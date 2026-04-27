import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .routes import (
    code_gen_router,
    compat_router,
    codegen_analytics_router,
    extract_router,
    group_entities_router,
    health_router,
    jobs_artifacts_router,
    jobs_create_router,
    jobs_query_router,
    jobs_stream_router,
    map_extract_router,
    workspace_archive_router,
)


def _configure_logging() -> None:
    level_name = (os.getenv("LOG_LEVEL") or "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        force=True,
    )
    logging.getLogger().setLevel(level)
    logging.getLogger("backend").setLevel(level)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # Runs after uvicorn's own dictConfig, so our handler survives.
    _configure_logging()
    logging.getLogger("backend.app.api").info(
        "[api] logging configured level=%s", logging.getLogger().level
    )
    yield


def create_app() -> FastAPI:
    _configure_logging()
    app = FastAPI(
        title="Framework Simulation Engine API",
        version="0.1.0",
        lifespan=_lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health_router)
    app.include_router(codegen_analytics_router)
    app.include_router(extract_router)
    app.include_router(group_entities_router)
    app.include_router(jobs_create_router)
    app.include_router(jobs_query_router)
    app.include_router(jobs_stream_router)
    app.include_router(jobs_artifacts_router)
    app.include_router(map_extract_router)
    app.include_router(code_gen_router)
    app.include_router(workspace_archive_router)
    app.include_router(compat_router)
    return app

app = create_app()
