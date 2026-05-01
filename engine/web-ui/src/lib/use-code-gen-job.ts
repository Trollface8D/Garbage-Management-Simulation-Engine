"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelCodeGenJob,
  createCodeGenJob,
  fetchCodeGenStatus,
  previewEntities,
  resumeCodeGenJob,
  type CodeGenCreateRequest,
  type CodeGenJobStatus,
  type CodeGenPreviewResult,
  type CodeGenResumeOverrides,
} from "@/lib/code-gen-api-client";
import {
  saveJobState,
  loadJobState,
  clearAllPersistence,
  type PersistedCodeGenState,
} from "@/lib/use-codegen-persistence";

const POLL_INTERVAL_MS = 1500;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "partial"]);

export type UseCodeGenJobState = {
  jobId: string | null;
  preview: CodeGenPreviewResult | null;
  status: CodeGenJobStatus | null;
  error: string | null;
  isStarting: boolean;
  isPreviewing: boolean;
  isResuming: boolean;
  isPolling: boolean;
  start: (req: CodeGenCreateRequest) => Promise<string>;
  runPreview: (jobId?: string) => Promise<CodeGenPreviewResult>;
  generate: (jobId?: string, overrides?: CodeGenResumeOverrides) => Promise<void>;
  cancel: (jobId?: string) => Promise<void>;
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
        !["completed", "failed", "cancelled"].includes(persisted.status.status)
      ) {
        // Delay polling start slightly to allow state stabilization
        const timer = window.setTimeout(() => {
          void (async () => {
            try {
              const next = await fetchCodeGenStatus(persisted.jobId!);
              setStatus(next);
              if (!["completed", "failed", "cancelled"].includes(next.status)) {
                // Resume polling
                pollTimerRef.current = window.setInterval(() => {
                  void (async () => {
                    try {
                      const next = await fetchCodeGenStatus(persisted.jobId!);
                      setStatus(next);
                      if (["completed", "failed", "cancelled"].includes(next.status)) {
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
      pollTimerRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const next = await fetchCodeGenStatus(id);
            setStatus(next);
            if (TERMINAL_STATUSES.has(next.status)) {
              stopPolling();
            }
          } catch (err) {
            setError(err instanceof Error ? err.message : "Status poll failed.");
            stopPolling();
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
        // Back-compat: when previewOnly is omitted/false the server auto-
        // spawns a worker that runs the full pipeline; cancel it immediately
        // so the caller can preview first. When previewOnly is true the
        // worker is never spawned — no cancel needed, and the sticky cancel
        // flag would just trip the inline preview anyway.
        if (!req.previewOnly) {
          await cancelCodeGenJob(result.jobId);
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
    [],
  );

  const runPreview = useCallback(
    async (overrideJobId?: string): Promise<CodeGenPreviewResult> => {
      const id = overrideJobId ?? jobId;
      if (!id) {
        throw new Error("No active job. Call start() first.");
      }
      setError(null);
      setIsPreviewing(true);
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

  const generate = useCallback(
    async (overrideJobId?: string, overrides?: CodeGenResumeOverrides) => {
      const id = overrideJobId ?? jobId;
      if (!id) {
        throw new Error("No active job. Call start() first.");
      }
      setError(null);
      setIsResuming(true);
      try {
        await resumeCodeGenJob(id, overrides);
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

  const cancel = useCallback(
    async (overrideJobId?: string) => {
      const id = overrideJobId ?? jobId;
      if (!id) return;
      try {
        await cancelCodeGenJob(id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Cancel failed.");
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

  return {
    jobId,
    preview,
    status,
    error,
    isStarting,
    isPreviewing,
    isResuming,
    isPolling: pollTimerRef.current !== null,
    start,
    runPreview,
    generate,
    cancel,
    reset,
  };
}
