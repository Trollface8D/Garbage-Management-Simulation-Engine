"""Code-page workspace export / import as a ZIP archive.

The frontend uses these to take a portable snapshot of the entity-grouping
workspace mid-pipeline so the user can save progress, share it, or come back
later. The archive contains:

- ``metadata.json`` — opaque JSON blob the frontend hands us; it contains
  the workspace state (entities, selection, grouping, model, …). We do not
  validate its shape — round-trip integrity is the only contract.
- ``artifacts/<relative_path>`` — every file under
  ``code_gen_checkpoints.artifact_root(job_id)`` if a ``job_id`` is given
  and a job dir exists. Lets users carry generated .py / .json artifacts
  alongside the metadata so a partial run is recoverable.

Import is the inverse: we accept a ZIP, return ``metadata`` parsed back to
JSON plus the names of any ``artifacts/*`` entries we saw. Artifact bytes
are not round-tripped to a job directory automatically — that would require
allocating a fresh ``job_id``, which is out of scope here.
"""

from __future__ import annotations

import io
import json
import logging
import zipfile
from typing import Any

from fastapi import APIRouter, Body, UploadFile, File
from fastapi.responses import JSONResponse, StreamingResponse

from ..services import code_gen_checkpoints as checkpoints


router = APIRouter(tags=["workspace_archive"])
logger = logging.getLogger(__name__)

MAX_IMPORT_BYTES = 50 * 1024 * 1024  # 50 MB cap on uploads


@router.post("/code_gen/workspace_export")
def export_workspace(payload: dict[str, Any] = Body(...)) -> StreamingResponse | JSONResponse:
    metadata = payload.get("metadata")
    if not isinstance(metadata, dict):
        return JSONResponse(
            {"error": "`metadata` must be a JSON object."}, status_code=400
        )

    job_id = str(payload.get("jobId") or "").strip() or None

    buffer = io.BytesIO()
    artifact_count = 0
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "metadata.json",
            json.dumps(metadata, ensure_ascii=False, indent=2),
        )

        if job_id:
            root = checkpoints.artifact_root(job_id)
            if root.exists() and root.is_dir():
                for path in sorted(root.rglob("*")):
                    if not path.is_file():
                        continue
                    rel = path.relative_to(root).as_posix()
                    arcname = f"artifacts/{rel}"
                    try:
                        archive.write(path, arcname)
                        artifact_count += 1
                    except OSError as exc:
                        logger.warning("export skipping %s: %s", path, exc)

    buffer.seek(0)
    filename_stub = job_id or "workspace"
    headers = {
        "Content-Disposition": f'attachment; filename="code-workspace-{filename_stub}.zip"',
        "X-Artifact-Count": str(artifact_count),
    }
    return StreamingResponse(buffer, media_type="application/zip", headers=headers)


@router.post("/code_gen/workspace_import")
async def import_workspace(file: UploadFile = File(...)) -> JSONResponse:
    raw = await file.read()
    if not raw:
        return JSONResponse({"error": "Uploaded archive is empty."}, status_code=400)
    if len(raw) > MAX_IMPORT_BYTES:
        return JSONResponse(
            {"error": "Archive exceeds the 50 MB import cap."}, status_code=413
        )

    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        return JSONResponse(
            {"error": "Uploaded file is not a valid ZIP archive."}, status_code=400
        )

    names = archive.namelist()
    if "metadata.json" not in names:
        return JSONResponse(
            {"error": "Archive is missing metadata.json — not a code workspace export."},
            status_code=400,
        )

    try:
        metadata_bytes = archive.read("metadata.json")
        metadata = json.loads(metadata_bytes.decode("utf-8"))
    except (KeyError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        return JSONResponse(
            {"error": f"metadata.json is unreadable: {exc}"}, status_code=400
        )
    if not isinstance(metadata, dict):
        return JSONResponse(
            {"error": "metadata.json must contain a JSON object."}, status_code=400
        )

    artifact_names = sorted(
        n[len("artifacts/") :]
        for n in names
        if n.startswith("artifacts/") and not n.endswith("/")
    )

    return JSONResponse({"metadata": metadata, "artifactNames": artifact_names})
