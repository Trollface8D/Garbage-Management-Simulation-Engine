"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cancelCodeGenJob,
  fetchCodeGenCheckpointDetail,
  fetchCodeGenCheckpoints,
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

type StageStatus = "pending" | "running" | "done" | "cancelled" | "failed";

function shortStageName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/^code_gen\//, "");
}

function stageStatus(
  stageKey: string,
  currentStage: string,
  completed: Set<string>,
  jobStatus: string,
): StageStatus {
  if (completed.has(stageKey)) return "done";
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
  canResume?: boolean;
  remainingStages?: number | null;
  nextStage?: string | null;
  resumeDisabledReason?: string | null;
  cancelRequested?: boolean;
  isActive: boolean;
  onResumeRequested?: () => void;
  onPreviewRequested?: () => void;
  previewDisabled?: boolean;
  previewDisabledReason?: string;
  onStatusUpdate?: (message: string) => void;
  selectedPolicyIds?: Set<string>;
  onTogglePolicy?: (id: string) => void;
  policyConfirmReady?: boolean;
};

export default function CodeGenStageLogPanel(props: CodeGenStageLogProps) {
  const {
    jobId,
    jobStatus,
    currentStage,
    stageMessage,
    completedStages,
    canResume,
    remainingStages,
    nextStage,
    resumeDisabledReason,
    cancelRequested,
    isActive,
    onResumeRequested,
    onPreviewRequested,
    previewDisabled,
    previewDisabledReason,
    onStatusUpdate,
    selectedPolicyIds,
    onTogglePolicy,
    policyConfirmReady,
  } = props;

  const [collapsed, setCollapsed] = useState(true);
  const [userToggled, setUserToggled] = useState(false);
  const [remoteCompleted, setRemoteCompleted] = useState<string[]>([]);
  const [expandedStage, setExpandedStage] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string>("");
  const [actionPending, setActionPending] = useState<boolean>(false);
  const [stageDetails, setStageDetails] = useState<
    Record<string, CodeGenCheckpointDetail>
  >({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string>("");

  const completedSet = useMemo(() => {
    const merged = new Set<string>();
    (completedStages || []).forEach((stage) => merged.add(stage));
    remoteCompleted.forEach((stage) => merged.add(stage));
    return merged;
  }, [completedStages, remoteCompleted]);

  const shortCurrentStage = shortStageName(currentStage);

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
      setActionStatus(`Rolling back to ${stage}…`);
      try {
        await rollbackCodeGenJob(jobId, stage, "from");
        setActionStatus(
          `Rolled back '${stage}' and later. Resume to re-run from this stage.`,
        );
        // Drop any cached detail beyond the rollback so the panel re-fetches
        // when the stage is re-run.
        setStageDetails((prev) => {
          const next = { ...prev };
          delete next[stage];
          return next;
        });
        onStatusUpdate?.(`Rollback done for '${stage}'.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionStatus(`Rollback failed: ${message}`);
      } finally {
        setActionPending(false);
      }
    },
    [jobId, onStatusUpdate],
  );

  const handleResume = useCallback(() => {
    if (!jobId) return;
    setActionStatus("Resume requested…");
    onResumeRequested?.();
  }, [jobId, onResumeRequested]);

  const hasHistory = completedSet.size > 0;
  const noRemainingStages = typeof remainingStages === "number" && remainingStages <= 0;
  const isFailed = jobStatus === "failed";
  const resumeEnabled =
    Boolean(jobId) &&
    !actionPending &&
    !isActive &&
    (isFailed || (!!canResume && !noRemainingStages));
  const resumeLabel = isFailed ? "Restart" : hasHistory ? "Resume" : "Confirm & start";
  const resumeTitle = !jobId
    ? "No prior job to resume."
    : isActive
      ? "Job already running."
      : isFailed
        ? nextStage
          ? `Restart from the stage that failed (${nextStage}).`
          : "Restart from the last successful checkpoint."
        : resumeDisabledReason ||
          (noRemainingStages
            ? "No stages left to run."
            : nextStage
              ? `Resume from next stage: ${nextStage}.`
              : "Resume from last completed stage.");

  // Auto-expand on first activity / history.
  useEffect(() => {
    if (userToggled) return;
    if (isActive || hasHistory) setCollapsed(false);
    else setCollapsed(true);
  }, [isActive, hasHistory, userToggled]);

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
        </div>
        <div className="flex items-center gap-2">
          {isEmptySlate ? (
            <button
              type="button"
              onClick={() => onPreviewRequested?.()}
              disabled={actionPending || Boolean(previewDisabled)}
              title={
                previewDisabled
                  ? previewDisabledReason || "Preview is not available yet."
                  : "Run the State 1/1b preview to derive the entity list and policy outline."
              }
              className="inline-flex items-center gap-2 rounded-md border border-sky-700 bg-sky-500/10 px-3 py-1.5 text-xs font-semibold text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Preview
            </button>
          ) : (
            <button
              type="button"
              onClick={handleResume}
              disabled={!resumeEnabled}
              title={resumeTitle}
              className="inline-flex items-center gap-2 rounded-md border border-emerald-700 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {resumeLabel}
            </button>
          )}
          <button
            type="button"
            onClick={handleCancel}
            disabled={actionPending || !isActive}
            title={
              isActive
                ? "Terminate: worker stops within ~0.5s, abandons any in-flight Gemini call."
                : "Job is not running."
            }
            className="inline-flex items-center gap-2 rounded-md border border-red-700 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-200 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Terminate
          </button>
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
              const status = stageStatus(entry.key, shortCurrentStage, completedSet, jobStatus);
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
                      <span className="block break-words text-[11px] text-neutral-400">
                        {progressMsg || entry.description}
                      </span>
                    </span>
                    <span className="text-[11px] text-neutral-500">
                      {isExpanded ? "▼" : "▶"}
                    </span>
                  </button>

                  {isExpanded ? (
                    <div className="space-y-2 border-t border-neutral-800 px-3 py-2 text-[12px] text-neutral-300">
                      <p className="break-words text-neutral-400">
                        Stage key: <span className="text-neutral-200">{entry.key}</span>
                      </p>
                      <p className="text-neutral-400">
                        Status: <span className="text-neutral-200">{status}</span>
                      </p>
                      {progressMsg ? (
                        <p className="break-words text-neutral-300">{progressMsg}</p>
                      ) : null}

                      {status === "done" ? (
                        entry.key === "state1b_policy_outline" ? (
                          <PolicyConfirmBlock
                            detail={stageDetails[entry.key]}
                            loading={detailLoading === entry.key}
                            error={detailLoading === entry.key ? "" : detailError}
                            selectedPolicyIds={selectedPolicyIds}
                            onTogglePolicy={onTogglePolicy}
                            onConfirm={onResumeRequested}
                            confirmReady={policyConfirmReady}
                            isRunning={isActive}
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
                        {status === "done" ? (
                          <button
                            type="button"
                            onClick={() => handleRollback(entry.key)}
                            disabled={actionPending || isActive}
                            className="inline-flex items-center rounded-md border border-amber-700 bg-amber-500/10 px-2 py-1 text-[11px] font-semibold text-amber-200 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                            title="Delete this stage's checkpoint and everything after it. Resume to re-run."
                          >
                            Rollback to here
                          </button>
                        ) : null}
                        {status === "running" ? (
                          <button
                            type="button"
                            onClick={handleCancel}
                            disabled={actionPending}
                            className="inline-flex items-center rounded-md border border-red-700 bg-red-500/10 px-2 py-1 text-[11px] font-semibold text-red-200 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Terminate this stage
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
            <p className="break-words text-[11px] text-neutral-400">{actionStatus}</p>
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
      <p className="break-words text-[11px] text-red-300">Failed to load: {error}</p>
    );
  }
  if (!detail) return null;

  const summary = detail.summary || {};
  const summaryEntries = Object.entries(summary);
  const token = detail.tokenUsage || undefined;
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
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words px-2 py-1 text-[10px] text-neutral-300">
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
  onConfirm,
  confirmReady,
  isRunning,
  actionPending,
}: {
  detail: CodeGenCheckpointDetail | undefined;
  loading: boolean;
  error: string;
  selectedPolicyIds?: Set<string>;
  onTogglePolicy?: (id: string) => void;
  onConfirm?: () => void;
  confirmReady?: boolean;
  isRunning: boolean;
  actionPending: boolean;
}) {
  if (loading) {
    return <p className="text-[11px] text-neutral-500">Loading checkpoint…</p>;
  }
  if (error) {
    return (
      <p className="break-words text-[11px] text-red-300">Failed to load: {error}</p>
    );
  }
  if (!detail) return null;

  const token = detail.tokenUsage || undefined;
  const policies: CodeGenPolicyOutline[] = (() => {
    try {
      const raw = detail.preview as { policies?: unknown } | null;
      if (Array.isArray(raw)) return raw as CodeGenPolicyOutline[];
      if (raw && Array.isArray(raw.policies)) return raw.policies as CodeGenPolicyOutline[];
      return [];
    } catch {
      return [];
    }
  })();

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

      {policies.length > 0 ? (
        <div>
          <p className="mb-1 text-[11px] font-semibold text-neutral-300">
            Policies ({policies.length}) — select to include
          </p>
          <ul className="max-h-72 overflow-y-auto">
            {policies.map((policy) => (
              <li key={policy.rule_id}>
                <label className="flex flex-col gap-1 border-b border-neutral-800/70 px-1 py-2 text-sm last:border-b-0">
                  <span className="flex items-center gap-2 text-neutral-100">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                      checked={selectedPolicyIds?.has(policy.rule_id) ?? true}
                      onChange={() => onTogglePolicy?.(policy.rule_id)}
                      disabled={isRunning || actionPending}
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
      ) : (
        <p className="text-[11px] text-neutral-500">No policies in checkpoint.</p>
      )}

      {confirmReady ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-700/50 bg-emerald-500/5 p-3">
          <p className="text-xs text-emerald-100">
            Review {policies.length} {policies.length === 1 ? "policy" : "policies"} above.
            Confirm to continue generation.
          </p>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!selectedPolicyIds || selectedPolicyIds.size === 0 || actionPending}
            title={
              selectedPolicyIds?.size === 0
                ? "Select at least one policy above"
                : undefined
            }
            className="rounded-md border border-emerald-600 bg-emerald-500/15 px-4 py-2 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Confirm &amp; continue generation
          </button>
        </div>
      ) : null}
    </div>
  );
}
