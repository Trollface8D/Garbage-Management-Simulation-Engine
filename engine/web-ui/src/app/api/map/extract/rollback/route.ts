import { NextResponse } from "next/server";

export const runtime = "nodejs";

function resolveBackendBaseUrl(): string {
  const configured =
    process.env.BACKEND_API_BASE_URL ||
    process.env.NEXT_PUBLIC_BACKEND_API_BASE_URL ||
    "http://127.0.0.1:8000";

  return configured.replace(/\/+$/, "");
}

async function parseErrorMessage(response: Response): Promise<string> {
  const fallback = `Request failed with status ${String(response.status)}`;
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || fallback;
  } catch {
    return fallback;
  }
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const jobId = (url.searchParams.get("jobId") || "").trim();
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required." }, { status: 400 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const backendUrl = `${resolveBackendBaseUrl()}/map_extract/jobs/${encodeURIComponent(jobId)}/rollback`;
  const backendResponse = await fetch(backendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (!backendResponse.ok) {
    return NextResponse.json(
      { error: await parseErrorMessage(backendResponse) },
      { status: backendResponse.status || 502 },
    );
  }

  return NextResponse.json(await backendResponse.json());
}
