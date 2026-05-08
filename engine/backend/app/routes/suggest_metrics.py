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
from ...infra.io_utils import is_auth_available, resolve_api_key
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

{environment_guidance}

Hard rules:
1. Every metric must be derivable from observable state / events of one
   or more of the listed entities. Do NOT propose metrics that require
   concepts not represented above.

2. ATTRIBUTE NAMING — IMPORTANT:
   Each metric must declare the entity attributes it reads in ``required_attrs``
   (entity + attr pairs). These are GUIDANCE NAMES representing the semantic concept
   (e.g., "waste_received_kg", "vehicle_capacity", "queue_length"), NOT the exact
   Python attribute name that will appear in code.

   The code generation pizpeline will ensure the generated entity classes expose
   numeric state attributes that match these concepts. If you cannot name a
   semantic concept for the required data, drop the metric.

   Good examples of attribute guidance:
   - "queue_length" (entities will expose a queue or count)
   - "current_load" (entities will track load/inventory state)
   - "total_capacity" (entities will have a capacity threshold)
   - "processing_rate" (entities will compute throughput)
   - "active_count" (environment will track entity lifecycles)

3. Prefer metrics that surface bottlenecks, utilization, throughput,
   waiting / queue length, ratios, and equity / fairness across entity
   instances. Mix domain-specific (e.g. waste_collected_kg) with
   universal (e.g. queue length, count).

4. Quality over quantity. Generate as many or as few metrics as are
   appropriate for these entities — do NOT artificially pad or limit.
   Focus on metrics that a domain expert would monitor to understand
   system behavior. If the entities naturally support 3 metrics, suggest
   3. If they support 12, suggest 12.

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
  pairs. Use CONCEPT-BASED SEMANTIC NAMES for attr (not implementation details).
  Examples:
    * "queue_length" (not "pending_jobs_buffer_list_size")
    * "total_processed" (not "completion_counter")
    * "current_utilization" (not "used_slots_v2")
    * "error_rate" (not "fail_pct_computed")
  The generated entity code will expose numeric state attributes matching
  these concepts. If you cannot think of a semantic concept, drop that attr.
- ``sampling_event`` is when the Reporter takes a sample. One of:
  "tick" (every simulation tick — use for time-series),
  "policy_fired" (when a policy rule executes),
  "entity_created" / "entity_destroyed" (lifecycle counts).
  Default to "tick" for almost all metrics.
- ``rationale`` is one sentence about why a domain reader cares — what
  behavior or system property does this metric reveal?

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
        {{"entity": "truck", "attr": "total_capacity"}}
      ],
      "sampling_event": "tick",
      "rationale": "Tracks utilization pressure; guides dispatch decisions and resource allocation."
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


def _format_environment_guidance(entity_names: list[str]) -> str:
    """Provide better guidance on what entity state typically looks like."""
    entity_list = ", ".join(entity_names[:5]) + (", ..." if len(entity_names) > 5 else "")
    return f"""Entity state context:

Generated entity classes will expose numeric state attributes. Examples of
common state patterns you can reference:

- Counters: total_processed, items_received, completed_tasks, failed_attempts
- Quantities: current_inventory, queue_length, active_count, available_capacity
- Measurements: current_load, temperature, efficiency_ratio, wait_time
- Rates: throughput_per_hour, utilization_rate, error_rate, completion_rate
- Lifecycle: created_at, destroyed_count, entity_lifetime

For the entities in this simulation ({entity_list}), propose metrics
that realistically track their behavior using concepts from these patterns."""


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

    if not is_auth_available():
        raise HTTPException(
            status_code=500, detail="No auth configured. Set GOOGLE_APPLICATION_CREDENTIALS or GEMINI_API_KEY."
        )
    api_key = resolve_api_key()

    model_name = (payload.model or "").strip() or DEFAULT_MODEL_NAME
    gateway = GeminiGateway(api_key=api_key, model_name=model_name)

    entity_lines = "\n".join(f"- {n}" for n in entity_names)
    prompt = _PROMPT_TEMPLATE.format(
        entity_lines=entity_lines,
        causal_block=_format_causal_block(payload.causalText),
        environment_guidance=_format_environment_guidance(entity_names),
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
