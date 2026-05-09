# Generated Code Evaluation Method

## Architecture: Policy-as-Behaviour-Adapter

This codebase does **not** embed causal behaviour inside entity classes. Instead:

- **Entities** are stateful hook providers — they hold state, expose named methods, and implement `on_query()` / `on_interact()` interfaces.
- **Policies** are behaviour adapters — each Policy class implements one causal rule by calling entity methods via `env.get_entity(id)`.

This separation allows causal rules (policies) to be swapped, tested, or disabled without touching entity code. An entity that looks "hollow" by conventional standards may be correct: its job is to provide a clean interface, not to drive its own behaviour.

**Consequence for evaluation:** an LLM judge that looks only at entity code will misrate entities that correctly expose their interface but delegate all behaviour to policies. Pass 1 must include the associated policy code. Pass 2 must include the policy that connects two entities — without it, the judge cannot verify the contract.

---

## Data Inputs

| Input | Source | Role |
|---|---|---|
| Entity source files | `artifacts/entities/*.py` | Code under judgment |
| Policy source files | `artifacts/policies/*.py` | Behaviour adapters under judgment |
| Policy outline | `checkpoints/state1b_policy_outline.json` | Maps `rule_id → target_entity_id + target_method` |
| Dependency graph | `checkpoints/state1c_entity_dependencies.json` | Directed edges `{from, to, reason}` |
| Causal triples | Exported causal bundle (or `inputs.json`) | Interview-grounded `{head, relationship, tail}` facts |
| Metric contracts | `artifacts/metric_contracts.json` | Required `on_query()` attributes per entity |

---

## Pass 1 — Entity Interface Audit

Each entity is judged **in context of its associated policies**.

### What counts as "correct" for an entity

Because behaviour lives in policies, an entity is correct when:

1. **State attributes** are present, correctly typed, and initialised to sensible defaults.
2. **Policy-callable methods** exist with signatures that match what associated policies call (`target_method` in policy outline + actual calls in policy code).
3. **`on_query()` returns** all attribute keys that metric contracts require.
4. **`on_interact()`** handles the action strings and payloads that other entities send.

### How policies are matched to an entity

1. Load `state1b_policy_outline.json` → list of `{rule_id, target_entity_id, target_method, ...}`.
2. For each entity, collect all outlines where `target_entity_id == eid`.
3. Load the corresponding policy file (`artifacts/policies/<rule_id>.py`).
4. Include up to **5 most relevant policy files** in the Pass 1 prompt via `build_policy_section(eid)` so the judge can cross-check method names and signatures.

> **Implementation note:** `entity_policies` (dict of eid → policy code list) and `build_policy_section` are defined in the prompt-builder cell alongside `build_pass1_prompt`. The judge is explicitly instructed to score on interface completeness against policy calls, **not** on whether the entity self-drives behaviour.

### Scoring rubric (behavior_score 0–3)

| Score | Label | Meaning |
|---|---|---|
| 3 | Complete interface | All policy-callable methods present with correct signatures; `on_query()` returns all required metric attrs; state well-initialised |
| 2 | Mostly present | Method signatures mostly correct; minor attrs missing from `on_query()` or shallow state initialisation |
| 1 | Broken interface | Key methods missing or wrong signatures — associated policies will fail at runtime |
| 0 | Hollow stub | No usable interface; policies cannot function |

### Pass 1 judge output per entity

| Field | Type | Meaning |
|---|---|---|
| `behavior_score` | 0–3 | Interface completeness |
| `verdict` | pass / warn / fail | pass ≥ 3, warn = 2, fail ≤ 1 |
| `causal_claim_checks` | list | Per-claim FOUND / PARTIAL / MISSING + evidence |
| `missing_attrs` | list | `on_query()` attrs absent or wrong |
| `interface_concerns` | list | Method signature mismatches, wrong action strings, type issues |
| `summary` | string | Free-text verdict |

---

## Pass 2 — Policy-Entity Contract Audit

Pass 1 cannot detect mismatches that only appear when a policy mediates between two entities. Pass 2 audits the **three-way contract**: policy ↔ FROM entity ↔ TO entity.

### Flagging rule

