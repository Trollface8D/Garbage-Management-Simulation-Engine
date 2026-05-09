"""Prompt assembly for the code-generation pipeline.

Loads ``code_generation_instruction.json`` and exposes builders for each
stage. Two design constraints from ``docs/code-gen-pipeline.md`` are honored
here:

- F2/Gemini cap: iterative-stage accumulators concatenate prior code into a
  single delimited string (see ``concat_with_delimiters``) so the request
  never exceeds Gemini's 10 file-parts-per-request limit.
- User feedback: State 1 prompt does NOT request LLM ranking
  (``priority``). Ranking, if surfaced, is computed client-side from
  causal-text frequency. ``state1`` therefore overrides the JSON file's
  schema to drop the ``priority`` field.
"""

from __future__ import annotations

import ast
import json
import logging
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

ACCUMULATOR_FILE_DELIMITER = "# === FILE: {name} ==="

INSTRUCTIONS_PATH: Path = (
    Path(__file__).resolve().parents[2] / "prompt" / "code_generation_instruction.json"
)

_TEMPLATE_DIR: Path = Path(__file__).resolve().parent / "templates"


def _read_template(name: str) -> str:
    try:
        return (_TEMPLATE_DIR / name).read_text(encoding="utf-8")
    except OSError:
        logger.warning("[code_gen][prompts] template not found: %s", name)
        return ""


ENTITY_OBJECT_TEMPLATE: str = _read_template("entity_object_template.py")
ENVIRONMENT_TEMPLATE: str = _read_template("environment_template.py")
POLICY_BASE_TEMPLATE: str = _read_template("policy_template.py")


def entity_label_to_class_name(label: str) -> str:
    """Derive a PascalCase class name from an entity id/label, prefixed with 'Entity_'.

    The class name is derived from the entity's id in PascalCase format, prefixed with 'Entity_'.
    Falls back gracefully when label is empty or an entity_id string.
    
    Examples:
        "waste"                          -> "Entity_Waste"
        "sorting_facility_operators"     -> "Entity_SortingFacilityOperators"
        "truck"                          -> "Entity_Truck"
        "entity-19-staff"                -> "Entity_Staff"  (strips numeric prefix segments)
    
    Note: The entity_id from State 1 is the source of truth for class naming.
    """
    text = (label or "").strip()
    # If it looks like an entity_id (entity-NN-label), strip the prefix
    text = re.sub(r'^entity[-_][\w\d]+[-_][\w\d]+[-_]', '', text)
    text = re.sub(r'^entity[-_][\w\d]+[-_]', '', text)
    text = re.sub(r'^entity[-_]', '', text)
    words = re.split(r'[\s\-_]+', text)
    pascal_case = ''.join(w.capitalize() for w in words if w and not w.isdigit())
    return f'Entity_{pascal_case}'


@lru_cache(maxsize=1)
def load_instructions() -> dict[str, Any]:
    return json.loads(INSTRUCTIONS_PATH.read_text(encoding="utf-8"))


def _runtime(name: str) -> str:
    runtime = load_instructions().get("runtime_prompts") or {}
    text = runtime.get(name)
    if not isinstance(text, str):
        raise KeyError(f"runtime_prompts.{name} not found in code_generation_instruction.json")
    return text


def _stage(name: str) -> dict[str, Any]:
    stage = load_instructions().get(name)
    if not isinstance(stage, dict):
        raise KeyError(f"stage {name!r} not found in code_generation_instruction.json")
    return stage


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

# State 1 schema — frequency stays (cheap and useful), priority dropped per
# user feedback (ranking is done client-side).
STATE1_ENTITY_LIST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "entities": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "label": {"type": "string"},
                    "type": {
                        "type": "string",
                        "enum": ["actor", "resource", "environment", "policy"],
                    },
                    "frequency": {"type": "integer"},
                },
                "required": ["id", "label", "type"],
            },
        },
        "warning": {"type": "string"},
    },
    "required": ["entities"],
}

STATE1_ENTITY_LIST_SCHEMA_TEXT = (
    "Use this JSON schema exactly:\n"
    "{\n"
    '  "entities": [\n'
    '    {"id": "string", "label": "string", "type": "string", "frequency": 0}\n'
    "  ]\n"
    "}\n"
    "Field rules:\n"
    "- id: ASCII English snake_case identifier for this concept. If the label contains"
    " non-ASCII characters (e.g. Thai), translate the concept to English and use that"
    " as the id (e.g. label='ขยะ' → id='waste', label='รถขยะ' → id='garbage_truck').\n"
    "- label: exact surface form as it appears in causal data — preserve original language.\n"
    '- type: one of ["actor", "resource", "environment", "policy"].\n'
    "- frequency: integer count of occurrences across all causal data.\n"
    "Do NOT emit a 'priority' field — ranking is done by the caller, not the model."
)

STATE1B_POLICY_OUTLINE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "policies": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "rule_id": {"type": "string"},
                    "label": {"type": "string"},
                    "trigger": {"type": "string"},
                    "target_entity_id": {"type": "string"},
                    "target_method": {"type": "string"},
                    "inputs": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "description": {"type": "string"},
                },
                "required": ["rule_id", "trigger", "target_entity_id", "target_method"],
            },
        }
    },
    "required": ["policies"],
}

