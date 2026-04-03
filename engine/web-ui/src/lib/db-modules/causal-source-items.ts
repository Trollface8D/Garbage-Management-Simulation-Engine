
import db from "./connection";
import type { CausalSourceItem, CausalSourceItemRow, InputMode, InputDocumentRow } from "./types";

function toCausalSourceItem(row: CausalSourceItemRow): CausalSourceItem {
  const parsedTags = (() => {
    try {
      const parsed = JSON.parse(row.tags_json) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((tag): tag is string => typeof tag === "string");
      }
    } catch {
      // Ignore malformed legacy values and fall back to empty tags.
    }
    return [];
  })();

  return {
    id: row.id,
    projectId: row.project_id,
    componentId: row.component_id,
    label: row.label,
    fileName: row.file_name,
    sourceType: row.source_type,
    status: row.status,
    tags: parsedTags,
    textContent: row.text_content,
    hasOriginalFile: Boolean(row.storage_path_or_blob),
    createdAt: row.created_at,
    updatedAt: row.created_at,
  };
}

function inferInputMode(tags: string[]): "upload" | "manual_text" | "other" {
  if (tags.includes("uploaded")) {
    return "upload";
  }

  if (tags.includes("manual note")) {
    return "manual_text";
  }

  return "other";
}

export function listCausalSourceItems(projectId: string, componentId?: string): CausalSourceItem[] {
  if (!projectId.trim()) {
    return [];
  }

  const hasComponent = Boolean(componentId?.trim());
  const rows = hasComponent
    ? (db
        .prepare(
          `SELECT
             item.id,
             item.project_id,
             item.component_id,
             item.label,
             item.file_name,
             item.source_type,
             item.status,
             item.tags_json,
             doc.storage_path_or_blob,
             COALESCE(doc.raw_text, doc.transcript_text, '') AS text_content,
             item.created_at
           FROM experiment_items item
           LEFT JOIN input_documents doc
             ON doc.id = (
               SELECT id
               FROM input_documents
               WHERE experiment_item_id = item.id
               ORDER BY uploaded_at DESC
               LIMIT 1
             )
           WHERE item.project_id = ? AND item.component_id = ?
           ORDER BY item.created_at DESC`,
        )
        .all(projectId, componentId?.trim()) as CausalSourceItemRow[])
    : (db
        .prepare(
          `SELECT
             item.id,
             item.project_id,
             item.component_id,
             item.label,
             item.file_name,
             item.source_type,
             item.status,
             item.tags_json,
             doc.storage_path_or_blob,
             COALESCE(doc.raw_text, doc.transcript_text, '') AS text_content,
             item.created_at
           FROM experiment_items item
           LEFT JOIN input_documents doc
             ON doc.id = (
               SELECT id
               FROM input_documents
               WHERE experiment_item_id = item.id
               ORDER BY uploaded_at DESC
               LIMIT 1
             )
           WHERE item.project_id = ?
           ORDER BY item.created_at DESC`,
        )
        .all(projectId) as CausalSourceItemRow[]);

  return rows.map(toCausalSourceItem);
}

export function getCausalSourceItem(itemId: string): CausalSourceItem | null {
  const trimmed = itemId.trim();
  if (!trimmed) {
    return null;
  }

  const row = db
    .prepare(
      `SELECT
         item.id,
         item.project_id,
         item.component_id,
         item.label,
         item.file_name,
         item.source_type,
         item.status,
         item.tags_json,
         doc.storage_path_or_blob,
         COALESCE(doc.raw_text, doc.transcript_text, '') AS text_content,
         item.created_at
       FROM experiment_items item
       LEFT JOIN input_documents doc
         ON doc.id = (
           SELECT id
           FROM input_documents
           WHERE experiment_item_id = item.id
           ORDER BY uploaded_at DESC
           LIMIT 1
         )
       WHERE item.id = ?`,
    )
    .get(trimmed) as CausalSourceItemRow | undefined;

  if (!row) {
    return null;
  }

  return toCausalSourceItem(row);
}

type UpsertCausalSourceItemInput = Omit<CausalSourceItem, "createdAt" | "updatedAt"> & {
  inputMode?: InputMode;
  storagePathOrBlob?: string | null;
  transcriptText?: string | null;
};

export function upsertCausalSourceItem(item: UpsertCausalSourceItemInput): CausalSourceItem {
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(item.tags);
  const inputDocumentId = `${item.id}:input-primary`;
  const rawText = item.sourceType === "audio" ? null : item.textContent;
  const transcriptText = item.transcriptText ?? (item.sourceType === "audio" ? item.textContent : null);

  db.prepare(
    `INSERT INTO experiment_items (id, project_id, component_id, label, file_name, source_type, status, tags_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id,
       component_id = excluded.component_id,
       label = excluded.label,
       file_name = excluded.file_name,
       source_type = excluded.source_type,
       status = excluded.status,
       tags_json = excluded.tags_json`,
  ).run(
    item.id,
    item.projectId,
    item.componentId,
    item.label,
    item.fileName,
    item.sourceType,
    item.status,
    tagsJson,
    now,
  );

  db.prepare(
    `INSERT INTO input_documents (
       id,
       experiment_item_id,
       input_mode,
       source_type,
       original_file_name,
       storage_path_or_blob,
       raw_text,
       transcript_text,
       uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       experiment_item_id = excluded.experiment_item_id,
       input_mode = excluded.input_mode,
       source_type = excluded.source_type,
       original_file_name = excluded.original_file_name,
       storage_path_or_blob = excluded.storage_path_or_blob,
       raw_text = excluded.raw_text,
       transcript_text = excluded.transcript_text,
       uploaded_at = excluded.uploaded_at`,
  ).run(
    inputDocumentId,
    item.id,
    item.inputMode ?? inferInputMode(item.tags),
    item.sourceType,
    item.fileName,
    item.storagePathOrBlob ?? null,
    rawText,
    transcriptText,
    now,
  );

  const saved = getCausalSourceItem(item.id);
  if (!saved) {
    throw new Error("Failed to save causal source item.");
  }
  return saved;
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
  const result = db
    .prepare("DELETE FROM experiment_items WHERE id = ?")
    .run(itemId.trim());

  return result.changes > 0;
}
