# Code-Gen Pipeline Changes — Session 2026-05-08

Diagram reference: `docs/image.png` (flow image shared in session)

---

## Section 1 — New `metrics_draft` Pipeline Stage

**What:** Insert a new stage `state1d_metrics_draft` between `state1c_entity_dependencies` and `state2_code_entity_object`.

**Why:** Currently metric suggestion happens *before* job creation via the standalone `/code_gen/suggest_metrics` endpoint. The diagram shows metrics as an in-pipeline stage that reads entity+dependency context produced earlier in the same run.

**Files touched:**
- `engine/backend/app/services/code_gen_checkpoints.py` — add `"state1d_metrics_draft"` to `STAGE_ORDER` between `state1c_entity_dependencies` and `state2_code_entity_object`
- `engine/backend/app/services/code_gen_prompts.py` — add `build_state1d_metrics_draft_prompt()`
- `engine/backend/app/services/code_gen_runner.py` — add `_stage_state1d_metrics_draft(ctx)` implementation
- `engine/backend/app/routes/code_gen.py` — add branch in `_summarize_code_gen_stage()` for `state1d_metrics_draft`

**Stage inputs (from upstream checkpoints):**
- `state1_entity_list` → entity list
- `state1b_policy_outline` → policy outline (which entity methods policies call)
- `state1c_entity_dependencies` → dependency edges + topological order

**Stage outputs (saved to `state1d_metrics_draft.json`):**
- Array of metric objects (same schema as current `SuggestedMetric` model in `suggest_metrics.py`)
- Each metric additionally carries diagram fields: `entity_id`, `expected_variable`, `chart_type`, `how_to_interpret`

**Prompt changes:**
- `build_state1d_metrics_draft_prompt()` replaces `_PROMPT_TEMPLATE` from `routes/suggest_metrics.py`
- New context sections added: entity dependency edges, policy method contracts
- Additional required output fields: `entity_id` (which entity owns the variable), `expected_variable` (human-readable variable concept), `chart_type` (viz hint), `how_to_interpret` (one sentence)

---

## Section 2 — Confirmation Gate for `metrics_draft`

**What:** Add `state1d_metrics_draft` to `CONFIRMATION_GATES` in `code_gen_runner.py`. Pipeline pauses after stage completes; user reviews and confirms before `state2` starts.

**Why:** User must be able to edit/deselect metrics before entity code generation uses them to inject `required_attrs` into entity classes. Post-confirmation changes are not possible without rollback.

**Files touched:**
- `engine/backend/app/services/code_gen_runner.py` — add `"state1d_metrics_draft"` to `CONFIRMATION_GATES` frozenset

**Backend behaviour (no changes needed):** `_wait_for_confirmation()` and `/code_gen/jobs/{job_id}/confirm` endpoint already support any stage name generically.

**What changes at the gate:**
- Job status becomes `"awaiting_confirmation"`, `awaiting_confirmation_stage = "state1d_metrics_draft"`
- SSE emits stage event with message `"state1d_metrics_draft: awaiting user confirmation"`

---

## Section 3 — Confirmation Preview: Code View of Metrics

**What:** When the pipeline halts at the `state1d_metrics_draft` confirmation gate, the frontend preview panel should display the **metric contracts code** (the `metric_contracts.json` payload that would be generated) rather than raw JSON metric objects.

**Why:** User's request — "preview should be the code that move from old suggest metric section". The `metric_contracts.json` format (built by `codegen_runtime_assets.build_metric_contracts()`) shows what the Reporter will actually sample, which is more actionable than the raw LLM suggestion.

**Files touched:**
- `engine/backend/app/routes/code_gen.py` — update `_summarize_code_gen_stage()` for `state1d_metrics_draft`: `preview` field should include `metric_contracts` sub-object (call `build_metric_contracts()` on the draft metrics list and embed result)
- `engine/web-ui/src/app/code/page.tsx` — add handling for `awaiting_confirmation` on stage `state1d_metrics_draft`; render preview as formatted code block (JSON or Python-style)

