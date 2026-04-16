import { randomUUID } from "crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import drizzleDb from "./drizzle";
import {
  causal,
  causalProjectDocuments,
  extractionClasses,
  followUpAnswers,
  followUpQuestions,
  followUps,
  textChunks,
} from "./schema";

export type ExtractedTriple = {
  head: string;
  relationship: string;
  tail: string;
  detail: string;
};

export type ExtractionClassRecord = {
  pattern_type: string;
  sentence_type: string;
  marked_type: string;
  explicit_type: string;
  marker: string;
  source_text: string;
  extracted: ExtractedTriple[];
};

export type ExtractionPayloadRecord = {
  chunk_label: string;
  classes: ExtractionClassRecord[];
};

export type FollowUpExportQuestion = {
  question_text: string;
  generated_by: string;
  generated_at: string;
  is_filtered_in: boolean;
  answer_text?: string;
  answered_by?: string;
  answered_at?: string;
  derived_causal?: ExtractionClassRecord[];
};

export type FollowUpExportRecord = {
  source_text: string;
  sentence_type: string;
  causal_ref?: {
    head: string;
    relationship: string;
    tail: string;
    detail: string;
  };
  questions: FollowUpExportQuestion[];
};

export type CausalArtifactsPayload = {
  raw_extraction: ExtractionPayloadRecord[];
  follow_up: FollowUpExportRecord[];
};

export type SaveCausalArtifactsInput = {
  experimentItemId: string;
  rawExtraction: ExtractionPayloadRecord[];
  followUp?: FollowUpExportRecord[];
};

export type SaveCausalArtifactsResult = {
  savedClasses: number;
  savedCausal: number;
  savedFollowUps: number;
};

export type FollowUpQuestionRecord = {
  questionId: string;
  questionText: string;
  generatedBy: string;
  generatedAt: string;
  isFilteredIn: boolean;
  answerText?: string;
  answeredBy?: string;
  answeredAt?: string;
  derivedCausal?: ExtractionClassRecord[];
};

export type FollowUpRecord = {
  followUpId: string;
  sourceText: string;
  sentenceType: string;
  causalId: string;
  questions: FollowUpQuestionRecord[];
};

export type SaveFollowUpQuestionsInput = {
  experimentItemId: string;
  records: Array<{
    sourceText: string;
    sentenceType?: string;
    generatedQuestions: string[];
    causalRef?: {
      head: string;
      relationship: string;
      tail: string;
      detail: string;
    };
    generatedBy?: string;
  }>;
};

export type SaveFollowUpQuestionsResult = {
  savedFollowUps: number;
  savedQuestions: number;
};

export type SaveFollowUpAnswersInput = {
  experimentItemId: string;
  answers: Array<{
    questionId: string;
    answerText: string;
    answeredBy?: string;
    derivedExtraction?: ExtractionClassRecord[];
  }>;
};

export type SaveFollowUpAnswersResult = {
  savedAnswers: number;
};

function parseChunkIndex(chunkLabel: string): number | null {
  const match = /chunk\s+(\d+)/i.exec(chunkLabel);
  if (!match) {
    return null;
  }

  const chunkNumber = Number(match[1]);
  if (!Number.isInteger(chunkNumber) || chunkNumber <= 0) {
    return null;
  }

  return chunkNumber - 1;
}

function normalizeDerivedExtraction(raw: unknown): ExtractionClassRecord[] {
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
    const extracted: ExtractedTriple[] = [];

    for (const relation of extractedRaw) {
      if (!relation || typeof relation !== "object") {
        continue;
      }
      const relationRow = relation as Record<string, unknown>;
      extracted.push({
        head: typeof relationRow.head === "string" ? relationRow.head : "",
        relationship: typeof relationRow.relationship === "string" ? relationRow.relationship : "",
        tail: typeof relationRow.tail === "string" ? relationRow.tail : "",
        detail: typeof relationRow.detail === "string" ? relationRow.detail : "",
      });
    }

    normalized.push({
      pattern_type: typeof row.pattern_type === "string" ? row.pattern_type : "",
      sentence_type: typeof row.sentence_type === "string" ? row.sentence_type : "",
      marked_type: typeof row.marked_type === "string" ? row.marked_type : "",
      explicit_type: typeof row.explicit_type === "string" ? row.explicit_type : "",
      marker: typeof row.marker === "string" ? row.marker : "",
      source_text: typeof row.source_text === "string" ? row.source_text : "",
      extracted,
    });
  }

  return normalized;
}

