"""Entrypoint for the generated simulation bundle.

Constructs the Environment, runs N ticks, hands each tick to the Reporter
which writes a JSONL metrics trace under ``runs/<run_id>/metrics.jsonl``.

Usage::

    python run.py --ticks 100 --tick-seconds 300

The Reporter and metric contract files live next to this script.
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
from datetime import datetime, timezone
from pathlib import Path

from environment import Environment
from reporter import Reporter


def _snapshot(inst: object) -> dict:
    out = {}
    for k, v in vars(inst).items():
        if k.startswith("_"):
            continue
        if isinstance(v, (int, float, str, bool)):
            out[k] = v
    return out


class EntityInteractionLogger:
    """Writes entity state-change diffs to entity_interactions.txt per tick."""

    def __init__(self, out_dir: "Path", run_id: str, tick_seconds: float) -> None:
        self._path = out_dir / "entity_interactions.txt"
        out_dir.mkdir(parents=True, exist_ok=True)
        self._fp = self._path.open("w", encoding="utf-8")
        self._tick_seconds = tick_seconds
        self._fp.write(f"=== Entity Interaction Log  run_id={run_id} ===\n")
        self._fp.write(f"tick_seconds={tick_seconds}\n\n")
        self._prev: dict = {}

    def _fmt_time(self, t: float) -> str:
        total = int(t)
        h = total // 3600
        m = (total % 3600) // 60
        s = total % 60
        return f"{h:02d}:{m:02d}:{s:02d}"

    def record(self, entities: list, tick_number: int, env: object) -> None:
        t = tick_number * self._tick_seconds
        lines = [f"--- tick {tick_number:>4}  t={self._fmt_time(t)} ---"]
        for inst in entities:
            name = type(inst).__name__
            eid  = getattr(inst, "entity_object_id", name)
            snap = _snapshot(inst)
            prev = self._prev.get(eid, {})
            changes = {k: (prev.get(k), v) for k, v in snap.items() if prev.get(k) != v}
            if changes:
                lines.append(f"  [{name}] id={eid}")
                for attr, (old, new) in changes.items():
                    lines.append(f"    {attr}: {old!r} -> {new!r}")
            self._prev[eid] = snap
        props = {}
        try:
            props = env.get_all_properties() if hasattr(env, "get_all_properties") else {}
        except Exception:
            pass
        prev_props = self._prev.get("__env__", {})
        prop_changes = {k: (prev_props.get(k), v) for k, v in props.items() if prev_props.get(k) != v}
        if prop_changes:
            lines.append("  [ENV global properties]")
            for k, (old, new) in prop_changes.items():
                lines.append(f"    {k}: {old!r} -> {new!r}")
        self._prev["__env__"] = dict(props)
        if len(lines) == 1:
            lines.append("  (no state changes)")
        self._fp.write("\n".join(lines) + "\n")
        self._fp.flush()

    def close(self) -> None:
        try:
            self._fp.flush()
        finally:
            self._fp.close()


def _load_entities() -> list:
    """Dynamically import and instantiate all entity classes from entities/ directory."""
    entities = []
    entities_dir = Path(__file__).resolve().parent / "entities"
    
    if not entities_dir.exists():
        return entities
    
    for entity_file in sorted(entities_dir.glob("*.py")):
        if entity_file.name.startswith("_"):
            continue
        
        try:
            # Load module dynamically
            spec = importlib.util.spec_from_file_location(entity_file.stem, entity_file)
            if spec is None or spec.loader is None:
                continue
            module = importlib.util.module_from_spec(spec)
            sys.modules[entity_file.stem] = module
            spec.loader.exec_module(module)
            
            # Find the entity class (first class that starts with Entity_)
            for attr_name in dir(module):
                if attr_name.startswith("Entity_"):
                    entity_class = getattr(module, attr_name)
                    if isinstance(entity_class, type):
                        # entity_object base requires entity_object_id; use class name as default
                        try:
                            entity_instance = entity_class(attr_name)
                        except TypeError:
                            try:
                                entity_instance = entity_class()
                            except Exception as e:
                                print(f"warning: failed to instantiate {attr_name}: {e}")
                                continue
                        except Exception as e:
                            print(f"warning: failed to instantiate {attr_name}: {e}")
                            continue
                        entities.append(entity_instance)
        except Exception as e:
            print(f"warning: failed to load entity {entity_file.stem}: {e}")
    
    return entities


def _load_policies() -> list:
    """Dynamically import and instantiate all policy classes from policies/ directory."""
    policies = []
    policies_dir = Path(__file__).resolve().parent / "policies"
    if not policies_dir.exists():
        return policies
    for policy_file in sorted(policies_dir.glob("*.py")):
        if policy_file.name.startswith("_"):
            continue
        try:
            spec = importlib.util.spec_from_file_location(policy_file.stem, policy_file)
            if spec is None or spec.loader is None:
                continue
            module = importlib.util.module_from_spec(spec)
            sys.modules[policy_file.stem] = module
            spec.loader.exec_module(module)
            for attr_name in dir(module):
                if attr_name.startswith("Entity_") and attr_name.endswith("Policy"):
                    cls = getattr(module, attr_name)
                    if isinstance(cls, type):
                        try:
                            policies.append(cls())
                        except Exception as e:
                            print(f"warning: failed to instantiate {attr_name}: {e}")
                        break
        except Exception as e:
            print(f"warning: failed to load policy {policy_file.stem}: {e}")
    return policies


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ticks", type=int, default=100)
    parser.add_argument("--tick-seconds", type=float, default=300.0)
    parser.add_argument("--out", type=str, default=None)
    parser.add_argument("--run-id", type=str, default=None)
    args = parser.parse_args()

    run_id = args.run_id or datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%SZ")
    here = Path(__file__).resolve().parent
    out_dir = Path(args.out) if args.out else here / "runs" / run_id

    contracts_path = here / "metric_contracts.json"
    if not contracts_path.exists():
        print(f"metric_contracts.json not found at {contracts_path}; aborting.")
        return 2

    entities = _load_entities()
    policies = _load_policies()
    env = Environment(entities=entities, policies=policies)
    reporter = Reporter(
        env=env,
        run_id=run_id,
        out_dir=out_dir,
        tick_seconds=args.tick_seconds,
        contracts_path=str(contracts_path),
    )

    ilogger = EntityInteractionLogger(out_dir, run_id, args.tick_seconds)
    try:
        for tick in range(args.ticks):
            try:
                env.tick(args.tick_seconds)
            except TypeError:
                env.tick()
            reporter.sample(env=env, tick_number=tick + 1)
            ilogger.record(entities, tick + 1, env)
    finally:
        reporter.close()
        ilogger.close()

    print(f"run complete: {reporter.log_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
