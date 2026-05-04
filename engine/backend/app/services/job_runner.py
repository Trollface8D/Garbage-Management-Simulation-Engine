import shutil
from datetime import datetime
from pathlib import Path
from tempfile import mkdtemp
from uuid import uuid4

from fastapi import UploadFile

from ...infra.paths import (
    DEFAULT_CAUSAL_PROMPT,
    DEFAULT_ENTITY_EXTRACTION_PROMPT,
    DEFAULT_ENTITY_GENERATION_PROMPT,
    DEFAULT_ENTITY_TEMPLATE_DIR,
    DEFAULT_FOLLOW_UP_PROMPT,
    DEFAULT_OUTPUT_ROOT,
)
from ...pipelines.c4.orchestrator import C4PipelineEngine
from .artifacts import build_response_from_run_dir
from .job_store import JOBS_LOCK, emit_job_event, utc_now_iso
from ..models.job_models import JobRecord


def run_job_worker(
    job: JobRecord,
    *,
    api_key: str | None,
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

        engine = C4PipelineEngine(
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

        with JOBS_LOCK:
            job.run_dir = str(engine.run_dir)
            job.updated_at = utc_now_iso()

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
