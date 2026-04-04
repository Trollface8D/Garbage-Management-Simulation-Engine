"""PyInstaller entrypoint for running the backend FastAPI server as a desktop sidecar."""

from __future__ import annotations

import os

import uvicorn

from backend.app.api import app


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def main() -> None:
    host = os.getenv("BACKEND_HOST", "127.0.0.1")
    port = _env_int("BACKEND_PORT", 8000)
    uvicorn.run(app, host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
