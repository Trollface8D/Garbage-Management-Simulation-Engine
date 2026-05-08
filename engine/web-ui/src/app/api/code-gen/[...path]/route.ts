import { NextResponse } from "next/server";

export const runtime = "nodejs";

function resolveBackendBaseUrl(): string {
  const configured =
    process.env.BACKEND_API_BASE_URL ||
    process.env.NEXT_PUBLIC_BACKEND_API_BASE_URL ||
    "http://127.0.0.1:8000";
  return configured.replace(/\/+$/, "");
}

async function proxyJson(request: Request, ctx: { params: Promise<{ path: string[] }> }, method: string) {
  const { path } = await ctx.params;
  const tail = (path || []).join("/");
  const incomingUrl = new URL(request.url);
  const backend = resolveBackendBaseUrl();
  const target = `${backend}/code_gen/${tail}${incomingUrl.search}`;

  const init: RequestInit = { method, cache: "no-store" };
  if (method !== "GET" && method !== "HEAD") {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      init.body = await request.text();
      init.headers = { "content-type": "application/json" };
    } else if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
      init.body = await request.formData();
    } else {
      const text = await request.text();
      if (text) {
        init.body = text;
        init.headers = { "content-type": contentType || "text/plain" };
      }
    }
  }

  const upstream = await fetch(target, init);
  const contentType = upstream.headers.get("content-type") || "application/json";
  const buffer = await upstream.arrayBuffer();
  return new NextResponse(buffer, {
    status: upstream.status,
    headers: { "content-type": contentType },
  });
}

export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxyJson(request, ctx, "GET");
}

export async function POST(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxyJson(request, ctx, "POST");
}

export async function DELETE(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxyJson(request, ctx, "DELETE");
}

export async function PATCH(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxyJson(request, ctx, "PATCH");
}