STATE1B_POLICY_OUTLINE_SCHEMA_TEXT = (
    "Use this JSON schema exactly:\n"
    "{\n"
    '  "policies": [\n'
    "    {\n"
    '      "rule_id": "string (snake_case)",\n'
    '      "label": "string (human-readable rule name)",\n'
    '      "trigger": "string (when the rule fires — condition or event from causal data)",\n'
    '      "target_entity_id": "string (entity.id from State 1 — the class the policy will mutate)",\n'
    '      "target_method": "string (snake_case method name the policy will call on the target entity)",\n'
    '      "inputs": ["string", ...],\n'
    '      "description": "string (one sentence)"\n'
    "    }\n"
    "  ]\n"
    "}\n"
    "Field rules:\n"
    "- target_entity_id MUST match an entity.id from the provided entity list. If a rule mutates the\n"
    "  environment, use the literal value 'environment'.\n"
    "- target_method MUST be the public method name the entity (or environment) is expected to\n"
    "  expose. Stage 2 will be told to define this method on the target class so the policy has a\n"
    "  stable interface to call.\n"
    "- Do NOT emit policy bodies. This stage is a contract preview only."
)

STATE1C_ENTITY_DEPENDENCIES_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "edges": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "from": {"type": "string"},
                    "to": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["from", "to"],
            },
        }
    },
    "required": ["edges"],
}

STATE1C_ENTITY_DEPENDENCIES_SCHEMA_TEXT = (
    "Use this JSON schema exactly:\n"
    "{\n"
    '  "edges": [\n'
    '    {"from": "entity_id", "to": "entity_id", "reason": "string"}\n'
    "  ]\n"
    "}\n"
    "Field rules:\n"
    "- edge direction is dependency: 'from' depends on 'to' (i.e. 'to' must exist first).\n"
    "- both ids MUST be present in the provided entity list.\n"
    "- emit no edges if there are no inter-entity dependencies; return an empty array.\n"
    "- do NOT include cycles. If the causal data implies a cycle, omit the weaker edge and add a\n"
    "  reason like 'cycle_break: weaker dependency'."
)


# ---------------------------------------------------------------------------
# Prompt assemblers
# ---------------------------------------------------------------------------


def _assemble(parts: list[str]) -> str:
    return "\n\n".join(p.strip() for p in parts if p and p.strip())


def build_state1_entity_list_prompt(causal_data: str) -> tuple[str, dict[str, Any]]:
    """Build the State 1 prompt (no LLM ranking)."""
    base = _stage("state1_entity_list").get("prompt") or ""
    overridden_base = (
        base
        + "\n\nDo NOT include a 'priority' field. The caller computes priority client-side."
    )
    prompt = _assemble(
        [
            overridden_base,
            STATE1_ENTITY_LIST_SCHEMA_TEXT,
            _runtime("codegen_dedup_policy"),
            _runtime("codegen_exclusion_policy"),
            _runtime("compact_output_policy"),
            "Causal data:\n" + (causal_data or "").strip(),
        ]
    )
    return prompt, STATE1_ENTITY_LIST_SCHEMA


def build_state1b_policy_outline_prompt(
    causal_data: str,
    entities: list[dict[str, Any]],
) -> tuple[str, dict[str, Any]]:
    """Build the State 1b policy outline prompt.

    Outline is needed BEFORE State 2 so generated entity classes expose the
    methods policies will eventually call (fix F3).
    """
    entities_json = json.dumps({"entities": entities or []}, ensure_ascii=False)
    instructions = (
        "Extract EVERY causal mechanism that the system exhibits, as evidenced by the causal data. "
        "A causal mechanism is any condition-action pair — a condition the system currently responds "
        "to and the action it currently takes. Include all types: enforcement rules, state "
        "transitions, feedback responses, resource reactions, overflow/underflow handlers, and any "
        "other behavior the causal data shows. Do NOT limit the number of policies — emit one entry "
        "per distinct causal mechanism, however many that is. "
        "Do NOT propose improvements, corrections, or new behaviors. "
        "Describe the system as-is: what condition already triggers it, which entity already "
        "handles it, and what method that entity already performs. "
        "For each mechanism, output one entry: the observed trigger, the target entity "
        "(or 'environment'), and a method name that reads as the entity's own behavior "
        "(not a policy label)."
    )
    prompt = _assemble(
        [
            instructions,
            STATE1B_POLICY_OUTLINE_SCHEMA_TEXT,
            "Entity list (output of State 1):\n" + entities_json,
            "Causal data:\n" + (causal_data or "").strip(),
        ]
    )
    return prompt, STATE1B_POLICY_OUTLINE_SCHEMA


def build_state1c_entity_dependencies_prompt(
    causal_data: str,
    entities: list[dict[str, Any]],
    policy_outline: list[dict[str, Any]],
) -> tuple[str, dict[str, Any]]:
    """Build the State 1c dependency-DAG prompt.

    The DAG is used by State 2 to pick a topological iteration order — leaves
    first — so each entity already sees its dependencies' interfaces in the
    accumulator.
    """
    entities_json = json.dumps({"entities": entities or []}, ensure_ascii=False)
    policy_json = json.dumps({"policies": policy_outline or []}, ensure_ascii=False)
    instructions = (
        "Identify direct inter-entity dependencies implied by the causal data and the policy "
        "outline. An edge {from: A, to: B} means A's class needs B's class to exist first "
        "(A holds a reference to B, calls B's methods, or models B as a sub-resource). Emit no "
        "speculative edges. If unsure, omit."
    )
    prompt = _assemble(
        [
            instructions,
            STATE1C_ENTITY_DEPENDENCIES_SCHEMA_TEXT,
            _runtime("compact_output_policy"),
            "Entity list (State 1):\n" + entities_json,
            "Policy outline (State 1b):\n" + policy_json,
            "Causal data:\n" + (causal_data or "").strip(),
        ]
    )
    return prompt, STATE1C_ENTITY_DEPENDENCIES_SCHEMA


