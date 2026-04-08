import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExtractRequestPayload = {
  inputText?: string;
  model?: string;
  causalProjectDocumentId?: string;
  chunkId?: string;
  dbPath?: string;
};

function resolveBackendBaseUrl(): string {
  const configured =
    process.env.BACKEND_API_BASE_URL ||
    process.env.NEXT_PUBLIC_BACKEND_API_BASE_URL ||
    "http://127.0.0.1:8000";

  return configured.replace(/\/+$/, "");
}

function resolveExtractModel(): string {
  return process.env.GEMINI_EXTRACT_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

export async function POST(request: Request) {
  let payload: ExtractRequestPayload;
  try {
    payload = (await request.json()) as ExtractRequestPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const inputText = (payload.inputText || "").trim();
  if (!inputText) {
    return NextResponse.json({ error: "inputText is required." }, { status: 400 });
  }

  const backendUrl = `${resolveBackendBaseUrl()}/extract`;

  try {
    const backendResponse = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputText,
        model: payload.model || resolveExtractModel(),
        causalProjectDocumentId: payload.causalProjectDocumentId,
        chunkId: payload.chunkId,
        dbPath: payload.dbPath,
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
    const message = error instanceof Error ? error.message : "Unknown proxy error.";
    return NextResponse.json(
      {
        error: "Failed to reach extraction backend.",
        detail: message,
      },
      { status: 502 },
    );
  }
}
