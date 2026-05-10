import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FollowUpAnswerRequest = {
  questions?: unknown[];
  model?: string;
};

function resolveBackendBaseUrl(): string {
  const configured =
    process.env.BACKEND_API_BASE_URL ||
    process.env.NEXT_PUBLIC_BACKEND_API_BASE_URL ||
    "http://127.0.0.1:8000";

  return configured.replace(/\/+$/, "");
}

function resolveFollowUpAnswerModel(): string {
  return (
    process.env.GEMINI_FOLLOW_UP_ANSWER_MODEL ||
    process.env.GEMINI_FOLLOW_UP_MODEL ||
    process.env.GEMINI_MODEL ||
    "gemini-2.5-flash"
  );
}

export async function POST(request: Request) {
  let payload: FollowUpAnswerRequest;
  try {
    payload = (await request.json()) as FollowUpAnswerRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  if (questions.length === 0) {
    return NextResponse.json({ error: "questions is required." }, { status: 400 });
  }

  const backendUrl = `${resolveBackendBaseUrl()}/follow-up-answer`;

  try {
    const backendResponse = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        questions,
        model: payload.model || resolveFollowUpAnswerModel(),
      }),
      cache: "no-store",
    });

    const contentType = backendResponse.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const detail = await backendResponse.text();
      return NextResponse.json(
        {
          error: "Backend returned non-JSON response.",
          detail,
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
        error: "Failed to reach follow-up answer backend.",
        detail: message,
      },
      { status: 502 },
    );
  }
}
