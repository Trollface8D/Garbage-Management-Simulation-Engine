# Failure Report: Dropped Metrics — sim-699d82a1f25a

**Job:** `code_gen-aa67a54b26fc4edd8bab69ddc8ba4818`  
**Run:** `sim-699d82a1f25a`  
**Model:** Gemini 2.5 Pro (implicit grounding)  
**Affected metrics:** `departmental_recycling_volume`, `ewaste_donated_for_reuse`  
**Expected metrics:** 6 — **Recorded metrics:** 4

---

## What Failed

Two metrics declared in `metric_contracts.json` produced zero rows in `metrics.jsonl`.
Both share the same `"sampling_event": "policy_fired"`.

| Metric | Entity | Attr | Type |
|--------|--------|------|------|
| `departmental_recycling_volume` | `entity-109-green-society` | `recorded_collection_data` | `List[Dict]` |
| `ewaste_donated_for_reuse` | `mirror_foundation` | `received_ewaste_weight` | `float` |

---

## Root Causes in the Pipeline

### RC-1: `RUN_PY` template never loads policies

`finalize_bundle` generates `run.py` with `_load_entities()` but no `_load_policies()`.
`Environment` receives `policies=[]`. `before_tick`/`after_tick` hooks never fire.
Result: `record_waste_collection()` is never called → `recorded_collection_data` stays `[]`.
Mirror Foundation never receives e-waste → `received_ewaste_weight` stays `0`.

This is a **template gap** — the codegen pipeline generates policy files but the harness that runs the sim ignores them entirely.

### RC-2: `REPORTER_PY` template silently drops `policy_fired` metrics

`Reporter.sample()` contains an explicit guard:
```python
if (metric.get("sampling_event") or "tick") != "tick":
    continue
```
The `policy_fired` sampling path was never implemented. No method exists to sample these metrics, and nothing in `run.py` would call one even if it did.

This is a **contract-implementation mismatch** — `metric_contracts.json` can express `policy_fired` but the runtime template never honors it.

### RC-3: `_read_attr` cannot reduce `List[Dict]` to float

`recorded_collection_data` is `List[{"department_id", "waste_type", "weight"}]`.
`Reporter._read_attr()` handles `int`, `float`, `bool` — falls through to `float(value)` on a list, raising `TypeError`, returns `None`. The metric goes silent.

Entity codegen (LLM) chose a list-of-records design for auditability. The reporter template was never updated to handle non-scalar metric attributes.

This is an **impedance mismatch** between entity codegen output shape and reporter input expectation.

---

## Which Prompts to Fix and Would More Verification Loops Help?

### RC-1 and RC-2: No prompt fix possible

`run.py` and `reporter.py` are **static templates** in `codegen_runtime_assets.py` — not LLM output. No prompt change affects them. Increasing any verification loop iteration count is irrelevant for both.

Fix is purely in template code:
- `RUN_PY`: add `_load_policies()`, pass to `Environment(policies=policies)`
- `REPORTER_PY`: remove the `sampling_event != "tick"` guard in `sample()`

---

### RC-3: Reporter fix is the right layer, not prompt restriction

**Correction on RC-3a:** Restricting `required_attrs` to scalar-only in `state1d_metrics_draft` is wrong. Collections are valid metric sources — `stacked_area` metrics (e.g. waste sorted by destination) naturally live in dicts, and audit-trail patterns use `List[Dict]`. Forcing the LLM to always emit a scalar would break those cases.

The correct fix for RC-3 is **RC-3b only**: extend `_read_attr` in `REPORTER_PY` to reduce `List[Dict]` to float (sum numeric sub-fields, priority: `weight → amount → value → count → len`). This is a template fix, not a prompt fix.

No prompt change needed for RC-3.

---

### Would increasing verification loop iterations help?

**Yes — partially, and it matters more than it first appeared.**

