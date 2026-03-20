from dataclasses import dataclass


@dataclass
class ChunkRecord:
    chunk_index: int
    start_word: int
    end_word: int
    topic_summary: str
    text: str