STATE1D_METRICS_DRAFT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "metrics": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "label": {"type": "string"},
                    "unit": {"type": "string"},
                    "agg": {"type": "string", "enum": ["sum", "mean", "max", "min", "count", "ratio"]},
                    "viz": {"type": "string", "enum": ["line", "bar", "histogram", "gauge", "stacked_area"]},
                    "chart_group": {"type": "string"},
                    "grounding": {"type": "string", "enum": ["causal_explicit", "causal_implicit", "domain_inference"]},
                    "entities": {"type": "array", "items": {"type": "string"}},
                    "entity_id": {"type": "string"},
                    "expected_variable": {"type": "string"},
                    "chart_type": {"type": "string"},
                    "how_to_interpret": {"type": "string"},
                    "required_attrs": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "entity": {"type": "string"},
                                "attr": {"type": "string"},
                            },
                            "required": ["entity", "attr"],
                        },
                    },
                    "sampling_event": {"type": "string", "enum": ["tick", "policy_fired", "entity_created", "entity_destroyed"]},
                    "rationale": {"type": "string"},
                },
                "required": ["name", "label", "agg", "viz", "entity_id", "expected_variable"],
            },
        }
    },
    "required": ["metrics"],
}

STATE1D_METRICS_DRAFT_SCHEMA_TEXT = (
    "Use this JSON schema exactly:\n"
    "{\n"
    '  "metrics": [\n'
    "    {\n"
    '      "name": "snake_case_id",\n'
    '      "label": "Display Name",\n'
    '      "unit": "kg",\n'
    '      "agg": "sum",\n'
    '      "viz": "line",\n'
    '      "chart_group": "optional_group_key",\n'
    '      "grounding": "causal_explicit",\n'
    '      "entities": ["entity_id_1"],\n'
    '      "entity_id": "entity_id_that_owns_variable",\n'
    '      "expected_variable": "human-readable variable concept",\n'
    '      "chart_type": "line",\n'
    '      "how_to_interpret": "one sentence on what to look for in this chart",\n'
    '      "required_attrs": [{"entity": "entity_id", "attr": "attr_name"}],\n'
    '      "sampling_event": "tick",\n'
    '      "rationale": "one sentence why this metric matters"\n'
    "    }\n"
    "  ]\n"
    "}\n"
    "Field rules:\n"
    "- name: snake_case Python identifier.\n"
    "- entity_id: the entity.id from State 1 that owns the primary state variable.\n"
    "- expected_variable: semantic concept the Reporter samples (e.g. 'waste collected per time step').\n"
    "- chart_type: one of line, bar, histogram, gauge, stacked_area — what viz best represents this metric.\n"
    "- how_to_interpret: one sentence a domain reader can use to understand the chart.\n"
    "- required_attrs: guidance names for entity attributes the Reporter will sample.\n"
    "- grounding: 'causal_explicit' if named in causal text, 'causal_implicit' if implied, 'domain_inference' otherwise.\n"
    "- Do NOT invent entity IDs. Only reference entity.id values from the provided entity list."
)


def build_state1d_metrics_draft_prompt(
    *,
    entities: list[dict[str, Any]],
    policy_outline: list[dict[str, Any]],
    dependency_edges: list[dict[str, Any]],
) -> tuple[str, dict[str, Any]]:
    """Build the State 1d metrics draft prompt.

    Reads entity+dependency context from upstream stages and produces
    metric objects with diagram fields: entity_id, expected_variable,
    chart_type, how_to_interpret.
    """
    entities_json = json.dumps({"entities": entities or []}, ensure_ascii=False)
    policy_json = json.dumps({"policies": policy_outline or []}, ensure_ascii=False)
    edges_json = json.dumps({"edges": dependency_edges or []}, ensure_ascii=False)
    instructions = (
        "You are designing the measurement layer of a tick-based agent simulation. "
        "The entities below have already been defined; you must propose metrics that "
        "the simulation can realistically compute and emit each tick or at the end of a run.\n\n"
        "Use the entity list, policy outline (which methods policies call on which entities), "
        "and dependency edges to infer what state each entity will track internally. "
        "Every metric must be derivable from observable state of one or more listed entities.\n\n"
        "For each metric:\n"
        "- entity_id: which entity's state is the primary source\n"
        "- expected_variable: human-readable concept the Reporter samples (e.g. 'waste collected per time step')\n"
        "- chart_type: best visualization for this metric (line/bar/histogram/gauge/stacked_area)\n"
        "- how_to_interpret: one sentence on what a rising/falling value means\n"
        "- required_attrs: list of {entity, attr} guidance names the Reporter must read\n\n"
        "Quality over quantity. Generate only metrics a domain expert would monitor."
    )
    prompt = _assemble(
        [
            instructions,
            STATE1D_METRICS_DRAFT_SCHEMA_TEXT,
            _runtime("compact_output_policy"),
            "Entity list (State 1):\n" + entities_json,
            "Policy outline (State 1b — which methods policies call on which entities):\n" + policy_json,
            "Dependency edges (State 1c):\n" + edges_json,
        ]
    )
    return prompt, STATE1D_METRICS_DRAFT_SCHEMA


# ---------------------------------------------------------------------------
# Topological order (used by State 2 driver in Phase 3)
# ---------------------------------------------------------------------------


