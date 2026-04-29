"""HTTP surface for the code-generation pipeline (Phase 1 scaffolding).

Mirrors ``map_extract`` route shapes so the frontend status / cancel / resume
hooks can be reused. Stage implementations are stubs at this phase — see
``services/code_gen_runner.py``.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Body
from fastapi.responses import FileResponse, JSONResponse

from ...infra.io_utils import resolve_api_key
from ...infra.paths import DEFAULT_MODEL_NAME
from ..models.job_models import JobRecord
from ..services import code_gen_checkpoints as checkpoints
from ..services.code_gen_runner import run_code_gen_worker, run_stage_inline
from ..services.job_store import (
    JOBS,
    JOBS_LOCK,
    emit_job_event,
    request_cancel,
    serialize_job,
    utc_now_iso,
)


router = APIRouter(tags=["code_gen"])
logger = logging.getLogger(__name__)
CODE_GEN_JOB_TIMEOUT_SECONDS = int(os.getenv("CODE_GEN_JOB_TIMEOUT_SECONDS", "1800"))

ARTIFACT_EXTENSION_WHITELIST: frozenset[str] = frozenset(
    {".py", ".json", ".md", ".log", ".txt"}
)


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


def _start_timeout_watchdog(job: JobRecord) -> None:
    def watchdog() -> None:
        if CODE_GEN_JOB_TIMEOUT_SECONDS <= 0:
            return
        poll_interval = 5
        while True:
            time.sleep(poll_interval)
            with JOBS_LOCK:
                if job.status in {"completed", "failed", "cancelled"}:
                    return
                idle = time.monotonic() - job.last_activity_ts
            if idle >= CODE_GEN_JOB_TIMEOUT_SECONDS:
                err = f"code_gen idle for {int(idle)}s — terminated."
                logger.error("[code_gen] watchdog terminated jobId=%s", job.job_id)
                emit_job_event(job, "error", {"error": err})
                emit_job_event(job, "close", None)
                return

    threading.Thread(target=watchdog, daemon=True).start()


def _spawn_worker(
    job: JobRecord,
    *,
    api_key: str,
    model_name: str,
    use_env_model_overrides: bool,
    inputs: dict[str, Any],
) -> None:
    thread = threading.Thread(
        target=run_code_gen_worker,
        kwargs={
            "job": job,
            "api_key": api_key,
            "model_name": model_name,
            "use_env_model_overrides": use_env_model_overrides,
            "inputs": inputs,
        },
        daemon=True,
    )
    thread.start()
    _start_timeout_watchdog(job)


@router.post("/code_gen/jobs")
async def create_code_gen_job(payload: dict[str, Any] = Body(default_factory=dict)):
    """Create a new code-generation job.

    Body shape (all optional except ``causalData``):
      {
        "causalData": "...",
        "mapNodeJson": {...} | null,
        "selectedEntities": [...],
        "selectedPolicies": [...],
        "model": "gemini-..."   // optional override
      }
    """
    causal_data = str(payload.get("causalData") or "").strip()
    if not causal_data:
        return JSONResponse({"error": "causalData is required."}, status_code=400)

    requested_model = str(payload.get("model") or "").strip()
    resolved_model = requested_model or DEFAULT_MODEL_NAME
    use_env_model_overrides = not bool(requested_model)

    api_key = resolve_api_key()
    if not api_key:
        return JSONResponse(
            {"error": "API key is required (GEMINI_API_KEY / API_KEY / GOOGLE_API_KEY)."},
            status_code=500,
        )

    map_node_json = payload.get("mapNodeJson")
    if map_node_json is not None and not isinstance(map_node_json, dict):
        return JSONResponse({"error": "mapNodeJson must be an object or null."}, status_code=400)
    selected_entities = list(payload.get("selectedEntities") or [])
    selected_policies = list(payload.get("selectedPolicies") or [])
    selected_metrics = list(payload.get("selectedMetrics") or [])
    preview_only = bool(payload.get("previewOnly", False))
    if not selected_metrics:
        return JSONResponse(
            {"error": "selectedMetrics is required — pick at least one metric to track."},
            status_code=400,
        )

    now = utc_now_iso()
    job_id = f"code_gen-{uuid4().hex}"
    job = JobRecord(job_id=job_id, status="queued", created_at=now, updated_at=now)

    with JOBS_LOCK:
        JOBS[job_id] = job

    checkpoints.save_inputs(
        job_id,
        causal_data=causal_data,
        map_node_json=map_node_json,
        selected_entities=selected_entities,
        selected_policies=selected_policies,
        selected_metrics=selected_metrics,
        model_name=resolved_model,
        use_env_model_overrides=use_env_model_overrides,
    )

    inputs = {
        "causalData": causal_data,
        "mapNodeJson": map_node_json,
        "selectedEntities": selected_entities,
        "selectedPolicies": selected_policies,
        "selectedMetrics": selected_metrics,
    }
    if not preview_only:
        _spawn_worker(
            job,
            api_key=api_key,
            model_name=resolved_model,
            use_env_model_overrides=use_env_model_overrides,
            inputs=inputs,
        )

    logger.info(
        "[code_gen] job queued jobId=%s entityCount=%s policyCount=%s metricCount=%s previewOnly=%s",
        job_id,
        len(selected_entities),
        len(selected_policies),
        len(selected_metrics),
        preview_only,
    )
    return {
        "pipeline": "code_gen",
        "jobId": job_id,
        "status": "queued",
        "statusUrl": f"/code_gen/jobs/{job_id}",
        "resultUrl": f"/code_gen/jobs/{job_id}/result",
    }


@router.get("/code_gen/jobs/{job_id}")
def get_code_gen_job(job_id: str):
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
        return payload

    disk_stages = checkpoints.list_stages(job_id)
    if not disk_stages:
        return JSONResponse({"error": f"Job '{job_id}' not found."}, status_code=404)

    disk_completed = [s["stage"] for s in disk_stages]
    disk_status = "completed" if "finalize_bundle" in disk_completed else "partial"
    disk_token_usage = checkpoints.latest_usage_totals(job_id)
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


@router.get("/code_gen/jobs/{job_id}/result")
def get_code_gen_result(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None or job.result is None:
        return JSONResponse({"error": "Result not available."}, status_code=404)
    return job.result


@router.post("/code_gen/jobs/{job_id}/cancel")
def cancel_code_gen_job(job_id: str):
    accepted = request_cancel(job_id)
    return {"jobId": job_id, "cancelRequested": accepted}


@router.post("/code_gen/jobs/{job_id}/resume")
def resume_code_gen_job(job_id: str):
    """Re-run the worker from the next unfinished stage.

    Cold-start safe: rehydrates inputs from ``inputs.json`` if the in-memory
    job record was lost (backend restart).
    """
    with JOBS_LOCK:
        job = JOBS.get(job_id)

    api_key = resolve_api_key()
    if not api_key:
        return JSONResponse({"error": "API key required."}, status_code=500)

    manifest = checkpoints.load_inputs(job_id)
    if manifest is None:
        return JSONResponse(
            {"error": f"No inputs manifest found for job '{job_id}'."},
            status_code=404,
        )

    if job is None:
        now = utc_now_iso()
        job = JobRecord(job_id=job_id, status="queued", created_at=now, updated_at=now)
        with JOBS_LOCK:
            JOBS[job_id] = job

    if job.status in {"running", "queued"}:
        return JSONResponse(
            {"error": "Job already running or queued."},
            status_code=409,
        )

    job.status = "queued"
    job.cancel_requested = False
    job.error = None
    job.updated_at = utc_now_iso()

    inputs = {
        "causalData": manifest.get("causalData") or "",
        "mapNodeJson": manifest.get("mapNodeJson"),
        "selectedEntities": manifest.get("selectedEntities") or [],
        "selectedPolicies": manifest.get("selectedPolicies") or [],
        "selectedMetrics": manifest.get("selectedMetrics") or [],
    }
    _spawn_worker(
        job,
        api_key=api_key,
        model_name=str(manifest.get("modelName") or DEFAULT_MODEL_NAME),
        use_env_model_overrides=bool(manifest.get("useEnvModelOverrides", True)),
        inputs=inputs,
    )
    return {"jobId": job_id, "status": "queued"}


@router.post("/code_gen/jobs/{job_id}/rollback")
def rollback_code_gen_job(job_id: str, payload: dict[str, Any] = Body(default_factory=dict)):
    """Roll back checkpoints.

    Body: ``{"toStage": "<stage>", "mode": "after" | "from"}``
      - ``after`` (default): keep ``toStage`` as completed; resume from the next.
      - ``from``: drop ``toStage`` itself and re-run it on resume.
    """
    stage = str(payload.get("toStage") or "").strip()
    if not stage or stage not in checkpoints.STAGE_ORDER:
        return JSONResponse({"error": "toStage is invalid."}, status_code=400)

    mode = str(payload.get("mode") or "after").strip()
    if mode == "from":
        removed = checkpoints.delete_from(job_id, stage)
    else:
        removed = checkpoints.delete_after(job_id, stage)

    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is not None:
            job.completed_stages = [
                s for s in (job.completed_stages or []) if s not in removed
            ]
            job.error = None
            job.updated_at = utc_now_iso()

    return {"jobId": job_id, "removed": removed, "mode": mode}


@router.get("/code_gen/jobs/{job_id}/iterations/{stage}")
def list_code_gen_iterations(job_id: str, stage: str):
    if stage not in checkpoints.ITERATIVE_STAGES:
        return JSONResponse(
            {"error": f"stage {stage!r} is not iterative."},
            status_code=400,
        )
    return {"jobId": job_id, "stage": stage, "iterations": checkpoints.list_iterations(job_id, stage)}


@router.get("/code_gen/jobs/{job_id}/iterations/{stage}/{iter_id}")
def get_code_gen_iteration(job_id: str, stage: str, iter_id: str):
    payload = checkpoints.load_iteration(job_id, stage, iter_id)
    if payload is None:
        return JSONResponse({"error": "Iteration not found."}, status_code=404)
    return payload


@router.delete("/code_gen/jobs/{job_id}/iterations/{stage}/{iter_id}")
def delete_code_gen_iteration(job_id: str, stage: str, iter_id: str):
    ok = checkpoints.delete_iteration(job_id, stage, iter_id)
    if not ok:
        return JSONResponse({"error": "Iteration not found."}, status_code=404)
    return {"jobId": job_id, "stage": stage, "iterId": iter_id, "deleted": True}


@router.post("/code_gen/jobs/{job_id}/preview_entities")
def preview_entities(job_id: str):
    """Run Stage 1 + Stage 1b synchronously and return their outputs.

    The result is also persisted to disk as ``state1_entity_list.json`` /
    ``state1b_policy_outline.json`` so the full pipeline run can skip them.
    Caller is expected to confirm the preview before kicking off the full job
    (see ``POST /code_gen/jobs/{id}/resume``).
    """
    api_key = resolve_api_key()
    if not api_key:
        return JSONResponse({"error": "API key required."}, status_code=500)

    manifest = checkpoints.load_inputs(job_id)
    if manifest is None:
        return JSONResponse(
            {"error": f"No inputs manifest found for job '{job_id}'."},
            status_code=404,
        )

    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None:
        now = utc_now_iso()
        job = JobRecord(job_id=job_id, status="running", created_at=now, updated_at=now)
        with JOBS_LOCK:
            JOBS[job_id] = job

    if job.status in {"running", "queued"} and job.current_stage:
        return JSONResponse(
            {"error": "Job is currently running; cancel it before previewing."},
            status_code=409,
        )

    # Clear any sticky cancel flag left over from the
    # create-then-cancel-then-preview client flow. By this point the
    # auto-spawned worker has already bailed (or never started a stage);
    # leaving cancel_requested=True would make the inline preview's
    # Gemini call fail with "cancel requested" before running anything.
    with JOBS_LOCK:
        job.cancel_requested = False
        if job.status in {"cancelled", "failed"}:
            job.status = "queued"
            job.current_stage = None
            job.error = None
        job.updated_at = utc_now_iso()

    inputs = {
        "causalData": manifest.get("causalData") or "",
        "mapNodeJson": manifest.get("mapNodeJson"),
        "selectedEntities": manifest.get("selectedEntities") or [],
        "selectedPolicies": manifest.get("selectedPolicies") or [],
        "selectedMetrics": manifest.get("selectedMetrics") or [],
    }
    model_name = str(manifest.get("modelName") or DEFAULT_MODEL_NAME)
    use_env_model_overrides = bool(manifest.get("useEnvModelOverrides", True))

    try:
        state1_payload = run_stage_inline(
            stage="state1_entity_list",
            job=job,
            api_key=api_key,
            model_name=model_name,
            use_env_model_overrides=use_env_model_overrides,
            inputs=inputs,
        )
        state1b_payload = run_stage_inline(
            stage="state1b_policy_outline",
            job=job,
            api_key=api_key,
            model_name=model_name,
            use_env_model_overrides=use_env_model_overrides,
            inputs=inputs,
        )
    except Exception as exc:
        logger.exception("[code_gen] preview_entities failed jobId=%s", job_id)
        return JSONResponse(
            {"error": f"preview_entities failed: {exc}"},
            status_code=500,
        )

    return {
        "jobId": job_id,
        "entities": state1_payload.get("entities") or [],
        "policies": state1b_payload.get("policies") or [],
        "warning": state1_payload.get("warning"),
    }


@router.get("/code_gen/jobs/{job_id}/artifacts/{path:path}")
def get_code_gen_artifact(job_id: str, path: str):
    """Serve a generated artifact, with traversal protection (fix F10)."""
    resolved = checkpoints.resolve_artifact_path(job_id, path)
    if resolved is None or not resolved.exists() or not resolved.is_file():
        return JSONResponse({"error": "Artifact not found."}, status_code=404)
    if resolved.suffix.lower() not in ARTIFACT_EXTENSION_WHITELIST:
        return JSONResponse(
            {"error": f"Extension {resolved.suffix!r} is not served."},
            status_code=403,
        )
    return FileResponse(resolved, filename=resolved.name)
