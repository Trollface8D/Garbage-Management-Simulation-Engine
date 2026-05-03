"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelCodeGenJob,
  confirmCodeGenStage,
  createCodeGenJob,
  fetchCodeGenStatus,
  previewEntities,
  resumeCodeGenJob,
  type CodeGenCreateRequest,
  type CodeGenJobStatus,
  type CodeGenPreviewResult,
} from "@/lib/code-gen-api-client";
import {
  saveJobState,
  loadJobState,
  clearAllPersistence,
  type PersistedCodeGenState,
} from "@/lib/use-codegen-persistence";

const POLL_INTERVAL_MS = 1500;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "partial"]);
// awaiting_confirmation is non-terminal — worker is alive, just gated.

function createPreviewingStatus(jobId: string): CodeGenJobStatus {
  return {
    jobId,
    status: "previewing",
    currentStage: "state1_entity_list",
    stageMessage: "Previewing entities and policies…",
    stageHistory: [],
    tokenUsage: null,
    error: null,
    cancelRequested: false,
    completedStages: [],
    remainingStages: 0,
    nextStage: "state1b_policy_outline",
    canResume: false,
    resumeDisabledReason: "Preview is still running.",
    awaitingConfirmationStage: null,
    confirmedStages: [],
  };
}

export type UseCodeGenJobState = {
  jobId: string | null;
  preview: CodeGenPreviewResult | null;
  status: CodeGenJobStatus | null;
  error: string | null;
  isStarting: boolean;
  isPreviewing: boolean;
  isResuming: boolean;
  isPolling: boolean;
  isActivelyProcessing: boolean;
  start: (req: CodeGenCreateRequest) => Promise<string>;
  runPreview: (jobId?: string) => Promise<CodeGenPreviewResult>;
  cancel: (jobId?: string) => Promise<void>;
  resume: (jobId?: string) => Promise<void>;
  confirm: (stage: string, jobId?: string) => Promise<void>;
  reset: () => void;
};

