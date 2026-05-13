# Simulation Failure Report: explicit_25pro

**Experiment path:** `Experiment/code_generation/entity_design/enitiy_code_verification/explicit_25pro`
**Job ID:** `code_gen-ed2dccc75ded444ab9141842ed8bbc3a`
**Run analyzed:** `sim-91f8b996fbc3`
**Report date:** 2026-05-11

---

## Summary

The simulation crashes on the first tick. 12 of 18 entity files contain LLM generation artifacts (markdown fences, error-correction prefixes) that make them unparseable Python. One policy calls a non-existent environment method. The policy verifier also recorded 15/27 policy failures that exhausted their retry budget.

---

## Issue 1 — Entity files corrupted with LLM artifacts (12 files)

**Severity:** Critical — simulation cannot start

The code-gen pipeline did not strip LLM output prefixes before saving entity files. Files begin with error messages, correction reasoning, or markdown code fences (`\`\`\`python`) instead of valid Python.

### Pattern A — `invalid syntax (line 1)`: LLM retry prefix before code fence

File starts with free-text LLM output. Python fails immediately.

| File | Prefix content |
|------|---------------|
| `entities/entity-228-garbage-truck.py` | `An exception occurred during generation. Re-running the pipeline.` |
| `entities/entity-341-the-lab.py` | `An error was detected in the previous attempt. The act method signature...` |
| `entities/entity-canonical-13-department.py` | `An error was detected in a previous attempt. The following corrections...` |
| `entities/entity-canonical-14-bin.py` | `An error was detected in the previous attempt. The following corrections...` |
| `entities/entity-canonical-31-junk-shop.py` | Correction note containing `→` (U+2192) Unicode arrow |
| `entities/the_mirror_foundation.py` | Correction note containing `→` (U+2192) Unicode arrow |

### Pattern B — `unterminated string literal`: LLM backtick-quoted text parsed as Python string

File starts with LLM bullet-point reasoning. The backtick-quoted identifiers (e.g., `` `entity-canonical-0-waste` ``) trigger Python 3.12+ tokenizer error.

| File | Error location |
|------|---------------|
| `entities/entity-canonical-0-waste.py` | Line 4 — backtick in reasoning text |
| `entities/entity-canonical-22-building.py` | Line 12 — backtick in correction notes |
| `entities/entity-canonical-32-sorting-plant.py` | Line 8 — backtick in correction notes |
| `entities/sorter.py` | Line 5 — backtick in correction notes |
| `entities/entity-37-garbage-buffer.py` | Code fence in description block |

### Pattern C — Truncated generation, no recoverable code

| File | Content | Root cause |
|------|---------|------------|
| `entities/entity-canonical-15-bma.py` | `from entity_object_template import entity_object\nAn exception occurred when generating the response. Please try again.` | API call failed mid-stream; only 2 lines written |