**Preview shape (backend):**
```json
{
  "summary": { "metricCount": 4, "entityCount": 3 },
  "preview": {
    "metrics": [...],
    "metric_contracts": { ... }
  }
}
```

---

## Section 4 — `selectedMetrics` No Longer Required at Job Creation

**What:** Remove `selectedMetrics` in `POST /code_gen/jobs`. The pipeline generates metrics in `state1d_metrics_draft` instead.

**Why:** Previously the frontend had to call `/code_gen/suggest_metrics` first, then let user pick, then POST the job with `selectedMetrics`. With the pipeline stage, this pre-step moves inside the pipeline (state1d_metrics_draft).

**Files touched:**
- `engine/backend/app/routes/code_gen.py` — remove the 400 guard that rejects requests without `selectedMetrics`; as it moved to state1d_metrics_draft.

---

## Section 5 — Frontend Confirmation UI for `metrics_draft` Gate

**What:** When `job.status === "awaiting_confirmation"` and `job.awaiting_confirmation_stage === "state1d_metrics_draft"`, show a metrics review panel (edit/toggle metrics) with a Confirm button.

**Why:** Maps to same UX pattern as `state1b_policies_outline` confirmation, but content is metric list + code preview instead of policies checkboxes.

**Files touched:**
- `engine/web-ui/src/app/code/page.tsx` — add branch handling `awaiting_confirmation_stage === "state1d_metrics_draft"`, fetch checkpoint preview, render metric toggle list + formatted contract code
- `engine/web-ui/src/app/code/metrics-selection-panel.tsx` — existing component can be reused or adapted for the in-pipeline confirmation context

**Behaviour:**
1. Fetch `GET /code_gen/jobs/{job_id}/checkpoints/state1d_metrics_draft` to get preview
2. Render metric cards from `preview.metrics` (user can toggle selected/deselected)
3. Show `preview.metric_contracts` as code block
4. On Confirm: `PATCH /code_gen/jobs/{job_id}/metrics` (new endpoint, see Section 6) with selected subset, then `POST /code_gen/jobs/{job_id}/confirm` with `{"stage": "state1d_metrics_draft"}`

---

## Section 6 — `PATCH /code_gen/jobs/{job_id}/metrics` Endpoint

**What:** New endpoint to overwrite `selectedMetrics` in the saved inputs manifest (mirrors existing `PATCH /code_gen/jobs/{job_id}/policies`).

**Why:** User may deselect or reorder metrics during the confirmation review. The updated selection must be persisted so when the worker resumes it reads the user-curated list from `state2` onward.

**Files touched:**
- `engine/backend/app/routes/code_gen.py` — add `@router.patch("/code_gen/jobs/{job_id}/metrics")` handler that calls `checkpoints.update_selected_metrics(job_id, metrics_list)` (new helper, mirrors `update_selected_policies`)
- `engine/backend/app/services/code_gen_checkpoints.py` — add `update_selected_metrics()` function

---

## Section 7 — Standalone `/code_gen/suggest_metrics` Endpoint (Keep or Deprecate)

**What:** The existing `POST /code_gen/suggest_metrics` route in `routes/suggest_metrics.py` becomes redundant once Section 1–4 land.

**Options:**
- Keep as utility (useful for testing / experimenting outside a job context)
- Deprecate and remove after frontend no longer calls it

Decision deferred — mark as deprecated in docstring for now; do not remove.

---

## Section 8 — State2: Read Metrics from `state1d` Checkpoint as Reference *(corrected 2026-05-08)*

**What:** Change `_stage_state2_code_entity_object` to read confirmed metrics from `state1d_metrics_draft` checkpoint. Metrics are passed to the LLM as **reference contracts** — the generated entity code must expose the required measurement attrs via `on_query()`.

**Why:** After Sections 1–6 land, `selectedMetrics` is gone from job inputs. State2 reads the user-confirmed metric list from the pipeline checkpoint. More importantly, the metrics define *what the simulation will measure* — entity code must be written with those measurement points in mind from the start, not retrofitted later.

**Current code (`code_gen_runner.py` ~line 436):**
```python
selected_metrics = ctx.inputs.get("selectedMetrics") or []
```

