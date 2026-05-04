from pydantic import ValidationError

from ...infra.gemini_client import GeminiGateway
from ...infra.io_utils import read_text
from ...infra.paths import DEFAULT_STRUCTURE_EXTRACTION_PROMPT
from ...pipelines.c4.stages import inject_input
from ..models.extraction_models import ExtractionClassRecord, validate_extraction_payload


class StructureExtractionError(Exception):
    pass


class GeminiRateLimitError(StructureExtractionError):
    pass


class GeminiResponseParseError(StructureExtractionError):
    pass


class GeminiResponseValidationError(StructureExtractionError):
    pass


def _is_rate_limit_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return any(token in message for token in ("429", "rate limit", "resource exhausted", "quota"))


def extract_structure_with_gemini(
    *,
    api_key: str | None,
    input_text: str,
    model_name: str,
) -> list[ExtractionClassRecord]:
    prompt_template = read_text(DEFAULT_STRUCTURE_EXTRACTION_PROMPT)
    prompt = inject_input(prompt_template, input_text)

    gateway = GeminiGateway(api_key=api_key, model_name=model_name)

    try:
        # response_json=True maps to response_mime_type="application/json" in GeminiGateway.
        raw_text = gateway.generate_text(prompt, response_json=True).strip()
    except Exception as exc:  # pragma: no cover - provider side errors are dynamic
        if _is_rate_limit_error(exc):
            raise GeminiRateLimitError("Gemini API rate limit exceeded") from exc
        raise StructureExtractionError(f"Gemini request failed: {exc}") from exc

    if not raw_text:
        raise GeminiResponseParseError("Gemini returned an empty payload")

    try:
        payload = GeminiGateway.parse_json_relaxed(raw_text)
    except ValueError as exc:
        raise GeminiResponseParseError(f"Failed to parse Gemini JSON output: {exc}") from exc

    try:
        return validate_extraction_payload(payload)
    except (ValidationError, ValueError) as exc:
        raise GeminiResponseValidationError(f"Gemini JSON does not match extraction schema: {exc}") from exc