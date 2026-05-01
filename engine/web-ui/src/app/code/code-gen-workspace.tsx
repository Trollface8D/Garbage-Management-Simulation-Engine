"use client";

import { useEffect, useRef, useState } from "react";
import {
  artifactUrl,
  fetchCodeGenResult,
  type CodeGenEntity,
  type CodeGenPolicyOutline,
  type SuggestedMetric,
  type UserEntityItem,
} from "@/lib/code-gen-api-client";
import { useCodeGenJob } from "@/lib/use-code-gen-job";
import CodeGenStageLogPanel from "@/app/code/code-gen-stage-log-panel";
import {
  loadCausalArtifactsForItem,
  loadCausalSourceItems,
} from "@/lib/pm-storage";
import {
  saveWorkspaceState,
  loadWorkspaceState,
  clearAllPersistence,
  type PersistedWorkspaceState,
} from "@/lib/use-codegen-persistence";
import type { MapGraphPayload } from "@/lib/map-types";
import ModelPicker from "@/app/components/model-picker";

type CausalChoice = {
  id: string;
  componentId: string;
  label: string;
};

export type ArtifactFile = {
  path: string;
  kind?: string;
  iterId?: string;
};

export type CausalSourceRef = { projectId: string; componentId: string };

type Props = {
  componentId: string;
  causalSourceRefs: CausalSourceRef[];
  selectedMapId?: string | null;
  selectedMapLabel?: string | null;
  model: string;
  onModelChange?: (model: string) => void;
  selectedMetrics: SuggestedMetric[];
  /** Page-level entity list — source of truth for codegen. Passed as userEntityList to backend. */
  pageEntities: UserEntityItem[];
  missingRequirements?: readonly string[];
  artifactFiles: ArtifactFile[];
  onArtifactFilesChange: (files: ArtifactFile[]) => void;
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
  // Codegen prompt input is only the `raw_extraction` field from each causal
  // artifact — the original source/transcript text is intentionally omitted
  // (too noisy, the structured relations are what State 1/1b actually need).
  const blocks: string[] = [];
  for (const item of items) {
    let extractionBlock = "";
    try {
      const artifacts = await loadCausalArtifactsForItem(item.id);
      const raw = artifacts.raw_extraction || [];
      if (raw.length > 0) {
        extractionBlock = `# ${item.label}\n${JSON.stringify(raw, null, 2)}`;
      }
    } catch {
      extractionBlock = "";
    }
    if (extractionBlock) {
      blocks.push(extractionBlock);
    }
  }
  return blocks.join("\n\n---\n\n").trim();
}

