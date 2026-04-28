"""Synchronous Gemini call that proposes simulation metrics from a chosen
entity list (plus optional causal text excerpt).

The Code page treats the returned metrics as a required step before code-gen
submission: the user reviews / edits / picks which ones the generated
simulation will actually track. Same one-shot ergonomics as
``/code_gen/group_entities`` — no job system, abortable from the client.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ...infra.gemini_client import GeminiGateway
from ...infra.io_utils import resolve_api_key
from ...infra.paths import DEFAULT_MODEL_NAME


router = APIRouter(tags=["suggest_metrics"])
logger = logging.getLogger(__name__)


MetricAggregation = Literal["sum", "mean", "max", "min", "count", "ratio"]
MetricViz = Literal["line", "bar", "histogram", "gauge", "stacked_area"]

MAX_CAUSAL_CHARS = 30_000


class EntityRef(BaseModel):
    name: str = Field(..., description="Canonical entity name from the workspace.")


class MetricSuggestionRequest(BaseModel):
    entities: list[EntityRef] = Field(
        ...,
        description="Entity names the user has selected; metrics must be computable from these.",
    )
    causalText: str | None = Field(
        default=None,
        description="Optional causal source excerpt for additional WHY context. Truncated server-side.",
    )
    model: str | None = Field(
        default=None,
        description="Optional Gemini model override; falls back to DEFAULT_MODEL_NAME.",
    )


class SuggestedMetric(BaseModel):
    name: str = Field(..., description="snake_case identifier safe to use as a Python attribute.")
    label: str = Field(..., description="Short human-readable display name.")
    unit: str = Field(default="", description="Unit of measurement, blank for dimensionless.")
    agg: MetricAggregation = Field(
        ..., description="Aggregation method applied across simulation ticks."
    )
    entities: list[str] = Field(
        default_factory=list,
        description="Subset of input entity names this metric depends on.",
    )
    viz: MetricViz = Field(..., description="Suggested chart type for visualizing this metric.")
    rationale: str = Field(
        default="",
        description="One-sentence explanation of why this metric matters for the domain.",
    )


class MetricSuggestionResponse(BaseModel):
    metrics: list[SuggestedMetric]


_PROMPT_TEMPLATE = """You are designing the measurement layer of a tick-based
agent simulation. The user has chosen the following entities for the
simulation; you must propose metrics that the generated simulation can
realistically compute and emit each tick or at the end of a run.

Entity names:
{entity_lines}

{causal_block}

Rules:
1. Every metric must be derivable from observable state of one or more of
   the listed entities. Do NOT propose metrics that require concepts not
   represented above.
2. Prefer metrics that surface bottlenecks, utilization, throughput,
   waiting / queue length, ratios, and equity / fairness across entity
   instances. Mix domain-specific (e.g. waste collected, kg) with
   universal (e.g. queue length, count) metrics.
3. Produce 5 to 10 metrics. Quality > quantity.
4. ``name`` must be snake_case Python identifier; ``label`` is the
   human-readable form.
5. ``agg`` is one of: sum, mean, max, min, count, ratio.
6. ``viz`` is one of: line, bar, histogram, gauge, stacked_area.
7. ``entities`` lists the input entity names this metric depends on; do
   not invent new names.
8. ``rationale`` is one sentence about why a domain reader cares.

Return ONLY a JSON object of this exact shape (no prose, no markdown, no
code fences):
{{
  "metrics": [
    {{
      "name": "snake_case_id",
      "label": "Display Name",
      "unit": "kg",
      "agg": "sum",
      "entities": ["truck", "bin"],
      "viz": "line",
      "rationale": "..."
    }}
  ]
}}
"""


def _format_causal_block(text: str | None) -> str:
    if not text or not text.strip():
        return ""
    cleaned = text.strip()
    if len(cleaned) > MAX_CAUSAL_CHARS:
        cleaned = cleaned[:MAX_CAUSAL_CHARS] + "\n…[truncated]"
    return f"Causal context (excerpt):\n{cleaned}\n"


@router.post(
    "/code_gen/suggest_metrics",
    response_model=MetricSuggestionResponse,
)
def suggest_metrics(payload: MetricSuggestionRequest) -> MetricSuggestionResponse:
    entity_names = [e.name.strip() for e in payload.entities if e.name.strip()]
    if not entity_names:
        raise HTTPException(
            status_code=400, detail="At least one entity is required."
        )

    api_key = resolve_api_key()
    if not api_key:
        raise HTTPException(
            status_code=500, detail="GEMINI_API_KEY is not configured."
        )

    model_name = (payload.model or "").strip() or DEFAULT_MODEL_NAME
    gateway = GeminiGateway(api_key=api_key, model_name=model_name)

    entity_lines = "\n".join(f"- {n}" for n in entity_names)
    prompt = _PROMPT_TEMPLATE.format(
        entity_lines=entity_lines,
        causal_block=_format_causal_block(payload.causalText),
    )

    try:
        parsed = gateway.generate_json(prompt)
    except Exception as exc:
        logger.exception("suggest-metrics Gemini call failed")
        raise HTTPException(
            status_code=502, detail=f"Gemini call failed: {exc}"
        ) from exc

    if not isinstance(parsed, dict):
        raise HTTPException(
            status_code=502, detail="Gemini did not return a JSON object."
        )

    raw_metrics = parsed.get("metrics")
    if not isinstance(raw_metrics, list):
        raise HTTPException(
            status_code=502, detail="Gemini response missing `metrics` array."
        )

    valid: list[SuggestedMetric] = []
    entity_set = {n.lower() for n in entity_names}
    for raw in raw_metrics:
        if not isinstance(raw, dict):
            continue
        try:
            metric = SuggestedMetric.model_validate(raw)
        except Exception:
            continue
        # Drop entity names the model invented out of thin air.
        metric_entities = [
            e for e in metric.entities if e.strip().lower() in entity_set
        ]
        metric.entities = metric_entities
        valid.append(metric)

    if not valid:
        raise HTTPException(
            status_code=502, detail="Gemini returned no usable metric suggestions."
        )

    return MetricSuggestionResponse(metrics=valid)
