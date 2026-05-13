"""Driver for the code-generation background pipeline.

Phase 2: Stage 1 family (state1_entity_list, state1b_policy_outline,
state1c_entity_dependencies) is wired with real Gemini calls. Stages 2 / 3 /
4 / validation / finalize remain stubs and are replaced in Phase 3.

The driver mirrors ``map_extract_runner`` in event semantics so the existing
status / SSE infrastructure can be reused without modification.
"""

from __future__ import annotations

import difflib
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Callable

from ...infra.gemini_client import GeminiCancelledError, GeminiGateway
from ..models.job_models import JobRecord
from ..services import code_gen_checkpoints as checkpoints
from ..services import code_gen_prompts as prompts
from ..services.job_store import (
    JOBS_LOCK,
    JobCancelledError,
    emit_job_event,
    is_cancel_requested,
    touch_activity,
    utc_now_iso,
)

logger = logging.getLogger(__name__)


def _append_interaction_log(
    job_id: str,
    stage: str,
    prompt: str,
    response: str,
    usage_snapshot: dict[str, int],
    *,
    iter_id: str | None = None,
) -> None:
    """Append one prompt/response record to <job_dir>/interaction_log.jsonl."""
    try:
        log_path = checkpoints.job_dir(job_id) / "interaction_log.jsonl"
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "stage": stage,
            "iter_id": iter_id,
            "prompt_chars": len(prompt),
            "response_chars": len(response),
            "prompt": prompt,
            "response": response,
            "usage": dict(usage_snapshot),
        }
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as exc:
        logger.warning("[code_gen][interaction_log] write failed jobId=%s stage=%s error=%s", job_id, stage, exc)


StageFn = Callable[["StageContext"], dict[str, Any]]


