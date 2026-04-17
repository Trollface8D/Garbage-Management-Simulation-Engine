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
  const formData = await request.formData();

  const backendBaseUrl = resolveBackendBaseUrl();
  const backendStartUrl = `${backendBaseUrl}/map_extract/jobs`;

  const backendResponse = await fetch(backendStartUrl, {
    method: "POST",
    body: formData,
    cache: "no-store",
  });

  if (!backendResponse.ok) {
    return NextResponse.json({ error: await parseErrorMessage(backendResponse) }, { status: backendResponse.status || 502 });
  }

  const payload = (await backendResponse.json()) as unknown;
  return NextResponse.json(payload);
}
