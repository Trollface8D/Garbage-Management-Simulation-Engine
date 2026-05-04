"""Filesystem-backed per-stage checkpoints for the code-generation pipeline.

Mirrors ``map_extract_checkpoints`` but adds per-iteration checkpoints for the
two iterative stages (``state2_code_entity_object`` and ``state4_code_policy``)
so each generated entity / policy is independently previewable and rollback-
target.

Layout under ``CHECKPOINT_ROOT/<job_id>/``:
  - ``inputs/``                       : binary payloads + manifest for resume
  - ``inputs.json``                   : metadata for ``inputs/``
  - ``<stage>.json``                  : final per-stage payload
  - ``iterations/<stage>/<iter>.json``: per-iteration payload (iterative stages)
  - ``artifacts/``                    : final code bundle exposed via the
                                        ``artifacts/{path}`` endpoint

Iterative-stage rule: a stage is considered ``completed`` (and recorded in
``JobRecord.completed_stages``) only after the runner writes ``<stage>.json``
summarizing every iteration. Per-iteration files exist beforehand to support
preview / partial rollback while the stage is still mid-flight.

The Gemini accumulator helper ``concat_iterations_with_delimiters`` joins all
prior iteration outputs into a *single* delimited blob — required because the
Gemini API caps file parts at 10 per request.
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
    "state1_entity_list",
    "state1b_policy_outline",
    "state1c_entity_dependencies",
    "state2_code_entity_object",
    "state2v_validate_protocol",
    "state3_code_environment",
    "state4_code_policy",
    "state4v_validate_policy",
    "finalize_bundle",
)

ITERATIVE_STAGES: frozenset[str] = frozenset(
    {"state2_code_entity_object", "state4_code_policy"}
)

ACCUMULATOR_FILE_DELIMITER = "# === FILE: {name} ==="


def _default_root() -> Path:
    configured = os.getenv("CODE_GEN_CHECKPOINT_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    repo_root = Path(__file__).resolve().parents[3]
    return repo_root / "data" / "code_gen_jobs"


CHECKPOINT_ROOT: Path = _default_root()


def job_dir(job_id: str) -> Path:
    return CHECKPOINT_ROOT / job_id


def ensure_job_dir(job_id: str) -> Path:
    path = job_dir(job_id)
    (path / "inputs").mkdir(parents=True, exist_ok=True)
    (path / "iterations").mkdir(parents=True, exist_ok=True)
    (path / "artifacts").mkdir(parents=True, exist_ok=True)
    return path


def stage_index(stage: str) -> int:
    try:
        return STAGE_ORDER.index(stage)
    except ValueError:
        return -1


def stage_file(job_id: str, stage: str) -> Path:
    return job_dir(job_id) / f"{stage}.json"


def iteration_dir(job_id: str, stage: str) -> Path:
    return job_dir(job_id) / "iterations" / stage


def iteration_file(job_id: str, stage: str, iter_id: str) -> Path:
    safe = _safe_iter_id(iter_id)
    return iteration_dir(job_id, stage) / f"{safe}.json"


def _safe_iter_id(iter_id: str) -> str:
    cleaned = "".join(c if c.isalnum() or c in {"-", "_"} else "_" for c in iter_id)
    if not cleaned:
        raise ValueError(f"iter_id cannot be empty after sanitization: {iter_id!r}")
    return cleaned


def save_stage(job_id: str, stage: str, payload: dict[str, Any]) -> None:
    ensure_job_dir(job_id)
    path = stage_file(job_id, stage)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    logger.info(
        "[code_gen][checkpoint] saved jobId=%s stage=%s bytes=%s",
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
            "[code_gen][checkpoint] read failed jobId=%s stage=%s error=%s",
            job_id,
            stage,
            exc,
        )
        return None


def save_iteration(
    job_id: str,
    stage: str,
    iter_id: str,
    payload: dict[str, Any],
) -> None:
    if stage not in ITERATIVE_STAGES:
        raise ValueError(f"stage {stage!r} is not iterative")
    ensure_job_dir(job_id)
    iteration_dir(job_id, stage).mkdir(parents=True, exist_ok=True)
    path = iteration_file(job_id, stage, iter_id)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    logger.info(
        "[code_gen][checkpoint] iteration saved jobId=%s stage=%s iterId=%s bytes=%s",
        job_id,
        stage,
        iter_id,
        path.stat().st_size,
    )


def load_iteration(job_id: str, stage: str, iter_id: str) -> dict[str, Any] | None:
    path = iteration_file(job_id, stage, iter_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "[code_gen][checkpoint] iteration read failed jobId=%s stage=%s iterId=%s error=%s",
            job_id,
            stage,
            iter_id,
            exc,
        )
        return None


def list_iterations(job_id: str, stage: str) -> list[dict[str, Any]]:
    """List per-iteration checkpoint metadata for an iterative stage.

    Returns entries sorted by mtime so callers see iteration order.
    """
    if stage not in ITERATIVE_STAGES:
        return []
    folder = iteration_dir(job_id, stage)
    if not folder.exists():
        return []
    entries: list[dict[str, Any]] = []
    for path in sorted(folder.glob("*.json"), key=lambda p: p.stat().st_mtime):
        stat = path.stat()
        entries.append(
            {
                "stage": stage,
                "iterId": path.stem,
                "savedAt": stat.st_mtime,
                "bytes": stat.st_size,
            }
        )
    return entries


def delete_iteration(job_id: str, stage: str, iter_id: str) -> bool:
    path = iteration_file(job_id, stage, iter_id)
    if not path.exists():
        return False
    try:
        path.unlink()
        logger.info(
            "[code_gen][checkpoint] iteration deleted jobId=%s stage=%s iterId=%s",
            job_id,
            stage,
            iter_id,
        )
        return True
    except OSError as exc:
        logger.warning(
            "[code_gen][checkpoint] iteration delete failed jobId=%s stage=%s iterId=%s error=%s",
            job_id,
            stage,
            iter_id,
            exc,
        )
        return False


def concat_iterations_with_delimiters(
    job_id: str,
    stage: str,
    *,
    code_field: str = "code",
    name_field: str = "filename",
) -> str:
    """Join all iteration outputs into a single delimited blob.

    Used to bypass the Gemini 10-file-part request cap: instead of uploading
    each prior entity / policy as a separate part, the runner sends ONE part
    containing every prior file separated by ``# === FILE: <name> ===``.

    Iterations missing ``code_field`` are skipped silently. Caller is
    responsible for writing both fields when calling ``save_iteration``.
    """
    entries = list_iterations(job_id, stage)
    if not entries:
        return ""
    chunks: list[str] = []
    for entry in entries:
        payload = load_iteration(job_id, stage, entry["iterId"])
        if not isinstance(payload, dict):
            continue
        code = payload.get(code_field)
        if not isinstance(code, str) or not code.strip():
            continue
        name = str(payload.get(name_field) or f"{entry['iterId']}.py")
        chunks.append(ACCUMULATOR_FILE_DELIMITER.format(name=name))
        chunks.append(code.rstrip())
        chunks.append("")
    return "\n".join(chunks)


def list_stages(job_id: str) -> list[dict[str, Any]]:
    path = job_dir(job_id)
    if not path.exists():
        return []
    out: list[dict[str, Any]] = []
    for stage in STAGE_ORDER:
        f = stage_file(job_id, stage)
        if f.exists():
            stat = f.stat()
            entry: dict[str, Any] = {
                "stage": stage,
                "savedAt": stat.st_mtime,
                "bytes": stat.st_size,
            }
            if stage in ITERATIVE_STAGES:
                entry["iterations"] = list_iterations(job_id, stage)
            out.append(entry)
    return out


def latest_usage_totals(job_id: str) -> dict[str, int] | None:
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
    """Delete the checkpoint for ``stage`` and every stage after it (inclusive).

    Iterative-stage iteration files are wiped alongside the stage summary file.
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
                    "[code_gen][checkpoint] delete failed jobId=%s stage=%s error=%s",
                    job_id,
                    later,
                    exc,
                )
        if later in ITERATIVE_STAGES:
            folder = iteration_dir(job_id, later)
            if folder.exists():
                shutil.rmtree(folder, ignore_errors=True)
    logger.info(
        "[code_gen][checkpoint] rollback jobId=%s fromStage=%s removed=%s",
        job_id,
        stage,
        removed,
    )
    return removed