**After:**
```python
state1d = ctx.stage_payload("state1d_metrics_draft") or {}
selected_metrics = list(state1d.get("metrics") or [])
```

**Prompt impact (required — not currently done):** `build_state2_entity_object_prompt()` must receive `selected_metrics` and inject a metric reference section telling the LLM which attrs each entity must expose. See Section 13b for prompt details.

**Files touched:**
- `engine/backend/app/services/code_gen_runner.py` — replace `selectedMetrics` read with `state1d` checkpoint read; pass `selected_metrics` to prompt builder
- `engine/backend/app/services/code_gen_prompts.py` — `build_state2_entity_object_prompt()` signature gets `selected_metrics: list[dict]` param (see Section 13b)

---

## Section 9 — State3: Add Edge Data + Map File Artifact

### 9a — Extend map input: nodes + edges together as `mapGraph`

**What:** Replace `mapNodeJson` (nodes-only dict) with `mapGraph` — a combined object `{vertices: [...], edges: [...]}` matching the `finalize_graph.json` output of the map extraction pipeline.

**Why:** The diagram shows both `node` and `edge` files feeding into `state3_code_environment`. Currently only nodes are passed; edges (traversal paths between locations) are missing. Without edges, environment code cannot represent spatial reachability — entities cannot traverse between map locations.

**`finalize_graph.json` shape (source of truth):**
```json
{
  "graph": {
    "vertices": [{"id":"L1.1","label":"...","x":0.25,"y":0.65,"type":"outdoor_buffer",...}],
    "edges": [{"id":"E1","source":"L1.1","target":"L1.26","label":"path","weight":0.15,...}]
  }
}
```

**New input field:** `mapGraph` = `graph` object from `finalize_graph.json` (populated from `mapExtractJobId` — see 9b).

**Files touched:**
- `engine/backend/app/routes/code_gen.py`:
  - Accept `mapExtractJobId` in POST body; load `finalize_graph.json` from map extract job directory; extract `.graph` as `mapGraph`
  - Validate: `mapGraph` must have non-empty `vertices` list and `edges` list — 422 if absent (see Section 11)
  - Store as `mapGraph` in inputs manifest
- `engine/backend/app/services/code_gen_checkpoints.py`:
  - Add `map_graph: dict[str, Any] | None` param to `save_inputs()`
  - Store as `"mapGraph"` in `inputs.json`
- `engine/backend/app/services/code_gen_runner.py` (`_stage_state3_code_environment`):
  - Read `map_graph = ctx.inputs.get("mapGraph")` (no legacy fallback — map is always required)
  - Pass both `vertices` and `edges` to prompt builder

### 9b — `mapExtractJobId` shortcut (ACTIVE — answered 2026-05-08)

**Decision:** Frontend passes `mapExtractJobId`; backend pulls `finalize_graph.json` from that job's directory and extracts the graph object itself. Frontend does NOT serialize graph data inline.

**Why:** Avoids re-serializing ~50 nodes + ~55 edges on every job creation. Backend already knows the artifact path from job ID.

**Implementation:**
- `engine/backend/app/routes/code_gen.py` — POST body accepts `mapExtractJobId: str`; backend resolves path via `checkpoints.artifact_root(mapExtractJobId) / "finalize_graph.json"`; loads and extracts `.graph`; stores as `mapGraph` in inputs
- No frontend graph serialization needed

### 9c — Write `map.json` artifact; environment loads it at runtime

**What:** State3 stage writes `map.json` into the job's artifact directory. The generated `environment.py` loads `map.json` at `__init__` time rather than having node/edge data hardcoded in Python source.

**Why:**
1. Hardcoded map data inflates generated code size, wastes tokens, is fragile.
2. Separating data from logic lets map be swapped without regenerating code.
3. Policy code calling `env.get_nodes(type="outdoor_buffer")` is more maintainable than indexing a hardcoded list.

**`map.json` written by state3 runner (normalized keys):**
```json
{
  "nodes": [{"id":"L1.1","label":"...","x":0.25,"y":0.65,"type":"outdoor_buffer","neighbors":["L1.26",...]}],
  "edges": [{"id":"E1","source":"L1.1","target":"L1.26","label":"path","weight":0.15}]
}
```
Note: `vertices` renamed to `nodes` for clarity in generated code; `neighbors` pre-computed adjacency list added per node.

