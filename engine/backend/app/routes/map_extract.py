from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Body, File, Form, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from ...infra.io_utils import resolve_api_key
from ...infra.paths import DEFAULT_MODEL_NAME
from ..models.job_models import JobRecord
from ..services import map_extract_checkpoints as checkpoints
from ..services.job_store import (
    JOBS,
    JOBS_LOCK,
    emit_job_event,
    request_cancel,
    serialize_job,
    touch_activity,
    utc_now_iso,
)
from ..services.map_extract_runner import run_map_extract_worker


router = APIRouter(tags=["map_extract"])
logger = logging.getLogger(__name__)
MAP_EXTRACT_JOB_TIMEOUT_SECONDS = int(os.getenv("MAP_EXTRACT_JOB_TIMEOUT_SECONDS", "1800"))

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
PDF_EXTENSIONS = {".pdf"}
TEXT_EXTENSIONS = {".txt", ".md", ".csv", ".json", ".log", ".tsv", ".yaml", ".yml"}


def _ordered_completed_stages(stages: list[str] | None) -> list[str]:
    stage_set = {str(stage or "").strip() for stage in (stages or [])}
    return [stage for stage in checkpoints.STAGE_ORDER if stage in stage_set]


def _resume_state_payload(
    *,
    status: str,
    completed_stages: list[str] | None,
    current_stage: str | None = None,
) -> dict[str, Any]:
    completed = _ordered_completed_stages(completed_stages)
    completed_set = set(completed)
    remaining = [stage for stage in checkpoints.STAGE_ORDER if stage not in completed_set]
    next_stage = remaining[0] if remaining else None

    can_resume = bool(remaining) and status not in {"running", "queued"}
    reason: str | None = None
    if not remaining:
        reason = "No stages left to run."
    elif status == "running":
        reason = "Job already running."
    elif status == "queued":
        reason = "Job already queued."

    return {
        "completedStages": completed,
        "remainingStages": len(remaining),
        "nextStage": next_stage,
        "canResume": can_resume,
        "resumeDisabledReason": None if can_resume else reason,
        "activeStage": current_stage,
    }


def _suffix(filename: str | None) -> str:
    if not filename:
        return ""
    idx = filename.rfind(".")
    return filename[idx:].lower() if idx >= 0 else ""


def _is_image_file(upload: UploadFile) -> bool:
    ext = _suffix(upload.filename)
    return ext in IMAGE_EXTENSIONS


def _is_supported_aux_file(upload: UploadFile) -> bool:
    ext = _suffix(upload.filename)
    return ext in IMAGE_EXTENSIONS or ext in PDF_EXTENSIONS or ext in TEXT_EXTENSIONS


def _start_timeout_watchdog(job: JobRecord) -> None:
    """Idle-based watchdog: terminate only if no activity for TIMEOUT seconds.

    The worker calls ``touch_activity`` around every stage boundary / Gemini
    emission, so slow-but-progressing jobs are not killed. A hung stage
    eventually trips this after the configured idle window.
    """

    def watchdog() -> None:
        if MAP_EXTRACT_JOB_TIMEOUT_SECONDS <= 0:
            return

        poll_interval = 5
        while True:
            time.sleep(poll_interval)
            with JOBS_LOCK:
                if job.status in {"completed", "failed", "cancelled"}:
                    return
                idle = time.monotonic() - job.last_activity_ts
            if idle >= MAP_EXTRACT_JOB_TIMEOUT_SECONDS:
                timeout_error = (
                    f"map_extract idle for {int(idle)}s (>= {MAP_EXTRACT_JOB_TIMEOUT_SECONDS}s) — terminated."
                )
                logger.error(
                    "[map_extract] timeout watchdog terminated jobId=%s idleSeconds=%s",
                    job.job_id,
                    int(idle),
                )
                emit_job_event(job, "error", {"error": timeout_error})
                emit_job_event(job, "close", None)
                return

    threading.Thread(target=watchdog, daemon=True).start()


