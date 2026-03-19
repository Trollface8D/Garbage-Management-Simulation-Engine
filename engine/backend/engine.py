import csv
import json
import re
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from .io_utils import preview, read_text, slugify, write_json, write_text
from .llm_client import GeminiGateway
from .steps import (
    chunk_text_with_topic_summaries,
    collect_template_context,
    extract_python_code,
    fallback_entity_code,
    filter_causal_by_entity,
    inject_input,
    normalize_causal_list,
    normalize_entities,
    resolve_input_text,
)


class PipelineEngine:
    def __init__(
        self,
        *,
        api_key: str,
        model_name: str,
        chunk_size_words: int,
        chunk_overlap_words: int,
        causal_prompt_path: Path,
        follow_up_prompt_path: Path,
        entity_extraction_prompt_path: Path,
        entity_generation_prompt_path: Path,
        entity_template_dir: Path,
        output_root: Path,
        stage_callback: Callable[[str, str], None] | None = None,
    ) -> None:
        if not api_key:
            raise ValueError(
                "API key is required. Set API_KEY or GOOGLE_API_KEY in your environment."
            )
        if chunk_size_words <= 0:
            raise ValueError("chunk_size_words must be > 0")
        if chunk_overlap_words < 0:
            raise ValueError("chunk_overlap_words must be >= 0")
        if chunk_overlap_words >= chunk_size_words:
            raise ValueError("chunk_overlap_words must be < chunk_size_words")

        self.gateway = GeminiGateway(api_key=api_key, model_name=model_name)
        self.chunk_size_words = chunk_size_words
        self.chunk_overlap_words = chunk_overlap_words

        self.causal_prompt = read_text(causal_prompt_path)
        self.follow_up_prompt = read_text(follow_up_prompt_path)
        self.entity_extraction_prompt = read_text(entity_extraction_prompt_path)
        self.entity_generation_prompt = read_text(entity_generation_prompt_path)
        self.entity_template_dir = entity_template_dir

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.run_dir = output_root / f"run_{timestamp}"
        self.generated_entities_dir = self.run_dir / "generated_entities"
        self.generated_entities_dir.mkdir(parents=True, exist_ok=True)

        self._log_rows: list[dict[str, str]] = []
        self._stage_callback = stage_callback

    def _emit_stage(self, stage: str, message: str = "") -> None:
        payload = {"stage": stage, "message": message}
        if self._stage_callback is not None:
            self._stage_callback(stage, message)
        print(f"[PIPELINE_STAGE]{json.dumps(payload, ensure_ascii=False)}", flush=True)

    def run(
        self,
        *,
        input_type: str,
        input_path: Path | None,
        input_text: str | None,
    ) -> dict[str, Any]:
        self._emit_stage("transcript", "Resolving input and preparing transcript")
        transcript_text = resolve_input_text(
            self.gateway,
            input_type=input_type,
            input_path=input_path,
            input_text=input_text,
        )
        write_text(self.run_dir / "transcript.txt", transcript_text)
        self._log("transcript", preview(transcript_text), "transcript.txt")

        self._emit_stage("chunking", "Chunking transcript with topic summaries")
        chunks = chunk_text_with_topic_summaries(
            self.gateway,
            transcript_text,
            chunk_size_words=self.chunk_size_words,
            chunk_overlap_words=self.chunk_overlap_words,
        )
        write_json(self.run_dir / "chunks.json", [asdict(c) for c in chunks])
        self._log(
            "chunking",
            f"words={len(re.findall(r'\\S+', transcript_text))}",
            "chunks.json",
        )

        causal_by_chunk: list[dict[str, Any]] = []
        combined_causal: list[dict[str, Any]] = []
        self._emit_stage("causal_extraction", "Extracting causal relationships per chunk")
        for chunk in chunks:
            causal_payload = self.gateway.generate_json(inject_input(self.causal_prompt, chunk.text))
            causal_by_chunk.append(
                {
                    "chunk_index": chunk.chunk_index,
                    "topic_summary": chunk.topic_summary,
                    "start_word": chunk.start_word,
                    "end_word": chunk.end_word,
                    "causal": causal_payload,
                }
            )
            combined_causal.extend(
                normalize_causal_list(causal_payload, chunk.chunk_index, chunk.topic_summary)
            )

        write_json(self.run_dir / "causal_by_chunk.json", causal_by_chunk)
        write_json(self.run_dir / "causal_combined.json", combined_causal)
        self._log("causal_extraction", f"chunks={len(chunks)}", "causal_combined.json")

        self._emit_stage("follow_up", "Generating follow-up questions")
        follow_up_questions = self._generate_follow_up_questions(combined_causal)
        write_json(self.run_dir / "follow_up_questions.json", follow_up_questions)
        self._log("follow_up", f"causal_items={len(combined_causal)}", "follow_up_questions.json")

        self._emit_stage("entity_extraction", "Extracting entities from causal graph")
        entities = self._extract_entities(combined_causal)
        write_json(self.run_dir / "entities.json", entities)
        self._log("entity_extraction", f"causal_items={len(combined_causal)}", "entities.json")

        self._emit_stage("entity_generation", "Generating entity Python files")
        generated_entity_files = self._generate_entity_files(entities, combined_causal)
        write_json(self.run_dir / "generated_entity_files.json", generated_entity_files)
        self._log("entity_generation", f"entities={len(entities)}", "generated_entity_files.json")

        self._flush_log_csv()

        summary = {
            "run_dir": str(self.run_dir),
            "transcript_file": str(self.run_dir / "transcript.txt"),
            "chunks_file": str(self.run_dir / "chunks.json"),
            "causal_by_chunk_file": str(self.run_dir / "causal_by_chunk.json"),
            "causal_combined_file": str(self.run_dir / "causal_combined.json"),
            "follow_up_file": str(self.run_dir / "follow_up_questions.json"),
            "entities_file": str(self.run_dir / "entities.json"),
            "generated_entities_dir": str(self.generated_entities_dir),
            "generated_entity_count": len(generated_entity_files),
        }
        write_json(self.run_dir / "summary.json", summary)
        self._emit_stage("completed", "Pipeline finished")
        return summary

    def _generate_follow_up_questions(self, combined_causal: list[dict[str, Any]]) -> Any:
        payload_json = json.dumps(combined_causal, ensure_ascii=False, indent=2)
        if "[Insert JSON Here]" in self.follow_up_prompt:
            prompt = self.follow_up_prompt.replace("[Insert JSON Here]", payload_json)
        else:
            prompt = f"{self.follow_up_prompt}\n\n# Input Data\n{payload_json}"
        return self.gateway.generate_json(prompt)

    def _extract_entities(self, combined_causal: list[dict[str, Any]]) -> list[str]:
        payload_json = json.dumps(combined_causal, ensure_ascii=False, indent=2)
        prompt = f"{self.entity_extraction_prompt}\n\nInput Data:\n{payload_json}"
        return normalize_entities(self.gateway.generate_json(prompt))

    def _generate_entity_files(
        self,
        entities: list[str],
        combined_causal: list[dict[str, Any]],
    ) -> list[dict[str, str]]:
        template_context = collect_template_context(self.entity_template_dir)
        generated: list[dict[str, str]] = []

        for entity_name in entities:
            entity_causal_data = filter_causal_by_entity(combined_causal, entity_name)
            entity_payload = json.dumps(entity_causal_data, ensure_ascii=False, indent=2)

            prompt = self.entity_generation_prompt.replace("CHANGE_NAME_HERE", entity_name)
            prompt = (
                f"{prompt}\n\n"
                "Selected Template Classes:\n"
                f"{template_context}\n\n"
                "Existing Entity (default = None): None\n\n"
                "Data File (response_*.json equivalent content):\n"
                f"{entity_payload}\n\n"
                "Output rule: return only Python code for a single file, no markdown fences."
            )

            code = extract_python_code(self.gateway.generate_text(prompt, response_json=False))
            if not code.strip():
                code = fallback_entity_code(entity_name)

            file_name = f"{slugify(entity_name)}.py"
            output_path = self.generated_entities_dir / file_name
            write_text(output_path, code)
            generated.append({"entity": entity_name, "file": str(output_path)})

        return generated

    def _log(self, stage: str, input_preview: str, output_filename: str) -> None:
        self._log_rows.append(
            {
                "stage": stage,
                "input_preview": input_preview,
                "output_filename": output_filename,
                "timestamp": datetime.now().isoformat(),
            }
        )

    def _flush_log_csv(self) -> None:
        log_path = self.run_dir / "generation_log.csv"
        with log_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=["stage", "input_preview", "output_filename", "timestamp"],
            )
            writer.writeheader()
            writer.writerows(self._log_rows)
