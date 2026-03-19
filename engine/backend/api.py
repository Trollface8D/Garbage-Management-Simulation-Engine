import json
import queue
import shutil
import threading
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from tempfile import mkdtemp
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from .constants import (
    DEFAULT_CAUSAL_PROMPT,
    DEFAULT_ENTITY_EXTRACTION_PROMPT,
    DEFAULT_ENTITY_GENERATION_PROMPT,
    DEFAULT_ENTITY_TEMPLATE_DIR,
    DEFAULT_FOLLOW_UP_PROMPT,
    DEFAULT_MODEL_NAME,
    DEFAULT_OUTPUT_ROOT,
)
from .engine import PipelineEngine
from .io_utils import resolve_api_key


def sse_event(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def build_response_from_run_dir(run_dir: Path, stdout: str) -> dict[str, Any]:
    summary = read_json(run_dir / "summary.json")
    entities = read_json(run_dir / "entities.json")
    follow_up_questions = read_json(run_dir / "follow_up_questions.json")
    causal_combined = read_json(run_dir / "causal_combined.json")
    generated_entity_files = read_json(run_dir / "generated_entity_files.json")

    return {
        "summary": summary,
        "entities": entities,
        "followUpQuestions": follow_up_questions,
        "causalCombined": causal_combined,
        "generatedEntityFiles": generated_entity_files,
        "stdout": stdout,
    }


@dataclass
class JobRecord:
    job_id: str
    status: str
    created_at: str
    updated_at: str
    current_stage: str | None = None
    stage_message: str = ""
    stage_history: list[dict[str, str]] = field(default_factory=list)
    error: str | None = None
    result: dict[str, Any] | None = None
    event_queue: queue.Queue[tuple[str, Any]] = field(default_factory=queue.Queue)


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


def run_job_worker(
    job: JobRecord,
    *,
    api_key: str,
    input_mode: str,
    file_mode: str,
    input_text: str,
    model: str,
    chunk_size_words: int,
    chunk_overlap_words: int,
    audio_file: UploadFile | None,
    text_file: UploadFile | None,
) -> None:
    request_output_root = (
        DEFAULT_OUTPUT_ROOT
        / "fastapi_runs"
        / f"request_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid4().hex[:8]}"
    )
    request_output_root.mkdir(parents=True, exist_ok=True)

    temp_dir = Path(mkdtemp(prefix="pipeline-upload-"))
    input_path: Path | None = None
    resolved_input_type = "text"
    stdout_capture = ""

    try:
        with JOBS_LOCK:
            job.status = "running"
            job.updated_at = utc_now_iso()

        emit_job_event(job, "stage", {"stage": "starting", "message": "Pipeline process started"})

        if input_mode == "text":
            if not input_text.strip():
                raise ValueError("Input text is required when input mode is text.")
            resolved_input_type = "text"
        else:
            selected_file = text_file if file_mode == "textFile" else audio_file
            if selected_file is None:
                raise ValueError("Please upload a valid file.")
            input_path = temp_dir / (selected_file.filename or "input.dat")
            file_bytes = selected_file.file.read()
            input_path.write_bytes(file_bytes)
            resolved_input_type = "text" if file_mode == "textFile" else "audio"

        def publish_stage(stage: str, message: str) -> None:
            emit_job_event(job, "stage", {"stage": stage, "message": message})

        engine = PipelineEngine(
            api_key=api_key,
            model_name=model,
            chunk_size_words=chunk_size_words,
            chunk_overlap_words=chunk_overlap_words,
            causal_prompt_path=DEFAULT_CAUSAL_PROMPT,
            follow_up_prompt_path=DEFAULT_FOLLOW_UP_PROMPT,
            entity_extraction_prompt_path=DEFAULT_ENTITY_EXTRACTION_PROMPT,
            entity_generation_prompt_path=DEFAULT_ENTITY_GENERATION_PROMPT,
            entity_template_dir=DEFAULT_ENTITY_TEMPLATE_DIR,
            output_root=request_output_root,
            stage_callback=publish_stage,
        )

        summary = engine.run(
            input_type=resolved_input_type,
            input_path=input_path,
            input_text=input_text if input_mode == "text" else None,
        )

        run_dir = Path(summary["run_dir"])
        response_payload = build_response_from_run_dir(run_dir, stdout=stdout_capture)
        emit_job_event(job, "result", response_payload)
        emit_job_event(job, "done", {"ok": True})
    except Exception as error:
        emit_job_event(job, "error", {"error": str(error)})
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
        job.event_queue.put(("close", None))


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
    }


app = FastAPI(title="Framework Simulation Engine API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/pipeline/jobs")
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
    api_key = resolve_api_key()
    if not api_key:
        return JSONResponse(
            {"error": "API key is required. Set API_KEY or GOOGLE_API_KEY in your environment."},
            status_code=500,
        )

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


@app.get("/pipeline/jobs/{job_id}")
def get_pipeline_job(job_id: str):
    job = get_job_or_404(job_id)
    if isinstance(job, JSONResponse):
        return job
    return serialize_job(job)


@app.get("/pipeline/jobs/{job_id}/result")
def get_pipeline_job_result(job_id: str):
    job = get_job_or_404(job_id)
    if isinstance(job, JSONResponse):
        return job
    if job.status == "failed":
        return JSONResponse({"error": job.error or "Job failed."}, status_code=500)
    if job.status != "completed" or job.result is None:
        return JSONResponse({"error": "Job is not completed yet."}, status_code=409)
    return job.result


@app.get("/pipeline/jobs/{job_id}/stream")
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


@app.post("/pipeline/run/stream")
async def run_pipeline_stream_compat(
    inputMode: str = Form("file"),
    fileMode: str = Form("audio"),
    inputText: str = Form(""),
    model: str = Form(DEFAULT_MODEL_NAME),
    chunkSizeWords: int = Form(900),
    chunkOverlapWords: int = Form(180),
    audioFile: UploadFile | None = File(default=None),
    textFile: UploadFile | None = File(default=None),
):
    creation = await create_pipeline_job(
        inputMode=inputMode,
        fileMode=fileMode,
        inputText=inputText,
        model=model,
        chunkSizeWords=chunkSizeWords,
        chunkOverlapWords=chunkOverlapWords,
        audioFile=audioFile,
        textFile=textFile,
    )
    if isinstance(creation, JSONResponse):
        return creation
    return stream_pipeline_job(creation["jobId"])


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("backend.api:app", host="127.0.0.1", port=8000, reload=False)
