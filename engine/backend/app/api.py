from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .routes import (
    compat_router,
    extract_router,
    health_router,
    jobs_artifacts_router,
    jobs_create_router,
    jobs_query_router,
    jobs_stream_router,
    map_extract_router,
)


def create_app() -> FastAPI:
    app = FastAPI(title="Framework Simulation Engine API", version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health_router)
    app.include_router(extract_router)
    app.include_router(jobs_create_router)
    app.include_router(jobs_query_router)
    app.include_router(jobs_stream_router)
    app.include_router(jobs_artifacts_router)
    app.include_router(map_extract_router)
    app.include_router(compat_router)
    return app

app = create_app()
