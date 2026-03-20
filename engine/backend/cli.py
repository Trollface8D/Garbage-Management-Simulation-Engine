import argparse
import json
from pathlib import Path

from .infra.paths import (
    DEFAULT_CAUSAL_PROMPT,
    DEFAULT_ENTITY_EXTRACTION_PROMPT,
    DEFAULT_ENTITY_GENERATION_PROMPT,
    DEFAULT_ENTITY_TEMPLATE_DIR,
    DEFAULT_EXAMPLE_TEXT_INPUT,
    DEFAULT_FOLLOW_UP_PROMPT,
    DEFAULT_MODEL_NAME,
    DEFAULT_OUTPUT_ROOT,
)
from .infra.io_utils import resolve_api_key
from .pipelines.c4 import C4PipelineEngine


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "C4 pipeline engine: audio/text -> transcript -> chunk -> causal -> "
            "combined causal -> follow-up -> entities -> generated entity files"
        )
    )
    parser.add_argument(
        "--serve-api",
        action="store_true",
        help="Start FastAPI sidecar server instead of running a single CLI pipeline job.",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)

    parser.add_argument(
        "--input-type",
        choices=["auto", "audio", "mp3", "text"],
        default="auto",
    )
    parser.add_argument("--input-path", type=Path, default=DEFAULT_EXAMPLE_TEXT_INPUT)
    parser.add_argument("--input-text", type=str, default=None)

    parser.add_argument("--model", default=DEFAULT_MODEL_NAME)
    parser.add_argument("--chunk-size-words", type=int, default=900)
    parser.add_argument("--chunk-overlap-words", type=int, default=180)

    parser.add_argument("--causal-prompt", type=Path, default=DEFAULT_CAUSAL_PROMPT)
    parser.add_argument("--follow-up-prompt", type=Path, default=DEFAULT_FOLLOW_UP_PROMPT)
    parser.add_argument(
        "--entity-extraction-prompt",
        type=Path,
        default=DEFAULT_ENTITY_EXTRACTION_PROMPT,
    )
    parser.add_argument(
        "--entity-generation-prompt",
        type=Path,
        default=DEFAULT_ENTITY_GENERATION_PROMPT,
    )
    parser.add_argument("--entity-template-dir", type=Path, default=DEFAULT_ENTITY_TEMPLATE_DIR)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)

    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.serve_api:
        import uvicorn

        from .app.api import app

        uvicorn.run(app, host=args.host, port=args.port, reload=False)
        return

    api_key = resolve_api_key()

    engine = C4PipelineEngine(
        api_key=api_key or "",
        model_name=args.model,
        chunk_size_words=args.chunk_size_words,
        chunk_overlap_words=args.chunk_overlap_words,
        causal_prompt_path=args.causal_prompt,
        follow_up_prompt_path=args.follow_up_prompt,
        entity_extraction_prompt_path=args.entity_extraction_prompt,
        entity_generation_prompt_path=args.entity_generation_prompt,
        entity_template_dir=args.entity_template_dir,
        output_root=args.output_root,
    )

    summary = engine.run(
        input_type=args.input_type,
        input_path=args.input_path,
        input_text=args.input_text,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
