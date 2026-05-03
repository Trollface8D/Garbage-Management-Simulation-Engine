"use client";

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  cancelCodeGenJob,
  fetchCodeGenCheckpointDetail,
  fetchCodeGenCheckpoints,
  fetchCodeGenStatus,
  rollbackCodeGenJob,
  type CodeGenCheckpointDetail,
  type CodeGenPolicyOutline,
} from "@/lib/code-gen-api-client";

type StageEntry = {
  key: string;
  label: string;
  description: string;
};

const STAGE_ENTRIES: StageEntry[] = [
  {
    key: "state1_entity_list",
    label: "Entities",
    description: "Curate the entity list that drives the simulation.",
  },
  {
    key: "state1b_policy_outline",
    label: "Policies",
    description:
      "Policy rule outline (trigger, target entity, method) — the policies that will be enforced in the simulation.",
  },
  {
    key: "state1c_entity_dependencies",
    label: "Dependencies",
    description: "Inter-entity dependency edges used to order codegen.",
  },
  {
    key: "state2_code_entity_object",
    label: "Entity classes",
    description: "Iterative code generation for each entity class.",
  },
  {
    key: "state2v_validate_protocol",
    label: "Validate protocol",
    description: "Static checks that entity classes meet the runtime protocol.",
  },
  {
    key: "state3_code_environment",
    label: "Environment",
    description: "Simulation environment glue (clock, registries, world).",
  },
  {
    key: "state4_code_policy",
    label: "Policy modules",
    description: "Iterative code generation for each policy rule.",
  },
  {
    key: "state4v_validate_policy",
    label: "Validate policies",
    description: "Static checks for the generated policy modules.",
  },
  {
    key: "finalize_bundle",
    label: "Finalize",
    description: "Bundle artifacts (entity_list, manifest, code) for download.",
  },
];

const NO_ROLLBACK_STAGES = new Set<string>();

type StageStatus = "pending" | "running" | "done" | "cancelled" | "failed" | "awaiting_confirmation";

function shortStageName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/^code_gen\//, "");
}

function stageStatus(
  stageKey: string,
  currentStage: string,
  completed: Set<string>,
  jobStatus: string,
  awaitingConfirmationStage?: string | null,
): StageStatus {
  // Gate is on state1c but confirmation UX lives on state1b (the policy review stage).
  // Show awaiting_confirmation on state1b so the user knows to act there.
  if (awaitingConfirmationStage === "state1c_entity_dependencies" && stageKey === "state1b_policy_outline") {
    return "awaiting_confirmation";
  }
  if (completed.has(stageKey)) return "done";
  // Keep state 1/1b visible as running during preview and partial phases
  // until they're actually marked completed (not just while preview is in-flight).
  // This ensures the user sees continuous progress, not a flicker to pending.
  if (
    (jobStatus === "previewing" || jobStatus === "partial") &&
    (stageKey === "state1_entity_list" || stageKey === "state1b_policy_outline")
  ) {
    return "running";
  }
  if (currentStage === stageKey) {
    if (jobStatus === "cancelled") return "cancelled";
    if (jobStatus === "failed") return "failed";
    return "running";
  }
  return "pending";
}

function statusDot(status: StageStatus): { label: string; className: string } {
  switch (status) {
    case "done":
      return { label: "✓", className: "bg-emerald-500 text-neutral-900" };
    case "running":
      return { label: "…", className: "bg-sky-500 text-neutral-900 animate-pulse" };
    case "awaiting_confirmation":
      return { label: "?", className: "bg-yellow-400 text-neutral-900 animate-pulse" };
    case "cancelled":
      return { label: "■", className: "bg-amber-500 text-neutral-900" };
    case "failed":
      return { label: "!", className: "bg-red-500 text-neutral-50" };
    default:
      return { label: "·", className: "bg-neutral-700 text-neutral-400" };
  }
}

