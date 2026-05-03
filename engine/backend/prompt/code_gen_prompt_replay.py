#!/usr/bin/env python3
"""Replay raw code-generation prompt text from current backend prompt builders.

Sister script to ``map_extract_prompt_replay.py``. Does not call any model —
it simply reconstructs the full prompt body each stage would send so a human
can audit them. Stage 1c, 2v and 4v are AST-only validators with no LLM call,
so they are skipped here.

Usage:
    python code_gen_prompt_replay.py \\
        --causal-data "JANITOR collects garbage every 30 min." \\
        --entity-id janitor_1 \\
        --rule-id policy_collect

All inputs are optional; defaults are placeholder strings so the script runs
out-of-the-box.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# Make the backend prompt module importable without triggering ``app.api``,
# which has heavy runtime deps (FastAPI, google-genai). We load
# ``code_gen_prompts`` directly via ``importlib.util``.
import importlib.util  # noqa: E402

HERE = Path(__file__).resolve()
BACKEND_ROOT = HERE.parent.parent  # engine/backend/
PROMPTS_PATH = BACKEND_ROOT / "app" / "services" / "code_gen_prompts.py"

_spec = importlib.util.spec_from_file_location("code_gen_prompts", PROMPTS_PATH)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"Could not load module spec for {PROMPTS_PATH}")
prompts = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(prompts)


def _fmt(title: str, body: str) -> str:
    line = "=" * 90
    return f"\n{line}\n{title}\n{line}\n{body.strip()}\n"


def _placeholder_entity_object(entity_id: str) -> dict[str, Any]:
    return {
        "id": entity_id,
        "label": entity_id.replace("_", " ").title(),
        "type": "actor",
        "frequency": 1,
    }


def _placeholder_policy_outline(entity_id: str, rule_id: str) -> list[dict[str, Any]]:
    return [
        {
            "rule_id": rule_id,
            "label": "Sample policy",
            "trigger": "every_tick",
            "target_entity_id": entity_id,
            "target_method": "act",
            "inputs": ["dt"],
            "description": "Placeholder rule — replace with the real outline row.",
        }
    ]


def _placeholder_interface_digest() -> dict[str, Any]:
    return {
        "classes": [
            {
                "name": "Truck",
                "methods": [
                    {"name": "step", "args": ["self", "dt", "env"], "returns": "None"},
                    {"name": "load", "args": ["self", "amount"], "returns": "None"},
                ],
            }
        ]
    }


def _placeholder_entities_blob() -> str:
    return prompts.concat_with_delimiters(
        [
            (
                "truck.py",
                "class Truck:\n"
                "    def __init__(self, capacity: float):\n"
                "        self.capacity = capacity\n"
                "    def step(self, dt: float, env) -> None:\n"
                "        pass\n",
            )
        ]
    )


def build_all_prompts(
    *,
    causal_data: str,
    entity_id: str,
    rule_id: str,
    map_node_json: dict[str, Any] | None,
) -> dict[str, str]:
    placeholder_entities = [_placeholder_entity_object(entity_id)]
    placeholder_outline = _placeholder_policy_outline(entity_id, rule_id)
    entities_blob = _placeholder_entities_blob()
    interface_digest = _placeholder_interface_digest()

    state1_prompt, _state1_schema = prompts.build_state1_entity_list_prompt(causal_data)
    state1b_prompt, _state1b_schema = prompts.build_state1b_policy_outline_prompt(
        causal_data, placeholder_entities
    )
    state1c_prompt, _state1c_schema = prompts.build_state1c_entity_dependencies_prompt(
        causal_data, placeholder_entities, placeholder_outline
    )

    state2_prompt = prompts.build_state2_entity_prompt(
        causal_data=causal_data,
        entity_id=entity_id,
        entity_obj=_placeholder_entity_object(entity_id),
        accumulator_blob=entities_blob,
        interface_digest=interface_digest,
        policy_outline=placeholder_outline,
        retry_error=None,
    )

    state3_prompt = prompts.build_state3_environment_prompt(
        causal_data=causal_data,
        entities_blob=entities_blob,
        map_node_json=map_node_json,
        retry_error=None,
    )

    state4_prompt = prompts.build_state4_policy_prompt(
        causal_data=causal_data,
        rule=placeholder_outline[0],
        entities_blob=entities_blob,
        environment_code=(
            "class Environment:\n"
            "    def __init__(self, entities=None, policies=None):\n"
            "        self.entities = list(entities or [])\n"
            "        self.policies = list(policies or [])\n"
            "    def tick(self, dt: float) -> None:\n"
            "        pass\n"
        ),
        policies_accumulator="",
        retry_error=None,
    )

    return {
        "stage_1_entity_list": state1_prompt,
        "stage_1b_policy_outline": state1b_prompt,
        "stage_1c_entity_dependencies": state1c_prompt,
        "stage_2_code_entity_object": state2_prompt,
        "stage_3_code_environment": state3_prompt,
        "stage_4_code_policy": state4_prompt,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Reconstruct raw code-generation stage prompts from the backend prompt builders."
    )
    parser.add_argument(
        "--causal-data",
        default="<paste causal data block>",
        help="Causal data text fed to every prompt.",
    )
    parser.add_argument(
        "--entity-id",
        default="entity_1",
        help="Entity id used as the State-2 iteration target.",
    )
    parser.add_argument(
        "--rule-id",
        default="policy_1",
        help="Policy rule id used as the State-4 iteration target.",
    )
    parser.add_argument(
        "--map-node-json",
        type=Path,
        default=None,
        help="Optional path to a JSON file with map node graph; passed to State 3.",
    )
    args = parser.parse_args()

    map_node_json: dict[str, Any] | None = None
    if args.map_node_json is not None:
        loaded = json.loads(args.map_node_json.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            print("--map-node-json must contain a JSON object.", file=sys.stderr)
            return 2
        map_node_json = loaded

    rendered = build_all_prompts(
        causal_data=args.causal_data,
        entity_id=args.entity_id,
        rule_id=args.rule_id,
        map_node_json=map_node_json,
    )

    for stage_name, prompt_body in rendered.items():
        print(_fmt(stage_name, prompt_body))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