function parseDerivedExtractionJson(raw: string | null): ExtractionClassRecord[] | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeDerivedExtraction(parsed);
  } catch {
    return undefined;
  }
}

export function saveCausalArtifacts(input: SaveCausalArtifactsInput): SaveCausalArtifactsResult {
  const experimentItemId = input.experimentItemId.trim();
  if (!experimentItemId) {
    throw new Error("experimentItemId is required.");
  }

  const rawExtraction = input.rawExtraction ?? [];
  const followUp = input.followUp ?? [];

  return drizzleDb.transaction((tx) => {
    const document = tx
      .select({ id: causalProjectDocuments.id })
      .from(causalProjectDocuments)
      .where(eq(causalProjectDocuments.id, experimentItemId))
      .get();

    if (!document) {
      throw new Error("Causal project document not found.");
    }

    const now = new Date().toISOString();

    tx.delete(followUps).where(eq(followUps.causalProjectDocumentId, experimentItemId)).run();
    tx.delete(causal).where(eq(causal.causalProjectDocumentId, experimentItemId)).run();
    tx.delete(extractionClasses).where(eq(extractionClasses.causalProjectDocumentId, experimentItemId)).run();

    const chunkRows = tx
      .select({ id: textChunks.id, chunkIndex: textChunks.chunkIndex })
      .from(textChunks)
      .where(eq(textChunks.causalProjectDocumentId, experimentItemId))
      .all();
    const chunkByIndex = new Map<number, string>();
    for (const row of chunkRows) {
      chunkByIndex.set(row.chunkIndex, row.id);
    }

    const causalIndex = new Map<string, string>();
    let savedClasses = 0;
    let savedCausal = 0;

    for (const chunkPayload of rawExtraction) {
      const chunkIndex = parseChunkIndex(chunkPayload.chunk_label);
      const chunkId = chunkIndex === null ? null : (chunkByIndex.get(chunkIndex) ?? null);

      for (const classItem of chunkPayload.classes ?? []) {
        const extractionClassId = randomUUID();
        tx.insert(extractionClasses)
          .values({
            id: extractionClassId,
            causalProjectDocumentId: experimentItemId,
            chunkId,
            patternType: classItem.pattern_type || null,
            sentenceType: classItem.sentence_type || null,
            markedType: classItem.marked_type || null,
            explicitType: classItem.explicit_type || null,
            marker: classItem.marker || null,
            sourceText: classItem.source_text || "",
            createdAt: now,
          })
          .run();
        savedClasses += 1;

        for (const relation of classItem.extracted ?? []) {
          const causalId = randomUUID();
          tx.insert(causal)
            .values({
              id: causalId,
              causalProjectDocumentId: experimentItemId,
              extractionClassId,
              head: relation.head || "",
              relationship: relation.relationship || "",
              tail: relation.tail || "",
              detail: relation.detail || null,
              createdAt: now,
            })
            .run();

          const key = [
            relation.head || "",
            relation.relationship || "",
            relation.tail || "",
            relation.detail || "",
          ].join("||");
          causalIndex.set(key, causalId);
          savedCausal += 1;
        }
      }
    }

    let savedFollowUps = 0;
    const fallbackCausal = tx
      .select({ id: causal.id })
      .from(causal)
      .where(eq(causal.causalProjectDocumentId, experimentItemId))
      .limit(1)
      .get();

    for (const followUpItem of followUp) {
      const reference = followUpItem.causal_ref;
      const refKey = reference
        ? [reference.head || "", reference.relationship || "", reference.tail || "", reference.detail || ""].join("||")
        : "";
      const causalId = (refKey && causalIndex.get(refKey)) || fallbackCausal?.id;

      if (!causalId) {
        continue;
      }

      const followUpId = randomUUID();
      tx.insert(followUps)
        .values({
          id: followUpId,
          causalProjectDocumentId: experimentItemId,
          causalId,
          sourceText: followUpItem.source_text || "",
          sentenceType: followUpItem.sentence_type || null,
          createdAt: now,
        })
        .run();
      savedFollowUps += 1;

      for (const question of followUpItem.questions ?? []) {
        const questionId = randomUUID();
        tx.insert(followUpQuestions)
          .values({
            id: questionId,
            followUpId,
            questionText: question.question_text || "",
            generatedBy: question.generated_by || "system",
            generatedAt: question.generated_at || now,
            isFilteredIn: question.is_filtered_in ?? true,
          })
          .run();

        if (question.answer_text && question.answer_text.trim()) {
          const derivedExtraction = normalizeDerivedExtraction(question.derived_causal);
          tx.insert(followUpAnswers)
            .values({
              id: randomUUID(),
              questionId,
              answerText: question.answer_text,
              answeredBy: question.answered_by || "user",
              answeredAt: question.answered_at || now,
              derivedCausalJson: derivedExtraction.length > 0 ? JSON.stringify(derivedExtraction) : null,
              derivedCausalUpdatedAt: derivedExtraction.length > 0 ? now : null,
            })
            .run();
        }
      }
    }

    tx.update(causalProjectDocuments)
      .set({
        status: savedCausal > 0 ? "extracted" : "chunked",
        updatedAt: now,
      })
      .where(eq(causalProjectDocuments.id, experimentItemId))
      .run();

    return {
      savedClasses,
      savedCausal,
      savedFollowUps,
    };
  });
}

