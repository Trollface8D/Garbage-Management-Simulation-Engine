# Desktop Packaging Guide (Nexttron + PyInstaller)

This document explains the automated build pipeline added for packaging the project as a desktop-style application.

## What Was Added

- Automation script: [scripts/package-desktop.sh](scripts/package-desktop.sh)
- Runtime launcher script: [scripts/run-compiled-app.sh](scripts/run-compiled-app.sh)
- Electron desktop shell: [desktop/main.js](desktop/main.js)
- Desktop package config: [desktop/package.json](desktop/package.json)
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

## Start The Compiled App

After build completes, start the compiled runtime with one command:

```bash
bash engine/scripts/run-compiled-app.sh
```

What this launcher does automatically:

- Verifies compiled backend/frontend artifacts exist.
- Picks free localhost ports automatically (unless `BACKEND_PORT`/`FRONTEND_PORT` are set).
- Starts backend and frontend in background processes.
- Waits for backend health and frontend readiness before opening browser.
- Writes logs to `engine/dist/runtime-logs/backend.log` and `engine/dist/runtime-logs/frontend.log`.
- Cleans up child processes on exit (`Ctrl+C`, termination, or shell exit), which frees the ports.

Optional launcher env vars:

- `BACKEND_HOST` (default: `127.0.0.1`)
- `BACKEND_PORT` (optional fixed backend port)
- `FRONTEND_PORT` (optional fixed frontend port)
- `OPEN_BROWSER` (`1` default, set `0` to skip auto-open)

Example:

```bash
OPEN_BROWSER=0 FRONTEND_PORT=3100 bash engine/scripts/run-compiled-app.sh
```

## Start As Window Application (Electron)

This is the true desktop app flow (single window, hidden backend/frontend processes, clean shutdown).

1. Build and sync artifacts to `engine/desktop/resources`:

```bash
bash engine/scripts/package-desktop.sh
```

2. Install desktop shell dependencies:

```bash
cd engine/desktop
npm ci
```

3. Launch desktop window app:

```bash
npm run start
```

Development mode behavior (`npm run start` from `engine/desktop`):

- Backend runs from Python source (`python3 -m backend ...`) instead of compiled executable.
- You do not need to rebuild PyInstaller output for backend code-only changes.
- Frontend still runs from `desktop/resources/frontend/standalone`, so rerun packaging after frontend build changes.
- Interpreter selection in dev mode prefers project-local Python (for example `engine/backend/env/bin/python`) before system Python commands.
- Override Python binary with `PYTHON_BIN` if needed.

What this Electron shell handles automatically:

- In development mode, starts backend from source.
- In packaged mode, starts backend executable from `desktop/resources/backend`.
- Chooses free localhost ports for backend and frontend.
- Starts frontend standalone server from `desktop/resources/frontend/standalone/server.js`.
- Keeps both processes hidden from the user (no dedicated backend/frontend terminal windows).
- Loads the app in an Electron `BrowserWindow`.
- Kills child processes during app quit to free ports.

Desktop shell source files:

- [desktop/main.js](desktop/main.js)
- [desktop/package.json](desktop/package.json)
- [desktop/README.md](desktop/README.md)

## Environment Variables

Optional variables to customize behavior:

- `PYTHON_BIN` (default: `python3`)
- `NODE_BIN` (default: `node`)
- `NPM_BIN` (default: `npm`)
- `PYTHON_BIN` (default: `python3`, used by Electron dev startup)
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

## Window App Experience (Icon + Hidden Background Processes)

To get a true desktop window app experience (single app icon, no visible terminal processes), use Electron/Nexttron as the shell.

Recommended behavior in Electron main process:

1. Spawn backend executable from `resources/backend` with hidden process options.
2. Wait until backend `/health` is ready.
3. Spawn frontend standalone server from `resources/frontend/standalone/server.js`.
4. Load the frontend URL into `BrowserWindow`.
5. On app exit, kill both child processes so ports are released.

Icon support:

- macOS icon file: `icon.icns`
- Windows icon file: `icon.ico`
- Configure icon in BrowserWindow and electron-builder packaging config.

If you do not use Electron/Nexttron yet, `run-compiled-app.sh` is the best available process manager and cleanup launcher.

Current status in this repository:

- Electron shell is already created in `engine/desktop`.
- Runtime icon uses `engine/desktop/assets/icon.png` when present.
- You can add installer icons later (`icon.icns` and `icon.ico`) and extend `desktop/package.json` build config.

## Troubleshooting

- `No Nexttron directory found`:
  - Create your Nexttron project and set `NEXTTRON_DIR`, or place it under `engine/desktop`.

- `No dist script`:
  - Add a `dist` script to your Nexttron `package.json` for installer generation.

- Backend build fails at PyInstaller step:
  - Ensure Python toolchain works and all backend imports are resolvable from `engine` root.

- Frontend build fails:
  - Run `npm ci && npm run build` in `engine/web-ui` manually to inspect errors.
