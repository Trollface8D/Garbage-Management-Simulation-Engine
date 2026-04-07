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
};

export type MapExtractionResult = {
  jobId: string;
  graph: MapGraphPayload;
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
