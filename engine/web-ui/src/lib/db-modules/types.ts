import type { SimulationComponent, SimulationProject } from "@/lib/simulation-components";

export type RecentArtifact = {
  componentId: string;
  title: string;
  category: SimulationComponent["category"];
  projectId?: string;
  href: string;
  openedAt: string;
};

export type DeletedProject = {
  project: SimulationProject;
  deletedAt: string;
};

export type DeletedComponent = {
  component: SimulationComponent;
  deletedAt: string;
};

export type LegacyMigrationPayload = {
  projects: SimulationProject[];
  components: SimulationComponent[];
  deletedProjects: DeletedProject[];
  deletedComponents: DeletedComponent[];
  recents: RecentArtifact[];
};

export type MigrationSummary = {
  projects: number;
  components: number;
  deletedProjects: number;
  deletedComponents: number;
  recents: number;
};

export type ProjectRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type ComponentRow = {
  id: string;
  title: string;
  category: SimulationComponent["category"];
  last_edited_at: string;
  deleted_at: string | null;
};

export type ComponentProjectLinkRole = "primary" | "left" | "right";

export type ComponentProjectLinkRow = {
  id: string;
  component_id: string;
  project_id: string;
  role: ComponentProjectLinkRole;
};

export type RecentRow = {
  component_id: string;
  title: string;
  category: SimulationComponent["category"];
  project_id: string | null;
  href: string;
  opened_at: string;
};

export type CausalSourceItemStatus = "raw_text" | "chunked" | "extracted";
export type CausalSourceItemSourceType = "text" | "audio";

export type CausalSourceItem = {
  id: string;
  projectId: string;
  componentId: string;
  label: string;
  fileName: string;
  sourceType: CausalSourceItemSourceType;
  status: CausalSourceItemStatus;
  tags: string[];
  textContent: string;
  createdAt: string;
  updatedAt: string;
};

export type CausalSourceItemRow = {
  id: string;
  project_id: string;
  component_id: string;
  label: string;
  file_name: string;
  source_type: CausalSourceItemSourceType;
  status: CausalSourceItemStatus;
  tags_json: string;
  created_at: string;
  text_content: string;
};

export type InputMode = "upload" | "manual_text" | "api" | "other";

export type InputDocumentRow = {
  id: string;
  experiment_item_id: string;
  input_mode: InputMode;
  source_type: CausalSourceItemSourceType;
  original_file_name: string;
  storage_path_or_blob: string | null;
  raw_text: string | null;
  transcript_text: string | null;
  uploaded_at: string;
};

export type PipelineJobStatus = "queued" | "running" | "completed" | "failed";

export type PipelineJobRow = {
  id: string;
  project_id: string;
  component_id: string;
  input_document_id: string;
  status: PipelineJobStatus;
  model: string;
  chunk_size_words: number;
  chunk_overlap_words: number;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
};

export type TextChunkRow = {
  id: string;
  pipeline_job_id: string;
  chunk_index: number;
  text: string;
  start_offset: number;
  end_offset: number;
  created_at: string;
};

export type SaveTextChunksInput = {
  experimentItemId: string;
  projectId: string;
  componentId: string;
  chunks: string[];
  model?: string;
  chunkSizeWords?: number;
  chunkOverlapWords?: number;
};

export type SaveTextChunksResult = {
  pipelineJobId: string;
  savedChunks: number;
};
