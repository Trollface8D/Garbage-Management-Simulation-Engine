from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..services.artifacts import list_artifacts, read_artifact
from ..services.job_store import get_job_or_404


router = APIRouter(tags=["jobs"])


@router.get("/pipeline/jobs/{job_id}/artifacts")
def get_pipeline_job_artifacts(job_id: str):
    job = get_job_or_404(job_id)
    if isinstance(job, JSONResponse):
        return job
    return list_artifacts(job)


@router.get("/pipeline/jobs/{job_id}/artifacts/{artifact_name}")
def get_pipeline_job_artifact(job_id: str, artifact_name: str):
    job = get_job_or_404(job_id)
    if isinstance(job, JSONResponse):
        return job
    return read_artifact(job, artifact_name)
