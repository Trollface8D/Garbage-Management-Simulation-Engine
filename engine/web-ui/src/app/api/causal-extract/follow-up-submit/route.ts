import { NextResponse } from "next/server";
import { saveFollowUpAnswers, type ExtractionClassRecord } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FollowUpSubmitAnswer = {
  questionId?: string;
  questionText?: string;
  sourceText?: string;
  answerText?: string;
  answeredBy?: string;
};

type FollowUpSubmitRequest = {
  experimentItemId?: string;
  answers?: FollowUpSubmitAnswer[];
  model?: string;
};

type ExtractProxyResponse = {
  records?: ExtractionClassRecord[];
  error?: string;
  detail?: string;
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

function normalizeExtractRecords(raw: unknown): ExtractionClassRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const normalized: ExtractionClassRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const row = item as Record<string, unknown>;
    const extractedRaw = Array.isArray(row.extracted) ? row.extracted : [];

    normalized.push({
      pattern_type: typeof row.pattern_type === "string" ? row.pattern_type : "",
      sentence_type: typeof row.sentence_type === "string" ? row.sentence_type : "",
      marked_type: typeof row.marked_type === "string" ? row.marked_type : "",
      explicit_type: typeof row.explicit_type === "string" ? row.explicit_type : "",
      marker: typeof row.marker === "string" ? row.marker : "",
      source_text: typeof row.source_text === "string" ? row.source_text : "",
      extracted: extractedRaw
        .filter((relation) => relation && typeof relation === "object")
        .map((relation) => {
          const relationRow = relation as Record<string, unknown>;
          return {
            head: typeof relationRow.head === "string" ? relationRow.head : "",
            relationship: typeof relationRow.relationship === "string" ? relationRow.relationship : "",
            tail: typeof relationRow.tail === "string" ? relationRow.tail : "",
            detail: typeof relationRow.detail === "string" ? relationRow.detail : "",
          };
        }),
    });
  }

  return normalized;
}

function buildFollowUpExtractText(questionText: string, answerText: string, sourceText?: string): string {
  const chunks = [
    sourceText?.trim() ? `Original source context: ${sourceText.trim()}` : "",
    `Follow-up question: ${questionText.trim()}`,
    `Follow-up answer: ${answerText.trim()}`,
  ].filter((entry) => entry.length > 0);

  return chunks.join("\n\n");
}

async function requestFollowUpExtraction(
  inputText: string,
  causalProjectDocumentId: string,
  model?: string,
): Promise<ExtractionClassRecord[]> {
  const backendUrl = `${resolveBackendBaseUrl()}/extract`;

  const response = await fetch(backendUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputText,
      causalProjectDocumentId,
      model: model || resolveExtractModel(),
    }),
    cache: "no-store",
  });

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const detail = await response.text();
    throw new Error(`Extraction backend returned non-JSON response: ${detail}`);
  }

  const payload = (await response.json()) as ExtractProxyResponse;
  if (!response.ok) {
    throw new Error(payload.error || payload.detail || `Extraction backend failed (${String(response.status)}).`);
  }

  return normalizeExtractRecords(payload.records);
}

export async function POST(request: Request) {
  let payload: FollowUpSubmitRequest;
  try {
    payload = (await request.json()) as FollowUpSubmitRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const experimentItemId = (payload.experimentItemId || "").trim();
  const answers = Array.isArray(payload.answers) ? payload.answers : [];

  if (!experimentItemId) {
    return NextResponse.json({ error: "experimentItemId is required." }, { status: 400 });
  }

  const answeredItems = answers
    .map((item) => ({
      questionId: (item.questionId || "").trim(),
      questionText: (item.questionText || "").trim(),
      sourceText: (item.sourceText || "").trim(),
      answerText: (item.answerText || "").trim(),
      answeredBy: (item.answeredBy || "").trim() || "user",
    }))
    .filter((item) => item.questionId && item.questionText && item.answerText);

  if (answeredItems.length === 0) {
    return NextResponse.json({ error: "At least one answered question is required." }, { status: 400 });
  }

  try {
    const extractionPayload = await Promise.all(
      answeredItems.map(async (item) => {
        const joinedText = buildFollowUpExtractText(item.questionText, item.answerText, item.sourceText);
        const derivedExtraction = await requestFollowUpExtraction(joinedText, experimentItemId, payload.model);
        return {
          questionId: item.questionId,
          answerText: item.answerText,
          answeredBy: item.answeredBy,
          derivedExtraction,
        };
      }),
    );

    const result = saveFollowUpAnswers({
      experimentItemId,
      answers: extractionPayload,
    });

    return NextResponse.json({
      savedAnswers: result.savedAnswers,
      extractedFromFollowUp: extractionPayload.length,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown follow-up submit error.";
    return NextResponse.json({ error: "Failed to extract and save follow-up answers.", detail }, { status: 502 });
  }
}