def topological_order(
    entities: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> list[str]:
    """Return entity ids in dependency order (leaves first).

    Cycles are broken by dropping the offending edge and recording a warning
    in the logger — caller is responsible for surfacing this through the
    stage event channel if needed.
    """
    ids = [str(e.get("id") or "").strip() for e in entities if e.get("id")]
    id_set = set(ids)
    indeg: dict[str, int] = {i: 0 for i in ids}
    deps: dict[str, list[str]] = {i: [] for i in ids}
    for edge in edges or []:
        a = str(edge.get("from") or "").strip()
        b = str(edge.get("to") or "").strip()
        if a not in id_set or b not in id_set or a == b:
            continue
        # 'a depends on b' → b must come before a → edge b → a in the toposort
        deps[b].append(a)
        indeg[a] += 1

    queue = [i for i in ids if indeg[i] == 0]
    out: list[str] = []
    while queue:
        nxt = queue.pop(0)
        out.append(nxt)
        for child in deps[nxt]:
            indeg[child] -= 1
            if indeg[child] == 0:
                queue.append(child)

    if len(out) != len(ids):
        leftover = [i for i in ids if i not in out]
        logger.warning(
            "[code_gen][prompts] dependency cycle detected; appending leftover entities: %s",
            leftover,
        )
        out.extend(leftover)
    return out


# ---------------------------------------------------------------------------
# Helpers used by Phase 3 (kept here so all prompt-side utilities live together)
# ---------------------------------------------------------------------------


def concat_with_delimiters(files: list[tuple[str, str]]) -> str:
    """Join (filename, code) pairs into a single delimited blob.

    Mirrors ``code_gen_checkpoints.concat_iterations_with_delimiters`` for
    callers that have files in hand rather than disk-backed iterations.
    """
    chunks: list[str] = []
    for name, code in files:
        if not code or not code.strip():
            continue
        chunks.append(ACCUMULATOR_FILE_DELIMITER.format(name=name))
        chunks.append(code.rstrip())
        chunks.append("")
    return "\n".join(chunks)


# ---------------------------------------------------------------------------
# State 2 / 3 / 4 prompt builders
# ---------------------------------------------------------------------------


# Default time-protocol surface — see fix F1 in docs/code-gen-pipeline.md.
ENTITY_TIME_PROTOCOL = (
    "Time protocol contract (mandatory):\n"
    "- The class MUST define `def step(self, dt: float, env: \"Environment\") -> None` that\n"
    "  advances internal state by `dt` simulation seconds. All mutation happens here.\n"
    "- The class MUST NOT call `time.sleep`, `asyncio.sleep`, `datetime.now`, `time.time`,\n"
    "  `time.monotonic`, or any other wall-clock or sleep API.\n"
    "- The class MUST NOT spawn threads, processes, or async tasks.\n"
    "- All scheduling is owned by the Environment (`Environment.tick(dt)`); entities only\n"
    "  react to `step(dt, env)` calls.\n"
    "- If the policy outline expects a method on this class, define that method. Policies will\n"
    "  invoke it through `before_tick` / `after_tick` hooks."
)

ENVIRONMENT_TIME_PROTOCOL = (
    "Time protocol contract (mandatory):\n"
    "- The class MUST define `def tick(self, dt: float) -> None` that:\n"
    "    1. invokes every registered policy's `before_tick(env, dt)` hook,\n"
    "    2. iterates entities in the order provided to the constructor and calls\n"
    "       `entity.step(dt, self)` on each,\n"
    "    3. invokes every policy's `after_tick(env, dt)` hook.\n"
    "- Constructor MUST accept `entities: list` and `policies: list` (default `[]`).\n"
    "- The class MUST NOT call `time.sleep`, `asyncio.sleep`, `datetime.now`, `time.time`,\n"
    "  `time.monotonic`, or any wall-clock / sleep API. Wall time is supplied via `dt`."
)

POLICY_TIME_PROTOCOL = (
    "Time protocol contract (mandatory):\n"
    "- The class MUST expose `before_tick(self, env, dt)` and `after_tick(self, env, dt)`.\n"
    "  At least one of them MUST contain real logic; the other may be a no-op.\n"
    "- The class MUST NOT call `time.sleep`, `asyncio.sleep`, `datetime.now`, `time.time`,\n"
    "  `time.monotonic`, or any wall-clock / sleep API.\n"
    "- The policy MUST mutate state ONLY by calling methods on `env` or on entities reached\n"
    "  through `env.entities`. Do not redefine entity / environment logic."
)


def build_state2_cached_context(*, causal_data: str) -> list[str]:
    """Pieces of State 2 that don't change across the per-entity loop.

    Returned as a list of text chunks suitable to feed into
    ``GeminiGateway.create_cache``. Pulling these out of every iteration
    is the whole point of caching — the same causal data and policy
    snippets currently get re-uploaded for every entity.
    """
    parts = [
        "CRITICAL IMPORTS: Your generated entity code MUST include this import at the top:\n"
        "  from entity_object_template import entity_object\n"
        "(Use absolute import without leading dot. All template files are in the same directory.)\n"
        "This template file is provided in the artifacts directory.\n"
        "Do NOT attempt to define entity_object yourself — import it from the template.",
        ENTITY_TIME_PROTOCOL,
        _runtime("codegen_template_routing_policy"),
        _runtime("codegen_accumulation_policy"),
        _runtime("codegen_entity_object_output_hint"),
        _runtime("compact_output_policy"),
        "Causal data:\n" + (causal_data or "").strip(),
    ]
    if ENTITY_OBJECT_TEMPLATE:
        parts.append(
            "Base class — your entity class MUST subclass `entity_object` defined below. "
            "Implement only the trait methods relevant to this entity (active/passive/hybrid). "
            "Do NOT redefine the base class itself:\n\n```python\n"
            + ENTITY_OBJECT_TEMPLATE
            + "\n```"
        )
    return parts


def build_state2_entity_prompt(
    *,
    causal_data: str,
    entity_id: str,
    entity_obj: dict[str, Any],
    accumulator_blob: str,
    interface_digest: dict[str, Any],
    policy_outline: list[dict[str, Any]],
    selected_metrics: list[dict[str, Any]] | None = None,
    retry_error: str | None = None,
    omit_cached_context: bool = False,
) -> str:
    """Build the State 2 prompt for one entity iteration.

    When ``omit_cached_context`` is True the stable prefix returned by
    :func:`build_state2_cached_context` is left out — the caller is
    expected to pass the cache name via ``cached_content`` in the request
    so Gemini stitches them back together upstream.
    
    When ``selected_metrics`` is provided, builds a guidance section that
    instructs the entity to expose numeric state attributes matching metric
    requirements.
    """
    base = (_stage("state2_code_entity_object").get("prompt") or "")
    base = base.replace("{entity_id}", entity_id)
    class_name = entity_label_to_class_name(entity_id or entity_obj.get("label") or entity_id)
    class_name_instruction = (
        f"The Python class name for this entity MUST be `{class_name}`. "
        "Use this exact name — not the entity id, not a numeric variant."
    )
    digest_json = json.dumps(interface_digest or {"classes": []}, ensure_ascii=False)
    relevant_policies = [
        p
        for p in (policy_outline or [])
        if p.get("target_entity_id") == entity_id
    ]
    policy_json = json.dumps({"policies": relevant_policies}, ensure_ascii=False)
    accumulator_section = (
        "Already generated entity code (single delimited blob — DO NOT redefine):\n"
        + (accumulator_blob.strip() if accumulator_blob.strip() else "(empty — this is the first entity)")
    )
    retry_section = (
        f"Previous attempt failed validation. Fix and retry. Error:\n{retry_error.strip()}"
        if retry_error
        else ""
    )
    
    # Build metric guidance sections (Sub-sections A and B per Section 13b)
    metric_guidance_section = ""
    if selected_metrics:
        # Filter metrics where entity_id matches — check both entity_id field and entities list
        entity_metrics = [
            m for m in selected_metrics
            if isinstance(m, dict) and (
                m.get("entity_id") == entity_id
                or entity_id in (m.get("entities") or [])
            )
        ]
        if entity_metrics:
            # Sub-section A: reference metrics context
            ref_lines: list[str] = []
            on_query_examples: list[str] = []
            attr_set: set[str] = set()
            for m in entity_metrics:
                m_name = str(m.get("name") or "")
                m_label = str(m.get("label") or m_name)
                m_chart = str(m.get("chart_type") or m.get("viz") or "line")
                m_expected = str(m.get("expected_variable") or "")
                attrs_for_entity = [
                    str(dep.get("attr") or "")
                    for dep in (m.get("required_attrs") or [])
                    if isinstance(dep, dict) and dep.get("entity") == entity_id and dep.get("attr")
                ]
                attr_set.update(attrs_for_entity)
                track_hint = f"→ This entity should track: {', '.join(attrs_for_entity)}" if attrs_for_entity else ""
                ref_lines.append(
                    f'  Metric "{m_name}" (chart: {m_chart}, entity: {entity_id})\n'
                    f"    expected_variable: \"{m_expected}\"\n"
                    + (f"    {track_hint}\n" if track_hint else "")
                )
                if attrs_for_entity:
                    kv = ", ".join(f'"{a}": self.{a}' for a in attrs_for_entity)
                    on_query_examples.append(
                        f'      if metric_name == "{m_name}":\n          return {{{kv}}}'
                    )

            section_a = (
                "Reference metrics for this simulation — your entity attributes MUST support these measurements:\n"
                + "".join(ref_lines)
                + "These metrics tell you what state this entity needs to maintain internally."
            )
            section_b_body = "\n".join(on_query_examples) if on_query_examples else "      return {}"
            section_b = (
                "Metric Reporter contracts — implement on_query() to expose these attrs:\n"
                "  def on_query(self, metric_name: str) -> dict:\n"
                "      # Must return dict with the exact keys the metric expects.\n"
                + section_b_body + "\n\n"
                "on_query() base signature already defined in entity_object_template.py — override it."
            )
            metric_guidance_section = section_a + "\n\n" + section_b
    
    sections: list[str] = [base, class_name_instruction]
    if not omit_cached_context:
        sections.extend(build_state2_cached_context(causal_data=causal_data))
    sections.extend(
        [
            "Entity object (from State 1):\n"
            + json.dumps(entity_obj or {"id": entity_id}, ensure_ascii=False),
            "Methods this class MUST expose for policies (from State 1b):\n" + policy_json,
            "Interface digest of prior entities (signatures only):\n" + digest_json,
            accumulator_section,
        ]
    )
    if metric_guidance_section:
        sections.append(metric_guidance_section)
    if omit_cached_context:
        sections.append(
            "(Stable causal data + policy boilerplate are provided via the request's cached_content.)"
        )
    if retry_section:
        sections.append(retry_section)
    return _assemble(sections)


def build_state3_environment_prompt(
    *,
    entities_blob: str,
    policy_outline: list[dict[str, Any]],
    map_graph: dict[str, Any] | None,
    retry_error: str | None = None,
) -> str:
    base = _stage("state3_code_environment").get("prompt") or ""

    # Map section — always required, but show only sample to keep prompt size bounded
    if isinstance(map_graph, dict) and map_graph:
        vertices = map_graph.get("vertices") or map_graph.get("nodes") or []
        edges = map_graph.get("edges") or []
        node_types = list({n.get("type") for n in vertices if n.get("type")})
        sample_nodes = json.dumps(vertices[:3], ensure_ascii=False)
        sample_edges = json.dumps(edges[:3], ensure_ascii=False)
        map_section = (
            "Map graph (nodes + edges) — ALREADY WRITTEN as map.json artifact in artifacts dir.\n"
            "DO NOT hardcode this data. Call self._load_map() via super().__init__() — it loads automatically.\n"
            f"Node types present: {json.dumps(node_types, ensure_ascii=False)}\n"
            f"Sample nodes: {sample_nodes}\n"
            f"Sample edges: {sample_edges}\n"
            "Accessor methods available (from SimulationEnvironment base):\n"
            "  env.get_nodes(type=None) → list of node dicts\n"
            "  env.get_node(node_id) → node dict or None\n"
            "  env.get_edges() → list of edge dicts\n"
            "  env.get_neighbors(node_id) → list of neighbor node IDs\n"
            "  env.get_node_types() → list of type strings"
        )
    else:
        map_section = "Map graph: unavailable."

    policy_outline_section = (
        "Policy outline (entity behaviours this environment must support):\n"
        + json.dumps(
            [
                {k: r.get(k) for k in ("rule_id", "trigger", "target_entity_id", "target_method") if r.get(k)}
                for r in (policy_outline or [])
            ],
            ensure_ascii=False,
        )
        + "\nUse this to understand what entity methods get called and what map traversal the policies expect."
    )

    retry_section = (
        f"Previous attempt failed validation. Fix and retry. Error:\n{retry_error.strip()}"
        if retry_error
        else ""
    )
    env_template_section = (
        "Base class — your Environment class MUST extend `SimulationEnvironment` defined below. "
        "Override or extend only what this simulation needs; do NOT redefine the base:\n\n"
        "```python\n" + ENVIRONMENT_TEMPLATE + "\n```"
        if ENVIRONMENT_TEMPLATE
        else ""
    )
    import_instructions = (
        "CRITICAL IMPORTS: Your generated code MUST include this import at the top:\n"
        "  from environment_template import SimulationEnvironment\n"
        "(Use absolute import without leading dot. All template files are in the same directory.)\n"
        "This template file is provided in the artifacts directory.\n"
        "Do NOT attempt to define SimulationEnvironment yourself — import it from the template."
    )
    entity_classes_instruction = (
        "CRITICAL: Entity classes are PROVIDED TO THE CONSTRUCTOR, NOT imported:\n"
        "- Your __init__ MUST accept `entities: list` parameter (list of Entity instances).\n"
        "- Store them: `self.entities = entities` (or name dict/list by entity_id for lookups).\n"
        "- Access at runtime: use `self.entities` — do NOT import entity modules.\n"
        "- Do NOT add import statements for entity classes.\n"
        "Below are the entity class definitions for your reference (read-only):\n"
        + (entities_blob.strip() if entities_blob.strip() else "(empty)")
    )
    return _assemble(
        [
            base,
            import_instructions,
            ENVIRONMENT_TIME_PROTOCOL,
            _runtime("codegen_environment_output_hint"),
            _runtime("compact_output_policy"),
            env_template_section,
            entity_classes_instruction,
            policy_outline_section,
            map_section,
            retry_section,
        ]
    )


def build_state4_policy_prompt(
    *,
    causal_data: str,
    rule: dict[str, Any],
    entities_blob: str,
    environment_code: str,
    policies_accumulator: str,
    map_graph: dict[str, Any] | None = None,
    retry_error: str | None = None,
) -> str:
    base = _stage("state4_code_policy").get("prompt") or ""
    rule_id = str(rule.get("rule_id") or "policy")
    base = base.replace("{policy_rule}", rule_id)
    policy_class_name = entity_label_to_class_name(rule.get("label") or rule_id) + "Policy"
    class_name_instruction = (
        f"The Python class name for this policy MUST be `{policy_class_name}`. "
        "Use this exact name — not the rule id, not a numeric variant."
    )
    rule_json = json.dumps(rule, ensure_ascii=False)
    retry_section = (
        f"Previous attempt failed validation. Fix and retry. Error:\n{retry_error.strip()}"
        if retry_error
        else ""
    )
    policy_template_section = (
        "Base class — your Policy class MUST subclass `Policy` defined below. "
        "Implement `apply` and optionally override `is_applicable_to`. "
        "Do NOT redefine the base class:\n\n"
        "```python\n" + POLICY_BASE_TEMPLATE + "\n```\n\n"
        "CRITICAL INSTRUCTION: Output ONLY your concrete policy implementation class. "
        "Do NOT include the abstract base `Policy` class in your output. "
        "The template above is reference material only — use it to understand the interface, "
        "then output only the concrete policy class (e.g., `" + policy_class_name + "`) that implements it."
        if POLICY_BASE_TEMPLATE
        else ""
    )
    import_instructions = (
        "CRITICAL IMPORTS: Your generated policy code MUST include this import at the top:\n"
        "  from policy_template import Policy\n"
        "(Use absolute import without leading dot. All template files are in the same directory.)\n"
        "This template file is provided in the artifacts directory.\n"
        "Do NOT attempt to define the Policy base class yourself — import it from the template."
    )
    # Map accessor API section (Section 10)
    map_interface_section = ""
    if isinstance(map_graph, dict) and map_graph:
        vertices = map_graph.get("vertices") or map_graph.get("nodes") or []
        node_types = list({n.get("type") for n in vertices if n.get("type")})
        map_interface_section = (
            "Map accessor API (call these on the `env` parameter, do NOT hardcode node IDs):\n"
            f"  env.get_nodes(type=None) → list of node dicts with keys: id, label, type, x, y, neighbors\n"
            "  env.get_node(node_id: str) → node dict or None\n"
            "  env.get_edges() → list of edge dicts with keys: id, source, target, label, weight\n"
            "  env.get_neighbors(node_id: str) → list of neighbor node IDs (strings)\n"
            "  env.get_node_types() → list[str]  — available node type strings in this map\n"
            f"  Node types available: {json.dumps(node_types, ensure_ascii=False)}"
        )

    return _assemble(
        [
            base,
            class_name_instruction,
            import_instructions,
            POLICY_TIME_PROTOCOL,
            _runtime("codegen_policy_accumulation_policy"),
            _runtime("codegen_fallback_policy_context"),
            _runtime("codegen_policy_output_hint"),
            _runtime("compact_output_policy"),
            policy_template_section,
            "Policy rule contract (from State 1b):\n" + rule_json,
            "Entity classes (single delimited blob):\n"
            + (entities_blob.strip() if entities_blob.strip() else "(empty)"),
            "Environment class code:\n"
            + (environment_code.strip() if environment_code.strip() else "(empty)"),
            map_interface_section,
            "Already generated policy code (single delimited blob):\n"
            + (policies_accumulator.strip() if policies_accumulator.strip() else "(empty)"),
            "Causal data:\n" + (causal_data or "").strip(),
            retry_section,
        ]
    )


# ---------------------------------------------------------------------------
# Output sanitization + protocol validators
# ---------------------------------------------------------------------------


_FORBIDDEN_TIME_TOKENS: tuple[str, ...] = (
    "time.sleep",
    "asyncio.sleep",
    "datetime.now",
    "datetime.utcnow",
    "time.time(",
    "time.monotonic",
    "time.perf_counter",
)


def strip_code_fences(raw: str) -> str:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
    if text.endswith("```"):
        text = text.rsplit("```", 1)[0]
    return text.strip()


def _walk_classes(tree: ast.AST) -> list[ast.ClassDef]:
    return [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)]