def delete_after(job_id: str, stage: str) -> list[str]:
    """Delete checkpoint files strictly after ``stage`` (exclusive)."""
    idx = stage_index(stage)
    if idx < 0:
        return []
    removed: list[str] = []
    for later in STAGE_ORDER[idx + 1 :]:
        path = stage_file(job_id, later)
        if path.exists():
            try:
                path.unlink()
                removed.append(later)
            except OSError as exc:
                logger.warning(
                    "[code_gen][checkpoint] delete_after failed jobId=%s stage=%s error=%s",
                    job_id,
                    later,
                    exc,
                )
        if later in ITERATIVE_STAGES:
            folder = iteration_dir(job_id, later)
            if folder.exists():
                shutil.rmtree(folder, ignore_errors=True)
    logger.info(
        "[code_gen][checkpoint] rollback jobId=%s afterStage=%s removed=%s",
        job_id,
        stage,
        removed,
    )
    return removed


def clear_job(job_id: str) -> None:
    path = job_dir(job_id)
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
        logger.info("[code_gen][checkpoint] cleared jobId=%s", job_id)


def save_inputs(
    job_id: str,
    *,
    causal_data: str,
    map_node_json: dict[str, Any] | None,
    selected_entities: list[dict[str, Any]],
    selected_policies: list[dict[str, Any]],
    selected_metrics: list[dict[str, Any]] | None = None,
    user_entity_list: list[dict[str, Any]] | None = None,
    extra_files: Iterable[dict[str, Any]] = (),
    model_name: str,
    use_env_model_overrides: bool,
) -> None:
    """Persist inputs needed to re-run the pipeline without re-upload."""
    base = ensure_job_dir(job_id)
    inputs_dir = base / "inputs"
    inputs_dir.mkdir(parents=True, exist_ok=True)

    extra_manifest: list[dict[str, Any]] = []
    for idx, file_data in enumerate(extra_files):
        raw = file_data.get("data") or b""
        if isinstance(raw, str):
            raw = raw.encode("utf-8")
        safe_name = f"extra-{idx + 1}.bin"
        out_path = inputs_dir / safe_name
        out_path.write_bytes(raw)
        extra_manifest.append(
            {
                "filename": str(file_data.get("filename") or safe_name),
                "mime_type": str(file_data.get("mime_type") or "application/octet-stream"),
                "path": safe_name,
            }
        )

    manifest = {
        "causalData": causal_data,
        "mapNodeJson": map_node_json,
        "selectedEntities": selected_entities,
        "selectedPolicies": selected_policies,
        "selectedMetrics": list(selected_metrics or []),
        "userEntityList": list(user_entity_list or []),
        "modelName": model_name,
        "useEnvModelOverrides": bool(use_env_model_overrides),
        "extraFiles": extra_manifest,
    }
    (base / "inputs.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    logger.info(
        "[code_gen][checkpoint] inputs saved jobId=%s entityCount=%s policyCount=%s extraCount=%s",
        job_id,
        len(selected_entities or []),
        len(selected_policies or []),
        len(extra_manifest),
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
            "[code_gen][checkpoint] inputs manifest unreadable jobId=%s error=%s",
            job_id,
            exc,
        )
        return None

    hydrated_extra: list[dict[str, Any]] = []
    for entry in manifest.get("extraFiles") or []:
        rel_path = str(entry.get("path") or "").strip()
        if not rel_path:
            continue
        file_path = base / "inputs" / rel_path
        if not file_path.exists():
            continue
        hydrated_extra.append(
            {
                "filename": str(entry.get("filename") or rel_path),
                "mime_type": str(entry.get("mime_type") or "application/octet-stream"),
                "data": file_path.read_bytes(),
            }
        )
    manifest["extraFiles"] = hydrated_extra
    return manifest


def update_selected_policies(job_id: str, selected_policies: list[dict[str, Any]]) -> None:
    """Overwrite only the selectedPolicies field in the existing inputs manifest."""
    base = job_dir(job_id)
    manifest_path = base / "inputs.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"No inputs manifest for job '{job_id}'")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["selectedPolicies"] = selected_policies
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(
        "[code_gen][checkpoint] policies updated jobId=%s count=%s",
        job_id,
        len(selected_policies),
    )


def encode_bytes(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def decode_bytes(data: str) -> bytes:
    return base64.b64decode(data.encode("ascii"))


def artifact_root(job_id: str) -> Path:
    return job_dir(job_id) / "artifacts"


def resolve_artifact_path(job_id: str, relative: str) -> Path | None:
    """Resolve ``relative`` under the job artifact root, rejecting traversal.

    Returns ``None`` if the path escapes the artifact root or contains an
    illegal segment. Implements fix F10 from ``docs/code-gen-pipeline.md``.
    """
    if not relative or relative != relative.strip():
        return None
    if relative.startswith(("/", "~")) or ".." in relative.split("/"):
        return None
    root = artifact_root(job_id).resolve()
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate
