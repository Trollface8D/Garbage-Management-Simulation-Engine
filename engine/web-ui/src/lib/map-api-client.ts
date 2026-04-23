import type {
  MapEditRequest,
  MapEditResult,
  MapExtractCheckpointDetail,
  MapExtractCheckpointList,
  MapExtractionJobStart,
  MapExtractionJobStatus,
  MapExtractionProgress,
  MapExtractionRequest,
  MapExtractionResult,
} from "@/lib/map-types";

const DEFAULT_EXTRACT_START_ENDPOINT = "/api/map/extract/start";
const DEFAULT_EXTRACT_STATUS_ENDPOINT = "/api/map/extract/status";
const DEFAULT_EXTRACT_RESULT_ENDPOINT = "/api/map/extract/result";
const DEFAULT_EXTRACT_CANCEL_ENDPOINT = "/api/map/extract/cancel";
const DEFAULT_EXTRACT_ROLLBACK_ENDPOINT = "/api/map/extract/rollback";
const DEFAULT_EXTRACT_RESUME_ENDPOINT = "/api/map/extract/resume";
const DEFAULT_EXTRACT_CHECKPOINTS_ENDPOINT = "/api/map/extract/checkpoints";
const DEFAULT_EDIT_ENDPOINT = "/api/map/edit";

function getExtractStartEndpoint(): string {
  return process.env.NEXT_PUBLIC_MAP_EXTRACT_START_ENDPOINT || DEFAULT_EXTRACT_START_ENDPOINT;
}

function getExtractStatusEndpoint(): string {
  return process.env.NEXT_PUBLIC_MAP_EXTRACT_STATUS_ENDPOINT || DEFAULT_EXTRACT_STATUS_ENDPOINT;
}

function getExtractResultEndpoint(): string {
  return process.env.NEXT_PUBLIC_MAP_EXTRACT_RESULT_ENDPOINT || DEFAULT_EXTRACT_RESULT_ENDPOINT;
}

function getEditEndpoint(): string {
  // TODO(team-backend): set NEXT_PUBLIC_MAP_EDIT_ENDPOINT when backend endpoint is ready.
  return process.env.NEXT_PUBLIC_MAP_EDIT_ENDPOINT || DEFAULT_EDIT_ENDPOINT;
}

function getAuthHeaders(): Record<string, string> {
  // TODO(auth): Electron window app currently has no auth.
  // Keep this hook so token-based auth can be added later without changing page logic.
  return {};
}

async function parseErrorMessage(response: Response): Promise<string> {
  const fallback = `Request failed with status ${String(response.status)}`;

  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || fallback;
  } catch {
    return fallback;
  }
}

async function fetchMapExtractStatus(jobId: string): Promise<MapExtractionJobStatus> {
  const url = new URL(getExtractStatusEndpoint(), window.location.origin);
  url.searchParams.set("jobId", jobId);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      ...getAuthHeaders(),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  return (await response.json()) as MapExtractionJobStatus;
}

async function fetchMapExtractResult(jobId: string): Promise<MapExtractionResult> {
  const url = new URL(getExtractResultEndpoint(), window.location.origin);
  url.searchParams.set("jobId", jobId);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      ...getAuthHeaders(),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  return (await response.json()) as MapExtractionResult;
}

