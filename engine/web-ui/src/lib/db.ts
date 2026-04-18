export type {
  CausalSourceItem,
  CausalSourceItemSourceType,
  CausalSourceItemStatus,
  SaveTextChunksInput,
  SaveTextChunksResult,
  DeletedComponent,
  DeletedProject,
  LegacyMigrationPayload,
  MigrationSummary,
  RecentArtifact,
} from "./db-modules/types";

export {
  createComponent,
  createProject,
  hardDeleteComponent,
  hardDeleteProject,
  listComponents,
  listDeletedComponents,
  listDeletedProjects,
  listProjects,
  restoreComponent,
  restoreProject,
  softDeleteComponent,
  softDeleteProject,
} from "./db-modules/projects-components";

export {
  listRecents,
  trackRecent,
} from "./db-modules/recents";

export {
  deleteCausalSourceItem,
  getCausalSourceItem,
  getLatestInputDocumentForItem,
  listCausalSourceItems,
  upsertCausalSourceItem,
} from "./db-modules/causal-source-items";

export {
  listLatestTextChunkRecordsForExperimentItem,
  listLatestTextChunksForExperimentItem,
  saveTextChunks,
  type TextChunkRecord,
} from "./db-modules/text-chunks";

export {
  listLatestChunkExtractionsForExperimentItem,
  type ChunkExtractionRecord,
  type ExtractionClassRecord as ChunkExtractionClassRecord,
  type ExtractedRelationRecord as ChunkExtractedRelationRecord,
} from "./db-modules/chunk-extractions";

export {
  getCausalArtifactsForItem,
  listFollowUpRecordsForExperimentItem,
  saveCausalArtifacts,
  saveFollowUpAnswers,
  saveFollowUpQuestions,
} from "./db-modules/causal-artifacts";

export type {
  CausalArtifactsPayload,
  ExtractionClassRecord,
  ExtractionPayloadRecord,
  FollowUpRecord,
  FollowUpExportRecord,
  SaveCausalArtifactsInput,
  SaveCausalArtifactsResult,
  SaveFollowUpAnswersInput,
  SaveFollowUpAnswersResult,
  SaveFollowUpQuestionsInput,
  SaveFollowUpQuestionsResult,
} from "./db-modules/causal-artifacts";

export {
  createCodegenRun,
  getCodegenRunById,
  listCodegenGeneratedFiles,
  listCodegenMetrics,
  listCodegenRuns,
  listCodegenRunsForComponent,
  markCodegenRunCompleted,
  markCodegenRunFailed,
  markCodegenRunRunning,
  saveCodegenGeneratedFiles,
  saveCodegenInputEntities,
  upsertCodegenMetrics,
  type CodegenMetricType,
  type CodegenRunRecord,
  type CodegenRunSourceType,
  type CodegenRunStatus,
  type CreateCodegenRunInput,
  type RecordCodegenGeneratedFile,
  type RecordCodegenInputEntity,
  type UpsertCodegenMetricInput,
} from "./db-modules/codegen-analytics";

export { migrateLegacyData } from "./db-modules/migration";

export { default } from "./db-modules/connection";