def _has_method(cls: ast.ClassDef, name: str) -> bool:
    for child in cls.body:
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) and child.name == name:
            return True
    return False


def _forbidden_tokens_in_source(src: str) -> list[str]:
    return [tok for tok in _FORBIDDEN_TIME_TOKENS if tok in src]


def validate_entity_protocol(
    src: str,
    *,
    required_methods: list[str] | None = None,
) -> list[str]:
    """Return a list of human-readable errors. Empty list = passes."""
    errors: list[str] = []
    src = src or ""
    if not src.strip():
        return ["empty source"]
    try:
        tree = ast.parse(src)
    except SyntaxError as exc:
        return [f"syntax error: {exc}"]
    classes = _walk_classes(tree)
    if not classes:
        return ["no class definition found"]
    cls = classes[0]
    if not _has_method(cls, "step"):
        errors.append(f"class {cls.name!r} must define `step(self, dt, env)`")
    for required in required_methods or []:
        if not _has_method(cls, required):
            errors.append(f"class {cls.name!r} must define method {required!r} (required by policy outline)")
    forbidden = _forbidden_tokens_in_source(src)
    if forbidden:
        errors.append(f"forbidden time/sleep API used: {', '.join(forbidden)}")
    return errors


def validate_environment_protocol(src: str) -> list[str]:
    errors: list[str] = []
    src = src or ""
    if not src.strip():
        return ["empty source"]
    try:
        tree = ast.parse(src)
    except SyntaxError as exc:
        return [f"syntax error: {exc}"]
    classes = _walk_classes(tree)
    if not classes:
        return ["no class definition found"]
    cls = classes[0]
    if not _has_method(cls, "tick"):
        errors.append(f"class {cls.name!r} must define `tick(self, dt)`")
    if not _has_method(cls, "__init__"):
        errors.append(f"class {cls.name!r} must define `__init__` to accept entities")
    forbidden = _forbidden_tokens_in_source(src)
    if forbidden:
        errors.append(f"forbidden time/sleep API used: {', '.join(forbidden)}")
    return errors


