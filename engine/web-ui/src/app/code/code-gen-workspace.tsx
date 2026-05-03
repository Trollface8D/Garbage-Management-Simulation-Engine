"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

type CodeGenWorkflowState = {
  status: string | null;
  statusLabel: string;
  isRunning: boolean;
  isActivelyProcessing: boolean;
  canCancel: boolean;
  primaryActionLabel: string;
  primaryActionTitle?: string;
  primaryActionDisabled: boolean;
  showProgressBar: boolean;
  policyConfirmReady: boolean;
};

function buildCodeGenWorkflowState({
  jobStatus,
  isStarting,
  isPreviewing,
  isResuming,
  isPolling,
  isActivelyProcessing,
  shouldShowResumeLabel,
  completedStages,
}: {
  jobStatus: string | null;
  isStarting: boolean;
  isPreviewing: boolean;
  isResuming: boolean;
  isPolling: boolean;
  isActivelyProcessing: boolean;
  shouldShowResumeLabel: boolean;
  completedStages: number;
}): CodeGenWorkflowState {
  const isPausedLike = jobStatus === "paused" || jobStatus === "partial";
  const isRunning =
    isStarting ||
    isPreviewing ||
    isResuming ||
    isPolling ||
    jobStatus === "running" ||
    jobStatus === "queued";
  const statusLabel = jobStatus || "—";

  return {
    status: jobStatus,
    statusLabel,
    isRunning,
    isActivelyProcessing,
    canCancel: isRunning,
    primaryActionLabel: isPreviewing
      ? "Generating…"
      : isStarting
        ? "Starting…"
        : isPausedLike && shouldShowResumeLabel
          ? "Resume"
          : "Generate",
    primaryActionTitle: isPausedLike && shouldShowResumeLabel
      ? undefined
      : isActivelyProcessing
        ? "Generation is running…"
        : undefined,
    primaryActionDisabled: isActivelyProcessing,
    showProgressBar: isRunning || (typeof jobStatus === "string" && completedStages > 0),
    policyConfirmReady: false,
  };
}

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
  selectedPolicyIds: Set<string>;
  onPolicyIdsChange: (ids: Set<string>) => void;
  manualPolicies: CodeGenPolicyOutline[];
  onManualPoliciesChange: (policies: CodeGenPolicyOutline[]) => void;
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
  selectedPolicyIds,
  onPolicyIdsChange,
  manualPolicies,
  onManualPoliciesChange,
}: Props) {
  const job = useCodeGenJob(componentId);
  const [causalChoices, setCausalChoices] = useState<CausalChoice[]>([]);
  const [mapGraph, setMapGraph] = useState<MapGraphPayload | null>(null);
  const [mapStatus, setMapStatus] = useState<string>("no map selected");
  const [selectedEntityIds, setSelectedEntityIds] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string>("");
  const [previewText, setPreviewText] = useState<string>("");
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

  const workflow = useMemo(
    () =>
      buildCodeGenWorkflowState({
        jobStatus: job.status?.status ?? null,
        isStarting: job.isStarting,
        isPreviewing: job.isPreviewing,
        isResuming: job.isResuming,
        isPolling: job.isPolling,
        isActivelyProcessing: job.isActivelyProcessing,
        shouldShowResumeLabel: Boolean(job.status?.canResume),
        completedStages: job.status?.completedStages?.length ?? 0,
      }),
    [
      artifactFiles.length,
      job.isActivelyProcessing,
      job.isPolling,
      job.isPreviewing,
      job.isResuming,
      job.isStarting,
      job.jobId,
      job.preview,
      job.status,
    ],
  );

  useEffect(() => {
    onRunningChange?.(workflow.isRunning);
  }, [workflow.isRunning, onRunningChange]);

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

  // When a new preview arrives, auto-select all derived policies. On page
  // reload, job.preview is null so persisted selectedPolicyIds survive.
  useEffect(() => {
    const preview = job.preview;
    if (!preview) return;
    onPolicyIdsChange(new Set(preview.policies.map((p: CodeGenPolicyOutline) => p.rule_id)));
  }, [job.preview, onPolicyIdsChange]);

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

  const mapNodeJson: Record<string, unknown> | null = mapGraph
    ? (mapGraph as unknown as Record<string, unknown>)
    : null;

  const formatMissingMessage = (action: string, items: readonly string[]) =>
    `Cannot ${action} yet. Required steps:\n• ${items.join("\n• ")}`;

  const handleGenerate = async (
    selectedPolicyIdsOverride?: string[],
    manualPoliciesOverride?: CodeGenPolicyOutline[],
  ) => {
    setActionError("");
    if (missingRequirements && missingRequirements.length > 0) {
      setActionError(formatMissingMessage("generate", missingRequirements));
      return;
    }
    if (pageEntities.length === 0) {
      setActionError("Add at least one entity in the entity section above before generating.");
      return;
    }
    if (pageEntities.length === 0) {
      setActionError("Add at least one entity in the entity section above before generating.");
      return;
    }
    try {
      const nextSelectedPolicyIds = selectedPolicyIdsOverride ?? Array.from(selectedPolicyIds);
      const nextManualPolicies = manualPoliciesOverride ?? manualPolicies;
      onPolicyIdsChange(new Set(nextSelectedPolicyIds));
      onManualPoliciesChange([...nextManualPolicies]);

      // Build payload entries: selected rule_id objects + manual policy objects
      const selectedPolicyPayload = [
        ...nextSelectedPolicyIds.map((rule_id) => ({ rule_id })),
        ...nextManualPolicies,
      ];

      // If no active job, create one and start running immediately.
      if (!job.jobId) {
        if (causalChoices.length === 0) {
          setActionError("No causal sources resolved from the selected components.");
          return;
        }
        const causalData = await aggregateCausalText(causalChoices);
        await job.start({
          causalData,
          mapNodeJson,
          selectedEntities: Array.from(selectedEntityIds).map((id) => ({ id })),
          selectedPolicies: selectedPolicyPayload,
          selectedMetrics,
          userEntityList: pageEntities,
          previewOnly: false,
        });
        return;
      } else {
        // Reuse the existing job and resume with overrides
        await job.generate(job.jobId, {
          selectedEntities: Array.from(selectedEntityIds).map((id) => ({ id })),
          selectedPolicies: selectedPolicyPayload,
          selectedMetrics,
          userEntityList: pageEntities,
        });
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Generate failed.");
    }
  };

  const handleCancel = async () => {
    try {
      await job.pause();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Pause failed.");
    }
  };

  const handleEditInput = async () => {
    // If actively processing, show confirmation and cancel the job first
    if (workflow.isRunning) {
      const shouldCancel = window.confirm(
        "This will cancel the active job. Discard progress and reset inputs?\n\nContinue?",
      );
      if (!shouldCancel) return;
      try {
        await job.cancel();
        // Wait briefly for cancel to propagate through polling
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to cancel job.");
        return;
      }
    } else if (artifactFiles.length > 0) {
      // If not running but have artifacts, show confirmation
      const shouldDiscard = window.confirm(
        `Edit Input will discard ${artifactFiles.length} artifact(s).\n\nContinue?`,
      );
      if (!shouldDiscard) return;
    } else if (job.preview || job.jobId) {
      // Preview loaded / awaiting confirmation — warn before discarding
      const shouldDiscard = window.confirm(
        "Edit Input will discard the current preview and policy outline.\n\nContinue?",
      );
      if (!shouldDiscard) return;
    }

    setActionError("");
    onArtifactFilesChange([]);
    onPolicyIdsChange(new Set());
    onManualPoliciesChange([]);
    lastResultJobIdRef.current = null;
    setPreviewText("");
    setWasRestoredFromPersistence(false);
    clearAllPersistence(componentId);
    job.reset();
  };

  const completedStages = job.status?.completedStages ?? [];
  const remainingStages = job.status?.remainingStages ?? null;
  const currentStage = job.status?.currentStage ?? null;
  const stageMessage = job.status?.stageMessage ?? "";

  const causalCount = causalChoices.length;
  const statusValue = job.status?.status;
  const isPaused = statusValue === "paused";

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
          {isPaused && (
            <p className="text-xs rounded-md bg-sky-500/20 border border-sky-600/50 px-2 py-1 text-sky-200">
              ⏸ Paused — click Resume to continue
            </p>
          )}
          {job.status?.status === "cancelled" && (
            <p className="text-xs rounded-md bg-amber-500/20 border border-amber-600/50 px-2 py-1 text-amber-200">
              ⚠ Job cancelled — click Edit Input to reset
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
        <span className="ml-auto" />
      </div>

      {/* One entrypoint: "Generate" runs the State 1 / 1b preview first; the
          confirm step is rendered below as a green button next to the
          entity / policy preview lists. Cancel + Edit Input stay handy. */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void handleGenerate()}
          disabled={workflow.primaryActionDisabled}
          title={workflow.primaryActionTitle}
          className="rounded-md border border-sky-600 bg-sky-500/10 px-4 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {workflow.primaryActionLabel}
        </button>

        <button
          type="button"
          onClick={() => void handleCancel()}
          disabled={!workflow.canCancel}
          className="rounded-md border border-red-800 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-300 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Pause
        </button>

        <button
          type="button"
          onClick={() => void handleEditInput()}
          disabled={false}
          className="rounded-md border border-neutral-700 bg-neutral-800/40 px-4 py-2 text-sm font-semibold text-neutral-200 transition hover:bg-neutral-700/40 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Edit Input
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
        const showBar = workflow.showProgressBar;
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
                  workflow.status === "failed"
                    ? "bg-red-500"
                    : workflow.status === "cancelled"
                      ? "bg-amber-500"
                      : workflow.status === "completed"
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
          jobStatus={job.status?.status || (job.preview ? "partial" : "—")}
          currentStage={currentStage}
          stageMessage={stageMessage}
          completedStages={completedStages}
          remainingStages={remainingStages}
          nextStage={job.status?.nextStage ?? null}
          cancelRequested={job.status?.cancelRequested}
          isActive={workflow.isRunning}
          initialSelectedPolicyIds={selectedPolicyIds}
          initialManualPolicies={manualPolicies}
          onProceedRequested={(selectedPolicies, manualPoliciesDraft) =>
            void handleGenerate(selectedPolicies, manualPoliciesDraft)
          }
          policyConfirmReady={workflow.policyConfirmReady}
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

    </section>
  );
}
