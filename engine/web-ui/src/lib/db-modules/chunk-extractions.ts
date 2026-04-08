import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import drizzleDb from "./drizzle";
import { causal, extractionClasses, textChunks } from "./schema";

export type ExtractedRelationRecord = {
  head: string;
  relationship: string;
  tail: string;
  detail: string | null;
};

export type ExtractionClassRecord = {
  pattern_type: string;
  sentence_type: string;
  marked_type: string;
  explicit_type: string;
  marker: string;
  source_text: string;
  extracted: ExtractedRelationRecord[];
};

export type ChunkExtractionRecord = {
  chunkId: string;
  chunkIndex: number;
  classes: ExtractionClassRecord[];
};

type JoinedRow = {
  chunkId: string;
  chunkIndex: number;
  extractionClassId: string;
  createdAt: string;
  patternType: string | null;
  sentenceType: string | null;
  markedType: string | null;
  explicitType: string | null;
  marker: string | null;
  sourceText: string;
  head: string | null;
  relationship: string | null;
  tail: string | null;
  detail: string | null;
};

export function listLatestChunkExtractionsForExperimentItem(experimentItemId: string): ChunkExtractionRecord[] {
  const trimmedItemId = experimentItemId.trim();
  if (!trimmedItemId) {
    return [];
  }

  const rows = drizzleDb
    .select({
      chunkId: textChunks.id,
      chunkIndex: textChunks.chunkIndex,
      extractionClassId: extractionClasses.id,
      createdAt: extractionClasses.createdAt,
      patternType: extractionClasses.patternType,
      sentenceType: extractionClasses.sentenceType,
      markedType: extractionClasses.markedType,
      explicitType: extractionClasses.explicitType,
      marker: extractionClasses.marker,
      sourceText: extractionClasses.sourceText,
      head: causal.head,
      relationship: causal.relationship,
      tail: causal.tail,
      detail: causal.detail,
    })
    .from(extractionClasses)
    .innerJoin(textChunks, eq(extractionClasses.chunkId, textChunks.id))
    .leftJoin(causal, eq(causal.extractionClassId, extractionClasses.id))
    .where(
      and(
        eq(extractionClasses.causalProjectDocumentId, trimmedItemId),
        isNotNull(extractionClasses.chunkId),
      ),
    )
    .orderBy(asc(textChunks.chunkIndex), desc(extractionClasses.createdAt), asc(extractionClasses.id))
    .all() as JoinedRow[];

  const latestByChunk = new Map<string, string>();
  for (const row of rows) {
    if (!latestByChunk.has(row.chunkId)) {
      latestByChunk.set(row.chunkId, row.createdAt);
    }
  }

  const chunkOrder = new Map<string, number>();
  const classMaps = new Map<string, Map<string, ExtractionClassRecord>>();

  for (const row of rows) {
    if (latestByChunk.get(row.chunkId) !== row.createdAt) {
      continue;
    }

    chunkOrder.set(row.chunkId, row.chunkIndex);
    if (!classMaps.has(row.chunkId)) {
      classMaps.set(row.chunkId, new Map<string, ExtractionClassRecord>());
    }

    const classesById = classMaps.get(row.chunkId)!;
    if (!classesById.has(row.extractionClassId)) {
      classesById.set(row.extractionClassId, {
        pattern_type: row.patternType ?? "",
        sentence_type: row.sentenceType ?? "",
        marked_type: row.markedType ?? "",
        explicit_type: row.explicitType ?? "",
        marker: row.marker ?? "",
        source_text: row.sourceText,
        extracted: [],
      });
    }

    if (row.head && row.relationship && row.tail) {
      classesById.get(row.extractionClassId)!.extracted.push({
        head: row.head,
        relationship: row.relationship,
        tail: row.tail,
        detail: row.detail,
      });
    }
  }

  return Array.from(classMaps.entries())
    .map(([chunkId, classesById]) => ({
      chunkId,
      chunkIndex: chunkOrder.get(chunkId) ?? 0,
      classes: Array.from(classesById.values()),
    }))
    .sort((a, b) => a.chunkIndex - b.chunkIndex);
}