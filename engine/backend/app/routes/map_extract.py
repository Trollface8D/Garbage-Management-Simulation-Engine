from __future__ import annotations

import logging
import os
import threading
import time
from uuid import uuid4

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import JSONResponse

from ...infra.io_utils import resolve_api_key
from ...infra.paths import DEFAULT_MODEL_NAME
from ..models.job_models import JobRecord
from ..services.job_store import JOBS, JOBS_LOCK, emit_job_event, serialize_job, utc_now_iso
from ..services.map_extract_runner import run_map_extract_worker


router = APIRouter(tags=["map_extract"])
logger = logging.getLogger(__name__)
MAP_EXTRACT_JOB_TIMEOUT_SECONDS = int(os.getenv("MAP_EXTRACT_JOB_TIMEOUT_SECONDS", "600"))

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
PDF_EXTENSIONS = {".pdf"}
TEXT_EXTENSIONS = {".txt", ".md", ".csv", ".json", ".log", ".tsv", ".yaml", ".yml"}


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
    def watchdog() -> None:
        if MAP_EXTRACT_JOB_TIMEOUT_SECONDS <= 0:
            return

        time.sleep(MAP_EXTRACT_JOB_TIMEOUT_SECONDS)
        with JOBS_LOCK:
            if job.status in {"completed", "failed"}:
                return

        timeout_error = (
            f"map_extract timed out after {MAP_EXTRACT_JOB_TIMEOUT_SECONDS}s and was terminated."
        )
        logger.error("[map_extract] timeout watchdog terminated jobId=%s", job.job_id)
        emit_job_event(job, "error", {"error": timeout_error})
        emit_job_event(job, "close", None)

    threading.Thread(target=watchdog, daemon=True).start()


@router.post("/map_extract/jobs")
async def create_map_extract_job(
    componentId: str = Form(default=""),
    overviewAdditionalInformation: str = Form(default=""),
    binAdditionalInformation: str = Form(default=""),
    model: str = Form(default=DEFAULT_MODEL_NAME),
    overviewMapFiles: list[UploadFile] = File(default_factory=list),
    binLocationFiles: list[UploadFile] = File(default_factory=list),
):
    resolved_model = model.strip() or DEFAULT_MODEL_NAME
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
        "[map_extract] request received componentId=%s overviewFiles=%s supportFiles=%s model=%s",
        componentId,
        len(overviewMapFiles),
        len(binLocationFiles),
        resolved_model,
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
        "[map_extract] job config jobId=%s model=%s overviewTextLen=%s supportTextLen=%s",
        job_id,
        resolved_model,
        len(overviewAdditionalInformation),
        len(binAdditionalInformation),
    )

    thread = threading.Thread(
        target=run_map_extract_worker,
        kwargs={
            "job": job,
            "api_key": api_key,
            "model_name": resolved_model,
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
    if job is None:
        logger.warning("[map_extract] status query job not found jobId=%s", job_id)
        return JSONResponse({"error": f"Job '{job_id}' not found."}, status_code=404)
    logger.info(
        "[map_extract] status query jobId=%s status=%s stage=%s",
        job_id,
        job.status,
        job.current_stage,
    )
    return serialize_job(job)


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