@router.post("/map_extract/jobs")
async def create_map_extract_job(
    componentId: str = Form(default=""),
    overviewAdditionalInformation: str = Form(default=""),
    binAdditionalInformation: str = Form(default=""),
    model: str = Form(default=""),
    overviewMapFiles: list[UploadFile] = File(default_factory=list),
    binLocationFiles: list[UploadFile] = File(default_factory=list),
):
    requested_model = model.strip()
    resolved_model = requested_model or DEFAULT_MODEL_NAME
    use_env_model_overrides = not bool(requested_model)
    overview_descriptors = [
        {
            "name": file.filename or "",
            "contentType": file.content_type or "",
            "suffix": _suffix(file.filename),
        }
        for file in overviewMapFiles
    ]
    support_descriptors = [
        {
            "name": file.filename or "",
            "contentType": file.content_type or "",
            "suffix": _suffix(file.filename),
        }
        for file in binLocationFiles
    ]

    logger.info(
        "[map_extract] request received componentId=%s overviewFiles=%s supportFiles=%s model=%s modelSource=%s",
        componentId,
        len(overviewMapFiles),
        len(binLocationFiles),
        resolved_model,
        "request" if requested_model else "env-default",
    )
    logger.info(
        "[map_extract] request files componentId=%s overview=%s support=%s",
        componentId,
        overview_descriptors,
        support_descriptors,
    )

    api_key = resolve_api_key()
    if not api_key:
        logger.error("[map_extract] request rejected: missing API key")
        return JSONResponse(
            {
                "error": "API key is required. Set GEMINI_API_KEY, API_KEY, or GOOGLE_API_KEY in your environment.",
            },
            status_code=500,
        )

    component_id = componentId.strip()
    if not component_id:
        logger.warning("[map_extract] request rejected: missing componentId")
        return JSONResponse({"error": "componentId is required."}, status_code=400)

    if not overviewMapFiles:
        logger.warning("[map_extract] request rejected: no overview map files")
        return JSONResponse({"error": "At least one overview map image is required."}, status_code=400)

    for file in overviewMapFiles:
        if not _is_image_file(file):
            logger.warning(
                "[map_extract] request rejected: invalid overview file type filename=%s",
                file.filename,
            )
            return JSONResponse(
                {
                    "error": (
                        "overviewMapFiles must contain image files only "
                        f"({', '.join(sorted(IMAGE_EXTENSIONS))})."
                    )
                },
                status_code=400,
            )

    for file in binLocationFiles:
        if not _is_supported_aux_file(file):
            logger.warning(
                "[map_extract] request rejected: invalid support file type filename=%s",
                file.filename,
            )
            return JSONResponse(
                {
                    "error": (
                        "binLocationFiles support image, PDF, and text-like files only "
                        f"({', '.join(sorted(IMAGE_EXTENSIONS | PDF_EXTENSIONS | TEXT_EXTENSIONS))})."
                    )
                },
                status_code=400,
            )

    overview_payloads: list[dict[str, object]] = []
    for file in overviewMapFiles:
        file_bytes = await file.read()
        if not file_bytes:
            logger.warning(
                "[map_extract] request rejected: empty overview file filename=%s",
                file.filename,
            )
            return JSONResponse(
                {"error": f"Uploaded overview file '{file.filename or 'unknown'}' is empty."},
                status_code=400,
            )
        overview_payloads.append(
            {
                "filename": file.filename or "overview-image",
                "mime_type": file.content_type or "application/octet-stream",
                "data": bytes(file_bytes),
            }
        )

    support_payloads: list[dict[str, object]] = []
    for file in binLocationFiles:
        file_bytes = await file.read()
        if not file_bytes:
            logger.warning(
                "[map_extract] request rejected: empty support file filename=%s",
                file.filename,
            )
            return JSONResponse(
                {"error": f"Uploaded support file '{file.filename or 'unknown'}' is empty."},
                status_code=400,
            )
        support_payloads.append(
            {
                "filename": file.filename or "support-file",
                "mime_type": file.content_type or "application/octet-stream",
                "data": bytes(file_bytes),
            }
        )

    now = utc_now_iso()
    job_id = f"map_extract-{uuid4().hex}"
    job = JobRecord(job_id=job_id, status="queued", created_at=now, updated_at=now)

    with JOBS_LOCK:
        JOBS[job_id] = job

    logger.info(
        "[map_extract] job queued jobId=%s componentId=%s overviewFiles=%s supportFiles=%s",
        job_id,
        component_id,
        len(overview_payloads),
        len(support_payloads),
    )
    logger.info(
        "[map_extract] job config jobId=%s model=%s modelSource=%s useEnvOverrides=%s overviewTextLen=%s supportTextLen=%s",
        job_id,
        resolved_model,
        "request" if requested_model else "env-default",
        use_env_model_overrides,
        len(overviewAdditionalInformation),
        len(binAdditionalInformation),
    )

    thread = threading.Thread(
        target=run_map_extract_worker,
        kwargs={
            "job": job,
            "api_key": api_key,
            "model_name": resolved_model,
            "use_env_model_overrides": use_env_model_overrides,
            "component_id": component_id,
            "overview_files": overview_payloads,
            "support_files": support_payloads,
            "overview_additional_information": overviewAdditionalInformation,
            "support_additional_information": binAdditionalInformation,
        },
        daemon=True,
    )
    thread.start()
    _start_timeout_watchdog(job)

    logger.info(
        "[map_extract] worker thread started jobId=%s timeoutSeconds=%s",
        job_id,
        MAP_EXTRACT_JOB_TIMEOUT_SECONDS,
    )

    return {
        "pipeline": "map_extract",
        "jobId": job_id,
        "status": "queued",
        "statusUrl": f"/map_extract/jobs/{job_id}",
        "resultUrl": f"/map_extract/jobs/{job_id}/result",
        "inputSummary": {
            "overviewMapFileCount": len(overviewMapFiles),
            "binLocationFileCount": len(binLocationFiles),
            "acceptedOverviewTypes": "image/*",
            "acceptedSupportTypes": "image/*, application/pdf, text/*",
        },
    }