export function getCausalArtifactsForItem(experimentItemId: string): CausalArtifactsPayload {
  const trimmed = experimentItemId.trim();
  if (!trimmed) {
    return {
      raw_extraction: [],
      follow_up: [],
    };
  }

  const chunkRows = drizzleDb
    .select({ id: textChunks.id, chunkIndex: textChunks.chunkIndex })
    .from(textChunks)
    .where(eq(textChunks.causalProjectDocumentId, trimmed))
    .all();
  const chunkLabelById = new Map<string, string>();
  for (const chunk of chunkRows) {
    chunkLabelById.set(chunk.id, `chunk ${String(chunk.chunkIndex + 1)}`);
  }

  const classRows = drizzleDb
    .select({
      id: extractionClasses.id,
      chunkId: extractionClasses.chunkId,
      patternType: extractionClasses.patternType,
      sentenceType: extractionClasses.sentenceType,
      markedType: extractionClasses.markedType,
      explicitType: extractionClasses.explicitType,
      marker: extractionClasses.marker,
      sourceText: extractionClasses.sourceText,
    })
    .from(extractionClasses)
    .where(eq(extractionClasses.causalProjectDocumentId, trimmed))
    .all();

  const classIds = classRows.map((row) => row.id);
  const causalRows = classIds.length === 0
    ? []
    : drizzleDb
      .select({
        id: causal.id,
        extractionClassId: causal.extractionClassId,
        head: causal.head,
        relationship: causal.relationship,
        tail: causal.tail,
        detail: causal.detail,
      })
      .from(causal)
      .where(and(eq(causal.causalProjectDocumentId, trimmed), inArray(causal.extractionClassId, classIds)))
      .all();

  const causalByClassId = new Map<string, ExtractedTriple[]>();
  const causalById = new Map<string, { head: string; relationship: string; tail: string; detail: string }>();
  for (const row of causalRows) {
    const relation = {
      head: row.head,
      relationship: row.relationship,
      tail: row.tail,
      detail: row.detail ?? "",
    };
    const current = causalByClassId.get(row.extractionClassId) ?? [];
    current.push(relation);
    causalByClassId.set(row.extractionClassId, current);
    causalById.set(row.id, relation);
  }

  const extractionByChunk = new Map<string, ExtractionClassRecord[]>();
  for (const row of classRows) {
    const chunkLabel = (row.chunkId && chunkLabelById.get(row.chunkId)) || "chunk unknown";
    const entry: ExtractionClassRecord = {
      pattern_type: row.patternType ?? "",
      sentence_type: row.sentenceType ?? "",
      marked_type: row.markedType ?? "",
      explicit_type: row.explicitType ?? "",
      marker: row.marker ?? "",
      source_text: row.sourceText,
      extracted: causalByClassId.get(row.id) ?? [],
    };
    const current = extractionByChunk.get(chunkLabel) ?? [];
    current.push(entry);
    extractionByChunk.set(chunkLabel, current);
  }

  const rawExtraction: ExtractionPayloadRecord[] = Array.from(extractionByChunk.entries()).map(([chunkLabel, classes]) => ({
    chunk_label: chunkLabel,
    classes,
  }));

  const followUpRows = drizzleDb
    .select({
      id: followUps.id,
      sourceText: followUps.sourceText,
      sentenceType: followUps.sentenceType,
      causalId: followUps.causalId,
    })
    .from(followUps)
    .where(eq(followUps.causalProjectDocumentId, trimmed))
    .all();

  const followUpIds = followUpRows.map((row) => row.id);
  const questionRows = followUpIds.length === 0
    ? []
    : drizzleDb
      .select({
        id: followUpQuestions.id,
        followUpId: followUpQuestions.followUpId,
        questionText: followUpQuestions.questionText,
        generatedBy: followUpQuestions.generatedBy,
        generatedAt: followUpQuestions.generatedAt,
        isFilteredIn: followUpQuestions.isFilteredIn,
      })
      .from(followUpQuestions)
      .where(inArray(followUpQuestions.followUpId, followUpIds))
      .orderBy(asc(followUpQuestions.generatedAt))
      .all();

  const questionIds = questionRows.map((question) => question.id);
  const answerRows = questionIds.length === 0
    ? []
    : drizzleDb
      .select({
        questionId: followUpAnswers.questionId,
        answerText: followUpAnswers.answerText,
        answeredBy: followUpAnswers.answeredBy,
        answeredAt: followUpAnswers.answeredAt,
        derivedCausalJson: followUpAnswers.derivedCausalJson,
      })
      .from(followUpAnswers)
      .where(inArray(followUpAnswers.questionId, questionIds))
      .all();

  const answerByQuestionId = new Map<
    string,
    {
      answerText: string;
      answeredBy: string;
      answeredAt: string;
      derivedCausal?: ExtractionClassRecord[];
    }
  >();
  for (const answer of answerRows) {
    answerByQuestionId.set(answer.questionId, {
      answerText: answer.answerText,
      answeredBy: answer.answeredBy,
      answeredAt: answer.answeredAt,
      derivedCausal: parseDerivedExtractionJson(answer.derivedCausalJson),
    });
  }

  const questionsByFollowUpId = new Map<string, FollowUpExportQuestion[]>();
  for (const question of questionRows) {
    const answer = answerByQuestionId.get(question.id);
    const current = questionsByFollowUpId.get(question.followUpId) ?? [];
    current.push({
      question_text: question.questionText,
      generated_by: question.generatedBy,
      generated_at: question.generatedAt,
      is_filtered_in: question.isFilteredIn,
      answer_text: answer?.answerText,
      answered_by: answer?.answeredBy,
      answered_at: answer?.answeredAt,
      derived_causal: answer?.derivedCausal,
    });
    questionsByFollowUpId.set(question.followUpId, current);
  }

  const followUp: FollowUpExportRecord[] = followUpRows.map((row) => ({
    source_text: row.sourceText,
    sentence_type: row.sentenceType ?? "",
    causal_ref: causalById.get(row.causalId),
    questions: questionsByFollowUpId.get(row.id) ?? [],
  }));

  return {
    raw_extraction: rawExtraction,
    follow_up: followUp,
  };
}

