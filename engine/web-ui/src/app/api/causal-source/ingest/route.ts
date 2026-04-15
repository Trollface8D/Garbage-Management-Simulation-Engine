import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getCausalSourceItem, saveTextChunks, upsertCausalSourceItem, type CausalSourceItem } from "@/lib/db";
import drizzleDb from "@/lib/db-modules/drizzle";
import {
  componentProjectLinks,
  componentTrash,
  projectComponents,
  projects,
  projectTrash,
} from "@/lib/db-modules/schema";

type SupportedSourceType = "text" | "audio";
type SupportedUploadKind = "txt" | "pdf" | "audio";

const GEMINI_MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-2.0-flash";

export const runtime = "nodejs";

function buildUnreadablePdfErrorMessage(fileName: string): string {
  return [
    `PDF parser could not extract readable text from '${fileName}'.`,
    "Possible causes: scanned/image-only PDF, encrypted/password-protected PDF, corrupted PDF,",
    "or non-Unicode embedded fonts (common in some pdfmake exports).",
    "Please re-export as searchable PDF with embedded Unicode fonts, or upload .txt.",
  ].join(" ");
}

function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function resolveGeminiApiKey(): string | null {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.API_KEY || null;
}

function buildGeminiApiKeyErrorMessage(): string {
  return [
    "Gemini API key is missing.",
    "Set one of GEMINI_API_KEY, GOOGLE_API_KEY, or API_KEY in Engine/web-ui/.env.local",
    "(or set it in your shell environment) and restart npm run dev.",
  ].join(" ");
}

type PdfJsModule = {
  getDocument: (source: unknown) => {
    promise: Promise<{
      numPages: number;
      getPage: (pageNumber: number) => Promise<{
        getTextContent: (options?: unknown) => Promise<{
          items: Array<{ str?: string; hasEOL?: boolean }>;
        }>;
        cleanup?: () => void;
      }>;
      cleanup?: () => void;
      destroy?: () => Promise<void>;
    }>;
    destroy?: () => Promise<void>;
  };
};

type PdfParseModule = {
  PDFParse: new (options: { data: Uint8Array }) => {
    getText: () => Promise<{ text?: string }>;
    destroy: () => Promise<void>;
  };
};

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;
let pdfParseModulePromise: Promise<PdfParseModule> | null = null;

async function loadPdfJsModule(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<PdfJsModule>;
  }

  return pdfJsModulePromise;
}

async function loadPdfParseModule(): Promise<PdfParseModule> {
  if (!pdfParseModulePromise) {
    pdfParseModulePromise = import("pdf-parse") as Promise<PdfParseModule>;
  }

  return pdfParseModulePromise;
}

async function extractPdfWithPdfJs(buffer: Buffer): Promise<string> {
  const pdfjsModule = await loadPdfJsModule();
  const loadingTask = pdfjsModule.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
  });
  const doc = await loadingTask.promise;

  try {
    const pages: string[] = [];

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const textContent = await page.getTextContent({ disableNormalization: false });

      const pageText = textContent.items
        .map((item) => {
          const text = typeof item.str === "string" ? item.str : "";
          return item.hasEOL ? `${text}\n` : text;
        })
        .join(" ")
        .trim();

      if (pageText) {
        pages.push(pageText);
      }

      page.cleanup?.();
    }

    return normalizeExtractedText(pages.join("\n\n"));
  } finally {
    doc.cleanup?.();
    await doc.destroy?.().catch(() => undefined);
    await loadingTask.destroy?.().catch(() => undefined);
  }
}

async function extractPdfWithPdfParse(buffer: Buffer): Promise<string> {
  const pdfParseModule = await loadPdfParseModule();
  const parser = new pdfParseModule.PDFParse({ data: new Uint8Array(buffer) });

  try {
    const parsed = await parser.getText();
    return normalizeExtractedText(parsed?.text || "");
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function getUploadsDirectory(): string {
  return path.resolve(process.cwd(), ".uploads", "causal-source");
}

function normalizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function getFileNameLower(file: File): string {
  return file.name.toLowerCase();
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

function isAudioFile(file: File): boolean {
  return file.type.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|flac|aac|webm)$/i.test(getFileNameLower(file));
}

function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || getFileNameLower(file).endsWith(".pdf");
}

function isTxtFile(file: File): boolean {
  return getFileNameLower(file).endsWith(".txt");
}

function detectUploadKind(file: File): SupportedUploadKind | null {
  if (isAudioFile(file)) {
    return "audio";
  }

  if (isPdfFile(file)) {
    return "pdf";
  }

  if (isTxtFile(file)) {
    return "txt";
  }

  return null;
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
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    throw new Error(buildGeminiApiKeyErrorMessage());
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

async function extractPdfWithLocalParser(buffer: Buffer, fileName: string): Promise<string> {
  try {
    const text = await extractPdfWithPdfJs(buffer);
    if (!text) {
      throw new Error("empty extracted text");
    }

    return text;
  } catch (error) {
    console.warn("[causal-source/ingest][pdf] local parser failed", {
      fileName,
      parserError: asErrorMessage(error),
    });
  }

  try {
    const fallbackText = await extractPdfWithPdfParse(buffer);
    if (!fallbackText) {
      throw new Error("empty extracted text");
    }

    return fallbackText;
  } catch (fallbackError) {
    console.warn("[causal-source/ingest][pdf] fallback parser failed", {
      fileName,
      parserError: asErrorMessage(fallbackError),
    });
    throw new Error(buildUnreadablePdfErrorMessage(fileName));
  }
}

async function extractRawTextFromUploadedFile(file: File, buffer: Buffer, uploadKind: SupportedUploadKind): Promise<string> {
  if (uploadKind === "audio") {
    return transcribeAudioWithGemini(buffer, file.type, file.name);
  }

  if (uploadKind === "pdf") {
    return extractPdfWithLocalParser(buffer, file.name);
  }

  if (uploadKind === "txt") {
    return buffer.toString("utf8").trim();
  }

  throw new Error("Unsupported file format. Please upload only .txt, .pdf, or audio files.");
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

  const uploadKind = detectUploadKind(file);
  if (!uploadKind) {
    return badRequest("Unsupported file format. Please upload only .txt, .pdf, or audio files.");
  }

  const sourceType: SupportedSourceType = uploadKind === "audio" ? "audio" : "text";
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

    const rawText = (await extractRawTextFromUploadedFile(file, buffer, uploadKind)).trim();
    if (!rawText) {
      return badRequest("No readable text could be extracted from uploaded file.");
    }

    let saved: CausalSourceItem = upsertCausalSourceItem({
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

    if (uploadKind === "txt") {
      saveTextChunks({
        experimentItemId: itemId,
        projectId,
        componentId,
        chunks: [rawText],
      });

      const refreshed = getCausalSourceItem(itemId);
      if (refreshed) {
        saved = refreshed;
      }
    }

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

    if (/PDF parser could not extract readable text|PDF is unreadable/i.test(message)) {
      return badRequest(message);
    }

    console.error("[causal-source/ingest]", message);
    return badRequest(message, 500);
  }
}
