"""Code-page workspace export / import as a ZIP archive.

The frontend uses these to take a portable snapshot of the entity-grouping
workspace mid-pipeline so the user can save progress, share it, or come back
later. The archive contains:

- ``metadata.json`` — opaque JSON blob the frontend hands us; it contains
  the workspace state (entities, selection, grouping, model, …). We do not
  validate its shape — round-trip integrity is the only contract.
- ``artifacts/<relative_path>`` — every file under
    ``code_gen_checkpoints.artifact_root(job_id)`` if a ``job_id`` is given.
- ``checkpoints/<relative_path>`` — the rest of the job directory
    (stage checkpoint JSON, iterations, inputs, inputs.json) so stage logs and
    resume context can be restored.

Import is the inverse: we accept a ZIP, return ``metadata`` parsed back to
JSON plus the names of any ``artifacts/*`` entries we saw. If the archive
contains artifacts/checkpoints entries, we extract them into a fresh job
directory and rewrite ``metadata.jobId`` to that restored job id.
"""

from __future__ import annotations

import io
import json
import logging
import shutil
import uuid
import zipfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..services import code_gen_checkpoints as checkpoints


router = APIRouter(tags=["workspace_archive"])
logger = logging.getLogger(__name__)

MAX_IMPORT_BYTES = 50 * 1024 * 1024  # 50 MB cap on uploads


class WorkspaceExportRequest(BaseModel):
    metadata: dict[str, Any] = Field(
        ...,
        description="Opaque JSON snapshot of the frontend workspace state.",
    )
    jobId: str | None = Field(
        default=None,
        description="Optional code-gen job id; if its artifact dir exists, every file under it is bundled at artifacts/<relative_path>.",
    )


class WorkspaceImportResponse(BaseModel):
    metadata: dict[str, Any] = Field(
        ...,
        description="Parsed contents of metadata.json from the uploaded archive.",
    )
    artifactNames: list[str] = Field(
        default_factory=list,
        description="Relative paths of every artifacts/* entry inside the archive (sorted).",
    )
    restoredJobId: str | None = Field(
        default=None,
        description="Fresh job id created during import when archive entries were extracted.",
    )
    restoredArtifactCount: int = Field(
        default=0,
        description="Count of extracted artifact files restored into the new job directory.",
    )
    restoredCheckpointCount: int = Field(
        default=0,
        description="Count of extracted checkpoint/input files restored into the new job directory.",
    )


def _safe_member_relative(member_name: str, prefix: str) -> str | None:
    if not member_name.startswith(prefix):
        return None
    rel = member_name[len(prefix) :]
    if not rel or rel.endswith("/"):
        return None
    parts = [part for part in rel.split("/") if part]
    if not parts:
        return None
    if any(part in {".", ".."} for part in parts):
        return None
    return "/".join(parts)


def _write_zip_member(
    archive: zipfile.ZipFile,
    *,
    member_name: str,
    target_root: Path,
    rel_path: str,
) -> bool:
    root = target_root.resolve()
    target = (root / rel_path).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        return False

    target.parent.mkdir(parents=True, exist_ok=True)
    with archive.open(member_name, "r") as src, target.open("wb") as dst:
        shutil.copyfileobj(src, dst)
    return True


