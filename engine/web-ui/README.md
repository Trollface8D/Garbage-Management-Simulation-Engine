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
3. API key is available for Gemini (`GEMINI_API_KEY`, `API_KEY`, or `GOOGLE_API_KEY`) in `Engine/web-ui/.env.local`.

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

The PM dashboard and causal extraction workspace data are stored in a local SQLite database.

### What gets stored

- Project and component metadata
- Component-project relationships
- Soft-delete state for trash
- Recent opened artifacts
- Causal document metadata
- Input documents (uploaded/manual text)
- Text chunks produced by chunking
- Extraction/follow-up pipeline entities

Pipeline run artifacts are still managed by the Python backend output directories.

### Where the database file is

- `engine/web-ui/local.db`

At startup, Drizzle migrations are applied by `src/lib/db-modules/connection.ts`.

Schema ownership:

- Source of truth: `src/lib/db-modules/schema.ts`
- Generated migrations: `drizzle/*.sql`
- Migration metadata: `drizzle/meta/*`

Do not manually edit generated files under `drizzle/` unless absolutely necessary.

### Setup steps

1. Install dependencies in `engine/web-ui`:

```bash
npm install
```

2. Start web UI:

```bash
npm run dev
```

3. (Optional) Run migrations manually:

```bash
npm run db:bootstrap
```

4. Open the app once (`/`, `/pm/...`, `/trash`, or `/recents`).
	This triggers PM API calls and uses the migrated SQLite schema.

### Schema change workflow

1. Update schema in `src/lib/db-modules/schema.ts`.
2. Generate migration SQL:

```bash
npm run db:generate
```

3. Commit both schema and generated migration files.
4. Run app/bootstrap so migrations are applied.

### How CRUD works

There are two CRUD access paths that use the same `local.db` file:

1. Web API (Next.js route)

- Endpoint: `src/app/api/pm/route.ts`
- Data layer entry: `src/lib/db.ts`
- Data modules: `src/lib/db-modules/*`
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

### Causal extract persistence notes

- Uploading files or submitting manual text creates/updates a `causal_project_documents` row and stores content in `input_documents`.
- Editing/splitting/joining chunks in `causal_extract/chunking` saves chunks into `text_chunks`.
- After chunk save, item status is updated from `raw_text` (shown as "not chunked" in UI) to `chunked` on `causal_project_documents`.
- Opening a chunked item in the chunking page loads saved chunks from `text_chunks` as editable blocks.

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

## Map Extraction Workspace (Placeholder Integration)

A new map artifact workspace is available at `/map/{componentId}`.

Current implementation status:
- Uses separate extract and edit endpoints.
- Includes placeholder local API routes:
	- `POST /api/map/extract`
	- `POST /api/map/edit`
- Endpoint override env vars are already wired:
	- `NEXT_PUBLIC_MAP_EXTRACT_ENDPOINT`
	- `NEXT_PUBLIC_MAP_EDIT_ENDPOINT`
- Auth is not enabled by default, but request hooks are prepared in `src/lib/map-api-client.ts` (`getAuthHeaders`).

SQLite persistence note:
- The map page currently saves snapshots in browser localStorage as an interim step.
- For production persistence/indexing, add map-specific tables (for example `map_graph_jobs`, `map_vertices`, `map_edges`, `map_edit_history`) and move save/load from localStorage into `/api/pm` or dedicated map APIs.
