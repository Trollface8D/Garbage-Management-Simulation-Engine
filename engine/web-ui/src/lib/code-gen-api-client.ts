"use client";

const BASE = "/api/code-gen";

export type CodeGenEntity = {
  id: string;
  label: string;
  type: "actor" | "resource" | "environment" | "policy";
  frequency: number;
};

export type CodeGenPolicyOutline = {
  rule_id: string;
  label: string;
  trigger: string;
  target_entity_id: string;
  target_method: string;
  inputs: string[];
  description: string;
};

export type CodeGenJobStatus = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "partial";
  currentStage: string | null;
  stageMessage: string;
  stageHistory: Array<{ stage: string; message: string; tokenUsage?: Record<string, number> }>;
  tokenUsage: Record<string, number> | null;
  error: string | null;
  cancelRequested: boolean;
  completedStages: string[];
  remainingStages: number;
  nextStage: string | null;
  canResume: boolean;
  resumeDisabledReason: string | null;
};

export type CodeGenPreviewResult = {
  jobId: string;
  entities: CodeGenEntity[];
  policies: CodeGenPolicyOutline[];
  warning: string | null;
};

export type CodeGenIterationEntry = {
  stage: string;
  iterId: string;
  savedAt: number;
  bytes: number;
};

export type MetricGrounding =
  | "causal_explicit"
  | "causal_implicit"
  | "domain_inference";

export type MetricSamplingEvent =
  | "tick"
  | "policy_fired"
  | "entity_created"
  | "entity_destroyed";

export type MetricAttrDependency = {
  entity: string;
  attr: string;
};

export type SuggestedMetric = {
  name: string;
  label: string;
  unit: string;
  agg: "sum" | "mean" | "max" | "min" | "count" | "ratio";
  entities: string[];
  viz: "line" | "bar" | "histogram" | "gauge" | "stacked_area";
  chart_group?: string | null;
  grounding?: MetricGrounding;
  required_attrs?: MetricAttrDependency[];
  sampling_event?: MetricSamplingEvent;
  rationale: string;
};

export async function suggestMetrics(
  entities: Array<{ name: string }>,
  causalText?: string,
  model?: string,
  signal?: AbortSignal,
): Promise<SuggestedMetric[]> {
  const response = await fetch(`${BASE}/suggest_metrics`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      entities,
      ...(causalText ? { causalText } : {}),
      ...(model ? { model } : {}),
    }),
    cache: "no-store",
    signal,
  });
  const payload = await jsonOrThrow<{ metrics: SuggestedMetric[] }>(response);
  return payload.metrics || [];
}

export type CodeGenCreateRequest = {
  causalData: string;
  mapNodeJson?: Record<string, unknown> | null;
  selectedEntities?: Array<{ id: string }>;
  selectedPolicies?: Array<{ rule_id: string }>;
  selectedMetrics?: SuggestedMetric[];
  model?: string;
};

async function parseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string; detail?: string };
    return (
      payload.error || payload.detail || `Request failed (${String(response.status)})`
    );
  } catch {
    return `Request failed (${String(response.status)})`;
  }
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return (await response.json()) as T;
}

export async function createCodeGenJob(req: CodeGenCreateRequest): Promise<{ jobId: string }> {
  const response = await fetch(`${BASE}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    cache: "no-store",
  });
  return jsonOrThrow<{ jobId: string }>(response);
}

export async function previewEntities(jobId: string): Promise<CodeGenPreviewResult> {
  const response = await fetch(`${BASE}/jobs/${encodeURIComponent(jobId)}/preview_entities`, {
    method: "POST",
    cache: "no-store",
  });
  return jsonOrThrow<CodeGenPreviewResult>(response);
}

export async function fetchCodeGenStatus(jobId: string): Promise<CodeGenJobStatus> {
  const response = await fetch(`${BASE}/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
  return jsonOrThrow<CodeGenJobStatus>(response);
}

export async function resumeCodeGenJob(jobId: string): Promise<void> {
  const response = await fetch(`${BASE}/jobs/${encodeURIComponent(jobId)}/resume`, {
    method: "POST",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
}

export async function cancelCodeGenJob(jobId: string): Promise<void> {
  const response = await fetch(`${BASE}/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
}

export async function rollbackCodeGenJob(
  jobId: string,
  toStage: string,
  mode: "after" | "from" = "after",
): Promise<void> {
  const response = await fetch(`${BASE}/jobs/${encodeURIComponent(jobId)}/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toStage, mode }),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
}

export async function fetchCodeGenResult(jobId: string): Promise<unknown> {
  const response = await fetch(`${BASE}/jobs/${encodeURIComponent(jobId)}/result`, { cache: "no-store" });
  return jsonOrThrow<unknown>(response);
}

export async function listIterations(jobId: string, stage: string): Promise<CodeGenIterationEntry[]> {
  const response = await fetch(`${BASE}/jobs/${encodeURIComponent(jobId)}/iterations/${encodeURIComponent(stage)}`, {
    cache: "no-store",
  });
  const payload = await jsonOrThrow<{ iterations: CodeGenIterationEntry[] }>(response);
  return payload.iterations || [];
}

export async function fetchIteration(jobId: string, stage: string, iterId: string): Promise<{ code?: string; filename?: string; validation?: { errors: string[] } }> {
  const response = await fetch(
    `${BASE}/jobs/${encodeURIComponent(jobId)}/iterations/${encodeURIComponent(stage)}/${encodeURIComponent(iterId)}`,
    { cache: "no-store" },
  );
  return jsonOrThrow(response);
}

export async function deleteIteration(jobId: string, stage: string, iterId: string): Promise<void> {
  const response = await fetch(
    `${BASE}/jobs/${encodeURIComponent(jobId)}/iterations/${encodeURIComponent(stage)}/${encodeURIComponent(iterId)}`,
    { method: "DELETE", cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
}

export function artifactUrl(jobId: string, relativePath: string): string {
  return `${BASE}/jobs/${encodeURIComponent(jobId)}/artifacts/${relativePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export type EntityGroup = {
  canonical: string;
  count: number;
  members: Array<{ name: string; count: number }>;
};

export async function exportWorkspaceArchive(
  metadata: Record<string, unknown>,
  jobId?: string | null,
): Promise<Blob> {
  const response = await fetch(`${BASE}/workspace_export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ metadata, ...(jobId ? { jobId } : {}) }),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return await response.blob();
}

export async function importWorkspaceArchive(
  file: File,
): Promise<{ metadata: Record<string, unknown>; artifactNames: string[] }> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch(`${BASE}/workspace_import`, {
    method: "POST",
    body: form,
    cache: "no-store",
  });
  return jsonOrThrow<{ metadata: Record<string, unknown>; artifactNames: string[] }>(
    response,
  );
}

export async function groupEntitiesWithGemini(
  counts: Record<string, number>,
  model?: string,
  signal?: AbortSignal,
): Promise<EntityGroup[]> {
  const response = await fetch(`${BASE}/group_entities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ counts, ...(model ? { model } : {}) }),
    cache: "no-store",
    signal,
  });
  const payload = await jsonOrThrow<{ groups: EntityGroup[] }>(response);
  return payload.groups || [];
}