export function listFollowUpRecordsForExperimentItem(experimentItemId: string): FollowUpRecord[] {
  const trimmed = experimentItemId.trim();
  if (!trimmed) {
    return [];
  }

  const followUpRows = drizzleDb
    .select({
      id: followUps.id,
      sourceText: followUps.sourceText,
      sentenceType: followUps.sentenceType,
      causalId: followUps.causalId,
    })
    .from(followUps)
    .where(eq(followUps.causalProjectDocumentId, trimmed))
    .all();

  const followUpIds = followUpRows.map((row) => row.id);
  const questionRows = followUpIds.length === 0
    ? []
    : drizzleDb
      .select({
        id: followUpQuestions.id,
        followUpId: followUpQuestions.followUpId,
        questionText: followUpQuestions.questionText,
        generatedBy: followUpQuestions.generatedBy,
        generatedAt: followUpQuestions.generatedAt,
        isFilteredIn: followUpQuestions.isFilteredIn,
      })
      .from(followUpQuestions)
      .where(inArray(followUpQuestions.followUpId, followUpIds))
      .orderBy(asc(followUpQuestions.generatedAt))
      .all();

  const questionIds = questionRows.map((row) => row.id);
  const answerRows = questionIds.length === 0
    ? []
    : drizzleDb
      .select({
        questionId: followUpAnswers.questionId,
        answerText: followUpAnswers.answerText,
        answeredBy: followUpAnswers.answeredBy,
        answeredAt: followUpAnswers.answeredAt,
        derivedCausalJson: followUpAnswers.derivedCausalJson,
      })
      .from(followUpAnswers)
      .where(inArray(followUpAnswers.questionId, questionIds))
      .all();

  const answerByQuestionId = new Map<
    string,
    {
      answerText: string;
      answeredBy: string;
      answeredAt: string;
      derivedCausal?: ExtractionClassRecord[];
    }
  >();
  for (const answer of answerRows) {
    answerByQuestionId.set(answer.questionId, {
      answerText: answer.answerText,
      answeredBy: answer.answeredBy,
      answeredAt: answer.answeredAt,
      derivedCausal: parseDerivedExtractionJson(answer.derivedCausalJson),
    });
  }

  const questionsByFollowUpId = new Map<string, FollowUpQuestionRecord[]>();
  for (const question of questionRows) {
    const answer = answerByQuestionId.get(question.id);
    const current = questionsByFollowUpId.get(question.followUpId) ?? [];
    current.push({
      questionId: question.id,
      questionText: question.questionText,
      generatedBy: question.generatedBy,
      generatedAt: question.generatedAt,
      isFilteredIn: question.isFilteredIn,
      answerText: answer?.answerText,
      answeredBy: answer?.answeredBy,
      answeredAt: answer?.answeredAt,
      derivedCausal: answer?.derivedCausal,
    });
    questionsByFollowUpId.set(question.followUpId, current);
  }

  return followUpRows.map((row) => ({
    followUpId: row.id,
    sourceText: row.sourceText,
    sentenceType: row.sentenceType ?? "",
    causalId: row.causalId,
    questions: questionsByFollowUpId.get(row.id) ?? [],
  }));
}

