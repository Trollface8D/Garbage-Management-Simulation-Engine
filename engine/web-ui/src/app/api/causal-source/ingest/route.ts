import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { upsertCausalSourceItem, type CausalSourceItem } from "@/lib/db";
import drizzleDb from "@/lib/db-modules/drizzle";
import {
  componentProjectLinks,
  componentTrash,
  projectComponents,
  projects,
  projectTrash,
} from "@/lib/db-modules/schema";

type SupportedSourceType = "text" | "audio";

const GEMINI_MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-2.0-flash";

export const runtime = "nodejs";

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function getUploadsDirectory(): string {
  return path.resolve(process.cwd(), ".uploads", "causal-source");
}

function normalizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function projectExists(projectId: string): boolean {
  const row = drizzleDb
    .select({ id: projects.id })
    .from(projects)
    .leftJoin(projectTrash, eq(projectTrash.projectId, projects.id))
    .where(and(eq(projects.id, projectId), isNull(projectTrash.projectId)))
    .limit(1)
    .get();

  return Boolean(row);
}

function componentExists(projectId: string, componentId: string): boolean {
  const row = drizzleDb
    .select({ id: projectComponents.id })
    .from(projectComponents)
    .innerJoin(componentProjectLinks, eq(componentProjectLinks.componentId, projectComponents.id))
    .leftJoin(componentTrash, eq(componentTrash.componentId, projectComponents.id))
    .leftJoin(projectTrash, eq(projectTrash.projectId, componentProjectLinks.projectId))
    .where(
      and(
        eq(projectComponents.id, componentId),
        eq(componentProjectLinks.projectId, projectId),
        isNull(componentTrash.componentId),
        isNull(projectTrash.projectId),
      ),
    )
    .limit(1)
    .get();

  return Boolean(row);
}

function detectSourceType(file: File): SupportedSourceType {
  const lowerName = file.name.toLowerCase();

  if (file.type.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|flac|aac|webm)$/i.test(lowerName)) {
    return "audio";
  }

  return "text";
}

function isTextLikeFile(file: File): boolean {
  const lowerName = file.name.toLowerCase();
  return (
    file.type.startsWith("text/") ||
    /\.(txt|md|csv|json|log|tsv|yaml|yml)$/i.test(lowerName)
  );
}

function isPdfFile(file: File): boolean {
  const lowerName = file.name.toLowerCase();
  return file.type === "application/pdf" || lowerName.endsWith(".pdf");
}

function extractGeminiText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const candidates = (payload as { candidates?: unknown[] }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return "";
  }

  const first = candidates[0] as { content?: { parts?: Array<{ text?: string }> } };
  const parts = first?.content?.parts;
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

async function runGeminiInlineDataPrompt(
  buffer: Buffer,
  mimeType: string,
  prompt: string,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is required for this file type.");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType,
                data: buffer.toString("base64"),
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Gemini request failed (${String(response.status)}): ${errorBody}`);
  }

  const payload = (await response.json()) as unknown;
  const text = extractGeminiText(payload);
  if (!text) {
    throw new Error("Gemini returned empty text.");
  }

  return text;
}

async function transcribeAudioWithGemini(buffer: Buffer, mimeType: string, fileName: string): Promise<string> {
  return runGeminiInlineDataPrompt(
    buffer,
    mimeType || "audio/mpeg",
    `Transcribe this audio file verbatim to plain text. Keep original language and punctuation. File: ${fileName}`,
  );
}

async function extractPdfWithGemini(buffer: Buffer, fileName: string): Promise<string> {
  return runGeminiInlineDataPrompt(
    buffer,
    "application/pdf",
    `Extract all readable text from this PDF document as plain text. Preserve section order and line breaks when possible. File: ${fileName}`,
  );
}

// async function extractPdfWithLocalParser(buffer: Buffer): Promise<string> {
//   const { PDFParse } = await import("pdf-parse");
//   const parser = new PDFParse({ data: buffer });

//   try {
//     const result = await parser.getText();
//     return (result.text ?? "").trim();
//   } finally {
//     await parser.destroy().catch(() => undefined);
//   }
// }

async function extractRawTextFromUploadedFile(file: File, buffer: Buffer, sourceType: SupportedSourceType): Promise<string> {
  if (sourceType === "audio") {
    return transcribeAudioWithGemini(buffer, file.type, file.name);
  }

  if (isPdfFile(file)) {
    return extractPdfWithGemini(buffer, file.name);
  }

  if (isTextLikeFile(file)) {
    return buffer.toString("utf8").trim();
  }

  throw new Error("Unsupported file format. Please upload text, PDF, or audio file.");
}

export async function POST(request: Request) {
  const formData = await request.formData();

  const projectId = String(formData.get("projectId") || "").trim();
  const componentId = String(formData.get("componentId") || "").trim();
  const label = String(formData.get("label") || "file upload").trim() || "file upload";
  const file = formData.get("file");

  if (!projectId || !componentId) {
    return badRequest("projectId and componentId are required.");
  }

  if (!(file instanceof File)) {
    return badRequest("file is required.");
  }

  if (file.size === 0) {
    return badRequest("Uploaded file is empty.");
  }

  if (!projectExists(projectId)) {
    return badRequest(`projectId '${projectId}' was not found or is deleted.`);
  }

  if (!componentExists(projectId, componentId)) {
    return badRequest(`componentId '${componentId}' was not found in project '${projectId}' or is deleted.`);
  }

  const sourceType = detectSourceType(file);
  const itemId = `upload-${randomUUID()}`;
  const now = Date.now();
  let storedPath = "";

  try {
    const uploadsDir = getUploadsDirectory();
    await fs.mkdir(uploadsDir, { recursive: true });

    const safeName = normalizeFileName(file.name || "source.dat");
    const storedName = `${String(now)}-${itemId}-${safeName}`;
    storedPath = path.join(uploadsDir, storedName);

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    await fs.writeFile(storedPath, buffer);

    const rawText = (await extractRawTextFromUploadedFile(file, buffer, sourceType)).trim();
    if (!rawText) {
      return badRequest("No readable text could be extracted from uploaded file.");
    }

    const saved: CausalSourceItem = upsertCausalSourceItem({
      id: itemId,
      projectId,
      componentId,
      label,
      fileName: file.name,
      sourceType,
      status: "raw_text",
      tags: ["uploaded", sourceType === "audio" ? "transcribed" : "parsed"],
      textContent: rawText,
      inputMode: "upload",
      storagePathOrBlob: storedPath,
      transcriptText: sourceType === "audio" ? rawText : null,
    });

    return NextResponse.json({
      item: saved,
      rawTextLength: rawText.length,
    });
  } catch (error) {
    if (storedPath) {
      await fs.rm(storedPath, { force: true }).catch(() => undefined);
    }

    const message = error instanceof Error ? error.message : "Failed to ingest source file.";

    if (/FOREIGN KEY constraint failed/i.test(message)) {
      return badRequest("Selected project/component is invalid. Please reopen this artifact from PM dashboard.");
    }

    console.error("[causal-source/ingest]", message);
    return badRequest(message, 500);
  }
}