def validate_policy_protocol(src: str) -> list[str]:
    errors: list[str] = []
    src = src or ""
    if not src.strip():
        return ["empty source"]
    try:
        tree = ast.parse(src)
    except SyntaxError as exc:
        return [f"syntax error: {exc}"]
    classes = _walk_classes(tree)
    if not classes:
        return ["no class definition found"]
    cls = classes[-1]  # Use last class (concrete implementation, not base template)
    if not (_has_method(cls, "before_tick") or _has_method(cls, "after_tick")):
        errors.append(f"class {cls.name!r} must define `before_tick` or `after_tick`")
    forbidden = _forbidden_tokens_in_source(src)
    if forbidden:
        errors.append(f"forbidden time/sleep API used: {', '.join(forbidden)}")
    return errors


def interface_digest_from_source(src: str) -> dict[str, Any]:
    """Extract a body-less interface digest from a Python source file.

    Returns ``{"classes": [{"name", "bases", "methods", "attributes"}]}``.
    Used in Phase 3 to keep State 2 / State 4 prompts small.
    """
    try:
        tree = ast.parse(src)
    except SyntaxError as exc:
        logger.warning("[code_gen][prompts] interface_digest parse failed: %s", exc)
        return {"classes": [], "_parseError": str(exc)}

    classes: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        bases = [ast.unparse(b) for b in node.bases]
        methods: list[dict[str, Any]] = []
        attributes: list[dict[str, Any]] = []
        for child in node.body:
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if child.name.startswith("_") and child.name not in {"__init__"}:
                    continue
                methods.append(
                    {
                        "name": child.name,
                        "args": [a.arg for a in child.args.args],
                        "doc": ast.get_docstring(child) or "",
                    }
                )
            elif isinstance(child, ast.AnnAssign) and isinstance(child.target, ast.Name):
                annotation = ast.unparse(child.annotation) if child.annotation else ""
                attributes.append({"name": child.target.id, "annotation": annotation})
        classes.append(
            {
                "name": node.name,
                "bases": bases,
                "methods": methods,
                "attributes": attributes,
            }
        )
    return {"classes": classes}