**Fix applied:** Strip all LLM prefix artifacts; extract valid Python code starting at the first `from`/`import` statement after the last ` ```python ` fence. BMA entity reconstructed from interaction log (`checkpoints/interaction_log.jsonl`) with required base class method stubs added.

---

## Issue 2 — Policy calls non-existent environment method (runtime crash)

**Severity:** Critical — crashes tick 1

`policies/department_requests_special_collection_for_unusual_trash.py` line 33:
```python
all_entities = env.get_all_entities()  # AttributeError: no such method
```

`Environment` exposes `get_entities_by_type(type_name: str)` — not `get_all_entities()`.

**Fix applied:** Replaced with two typed lookups:
```python
departments = env.get_entities_by_type('Entity_Department')
all_bins = env.get_entities_by_type('Entity_Bin')
```

---

## Issue 3 — Policy verifier: 15/27 policies failed after 3 attempts

**Severity:** High — generated policies have logic errors; simulation runs but behaviors are wrong

Policy judge ran 3 fix attempts per policy. 15 policies exhausted retries without passing. Root causes cluster into four recurring patterns:

### 3a. Entity API violations (direct attribute access instead of method calls)
Policies modify entity internal state directly (e.g., `bin.current_load_kg -= x`) instead of calling the entity's public methods. This breaks encapsulation and can cause inconsistent entity state.

Affected: `garbage_buffer_stores_overflow_waste`

### 3b. Environment API misuse
Policies call methods that exist only partially or not at all on the environment:
- `env.get_bins_in_location()` — exists, but policies combine it with `get_all_entities()` in the same block
- `env.get_entities_by_type()` called with wrong type string vs. actual class name

Affected: `department_requests_bma_collection_for_excess_waste`, `department_sets_up_event_sorting_stations`, and 5 others

### 3c. Runtime `TYPE_CHECKING` imports
Entity classes imported inside `if TYPE_CHECKING:` block. Available to mypy/pyright but **not at runtime**. `isinstance()` checks using these imports cause `NameError`.

Affected: `department_requests_bma_collection_for_excess_waste` and others

### 3d. Unknown entity class names
Policies call `env.get_entities_by_type("Entity_Department")` while the actual registered class name may differ. This returns empty lists silently, making the policy a no-op.

Affected: `department_sets_up_event_sorting_stations`

### Failed policies list

| Policy | Final failure reason |
|--------|---------------------|
| `garbage_buffer_stores_overflow_waste` | `Entity_Bin` has no `remove_waste` method |
| `department_sets_up_event_sorting_stations` | Wrong entity type string; `setup_event_sorting_stations()` arg mismatch |
| `department_requests_bma_collection_for_excess_waste` | `TYPE_CHECKING`-gated imports; type string mismatch |
| `waste_diverts_food_scraps_to_geese` | Unknown |
| `waste_sends_toxic_waste_to_company` | Unknown |
| `waste_sends_food_scraps_to_bma` | Unknown |
| `junk_shop_collects_departmental_recyclables` | `collect_and_record_departmental_recyclables` needs `env` param |
| `waste_sends_usable_ewaste_to_mirror_foundation` | Unknown |
| `waste_collector_processes_internal_waste` | Unknown |
| `garbage_truck_transports_waste_to_sorting_plant` | Unknown |
| `sorter_compacts_unsortable_waste` | Unknown |
| `students_complain_about_overflowing_waste` | Unknown |
| `department_schedules_large_item_pickup` | Unknown |
| `waste_attracts_pests_in_office` | Unknown |
| `environment_makes_rules_important_after_incident` | Unknown |

**Note:** Root causes for policies marked "Unknown" are in `checkpoints/state5_policy_verify.json`. Not all 15 were analyzed exhaustively in this report.

---

## Issue 4 — Entity judge: 9/18 entity validations failed

**Severity:** Medium — entities missing required base class method implementations

| Entity | Failure type |
|--------|-------------|
| `entity-canonical-15-bma` | Missing: `add_policy`, `remove_policy`, `get_policies`, `apply_policies`, `perceive`, `decide_action`, `act`, `get_status`, `on_interact` |
| Others (8) | Various method signature mismatches (see `checkpoints/state2j_entity_judge.json`) |

---

## Fixes Applied

| # | Target | Action |
|---|--------|--------|
| 1 | 11 entity files with LLM prefix | Stripped prefix; extracted Python code after last ` ```python ` fence |
| 2 | `entity-canonical-15-bma.py` | Reconstructed from `interaction_log.jsonl`; added base class method stubs |
| 3 | `department_requests_special_collection_for_unusual_trash.py` | Replaced `get_all_entities()` with two `get_entities_by_type()` calls |

Fixes in Issue 3 (policy logic errors) are **not applied** — they require regeneration or manual correction per policy contract.

---

## Root Cause

The code-gen pipeline's entity generation stage uses a retry loop with LLM correction feedback. When a retry is triggered, the LLM response includes the correction reasoning in natural language before the code block. The pipeline saved the raw LLM response string directly to disk instead of extracting only the fenced code block. Additionally, when the API call fails mid-stream (BMA entity), the partial response (one import line + error message) was written as-is.
