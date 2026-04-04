import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getLatestInputDocumentForItem } from "@/lib/db";

export const runtime = "nodejs";

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const itemId = (url.searchParams.get("itemId") || "").trim();

  if (!itemId) {
    return badRequest("itemId is required.");
  }

  const inputDocument = getLatestInputDocumentForItem(itemId);
  if (!inputDocument) {
    return badRequest("Input document not found.", 404);
  }

  const sourcePath = inputDocument.storage_path_or_blob;
  if (!sourcePath) {
    return badRequest("No original file is attached for this item.", 404);
  }

  try {
    const resolvedPath = path.resolve(sourcePath);
    const data = await fs.readFile(resolvedPath);

    return new Response(data, {
      headers: {
        "Content-Type": inputDocument.source_type === "audio" ? "audio/*" : "application/octet-stream",
        "Content-Disposition": `inline; filename="${inputDocument.original_file_name}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return badRequest("Attached file cannot be read.", 404);
  }
}
