from typing import Any


def inject_input(template: str, input_data: str) -> str:
    if "{input}" in template:
        return template.replace("{input}", input_data)
    if "{}" in template:
        return template.replace("{}", input_data)

    import re

    match = re.search(r"\{([A-Za-z0-9_]+)\}", template)
    if match:
        return template.replace(match.group(0), input_data, 1)

    return f"{template}\n\nInput:\n{input_data}"


def normalize_causal_list(
    causal_payload: Any,
    chunk_index: int,
    topic_summary: str,
) -> list[dict[str, Any]]:
    if isinstance(causal_payload, list):
        items = causal_payload
    elif isinstance(causal_payload, dict):
        for key in ("data", "items", "extractions", "relationships"):
            if isinstance(causal_payload.get(key), list):
                items = causal_payload[key]
                break
        else:
            items = [causal_payload]
    else:
        items = []

    normalized: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        enriched = dict(item)
        enriched["chunk_index"] = chunk_index
        enriched["chunk_topic_summary"] = topic_summary
        normalized.append(enriched)
    return normalized


def filter_causal_by_entity(
    combined_causal: list[dict[str, Any]],
    entity_name: str,
    *,
    max_items: int = 40,
) -> list[dict[str, Any]]:
    lowered = entity_name.lower()

    def matches(item: dict[str, Any]) -> bool:
        for key in ("subject", "object", "relationship", "source_text"):
            value = item.get(key)
            if isinstance(value, str) and lowered in value.lower():
                return True

        extracted = item.get("extracted")
        if isinstance(extracted, list):
            for ex in extracted:
                if not isinstance(ex, dict):
                    continue
                if any(
                    isinstance(ex.get(k), str) and lowered in ex[k].lower()
                    for k in ("head", "tail", "relationship")
                ):
                    return True
        return False

    matched = [item for item in combined_causal if matches(item)]
    return matched[:max_items] if matched else combined_causal[:max_items]
