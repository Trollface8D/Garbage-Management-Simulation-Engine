import json
from pathlib import Path
from typing import Any

from fastapi.responses import JSONResponse

from ..models.job_models import JobRecord


ARTIFACT_FILE_MAP: dict[str, str] = {
    "summary": "summary.json",
    "transcript": "transcript.txt",
    "chunks": "chunks.json",
    "causalByChunk": "causal_by_chunk.json",
    "causalCombined": "causal_combined.json",
    "followUpQuestions": "follow_up_questions.json",
    "entities": "entities.json",
    "generatedEntityFiles": "generated_entity_files.json",
    "generationLog": "generation_log.csv",
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def build_response_from_run_dir(run_dir: Path, stdout: str) -> dict[str, Any]:
    summary = read_json(run_dir / "summary.json")
    entities = read_json(run_dir / "entities.json")
    follow_up_questions = read_json(run_dir / "follow_up_questions.json")
    causal_combined = read_json(run_dir / "causal_combined.json")
    generated_entity_files = read_json(run_dir / "generated_entity_files.json")

    return {
        "summary": summary,
        "entities": entities,
        "followUpQuestions": follow_up_questions,
        "causalCombined": causal_combined,
        "generatedEntityFiles": generated_entity_files,
        "stdout": stdout,
    }


def resolve_run_dir(job: JobRecord) -> Path | None:
    if job.run_dir:
        return Path(job.run_dir)
    if isinstance(job.result, dict):
        summary = job.result.get("summary")
        if isinstance(summary, dict) and summary.get("run_dir"):
            return Path(str(summary["run_dir"]))
    return None


def list_artifacts(job: JobRecord) -> dict[str, Any]:
    run_dir = resolve_run_dir(job)
    if run_dir is None:
        return {"runDir": None, "artifacts": []}

    artifacts = []
    for name, filename in ARTIFACT_FILE_MAP.items():
        path = run_dir / filename
        artifacts.append(
            {
                "name": name,
                "file": filename,
                "ready": path.exists(),
            }
        )

    return {
        "runDir": str(run_dir),
        "artifacts": artifacts,
    }


def read_artifact(job: JobRecord, artifact_name: str) -> Any:
    if artifact_name not in ARTIFACT_FILE_MAP:
        return JSONResponse({"error": f"Unknown artifact '{artifact_name}'."}, status_code=404)

    run_dir = resolve_run_dir(job)
    if run_dir is None:
        return JSONResponse({"error": "Artifacts are not available yet."}, status_code=409)

    artifact_path = run_dir / ARTIFACT_FILE_MAP[artifact_name]
    if not artifact_path.exists():
        return JSONResponse({"error": f"Artifact '{artifact_name}' is not ready yet."}, status_code=409)

    suffix = artifact_path.suffix.lower()
    if suffix == ".json":
        return read_json(artifact_path)

    return {
        "name": artifact_name,
        "file": artifact_path.name,
        "content": artifact_path.read_text(encoding="utf-8"),
    }
