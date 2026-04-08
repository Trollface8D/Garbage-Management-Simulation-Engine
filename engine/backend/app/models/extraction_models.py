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

    return [ExtractionClassRecord.model_validate(item) for item in items]