import json
import logging
import os
import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...infra.gemini_client import GeminiGateway
from ...infra.io_utils import is_auth_available, read_text, resolve_api_key
from ...infra.paths import BACKEND_DIR, DEFAULT_MODEL_NAME


logger = logging.getLogger(__name__)
router = APIRouter(tags=["extract"])
FOLLOW_UP_ANSWER_PROMPT_PATH = BACKEND_DIR / "prompt" / "follow_up_answer.txt"


def _build_search_tools() -> list[Any] | None:
    try:
        from google.genai.types import GoogleSearch, Tool

        return [Tool(google_search=GoogleSearch())]
    except Exception as exc:  # pragma: no cover - optional dependency
        logger.info("Follow-up answer search tool unavailable: %s", exc)
        return None


def _resolve_answer_model_name(model: str | None) -> str:
    configured = (
        (model or "").strip()
        or os.getenv("GEMINI_FOLLOW_UP_ANSWER_MODEL", "").strip()
        or os.getenv("GEMINI_FOLLOW_UP_MODEL", "").strip()
        or os.getenv("GEMINI_MODEL", "").strip()
    )
    return configured or DEFAULT_MODEL_NAME


def _normalize_question_payload(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []

    normalized: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue

        question_text = str(entry.get("questionText") or entry.get("question_text") or "").strip()
        if not question_text:
            continue

        normalized.append(
            {
                "question_text": question_text,
                "source_text": str(entry.get("sourceText") or entry.get("source_text") or "").strip(),
                "sentence_type": str(entry.get("sentenceType") or entry.get("sentence_type") or "").strip(),
                "use_internet": bool(entry.get("useInternet") or entry.get("use_internet") or False),
            }
        )

    return normalized


def _normalize_answer_records(payload: Any) -> list[dict[str, str]]:
    if isinstance(payload, dict) and isinstance(payload.get("answers"), list):
        raw_records = payload.get("answers")
    elif isinstance(payload, list):
        raw_records = payload
    else:
        raw_records = []

    normalized: list[dict[str, str]] = []
    for entry in raw_records:
        if not isinstance(entry, dict):
            continue

        question_text = str(entry.get("question_text") or entry.get("questionText") or "").strip()
        answer_text = str(entry.get("answer_text") or entry.get("answerText") or "").strip()
        source_text = str(entry.get("source_text") or entry.get("sourceText") or "").strip()
        if not question_text or not answer_text:
            continue

        normalized.append(
            {
                "questionText": question_text,
                "answerText": answer_text,
                "sourceText": source_text,
            }
        )

    return normalized


@router.post("/follow-up-answer")
async def generate_follow_up_answers(request: Request):
    if not is_auth_available():
        return JSONResponse(
            {
                "error": "No auth configured. Set GOOGLE_APPLICATION_CREDENTIALS or GEMINI_API_KEY.",
            },
            status_code=500,
        )

    api_key = resolve_api_key()

    try:
        payload = await request.json()
    except ValueError:
        return JSONResponse({"error": "Invalid JSON payload."}, status_code=400)

    if not isinstance(payload, dict):
        return JSONResponse({"error": "JSON payload must be an object."}, status_code=400)

    questions = _normalize_question_payload(payload.get("questions"))
    if not questions:
        return JSONResponse({"error": "questions is required."}, status_code=400)

    model_name = _resolve_answer_model_name(payload.get("model"))

    fallback_models_raw = (
        os.getenv("GEMINI_FOLLOW_UP_ANSWER_FALLBACK_MODELS")
        or os.getenv("GEMINI_FOLLOW_UP_FALLBACK_MODELS")
        or ""
    ).strip()
    fallback_models = [m.strip() for m in fallback_models_raw.split(",") if m.strip()]

    candidate_models: list[str] = []
    for candidate in [model_name, *fallback_models]:
        if candidate and candidate not in candidate_models:
            candidate_models.append(candidate)

    max_retries_per_model = max(1, int(os.getenv("GEMINI_FOLLOW_UP_ANSWER_MAX_RETRIES_PER_MODEL", "2")))
    initial_backoff_seconds = max(0.1, float(os.getenv("GEMINI_FOLLOW_UP_ANSWER_RETRY_BACKOFF_SECONDS", "0.8")))

    try:
        prompt_template = read_text(FOLLOW_UP_ANSWER_PROMPT_PATH).strip()
    except OSError as exc:
        return JSONResponse({"error": f"Failed to load follow-up answer prompt: {exc}"}, status_code=500)

    prompt = f"{prompt_template}\n\nInput JSON:\n{json.dumps(questions, ensure_ascii=False)}"

    raw_text = ""
    selected_model = model_name
    last_error: Exception | None = None
    exhausted_retryable = False

    use_internet = any(bool(item.get("use_internet")) for item in questions)
    tools = _build_search_tools() if use_internet else None

    response_json = tools is None

    for candidate_model in candidate_models:
        gateway = GeminiGateway(api_key=api_key, model_name=candidate_model)
        for attempt in range(1, max_retries_per_model + 1):
            try:
                raw_text = gateway.generate_text(prompt, response_json=response_json, tools=tools).strip()
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
                            "Follow-up answer retrying model=%s attempt=%s/%s backoff=%.2fs error=%s",
                            candidate_model,
                            attempt,
                            max_retries_per_model,
                            backoff,
                            message,
                        )
                        time.sleep(backoff)
                        continue

                    logger.warning(
                        "Follow-up answer exhausted retries for model=%s error=%s",
                        candidate_model,
                        message,
                    )
                    break

                logger.exception("Follow-up answer request to Gemini failed model=%s", candidate_model)
                return JSONResponse({"error": "Follow-up answer failed."}, status_code=502)

        if raw_text:
            break

    if not raw_text:
        if exhausted_retryable:
            return JSONResponse(
                {
                    "error": "Follow-up answer service is temporarily busy. Please retry shortly.",
                    "detail": str(last_error) if last_error else "Transient Gemini error",
                    "modelsTried": candidate_models,
                },
                status_code=503,
            )

        if last_error is not None:
            return JSONResponse(
                {
                    "error": "Follow-up answer failed.",
                    "detail": str(last_error),
                    "modelsTried": candidate_models,
                },
                status_code=502,
            )

        return JSONResponse({"error": "Gemini returned empty payload."}, status_code=502)

    try:
        parsed_payload = GeminiGateway.parse_json_relaxed(raw_text)
    except ValueError:
        logger.exception("Failed to parse Gemini follow-up answer JSON output")
        return JSONResponse(
            {
                "error": "Follow-up answer returned an invalid response.",
            },
            status_code=502,
        )

    return {
        "model": selected_model,
        "answers": _normalize_answer_records(parsed_payload),
    }
