from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse

from ..services.job_store import JOBS_LOCK, get_job_or_404
from ..services.sse import sse_event


router = APIRouter(tags=["jobs"])


@router.get("/pipeline/jobs/{job_id}/stream")
def stream_pipeline_job(job_id: str):
    job = get_job_or_404(job_id)
    if isinstance(job, JSONResponse):
        return job

    def event_stream():
        with JOBS_LOCK:
            backlog = list(job.stage_history)

        for stage in backlog:
            yield sse_event("stage", stage)

        while True:
            event, payload = job.event_queue.get()
            if event == "close":
                break
            yield sse_event(event, payload)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
        },
    )
