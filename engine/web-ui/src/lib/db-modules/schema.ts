import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey().notNull(),
  name: text("name").notNull().unique(),
  deletedAt: text("deleted_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const projectComponents = sqliteTable(
  "project_components",
  {
    id: text("id").primaryKey().notNull(),
    title: text("title").notNull(),
    category: text("category").notNull(),
    lastEditedAt: text("last_edited_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "project_components_category_check",
      sql`${table.category} IN ('Causal', 'Map', 'Code', 'Policy_Testing')`,
    ),
  ],
);

// DBML-compatible soft-delete support via side tables (without mutating core table columns).
export const projectTrash = sqliteTable(
  "project_trash",
  {
    projectId: text("project_id")
      .primaryKey()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    deletedAt: text("deleted_at").notNull(),
  },
  (table) => [index("idx_project_trash_deleted_at").on(table.deletedAt)],
);

export const componentTrash = sqliteTable(
  "component_trash",
  {
    componentId: text("component_id")
      .primaryKey()
      .notNull()
      .references(() => projectComponents.id, { onDelete: "cascade" }),
    deletedAt: text("deleted_at").notNull(),
  },
  (table) => [index("idx_component_trash_deleted_at").on(table.deletedAt)],
);

export const componentProjectLinks = sqliteTable(
  "component_project_links",
  {
    id: text("id").primaryKey().notNull(),
    componentId: text("component_id")
      .notNull()
      .references(() => projectComponents.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("PRIMARY"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("component_project_links_role_check", sql`${table.role} IN ('PRIMARY', 'LEFT', 'RIGHT')`),
    uniqueIndex("component_project_links_unique").on(table.componentId, table.projectId, table.role),
    index("idx_component_project_links_component_id").on(table.componentId),
    index("idx_component_project_links_project_id").on(table.projectId),
  ],
);

export const causalProjectDocuments = sqliteTable(
  "causal_project_documents",
  {
    id: text("id").primaryKey().notNull(),
    componentId: text("component_id")
      .notNull()
      .references(() => projectComponents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("raw_text"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "causal_project_documents_status_check",
      sql`${table.status} IN ('raw_text', 'chunked', 'extracted')`,
    ),
    index("idx_causal_project_documents_component_id").on(table.componentId),
  ],
);

export const inputDocuments = sqliteTable(
  "input_documents",
  {
    id: text("id").primaryKey().notNull(),
    causalProjectDocumentId: text("causal_project_document_id")
      .notNull()
      .references(() => causalProjectDocuments.id, { onDelete: "cascade" }),
    inputMode: text("input_mode").notNull(),
    sourceType: text("source_type").notNull(),
    originalFileName: text("original_file_name"),
    storagePath: text("storage_path"),
    rawText: text("raw_text"),
    transcriptText: text("transcript_text"),
    uploadedAt: text("uploaded_at").notNull(),
  },
  (table) => [
    check("input_documents_input_mode_check", sql`${table.inputMode} IN ('text', 'file')`),
    check("input_documents_source_type_check", sql`${table.sourceType} IN ('text', 'audio')`),
    index("idx_input_documents_cpd_uploaded_at").on(table.causalProjectDocumentId, table.uploadedAt),
  ],
);

export const textChunks = sqliteTable(
  "text_chunks",
  {
    id: text("id").primaryKey().notNull(),
    causalProjectDocumentId: text("causal_project_document_id")
      .notNull()
      .references(() => causalProjectDocuments.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    text: text("text").notNull(),
    startOffset: integer("start_offset"),
    endOffset: integer("end_offset"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("text_chunks_doc_chunk_unique").on(table.causalProjectDocumentId, table.chunkIndex),
    index("idx_text_chunks_doc_chunk").on(table.causalProjectDocumentId, table.chunkIndex),
  ],
);

export const extractionClasses = sqliteTable("extraction_classes", {
  id: text("id").primaryKey().notNull(),
  causalProjectDocumentId: text("causal_project_document_id")
    .notNull()
    .references(() => causalProjectDocuments.id, { onDelete: "cascade" }),
  chunkId: text("chunk_id").references(() => textChunks.id, { onDelete: "set null" }),
  patternType: text("pattern_type"),
  sentenceType: text("sentence_type"),
  markedType: text("marked_type"),
  explicitType: text("explicit_type"),
  marker: text("marker"),
  sourceText: text("source_text").notNull(),
  createdAt: text("created_at").notNull(),
});

export const causal = sqliteTable("causal", {
  id: text("id").primaryKey().notNull(),
  causalProjectDocumentId: text("causal_project_document_id")
    .notNull()
    .references(() => causalProjectDocuments.id, { onDelete: "cascade" }),
  extractionClassId: text("extraction_class_id")
    .notNull()
    .references(() => extractionClasses.id, { onDelete: "cascade" }),
  head: text("head").notNull(),
  relationship: text("relationship").notNull(),
  tail: text("tail").notNull(),
  detail: text("detail"),
  createdAt: text("created_at").notNull(),
});

export const followUps = sqliteTable("follow_ups", {
  id: text("id").primaryKey().notNull(),
  causalProjectDocumentId: text("causal_project_document_id")
    .notNull()
    .references(() => causalProjectDocuments.id, { onDelete: "cascade" }),
  causalId: text("causal_id")
    .notNull()
    .references(() => causal.id, { onDelete: "cascade" }),
  sourceText: text("source_text").notNull(),
  sentenceType: text("sentence_type"),
  createdAt: text("created_at").notNull(),
});

export const followUpQuestions = sqliteTable("follow_up_questions", {
  id: text("id").primaryKey().notNull(),
  followUpId: text("follow_up_id")
    .notNull()
    .references(() => followUps.id, { onDelete: "cascade" }),
  questionText: text("question_text").notNull(),
  generatedBy: text("generated_by").notNull().default("system"),
  generatedAt: text("generated_at").notNull(),
  isFilteredIn: integer("is_filtered_in", { mode: "boolean" }).notNull().default(true),
});

export const followUpAnswers = sqliteTable("follow_up_answers", {
  id: text("id").primaryKey().notNull(),
  questionId: text("question_id")
    .notNull()
    .references(() => followUpQuestions.id, { onDelete: "cascade" }),
  answerText: text("answer_text").notNull(),
  answeredBy: text("answered_by").notNull().default("user"),
  answeredAt: text("answered_at").notNull(),
  derivedCausalJson: text("derived_causal_json"),
  derivedCausalUpdatedAt: text("derived_causal_updated_at"),
});

export const submissionBatches = sqliteTable(
  "submission_batches",
  {
    id: text("id").primaryKey().notNull(),
    causalProjectDocumentId: text("causal_project_document_id")
      .notNull()
      .references(() => causalProjectDocuments.id, { onDelete: "cascade" }),
    scopeType: text("scope_type").notNull(),
    scopeRef: text("scope_ref"),
    submittedCount: integer("submitted_count").notNull().default(0),
    statusMessage: text("status_message"),
    submittedAt: text("submitted_at").notNull(),
  },
  (table) => [
    check("submission_batches_scope_type_check", sql`${table.scopeType} IN ('GROUP', 'ALL')`),
  ],
);

export const generatedEntities = sqliteTable(
  "generated_entities",
  {
    id: text("id").primaryKey().notNull(),
    causalId: text("causal_id")
      .notNull()
      .references(() => causal.id, { onDelete: "cascade" }),
    entityName: text("entity_name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("generated_entities_causal_entity_unique").on(table.causalId, table.entityName)],
);

export const mapProjectDocuments = sqliteTable(
  "map_project_documents",
  {
    id: text("id").primaryKey().notNull(),
    componentId: text("component_id")
      .notNull()
      .references(() => projectComponents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("draft"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("map_project_documents_status_check", sql`${table.status} IN ('draft', 'extracted', 'edited')`),
    uniqueIndex("map_project_documents_component_unique").on(table.componentId),
    index("idx_map_project_documents_component_id").on(table.componentId),
  ],
);

export const mapSnapshots = sqliteTable(
  "map_snapshots",
  {
    id: text("id").primaryKey().notNull(),
    mapProjectDocumentId: text("map_project_document_id")
      .notNull()
      .references(() => mapProjectDocuments.id, { onDelete: "cascade" }),
    jobId: text("job_id"),
    selectedModel: text("selected_model"),
    overviewAdditionalInfo: text("overview_additional_info"),
    binAdditionalInfo: text("bin_additional_info"),
    editStatus: text("edit_status"),
    coordinateSystem: text("coordinate_system").notNull().default("normalized"),
    metadataJson: text("metadata_json"),
    selectedKind: text("selected_kind").notNull().default("none"),
    selectedRefId: text("selected_ref_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("map_snapshots_coordinate_system_check", sql`${table.coordinateSystem} IN ('normalized', 'pixel')`),
    check("map_snapshots_selected_kind_check", sql`${table.selectedKind} IN ('none', 'vertex', 'edge')`),
    index("idx_map_snapshots_doc_id").on(table.mapProjectDocumentId),
    index("idx_map_snapshots_created_at").on(table.createdAt),
    index("idx_map_snapshots_job_id").on(table.jobId),
  ],
);

export const mapSnapshotOverviewFiles = sqliteTable(
  "map_snapshot_overview_files",
  {
    id: text("id").primaryKey().notNull(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => mapSnapshots.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("map_snapshot_overview_files_snapshot_name_unique").on(table.snapshotId, table.fileName),
    index("idx_map_snapshot_overview_files_snapshot_id").on(table.snapshotId),
  ],
);

export const mapSnapshotBinFiles = sqliteTable(
  "map_snapshot_bin_files",
  {
    id: text("id").primaryKey().notNull(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => mapSnapshots.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("map_snapshot_bin_files_snapshot_name_unique").on(table.snapshotId, table.fileName),
    index("idx_map_snapshot_bin_files_snapshot_id").on(table.snapshotId),
  ],
);

export const mapVertices = sqliteTable(
  "map_vertices",
  {
    id: text("id").primaryKey().notNull(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => mapSnapshots.id, { onDelete: "cascade" }),
    vertexId: text("vertex_id").notNull(),
    label: text("label").notNull(),
    x: real("x").notNull(),
    y: real("y").notNull(),
    vertexType: text("vertex_type"),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("map_vertices_snapshot_vertex_unique").on(table.snapshotId, table.vertexId),
    index("idx_map_vertices_snapshot_id").on(table.snapshotId),
  ],
);

export const mapEdges = sqliteTable(
  "map_edges",
  {
    id: text("id").primaryKey().notNull(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => mapSnapshots.id, { onDelete: "cascade" }),
    edgeId: text("edge_id").notNull(),
    sourceVertexId: text("source_vertex_id").notNull(),
    targetVertexId: text("target_vertex_id").notNull(),
    label: text("label"),
    weight: real("weight"),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("map_edges_snapshot_edge_unique").on(table.snapshotId, table.edgeId),
    index("idx_map_edges_snapshot_id").on(table.snapshotId),
    index("idx_map_edges_source_vertex_id").on(table.sourceVertexId),
    index("idx_map_edges_target_vertex_id").on(table.targetVertexId),
  ],
);

export const mapChangeLogs = sqliteTable(
  "map_change_logs",
  {
    id: text("id").primaryKey().notNull(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => mapSnapshots.id, { onDelete: "cascade" }),
    logEntry: text("log_entry").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    loggedAt: text("logged_at").notNull(),
  },
  (table) => [
    index("idx_map_change_logs_snapshot_id").on(table.snapshotId),
    index("idx_map_change_logs_logged_at").on(table.loggedAt),
  ],
);

export const codegenRuns = sqliteTable(
  "codegen_runs",
  {
    id: text("id").primaryKey().notNull(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    componentId: text("component_id").references(() => projectComponents.id, { onDelete: "set null" }),
    causalProjectDocumentId: text("causal_project_document_id").references(() => causalProjectDocuments.id, {
      onDelete: "set null",
    }),
    sourceType: text("source_type").notNull().default("manual"),
    status: text("status").notNull().default("queued"),
    model: text("model"),
    inputPrompt: text("input_prompt"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    durationMs: integer("duration_ms"),
    inputEntityCount: integer("input_entity_count").notNull().default(0),
    generatedEntityCount: integer("generated_entity_count").notNull().default(0),
    generatedFileCount: integer("generated_file_count").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "codegen_runs_source_type_check",
      sql`${table.sourceType} IN ('manual', 'derived_causal', 'follow_up', 'imported')`,
    ),
    check(
      "codegen_runs_status_check",
      sql`${table.status} IN ('queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    index("idx_codegen_runs_project_id").on(table.projectId),
    index("idx_codegen_runs_component_id").on(table.componentId),
    index("idx_codegen_runs_status").on(table.status),
    index("idx_codegen_runs_created_at").on(table.createdAt),
  ],
);

export const codegenInputEntities = sqliteTable(
  "codegen_input_entities",
  {
    id: text("id").primaryKey().notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => codegenRuns.id, { onDelete: "cascade" }),
    entityName: text("entity_name").notNull(),
    sourceCausalId: text("source_causal_id").references(() => causal.id, { onDelete: "set null" }),
    sourceHead: text("source_head"),
    sourceRelationship: text("source_relationship"),
    sourceTail: text("source_tail"),
    sourceDetail: text("source_detail"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("codegen_input_entities_run_entity_unique").on(table.runId, table.entityName),
    index("idx_codegen_input_entities_run_id").on(table.runId),
  ],
);

export const codegenGeneratedFiles = sqliteTable(
  "codegen_generated_files",
  {
    id: text("id").primaryKey().notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => codegenRuns.id, { onDelete: "cascade" }),
    entityName: text("entity_name").notNull(),
    filePath: text("file_path").notNull(),
    language: text("language"),
    fileSizeBytes: integer("file_size_bytes"),
    generationOrder: integer("generation_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("codegen_generated_files_run_path_unique").on(table.runId, table.filePath),
    index("idx_codegen_generated_files_run_id").on(table.runId),
    index("idx_codegen_generated_files_entity_name").on(table.entityName),
  ],
);

export const codegenRunMetrics = sqliteTable(
  "codegen_run_metrics",
  {
    id: text("id").primaryKey().notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => codegenRuns.id, { onDelete: "cascade" }),
    metricKey: text("metric_key").notNull(),
    metricType: text("metric_type").notNull().default("text"),
    metricValue: text("metric_value").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("codegen_run_metrics_metric_type_check", sql`${table.metricType} IN ('text', 'number', 'boolean', 'json')`),
    uniqueIndex("codegen_run_metrics_run_key_unique").on(table.runId, table.metricKey),
    index("idx_codegen_run_metrics_run_id").on(table.runId),
  ],
);

// Not part of schema.dbml, kept for current UI recent-artifacts feature.
export const recents = sqliteTable(
  "recents",
  {
    componentId: text("component_id").primaryKey().notNull(),
    title: text("title").notNull(),
    category: text("category").notNull(),
    projectId: text("project_id"),
    href: text("href").notNull(),
    openedAt: text("opened_at").notNull(),
  },
  (table) => [
    check("recents_category_check", sql`${table.category} IN ('Causal', 'Map', 'Code', 'PolicyTesting')`),
    index("idx_recents_opened_at").on(table.openedAt),
  ],
);
