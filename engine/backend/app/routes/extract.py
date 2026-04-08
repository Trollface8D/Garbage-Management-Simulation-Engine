from typing import Any
from uuid import uuid4

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse

from ...infra.io_utils import resolve_api_key
from ...infra.paths import DEFAULT_MODEL_NAME
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


def _extract_text_from_txt_file(text_file: UploadFile) -> str:
    filename = (text_file.filename or "").strip().lower()
    if not filename.endswith(".txt"):
        raise ValueError("Only .txt files are supported")

    return filename


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
            _extract_text_from_txt_file(textFile)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

        file_bytes = await textFile.read()
        if not file_bytes:
            return JSONResponse({"error": "Uploaded file is empty."}, status_code=400)
        try:
            input_text = file_bytes.decode("utf-8").strip()
        except UnicodeDecodeError:
            return JSONResponse({"error": "Text file must be UTF-8 encoded."}, status_code=400)

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