@router.get("/map_extract/jobs/{job_id}")
def get_map_extract_job(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)

    if job is not None:
        payload = serialize_job(job)
        payload.update(
            _resume_state_payload(
                status=str(payload.get("status") or ""),
                completed_stages=list(payload.get("completedStages") or []),
                current_stage=str(payload.get("currentStage") or "") or None,
            )
        )
        logger.info(
            "[map_extract] status query jobId=%s status=%s stage=%s canResume=%s remainingStages=%s",
            job_id,
            payload.get("status"),
            payload.get("currentStage"),
            payload.get("canResume"),
            payload.get("remainingStages"),
        )
        return payload

    # Job not in memory (backend may have restarted).  Reconstruct a
    # best-effort status response from disk checkpoint files so the
    # frontend can still display completed stage info.
    disk_stages = checkpoints.list_stages(job_id)
    if not disk_stages:
        logger.warning("[map_extract] status query job not found jobId=%s", job_id)
        return JSONResponse({"error": f"Job '{job_id}' not found."}, status_code=404)

    disk_completed = [s["stage"] for s in disk_stages]
    disk_status = "completed" if "finalize_graph" in disk_completed else "partial"
    disk_token_usage = checkpoints.latest_usage_totals(job_id)
    logger.info(
        "[map_extract] status query (from disk) jobId=%s status=%s completedStages=%s",
        job_id,
        disk_status,
        disk_completed,
    )
    payload = {
        "jobId": job_id,
        "status": disk_status,
        "currentStage": None,
        "stageMessage": "Restored from checkpoint files (backend was restarted).",
        "stageHistory": [],
        "tokenUsage": disk_token_usage,
        "costEstimate": None,
        "error": None,
        "cancelRequested": False,
        "completedStages": disk_completed,
    }
    payload.update(
        _resume_state_payload(
            status=disk_status,
            completed_stages=disk_completed,
            current_stage=None,
        )
    )
    return payload


@router.get("/map_extract/jobs/{job_id}/checkpoints")
def list_map_extract_checkpoints(job_id: str):
    stages = checkpoints.list_stages(job_id)
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        in_memory_completed = list(job.completed_stages) if job else None
        status = job.status if job else None

    # When the job is not in memory (e.g. backend restarted), infer which
    # stages completed from the checkpoint files that exist on disk.
    if in_memory_completed is not None:
        completed = in_memory_completed
    else:
        completed = [s["stage"] for s in stages]
        # If finalize_graph checkpoint exists the job ran to completion.
        if status is None and any(s["stage"] == "finalize_graph" for s in stages):
            status = "completed"
        elif status is None and completed:
            status = "partial"

    return {
        "jobId": job_id,
        "status": status,
        "stageOrder": list(checkpoints.STAGE_ORDER),
        "completedStages": completed,
        "checkpoints": stages,
    }


