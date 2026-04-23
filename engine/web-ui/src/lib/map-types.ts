export type MapVertex = {
  id: string;
  label: string;
  x: number;
  y: number;
  type?: string;
  metadata?: Record<string, unknown>;
};

export type MapEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  weight?: number;
  metadata?: Record<string, unknown>;
};

export type MapGraphMeta = {
  mapImageRef?: string;
  coordinateSystem?: "pixel" | "normalized";
  width?: number;
  height?: number;
  symbolLegend?: Array<{
    symbol?: string;
    notation?: string;
    description?: string;
    color?: string;
  }>;
  symbolEnum?: string[];
  extractmapSymbol?: string;
  tokenUsage?: {
    promptTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    callCount?: number;
  };
  costEstimate?: {
    currency?: string;
    estimatedCost?: number | null;
    inputRatePer1M?: number;
    outputRatePer1M?: number;
    source?: string;
    note?: string;
  };
  [key: string]: unknown;
};

export type MapGraphPayload = {
  vertices: MapVertex[];
  edges: MapEdge[];
  metadata?: MapGraphMeta;
};

export type MapExtractionRequest = {
  componentId: string;
  overviewAdditionalInformation: string;
  binAdditionalInformation: string;
  overviewMapFiles: File[];
  binLocationFiles: File[];
  model?: string;
};

export type MapExtractionResult = {
  jobId: string;
  graph: MapGraphPayload;
};

export type MapExtractionJobStart = {
  jobId: string;
  status?: string;
  statusUrl?: string;
  resultUrl?: string;
};

export type MapExtractionJobStatus = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | string;
  currentStage?: string | null;
  activeStage?: string | null;
  stageMessage?: string;
  stageHistory?: Array<{
    stage: string;
    message?: string;
    tokenUsage?: MapExtractionProgress["tokenUsage"];
    costEstimate?: MapExtractionProgress["costEstimate"];
  }>;
  tokenUsage?: {
    promptTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    callCount?: number;
  };
  costEstimate?: {
    currency?: string;
    estimatedCost?: number | null;
    source?: string;
  };
  error?: string | null;
  cancelRequested?: boolean;
  completedStages?: string[];
  canResume?: boolean;
  remainingStages?: number;
  nextStage?: string | null;
  resumeDisabledReason?: string | null;
};

export type MapExtractCheckpoint = {
  stage: string;
  savedAt: number;
  bytes: number;
};

export type MapExtractCheckpointList = {
  jobId: string;
  status?: string | null;
  stageOrder: string[];
  completedStages: string[];
  checkpoints: MapExtractCheckpoint[];
};

export type MapExtractCheckpointDetail = {
  jobId: string;
  stage: string;
  summary?: Record<string, unknown>;
  preview?: unknown;
  tokenUsage?: {
    promptTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    callCount?: number;
  } | null;
};

export type MapExtractionProgress = {
  jobId: string;
  attempt: number;
  elapsedMs: number;
  status: string;
  stage?: string | null;
  message?: string;
  tokenUsage?: {
    promptTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    callCount?: number;
  };
  costEstimate?: {
    currency?: string;
    estimatedCost?: number | null;
    source?: string;
  };
  canResume?: boolean;
  remainingStages?: number;
  nextStage?: string | null;
  resumeDisabledReason?: string | null;
};

export type MapEditRequest = {
  componentId: string;
  prompt: string;
  graph: MapGraphPayload;
};

export type MapEditResult = {
  changeSummary: string;
  graph: MapGraphPayload;
};

export type GraphSelection =
  | { kind: "vertex"; data: MapVertex }
  | { kind: "edge"; data: MapEdge }
  | { kind: "none" };
