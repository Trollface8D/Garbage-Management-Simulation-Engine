"use client";

import { useEffect, useRef, useState } from "react";
import {
  artifactUrl,
  fetchCodeGenResult,
  type CodeGenEntity,
  type CodeGenPolicyOutline,
  type SuggestedMetric,
} from "@/lib/code-gen-api-client";
import { useCodeGenJob } from "@/lib/use-code-gen-job";
import {
  loadCausalArtifactsForItem,
  loadCausalSourceItem,
  loadCausalSourceItems,
  type CausalSourceItem,
} from "@/lib/pm-storage";
import type { MapGraphPayload } from "@/lib/map-types";

type CausalChoice = {
  id: string;
  componentId: string;
  label: string;
};

type ArtifactFile = {
  path: string;
  kind?: string;
  iterId?: string;
};

export type CausalSourceRef = { projectId: string; componentId: string };

type Props = {
  causalSourceRefs: CausalSourceRef[];
  selectedMapId?: string | null;
  selectedMapLabel?: string | null;
  model: string;
  selectedMetrics: SuggestedMetric[];
  missingRequirements?: readonly string[];
  onRunningChange?: (running: boolean) => void;
  onJobIdChange?: (jobId: string | null) => void;
};

function loadMapGraphForComponent(componentId: string): MapGraphPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`map-workspace:${componentId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { graph?: MapGraphPayload | null };
    return parsed?.graph ?? null;
  } catch {
    return null;
  }
}

async function aggregateCausalText(items: CausalChoice[]): Promise<string> {
  const blocks: string[] = [];
  for (const item of items) {
    let source: CausalSourceItem | null = null;
    try {
      source = await loadCausalSourceItem(item.id);
    } catch {
      source = null;
    }
    const heading = `# ${item.label}`;
    const sourceText = source?.textContent?.trim() || "";
    let extractionBlock = "";
    try {
      const artifacts = await loadCausalArtifactsForItem(item.id);
      const lines: string[] = [];
      for (const chunk of artifacts.raw_extraction || []) {
        for (const cls of chunk.classes || []) {
          for (const rel of cls.extracted || []) {
            const head = rel.head?.trim() || "";
            const relationship = rel.relationship?.trim() || "";
            const tail = rel.tail?.trim() || "";
            const detail = rel.detail?.trim() || "";
            if (!head && !relationship && !tail) continue;
            lines.push(`- ${head} -[${relationship}]-> ${tail}${detail ? ` :: ${detail}` : ""}`);
          }
        }
      }
      if (lines.length > 0) {
        extractionBlock = `## Extracted relations\n${lines.join("\n")}`;
      }
    } catch {
      extractionBlock = "";
    }
    const parts = [heading, sourceText, extractionBlock].filter((s) => s.length > 0);
    if (parts.length > 0) {
      blocks.push(parts.join("\n\n"));
    }
  }
  return blocks.join("\n\n---\n\n").trim();
}

