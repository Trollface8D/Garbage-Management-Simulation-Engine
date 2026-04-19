from __future__ import annotations


def ensure_usage_progress(
    *,
    usage_totals: dict[str, int],
    before_calls: int,
    prompt_payload: str,
    raw: str,
) -> None:
    # Keep token/call telemetry monotonic even when provider metadata is missing.
    if int(usage_totals.get("call_count", 0)) > before_calls:
        return

    prompt_est = max(1, len(prompt_payload) // 4)
    output_est = max(0, len(raw) // 4)
    usage_totals["prompt_tokens"] = int(usage_totals.get("prompt_tokens", 0)) + prompt_est
    usage_totals["output_tokens"] = int(usage_totals.get("output_tokens", 0)) + output_est
    usage_totals["total_tokens"] = int(usage_totals.get("total_tokens", 0)) + prompt_est + output_est
    usage_totals["call_count"] = before_calls + 1
