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
MetricGrounding = Literal["causal_explicit", "causal_implicit", "domain_inference"]
MetricSamplingEvent = Literal["tick", "policy_fired", "entity_created", "entity_destroyed"]

MAX_CAUSAL_CHARS = 30_000


class EntityRef(BaseModel):
    name: str = Field(..., description="Canonical entity name from the workspace.")


class MetricAttrDependency(BaseModel):
    entity: str = Field(..., description="Entity name the attribute belongs to.")
    attr: str = Field(..., description="Attribute / property name to read for sampling.")


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
    chart_group: str | None = Field(
        default=None,
        description="Optional shared key — metrics with the same chart_group render on one combined panel (overlay / dual-axis).",
    )
    grounding: MetricGrounding = Field(
        default="domain_inference",
        description=(
            "How the metric was justified: causal_explicit (named in causal text), "
            "causal_implicit (relations imply it), domain_inference (LLM filled the gap)."
        ),
    )
    required_attrs: list[MetricAttrDependency] = Field(
        default_factory=list,
        description="Entity attributes the Reporter must sample to compute this metric.",
    )
    sampling_event: MetricSamplingEvent = Field(
        default="tick",
        description="Sim event that triggers a sample.",
    )
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

Hard rules:
1. Every metric must be derivable from observable state / events of one
   or more of the listed entities. Do NOT propose metrics that require
   concepts not represented above.
2. Each metric must declare the concrete entity attributes it samples in
   ``required_attrs`` (entity + attr pairs). The Reporter the codegen
   pipeline emits will read exactly these. If you can't name attributes
   that almost certainly exist on a normal implementation of the entity,
   drop the metric.
3. Prefer metrics that surface bottlenecks, utilization, throughput,
   waiting / queue length, ratios, and equity / fairness across entity
   instances. Mix domain-specific (e.g. waste_collected_kg) with
   universal (e.g. queue length, count).
4. Produce 5 to 10 metrics. Quality > quantity.

Field rules:
- ``name`` must be a snake_case Python identifier; ``label`` is the
  human-readable form.
- ``unit`` is the unit string (kg, items, %, ratio, ...). Empty for
  dimensionless ratios.
- ``agg`` is one of: sum, mean, max, min, count, ratio.
- ``viz`` is one of: line, bar, histogram, gauge, stacked_area.
  THINK ABOUT THE CHART FIRST: pick a viz the metric will actually look
  meaningful in. If two metrics are best understood together, give them
  the same ``chart_group`` so the in-engine viewer overlays them on one
  panel.
- ``grounding`` MUST reflect honesty:
    * "causal_explicit"  — the metric is named or directly described in
                            the causal text excerpt.
    * "causal_implicit"  — the causal relations imply it (e.g. "trucks
                            fill up" implies a fill-rate metric).
    * "domain_inference" — domain knowledge you are contributing because
                            the causal text didn't make it explicit.
  Don't lie about grounding — domain_inference is fine, just label it.
- ``entities`` lists which input entity names this metric reads from;
  do not invent new names.
- ``required_attrs`` is a list of {{"entity": "<name>", "attr": "<attr>"}}
  pairs naming the attributes the Reporter samples. Use realistic
  attribute names like ``capacity``, ``current_load``, ``status``,
  ``queue_length`` — the entity-code stage will be told to expose them.
- ``sampling_event`` is when the Reporter takes a sample. One of:
  "tick" (every simulation tick — use for time-series),
  "policy_fired" (when a policy rule executes),
  "entity_created" / "entity_destroyed" (lifecycle counts).
  Default to "tick" for almost all metrics.
- ``rationale`` is one sentence about why a domain reader cares.

Return ONLY a JSON object of this exact shape (no prose, no markdown, no
code fences):
{{
  "metrics": [
    {{
      "name": "snake_case_id",
      "label": "Display Name",
      "unit": "kg",
      "agg": "sum",
      "viz": "line",
      "chart_group": "capacity_pressure",
      "grounding": "causal_implicit",
      "entities": ["truck", "bin"],
      "required_attrs": [
        {{"entity": "truck", "attr": "current_load"}},
        {{"entity": "truck", "attr": "capacity"}}
      ],
      "sampling_event": "tick",
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
        # Same treatment for required_attrs — the Reporter can only sample
        # attributes that belong to entities the user selected.
        metric.required_attrs = [
            dep for dep in metric.required_attrs if dep.entity.strip().lower() in entity_set
        ]
        # A metric without any grounded attribute can't be measured — drop it
        # rather than letting the Reporter generate broken sampling code later.
        if metric.sampling_event == "tick" and not metric.required_attrs:
            continue
        valid.append(metric)

    if not valid:
        raise HTTPException(
            status_code=502, detail="Gemini returned no usable metric suggestions."
        )

    return MetricSuggestionResponse(metrics=valid)
