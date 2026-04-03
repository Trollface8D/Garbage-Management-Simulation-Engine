import re
from pathlib import Path
from typing import Any

from ....infra.io_utils import read_text, to_class_name


def normalize_entities(raw: Any) -> list[str]:
    candidates: list[str] = []

    if isinstance(raw, list):
        iterable = raw
    elif isinstance(raw, dict):
        for key in ("entities", "entity_list", "data", "items"):
            if isinstance(raw.get(key), list):
                iterable = raw[key]
                break
        else:
            iterable = [raw]
    else:
        iterable = []

    for item in iterable:
        if isinstance(item, str):
            candidates.append(item.strip())
            continue
        if isinstance(item, dict):
            for key in ("entity", "name", "label", "entity_name"):
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    candidates.append(value.strip())
                    break

    deduped: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        normalized = re.sub(r"\s+", " ", candidate).strip()
        if not normalized:
            continue
        marker = normalized.lower()
        if marker in seen:
            continue
        seen.add(marker)
        deduped.append(normalized)

    return deduped


def collect_template_context(entity_template_dir: Path) -> str:
    template_files = [
        entity_template_dir / "entity_object_template.py",
        entity_template_dir / "environment_template.py",
        entity_template_dir / "policy_template.py",
        entity_template_dir / "entity_template.py",
    ]

    sections: list[str] = []
    for path in template_files:
        if path.exists():
            sections.append(f"### {path.name}\n{read_text(path)}")
    return "\n\n".join(sections)


def extract_python_code(text: str) -> str:
    cleaned = text.strip()
    fence_match = re.search(r"```(?:python)?\s*(.*?)```", cleaned, flags=re.S)
    if fence_match:
        cleaned = fence_match.group(1).strip()
    return cleaned


def fallback_entity_code(entity_name: str) -> str:
    return (
        "from .entity_object_template import entity_object\n\n"
        f"class {to_class_name(entity_name)}(entity_object):\n"
        "    pass\n"
    )
