import threading
import time
from datetime import datetime
import logging
from typing import Any

from fastapi.responses import JSONResponse

from ..models.job_models import JobRecord


class JobCancelledError(RuntimeError):
    """Raised by the pipeline worker when the user has requested cancellation."""


def request_cancel(job_id: str) -> bool:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return False
        if job.status in {"completed", "failed", "cancelled"}:
            return False
        job.cancel_requested = True
        job.updated_at = utc_now_iso()
    logger.info("[job_store] cancel requested jobId=%s", job_id)
    return True


def is_cancel_requested(job_id: str) -> bool:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        return bool(job and job.cancel_requested)


def mark_cancelled(job_id: str) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None or job.status in {"completed", "failed"}:
            return
        if job.pause_requested:
            job.status = "paused"
            job.cancel_requested = False
            job.pause_requested = False
            job.updated_at = utc_now_iso()
            logger.info("[job_store] paused (via cancel) jobId=%s", job_id)
            return
        job.status = "cancelled"
        job.updated_at = utc_now_iso()
    logger.info("[job_store] cancelled jobId=%s", job_id)


def request_pause(job_id: str) -> bool:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return False
        if job.status in {"completed", "failed", "cancelled"}:
            return False
        job.cancel_requested = True
        job.pause_requested = True
        job.updated_at = utc_now_iso()
    logger.info("[job_store] pause requested jobId=%s", job_id)
    return True


def is_pause_requested(job_id: str) -> bool:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        return bool(job and job.pause_requested)


def try_transition(job_id: str, from_statuses: set[str], to_status: str) -> bool:
    """Atomically transition a job's status if it's currently in one of from_statuses.

    Returns True if transition succeeded, False if current status is not in from_statuses.
    Must be called while holding JOBS_LOCK or from within a locked context.
    """
    job = JOBS.get(job_id)
    if job is None:
        return False
    if job.status not in from_statuses:
        return False
    job.status = to_status
    job.updated_at = utc_now_iso()
    logger.info("[job_store] transitioned jobId=%s %s -> %s", job_id, job.status, to_status)
    return True


def touch_activity(job: JobRecord) -> None:
    job.last_activity_ts = time.monotonic()


JOBS: dict[str, JobRecord] = {}
JOBS_LOCK = threading.Lock()
logger = logging.getLogger(__name__)


def utc_now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def get_job_or_404(job_id: str) -> JobRecord | JSONResponse:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None:
        return JSONResponse({"error": f"Job '{job_id}' not found."}, status_code=404)
    return job


def emit_job_event(job: JobRecord, event: str, payload: Any) -> None:
    if event == "stage" and isinstance(payload, dict):
        stage = str(payload.get("stage") or "")
        message = str(payload.get("message") or "")
        token_usage = payload.get("tokenUsage")
        cost_estimate = payload.get("costEstimate")
        with JOBS_LOCK:
            if job.status in {"failed", "cancelled"}:
                logger.info("[job_store] ignored stage for %s jobId=%s stage=%s", job.status, job.job_id, stage)
                return
            if job.status == "queued":
                job.status = "running"
            job.current_stage = stage or job.current_stage
            job.stage_message = message
            stage_entry: dict[str, Any] = {"stage": stage, "message": message}
            if isinstance(token_usage, dict):
                job.token_usage = token_usage
                stage_entry["tokenUsage"] = token_usage
            if isinstance(cost_estimate, dict):
                job.cost_estimate = cost_estimate
                stage_entry["costEstimate"] = cost_estimate
            job.stage_history.append(stage_entry)
            job.updated_at = utc_now_iso()
        logger.info("[job_store] stage jobId=%s status=%s stage=%s message=%s", job.job_id, job.status, stage, message)

    if event == "error" and isinstance(payload, dict):
        with JOBS_LOCK:
            job.error = str(payload.get("error") or "Unknown pipeline execution error.")
            job.status = "failed"
            job.updated_at = utc_now_iso()
        logger.error("[job_store] error jobId=%s error=%s", job.job_id, job.error)

    if event == "result":
        with JOBS_LOCK:
            if job.status in {"failed", "cancelled"}:
                logger.warning("[job_store] ignored result for %s jobId=%s", job.status, job.job_id)
                return
            job.result = payload if isinstance(payload, dict) else None
            job.status = "completed"
            job.updated_at = utc_now_iso()
        logger.info("[job_store] result jobId=%s status=%s", job.job_id, job.status)

    if event == "done":
        with JOBS_LOCK:
            if job.status not in {"completed", "failed", "cancelled", "paused"}:
                job.status = "completed"
            job.updated_at = utc_now_iso()
        logger.info("[job_store] done jobId=%s status=%s", job.job_id, job.status)

    job.event_queue.put((event, payload))


def serialize_job(job: JobRecord) -> dict[str, Any]:
    return {
        "jobId": job.job_id,
        "status": job.status,
        "createdAt": job.created_at,
        "updatedAt": job.updated_at,
        "currentStage": job.current_stage,
        "stageMessage": job.stage_message,
        "stageHistory": job.stage_history,
        "tokenUsage": job.token_usage,
        "costEstimate": job.cost_estimate,
        "error": job.error,
        "runDir": job.run_dir,
        "cancelRequested": job.cancel_requested,
        "pauseRequested": job.pause_requested,
        "completedStages": list(job.completed_stages),
    }
