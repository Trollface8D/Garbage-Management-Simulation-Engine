import threading
from datetime import datetime
from typing import Any

from fastapi.responses import JSONResponse

from ..models.job_models import JobRecord


JOBS: dict[str, JobRecord] = {}
JOBS_LOCK = threading.Lock()


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
        with JOBS_LOCK:
            job.current_stage = stage or job.current_stage
            job.stage_message = message
            job.stage_history.append({"stage": stage, "message": message})
            job.updated_at = utc_now_iso()

    if event == "error" and isinstance(payload, dict):
        with JOBS_LOCK:
            job.error = str(payload.get("error") or "Unknown pipeline execution error.")
            job.status = "failed"
            job.updated_at = utc_now_iso()

    if event == "result":
        with JOBS_LOCK:
            job.result = payload if isinstance(payload, dict) else None
            job.status = "completed"
            job.updated_at = utc_now_iso()

    if event == "done":
        with JOBS_LOCK:
            if job.status not in {"completed", "failed"}:
                job.status = "completed"
            job.updated_at = utc_now_iso()

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
        "error": job.error,
        "runDir": job.run_dir,
    }
