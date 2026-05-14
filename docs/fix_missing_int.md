# Fix: Missing Interface & Pipeline Accuracy Improvements

**Date:** 2026-05-14  
**Scope:** `code_gen_prompts.py`, `code_gen_runner.py`, `environment_template.py`, `code-gen-api-client.ts`, `code-gen-stage-log-panel.tsx`  
**Root cause source:** `Experiment/code_generation/simulation_failed_report/explicit_rerun_inaccurate.md`

---

## Problem Summary

Explicit pipeline rerun produced **8/18 entity failures** and **12/24 policy failures** after 3 attempts. Five root causes were identified.

| RC | Name | Impact |
|----|------|--------|
| RC-1 | Contract interface gap — no observable state defined | Entity and policy generators guess different `on_query` key names each attempt |
| RC-2 | Param-less contract contradicts semantic requirement | Fix makes method syntactically compliant but semantically broken |
| RC-3 | Isolated fix pipelines — no cross-component coordination | Correct policy fix fails because entity never implements required `on_query` |
| RC-4 | Syntax error blocks all verification | Attempt budget wasted on unfixable issues while parse error persists |
| RC-5 | Multi-issue stacking + non-additive regen exhausts budget | 3 attempts insufficient when N≥3 independent issues exist; regen can regress fixed issues |

Two additional structural issues were identified in follow-up analysis:

| Issue | Name | Impact |
|-------|------|--------|
| Issue-6 | Missing env API methods | Policies fail at runtime calling `env.get_entities_by_type()` / `env.get_entities_at()` which didn't exist |
| Issue-7 | Canonical name confusion | Policies pass Python class objects to `get_entities_by_type()` instead of canonical string ids |
| Issue-8 | Dependency-unaware judge | Fix budget spent on entities/policies whose dependencies already failed verification |
| Issue-9 | Silent contract gaps at State 1b | Broken mechanisms dropped without warning; missing mediating entities not flagged |

---

## Fix 1 — Syntax-first judge priority (RC-4)

**File:** `engine/backend/app/services/code_gen_prompts.py`  
**Templates modified:** `_ENTITY_JUDGE_TEMPLATE`, `_JUDGE_PASS1_TEMPLATE`

Added explicit priority rule to both judge prompt templates:

```
PRIORITY RULE: If the code has ANY syntax error (SyntaxError, unfinished string,
missing colon, etc.), report ONLY that syntax error. Do NOT report other issues —
they cannot be verified until the file parses. Set verdict="fail" with issues
containing only the syntax error.
```

**Effect:** Attempt 1 budget clears parse error. Attempts 2-3 have working file to inspect. Previously the judge reported all N issues simultaneously; the fixer tried to fix all at once and often missed the syntax error, blocking subsequent attempts.

**Affected failures fixed:** `entity-canonical-16-organization` (unfinished string literal), `entity-canonical-3-truck` (missing method body).

---

## Fix 2 — `on_query` contract in policy outline (RC-1, RC-3)

**File:** `engine/backend/app/services/code_gen_prompts.py`  
**Schema modified:** `STATE1B_POLICY_OUTLINE_SCHEMA`, `STATE1B_POLICY_OUTLINE_SCHEMA_TEXT`

Added two fields to the policy outline schema:

```json
{
  "observable_via": "attribute|on_query|method_return|none",
  "observable_key": "string (exact attr name or on_query key)"
}
```

**Prompt instruction added:**
> If the policy READS state from the target entity, specify `observable_via` and `observable_key`. If entity exposes state via `on_query()`, set `observable_via="on_query"` and `observable_key=<exact key string>`.

**Runner:** `_stage_state1b_policy_outline` now preserves `observable_via` / `observable_key` in cleaned policy records.

**Effect:** Both entity generator (State 2) and entity judge (State 2j) receive the same `on_query` key. No more independent guessing across 3 attempts. The `_extract_on_query_keys()` helper extracts these keys and feeds them into both `_ENTITY_JUDGE_TEMPLATE` and `_ENTITY_JUDGE_FIX_TEMPLATE`.

**Affected failures fixed:** `waste_collector` / `handle_overflow_complaints` cross-dependency (Case Study A).

---

## Fix 3 — Policy methods in entity fix prompt (RC-3)

**File:** `engine/backend/app/services/code_gen_prompts.py`  
**Function modified:** `build_entity_judge_fix_prompt`, `_ENTITY_JUDGE_FIX_TEMPLATE`

