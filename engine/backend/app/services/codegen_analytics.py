from __future__ import annotations

import os
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ...infra.paths import ROOT_DIR


CODEGEN_ANALYTICS_TABLES = (
    "fact_codegen_runs",
    "fact_codegen_generated_files",
    "fact_codegen_input_entities",
    "fact_codegen_metrics",
)

CODEGEN_SOURCE_TABLES = (
    "codegen_runs",
    "codegen_generated_files",
    "codegen_input_entities",
    "codegen_run_metrics",
)


class CodegenAnalyticsError(RuntimeError):
    """Raised when codegen analytics refresh or queries fail."""


def _resolve_source_db_path(db_path: str | None = None) -> Path:
    configured = (db_path or os.getenv("CODEGEN_ANALYTICS_SOURCE_DB_PATH") or "").strip()
    if configured:
        return Path(configured).expanduser().resolve()

    candidates = [
        ROOT_DIR / "Engine" / "web-ui" / "local.db",
        ROOT_DIR / "engine" / "web-ui" / "local.db",
    ]

    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()

    return candidates[0].resolve()


def _resolve_analytics_db_path(db_path: str | None = None) -> Path:
    configured = (db_path or os.getenv("CODEGEN_ANALYTICS_DB_PATH") or "").strip()
    if configured:
        return Path(configured).expanduser().resolve()

    return (ROOT_DIR / "Engine" / "output" / "analytics" / "codegen_analytics.db").resolve()


def _table_exists(connection: sqlite3.Connection, table_name: str, schema_name: str | None = None) -> bool:
    source = f"{schema_name}.sqlite_master" if schema_name else "sqlite_master"
    row = connection.execute(
        f"SELECT 1 FROM {source} WHERE type='table' AND name = ? LIMIT 1",
        (table_name,),
    ).fetchone()
    return row is not None


