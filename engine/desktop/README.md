# Desktop Shell (Electron)

This folder provides a desktop window shell for compiled backend/frontend artifacts.

## Behavior

- Starts compiled backend and frontend as hidden child processes.
- Uses free localhost ports automatically.
- Waits for services to be ready before opening a window.
- Stops child processes on app exit to release ports.

## Development run

1. Build artifacts:

```bash
bash ../scripts/package-desktop.sh
```

2. Install desktop shell deps:

```bash
npm ci
```

3. Run desktop shell:

```bash
npm run start
```

## Build installer (macOS)

```bash
npm run dist
```

Installers are written to `release/`.

## Icons

Add icon files under `assets/`:

- `icon.png` for runtime window icon in development.
- `icon.icns` for macOS installer icon (optional build config extension).
- `icon.ico` for Windows installer icon (optional build config extension).
