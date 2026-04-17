import { NextResponse } from "next/server";
import { toHttpErrorResponse } from "./lib/http-error";
import { parseIngestRequest } from "./lib/request";
import { ingestUploadedSource } from "./lib/use-case";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const parsed = await parseIngestRequest(request);
    const result = await ingestUploadedSource(parsed);
    return NextResponse.json(result);
  } catch (error) {
    return toHttpErrorResponse(error);
  }
}