**Files touched:**
- `engine/backend/app/services/code_gen_runner.py` (`_stage_state3_code_environment`):
  - Build `map_json_data = _build_map_artifact(map_graph)` (normalize + pre-compute neighbors)
  - Write `artifact_root(job_id) / "map.json"` before calling the LLM
  - Return `"mapArtifactWritten": True` in stage payload
- New helper `_build_map_artifact(map_graph: dict | None) -> dict`:
  - Converts `vertices` → `nodes`, adds `neighbors` list per node from edge data
  - Returns `{"nodes": [...], "edges": [...]}`

### 9d — Environment template: map loading + accessor methods

**What:** Extend `environment_template.py` (the base `SimulationEnvironment`) with map loading and traversal methods.

**Why:** Generated `environment.py` subclasses this template. If traversal methods live in the base, generated code only needs to call `super().__init__()` and override nothing — the LLM can't break the map API.

**New base class additions:**
```python
import json, pathlib

class SimulationEnvironment:
    def __init__(self):
        ...existing fields...
        self._nodes: dict[str, dict] = {}   # node_id → node dict
        self._edges: list[dict] = []
        self._adjacency: dict[str, list[str]] = {}  # node_id → [neighbor_ids]
        self._load_map()

    def _load_map(self) -> None:
        """Load map.json from same directory as this file. Silent no-op if absent."""
        map_path = pathlib.Path(__file__).parent / "map.json"
        if map_path.exists():
            data = json.loads(map_path.read_text())
            for n in data.get("nodes", []):
                self._nodes[n["id"]] = n
            self._edges = data.get("edges", [])
            for n in data.get("nodes", []):
                self._adjacency[n["id"]] = n.get("neighbors", [])

    # --- Map accessors (policies and entities call these) ---
    def get_nodes(self, type: str | None = None) -> list[dict]:
        nodes = list(self._nodes.values())
        return [n for n in nodes if n.get("type") == type] if type else nodes

    def get_node(self, node_id: str) -> dict | None:
        return self._nodes.get(node_id)

    def get_edges(self) -> list[dict]:
        return list(self._edges)

    def get_neighbors(self, node_id: str) -> list[str]:
        return list(self._adjacency.get(node_id, []))

    def get_node_types(self) -> list[str]:
        return list({n.get("type") for n in self._nodes.values() if n.get("type")})
```

**Files touched:**
- `engine/backend/app/services/templates/environment_template.py` — add fields + `_load_map()` + accessor methods (after template relocation — see Section 9f)

### 9e — Prompt changes for state3 *(corrected 2026-05-08)*

**What:** Update `build_state3_environment_prompt()` to accept graph + entity + policy outline only. **Drop `causal_data` entirely** — causal triples are not needed for environment generation; the map graph and entity/policy structure are sufficient.

**Why dropped:** Environment code models spatial layout and entity containers, not causal mechanisms. Causal triples are state1 inputs; by state3 their content is already encoded in the entity definitions and policy outline. Passing causal text bloats the prompt and the LLM tends to produce causal-narrative comments instead of structural code.

**Files touched — `code_gen_prompts.py`:**
- Signature change (remove `causal_data`, add `policy_outline`):
  ```python
  def build_state3_environment_prompt(
      *,
      entities_blob: str,
      policy_outline: list[dict[str, Any]],   # from state1b_policy_outline checkpoint
      map_graph: dict[str, Any] | None,        # replaces map_node_json
      retry_error: str | None = None,
  ) -> str:
  ```
- Remove the `"Causal data:\n" + (causal_data or "").strip()` line from `_assemble([...])`.
- Add policy outline section (replaces causal context):
  ```
  Policy outline (entity behaviours this environment must support):
  <policy_outline as compact JSON — rule_id, trigger, target_entity_id, target_method per rule>
  Use this to understand what entity methods get called and what map traversal the policies expect.
  ```
