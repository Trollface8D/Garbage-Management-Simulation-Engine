#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$ROOT_DIR/dist/desktop-build"
BACKEND_EXEC="$BUILD_ROOT/backend/gms-backend/gms-backend"
FRONTEND_SERVER="$BUILD_ROOT/frontend/standalone/server.js"
LOG_DIR="$ROOT_DIR/dist/runtime-logs"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
OPEN_BROWSER="${OPEN_BROWSER:-1}"

mkdir -p "$LOG_DIR"

require_file() {
    local path="$1"
    if [[ ! -e "$path" ]]; then
        echo "Missing required artifact: $path" >&2
        echo "Build first with: bash engine/scripts/package-desktop.sh" >&2
        exit 1
    fi
}

pick_free_port() {
    python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

wait_for_url() {
    local url="$1"
    local timeout_seconds="$2"
    local elapsed=0

    while ! curl -fsS "$url" >/dev/null 2>&1; do
        if [[ "$elapsed" -ge "$timeout_seconds" ]]; then
            echo "Timed out waiting for: $url" >&2
            return 1
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
}

cleanup() {
    local exit_code=$?

    if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" >/dev/null 2>&1; then
        kill "$FRONTEND_PID" >/dev/null 2>&1 || true
        wait "$FRONTEND_PID" 2>/dev/null || true
    fi

    if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
        kill "$BACKEND_PID" >/dev/null 2>&1 || true
        wait "$BACKEND_PID" 2>/dev/null || true
    fi

    echo "Stopped runtime processes."
    exit "$exit_code"
}

trap cleanup EXIT INT TERM

require_file "$BACKEND_EXEC"
require_file "$FRONTEND_SERVER"

BACKEND_PORT="${BACKEND_PORT:-$(pick_free_port)}"
FRONTEND_PORT="${FRONTEND_PORT:-$(pick_free_port)}"
API_BASE="http://${BACKEND_HOST}:${BACKEND_PORT}"
APP_URL="http://127.0.0.1:${FRONTEND_PORT}"

"$BACKEND_EXEC" >"$LOG_DIR/backend.log" 2>&1 &
BACKEND_PID=$!

echo "Starting backend on ${API_BASE} (pid ${BACKEND_PID})"
wait_for_url "${API_BASE}/health" 60

NEXT_PUBLIC_ENGINE_API_BASE="$API_BASE" \
PORT="$FRONTEND_PORT" \
HOSTNAME="127.0.0.1" \
node "$FRONTEND_SERVER" >"$LOG_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!

echo "Starting frontend on ${APP_URL} (pid ${FRONTEND_PID})"
wait_for_url "$APP_URL" 60

echo "Application is ready at: ${APP_URL}"
echo "Logs: $LOG_DIR/backend.log and $LOG_DIR/frontend.log"

if [[ "$OPEN_BROWSER" == "1" ]]; then
    open "$APP_URL" || true
fi

wait "$FRONTEND_PID"
