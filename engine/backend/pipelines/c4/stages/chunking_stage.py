import re

from ..adapters.gemini_client import GeminiGateway
from ..models import ChunkRecord


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
