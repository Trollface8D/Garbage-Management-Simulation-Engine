import { randomUUID } from "crypto";
import db from "./connection";
import type { SaveTextChunksInput, SaveTextChunksResult } from "./types";

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

  const latestJob = db
    .prepare(
      `SELECT job.id
       FROM pipeline_jobs job
       INNER JOIN input_documents doc ON doc.id = job.input_document_id
       WHERE doc.experiment_item_id = ?
       ORDER BY job.started_at DESC
       LIMIT 1`,
    )
    .get(trimmedItemId) as { id: string } | undefined;

  if (!latestJob) {
    return [];
  }

  const rows = db
    .prepare(
      `SELECT text
       FROM text_chunks
       WHERE pipeline_job_id = ?
       ORDER BY chunk_index ASC`,
    )
    .all(latestJob.id) as Array<{ text: string }>;

  return rows.map((row) => row.text).filter((text) => text.trim().length > 0);
}

export function saveTextChunks(input: SaveTextChunksInput): SaveTextChunksResult {
  const experimentItemId = input.experimentItemId.trim();
  const projectId = input.projectId.trim();
  const componentId = input.componentId.trim();
  const chunks = input.chunks.map((chunk) => chunk.trim()).filter(Boolean);

  if (!experimentItemId || !projectId || !componentId) {
    throw new Error("experimentItemId, projectId, and componentId are required.");
  }

  const runInTransaction = db.transaction((payload: SaveTextChunksInput): SaveTextChunksResult => {
    const item = db
      .prepare(
        `SELECT id, project_id, component_id, source_type, file_name
         FROM experiment_items
         WHERE id = ?`,
      )
      .get(payload.experimentItemId) as
      | {
          id: string;
          project_id: string;
          component_id: string;
          source_type: "text" | "audio";
          file_name: string;
        }
      | undefined;

    if (!item) {
      throw new Error("Experiment item not found.");
    }

    const latestInputDocument = db
      .prepare(
        `SELECT id
         FROM input_documents
         WHERE experiment_item_id = ?
         ORDER BY uploaded_at DESC
         LIMIT 1`,
      )
      .get(payload.experimentItemId) as { id: string } | undefined;

    const now = new Date().toISOString();

    const inputDocumentId = latestInputDocument?.id ?? `${payload.experimentItemId}:input-primary`;
    if (!latestInputDocument) {
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
        ) VALUES (?, ?, 'other', ?, ?, NULL, '', NULL, ?)`,
      ).run(inputDocumentId, payload.experimentItemId, item.source_type, item.file_name, now);
    }

    const pipelineJobId = randomUUID();

    db.prepare(
      `INSERT INTO pipeline_jobs (
        id,
        project_id,
        component_id,
        input_document_id,
        status,
        model,
        chunk_size_words,
        chunk_overlap_words,
        started_at,
        finished_at,
        error_message
      ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, NULL)`,
    ).run(
      pipelineJobId,
      payload.projectId,
      payload.componentId,
      inputDocumentId,
      payload.model ?? "manual-chunking",
      payload.chunkSizeWords ?? 20,
      payload.chunkOverlapWords ?? 0,
      now,
      now,
    );

    const chunkRows = buildChunkOffsets(payload.chunks.map((chunk) => chunk.trim()).filter(Boolean));
    for (let index = 0; index < chunkRows.length; index += 1) {
      const chunk = chunkRows[index];
      db.prepare(
        `INSERT INTO text_chunks (
          id,
          pipeline_job_id,
          chunk_index,
          text,
          start_offset,
          end_offset,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), pipelineJobId, index, chunk.text, chunk.start, chunk.end, now);
    }

    const nextStatus = chunkRows.length > 0 ? "chunked" : "raw_text";
    db.prepare(
      `UPDATE experiment_items
       SET status = ?
       WHERE id = ?`,
    ).run(nextStatus, payload.experimentItemId);

    return {
      pipelineJobId,
      savedChunks: chunkRows.length,
    };
  });

  return runInTransaction({
    ...input,
    experimentItemId,
    projectId,
    componentId,
    chunks,
  });
}
