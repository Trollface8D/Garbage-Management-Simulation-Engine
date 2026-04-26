"""Synchronous Gemini call that semantically merges raw entity counts.

Used by the Code page to clean up the word-cloud noise produced by raw
extraction frequencies (e.g. {"waste separation": 2, "waste": 3} should
collapse to {"waste": 5}). Same input/output schema: a flat name->count
mapping. No job system — this is a one-shot LLM call expected to return in
a few seconds.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from ...infra.gemini_client import GeminiGateway
from ...infra.io_utils import resolve_api_key
from ...infra.paths import DEFAULT_MODEL_NAME


router = APIRouter(tags=["group_entities"])
logger = logging.getLogger(__name__)


_PROMPT_TEMPLATE = """You are normalizing a noisy bag of entity names extracted from
text about a domain (e.g. waste management, supply chain). Each name has a
frequency count from raw extraction. Your job is to merge semantically
equivalent or strongly-related names into a single canonical name and SUM
their counts.

Rules:
1. Pick the shortest, most general canonical form when merging
   ("waste separation" + "waste" -> "waste"; "garbage truck" + "trucks" -> "truck").
2. Only merge names that refer to the same actor/object/concept. Do NOT merge
   distinct things that merely co-occur (e.g. "driver" and "truck" stay separate).
3. Use lowercase canonical names unless the term is a proper noun.
4. Drop entries that are pure stopwords, single letters, numbers, or empty.
5. Preserve every input count somewhere in the output (sum of output counts
   should equal sum of input counts minus anything you legitimately dropped
   in rule 4).
6. Return ONLY a JSON object mapping canonical_name -> integer count.
   No prose, no markdown, no code fences.

Input counts:
{counts_json}

Output JSON:"""


def _coerce_counts(raw: Any) -> dict[str, int]:
    if not isinstance(raw, dict):
        raise ValueError("`counts` must be a JSON object of name -> integer.")
    out: dict[str, int] = {}
    for key, value in raw.items():
        name = str(key or "").strip()
        if not name:
            continue
        try:
            count = int(value)
        except (TypeError, ValueError):
            continue
        if count <= 0:
            continue
        out[name] = count
    return out


@router.post("/code_gen/group_entities")
def group_entities(payload: dict[str, Any] = Body(...)) -> JSONResponse:
    try:
        counts = _coerce_counts(payload.get("counts"))
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    if not counts:
        return JSONResponse({"counts": {}})

    api_key = resolve_api_key()
    if not api_key:
        return JSONResponse({"error": "GEMINI_API_KEY is not configured."}, status_code=500)

    model_name = (str(payload.get("model") or "").strip() or DEFAULT_MODEL_NAME)
    gateway = GeminiGateway(api_key=api_key, model_name=model_name)

    import json as _json
    prompt = _PROMPT_TEMPLATE.format(counts_json=_json.dumps(counts, ensure_ascii=False))

    try:
        parsed = gateway.generate_json(prompt)
    except Exception as exc:
        logger.exception("group-entities Gemini call failed")
        return JSONResponse({"error": f"Gemini call failed: {exc}"}, status_code=502)

    if not isinstance(parsed, dict):
        return JSONResponse(
            {"error": "Gemini did not return a JSON object."}, status_code=502
        )

    try:
        grouped = _coerce_counts(parsed)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=502)

    return JSONResponse({"counts": grouped})