- Map section shows both vertices + edges sample:
  ```
  Map graph (nodes + edges) — ALREADY WRITTEN as map.json artifact in artifacts dir.
  DO NOT hardcode this data. Call self._load_map() via super().__init__() — it loads automatically.
  Node types present: ["outdoor_buffer", "indoor_buffer", ...]
  Sample nodes: [first 3 nodes as JSON]
  Sample edges: [first 3 edges as JSON]
  Accessor methods available (from SimulationEnvironment base):
    env.get_nodes(type=None) → list of node dicts
    env.get_node(node_id) → node dict or None
    env.get_edges() → list of edge dicts
    env.get_neighbors(node_id) → list of neighbor node IDs
    env.get_node_types() → list of type strings
  ```
- Remove `codegen_fallback_map_policy` runtime section (no longer needed — map is always required).

**Files touched — `code_gen_runner.py` (`_stage_state3_code_environment`):**
- Remove `causal_data = str(ctx.inputs.get("causalData") or "")` read.
- Add `state1b = ctx.stage_payload("state1b_policy_outline") or {}; policy_outline = state1b.get("policies") or []`
- Pass `policy_outline=policy_outline` to `build_state3_environment_prompt()`; remove `causal_data=` arg.

### 9f — Template relocation (new — answered 2026-05-08)

**Decision:** Templates currently live in `Experiment/` (out of engine scope). Move all 4 templates to an engine-local directory. Both `code_gen_prompts.py` and `code_gen_runner.py` resolve `_TEMPLATE_DIR` to the Experiment path — update both.

**Target location:** `engine/backend/app/services/templates/`
(All 4 templates in same folder: `environment_template.py`, `entity_object_template.py`, `policy_template.py`, `entity_template.py`)

**Files touched:**
- Create `engine/backend/app/services/templates/` directory
- Copy (then delete Experiment originals, or keep as reference) all 4 template files
- `engine/backend/app/services/code_gen_prompts.py` — update `_TEMPLATE_DIR` to:
  ```python
  _TEMPLATE_DIR: Path = Path(__file__).resolve().parent / "templates"
  ```
- `engine/backend/app/services/code_gen_runner.py` — update `_get_template_dir()` to same path

**Template alignment changes (apply when copying):**
- `environment_template.py`: Apply Section 9d additions (map loading + accessor methods). Currently has NO map support.
- `entity_object_template.py`: Add `on_query()` method alongside `get_status()`. The Reporter calls `on_query()` to sample metrics — base class must define the contract:
  ```python
  def on_query(self, metric_name: str) -> dict:
      """[METRIC TRAIT] Return metric sample dict for Reporter. Override per entity.
      Keys must match required_attrs from metric_contracts.json."""
      return {}
  ```
- `policy_template.py`: No changes needed — current contract is aligned.
- `entity_template.py`: No changes needed — it's a re-export shim.

---

## Section 10 — State4: Policy Uses Env Map Accessors

**What:** Update `build_state4_policy_prompt()` to include a map interface summary so generated policy code calls env methods rather than hardcoding node IDs or re-importing map data.

**Why:** Policy `apply(self, entity_object, context, env)` receives the environment instance. Policies need to know which env methods exist for map traversal. Without explicit prompt context, LLM may invent method names or hardcode spatial data.

**New prompt section added to state4 (after environment_code):**
```
Map accessor API (call these on the `env` parameter, do NOT hardcode node IDs):
  env.get_nodes(type=None) → list of node dicts with keys: id, label, type, x, y, neighbors
  env.get_node(node_id: str) → node dict or None
  env.get_edges() → list of edge dicts with keys: id, source, target, label, weight
  env.get_neighbors(node_id: str) → list of neighbor node IDs (strings)
  env.get_node_types() → list[str]  — available node type strings in this map
```

**Files touched:**
- `engine/backend/app/services/code_gen_prompts.py` — `build_state4_policy_prompt()`:
  - Add `map_graph: dict[str, Any] | None = None` param
  - Build `map_interface_section` from map_graph node type set + fixed accessor docstring
  - Append to `_assemble([...])` list
