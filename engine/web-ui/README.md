## Pipeline Web UI (Next.js)

This app provides a browser interface for your existing Python pipeline in `Engine/pipeline_engine.py`.

Features:
- Upload transcript/audio input files or paste raw text.
- Configure model and chunking settings.
- Run the Python pipeline from a Next.js API route.
- Display summary, entities, follow-up questions, causal output, and generated entity files.

## Prerequisites

1. Python environment for the project is ready (`.venv` recommended).
2. Pipeline dependencies are installed (from `Engine/requirement.txt`).
3. API key is available for Gemini (`API_KEY` or `GOOGLE_API_KEY`) in the repository root `.env`.

Optional:
- Set `PYTHON_EXECUTABLE` if you want to override Python command detection.

## Run

From this `web-ui` folder:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## How It Works

- Frontend page: `src/app/page.tsx`
- Backend route: `src/app/api/pipeline/run/route.ts`

The API route:
1. Accepts multipart form data (file or text input).
2. Creates a request-specific output directory under `Engine/output/web_ui_runs`.
3. Executes `Engine/pipeline_engine.py`.
4. Reads generated artifacts from the newest `run_*` directory.
5. Returns structured JSON to render in the UI.

## Notes

- Large inputs may take time because pipeline stages call external model APIs.
- Generated files and run outputs remain on disk under `Engine/output/web_ui_runs`.
