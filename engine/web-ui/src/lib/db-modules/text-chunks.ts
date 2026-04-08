import { randomUUID } from "crypto";
import { asc, desc, eq } from "drizzle-orm";
import drizzleDb from "./drizzle";
import { causalProjectDocuments, inputDocuments, textChunks } from "./schema";
import type { SaveTextChunksInput, SaveTextChunksResult } from "./types";

export type TextChunkRecord = {
  id: string;
  chunkIndex: number;
  text: string;
};

function buildChunkOffsets(chunks: string[]): Array<{ text: string; start: number; end: number }> {
  let cursor = 0;

  return chunks.map((rawText) => {
    const text = rawText.trim();
    const start = cursor;
    const end = start + text.length;
    cursor = end + 1;

    return { text, start, end };
  });
}

export function listLatestTextChunksForExperimentItem(experimentItemId: string): string[] {
  const trimmedItemId = experimentItemId.trim();
  if (!trimmedItemId) {
    return [];
  }

  const rows = drizzleDb
    .select({ text: textChunks.text })
    .from(textChunks)
    .where(eq(textChunks.causalProjectDocumentId, trimmedItemId))
    .orderBy(asc(textChunks.chunkIndex))
    .all();

  return rows.map((row) => row.text).filter((text) => text.trim().length > 0);
}

export function listLatestTextChunkRecordsForExperimentItem(experimentItemId: string): TextChunkRecord[] {
  const trimmedItemId = experimentItemId.trim();
  if (!trimmedItemId) {
    return [];
  }

  const rows = drizzleDb
    .select({
      id: textChunks.id,
      chunkIndex: textChunks.chunkIndex,
      text: textChunks.text,
    })
    .from(textChunks)
    .where(eq(textChunks.causalProjectDocumentId, trimmedItemId))
    .orderBy(asc(textChunks.chunkIndex))
    .all();

  return rows
    .map((row) => ({
      id: row.id,
      chunkIndex: row.chunkIndex,
      text: row.text,
    }))
    .filter((row) => row.text.trim().length > 0);
}

export function saveTextChunks(input: SaveTextChunksInput): SaveTextChunksResult {
  const experimentItemId = input.experimentItemId.trim();
  const chunks = input.chunks.map((chunk) => chunk.trim()).filter(Boolean);

  if (!experimentItemId) {
    throw new Error("experimentItemId is required.");
  }

  return drizzleDb.transaction((tx) => {
    const document = tx
      .select({ id: causalProjectDocuments.id, componentId: causalProjectDocuments.componentId })
      .from(causalProjectDocuments)
      .where(eq(causalProjectDocuments.id, experimentItemId))
      .get();

    if (!document) {
      throw new Error("Causal project document not found.");
    }

    const now = new Date().toISOString();

    const latestInputDocument = tx
      .select({ id: inputDocuments.id })
      .from(inputDocuments)
      .where(eq(inputDocuments.causalProjectDocumentId, experimentItemId))
      .orderBy(desc(inputDocuments.uploadedAt))
      .limit(1)
      .get();

    if (!latestInputDocument) {
      tx.insert(inputDocuments)
        .values({
          id: `${experimentItemId}:input-primary`,
          causalProjectDocumentId: experimentItemId,
          inputMode: "text",
          sourceType: "text",
          originalFileName: "manual-input.txt",
          storagePath: null,
          rawText: "",
          transcriptText: null,
          uploadedAt: now,
        })
        .run();
    }

    tx.delete(textChunks).where(eq(textChunks.causalProjectDocumentId, experimentItemId)).run();

    const chunkRows = buildChunkOffsets(chunks);
    for (let index = 0; index < chunkRows.length; index += 1) {
      const chunk = chunkRows[index];
      tx.insert(textChunks)
        .values({
          id: randomUUID(),
          causalProjectDocumentId: experimentItemId,
          chunkIndex: index,
          text: chunk.text,
          startOffset: chunk.start,
          endOffset: chunk.end,
          createdAt: now,
        })
        .run();
    }

    tx.update(causalProjectDocuments)
      .set({
        status: chunkRows.length > 0 ? "chunked" : "raw_text",
        updatedAt: now,
      })
      .where(eq(causalProjectDocuments.id, experimentItemId))
      .run();

    return {
      pipelineJobId: randomUUID(),
      savedChunks: chunkRows.length,
    };
  });
}