`build_entity_judge_fix_prompt` now accepts `policy_outline` and `entity_id` parameters (both optional for backward compatibility). The fix prompt now includes:

- **Policy methods this entity must expose** (which policies call what method)
- **`on_query` keys this entity must return** (derived from `observable_key` fields)
- **Issue ordering:** syntax errors sorted to top so fixer clears parse blocker first

**Runner:** Call site in `_stage_state2j_entity_judge` passes `policy_outline=policy_outline, entity_id=entity_id`.

**Effect:** Fixer no longer operates blind to policy contracts. When judge says "missing `on_query`", fixer prompt tells it exactly which keys to implement.

---

## Fix 4 — LLM crash detection (RC-5)

**File:** `engine/backend/app/services/code_gen_runner.py`

Added `_is_llm_crash(text: str) -> bool` helper detecting error strings instead of code:

```python
_LLM_CRASH_PATTERNS = (
    "An internal error occurred",
    "Please try again",
    "I'm sorry, I encountered",
    "I apologize",
    "[INTERNAL]",
)
```

Both `_stage_state2j_entity_judge` and `_stage_state5_policy_verify` judge→fix loops now check for crashes before decrementing the verify budget. Crashes get up to 2 retries (separate `crash_retries_remaining` counter) without consuming attempt budget.

**Effect:** Waste collector attempt 2 returned `"An internal error occurred."` — this burned an attempt and left only 1 attempt for remaining issues. Crash detection prevents this.

**New attempt statuses:** `fix_failed_crash` (crash retry budget exhausted without code produced).

---

## Fix 5 — Contract-violation verdict + early exit (RC-2)

**File:** `engine/backend/app/services/code_gen_prompts.py`, `code_gen_runner.py`

Judge prompts now recognize that some fixes are architecturally impossible (e.g. removing params satisfies type checker but makes method non-functional). Both entity and policy judge loops check for `severity == "contract_violation"` issues:

```python
contract_violations = [i for i in issues if i.get("severity") == "contract_violation"]
if contract_violations:
    attempt_record["status"] = "contract_gap"
    passed = False
    # break immediately — don't waste remaining budget
```

**Effect:** Stops burning 2 more fix attempts on a structurally broken contract. Logs the gap for manual review. Does not fail the entire pipeline — other entities/policies continue.

**New attempt status:** `contract_gap`.

**Affected failures:** `junk_shop` (`collect_and_record_department_recyclables()` forbidden params), `entity-263-n15` (`receive_waste_for_fuel()` param contradiction).

---

## Fix 6 — Environment API surface (Issue-6)

**File:** `engine/backend/app/services/templates/environment_template.py`

Added two methods to `SimulationEnvironment`:

```python
def get_entities_by_type(self, type_name: str) -> list:
    """type_name is canonical string id e.g. 'entity-canonical-0-waste'"""

def get_entities_at(self, location_id: str) -> list:
    """Entities whose location_id or current_location matches location_id"""
```

**File:** `code_gen_prompts.py` → `build_state4_policy_prompt`

Added `entity_api_section` always included in policy prompt (regardless of map availability):

```
Entity lookup API (call these on the `env` parameter):
  env.entities → list of all entity instances
  env.get_entities_by_type(type_name: str) → list
  env.get_entities_at(location_id: str) → list
  env.get_entity_object(entity_object_id: str) → entity or None
```

**Affected failures fixed:** `dispose_of_unusable_materials`, `insufficient_sorter_capacity`, `missed_collection_due_to_timing`, `send_e_waste_to_mirror_foundation`, `send_waste_to_n15`.

---

## Fix 7 — Canonical name guidance (Issue-7)

**Files:** `code_gen_prompts.py` → `_JUDGE_PASS1_TEMPLATE`, `entity_api_section`

Added canonical name rule to both the policy judge prompt and the entity API section in policy generation prompt:

```
CANONICAL NAME RULE: get_entities_by_type() requires a canonical entity id STRING
(e.g. 'entity-canonical-0-waste', 'entity-canonical-5-pest', 'entity-canonical-14-event'),
NOT a Python class object like Entity_Waste or Entity_Pest.
```

**Affected failures fixed:** `request_special_collection_for_event_waste` (`'Entity_Event'` → `'entity-canonical-14-event'`), `send_waste_to_n15`, `send_e_waste_to_mirror_foundation`.

---

## Fix 8 — Dependency-aware judge gate (Issue-8)

**File:** `engine/backend/app/services/code_gen_runner.py`

### Entity judge (`state2j_entity_judge`)

