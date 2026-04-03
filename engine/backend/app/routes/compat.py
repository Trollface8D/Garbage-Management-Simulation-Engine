from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import JSONResponse

from ...infra.paths import DEFAULT_MODEL_NAME
from .jobs_create import create_pipeline_job
from .jobs_stream import stream_pipeline_job


router = APIRouter(tags=["compat"])


@router.post("/pipeline/run/stream")
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