def _summarize_stage_payload(stage: str, payload: dict) -> dict:
    """Compute a compact summary + bounded preview for the UI dropdown."""
    summary: dict = {}
    preview: object = None
    try:
        if stage == "extractmap_symbol":
            summary["symbolLegendCount"] = len(payload.get("symbolLegend") or [])
            summary["symbolEnumCount"] = len(payload.get("symbolEnum") or [])
            preview = {
                "symbolLegend": (payload.get("symbolLegend") or [])[:8],
                "symbolEnum": (payload.get("symbolEnum") or [])[:16],
            }
        elif stage == "extractmap_text":
            nodes = payload.get("nodes") or []
            summary["nodeCount"] = len(nodes)
            preview = {"nodes": nodes[:6]}
        elif stage == "tabular_extraction":
            csv = str(payload.get("tabularCsv") or "")
            summary["csvLen"] = len(csv)
            summary["csvChunks"] = len(payload.get("csvChunks") or [])
            preview = {"tabularCsvHead": csv[:2000]}
        elif stage == "support_enrichment":
            nodes = payload.get("nodes") or []
            summary["nodeCount"] = len(nodes)
            summary["matchedCount"] = int(payload.get("matchedCount") or 0)
            summary["ignoredNonStage2Count"] = int(payload.get("ignoredNonStage2Count") or 0)
            preview = {"nodes": nodes[:6]}
        elif stage == "edge_extraction":
            edges = payload.get("edges") or []
            summary["edgeCount"] = len(edges)
            preview = {"edges": edges[:8]}
        elif stage == "finalize_graph":
            graph = (payload.get("graph") or {}) if isinstance(payload.get("graph"), dict) else {}
            summary["vertexCount"] = len(graph.get("vertices") or [])
            summary["edgeCount"] = len(graph.get("edges") or [])
            preview = {
                "vertices": (graph.get("vertices") or [])[:4],
                "edges": (graph.get("edges") or [])[:4],
            }
        else:
            preview = payload
    except Exception:  # noqa: BLE001 — summary is best-effort.
        preview = None
    return {"summary": summary, "preview": preview}


def _stage_token_usage(job: JobRecord | None, stage: str) -> dict | None:
    """Return the latest tokenUsage recorded for `stage` from stage_history."""
    if job is None:
        return None
    last: dict | None = None
    short = stage
    prefixed = f"map_extract/{stage}"
    for entry in job.stage_history:
        entry_stage = str(entry.get("stage") or "")
        if entry_stage == short or entry_stage == prefixed:
            usage = entry.get("tokenUsage")
            if isinstance(usage, dict):
                last = usage
    return last


@router.get("/map_extract/jobs/{job_id}/checkpoints/{stage}")
def get_map_extract_checkpoint(job_id: str, stage: str):
    if stage not in checkpoints.STAGE_ORDER:
        return JSONResponse({"error": f"Unknown stage '{stage}'."}, status_code=400)
    payload = checkpoints.load_stage(job_id, stage)
    if payload is None:
        return JSONResponse({"error": f"No checkpoint for stage '{stage}'."}, status_code=404)
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    summarized = _summarize_stage_payload(stage, payload)
    return {
        "jobId": job_id,
        "stage": stage,
        "summary": summarized["summary"],
        "preview": summarized["preview"],
        "tokenUsage": _stage_token_usage(job, stage),
    }


