# Failure Report: explicit rerun (code_gen-ad4e95932011492799926e16c0b01fb9)

**Job ID:** `code_gen-ad4e95932011492799926e16c0b01fb9`
**Model:** `gemini-2.5-pro`
**Max verify attempts:** 3
**Report date:** 2026-05-13
**Verified stages:** `state2j_entity_judge`, `state5_policy_verify`

---

## Summary

Entity verification: **8/18 failed** after 3 attempts.
Policy verification: **12/24 failed** after 3 attempts.

Neither stage shares fix state with the other. Both ran with the same 3-attempt budget. Failures cluster into five root cause categories that compound each other.

---

## Stage 1 — Entity Verification Failures (8/18)

| Entity | Final issues | Why fix failed |
|--------|-------------|----------------|
| `entity-263-n15` | `receive_waste_for_fuel()` contract forbids params; `on_query` missing | Method semantically broken without params; `on_query` never added across all 3 attempts |
| `entity-37-garbage-buffer` | `store_overflow_waste(waste)` wrong sig; `emit_negative_effects(odor)` wrong sig; 7 base-class methods missing | Too many simultaneous issues; 3 attempts not enough to fix all |
| `entity-canonical-12-location` | `decide_action` empty body; missing `act`; missing `on_interact` | All stubs — technically trivial but patcheone-per-attempt, budget exhausted |
| `entity-canonical-16-organization` | `make_fertilizer` syntax error (unfinished string literal); missing `address_overflow_complaint`, `schedule_special_pickup`, `on_query` | Syntax error prevents file from loading → all other fixes irrelevant until cleared first; never cleared |
| `entity-canonical-3-truck` | 7 base-class methods missing; `on_query` body empty (syntax error) | Syntax error blocks parsing; missing methods too many for 3 attempts |
| `junk_shop` | `collect_and_record_department_recyclables(self, env)` — contract says `()` | Removing `env` param makes signature compliant but method can't function without env access; contract is contradictory |
| `mirror_foundation` | Public attributes `total_e_waste_received_kg`, `total_parts_reused_kg` violate no-metrics contract | Rename to private requires updating all internal refs; partial rename introduced AttributeError |
| `waste_collector` | `report_overflow_to_management(location_id, overflow_level)` wrong sig; `on_query` missing; extra metric attribute | Attempt 2 returned LLM error string (not code) — wasted attempt; attempt 3 still missing `on_query` |

---

## Stage 2 — Policy Verification Failures (12/24)

| Policy | Root cause category | Final blocker |
|--------|--------------------|-|
| `buffer_stores_overflow_waste` | Wrong initiator type | `initiator=self` (policy) not changed to `initiator=buffer_entity` cleanly |
| `compress_unsortable_waste` | Multi-bug + env API | No status filter; wrong trigger location; unverified compactor methods — 3 bugs, 3 attempts |
| `dispose_of_unusable_materials` | Env API missing | `env.entities` attribute does not exist; no entity query method in env API |
| `feed_geese_with_food_scraps` | Regen regression + API type | Attempt 2 regen moved logic to `after_tick`, left `apply` empty; `get_entities_by_type(class_obj)` should be string |
| `handle_overflow_complaints` | Cross-dependency (entity) | `collector.on_query("overflow_report_count")` — method never implemented on `waste_collector` entity |
| `insufficient_sorter_capacity` | Env API missing | `env.get_entities_at(loc_id)` not in env API |
| `missed_collection_due_to_timing` | Env API missing + wrong lifecycle hook | `env.get_entity_class()` not in API; logic in `after_tick` instead of `apply` |
| `office_waste_attracts_pests` | Entity interface incomplete | `pest_entity.infest_area()` takes no params — fix drops location context, entity interface is broken |
| `request_special_collection_for_event_waste` | Wrong canonical name | `'Entity_Event'` used; framework registry uses `'entity-canonical-14-event'` |
| `schedule_large_waste_pickup` | Naming convention + memory leak | Class named `Entity_ScheduleLarge...` — wrong prefix, framework won't discover; `processed_waste_ids` grows indefinitely |
| `send_e_waste_to_mirror_foundation` | API type mismatch | `env.get_entities_by_type(class_obj)` — should pass canonical string `'entity-canonical-0-waste'` |
| `send_waste_to_n15` | Wrong canonical name + keyword arg | `'Entity_Waste'` not canonical name; `receive_waste_for_fuel(waste_items=...)` keyword arg may not match signature |

---

## Root Cause Analysis

### RC-1: Contract Interface Gap — Missing Observable State

Entity contract defines an action method but does not specify how state is exposed (no attribute, no `on_query`, nothing documented). Both entity and policy generators guess independently. They guess different names each attempt and never converge.

**Affected:** `waste_collector` / `handle_overflow_complaints` (see Case Study A)

---

### RC-2: Param-less Contract Contradicts Semantic Requirement

Contract specifies `method()` with no arguments, but the method requires input data to function. Removing params satisfies the type checker but leaves the method unable to do anything meaningful. Fix is architecturally impossible without changing the contract.

**Affected entities:**
- `entity-263-n15`: `receive_waste_for_fuel()` needs waste list
- `junk_shop`: `collect_and_record_department_recyclables()` needs env
- `waste_collector`: `report_overflow_to_management()` needs location + severity

---

