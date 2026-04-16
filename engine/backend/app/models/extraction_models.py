from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ExtractedRelation(BaseModel):
    model_config = ConfigDict(extra="ignore")

    head: str = Field(min_length=1)
    relationship: str = Field(min_length=1)
    tail: str = Field(min_length=1)
    detail: str | None = None


class ExtractionClassRecord(BaseModel):
    model_config = ConfigDict(extra="ignore")

    pattern_type: Literal["C", "A", "F"]
    sentence_type: Literal["SB", "ES", "OT", "SP", "D", "NR"]
    marked_type: Literal["M", "U", "N/A"]
    explicit_type: Literal["E", "I"]
    marker: str | None = None
    source_text: str = Field(min_length=1)
    extracted: list[ExtractedRelation] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_markedness(self) -> "ExtractionClassRecord":
        normalized_marker = (self.marker or "").strip().lower()

        if self.pattern_type == "C":
            if self.marked_type not in {"M", "U"}:
                raise ValueError("marked_type must be M or U when pattern_type is C")
            if self.marked_type == "M" and normalized_marker in {"", "null", "n/a"}:
                raise ValueError("marker must be present when pattern_type is C and marked_type is M")
            return self

        if self.marked_type != "N/A":
            raise ValueError("marked_type must be N/A when pattern_type is A or F")

        return self


ALLOWED_PATTERN_TYPES = {"C", "A", "F"}
ALLOWED_SENTENCE_TYPES = {"SB", "ES", "OT", "SP", "D", "NR"}
ALLOWED_MARKED_TYPES = {"M", "U", "N/A"}
ALLOWED_EXPLICIT_TYPES = {"E", "I"}


def _clean_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _repair_relation(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None

    head = _clean_text(raw.get("head"))
    relationship = _clean_text(raw.get("relationship"))
    tail = _clean_text(raw.get("tail"))
    detail = _clean_text(raw.get("detail"))

    if not head or not relationship or not tail:
        return None

    return {
        "head": head,
        "relationship": relationship,
        "tail": tail,
        "detail": detail or None,
    }


def _repair_extraction_item(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None

    pattern_type = _clean_text(raw.get("pattern_type")).upper()
    sentence_type = _clean_text(raw.get("sentence_type")).upper()
    marked_type = _clean_text(raw.get("marked_type")).upper()
    explicit_type = _clean_text(raw.get("explicit_type")).upper()
    marker = _clean_text(raw.get("marker"))
    source_text = _clean_text(raw.get("source_text"))

    if pattern_type not in ALLOWED_PATTERN_TYPES:
        # Gemini occasionally misplaces sentence label D into pattern_type.
        if pattern_type == "D":
            pattern_type = "F"
        elif sentence_type in {"D", "NR", "ES"}:
            pattern_type = "F"
        else:
            pattern_type = "A"

    if sentence_type not in ALLOWED_SENTENCE_TYPES:
        sentence_type = "D" if _clean_text(raw.get("pattern_type")).upper() == "D" else "NR"

    if explicit_type not in ALLOWED_EXPLICIT_TYPES:
        explicit_type = "I"

    if pattern_type == "C":
        if marked_type not in ALLOWED_MARKED_TYPES or marked_type == "N/A":
            marked_type = "U"
        if marked_type == "M" and not marker:
            # Avoid invalid C+M with empty marker.
            marked_type = "U"
            marker = ""
    else:
        marked_type = "N/A"
        marker = "N/A"

    extracted_raw = raw.get("extracted")
    extracted_items = extracted_raw if isinstance(extracted_raw, list) else []
    extracted: list[dict[str, Any]] = []
    for relation in extracted_items:
        repaired = _repair_relation(relation)
        if repaired:
            extracted.append(repaired)

    if not source_text and extracted:
        first = extracted[0]
        source_text = f"{first['head']} {first['relationship']} {first['tail']}"

    if not source_text:
        return None

    return {
        "pattern_type": pattern_type,
        "sentence_type": sentence_type,
        "marked_type": marked_type,
        "explicit_type": explicit_type,
        "marker": marker or None,
        "source_text": source_text,
        "extracted": extracted,
    }


def validate_extraction_payload(payload: Any) -> list[ExtractionClassRecord]:
    items: list[Any]
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        items = []
        for key in ("data", "items", "extractions", "relationships", "result"):
            value = payload.get(key)
            if isinstance(value, list):
                items = value
                break
        if not items:
            items = [payload]
    else:
        raise ValueError("Gemini output must be a JSON list or object")

    repaired_items: list[dict[str, Any]] = []
    for item in items:
        repaired = _repair_extraction_item(item)
        if repaired is not None:
            repaired_items.append(repaired)

    if not repaired_items:
        raise ValueError("Gemini output does not contain any valid extraction records")

    return [ExtractionClassRecord.model_validate(item) for item in repaired_items]