class StageContext:
    """Per-stage handle passed to stage implementations.

    Provides everything a stage needs without coupling it to ``JobRecord``
    internals: previous-stage outputs, inputs manifest, cancel check, and
    iteration helpers for iterative stages.
    """

    def __init__(
        self,
        job: JobRecord,
        api_key: str | None,
        model_name: str,
        use_env_model_overrides: bool,
        inputs: dict[str, Any],
    ) -> None:
        self.job = job
        self.api_key = api_key
        self.model_name = model_name
        self.use_env_model_overrides = use_env_model_overrides
        self.inputs = inputs
        self.usage: dict[str, int] = {}

    @property
    def job_id(self) -> str:
        return self.job.job_id

    def stage_payload(self, stage: str) -> dict[str, Any] | None:
        return checkpoints.load_stage(self.job_id, stage)

    def is_cancelled(self) -> bool:
        return is_cancel_requested(self.job_id)

    def raise_if_cancelled(self) -> None:
        if self.is_cancelled():
            raise JobCancelledError("cancel requested")

    def emit_stage_message(
        self,
        stage: str,
        message: str,
        *,
        token_usage: dict[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {"stage": stage, "message": message}
        if token_usage is not None:
            payload["tokenUsage"] = token_usage
        emit_job_event(self.job, "stage", payload)

    def gateway(self) -> GeminiGateway:
        return GeminiGateway(api_key=self.api_key, model_name=self.model_name)


def _gemini_retry_callback(ctx: StageContext, stage: str):
    def _emit(info: dict[str, Any]) -> None:
        attempt = info.get("attempt")
        max_attempts = info.get("maxAttempts")
        delay = info.get("delaySeconds")
        err_class = info.get("errorClass") or "Error"
        err_text = str(info.get("error") or "")[:160]
        msg = (
            f"{stage}: Gemini transient error — retrying attempt "
            f"{attempt}/{max_attempts} in {delay}s ({err_class}: {err_text})"
        )
        ctx.emit_stage_message(stage, msg)
        touch_activity(ctx.job)

    return _emit


def _gemini_cancel_check(ctx: StageContext):
    return lambda: is_cancel_requested(ctx.job_id)


def _gemini_progress_callback(ctx: StageContext):
    return lambda: touch_activity(ctx.job)


def _generate_json(
    ctx: StageContext,
    stage: str,
    prompt: str,
    schema: dict[str, Any] | None = None,
    *,
    iter_id: str | None = None,
) -> Any:
    """Run a JSON-schema-constrained Gemini call with cancel + retry surfacing."""
    gateway = ctx.gateway()
    try:
        raw = gateway.generate_text(
            prompt,
            response_json=True,
            response_schema=schema,
            usage_collector=ctx.usage,
            on_retry=_gemini_retry_callback(ctx, stage),
            cancel_check=_gemini_cancel_check(ctx),
            on_progress=_gemini_progress_callback(ctx),
        )
    except GeminiCancelledError as exc:
        raise JobCancelledError(str(exc)) from exc
    _append_interaction_log(ctx.job_id, stage, prompt, raw or "", dict(ctx.usage), iter_id=iter_id)
    return GeminiGateway.parse_json_relaxed(raw)


def _generate_text(
    ctx: StageContext,
    stage: str,
    prompt: str,
    *,
    cached_content: str | None = None,
    iter_id: str | None = None,
) -> str:
    """Run a free-form Gemini call returning raw text (for code generation)."""
    gateway = ctx.gateway()
    try:
        raw = gateway.generate_text(
            prompt,
            response_json=False,
            usage_collector=ctx.usage,
            on_retry=_gemini_retry_callback(ctx, stage),
            cancel_check=_gemini_cancel_check(ctx),
            on_progress=_gemini_progress_callback(ctx),
            cached_content=cached_content,
        )
    except GeminiCancelledError as exc:
        raise JobCancelledError(str(exc)) from exc
    _append_interaction_log(ctx.job_id, stage, prompt, raw or "", dict(ctx.usage), iter_id=iter_id)
    return prompts.strip_code_fences(raw)


def _resume_skip_completed(job: JobRecord) -> set[str]:
    """Return the set of stages already completed on disk.

    On cold restart ``JobRecord.completed_stages`` is empty, so we trust the
    checkpoint files. Stage-N is considered complete only if its summary file
    exists (per-iteration files alone are NOT enough — see docstring on
    ``code_gen_checkpoints.ITERATIVE_STAGES``).

    Also infers which confirmation gates were already acknowledged: if a gate
    stage is complete *and* a later stage also has a checkpoint on disk, the
    gate must have been confirmed before the crash/import (downstream stages
    cannot run without it).  This prevents re-engaging gates after a restart
    or when resuming an imported workspace.
    """
    completed: set[str] = set()
    stage_list = list(checkpoints.STAGE_ORDER)
    for stage in stage_list:
        if checkpoints.load_stage(job.job_id, stage) is not None:
            completed.add(stage)
    completed.update(job.completed_stages or [])

    confirmed = set(job.confirmed_stages or [])
    for i, stage in enumerate(stage_list):
        if stage not in POST_RUN_CONFIRMATION_GATES:
            continue
        if stage not in completed or stage in confirmed:
            continue
        # Any later checkpoint means this gate was already passed.
        if any(stage_list[j] in completed for j in range(i + 1, len(stage_list))):
            confirmed.add(stage)
    job.confirmed_stages = list(confirmed)

    return completed


# Stages that require explicit user confirmation AFTER they complete (before pipeline advances).
POST_RUN_CONFIRMATION_GATES: frozenset[str] = frozenset({"state1b_policy_outline", "state1d_metrics_draft"})


def _wait_for_confirmation(ctx: "StageContext", stage: str) -> None:
    """Block worker until user confirms the gate stage, honouring cancel."""
    job = ctx.job
    # Set awaiting state under lock so serializer surfaces it immediately.
    with JOBS_LOCK:
        job.awaiting_confirmation_stage = stage
        job.status = "awaiting_confirmation"
        job.updated_at = utc_now_iso()
    logger.info("[code_gen] awaiting confirmation jobId=%s stage=%s", job.job_id, stage)
    ctx.emit_stage_message(stage, f"{stage}: awaiting user confirmation")
    # Reset event so we don't skip past it if it was set previously.
    job.confirm_event.clear()
    while True:
        # Wait 0.5s at a time so cancel can interrupt the gate.
        job.confirm_event.wait(timeout=0.5)
        ctx.raise_if_cancelled()
        if stage in job.confirmed_stages:
            break
    logger.info("[code_gen] confirmation received jobId=%s stage=%s", job.job_id, stage)


# ---------------------------------------------------------------------------
# Stage 1 family — real implementations (Phase 2)
# ---------------------------------------------------------------------------


_TRANSLATE_IDS_PROMPT = """You are given a list of entity labels that may contain non-ASCII text (e.g. Thai).
For each label, return an ASCII English snake_case identifier that best represents the concept.
Translate non-ASCII labels to English. For already-ASCII labels, just normalise to snake_case.

Input labels (JSON array of strings):
{labels_json}

Return ONLY a JSON object mapping each input label to its English snake_case id:
{{"<original label>": "<english_snake_case_id>", ...}}

Examples:
- "ขยะ" -> "waste"
- "รถขยะ" -> "garbage_truck"
- "คนขับรถ" -> "driver"
- "waste separation" -> "waste_separation"
"""

def _needs_translation(label: str) -> bool:
    return bool(re.search(r'[^\x00-\x7F]', label))


def _translate_entity_ids(
    ctx: StageContext,
    labels: list[str],
) -> dict[str, str]:
    """Call Gemini once to get English snake_case ids for any non-ASCII labels."""
    non_ascii = [l for l in labels if _needs_translation(l)]
    if not non_ascii:
        return {}
    prompt = _TRANSLATE_IDS_PROMPT.format(labels_json=json.dumps(non_ascii, ensure_ascii=False))
    ctx.emit_stage_message("state1_entity_list", f"Translating {len(non_ascii)} non-ASCII entity label(s) to English ids…")
    try:
        result = _generate_json(ctx, "state1_translate_ids", prompt, None)
    except Exception as exc:
        logger.warning("[code_gen][state1] translation call failed: %s — falling back to slugs", exc)
        return {}
    if not isinstance(result, dict):
        return {}
    out: dict[str, str] = {}
    for label, eng_id in result.items():
        if not isinstance(eng_id, str):
            continue
        slug = eng_id.strip().lower()
        slug = re.sub(r'[^a-z0-9]+', '_', slug).strip('_')
        if slug:
            out[label] = slug
    return out


def _stage_state1_entity_list(ctx: StageContext) -> dict[str, Any]:
    ctx.raise_if_cancelled()
    user_list = list(ctx.inputs.get("userEntityList") or [])
    if user_list:
        # User-curated list is source of truth — skip Gemini extraction.
        # Non-ASCII labels (e.g. Thai) need their ids translated to English.
        raw_labels = [str(entry.get("label") or entry.get("id") or "") for entry in user_list if isinstance(entry, dict)]
        translations = _translate_entity_ids(ctx, raw_labels)

        cleaned: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for entry in user_list:
            if not isinstance(entry, dict):
                continue
            label = str(entry.get("label") or "").strip()
            # Use Gemini-translated id for non-ASCII labels; fall back to original id.
            if label and _needs_translation(label) and label in translations:
                eid = translations[label]
            else:
                eid = str(entry.get("id") or "").strip()
            if not eid or eid in seen_ids:
                continue
            seen_ids.add(eid)
            cleaned.append(
                {
                    "id": eid,
                    "label": label or eid,
                    "type": str(entry.get("type") or "actor"),
                    "frequency": int(entry.get("frequency") or 0),
                }
            )
        logger.info(
            "[code_gen][state1] using user entity list (%d entities), skipping Gemini extraction",
            len(cleaned),
        )
        return {"stage": "state1_entity_list", "entities": cleaned}
    causal_data = str(ctx.inputs.get("causalData") or "")
    prompt, schema = prompts.build_state1_entity_list_prompt(causal_data)
    parsed = _generate_json(ctx, "state1_entity_list", prompt, schema)
    if not isinstance(parsed, dict):
        parsed = {"entities": []}
    entities = parsed.get("entities") or []
    if not isinstance(entities, list):
        entities = []
    cleaned2: list[dict[str, Any]] = []
    seen_ids2: set[str] = set()
    for entry in entities:
        if not isinstance(entry, dict):
            continue
        eid = str(entry.get("id") or "").strip()
        if not eid or eid in seen_ids2:
            continue
        seen_ids2.add(eid)
        cleaned2.append(
            {
                "id": eid,
                "label": str(entry.get("label") or eid),
                "type": str(entry.get("type") or "actor"),
                "frequency": int(entry.get("frequency") or 0),
            }
        )
    return {
        "stage": "state1_entity_list",
        "entities": cleaned2,
        "warning": parsed.get("warning"),
    }


def _filter_causal_sp(causal_data: str) -> str:
    """Remove classes with sentence_type == 'SP' (suggested policy) from causal JSON string."""
    raw = causal_data.strip()
    comment = ""
    if raw.startswith("#"):
        nl = raw.find("\n")
        if nl != -1:
            comment = raw[: nl + 1]
            raw = raw[nl + 1 :]
    try:
        chunks = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return causal_data
    if not isinstance(chunks, list):
        return causal_data
    for chunk in chunks:
        if isinstance(chunk, dict) and isinstance(chunk.get("classes"), list):
            chunk["classes"] = [
                c for c in chunk["classes"]
                if not (isinstance(c, dict) and c.get("sentence_type") == "SP")
            ]
    return comment + json.dumps(chunks, ensure_ascii=False)


def _stage_state1b_policy_outline(ctx: StageContext) -> dict[str, Any]:
    ctx.raise_if_cancelled()
    state1 = ctx.stage_payload("state1_entity_list") or {}
    entities = state1.get("entities") or []
    causal_data = _filter_causal_sp(str(ctx.inputs.get("causalData") or ""))
    prompt, schema = prompts.build_state1b_policy_outline_prompt(causal_data, entities)
    parsed = _generate_json(ctx, "state1b_policy_outline", prompt, schema)
    if not isinstance(parsed, dict):
        parsed = {"policies": []}
    policies = parsed.get("policies") or []
    if not isinstance(policies, list):
        policies = []
    valid_ids = {str(e.get("id") or "") for e in entities if isinstance(e, dict)}
    valid_ids.add("environment")
    valid_ids_list = sorted(valid_ids)
    cleaned: list[dict[str, Any]] = []
    seen_rule_ids: set[str] = set()
    for entry in policies:
        if not isinstance(entry, dict):
            continue
        rule_id = str(entry.get("rule_id") or "").strip()
        target = str(entry.get("target_entity_id") or "").strip()
        method = str(entry.get("target_method") or "").strip()
        if not rule_id or not target or not method or rule_id in seen_rule_ids:
            continue
        if target not in valid_ids:
            closest = difflib.get_close_matches(target, valid_ids_list, n=1, cutoff=0.5)
            if closest:
                logger.warning(
                    "[code_gen][state1b] rule %r: target_entity_id %r not in entity list — corrected to %r",
                    rule_id,
                    target,
                    closest[0],
                )
                target = closest[0]
            else:
                logger.warning(
                    "[code_gen][state1b] dropping rule %r: target_entity_id %r not in entity list and no close match",
                    rule_id,
                    target,
                )
                continue
        seen_rule_ids.add(rule_id)
        cleaned.append(
            {
                "rule_id": rule_id,
                "label": str(entry.get("label") or rule_id),
                "trigger": str(entry.get("trigger") or "").strip(),
                "target_entity_id": target,
                "target_method": method,
                "inputs": [str(x) for x in (entry.get("inputs") or []) if isinstance(x, str)],
                "description": str(entry.get("description") or "").strip(),
            }
        )
    return {"stage": "state1b_policy_outline", "policies": cleaned}


def _stage_state1c_entity_dependencies(ctx: StageContext) -> dict[str, Any]:
    ctx.raise_if_cancelled()
    state1 = ctx.stage_payload("state1_entity_list") or {}
    entities = state1.get("entities") or []
    state1b = ctx.stage_payload("state1b_policy_outline") or {}
    policies = state1b.get("policies") or []
    causal_data = str(ctx.inputs.get("causalData") or "")
    prompt, schema = prompts.build_state1c_entity_dependencies_prompt(
        causal_data, entities, policies
    )
    parsed = _generate_json(ctx, "state1c_entity_dependencies", prompt, schema)
    if not isinstance(parsed, dict):
        parsed = {"edges": []}
    edges = parsed.get("edges") or []
    if not isinstance(edges, list):
        edges = []
    valid_ids = {str(e.get("id") or "") for e in entities if isinstance(e, dict)}
    cleaned: list[dict[str, Any]] = []
    for entry in edges:
        if not isinstance(entry, dict):
            continue
        a = str(entry.get("from") or "").strip()
        b = str(entry.get("to") or "").strip()
        if not a or not b or a == b:
            continue
        if a not in valid_ids or b not in valid_ids:
            continue
        cleaned.append({"from": a, "to": b, "reason": str(entry.get("reason") or "")})
    order = prompts.topological_order(entities, cleaned)
    return {
        "stage": "state1c_entity_dependencies",
        "edges": cleaned,
        "order": order,
    }


def _stage_state1d_metrics_draft(ctx: StageContext) -> dict[str, Any]:
    ctx.raise_if_cancelled()
    state1 = ctx.stage_payload("state1_entity_list") or {}
    entities = state1.get("entities") or []
    state1b = ctx.stage_payload("state1b_policy_outline") or {}
    policy_outline = state1b.get("policies") or []
    state1c = ctx.stage_payload("state1c_entity_dependencies") or {}
    dependency_edges = state1c.get("edges") or []

    prompt, schema = prompts.build_state1d_metrics_draft_prompt(
        entities=entities,
        policy_outline=policy_outline,
        dependency_edges=dependency_edges,
    )
    parsed = _generate_json(ctx, "state1d_metrics_draft", prompt, schema)
    if not isinstance(parsed, dict):
        parsed = {"metrics": []}
    metrics = parsed.get("metrics") or []
    if not isinstance(metrics, list):
        metrics = []
    valid_ids = {str(e.get("id") or "") for e in entities if isinstance(e, dict)}
    cleaned: list[dict[str, Any]] = []
    for m in metrics:
        if not isinstance(m, dict):
            continue
        name = str(m.get("name") or "").strip()
        if not name:
            continue
        entity_id = str(m.get("entity_id") or "").strip()
        if entity_id and entity_id not in valid_ids:
            logger.warning(
                "[code_gen][state1d] dropping metric %r: entity_id %r not in entity list",
                name,
                entity_id,
            )
            continue
        cleaned.append({
            "name": name,
            "label": str(m.get("label") or name),
            "unit": str(m.get("unit") or ""),
            "agg": str(m.get("agg") or "sum"),
            "viz": str(m.get("viz") or "line"),
            "chart_group": m.get("chart_group"),
            "grounding": str(m.get("grounding") or "domain_inference"),
            "entities": [str(e) for e in (m.get("entities") or []) if isinstance(e, str)],
            "entity_id": entity_id,
            "expected_variable": str(m.get("expected_variable") or ""),
            "chart_type": str(m.get("chart_type") or m.get("viz") or "line"),
            "how_to_interpret": str(m.get("how_to_interpret") or ""),
            "required_attrs": [
                dep for dep in (m.get("required_attrs") or [])
                if isinstance(dep, dict) and dep.get("entity") and dep.get("attr")
            ],
            "sampling_event": str(m.get("sampling_event") or "tick"),
            "rationale": str(m.get("rationale") or ""),
        })
    return {"stage": "state1d_metrics_draft", "metrics": cleaned, "metricCount": len(cleaned)}


# ---------------------------------------------------------------------------
# Stage 2 / 3 / 4 / validation / finalize (Phase 3)
# ---------------------------------------------------------------------------


def _required_methods_for_entity(
    entity_id: str,
    policy_outline: list[dict[str, Any]],
) -> list[str]:
    methods = [
        str(p.get("target_method") or "").strip()
        for p in (policy_outline or [])
        if p.get("target_entity_id") == entity_id
    ]
    return [m for m in methods if m]


def _selected_entity_filter(ctx: StageContext) -> set[str]:
    """If the user picked specific entities client-side, restrict generation to those.

    Empty selection → generate all from State 1.
    """
    selected = ctx.inputs.get("selectedEntities") or []
    out: set[str] = set()
    for entry in selected:
        if isinstance(entry, dict) and entry.get("id"):
            out.add(str(entry["id"]))
        elif isinstance(entry, str):
            out.add(entry)
    return out


def _stage_state2_code_entity_object(ctx: StageContext) -> dict[str, Any]:
    ctx.raise_if_cancelled()
    state1 = ctx.stage_payload("state1_entity_list") or {}
    entities: list[dict[str, Any]] = list(state1.get("entities") or [])
    entity_by_id = {str(e.get("id") or ""): e for e in entities if isinstance(e, dict)}

    state1b = ctx.stage_payload("state1b_policy_outline") or {}
    policy_outline = list(state1b.get("policies") or [])

    state1c = ctx.stage_payload("state1c_entity_dependencies") or {}
    order = list(state1c.get("order") or list(entity_by_id.keys()))

    user_filter = _selected_entity_filter(ctx)
    if user_filter:
        # selectedEntities uses pre-translation IDs; remap to state1 translated IDs via label.
        label_to_new_id: dict[str, str] = {
            str(e.get("label") or ""): str(e.get("id") or "")
            for e in entities if isinstance(e, dict) and e.get("label") and e.get("id")
        }
        user_list_raw = list(ctx.inputs.get("userEntityList") or [])
        old_to_new: dict[str, str] = {}
        for entry in user_list_raw:
            if not isinstance(entry, dict):
                continue
            old_id = str(entry.get("id") or "").strip()
            label = str(entry.get("label") or "").strip()
            new_id = label_to_new_id.get(label, "")
            if old_id and new_id and old_id != new_id:
                old_to_new[old_id] = new_id
        if old_to_new:
            user_filter = {old_to_new.get(eid, eid) for eid in user_filter}
        order = [eid for eid in order if eid in user_filter]

    causal_data = str(ctx.inputs.get("causalData") or "")

    # Read confirmed metrics from state1d checkpoint (Section 8)
    state1d = ctx.stage_payload("state1d_metrics_draft") or {}
    selected_metrics = list(state1d.get("metrics") or [])

    iteration_summaries: list[dict[str, Any]] = []
    accumulator_files: list[tuple[str, str]] = []

    # Caching: build a context cache once with the bits that don't change
    # across iterations (causal data, policy snippets, entity time protocol).
    # Each iteration then sends only the variable parts inline. Gracefully
    # falls back to inline behavior when the cache create fails (e.g. content
    # too small for explicit caching, quota issues, network blip).
    cache_threshold = int(os.getenv("CODE_GEN_CACHE_MIN_ENTITIES", "5") or "5")
    cache_ttl_seconds = int(os.getenv("CODE_GEN_CACHE_TTL_SECONDS", "1800") or "1800")
    cache_name: str | None = None
    if len(order) >= cache_threshold:
        try:
            cache_name = ctx.gateway().create_cache(
                text_parts=prompts.build_state2_cached_context(causal_data=causal_data),
                ttl_seconds=cache_ttl_seconds,
            )
        except Exception:
            cache_name = None
        ctx.emit_stage_message(
            "state2_code_entity_object",
            (
                f"state2: cache enabled (entities={len(order)}, ttl={cache_ttl_seconds}s)"
                if cache_name
                else f"state2: cache disabled (create failed or content too small) entities={len(order)}"
            ),
        )

    for index, entity_id in enumerate(order):
        ctx.raise_if_cancelled()
        entity_obj = entity_by_id.get(entity_id) or {"id": entity_id}

        existing = checkpoints.load_iteration(ctx.job_id, "state2_code_entity_object", entity_id)
        if existing and isinstance(existing, dict) and existing.get("code"):
            ctx.emit_stage_message(
                "state2_code_entity_object",
                f"state2: skip {entity_id} (already generated)",
            )
            iteration_summaries.append(
                {
                    "iterId": entity_id,
                    "filename": existing.get("filename") or f"{entity_id}.py",
                    "validation": existing.get("validation") or {"errors": []},
                }
            )
            accumulator_files.append((existing.get("filename") or f"{entity_id}.py", existing.get("code") or ""))
            continue

        ctx.emit_stage_message(
            "state2_code_entity_object",
            f"state2: generating {entity_id} ({index + 1}/{len(order)})",
        )

        accumulator_blob = prompts.concat_with_delimiters(accumulator_files)
        digest_collected: dict[str, Any] = {"classes": []}
        for _, prior_code in accumulator_files:
            digest_collected["classes"].extend(
                prompts.interface_digest_from_source(prior_code).get("classes") or []
            )

        retry_error: str | None = None
        code = ""
        validation_errors: list[str] = []
        for attempt in range(2):  # one initial + one retry
            prompt = prompts.build_state2_entity_prompt(
                causal_data=causal_data,
                entity_id=entity_id,
                entity_obj=entity_obj,
                accumulator_blob=accumulator_blob,
                interface_digest=digest_collected,
                policy_outline=policy_outline,
                selected_metrics=selected_metrics,
                retry_error=retry_error,
                omit_cached_context=cache_name is not None,
            )
            code = _generate_text(
                ctx,
                "state2_code_entity_object",
                prompt,
                cached_content=cache_name,
                iter_id=entity_id,
            )
            validation_errors = prompts.validate_entity_protocol(
                code,
                required_methods=_required_methods_for_entity(entity_id, policy_outline),
            )
            if not validation_errors:
                break
            retry_error = "; ".join(validation_errors)
            ctx.emit_stage_message(
                "state2_code_entity_object",
                f"state2: {entity_id} validation failed (attempt {attempt + 1}/2): {retry_error}",
            )

        filename = f"{entity_id}.py"
        payload = {
            "entityId": entity_id,
            "filename": filename,
            "code": code,
            "validation": {"errors": validation_errors},
        }
        checkpoints.save_iteration(ctx.job_id, "state2_code_entity_object", entity_id, payload)
        # Write .py file immediately so artifacts are available before finalize.
        try:
            entities_dir = checkpoints.artifact_root(ctx.job_id) / "entities"
            entities_dir.mkdir(parents=True, exist_ok=True)
            (entities_dir / filename).write_text(code or "", encoding="utf-8")
        except Exception as _exc:
            logger.warning("[code_gen][state2] failed to write early artifact %s: %s", filename, _exc)
        iteration_summaries.append(
            {"iterId": entity_id, "filename": filename, "validation": payload["validation"]}
        )
        accumulator_files.append((filename, code))
        touch_activity(ctx.job)

    if cache_name:
        try:
            ctx.gateway().delete_cache(cache_name)
        except Exception:
            pass

    return {
        "stage": "state2_code_entity_object",
        "iterations": iteration_summaries,
        "iterationCount": len(iteration_summaries),
        "cacheUsed": bool(cache_name),
    }


def _stage_state2j_entity_judge(ctx: StageContext) -> dict[str, Any]:
    """LLM-as-Judge: review each entity, fix via state2 retry, loop up to maxVerifyAttempts."""
    ctx.raise_if_cancelled()

    iterations = checkpoints.list_iterations(ctx.job_id, "state2_code_entity_object")
    if not iterations:
        return {"stage": "state2j_entity_judge", "skipped": True, "reason": "no state2 iterations"}

    state1 = ctx.stage_payload("state1_entity_list") or {}
    entity_list: list[dict] = state1.get("entities") or []
    entity_map = {str(e.get("id") or ""): e for e in entity_list if isinstance(e, dict)}

    state1b = ctx.stage_payload("state1b_policy_outline") or {}
    policy_outline: list[dict] = state1b.get("policies") or []

    selected_metrics: list[dict] = list(ctx.inputs.get("selectedMetrics") or [])

    base_class_src = Path(
        Path(__file__).resolve().parents[1] / "services" / "templates" / "entity_object_template.py"
    ).read_text(encoding="utf-8")

    max_attempts = int(ctx.inputs.get("maxVerifyAttempts", 3))
    results: list[dict] = []
    total = len(iterations)

    for index, entry in enumerate(iterations):
        ctx.raise_if_cancelled()
        entity_id = str(entry["iterId"])

        existing_judge = checkpoints.load_iteration(ctx.job_id, "state2j_entity_judge", entity_id)
        if existing_judge and isinstance(existing_judge, dict) and "passed" in existing_judge:
            ctx.emit_stage_message(
                "state2j_entity_judge",
                f"state2j: skip {entity_id} (already judged)",
            )
            results.append(existing_judge)
            continue

        payload = checkpoints.load_iteration(ctx.job_id, "state2_code_entity_object", entity_id)
        if not isinstance(payload, dict) or not payload.get("code"):
            skip_record: dict[str, Any] = {"entity_id": entity_id, "skipped": True}
            checkpoints.save_iteration(ctx.job_id, "state2j_entity_judge", entity_id, skip_record)
            results.append(skip_record)
            continue

        current_code = str(payload["code"])
        entity_obj = entity_map.get(entity_id, {"id": entity_id})
        attempts: list[dict] = []
        passed = True

        ctx.emit_stage_message("state2j_entity_judge", f"state2j: judging {entity_id} ({index + 1}/{total})")

        for attempt_num in range(max_attempts):
            ctx.raise_if_cancelled()
            judge_prompt = prompts.build_entity_judge_prompt(
                entity_id=entity_id,
                entity_obj=entity_obj,
                entity_code=current_code,
                policy_outline=policy_outline,
                selected_metrics=selected_metrics,
                base_class_src=base_class_src,
            )
            judge_result = _generate_json(
                ctx, "state2j_entity_judge", judge_prompt, prompts.JUDGE_PASS1_SCHEMA,
                iter_id=f"{entity_id}_attempt{attempt_num + 1}",
            )
            issues = []
            if isinstance(judge_result, dict):
                issues = [i for i in (judge_result.get("issues") or []) if isinstance(i, dict)]

            attempt_record: dict = {"attempt": attempt_num + 1, "issues": issues}

            if not issues:
                attempt_record["status"] = "pass"
                attempts.append(attempt_record)
                break

            if attempt_num < max_attempts - 1:
                regen_prompt = prompts.build_entity_judge_fix_prompt(
                    entity_code=current_code,
                    issues=issues,
                    base_class_src=base_class_src,
                )
                fixed_code = _generate_text(
                    ctx, "state2j_entity_judge", regen_prompt,
                    iter_id=f"{entity_id}_fix{attempt_num + 1}",
                )
                if fixed_code.strip():
                    current_code = fixed_code
                    attempt_record["status"] = "fixed_and_retry"
                else:
                    attempt_record["status"] = "fix_failed"
                    passed = False
                    attempts.append(attempt_record)
                    break
            else:
                attempt_record["status"] = "fail"
                passed = False

            attempts.append(attempt_record)

        code_changed = current_code != str(payload.get("code", ""))
        if code_changed:
            updated_payload = dict(payload)
            updated_payload["code"] = current_code
            checkpoints.save_iteration(ctx.job_id, "state2_code_entity_object", entity_id, updated_payload)

        judge_record: dict[str, Any] = {
            "entity_id": entity_id,
            "passed": passed,
            "attempts": attempts,
            "codeChanged": code_changed,
        }
        checkpoints.save_iteration(ctx.job_id, "state2j_entity_judge", entity_id, judge_record)
        results.append({"entity_id": entity_id, "passed": passed, "attempts": attempts})

    passed_count = sum(1 for r in results if r.get("passed"))
    failed_count = sum(1 for r in results if not r.get("passed") and not r.get("skipped"))
    return {
        "stage": "state2j_entity_judge",
        "entityCount": len(results),
        "passedCount": passed_count,
        "failedCount": failed_count,
        "results": results,
    }


def _stage_state2v_validate_protocol(ctx: StageContext) -> dict[str, Any]:
    ctx.raise_if_cancelled()
    iterations = checkpoints.list_iterations(ctx.job_id, "state2_code_entity_object")
    failures: list[dict[str, Any]] = []
    for entry in iterations:
        payload = checkpoints.load_iteration(
            ctx.job_id, "state2_code_entity_object", entry["iterId"]
        )
        if not isinstance(payload, dict):
            failures.append({"iterId": entry["iterId"], "errors": ["payload missing"]})
            continue
        errors = list((payload.get("validation") or {}).get("errors") or [])
        if errors:
            failures.append({"iterId": entry["iterId"], "errors": errors})
    if failures:
        msg = "; ".join(f"{f['iterId']}: {', '.join(f['errors'])}" for f in failures)
        raise RuntimeError(f"state2 validation failed: {msg}")
    return {"stage": "state2v_validate_protocol", "iterations": len(iterations), "failures": []}


def _build_map_artifact(map_graph: dict[str, Any] | None) -> dict[str, Any]:
    """Normalize map_graph into map.json format with pre-computed neighbors."""
    if not isinstance(map_graph, dict):
        return {"nodes": [], "edges": []}
    vertices = map_graph.get("vertices") or map_graph.get("nodes") or []
    edges = map_graph.get("edges") or []
    # Build adjacency from edges
    adjacency: dict[str, list[str]] = {}
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        src = str(edge.get("source") or edge.get("from") or "").strip()
        tgt = str(edge.get("target") or edge.get("to") or "").strip()
        if src and tgt:
            adjacency.setdefault(src, []).append(tgt)
    nodes = []
    for v in vertices:
        if not isinstance(v, dict):
            continue
        node_id = str(v.get("id") or "").strip()
        node = dict(v)
        node["neighbors"] = adjacency.get(node_id, [])
        nodes.append(node)
    normalized_edges = []
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        normalized_edges.append({
            "id": str(edge.get("id") or ""),
            "source": str(edge.get("source") or edge.get("from") or ""),
            "target": str(edge.get("target") or edge.get("to") or ""),
            "label": str(edge.get("label") or ""),
            "weight": edge.get("weight", 1.0),
        })
    return {"nodes": nodes, "edges": normalized_edges}


def _stage_state3_code_environment(ctx: StageContext) -> dict[str, Any]:
    ctx.raise_if_cancelled()
    map_graph = ctx.inputs.get("mapGraph")
    state1b = ctx.stage_payload("state1b_policy_outline") or {}
    policy_outline = list(state1b.get("policies") or [])
    entities_blob = checkpoints.concat_iterations_with_delimiters(
        ctx.job_id, "state2_code_entity_object"
    )

    # Write map.json artifact before LLM call so environment.py can load it at runtime
    map_json_data = _build_map_artifact(map_graph if isinstance(map_graph, dict) else None)
    try:
        artifact_base = checkpoints.artifact_root(ctx.job_id)
        artifact_base.mkdir(parents=True, exist_ok=True)
        import json as _json
        (artifact_base / "map.json").write_text(
            _json.dumps(map_json_data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception as _exc:
        logger.warning("[code_gen][state3] failed to write map.json artifact: %s", _exc)

    retry_error: str | None = None
    code = ""
    errors: list[str] = []
    for attempt in range(2):
        ctx.raise_if_cancelled()
        prompt = prompts.build_state3_environment_prompt(
            entities_blob=entities_blob,
            policy_outline=policy_outline,
            map_graph=map_graph if isinstance(map_graph, dict) else None,
            retry_error=retry_error,
        )
        code = _generate_text(ctx, "state3_code_environment", prompt)
        ctx.raise_if_cancelled()
        errors = prompts.validate_environment_protocol(code)
        if not errors:
            break
        retry_error = "; ".join(errors)
        ctx.emit_stage_message(
            "state3_code_environment",
            f"state3: validation failed (attempt {attempt + 1}/2): {retry_error}",
        )

    # Write .py file immediately so the artifact is available before finalize.
    if code.strip():
        try:
            env_path = checkpoints.artifact_root(ctx.job_id) / "environment.py"
            env_path.parent.mkdir(parents=True, exist_ok=True)
            env_path.write_text(code, encoding="utf-8")
        except Exception as _exc:
            logger.warning("[code_gen][state3] failed to write early artifact environment.py: %s", _exc)

    return {
        "stage": "state3_code_environment",
        "filename": "environment.py",
        "code": code,
        "validation": {"errors": errors},
        "mapAvailable": isinstance(map_graph, dict) and bool(map_graph),
        "mapArtifactWritten": True,
    }


def _stage_state4_code_policy(ctx: StageContext) -> dict[str, Any]:
    ctx.raise_if_cancelled()
    state1b = ctx.stage_payload("state1b_policy_outline") or {}
    policies: list[dict[str, Any]] = list(state1b.get("policies") or [])

    selected_policies = ctx.inputs.get("selectedPolicies") or []
    if selected_policies:
        wanted_ids: set[str] = set()
        for entry in selected_policies:
            if isinstance(entry, dict) and entry.get("rule_id"):
                wanted_ids.add(str(entry["rule_id"]))
            elif isinstance(entry, str):
                wanted_ids.add(entry)
        if wanted_ids:
            policies = [p for p in policies if p.get("rule_id") in wanted_ids]

    state3 = ctx.stage_payload("state3_code_environment") or {}
    environment_code = str(state3.get("code") or "")
    entities_blob = checkpoints.concat_iterations_with_delimiters(
        ctx.job_id, "state2_code_entity_object"
    )
    causal_data = str(ctx.inputs.get("causalData") or "")
    map_graph = ctx.inputs.get("mapGraph")
    iteration_summaries: list[dict[str, Any]] = []

    for index, rule in enumerate(policies):
        ctx.raise_if_cancelled()
        rule_id = str(rule.get("rule_id") or f"policy_{index}")
        existing = checkpoints.load_iteration(ctx.job_id, "state4_code_policy", rule_id)
        if existing and isinstance(existing, dict) and existing.get("code"):
            ctx.emit_stage_message(
                "state4_code_policy",
                f"state4: skip {rule_id} (already generated)",
            )
            iteration_summaries.append(
                {"iterId": rule_id, "filename": existing.get("filename") or f"{rule_id}.py"}
            )
            continue

        ctx.emit_stage_message(
            "state4_code_policy",
            f"state4: generating {rule_id} ({index + 1}/{len(policies)})",
        )
        policies_blob = checkpoints.concat_iterations_with_delimiters(
            ctx.job_id, "state4_code_policy"
        )

        retry_error: str | None = None
        code = ""
        errors: list[str] = []
        for attempt in range(2):
            ctx.raise_if_cancelled()
            prompt = prompts.build_state4_policy_prompt(
                causal_data=causal_data,
                rule=rule,
                entities_blob=entities_blob,
                environment_code=environment_code,
                policies_accumulator=policies_blob,
                map_graph=map_graph if isinstance(map_graph, dict) else None,
                retry_error=retry_error,
            )
            code = _generate_text(ctx, "state4_code_policy", prompt, iter_id=rule_id)
            ctx.raise_if_cancelled()
            errors = prompts.validate_policy_protocol(code)
            if not errors:
                break
            retry_error = "; ".join(errors)
            ctx.emit_stage_message(
                "state4_code_policy",
                f"state4: {rule_id} validation failed (attempt {attempt + 1}/2): {retry_error}",
            )

        filename = f"{rule_id}.py"
        payload = {
            "ruleId": rule_id,
            "filename": filename,
            "code": code,
            "validation": {"errors": errors},
        }
        checkpoints.save_iteration(ctx.job_id, "state4_code_policy", rule_id, payload)
        # Write .py file immediately so artifacts are available before finalize.
        try:
            policies_dir = checkpoints.artifact_root(ctx.job_id) / "policies"
            policies_dir.mkdir(parents=True, exist_ok=True)
            (policies_dir / filename).write_text(code or "", encoding="utf-8")
        except Exception as _exc:
            logger.warning("[code_gen][state4] failed to write early artifact %s: %s", filename, _exc)
        iteration_summaries.append({"iterId": rule_id, "filename": filename})
        touch_activity(ctx.job)

    return {
        "stage": "state4_code_policy",
        "iterations": iteration_summaries,
        "iterationCount": len(iteration_summaries),
    }


def _stage_state4v_validate_policy(ctx: StageContext) -> dict[str, Any]:
    ctx.raise_if_cancelled()
    iterations = checkpoints.list_iterations(ctx.job_id, "state4_code_policy")
    failures: list[dict[str, Any]] = []
    for entry in iterations:
        payload = checkpoints.load_iteration(
            ctx.job_id, "state4_code_policy", entry["iterId"]
        )
        if not isinstance(payload, dict):
            failures.append({"iterId": entry["iterId"], "errors": ["payload missing"]})
            continue
        errors = list((payload.get("validation") or {}).get("errors") or [])
        if errors:
            failures.append({"iterId": entry["iterId"], "errors": errors})
    if failures:
        msg = "; ".join(f"{f['iterId']}: {', '.join(f['errors'])}" for f in failures)
        raise RuntimeError(f"state4 validation failed: {msg}")
    return {"stage": "state4v_validate_policy", "iterations": len(iterations), "failures": []}


# ----- Template Management Helpers -----

def _get_template_dir() -> Path:
    """Get the path to the template directory."""
    return Path(__file__).resolve().parent / "templates"


def _copy_template_files(artifact_base: Path) -> list[dict[str, str]]:
    """
    Copy all template files to the artifacts directory.
    
    Copies:
      - environment_template.py
      - entity_object_template.py
      - policy_template.py
      - entity_template.py
    
    Returns:
        List of manifest entries for the copied template files.
    """
    template_dir = _get_template_dir()
    manifest_entries: list[dict[str, str]] = []
    
    template_files = [
        "environment_template.py",
        "entity_object_template.py",
        "policy_template.py",
        "entity_template.py",
    ]
    
    for template_file in template_files:
        template_path = template_dir / template_file
        if template_path.exists():
            target_path = artifact_base / template_file
            try:
                content = template_path.read_text(encoding="utf-8")
                target_path.write_text(content, encoding="utf-8")
                manifest_entries.append({
                    "path": template_file,
                    "kind": "template",
                    "filename": template_file,
                })
            except Exception as exc:
                logger.warning(
                    "[code_gen][finalize] failed to copy template %s: %s",
                    template_file, exc
                )
    
    return manifest_entries


def _fix_environment_imports(code: str) -> str:
    """
    Fix imports in generated environment.py to reference local template files.
    
    Uses non-relative imports so imports work when run.py executes as a script.
    """
    if not code.strip():
        return code
    
    # Check if already has the import (either form)
    if ("from environment_template import SimulationEnvironment" in code or
        "from .environment_template import SimulationEnvironment" in code):
        return code
    
    # Replace relative import with absolute import if present
    code = code.replace(
        "from .environment_template import SimulationEnvironment",
        "from environment_template import SimulationEnvironment"
    )
    
    # Find where to insert the import (after other imports, before class def)
    lines = code.split("\n")
    import_section_end = 0
    in_imports = False
    for i, line in enumerate(lines):
        if line.startswith(("import ", "from ")):
            in_imports = True
            import_section_end = i + 1
        elif in_imports and line.strip() and not line.startswith("#"):
            if not line.startswith(("import ", "from ")):
                break
    
    # Insert the import
    insert_line = import_section_end
    lines.insert(insert_line, "from environment_template import SimulationEnvironment")
    
    return "\n".join(lines)


def _fix_entity_imports(code: str) -> str:
    """
    Fix imports in generated entity files to reference local template files.
    
    Uses non-relative imports so imports work when run.py executes as a script.
    """
    if not code.strip():
        return code
    
    # Check if already has the import (either form)
    if ("from entity_object_template import entity_object" in code or
        "from .entity_object_template import entity_object" in code):
        return code
    
    # Check if it's trying to import from .environment (wrong) and fix
    if "from .environment import entity_object" in code:
        code = code.replace(
            "from .environment import entity_object",
            "from entity_object_template import entity_object"
        )
        return code
    
    # Replace relative import with absolute import if present
    code = code.replace(
        "from .entity_object_template import entity_object",
        "from entity_object_template import entity_object"
    )
    
    # Find where to insert the import
    lines = code.split("\n")
    import_section_end = 0
    in_imports = False
    for i, line in enumerate(lines):
        if line.startswith(("import ", "from ")):
            in_imports = True
            import_section_end = i + 1
        elif in_imports and line.strip() and not line.startswith("#"):
            if not line.startswith(("import ", "from ")):
                break
    
    # Insert the import if not already there
    insert_line = import_section_end
    lines.insert(insert_line, "from entity_object_template import entity_object")
    
    return "\n".join(lines)


def _fix_policy_imports(code: str) -> str:
    """
    Fix imports in generated policy files to reference local template files.
    
    Uses non-relative imports so imports work when run.py executes as a script.
    """
    if not code.strip():
        return code
    
    # Check if already has the import (either form)
    if ("from policy_template import Policy" in code or
        "from .policy_template import Policy" in code):
        return code
    
    # Check if it's trying to import from .environment (wrong) and fix
    if "from .environment import Policy" in code:
        code = code.replace(
            "from .environment import Policy",
            "from policy_template import Policy"
        )
        return code
    
    # Replace relative import with absolute import if present
    code = code.replace(
        "from .policy_template import Policy",
        "from policy_template import Policy"
    )
    
    # Find where to insert the import
    lines = code.split("\n")
    import_section_end = 0
    in_imports = False
    for i, line in enumerate(lines):
        if line.startswith(("import ", "from ")):
            in_imports = True
            import_section_end = i + 1
        elif in_imports and line.strip() and not line.startswith("#"):
            if not line.startswith(("import ", "from ")):
                break
    
    # Insert the import if not already there
    insert_line = import_section_end
    lines.insert(insert_line, "from policy_template import Policy")
    
    return "\n".join(lines)


def _stage_finalize_bundle(ctx: StageContext) -> dict[str, Any]:
    """Write a flat artifact tree under ``<job>/artifacts/``.

    Layout:
      artifacts/entities/<id>.py
      artifacts/environment.py
      artifacts/environment_template.py (base class)
      artifacts/entity_object_template.py (base class)
      artifacts/policy_template.py (base class)
      artifacts/entity_template.py (compatibility re-export)
      artifacts/policies/<rule_id>.py
      artifacts/manifest.json
    """
    ctx.raise_if_cancelled()
    base = checkpoints.artifact_root(ctx.job_id)
    entities_dir = base / "entities"
    policies_dir = base / "policies"
    entities_dir.mkdir(parents=True, exist_ok=True)
    policies_dir.mkdir(parents=True, exist_ok=True)

    manifest_files: list[dict[str, Any]] = []

    # Step 1: Copy all template files to artifacts root
    template_entries = _copy_template_files(base)
    manifest_files.extend(template_entries)

    # Step 2: Write entity files with fixed imports
    for entry in checkpoints.list_iterations(ctx.job_id, "state2_code_entity_object"):
        payload = checkpoints.load_iteration(
            ctx.job_id, "state2_code_entity_object", entry["iterId"]
        )
        if not isinstance(payload, dict):
            continue
        filename = str(payload.get("filename") or f"{entry['iterId']}.py")
        entity_code = str(payload.get("code") or "")
        # Fix imports to reference local templates
        entity_code = _fix_entity_imports(entity_code)
        target = entities_dir / filename
        target.write_text(entity_code, encoding="utf-8")
        manifest_files.append({"path": f"entities/{filename}", "iterId": entry["iterId"], "kind": "entity"})

    # Step 3: Write environment file with fixed imports
    state3 = ctx.stage_payload("state3_code_environment") or {}
    env_code = str(state3.get("code") or "")
    if env_code.strip():
        # Fix imports to reference local templates
        env_code = _fix_environment_imports(env_code)
        env_path = base / "environment.py"
        env_path.write_text(env_code, encoding="utf-8")
        manifest_files.append({"path": "environment.py", "kind": "environment"})

    # Step 4: Write policy files with fixed imports
    for entry in checkpoints.list_iterations(ctx.job_id, "state4_code_policy"):
        payload = checkpoints.load_iteration(
            ctx.job_id, "state4_code_policy", entry["iterId"]
        )
        if not isinstance(payload, dict):
            continue
        filename = str(payload.get("filename") or f"{entry['iterId']}.py")
        policy_code = str(payload.get("code") or "")
        # Fix imports to reference local templates
        policy_code = _fix_policy_imports(policy_code)
        target = policies_dir / filename
        target.write_text(policy_code, encoding="utf-8")
        manifest_files.append({"path": f"policies/{filename}", "iterId": entry["iterId"], "kind": "policy"})

    # Runtime assets — deterministic, no LLM call. The generated bundle
    # gets a Reporter + run.py orchestrator + the metric contract JSON
    # the user picked at job submission, plus a small PowerBI recipe so
    # downstream BI consumes the same chart_group / viz hints.
    from . import codegen_runtime_assets as _runtime_assets

    # Read confirmed metrics from state1d checkpoint (Section 13a)
    state1d = ctx.stage_payload("state1d_metrics_draft") or {}
    selected_metrics: list[dict[str, Any]] = [
        m for m in (state1d.get("metrics") or []) if isinstance(m, dict)
    ]

    (base / "reporter.py").write_text(_runtime_assets.REPORTER_PY, encoding="utf-8")
    manifest_files.append({"path": "reporter.py", "kind": "runtime"})
    (base / "run.py").write_text(_runtime_assets.RUN_PY, encoding="utf-8")
    manifest_files.append({"path": "run.py", "kind": "runtime"})

    contracts_payload = _runtime_assets.build_metric_contracts(
        selected_metrics, job_id=ctx.job_id
    )
    (base / "metric_contracts.json").write_text(
        _runtime_assets.serialize_json(contracts_payload), encoding="utf-8"
    )
    manifest_files.append({"path": "metric_contracts.json", "kind": "metrics"})

    pbi_dir = base / "pbi"
    pbi_dir.mkdir(parents=True, exist_ok=True)
    recipe_payload = _runtime_assets.build_pbi_recipe(
        selected_metrics, job_id=ctx.job_id
    )
    (pbi_dir / "recipe.json").write_text(
        _runtime_assets.serialize_json(recipe_payload), encoding="utf-8"
    )
    manifest_files.append({"path": "pbi/recipe.json", "kind": "pbi"})
    (pbi_dir / "theme.json").write_text(
        _runtime_assets.serialize_json(_runtime_assets.PBI_THEME_JSON), encoding="utf-8"
    )
    manifest_files.append({"path": "pbi/theme.json", "kind": "pbi"})

    # Write verification_report.json from state5_policy_verify if available
    state5 = ctx.stage_payload("state5_policy_verify") or {}
    if state5 and not state5.get("skipped"):
        import json as _json_v
        verification_report = {
            "policyCount": state5.get("policyCount") or 0,
            "fixedCount": state5.get("fixedCount") or 0,
            "failedCount": state5.get("failedCount") or 0,
            "results": state5.get("results") or [],
        }
        (base / "verification_report.json").write_text(
            _json_v.dumps(verification_report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        manifest_files.append({"path": "verification_report.json", "kind": "verification"})

    manifest = {
        "pipeline": "code_gen",
        "jobId": ctx.job_id,
        "files": manifest_files,
        "tokenUsage": dict(ctx.usage) if ctx.usage else {},
        "selectedMetricsCount": len(selected_metrics),
    }
    import json as _json

    (base / "manifest.json").write_text(
        _json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {"stage": "finalize_bundle", "fileCount": len(manifest_files), "files": manifest_files}


# ---------------------------------------------------------------------------
# Section 12 — Policy self-verification
# ---------------------------------------------------------------------------

_MAP_ACCESSOR_API_SUMMARY = """\
env.get_nodes() -> list[dict]          # all map nodes
env.get_node(node_id) -> dict | None   # single node by id
env.get_edges() -> list[dict]          # all map edges
env.get_neighbors(node_id) -> list[str]  # neighbor node ids
env.get_node_types() -> list[str]      # distinct node types"""


def _load_entity_code_index(ctx: StageContext) -> dict[str, str]:
    """Return {entity_id: python_code} from state2 iterations."""
    iterations = checkpoints.list_iterations(ctx.job_id, "state2_code_entity_object")
    result: dict[str, str] = {}
    for entry in iterations:
        payload = checkpoints.load_iteration(ctx.job_id, "state2_code_entity_object", entry["iterId"])
        if isinstance(payload, dict) and payload.get("code"):
            eid = str(payload.get("entityId") or entry["iterId"])
            result[eid] = str(payload["code"])
    return result


def _stage_state5_policy_verify(ctx: StageContext) -> dict[str, Any]:
    """LLM-as-Judge: review each generated policy, fix bugs, max 2 retries per policy."""
    ctx.raise_if_cancelled()

    state4_iterations = checkpoints.list_iterations(ctx.job_id, "state4_code_policy")
    if not state4_iterations:
        return {"stage": "state5_policy_verify", "skipped": True, "reason": "no state4 iterations found"}

    state1b = ctx.stage_payload("state1b_policy_outline") or {}
    policy_outlines = state1b.get("policies") or []
    rule_contracts: dict[str, dict[str, Any]] = {
        str(p.get("rule_id") or ""): p
        for p in policy_outlines
        if isinstance(p, dict) and p.get("rule_id")
    }

    entity_code_index = _load_entity_code_index(ctx)
    map_graph = ctx.inputs.get("mapGraph")
    map_accessor_api = _MAP_ACCESSOR_API_SUMMARY if isinstance(map_graph, dict) and map_graph else ""

    verification_results: list[dict[str, Any]] = []
    fixed_count = 0
    failed_count = 0

    for entry in state4_iterations:
        ctx.raise_if_cancelled()
        rule_id = str(entry["iterId"])

        existing_verify = checkpoints.load_iteration(ctx.job_id, "state5_policy_verify", rule_id)
        if existing_verify and isinstance(existing_verify, dict) and "passed" in existing_verify:
            ctx.emit_stage_message(
                "state5_policy_verify",
                f"state5: skip {rule_id} (already verified)",
            )
            verification_results.append(existing_verify)
            if existing_verify.get("passed") and existing_verify.get("attempts", 1) > 1:
                fixed_count += 1
            elif not existing_verify.get("passed"):
                failed_count += 1
            continue

        payload = checkpoints.load_iteration(ctx.job_id, "state4_code_policy", rule_id)
        if not isinstance(payload, dict) or not payload.get("code"):
            verification_results.append({"rule_id": rule_id, "skipped": True, "reason": "no code"})
            continue

        rule_contract = rule_contracts.get(rule_id, {"rule_id": rule_id})
        current_code = str(payload["code"])
        attempts: list[dict[str, Any]] = []
        final_code = current_code
        passed = True

        ctx.emit_stage_message(
            "state5_policy_verify",
            f"state5: judging {rule_id} ({state4_iterations.index(entry) + 1}/{len(state4_iterations)})",
        )

        max_verify_attempts = int(ctx.inputs.get("maxVerifyAttempts", 3))
        for attempt_num in range(max_verify_attempts):
            ctx.raise_if_cancelled()
            judge_prompt = prompts.build_policy_judge_pass1_prompt(
                policy_code=current_code,
                rule_contract=rule_contract,
                entity_code_index=entity_code_index,
                map_accessor_api=map_accessor_api,
            )
            judge_result = _generate_json(
                ctx, "state5_policy_verify", judge_prompt, prompts.JUDGE_PASS1_SCHEMA,
                iter_id=f"{rule_id}_pass1_attempt{attempt_num + 1}",
            )
            issues: list[dict[str, Any]] = []
            if isinstance(judge_result, dict):
                issues = [i for i in (judge_result.get("issues") or []) if isinstance(i, dict)]

            attempt_record: dict[str, Any] = {"attempt": attempt_num + 1, "issues": issues}

            if not issues:
                attempt_record["status"] = "pass"
                attempts.append(attempt_record)
                break

            if attempt_num < 2:
                fix_prompt = prompts.build_policy_judge_pass2_prompt(
                    policy_code=current_code,
                    rule_contract=rule_contract,
                    entity_code_index=entity_code_index,
                    map_accessor_api=map_accessor_api,
                    issues=issues,
                )
                fixed_code = _generate_text(
                    ctx, "state5_policy_verify", fix_prompt,
                    iter_id=f"{rule_id}_fix_attempt{attempt_num + 1}",
                )
                if fixed_code.strip():
                    current_code = fixed_code
                    final_code = fixed_code
                attempt_record["status"] = "fixed"
                attempts.append(attempt_record)
            else:
                attempt_record["status"] = "fail"
                attempts.append(attempt_record)
                passed = False

        if len(attempts) > 1 and passed:
            fixed_count += 1
            # Persist the fixed code back to the state4 iteration.
            updated_payload = dict(payload)
            updated_payload["code"] = final_code
            updated_payload["verifiedFixed"] = True
            checkpoints.save_iteration(ctx.job_id, "state4_code_policy", rule_id, updated_payload)
            try:
                policies_dir = checkpoints.artifact_root(ctx.job_id) / "policies"
                policies_dir.mkdir(parents=True, exist_ok=True)
                filename = str(payload.get("filename") or f"{rule_id}.py")
                (policies_dir / filename).write_text(final_code, encoding="utf-8")
            except Exception as _exc:
                logger.warning("[code_gen][state5] failed to write fixed artifact %s: %s", rule_id, _exc)
        elif not passed:
            failed_count += 1

        file_result = {
            "rule_id": rule_id,
            "passed": passed,
            "attempts": len(attempts),
            "fix_history": attempts,
        }
        verification_results.append(file_result)
        checkpoints.save_iteration(ctx.job_id, "state5_policy_verify", rule_id, file_result)

    return {
        "stage": "state5_policy_verify",
        "policyCount": len(state4_iterations),
        "fixedCount": fixed_count,
        "failedCount": failed_count,
        "results": verification_results,
    }


# ---------------------------------------------------------------------------
# Stage registry
# ---------------------------------------------------------------------------


def _stage_stub(name: str) -> StageFn:
    def _impl(ctx: StageContext) -> dict[str, Any]:
        ctx.raise_if_cancelled()
        ctx.emit_stage_message(name, f"{name}: stub (not yet implemented)")
        return {
            "stage": name,
            "stub": True,
            "message": "Stage not yet implemented (Phase 2 scaffold).",
        }

    return _impl


STAGE_REGISTRY: dict[str, StageFn] = {
    stage: _stage_stub(stage) for stage in checkpoints.STAGE_ORDER
}
STAGE_REGISTRY["state1_entity_list"] = _stage_state1_entity_list
STAGE_REGISTRY["state1b_policy_outline"] = _stage_state1b_policy_outline
STAGE_REGISTRY["state1c_entity_dependencies"] = _stage_state1c_entity_dependencies
STAGE_REGISTRY["state1d_metrics_draft"] = _stage_state1d_metrics_draft
STAGE_REGISTRY["state2_code_entity_object"] = _stage_state2_code_entity_object
STAGE_REGISTRY["state2v_validate_protocol"] = _stage_state2v_validate_protocol
STAGE_REGISTRY["state2j_entity_judge"] = _stage_state2j_entity_judge
STAGE_REGISTRY["state3_code_environment"] = _stage_state3_code_environment
STAGE_REGISTRY["state4_code_policy"] = _stage_state4_code_policy
STAGE_REGISTRY["state4v_validate_policy"] = _stage_state4v_validate_policy
STAGE_REGISTRY["state5_policy_verify"] = _stage_state5_policy_verify
STAGE_REGISTRY["finalize_bundle"] = _stage_finalize_bundle


def run_stage_inline(
    *,
    stage: str,
    job: JobRecord,
    api_key: str | None,
    model_name: str,
    use_env_model_overrides: bool,
    inputs: dict[str, Any],
) -> dict[str, Any]:
    """Run a single stage in the calling thread, persisting its checkpoint.

    Used by the ``preview_entities`` HTTP endpoint to run Stage 1 + Stage 1b
    synchronously from a request handler. Skips re-running if the stage is
    already on disk.
    """
    impl = STAGE_REGISTRY.get(stage)
    if impl is None:
        raise KeyError(f"unknown stage {stage!r}")
    existing = checkpoints.load_stage(job.job_id, stage)
    if existing is not None:
        return existing
    ctx = StageContext(
        job=job,
        api_key=api_key,
        model_name=model_name,
        use_env_model_overrides=use_env_model_overrides,
        inputs=inputs,
    )
    payload = impl(ctx)
    checkpoints.save_stage(job.job_id, stage, payload)
    with_completed = list(job.completed_stages or [])
    if stage not in with_completed:
        with_completed.append(stage)
        job.completed_stages = with_completed
    return payload


def run_code_gen_worker(
    *,
    job: JobRecord,
    api_key: str | None,
    model_name: str,
    use_env_model_overrides: bool,
    inputs: dict[str, Any],
) -> None:
    """Background worker entry point.

    Walks ``STAGE_ORDER``, skipping any stage whose checkpoint already exists,
    and emits the same ``stage`` / ``error`` / ``result`` / ``done`` events as
    the map_extract worker so the existing frontend status path Just Works.
    """
    ctx = StageContext(
        job=job,
        api_key=api_key,
        model_name=model_name,
        use_env_model_overrides=use_env_model_overrides,
        inputs=inputs,
    )
    completed = _resume_skip_completed(job)
    final_stage_payload: dict[str, Any] | None = None

    try:
        for stage in checkpoints.STAGE_ORDER:
            ctx.raise_if_cancelled()

            if stage in completed:
                logger.info(
                    "[code_gen] skip already-completed stage jobId=%s stage=%s",
                    job.job_id,
                    stage,
                )
                # Resume path: if the post-run gate for this stage was never confirmed
                # (e.g. server restart while awaiting), re-enter the gate here.
                if stage in POST_RUN_CONFIRMATION_GATES and stage not in job.confirmed_stages:
                    if ctx.inputs.get("autoConfirm"):
                        job.confirmed_stages = list(job.confirmed_stages or []) + [stage]
                    else:
                        _wait_for_confirmation(ctx, stage)
                        ctx.raise_if_cancelled()
                ctx.emit_stage_message(stage, f"{stage}: skipped (already completed)")
                continue

            ctx.emit_stage_message(stage, f"{stage}: starting")
            touch_activity(job)

            impl = STAGE_REGISTRY[stage]
            payload = impl(ctx)

            checkpoints.save_stage(job.job_id, stage, payload)
            with_completed = list(job.completed_stages or [])
            if stage not in with_completed:
                with_completed.append(stage)
                job.completed_stages = with_completed
            touch_activity(job)
            usage_snapshot = (
                {
                    "promptTokens": int(ctx.usage.get("prompt_tokens", 0)),
                    "outputTokens": int(ctx.usage.get("output_tokens", 0)),
                    "totalTokens": int(ctx.usage.get("total_tokens", 0)),
                    "callCount": int(ctx.usage.get("call_count", 0)),
                }
                if ctx.usage
                else None
            )
            ctx.emit_stage_message(stage, f"{stage}: done", token_usage=usage_snapshot)
            final_stage_payload = payload

            # Post-run gate: stage completed, pause for user review before advancing.
            if stage in POST_RUN_CONFIRMATION_GATES and stage not in job.confirmed_stages:
                if ctx.inputs.get("autoConfirm"):
                    logger.info("[code_gen] autoConfirm: skipping post-run gate jobId=%s stage=%s", job.job_id, stage)
                    job.confirmed_stages = list(job.confirmed_stages or []) + [stage]
                else:
                    _wait_for_confirmation(ctx, stage)
                    ctx.raise_if_cancelled()

        result = {
            "pipeline": "code_gen",
            "completedStages": list(job.completed_stages),
            "finalStage": final_stage_payload,
        }
        emit_job_event(job, "result", result)
    except JobCancelledError:
        logger.info("[code_gen] cancelled jobId=%s", job.job_id)
        from ..services.job_store import mark_cancelled

        mark_cancelled(job.job_id)
    except Exception as exc:  # pragma: no cover - defensive surface
        logger.exception("[code_gen] worker failed jobId=%s", job.job_id)
        emit_job_event(job, "error", {"error": f"code_gen worker failed: {exc}"})
    finally:
        emit_job_event(job, "done", None)