@router.get("/map_extract/jobs/{job_id}/inputs")
def list_map_extract_inputs(job_id: str):
    """Return the saved inputs manifest (no file bytes) so the UI can
    rebuild the upload list on reload without forcing the user to
    re-select every file."""
    base = checkpoints.job_dir(job_id)
    manifest_path = base / "inputs.json"
    if not manifest_path.exists():
        return JSONResponse({"error": f"No saved inputs for job '{job_id}'."}, status_code=404)
    try:
        import json as _json

        manifest = _json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:  # noqa: BLE001
        logger.warning(
            "[map_extract] inputs manifest unreadable jobId=%s error=%s", job_id, exc
        )
        return JSONResponse(
            {"error": "Failed to read inputs manifest."}, status_code=500
        )

    def _describe(entries, kind):
        out = []
        for idx, entry in enumerate(entries or []):
            rel = str(entry.get("path") or "").strip()
            if not rel:
                continue
            file_path = base / "inputs" / rel
            if not file_path.exists():
                continue
            stat = file_path.stat()
            out.append(
                {
                    "index": idx,
                    "filename": str(entry.get("filename") or rel),
                    "mimeType": str(entry.get("mime_type") or "application/octet-stream"),
                    "size": stat.st_size,
                    "downloadUrl": f"/map_extract/jobs/{job_id}/inputs/{kind}/{idx}",
                }
            )
        return out

    return {
        "jobId": job_id,
        "componentId": str(manifest.get("componentId") or ""),
        "overviewAdditionalInformation": str(
            manifest.get("overviewAdditionalInformation") or ""
        ),
        "supportAdditionalInformation": str(
            manifest.get("supportAdditionalInformation") or ""
        ),
        "modelName": str(manifest.get("modelName") or ""),
        "overviewFiles": _describe(manifest.get("overviewFiles") or [], "overview"),
        "supportFiles": _describe(manifest.get("supportFiles") or [], "support"),
    }


@router.get("/map_extract/jobs/{job_id}/inputs/{kind}/{index}")
def download_map_extract_input(job_id: str, kind: str, index: int):
    if kind not in {"overview", "support"}:
        return JSONResponse({"error": f"Unknown input kind '{kind}'."}, status_code=400)
    base = checkpoints.job_dir(job_id)
    manifest_path = base / "inputs.json"
    if not manifest_path.exists():
        return JSONResponse({"error": f"No saved inputs for job '{job_id}'."}, status_code=404)
    try:
        import json as _json

        manifest = _json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return JSONResponse({"error": "Failed to read inputs manifest."}, status_code=500)
    key = "overviewFiles" if kind == "overview" else "supportFiles"
    entries = manifest.get(key) or []
    if index < 0 or index >= len(entries):
        return JSONResponse({"error": f"Input index {index} out of range."}, status_code=404)
    entry = entries[index]
    rel = str(entry.get("path") or "").strip()
    if not rel:
        return JSONResponse({"error": "Input has no stored path."}, status_code=404)
    file_path = base / "inputs" / rel
    if not file_path.exists():
        return JSONResponse({"error": "Input file missing on disk."}, status_code=404)
    return FileResponse(
        str(file_path),
        media_type=str(entry.get("mime_type") or "application/octet-stream"),
        filename=str(entry.get("filename") or rel),
    )


@router.post("/map_extract/jobs/{job_id}/cancel")
def cancel_map_extract_job(job_id: str):
    ok = request_cancel(job_id)
    if not ok:
        with JOBS_LOCK:
            job = JOBS.get(job_id)
        if job is None:
            return JSONResponse({"error": f"Job '{job_id}' not found."}, status_code=404)
        return {"jobId": job_id, "status": job.status, "cancelRequested": job.cancel_requested}
    with JOBS_LOCK:
        job = JOBS[job_id]
        status = job.status
    return {"jobId": job_id, "status": status, "cancelRequested": True}


@router.post("/map_extract/jobs/{job_id}/rollback")
def rollback_map_extract_job(
    job_id: str,
    payload: dict = Body(default_factory=dict),
):
    stage = str(payload.get("stage") or payload.get("toStage") or "").strip()
    if not stage:
        return JSONResponse({"error": "stage is required."}, status_code=400)
    if checkpoints.stage_index(stage) < 0:
        return JSONResponse(
            {"error": f"unknown stage '{stage}'; valid: {list(checkpoints.STAGE_ORDER)}"},
            status_code=400,
        )
    with JOBS_LOCK:
        existing = JOBS.get(job_id)
        if existing is not None and existing.status == "running":
            return JSONResponse({"error": "Job is running; terminate first before rollback."}, status_code=409)

    removed = checkpoints.delete_after(job_id, stage)
    persisted_completed = [entry["stage"] for entry in checkpoints.list_stages(job_id)]
    resume_state = _resume_state_payload(
        status="partial" if "finalize_graph" not in persisted_completed else "completed",
        completed_stages=persisted_completed,
        current_stage=None,
    )

    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is not None:
            job.completed_stages = resume_state["completedStages"]
            if resume_state["remainingStages"] == 0:
                job.status = "completed"
            else:
                job.status = "partial"
            job.cancel_requested = False
            job.error = None
            job.current_stage = None
            job.updated_at = utc_now_iso()

    logger.info(
        "[map_extract] rollback applied jobId=%s stage=%s removed=%s nextStage=%s remainingStages=%s",
        job_id,
        stage,
        removed,
        resume_state.get("nextStage"),
        resume_state.get("remainingStages"),
    )
    return {
        "jobId": job_id,
        "removed": removed,
        "remaining": checkpoints.list_stages(job_id),
        **resume_state,
    }


