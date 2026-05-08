import threading
from uuid import uuid4

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import JSONResponse

from ...infra.io_utils import is_auth_available, resolve_api_key
from ...infra.paths import DEFAULT_MODEL_NAME
from ..models.job_models import JobRecord
from ..services.job_runner import run_job_worker
from ..services.job_store import JOBS, JOBS_LOCK, utc_now_iso


router = APIRouter(tags=["jobs"])


@router.post("/pipeline/jobs")
async def create_pipeline_job(
    inputMode: str = Form("file"),
    fileMode: str = Form("audio"),
    inputText: str = Form(""),
    model: str = Form(DEFAULT_MODEL_NAME),
    chunkSizeWords: int = Form(900),
    chunkOverlapWords: int = Form(180),
    audioFile: UploadFile | None = File(default=None),
    textFile: UploadFile | None = File(default=None),
):
    if not is_auth_available():
        return JSONResponse(
            {"error": "No auth configured. Set GOOGLE_APPLICATION_CREDENTIALS or GEMINI_API_KEY."},
            status_code=500,
        )
    api_key = resolve_api_key()

    if inputMode == "text" and not inputText.strip():
        return JSONResponse({"error": "Input text is required when input mode is text."}, status_code=400)
    if inputMode != "text":
        selected_file = textFile if fileMode == "textFile" else audioFile
        if selected_file is None:
            return JSONResponse({"error": "Please upload a valid file."}, status_code=400)

    now = utc_now_iso()
    job_id = uuid4().hex
    job = JobRecord(
        job_id=job_id,
        status="queued",
        created_at=now,
        updated_at=now,
    )

    with JOBS_LOCK:
        JOBS[job_id] = job

    thread = threading.Thread(
        target=run_job_worker,
        kwargs={
            "job": job,
            "api_key": api_key,
            "input_mode": inputMode,
            "file_mode": fileMode,
            "input_text": inputText,
            "model": model,
            "chunk_size_words": chunkSizeWords,
            "chunk_overlap_words": chunkOverlapWords,
            "audio_file": audioFile,
            "text_file": textFile,
        },
        daemon=True,
    )
    thread.start()

    return {
        "jobId": job_id,
        "status": "queued",
        "streamUrl": f"/pipeline/jobs/{job_id}/stream",
        "statusUrl": f"/pipeline/jobs/{job_id}",
        "resultUrl": f"/pipeline/jobs/{job_id}/result",
    }
