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

type RouteContext = {
  params: Promise<{ kind: string; index: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const url = new URL(request.url);
  const jobId = (url.searchParams.get("jobId") || "").trim();
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required." }, { status: 400 });
  }
  const { kind, index } = await context.params;
  if (!kind || !index) {
    return NextResponse.json({ error: "kind and index are required." }, { status: 400 });
  }
  const backendUrl = `${resolveBackendBaseUrl()}/map_extract/jobs/${encodeURIComponent(
    jobId,
  )}/inputs/${encodeURIComponent(kind)}/${encodeURIComponent(index)}`;
  const backendResponse = await fetch(backendUrl, { method: "GET", cache: "no-store" });
  if (!backendResponse.ok) {
    return NextResponse.json(
      { error: await parseErrorMessage(backendResponse) },
      { status: backendResponse.status || 502 },
    );
  }
  const headers = new Headers();
  const contentType = backendResponse.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const contentDisposition = backendResponse.headers.get("content-disposition");
  if (contentDisposition) headers.set("content-disposition", contentDisposition);
  return new Response(backendResponse.body, { status: 200, headers });
}
