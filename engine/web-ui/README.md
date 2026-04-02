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
python -m Engine.backend --serve-api --host 127.0.0.1 --port 8000
```

2. Start the web UI (from this `web-ui` folder):

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Database (Local SQLite for PM Data)

The PM dashboard data (projects, artifacts/components, trash, recents) is stored in a local SQLite database.

### What gets stored

- Projects
- Components/artifacts
- Soft-delete state for trash
- Recent opened artifacts

Pipeline run artifacts are still managed by the Python backend output directories.

### Where the database file is

- `engine/web-ui/local.db`

When the app starts and the PM API is called, required tables are created automatically by `src/lib/db.ts`.

### Setup steps

1. Install dependencies in `engine/web-ui`:

```bash
npm install
```

2. Start web UI:

```bash
npm run dev
```

3. Open the app once (`/`, `/pm/...`, `/trash`, or `/recents`).
	This triggers PM API calls and initializes SQLite tables if they do not exist.

### How CRUD works

There are two CRUD access paths that use the same `local.db` file:

1. Web API (Next.js route)

- Endpoint: `src/app/api/pm/route.ts`
- Data layer: `src/lib/db.ts`
- Client adapter: `src/lib/pm-storage.ts`

Flow:

UI page -> `pm-storage.ts` -> `/api/pm` -> `db.ts` -> SQLite

2. CLI CRUD

- Script: `scripts/pm-crud.js`
- NPM command:

```bash
npm run pm:cli -- projects:list
npm run pm:cli -- projects:create my-project "My Project"
npm run pm:cli -- components:list
```

Both API and CLI read/write the same SQLite file.

### One-time migration from legacy localStorage

The app automatically migrates old browser `localStorage` PM keys into SQLite once:

- Source keys: `pm.projects`, `pm.components`, `pm.trash.projects`, `pm.trash.components`, `pm.recents`
- Migration marker key: `pm.db.migration.v1`
- Triggered by first PM storage call in `src/lib/pm-storage.ts`

After successful migration, legacy keys are cleared and marker is set.

### Troubleshooting

- If `npm run dev` says another Next dev server is already running, stop the existing process and retry.
- If PM lists appear empty after migration, verify with CLI:

```bash
npm run pm:cli -- projects:list
npm run pm:cli -- components:list
npm run pm:cli -- recents:list
```

## How It Works

- Frontend page: `src/app/page.tsx`
- Sidecar API: `Engine/backend/app/api.py`

The FastAPI sidecar:
1. Accepts multipart form data (file or text input).
2. Runs pipeline stages with callback-based progress events.
3. Streams stage updates and final result via SSE (`/pipeline/run/stream`).
4. Returns generated artifacts to render in the UI.

## Notes

- Large inputs may take time because pipeline stages call external model APIs.
- Generated files and run outputs remain on disk under `Engine/output/pipeline_runs/fastapi_runs`.
