import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChunkRequestPayload = {
  inputText?: string;
  model?: string;
};

function resolveBackendBaseUrl(): string {
  const configured =
    process.env.BACKEND_API_BASE_URL ||
    process.env.NEXT_PUBLIC_BACKEND_API_BASE_URL ||
    "http://127.0.0.1:8000";

  return configured.replace(/\/+$/, "");
}

function resolveChunkModel(): string {
  return process.env.GEMINI_CHUNK_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

function extractFetchErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const code = (cause as { code?: unknown }).code;
      const causeMessage = (cause as { message?: unknown }).message;
      const normalizedCode = typeof code === "string" ? code : "";
      const normalizedCauseMessage = typeof causeMessage === "string" ? causeMessage : "";

      if (normalizedCode || normalizedCauseMessage) {
        return [normalizedCode, normalizedCauseMessage].filter(Boolean).join(": ");
      }
    }
    return error.message;
  }

  return "Unknown proxy error.";
}

export async function POST(request: Request) {
  let payload: ChunkRequestPayload;
  try {
    payload = (await request.json()) as ChunkRequestPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const inputText = (payload.inputText || "").trim();
  if (!inputText) {
    return NextResponse.json({ error: "inputText is required." }, { status: 400 });
  }

  const backendUrl = `${resolveBackendBaseUrl()}/chunk`;

  try {
    const backendResponse = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputText,
        model: payload.model || resolveChunkModel(),
      }),
      cache: "no-store",
    });

    const contentType = backendResponse.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const text = await backendResponse.text();
      return NextResponse.json(
        {
          error: "Backend returned non-JSON response.",
          detail: text,
        },
        { status: backendResponse.status || 502 },
      );
    }

    const data = (await backendResponse.json()) as unknown;
    return NextResponse.json(data, { status: backendResponse.status });
  } catch (error) {
    const backendBaseUrl = resolveBackendBaseUrl();
    const message = extractFetchErrorDetail(error);
    const hint = (
      "Cannot reach backend chunk endpoint. "
      + `Expected backend URL: ${backendBaseUrl}. `
      + "Make sure backend API is running (python -m backend --serve-api --host 127.0.0.1 --port 8000)."
    );

    console.error("[causal-extract/chunk] backend connectivity error", {
      backendUrl,
      detail: message,
    });

    return NextResponse.json(
      {
        error: "Failed to reach chunking backend.",
        detail: message,
        hint,
        backendUrl,
      },
      { status: 502 },
    );
  }
}