export function saveFollowUpQuestions(input: SaveFollowUpQuestionsInput): SaveFollowUpQuestionsResult {
  const experimentItemId = input.experimentItemId.trim();
  if (!experimentItemId) {
    throw new Error("experimentItemId is required.");
  }

  const records = input.records ?? [];

  return drizzleDb.transaction((tx) => {
    const document = tx
      .select({ id: causalProjectDocuments.id })
      .from(causalProjectDocuments)
      .where(eq(causalProjectDocuments.id, experimentItemId))
      .get();

    if (!document) {
      throw new Error("Causal project document not found.");
    }

    const causalRows = tx
      .select({
        id: causal.id,
        head: causal.head,
        relationship: causal.relationship,
        tail: causal.tail,
        detail: causal.detail,
      })
      .from(causal)
      .where(eq(causal.causalProjectDocumentId, experimentItemId))
      .all();

    const causalByKey = new Map<string, string>();
    for (const row of causalRows) {
      const key = [row.head || "", row.relationship || "", row.tail || "", row.detail || ""].join("||");
      causalByKey.set(key, row.id);
    }
    const fallbackCausalId = causalRows[0]?.id;

    let savedFollowUps = 0;
    let savedQuestions = 0;

    for (const record of records) {
      const sourceText = (record.sourceText || "").trim();
      if (!sourceText) {
        continue;
      }

      tx
        .delete(followUps)
        .where(and(eq(followUps.causalProjectDocumentId, experimentItemId), eq(followUps.sourceText, sourceText)))
        .run();

      const questionTexts = Array.from(
        new Set(
          (record.generatedQuestions ?? [])
            .map((question) => (question || "").trim())
            .filter((question) => question.length > 0),
        ),
      );

      if (questionTexts.length === 0) {
        continue;
      }

      const reference = record.causalRef;
      const referenceKey = reference
        ? [reference.head || "", reference.relationship || "", reference.tail || "", reference.detail || ""].join("||")
        : "";
      const causalId = (referenceKey && causalByKey.get(referenceKey)) || fallbackCausalId;

      if (!causalId) {
        continue;
      }

      const now = new Date().toISOString();
      const followUpId = randomUUID();
      tx
        .insert(followUps)
        .values({
          id: followUpId,
          causalProjectDocumentId: experimentItemId,
          causalId,
          sourceText,
          sentenceType: (record.sentenceType || "").trim() || null,
          createdAt: now,
        })
        .run();
      savedFollowUps += 1;

      const generatedBy = (record.generatedBy || "").trim() || "system";

      for (const questionText of questionTexts) {
        tx
          .insert(followUpQuestions)
          .values({
            id: randomUUID(),
            followUpId,
            questionText,
            generatedBy,
            generatedAt: now,
            isFilteredIn: true,
          })
          .run();
        savedQuestions += 1;
      }
    }

    tx
      .update(causalProjectDocuments)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(causalProjectDocuments.id, experimentItemId))
      .run();

    return { savedFollowUps, savedQuestions };
  });
}

