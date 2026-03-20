import mimetypes
import re
from pathlib import Path
from typing import Any

from google.genai.types import Part

from ..infra.io_utils import read_text, to_class_name
from ..infra.paths import (
    AUDIO_MIME_MAP,
    DEFAULT_EXAMPLE_TEXT_INPUT,
    DEFAULT_MEDIA_DIR,
    ROOT_DIR,
    SUPPORTED_AUDIO_EXTENSIONS,
)
from .llm_client import GeminiGateway
from .types import ChunkRecord


def resolve_input_path(input_path: Path | None) -> Path | None:
    if input_path is None:
        return None

    candidates = [
        input_path,
        ROOT_DIR / input_path,
        ROOT_DIR / "Engine" / input_path,
        DEFAULT_MEDIA_DIR / input_path,
        DEFAULT_MEDIA_DIR / input_path.name,
    ]

    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate

    return input_path


def get_audio_mime_type(audio_path: Path) -> str:
    suffix = audio_path.suffix.lower()
    if suffix in AUDIO_MIME_MAP:
        return AUDIO_MIME_MAP[suffix]

    guessed_mime, _ = mimetypes.guess_type(str(audio_path))
    if guessed_mime and guessed_mime.startswith("audio/"):
        return guessed_mime
    return "audio/mpeg"


def transcribe_audio(gateway: GeminiGateway, audio_path: Path) -> str:
    prompt = (
        "Transcribe this Thai/English interview audio into plain text. "
        "Keep wording faithful and do not summarize."
    )
    response_text = gateway.generate_text(
        prompt,
        parts=[Part.from_bytes(data=audio_path.read_bytes(), mime_type=get_audio_mime_type(audio_path))],
        response_json=False,
    )
    if not response_text.strip():
        raise RuntimeError("Empty transcription result")
    return response_text.strip()


def resolve_input_text(
    gateway: GeminiGateway,
    *,
    input_type: str,
    input_path: Path | None,
    input_text: str | None,
) -> str:
    resolved_path = resolve_input_path(input_path)
    resolved_type = input_type

    if resolved_type == "auto":
        if input_text:
            resolved_type = "text"
        elif resolved_path and resolved_path.suffix.lower() in SUPPORTED_AUDIO_EXTENSIONS:
            resolved_type = "audio"
        else:
            resolved_type = "text"

    if resolved_type in {"mp3", "audio"}:
        if not resolved_path:
            raise ValueError("--input-path is required for audio/mp3 input")
        return transcribe_audio(gateway, resolved_path)

    if input_text and input_text.strip():
        return input_text.strip()

    if resolved_path:
        return read_text(resolved_path)

    if DEFAULT_EXAMPLE_TEXT_INPUT.exists():
        return read_text(DEFAULT_EXAMPLE_TEXT_INPUT)

    raise ValueError("Provide --input-text or --input-path")


def summarize_chunk_topic(gateway: GeminiGateway, chunk_text: str) -> str:
    prompt = (
        "Summarize the main topic of this interview chunk in one short sentence "
        "(max 18 words).\n\nChunk:\n"
        f"{chunk_text}"
    )
    try:
        summary = gateway.generate_text(prompt, response_json=False).strip()
        if summary:
            return summary
    except Exception:
        pass

    words = re.findall(r"\S+", chunk_text)
    return " ".join(words[:18])


def chunk_text_with_topic_summaries(
    gateway: GeminiGateway,
    text: str,
    *,
    chunk_size_words: int,
    chunk_overlap_words: int,
) -> list[ChunkRecord]:
    words = re.findall(r"\S+", text)
    if not words:
        return []

    chunks: list[ChunkRecord] = []
    start = 0
    chunk_index = 1
    total_words = len(words)

    while start < total_words:
        end = min(start + chunk_size_words, total_words)
        chunk_text = " ".join(words[start:end])
        topic_summary = summarize_chunk_topic(gateway, chunk_text)
        chunks.append(
            ChunkRecord(
                chunk_index=chunk_index,
                start_word=start,
                end_word=end,
                topic_summary=topic_summary,
                text=chunk_text,
            )
        )

        if end >= total_words:
            break

        start = max(0, end - chunk_overlap_words)
        chunk_index += 1

    return chunks