# ---------------------------------------------------------------------------
# Section 12 — Policy self-verification judge prompts
# ---------------------------------------------------------------------------

_JUDGE_PASS1_TEMPLATE = """You are a Python code reviewer checking a simulation policy module.

Policy contract:
  rule_id: {rule_id}
  label: {label}
  trigger: {trigger}
  target: {target_entity_id}.{target_method}
  description: {description}

Available entity class interfaces:
{entity_interfaces}
{map_section}
Policy code under review:
```python
{policy_code}
```

Identify concrete bugs only — wrong method signatures, missing imports, undefined names,
incorrect entity method calls, broken Policy base-class inheritance, or runtime errors.
Do NOT report style issues or minor formatting.

Return JSON only (no prose, no markdown):
{{
  "issues": [
    {{
      "severity": "critical",
      "location": "method_or_line_description",
      "description": "what is wrong",
      "suggested_fix": "how to fix it"
    }}
  ],
  "verdict": "pass"
}}
If there are no issues return {{"issues": [], "verdict": "pass"}}.
If there are issues return {{"issues": [...], "verdict": "fail"}}.
"""

_JUDGE_PASS2_TEMPLATE = """You are fixing bugs in a simulation policy module.

Issues identified:
{issues_text}

Original policy code:
```python
{policy_code}
```

Entity class interfaces:
{entity_interfaces}
{map_section}
Return ONLY the fixed Python code. No markdown fences, no explanation.
"""

