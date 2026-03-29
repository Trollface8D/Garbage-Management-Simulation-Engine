from dataclasses import dataclass, field
from typing import Any
import queue


@dataclass
class JobRecord:
    job_id: str
    status: str
    created_at: str
    updated_at: str
    current_stage: str | None = None
    stage_message: str = ""
    stage_history: list[dict[str, str]] = field(default_factory=list)
    error: str | None = None
    result: dict[str, Any] | None = None
    run_dir: str | None = None
    event_queue: queue.Queue[tuple[str, Any]] = field(default_factory=queue.Queue)