- `engine/backend/app/services/code_gen_runner.py` — `_stage_state4_code_policy()`:
  - Read `map_graph = ctx.inputs.get("mapGraph")`
  - Pass to `build_state4_policy_prompt(map_graph=map_graph, ...)`

---

## Section 11 — Map Required: Validate at Generate + Backend (new — answered 2026-05-08)

**Decision:** No fallback. Map (nodes + edges) must be present before Generate is allowed. Currently the Generate button does not enforce this.

**Why:** User confirmed — Generate button already requires a map to be present. Backend has no fallback path for missing map data. Adding explicit checks prevents silent failures in state3.

**Frontend changes:**
- `engine/web-ui/src/app/code/page.tsx` (or wherever Generate button lives):
  - Enable Generate only when `mapExtractJobId` is set AND the referenced job has a `finalize_graph.json` artifact
  - Show tooltip/error "Map must be uploaded and processed before generating code" if absent

**Backend changes:**
- `engine/backend/app/routes/code_gen.py` — POST `/code_gen/jobs`:
  - Require `mapExtractJobId` field (non-optional)
  - Load and validate `finalize_graph.json`: must have `.graph.vertices` (non-empty) AND `.graph.edges` (non-empty)
  - Return 422 with message `"mapExtractJobId references a job with no finalized graph"` if validation fails

---

## Section 12 — Policy Self-Verification *(corrected 2026-05-08)*

**What:** After state4 generates policy code, add verification stage `state5_policy_verify` using LLM-as-Judge to audit policy code and trigger auto-fix.

**Why:** Policy code is the most likely place for integration failures — wrong entity method names, missing policy application logic, type mismatches when policies interact with entity state. The judge notebook (`Experiment/.../llm_judge.ipynb`) proves this pattern works for entities; applying to policies catches errors before simulation runs.

---

### Correction 4 — Entity Code Must Be Wired Into Pass 1

**Problem:** Pass 1 judge compares policy `apply()` calls against target entity methods. Entity code is NOT passed as input currently — the plan listed it but didn't specify the data path, making Pass 1 impossible without a live codebase lookup.

**Fix — entity code loading in `_stage_state5_policy_verify`:**

Each policy's rule contract has `target_entity_id`. For each policy, load the corresponding entity's generated code from the `state2_code_entity_object` checkpoint:

```python
def _load_entity_code_index(ctx: StageContext) -> dict[str, str]:
    """Returns {entity_id: python_code_str} from state2 checkpoints."""
    state2_payloads = ctx.stage_payloads_all("state2_code_entity_object") or []
    return {p["entity_id"]: p.get("code", "") for p in state2_payloads if p.get("entity_id")}
```

Then per-policy in Pass 1:
```python
entity_code = entity_code_index.get(rule["target_entity_id"], "")
# entity_code is passed to build_policy_judge_pass1_prompt()
```

**`build_policy_judge_pass1_prompt()` signature:**
```python
def build_policy_judge_pass1_prompt(
    *,
    policy_code: str,
    rule_contract: dict[str, Any],   # rule_id, trigger, target_entity_id, target_method
    entity_code: str,                # generated code from state2 checkpoint — REQUIRED
    map_accessor_api: str,           # short accessor docstring from Section 10
) -> str:
```

**Pass 1 judge checks:**
1. Does `apply()` correctly call `target_method` on the entity? (method name, args)
2. Does trigger logic match the rule contract trigger?
3. Are entity attrs accessed by correct name (matching `on_query()` contract from entity code)?
4. Does policy use map accessor API instead of hardcoding node IDs?

**Output schema (Pass 1):**
```json
{
  "policy": "string",
  "policy_score": 0-3,
  "verdict": "pass|warn|fail",
  "contract_checks": [{"claim": "string", "status": "FOUND|PARTIAL|MISSING", "evidence": "string"}],
  "interface_issues": ["string"],
  "fix_suggestions": ["string"],
  "summary": "string"
}
```

---

**Pass 2 — Cross-policy interface check:**
- Only for policy pairs that both target the same entity (potential conflict or ordering dependency)
- Judge checks: attribute name collisions, ordering assumptions, conflicting state mutations
- Output: `compatible` bool, `conflict_issues[]`

