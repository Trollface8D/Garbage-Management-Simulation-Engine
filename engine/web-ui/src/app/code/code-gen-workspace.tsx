"use client";

import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  artifactUrl,
  fetchCodeGenResult,
  type CodeGenEntity,
  type CodeGenPolicyOutline,
} from "@/lib/code-gen-api-client";
import { useCodeGenJob } from "@/lib/use-code-gen-job";
import {
  loadCausalArtifactsForItem,
  loadCausalSourceItem,
  loadCausalSourceItems,
  type CausalSourceItem,
} from "@/lib/pm-storage";

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

const DEFAULT_MODEL = "gemini-2.5-flash";

type Props = {
  causalComponentIds: string[];
  onRunningChange?: (running: boolean) => void;
};

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

export default function CodeGenWorkspace({ causalComponentIds, onRunningChange }: Props) {
  const job = useCodeGenJob();
  const [causalChoices, setCausalChoices] = useState<CausalChoice[]>([]);
  const [selectedCausalIds, setSelectedCausalIds] = useState<Set<string>>(new Set());
  const [mapJsonText, setMapJsonText] = useState<string>("");
  const [mapJsonError, setMapJsonError] = useState<string>("");
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [selectedEntityIds, setSelectedEntityIds] = useState<Set<string>>(new Set());
  const [selectedPolicyIds, setSelectedPolicyIds] = useState<Set<string>>(new Set());
  const [artifactFiles, setArtifactFiles] = useState<ArtifactFile[]>([]);
  const [actionError, setActionError] = useState<string>("");
  const lastResultJobIdRef = useRef<string | null>(null);

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

  // Discover causal source documents for the selected causal components.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const collected: CausalChoice[] = [];
      for (const componentId of causalComponentIds) {
        try {
          const items = await loadCausalSourceItems("", componentId);
          for (const item of items) {
            collected.push({
              id: item.id,
              componentId,
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
  }, [causalComponentIds]);

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

  const toggleCausal = (id: string) => {
    setSelectedCausalIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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

  const handleMapJsonChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setMapJsonText(value);
    if (value.trim().length === 0) {
      setMapJsonError("");
      return;
    }
    try {
      JSON.parse(value);
      setMapJsonError("");
    } catch {
      setMapJsonError("Invalid JSON.");
    }
  };

  const parsedMapJson = useMemo<Record<string, unknown> | null>(() => {
    const trimmed = mapJsonText.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }, [mapJsonText]);

  const handlePreview = async () => {
    setActionError("");
    if (mapJsonError) {
      setActionError("Fix map JSON before previewing.");
      return;
    }
    if (selectedCausalIds.size === 0) {
      setActionError("Select at least one causal source.");
      return;
    }

    const chosen = causalChoices.filter((c) => selectedCausalIds.has(c.id));
    const causalData = await aggregateCausalText(chosen);
    if (!causalData) {
      setActionError("Selected causal sources have no extractable text.");
      return;
    }

    try {
      const newJobId = await job.start({
        causalData,
        mapNodeJson: parsedMapJson,
        model,
      });
      await job.runPreview(newJobId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Preview failed.");
    }
  };

  const handleGenerate = async () => {
    setActionError("");
    if (!job.jobId) {
      setActionError("No active job. Run preview first.");
      return;
    }
    if (selectedEntityIds.size === 0) {
      setActionError("Select at least one entity.");
      return;
    }
    try {
      // Re-create the job manifest with refined selections so the backend
      // honors them. The existing job's manifest already has full sets — we
      // simply restart with the user's filter.
      const causalData = await aggregateCausalText(
        causalChoices.filter((c) => selectedCausalIds.has(c.id)),
      );
      const refinedJobId = await job.start({
        causalData,
        mapNodeJson: parsedMapJson,
        selectedEntities: Array.from(selectedEntityIds).map((id) => ({ id })),
        selectedPolicies: Array.from(selectedPolicyIds).map((rule_id) => ({ rule_id })),
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

  return (
    <section className="rounded-xl border border-neutral-700 bg-neutral-900/60 p-4 md:p-6">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-bold text-neutral-100 md:text-2xl">Run real code-gen pipeline</h2>
        <p className="text-xs text-neutral-400">
          {job.jobId ? `Job: ${job.jobId}` : "No active job"}
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
          <p className="mb-2 text-sm font-semibold text-neutral-200">Causal sources</p>
          {causalChoices.length === 0 ? (
            <p className="text-xs text-neutral-500">
              No causal source documents found for the selected components.
            </p>
          ) : (
            <ul className="max-h-40 overflow-y-auto">
              {causalChoices.map((c) => (
                <li key={c.id}>
                  <label className="flex items-center gap-2 px-1 py-1 text-sm text-neutral-200">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                      checked={selectedCausalIds.has(c.id)}
                      onChange={() => toggleCausal(c.id)}
                      disabled={isRunning}
                    />
                    <span>{c.label}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
          <p className="mb-2 text-sm font-semibold text-neutral-200">Map JSON (optional)</p>
          <textarea
            value={mapJsonText}
            onChange={handleMapJsonChange}
            placeholder='Paste a map node graph as JSON, e.g. {"nodes": [...], "edges": [...]}. Leave blank for fallback policy.'
            rows={6}
            disabled={isRunning}
            className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-950 p-2 font-mono text-xs text-neutral-100 focus:outline-none focus:ring-1 focus:ring-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
          />
          {mapJsonError ? (
            <p className="mt-1 text-xs text-red-300">{mapJsonError}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <span>Model</span>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={isRunning}
            className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-100 focus:outline-none focus:ring-1 focus:ring-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>

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
        <p className="mt-3 rounded-md border border-red-800/70 bg-red-500/10 px-3 py-2 text-xs text-red-200">
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

      {artifactFiles.length > 0 && job.jobId ? (
        <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
          <p className="mb-2 text-sm font-semibold text-neutral-200">
            Artifacts ({artifactFiles.length})
          </p>
          <ul className="max-h-60 overflow-y-auto font-mono text-xs">
            {artifactFiles.map((file) => (
              <li key={file.path} className="py-0.5">
                <a
                  className="text-sky-300 underline hover:text-sky-200"
                  href={artifactUrl(job.jobId, file.path)}
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
      ) : null}
    </section>
  );
}
