"""Driver for the code-generation background pipeline.

Phase 2: Stage 1 family (state1_entity_list, state1b_policy_outline,
state1c_entity_dependencies) is wired with real Gemini calls. Stages 2 / 3 /
4 / validation / finalize remain stubs and are replaced in Phase 3.

The driver mirrors ``map_extract_runner`` in event semantics so the existing
status / SSE infrastructure can be reused without modification.
"""

from __future__ import annotations

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
    """
    completed: set[str] = set()
    for stage in checkpoints.STAGE_ORDER:
        if checkpoints.load_stage(job.job_id, stage) is not None:
            completed.add(stage)
    completed.update(job.completed_stages or [])
    return completed


# Stages that require explicit user confirmation before the worker proceeds.
CONFIRMATION_GATES: frozenset[str] = frozenset({"state1c_entity_dependencies"})


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


def _stage_state1_entity_list(ctx: StageContext) -> dict[str, Any]:
    ctx.raise_if_cancelled()
    user_list = list(ctx.inputs.get("userEntityList") or [])
    if user_list:
        # User-curated list is source of truth — skip Gemini extraction.
        cleaned: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for entry in user_list:
            if not isinstance(entry, dict):
                continue
            eid = str(entry.get("id") or "").strip()
            if not eid or eid in seen_ids:
                continue
            seen_ids.add(eid)
            cleaned.append(
                {
                    "id": eid,
                    "label": str(entry.get("label") or eid),
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


def _stage_state1b_policy_outline(ctx: StageContext) -> dict[str, Any]:
    ctx.raise_if_cancelled()
    state1 = ctx.stage_payload("state1_entity_list") or {}
    entities = state1.get("entities") or []
    causal_data = str(ctx.inputs.get("causalData") or "")
    prompt, schema = prompts.build_state1b_policy_outline_prompt(causal_data, entities)
    parsed = _generate_json(ctx, "state1b_policy_outline", prompt, schema)
    if not isinstance(parsed, dict):
        parsed = {"policies": []}
    policies = parsed.get("policies") or []
    if not isinstance(policies, list):
        policies = []
    valid_ids = {str(e.get("id") or "") for e in entities if isinstance(e, dict)}
    valid_ids.add("environment")
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
            logger.warning(
                "[code_gen][state1b] dropping rule %r: target_entity_id %r not in entity list",
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
        order = [eid for eid in order if eid in user_filter]

    causal_data = str(ctx.inputs.get("causalData") or "")
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


def _stage_state3_code_environment(ctx: StageContext) -> dict[str, Any]:
    ctx.raise_if_cancelled()
    causal_data = str(ctx.inputs.get("causalData") or "")
    map_node_json = ctx.inputs.get("mapNodeJson")
    entities_blob = checkpoints.concat_iterations_with_delimiters(
        ctx.job_id, "state2_code_entity_object"
    )

    retry_error: str | None = None
    code = ""
    errors: list[str] = []
    for attempt in range(2):
        ctx.raise_if_cancelled()
        prompt = prompts.build_state3_environment_prompt(
            causal_data=causal_data,
            entities_blob=entities_blob,
            map_node_json=map_node_json if isinstance(map_node_json, dict) else None,
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
        "mapAvailable": isinstance(map_node_json, dict) and bool(map_node_json),
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
    return (
        Path(__file__).resolve().parents[4]
        / "Experiment/code_generation/entity_design/entity/gemini_3_pro_entity/template"
    )


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

    selected_metrics_raw = ctx.inputs.get("selectedMetrics") or []
    selected_metrics: list[dict[str, Any]] = [
        m for m in selected_metrics_raw if isinstance(m, dict)
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
STAGE_REGISTRY["state2_code_entity_object"] = _stage_state2_code_entity_object
STAGE_REGISTRY["state2v_validate_protocol"] = _stage_state2v_validate_protocol
STAGE_REGISTRY["state3_code_environment"] = _stage_state3_code_environment
STAGE_REGISTRY["state4_code_policy"] = _stage_state4_code_policy
STAGE_REGISTRY["state4v_validate_policy"] = _stage_state4v_validate_policy
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
                ctx.emit_stage_message(stage, f"{stage}: skipped (already completed)")
                continue

            if stage in CONFIRMATION_GATES and stage not in job.confirmed_stages:
                if ctx.inputs.get("autoConfirm"):
                    logger.info("[code_gen] autoConfirm: skipping gate jobId=%s stage=%s", job.job_id, stage)
                    job.confirmed_stages = list(job.confirmed_stages or []) + [stage]
                else:
                    _wait_for_confirmation(ctx, stage)
                    ctx.raise_if_cancelled()

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