### RC-3: Isolated Fix Pipelines — No Cross-Component Coordination

Entity fixer and policy fixer run as independent pipelines with no shared fix state. When policy judge says "entity must implement X," that instruction goes nowhere. When entity judge says "add method Y," policy fixer never knows it was added.

Result: policy can reach the correct fix while the entity remains broken. Both fail.

**Example:** `handle_overflow_complaints` attempt 3 correctly called `on_query("overflow_report_count")`. `waste_collector` never implemented `on_query`. Policy fix was correct; entity fix was not. Both recorded as failed.

---

### RC-4: Syntax Error Blocks All Verification

A file with an unfinished string literal or missing method body fails to parse. Every subsequent fix attempt on other issues in the same file is irrelevant until the parse error is cleared. If each attempt fixes a different issue but the syntax error is never prioritized first, the entity never loads.

**Affected:**
- `entity-canonical-16-organization`: `make_fertilizer` ends mid-string: `kwargs.get('tree_scraps', ['`
- `entity-canonical-3-truck`: `on_query` definition with no body

---

### RC-5: Multi-Issue Stacking Exhausts Attempt Budget

Judge patches issues one-per-attempt. Entities or policies with N≥3 simultaneous independent issues need N attempts minimum just to address them sequentially — no budget left for regressions or co-dependent fixes.

Additionally, regen is not additive. A regen in attempt K may correctly fix issue A from attempt K-1 while reintroducing issue B that was fixed in attempt K-2. Each regen starts from a fresh generation, not from a cumulative diff.

**Affected:** `entity-37-garbage-buffer` (9 issues), `entity-canonical-3-truck` (8 issues), `compress_unsortable_waste` (3 simultaneous logic issues), `feed_geese_with_food_scraps` (regen regression)

---

## Case Study A: Cross-Dependency Failure (`handle_overflow_complaints` + `waste_collector`)

### What should happen

Policy detects when `waste_collector` has received overflow complaints → triggers management response.

### What happened — entity side

| Attempt | Status | Issue |
|---------|--------|-------|
| 1 | `fixed_and_retry` | Wrong method signatures + 5 missing base-class methods |
| 2 | `fixed_and_retry` | **LLM returned error string, not code** — `"An internal error occurred. Please try again."` |
| 3 | `fail` | Same signature bug persisted + `on_query` still missing |

Attempt 2 burned an attempt budget on a generation crash. Attempt 3 only had one shot for remaining issues and still missed `on_query`.

### What happened — policy side

| Attempt | Access tried | Why it failed |
|---------|-------------|--------------|
| 1 | `getattr(collector, 'total_overflow_reports_made', 0)` | Attribute not in interface; `getattr` silently returns 0; condition never true |
| 2 | `getattr(collector, 'overflow_report_count', 0)` | Same failure mode, different attribute name guess |
| 3 | `collector.on_query("overflow_report_count")` | `on_query` not defined on `Entity_WasteCollector` |

### Why fix was impossible

Policy attempt 3 had the correct final answer. It failed only because the entity never implemented `on_query`. The two fix pipelines were independent — the policy's correct conclusion never informed the entity fixer.

Additionally the contract itself had no specification for how complaint count should be exposed: no attribute name, no `on_query` documented. Both generators guessed different names every attempt.

```
Entity contract: specifies report_overflow_to_management() with no observable output
                 no on_query documented
        │
        ├── Entity fixer (independent):  guesses / crashes / misses on_query
        │
        └── Policy fixer (independent):  guesses 3 different access paths
                                          reaches correct answer (on_query) at attempt 3
                                          entity still broken → BOTH FAIL
```

---

## Case Study B: Regen Regression (`feed_geese_with_food_scraps`)

### Attempt progression

| Attempt | Issue fixed | New issue introduced |
|---------|-------------|---------------------|
| 1 | Filter missing `'vegetable_waste'` | — |
| 2 | (tried to handle undocumented entity method) | Regen moved all logic to `after_tick`; left `apply` empty |
| 3 | — | `after_tick` architecture wrong (should be `apply`); `get_entities_by_type(class_obj)` should be string — budget exhausted |

### Root cause

Attempt 2 could not satisfy the judge's instruction ("entity must expose `feed_geese_with_scraps` — provide the interface"). This is outside policy scope. The generator regenerated anyway and introduced a new architectural error: logic in `after_tick` instead of `apply`, which means the policy never fires on its declared trigger (`waste generated`). Attempt 3 correctly identified both remaining issues but the budget was gone.

**Pattern:** Unactionable fix instruction → blind regen → regression introduced → budget exhausted.

---

## Cross-Cutting Pattern

```
Contract gap (no observable state defined)
    │
    ├─► Entity never implements exposure mechanism
    │       │
    │       └─► Policy guesses access path each attempt, never converges
    │
    ├─► Isolated pipelines → correct policy fix never coordinates with entity fix
    │
    ├─► Param-less contract → method semantically broken after signature fix
    │
    ├─► LLM crash → wasted attempt → multi-issue entity runs out of budget
    │
    └─► Multi-issue stacking + non-additive regen → 3 attempts not enough
```

**Single-sentence root cause:** Underspecified contracts leave observable state ambiguous; isolated pipelines prevent entity-policy coordination; param-less signatures make logic-level fixes impossible; LLM crashes and multi-issue stacking exhaust the 3-attempt budget before convergence.
