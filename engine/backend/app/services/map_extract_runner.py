from __future__ import annotations

import csv
import json
import logging
import os
import re
import struct
import time
from typing import Any

from google.genai.types import Part

from ..response_schema.map_extract import MAP_EXTRACT_EDGE_RESPONSE_SCHEMA, MAP_EXTRACT_NODE_RESPONSE_SCHEMA
from ...infra.gemini_client import GeminiCancelledError, GeminiGateway
from ...infra.io_utils import read_text
from ...infra.paths import DEFAULT_MAP_BUFFER_TRAIT_TABLE, DEFAULT_MAP_EXTRACT_PROMPT_CONFIG
from ..models.job_models import JobRecord
from . import map_extract_checkpoints as checkpoints
from .job_store import (
    JOBS_LOCK,
    JobCancelledError,
    emit_job_event,
    is_cancel_requested,
    mark_cancelled,
    touch_activity,
)
from .usage_utils import ensure_usage_progress


logger = logging.getLogger(__name__)


def _resolve_stage_models(default_model: str, *, use_env_overrides: bool) -> dict[str, str]:
    if not use_env_overrides:
        return {
            "extractmap_symbol": default_model,
            "extractmap_text": default_model,
            "tabular_extraction": default_model,
            "edge_extraction": default_model,
        }

    # Legacy env overrides: used only when caller did not explicitly pick a model.
    all_override = (os.getenv("GEMINI_MAP_EXTRACT_MODEL") or "").strip()
    resolved_default = all_override or default_model
    return {
        "extractmap_symbol": (os.getenv("GEMINI_MAP_EXTRACT_MODEL_SYMBOL") or "").strip() or resolved_default,
        "extractmap_text": (os.getenv("GEMINI_MAP_EXTRACT_MODEL_TEXT") or "").strip() or resolved_default,
        "tabular_extraction": (os.getenv("GEMINI_MAP_EXTRACT_MODEL_TABULAR") or "").strip() or resolved_default,
        "edge_extraction": (os.getenv("GEMINI_MAP_EXTRACT_MODEL_EDGE") or "").strip() or resolved_default,
    }


def _raise_if_cancelled(job: JobRecord) -> None:
    if is_cancel_requested(job.job_id):
        raise JobCancelledError(f"job cancelled jobId={job.job_id}")


def _gemini_retry_callback(job: JobRecord, stage_name: str):
    """Build an on_retry callback that surfaces Gemini transient errors to the UI.

    Emits a lightweight stage event each time the Gemini client backs off, so
    the polling frontend can show *why* a stage is taking longer than expected
    (503 / UNAVAILABLE / RESOURCE_EXHAUSTED / network). The message is also
    appended to stage_history for post-mortem review.
    """

    def _on_retry(info: dict[str, Any]) -> None:
        attempt = info.get("attempt")
        max_attempts = info.get("maxAttempts")
        delay = info.get("delaySeconds")
        err = str(info.get("error") or info.get("errorClass") or "transient error")
        # Keep the error snippet short so it fits the single-line stage message.
        err_snippet = err.strip().replace("\n", " ")[:160]
        message = (
            f"Gemini transient error — retrying attempt {attempt}/{max_attempts} "
            f"in {delay}s ({err_snippet})"
        )
        try:
            emit_job_event(
                job,
                "stage",
                {"stage": f"map_extract/{stage_name}", "message": message},
            )
        except Exception:  # pragma: no cover - defensive
            logger.exception("[map_extract][worker] retry emit failed jobId=%s", job.job_id)

    return _on_retry


def _gemini_cancel_check(job: JobRecord):
    return lambda: is_cancel_requested(job.job_id)


def _usage_totals_snapshot(usage_totals: dict[str, int]) -> dict[str, int]:
    """Shallow copy of the running usage_totals dict at a checkpoint boundary.

    Embedded into every stage checkpoint so that a resume can restore the
    cumulative token counters earned by stages that are being skipped.
    Without this, cached stages emit "0 tokens" back to the UI and the bottom
    counter collapses to zero until the remaining stages add more.
    """
    return {
        "prompt_tokens": int(usage_totals.get("prompt_tokens", 0)),
        "output_tokens": int(usage_totals.get("output_tokens", 0)),
        "total_tokens": int(usage_totals.get("total_tokens", 0)),
        "call_count": int(usage_totals.get("call_count", 0)),
    }


def _restore_usage_totals_from_cache(
    cached: dict[str, Any] | None,
    usage_totals: dict[str, int],
) -> None:
    """If the cached checkpoint embeds a usage snapshot, replace the running
    totals in place.  No-op when the snapshot is absent (old checkpoints)."""
    if not cached:
        return
    snapshot = cached.get("_usageTotalsAtCompletion")
    if not isinstance(snapshot, dict):
        return
    for key in ("prompt_tokens", "output_tokens", "total_tokens", "call_count"):
        value = snapshot.get(key)
        if isinstance(value, int) and value > usage_totals.get(key, 0):
            usage_totals[key] = value


def _save_stage_with_usage(
    job_id: str,
    stage: str,
    payload: dict[str, Any],
    usage_totals: dict[str, int],
) -> None:
    """Wrapper around checkpoints.save_stage that embeds a usage snapshot."""
    payload = dict(payload)
    payload["_usageTotalsAtCompletion"] = _usage_totals_snapshot(usage_totals)
    checkpoints.save_stage(job_id, stage, payload)


def _mark_stage_completed(job: JobRecord, stage: str) -> None:
    with JOBS_LOCK:
        if stage not in job.completed_stages:
            job.completed_stages.append(stage)
    touch_activity(job)


def _stage_begin(job_id: str, stage: str) -> float:
    started = time.perf_counter()
    logger.info("[map_extract][worker] stage_begin jobId=%s stage=%s", job_id, stage)
    return started


def _stage_end(job_id: str, stage: str, started_at: float, **details: Any) -> None:
    elapsed_ms = int((time.perf_counter() - started_at) * 1000)
    logger.info(
        "[map_extract][worker] stage_end jobId=%s stage=%s elapsedMs=%s details=%s",
        job_id,
        stage,
        elapsed_ms,
        details,
    )


def _load_map_extract_config() -> dict[str, Any]:
    payload = GeminiGateway.parse_json_relaxed(read_text(DEFAULT_MAP_EXTRACT_PROMPT_CONFIG))
    if not isinstance(payload, dict):
        raise ValueError("map_extarct.json must be a JSON object")

    for key in ("extractmap_symbol", "extractmap_text", "tabular_extraction", "edge_extraction"):
        if key not in payload or not isinstance(payload[key], dict):
            raise ValueError(f"map_extarct.json missing task definition: {key}")

    required_runtime = (
        "extractmap_text_nodes_json_schema",
        "extractmap_text_dedup_policy",
        "extractmap_text_exclusion_policy",
        "extractmap_symbol_output_hint",
        "extractmap_text_symbol_usage_policy",
        "compact_output_policy",
        "tabular_extraction_output_hint",
        "tabular_extraction_no_support_hint",
        "extractmap_text_normalize_prompt",
        "extractmap_text_normalize_context",
        "edge_extraction_json_schema",
        "edge_extraction_dedup_policy",
        "edge_extraction_csv_fallback_hint",
    )
    runtime = payload.get("runtime_prompts")
    if not isinstance(runtime, dict):
        raise ValueError("map_extarct.json missing runtime_prompts object")
    for key in required_runtime:
        value = runtime.get(key)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"map_extarct.json runtime_prompts missing/empty key: {key}")
    return payload


def _config_text(config: dict[str, Any], key: str, *, default: str = "") -> str:
    runtime = config.get("runtime_prompts")
    if isinstance(runtime, dict):
        value = runtime.get(key)
        if isinstance(value, str):
            return value
    return default


def _normalize_symbol_enum(value: Any) -> str:
    token = str(value or "").strip().upper()
    token = re.sub(r"[^A-Z0-9]+", "_", token)
    token = re.sub(r"_+", "_", token).strip("_")
    return token or "UNKNOWN"


