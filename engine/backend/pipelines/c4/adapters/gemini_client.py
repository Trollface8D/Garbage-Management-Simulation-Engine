import json
import re
from typing import Any

from google import genai
from google.genai.types import GenerateContentConfig, Part, ThinkingConfig


class GeminiGateway:
    def __init__(self, *, api_key: str, model_name: str) -> None:
        self.client = genai.Client(api_key=api_key)
        self.model_name = model_name

    def generate_text(
        self,
        prompt: str,
        *,
        parts: list[Part] | None = None,
        response_json: bool,
    ) -> str:
        content_parts: list[Part] = [Part.from_text(text=prompt)]
        if parts:
            content_parts.extend(parts)

        config_kwargs: dict[str, Any] = {
            "thinking_config": ThinkingConfig(thinking_budget=2048),
            "temperature": 0.2,
        }
        if response_json:
            config_kwargs["response_mime_type"] = "application/json"

        response = self.client.models.generate_content(
            model=self.model_name,
            contents=content_parts,
            config=GenerateContentConfig(**config_kwargs),
        )
        return (response.text or "").strip()

    def generate_json(self, prompt: str) -> Any:
        return self.parse_json_relaxed(self.generate_text(prompt, response_json=True))

    @staticmethod
    def parse_json_relaxed(raw_text: str) -> Any:
        raw = raw_text.strip().replace("```json", "").replace("```", "").strip()
        if not raw:
            return []

        candidates = [raw]
        list_start, list_end = raw.find("["), raw.rfind("]")
        if list_start != -1 and list_end != -1 and list_end > list_start:
            candidates.append(raw[list_start : list_end + 1])

        obj_start, obj_end = raw.find("{"), raw.rfind("}")
        if obj_start != -1 and obj_end != -1 and obj_end > obj_start:
            candidates.append(raw[obj_start : obj_end + 1])

        for candidate in candidates:
            candidate = re.sub(r"//.*(?=\n)|/\*.*?\*/", "", candidate, flags=re.S)
            candidate = re.sub(r",\s*([}\]])", r"\1", candidate)
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                continue

        raise ValueError("Could not parse JSON from model response")