export type CodeGenStageLogProps = {
  jobId: string | null;
  jobStatus: string;
  currentStage: string | null | undefined;
  stageMessage: string | undefined;
  completedStages?: string[];
  remainingStages?: number | null;
  nextStage?: string | null;
  cancelRequested?: boolean;
  awaitingConfirmationStage?: string | null;
  isActive: boolean;
  onStatusUpdate?: (message: string) => void;
  initialSelectedPolicyIds?: Set<string>;
  initialManualPolicies?: CodeGenPolicyOutline[];
  onProceedRequested?: (selectedPolicies: string[], manualPolicies: CodeGenPolicyOutline[]) => void;
  onResumeRequested?: () => void;
  onResumeWithPolicies?: (selectedPolicies: string[], manualPolicies: CodeGenPolicyOutline[]) => void;
  onConfirmStage?: (stage: string) => void;
  policyConfirmReady?: boolean;
};

export default function CodeGenStageLogPanel(props: CodeGenStageLogProps) {
  const {
    jobId,
    jobStatus,
    currentStage,
    stageMessage,
    completedStages,
    remainingStages,
    nextStage,
    cancelRequested,
    awaitingConfirmationStage,
    isActive,
    onStatusUpdate,
    initialSelectedPolicyIds,
    initialManualPolicies,
    onProceedRequested,
    onResumeRequested,
    onResumeWithPolicies,
    onConfirmStage,
    policyConfirmReady,
  } = props;

  const [collapsed, setCollapsed] = useState(false);
  const [userToggled, setUserToggled] = useState(false);
  const [remoteCompleted, setRemoteCompleted] = useState<string[]>([]);
  const [expandedStage, setExpandedStage] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string>("");
  const [actionPending, setActionPending] = useState<boolean>(false);
  const [draftSelectedPolicyIds, setDraftSelectedPolicyIds] = useState<Set<string>>(
    () => new Set(initialSelectedPolicyIds || []),
  );
  const [draftManualPolicies, setDraftManualPolicies] = useState<CodeGenPolicyOutline[]>(() => [
    ...(initialManualPolicies || []),
  ]);
  const [stageDetails, setStageDetails] = useState<
    Record<string, CodeGenCheckpointDetail>
  >({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string>("");
  // Authoritative completed list set after a rollback; overrides the stale prop
  // until the job resumes (at which point live polling takes over again).
  const [completedOverride, setCompletedOverride] = useState<string[] | null>(null);

  const completedSet = useMemo(() => {
    const merged = new Set<string>();
    if (completedOverride !== null) {
      completedOverride.forEach((stage) => merged.add(stage));
    } else {
      (completedStages || []).forEach((stage) => merged.add(stage));
      remoteCompleted.forEach((stage) => merged.add(stage));
    }
    return merged;
  }, [completedStages, remoteCompleted, completedOverride]);

  const shortCurrentStage = shortStageName(currentStage);

  useEffect(() => {
    setDraftSelectedPolicyIds(new Set(initialSelectedPolicyIds || []));
    setDraftManualPolicies([...(initialManualPolicies || [])]);
    setCompletedOverride(null);
  }, [jobId, initialSelectedPolicyIds, initialManualPolicies]);

  // Once the job resumes and becomes active, live polling takes over — drop override.
  useEffect(() => {
    if (isActive) setCompletedOverride(null);
  }, [isActive]);

  useEffect(() => {
    if (!jobId) {
      setRemoteCompleted([]);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await fetchCodeGenCheckpoints(jobId);
        if (!cancelled) {
          setRemoteCompleted(data.completedStages || []);
        }
      } catch {
        // ignore stale id
      }
    };
    void poll();
    if (!isActive) {
      return () => {
        cancelled = true;
      };
    }
    const handle = window.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [jobId, isActive]);

  // When a stage is expanded and its checkpoint exists, fetch the detail.
  // Re-fetch when remoteCompleted gains the stage (so a freshly-finished
  // stage's detail loads once it lands).
  useEffect(() => {
    if (!jobId || !expandedStage) {
      setDetailError("");
      return;
    }
    if (!completedSet.has(expandedStage)) {
      setDetailError("");
      return;
    }
    if (stageDetails[expandedStage]) {
      setDetailError("");
      return;
    }
    let cancelled = false;
    setDetailLoading(expandedStage);
    setDetailError("");
    fetchCodeGenCheckpointDetail(jobId, expandedStage)
      .then((detail) => {
        if (cancelled) return;
        setStageDetails((prev) => ({ ...prev, [expandedStage]: detail }));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDetailError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (cancelled) return;
        setDetailLoading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, expandedStage, completedSet, stageDetails]);

  const handleCancel = useCallback(async () => {
    if (!jobId) return;
    setActionPending(true);
    setActionStatus("Requesting cancel…");
    try {
      await cancelCodeGenJob(jobId);
      setActionStatus(
        "Cancel requested. Worker stops within ~0.5s; in-flight Gemini call abandoned.",
      );
      onStatusUpdate?.("Cancel requested.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionStatus(`Cancel failed: ${message}`);
    } finally {
      setActionPending(false);
    }
  }, [jobId, onStatusUpdate]);

  const handleRollback = useCallback(
    async (stage: string) => {
      if (!jobId) return;
      setActionPending(true);
      setActionStatus(`Rolling back after ${stage}…`);
      try {
        // "after" mode: keep target stage checkpoint (shows "done"), delete only stages after it.
        await rollbackCodeGenJob(jobId, stage, "after");
        // Drop cached details only for stages AFTER target; target artifact is preserved.
        setStageDetails((prev) => {
          const next = { ...prev };
          let found = false;
          for (const key of Object.keys(next)) {
            if (found) delete next[key];
            if (key === stage) found = true;
          }
          return next;
        });
        // Fetch authoritative completed list and override stale prop.
        try {
          const data = await fetchCodeGenStatus(jobId);
          const fresh = data.completedStages || [];
          setRemoteCompleted(fresh);
          setCompletedOverride(fresh);
        } catch {
          /* best-effort */
        }
        setActionStatus(`Rolled back. '${stage}' artifact preserved. Click "Resume & proceed" to continue.`);
        onStatusUpdate?.(`Rollback done after '${stage}'.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionStatus(`Rollback failed: ${message}`);
      } finally {
        setActionPending(false);
      }
    },
    [jobId, onStatusUpdate],
  );

  const hasHistory = completedSet.size > 0;
  const noRemainingStages = typeof remainingStages === "number" && remainingStages <= 0;
  const isFailed = jobStatus === "failed";
  const selectedCount = draftSelectedPolicyIds.size;
  const manualCount = draftManualPolicies.length;
  const canProceed = Boolean(jobId) && !actionPending && !isActive;
  const proceedLabel = isFailed ? "Restart & proceed" : hasHistory ? "Resume & proceed" : "Confirm & proceed";
  const proceedTitle = !jobId
    ? "No prior job to continue."
    : isActive
      ? "Job already running."
      : !canProceed
        ? "Select at least one policy above or add a manual policy."
        : nextStage
          ? `Proceed from next stage: ${nextStage}.`
          : noRemainingStages
            ? "No stages remain; use Restart if you need to regenerate."
            : "Proceed with the selected policies.";

  // Auto-expand on first activity / history.
  useEffect(() => {
    if (userToggled) return;
    if (isActive || hasHistory) setCollapsed(false);
  }, [isActive, hasHistory, userToggled]);

  // Auto-expand state1b when confirmation gate becomes active so user sees confirm UI.
  useEffect(() => {
    if (awaitingConfirmationStage === "state1c_entity_dependencies") {
      setExpandedStage("state1b_policy_outline");
    }
  }, [awaitingConfirmationStage]);

  const isEmptySlate = !jobId && !isActive;

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 text-sm text-neutral-200">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold text-neutral-100">Stage Log</span>
          <span className="rounded-md border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-[11px] uppercase tracking-wider text-neutral-400">
            {jobStatus || "—"}
          </span>
          {cancelRequested ? (
            <span className="rounded-md border border-amber-700 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-amber-200">
              cancel requested
            </span>
          ) : null}
          {awaitingConfirmationStage ? (
            <span className="rounded-md border border-yellow-700 bg-yellow-500/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-yellow-200">
              awaiting confirmation ↓
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setUserToggled(true);
              setCollapsed((prev) => !prev);
            }}
            aria-label={collapsed ? "Expand stage log" : "Collapse stage log"}
            className="inline-flex items-center rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-xs text-neutral-300 transition hover:border-sky-500"
          >
            {collapsed ? "▼" : "▲"}
          </button>
        </div>
      </header>

      {!collapsed ? (
        <div className="mt-3 space-y-2">
          <ol className="space-y-1">
            {STAGE_ENTRIES.map((entry, index) => {
              const baseStatus = stageStatus(entry.key, shortCurrentStage, completedSet, jobStatus, awaitingConfirmationStage);
              const isPolicyCheckpointLoading =
                entry.key === "state1b_policy_outline" &&
                expandedStage === entry.key &&
                completedSet.has(entry.key) &&
                !stageDetails[entry.key];
              const status =
                baseStatus !== "awaiting_confirmation" &&
                ((entry.key === "state1b_policy_outline" && detailLoading === entry.key && baseStatus === "done") ||
                  isPolicyCheckpointLoading)
                  ? "running"
                  : baseStatus;
              const dot = statusDot(status);
              const isExpanded = expandedStage === entry.key;
              const progressMsg =
                shortCurrentStage === entry.key && stageMessage ? stageMessage : "";
              return (
                <li
                  key={entry.key}
                  className={`rounded-md border ${
                    status === "running"
                      ? "border-sky-700 bg-sky-500/5"
                      : status === "awaiting_confirmation"
                        ? "border-yellow-600 bg-yellow-500/5"
                        : status === "done"
                          ? "border-emerald-700/60 bg-emerald-500/5"
                          : status === "failed"
                            ? "border-red-700 bg-red-500/5"
                            : "border-neutral-800 bg-neutral-900/40"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedStage((prev) => (prev === entry.key ? null : entry.key))
                    }
                    className="flex w-full items-center gap-3 px-3 py-2 text-left"
                  >
                    <span className="w-5 shrink-0 text-[11px] text-neutral-500">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span
                      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${dot.className}`}
                    >
                      {dot.label}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-neutral-100">
                        {entry.label}
                      </span>
                      <span className="block wrap-break-word text-[11px] text-neutral-400">
                        {progressMsg || entry.description}
                      </span>
                    </span>
                    <span className="text-[11px] text-neutral-500">
                      {isExpanded ? "▼" : "▶"}
                    </span>
                  </button>

                  {isExpanded ? (
                    <div className="space-y-2 border-t border-neutral-800 px-3 py-2 text-[12px] text-neutral-300">
                      <p className="wrap-break-word text-neutral-400">
                        Stage key: <span className="text-neutral-200">{entry.key}</span>
                      </p>
                      <p className="text-neutral-400">
                        Status: <span className="text-neutral-200">{status}</span>
                      </p>
                      {progressMsg ? (
                        <p className="wrap-break-word text-neutral-300">{progressMsg}</p>
                      ) : null}

                      {status === "awaiting_confirmation" && entry.key === awaitingConfirmationStage ? (
                        <div className="rounded-md border border-yellow-700/60 bg-yellow-500/10 p-3 space-y-2">
                          <p className="text-xs font-semibold text-yellow-200">
                            Waiting for confirmation before running {entry.label}
                          </p>
                          <p className="text-[11px] text-yellow-100/70">
                            All policies and entity classes are ready. Review the stage log above, then confirm to proceed.
                          </p>
                          <button
                            type="button"
                            onClick={() => onConfirmStage?.(entry.key)}
                            disabled={actionPending || isActive === false}
                            className="rounded-md border border-yellow-600 bg-yellow-500/15 px-4 py-2 text-xs font-semibold text-yellow-100 transition hover:bg-yellow-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Confirm & run {entry.label}
                          </button>
                        </div>
                      ) : null}

                      {(status === "done" || (status === "awaiting_confirmation" && entry.key === "state1b_policy_outline")) ? (
                        entry.key === "state1b_policy_outline" ? (
                          <PolicyConfirmBlock
                            detail={stageDetails[entry.key]}
                            loading={detailLoading === entry.key}
                            error={detailLoading === entry.key ? "" : detailError}
                            selectedPolicyIds={draftSelectedPolicyIds}
                            onTogglePolicy={(id) => {
                              setDraftSelectedPolicyIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(id)) next.delete(id);
                                else next.add(id);
                                return next;
                              });
                            }}
                            manualPolicies={draftManualPolicies}
                            onAddManualPolicy={(policy) => {
                              setDraftManualPolicies((prev) =>
                                prev.some((p) => p.rule_id === policy.rule_id) ? prev : [...prev, policy],
                              );
                            }}
                            onRemoveManualPolicy={(rule_id) => {
                              setDraftManualPolicies((prev) => prev.filter((item) => item.rule_id !== rule_id));
                            }}
                            onConfirm={
                              awaitingConfirmationStage
                                ? () => onConfirmStage?.(awaitingConfirmationStage)
                                : hasHistory
                                  ? () => (onResumeWithPolicies
                                    ? onResumeWithPolicies([...draftSelectedPolicyIds], draftManualPolicies)
                                    : onResumeRequested?.())
                                  : () => onProceedRequested?.([...draftSelectedPolicyIds], draftManualPolicies)
                            }
                            proceedLabelOverride={
                              awaitingConfirmationStage
                                ? "Confirm & proceed"
                                : isFailed
                                  ? "Restart & proceed"
                                  : hasHistory
                                    ? "Resume & proceed"
                                    : undefined
                            }
                            confirmReady={policyConfirmReady}
                            isRunning={isActive}
                            isGated={!!awaitingConfirmationStage}
                            actionPending={actionPending}
                          />
                        ) : (
                          <StageDetailBlock
                            detail={stageDetails[entry.key]}
                            loading={detailLoading === entry.key}
                            error={detailLoading === entry.key ? "" : detailError}
                          />
                        )
                      ) : null}

                      <div className="flex flex-wrap items-center gap-2">
                        {status === "done" && !NO_ROLLBACK_STAGES.has(entry.key) ? (
                          <button
                            type="button"
                            onClick={() => handleRollback(entry.key)}
                            disabled={actionPending}
                            className="inline-flex items-center rounded-md border border-amber-700 bg-amber-500/10 px-2 py-1 text-[11px] font-semibold text-amber-200 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                            title="Keep this stage's artifact; delete all stages after it. Resume to re-run from next stage."
                          >
                            Rollback to here
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>

          {actionStatus ? (
            <p className="wrap-break-word text-[11px] text-neutral-400">{actionStatus}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function StageDetailBlock({
  detail,
  loading,
  error,
}: {
  detail: CodeGenCheckpointDetail | undefined;
  loading: boolean;
  error: string;
}) {
  if (loading) {
    return <p className="text-[11px] text-neutral-500">Loading checkpoint…</p>;
  }
  if (error) {
    return (
      <p className="wrap-break-word text-[11px] text-red-300">Failed to load: {error}</p>
    );
  }
  if (!detail) return null;

  const summary = detail.summary || {};
  const summaryEntries = Object.entries(summary);
  const token = detail?.tokenUsage || undefined;
  const previewJson = (() => {
    try {
      return JSON.stringify(detail.preview ?? null, null, 2);
    } catch {
      return "<unserializable>";
    }
  })();
  const trimmedPreview =
    previewJson.length > 4000
      ? `${previewJson.slice(0, 4000)}\n/* … truncated */`
      : previewJson;

  return (
    <div className="space-y-2 rounded-md border border-neutral-800 bg-neutral-950/70 p-2">
      {summaryEntries.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {summaryEntries.map(([key, value]) => (
            <span
              key={`summary-${key}`}
              className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[10px] text-neutral-300"
            >
              {key}: <span className="text-neutral-100">{String(value)}</span>
            </span>
          ))}
        </div>
      ) : null}

      {token ? (
        <div className="text-[10px] text-neutral-400">
          tokens: in {String(token.promptTokens ?? 0)} / out {String(token.outputTokens ?? 0)} /
          total {String(token.totalTokens ?? 0)} · calls {String(token.callCount ?? 0)}
        </div>
      ) : (
        <div className="text-[10px] text-neutral-500">No token usage recorded for this stage.</div>
      )}

      <details className="rounded border border-neutral-800 bg-neutral-900/60">
        <summary className="cursor-pointer px-2 py-1 text-[11px] text-neutral-300 hover:text-neutral-100">
          Output preview
        </summary>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap wrap-break-word px-2 py-1 text-[10px] text-neutral-300">
          {trimmedPreview}
        </pre>
      </details>
    </div>
  );
}

function PolicyConfirmBlock({
  detail,
  loading,
  error,
  selectedPolicyIds,
  onTogglePolicy,
  manualPolicies,
  onAddManualPolicy,
  onRemoveManualPolicy,
  onConfirm,
  confirmReady,
  isRunning,
  isGated,
  actionPending,
  proceedLabelOverride,
}: {
  detail: CodeGenCheckpointDetail | undefined;
  loading: boolean;
  error: string;
  selectedPolicyIds?: Set<string>;
  onTogglePolicy?: (id: string) => void;
  manualPolicies?: CodeGenPolicyOutline[];
  onAddManualPolicy?: (policy: CodeGenPolicyOutline) => void;
  onRemoveManualPolicy?: (rule_id: string) => void;
  onConfirm?: () => void;
  confirmReady?: boolean;
  isRunning: boolean;
  isGated?: boolean;
  actionPending: boolean;
  proceedLabelOverride?: string;
}) {
  const [labelInput, setLabelInput] = useState("");
  const [descInput, setDescInput] = useState("");

  const handleAddManualPolicy = () => {
    const label = labelInput.trim();
    const description = descInput.trim();
    if (!label && !description) return;
    const policy: CodeGenPolicyOutline = {
      rule_id: `manual_${Date.now()}`,
      label: label || (description.length > 80 ? `${description.slice(0, 77)}…` : description || "manual policy"),
      trigger: "manual",
      target_entity_id: "",
      target_method: "",
      inputs: [],
      description: description,
    };
    onAddManualPolicy?.(policy);
    setLabelInput("");
    setDescInput("");
  };

  const handleDescKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    handleAddManualPolicy();
  };

  if (loading) {
    return <p className="text-[11px] text-neutral-500">Loading checkpoint…</p>;
  }
  if (error) {
    return (
      <p className="wrap-break-word text-[11px] text-red-300">Failed to load: {error}</p>
    );
  }

  const ready = isGated ? true : (confirmReady ?? true);
  const token = detail?.tokenUsage || undefined;
  const selectedCount = selectedPolicyIds?.size ?? 0;
  const manualCount = manualPolicies?.length ?? 0;
  const hasSelection = selectedCount > 0 || manualCount > 0;
  const canProceed = ready && !actionPending && (isGated || !isRunning) && (isGated ? true : (proceedLabelOverride ? true : hasSelection));
  const proceedLabel = proceedLabelOverride ?? "Confirm & proceed";
  const proceedTitle = !ready
    ? "Preview is still running."
    : (!isGated && !hasSelection)
      ? "Select at least one policy above or add a manual policy."
      : undefined;

  const handleConfirm = () => {
    if (isGated && !hasSelection) {
      window.alert("Please select at least one policy before confirming.");
      return;
    }
    onConfirm?.();
  };

  const previewPolicies: CodeGenPolicyOutline[] = (() => {
    try {
      const raw = detail?.preview as { policies?: unknown } | null | undefined;
      if (Array.isArray(raw)) return raw as CodeGenPolicyOutline[];
      if (raw && Array.isArray(raw.policies)) return raw.policies as CodeGenPolicyOutline[];
      return [];
    } catch {
      return [];
    }
  })();

  // Merge preview policies with manual policies, manual policies appended
  const combinedPolicies: CodeGenPolicyOutline[] = [
    ...previewPolicies,
    ...(manualPolicies || []),
  ];

  return (
    <div className="space-y-2 rounded-md border border-neutral-800 bg-neutral-950/70 p-2">
      {token ? (
        <div className="text-[10px] text-neutral-400">
          tokens: in {String(token.promptTokens ?? 0)} / out {String(token.outputTokens ?? 0)} /
          total {String(token.totalTokens ?? 0)} · calls {String(token.callCount ?? 0)}
        </div>
      ) : (
        <div className="text-[10px] text-neutral-500">No token usage recorded for this stage.</div>
      )}

      {!detail ? (
        <p className="text-[11px] text-neutral-500">
          Policy checkpoint details are not loaded yet. Manual policy entry remains available.
        </p>
      ) : null}

      <div>
        <p className="mb-1 text-[11px] font-semibold text-neutral-300">
          Policies ({combinedPolicies.length}) — select to include
        </p>
        <ul className="max-h-72 overflow-y-auto">
          {combinedPolicies.map((policy) => (
            <li key={policy.rule_id}>
              <label className="flex flex-col gap-1 border-b border-neutral-800/70 px-1 py-2 text-sm last:border-b-0">
                <span className="flex items-center gap-2 text-neutral-100">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                    checked={selectedPolicyIds?.has(policy.rule_id) ?? false}
                    onChange={() => onTogglePolicy?.(policy.rule_id)}
                    disabled={actionPending}
                  />
                  <span className="font-semibold">{policy.label}</span>
                </span>
                <span className="ml-6 text-xs text-neutral-400">
                  {policy.target_entity_id}{policy.target_method ? `.${policy.target_method}` : ""}{policy.trigger ? ` on ${policy.trigger}` : ""}
                </span>
                {policy.description ? (
                  <span className="ml-6 mt-1 text-xs text-neutral-400">{policy.description}</span>
                ) : null}
                {manualPolicies?.some((m) => m.rule_id === policy.rule_id) ? (
                  <div className="ml-6 mt-1">
                    <button
                      type="button"
                      onClick={() => onRemoveManualPolicy?.(policy.rule_id)}
                      disabled={actionPending}
                      className="rounded-md border border-neutral-700 px-2 py-1 text-[11px] font-semibold text-neutral-300 transition hover:border-red-500 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Remove manual
                    </button>
                  </div>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-950/50 p-3">
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Add manual policy</p>
          <div className="space-y-2">
            <input
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              placeholder="Policy title (short)"
              className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-sky-500"
              disabled={actionPending}
            />
            <textarea
              value={descInput}
              onChange={(event) => setDescInput(event.target.value)}
              onKeyDown={handleDescKeyDown}
              placeholder="Description (optional): Describe trigger and intent. Example: When stock is low, prioritize restocking before delivery."
              rows={3}
              className="min-h-20 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-500 focus:border-sky-500"
              disabled={actionPending}
            />
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleAddManualPolicy}
                disabled={actionPending || (!labelInput.trim() && !descInput.trim())}
                className="rounded-md border border-sky-700 bg-sky-500/10 px-4 py-2 text-sm font-semibold text-sky-100 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Add policy
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-emerald-700/50 bg-emerald-500/5 p-3">
          <p className="text-xs text-emerald-100">Review {combinedPolicies.length} {combinedPolicies.length === 1 ? "policy" : "policies"} above. You can also add manual policies before continuing.</p>
          <button
            type="button"
            onClick={handleConfirm}
            title={proceedTitle}
            disabled={!canProceed}
            className="rounded-md border border-emerald-600 bg-emerald-500/15 px-4 py-2 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {proceedLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