export default function CodeGenWorkspace({
  causalSourceRefs,
  selectedMapId,
  selectedMapLabel,
  model,
  selectedMetrics,
  missingRequirements,
  onRunningChange,
  onJobIdChange,
}: Props) {
  const job = useCodeGenJob();
  const [causalChoices, setCausalChoices] = useState<CausalChoice[]>([]);
  const [mapGraph, setMapGraph] = useState<MapGraphPayload | null>(null);
  const [mapStatus, setMapStatus] = useState<string>("no map selected");
  const [selectedEntityIds, setSelectedEntityIds] = useState<Set<string>>(new Set());
  const [selectedPolicyIds, setSelectedPolicyIds] = useState<Set<string>>(new Set());
  const [artifactFiles, setArtifactFiles] = useState<ArtifactFile[]>([]);
  const [actionError, setActionError] = useState<string>("");
  const [previewOpen, setPreviewOpen] = useState<boolean>(false);
  const [previewText, setPreviewText] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const lastResultJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedMapId) {
      setMapGraph(null);
      setMapStatus("no map selected");
      return;
    }
    const graph = loadMapGraphForComponent(selectedMapId);
    if (!graph) {
      setMapGraph(null);
      setMapStatus(
        `1 map: ${selectedMapLabel ?? selectedMapId} — no saved graph found (open the map workspace once to extract it)`,
      );
      return;
    }
    setMapGraph(graph);
    const v = graph.vertices?.length ?? 0;
    const e = graph.edges?.length ?? 0;
    setMapStatus(
      `1 map: ${selectedMapLabel ?? selectedMapId} (${String(v)} vertices, ${String(e)} edges)`,
    );
  }, [selectedMapId, selectedMapLabel]);

  const jobStatus = job.status?.status;
  const isRunning =
    job.isStarting ||
    job.isPreviewing ||
    job.isResuming ||
    job.isPolling ||
    jobStatus === "running" ||
    jobStatus === "queued";

  useEffect(() => {
    onRunningChange?.(isRunning);
  }, [isRunning, onRunningChange]);

  useEffect(() => {
    onJobIdChange?.(job.jobId);
  }, [job.jobId, onJobIdChange]);

  // Discover causal source documents for the selected causal components.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const collected: CausalChoice[] = [];
      for (const ref of causalSourceRefs) {
        try {
          const items = await loadCausalSourceItems(ref.projectId, ref.componentId);
          for (const item of items) {
            collected.push({
              id: item.id,
              componentId: ref.componentId,
              label: item.label || item.fileName || item.id,
            });
          }
        } catch {
          // Ignore — component may have no causal sources yet.
        }
      }
      if (!cancelled) {
        setCausalChoices(collected);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [causalSourceRefs]);

  // When preview entities arrives, auto-select all by default.
  useEffect(() => {
    const preview = job.preview;
    if (!preview) return;
    setSelectedEntityIds(new Set(preview.entities.map((e: CodeGenEntity) => e.id)));
    setSelectedPolicyIds(new Set(preview.policies.map((p: CodeGenPolicyOutline) => p.rule_id)));
  }, [job.preview]);

  // When job completes, fetch the artifact manifest from the result.
  useEffect(() => {
    const status = job.status?.status;
    const id = job.jobId;
    if (status !== "completed" || !id) return;
    if (lastResultJobIdRef.current === id) return;
    lastResultJobIdRef.current = id;
    void (async () => {
      try {
        const result = (await fetchCodeGenResult(id)) as {
          stages?: Array<{ stage: string; result?: { files?: ArtifactFile[] } }>;
        };
        const finalize = result.stages?.find((s) => s.stage === "finalize_bundle");
        const files = finalize?.result?.files || [];
        setArtifactFiles(files);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to load artifact manifest.");
      }
    })();
  }, [job.status?.status, job.jobId]);

  const toggleEntity = (id: string) => {
    setSelectedEntityIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePolicy = (id: string) => {
    setSelectedPolicyIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const mapNodeJson: Record<string, unknown> | null = mapGraph
    ? (mapGraph as unknown as Record<string, unknown>)
    : null;

  const handleOpenPreview = async () => {
    setPreviewOpen(true);
    if (causalChoices.length === 0) {
      setPreviewText("No causal source documents resolved from the selected components.");
      return;
    }
    setPreviewLoading(true);
    try {
      const text = await aggregateCausalText(causalChoices);
      setPreviewText(text || "(empty — selected sources have no extractable text)");
    } catch (err) {
      setPreviewText(err instanceof Error ? err.message : "Failed to build preview.");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleCopyPreview = async () => {
    try {
      await navigator.clipboard.writeText(previewText);
    } catch {
      // Best-effort; clipboard may be unavailable.
    }
  };

  const formatMissingMessage = (action: string, items: readonly string[]) =>
    `Cannot ${action} yet. Required steps:\n• ${items.join("\n• ")}`;

  const handlePreview = async () => {
    setActionError("");
    if (missingRequirements && missingRequirements.length > 0) {
      setActionError(formatMissingMessage("preview", missingRequirements));
      return;
    }
    if (causalChoices.length === 0) {
      setActionError("No causal sources resolved from the selected components above.");
      return;
    }

    const causalData = await aggregateCausalText(causalChoices);
    if (!causalData) {
      setActionError("Selected causal sources have no extractable text.");
      return;
    }
    if (selectedMetrics.length === 0) {
      setActionError(
        "Select at least one metric in the metric section before previewing.",
      );
      return;
    }

    try {
      const newJobId = await job.start({
        causalData,
        mapNodeJson,
        selectedMetrics,
        model,
      });
      await job.runPreview(newJobId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Preview failed.");
    }
  };

  const handleGenerate = async () => {
    setActionError("");
    if (missingRequirements && missingRequirements.length > 0) {
      setActionError(formatMissingMessage("generate", missingRequirements));
      return;
    }
    if (!job.jobId) {
      setActionError("No active job. Run preview first.");
      return;
    }
    if (selectedEntityIds.size === 0) {
      setActionError("Select at least one entity.");
      return;
    }
    try {
      const causalData = await aggregateCausalText(causalChoices);
      // Policy stage needs the FULL entity universe so policies can reference
      // any preview entity even if the user unchecked it in the workspace's
      // entity list. The user's checkbox subset stays advisory for now.
      const fullEntityList =
        job.preview?.entities.map((e) => ({ id: e.id })) ?? [];
      const refinedJobId = await job.start({
        causalData,
        mapNodeJson,
        selectedEntities: fullEntityList,
        selectedPolicies: Array.from(selectedPolicyIds).map((rule_id) => ({ rule_id })),
        selectedMetrics,
        model,
      });
      await job.generate(refinedJobId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Generate failed.");
    }
  };

  const handleCancel = async () => {
    try {
      await job.cancel();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Cancel failed.");
    }
  };

  const stageHistory = job.status?.stageHistory ?? [];
  const completedStages = job.status?.completedStages ?? [];
  const remainingStages = job.status?.remainingStages ?? null;
  const currentStage = job.status?.currentStage ?? null;
  const stageMessage = job.status?.stageMessage ?? "";
  const jobStatusLabel = job.status?.status ?? "—";

  const causalCount = causalChoices.length;

  return (
    <section className="rounded-xl border border-neutral-700 bg-neutral-900/60 p-4 md:p-6">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-bold text-neutral-100 md:text-2xl">Generate simulation code</h2>
        <p className="text-xs text-neutral-400">
          {job.jobId ? `Job: ${job.jobId}` : "No active job"}
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-neutral-800 bg-neutral-950/40 px-3 py-2 text-sm text-neutral-300">
        <span>
          <span className="font-semibold text-neutral-100">{causalCount}</span> causal source
          {causalCount === 1 ? "" : "s"}
        </span>
        <span className="text-neutral-600">·</span>
        <span>{mapStatus}</span>
        <span className="text-neutral-600">·</span>
        <span>
          model{" "}
          <span className="font-mono text-neutral-100">
            {model.trim() || "(env default)"}
          </span>
        </span>
        <button
          type="button"
          onClick={() => void handleOpenPreview()}
          className="ml-auto rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-200 transition hover:border-sky-500 hover:text-sky-200"
        >
          Preview prompt input
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void handlePreview()}
          disabled={isRunning}
          className="rounded-md border border-sky-600 bg-sky-500/10 px-4 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {job.isPreviewing ? "Previewing..." : job.isStarting ? "Starting..." : "Preview entities"}
        </button>

        <button
          type="button"
          onClick={() => void handleGenerate()}
          disabled={!job.preview || job.isResuming || job.isPolling}
          className="rounded-md border border-emerald-700 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {job.isResuming ? "Resuming..." : job.isPolling ? "Generating..." : "Generate"}
        </button>

        <button
          type="button"
          onClick={() => void handleCancel()}
          disabled={!job.jobId}
          className="rounded-md border border-red-800 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-300 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Cancel
        </button>

        <button
          type="button"
          onClick={() => {
            setActionError("");
            setArtifactFiles([]);
            lastResultJobIdRef.current = null;
            job.reset();
          }}
          disabled={isRunning}
          className="rounded-md border border-neutral-700 bg-neutral-800/40 px-4 py-2 text-sm font-semibold text-neutral-200 transition hover:bg-neutral-700/40 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Reset
        </button>
      </div>

      {actionError ? (
        <p className="mt-3 whitespace-pre-line rounded-md border border-red-800/70 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {actionError}
        </p>
      ) : null}
      {job.error ? (
        <p className="mt-3 rounded-md border border-red-800/70 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {job.error}
        </p>
      ) : null}

      {job.preview ? (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
            <p className="mb-2 text-sm font-semibold text-neutral-200">
              Entities ({job.preview.entities.length})
            </p>
            <ul className="max-h-72 overflow-y-auto">
              {job.preview.entities.map((entity) => (
                <li key={entity.id}>
                  <label className="flex items-center justify-between gap-2 border-b border-neutral-800/70 px-1 py-1 text-sm last:border-b-0">
                    <span className="flex items-center gap-2 text-neutral-100">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                        checked={selectedEntityIds.has(entity.id)}
                        onChange={() => toggleEntity(entity.id)}
                        disabled={isRunning}
                      />
                      <span>
                        {entity.label}{" "}
                        <span className="text-xs text-neutral-500">[{entity.type}]</span>
                      </span>
                    </span>
                    <span className="text-xs font-semibold text-neutral-400">×{entity.frequency}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
            <p className="mb-2 text-sm font-semibold text-neutral-200">
              Policies ({job.preview.policies.length})
            </p>
            <ul className="max-h-72 overflow-y-auto">
              {job.preview.policies.map((policy) => (
                <li key={policy.rule_id}>
                  <label className="flex flex-col gap-1 border-b border-neutral-800/70 px-1 py-2 text-sm last:border-b-0">
                    <span className="flex items-center gap-2 text-neutral-100">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                        checked={selectedPolicyIds.has(policy.rule_id)}
                        onChange={() => togglePolicy(policy.rule_id)}
                        disabled={isRunning}
                      />
                      <span className="font-semibold">{policy.label}</span>
                    </span>
                    <span className="ml-6 text-xs text-neutral-400">
                      {policy.target_entity_id}.{policy.target_method} on {policy.trigger}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-semibold text-neutral-200">Stage log</p>
          <p className="text-xs text-neutral-500">
            status: <span className="text-neutral-300">{jobStatusLabel}</span>
            {currentStage ? <> · stage: <span className="text-neutral-300">{currentStage}</span></> : null}
            {remainingStages !== null ? <> · remaining: {String(remainingStages)}</> : null}
          </p>
        </div>
        {stageMessage ? (
          <p className="mb-2 text-xs text-neutral-400">{stageMessage}</p>
        ) : null}
        {stageHistory.length === 0 ? (
          <p className="text-xs text-neutral-500">No stages run yet.</p>
        ) : (
          <ul className="max-h-48 overflow-y-auto font-mono text-xs">
            {stageHistory.map((entry, idx) => (
              <li
                key={`${entry.stage}-${String(idx)}`}
                className={
                  completedStages.includes(entry.stage)
                    ? "py-0.5 text-emerald-300"
                    : "py-0.5 text-neutral-300"
                }
              >
                <span className="mr-2 text-neutral-500">[{entry.stage}]</span>
                {entry.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      {(() => {
        const id = job.jobId;
        if (!id || artifactFiles.length === 0) return null;
        return (
          <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
            <p className="mb-2 text-sm font-semibold text-neutral-200">
              Artifacts ({artifactFiles.length})
            </p>
            <ul className="max-h-60 overflow-y-auto font-mono text-xs">
              {artifactFiles.map((file) => (
                <li key={file.path} className="py-0.5">
                  <a
                    className="text-sky-300 underline hover:text-sky-200"
                    href={artifactUrl(id, file.path)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {file.path}
                  </a>
                  {file.kind ? <span className="ml-2 text-neutral-500">[{file.kind}]</span> : null}
                </li>
              ))}
            </ul>
          </div>
        );
      })()}

      {previewOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setPreviewOpen(false)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-neutral-700 bg-neutral-950 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
              <p className="text-sm font-semibold text-neutral-100">
                Resolved causal prompt input
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleCopyPreview()}
                  disabled={previewLoading || !previewText}
                  className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-200 transition hover:border-sky-500 hover:text-sky-200 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Copy
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewOpen(false)}
                  className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-200 transition hover:border-red-500 hover:text-red-200"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {previewLoading ? (
                <p className="text-xs text-neutral-400">Building preview…</p>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-xs text-neutral-100">
                  {previewText}
                </pre>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
