# Backend 
## Backend refactor summary

- Split backend into clear subpackages (`app`, `pipeline`, `infra`) to separate API transport, core orchestration, and utility/config concerns.
- Added module entrypoint at `backend/__main__.py` so backend can be started in package mode reliably.
- Moved FastAPI implementation into `backend/app/api.py` to keep route/service code isolated from CLI and helpers.
- Moved pipeline core to `backend/pipeline/*` to keep domain logic reusable by both CLI and API.
- Moved shared paths and IO helpers to `backend/infra/*` to centralize defaults, env loading, and file operations.
- Kept legacy top-level files as compatibility shims (`backend/api.py`, `backend/engine.py`, etc.) to avoid breaking older imports while transitioning.
- Updated CLI imports to package-relative paths for stable resolution across working directories.
- Removed direct API script startup pattern in favor of package/module startup to avoid `ModuleNotFoundError` issues.
- Updated docs to show one canonical backend startup command and current backend layout.

## Backend entry points

Preferred (canonical):

```powershell
python -m Engine.backend --serve-api --host 127.0.0.1 --port 8000
```

Backend CLI pipeline mode (single run, no API server):

```powershell
python -m Engine.backend --input-path path/to/interview.txt --input-type text
```

Compatibility launcher (still supported):

```powershell
python Engine/pipeline_engine.py --input-path path/to/interview.mp3 --input-type mp3
```

Legacy backend CLI module path (works, but canonical command above is preferred):

```powershell
python -m Engine.backend.cli --serve-api --host 127.0.0.1 --port 8000
```

Not recommended:

```powershell
python Engine/backend/api.py
```

Reason: direct script execution can break package imports depending on working directory.

## C4 pipeline engine

Run from workspace root:

```powershell
python Engine/pipeline_engine.py --input-path path/to/interview.mp3 --input-type mp3
```

or with text input:

```powershell
python Engine/pipeline_engine.py --input-path path/to/interview.txt --input-type text
```

Optional inline text mode:

```powershell
python Engine/pipeline_engine.py --input-text "your interview text" --input-type text
```

Start FastAPI sidecar from workspace root:

```powershell
python -m Engine.backend --serve-api --host 127.0.0.1 --port 8000
```

Artifacts are written to `Engine/output/pipeline_runs/run_YYYYMMDD_HHMMSS/`:

- `transcript.txt`
- `chunks.json`
- `causal_by_chunk.json`
- `causal_combined.json`
- `follow_up_questions.json`
- `entities.json`
- `generated_entities/*.py`
- `generated_entity_files.json`
- `generation_log.csv`
- `summary.json`

