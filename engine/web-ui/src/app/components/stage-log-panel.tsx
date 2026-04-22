"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cancelMapExtractJob,
  fetchMapExtractCheckpoints,
  resumeMapExtractJob,
  rollbackMapExtractJob,
} from "@/lib/map-api-client";
import type { MapExtractionProgress } from "@/lib/map-types";

type StageEntry = {
  key: string;
  label: string;
  description: string;
};

const STAGE_ENTRIES: StageEntry[] = [
  {
    key: "extractmap_symbol",
    label: "Symbols",
    description: "Legend + notation extraction from the map image.",
  },
  {
    key: "extractmap_text",
    label: "Nodes",
    description: "Extract bin/buffer nodes with normalized coordinates.",
  },
  {
    key: "tabular_extraction",
    label: "Tables",
    description: "Parse support artifacts into CSV rows.",
  },
  {
    key: "support_enrichment",
    label: "Enrichment",
    description: "Merge stage-3 tabular text back into stage-2 nodes.",
  },
  {
    key: "edge_extraction",
    label: "Edges",
    description: "Traversal edges with approximate costs.",
  },
  {
    key: "finalize_graph",
    label: "Finalize",
    description: "Assemble final vertices/edges/metadata.",
  },
];

const STAGE_KEYS = new Set(STAGE_ENTRIES.map((entry) => entry.key));

type StageStatus = "pending" | "running" | "done" | "cancelled" | "failed";

function shortStageName(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.replace(/^map_extract\//, "");
  return trimmed;
}

function stageStatus(
  stageKey: string,
  currentStage: string,
  completed: Set<string>,
  jobStatus: string,
): StageStatus {
  if (completed.has(stageKey)) {
    return "done";
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
    case "cancelled":
      return { label: "■", className: "bg-amber-500 text-neutral-900" };
    case "failed":
      return { label: "!", className: "bg-red-500 text-neutral-50" };
    default:
      return { label: "·", className: "bg-neutral-700 text-neutral-400" };
  }
}

export type StageLogProps = {
  jobId: string;
  jobStatus: string;
  currentStage: string | null | undefined;
  stageMessage: string | undefined;
  completedStages?: string[];
  cancelRequested?: boolean;
  latestProgress?: MapExtractionProgress | null;
  isActive: boolean;
  onResumeSuccess?: () => void;
  onStatusUpdate?: (message: string) => void;
};

export default function StageLogPanel(props: StageLogProps) {
  const {
    jobId,
    jobStatus,
    currentStage,
    stageMessage,
    completedStages,
    cancelRequested,
    latestProgress,
    isActive,
    onResumeSuccess,
    onStatusUpdate,
  } = props;

  const [collapsed, setCollapsed] = useState(false);
  const [remoteCompleted, setRemoteCompleted] = useState<string[]>([]);
  const [expandedStage, setExpandedStage] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string>("");
  const [actionPending, setActionPending] = useState<boolean>(false);

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
        const data = await fetchMapExtractCheckpoints(jobId);
        if (!cancelled) {
          setRemoteCompleted(data.completedStages || []);
        }
      } catch {
        // ignore — stale job id etc.
      }
    };
    poll();
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

  const handleCancel = useCallback(async () => {
    if (!jobId) return;
    setActionPending(true);
    setActionStatus("Requesting cancel…");
    try {
      await cancelMapExtractJob(jobId);
      setActionStatus("Cancel requested. Worker will stop at the next stage boundary.");
      onStatusUpdate?.("Cancel requested; current stage will complete before the worker stops.");
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
        await rollbackMapExtractJob(jobId, stage);
        setActionStatus(`Rolled back stage '${stage}' and later. Resume to re-run.`);
        onStatusUpdate?.(`Rollback done for '${stage}'. Click Resume to re-run.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionStatus(`Rollback failed: ${message}`);
      } finally {
        setActionPending(false);
      }
    },
    [jobId, onStatusUpdate],
  );

  const handleResume = useCallback(async () => {
    if (!jobId) return;
    setActionPending(true);
    setActionStatus("Resuming job…");
    try {
      await resumeMapExtractJob(jobId, {
        onProgress: (progress) => {
          const label = shortStageName(progress.stage);
          setActionStatus(label ? `Resume: ${label} — ${progress.message || ""}` : "Resuming…");
        },
      });
      setActionStatus("Resume completed.");
      onResumeSuccess?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionStatus(`Resume failed: ${message}`);
    } finally {
      setActionPending(false);
    }
  }, [jobId, onResumeSuccess]);

  if (!jobId) {
    return null;
  }

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
          <button
            type="button"
            onClick={handleResume}
            disabled={actionPending || isActive}
            title={isActive ? "Job already running." : "Resume from last completed stage."}
            className="inline-flex items-center gap-2 rounded-md border border-emerald-700 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Resume
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={actionPending || !isActive}
            title={isActive ? "Terminate current stage at next boundary." : "Job is not running."}
            className="inline-flex items-center gap-2 rounded-md border border-red-700 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-200 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Terminate
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((prev) => !prev)}
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
                    <span className="flex-1">
                      <span className="text-sm font-semibold text-neutral-100">{entry.label}</span>
                      <span className="block truncate text-[11px] text-neutral-400">
                        {progressMsg || entry.description}
                      </span>
                    </span>
                    <span className="text-[11px] text-neutral-500">{isExpanded ? "▼" : "▶"}</span>
                  </button>

                  {isExpanded ? (
                    <div className="border-t border-neutral-800 px-3 py-2 text-[12px] text-neutral-300">
                      <p className="text-neutral-400">Stage key: <span className="text-neutral-200">{entry.key}</span></p>
                      <p className="mt-1 text-neutral-400">
                        Status: <span className="text-neutral-200">{status}</span>
                      </p>
                      {progressMsg ? (
                        <p className="mt-1 text-neutral-300">{progressMsg}</p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {status === "done" ? (
                          <button
                            type="button"
                            onClick={() => handleRollback(entry.key)}
                            disabled={actionPending || isActive}
                            className="inline-flex items-center rounded-md border border-amber-700 bg-amber-500/10 px-2 py-1 text-[11px] font-semibold text-amber-200 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                            title="Delete this stage's checkpoint and everything after it."
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

          {latestProgress?.message ? (
            <p className="rounded-md border border-neutral-800 bg-neutral-950/60 p-2 text-[11px] text-neutral-400">
              <span className="font-semibold text-neutral-300">Live:</span>{" "}
              {latestProgress.message}
            </p>
          ) : null}

          {actionStatus ? (
            <p className="text-[11px] text-neutral-400">{actionStatus}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export { STAGE_KEYS };
