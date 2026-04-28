import ast
import json
import logging
import random
import os
import re
import threading
import time
from typing import Any, Callable

from google import genai
from google.genai import errors as genai_errors
from google.genai.types import GenerateContentConfig, Part, ThinkingConfig


logger = logging.getLogger(__name__)


class GeminiCancelledError(RuntimeError):
    """Raised when a cancel_check callback signals True during a Gemini call.

    The gateway uses this to bail out of its retry/backoff loop so callers can
    translate it to their own domain-level cancellation exception without
    spending more tokens on doomed retries.
    """


class GeminiGateway:
    def __init__(self, *, api_key: str, model_name: str) -> None:
        self.client = genai.Client(api_key=api_key)
        self.model_name = model_name

    def create_cache(
        self,
        *,
        text_parts: list[str],
        ttl_seconds: int = 1800,
    ) -> str | None:
        """Create an explicit Gemini context cache from text parts.

        Returns the cache name on success, ``None`` on any failure (most
        commonly: stable content too small to qualify for explicit
        caching). Callers should fall back to inline content when ``None``
        is returned — no behavior change, just no token discount.
        """
        cleaned = [t for t in (s.strip() for s in text_parts) if t]
        if not cleaned:
            return None
        try:
            from google.genai.types import CreateCachedContentConfig, Content
        except ImportError:
            logger.warning("[gemini] cache types not importable — skipping cache")
            return None
        try:
            content = Content(
                role="user",
                parts=[Part.from_text(text=t) for t in cleaned],
            )
            cache = self.client.caches.create(
                model=self.model_name,
                config=CreateCachedContentConfig(
                    contents=[content],
                    ttl=f"{int(ttl_seconds)}s",
                ),
            )
            name = getattr(cache, "name", None)
            if name:
                logger.info(
                    "[gemini] cache created name=%s ttl=%ss bytes=%s",
                    name,
                    ttl_seconds,
                    sum(len(t) for t in cleaned),
                )
            return name
        except Exception as exc:  # noqa: BLE001
            # Common failure: content too small for explicit cache (Gemini
            # has a minimum token threshold). Don't escalate — just log
            # and let callers proceed without caching.
            logger.warning("[gemini] cache create failed (falling back inline): %s", exc)
            return None

    def delete_cache(self, cache_name: str) -> None:
        """Best-effort cache cleanup. Silent on failure."""
        try:
            self.client.caches.delete(name=cache_name)
            logger.info("[gemini] cache deleted name=%s", cache_name)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[gemini] cache delete failed name=%s err=%s", cache_name, exc)

    def generate_text(
        self,
        prompt: str,
        *,
        parts: list[Part] | None = None,
        response_json: bool,
        response_schema: dict[str, Any] | None = None,
        usage_collector: dict[str, int] | None = None,
        on_retry: Callable[[dict[str, Any]], None] | None = None,
        cancel_check: Callable[[], bool] | None = None,
        cached_content: str | None = None,
    ) -> str:
        content_parts: list[Part] = [Part.from_text(text=prompt)]
        if parts:
            content_parts.extend(parts)

        def _safe_int_env(name: str, default: int, *, minimum: int, maximum: int | None) -> int:
            raw = os.getenv(name, str(default))
            try:
                value = int(raw)
            except (TypeError, ValueError):
                logger.warning("[gemini] invalid %s=%r, fallback=%s", name, raw, default)
                value = default

            if value < minimum:
                logger.warning("[gemini] %s=%s below minimum %s, clamped", name, value, minimum)
                return minimum
            if maximum is not None and value > maximum:
                logger.warning("[gemini] %s=%s above maximum %s, clamped", name, value, maximum)
                return maximum
            return value

        # Keep values within practical bounds to avoid provider rejection and overly long hidden reasoning.
        thinking_budget = _safe_int_env("GEMINI_THINKING_BUDGET", 512, minimum=0, maximum=4192)

        config_kwargs: dict[str, Any] = {
            "thinking_config": ThinkingConfig(thinking_budget=thinking_budget),
            "temperature": 0.2,
        }
        if response_json:
            config_kwargs["response_mime_type"] = "application/json"
            if response_schema is not None:
                config_kwargs["response_schema"] = response_schema
        if cached_content:
            config_kwargs["cached_content"] = cached_content

        max_attempts = _safe_int_env("GEMINI_MAX_ATTEMPTS", 4, minimum=1, maximum=10)
        base_delay = 1.5
        max_delay = 30.0

        def _should_cancel() -> bool:
            if cancel_check is None:
                return False
            try:
                return bool(cancel_check())
            except Exception:  # pragma: no cover - defensive
                return False

        def _interruptible_sleep(total: float) -> None:
            # Poll cancel_check every 0.5s so a cancel during backoff wakes
            # up promptly instead of waiting out the full exponential delay.
            step = 0.5
            remaining = total
            while remaining > 0:
                if _should_cancel():
                    return
                chunk = step if remaining > step else remaining
                time.sleep(chunk)
                remaining -= chunk

        def _call_with_cancel() -> Any:
            """Invoke generate_content on a daemon thread so that a cancel
            during the in-flight HTTP request can abandon the wait instantly.

            The background thread cannot be safely killed — the sync
            google-genai SDK has no cancel hook — so when the user cancels
            we simply stop waiting on it. The thread dies naturally once
            the HTTP call returns (daemon=True means it won't block process
            shutdown). We pay the tokens for the in-flight request, but the
            worker stops immediately and no further retries or stages run.
            """
            box: dict[str, Any] = {}

            def _worker() -> None:
                try:
                    box["value"] = self.client.models.generate_content(
                        model=self.model_name,
                        contents=content_parts,
                        config=GenerateContentConfig(**config_kwargs),
                    )
                except BaseException as inner:  # noqa: BLE001
                    box["error"] = inner

            thread = threading.Thread(
                target=_worker,
                name=f"gemini-call-{self.model_name}",
                daemon=True,
            )
            thread.start()
            while thread.is_alive():
                thread.join(timeout=0.5)
                if _should_cancel():
                    logger.info(
                        "[gemini] cancel detected during in-flight request — abandoning thread"
                    )
                    raise GeminiCancelledError(
                        "generate_content cancelled during in-flight request"
                    )
            if "error" in box:
                raise box["error"]
            return box.get("value")

        response = None
        last_exc: Exception | None = None
        for attempt in range(1, max_attempts + 1):
            if _should_cancel():
                logger.info(
                    "[gemini] cancel detected before attempt=%s/%s — aborting",
                    attempt,
                    max_attempts,
                )
                raise GeminiCancelledError("generate_content cancelled before attempt")
            try:
                response = _call_with_cancel()
                break
            except GeminiCancelledError:
                raise
            except Exception as exc:  # pragma: no cover - network path
                last_exc = exc
                if attempt >= max_attempts or not self._is_retryable_transient_error(exc):
                    logger.error(
                        "[gemini] generate_content failed attempt=%s/%s error=%s",
                        attempt,
                        max_attempts,
                        exc,
                    )
                    raise
                delay = min(max_delay, base_delay * (2 ** (attempt - 1)))
                delay += random.uniform(0, delay * 0.25)
                logger.warning(
                    "[gemini] transient error attempt=%s/%s sleeping=%.2fs error=%s",
                    attempt,
                    max_attempts,
                    delay,
                    exc,
                )
                if on_retry is not None:
                    try:
                        on_retry(
                            {
                                "attempt": attempt,
                                "maxAttempts": max_attempts,
                                "delaySeconds": round(delay, 2),
                                "error": str(exc),
                                "errorClass": exc.__class__.__name__,
                            }
                        )
                    except Exception:  # pragma: no cover - defensive
                        logger.exception("[gemini] on_retry callback raised")
                _interruptible_sleep(delay)
                if _should_cancel():
                    logger.info(
                        "[gemini] cancel detected during backoff attempt=%s/%s — aborting",
                        attempt,
                        max_attempts,
                    )
                    raise GeminiCancelledError("generate_content cancelled during backoff")

        if response is None:
            # Should be unreachable — either break or raise above.
            raise last_exc if last_exc else RuntimeError("generate_content returned no response")

        # Final race check: a cancel may have landed between the last 0.5s
        # poll and the thread returning.  Discard the response instead of
        # letting the caller continue into downstream work.
        if _should_cancel():
            raise GeminiCancelledError("generate_content cancelled after response arrived")

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
            usage_collector["provider_total_tokens"] = usage_collector.get("provider_total_tokens", 0) + usage[
                "provider_total_tokens"
            ]
            usage_collector["hidden_tokens"] = usage_collector.get("hidden_tokens", 0) + usage["hidden_tokens"]
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
        thinking_tokens_raw = read_field(usage, "thoughts_token_count", "thoughtsTokenCount")
        cached_tokens_raw = read_field(usage, "cached_content_token_count", "cachedContentTokenCount")

        prompt_tokens = int(prompt_tokens_raw or 0)
        output_tokens = int(output_tokens_raw or 0)
        provider_total_tokens = int(total_tokens_raw or 0)
        thinking_tokens = int(thinking_tokens_raw or 0)
        cached_tokens = int(cached_tokens_raw or 0)

        # Fallback estimate if provider usage metadata is unavailable.
        if prompt_tokens <= 0:
            prompt_tokens = max(1, len(prompt_text) // 4)
        if output_tokens <= 0 and response_text:
            output_tokens = max(1, len(response_text) // 4)
        # Keep displayed total consistent with visible buckets.
        total_tokens = prompt_tokens + output_tokens
        if provider_total_tokens <= 0:
            provider_total_tokens = total_tokens + thinking_tokens + cached_tokens

        hidden_tokens = provider_total_tokens - total_tokens
        if hidden_tokens < 0:
            hidden_tokens = 0

        return {
            "prompt_tokens": prompt_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
            "provider_total_tokens": provider_total_tokens,
            "hidden_tokens": hidden_tokens,
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

    def generate_json(self, prompt: str) -> Any:
        return self.parse_json_relaxed(self.generate_text(prompt, response_json=True))

    @staticmethod
    def parse_json_relaxed(raw_text: str) -> Any:
        raw = raw_text.strip().replace("```json", "").replace("```", "").strip()
        if not raw:
            return []

        def _balanced_blocks(text: str, open_ch: str, close_ch: str) -> list[str]:
            blocks: list[str] = []
            start = -1
            depth = 0
            in_string = False
            escaped = False

            for idx, ch in enumerate(text):
                if in_string:
                    if escaped:
                        escaped = False
                    elif ch == "\\":
                        escaped = True
                    elif ch == '"':
                        in_string = False
                    continue

                if ch == '"':
                    in_string = True
                    continue

                if ch == open_ch:
                    if depth == 0:
                        start = idx
                    depth += 1
                elif ch == close_ch and depth > 0:
                    depth -= 1
                    if depth == 0 and start >= 0:
                        blocks.append(text[start : idx + 1])

            return blocks

        candidates = [raw]
        list_start, list_end = raw.find("["), raw.rfind("]")
        if list_start != -1 and list_end != -1 and list_end > list_start:
            candidates.append(raw[list_start : list_end + 1])

        obj_start, obj_end = raw.find("{"), raw.rfind("}")
        if obj_start != -1 and obj_end != -1 and obj_end > obj_start:
            candidates.append(raw[obj_start : obj_end + 1])

        candidates.extend(_balanced_blocks(raw, "{", "}"))
        candidates.extend(_balanced_blocks(raw, "[", "]"))

        # Preserve order but remove duplicates.
        seen_candidates: set[str] = set()
        uniq_candidates: list[str] = []
        for cand in candidates:
            if cand in seen_candidates:
                continue
            seen_candidates.add(cand)
            uniq_candidates.append(cand)

        for candidate in uniq_candidates:
            candidate = re.sub(r"//.*(?=\n)|/\*.*?\*/", "", candidate, flags=re.S)
            candidate = re.sub(r",\s*([}\]])", r"\1", candidate)
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                pass

            try:
                parsed = ast.literal_eval(candidate)
            except (SyntaxError, ValueError):
                continue
            if isinstance(parsed, (dict, list)):
                return parsed

        raise ValueError("Could not parse JSON from model response")
