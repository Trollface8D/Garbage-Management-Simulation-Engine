from __future__ import annotations

import logging

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..services.codegen_analytics import (
    CodegenAnalyticsError,
    list_codegen_analytics_tables,
    query_codegen_analytics_table,
    refresh_codegen_analytics,
)


logger = logging.getLogger(__name__)
router = APIRouter(tags=["analytics", "codegen"])


class CodegenAnalyticsRefreshRequest(BaseModel):
    sourceDbPath: str | None = None
    analyticsDbPath: str | None = None


@router.post("/analytics/codegen/refresh")
def refresh_codegen_analytics_route(payload: CodegenAnalyticsRefreshRequest | None = None):
    request_payload = payload or CodegenAnalyticsRefreshRequest()

    try:
        result = refresh_codegen_analytics(
            source_db_path=request_payload.sourceDbPath,
            analytics_db_path=request_payload.analyticsDbPath,
        )
        return {"ok": True, **result}
    except CodegenAnalyticsError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except Exception as exc:
        logger.exception("Unexpected codegen analytics refresh failure")
        return JSONResponse({"error": f"Failed to refresh codegen analytics: {exc}"}, status_code=500)


@router.get("/analytics/codegen/tables")
def get_codegen_analytics_tables(analyticsDbPath: str | None = Query(default=None)):
    try:
        return {"tables": list_codegen_analytics_tables(analytics_db_path=analyticsDbPath)}
    except CodegenAnalyticsError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except Exception as exc:
        logger.exception("Unexpected codegen analytics table-list failure")
        return JSONResponse({"error": f"Failed to list codegen analytics tables: {exc}"}, status_code=500)


@router.get("/analytics/codegen/table/{table_name}")
def get_codegen_analytics_table_rows(
    table_name: str,
    limit: int = Query(default=1000, ge=1, le=10000),
    offset: int = Query(default=0, ge=0),
    analyticsDbPath: str | None = Query(default=None),
):
    try:
        return query_codegen_analytics_table(
            table_name=table_name,
            limit=limit,
            offset=offset,
            analytics_db_path=analyticsDbPath,
        )
    except CodegenAnalyticsError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except Exception as exc:
        logger.exception("Unexpected codegen analytics query failure table=%s", table_name)
        return JSONResponse({"error": f"Failed to query codegen analytics table: {exc}"}, status_code=500)