export async function extractMapGraph(
  input: MapExtractionRequest,
  options?: {
    onProgress?: (progress: MapExtractionProgress) => void;
  },
): Promise<MapExtractionResult> {
  const formData = new FormData();
  formData.set("componentId", input.componentId);
  formData.set("overviewAdditionalInformation", input.overviewAdditionalInformation);
  formData.set("binAdditionalInformation", input.binAdditionalInformation);
  if (input.model && input.model.trim()) {
    formData.set("model", input.model.trim());
  }

  for (const file of input.overviewMapFiles) {
    formData.append("overviewMapFiles", file);
  }

  for (const file of input.binLocationFiles) {
    formData.append("binLocationFiles", file);
  }

  const response = await fetch(getExtractStartEndpoint(), {
    method: "POST",
    headers: {
      ...getAuthHeaders(),
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  const startPayload = (await response.json()) as MapExtractionJobStart;
  const jobId = String(startPayload.jobId || "").trim();
  if (!jobId) {
    throw new Error("map_extract did not return a valid jobId.");
  }

  const startedAt = Date.now();
  const maxAttempts = 1500;
  const pollIntervalMs = 1200;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await fetchMapExtractStatus(jobId);

    options?.onProgress?.({
      jobId,
      attempt,
      elapsedMs: Date.now() - startedAt,
      status: status.status,
      stage: status.currentStage,
      message: status.stageMessage,
      tokenUsage: status.tokenUsage,
      costEstimate: status.costEstimate,
    });

    if (status.status === "failed") {
      throw new Error(status.error || "map_extract failed.");
    }
    if (status.status === "cancelled") {
      throw new Error("map_extract was cancelled.");
    }

    if (status.status === "completed") {
      const result = await fetchMapExtractResult(jobId);
      if (!result.jobId) {
        result.jobId = jobId;
      }
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("map_extract timed out while waiting for completion.");
}

export async function fetchMapExtractStatusOnce(jobId: string): Promise<MapExtractionJobStatus> {
  return fetchMapExtractStatus(jobId);
}

export type MapExtractInputsManifest = {
  jobId: string;
  componentId?: string;
  overviewAdditionalInformation?: string;
  supportAdditionalInformation?: string;
  modelName?: string;
  overviewFiles: {
    index: number;
    filename: string;
    mimeType: string;
    size: number;
    downloadUrl: string;
  }[];
  supportFiles: {
    index: number;
    filename: string;
    mimeType: string;
    size: number;
    downloadUrl: string;
  }[];
};

export async function fetchMapExtractInputs(jobId: string): Promise<MapExtractInputsManifest | null> {
  const url = new URL("/api/map/extract/inputs", window.location.origin);
  url.searchParams.set("jobId", jobId);
  const response = await fetch(url.toString(), { method: "GET", cache: "no-store" });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as MapExtractInputsManifest;
}

export async function fetchMapExtractInputFile(
  jobId: string,
  kind: "overview" | "support",
  index: number,
  filename: string,
  mimeType: string,
): Promise<File | null> {
  const url = new URL(`/api/map/extract/inputs/${kind}/${index}`, window.location.origin);
  url.searchParams.set("jobId", jobId);
  const response = await fetch(url.toString(), { method: "GET", cache: "no-store" });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  const blob = await response.blob();
  return new File([blob], filename, {
    type: mimeType || blob.type || "application/octet-stream",
  });
}

export async function fetchMapExtractCheckpoints(jobId: string): Promise<MapExtractCheckpointList> {
  const url = new URL(DEFAULT_EXTRACT_CHECKPOINTS_ENDPOINT, window.location.origin);
  url.searchParams.set("jobId", jobId);
  const response = await fetch(url.toString(), { method: "GET", cache: "no-store" });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as MapExtractCheckpointList;
}

export async function fetchMapExtractCheckpointDetail(
  jobId: string,
  stage: string,
): Promise<MapExtractCheckpointDetail> {
  const url = new URL("/api/map/extract/checkpoint", window.location.origin);
  url.searchParams.set("jobId", jobId);
  url.searchParams.set("stage", stage);
  const response = await fetch(url.toString(), { method: "GET", cache: "no-store" });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as MapExtractCheckpointDetail;
}

export async function cancelMapExtractJob(jobId: string): Promise<void> {
  const url = new URL(DEFAULT_EXTRACT_CANCEL_ENDPOINT, window.location.origin);
  url.searchParams.set("jobId", jobId);
  const response = await fetch(url.toString(), { method: "POST", cache: "no-store" });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
}

export async function rollbackMapExtractJob(jobId: string, stage: string): Promise<void> {
  const url = new URL(DEFAULT_EXTRACT_ROLLBACK_ENDPOINT, window.location.origin);
  url.searchParams.set("jobId", jobId);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stage }),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
}

export async function resumeMapExtractJob(
  jobId: string,
  options?: { onProgress?: (progress: MapExtractionProgress) => void },
): Promise<MapExtractionResult> {
  const url = new URL(DEFAULT_EXTRACT_RESUME_ENDPOINT, window.location.origin);
  url.searchParams.set("jobId", jobId);
  const response = await fetch(url.toString(), { method: "POST", cache: "no-store" });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  const startedAt = Date.now();
  const maxAttempts = 1500;
  const pollIntervalMs = 1200;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await fetchMapExtractStatus(jobId);

    options?.onProgress?.({
      jobId,
      attempt,
      elapsedMs: Date.now() - startedAt,
      status: status.status,
      stage: status.currentStage,
      message: status.stageMessage,
      tokenUsage: status.tokenUsage,
      costEstimate: status.costEstimate,
    });

    if (status.status === "failed") {
      throw new Error(status.error || "map_extract failed.");
    }
    if (status.status === "cancelled") {
      throw new Error("map_extract was cancelled.");
    }
    if (status.status === "completed") {
      const result = await fetchMapExtractResult(jobId);
      if (!result.jobId) {
        result.jobId = jobId;
      }
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("map_extract resume timed out while waiting for completion.");
}

export async function editMapGraph(input: MapEditRequest): Promise<MapEditResult> {
  const response = await fetch(getEditEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  return (await response.json()) as MapEditResult;
}