export function saveFollowUpAnswers(input: SaveFollowUpAnswersInput): SaveFollowUpAnswersResult {
  const experimentItemId = input.experimentItemId.trim();
  if (!experimentItemId) {
    throw new Error("experimentItemId is required.");
  }

  const answers = input.answers ?? [];

  return drizzleDb.transaction((tx) => {
    const document = tx
      .select({ id: causalProjectDocuments.id })
      .from(causalProjectDocuments)
      .where(eq(causalProjectDocuments.id, experimentItemId))
      .get();

    if (!document) {
      throw new Error("Causal project document not found.");
    }

    const questionRows = tx
      .select({ questionId: followUpQuestions.id })
      .from(followUpQuestions)
      .innerJoin(followUps, eq(followUpQuestions.followUpId, followUps.id))
      .where(eq(followUps.causalProjectDocumentId, experimentItemId))
      .all();
    const allowedQuestionIds = new Set(questionRows.map((row) => row.questionId));

    let savedAnswers = 0;

    for (const entry of answers) {
      const questionId = (entry.questionId || "").trim();
      const answerText = (entry.answerText || "").trim();
      const hasDerivedExtraction = Object.prototype.hasOwnProperty.call(entry, "derivedExtraction");
      const normalizedDerivedExtraction = hasDerivedExtraction
        ? normalizeDerivedExtraction(entry.derivedExtraction)
        : undefined;

      if (!questionId || !allowedQuestionIds.has(questionId)) {
        continue;
      }

      const now = new Date().toISOString();
      const answeredBy = (entry.answeredBy || "").trim() || "user";

      const existing = tx
        .select({ id: followUpAnswers.id })
        .from(followUpAnswers)
        .where(eq(followUpAnswers.questionId, questionId))
        .limit(1)
        .get();

      if (!answerText) {
        if (existing) {
          tx
            .delete(followUpAnswers)
            .where(eq(followUpAnswers.id, existing.id))
            .run();
          savedAnswers += 1;
        }
        continue;
      }

      if (existing) {
        const updatePayload: {
          answerText: string;
          answeredBy: string;
          answeredAt: string;
          derivedCausalJson?: string;
          derivedCausalUpdatedAt?: string;
        } = {
          answerText,
          answeredBy,
          answeredAt: now,
        };

        if (hasDerivedExtraction) {
          updatePayload.derivedCausalJson = JSON.stringify(normalizedDerivedExtraction ?? []);
          updatePayload.derivedCausalUpdatedAt = now;
        }

        tx
          .update(followUpAnswers)
          .set(updatePayload)
          .where(eq(followUpAnswers.id, existing.id))
          .run();
      } else {
        const insertPayload: {
          id: string;
          questionId: string;
          answerText: string;
          answeredBy: string;
          answeredAt: string;
          derivedCausalJson?: string;
          derivedCausalUpdatedAt?: string;
        } = {
          id: randomUUID(),
          questionId,
          answerText,
          answeredBy,
          answeredAt: now,
        };

        if (hasDerivedExtraction) {
          insertPayload.derivedCausalJson = JSON.stringify(normalizedDerivedExtraction ?? []);
          insertPayload.derivedCausalUpdatedAt = now;
        }

        tx
          .insert(followUpAnswers)
          .values(insertPayload)
          .run();
      }

      savedAnswers += 1;
    }

    tx
      .update(causalProjectDocuments)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(causalProjectDocuments.id, experimentItemId))
      .run();

    return { savedAnswers };
  });
}
