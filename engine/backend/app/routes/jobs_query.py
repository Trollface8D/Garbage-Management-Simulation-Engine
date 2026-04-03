from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..services.job_store import get_job_or_404, serialize_job


router = APIRouter(tags=["jobs"])


@router.get("/pipeline/jobs/{job_id}")
def get_pipeline_job(job_id: str):
    job = get_job_or_404(job_id)
    if isinstance(job, JSONResponse):
        return job
    return serialize_job(job)


@router.get("/pipeline/jobs/{job_id}/result")
def get_pipeline_job_result(job_id: str):
    job = get_job_or_404(job_id)
    if isinstance(job, JSONResponse):
        return job
    if job.status == "failed":
        return JSONResponse({"error": job.error or "Job failed."}, status_code=500)
    if job.status != "completed" or job.result is None:
        return JSONResponse({"error": "Job is not completed yet."}, status_code=409)
    return job.result
