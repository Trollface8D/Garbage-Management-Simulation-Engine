"""Filesystem-backed per-stage checkpoints for the map_extract pipeline.

Each job gets its own directory under ``CHECKPOINT_ROOT/<job_id>/`` containing:
  - ``inputs/``: binary payloads (overview maps, support files) preserved from the
    original request so a resume can rebuild image parts without a re-upload.
  - ``inputs.json``: metadata manifest for ``inputs/``.
  - ``<stage>.json``: serialized output of each stage.

The pipeline worker calls ``load_stage``/``save_stage`` at each stage boundary.
Rollback simply deletes the target stage file plus all later ones; the next
resume re-runs only the missing stages.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)

STAGE_ORDER: tuple[str, ...] = (
    "extractmap_symbol",
    "extractmap_text",
    "tabular_extraction",
    "support_enrichment",
    "edge_extraction",
    "finalize_graph",
)


def _default_root() -> Path:
    configured = os.getenv("MAP_EXTRACT_CHECKPOINT_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    repo_root = Path(__file__).resolve().parents[3]
    return repo_root / "data" / "map_extract_jobs"


CHECKPOINT_ROOT: Path = _default_root()


def job_dir(job_id: str) -> Path:
    return CHECKPOINT_ROOT / job_id


def ensure_job_dir(job_id: str) -> Path:
    path = job_dir(job_id)
    (path / "inputs").mkdir(parents=True, exist_ok=True)
    return path


def stage_index(stage: str) -> int:
    try:
        return STAGE_ORDER.index(stage)
    except ValueError:
        return -1


def stage_file(job_id: str, stage: str) -> Path:
    return job_dir(job_id) / f"{stage}.json"


def save_stage(job_id: str, stage: str, payload: dict[str, Any]) -> None:
    ensure_job_dir(job_id)
    path = stage_file(job_id, stage)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    logger.info(
        "[map_extract][checkpoint] saved jobId=%s stage=%s bytes=%s",
        job_id,
        stage,
        path.stat().st_size,
    )


def load_stage(job_id: str, stage: str) -> dict[str, Any] | None:
    path = stage_file(job_id, stage)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "[map_extract][checkpoint] read failed jobId=%s stage=%s error=%s",
            job_id,
            stage,
            exc,
        )
        return None


def list_stages(job_id: str) -> list[dict[str, Any]]:
    path = job_dir(job_id)
    if not path.exists():
        return []
    out: list[dict[str, Any]] = []
    for stage in STAGE_ORDER:
        f = stage_file(job_id, stage)
        if f.exists():
            stat = f.stat()
            out.append(
                {
                    "stage": stage,
                    "savedAt": stat.st_mtime,
                    "bytes": stat.st_size,
                }
            )
    return out


def latest_usage_totals(job_id: str) -> dict[str, int] | None:
    """Return the usage_totals snapshot embedded in the latest checkpoint.

    Scans stage files in reverse STAGE_ORDER and returns the first
    ``_usageTotalsAtCompletion`` snapshot it finds.  This lets the
    status endpoint surface accurate cumulative tokens even after a
    backend restart, before any resume has been triggered.
    """
    for stage in reversed(STAGE_ORDER):
        payload = load_stage(job_id, stage)
        if not isinstance(payload, dict):
            continue
        snapshot = payload.get("_usageTotalsAtCompletion")
        if isinstance(snapshot, dict):
            return {
                "promptTokens": int(snapshot.get("prompt_tokens", 0)),
                "outputTokens": int(snapshot.get("output_tokens", 0)),
                "totalTokens": int(snapshot.get("total_tokens", 0)),
                "callCount": int(snapshot.get("call_count", 0)),
            }
    return None


def delete_from(job_id: str, stage: str) -> list[str]:
    """Delete the checkpoint for ``stage`` and every stage after it.

    Returns the list of stages that were removed.
    """
    idx = stage_index(stage)
    if idx < 0:
        return []
    removed: list[str] = []
    for later in STAGE_ORDER[idx:]:
        path = stage_file(job_id, later)
        if path.exists():
            try:
                path.unlink()
                removed.append(later)
            except OSError as exc:
                logger.warning(
                    "[map_extract][checkpoint] delete failed jobId=%s stage=%s error=%s",
                    job_id,
                    later,
                    exc,
                )
    logger.info(
        "[map_extract][checkpoint] rollback jobId=%s fromStage=%s removed=%s",
        job_id,
        stage,
        removed,
    )
    return removed


def clear_job(job_id: str) -> None:
    path = job_dir(job_id)
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
        logger.info("[map_extract][checkpoint] cleared jobId=%s", job_id)


def save_inputs(
    job_id: str,
    *,
    overview_files: Iterable[dict[str, Any]],
    support_files: Iterable[dict[str, Any]],
    component_id: str,
    overview_additional_information: str,
    support_additional_information: str,
    model_name: str,
    use_env_model_overrides: bool,
) -> None:
    base = ensure_job_dir(job_id)
    inputs_dir = base / "inputs"
    inputs_dir.mkdir(parents=True, exist_ok=True)

    def _persist(files: Iterable[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
        manifest: list[dict[str, Any]] = []
        for idx, file_data in enumerate(files):
            raw = file_data.get("data") or b""
            if isinstance(raw, str):
                raw = raw.encode("utf-8")
            safe_name = f"{kind}-{idx + 1}.bin"
            out_path = inputs_dir / safe_name
            out_path.write_bytes(raw)
            manifest.append(
                {
                    "filename": str(file_data.get("filename") or safe_name),
                    "mime_type": str(file_data.get("mime_type") or "application/octet-stream"),
                    "path": safe_name,
                }
            )
        return manifest

    manifest = {
        "componentId": component_id,
        "overviewAdditionalInformation": overview_additional_information,
        "supportAdditionalInformation": support_additional_information,
        "modelName": model_name,
        "useEnvModelOverrides": bool(use_env_model_overrides),
        "overviewFiles": _persist(overview_files, "overview"),
        "supportFiles": _persist(support_files, "support"),
    }
    (base / "inputs.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    logger.info(
        "[map_extract][checkpoint] inputs saved jobId=%s overviewCount=%s supportCount=%s",
        job_id,
        len(manifest["overviewFiles"]),
        len(manifest["supportFiles"]),
    )


def load_inputs(job_id: str) -> dict[str, Any] | None:
    base = job_dir(job_id)
    manifest_path = base / "inputs.json"
    if not manifest_path.exists():
        return None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "[map_extract][checkpoint] inputs manifest unreadable jobId=%s error=%s",
            job_id,
            exc,
        )
        return None

    def _hydrate(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for entry in entries or []:
            rel_path = str(entry.get("path") or "").strip()
            if not rel_path:
                continue
            file_path = base / "inputs" / rel_path
            if not file_path.exists():
                continue
            out.append(
                {
                    "filename": str(entry.get("filename") or rel_path),
                    "mime_type": str(entry.get("mime_type") or "application/octet-stream"),
                    "data": file_path.read_bytes(),
                }
            )
        return out

    manifest["overviewFiles"] = _hydrate(manifest.get("overviewFiles") or [])
    manifest["supportFiles"] = _hydrate(manifest.get("supportFiles") or [])
    return manifest


def encode_bytes(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def decode_bytes(data: str) -> bytes:
    return base64.b64decode(data.encode("ascii"))
