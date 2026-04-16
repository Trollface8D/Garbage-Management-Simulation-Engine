from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any

from google.genai.types import Part

from ...infra.gemini_client import GeminiGateway
from ...infra.io_utils import read_text
from ...infra.paths import DEFAULT_MAP_BUFFER_TRAIT_TABLE, DEFAULT_MAP_EXTRACT_PROMPT_CONFIG
from ..models.job_models import JobRecord
from .job_store import emit_job_event


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
        "extractmap_symbol_output_hint",
        "tabular_extraction_output_hint",
        "tabular_extraction_no_support_hint",
        "extractmap_text_support_joint_prompt",
        "extractmap_text_support_fallback_prompt",
        "extractmap_text_support_delta_prompt",
        "extractmap_text_normalize_prompt",
        "extractmap_text_normalize_context",
        "extractmap_text_support_delta_context",
        "edge_extraction_json_schema",
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


def _normalize_node(item: Any, index: int) -> dict[str, Any]:
    def normalize_coordinate(raw: Any, *, axis: str) -> float | None:
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return None

        if value > 1:
            # Heuristic: model may return pixel-like coordinates.
            if value > 100:
                value = value / 1000.0
            else:
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
        fx = normalize_coordinate(item.get("x"), axis="x")
        fy = normalize_coordinate(item.get("y"), axis="y")

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
            "metadata": item,
        }

    text = str(item).strip() or f"N{index + 1}"
    return {
        "id": f"N{index + 1}",
        "label": text,
        "x": round(0.15 + ((index % 5) * 0.16), 3),
        "y": round(0.2 + ((index // 5) * 0.18), 3),
        "type": None,
        "metadata": {"raw": item},
    }


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


def _extract_nodes(payload: Any) -> list[dict[str, Any]]:
    candidates: list[Any] = []
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
        normalized.append(_normalize_node(item, i))
    return normalized


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

    # 3) Arrow fallback: A -> B (cost=...)
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
        if known_node_ids and (src not in known_node_ids or tgt not in known_node_ids):
            # Keep strict when we know expected node IDs to reduce hallucinated edges.
            continue
        edge_obj: dict[str, Any] = {"id": f"E{line_no}", "source": src, "target": tgt}
        if match.group("cost"):
            edge_obj["approximate_cost"] = match.group("cost")
        normalized = _normalize_edge(edge_obj, line_no - 1)
        if normalized:
            extracted.append(normalized)
    if extracted:
        return extracted

    # 4) Last resort: if line mentions exactly two known nodes, infer an edge.
    if known_node_ids:
        node_pattern = re.compile(r"[A-Za-z0-9._-]+")
        inferred: list[dict[str, Any]] = []
        for line_no, row in enumerate(lines, start=1):
            tokens = node_pattern.findall(row)
            hits = [token for token in tokens if token in known_node_ids]
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
            result.append(normalized)
    return result


def _merge_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for node in nodes:
        node_id = str(node.get("id") or "").strip()
        if not node_id:
            continue

        existing = merged.get(node_id)
        if not existing:
            merged[node_id] = node
            continue

        # Keep first stable coordinates/label but merge metadata.
        if not existing.get("label") and node.get("label"):
            existing["label"] = node["label"]
        if existing.get("type") is None and node.get("type") is not None:
            existing["type"] = node["type"]

        existing_meta = existing.get("metadata")
        next_meta = node.get("metadata")
        if isinstance(existing_meta, dict) and isinstance(next_meta, dict):
            existing_meta.update(next_meta)
        elif next_meta is not None:
            existing["metadata"] = next_meta

    return list(merged.values())


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
    base_prompt: str,
    extra_context: str,
    parts: list[Part] | None,
) -> Any:
    raw = gateway.generate_text(
        f"{base_prompt}\n\n{extra_context}",
        parts=parts,
        response_json=True,
    ).strip()
    if not raw:
        return {}
    return GeminiGateway.parse_json_relaxed(raw)


def _run_stage_text(
    gateway: GeminiGateway,
    *,
    base_prompt: str,
    extra_context: str,
    parts: list[Part] | None,
) -> str:
    return gateway.generate_text(
        f"{base_prompt}\n\n{extra_context}",
        parts=parts,
        response_json=False,
    ).strip()


def _to_graph(
    *,
    job: JobRecord,
    component_id: str,
    overview_count: int,
    support_count: int,
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    symbol_markdown: str,
    tabular_csv: str,
) -> dict[str, Any]:
    existing_ids = {node["id"] for node in nodes}
    for edge in edges:
        if edge["source"] not in existing_ids:
            nodes.append(_normalize_node({"id": edge["source"], "label": edge["source"]}, len(nodes)))
            existing_ids.add(edge["source"])
        if edge["target"] not in existing_ids:
            nodes.append(_normalize_node({"id": edge["target"], "label": edge["target"]}, len(nodes)))
            existing_ids.add(edge["target"])

    return {
        "jobId": job.job_id,
        "graph": {
            "vertices": nodes,
            "edges": edges,
            "metadata": {
                "pipeline": "map_extract",
                "coordinateSystem": "normalized",
                "componentId": component_id,
                "overviewMapFileCount": overview_count,
                "supportFileCount": support_count,
                "edgeCount": len(edges),
                "extractmapSymbol": symbol_markdown[:4000],
                "tabularExtractionCsv": tabular_csv[:4000],
                "note": "Generated from map_extarct.json staged extraction.",
            },
        },
    }


def run_map_extract_worker(
    *,
    job: JobRecord,
    api_key: str,
    model_name: str,
    use_env_model_overrides: bool,
    component_id: str,
    overview_files: list[dict[str, Any]],
    support_files: list[dict[str, Any]],
    overview_additional_information: str,
    support_additional_information: str,
) -> None:
    try:
        run_started = time.perf_counter()
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
        symbol_output_hint = _config_text(config, "extractmap_symbol_output_hint")
        tabular_output_hint = _config_text(config, "tabular_extraction_output_hint")
        tabular_no_support_hint = _config_text(config, "tabular_extraction_no_support_hint")
        support_joint_prompt = _config_text(config, "extractmap_text_support_joint_prompt")
        support_fallback_prompt = _config_text(config, "extractmap_text_support_fallback_prompt")
        support_delta_prompt = _config_text(config, "extractmap_text_support_delta_prompt")
        normalize_prompt = _config_text(config, "extractmap_text_normalize_prompt")
        normalize_context = _config_text(config, "extractmap_text_normalize_context")
        support_delta_context = _config_text(config, "extractmap_text_support_delta_context")
        edge_schema_text = _config_text(config, "edge_extraction_json_schema")
        edge_csv_fallback_hint = _config_text(config, "edge_extraction_csv_fallback_hint")

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

        map_parts: list[tuple[str, Part]] = [
            (str(file_data.get("filename") or f"map-{idx + 1}"), _make_part(file_data))
            for idx, file_data in enumerate(overview_files)
        ]
        support_parts: list[tuple[str, Part]] = [
            (str(file_data.get("filename") or f"support-{idx + 1}"), _make_part(file_data))
            for idx, file_data in enumerate(support_files)
        ]

        emit_job_event(
            job,
            "stage",
            {
                "stage": "map_extract/extractmap_symbol",
                "message": "Extracting map symbols and notations.",
            },
        )
        symbol_started = _stage_begin(job.job_id, "extractmap_symbol")
        symbol_chunks: list[str] = []
        for map_name, map_part in map_parts:
            chunk = _run_stage_text(
                stage_gateway("extractmap_symbol"),
                base_prompt=str(config["extractmap_symbol"].get("prompt") or ""),
                extra_context=(
                    f"{symbol_output_hint}\n"
                    f"source_map={map_name}"
                ),
                parts=[map_part],
            )
            if chunk:
                symbol_chunks.append(f"## {map_name}\n{chunk}")

        symbol_markdown = "\n\n".join(symbol_chunks)
        _stage_end(job.job_id, "extractmap_symbol", symbol_started, markdownLen=len(symbol_markdown))

        emit_job_event(
            job,
            "stage",
            {
                "stage": "map_extract/extractmap_text",
                "message": "Extracting nodes and metadata from map with static buffer trait table.",
            },
        )
        node_started = _stage_begin(job.job_id, "extractmap_text")
        all_nodes: list[dict[str, Any]] = []
        node_payload_types: list[str] = []

        if support_parts:
            for map_name, map_part in map_parts:
                for support_name, support_part in support_parts:
                    nodes_payload = _run_stage_json(
                        stage_gateway("extractmap_text"),
                        base_prompt=str(config["extractmap_text"].get("prompt") or ""),
                        extra_context=(
                            f"{node_schema_text}\n\n"
                            f"incomplete_json={{\"nodes\": []}}\n"
                            f"buffer_trait_table={trait_table_raw}\n"
                            f"overviewAdditionalInformation={overview_additional_information}\n"
                            f"binAdditionalInformation={support_additional_information}\n"
                            f"extractmap_symbol_markdown={symbol_markdown[:3000]}\n"
                            f"source_map={map_name}\n"
                            f"source_bin_data={support_name}"
                        ),
                        parts=[map_part, support_part],
                    )
                    all_nodes.extend(_extract_nodes(nodes_payload))
                    node_payload_types.append(type(nodes_payload).__name__)
        else:
            for map_name, map_part in map_parts:
                nodes_payload = _run_stage_json(
                    stage_gateway("extractmap_text"),
                    base_prompt=str(config["extractmap_text"].get("prompt") or ""),
                    extra_context=(
                        f"{node_schema_text}\n\n"
                        f"incomplete_json={{\"nodes\": []}}\n"
                        f"buffer_trait_table={trait_table_raw}\n"
                        f"overviewAdditionalInformation={overview_additional_information}\n"
                        f"binAdditionalInformation={support_additional_information}\n"
                        f"extractmap_symbol_markdown={symbol_markdown[:3000]}\n"
                        f"source_map={map_name}"
                    ),
                    parts=[map_part],
                )
                all_nodes.extend(_extract_nodes(nodes_payload))
                node_payload_types.append(type(nodes_payload).__name__)

        nodes = _merge_nodes(all_nodes)

        if not nodes:
            nodes = [_normalize_node({"id": "N1", "label": "Map Root", "type": "Map"}, 0)]

        _stage_end(
            job.job_id,
            "extractmap_text",
            node_started,
            nodeCount=len(nodes),
            payloadTypes=node_payload_types,
        )

        emit_job_event(
            job,
            "stage",
            {
                "stage": "map_extract/tabular_extraction",
                "message": "Extracting tabular data from support images/PDFs.",
            },
        )
        table_started = _stage_begin(job.job_id, "tabular_extraction")
        csv_chunks: list[str] = []
        if support_parts:
            for support_name, support_part in support_parts:
                csv_text = _run_stage_text(
                    stage_gateway("tabular_extraction"),
                    base_prompt=str(config["tabular_extraction"].get("prompt") or ""),
                    extra_context=(
                        f"{tabular_output_hint}\n"
                        "Process only the provided single artifact.\n"
                        f"source_artifact={support_name}"
                    ),
                    parts=[support_part],
                )
                if csv_text:
                    csv_chunks.append(f"# {support_name}\n{csv_text}")
        else:
            first_map_name, first_map_part = map_parts[0]
            csv_text = _run_stage_text(
                stage_gateway("tabular_extraction"),
                base_prompt=str(config["tabular_extraction"].get("prompt") or ""),
                extra_context=(
                    f"{tabular_output_hint}\n"
                    f"{tabular_no_support_hint}\n"
                    f"source_map={first_map_name}"
                ),
                parts=[first_map_part],
            )
            if csv_text:
                csv_chunks.append(f"# {first_map_name}\n{csv_text}")

        tabular_csv = "\n\n".join(csv_chunks)

        # LLM-based enrichment from support/bin artifacts to capture bin series (e.g., L.*) robustly.
        support_enriched_nodes: list[dict[str, Any]] = []
        if support_parts:
            reference_map_name, reference_map_part = map_parts[0]
            for support_name, support_part in support_parts:
                support_nodes_payload = _run_stage_json(
                    stage_gateway("extractmap_text"),
                    base_prompt=support_joint_prompt,
                    extra_context=(
                        f"{node_schema_text}\n\n"
                        f"reference_map={reference_map_name}\n"
                        f"support_artifact={support_name}\n"
                        "Use support artifact for detailed bin data and map for placement/context.\n"
                        f"existing_nodes={json.dumps({'nodes': nodes}, ensure_ascii=False)[:6000]}\n"
                        f"extractmap_symbol_markdown={symbol_markdown[:3000]}\n"
                        f"tabular_extraction_csv={tabular_csv[:5000]}"
                    ),
                    parts=[reference_map_part, support_part],
                )

                extracted_from_support = _extract_nodes(support_nodes_payload)

                if not extracted_from_support:
                    # LLM normalization fallback for non-conforming JSON.
                    support_nodes_text = _run_stage_text(
                        stage_gateway("extractmap_text"),
                        base_prompt=support_fallback_prompt,
                        extra_context=(
                            f"support_artifact={support_name}\n"
                            f"tabular_extraction_csv={tabular_csv[:5000]}\n"
                            f"extractmap_symbol_markdown={symbol_markdown[:3000]}\n"
                            f"existing_nodes={json.dumps({'nodes': nodes}, ensure_ascii=False)[:5000]}"
                        ),
                        parts=[support_part],
                    )

                    normalized_payload = _run_stage_json(
                        stage_gateway("extractmap_text"),
                        base_prompt=normalize_prompt,
                        extra_context=(
                            f"{normalize_context}\n"
                            f"source_text={support_nodes_text[:7000]}"
                        ),
                        parts=None,
                    )
                    extracted_from_support = _extract_nodes(normalized_payload)

                if not extracted_from_support:
                    # Final coercion: if model returned a single dict-like node, wrap it.
                    if isinstance(support_nodes_payload, dict):
                        support_nodes_payload = {"nodes": [support_nodes_payload]}
                    extracted_from_support = _extract_nodes(support_nodes_payload)

                logger.info(
                    "[map_extract][worker] support artifact extraction jobId=%s support=%s extractedNodeCount=%s",
                    job.job_id,
                    support_name,
                    len(extracted_from_support),
                )

                support_enriched_nodes.extend(extracted_from_support)

                # Keep merged context updated so later support files can enrich missing fields.
                if extracted_from_support:
                    nodes = _merge_nodes([*nodes, *extracted_from_support])

                # Backward-compatible text extraction path retained for noisy artifacts.
                support_nodes_text = _run_stage_text(
                    stage_gateway("extractmap_text"),
                    base_prompt=support_delta_prompt,
                    extra_context=(
                        f"{support_delta_context}\n"
                        f"support_artifact={support_name}\n"
                        f"existing_nodes={json.dumps({'nodes': nodes}, ensure_ascii=False)[:6000]}"
                    ),
                    parts=[support_part],
                )

                if support_nodes_text.strip():
                    normalized_payload = _run_stage_json(
                        stage_gateway("extractmap_text"),
                        base_prompt=normalize_prompt,
                        extra_context=(
                            f"{normalize_context}\n"
                            f"source_text={support_nodes_text[:7000]}"
                        ),
                        parts=None,
                    )
                    text_nodes = _extract_nodes(normalized_payload)
                    if text_nodes:
                        support_enriched_nodes.extend(text_nodes)
                        nodes = _merge_nodes([*nodes, *text_nodes])

        if support_enriched_nodes:
            nodes = _merge_nodes([*nodes, *support_enriched_nodes])
            logger.info(
                "[map_extract][worker] support node enrichment jobId=%s supportNodeCount=%s mergedNodeCount=%s",
                job.job_id,
                len(support_enriched_nodes),
                len(nodes),
            )

        _stage_end(job.job_id, "tabular_extraction", table_started, csvLen=len(tabular_csv))

        emit_job_event(
            job,
            "stage",
            {
                "stage": "map_extract/edge_extraction",
                "message": "Generating traversal edges with approximate costs.",
            },
        )
        edge_started = _stage_begin(job.job_id, "edge_extraction")
        all_edges: list[dict[str, Any]] = []
        edge_payload_types: list[str] = []
        for map_name, map_part in map_parts:
            edge_raw_text = _run_stage_text(
                stage_gateway("edge_extraction"),
                base_prompt=str(config["edge_extraction"].get("prompt") or ""),
                extra_context=(
                    f"{edge_schema_text}\n\n"
                    f"{edge_csv_fallback_hint}\n"
                    f"source_map={map_name}\n"
                    f"extracted_node_json={json.dumps({'nodes': nodes}, ensure_ascii=False)}\n"
                    f"tabular_extraction_csv={tabular_csv[:3000]}"
                ),
                parts=[map_part],
            )

            try:
                edges_payload: Any = GeminiGateway.parse_json_relaxed(edge_raw_text)
            except ValueError:
                edges_payload = edge_raw_text

            all_edges.extend(_extract_edges(edges_payload, {node["id"] for node in nodes}))
            edge_payload_types.append(type(edges_payload).__name__)

        edges = _merge_edges(all_edges)

        _stage_end(
            job.job_id,
            "edge_extraction",
            edge_started,
            edgeCount=len(edges),
            payloadTypes=edge_payload_types,
        )

        emit_job_event(
            job,
            "stage",
            {
                "stage": "map_extract/finalize_graph",
                "message": "Building final graph payload from extracted nodes and edges.",
            },
        )
        finalize_started = _stage_begin(job.job_id, "finalize_graph")

        result = _to_graph(
            job=job,
            component_id=component_id,
            overview_count=len(overview_files),
            support_count=len(support_files),
            nodes=nodes,
            edges=edges,
            symbol_markdown=symbol_markdown,
            tabular_csv=tabular_csv,
        )
        _stage_end(
            job.job_id,
            "finalize_graph",
            finalize_started,
            vertexCount=len(result["graph"]["vertices"]),
            edgeCount=len(result["graph"]["edges"]),
        )
        emit_job_event(job, "result", result)
        emit_job_event(job, "done", {"status": "completed"})
        logger.info(
            "[map_extract][worker] completed jobId=%s vertexCount=%s edgeCount=%s totalElapsedMs=%s",
            job.job_id,
            len(result["graph"]["vertices"]),
            len(result["graph"]["edges"]),
            int((time.perf_counter() - run_started) * 1000),
        )
    except Exception as exc:  # pragma: no cover - defensive worker safety
        logger.exception("[map_extract][worker] failed jobId=%s", job.job_id)
        emit_job_event(job, "error", {"error": f"map_extract worker failed: {exc}"})
        emit_job_event(job, "close", None)
        return

    emit_job_event(job, "close", None)
