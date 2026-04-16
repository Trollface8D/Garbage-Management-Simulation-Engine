import mimetypes
import os
from io import BytesIO
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from google.genai.types import Part

from ...infra.gemini_client import GeminiGateway
from ...infra.io_utils import resolve_api_key
from ...infra.paths import AUDIO_MIME_MAP, DEFAULT_MODEL_NAME
from ..services.causal_store import (
    CausalStoreConstraintError,
    CausalStoreError,
    persist_to_causal_tables,
)
from ..services.structure_extractor import (
    GeminiRateLimitError,
    GeminiResponseParseError,
    GeminiResponseValidationError,
    StructureExtractionError,
    extract_structure_with_gemini,
)


router = APIRouter(tags=["extract"])


def _resolve_transcribe_model_name(model: str | None) -> str:
    configured = model or os.getenv("GEMINI_TRANSCRIBE_MODEL") or DEFAULT_MODEL_NAME
    normalized = configured.strip()
    return normalized or DEFAULT_MODEL_NAME


def _resolve_transcribe_fallback_model_name() -> str:
    configured = os.getenv("GEMINI_TRANSCRIBE_FALLBACK_MODEL") or os.getenv("GEMINI_MODEL") or "gemini-2.5-flash"
    normalized = configured.strip()
    return normalized or "gemini-2.5-flash"


def _is_model_not_found_error(message: str) -> bool:
    lowered = message.lower()
    return "not_found" in lowered or "no longer available" in lowered or "model" in lowered and "not found" in lowered


def _resolve_audio_mime_type(audio_file: UploadFile) -> str:
    content_type = (audio_file.content_type or "").strip().lower()
    if content_type.startswith("audio/"):
        return content_type

    filename = (audio_file.filename or "").strip().lower()
    _, extension = os.path.splitext(filename)

    if extension in AUDIO_MIME_MAP:
        return AUDIO_MIME_MAP[extension]

    guessed_mime, _ = mimetypes.guess_type(filename)
    if guessed_mime and guessed_mime.startswith("audio/"):
        return guessed_mime

    return "audio/mpeg"


def _resolve_uploaded_file_type(text_file: UploadFile) -> str:
    filename = (text_file.filename or "").strip().lower()
    if filename.endswith(".txt"):
        return "txt"
    if filename.endswith(".pdf"):
        return "pdf"
    raise ValueError("Only .txt and .pdf files are supported")