JUDGE_PASS1_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "severity": {"type": "string", "enum": ["critical", "warning"]},
                    "location": {"type": "string"},
                    "description": {"type": "string"},
                    "suggested_fix": {"type": "string"},
                },
                "required": ["severity", "location", "description"],
            },
        },
        "verdict": {"type": "string", "enum": ["pass", "fail"]},
    },
    "required": ["issues", "verdict"],
}


def _format_entity_interfaces(entity_code_index: dict[str, str]) -> str:
    parts: list[str] = []
    for entity_id, src in entity_code_index.items():
        digest = interface_digest_from_source(src)
        classes = digest.get("classes") or []
        lines: list[str] = [f"# entity: {entity_id}"]
        for cls in classes:
            bases = ", ".join(cls.get("bases") or [])
            lines.append(f"class {cls['name']}({bases}):")
            for method in cls.get("methods") or []:
                args = ", ".join(method.get("args") or [])
                lines.append(f"    def {method['name']}({args}): ...")
        parts.append("\n".join(lines))
    return "\n\n".join(parts) if parts else "(no entity interfaces available)"


def build_policy_judge_pass1_prompt(
    *,
    policy_code: str,
    rule_contract: dict[str, Any],
    entity_code_index: dict[str, str],
    map_accessor_api: str,
) -> str:
    """Pass 1: identify bugs in a generated policy."""
    map_section = (
        f"\nMap accessor API available on env:\n{map_accessor_api}\n"
        if map_accessor_api.strip()
        else ""
    )
    return _JUDGE_PASS1_TEMPLATE.format(
        rule_id=str(rule_contract.get("rule_id") or ""),
        label=str(rule_contract.get("label") or ""),
        trigger=str(rule_contract.get("trigger") or ""),
        target_entity_id=str(rule_contract.get("target_entity_id") or ""),
        target_method=str(rule_contract.get("target_method") or ""),
        description=str(rule_contract.get("description") or ""),
        entity_interfaces=_format_entity_interfaces(entity_code_index),
        map_section=map_section,
        policy_code=policy_code[:8000],
    )


def build_policy_judge_pass2_prompt(
    *,
    policy_code: str,
    rule_contract: dict[str, Any],
    entity_code_index: dict[str, str],
    map_accessor_api: str,
    issues: list[dict[str, Any]],
) -> str:
    """Pass 2: fix the issues identified in pass 1."""
    map_section = (
        f"\nMap accessor API available on env:\n{map_accessor_api}\n"
        if map_accessor_api.strip()
        else ""
    )
    issues_text = "\n".join(
        f"- [{i.get('severity','?')}] {i.get('location','?')}: {i.get('description','?')}"
        f"{' → ' + i['suggested_fix'] if i.get('suggested_fix') else ''}"
        for i in (issues or [])
    ) or "(none)"
    return _JUDGE_PASS2_TEMPLATE.format(
        issues_text=issues_text,
        policy_code=policy_code[:8000],
        entity_interfaces=_format_entity_interfaces(entity_code_index),
        map_section=map_section,
    )
