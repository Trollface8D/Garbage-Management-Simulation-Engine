import { NextResponse } from "next/server";
import {
  getCausalArtifactsForItem,
  listFollowUpRecordsForExperimentItem,
  saveFollowUpAnswers,
  type FollowUpRecord,
} from "@/lib/db";

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

type FollowUpSubmitResponse = {
  savedAnswers: number;
  followUpRecords: FollowUpRecord[];
  rawExtraction: Array<{
    chunk_label: string;
    classes: Array<{
      pattern_type: string;
      sentence_type: string;
      marked_type: string;
      explicit_type: string;
      marker: string;
      source_text: string;
      extracted: Array<{ head: string; relationship: string; tail: string; detail: string }>;
    }>;
  }>;
};

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
    const result = saveFollowUpAnswers({
      experimentItemId,
      answers: answeredItems.map((item) => ({
        questionId: item.questionId,
        answerText: item.answerText,
        answeredBy: item.answeredBy,
      })),
    });

    const updatedArtifacts = getCausalArtifactsForItem(experimentItemId);
    const updatedFollowUpRecords = listFollowUpRecordsForExperimentItem(experimentItemId);

    const responseBody: FollowUpSubmitResponse = {
      savedAnswers: result.savedAnswers,
      followUpRecords: updatedFollowUpRecords,
      rawExtraction: updatedArtifacts.raw_extraction,
    };

    return NextResponse.json(responseBody);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown follow-up submit error.";
    return NextResponse.json({ error: "Failed to save follow-up answers.", detail }, { status: 502 });
  }
}