def _extract_text_from_pdf_bytes(file_bytes: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise RuntimeError("PDF support requires pypdf to be installed on the server.") from exc

    try:
        reader = PdfReader(BytesIO(file_bytes))
    except Exception as exc:
        raise ValueError("Uploaded PDF could not be read.") from exc

    text = "\n".join((page.extract_text() or "") for page in reader.pages).strip()
    if not text:
        raise ValueError("No extractable text found in PDF.")
    return text


async def _resolve_raw_text_from_request(request: Request) -> tuple[str | None, dict[str, Any]]:
    content_type = (request.headers.get("content-type") or "").lower()

    if "application/json" in content_type:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("JSON payload must be an object")
        body_text = payload.get("inputText") or payload.get("text")
        return (str(body_text).strip() if isinstance(body_text, str) else None, payload)

    if "text/plain" in content_type:
        raw = (await request.body()).decode("utf-8", errors="ignore").strip()
        return (raw or None, {})

    return (None, {})


@router.post("/extract")
async def extract_structure(
    request: Request,
    inputText: str | None = Form(default=None),
    textFile: UploadFile | None = File(default=None),
    model: str = Form(DEFAULT_MODEL_NAME),
    causalProjectDocumentId: str | None = Form(default=None),
    chunkId: str | None = Form(default=None),
    dbPath: str | None = Form(default=None),
):
    api_key = resolve_api_key()
    if not api_key:
        return JSONResponse(
            {
                "error": "API key is required. Set GEMINI_API_KEY, API_KEY, or GOOGLE_API_KEY in your environment.",
            },
            status_code=500,
        )

    json_text: str | None = None
    json_payload: dict[str, Any] = {}
    try:
        json_text, json_payload = await _resolve_raw_text_from_request(request)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    if textFile is not None and (inputText or json_text):
        return JSONResponse({"error": "Provide either textFile or raw text, not both."}, status_code=400)

    input_text = (inputText or json_text or "").strip()

    if textFile is not None:
        try:
            file_type = _resolve_uploaded_file_type(textFile)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

        file_bytes = await textFile.read()
        if not file_bytes:
            return JSONResponse({"error": "Uploaded file is empty."}, status_code=400)

        if file_type == "txt":
            try:
                input_text = file_bytes.decode("utf-8").strip()
            except UnicodeDecodeError:
                return JSONResponse({"error": "Text file must be UTF-8 encoded."}, status_code=400)
        else:
            try:
                input_text = _extract_text_from_pdf_bytes(file_bytes)
            except ValueError as exc:
                return JSONResponse({"error": str(exc)}, status_code=400)
            except RuntimeError as exc:
                return JSONResponse({"error": str(exc)}, status_code=500)

    if not input_text:
        return JSONResponse({"error": "No text content provided for extraction."}, status_code=400)

    model_name = (json_payload.get("model") if isinstance(json_payload.get("model"), str) else model).strip()
    if not model_name:
        model_name = DEFAULT_MODEL_NAME

    if not causalProjectDocumentId and isinstance(json_payload.get("causalProjectDocumentId"), str):
        causalProjectDocumentId = json_payload["causalProjectDocumentId"]
    if not chunkId and isinstance(json_payload.get("chunkId"), str):
        chunkId = json_payload["chunkId"]
    if not dbPath and isinstance(json_payload.get("dbPath"), str):
        dbPath = json_payload["dbPath"]

    effective_doc_id = (causalProjectDocumentId or uuid4().hex).strip()

    try:
        records = extract_structure_with_gemini(
            api_key=api_key,
            input_text=input_text,
            model_name=model_name,
        )
    except GeminiRateLimitError as exc:
        return JSONResponse({"error": str(exc)}, status_code=429)
    except (GeminiResponseParseError, GeminiResponseValidationError) as exc:
        return JSONResponse({"error": str(exc)}, status_code=502)
    except StructureExtractionError as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)

    try:
        persist_result = persist_to_causal_tables(
            db_path=dbPath,
            causal_project_document_id=effective_doc_id,
            chunk_id=chunkId,
            records=records,
        )
    except CausalStoreConstraintError as exc:
        return JSONResponse({"error": str(exc), "causalProjectDocumentId": effective_doc_id}, status_code=409)
    except CausalStoreError as exc:
        return JSONResponse({"error": str(exc), "causalProjectDocumentId": effective_doc_id}, status_code=500)

    return {
        "causalProjectDocumentId": effective_doc_id,
        "model": model_name,
        "dbPath": persist_result.db_path,
        "insertedExtractionClasses": persist_result.inserted_extraction_classes,
        "insertedCausalRows": persist_result.inserted_causal_rows,
        "records": [record.model_dump() for record in records],
    }


@router.post("/transcribe/audio")
async def transcribe_audio(
    audioFile: UploadFile = File(...),
    model: str | None = Form(default=None),
):
    api_key = resolve_api_key()
    if not api_key:
        return JSONResponse(
            {
                "error": "API key is required. Set GEMINI_API_KEY, API_KEY, or GOOGLE_API_KEY in your environment.",
            },
            status_code=500,
        )

    file_bytes = await audioFile.read()
    if not file_bytes:
        return JSONResponse({"error": "Uploaded audio file is empty."}, status_code=400)

    mime_type = _resolve_audio_mime_type(audioFile)
    model_name = _resolve_transcribe_model_name(model)

    gateway = GeminiGateway(api_key=api_key, model_name=model_name)
    prompt = (
        "Transcribe this Thai/English interview audio into plain text. "
        "Keep wording faithful and do not summarize."
    )

    used_fallback_model = False
    try:
        response_text = gateway.generate_text(
            prompt,
            parts=[Part.from_bytes(data=file_bytes, mime_type=mime_type)],
            response_json=False,
        )
    except Exception as exc:
        error_message = str(exc)
        fallback_model_name = _resolve_transcribe_fallback_model_name()

        if model_name != fallback_model_name and _is_model_not_found_error(error_message):
            try:
                fallback_gateway = GeminiGateway(api_key=api_key, model_name=fallback_model_name)
                response_text = fallback_gateway.generate_text(
                    prompt,
                    parts=[Part.from_bytes(data=file_bytes, mime_type=mime_type)],
                    response_json=False,
                )
                model_name = fallback_model_name
                used_fallback_model = True
            except Exception as fallback_exc:
                return JSONResponse(
                    {
                        "error": (
                            "Audio transcription failed with requested model "
                            f"'{model_name}' and fallback '{fallback_model_name}': {str(fallback_exc)}"
                        )
                    },
                    status_code=502,
                )
        else:
            return JSONResponse({"error": f"Audio transcription failed: {error_message}"}, status_code=502)

    transcription = response_text.strip()
    if not transcription:
        return JSONResponse({"error": "Empty transcription result."}, status_code=502)

    return {
        "text": transcription,
        "model": model_name,
        "usedFallbackModel": used_fallback_model,
        "mimeType": mime_type,
        "fileName": audioFile.filename,
    }