def inject_input(template: str, input_data: str) -> str:
    if "{input}" in template:
        return template.replace("{input}", input_data)
    if "{}" in template:
        return template.replace("{}", input_data)

    match = re.search(r"\{([A-Za-z0-9_]+)\}", template)
    if match:
        return template.replace(match.group(0), input_data, 1)

    return f"{template}\n\nInput:\n{input_data}"


def normalize_causal_list(
    causal_payload: Any,
    chunk_index: int,
    topic_summary: str,
) -> list[dict[str, Any]]:
    if isinstance(causal_payload, list):
        items = causal_payload
    elif isinstance(causal_payload, dict):
        for key in ("data", "items", "extractions", "relationships"):
            if isinstance(causal_payload.get(key), list):
                items = causal_payload[key]
                break
        else:
            items = [causal_payload]
    else:
        items = []

    normalized: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        enriched = dict(item)
        enriched["chunk_index"] = chunk_index
        enriched["chunk_topic_summary"] = topic_summary
        normalized.append(enriched)
    return normalized


def normalize_entities(raw: Any) -> list[str]:
    candidates: list[str] = []

    if isinstance(raw, list):
        iterable = raw
    elif isinstance(raw, dict):
        for key in ("entities", "entity_list", "data", "items"):
            if isinstance(raw.get(key), list):
                iterable = raw[key]
                break
        else:
            iterable = [raw]
    else:
        iterable = []

    for item in iterable:
        if isinstance(item, str):
            candidates.append(item.strip())
            continue
        if isinstance(item, dict):
            for key in ("entity", "name", "label", "entity_name"):
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    candidates.append(value.strip())
                    break

    deduped: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        normalized = re.sub(r"\s+", " ", candidate).strip()
        if not normalized:
            continue
        marker = normalized.lower()
        if marker in seen:
            continue
        seen.add(marker)
        deduped.append(normalized)

    return deduped


def filter_causal_by_entity(
    combined_causal: list[dict[str, Any]],
    entity_name: str,
    *,
    max_items: int = 40,
) -> list[dict[str, Any]]:
    lowered = entity_name.lower()

    def matches(item: dict[str, Any]) -> bool:
        for key in ("subject", "object", "relationship", "source_text"):
            value = item.get(key)
            if isinstance(value, str) and lowered in value.lower():
                return True

        extracted = item.get("extracted")
        if isinstance(extracted, list):
            for ex in extracted:
                if not isinstance(ex, dict):
                    continue
                if any(
                    isinstance(ex.get(k), str) and lowered in ex[k].lower()
                    for k in ("head", "tail", "relationship")
                ):
                    return True
        return False

    matched = [item for item in combined_causal if matches(item)]
    return matched[:max_items] if matched else combined_causal[:max_items]


def collect_template_context(entity_template_dir: Path) -> str:
    template_files = [
        entity_template_dir / "entity_object_template.py",
        entity_template_dir / "environment_template.py",
        entity_template_dir / "policy_template.py",
        entity_template_dir / "entity_template.py",
    ]

    sections: list[str] = []
    for path in template_files:
        if path.exists():
            sections.append(f"### {path.name}\n{read_text(path)}")
    return "\n\n".join(sections)


def extract_python_code(text: str) -> str:
    cleaned = text.strip()
    fence_match = re.search(r"```(?:python)?\s*(.*?)```", cleaned, flags=re.S)
    if fence_match:
        cleaned = fence_match.group(1).strip()
    return cleaned


def fallback_entity_code(entity_name: str) -> str:
    return (
        "from .entity_object_template import entity_object\n\n"
        f"class {to_class_name(entity_name)}(entity_object):\n"
        "    pass\n"
    )
