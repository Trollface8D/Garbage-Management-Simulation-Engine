import json
import logging
import os
import time
from io import BytesIO
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse

from ...infra.gemini_client import GeminiGateway
from ...infra.io_utils import read_text, resolve_api_key
from ...infra.paths import BACKEND_DIR, DEFAULT_MODEL_NAME
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
FOLLOW_UP_PROMPT_PATH = BACKEND_DIR / "prompt" / "follow_up.txt"
logger = logging.getLogger(__name__)


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


def _normalize_follow_up_records(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        return []

    records: list[dict[str, Any]] = []
    for entry in payload:
        if not isinstance(entry, dict):
            continue

        source_text = str(entry.get("source_text") or "").strip()
        sentence_type = str(entry.get("sentence_type") or "").strip()
        raw_questions = entry.get("generated_questions")
        if not isinstance(raw_questions, list):
            raw_questions = []

        generated_questions: list[str] = []
        for question in raw_questions:
            if isinstance(question, str):
                normalized = question.strip()
                if normalized:
                    generated_questions.append(normalized)

        if not source_text:
            continue

        records.append(
            {
                "source_text": source_text,
                "sentence_type": sentence_type,
                "generated_questions": generated_questions,
            }
        )

    return records


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


@router.post("/follow-up")
async def generate_follow_up_questions(request: Request):
    api_key = resolve_api_key()
    if not api_key:
        return JSONResponse(
            {
                "error": "API key is required. Set GEMINI_API_KEY, API_KEY, or GOOGLE_API_KEY in your environment.",
            },
            status_code=500,
        )

    try:
        payload = await request.json()
    except ValueError:
        return JSONResponse({"error": "Invalid JSON payload."}, status_code=400)

    if not isinstance(payload, dict):
        return JSONResponse({"error": "JSON payload must be an object."}, status_code=400)

    causal_items = payload.get("causalItems")
    if not isinstance(causal_items, list) or not causal_items:
        return JSONResponse({"error": "causalItems is required."}, status_code=400)

    model_name = str(payload.get("model") or "").strip() or DEFAULT_MODEL_NAME

    fallback_models_raw = (os.getenv("GEMINI_FOLLOW_UP_FALLBACK_MODELS") or "").strip()
    fallback_models = [m.strip() for m in fallback_models_raw.split(",") if m.strip()]

    candidate_models: list[str] = []
    for candidate in [model_name, *fallback_models]:
        if candidate and candidate not in candidate_models:
            candidate_models.append(candidate)

    max_retries_per_model = max(1, int(os.getenv("GEMINI_FOLLOW_UP_MAX_RETRIES_PER_MODEL", "2")))
    initial_backoff_seconds = max(0.1, float(os.getenv("GEMINI_FOLLOW_UP_RETRY_BACKOFF_SECONDS", "0.8")))

    try:
        prompt_template = read_text(FOLLOW_UP_PROMPT_PATH).strip()
    except OSError as exc:
        return JSONResponse({"error": f"Failed to load follow-up prompt: {exc}"}, status_code=500)

    prompt = f"{prompt_template}\n\nInput JSON:\n{json.dumps(causal_items, ensure_ascii=False)}"

    raw_text = ""
    selected_model = model_name
    last_error: Exception | None = None
    exhausted_retryable = False

    for candidate_model in candidate_models:
        gateway = GeminiGateway(api_key=api_key, model_name=candidate_model)
        for attempt in range(1, max_retries_per_model + 1):
            try:
                raw_text = gateway.generate_text(prompt, response_json=True).strip()
                selected_model = candidate_model
                last_error = None
                break
            except Exception as exc:  # pragma: no cover - provider side errors are dynamic
                last_error = exc
                message = str(exc)
                lowered = message.lower()
                is_retryable = GeminiGateway._is_retryable_transient_error(exc) or any(
                    token in lowered for token in ("429", "rate limit", "resource exhausted", "quota")
                )

                if is_retryable:
                    exhausted_retryable = True
                    if attempt < max_retries_per_model:
                        backoff = initial_backoff_seconds * (2 ** (attempt - 1))
                        logger.warning(
                            "Follow-up generation retrying model=%s attempt=%s/%s backoff=%.2fs error=%s",
                            candidate_model,
                            attempt,
                            max_retries_per_model,
                            backoff,
                            message,
                        )
                        time.sleep(backoff)
                        continue

                    logger.warning(
                        "Follow-up generation exhausted retries for model=%s error=%s",
                        candidate_model,
                        message,
                    )
                    break

                logger.exception("Follow-up generation request to Gemini failed model=%s", candidate_model)
                return JSONResponse({"error": "Follow-up generation failed."}, status_code=502)

        if raw_text:
            break

    if not raw_text:
        if exhausted_retryable:
            return JSONResponse(
                {
                    "error": "Follow-up service is temporarily busy. Please retry shortly.",
                    "detail": str(last_error) if last_error else "Transient Gemini error",
                    "modelsTried": candidate_models,
                },
                status_code=503,
            )

        if last_error is not None:
            return JSONResponse(
                {
                    "error": "Follow-up generation failed.",
                    "detail": str(last_error),
                    "modelsTried": candidate_models,
                },
                status_code=502,
            )

        return JSONResponse({"error": "Gemini returned empty payload."}, status_code=502)

    if not raw_text:
        return JSONResponse({"error": "Gemini returned empty payload."}, status_code=502)

    try:
        parsed_payload = GeminiGateway.parse_json_relaxed(raw_text)
    except ValueError:
        logger.exception("Failed to parse Gemini follow-up JSON output")
        return JSONResponse(
            {
                "error": "Follow-up generation returned an invalid response.",
            },
            status_code=502,
        )

    return {
        "model": selected_model,
        "records": _normalize_follow_up_records(parsed_payload),
    }