from dataclasses import dataclass, field
from threading import Event
from typing import Any
import queue
import time


@dataclass
class JobRecord:
    job_id: str
    status: str
    created_at: str
    updated_at: str
    current_stage: str | None = None
    stage_message: str = ""
    stage_history: list[dict[str, Any]] = field(default_factory=list)
    token_usage: dict[str, int] = field(default_factory=dict)
    cost_estimate: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    result: dict[str, Any] | None = None
    run_dir: str | None = None
    event_queue: queue.Queue[tuple[str, Any]] = field(default_factory=queue.Queue)
    cancel_requested: bool = False
    last_activity_ts: float = field(default_factory=time.monotonic)
    completed_stages: list[str] = field(default_factory=list)
    # Confirmation gate: worker pauses at gated stages until user confirms.
    awaiting_confirmation_stage: str | None = None
    confirmed_stages: list[str] = field(default_factory=list)
    confirm_event: Event = field(default_factory=Event)
