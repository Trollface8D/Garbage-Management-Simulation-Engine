# Backend Developer Guide

This guide explains how the backend is structured, how to add another pipeline, and how to run the backend in each mode.

## Current backend layout

- `app/`: FastAPI composition, routes, request/response services.
- `pipelines/`: pipeline implementations (currently `c4`).
- `infra/`: shared environment/path/io helpers.
- `legacy/`: old compatibility/debug files, not part of active runtime path.

## Runtime flow (current)

1. API receives a job request at `/pipeline/jobs`.
2. Route starts a background worker thread.
3. Worker constructs `C4PipelineEngine` and executes stages.
4. Progress events are pushed to SSE stream.
5. Artifacts and final result are exposed by job endpoints.

## API endpoints (current)

- `GET /health`
- `POST /pipeline/jobs`
- `GET /pipeline/jobs/{job_id}`
- `GET /pipeline/jobs/{job_id}/stream`
- `GET /pipeline/jobs/{job_id}/result`
- `GET /pipeline/jobs/{job_id}/artifacts`
- `GET /pipeline/jobs/{job_id}/artifacts/{artifact_name}`
- `POST /pipeline/run/stream` (compat endpoint)

## How to run

### 1) Run API sidecar (recommended)

From workspace root:

```powershell
python -m engine.backend --serve-api --host 127.0.0.1 --port 8000
```

### 2) Run single pipeline from CLI (no API server)

From workspace root:

```powershell
python -m Engine.backend --input-path path/to/interview.txt --input-type text
```

Other input example:

```powershell
python -m Engine.backend --input-path path/to/interview.mp3 --input-type mp3
```

### 3) Run compatibility launcher

```powershell
python Engine/pipeline_engine.py --input-path path/to/interview.txt --input-type text
```

## How to add a new pipeline

Assume your new pipeline id is `risk`.

### Step A: create new pipeline package

Create:

- `backend/pipelines/risk/__init__.py`
- `backend/pipelines/risk/orchestrator.py`
- `backend/pipelines/risk/models.py`
- `backend/pipelines/risk/adapters/__init__.py`
- `backend/pipelines/risk/stages/__init__.py`
- `backend/pipelines/risk/stages/*.py` (domain stages)

Implement in `orchestrator.py`:

- `class RiskPipelineEngine`
- `run(...) -> dict[str, Any]`
- stage callbacks and artifact writes under `run_dir`

Export in `backend/pipelines/risk/__init__.py`:

```python
from .orchestrator import RiskPipelineEngine

__all__ = ["RiskPipelineEngine"]
```

### Step B: wire selection in API worker

Current worker is hardcoded to C4 in `backend/app/services/job_runner.py`.

To support multiple pipelines:

1. Add a new form field in job create route, for example `pipelineId` defaulting to `c4`.
2. Pass `pipeline_id` into `run_job_worker(...)` kwargs.
3. Add a small resolver in `job_runner.py`:

- if `pipeline_id == "c4"`: use `C4PipelineEngine`
- if `pipeline_id == "risk"`: use `RiskPipelineEngine`
- else: raise a validation error

4. Keep artifact naming consistent so existing artifact endpoints keep working.

### Step C: wire selection in CLI

Current CLI path in `backend/cli.py` runs C4 only.

Add argument:

- `--pipeline-id` with choices `c4`, `risk`, ...

Then resolve engine class similarly to API worker.

### Step D: update defaults/config if needed

If the new pipeline needs dedicated prompt/template paths:

- add paths in `backend/infra/paths.py`, or
- create per-pipeline config module under `backend/pipelines/risk/config.py` and reference from resolver.

### Step E: document and test

Update docs and run:

- API mode (`python -m Engine.backend --serve-api ...`)
- CLI mode (`python -m Engine.backend --pipeline-id risk ...`)
- SSE flow (`/pipeline/jobs/{job_id}/stream`)
- Artifact endpoints (`/artifacts` and `/artifacts/{artifact_name}`)

## Recommended conventions for more pipelines

1. Keep each pipeline self-contained under `backend/pipelines/<id>/`.
2. Keep route surface stable; avoid exposing internal helper functions as endpoints.
3. Expose stage-level progress/events and artifact retrieval instead.
4. Reuse shared helpers only after they are used by at least two pipelines.
5. Use explicit pipeline ids to avoid hidden default behavior.

## Troubleshooting

### `ModuleNotFoundError: backend`

Use module mode from workspace root:

```powershell
python -m Engine.backend --serve-api
```

Do not run `python Engine/backend/app/api.py` directly.

### API key error

Set one of:

- `API_KEY`
- `GOOGLE_API_KEY`

in repository root `.env`.

### No artifacts returned yet

The job may still be running. Check:

- `GET /pipeline/jobs/{job_id}`
- `GET /pipeline/jobs/{job_id}/stream`

then fetch artifacts again.
