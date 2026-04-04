import { and, desc, eq } from "drizzle-orm";
import drizzleDb from "./drizzle";
import { causalProjectDocuments, componentProjectLinks, inputDocuments } from "./schema";
import type { CausalSourceItem, InputMode, InputDocumentRow } from "./types";

function inferInputMode(tags: string[]): "text" | "file" {
  if (tags.includes("uploaded")) {
    return "file";
  }

  return "text";
}

function listDocumentProjectIds(documentId: string): string[] {
  const rows = drizzleDb
    .select({ projectId: componentProjectLinks.projectId })
    .from(causalProjectDocuments)
    .innerJoin(componentProjectLinks, eq(causalProjectDocuments.componentId, componentProjectLinks.componentId))
    .where(eq(causalProjectDocuments.id, documentId))
    .all();

  return Array.from(new Set(rows.map((row) => row.projectId).filter(Boolean)));
}

function getLatestInputDocument(documentId: string): {
  fileName: string;
  sourceType: "text" | "audio";
  textContent: string;
} {
  const latest = drizzleDb
    .select({
      originalFileName: inputDocuments.originalFileName,
      sourceType: inputDocuments.sourceType,
      rawText: inputDocuments.rawText,
      transcriptText: inputDocuments.transcriptText,
    })
    .from(inputDocuments)
    .where(eq(inputDocuments.causalProjectDocumentId, documentId))
    .orderBy(desc(inputDocuments.uploadedAt))
    .limit(1)
    .get();

  return {
    fileName: latest?.originalFileName ?? "untitled.txt",
    sourceType: (latest?.sourceType as "text" | "audio" | undefined) ?? "text",
    textContent: latest?.rawText ?? latest?.transcriptText ?? "",
  };
}

function toCausalSourceItem(row: {
  id: string;
  componentId: string;
  status: "raw_text" | "chunked" | "extracted";
  createdAt: string;
  updatedAt: string;
  projectId: string;
}): CausalSourceItem {
  const latestInput = getLatestInputDocument(row.id);

  return {
    id: row.id,
    projectId: row.projectId,
    componentId: row.componentId,
    label: latestInput.fileName,
    fileName: latestInput.fileName,
    sourceType: latestInput.sourceType,
    status: row.status,
    tags: [],
    textContent: latestInput.textContent,
    hasOriginalFile: Boolean(row.storage_path_or_blob),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listCausalSourceItems(projectId: string, componentId?: string): CausalSourceItem[] {
  if (!projectId.trim()) {
    return [];
  }

  const filters = [eq(componentProjectLinks.projectId, projectId.trim())];
  if (componentId?.trim()) {
    filters.push(eq(causalProjectDocuments.componentId, componentId.trim()));
  }

  const rows = drizzleDb
    .select({
      id: causalProjectDocuments.id,
      componentId: causalProjectDocuments.componentId,
      status: causalProjectDocuments.status,
      createdAt: causalProjectDocuments.createdAt,
      updatedAt: causalProjectDocuments.updatedAt,
      projectId: componentProjectLinks.projectId,
    })
    .from(causalProjectDocuments)
    .innerJoin(componentProjectLinks, eq(causalProjectDocuments.componentId, componentProjectLinks.componentId))
    .where(and(...filters))
    .orderBy(desc(causalProjectDocuments.createdAt))
    .all();

  const deduped = new Map<string, CausalSourceItem>();
  for (const row of rows) {
    if (!deduped.has(row.id)) {
      deduped.set(
        row.id,
        toCausalSourceItem({
          id: row.id,
          componentId: row.componentId,
          status: row.status as "raw_text" | "chunked" | "extracted",
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          projectId: row.projectId,
        }),
      );
    }
  }

  return Array.from(deduped.values());
}

export function getCausalSourceItem(itemId: string): CausalSourceItem | null {
  const trimmed = itemId.trim();
  if (!trimmed) {
    return null;
  }

  const row = drizzleDb
    .select({
      id: causalProjectDocuments.id,
      componentId: causalProjectDocuments.componentId,
      status: causalProjectDocuments.status,
      createdAt: causalProjectDocuments.createdAt,
      updatedAt: causalProjectDocuments.updatedAt,
    })
    .from(causalProjectDocuments)
    .where(eq(causalProjectDocuments.id, trimmed))
    .get();

  if (!row) {
    return null;
  }

  const projectIds = listDocumentProjectIds(trimmed);
  const projectId = projectIds[0] ?? "";

  return toCausalSourceItem({
    id: row.id,
    componentId: row.componentId,
    status: row.status as "raw_text" | "chunked" | "extracted",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    projectId,
  });
}

type UpsertCausalSourceItemInput = Omit<CausalSourceItem, "createdAt" | "updatedAt"> & {
  inputMode?: InputMode;
  storagePathOrBlob?: string | null;
  transcriptText?: string | null;
};

export function upsertCausalSourceItem(item: UpsertCausalSourceItemInput): CausalSourceItem {
  const now = new Date().toISOString();
  const inputDocumentId = `${item.id}:input-primary`;
  const rawText = item.sourceType === "audio" ? null : item.textContent;
  const transcriptText = item.transcriptText ?? (item.sourceType === "audio" ? item.textContent : null);

  const runInTransaction = drizzleDb.transaction((tx) => {
    tx.insert(causalProjectDocuments)
      .values({
        id: item.id,
        componentId: item.componentId,
        status: item.status,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: causalProjectDocuments.id,
        set: {
          componentId: item.componentId,
          status: item.status,
          updatedAt: now,
        },
      })
      .run();

    tx.insert(componentProjectLinks)
      .values({
        id: `${item.componentId}:${item.projectId}:PRIMARY`,
        componentId: item.componentId,
        projectId: item.projectId,
        role: "PRIMARY",
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();

    tx.insert(inputDocuments)
      .values({
        id: inputDocumentId,
        causalProjectDocumentId: item.id,
        inputMode: inferInputMode(item.tags),
        sourceType: item.sourceType,
        originalFileName: item.fileName,
        storagePath: null,
        rawText: item.textContent,
        transcriptText: null,
        uploadedAt: now,
      })
      .onConflictDoUpdate({
        target: inputDocuments.id,
        set: {
          causalProjectDocumentId: item.id,
          inputMode: inferInputMode(item.tags),
          sourceType: item.sourceType,
          originalFileName: item.fileName,
          rawText: item.textContent,
          transcriptText: null,
          uploadedAt: now,
        },
      })
      .run();

    const saved = getCausalSourceItem(item.id);
    if (!saved) {
      throw new Error("Failed to save causal source item.");
    }
    return saved;
  });

  return runInTransaction;
}

export function getLatestInputDocumentForItem(itemId: string): InputDocumentRow | null {
  const trimmed = itemId.trim();
  if (!trimmed) {
    return null;
  }

  const row = db
    .prepare(
      `SELECT
         id,
         experiment_item_id,
         input_mode,
         source_type,
         original_file_name,
         storage_path_or_blob,
         raw_text,
         transcript_text,
         uploaded_at
       FROM input_documents
       WHERE experiment_item_id = ?
       ORDER BY uploaded_at DESC
       LIMIT 1`,
    )
    .get(trimmed) as InputDocumentRow | undefined;

  return row ?? null;
}

export function deleteCausalSourceItem(itemId: string): boolean {
  const result = drizzleDb
    .delete(causalProjectDocuments)
    .where(eq(causalProjectDocuments.id, itemId.trim()))
    .run();

  return (result.changes ?? 0) > 0;
}
