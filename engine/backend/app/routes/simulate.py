"""HTTP surface for spawning + tailing simulation runs of a generated bundle.

Sister to ``code_gen`` but much smaller — running ``python run.py`` against
the bundle is a one-shot subprocess, not a multi-stage Gemini pipeline.
"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..services import simulation_runner


router = APIRouter(tags=["simulate"])
logger = logging.getLogger(__name__)


class SimulationStartRequest(BaseModel):
    ticks: int = Field(default=100, ge=1, le=100_000)
    tickSeconds: float = Field(default=300.0, gt=0, le=86_400)


class SimulationRunInfo(BaseModel):
    simRunId: str
    jobId: str
    status: Literal["running", "completed", "failed", "cancelled"]
    ticks: int
    tickSeconds: float
    error: str | None = None
    logPath: str


class SimulationLogChunk(BaseModel):
    bytes: int
    nextOffset: int
    lines: list[str]
    status: Literal["running", "completed", "failed", "cancelled"]
    error: str | None = None


def _to_info(run: "simulation_runner.SimulationRun") -> SimulationRunInfo:
    return SimulationRunInfo(
        simRunId=run.sim_run_id,
        jobId=run.job_id,
        status=run.status,  # type: ignore[arg-type]
        ticks=run.ticks,
        tickSeconds=run.tick_seconds,
        error=run.error,
        logPath=str(run.log_path),
    )


@router.post(
    "/code_gen/jobs/{job_id}/simulations",
    response_model=SimulationRunInfo,
)
def start_simulation(job_id: str, payload: SimulationStartRequest) -> SimulationRunInfo:
    try:
        run = simulation_runner.start_run(
            job_id=job_id,
            ticks=payload.ticks,
            tick_seconds=payload.tickSeconds,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("simulation start failed jobId=%s", job_id)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return _to_info(run)


@router.get(
    "/code_gen/jobs/{job_id}/simulations/{sim_run_id}",
    response_model=SimulationRunInfo,
)
def get_simulation(job_id: str, sim_run_id: str) -> SimulationRunInfo:
    run = simulation_runner.get_run(sim_run_id)
    if not run or run.job_id != job_id:
        raise HTTPException(status_code=404, detail="simulation run not found")
    return _to_info(run)


@router.get(
    "/code_gen/jobs/{job_id}/simulations",
    response_model=list[SimulationRunInfo],
)
def list_simulations(job_id: str) -> list[SimulationRunInfo]:
    return [_to_info(run) for run in simulation_runner.list_runs(job_id=job_id)]


@router.post(
    "/code_gen/jobs/{job_id}/simulations/{sim_run_id}/cancel",
    response_model=SimulationRunInfo,
)
def cancel_simulation(job_id: str, sim_run_id: str) -> SimulationRunInfo:
    run = simulation_runner.get_run(sim_run_id)
    if not run or run.job_id != job_id:
        raise HTTPException(status_code=404, detail="simulation run not found")
    simulation_runner.cancel_run(sim_run_id)
    return _to_info(run)


@router.get(
    "/code_gen/jobs/{job_id}/simulations/{sim_run_id}/entity_interactions",
)
def read_entity_interactions(
    job_id: str,
    sim_run_id: str,
) -> dict:
    run = simulation_runner.get_run(sim_run_id)
    if not run or run.job_id != job_id:
        raise HTTPException(status_code=404, detail="simulation run not found")
    path = run.out_dir / "entity_interactions.txt"
    if not path.exists():
        return {"status": run.status, "text": None, "available": False}
    text = path.read_text(encoding="utf-8", errors="replace")
    return {"status": run.status, "text": text, "available": True}


@router.get(
    "/code_gen/jobs/{job_id}/simulations/{sim_run_id}/log",
    response_model=SimulationLogChunk,
)
def read_simulation_log(
    job_id: str,
    sim_run_id: str,
    offset: int = Query(default=0, ge=0),
    maxBytes: int = Query(default=1024 * 1024, ge=1024, le=8 * 1024 * 1024),
) -> SimulationLogChunk:
    run = simulation_runner.get_run(sim_run_id)
    if not run or run.job_id != job_id:
        raise HTTPException(status_code=404, detail="simulation run not found")
    chunk = simulation_runner.read_log(sim_run_id, byte_offset=offset, max_bytes=maxBytes)
    return SimulationLogChunk(
        bytes=chunk["bytes"],
        nextOffset=chunk["next_offset"],
        lines=chunk["lines"],
        status=chunk["status"],
        error=chunk.get("error"),
    )