def _split_symbol_tokens(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        output: list[str] = []
        for item in value:
            output.extend(_split_symbol_tokens(item))
        return output
    if isinstance(value, dict):
        output: list[str] = []
        for item in value.values():
            output.extend(_split_symbol_tokens(item))
        return output

    text = str(value).strip()
    if not text:
        return []

    parts = [part.strip() for part in re.split(r"[,/|;]", text) if part.strip()]
    return parts or [text]


def _extract_symbol_legend(symbol_output: str) -> list[dict[str, str]]:
    text = str(symbol_output or "").strip()
    if not text:
        return []

    candidates: list[Any] = []
    try:
        parsed = GeminiGateway.parse_json_relaxed(text)
    except ValueError:
        parsed = None

    if isinstance(parsed, dict):
        symbols = parsed.get("symbols")
        if isinstance(symbols, list):
            candidates.extend(symbols)
        elif isinstance(symbols, dict):
            candidates.extend(symbols.values())
    elif isinstance(parsed, list):
        candidates.extend(parsed)

    if not candidates:
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        table_rows = [line for line in lines if line.startswith("|") and line.endswith("|")]
        if len(table_rows) >= 2:
            header_cells = [cell.strip().lower() for cell in table_rows[0].strip("|").split("|")]

            def idx(names: set[str], default: int) -> int:
                for i, cell in enumerate(header_cells):
                    cell_norm = re.sub(r"[^a-z0-9]", "", cell)
                    if cell_norm in names:
                        return i
                return default

            symbol_idx = idx({"symbol", "symbols", "notation"}, 0)
            notation_idx = idx({"notation", "code", "legendcode"}, min(1, len(header_cells) - 1))
            desc_idx = idx({"description", "symboldescription", "meaning"}, min(2, len(header_cells) - 1))
            color_idx = idx({"color", "colour"}, -1)

            for row in table_rows[1:]:
                cells = [cell.strip() for cell in row.strip("|").split("|")]
                if not cells or all(set(cell) <= {"-", ":"} for cell in cells):
                    continue
                candidates.append(
                    {
                        "symbol": cells[symbol_idx] if symbol_idx < len(cells) else "",
                        "notation": cells[notation_idx] if notation_idx < len(cells) else "",
                        "description": cells[desc_idx] if desc_idx < len(cells) else "",
                        "color": cells[color_idx] if color_idx >= 0 and color_idx < len(cells) else "",
                    }
                )

    legend: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in candidates:
        if not isinstance(item, dict):
            continue
        raw_symbol = item.get("symbol") or item.get("notation") or item.get("name") or item.get("code")
        symbol = _normalize_symbol_enum(raw_symbol)
        if symbol in seen:
            continue
        seen.add(symbol)
        legend.append(
            {
                "symbol": symbol,
                "notation": str(item.get("notation") or item.get("symbol") or "").strip(),
                "description": str(item.get("description") or item.get("meaning") or "").strip(),
                "color": str(item.get("color") or "").strip(),
            }
        )

    return legend


def _resolve_symbol_token(token: str, allowed_symbols: set[str]) -> str:
    normalized = _normalize_symbol_enum(token)
    if normalized in allowed_symbols:
        return normalized

    for symbol in allowed_symbols:
        if normalized in symbol or symbol in normalized:
            return symbol

    color_aliases = {
        "RED": "RED",
        "GREEN": "GREEN",
        "BLUE": "BLUE",
        "YELLOW": "YELLOW",
        "ORANGE": "ORANGE",
        "BLACK": "BLACK",
        "WHITE": "WHITE",
    }
    if normalized in color_aliases and color_aliases[normalized] in allowed_symbols:
        return color_aliases[normalized]

    return "UNKNOWN"


def _apply_symbol_metadata(nodes: list[dict[str, Any]], symbol_enum: list[str]) -> list[dict[str, Any]]:
    allowed = {value for value in symbol_enum if value}
    output: list[dict[str, Any]] = []

    for node in nodes:
        metadata = node.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {"raw": metadata} if metadata is not None else {}

        raw_candidates: list[Any] = []
        for key in ("symbols", "symbol", "legend_symbol", "legend_symbols", "color", "colour"):
            if key in metadata:
                raw_candidates.append(metadata.get(key))

        raw_symbols: list[str] = []
        for value in raw_candidates:
            raw_symbols.extend(_split_symbol_tokens(value))

        normalized: list[str] = []
        for token in raw_symbols:
            symbol = _resolve_symbol_token(token, allowed) if allowed else _normalize_symbol_enum(token)
            if symbol not in normalized:
                normalized.append(symbol)

        if raw_symbols and not normalized and allowed:
            normalized = ["UNKNOWN"]

        if normalized:
            metadata["symbols"] = normalized
            metadata["primarySymbol"] = normalized[0]

        node["metadata"] = metadata
        output.append(node)

    return output


def _image_dimensions(data: bytes) -> tuple[int, int] | None:
    """Extract (width, height) in pixels from PNG or JPEG byte payloads. Returns None otherwise."""
    if not data or len(data) < 24:
        return None

    # PNG: 8-byte signature, then IHDR chunk at offsets 8.. with width/height as big-endian uint32 at 16..24
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        try:
            width, height = struct.unpack(">II", data[16:24])
            if width > 0 and height > 0:
                return (int(width), int(height))
        except struct.error:
            return None
        return None

    # JPEG: scan for SOFn marker (0xFFC0..0xFFCF excluding DHT/DAC/DRI which share prefix)
    if data[:2] == b"\xff\xd8":
        i = 2
        n = len(data)
        sof_markers = {
            0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
            0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
        }
        while i + 9 < n:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in sof_markers:
                try:
                    height, width = struct.unpack(">HH", data[i + 5 : i + 9])
                    if width > 0 and height > 0:
                        return (int(width), int(height))
                except struct.error:
                    return None
                return None
            # Standalone markers (no length byte)
            if 0xD0 <= marker <= 0xD9:
                i += 2
                continue
            try:
                seg_len = struct.unpack(">H", data[i + 2 : i + 4])[0]
            except struct.error:
                return None
            i += 2 + seg_len
        return None

    return None


def _normalize_node(
    item: Any,
    index: int,
    *,
    image_dims: tuple[int, int] | None = None,
) -> dict[str, Any]:
    image_width = image_dims[0] if image_dims else None
    image_height = image_dims[1] if image_dims else None

    def normalize_coordinate(raw: Any, axis_size: int | None) -> float | None:
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return None

        # Already normalized 0..1 — use as-is.
        if 0.0 <= value <= 1.0:
            return value

        if value > 1:
            # Prefer real image dimensions when known (most accurate for pixel coords).
            if axis_size and axis_size > 0:
                value = value / float(axis_size)
            elif value > 100:
                # Fallback heuristic: probably pixel coords in an image ≤1000px.
                value = value / 1000.0
            else:
                # Fallback heuristic: looks like a 0..100 percent.
                value = value / 100.0

        if value < 0:
            value = 0.0
        if value > 1:
            value = 1.0
        return value

    if isinstance(item, dict):
        node_id = str(item.get("id") or item.get("node_id") or f"N{index + 1}").strip()
        label = str(item.get("label") or item.get("name") or node_id).strip() or node_id
        node_type = item.get("type") or item.get("node_type")
        raw_x = item.get("x")
        raw_y = item.get("y")
        fx = normalize_coordinate(raw_x, image_width)
        fy = normalize_coordinate(raw_y, image_height)
        coord_source = "model" if fx is not None and fy is not None else "fallback"

        if fx is None:
            fx = round(0.15 + ((index % 5) * 0.16), 3)
        if fy is None:
            fy = round(0.2 + ((index // 5) * 0.18), 3)

        return {
            "id": node_id,
            "label": label,
            "x": fx,
            "y": fy,
            "type": str(node_type) if node_type else None,
            "_coordSource": coord_source,
            "metadata": item,
        }

    text = str(item).strip() or f"N{index + 1}"
    return {
        "id": f"N{index + 1}",
        "label": text,
        "x": round(0.15 + ((index % 5) * 0.16), 3),
        "y": round(0.2 + ((index // 5) * 0.18), 3),
        "type": None,
        "_coordSource": "fallback",
        "metadata": {"raw": item},
    }


def _canonical_text(value: Any) -> str:
    raw = str(value or "").strip().lower()
    raw = re.sub(r"\s+", " ", raw)
    raw = re.sub(r"[^a-z0-9._\- ]", "", raw)
    return raw


def _canonical_node_id(value: Any) -> str:
    raw = str(value or "").strip().lower()
    return re.sub(r"[^a-z0-9]", "", raw)


def _resolve_node_id(token: str, known_node_ids: set[str] | None) -> str:
    resolved = str(token or "").strip()
    if not resolved or not known_node_ids:
        return resolved
    if resolved in known_node_ids:
        return resolved

    canonical_token = _canonical_node_id(resolved)
    if not canonical_token:
        return resolved

    canonical_to_actual: dict[str, str] = {}
    ambiguous: set[str] = set()
    for known in known_node_ids:
        c = _canonical_node_id(known)
        if not c:
            continue
        if c in canonical_to_actual and canonical_to_actual[c] != known:
            ambiguous.add(c)
            continue
        canonical_to_actual[c] = known

    if canonical_token in ambiguous:
        return resolved
    return canonical_to_actual.get(canonical_token, resolved)


def _coordinate_quality(node: dict[str, Any]) -> int:
    score = 0
    for axis in ("x", "y"):
        try:
            value = float(node.get(axis))
        except (TypeError, ValueError):
            continue
        # Interior normalized coordinates are generally more informative than hard boundaries.
        if 0.0 < value < 1.0:
            score += 1
    return score


def _semantic_node_key(node: dict[str, Any]) -> str:
    node_id = _canonical_text(node.get("id"))
    label = _canonical_text(node.get("label"))
    node_type = _canonical_text(node.get("type"))

    if node_id and not node_id.startswith("n"):
        return f"id:{node_id}"

    x = node.get("x")
    y = node.get("y")
    x_bucket = "na"
    y_bucket = "na"
    try:
        x_bucket = str(int(float(x) * 40))
        y_bucket = str(int(float(y) * 40))
    except (TypeError, ValueError):
        pass

    return f"sem:{label}|{node_type}|{x_bucket}|{y_bucket}"


def _semantic_node_signature(node: dict[str, Any]) -> str:
    label = _canonical_text(node.get("label"))
    node_type = _canonical_text(node.get("type"))
    x = node.get("x")
    y = node.get("y")
    x_bucket = "na"
    y_bucket = "na"
    try:
        x_bucket = str(int(float(x) * 40))
        y_bucket = str(int(float(y) * 40))
    except (TypeError, ValueError):
        pass
    return f"{label}|{node_type}|{x_bucket}|{y_bucket}"


def _is_canceled_node(node: dict[str, Any]) -> bool:
    cancel_terms = {
        "canceled",
        "cancelled",
        "inactive",
        "decommissioned",
        "removed",
        "closed",
        "retired",
        "obsolete",
    }

    def collect_texts(value: Any, sink: list[str]) -> None:
        if value is None:
            return
        if isinstance(value, str):
            sink.append(value)
            return
        if isinstance(value, (int, float, bool)):
            sink.append(str(value))
            return
        if isinstance(value, list):
            for item in value:
                collect_texts(item, sink)
            return
        if isinstance(value, dict):
            for key, item in value.items():
                sink.append(str(key))
                collect_texts(item, sink)

    texts: list[str] = []
    collect_texts(node.get("id"), texts)
    collect_texts(node.get("label"), texts)
    collect_texts(node.get("type"), texts)
    collect_texts(node.get("metadata"), texts)

    normalized = " ".join(_canonical_text(text) for text in texts)
    if not normalized:
        return False
    return any(term in normalized for term in cancel_terms)


def _filter_active_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [node for node in nodes if not _is_canceled_node(node)]


def _filter_edges_by_nodes(edges: list[dict[str, Any]], nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    active_ids = {str(node.get("id") or "").strip() for node in nodes}
    active_ids.discard("")
    filtered: list[dict[str, Any]] = []
    for edge in edges:
        source = _resolve_node_id(str(edge.get("source") or "").strip(), active_ids)
        target = _resolve_node_id(str(edge.get("target") or "").strip(), active_ids)
        if not source or not target:
            continue
        if source not in active_ids or target not in active_ids:
            continue
        edge["source"] = source
        edge["target"] = target
        filtered.append(edge)
    return filtered


def _normalize_edge(item: Any, index: int) -> dict[str, Any] | None:
    def key_lookup(data: dict[str, Any], *candidates: str) -> Any:
        normalized: dict[str, Any] = {}
        for key, value in data.items():
            key_str = str(key).strip().lower()
            key_norm = re.sub(r"[^a-z0-9]", "", key_str)
            normalized[key_norm] = value

        for candidate in candidates:
            cand_norm = re.sub(r"[^a-z0-9]", "", candidate.strip().lower())
            if cand_norm in normalized:
                return normalized[cand_norm]
        return None

    if not isinstance(item, dict):
        return None

    source = str(
        key_lookup(
            item,
            "source",
            "source_node",
            "source node",
            "from",
            "head",
            "node1",
            "start",
        )
        or ""
    ).strip()
    target = str(
        key_lookup(
            item,
            "target",
            "target_node",
            "target node",
            "to",
            "tail",
            "node2",
            "end",
        )
        or ""
    ).strip()
    if not source or not target:
        return None

    raw_weight = key_lookup(item, "weight", "approximate_cost", "approximate cost", "cost", "distance")
    if raw_weight is None:
        raw_weight = None

    weight: float | None = None
    if raw_weight is not None:
        try:
            weight = float(raw_weight)
        except (TypeError, ValueError):
            weight = None

    return {
        "id": str(item.get("id") or f"E{index + 1}"),
        "source": source,
        "target": target,
        "label": key_lookup(item, "label", "relation", "type") or "path",
        "weight": weight,
        "metadata": item,
    }


def _extract_nodes_from_text(
    text: str,
    *,
    image_dims: tuple[int, int] | None = None,
) -> list[dict[str, Any]]:
    raw = str(text or "").strip()
    if not raw:
        return []

    # First, try relaxed JSON parsing from text-like responses.
    try:
        parsed = GeminiGateway.parse_json_relaxed(raw)
    except ValueError:
        parsed = None
    if parsed is not None and not isinstance(parsed, str):
        return _extract_nodes(parsed, image_dims=image_dims)

    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    if not lines:
        return []

    if lines and lines[0].startswith("```"):
        lines = [line for line in lines if not line.startswith("```")]
    if not lines:
        return []

    # Markdown table fallback.
    table_rows = [line for line in lines if line.startswith("|") and line.endswith("|")]
    if len(table_rows) >= 2:
        headers = [cell.strip().lower() for cell in table_rows[0].strip("|").split("|")]

        def idx(names: set[str], default: int) -> int:
            for i, cell in enumerate(headers):
                cell_norm = re.sub(r"[^a-z0-9]", "", cell)
                if cell_norm in names:
                    return i
            return default

        id_idx = idx({"id", "nodeid", "node", "nodecode"}, 0)
        label_idx = idx({"label", "name", "nodelabel", "description"}, min(1, len(headers) - 1))
        type_idx = idx({"type", "nodetype", "category"}, -1)
        x_idx = idx({"x", "xcoord", "xcoordinate"}, -1)
        y_idx = idx({"y", "ycoord", "ycoordinate"}, -1)

        extracted: list[dict[str, Any]] = []
        for row in table_rows[1:]:
            cells = [cell.strip() for cell in row.strip("|").split("|")]
            if not cells or all(set(cell) <= {"-", ":"} for cell in cells):
                continue
            node_obj: dict[str, Any] = {
                "id": cells[id_idx] if id_idx < len(cells) else "",
                "label": cells[label_idx] if label_idx < len(cells) else "",
            }
            if type_idx >= 0 and type_idx < len(cells):
                node_obj["type"] = cells[type_idx]
            if x_idx >= 0 and x_idx < len(cells):
                node_obj["x"] = cells[x_idx]
            if y_idx >= 0 and y_idx < len(cells):
                node_obj["y"] = cells[y_idx]
            normalized = _normalize_node(node_obj, len(extracted), image_dims=image_dims)
            extracted.append(normalized)

        if extracted:
            return extracted

    # CSV/TSV fallback.
    header = [part.strip().lower() for part in re.split(r",|\t|;", lines[0])]
    id_idx = -1
    label_idx = -1
    type_idx = -1
    x_idx = -1
    y_idx = -1
    for i, col in enumerate(header):
        col_norm = re.sub(r"[^a-z0-9]", "", col)
        if col_norm in {"id", "nodeid", "node", "nodecode"}:
            id_idx = i
        elif col_norm in {"label", "name", "nodelabel", "description"}:
            label_idx = i
        elif col_norm in {"type", "nodetype", "category"}:
            type_idx = i
        elif col_norm in {"x", "xcoord", "xcoordinate"}:
            x_idx = i
        elif col_norm in {"y", "ycoord", "ycoordinate"}:
            y_idx = i

    if id_idx >= 0 or label_idx >= 0:
        extracted: list[dict[str, Any]] = []
        for row in lines[1:]:
            parts = [part.strip() for part in re.split(r",|\t|;", row)]
            node_obj: dict[str, Any] = {}
            if id_idx >= 0 and id_idx < len(parts):
                node_obj["id"] = parts[id_idx]
            if label_idx >= 0 and label_idx < len(parts):
                node_obj["label"] = parts[label_idx]
            if type_idx >= 0 and type_idx < len(parts):
                node_obj["type"] = parts[type_idx]
            if x_idx >= 0 and x_idx < len(parts):
                node_obj["x"] = parts[x_idx]
            if y_idx >= 0 and y_idx < len(parts):
                node_obj["y"] = parts[y_idx]
            if not node_obj:
                continue
            normalized = _normalize_node(node_obj, len(extracted), image_dims=image_dims)
            extracted.append(normalized)

        if extracted:
            return extracted

    # JSON-like fallback for partially broken model outputs.
    # This recovers nodes when output looks like JSON but cannot be parsed strictly.
    id_matches = list(re.finditer(r'"id"\s*:\s*"(?P<id>[^"]+)"', raw))
    if id_matches:
        extracted: list[dict[str, Any]] = []
        for i, match in enumerate(id_matches):
            start = match.start()
            end = id_matches[i + 1].start() if i + 1 < len(id_matches) else len(raw)
            segment = raw[start:end]

            node_id = (match.group("id") or "").strip()
            if not node_id:
                continue

            label_match = re.search(r'"label"\s*:\s*"(?P<label>[^"]*)"', segment)
            type_match = re.search(r'"type"\s*:\s*"(?P<type>[^"]*)"', segment)
            x_match = re.search(r'"x"\s*:\s*(?P<x>-?\d+(?:\.\d+)?)', segment)
            y_match = re.search(r'"y"\s*:\s*(?P<y>-?\d+(?:\.\d+)?)', segment)

            node_obj: dict[str, Any] = {
                "id": node_id,
                "label": label_match.group("label").strip() if label_match else node_id,
            }
            if type_match:
                node_obj["type"] = type_match.group("type").strip()
            if x_match:
                node_obj["x"] = x_match.group("x")
            if y_match:
                node_obj["y"] = y_match.group("y")

            extracted.append(_normalize_node(node_obj, len(extracted), image_dims=image_dims))

        if extracted:
            return extracted

    # Line-oriented fallback: "ID: label" or "ID - label".
    extracted: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    line_pattern = re.compile(r"^(?:[-*]\s*)?(?P<id>[A-Za-z0-9._-]{2,})\s*(?::|-|->)\s*(?P<label>.+)$")
    for line in lines:
        if line.startswith("#"):
            continue
        match = line_pattern.match(line)
        if not match:
            continue
        node_id = (match.group("id") or "").strip()
        if not node_id or node_id in seen_ids:
            continue
        seen_ids.add(node_id)
        label = (match.group("label") or "").strip() or node_id
        normalized = _normalize_node({"id": node_id, "label": label}, len(extracted), image_dims=image_dims)
        extracted.append(normalized)

    return extracted


def _extract_nodes(
    payload: Any,
    *,
    image_dims: tuple[int, int] | None = None,
) -> list[dict[str, Any]]:
    candidates: list[Any] = []
    if isinstance(payload, str):
        return _extract_nodes_from_text(payload, image_dims=image_dims)

    if isinstance(payload, dict):
        primary = payload.get("nodes") or payload.get("vertices") or payload.get("items")
        if isinstance(primary, list):
            candidates.extend(primary)
        elif isinstance(primary, dict):
            candidates.extend(primary.values())

        # Flexible fallback: include list/dict collections under any key.
        if not candidates:
            for value in payload.values():
                if isinstance(value, list):
                    candidates.extend(value)
                elif isinstance(value, dict):
                    candidates.append(value)

            # Map-like shape: {"TR.1": {...}, "L.1": {...}}
            if not candidates:
                for key, value in payload.items():
                    if isinstance(value, dict):
                        node_obj = {"id": str(key), **value}
                        candidates.append(node_obj)
    elif isinstance(payload, list):
        candidates = payload

    if not isinstance(candidates, list):
        candidates = []

    normalized: list[dict[str, Any]] = []
    for i, item in enumerate(candidates):
        normalized.append(_normalize_node(item, i, image_dims=image_dims))
    return normalized


def _merge_stage4_completion(
    stage2_nodes: list[dict[str, Any]],
    stage4_nodes: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int, int]:
    # Stage 4 enriches metadata/text only; Stage 2 remains authoritative for geometry and ID set.
    stage2_ids = {str(node.get("id") or "").strip() for node in stage2_nodes}
    stage2_ids.discard("")

    stage4_by_id: dict[str, dict[str, Any]] = {}
    ignored_non_stage2 = 0
    for node in stage4_nodes:
        node_id = str(node.get("id") or "").strip()
        if not node_id:
            continue
        if node_id not in stage2_ids:
            ignored_non_stage2 += 1
            continue
        stage4_by_id[node_id] = node

    merged: list[dict[str, Any]] = []
    matched = 0
    for stage2_node in stage2_nodes:
        node = dict(stage2_node)
        node_id = str(node.get("id") or "").strip()
        incoming = stage4_by_id.get(node_id)
        if not incoming:
            merged.append(node)
            continue

        matched += 1
        incoming_label = str(incoming.get("label") or "").strip()
        if incoming_label:
            node["label"] = incoming_label

        incoming_type = incoming.get("type")
        if incoming_type is not None:
            node["type"] = incoming_type

        base_meta = node.get("metadata")
        if not isinstance(base_meta, dict):
            base_meta = {"raw": base_meta} if base_meta is not None else {}

        incoming_meta = incoming.get("metadata")
        if isinstance(incoming_meta, dict):
            for key, value in incoming_meta.items():
                if _is_empty_metadata_value(value):
                    continue
                existing = base_meta.get(key)
                if not _is_empty_metadata_value(existing):
                    continue
                base_meta[key] = value

        node["metadata"] = base_meta
        merged.append(node)

    unmatched = ignored_non_stage2
    return merged, matched, unmatched


def _is_empty_metadata_value(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, (list, dict, tuple, set)):
        return len(value) == 0
    return False


def _split_tabular_row(line: str) -> list[str]:
    row = str(line or "").strip()
    if not row:
        return []

    if row.startswith("|") and row.endswith("|"):
        return [cell.strip() for cell in row.strip("|").split("|")]

    delimiter = ","
    if "\t" in row:
        delimiter = "\t"
    elif row.count(";") > row.count(","):
        delimiter = ";"

    try:
        return [cell.strip() for cell in next(csv.reader([row], delimiter=delimiter))]
    except Exception:
        return [cell.strip() for cell in re.split(r",|\t|;|\|", row) if cell.strip()]


def _extract_stage4_tabular_candidates(
    tabular_text: str,
    known_node_ids: set[str],
) -> list[dict[str, Any]]:
    lines = [line.strip() for line in str(tabular_text or "").splitlines() if line.strip()]
    if not lines or not known_node_ids:
        return []

    header_tokens: list[str] | None = None
    candidates: list[dict[str, Any]] = []
    for line in lines:
        if line.startswith("#"):
            continue
        cells = _split_tabular_row(line)
        if len(cells) < 2:
            continue

        resolved: list[tuple[int, str]] = []
        for idx, cell in enumerate(cells):
            node_id = _resolve_node_id(cell, known_node_ids)
            if node_id in known_node_ids:
                resolved.append((idx, node_id))

        if not resolved:
            alpha_like = sum(1 for cell in cells if re.search(r"[^\d\s.,;:()\[\]{}]+", cell))
            if alpha_like >= max(1, len(cells) // 2):
                header_tokens = cells
            continue

        id_idx, node_id = resolved[0]
        metadata: dict[str, Any] = {}
        for idx, cell in enumerate(cells):
            if idx == id_idx:
                continue
            value = cell.strip()
            if _is_empty_metadata_value(value):
                continue

            key = f"col_{idx + 1}"
            if header_tokens and idx < len(header_tokens):
                raw_key = str(header_tokens[idx]).strip()
                key_candidate = re.sub(r"\s+", "_", raw_key, flags=re.UNICODE)
                key_candidate = re.sub(r"[^\w]+", "_", key_candidate, flags=re.UNICODE).strip("_").lower()
                if key_candidate:
                    key = key_candidate

            if key == "id":
                key = f"{key}_{idx + 1}"

            if key in metadata and metadata[key] != value:
                existing = metadata[key]
                if isinstance(existing, list):
                    if value not in existing:
                        existing.append(value)
                else:
                    metadata[key] = [existing, value]
            else:
                metadata[key] = value

        if metadata:
            candidates.append(
                {
                    "id": node_id,
                    "metadata": metadata,
                    "rawRow": line,
                }
            )

    return candidates


def _apply_stage4_tabular_overlay(
    nodes: list[dict[str, Any]],
    tabular_candidates: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int]:
    by_id: dict[str, dict[str, Any]] = {}
    for candidate in tabular_candidates:
        node_id = str(candidate.get("id") or "").strip()
        if not node_id:
            continue
        metadata = candidate.get("metadata")
        if not isinstance(metadata, dict):
            continue
        row_text = str(candidate.get("rawRow") or "").strip()

        slot = by_id.setdefault(node_id, {"metadata": {}, "rows": []})
        slot_meta = slot["metadata"]
        if isinstance(slot_meta, dict):
            for key, value in metadata.items():
                if _is_empty_metadata_value(value):
                    continue
                if key in slot_meta and slot_meta[key] != value:
                    existing = slot_meta[key]
                    if isinstance(existing, list):
                        if value not in existing:
                            existing.append(value)
                    else:
                        slot_meta[key] = [existing, value]
                else:
                    slot_meta[key] = value

        rows = slot.get("rows")
        if isinstance(rows, list) and row_text and row_text not in rows:
            rows.append(row_text)

    enriched_count = 0
    merged: list[dict[str, Any]] = []
    for node in nodes:
        next_node = dict(node)
        node_id = str(next_node.get("id") or "").strip()
        candidate = by_id.get(node_id)
        if not candidate:
            merged.append(next_node)
            continue

        base_meta = next_node.get("metadata")
        if not isinstance(base_meta, dict):
            base_meta = {"raw": base_meta} if base_meta is not None else {}

        candidate_meta = candidate.get("metadata")
        changed = False
        if isinstance(candidate_meta, dict):
            for key, value in candidate_meta.items():
                existing = base_meta.get(key)
                if _is_empty_metadata_value(existing) and not _is_empty_metadata_value(value):
                    base_meta[key] = value
                    changed = True

        candidate_rows = candidate.get("rows")
        if isinstance(candidate_rows, list) and candidate_rows:
            existing_rows = base_meta.get("stage3Rows")
            if not isinstance(existing_rows, list):
                existing_rows = []
            for row_text in candidate_rows:
                if row_text not in existing_rows:
                    existing_rows.append(row_text)
                    changed = True
            base_meta["stage3Rows"] = existing_rows[:16]

        if changed:
            enriched_count += 1
        next_node["metadata"] = base_meta
        merged.append(next_node)

    return merged, enriched_count


def _count_enriched_nodes(nodes: list[dict[str, Any]]) -> int:
    count = 0
    for node in nodes:
        metadata = node.get("metadata")
        if not isinstance(metadata, dict):
            continue
        meaningful = [
            key
            for key, value in metadata.items()
            if key not in {"id", "label", "x", "y", "type", "node_id"}
            and not _is_empty_metadata_value(value)
        ]
        if meaningful:
            count += 1
    return count


def _extract_edges_from_text(text: str, known_node_ids: set[str] | None = None) -> list[dict[str, Any]]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return []

    # Drop common markdown wrappers.
    if lines and lines[0].startswith("```"):
        lines = [line for line in lines if not line.startswith("```")]
    if not lines:
        return []

    # 1) CSV/TSV-like fallback.
    header = [part.strip().lower() for part in re.split(r",|\t|;", lines[0])]
    source_idx = -1
    target_idx = -1
    cost_idx = -1
    for i, col in enumerate(header):
        col_norm = re.sub(r"[^a-z0-9]", "", col)
        if col_norm in {"sourcenode", "source", "from", "head", "node1", "start"}:
            source_idx = i
        elif col_norm in {"targetnode", "target", "to", "tail", "node2", "end"}:
            target_idx = i
        elif col_norm in {"approximatecost", "cost", "distance", "weight"}:
            cost_idx = i

    if source_idx >= 0 and target_idx >= 0:
        extracted: list[dict[str, Any]] = []
        for line_no, row in enumerate(lines[1:], start=1):
            parts = [part.strip() for part in re.split(r",|\t|;", row)]
            if max(source_idx, target_idx) >= len(parts):
                continue
            edge_obj: dict[str, Any] = {
                "id": f"E{line_no}",
                "source": parts[source_idx],
                "target": parts[target_idx],
            }
            if cost_idx >= 0 and cost_idx < len(parts):
                edge_obj["approximate_cost"] = parts[cost_idx]
            normalized = _normalize_edge(edge_obj, line_no - 1)
            if normalized:
                extracted.append(normalized)
        if extracted:
            return extracted

    # 2) Markdown table fallback: | source | target | cost |
    table_rows = [line for line in lines if line.startswith("|") and line.endswith("|")]
    if table_rows:
        extracted: list[dict[str, Any]] = []
        for line_no, row in enumerate(table_rows, start=1):
            cols = [c.strip() for c in row.strip("|").split("|")]
            if len(cols) < 2:
                continue
            if all(set(c) <= {"-", ":"} for c in cols):
                continue
            edge_obj: dict[str, Any] = {
                "id": f"E{line_no}",
                "source": cols[0],
                "target": cols[1],
            }
            if len(cols) >= 3:
                edge_obj["approximate_cost"] = cols[2]
            normalized = _normalize_edge(edge_obj, line_no - 1)
            if normalized:
                extracted.append(normalized)
        if extracted:
            return extracted

    # 3) JSON-like fallback for partially truncated model outputs.
    # Example: '{"edges": [{"source": "A", "target": "B", ...}, ...' cut before final closing tokens.
    source_matches = list(re.finditer(r'"source"\s*:\s*"(?P<source>[^"]+)"', text))
    if source_matches:
        recovered: list[dict[str, Any]] = []
        for i, match in enumerate(source_matches):
            start = match.start()
            end = source_matches[i + 1].start() if i + 1 < len(source_matches) else len(text)
            segment = text[start:end]

            source = (match.group("source") or "").strip()
            target_match = re.search(r'"target"\s*:\s*"(?P<target>[^"]+)"', segment)
            if not source or not target_match:
                continue
            target = (target_match.group("target") or "").strip()

            source_resolved = _resolve_node_id(source, known_node_ids)
            target_resolved = _resolve_node_id(target, known_node_ids)
            if known_node_ids and (source_resolved not in known_node_ids or target_resolved not in known_node_ids):
                continue

            edge_obj: dict[str, Any] = {
                "id": f"E{i + 1}",
                "source": source_resolved,
                "target": target_resolved,
            }

            cost_match = re.search(r'"approximate_cost"\s*:\s*(?P<cost>-?\d+(?:\.\d+)?)', segment)
            if cost_match:
                edge_obj["approximate_cost"] = cost_match.group("cost")

            label_match = re.search(r'"label"\s*:\s*"(?P<label>[^"]*)"', segment)
            if label_match:
                edge_obj["label"] = label_match.group("label").strip() or "path"

            normalized = _normalize_edge(edge_obj, i)
            if normalized:
                recovered.append(normalized)

        if recovered:
            return recovered

    # 4) Arrow fallback: A -> B (cost=...)
    arrow_pattern = re.compile(
        r"(?P<src>[A-Za-z0-9._-]+)\s*(?:->|→|=>|to)\s*(?P<tgt>[A-Za-z0-9._-]+)(?:[^\n]*?(?P<cost>\d+(?:\.\d+)?))?",
        flags=re.IGNORECASE,
    )
    extracted: list[dict[str, Any]] = []
    for line_no, row in enumerate(lines, start=1):
        match = arrow_pattern.search(row)
        if not match:
            continue
        src = match.group("src")
        tgt = match.group("tgt")
        src_resolved = _resolve_node_id(src, known_node_ids)
        tgt_resolved = _resolve_node_id(tgt, known_node_ids)
        if known_node_ids and (src_resolved not in known_node_ids or tgt_resolved not in known_node_ids):
            # Keep strict when we know expected node IDs to reduce hallucinated edges.
            continue
        edge_obj: dict[str, Any] = {"id": f"E{line_no}", "source": src_resolved, "target": tgt_resolved}
        if match.group("cost"):
            edge_obj["approximate_cost"] = match.group("cost")
        normalized = _normalize_edge(edge_obj, line_no - 1)
        if normalized:
            extracted.append(normalized)
    if extracted:
        return extracted

    # 5) Last resort: if line mentions exactly two known nodes, infer an edge.
    if known_node_ids:
        node_pattern = re.compile(r"[A-Za-z0-9._-]+")
        inferred: list[dict[str, Any]] = []
        for line_no, row in enumerate(lines, start=1):
            tokens = node_pattern.findall(row)
            hits: list[str] = []
            for token in tokens:
                resolved = _resolve_node_id(token, known_node_ids)
                if resolved in known_node_ids:
                    hits.append(resolved)
            if len(hits) < 2:
                continue
            src, tgt = hits[0], hits[1]
            normalized = _normalize_edge({"id": f"E{line_no}", "source": src, "target": tgt}, line_no - 1)
            if normalized:
                inferred.append(normalized)
        if inferred:
            return inferred

    return []


def _extract_edges(payload: Any, known_node_ids: set[str] | None = None) -> list[dict[str, Any]]:
    if isinstance(payload, str):
        text = payload.strip()
        if not text:
            return []
        return _extract_edges_from_text(text, known_node_ids)

    if isinstance(payload, dict):
        candidates = payload.get("edges") or payload.get("links") or payload.get("paths") or []
    elif isinstance(payload, list):
        candidates = payload
    else:
        candidates = []

    if not isinstance(candidates, list):
        candidates = []

    result: list[dict[str, Any]] = []
    for i, item in enumerate(candidates):
        normalized = _normalize_edge(item, i)
        if normalized:
            if known_node_ids:
                normalized["source"] = _resolve_node_id(str(normalized.get("source") or "").strip(), known_node_ids)
                normalized["target"] = _resolve_node_id(str(normalized.get("target") or "").strip(), known_node_ids)
            result.append(normalized)
    return result


def _merge_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    key_by_id: dict[str, str] = {}
    key_by_semantic: dict[str, str] = {}
    for node in nodes:
        if _is_canceled_node(node):
            continue

        node_id = str(node.get("id") or "").strip()
        if not node_id:
            continue

        semantic_key = _semantic_node_key(node)
        semantic_signature = _semantic_node_signature(node)
        existing_key = key_by_id.get(node_id) or key_by_semantic.get(semantic_signature) or semantic_key
        existing = merged.get(existing_key)
        if not existing:
            merged[existing_key] = node
            key_by_id[node_id] = existing_key
            key_by_semantic[semantic_signature] = existing_key
            continue

        # Keep first stable coordinates/label but merge metadata.
        if not existing.get("label") and node.get("label"):
            existing["label"] = node["label"]
        if existing.get("type") is None and node.get("type") is not None:
            existing["type"] = node["type"]

        # Upgrade coordinates when a later model-derived coordinate arrives.
        existing_source = str(existing.get("_coordSource") or "")
        incoming_source = str(node.get("_coordSource") or "")
        if existing_source != "model" and incoming_source == "model":
            existing["x"] = node.get("x")
            existing["y"] = node.get("y")
            existing["_coordSource"] = "model"
        elif existing_source == "model" and incoming_source == "model":
            if _coordinate_quality(node) > _coordinate_quality(existing):
                existing["x"] = node.get("x")
                existing["y"] = node.get("y")
                existing["_coordSource"] = "model"

        existing_meta = existing.get("metadata")
        next_meta = node.get("metadata")
        if isinstance(existing_meta, dict) and isinstance(next_meta, dict):
            existing_meta.update(next_meta)
        elif next_meta is not None:
            existing["metadata"] = next_meta

        key_by_id[node_id] = existing_key
        key_by_semantic[semantic_signature] = existing_key

    return list(merged.values())


def _default_token_rates_for_model(model_name: str) -> tuple[float, float]:
    model = model_name.lower()
    if "pro" in model:
        return 3.50, 10.00
    if "flash-lite" in model or "lite" in model:
        return 0.10, 0.40
    return 0.30, 1.20


def _estimate_cost_usd(
    *,
    model_name: str,
    prompt_tokens: int,
    output_tokens: int,
) -> dict[str, Any]:
    env_input_rate = float(os.getenv("MAP_EXTRACT_INPUT_USD_PER_1M_TOKENS", "0") or "0")
    env_output_rate = float(os.getenv("MAP_EXTRACT_OUTPUT_USD_PER_1M_TOKENS", "0") or "0")

    if env_input_rate > 0 or env_output_rate > 0:
        input_rate = env_input_rate
        output_rate = env_output_rate
        source = "env"
    else:
        input_rate, output_rate = _default_token_rates_for_model(model_name)
        source = "model-default"

    estimated = ((prompt_tokens / 1_000_000.0) * input_rate) + ((output_tokens / 1_000_000.0) * output_rate)
    return {
        "estimated": round(estimated, 6),
        "input_rate": input_rate,
        "output_rate": output_rate,
        "source": source,
    }


def _usage_snapshot(
    *,
    model_name: str,
    token_usage: dict[str, int],
) -> dict[str, Any]:
    prompt_tokens = int(token_usage.get("prompt_tokens", 0))
    output_tokens = int(token_usage.get("output_tokens", 0))
    total_tokens = prompt_tokens + output_tokens
    provider_total_tokens = int(token_usage.get("provider_total_tokens", 0))
    hidden_tokens = int(token_usage.get("hidden_tokens", 0))
    call_count = int(token_usage.get("call_count", 0))

    estimate = _estimate_cost_usd(
        model_name=model_name,
        prompt_tokens=prompt_tokens,
        output_tokens=output_tokens,
    )
    return {
        "tokenUsage": {
            "promptTokens": prompt_tokens,
            "outputTokens": output_tokens,
            "totalTokens": total_tokens,
            "providerTotalTokens": provider_total_tokens,
            "hiddenTokens": hidden_tokens,
            "callCount": call_count,
        },
        "costEstimate": {
            "currency": "USD",
            "estimatedCost": estimate.get("estimated"),
            "source": estimate.get("source"),
        },
    }


def _emit_stage_with_usage(
    *,
    job: JobRecord,
    stage: str,
    message: str,
    model_name: str,
    token_usage: dict[str, int],
) -> None:
    usage = _usage_snapshot(model_name=model_name, token_usage=token_usage)
    emit_job_event(
        job,
        "stage",
        {
            "stage": stage,
            "message": message,
            "tokenUsage": usage["tokenUsage"],
            "costEstimate": usage["costEstimate"],
        },
    )
    touch_activity(job)


def _merge_edges(edges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    next_index = 1
    for edge in edges:
        source = str(edge.get("source") or "").strip()
        target = str(edge.get("target") or "").strip()
        if not source or not target:
            continue

        # Merge by topology first to avoid dropping valid edges when model reuses IDs like E1.
        edge_id = f"{source}->{target}"
        if edge.get("id"):
            edge["id"] = str(edge["id"])
        else:
            edge["id"] = f"E{next_index}"
            next_index += 1

        existing = merged.get(edge_id)
        if not existing:
            merged[edge_id] = edge
            continue

        # Prefer existing topology, fill missing weight/metadata from new candidate.
        if existing.get("weight") is None and edge.get("weight") is not None:
            existing["weight"] = edge["weight"]

        existing_meta = existing.get("metadata")
        next_meta = edge.get("metadata")
        if isinstance(existing_meta, dict) and isinstance(next_meta, dict):
            existing_meta.update(next_meta)
        elif next_meta is not None:
            existing["metadata"] = next_meta

    result = list(merged.values())
    # Ensure stable sequential IDs for UI predictability.
    for i, edge in enumerate(result, start=1):
        edge["id"] = f"E{i}"
    return result


def _make_part(file_data: dict[str, Any]) -> Part:
    return Part.from_bytes(data=file_data["data"], mime_type=file_data["mime_type"])


def _run_stage_json(
    gateway: GeminiGateway,
    *,
    stage_name: str,
    base_prompt: str,
    extra_context: str,
    parts: list[Part] | None,
    response_schema: dict[str, Any] | None,
    usage_totals: dict[str, int],
    job: JobRecord | None = None,
) -> Any:
    prompt_payload = f"{base_prompt}\n\n{extra_context}"
    before_calls = int(usage_totals.get("call_count", 0))
    call_started = time.perf_counter()
    logger.info(
        "[map_extract][worker] gemini_call_start stage=%s model=%s promptChars=%s partsCount=%s",
        stage_name,
        gateway.model_name,
        len(prompt_payload),
        len(parts or []),
    )
    try:
        raw = gateway.generate_text(
            prompt_payload,
            parts=parts,
            response_json=True,
            response_schema=response_schema,
            usage_collector=usage_totals,
            on_retry=_gemini_retry_callback(job, stage_name) if job else None,
            cancel_check=_gemini_cancel_check(job) if job else None,
        ).strip()
    except GeminiCancelledError as exc:
        if job is not None:
            raise JobCancelledError(str(exc)) from exc
        raise
    logger.info(
        "[map_extract][worker] gemini_call_end stage=%s model=%s elapsedMs=%s rawChars=%s",
        stage_name,
        gateway.model_name,
        int((time.perf_counter() - call_started) * 1000),
        len(raw),
    )

    ensure_usage_progress(
        usage_totals=usage_totals,
        before_calls=before_calls,
        prompt_payload=prompt_payload,
        raw=raw,
    )

    logger.debug(
        "[map_extract][worker] raw_response stage=%s model=%s rawChars=%s raw=%s",
        stage_name,
        gateway.model_name,
        len(raw),
        raw,
    )

    if not raw:
        return {}
    try:
        return GeminiGateway.parse_json_relaxed(raw)
    except ValueError:
        truncated_likely = (raw.count("{") > raw.count("}")) or (raw.count("[") > raw.count("]"))
        logger.warning(
            "[map_extract][worker] json parse fallback stage=%s model=%s promptState={basePromptChars:%s,extraContextChars:%s,partsCount:%s,rawChars:%s,truncatedLikely:%s} snippet=%s",
            stage_name,
            gateway.model_name,
            len(base_prompt),
            len(extra_context),
            len(parts or []),
            len(raw),
            truncated_likely,
            raw,
        )
        return raw


def _run_stage_text(
    gateway: GeminiGateway,
    *,
    base_prompt: str,
    extra_context: str,
    parts: list[Part] | None,
    usage_totals: dict[str, int],
    stage_name: str | None = None,
    job: JobRecord | None = None,
) -> str:
    prompt_payload = f"{base_prompt}\n\n{extra_context}"
    before_calls = int(usage_totals.get("call_count", 0))
    call_started = time.perf_counter()
    logger.info(
        "[map_extract][worker] gemini_call_start stage=%s model=%s promptChars=%s partsCount=%s",
        stage_name or "text",
        gateway.model_name,
        len(prompt_payload),
        len(parts or []),
    )
    try:
        raw = gateway.generate_text(
            prompt_payload,
            parts=parts,
            response_json=False,
            usage_collector=usage_totals,
            on_retry=_gemini_retry_callback(job, stage_name or "text") if job else None,
            cancel_check=_gemini_cancel_check(job) if job else None,
        ).strip()
    except GeminiCancelledError as exc:
        if job is not None:
            raise JobCancelledError(str(exc)) from exc
        raise
    logger.info(
        "[map_extract][worker] gemini_call_end stage=%s model=%s elapsedMs=%s rawChars=%s",
        stage_name or "text",
        gateway.model_name,
        int((time.perf_counter() - call_started) * 1000),
        len(raw),
    )

    ensure_usage_progress(
        usage_totals=usage_totals,
        before_calls=before_calls,
        prompt_payload=prompt_payload,
        raw=raw,
    )

    logger.debug(
        "[map_extract][worker] raw_response stage=%s model=%s rawChars=%s raw=%s",
        stage_name or "text",
        gateway.model_name,
        len(raw),
        raw,
    )

    return raw


def _to_graph(
    *,
    job: JobRecord,
    component_id: str,
    overview_count: int,
    support_count: int,
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    symbol_markdown: str,
    symbol_legend: list[dict[str, str]],
    symbol_enum: list[str],
    tabular_csv: str,
    token_usage: dict[str, int],
    estimated_cost: dict[str, Any],
) -> dict[str, Any]:
    clean_nodes: list[dict[str, Any]] = []
    for node in nodes:
        cleaned = dict(node)
        cleaned.pop("_coordSource", None)
        clean_nodes.append(cleaned)

    existing_ids = {node["id"] for node in clean_nodes}
    for edge in edges:
        if edge["source"] not in existing_ids:
            clean_nodes.append(_normalize_node({"id": edge["source"], "label": edge["source"]}, len(clean_nodes)))
            existing_ids.add(edge["source"])
        if edge["target"] not in existing_ids:
            clean_nodes.append(_normalize_node({"id": edge["target"], "label": edge["target"]}, len(clean_nodes)))
            existing_ids.add(edge["target"])

    for node in clean_nodes:
        node.pop("_coordSource", None)

    return {
        "jobId": job.job_id,
        "graph": {
            "vertices": clean_nodes,
            "edges": edges,
            "metadata": {
                "pipeline": "map_extract",
                "coordinateSystem": "normalized",
                "componentId": component_id,
                "overviewMapFileCount": overview_count,
                "supportFileCount": support_count,
                "edgeCount": len(edges),
                "tokenUsage": {
                    "promptTokens": int(token_usage.get("prompt_tokens", 0)),
                    "outputTokens": int(token_usage.get("output_tokens", 0)),
                    "totalTokens": int(token_usage.get("prompt_tokens", 0))
                    + int(token_usage.get("output_tokens", 0)),
                    "providerTotalTokens": int(token_usage.get("provider_total_tokens", 0)),
                    "hiddenTokens": int(token_usage.get("hidden_tokens", 0)),
                    "callCount": int(token_usage.get("call_count", 0)),
                },
                "costEstimate": {
                    "currency": "USD",
                    "estimatedCost": estimated_cost.get("estimated"),
                    "inputRatePer1M": estimated_cost.get("input_rate"),
                    "outputRatePer1M": estimated_cost.get("output_rate"),
                    "source": estimated_cost.get("source"),
                    "note": "Rough estimate from configured rates (env) or model-family defaults.",
                },
                "extractmapSymbol": symbol_markdown,
                "symbolLegend": symbol_legend,
                "symbolEnum": symbol_enum,
                "tabularExtractionCsv": tabular_csv,
                "note": "Generated from map_extarct.json staged extraction.",
            },
        },
    }


def run_map_extract_worker(
    *,
    job: JobRecord,
    api_key: str | None,
    model_name: str,
    use_env_model_overrides: bool,
    component_id: str,
    overview_files: list[dict[str, Any]],
    support_files: list[dict[str, Any]],
    overview_additional_information: str,
    support_additional_information: str,
    resume_existing: bool = False,
) -> None:
    try:
        run_started = time.perf_counter()
        touch_activity(job)

        if not resume_existing:
            checkpoints.save_inputs(
                job.job_id,
                overview_files=overview_files,
                support_files=support_files,
                component_id=component_id,
                overview_additional_information=overview_additional_information,
                support_additional_information=support_additional_information,
                model_name=model_name,
                use_env_model_overrides=use_env_model_overrides,
            )
        usage_totals: dict[str, int] = {
            "prompt_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "call_count": 0,
        }
        stage_models = _resolve_stage_models(model_name, use_env_overrides=use_env_model_overrides)
        gateways: dict[str, GeminiGateway] = {}

        def stage_gateway(stage_key: str) -> GeminiGateway:
            stage_model = stage_models[stage_key]
            cached = gateways.get(stage_model)
            if cached is not None:
                return cached

            created = GeminiGateway(api_key=api_key, model_name=stage_model)
            gateways[stage_model] = created
            logger.info(
                "[map_extract][worker] gateway initialized jobId=%s stage=%s model=%s",
                job.job_id,
                stage_key,
                stage_model,
            )
            return created

        logger.info(
            "[map_extract][worker] start jobId=%s componentId=%s overviewFiles=%s supportFiles=%s defaultModel=%s stageModels=%s",
            job.job_id,
            component_id,
            len(overview_files),
            len(support_files),
            model_name,
            stage_models,
        )
        config = _load_map_extract_config()
        trait_table_raw = read_text(DEFAULT_MAP_BUFFER_TRAIT_TABLE)
        node_schema_text = _config_text(config, "extractmap_text_nodes_json_schema")
        dedup_policy_text = _config_text(config, "extractmap_text_dedup_policy")
        exclusion_policy_text = _config_text(config, "extractmap_text_exclusion_policy")
        compact_output_policy = _config_text(config, "compact_output_policy")
        symbol_output_hint = _config_text(config, "extractmap_symbol_output_hint")
        symbol_usage_policy = _config_text(config, "extractmap_text_symbol_usage_policy")
        tabular_output_hint = _config_text(config, "tabular_extraction_output_hint")
        tabular_no_support_hint = _config_text(config, "tabular_extraction_no_support_hint")
        normalize_prompt = _config_text(config, "extractmap_text_normalize_prompt")
        normalize_context = _config_text(config, "extractmap_text_normalize_context")
        edge_schema_text = _config_text(config, "edge_extraction_json_schema")
        edge_dedup_policy = _config_text(config, "edge_extraction_dedup_policy")
        edge_csv_fallback_hint = _config_text(config, "edge_extraction_csv_fallback_hint")
        coordinate_policy = _config_text(config, "extractmap_text_coordinate_policy")

        emit_job_event(
            job,
            "stage",
            {
                "stage": "map_extract/validate_inputs",
                "message": "Validating and classifying text/image/pdf inputs for map_extract.",
            },
        )
        logger.info(
            "[map_extract][worker] input summary jobId=%s overviewNames=%s supportNames=%s",
            job.job_id,
            [str(item.get("filename") or "") for item in overview_files],
            [str(item.get("filename") or "") for item in support_files],
        )

        if not overview_files:
            raise ValueError("map_extract requires at least one overview map image")

        primary_map = overview_files[0]
        image_dims = _image_dimensions(primary_map.get("data") or b"")
        if image_dims is not None:
            logger.info(
                "[map_extract][worker] primary_map_dimensions jobId=%s filename=%s width=%s height=%s",
                job.job_id,
                primary_map.get("filename"),
                image_dims[0],
                image_dims[1],
            )
        else:
            logger.info(
                "[map_extract][worker] primary_map_dimensions unavailable jobId=%s filename=%s mime=%s — falling back to coord heuristic",
                job.job_id,
                primary_map.get("filename"),
                primary_map.get("mime_type"),
            )

        map_parts: list[tuple[str, Part]] = [
            (str(file_data.get("filename") or f"map-{idx + 1}"), _make_part(file_data))
            for idx, file_data in enumerate(overview_files)
        ]
        support_parts: list[tuple[str, Part]] = [
            (str(file_data.get("filename") or f"support-{idx + 1}"), _make_part(file_data))
            for idx, file_data in enumerate(support_files)
        ]

        _raise_if_cancelled(job)
        stage1_cached = checkpoints.load_stage(job.job_id, "extractmap_symbol") if resume_existing else None
        if stage1_cached is not None:
            _restore_usage_totals_from_cache(stage1_cached, usage_totals)
            symbol_markdown = str(stage1_cached.get("symbolMarkdown") or "")
            symbol_legend = list(stage1_cached.get("symbolLegend") or [])
            symbol_enum = list(stage1_cached.get("symbolEnum") or [])
            symbol_context_payload = json.dumps(
                {"symbolEnum": symbol_enum, "symbolLegend": symbol_legend}, ensure_ascii=False
            )
            _emit_stage_with_usage(
                job=job,
                stage="map_extract/extractmap_symbol",
                message="Resumed from checkpoint (symbols).",
                model_name=model_name,
                token_usage=usage_totals,
            )
        else:
            _emit_stage_with_usage(
                job=job,
                stage="map_extract/extractmap_symbol",
                message="Extracting map symbols and notations.",
                model_name=model_name,
                token_usage=usage_totals,
            )
            symbol_started = _stage_begin(job.job_id, "extractmap_symbol")
            symbol_chunks: list[str] = []
            for map_name, map_part in map_parts:
                _raise_if_cancelled(job)
                chunk = _run_stage_text(
                    stage_gateway("extractmap_symbol"),
                    base_prompt=str(config["extractmap_symbol"].get("prompt") or ""),
                    extra_context=(
                        f"{symbol_output_hint}\n"
                        f"{compact_output_policy}\n"
                        f"source_map={map_name}"
                    ),
                    parts=[map_part],
                    usage_totals=usage_totals,
                    stage_name="map_extract/extractmap_symbol",
                    job=job,
                )
                if chunk:
                    symbol_chunks.append(f"## {map_name}\n{chunk}")
                touch_activity(job)

            symbol_markdown = "\n\n".join(symbol_chunks)
            symbol_legend = _extract_symbol_legend(symbol_markdown)
            symbol_enum = [entry["symbol"] for entry in symbol_legend if entry.get("symbol")]
            symbol_context_payload = json.dumps(
                {
                    "symbolEnum": symbol_enum,
                    "symbolLegend": symbol_legend,
                },
                ensure_ascii=False,
            )
            _stage_end(job.job_id, "extractmap_symbol", symbol_started, markdownLen=len(symbol_markdown))
            _save_stage_with_usage(
                job.job_id,
                "extractmap_symbol",
                {
                    "symbolMarkdown": symbol_markdown,
                    "symbolLegend": symbol_legend,
                    "symbolEnum": symbol_enum,
                },
                usage_totals,
            )
        _mark_stage_completed(job, "extractmap_symbol")

        _raise_if_cancelled(job)
        stage2_cached = checkpoints.load_stage(job.job_id, "extractmap_text") if resume_existing else None
        if stage2_cached is not None:
            _restore_usage_totals_from_cache(stage2_cached, usage_totals)
            nodes = list(stage2_cached.get("nodes") or [])
            node_payload_types = list(stage2_cached.get("payloadTypes") or [])
            _emit_stage_with_usage(
                job=job,
                stage="map_extract/extractmap_text",
                message=f"Resumed from checkpoint (nodes={len(nodes)}).",
                model_name=model_name,
                token_usage=usage_totals,
            )
            _mark_stage_completed(job, "extractmap_text")
            # Jump to stage 3 via a guarded block — the existing stage 2 body
            # is wrapped in `if True:` only when no checkpoint exists.
            _stage2_run = False
        else:
            _stage2_run = True

        if _stage2_run:
            _emit_stage_with_usage(
                job=job,
                stage="map_extract/extractmap_text",
                message="Extracting nodes and metadata from map with static buffer trait table.",
                model_name=model_name,
                token_usage=usage_totals,
            )
            node_started = _stage_begin(job.job_id, "extractmap_text")
            all_nodes: list[dict[str, Any]] = []
            node_payload_types = []

        # Stage 2 ("Nodes") intentionally consumes ONLY the map image(s).
        # Support documents are reserved for stage 3 (metadata extraction) and
        # stage 4 (support enrichment). Mixing support into stage 2 was causing
        # hallucinated nodes sourced from bin tables rather than the map itself.
        if _stage2_run:
            total_maps = len(map_parts)
            for map_name, map_part in map_parts:
                _raise_if_cancelled(job)
                nodes_payload = _run_stage_json(
                    stage_gateway("extractmap_text"),
                    stage_name="map_extract/extractmap_text",
                    base_prompt=str(config["extractmap_text"].get("prompt") or ""),
                    extra_context=(
                        f"{node_schema_text}\n\n"
                        f"{coordinate_policy}\n\n"
                        f"{dedup_policy_text}\n"
                        f"{exclusion_policy_text}\n"
                        f"{symbol_usage_policy}\n"
                        f"{compact_output_policy}\n"
                        f"incomplete_json={{\"nodes\": []}}\n"
                        f"buffer_trait_table={trait_table_raw}\n"
                        f"symbol_legend_json={symbol_context_payload}\n"
                        f"overviewAdditionalInformation={overview_additional_information}\n"
                        f"binAdditionalInformation={support_additional_information}\n"
                        f"extractmap_symbol_markdown={symbol_markdown}\n"
                        f"source_map={map_name}"
                    ),
                    parts=[map_part],
                    response_schema=MAP_EXTRACT_NODE_RESPONSE_SCHEMA,
                    usage_totals=usage_totals,
                    job=job,
                )
                all_nodes.extend(_extract_nodes(nodes_payload, image_dims=image_dims))
                node_payload_types.append(type(nodes_payload).__name__)
                _emit_stage_with_usage(
                    job=job,
                    stage="map_extract/extractmap_text",
                    message=(
                        f"Processed map '{map_name}' "
                        f"({len(node_payload_types)}/{total_maps})."
                    ),
                    model_name=model_name,
                    token_usage=usage_totals,
                )
                touch_activity(job)

        if _stage2_run:
            nodes = _merge_nodes(_filter_active_nodes(all_nodes))
            nodes = _apply_symbol_metadata(nodes, symbol_enum)

            if len(nodes) < 2:
                raise ValueError(
                    "map_extract failed: insufficient nodes extracted in stage 2 "
                    f"(nodeCount={len(nodes)}, payloadTypes={node_payload_types})."
                )

            _stage_end(
                job.job_id,
                "extractmap_text",
                node_started,
                nodeCount=len(nodes),
                payloadTypes=node_payload_types,
            )
            _save_stage_with_usage(
                job.job_id,
                "extractmap_text",
                {
                    "nodes": nodes,
                    "payloadTypes": node_payload_types,
                },
                usage_totals,
            )
            _mark_stage_completed(job, "extractmap_text")

        _raise_if_cancelled(job)
        stage3_cached = checkpoints.load_stage(job.job_id, "tabular_extraction") if resume_existing else None
        if stage3_cached is not None:
            _restore_usage_totals_from_cache(stage3_cached, usage_totals)
            tabular_csv = str(stage3_cached.get("tabularCsv") or "")
            csv_chunks = list(stage3_cached.get("csvChunks") or [])
            _emit_stage_with_usage(
                job=job,
                stage="map_extract/tabular_extraction",
                message=f"Resumed from checkpoint (csvLen={len(tabular_csv)}).",
                model_name=model_name,
                token_usage=usage_totals,
            )
            _stage3_run = False
        else:
            _stage3_run = True
            _emit_stage_with_usage(
                job=job,
                stage="map_extract/tabular_extraction",
                message="Extracting tabular data from support images/PDFs.",
                model_name=model_name,
                token_usage=usage_totals,
            )
            table_started = _stage_begin(job.job_id, "tabular_extraction")
            csv_chunks = []

        if _stage3_run and support_parts:
            total_support = len(support_parts)
            # Stage 3 ("Tables") processes each support file individually.
            # Inputs per iteration:
            #   - ONE support artifact (the only binary part sent to Gemini)
            #   - stage_2_nodes JSON (reference only — keys metadata rows to
            #     existing node ids so stage 4 can merge them back in)
            # The map image is NOT passed here; it belongs to stage 2 (node
            # discovery) and stage 5 (edge / traversal cost). Stage 4 performs
            # the actual merge of these CSV chunks into the stage-2 nodes.
            stage3_nodes_json = json.dumps({"nodes": nodes}, ensure_ascii=False)
            for support_idx, (support_name, support_part) in enumerate(support_parts, start=1):
                emit_job_event(
                    job,
                    "stage",
                    {
                        "stage": "map_extract/tabular_extraction",
                        "message": f"Processing support file {support_idx}/{total_support}: {support_name}",
                    },
                )
                csv_text = _run_stage_text(
                    stage_gateway("tabular_extraction"),
                    base_prompt=str(config["tabular_extraction"].get("prompt") or ""),
                    extra_context=(
                        f"{tabular_output_hint}\n"
                        f"{compact_output_policy}\n"
                        f"prior_table={trait_table_raw}\n"
                        "Process only the single support artifact attached. "
                        "Produce structured rows whose identifiers align with stage_2_nodes "
                        "(use the node id/label from stage_2_nodes as the join key). "
                        "Do NOT invent nodes that are not present in stage_2_nodes.\n"
                        f"stage_2_nodes={stage3_nodes_json}\n"
                        f"source_artifact={support_name}"
                    ),
                    parts=[support_part],
                    usage_totals=usage_totals,
                    stage_name="map_extract/tabular_extraction",
                    job=job,
                )
                if csv_text:
                    csv_chunks.append(f"# {support_name}\n{csv_text}")
                _emit_stage_with_usage(
                    job=job,
                    stage="map_extract/tabular_extraction",
                    message=f"Processed support file {support_idx}/{total_support}: {support_name}",
                    model_name=model_name,
                    token_usage=usage_totals,
                )
        elif _stage3_run:
            first_map_name, first_map_part = map_parts[0]
            csv_text = _run_stage_text(
                stage_gateway("tabular_extraction"),
                base_prompt=str(config["tabular_extraction"].get("prompt") or ""),
                extra_context=(
                    f"{tabular_output_hint}\n"
                    f"{compact_output_policy}\n"
                    f"prior_table={trait_table_raw}\n"
                    f"{tabular_no_support_hint}\n"
                    f"map_ocr_text_context={overview_additional_information}\n"
                    f"source_map={first_map_name}"
                ),
                parts=[first_map_part],
                usage_totals=usage_totals,
                stage_name="map_extract/tabular_extraction",
                job=job,
            )
            if csv_text:
                csv_chunks.append(f"# {first_map_name}\n{csv_text}")
            _emit_stage_with_usage(
                job=job,
                stage="map_extract/tabular_extraction",
                message=f"Processed map-derived tabular extraction for: {first_map_name}",
                model_name=model_name,
                token_usage=usage_totals,
            )

        if _stage3_run:
            tabular_csv = "\n\n".join(csv_chunks)
            _save_stage_with_usage(
                job.job_id,
                "tabular_extraction",
                {
                    "tabularCsv": tabular_csv,
                    "csvChunks": csv_chunks,
                },
                usage_totals,
            )
            _mark_stage_completed(job, "tabular_extraction")
        # Keep full stage-3 output for stage-4 merging; do not truncate context.
        stage4_tabular_csv_context = "\n\n".join(csv_chunks)

        _raise_if_cancelled(job)
        stage4_cached = checkpoints.load_stage(job.job_id, "support_enrichment") if resume_existing else None
        if stage4_cached is not None:
            _restore_usage_totals_from_cache(stage4_cached, usage_totals)
            nodes = list(stage4_cached.get("nodes") or [])
            support_enriched_nodes = list(stage4_cached.get("supportEnrichedNodes") or [])
            matched_count = int(stage4_cached.get("matchedCount") or 0)
            ignored_non_stage2_count = int(stage4_cached.get("ignoredNonStage2Count") or 0)
            _emit_stage_with_usage(
                job=job,
                stage="map_extract/support_enrichment",
                message=f"Resumed from checkpoint (nodes={len(nodes)}).",
                model_name=model_name,
                token_usage=usage_totals,
            )
            _mark_stage_completed(job, "support_enrichment")
            _stage4_run = False
        else:
            _stage4_run = True

        if _stage4_run:
            # Stage 4: always let Gemini map stage-3 text into the stage-2 JSON.
            known_node_ids_for_stage4 = {str(node.get("id") or "").strip() for node in nodes if str(node.get("id") or "").strip()}
            tabular_row_candidates = _extract_stage4_tabular_candidates(
                stage4_tabular_csv_context,
                known_node_ids_for_stage4,
            )
            _emit_stage_with_usage(
                job=job,
                stage="map_extract/support_enrichment",
                message="Applying Gemini mapping from stage-3 outputs into stage-2 nodes.",
                model_name=model_name,
                token_usage=usage_totals,
            )
            merged_payload = _run_stage_json(
                stage_gateway("extractmap_text"),
                stage_name="map_extract/support_enrichment",
                base_prompt=normalize_prompt,
                extra_context=(
                    f"{normalize_context}\n"
                    f"{node_schema_text}\n"
                    f"{coordinate_policy}\n"
                    f"{dedup_policy_text}\n"
                    f"{exclusion_policy_text}\n"
                    f"{symbol_usage_policy}\n"
                    f"{compact_output_policy}\n"
                    "Use tabular_row_candidates_json as header-agnostic normalized rows. Headers may be inconsistent or missing.\n"
                    "Map candidate rows into existing_nodes by exact id and transfer tabular fields into metadata keys.\n"
                    "CRITICAL: existing_nodes is the stage-2 seed JSON. Complete/fill it from source_text. "
                    "Do not invent map-root placeholders. Keep existing IDs.\n"
                    f"symbol_legend_json={symbol_context_payload}\n"
                    f"existing_nodes={json.dumps({'nodes': nodes}, ensure_ascii=False)}\n"
                    f"tabular_row_candidates_json={json.dumps(tabular_row_candidates, ensure_ascii=False)}\n"
                    f"extractmap_symbol_markdown={symbol_markdown}\n"
                    f"source_text={stage4_tabular_csv_context}"
                ),
                parts=None,
                response_schema=MAP_EXTRACT_NODE_RESPONSE_SCHEMA,
                usage_totals=usage_totals,
                job=job,
            )
            support_enriched_nodes = _extract_nodes(merged_payload, image_dims=image_dims)
            nodes, matched_count, ignored_non_stage2_count = _merge_stage4_completion(nodes, support_enriched_nodes)
            nodes = _apply_symbol_metadata(nodes, symbol_enum)
            model_enriched_count = _count_enriched_nodes(nodes)
            overlay_enriched_count = 0
            if tabular_row_candidates:
                # Overlay only fills empty metadata slots, so it's safe to run
                # unconditionally as a deterministic backstop against sparse
                # Gemini output on stage-4.
                nodes, overlay_enriched_count = _apply_stage4_tabular_overlay(nodes, tabular_row_candidates)
                nodes = _apply_symbol_metadata(nodes, symbol_enum)
            final_enriched_count = _count_enriched_nodes(nodes)
            _emit_stage_with_usage(
                job=job,
                stage="map_extract/support_enrichment",
                message=(
                    f"Gemini completion merged into stage-2 nodes: "
                    f"matched={matched_count}, ignoredNonStage2={ignored_non_stage2_count}, "
                    f"enriched={final_enriched_count}/{len(nodes)}, overlay={overlay_enriched_count}."
                ),
                model_name=model_name,
                token_usage=usage_totals,
            )
            logger.info(
                "[map_extract][worker] support enrichment mapped jobId=%s supportNodeCount=%s matched=%s ignoredNonStage2=%s tabularCandidates=%s modelEnriched=%s finalEnriched=%s overlayEnriched=%s finalNodeCount=%s",
                job.job_id,
                len(support_enriched_nodes),
                matched_count,
                ignored_non_stage2_count,
                len(tabular_row_candidates),
                model_enriched_count,
                final_enriched_count,
                overlay_enriched_count,
                len(nodes),
            )
            if final_enriched_count < max(1, int(len(nodes) * 0.25)):
                logger.warning(
                    "[map_extract][worker] support enrichment sparse jobId=%s enriched=%s/%s",
                    job.job_id,
                    final_enriched_count,
                    len(nodes),
                )
            _save_stage_with_usage(
                job.job_id,
                "support_enrichment",
                {
                    "nodes": nodes,
                    "supportEnrichedNodes": support_enriched_nodes,
                    "matchedCount": matched_count,
                    "ignoredNonStage2Count": ignored_non_stage2_count,
                    "tabularCandidateCount": len(tabular_row_candidates),
                    "modelEnrichedCount": model_enriched_count,
                    "finalEnrichedCount": final_enriched_count,
                    "overlayEnrichedCount": overlay_enriched_count,
                },
                usage_totals,
            )
            _mark_stage_completed(job, "support_enrichment")

        if len(nodes) < 2:
            raise ValueError(
                "map_extract failed: insufficient nodes after stage 4 enrichment "
                f"(nodeCount={len(nodes)})."
            )

        if _stage3_run:
            _stage_end(job.job_id, "tabular_extraction", table_started, csvLen=len(tabular_csv))

        _raise_if_cancelled(job)
        stage5_cached = checkpoints.load_stage(job.job_id, "edge_extraction") if resume_existing else None
        if stage5_cached is not None:
            _restore_usage_totals_from_cache(stage5_cached, usage_totals)
            edges = list(stage5_cached.get("edges") or [])
            edge_payload_types = list(stage5_cached.get("payloadTypes") or [])
            _emit_stage_with_usage(
                job=job,
                stage="map_extract/edge_extraction",
                message=f"Resumed from checkpoint (edges={len(edges)}).",
                model_name=model_name,
                token_usage=usage_totals,
            )
            _mark_stage_completed(job, "edge_extraction")
            _stage5_run = False
        else:
            _stage5_run = True

        if _stage5_run:
            _emit_stage_with_usage(
                job=job,
                stage="map_extract/edge_extraction",
                message="Generating traversal edges with approximate costs.",
                model_name=model_name,
                token_usage=usage_totals,
            )
            edge_started = _stage_begin(job.job_id, "edge_extraction")
            all_edges: list[dict[str, Any]] = []
            edge_payload_types = []
            total_maps_for_edge = len(map_parts)
        for edge_index, (map_name, map_part) in enumerate(map_parts if _stage5_run else [], start=1):
            _raise_if_cancelled(job)
            edges_payload = _run_stage_json(
                stage_gateway("edge_extraction"),
                stage_name="map_extract/edge_extraction",
                base_prompt=str(config["edge_extraction"].get("prompt") or ""),
                extra_context=(
                    f"{edge_schema_text}\n\n"
                    f"{edge_dedup_policy}\n"
                    f"{compact_output_policy}\n"
                    f"{edge_csv_fallback_hint}\n"
                    f"source_map={map_name}\n"
                    f"extracted_node_json={json.dumps({'nodes': nodes}, ensure_ascii=False)}\n"
                    f"tabular_extraction_csv={tabular_csv}"
                ),
                parts=[map_part],
                response_schema=MAP_EXTRACT_EDGE_RESPONSE_SCHEMA,
                usage_totals=usage_totals,
                job=job,
            )

            all_edges.extend(_extract_edges(edges_payload, {node["id"] for node in nodes}))
            edge_payload_types.append(type(edges_payload).__name__)
            _emit_stage_with_usage(
                job=job,
                stage="map_extract/edge_extraction",
                message=f"Processed edge extraction for map {edge_index}/{total_maps_for_edge}: {map_name}",
                model_name=model_name,
                token_usage=usage_totals,
            )
            touch_activity(job)

        if _stage5_run:
            edges = _merge_edges(all_edges)
            edges = _filter_edges_by_nodes(edges, nodes)

            _stage_end(
                job.job_id,
                "edge_extraction",
                edge_started,
                edgeCount=len(edges),
                payloadTypes=edge_payload_types,
            )
            _save_stage_with_usage(
                job.job_id,
                "edge_extraction",
                {
                    "edges": edges,
                    "payloadTypes": edge_payload_types,
                },
                usage_totals,
            )
            _mark_stage_completed(job, "edge_extraction")

        _raise_if_cancelled(job)
        _emit_stage_with_usage(
            job=job,
            stage="map_extract/finalize_graph",
            message="Building final graph payload from extracted nodes and edges.",
            model_name=model_name,
            token_usage=usage_totals,
        )
        finalize_started = _stage_begin(job.job_id, "finalize_graph")

        cost_estimate = _estimate_cost_usd(
            model_name=model_name,
            prompt_tokens=int(usage_totals.get("prompt_tokens", 0)),
            output_tokens=int(usage_totals.get("output_tokens", 0)),
        )

        result = _to_graph(
            job=job,
            component_id=component_id,
            overview_count=len(overview_files),
            support_count=len(support_files),
            nodes=nodes,
            edges=edges,
            symbol_markdown=symbol_markdown,
            symbol_legend=symbol_legend,
            symbol_enum=symbol_enum,
            tabular_csv=tabular_csv,
            token_usage=usage_totals,
            estimated_cost=cost_estimate,
        )
        _stage_end(
            job.job_id,
            "finalize_graph",
            finalize_started,
            vertexCount=len(result["graph"]["vertices"]),
            edgeCount=len(result["graph"]["edges"]),
        )
        _save_stage_with_usage(job.job_id, "finalize_graph", result, usage_totals)
        _mark_stage_completed(job, "finalize_graph")
        emit_job_event(job, "result", result)
        emit_job_event(job, "done", {"status": "completed"})
        logger.info(
            "[map_extract][worker] completed jobId=%s vertexCount=%s edgeCount=%s totalElapsedMs=%s usage=%s",
            job.job_id,
            len(result["graph"]["vertices"]),
            len(result["graph"]["edges"]),
            int((time.perf_counter() - run_started) * 1000),
            {
                "promptTokens": int(usage_totals.get("prompt_tokens", 0)),
                "outputTokens": int(usage_totals.get("output_tokens", 0)),
                "totalTokens": int(usage_totals.get("total_tokens", 0)),
                "callCount": int(usage_totals.get("call_count", 0)),
            },
        )
    except JobCancelledError:
        # Roll back the stage that was mid-flight when cancel fired so a
        # later resume will re-run it instead of treating a partial (or
        # already-saved but undesired) checkpoint as completed.  Without
        # this the resume silently skips the cancelled stage, which
        # contradicts the user-visible "terminate" semantics.
        cancelled_stage = str(job.current_stage or "")
        if cancelled_stage.startswith("map_extract/"):
            cancelled_stage = cancelled_stage[len("map_extract/"):]
        # Only roll back the mid-flight stage.  If the stage is already in
        # completed_stages the cancel fired at a between-stage boundary —
        # keep every completed checkpoint so resume picks up where we
        # actually were (the next pending stage), not one stage earlier.
        should_rollback = (
            cancelled_stage
            and cancelled_stage in checkpoints.STAGE_ORDER
            and cancelled_stage not in job.completed_stages
        )
        if should_rollback:
            removed = checkpoints.delete_from(job.job_id, cancelled_stage)
            cutoff = checkpoints.stage_index(cancelled_stage)
            with JOBS_LOCK:
                job.completed_stages = [
                    s for s in job.completed_stages
                    if checkpoints.stage_index(s) < cutoff
                ]
            logger.info(
                "[map_extract][worker] cancel rolled back jobId=%s fromStage=%s removed=%s",
                job.job_id,
                cancelled_stage,
                removed,
            )
        else:
            logger.info(
                "[map_extract][worker] cancel at stage boundary jobId=%s stage=%s completed=%s",
                job.job_id,
                cancelled_stage,
                list(job.completed_stages),
            )
        logger.warning("[map_extract][worker] cancelled jobId=%s", job.job_id)
        mark_cancelled(job.job_id)
        emit_job_event(job, "stage", {"stage": "map_extract/cancelled", "message": "Cancelled by user."})
        emit_job_event(job, "close", None)
        return
    except Exception as exc:  # pragma: no cover - defensive worker safety
        logger.exception("[map_extract][worker] failed jobId=%s", job.job_id)
        emit_job_event(job, "error", {"error": f"map_extract worker failed: {exc}"})
        emit_job_event(job, "close", None)
        return

    emit_job_event(job, "close", None)
