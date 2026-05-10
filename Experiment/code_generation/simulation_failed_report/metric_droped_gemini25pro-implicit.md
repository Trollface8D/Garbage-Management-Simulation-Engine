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

`state5_policy_verify` currently runs max 3 attempts per policy (1 judge + 2 fix retries). Observed issues:
- **22% of policies fail pass 1** (have concrete bugs identified by the judge)
- After the 2 fix retries, some policies still have residual suggested fixes — meaning the 3-attempt cap cuts off before convergence

This matters for metrics because: if a policy has bugs and fails to execute correctly, the entity state it was supposed to update never changes → `policy_fired` metric values stay flat zero even after RC-1 and RC-2 are fixed.

**Increasing attempts from 3 to 4 or 5 would likely reduce the residual fail rate** for the 22% that currently exit with unresolved issues. This is a low-effort change with direct impact on metric data quality.

However, more `state5` iterations still do not fix RC-1, RC-2, or RC-3. They address a separate but related problem: **correct policy execution is a prerequisite for metric data to exist**.

---

### Entity-level judge (new proposal): `state2j_entity_judge`

Currently entity code has no LLM judge — `state2v_validate_protocol` only checks whether prior generation validation errors existed (syntax/schema). It does not review entity logic, method signatures, or metric attr correctness.

The 22% policy fail rate in `state5` is partly caused by **entity code defects**: policies call entity methods that exist but have wrong signatures, missing return values, or incorrect attribute names. The policy judge catches these at policy review time, but the entity code has already been written and frozen.

**Proposed: add `state2j_entity_judge` after `state2v_validate_protocol`**, mirroring the `state5` judge pattern:

- **Pass 1**: LLM reviews each entity class against:
  - Method signatures required by policy outline (`state1b`)
  - Metric attr accessibility required by metric contracts (`state1d`) — checks that the attr exists, is readable, and if it's a collection, is reducible (e.g. list of dicts with a numeric field)
  - Base class compliance (`entity_object_template.py`)
- **Pass 2**: If issues found, LLM fixes the entity code (same fix-retry pattern as `state5`)
- **Max attempts**: same 3-attempt cap, but can be tuned independently

This would catch:
- Wrong method signatures that cause policy execution errors (reduce the upstream cause of the 22%)
- Non-reducible metric attrs before `finalize_bundle` (RC-3 prevention at source)
- Missing `step()` / `on_query()` overrides

**Reuse existing infrastructure**: `_JUDGE_PASS1_TEMPLATE` and `_JUDGE_PASS2_TEMPLATE` in `code_gen_prompts.py` can be adapted. The entity judge prompt would swap policy contract → entity contract (from `state1` entity list + metric requirements).

---

### `state2vm_validate_metric_attrs` — with auto-fix

Add deterministic validation after `state2j_entity_judge` (or independently after `state2v`):

```python
# Pseudo-code
for metric in selected_metrics:
    entity_code = load_entity_artifact(metric["entity_id"])
    for dep in metric["required_attrs"]:
        attr = dep["attr"]
        inferred_type = static_infer_attr_type(entity_code, attr)
        if not is_reporter_reducible(inferred_type):
            # Auto-fix: prompt LLM to add scalar summary attr alongside the collection
            fixed_code = llm_add_scalar_summary(entity_code, attr, metric)
            write_entity_artifact(metric["entity_id"], fixed_code)
            # Update metric contract to reference new scalar attr name
            update_metric_contract_attr(metric["name"], dep["entity"], new_attr_name)
```

"Reporter-reducible" means: `int`, `float`, `bool`, or `List[Dict]` where at least one key has a numeric type (detectable by scanning `__init__` assignments or the `append()` call shape). If reducible, pass. If not reducible (e.g. pure string list, nested dict of unknown shape), trigger auto-fix.

This is deterministic (AST parse, no LLM) for detection, LLM only for the fix. Would have prevented RC-3 entirely.

---

## Summary Table

| Root Cause | Pipeline Stage | Prompt Fix? | More Loops Help? | Recommended Fix |
|------------|---------------|------------|-----------------|-----------------|
| Policies not loaded in run harness | `finalize_bundle` / `RUN_PY` template | No | No | Fix `codegen_runtime_assets.py` template |
| `policy_fired` silently skipped | `finalize_bundle` / `REPORTER_PY` template | No | No | Fix `codegen_runtime_assets.py` template |
| `List[Dict]` not reducible to float | `REPORTER_PY` `_read_attr` | No (collection restriction wrong) | No | Extend `_read_attr` in template to reduce `List[Dict]` |
| Policy bugs cause entity state to never update | `state5_policy_verify` | No — loop count | **Yes — increase attempts 3→5** | Raise attempt cap; also add `state2j_entity_judge` to fix upstream entity defects |
| No entity-level logic review | Missing stage | New prompt needed | New loop | Add `state2j_entity_judge` (LLM judge+fix, mirrors `state5` pattern) |
| Non-reducible metric attrs reach `finalize_bundle` | Missing stage | No | No | Add `state2vm_validate_metric_attrs` (deterministic detect + LLM auto-fix) |

---

## Severity

All three causes compound: even if RC-1 were fixed (policies fire), RC-2 would still silence both metrics. Even if RC-1 + RC-2 were fixed, RC-3 would silence `departmental_recycling_volume` specifically. All three must be addressed for full metric coverage.

The failure is **silent** — no exception, no warning in the run log. `metrics.jsonl` is valid JSONL with correct headers; the missing metrics simply produce no rows. This makes the failure invisible without a post-run metric coverage check.

**Recommended addition to pipeline:** After every sim run, assert `len(recorded_metric_names) == len(contracted_metric_names)`. Emit a warning (or fail the run artifact) if any contracted metric produced zero rows.
