#!/usr/bin/env python3
"""Replay raw map-extraction prompt text from current backend prompt config.

This script does not call any model. It only reconstructs stage prompt bodies.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict


ROOT = Path(__file__).resolve().parent
PROMPT_CONFIG_PATH = ROOT / "engine" / "backend" / "prompt" / "map_extarct.json"


def _load_config(path: Path) -> Dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("map_extarct.json must be a JSON object")
    return data


def _need_runtime(runtime: Dict[str, Any], key: str) -> str:
    value = runtime.get(key, "")
    if not isinstance(value, str) or not value.strip():
        raise KeyError(f"Missing runtime prompt key: {key}")
    return value


def _fmt(title: str, body: str) -> str:
    line = "=" * 90
    return f"\n{line}\n{title}\n{line}\n{body.strip()}\n"


def build_prompts(
    cfg: Dict[str, Any],
    *,
    ocr_map: str,
    symbol_table: str,
    support_csv: str,
    support_extracted_text: str,
    node_json: str,
) -> Dict[str, str]:
    runtime = cfg.get("runtime_prompts", {})
    if not isinstance(runtime, dict):
        raise ValueError("runtime_prompts must be an object")

    extractmap_symbol = cfg["extractmap_symbol"]["prompt"]
    extractmap_text = cfg["extractmap_text"]["prompt"]
    tabular_extraction = cfg["tabular_extraction"]["prompt"]
    edge_extraction = cfg["edge_extraction"]["prompt"]

    symbol_stage = "\n\n".join(
        [
            extractmap_symbol,
            _need_runtime(runtime, "extractmap_symbol_output_hint"),
            "MAP OCR TEXT (optional context):",
            ocr_map,
        ]
    )

    text_stage = "\n\n".join(
        [
            extractmap_text,
            _need_runtime(runtime, "extractmap_text_nodes_json_schema"),
            _need_runtime(runtime, "extractmap_text_dedup_policy"),
            _need_runtime(runtime, "extractmap_text_exclusion_policy"),
            _need_runtime(runtime, "compact_output_policy"),
            "SYMBOL TABLE CONTEXT:",
            symbol_table,
            "MAP OCR TEXT CONTEXT:",
            ocr_map,
        ]
    )

    tabular_stage = "\n\n".join(
        [
            tabular_extraction,
            _need_runtime(runtime, "tabular_extraction_output_hint"),
            _need_runtime(runtime, "tabular_extraction_no_support_hint"),
            "MAP OCR TEXT CONTEXT (used when support image is unavailable):",
            ocr_map,
        ]
    )

    support_enrich_stage = "\n\n".join(
        [
            _need_runtime(runtime, "extractmap_text_support_joint_prompt"),
            _need_runtime(runtime, "extractmap_text_support_fallback_prompt"),
            _need_runtime(runtime, "extractmap_text_support_delta_prompt"),
            _need_runtime(runtime, "extractmap_text_support_delta_context"),
            _need_runtime(runtime, "extractmap_text_normalize_prompt"),
            _need_runtime(runtime, "extractmap_text_normalize_context"),
            "SUPPORT CSV / EXTRACTED TEXT:",
            support_csv or support_extracted_text,
        ]
    )

    edge_stage = "\n\n".join(
        [
            edge_extraction,
            _need_runtime(runtime, "edge_extraction_json_schema"),
            _need_runtime(runtime, "edge_extraction_dedup_policy"),
            _need_runtime(runtime, "compact_output_policy"),
            _need_runtime(runtime, "edge_extraction_csv_fallback_hint"),
            "EXTRACTED NODE JSON CONTEXT:",
            node_json,
            "MAP OCR TEXT CONTEXT:",
            ocr_map,
        ]
    )

    return {
        "stage_1_extractmap_symbol": symbol_stage,
        "stage_2_extractmap_text": text_stage,
        "stage_3_tabular_extraction": tabular_stage,
        "stage_4_support_enrichment": support_enrich_stage,
        "stage_5_edge_extraction": edge_stage,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Reconstruct raw map extraction stage prompts from map_extarct.json"
    )
    parser.add_argument("--config", type=Path, default=PROMPT_CONFIG_PATH)
    parser.add_argument("--ocr-map", default="<paste map OCR text>")
    parser.add_argument("--symbol-table", default="<paste symbol extraction markdown table>")
    parser.add_argument("--support-csv", default="<paste support table csv>")
    parser.add_argument("--support-extracted-text", default="<paste support extracted plain text>")
    parser.add_argument("--node-json", default='{"nodes": []}')
    args = parser.parse_args()

    config = _load_config(args.config)
    prompts = build_prompts(
        config,
        ocr_map=args.ocr_map,
        symbol_table=args.symbol_table,
        support_csv=args.support_csv,
        support_extracted_text=args.support_extracted_text,
        node_json=args.node_json,
    )

    for stage_name, prompt_body in prompts.items():
        print(_fmt(stage_name, prompt_body))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
