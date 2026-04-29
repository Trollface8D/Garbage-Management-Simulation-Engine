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
from functools import lru_cache
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

ACCUMULATOR_FILE_DELIMITER = "# === FILE: {name} ==="

INSTRUCTIONS_PATH: Path = (
    Path(__file__).resolve().parents[2] / "prompt" / "code_generation_instruction.json"
)

_TEMPLATE_DIR: Path = (
    Path(__file__).resolve().parents[4]
    / "Experiment/code_generation/entity_design/entity/gemini_3_pro_entity/template"
)


def _read_template(name: str) -> str:
    try:
        return (_TEMPLATE_DIR / name).read_text(encoding="utf-8")
    except OSError:
        logger.warning("[code_gen][prompts] template not found: %s", name)
        return ""


ENTITY_OBJECT_TEMPLATE: str = _read_template("entity_object_template.py")
ENVIRONMENT_TEMPLATE: str = _read_template("environment_template.py")
POLICY_BASE_TEMPLATE: str = _read_template("policy_template.py")


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
    "- id: normalized snake_case identifier derived from label.\n"
    "- label: exact surface form as it appears in causal data.\n"
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
        "Identify every behavior-change rule the causal data implies. For each rule, output a row "
        "describing the trigger, the target entity (or 'environment'), and the method name the "
        "rule will call on the target. The target class will be implemented in State 2 and MUST "
        "expose this method, so pick names that read like real entity behavior, not policy names."
    )
    prompt = _assemble(
        [
            instructions,
            STATE1B_POLICY_OUTLINE_SCHEMA_TEXT,
            _runtime("compact_output_policy"),
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
    retry_error: str | None = None,
    omit_cached_context: bool = False,
) -> str:
    """Build the State 2 prompt for one entity iteration.

    When ``omit_cached_context`` is True the stable prefix returned by
    :func:`build_state2_cached_context` is left out — the caller is
    expected to pass the cache name via ``cached_content`` in the request
    so Gemini stitches them back together upstream.
    """
    base = (_stage("state2_code_entity_object").get("prompt") or "")
    base = base.replace("{entity_id}", entity_id)
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
    sections: list[str] = [base]
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
    if omit_cached_context:
        sections.append(
            "(Stable causal data + policy boilerplate are provided via the request's cached_content.)"
        )
    if retry_section:
        sections.append(retry_section)
    return _assemble(sections)


def build_state3_environment_prompt(
    *,
    causal_data: str,
    entities_blob: str,
    map_node_json: dict[str, Any] | None,
    retry_error: str | None = None,
) -> str:
    base = _stage("state3_code_environment").get("prompt") or ""
    map_section: str
    if isinstance(map_node_json, dict) and map_node_json:
        map_section = (
            "Extracted map node JSON (use coordinate / type / label fields for spatial layout):\n"
            + json.dumps(map_node_json, ensure_ascii=False)
        )
        fallback = ""
    else:
        map_section = "Map node JSON unavailable."
        fallback = _runtime("codegen_fallback_map_policy")
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
    return _assemble(
        [
            base,
            ENVIRONMENT_TIME_PROTOCOL,
            _runtime("codegen_map_input_policy"),
            fallback,
            _runtime("codegen_environment_output_hint"),
            _runtime("compact_output_policy"),
            env_template_section,
            "Entity classes (single delimited blob — import / reference, do NOT redefine):\n"
            + (entities_blob.strip() if entities_blob.strip() else "(empty)"),
            map_section,
            "Causal data:\n" + (causal_data or "").strip(),
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
    retry_error: str | None = None,
) -> str:
    base = _stage("state4_code_policy").get("prompt") or ""
    rule_id = str(rule.get("rule_id") or "policy")
    base = base.replace("{policy_rule}", rule_id)
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
        "```python\n" + POLICY_BASE_TEMPLATE + "\n```"
        if POLICY_BASE_TEMPLATE
        else ""
    )
    return _assemble(
        [
            base,
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
    cls = classes[0]
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
