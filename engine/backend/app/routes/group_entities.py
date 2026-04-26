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


_PROMPT_TEMPLATE = """You are doing aggressive hierarchical clustering of a noisy bag of
entity names extracted from text about a domain (e.g. waste management,
supply chain). Each name has a frequency count from raw extraction. The
downstream goal is to give a human a SHORT list of high-level actors /
objects / concepts to choose from, so be aggressive about collapsing
related terms.

Rules:
1. Cluster names that refer to the same actor / object / concept OR to a
   common parent concept. Examples:
   - "waste", "waste separation", "general waste", "household waste" ->
     parent "waste"
   - "garbage truck", "trucks", "collection truck" -> parent "truck"
   - "driver", "truck driver", "operator" -> parent "driver"
2. Pick the shortest, most general lowercase canonical form as the parent
   name. Use a proper noun only when it really is one.
3. Be aggressive: if two names plausibly belong together for a domain
   reader, merge them. Aim for roughly 5-15 top-level groups for typical
   inputs, fewer when the input is small.
4. Do NOT merge distinct things that merely co-occur (e.g. "driver" and
   "truck" stay separate parents).
5. Drop entries that are pure stopwords, single letters, numbers, empty,
   or pure verbs/actions ("collect", "load") that aren't entities.
6. Every accepted input must appear as a member of exactly one group. The
   parent's count is the sum of its members' counts.
7. If a name doesn't merge with anything, output a singleton group with
   one member equal to the input.

Return ONLY a JSON object of this exact shape (no prose, no markdown, no
code fences):
{{
  "groups": [
    {{
      "canonical": "<parent name>",
      "members": [
        {{"name": "<original input name>", "count": <int>}},
        ...
      ]
    }},
    ...
  ]
}}

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

    raw_groups = parsed.get("groups")
    if not isinstance(raw_groups, list):
        return JSONResponse(
            {"error": "Gemini response missing `groups` array."}, status_code=502
        )

    out_groups: list[dict[str, Any]] = []
    for raw_group in raw_groups:
        if not isinstance(raw_group, dict):
            continue
        canonical = str(raw_group.get("canonical") or "").strip()
        if not canonical:
            continue
        raw_members = raw_group.get("members")
        if not isinstance(raw_members, list):
            continue
        members: list[dict[str, Any]] = []
        total = 0
        for raw_member in raw_members:
            if not isinstance(raw_member, dict):
                continue
            name = str(raw_member.get("name") or "").strip()
            if not name:
                continue
            try:
                cnt = int(raw_member.get("count"))
            except (TypeError, ValueError):
                continue
            if cnt <= 0:
                continue
            members.append({"name": name, "count": cnt})
            total += cnt
        if not members:
            continue
        out_groups.append({"canonical": canonical, "count": total, "members": members})

    if not out_groups:
        return JSONResponse(
            {"error": "Gemini returned no usable groups."}, status_code=502
        )

    return JSONResponse({"groups": out_groups})