---

### Correction 3 — Track Validation/Fix Loop Count Per Policy

**What:** Track how many validation+fix attempts each policy file went through. Save counts in stage metadata and include in workspace export.

**Per-policy tracking object (built in runner, saved to stage payload):**
```python
# built during the auto-fix loop, one entry per policy:
policy_verification_meta = {
    rule_id: {
        "attempts": int,          # number of judge+fix cycles run (1 = no retry needed)
        "final_verdict": str,     # "pass" | "warn" | "fail"
        "final_score": int,       # 0–3
        "fix_history": [          # one entry per retry
            {"attempt": 1, "verdict": "fail", "fix_suggestions": [...]}
        ]
    }
}
```

**Stage payload shape saved to `state5_policy_verify.json`:**
```json
{
  "passed": ["rule_id_1", ...],
  "warned": ["rule_id_2", ...],
  "failed": [],
  "policy_verification_meta": { "<rule_id>": { "attempts": 2, "final_verdict": "pass", ... } },
  "pass2_results": [...]
}
```

**Workspace export (`finalize_bundle`):** Include `policy_verification_meta` in the bundle manifest. When workspace zip is exported, write `verification_report.json` alongside other artifacts:
```json
{
  "generated_at": "ISO timestamp",
  "policies": {
    "<rule_id>": { "attempts": 2, "final_verdict": "pass", "final_score": 3 }
  }
}
```

**Files touched (additions to runner):**
- `_stage_state5_policy_verify`: maintain `attempts` counter per policy inside auto-fix loop; append to `fix_history`; write `policy_verification_meta` into stage payload
- `_stage_finalize_bundle`: read `state5_policy_verify` payload; write `verification_report.json` into artifact dir

---

**Auto-fix loop (unchanged):**
- Policies with `verdict != pass`: re-queue to state4 with `retry_error` from `fix_suggestions`
- Max 2 auto-retries per policy; after that mark as `warn`, continue

**Stage placement:** After all `state4_code_policy` iterations, before `finalize_bundle`.

**Files touched (full list):**
- `engine/backend/app/services/code_gen_checkpoints.py` — add `"state5_policy_verify"` to `STAGE_ORDER`
- `engine/backend/app/services/code_gen_runner.py` — add `_stage_state5_policy_verify(ctx)` + `_load_entity_code_index(ctx)` helper
- `engine/backend/app/services/code_gen_prompts.py` — add `build_policy_judge_pass1_prompt()` and `build_policy_judge_pass2_prompt()`
- `engine/backend/app/routes/code_gen.py` — add summary branch for `state5_policy_verify` in `_summarize_code_gen_stage()`

---

## Section 13 — Visualization Integration Audit (new — 2026-05-08)

**Finding:** Current pipeline has multiple gaps between metric/visualization intent and code generation. State prompts do not mention `on_query()`, `chart_type`, `expected_variable`, or `how_to_interpret`. The `finalize_bundle` stage reads metrics from the wrong source after the Section 4 change.

**Gap inventory:**

| Location | Gap | Fix |
|---|---|---|
| `_stage_finalize_bundle` line 1004 | Reads `selectedMetrics` from `ctx.inputs` — will be empty after Section 4 | Read from `state1d_metrics_draft` checkpoint instead |
| `build_state2_entity_object_prompt` | No mention of `on_query()` or required metric attrs | Add metric contract section: which attrs this entity must expose via `on_query()` |
| `entity_object_template.py` | Has `get_status()` but not `on_query()` — Reporter calls `on_query()`, not `get_status()` | Add `on_query(metric_name: str) -> dict` to base template (Section 9f) |
| `build_state3_environment_prompt` | No visualization context at all | No change needed — environment doesn't expose metrics directly |
| `build_state4_policy_prompt` | No metric accessor context | Already addressed in Section 10 (map API); metrics are entity-level, not policy-level — no change needed |
| `finalize_bundle → metric_contracts.json` | Contracts built from job-input selectedMetrics | Build from `state1d_metrics_draft` checkpoint (aligned with Section 8) |

**Fixes required:**