Edges are flagged for Pass 2 when at least one endpoint has `behavior_score ≤ PASS2_SCORE_THRESHOLD` **or** `verdict ≠ pass`.

Set `PASS2_SCORE_THRESHOLD = 3` to audit all edges regardless of Pass 1 scores.

### Finding the implementing policy for an edge

Edge reason text (e.g. `"BMA disposes of waste from sorting facility"`) is matched against policy outline labels using word-overlap scoring:

```
score = word_overlap(reason, policy_label) + 2 * (policy.target_entity_id in {from_eid, to_eid})
```

Top-scoring policies (score ≥ 3) are loaded. Up to 3 policies per edge are included in the prompt.

> **Implementation note:** `find_policies_for_edge(edge)` is called inside `build_pass2_prompt`. The resulting policy code is injected as a **"Mediating Policy"** section. The judge system prompt explicitly states that entities do **not** call each other directly — the policy mediates all interactions — so the judge evaluates the three-way contract rather than a direct entity-to-entity call.

### What the Pass 2 judge checks

1. Does the policy look up entities using the correct IDs? (must match actual file stems)
2. Does the policy call the correct method names on each entity?
3. Are attribute keys passed in `context` / returned by `on_query()` consistent between policy and entity?
4. Are there type or unit mismatches (e.g. policy sends `kg`, entity expects `count`)?
5. Does the FROM entity expose the method/attr the policy reads from it?
6. Does the TO entity's receiving method handle the payload the policy sends?

### Pass 2 judge output per edge

| Field | Type | Meaning |
|---|---|---|
| `compatible` | bool | Whether the three-way contract is sound |
| `issues` | list | Specific mismatches (method name, attr key, type, entity ID) |
| `fix_suggestions` | list | Concrete code-level fixes |
| `summary` | string | Free-text verdict |

---

## Entity Name Resolution

Entity files use ID-based names (`entity-manual-1777470690931-sorting-facility`). Human-readable names are resolved by:

1. **Priority**: explicit label from `inputs.json → userEntityList` (most accurate)
2. **Fallback**: filename parsing — strips noise prefixes (`entity`, `canonical`, `manual`, `the`) and pure-numeric / UUID segments

Short names like `bma` and `n15` are preserved because single-word entity names use a relaxed match (1-keyword overlap instead of 2+).

---

## Causal Triple Matching (Pass 1 context)

Each entity receives only the causal triples relevant to it. Matching uses two tiers:

- **Exact substring** — entity name appears inside triple's `head` or `tail` text
- **2+ keyword overlap** — prevents false matches on ubiquitous words like `"waste"` that appear in nearly every triple

---

## Limitations

- **Gemini as judge is not deterministic** — same entity may receive different scores across runs; treat results as indicative, not ground truth.
- **Policy matching is fuzzy** — if a policy filename diverges significantly from the edge reason text, it may be missed. Verify `find_policies_for_edge` output (printed at notebook startup) before interpreting Pass 2 verdicts.
- **Metric contract fuzzy matching** — contracts reference entities by informal names; mismatches cause missed or spurious attr checks.
- **Pass 2 only covers flagged edges** — interface bugs in entities that both scored 3 will not be caught unless `PASS2_SCORE_THRESHOLD = 3`.
- **Policy code is not exhaustive** — some behaviour is implemented directly in `environment.py` hooks; these are not included in the judge prompts.

## Known Issues Fixed

| Issue | Symptom | Fix |
|---|---|---|
| Pass 1 used wrong rubric | Entities scored 0–1 even when interface was correct, because judge evaluated self-driven behaviour instead of interface completeness | `PASS1_SYSTEM` updated to interface-completeness rubric; added `build_policy_section` to prompt |
| Pass 1 missing policy context | Judge could not verify method names/signatures without seeing policy code | `build_policy_section(eid)` now injected into every Pass 1 prompt |
| Pass 2 missing mediating policy | Judge saw two entity files with no connecting policy; marked all edges incompatible | `find_policies_for_edge(edge)` now called in `build_pass2_prompt`; result injected as "Mediating Policy" section |
| Pass 2 wrong task framing | Prompt asked "does FROM call TO correctly?" — impossible in this architecture | Prompt reframed to three-way contract: policy ↔ FROM ↔ TO |