export function useCodeGenJob(componentId?: string) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [preview, setPreview] = useState<CodeGenPreviewResult | null>(null);
  const [status, setStatus] = useState<CodeGenJobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [isRestoringFromPersistence, setIsRestoringFromPersistence] = useState(true);
  const pollTimerRef = useRef<number | null>(null);
  const pollStabilizedRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Restore persisted job state on mount (if componentId provided)
  useEffect(() => {
    if (!componentId) {
      setIsRestoringFromPersistence(false);
      return;
    }
    const persisted = loadJobState(componentId);
    if (persisted) {
      setJobId(persisted.jobId);
      setPreview(persisted.preview);
      setStatus(persisted.status);
      setError(persisted.error);

      // Auto-resume polling if job was active during reload
      if (
        persisted.jobId &&
        persisted.status &&
        !TERMINAL_STATUSES.has(persisted.status.status)
      ) {
        // Delay polling start slightly to allow state stabilization
        const timer = window.setTimeout(() => {
          void (async () => {
            try {
              const next = await fetchCodeGenStatus(persisted.jobId!);
              setStatus(next);
              setIsRestoringFromPersistence(false);
              if (!TERMINAL_STATUSES.has(next.status)) {
                // Resume polling
                pollTimerRef.current = window.setInterval(() => {
                  void (async () => {
                    try {
                      const next = await fetchCodeGenStatus(persisted.jobId!);
                      setStatus(next);
                      if (TERMINAL_STATUSES.has(next.status)) {
                        if (pollTimerRef.current !== null) {
                          window.clearInterval(pollTimerRef.current);
                          pollTimerRef.current = null;
                        }
                      }
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Status poll failed.");
                      if (pollTimerRef.current !== null) {
                        window.clearInterval(pollTimerRef.current);
                        pollTimerRef.current = null;
                      }
                    }
                  })();
                }, POLL_INTERVAL_MS);
              }
            } catch (err) {
              setIsRestoringFromPersistence(false);
              setError(err instanceof Error ? err.message : "Failed to resume polling.");
            }
          })();
        }, 100);
        return () => window.clearTimeout(timer);
      }
    }
    setIsRestoringFromPersistence(false);
  }, [componentId]);

  // Persist job state whenever it changes (if componentId provided)
  useEffect(() => {
    if (!componentId || isRestoringFromPersistence) return;
    const state: PersistedCodeGenState = {
      version: 1,
      jobId,
      preview,
      status,
      error,
    };
    saveJobState(componentId, state);
  }, [componentId, jobId, preview, status, error, isRestoringFromPersistence]);

  const startPolling = useCallback(
    (id: string) => {
      stopPolling();
      pollStabilizedRef.current = false;
      // Wait 500ms before stabilizing poll flag (so isActivelyProcessing reflects initial fetch)
      const stabilizeTimer = window.setTimeout(() => {
        pollStabilizedRef.current = true;
      }, 500);
      pollTimerRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const next = await fetchCodeGenStatus(id);
            setStatus(next);
            // Auto-clear jobId and preview when job is cancelled server-side
            if (next.status === "cancelled") {
              stopPolling();
              window.clearTimeout(stabilizeTimer);
              return;
            }
            if (TERMINAL_STATUSES.has(next.status)) {
              stopPolling();
              window.clearTimeout(stabilizeTimer);
            }
          } catch (err) {
            setError(err instanceof Error ? err.message : "Status poll failed.");
            stopPolling();
            window.clearTimeout(stabilizeTimer);
          }
        })();
      }, POLL_INTERVAL_MS);
    },
    [stopPolling],
  );

  useEffect(() => stopPolling, [stopPolling]);

  const start = useCallback(
    async (req: CodeGenCreateRequest): Promise<string> => {
      setError(null);
      setIsStarting(true);
      try {
        const result = await createCodeGenJob(req);
        setJobId(result.jobId);
        setStatus(null);
        setPreview(null);
        if (!req.previewOnly) {
          startPolling(result.jobId);
        }
        return result.jobId;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Job creation failed.";
        setError(message);
        throw err;
      } finally {
        setIsStarting(false);
      }
    },
    [startPolling],
  );

  const runPreview = useCallback(
    async (overrideJobId?: string): Promise<CodeGenPreviewResult> => {
      const id = overrideJobId ?? jobId;
      if (!id) {
        throw new Error("No active job. Call start() first.");
      }
      setError(null);
      setIsPreviewing(true);
      setStatus(createPreviewingStatus(id));
      // preview_entities is a single blocking POST that runs State 1 + 1b
      // inline server-side; the worker emits stage events to the same job
      // record, so a parallel status poll surfaces "state1_entity_list:
      // starting", token usage, etc. into job.status while we wait. Without
      // this the UI looks frozen for the 10-60s the LLM call takes.
      let pollHandle: number | null = window.setInterval(() => {
        void (async () => {
          try {
            const next = await fetchCodeGenStatus(id);
            setStatus(next);
          } catch {
            /* swallow — preview's own response will surface real errors */
          }
        })();
      }, POLL_INTERVAL_MS);
      try {
        const result = await previewEntities(id);
        try {
          const next = await fetchCodeGenStatus(id);
          setStatus(next);
        } catch {
          /* preview already persisted; keep the synthetic status if refresh fails */
        }
        setPreview(result);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Preview failed.";
        setError(message);
        throw err;
      } finally {
        if (pollHandle !== null) {
          window.clearInterval(pollHandle);
          pollHandle = null;
        }
        setIsPreviewing(false);
      }
    },
    [jobId],
  );

  const cancel = useCallback(
    async (overrideJobId?: string) => {
      const id = overrideJobId ?? jobId;
      if (!id) return;
      try {
        await cancelCodeGenJob(id);
        // Optimistically mark cancelRequested so the badge lights up immediately.
        setStatus((prev) => (prev ? { ...prev, cancelRequested: true } : prev));
        // One immediate status refresh to accelerate feedback; polling continues
        // and will naturally stop when it sees the terminal "cancelled" status.
        try {
          const next = await fetchCodeGenStatus(id);
          setStatus(next);
          if (next.status === "cancelled") {
            stopPolling();
          }
        } catch {
          /* best-effort — polling will catch up */
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Cancel failed.");
      }
    },
    [jobId, stopPolling],
  );

  const resume = useCallback(
    async (overrideJobId?: string) => {
      const id = overrideJobId ?? jobId;
      if (!id) throw new Error("No job to resume.");
      setError(null);
      setIsResuming(true);
      try {
        await resumeCodeGenJob(id);
        setJobId(id);
        startPolling(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Resume failed.";
        setError(message);
        throw err;
      } finally {
        setIsResuming(false);
      }
    },
    [jobId, startPolling],
  );

  const confirm = useCallback(
    async (stage: string, overrideJobId?: string) => {
      const id = overrideJobId ?? jobId;
      if (!id) throw new Error("No active job.");
      setError(null);
      try {
        await confirmCodeGenStage(id, stage);
        // Status will update via polling; no need to force a refresh.
      } catch (err) {
        const message = err instanceof Error ? err.message : "Confirm failed.";
        setError(message);
        throw err;
      }
    },
    [jobId],
  );

  const reset = useCallback(() => {
    stopPolling();
    setJobId(null);
    setPreview(null);
    setStatus(null);
    setError(null);
    if (componentId) {
      clearAllPersistence(componentId);
    }
  }, [stopPolling, componentId]);

  // isActivelyProcessing: true only during immediate user actions (not during polling).
  // awaiting_confirmation is intentionally excluded — buttons must remain clickable.
  const isActivelyProcessing =
    isStarting ||
    isPreviewing ||
    isResuming ||
    (pollTimerRef.current !== null && !pollStabilizedRef.current);

  return {
    jobId,
    preview,
    status,
    error,
    isStarting,
    isPreviewing,
    isResuming,
    isPolling: pollTimerRef.current !== null,
    isActivelyProcessing,
    start,
    runPreview,
    cancel,
    resume,
    confirm,
    reset,
  };
}