### 13a — Fix `_stage_finalize_bundle` metric source

**File:** `engine/backend/app/services/code_gen_runner.py` lines 1004-1006

**Current:**
```python
selected_metrics_raw = ctx.inputs.get("selectedMetrics") or []
```

**After:**
```python
state1d = ctx.stage_payload("state1d_metrics_draft") or {}
selected_metrics_raw = list(state1d.get("metrics") or [])
```

### 13b — State2 Prompt: Metrics as Simulation Reference *(corrected 2026-05-08)*

**Context:** `state1d_metrics_draft` defines what the simulation will measure. State2 generates entity class code. The entity code must track state variables that correspond to those metrics from day one — otherwise the Reporter will find nothing to sample.

**File:** `engine/backend/app/services/code_gen_prompts.py` — `build_state2_entity_object_prompt()`

Add `selected_metrics: list[dict]` param. Filter to metrics where `entity_id` matches the entity being generated. Build two sub-sections:

**Sub-section A — Reference metrics (simulation measurement context):**
```
Reference metrics for this simulation — your entity attributes MUST support these measurements:
  Metric "waste_collection_rate" (chart: line, entity: GarbageTruck)
    expected_variable: "waste collected per time step"
    → This entity should track: total_collected, collection_timestamp
  Metric "bin_overflow_events" (chart: bar, entity: WasteBin)
    expected_variable: "overflow count"
    → This entity should track: overflow_count, current_load
These metrics tell you what state this entity needs to maintain internally.
```

**Sub-section B — on_query() contract:**
```
Metric Reporter contracts — implement on_query() to expose these attrs:
  def on_query(self, metric_name: str) -> dict:
      # Must return dict with the exact keys the metric expects.
      # Example for metric "waste_collection_rate":
      #   return {"total_collected": self.total_collected, "collection_timestamp": self.last_tick}

on_query() base signature already defined in entity_object_template.py — override it.
```

**Prompt ordering:** Insert both sub-sections after the entity contract section, before the output format instruction.

**Pass `selected_metrics` from** `_stage_state2_code_entity_object` (reads from `state1d` checkpoint per Section 8). Filter by `entity_id == current_entity.entity_id` before passing to prompt.

---

## Answered Questions (2026-05-08 sync)

1. Stage name → `state1d_metrics_draft`
2. Extra fields → on each metric object: `entity_id`, `expected_variable`, `chart_type`, `how_to_interpret`
3. Preview UI → copy from current panelUI code; panelUI loads from `metric_contracts.json`
4. Edit scope → toggle on/off AND edit field values
5. `selectedMetrics` bypass → remove `selectedMetrics` entirely (old construction removed; replaced by `state1d`)
6. `/code_gen/suggest_metrics` callsite → removed; replaced by `state1d`
7. `mapExtractJobId` → ACTIVE: frontend passes job ID; backend loads `finalize_graph.json` directly
8. Template location → copy all templates to `engine/backend/app/services/templates/`; update `_TEMPLATE_DIR` in prompts.py and runner.py
9. Map fallback → none; map is required; validate at Generate button and POST endpoint
10. Policy self-verification → new `state5_policy_verify` stage; two-pass LLM judge + auto-retry

## Corrections Applied (2026-05-08 second sync)

11. `build_state3_environment_prompt` — drop `causal_data`; accept `policy_outline` (from `state1b`) instead. Section 9e rewritten. Runner must load state1b checkpoint, not causal data string.
12. State2 metrics input — `state1d_metrics_draft` feeds state2 as simulation measurement reference (not just `on_query()` wiring). Prompt gets both a "reference metrics" context block AND the `on_query()` contract block. Section 8 and 13b updated.
13. `state5_policy_verify` fix-loop tracking — per-policy `attempts` counter + `fix_history` saved in stage payload; `verification_report.json` written to artifact dir during `finalize_bundle`. Section 12 updated.
14. Pass 1 entity code wiring — entity code loaded from `state2_code_entity_object` checkpoint via `_load_entity_code_index(ctx)`; keyed by `entity_id` matching `rule.target_entity_id`. Pass 1 impossible without this. Section 12 updated.