@router.post(
    "/code_gen/workspace_export",
    response_class=StreamingResponse,
    responses={
        200: {
            "description": "ZIP archive containing metadata.json and any bundled artifacts/*.",
            "content": {"application/zip": {}},
        },
        400: {"description": "Invalid request body."},
    },
)
def export_workspace(payload: WorkspaceExportRequest) -> StreamingResponse:
    job_id = (payload.jobId or "").strip() or None

    buffer = io.BytesIO()
    artifact_count = 0
    checkpoint_count = 0
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "metadata.json",
            json.dumps(payload.metadata, ensure_ascii=False, indent=2),
        )

        if job_id:
            job_root = checkpoints.job_dir(job_id)
            artifact_root = checkpoints.artifact_root(job_id)

            if artifact_root.exists() and artifact_root.is_dir():
                for path in sorted(artifact_root.rglob("*")):
                    if not path.is_file():
                        continue
                    rel = path.relative_to(artifact_root).as_posix()
                    arcname = f"artifacts/{rel}"
                    try:
                        archive.write(path, arcname)
                        artifact_count += 1
                    except OSError as exc:
                        logger.warning("export skipping %s: %s", path, exc)

            if job_root.exists() and job_root.is_dir():
                for path in sorted(job_root.rglob("*")):
                    if not path.is_file():
                        continue
                    # Artifacts are already bundled under artifacts/*.
                    if artifact_root.exists() and path.is_relative_to(artifact_root):
                        continue
                    rel = path.relative_to(job_root).as_posix()
                    arcname = f"checkpoints/{rel}"
                    try:
                        archive.write(path, arcname)
                        checkpoint_count += 1
                    except OSError as exc:
                        logger.warning("export skipping checkpoint %s: %s", path, exc)

    buffer.seek(0)
    filename_stub = job_id or "workspace"
    headers = {
        "Content-Disposition": f'attachment; filename="code-workspace-{filename_stub}.zip"',
        "X-Artifact-Count": str(artifact_count),
        "X-Checkpoint-Count": str(checkpoint_count),
    }
    return StreamingResponse(buffer, media_type="application/zip", headers=headers)


@router.post(
    "/code_gen/workspace_import",
    response_model=WorkspaceImportResponse,
)
async def import_workspace(file: UploadFile = File(...)) -> WorkspaceImportResponse:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded archive is empty.")
    if len(raw) > MAX_IMPORT_BYTES:
        raise HTTPException(status_code=413, detail="Archive exceeds the 50 MB import cap.")

    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise HTTPException(
            status_code=400, detail="Uploaded file is not a valid ZIP archive."
        ) from exc

    names = archive.namelist()
    if "metadata.json" not in names:
        raise HTTPException(
            status_code=400,
            detail="Archive is missing metadata.json — not a code workspace export.",
        )

    try:
        metadata_bytes = archive.read("metadata.json")
        metadata = json.loads(metadata_bytes.decode("utf-8"))
    except (KeyError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status_code=400, detail=f"metadata.json is unreadable: {exc}"
        ) from exc
    if not isinstance(metadata, dict):
        raise HTTPException(
            status_code=400, detail="metadata.json must contain a JSON object."
        )

    artifact_names = sorted(
        n[len("artifacts/") :]
        for n in names
        if n.startswith("artifacts/") and not n.endswith("/")
    )

    artifact_members = [
        (name, rel)
        for name in names
        if (rel := _safe_member_relative(name, "artifacts/")) is not None
    ]
    checkpoint_members = [
        (name, rel)
        for name in names
        if (rel := _safe_member_relative(name, "checkpoints/")) is not None
    ]

    restored_job_id: str | None = None
    restored_artifact_count = 0
    restored_checkpoint_count = 0

    if artifact_members or checkpoint_members:
        restored_job_id = f"job-imported-{uuid.uuid4().hex}"
        checkpoints.ensure_job_dir(restored_job_id)
        restored_artifact_root = checkpoints.artifact_root(restored_job_id)
        restored_job_root = checkpoints.job_dir(restored_job_id)

        try:
            for member_name, rel in artifact_members:
                if _write_zip_member(
                    archive,
                    member_name=member_name,
                    target_root=restored_artifact_root,
                    rel_path=rel,
                ):
                    restored_artifact_count += 1

            for member_name, rel in checkpoint_members:
                if _write_zip_member(
                    archive,
                    member_name=member_name,
                    target_root=restored_job_root,
                    rel_path=rel,
                ):
                    restored_checkpoint_count += 1
        except OSError as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to extract archive into restored job directory: {exc}",
            ) from exc

        metadata["jobId"] = restored_job_id

    return WorkspaceImportResponse(
        metadata=metadata,
        artifactNames=artifact_names,
        restoredJobId=restored_job_id,
        restoredArtifactCount=restored_artifact_count,
        restoredCheckpointCount=restored_checkpoint_count,
    )