`state5_policy_verify` currently runs max 3 attempts per policy (1 judge + 2 fix retries) — hardcoded at `code_gen_runner.py:1380` as `range(3)`. Observed issues:
- **22% of policies fail pass 1** (have concrete bugs identified by the judge)
- After the 2 fix retries, some policies still have residual suggested fixes — meaning the 3-attempt cap cuts off before convergence

This matters for metrics because: if a policy has bugs and fails to execute correctly, the entity state it was supposed to update never changes → `policy_fired` metric values stay flat zero even after RC-1 and RC-2 are fixed.

**Increasing attempts from 3 to 4 or 5 would likely reduce the residual fail rate** for the 22% that currently exit with unresolved issues.

**The attempt cap should be default 3 but configurable per job.** Replace the hardcoded `range(3)` with a value read from `ctx.inputs`:

```python
# code_gen_runner.py, _stage_state5_policy_verify
max_verify_attempts = int(ctx.inputs.get("maxVerifyAttempts", 3))
for attempt_num in range(max_verify_attempts):
```

Callers pass `maxVerifyAttempts` in the job inputs dict (same place as `causalData`, `selectedEntities`, etc.). Frontend can expose this as an advanced setting. Default 3 preserves current behaviour; power users can raise to 5 for complex bundles.

However, more `state5` iterations still do not fix RC-1, RC-2, or RC-3. They address a separate but related problem: **correct policy execution is a prerequisite for metric data to exist**.

---

### Entity-level judge+fix loop: `state2j_entity_judge`

Currently entity code has no LLM judge — `state2v_validate_protocol` only checks whether prior generation validation errors existed (syntax/schema). It does not review entity logic, method signatures, or metric attr correctness.

The 22% policy fail rate in `state5` is partly caused by **entity code defects**: policies call entity methods that exist but have wrong signatures, missing return values, or incorrect attribute names. The policy judge catches these at policy review time, but the entity code has already been written and frozen.

**Proposed: add `state2j_entity_judge` after `state2v_validate_protocol`.**

Loop design: **same pass-1 judge prompt runs in a judge→fix→re-judge loop**, up to `maxVerifyAttempts` (default 3). No separate pass-2 fix template needed — checking against the `entity_object_template.py` base class is exactly the pass-1 judgment function. After issues are found, the fix is a re-invocation of `state2_code_entity_object` with the issue list injected as `retry_error`. The re-generated entity code is then re-judged with the same pass-1 prompt.

```
for each entity:
    attempt 1..maxVerifyAttempts:
        issues = entity_judge_pass1(entity_code, entity_contract, metric_contracts, policy_outline)
        if no issues → break
        entity_code = state2_regenerate(entity_code, retry_error=issues)
```

Pass 1 judges each entity class against:
- Method signatures required by policy outline (`state1b`) — existence, arity, return type
- Metric attr accessibility (`state1d`) — attr exists, and if collection, is reporter-reducible (list of dicts with at least one numeric field)
- Base class compliance (`entity_object_template.py`) — `step()` and `on_query()` present and correctly typed

`state2vm_validate_metric_attrs` is **dropped** — its responsibility (catching non-reducible metric attrs) is now fully covered by `state2j` pass-1 judgment and the fix loop.

Stage fits between `state2v_validate_protocol` and `state3_code_environment` in `STAGE_ORDER` (`code_gen_checkpoints.py:38`). Also add to `ITERATIVE_STAGES` (iterates per entity, same as `state2_code_entity_object`).

**Reuse existing infrastructure**: new prompt builder modelled on `build_policy_judge_pass1_prompt` (`code_gen_prompts.py:1131`), swapping policy contract for entity contract (entity object from `state1` + relevant metrics from `state1d` + policy methods from `state1b`).

---

## Summary Table