@router.post("/map_extract/jobs/{job_id}/resume")
def resume_map_extract_job(job_id: str):
    manifest = checkpoints.load_inputs(job_id)
    if manifest is None:
        return JSONResponse(
            {"error": f"No saved inputs for job '{job_id}'. Start a new job instead."},
            status_code=404,
        )

    disk_completed = [entry["stage"] for entry in checkpoints.list_stages(job_id)]
    preflight_resume = _resume_state_payload(
        status="partial" if "finalize_graph" not in disk_completed else "completed",
        completed_stages=disk_completed,
        current_stage=None,
    )
    if not preflight_resume["canResume"]:
        return JSONResponse(
            {
                "jobId": job_id,
                "error": preflight_resume["resumeDisabledReason"] or "Nothing to resume.",
                **preflight_resume,
            },
            status_code=409,
        )

    api_key = resolve_api_key()
    if not api_key:
        return JSONResponse(
            {"error": "API key is required. Set GEMINI_API_KEY, API_KEY, or GOOGLE_API_KEY."},
            status_code=500,
        )

    now = utc_now_iso()
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            job = JobRecord(job_id=job_id, status="queued", created_at=now, updated_at=now)
            JOBS[job_id] = job
        else:
            if job.status == "running":
                return JSONResponse(
                    {"error": "Job is already running."}, status_code=409
                )
            job.status = "queued"
            job.cancel_requested = False
            job.error = None
            job.updated_at = now
        job.completed_stages = preflight_resume["completedStages"]
        touch_activity(job)

    thread = threading.Thread(
        target=run_map_extract_worker,
        kwargs={
            "job": job,
            "api_key": api_key,
            "model_name": str(manifest.get("modelName") or DEFAULT_MODEL_NAME),
            "use_env_model_overrides": bool(manifest.get("useEnvModelOverrides")),
            "component_id": str(manifest.get("componentId") or ""),
            "overview_files": manifest.get("overviewFiles") or [],
            "support_files": manifest.get("supportFiles") or [],
            "overview_additional_information": str(manifest.get("overviewAdditionalInformation") or ""),
            "support_additional_information": str(manifest.get("supportAdditionalInformation") or ""),
            "resume_existing": True,
        },
        daemon=True,
    )
    thread.start()
    _start_timeout_watchdog(job)

    logger.info(
        "[map_extract] resume triggered jobId=%s nextStage=%s remainingStages=%s",
        job_id,
        preflight_resume.get("nextStage"),
        preflight_resume.get("remainingStages"),
    )
    return {
        "jobId": job_id,
        "status": "queued",
        "resumed": True,
        **preflight_resume,
    }


@router.get("/map_extract/jobs/{job_id}/result")
def get_map_extract_job_result(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None:
        logger.warning("[map_extract] result query job not found jobId=%s", job_id)
        return JSONResponse({"error": f"Job '{job_id}' not found."}, status_code=404)
    if job.status == "failed":
        logger.error("[map_extract] result query failed jobId=%s error=%s", job_id, job.error)
        return JSONResponse({"error": job.error or "Job failed."}, status_code=500)
    if job.status != "completed" or job.result is None:
        logger.info("[map_extract] result pending jobId=%s status=%s", job_id, job.status)
        return JSONResponse({"error": "Job is not completed yet."}, status_code=409)
    logger.info("[map_extract] result ready jobId=%s", job_id)
    return job.result
