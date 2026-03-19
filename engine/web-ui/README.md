## Pipeline Web UI (Next.js)

This app provides a browser interface for your Python pipeline using a FastAPI sidecar service (`Engine/backend`).

Features:
- Upload transcript/audio input files or paste raw text.
- Configure model and chunking settings.
- Run the Python pipeline through a local FastAPI microservice (`localhost`).
- Display summary, entities, follow-up questions, causal output, and generated entity files.

## Prerequisites

1. Python environment for the project is ready (`.venv` recommended).
2. Pipeline dependencies are installed (from `Engine/requirement.txt`).
3. API key is available for Gemini (`API_KEY` or `GOOGLE_API_KEY`) in the repository root `.env`.

Optional:
- Set `NEXT_PUBLIC_ENGINE_API_BASE` to change API base URL (default: `http://127.0.0.1:8000`).

## Run

1. Start FastAPI sidecar (from workspace root):

```bash
python -m Engine.backend.cli --serve-api --host 127.0.0.1 --port 8000
```

2. Start the web UI (from this `web-ui` folder):

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## How It Works

- Frontend page: `src/app/page.tsx`
- Sidecar API: `Engine/backend/api.py`

The FastAPI sidecar:
1. Accepts multipart form data (file or text input).
2. Runs pipeline stages with callback-based progress events.
3. Streams stage updates and final result via SSE (`/pipeline/run/stream`).
4. Returns generated artifacts to render in the UI.

## Notes

- Large inputs may take time because pipeline stages call external model APIs.
- Generated files and run outputs remain on disk under `Engine/output/pipeline_runs/fastapi_runs`.
