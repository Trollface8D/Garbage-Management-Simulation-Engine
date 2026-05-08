"""Spawn ``python run.py`` against a generated bundle and surface its JSONL
trace through the API.

Intentionally minimal — no JobRecord, no checkpoints. A simulation run is
just: pick a code-gen job, run its ``run.py`` in a subprocess, point the
viewer at ``runs/<sim_run_id>/metrics.jsonl``. State lives in an in-memory
dict keyed by ``sim_run_id``.
"""

from __future__ import annotations

import logging
import subprocess
import sys
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import code_gen_checkpoints as checkpoints


logger = logging.getLogger(__name__)


@dataclass
class SimulationRun:
    sim_run_id: str
    job_id: str
    bundle_dir: Path
    out_dir: Path
    log_path: Path
    ticks: int
    tick_seconds: float
    status: str = "running"  # running | completed | failed | cancelled
    error: str | None = None
    process: subprocess.Popen | None = field(default=None, repr=False)


_RUNS: dict[str, SimulationRun] = {}
_LOCK = threading.Lock()


def _bundle_dir(job_id: str) -> Path:
    return checkpoints.artifact_root(job_id)


def start_run(*, job_id: str, ticks: int = 100, tick_seconds: float = 300.0) -> SimulationRun:
    bundle = _bundle_dir(job_id)
    if not bundle.exists() or not bundle.is_dir():
        raise FileNotFoundError(
            f"Bundle for job {job_id} not found at {bundle}. Run code-gen first."
        )
    if not (bundle / "run.py").exists():
        raise FileNotFoundError(
            f"{bundle}/run.py is missing — re-run finalize_bundle on this job."
        )

    sim_run_id = f"sim-{uuid.uuid4().hex[:12]}"
    out_dir = bundle / "runs" / sim_run_id
    log_path = out_dir / "metrics.jsonl"

    cmd = [
        sys.executable,
        "run.py",
        "--ticks",
        str(int(ticks)),
        "--tick-seconds",
        str(float(tick_seconds)),
        "--out",
        str(out_dir),
        "--run-id",
        sim_run_id,
    ]

    process = subprocess.Popen(
        cmd,
        cwd=str(bundle),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    run = SimulationRun(
        sim_run_id=sim_run_id,
        job_id=job_id,
        bundle_dir=bundle,
        out_dir=out_dir,
        log_path=log_path,
        ticks=int(ticks),
        tick_seconds=float(tick_seconds),
        status="running",
        process=process,
    )
    with _LOCK:
        _RUNS[sim_run_id] = run

    threading.Thread(target=_watch, args=(sim_run_id,), daemon=True).start()
    logger.info(
        "[simulate] started sim_run_id=%s job_id=%s ticks=%s",
        sim_run_id,
        job_id,
        ticks,
    )
    return run


def _watch(sim_run_id: str) -> None:
    run = _RUNS.get(sim_run_id)
    if run is None or run.process is None:
        return
    try:
        stdout, stderr = run.process.communicate(timeout=60 * 30)
        rc = run.process.returncode
        if rc == 0:
            run.status = "completed"
        else:
            run.status = "failed"
            tail = (stderr or stdout or "").strip().splitlines()[-20:]
            run.error = "\n".join(tail) or f"run.py exited with code {rc}"
            logger.warning(
                "[simulate] sim_run_id=%s exited code=%s tail=%s",
                sim_run_id,
                rc,
                run.error,
            )
    except subprocess.TimeoutExpired:
        run.process.kill()
        run.status = "failed"
        run.error = "Simulation timed out (30 minutes cap)."
    except Exception as exc:
        run.status = "failed"
        run.error = str(exc)


def get_run(sim_run_id: str) -> SimulationRun | None:
    with _LOCK:
        return _RUNS.get(sim_run_id)


def list_runs(job_id: str | None = None) -> list[SimulationRun]:
    with _LOCK:
        return [r for r in _RUNS.values() if job_id is None or r.job_id == job_id]


def cancel_run(sim_run_id: str) -> bool:
    run = get_run(sim_run_id)
    if not run or run.process is None:
        return False
    if run.status != "running":
        return False
    try:
        run.process.terminate()
        run.status = "cancelled"
        return True
    except Exception:
        return False


def read_log(sim_run_id: str, *, byte_offset: int = 0, max_bytes: int = 1024 * 1024) -> dict[str, Any]:
    run = get_run(sim_run_id)
    if not run:
        raise FileNotFoundError(f"sim_run_id {sim_run_id} not found")
    path = run.log_path
    if not path.exists():
        return {"bytes": 0, "next_offset": byte_offset, "lines": [], "status": run.status}

    size = path.stat().st_size
    if byte_offset >= size:
        return {"bytes": 0, "next_offset": size, "lines": [], "status": run.status}

    with path.open("rb") as fp:
        fp.seek(byte_offset)
        chunk = fp.read(max_bytes)

    next_offset = byte_offset + len(chunk)
    text = chunk.decode("utf-8", errors="replace")
    # If we're mid-line, drop the trailing partial line and rewind.
    if next_offset < size and "\n" in text:
        last_newline = text.rfind("\n")
        text = text[: last_newline + 1]
        next_offset = byte_offset + len(text.encode("utf-8"))

    lines = [line for line in text.splitlines() if line.strip()]
    return {
        "bytes": next_offset - byte_offset,
        "next_offset": next_offset,
        "lines": lines,
        "status": run.status,
        "error": run.error,
    }
