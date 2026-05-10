"""Static templates emitted by ``finalize_bundle``.

These files are deterministic — they don't depend on any LLM call. Each
generated bundle gets:

- ``reporter.py`` reads ``metric_contracts.json`` and writes a JSON Lines
  trace at the configured ``tick_seconds`` cadence.
- ``run.py`` is the entrypoint: constructs ``Environment`` from the
  generated bundle, runs N ticks, hands each tick to the Reporter.
- ``metric_contracts.json`` — derived per-run from the user's
  ``selectedMetrics`` (frozen at job submission time).
- ``pbi/recipe.json`` — chart-group → visual mapping the in-engine
  viewer and any future PowerBI report can both consume.
- ``pbi/theme.json`` — a small static color theme so the viewer and
  PowerBI render with consistent palette.
- ``runs/`` is the conventional output directory the Reporter writes
  ``metrics.jsonl`` into.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"

REPORTER_PY = (_TEMPLATES_DIR / "reporter_template.py").read_text(encoding="utf-8")
RUN_PY = (_TEMPLATES_DIR / "run_template.py").read_text(encoding="utf-8")


PBI_THEME_JSON: dict[str, Any] = {
    "name": "GMSE Default",
    "dataColors": [
        "#38bdf8",
        "#a855f7",
        "#34d399",
        "#f59e0b",
        "#f472b6",
        "#22d3ee",
        "#fb7185",
        "#facc15",
    ],
    "background": "#0a0a0a",
    "foreground": "#e5e5e5",
    "tableAccent": "#38bdf8",
}


def build_metric_contracts(
    selected_metrics: list[dict[str, Any]],
    *,
    job_id: str,
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "jobId": job_id,
        "metrics": [dict(m) for m in selected_metrics if isinstance(m, dict)],
    }


def build_pbi_recipe(
    selected_metrics: list[dict[str, Any]],
    *,
    job_id: str,
) -> dict[str, Any]:
    """Group metrics by ``chart_group``; emit one panel per group."""
    panels: list[dict[str, Any]] = []
    by_group: dict[str, list[dict[str, Any]]] = {}
    ungrouped: list[dict[str, Any]] = []
    for m in selected_metrics:
        if not isinstance(m, dict):
            continue
        group = m.get("chart_group")
        if isinstance(group, str) and group.strip():
            by_group.setdefault(group.strip(), []).append(m)
        else:
            ungrouped.append(m)

    for group_name, members in by_group.items():
        viz = next((m.get("viz") for m in members if m.get("viz")), "line")
        panels.append(
            {
                "chart_group": group_name,
                "visual": viz,
                "y_metrics": [m.get("name") for m in members],
                "shared_x": "tick_seconds",
                "slicers": ["entity_kind", "grounding"],
            }
        )

    for m in ungrouped:
        panels.append(
            {
                "chart_group": None,
                "visual": m.get("viz") or "line",
                "y_metrics": [m.get("name")],
                "shared_x": "tick_seconds",
                "slicers": ["entity_kind", "grounding"],
            }
        )

    return {
        "schemaVersion": 1,
        "jobId": job_id,
        "panels": panels,
    }


def serialize_json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)