def _create_codegen_analytics_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS fact_codegen_runs (
          run_id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT,
          project_name TEXT,
          component_id TEXT,
          component_title TEXT,
          component_category TEXT,
          causal_project_document_id TEXT,
          source_type TEXT NOT NULL,
          status TEXT NOT NULL,
          model TEXT,
          started_at TEXT,
          finished_at TEXT,
          duration_ms INTEGER,
          duration_seconds REAL,
          input_entity_count INTEGER NOT NULL,
          generated_entity_count INTEGER NOT NULL,
          generated_file_count INTEGER NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          is_success INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_fact_codegen_runs_project_id ON fact_codegen_runs(project_id);
        CREATE INDEX IF NOT EXISTS idx_fact_codegen_runs_component_id ON fact_codegen_runs(component_id);
        CREATE INDEX IF NOT EXISTS idx_fact_codegen_runs_status ON fact_codegen_runs(status);
        CREATE INDEX IF NOT EXISTS idx_fact_codegen_runs_created_at ON fact_codegen_runs(created_at);

        CREATE TABLE IF NOT EXISTS fact_codegen_generated_files (
          generated_file_id TEXT PRIMARY KEY NOT NULL,
          run_id TEXT NOT NULL,
          project_id TEXT,
          project_name TEXT,
          component_id TEXT,
          component_title TEXT,
          entity_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          language TEXT,
          file_size_bytes INTEGER,
          generation_order INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_fact_codegen_generated_files_run_id ON fact_codegen_generated_files(run_id);
        CREATE INDEX IF NOT EXISTS idx_fact_codegen_generated_files_entity_name ON fact_codegen_generated_files(entity_name);

        CREATE TABLE IF NOT EXISTS fact_codegen_input_entities (
          input_entity_id TEXT PRIMARY KEY NOT NULL,
          run_id TEXT NOT NULL,
          project_id TEXT,
          project_name TEXT,
          component_id TEXT,
          component_title TEXT,
          source_causal_id TEXT,
          entity_name TEXT NOT NULL,
          source_head TEXT,
          source_relationship TEXT,
          source_tail TEXT,
          source_detail TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_fact_codegen_input_entities_run_id ON fact_codegen_input_entities(run_id);
        CREATE INDEX IF NOT EXISTS idx_fact_codegen_input_entities_entity_name ON fact_codegen_input_entities(entity_name);

        CREATE TABLE IF NOT EXISTS fact_codegen_metrics (
          metric_row_id TEXT PRIMARY KEY NOT NULL,
          run_id TEXT NOT NULL,
          project_id TEXT,
          project_name TEXT,
          component_id TEXT,
          component_title TEXT,
          metric_key TEXT NOT NULL,
          metric_type TEXT NOT NULL,
          metric_value TEXT NOT NULL,
          metric_number_value REAL,
          metric_boolean_value INTEGER,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_fact_codegen_metrics_run_id ON fact_codegen_metrics(run_id);
        CREATE INDEX IF NOT EXISTS idx_fact_codegen_metrics_key ON fact_codegen_metrics(metric_key);

        CREATE TABLE IF NOT EXISTS codegen_analytics_refresh_log (
          refresh_id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_db_path TEXT NOT NULL,
          analytics_db_path TEXT NOT NULL,
          refreshed_at TEXT NOT NULL,
          fact_codegen_runs_count INTEGER NOT NULL,
          fact_codegen_generated_files_count INTEGER NOT NULL,
          fact_codegen_input_entities_count INTEGER NOT NULL,
          fact_codegen_metrics_count INTEGER NOT NULL,
          warnings_json TEXT NOT NULL
        );
        """
    )


def _drop_codegen_analytics_fact_tables(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        DROP TABLE IF EXISTS fact_codegen_runs;
        DROP TABLE IF EXISTS fact_codegen_generated_files;
        DROP TABLE IF EXISTS fact_codegen_input_entities;
        DROP TABLE IF EXISTS fact_codegen_metrics;
        DROP TABLE IF EXISTS codegen_analytics_refresh_log;
        """
    )


def _clear_codegen_analytics_tables(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        DELETE FROM fact_codegen_runs;
        DELETE FROM fact_codegen_generated_files;
        DELETE FROM fact_codegen_input_entities;
        DELETE FROM fact_codegen_metrics;
        """
    )


def _refresh_fact_codegen_runs(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        INSERT INTO fact_codegen_runs (
          run_id,
          project_id,
          project_name,
          component_id,
          component_title,
          component_category,
          causal_project_document_id,
          source_type,
          status,
          model,
          started_at,
          finished_at,
          duration_ms,
          duration_seconds,
          input_entity_count,
          generated_entity_count,
          generated_file_count,
          error_message,
          created_at,
          updated_at,
          is_success
        )
        SELECT
          run.id,
          run.project_id,
          project.name,
          run.component_id,
          component.title,
          component.category,
          run.causal_project_document_id,
          run.source_type,
          run.status,
          run.model,
          run.started_at,
          run.finished_at,
          run.duration_ms,
          CASE WHEN run.duration_ms IS NULL THEN NULL ELSE (run.duration_ms / 1000.0) END,
          run.input_entity_count,
          run.generated_entity_count,
          run.generated_file_count,
          run.error_message,
          run.created_at,
          run.updated_at,
          CASE WHEN run.status = 'completed' THEN 1 ELSE 0 END
        FROM src.codegen_runs AS run
        LEFT JOIN src.projects AS project ON project.id = run.project_id
        LEFT JOIN src.project_components AS component ON component.id = run.component_id;
        """
    )


def _refresh_fact_codegen_generated_files(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        INSERT INTO fact_codegen_generated_files (
          generated_file_id,
          run_id,
          project_id,
          project_name,
          component_id,
          component_title,
          entity_name,
          file_path,
          language,
          file_size_bytes,
          generation_order,
          created_at
        )
        SELECT
          file.id,
          run.id,
          run.project_id,
          project.name,
          run.component_id,
          component.title,
          file.entity_name,
          file.file_path,
          file.language,
          file.file_size_bytes,
          file.generation_order,
          file.created_at
        FROM src.codegen_generated_files AS file
        INNER JOIN src.codegen_runs AS run ON run.id = file.run_id
        LEFT JOIN src.projects AS project ON project.id = run.project_id
        LEFT JOIN src.project_components AS component ON component.id = run.component_id;
        """
    )


def _refresh_fact_codegen_input_entities(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        INSERT INTO fact_codegen_input_entities (
          input_entity_id,
          run_id,
          project_id,
          project_name,
          component_id,
          component_title,
          source_causal_id,
          entity_name,
          source_head,
          source_relationship,
          source_tail,
          source_detail,
          created_at
        )
        SELECT
          entity.id,
          run.id,
          run.project_id,
          project.name,
          run.component_id,
          component.title,
          entity.source_causal_id,
          entity.entity_name,
          entity.source_head,
          entity.source_relationship,
          entity.source_tail,
          entity.source_detail,
          entity.created_at
        FROM src.codegen_input_entities AS entity
        INNER JOIN src.codegen_runs AS run ON run.id = entity.run_id
        LEFT JOIN src.projects AS project ON project.id = run.project_id
        LEFT JOIN src.project_components AS component ON component.id = run.component_id;
        """
    )


def _refresh_fact_codegen_metrics(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        INSERT INTO fact_codegen_metrics (
          metric_row_id,
          run_id,
          project_id,
          project_name,
          component_id,
          component_title,
          metric_key,
          metric_type,
          metric_value,
          metric_number_value,
          metric_boolean_value,
          created_at
        )
        SELECT
          metric.id,
          run.id,
          run.project_id,
          project.name,
          run.component_id,
          component.title,
          metric.metric_key,
          metric.metric_type,
          metric.metric_value,
          CASE WHEN metric.metric_type = 'number' THEN CAST(metric.metric_value AS REAL) ELSE NULL END,
          CASE
            WHEN metric.metric_type = 'boolean' AND lower(metric.metric_value) IN ('1', 'true', 'yes') THEN 1
            WHEN metric.metric_type = 'boolean' AND lower(metric.metric_value) IN ('0', 'false', 'no') THEN 0
            ELSE NULL
          END,
          metric.created_at
        FROM src.codegen_run_metrics AS metric
        INNER JOIN src.codegen_runs AS run ON run.id = metric.run_id
        LEFT JOIN src.projects AS project ON project.id = run.project_id
        LEFT JOIN src.project_components AS component ON component.id = run.component_id;
        """
    )


def _table_row_count(connection: sqlite3.Connection, table_name: str) -> int:
    row = connection.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()
    return int(row[0]) if row else 0


def refresh_codegen_analytics(
    source_db_path: str | None = None,
    analytics_db_path: str | None = None,
) -> dict[str, Any]:
    source_path = _resolve_source_db_path(source_db_path)
    analytics_path = _resolve_analytics_db_path(analytics_db_path)

    if not source_path.exists():
        raise CodegenAnalyticsError(
            f"Source database does not exist: {source_path}. "
            "Run web-ui first so local.db is created."
        )

    analytics_path.parent.mkdir(parents=True, exist_ok=True)

    warnings: list[str] = []

    with sqlite3.connect(source_path) as source_connection, sqlite3.connect(analytics_path) as analytics_connection:
        analytics_connection.execute("PRAGMA foreign_keys = ON")
        analytics_connection.execute("ATTACH DATABASE ? AS src", (str(source_path),))

        try:
            _drop_codegen_analytics_fact_tables(analytics_connection)
            _create_codegen_analytics_schema(analytics_connection)
            _clear_codegen_analytics_tables(analytics_connection)

            missing_source_tables = [
                table_name
                for table_name in CODEGEN_SOURCE_TABLES
                if not _table_exists(analytics_connection, table_name, schema_name="src")
            ]

            if missing_source_tables:
                warnings.append(
                    "Missing source tables: "
                    + ", ".join(sorted(missing_source_tables))
                    + ". Run latest drizzle migrations in web-ui to enable codegen analytics ingestion."
                )
            else:
                _refresh_fact_codegen_runs(analytics_connection)
                _refresh_fact_codegen_generated_files(analytics_connection)
                _refresh_fact_codegen_input_entities(analytics_connection)
                _refresh_fact_codegen_metrics(analytics_connection)

            counts = {table_name: _table_row_count(analytics_connection, table_name) for table_name in CODEGEN_ANALYTICS_TABLES}
            refreshed_at = datetime.now(timezone.utc).isoformat()

            analytics_connection.execute(
                """
                INSERT INTO codegen_analytics_refresh_log (
                  source_db_path,
                  analytics_db_path,
                  refreshed_at,
                  fact_codegen_runs_count,
                  fact_codegen_generated_files_count,
                  fact_codegen_input_entities_count,
                  fact_codegen_metrics_count,
                  warnings_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(source_path),
                    str(analytics_path),
                    refreshed_at,
                    counts["fact_codegen_runs"],
                    counts["fact_codegen_generated_files"],
                    counts["fact_codegen_input_entities"],
                    counts["fact_codegen_metrics"],
                    json.dumps(warnings),
                ),
            )

            analytics_connection.commit()

            return {
                "sourceDbPath": str(source_path),
                "analyticsDbPath": str(analytics_path),
                "refreshedAt": refreshed_at,
                "counts": counts,
                "warnings": warnings,
            }
        finally:
            try:
                analytics_connection.execute("DETACH DATABASE src")
            except sqlite3.Error:
                pass


def list_codegen_analytics_tables(analytics_db_path: str | None = None) -> list[dict[str, Any]]:
    analytics_path = _resolve_analytics_db_path(analytics_db_path)
    if not analytics_path.exists():
        raise CodegenAnalyticsError(
            f"Analytics database does not exist: {analytics_path}. "
            "Run POST /analytics/codegen/refresh first."
        )

    with sqlite3.connect(analytics_path) as connection:
        return [
            {"name": table_name, "rows": _table_row_count(connection, table_name)}
            for table_name in CODEGEN_ANALYTICS_TABLES
        ]


def query_codegen_analytics_table(
    table_name: str,
    limit: int = 1000,
    offset: int = 0,
    analytics_db_path: str | None = None,
) -> dict[str, Any]:
    if table_name not in CODEGEN_ANALYTICS_TABLES:
        allowed = ", ".join(CODEGEN_ANALYTICS_TABLES)
        raise CodegenAnalyticsError(f"Unsupported table '{table_name}'. Allowed values: {allowed}")

    safe_limit = max(1, min(limit, 10000))
    safe_offset = max(0, offset)

    analytics_path = _resolve_analytics_db_path(analytics_db_path)
    if not analytics_path.exists():
        raise CodegenAnalyticsError(
            f"Analytics database does not exist: {analytics_path}. "
            "Run POST /analytics/codegen/refresh first."
        )

    with sqlite3.connect(analytics_path) as connection:
        connection.row_factory = sqlite3.Row
        total_row = connection.execute(f"SELECT COUNT(*) AS count FROM {table_name}").fetchone()
        total = int(total_row["count"]) if total_row else 0

        rows = connection.execute(
            f"SELECT * FROM {table_name} LIMIT ? OFFSET ?",
            (safe_limit, safe_offset),
        ).fetchall()

    return {
        "table": table_name,
        "limit": safe_limit,
        "offset": safe_offset,
        "total": total,
        "rows": [dict(row) for row in rows],
    }
