import json
import os
import re
from pathlib import Path
from typing import Any


def resolve_api_key() -> str | None:
    return os.getenv("GEMINI_API_KEY") or os.getenv("API_KEY") or os.getenv("GOOGLE_API_KEY")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(read_text(path))


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def preview(value: str, max_len: int = 120) -> str:
    compact = re.sub(r"\s+", " ", value).strip()
    if len(compact) <= max_len:
        return compact
    return compact[: max_len - 3] + "..."


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", value.strip().lower())
    slug = slug.strip("_")
    return slug or "entity"


def to_class_name(value: str) -> str:
    parts = re.split(r"[^A-Za-z0-9]+", value)
    parts = [p for p in parts if p]
    if not parts:
        return "GeneratedEntity"
    return "".join(p[:1].upper() + p[1:] for p in parts)