| Root Cause | Pipeline Stage | Prompt Fix? | More Loops Help? | Recommended Fix |
|------------|---------------|------------|-----------------|-----------------|
| Policies not loaded in run harness | `finalize_bundle` / `RUN_PY` template | No | No | Fix `codegen_runtime_assets.py` template |
| `policy_fired` silently skipped | `finalize_bundle` / `REPORTER_PY` template | No | No | Fix `codegen_runtime_assets.py` template |
| `List[Dict]` not reducible to float | `REPORTER_PY` `_read_attr` | No | No | Extend `_read_attr` to reduce `List[Dict]` (sum numeric sub-fields) |
| Policy bugs cause entity state to never update | `state5_policy_verify` | No | **Yes** | Make `maxVerifyAttempts` configurable (default 3) via `ctx.inputs` |
| No entity-level logic / metric attr review | Missing stage | New prompt needed | Yes — same `maxVerifyAttempts` | Add `state2j_entity_judge`: judge+fix loop, same pass-1 prompt, re-runs `state2` on failure |

---

## Severity

All three causes compound: even if RC-1 were fixed (policies fire), RC-2 would still silence both metrics. Even if RC-1 + RC-2 were fixed, RC-3 would silence `departmental_recycling_volume` specifically. All three must be addressed for full metric coverage.

The failure is **silent** — no exception, no warning in the run log. `metrics.jsonl` is valid JSONL with correct headers; the missing metrics simply produce no rows. This makes the failure invisible without a post-run metric coverage check.

**Recommended addition to pipeline:** After every sim run, assert `len(recorded_metric_names) == len(contracted_metric_names)`. Emit a warning (or fail the run artifact) if any contracted metric produced zero rows.

---

## Implementation Instructions (Next Sync)

### Task order

Implement in this order — each task has zero dependency on the next:

1. **RC-1 + RC-2** — template fixes (no LLM, no new stage, safest)
2. **RC-3** — `_read_attr` extension (no new stage, isolated change)
3. **`maxVerifyAttempts`** — single-line change in runner + inputs threading
4. **`state2j_entity_judge`** — new stage (largest change, depends on 3 being done first so the loop cap is reused)

---

### Task 1 — Fix `RUN_PY` and `REPORTER_PY` templates

**File:** `engine/backend/app/services/codegen_runtime_assets.py`

**Change A — `RUN_PY`: add `_load_policies()`**

Add after `_load_entities()` function (before `main()`):

```python
def _load_policies() -> list:
    """Dynamically import and instantiate all policy classes from policies/ directory."""
    policies = []
    policies_dir = Path(__file__).resolve().parent / "policies"
    if not policies_dir.exists():
        return policies
    for policy_file in sorted(policies_dir.glob("*.py")):
        if policy_file.name.startswith("_"):
            continue
        try:
            spec = importlib.util.spec_from_file_location(policy_file.stem, policy_file)
            if spec is None or spec.loader is None:
                continue
            module = importlib.util.module_from_spec(spec)
            sys.modules[policy_file.stem] = module
            spec.loader.exec_module(module)
            for attr_name in dir(module):
                if attr_name.startswith("Entity_") and attr_name.endswith("Policy"):
                    cls = getattr(module, attr_name)
                    if isinstance(cls, type):
                        try:
                            policies.append(cls())
                        except Exception as e:
                            print(f"warning: failed to instantiate {attr_name}: {e}")
                        break
        except Exception as e:
            print(f"warning: failed to load policy {policy_file.stem}: {e}")
    return policies
```

In `main()`, change:
```python
# before
entities = _load_entities()
env = Environment(entities=entities)

# after
entities = _load_entities()
policies = _load_policies()
env = Environment(entities=entities, policies=policies)
```

**Change B — `REPORTER_PY`: remove `sampling_event` guard**

In `sample()` method, remove:
```python
if (metric.get("sampling_event") or "tick") != "tick":
    continue
```

**Change C — `REPORTER_PY`: extend `_read_attr` for `List[Dict]`**

