# Code Generation Pipeline — Plan & Fix Catalog

This document captures the design for the code-generation background-job pipeline (entity classes, environment, policies) and the concrete fixes to flaws identified during planning. It mirrors the architecture of [`background-job-pipeline.md`](background-job-pipeline.md) (map_extract pipeline) so reuse is maximized.

References:
- Reuse contract: `docs/background-job-pipeline.md`
- Stage prompts and replay: `engine/backend/prompt/code_generation_prompt_flow.md`, `engine/backend/prompt/code_generation_instruction.json`

---

## 1. Stage Order

```
state1_entity_list
   ↓
state1b_policy_outline       (NEW — preview the contract policies will need)
   ↓
state1c_entity_dependencies  (NEW — DAG so iteration order respects deps)
   ↓
state2_code_entity_object    (iterative, topological order; intra-stage resume)
   ↓
state2v_validate_protocol    (AST + import check after each entity, single retry)
   ↓
state3_code_environment
   ↓
state4_code_policy           (iterative; intra-stage resume)
   ↓
state4v_validate_policy      (AST + import check)
   ↓
finalize_bundle
```

Iterative stages (`state2_code_entity_object`, `state4_code_policy`) save a sub-iteration checkpoint after **each** entity / policy. Each sub-iteration is independently previewable and rollback-target.

---

## 2. Fixes for Identified Flaws

### F1. Time management protocol (severe)
- **What:** Enforce a shared `step(dt)`/`tick(dt)` contract through prompts and a validation sub-stage.
- **Where:** `code_generation_instruction.json` adds three new policy blocks:
  - `codegen_time_protocol_entity` — every entity class MUST implement `step(self, dt: float, env: "Environment") -> None`; MUST NOT call `time.sleep`, `asyncio.sleep`, or read wall clock.
  - `codegen_time_protocol_environment` — `Environment.tick(self, dt)` iterates entities in the order from the dependency DAG, then calls policy `before_tick` / `after_tick`.
  - `codegen_time_protocol_policy` — policies expose `before_tick(env, dt)` / `after_tick(env, dt)` only.
- **Validation stage `state2v_validate_protocol`:** AST-walk each emitted file. Reject if `step`/`tick` missing, or if `time.sleep`, `asyncio.sleep`, `datetime.now`, or `time.monotonic` appear. Single LLM retry with the failure reason appended.

### F2. Prompt-context blowup from raw accumulator
- **What:** Replace the raw-source accumulator with an interface digest, AND obey the Gemini 10-file-part cap by using a single concatenated file with delimiters.
- **Where:** `engine/backend/app/services/code_gen_prompts.py`:
  - `concat_with_delimiters(files: dict[str, str]) -> str` — joins prior files with `# === FILE: <name> ===` markers; uploaded as **one** file part regardless of count.
  - `interface_digest_from_source(src: str) -> dict` — `ast.parse` then extract: class name, base classes, public method signatures + docstrings, class-level annotations. No bodies.
  - State 2 prompt receives **digest JSON** as `already_generated_entities`. State 4 receives **concatenated entity code** + digest combined.

### F3. Policy generated last (API mismatch)
- **What:** New stage `state1b_policy_outline` produces `[{rule_id, trigger, target_entity_method, inputs}]` JSON.
- **Where:** Inserted between State 1 and State 1c; output passed into State 2 prompt so entities expose the methods policies will eventually call.

### F4. Word-cloud frequency ≠ relevance
- **Backend:** State 1 schema rejects `type ∈ {metric, event, condition}` for the cloud bucket. Drop the LLM `priority` field — ranking is **client-side** only (per user feedback).
- **Frontend:** word cloud sized by simple frequency from causal text on the client; metrics/events shown as a separate non-selectable chip row.

### F5. Single-map limitation (v1 cap, v2 deferred)
- v1: enforce single-map selection in the UI; document the cap.
- v2 (later): `extracted_node_json` becomes `maps: [{map_id, nodes, edges, transform}]` with a `map_transforms` object. Defer until v1 ships.

### F6. All-or-nothing Generate gate
- **What:** Progressive unlock + preview endpoint.
- **New endpoint:** `POST /api/code_gen/jobs/{id}/preview_entities` — runs only `state1_entity_list` + `state1b_policy_outline`, returns the entity list and policy outline.
- **UX:** Generate enabled once user confirms preview. Show a "what will run" summary (N entities × est tokens, M policies) before commit.

### F7. No code validation loop
- **What:** Per-emitted-file `ast.parse` + import sandbox check.
- **Where:** `state2v_validate_protocol` and `state4v_validate_policy`. On failure: single retry with the syntax/import error appended; second failure → stage fails, exact error surfaced through the existing `stage_message` channel.

### F8. No dependency graph between entities
- **What:** New stage `state1c_entity_dependencies`.
- **Output:** DAG edges `[{from, to, reason}]`. State 2 iterates leaves first. Cycles broken by lowest client-ranked priority and surfaced as a stage warning.

### F9. react-wordcloud peer-dep collision with React 19
- Replace with `@visx/wordcloud`. Drop `legacy-peer-deps=true` once removed. ~30-line component swap.