export default function CodeGenWorkspace({
  componentId,
  causalSourceRefs,
  selectedMapId,
  selectedMapLabel,
  model,
  onModelChange,
  selectedMetrics,
  pageEntities,
  missingRequirements,
  artifactFiles,
  onArtifactFilesChange,
  onRunningChange,
  onJobIdChange,
}: Props) {
  const job = useCodeGenJob(componentId);
  const [causalChoices, setCausalChoices] = useState<CausalChoice[]>([]);
  const [mapGraph, setMapGraph] = useState<MapGraphPayload | null>(null);
  const [mapStatus, setMapStatus] = useState<string>("no map selected");
  const [selectedEntityIds, setSelectedEntityIds] = useState<Set<string>>(new Set());
  const [selectedPolicyIds, setSelectedPolicyIds] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string>("");
  const [previewOpen, setPreviewOpen] = useState<boolean>(false);
  const [previewText, setPreviewText] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const [wasRestoredFromPersistence, setWasRestoredFromPersistence] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const lastResultJobIdRef = useRef<string | null>(null);

  const pageEntityIdsSignature = pageEntities.map((entity) => entity.id).join("\u0000");

  // Restore persisted workspace state on mount
  useEffect(() => {
    const persisted = loadWorkspaceState(componentId);
    if (persisted) {
      setCausalChoices(persisted.causalChoices);
      setMapGraph(persisted.mapGraph);
      setMapStatus(persisted.mapStatus);
      setSelectedEntityIds(new Set(persisted.selectedEntityIds));
      setSelectedPolicyIds(new Set(persisted.selectedPolicyIds));
      setPreviewText(persisted.previewText);
      setWasRestoredFromPersistence(true);
    }
    setIsInitialized(true);
  }, [componentId]);

  // Persist workspace state whenever it changes (skip initial setup phase)
  useEffect(() => {
    if (!isInitialized || wasRestoredFromPersistence) return;
    const state: PersistedWorkspaceState = {
      version: 1,
      causalChoices,
      mapGraph,
      mapStatus,
      selectedEntityIds: Array.from(selectedEntityIds),
      selectedPolicyIds: Array.from(selectedPolicyIds),
      artifactFiles,
      previewText,
    };
    saveWorkspaceState(componentId, state);
  }, [
    componentId,
    isInitialized,
    wasRestoredFromPersistence,
    causalChoices,
    mapGraph,
    mapStatus,
    selectedEntityIds,
    selectedPolicyIds,
    artifactFiles,
    previewText,
  ]);

  // Clear restoration flag and enable persistence after initial setup
  useEffect(() => {
    if (wasRestoredFromPersistence && isInitialized) {
      const timer = window.setTimeout(() => {
        setWasRestoredFromPersistence(false);
      }, 500);
      return () => window.clearTimeout(timer);
    }
  }, [wasRestoredFromPersistence, isInitialized]);

  useEffect(() => {
    setSelectedEntityIds(new Set(pageEntities.map((entity) => entity.id)));
  }, [pageEntityIdsSignature]);

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

  // When preview arrives, auto-select all derived policies. The user can
  // de-select inside the stage log (state1b_policy_outline expansion) before
  // hitting Resume; the refined selection is shipped to the resume endpoint.
  useEffect(() => {
    const preview = job.preview;
    if (!preview) return;
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
        onArtifactFilesChange(files);
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
        previewOnly: true,
        userEntityList: pageEntities,
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
    if (pageEntities.length === 0) {
      setActionError("Add at least one entity in the entity section above before generating.");
      return;
    }
    try {
      // Reuse the existing job so its preview checkpoints (state1, state1b)
      // are honored — the worker resumes from the next unfinished stage.
      // Refined entity/policy/metric selections override the saved manifest
      // server-side via the resume body so later stages see the user's
      // confirmed inputs without spawning a fresh job.
      await job.generate(job.jobId, {
        selectedEntities: Array.from(selectedEntityIds).map((id) => ({ id })),
        selectedPolicies: Array.from(selectedPolicyIds).map((rule_id) => ({ rule_id })),
        selectedMetrics,
        userEntityList: pageEntities,
      });
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

  const completedStages = job.status?.completedStages ?? [];
  const remainingStages = job.status?.remainingStages ?? null;
  const currentStage = job.status?.currentStage ?? null;
  const stageMessage = job.status?.stageMessage ?? "";

  const causalCount = causalChoices.length;

  return (
    <section className="rounded-xl border border-neutral-700 bg-neutral-900/60 p-4 md:p-6">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-bold text-neutral-100 md:text-2xl">Generate simulation code</h2>
        <div className="flex items-center gap-2">
          {wasRestoredFromPersistence && (
            <p className="text-xs rounded-md bg-emerald-500/20 border border-emerald-600/50 px-2 py-1 text-emerald-200">
              ✓ Restored from previous session
            </p>
          )}
          <p className="text-xs text-neutral-400">
            {job.jobId ? `Job: ${job.jobId}` : "No active job"}
          </p>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-neutral-800 bg-neutral-950/40 px-3 py-2 text-sm text-neutral-300">
        <span>
          <span className="font-semibold text-neutral-100">{causalCount}</span> causal source
          {causalCount === 1 ? "" : "s"}
        </span>
        <span className="text-neutral-600">·</span>
        <span>{mapStatus}</span>
        <span className="text-neutral-600">·</span>
        <button
          type="button"
          onClick={() => void handleOpenPreview()}
          className="ml-auto rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-200 transition hover:border-sky-500 hover:text-sky-200"
        >
          Preview prompt input
        </button>
      </div>

      {/* One entrypoint: "Generate" runs the State 1 / 1b preview first; the
          confirm step is rendered below as a green button next to the
          entity / policy preview lists. Cancel + Reset stay handy. */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void handlePreview()}
          disabled={isRunning || !!job.preview}
          title={
            job.preview
              ? "Preview already loaded — confirm or reset below."
              : undefined
          }
          className="rounded-md border border-sky-600 bg-sky-500/10 px-4 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {job.isPreviewing
            ? "Previewing entities…"
            : job.isStarting
              ? "Starting…"
              : job.preview
                ? "Preview loaded ↓"
                : "Generate"}
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
            onArtifactFilesChange([]);
            lastResultJobIdRef.current = null;
            setCausalChoices([]);
            setSelectedEntityIds(new Set());
            setSelectedPolicyIds(new Set());
            setPreviewText("");
            setWasRestoredFromPersistence(false);
            clearAllPersistence(componentId);
            job.reset();
          }}
          disabled={isRunning}
          className="rounded-md border border-neutral-700 bg-neutral-800/40 px-4 py-2 text-sm font-semibold text-neutral-200 transition hover:bg-neutral-700/40 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Reset
        </button>
        <div className="ml-auto flex items-center gap-2">
        <ModelPicker value={model} onChange={(v) => onModelChange?.(v)} label="model" placeholder="default from .env" />
        </div>
      </div>

      {(() => {
        const completed = job.status?.completedStages?.length ?? 0;
        const remaining = job.status?.remainingStages ?? null;
        const total = remaining !== null ? completed + remaining : null;
        const percent = total && total > 0 ? Math.round((completed / total) * 100) : 0;
        const showBar = isRunning || (typeof jobStatus === "string" && completed > 0);
        if (!showBar) return null;
        return (
          <div className="mt-3 rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
            <div className="mb-1 flex items-baseline justify-between text-xs text-neutral-400">
              <span>
                Progress:{" "}
                <span className="text-neutral-200">
                  {String(completed)}/{total !== null ? String(total) : "?"} stages
                </span>
                {currentStage ? (
                  <span className="ml-2 font-mono text-neutral-300">{currentStage}</span>
                ) : null}
              </span>
              <span className="font-mono text-neutral-300">{String(percent)}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-md bg-neutral-800">
              <div
                className={`h-full rounded-md transition-[width] duration-300 ${
                  jobStatus === "failed"
                    ? "bg-red-500"
                    : jobStatus === "cancelled"
                      ? "bg-amber-500"
                      : jobStatus === "completed"
                        ? "bg-emerald-500"
                        : "bg-sky-500"
                }`}
                style={{ width: `${String(percent)}%` }}
              />
            </div>
          </div>
        );
      })()}

      {(() => {
        // Dedup error display: actionError (UI-side validation / catch) wins
        // over job.error (hook-side); show a single red box instead of two.
        const errMsg = actionError || job.error || "";
        if (!errMsg) return null;
        return (
          <p className="mt-3 whitespace-pre-line rounded-md border border-red-800/70 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {errMsg}
          </p>
        );
      })()}

      <div className="mt-6">
        <CodeGenStageLogPanel
          jobId={job.jobId}
          jobStatus={jobStatus || (job.preview ? "partial" : "—")}
          currentStage={currentStage}
          stageMessage={stageMessage}
          completedStages={completedStages}
          canResume={job.status?.canResume}
          remainingStages={remainingStages}
          nextStage={job.status?.nextStage ?? null}
          resumeDisabledReason={job.status?.resumeDisabledReason ?? null}
          cancelRequested={job.status?.cancelRequested}
          isActive={isRunning}
          onPreviewRequested={() => void handlePreview()}
          previewDisabled={
            (missingRequirements && missingRequirements.length > 0) || pageEntities.length === 0
          }
          previewDisabledReason={
            missingRequirements && missingRequirements.length > 0
              ? formatMissingMessage("preview", missingRequirements)
              : pageEntities.length === 0
                ? "Add at least one entity above before previewing."
                : undefined
          }
          onResumeRequested={() => void handleGenerate()}
          selectedPolicyIds={selectedPolicyIds}
          onTogglePolicy={togglePolicy}
          policyConfirmReady={!!job.preview && !isRunning && !job.isResuming}
        />
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
                <pre className="whitespace-pre-wrap wrap-break-word font-mono text-xs text-neutral-100">
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
