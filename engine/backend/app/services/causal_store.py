import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from ...infra.paths import DEFAULT_CAUSAL_DB_PATH
from ..models.extraction_models import ExtractionClassRecord
from .job_store import utc_now_iso


class CausalStoreError(Exception):
    pass


class CausalStoreConstraintError(CausalStoreError):
    pass


@dataclass
class CausalStoreResult:
    db_path: str
    inserted_extraction_classes: int
    inserted_causal_rows: int


def _resolve_db_path(db_path: str | None) -> Path:
    candidate = (db_path or os.getenv("CAUSAL_DB_PATH") or str(DEFAULT_CAUSAL_DB_PATH)).strip()
    return Path(candidate).expanduser().resolve()


def _assert_required_tables(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('extraction_classes', 'causal')"
    ).fetchall()
    existing = {row[0] for row in rows}
    if {"extraction_classes", "causal"} - existing:
        raise CausalStoreError(
            "Database is missing required tables: extraction_classes and/or causal. "
            "Run drizzle migrations before using /extract."
        )


def persist_to_causal_tables(
    *,
    db_path: str | None,
    causal_project_document_id: str,
    chunk_id: str | None,
    records: list[ExtractionClassRecord],
) -> CausalStoreResult:
    trimmed_doc_id = causal_project_document_id.strip()
    if not trimmed_doc_id:
        raise CausalStoreError("causal_project_document_id is required for causal table inserts")

    resolved_db_path = _resolve_db_path(db_path)

    if not resolved_db_path.exists():
        raise CausalStoreError(f"Database file does not exist: {resolved_db_path}")

    inserted_classes = 0
    inserted_rows = 0

    try:
        with sqlite3.connect(resolved_db_path) as conn:
            conn.execute("PRAGMA foreign_keys = ON")
            _assert_required_tables(conn)

            for record in records:
                extraction_class_id = uuid4().hex
                created_at = utc_now_iso()

                conn.execute(
                    """
                    INSERT INTO extraction_classes (
                        id,
                        causal_project_document_id,
                        chunk_id,
                        pattern_type,
                        sentence_type,
                        marked_type,
                        explicit_type,
                        marker,
                        source_text,
                        created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        extraction_class_id,
                        trimmed_doc_id,
                        chunk_id.strip() if isinstance(chunk_id, str) and chunk_id.strip() else None,
                        record.pattern_type,
                        record.sentence_type,
                        record.marked_type,
                        record.explicit_type,
                        record.marker,
                        record.source_text,
                        created_at,
                    ),
                )
                inserted_classes += 1

                for relation in record.extracted:
                    conn.execute(
                        """
                        INSERT INTO causal (
                            id,
                            causal_project_document_id,
                            extraction_class_id,
                            head,
                            relationship,
                            tail,
                            detail,
                            created_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            uuid4().hex,
                            trimmed_doc_id,
                            extraction_class_id,
                            relation.head,
                            relation.relationship,
                            relation.tail,
                            relation.detail,
                            created_at,
                        ),
                    )
                    inserted_rows += 1
    except sqlite3.IntegrityError as exc:
        raise CausalStoreConstraintError(
            "Database constraint failed while writing to causal tables. "
            "Ensure causal_project_document_id exists and foreign keys are valid."
        ) from exc
    except sqlite3.Error as exc:
        raise CausalStoreError(f"Failed to write extraction results to database: {exc}") from exc

    return CausalStoreResult(
        db_path=str(resolved_db_path),
        inserted_extraction_classes=inserted_classes,
        inserted_causal_rows=inserted_rows,
    )