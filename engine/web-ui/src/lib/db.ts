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

export { listLatestTextChunksForExperimentItem, saveTextChunks } from "./db-modules/text-chunks";

export { getCausalArtifactsForItem, saveCausalArtifacts } from "./db-modules/causal-artifacts";

export type {
  CausalArtifactsPayload,
  ExtractionPayloadRecord,
  FollowUpExportRecord,
  SaveCausalArtifactsInput,
  SaveCausalArtifactsResult,
} from "./db-modules/causal-artifacts";

export { migrateLegacyData } from "./db-modules/migration";

export { default } from "./db-modules/connection";
