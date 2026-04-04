# Desktop Shell (Electron)

This folder provides a desktop window shell for compiled backend/frontend artifacts.

## Behavior

- Development run starts backend from Python source.
- Packaged app run starts backend from compiled executable.
- Starts frontend from standalone resources as hidden child process.
- Uses free localhost ports automatically.
- Waits for services to be ready before opening a window.
- Stops child processes on app exit to release ports.

## Development run
0. preparing
```bash
# 1. cd to folder that this read me is located
# 2. if node module is not present, run npm install
# 
```

1. Build artifacts:

```bash
# set bin path to your python executable recommended to be 3.10 or above
PYTHON_BIN=backend/env/bin/python bash scripts/package-desktop.sh
```

2. Install desktop shell deps:

```bash
npm ci
```

3. Run desktop shell:

```bash
npm run start
```

Notes:

- Backend source changes are picked up without rebuilding PyInstaller output.
- If frontend code changes, rebuild/sync resources with `bash ../scripts/package-desktop.sh`.
- Development backend requires Python 3.10+.
- If `PYTHON_BIN` is not set, desktop startup first tries project-local interpreters such as `engine/backend/env/bin/python`, then falls back to common system commands.
- Set `PYTHON_BIN` to force a specific Python executable, for example:

```bash
PYTHON_BIN=python3.11 npm run start
```

## Build installer (macOS)

```bash
npm run dist
```

Installers are written to `release/`.

## Build Windows `.exe` (option)

Yes, Electron can produce Windows `.exe` installers.

From `engine/desktop`, run:

```bash
npm run dist -- --win nsis
```

You can also build a portable `.exe`:

```bash
npm run dist -- --win portable
```

Output files are written to `release/`.

Note:

- Best reliability is building Windows artifacts on a Windows runner/machine (local Windows, GitHub Actions Windows runner, etc.).
- Cross-building from macOS may require extra tooling and can fail depending on target/signing setup.

## Icons

Add icon files under `assets/`:

- `icon.png` for runtime window icon in development.
- `icon.icns` for macOS installer icon (optional build config extension).
- `icon.ico` for Windows installer icon (optional build config extension).