New helper `_broken_dependencies(entity_id, dep_edges, judge_results_map)` checks state1c dependency edges. Before spending any LLM budget on an entity, the runner checks if its dependencies already failed:

```python
broken_deps = _broken_dependencies(entity_id, dep_edges, judge_results_map)
if broken_deps:
    # mark dependency_blocked, skip judge loop
```

The `judge_results_map` is built progressively as each entity is judged (in topological order, which state1c already provides). Dependency check only fires on deps already evaluated.

### Policy verify (`state5_policy_verify`)

New helper `_policy_target_entity_broken(rule_contract, state2j_results_map)` checks if the policy's `target_entity_id` failed state2j. If yes, policy is marked `dependency_blocked` without running the judge.

**New stage output fields:** `depBlockedCount` in both `state2j_entity_judge` and `state5_policy_verify` results.

**New record status:** `dependency_blocked` with `blocked_by: [entity_id_list]`.

**Effect:** `handle_overflow_complaints` will be correctly marked `dependency_blocked` because `waste_collector` (target entity) failed — instead of running 3 policy judge attempts that would all fail for the same root cause.

---

## Fix 9 — Contract completeness check in State 1b (Issue-9)

**File:** `engine/backend/app/services/code_gen_prompts.py`, `code_gen_runner.py`

### New schema fields

Per-policy: `contract_warning` (string describing what is missing or contradictory).  
Top-level: `missing_entities[]` with `suggested_id`, `role`, `needed_by_rules`, `reason`.

### New prompt instruction (3-point completeness check)

For every mechanism extracted from causal data:

1. Does `target_method` need params but contract forbids them? → emit `contract_warning`
2. Does policy read entity state but no exposure mechanism specified? → set `observable_via/observable_key` or emit `contract_warning`
3. Does mechanism require a data-holder entity not in the entity list? → emit `missing_entities[]` entry + `contract_warning`

> Do NOT silently drop mechanisms with gaps — emit them with warnings so the code generator knows upfront that manual intervention may be needed.

### Runner changes

`_stage_state1b_policy_outline` now:
- Preserves `contract_warning` per policy record
- Collects and validates `missing_entities[]`
- Logs warnings at `WARNING` level
- Returns `missingEntities` and `contractWarnings` in stage payload

**Effect:** Contract gaps are now visible at State 1b (before any code is generated) rather than discovered at attempt 3 of State 2j. Human can review and fix the entity design or contract before wasting LLM budget.

---

## Frontend Changes

### `code-gen-api-client.ts`

- `CodeGenPolicyOutline` extended: `observable_via?`, `observable_key?`, `contract_warning?`
- New type `CodeGenMissingEntity`
- `CodeGenPreviewResult` extended: `missingEntities?`, `contractWarnings?`
- New type `CodeGenJudgeResult` for `state2j`/`state5` result items with `dependency_blocked` / `contract_gap` / `fix_failed_crash` statuses

### `code-gen-stage-log-panel.tsx`

- `PolicyConfirmBlock`: shows amber warning badge on policies with `contract_warning`
- `PolicyConfirmBlock`: shows `missingEntities` section when present in checkpoint data
- Stage descriptions updated for `state2j_entity_judge` and `state5_policy_verify` to mention new statuses (`dependency_blocked`, `contract_gap`)

---

## Attempt Budget Accounting (after fixes)

| Status | Budget consumed? | Meaning |
|--------|-----------------|---------|
| `pass` | Yes (final) | No issues |
| `fixed_and_retry` | Yes | Fix applied, retry needed |
| `fail` | Yes (final) | Budget exhausted, issues remain |
| `contract_gap` | Yes (final, 1 attempt) | Unfixable without contract change |
| `fix_failed_crash` | No (crash retries used) | LLM returned error, not code |
| `fix_failed` | Yes (final) | Fix returned empty string |
| `dependency_blocked` | **No budget spent** | Dependency entity failed — skip |

---

## Files Changed

| File | Change type |
|------|-------------|
| `engine/backend/app/services/code_gen_prompts.py` | Prompt templates, schemas, builders |
| `engine/backend/app/services/code_gen_runner.py` | Pipeline logic, judge loops, state1b cleanup |
| `engine/backend/app/services/templates/environment_template.py` | New env API methods |
| `engine/web-ui/src/lib/code-gen-api-client.ts` | Type extensions |
| `engine/web-ui/src/app/code/code-gen-stage-log-panel.tsx` | Contract warning UI |