### F10. Artifacts endpoint path traversal
- `GET /api/code_gen/jobs/{id}/artifacts/{path}`: resolve relative to job artifact dir; assert `artifact_root.is_relative_to` after `.resolve()`. Reject `..`, `~`, leading `/`. Whitelist extensions to `.py`, `.json`, `.md`, `.log`.

---

## 3. User-Confirmed Design Decisions

- **No LLM ranking in State 1.** Ranking, if shown, is computed client-side from causal-text frequency. Saves prompt tokens.
- **Gemini 10-file-part cap.** Iterative accumulators must concatenate prior outputs into ONE file with `# === FILE: ... ===` delimiters; never a separate part per artifact.
- **Sub-iteration access.** Each iteration of State 2 / State 4 is individually previewable and rollback-target (intra-stage resume + per-iteration checkpoint).

---

## 4. Phased Implementation Plan

Each phase is an independently shippable PR.

### Phase 1 — Backend scaffolding (no LLM calls yet)
**Goal:** A job can be created, polled, cancelled, restarted, with disk checkpoints — same wire format as map_extract. Stages stubbed.

Deliverables:
- `engine/backend/app/services/code_gen_checkpoints.py` (mirrors `map_extract_checkpoints.py`)
  - `STAGE_ORDER` constant
  - `save_stage` / `load_stage` / `delete_from` / `delete_after`
  - Per-iteration: `save_iteration(stage, iter_id, payload)` / `load_iteration` / `list_iterations`
  - `concat_iterations_with_delimiters(stage)` — produces single-file accumulator obeying the Gemini 10-part cap
- `engine/backend/app/services/code_gen_runner.py` skeleton — driver that walks `STAGE_ORDER`, emits stage events, handles cancellation. Each stage returns a stub payload.
- `engine/backend/app/routes/code_gen.py` — endpoints: `POST /jobs`, `GET /jobs/{id}/status`, `POST /jobs/{id}/cancel`, `POST /jobs/{id}/resume`, `POST /jobs/{id}/rollback`, `GET /jobs/{id}/result`, `GET /jobs/{id}/artifacts/{path}` (with traversal guard from F10), `POST /jobs/{id}/preview_entities` (returns `{ ok: false, reason: "stub" }` for now).
- Wire into `app/main.py` via `include_router`.
- No prompts called yet — Phase 2.

### Phase 2 — Stage 1 family + Validation (LLM calls)
- `state1_entity_list` (no ranking field)
- `state1b_policy_outline`
- `state1c_entity_dependencies`
- Wire `preview_entities` endpoint to actually run States 1 and 1b.
- Reuse `gemini_client.generate_text` with `on_retry` + `cancel_check` callbacks (already supports both).

### Phase 3 — Stage 2/3/4 + validation loops
- `state2_code_entity_object` — topological iteration, interface digest, single-file accumulator, intra-stage resume.
- `state2v_validate_protocol` — AST + import check, one retry.
- `state3_code_environment` — receives concatenated entity code (1 file part).
- `state4_code_policy` — iterative, accumulator-based.
- `state4v_validate_policy` — AST + import check.
- `finalize_bundle` — write a zip + manifest under `artifacts/`.

### Phase 4 — Frontend
- Adapt `engine/web-ui/src/app/code/` page to:
  - `ProjectPageHeader` + horizontally-scrolling causal cards (multi-select)
  - Map cards (single-select; cap from F5)
  - Preview entities button → `POST /preview_entities`
  - WordCloud (`@visx/wordcloud`, F9) + EntityChecklist + ManualEntityInput + SelectionSummary
  - ModelPicker + Generate button (gated per F6)
  - ArtifactBrowser (per-iteration preview/rollback per user feedback)
  - Sticky StageLogPanel (reuse existing component)
- Mirror map_extract's three mount effects + remote-watcher effect for cold-start recovery.

### Phase 5 — Hardening + cleanups
- Replace `react-wordcloud` (F9), drop `.npmrc legacy-peer-deps=true`.
- Tighten artifacts endpoint (F10).
- Stress test: 15+ entity job to validate the 10-file-part cap doesn't trip.
- Add `code_gen_prompt_replay.py` parallel to `map_extract_prompt_replay.py`.

---

## 5. Reuse Matrix

| Component | Reuse / Adapt / New |
|-----------|---------------------|
| `JobRecord`, `job_store.py`, `gemini_client.py` (with `on_retry` + `cancel_check`) | Reuse verbatim |
| `map_extract_checkpoints.py` structure | Adapt → `code_gen_checkpoints.py` (adds per-iteration files) |
| `map_extract_runner.py` driver | Adapt → `code_gen_runner.py` |
| `routes/map_extract.py` | Adapt → `routes/code_gen.py` |
| `StageLogPanel`, `useJobStatusPoller`, remote watcher | Reuse |
| Prompt assembly | New (`code_gen_prompts.py`) — concat-with-delimiters + interface digest |

---

## 6. Open Questions (track before Phase 2)

- Time protocol: confirm `step(dt)` vs `tick(dt)` naming.
- Max entities cap: hard limit before generation rejects (suggest 30; Gemini cap is on file parts not lines).
- Causal/map ID format: stable IDs vs hashes.
- Artifact preview style: render `.py` with syntax highlight in the browser, or download-only.
