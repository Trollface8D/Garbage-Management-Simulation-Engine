#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
WEB_UI_DIR="$ROOT_DIR/web-ui"
DIST_DIR="$ROOT_DIR/dist"
BUILD_ROOT="$DIST_DIR/desktop-build"
BACKEND_BUILD_DIR="$BUILD_ROOT/backend"
FRONTEND_BUILD_DIR="$BUILD_ROOT/frontend"
DESKTOP_RESOURCES_DIR="$ROOT_DIR/desktop/resources"
DESKTOP_DIR_DEFAULT="$ROOT_DIR/desktop"
NEXTTRON_DIR="${NEXTTRON_DIR:-$DESKTOP_DIR_DEFAULT}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
NODE_BIN="${NODE_BIN:-node}"
NPM_BIN="${NPM_BIN:-npm}"
SKIP_CLEAN="${SKIP_CLEAN:-0}"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8000}"

log() {
    printf '\n[%s] %s\n' "$(date +"%Y-%m-%d %H:%M:%S")" "$1"
}

require_cmd() {
    local cmd="$1"
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: required command '$cmd' is not available." >&2
        exit 1
    fi
}

clean() {
    if [[ "$SKIP_CLEAN" == "1" ]]; then
        log "Skipping clean step (SKIP_CLEAN=1)."
        mkdir -p "$BUILD_ROOT"
        return
    fi

    log "Cleaning previous build outputs."
    rm -rf "$BUILD_ROOT"
    mkdir -p "$BACKEND_BUILD_DIR" "$FRONTEND_BUILD_DIR"
}

build_backend() {
    log "Building backend executable with PyInstaller."
    local venv_dir="$BACKEND_DIR/.venv-pack"

    "$PYTHON_BIN" -m venv "$venv_dir"
    # shellcheck disable=SC1091
    source "$venv_dir/bin/activate"

    python -m pip install --upgrade pip
    python -m pip install -r "$BACKEND_DIR/requirement.txt"
    python -m pip install pyinstaller

    BACKEND_HOST="$BACKEND_HOST" BACKEND_PORT="$BACKEND_PORT" \
    pyinstaller \
        --clean \
        --noconfirm \
        --onedir \
        --name gms-backend \
        --paths "$ROOT_DIR" \
        "$BACKEND_DIR/packaging/serve_api_entry.py"

    mkdir -p "$BACKEND_BUILD_DIR"
    cp -R "$BACKEND_DIR/dist/gms-backend" "$BACKEND_BUILD_DIR/"

    deactivate
    log "Backend build ready at $BACKEND_BUILD_DIR/gms-backend"
}

build_frontend() {
    log "Building Next.js frontend."
    pushd "$WEB_UI_DIR" >/dev/null
    "$NPM_BIN" ci
    "$NPM_BIN" run build
    popd >/dev/null

    mkdir -p "$FRONTEND_BUILD_DIR"
    cp -R "$WEB_UI_DIR/.next/standalone" "$FRONTEND_BUILD_DIR/"
    cp -R "$WEB_UI_DIR/.next/static" "$FRONTEND_BUILD_DIR/static"

    if [[ -d "$WEB_UI_DIR/public" ]]; then
        cp -R "$WEB_UI_DIR/public" "$FRONTEND_BUILD_DIR/public"
    fi

    log "Frontend build ready at $FRONTEND_BUILD_DIR"
}

sync_for_nexttron() {
    if [[ ! -d "$NEXTTRON_DIR" ]]; then
        log "No Nexttron directory found at $NEXTTRON_DIR. Skipping desktop packaging step."
        return
    fi

    log "Syncing backend/frontend artifacts into Nexttron resources."
    mkdir -p "$DESKTOP_RESOURCES_DIR"
    rm -rf "$DESKTOP_RESOURCES_DIR/backend" "$DESKTOP_RESOURCES_DIR/frontend"

    cp -R "$BACKEND_BUILD_DIR/gms-backend" "$DESKTOP_RESOURCES_DIR/backend"
    cp -R "$FRONTEND_BUILD_DIR" "$DESKTOP_RESOURCES_DIR/frontend"

    if [[ -f "$NEXTTRON_DIR/package.json" ]]; then
        pushd "$NEXTTRON_DIR" >/dev/null
        "$NPM_BIN" ci

        if "$NPM_BIN" run | grep -q "dist"; then
            log "Running Nexttron packaging script: npm run dist"
            "$NPM_BIN" run dist
        else
            log "No dist script in $NEXTTRON_DIR/package.json. Artifacts were synced only."
        fi

        popd >/dev/null
    else
        log "No package.json found in $NEXTTRON_DIR. Artifacts were synced only."
    fi
}

summary() {
    log "Packaging pipeline completed."
    echo "Backend artifact : $BACKEND_BUILD_DIR/gms-backend"
    echo "Frontend artifact: $FRONTEND_BUILD_DIR"
    echo "Nexttron dir     : $NEXTTRON_DIR"
}

main() {
    require_cmd "$PYTHON_BIN"
    require_cmd "$NODE_BIN"
    require_cmd "$NPM_BIN"

    clean
    build_backend
    build_frontend
    sync_for_nexttron
    summary
}

main "$@"
