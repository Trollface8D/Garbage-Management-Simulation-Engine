# Desktop Packaging Guide (Nexttron + PyInstaller)

This document explains the automated build pipeline added for packaging the project as a desktop-style application.

## What Was Added

- Automation script: [scripts/package-desktop.sh](scripts/package-desktop.sh)
- PyInstaller backend entrypoint: [backend/packaging/serve_api_entry.py](backend/packaging/serve_api_entry.py)
- Next.js standalone output enabled in [web-ui/next.config.ts](web-ui/next.config.ts)

## How the Build Pipeline Works

When you run the script, it performs these stages in order:

1. Clean output folder
- Creates fresh build workspace under `engine/dist/desktop-build`.
- Can be skipped with `SKIP_CLEAN=1`.

2. Build backend executable (PyInstaller)
- Creates isolated Python build venv at `engine/backend/.venv-pack`.
- Installs backend requirements from `backend/requirement.txt` plus `pyinstaller`.
- Builds a distributable backend app (`onedir`) named `gms-backend`.
- Uses `backend/packaging/serve_api_entry.py`, which starts FastAPI directly with Uvicorn.

3. Build frontend (Next.js)
- Runs `npm ci` and `npm run build` in `engine/web-ui`.
- Relies on `output: "standalone"` in Next config.
- Copies packaged frontend runtime from `.next/standalone` and `.next/static` into build output.

4. Sync artifacts into Nexttron resources (if available)
- If `engine/desktop` (or `NEXTTRON_DIR`) exists, backend/frontend artifacts are copied into:
  - `desktop/resources/backend`
  - `desktop/resources/frontend`
- If `package.json` exists in that folder and has a `dist` script, script runs `npm run dist`.

5. Print summary
- Displays where backend/frontend artifacts were created.

## Run Command

From repository root:

```bash
bash engine/scripts/package-desktop.sh
```

Or executable form:

```bash
./engine/scripts/package-desktop.sh
```

## Environment Variables

Optional variables to customize behavior:

- `PYTHON_BIN` (default: `python3`)
- `NODE_BIN` (default: `node`)
- `NPM_BIN` (default: `npm`)
- `SKIP_CLEAN` (`1` to keep previous build outputs)
- `BACKEND_HOST` (default: `127.0.0.1`)
- `BACKEND_PORT` (default: `8000`)
- `NEXTTRON_DIR` (default: `engine/desktop`)

Example:

```bash
BACKEND_PORT=18000 NEXTTRON_DIR=/absolute/path/to/your-nexttron-app ./engine/scripts/package-desktop.sh
```

## Output Layout

After success, artifacts are under:

- Backend: `engine/dist/desktop-build/backend/gms-backend`
- Frontend: `engine/dist/desktop-build/frontend`

If Nexttron packaging ran, final installer/app outputs are produced by your Nexttron `dist` script in its own configured output path.

## Expected Nexttron Integration Contract

Your Nexttron/Electron main process should:

1. Start `resources/backend` executable as a child process.
2. Wait for backend health endpoint to be ready.
3. Serve/load `resources/frontend` standalone frontend.
4. Stop backend process when app closes.

This script already guarantees artifacts are copied to `desktop/resources/*` in that shape.

## Troubleshooting

- `No Nexttron directory found`:
  - Create your Nexttron project and set `NEXTTRON_DIR`, or place it under `engine/desktop`.

- `No dist script`:
  - Add a `dist` script to your Nexttron `package.json` for installer generation.

- Backend build fails at PyInstaller step:
  - Ensure Python toolchain works and all backend imports are resolvable from `engine` root.

- Frontend build fails:
  - Run `npm ci && npm run build` in `engine/web-ui` manually to inspect errors.