Replace `_read_attr` body with:
```python
def _read_attr(self, instance: Any, attr: str) -> float | None:
    try:
        value = getattr(instance, attr)
    except Exception:
        return None
    if value is None:
        return None
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, list):
        if not value:
            return 0.0
        if isinstance(value[0], (int, float)) and not isinstance(value[0], bool):
            return float(sum(float(x) for x in value if isinstance(x, (int, float))))
        if isinstance(value[0], dict):
            for key in ("weight", "amount", "value", "count", "quantity"):
                vals = [v[key] for v in value if isinstance(v.get(key), (int, float))]
                if vals:
                    return float(sum(vals))
        return float(len(value))
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
```

> Note: Changes A+B+C are in the string constants `RUN_PY` and `REPORTER_PY` inside `codegen_runtime_assets.py`. These strings are written to artifact directories at bundle finalization — they do not affect already-generated bundles. Re-run the sim after regenerating.

---

### Task 2 — `maxVerifyAttempts` configurable

**File:** `engine/backend/app/services/code_gen_runner.py`

At line 1380, replace:
```python
for attempt_num in range(3):  # pass 1 + max 2 fix retries
```
with:
```python
max_verify_attempts = int(ctx.inputs.get("maxVerifyAttempts", 3))
for attempt_num in range(max_verify_attempts):
```

No other changes needed — `ctx.inputs` already flows from job creation through `run_code_gen_worker` → `StageContext`. Callers add `"maxVerifyAttempts": N` to the job inputs JSON.

---

### Task 3 — Add `state2j_entity_judge` stage

#### 3a. New prompt builder — `code_gen_prompts.py`

Add after the `_JUDGE_PASS2_TEMPLATE` block (around line 1091):

```python
_ENTITY_JUDGE_TEMPLATE = """You are a Python code reviewer checking a simulation entity module.

Entity contract:
  entity_id: {entity_id}
  label: {label}
  description: {description}

Policy methods this entity MUST expose (called by policies):
{policy_methods}

Metric attributes this entity MUST expose for the Reporter:
{metric_attrs}

Base class interface (entity_object_template.py — must be satisfied):
{base_class_interface}

Entity code under review:
```python
{entity_code}
```

Identify concrete bugs only:
- Missing or wrong-signature policy methods
- Metric attrs that don't exist, are wrong type, or are not reporter-reducible
  (reporter-reducible = int/float/bool, or List[Dict] with at least one numeric value field)
- Missing step() or on_query() overrides
- Broken base class inheritance

Do NOT report style issues or minor formatting.

Return JSON only:
{{
  "issues": [
    {{
      "severity": "critical",
      "location": "method_or_attr_name",
      "description": "what is wrong",
      "suggested_fix": "how to fix it"
    }}
  ],
  "verdict": "pass"
}}
If no issues: {{"issues": [], "verdict": "pass"}}.
If issues: {{"issues": [...], "verdict": "fail"}}.
"""


def build_entity_judge_prompt(
    *,
    entity_id: str,
    entity_obj: dict[str, Any],
    entity_code: str,
    policy_outline: list[dict[str, Any]],
    selected_metrics: list[dict[str, Any]],
    base_class_src: str,
) -> str:
    """Pass 1 judge for entity code — same prompt reused in judge→fix loop."""
    relevant_policies = [
        p for p in policy_outline
        if p.get("target_entity_id") == entity_id
    ]
    policy_methods_lines = [
        f"  {p.get('rule_id')}: {p.get('target_method')}() — {p.get('trigger', '')}"
        for p in relevant_policies
    ] or ["  (none)"]

    entity_metrics = [
        m for m in selected_metrics
        if isinstance(m, dict) and (
            m.get("entity_id") == entity_id
            or entity_id in (m.get("entities") or [])
        )
    ]
    metric_attr_lines = []
    for m in entity_metrics:
        attrs = [
            dep.get("attr") for dep in (m.get("required_attrs") or [])
            if isinstance(dep, dict) and dep.get("entity") == entity_id
        ]
        metric_attr_lines.append(
            f"  metric '{m.get('name')}' (agg={m.get('agg')}): {', '.join(attrs) or '(none)'}"
        )
    if not metric_attr_lines:
        metric_attr_lines = ["  (none)"]

    digest = interface_digest_from_source(base_class_src)
    base_lines: list[str] = []
    for cls in digest.get("classes") or []:
        for method in cls.get("methods") or []:
            args = ", ".join(method.get("args") or [])
            base_lines.append(f"  def {method['name']}({args}): ...")

    return _ENTITY_JUDGE_TEMPLATE.format(
        entity_id=entity_id,
        label=str(entity_obj.get("label") or entity_id),
        description=str(entity_obj.get("description") or ""),
        policy_methods="\n".join(policy_methods_lines),
        metric_attrs="\n".join(metric_attr_lines),
        base_class_interface="\n".join(base_lines) or "  (unavailable)",
        entity_code=entity_code[:8000],
    )
```

