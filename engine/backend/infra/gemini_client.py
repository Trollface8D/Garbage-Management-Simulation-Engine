import json
import logging
import random
import os
import re
import time
from typing import Any

from google import genai
from google.genai import errors as genai_errors
from google.genai.types import GenerateContentConfig, Part, ThinkingConfig


logger = logging.getLogger(__name__)


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
        usage_collector: dict[str, int] | None = None,
    ) -> str:
        content_parts: list[Part] = [Part.from_text(text=prompt)]
        if parts:
            content_parts.extend(parts)

        thinking_budget = int(os.getenv("GEMINI_THINKING_BUDGET", "512"))
        max_output_tokens = int(os.getenv("GEMINI_MAX_OUTPUT_TOKENS", "1200"))

        config_kwargs: dict[str, Any] = {
            "thinking_config": ThinkingConfig(thinking_budget=thinking_budget),
            "temperature": 0.2,
            "max_output_tokens": max_output_tokens,
        }
        if response_json:
            config_kwargs["response_mime_type"] = "application/json"

        response = self.client.models.generate_content(
            model=self.model_name,
            contents=content_parts,
            config=GenerateContentConfig(**config_kwargs),
        )
        response_text = (response.text or "").strip()

        if usage_collector is not None:
            usage = self._extract_usage(
                response,
                prompt_text=prompt,
                response_text=response_text,
            )
            usage_collector["prompt_tokens"] = usage_collector.get("prompt_tokens", 0) + usage["prompt_tokens"]
            usage_collector["output_tokens"] = usage_collector.get("output_tokens", 0) + usage["output_tokens"]
            usage_collector["total_tokens"] = usage_collector.get("total_tokens", 0) + usage["total_tokens"]
            usage_collector["call_count"] = usage_collector.get("call_count", 0) + 1

        return response_text

    @staticmethod
    def _extract_usage(response: Any, *, prompt_text: str, response_text: str) -> dict[str, int]:
        def read_field(source: Any, *keys: str) -> Any:
            if source is None:
                return None

            for key in keys:
                # Object-style access.
                value = getattr(source, key, None)
                if value is not None:
                    return value

                # Dict-style access.
                if isinstance(source, dict) and key in source:
                    dict_value = source.get(key)
                    if dict_value is not None:
                        return dict_value
            return None

        usage = read_field(response, "usage_metadata", "usageMetadata")
        if usage is None and hasattr(response, "to_json_dict"):
            try:
                payload = response.to_json_dict()
                usage = read_field(payload, "usage_metadata", "usageMetadata")
            except Exception:
                usage = None

        prompt_tokens_raw = read_field(usage, "prompt_token_count", "promptTokenCount")
        output_tokens_raw = read_field(usage, "candidates_token_count", "candidatesTokenCount")
        total_tokens_raw = read_field(usage, "total_token_count", "totalTokenCount")

        prompt_tokens = int(prompt_tokens_raw or 0)
        output_tokens = int(output_tokens_raw or 0)
        total_tokens = int(total_tokens_raw or 0)

        # Fallback estimate if provider usage metadata is unavailable.
        if prompt_tokens <= 0:
            prompt_tokens = max(1, len(prompt_text) // 4)
        if output_tokens <= 0 and response_text:
            output_tokens = max(1, len(response_text) // 4)
        if total_tokens <= 0:
            total_tokens = prompt_tokens + output_tokens

        return {
            "prompt_tokens": prompt_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
        }

    @staticmethod
    def _is_retryable_transient_error(exc: Exception) -> bool:
        if isinstance(exc, genai_errors.ServerError):
            return True

        message = str(exc).lower()
        transient_tokens = (
            "503",
            "unavailable",
            "high demand",
            "resource exhausted",
            "temporarily",
            "timeout",
            "timed out",
            "connection reset",
            "connection aborted",
            "network",
        )
        return any(token in message for token in transient_tokens)

    @staticmethod
    def _is_retryable_transient_error(exc: Exception) -> bool:
        if isinstance(exc, genai_errors.ServerError):
            return True

        message = str(exc).lower()
        transient_tokens = (
            "503",
            "unavailable",
            "high demand",
            "resource exhausted",
            "temporarily",
            "timeout",
            "timed out",
            "connection reset",
            "connection aborted",
            "network",
        )
        return any(token in message for token in transient_tokens)

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