#### 3b. New stage function — `code_gen_runner.py`

Add before `_stage_state2v_validate_protocol` (around line 757):

```python
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

    for entry in iterations:
        ctx.raise_if_cancelled()
        entity_id = str(entry["iterId"])
        payload = checkpoints.load_iteration(ctx.job_id, "state2_code_entity_object", entity_id)
        if not isinstance(payload, dict) or not payload.get("code"):
            results.append({"entity_id": entity_id, "skipped": True})
            continue

        current_code = str(payload["code"])
        entity_obj = entity_map.get(entity_id, {"id": entity_id})
        attempts: list[dict] = []
        passed = True

        ctx.emit_stage_message("state2j_entity_judge", f"state2j: judging {entity_id}")

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
                # Re-generate entity code with issues as retry_error context
                issues_text = "\n".join(
                    f"- [{i.get('severity')}] {i.get('location')}: {i.get('description')} → {i.get('suggested_fix', '')}"
                    for i in issues
                )
                # Build regeneration prompt reusing state2 builder with retry_error
                regen_prompt = prompts.build_state2_entity_prompt(
                    entity_id=entity_id,
                    entity_obj=entity_obj,
                    accumulator_blob=current_code,
                    causal_data=str(ctx.inputs.get("causalData") or ""),
                    interface_digest={},
                    policy_outline=policy_outline,
                    selected_metrics=selected_metrics,
                    retry_error=issues_text,
                    omit_cached_context=True,
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

        # Persist the final (possibly improved) entity code back to checkpoint
        if current_code != str(payload.get("code", "")):
            updated_payload = dict(payload)
            updated_payload["code"] = current_code
            checkpoints.save_iteration(ctx.job_id, "state2_code_entity_object", entity_id, updated_payload)

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
```

#### 3c. Register stage — `code_gen_checkpoints.py` and `code_gen_runner.py`

In `code_gen_checkpoints.py`, insert `"state2j_entity_judge"` into `STAGE_ORDER` and `ITERATIVE_STAGES`:

```python
STAGE_ORDER: tuple[str, ...] = (
    "state1_entity_list",
    "state1b_policy_outline",
    "state1c_entity_dependencies",
    "state1d_metrics_draft",
    "state2_code_entity_object",
    "state2v_validate_protocol",
    "state2j_entity_judge",          # ← insert here
    "state3_code_environment",
    "state4_code_policy",
    "state4v_validate_policy",
    "state5_policy_verify",
    "finalize_bundle",
)

ITERATIVE_STAGES: frozenset[str] = frozenset(
    {"state2_code_entity_object", "state2j_entity_judge", "state4_code_policy", "state5_policy_verify"}
)
```

In `code_gen_runner.py`, register (near line 1486):
```python
STAGE_REGISTRY["state2j_entity_judge"] = _stage_state2j_entity_judge
```

---

### Verification after implementation

1. Regenerate bundle from existing job (or new job)
2. Run sim, check `metrics.jsonl` — all 6 metrics should have rows
3. Confirm `entity_interactions.txt` shows policy-driven state changes (e.g. `recorded_collection_data` grows, `received_ewaste_weight` increases)
4. Check `state2j_entity_judge` checkpoint exists in `data/code_gen_jobs/<job_id>/`
