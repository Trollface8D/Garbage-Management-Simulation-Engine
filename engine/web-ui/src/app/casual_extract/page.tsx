"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  findComponentById,
  getProjectIdForComponent,
  getSeedBlocksForComponent,
  simulationProjects,
  type SimulationProject,
} from "@/lib/simulation-components";

type TextBlock = {
  id: string;
  text: string;
};

type LoadOptions = {
  silentFailure?: boolean;
};

const DEFAULT_EDITOR_TEXT =
  "Select a Causal component from the dashboard to load its base text. You can then split by click, merge selected blocks, or rechunk the whole document.";

function createBlock(text: string): TextBlock {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    text,
  };
}

function buildBlocksFromTexts(texts: string[]): TextBlock[] {
  const cleaned = texts.map((text) => text.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return [createBlock(DEFAULT_EDITOR_TEXT)];
  }
  return cleaned.map((text) => createBlock(text));
}

function extractChunkTexts(payload: unknown): string[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (item && typeof item === "object") {
        const candidate = item as { text?: unknown; chunkText?: unknown; content?: unknown };
        if (typeof candidate.text === "string") {
          return candidate.text;
        }
        if (typeof candidate.chunkText === "string") {
          return candidate.chunkText;
        }
        if (typeof candidate.content === "string") {
          return candidate.content;
        }
      }

      return "";
    })
    .map((text) => text.trim())
    .filter(Boolean);
}

function splitIntoFixedWordChunks(fullText: string, chunkSize: number): string[] {
  const words = fullText.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += chunkSize) {
    chunks.push(words.slice(index, index + chunkSize).join(" "));
  }

  return chunks;
}

export default function CasualExtractPage() {
  const searchParams = useSearchParams();

  const componentId = searchParams.get("componentId");
  const queryProjectId = searchParams.get("projectId");
  const initialJobId = searchParams.get("jobId") ?? "";
  const queryTitle = searchParams.get("title");

  const selectedComponent = useMemo(() => findComponentById(componentId), [componentId]);
  const defaultProjectId = queryProjectId ?? getProjectIdForComponent(componentId) ?? simulationProjects[0]?.id ?? "";

  const selectedTitle = queryTitle ?? selectedComponent?.title ?? "Unselected component";
  const engineApiBase = process.env.NEXT_PUBLIC_ENGINE_API_BASE ?? "http://127.0.0.1:8000";

  const [projects, setProjects] = useState<SimulationProject[]>(simulationProjects);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(defaultProjectId);
  const [blocks, setBlocks] = useState<TextBlock[]>(() => buildBlocksFromTexts([]));
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [isCutMode, setIsCutMode] = useState<boolean>(false);
  const [selectedForJoin, setSelectedForJoin] = useState<number[]>([]);
  const [jobIdInput, setJobIdInput] = useState<string>(initialJobId);
  const [isLoadingBackend, setIsLoadingBackend] = useState<boolean>(false);
  const [loadStatus, setLoadStatus] = useState<string>("");

  const selectedProjectName =
    projects.find((project) => project.id === selectedProjectId)?.name ?? "Unselected project";

  const handleProjectChange = (value: string) => {
    if (value !== "__add_new__") {
      setSelectedProjectId(value);
      return;
    }

    const nextNameRaw = window.prompt("Enter new project name:");
    const nextName = nextNameRaw?.trim();
    if (!nextName) {
      return;
    }

    const existingByName = projects.find((project) => project.name.toLowerCase() === nextName.toLowerCase());
    if (existingByName) {
      setSelectedProjectId(existingByName.id);
      return;
    }

    const slugBase = nextName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    let nextId = slugBase || `project-${String(projects.length + 1)}`;
    let index = 2;
    while (projects.some((project) => project.id === nextId)) {
      nextId = `${slugBase || "project"}-${String(index)}`;
      index += 1;
    }

    const nextProject: SimulationProject = { id: nextId, name: nextName };
    setProjects((prev) => [nextProject, ...prev]);
    setSelectedProjectId(nextProject.id);
  };

  const loadFromBackend = useCallback(
    async (targetJobId: string, options: LoadOptions = {}): Promise<void> => {
      const trimmedJobId = targetJobId.trim();
      if (!trimmedJobId) {
        if (!options.silentFailure) {
          setLoadStatus("Enter a job id before loading backend chunks.");
        }
        return;
      }

      setIsLoadingBackend(true);
      setLoadStatus("Loading chunks from backend...");

      try {
        const response = await fetch(`${engineApiBase}/pipeline/jobs/${encodeURIComponent(trimmedJobId)}/artifacts/chunks`);
        if (!response.ok) {
          throw new Error(`Backend responded with status ${String(response.status)}.`);
        }

        const payload: unknown = await response.json();
        const chunkTexts = extractChunkTexts(payload);

        if (chunkTexts.length === 0) {
          throw new Error("No chunk text was returned for this job id.");
        }

        setBlocks(buildBlocksFromTexts(chunkTexts));
        setActiveIndex(0);
        setSelectedForJoin([]);
        setIsCutMode(false);
        setLoadStatus(`Loaded ${String(chunkTexts.length)} chunks from backend.`);
      } catch (error) {
        if (!options.silentFailure) {
          const message = error instanceof Error ? error.message : "Unable to load backend chunks.";
          setLoadStatus(`Backend load failed: ${message}`);
        }
      } finally {
        setIsLoadingBackend(false);
      }
    },
    [engineApiBase],
  );

  useEffect(() => {
    setJobIdInput(initialJobId);
  }, [initialJobId]);

  useEffect(() => {
    if (!defaultProjectId) {
      return;
    }
    setSelectedProjectId(defaultProjectId);
  }, [defaultProjectId]);

  useEffect(() => {
    const seedTexts = getSeedBlocksForComponent(componentId);
    const initialTexts = seedTexts.length > 0 ? seedTexts : [DEFAULT_EDITOR_TEXT];

    setBlocks(buildBlocksFromTexts(initialTexts));
    setActiveIndex(0);
    setSelectedForJoin([]);
    setIsCutMode(false);

    if (!componentId) {
      setLoadStatus("No component was selected from the dashboard. Showing default editor text.");
      return;
    }

    if (initialJobId.trim()) {
      void loadFromBackend(initialJobId, { silentFailure: true });
      return;
    }

    setLoadStatus("Loaded seed text based on the selected dashboard component.");
  }, [componentId, initialJobId, loadFromBackend]);

  const armCutMode = () => {
    setIsCutMode(true);
  };

  const handleEdit = (index: number, nextText: string) => {
    setBlocks((prev) => {
      const nextBlocks = [...prev];
      if (!nextBlocks[index]) {
        return prev;
      }
      nextBlocks[index] = {
        ...nextBlocks[index],
        text: nextText,
      };
      return nextBlocks;
    });
  };

  const handleCutAt = (index: number, cursorPosition: number) => {
    setBlocks((prev) => {
      const target = prev[index];
      if (!target) {
        return prev;
      }

      const leftText = target.text.substring(0, cursorPosition);
      const rightText = target.text.substring(cursorPosition);

      const nextBlocks = [...prev];
      nextBlocks.splice(index, 1, createBlock(leftText), createBlock(rightText));
      return nextBlocks;
    });

    setActiveIndex(index + 1);
    setSelectedForJoin([]);
    setIsCutMode(false);
  };

  const handleTextareaMouseUp = (index: number, selectionStart: number | null) => {
    if (!isCutMode) {
      return;
    }

    handleCutAt(index, selectionStart ?? 0);
  };

  const toggleJoinSelection = (index: number) => {
    setSelectedForJoin((prev) => {
      if (prev.includes(index)) {
        return prev.filter((value) => value !== index);
      }
      return [...prev, index].sort((left, right) => left - right);
    });
  };

  const handleJoinSelected = () => {
    if (selectedForJoin.length < 2) {
      return;
    }

    const ordered = [...selectedForJoin].sort((left, right) => left - right);
    const insertAt = ordered[0];
    const selectedSet = new Set(ordered);

    const mergedText = ordered
      .map((index) => blocks[index]?.text.trim() ?? "")
      .filter(Boolean)
      .join(" ");

    setBlocks((prev) => {
      const remaining = prev.filter((_, index) => !selectedSet.has(index));
      remaining.splice(insertAt, 0, createBlock(mergedText));
      return remaining;
    });

    setActiveIndex(insertAt);
    setSelectedForJoin([]);
    setIsCutMode(false);
  };

  const handleAutochunk = () => {
    const shouldContinue = window.confirm(
      "Autochunk will rechunk the entire document into 20-word blocks and reset current block-level edits. Continue?",
    );

    if (!shouldContinue) {
      return;
    }

    const fullText = blocks
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join(" ");

    const rechunked = splitIntoFixedWordChunks(fullText, 20);
    if (rechunked.length === 0) {
      return;
    }

    setBlocks(buildBlocksFromTexts(rechunked));
    setActiveIndex(0);
    setSelectedForJoin([]);
    setIsCutMode(false);
    setLoadStatus(`Autochunk completed with ${String(rechunked.length)} blocks.`);
  };

  return (
    <div className="min-h-screen bg-[#1e1e1e] text-neutral-100">
      <main className="mx-auto w-full max-w-6xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black uppercase tracking-tight md:text-4xl">Casual Extract Editor</h1>
            <p className="mt-2 text-sm text-neutral-300">
              Selected component: <span className="font-semibold text-neutral-100">{selectedTitle}</span>
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <label htmlFor="project-picker" className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Project
              </label>
              <select
                id="project-picker"
                value={selectedProjectId}
                onChange={(event) => handleProjectChange(event.target.value)}
                className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none transition focus:border-sky-500"
              >
                <option value="__add_new__">+ Add new project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <span className="text-xs text-neutral-400">{selectedProjectName}</span>
            </div>
          </div>
          <Link
            href="/"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm font-semibold text-neutral-200 transition hover:border-sky-500 hover:text-sky-200"
          >
            Back to dashboard
          </Link>
        </header>

        <section className="mb-6 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <label htmlFor="job-id" className="mb-2 block text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Optional backend job id
              </label>
              <input
                id="job-id"
                type="text"
                value={jobIdInput}
                onChange={(event) => setJobIdInput(event.target.value)}
                placeholder="Paste pipeline job id to load chunks artifact"
                className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 outline-none transition focus:border-sky-500"
              />
            </div>
            <button
              type="button"
              onClick={() => void loadFromBackend(jobIdInput)}
              disabled={isLoadingBackend}
              className="rounded-md border border-sky-500 bg-sky-500/15 px-4 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoadingBackend ? "Loading..." : "Load backend chunks"}
            </button>
          </div>
          <p className="mt-3 text-xs text-neutral-400">{loadStatus}</p>
        </section>

        <section className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
          <button
            type="button"
            onClick={armCutMode}
            className={`rounded-md border px-4 py-2 text-sm font-semibold transition ${
              isCutMode
                ? "border-sky-400 bg-sky-500/30 text-sky-100"
                : "border-sky-700 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20"
            }`}
          >
            {isCutMode ? "Click text to split" : "Cut by next click"}
          </button>

          <button
            type="button"
            onClick={handleJoinSelected}
            disabled={selectedForJoin.length < 2}
            className="rounded-md border border-emerald-700 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Join selected ({String(selectedForJoin.length)})
          </button>

          <button
            type="button"
            onClick={handleAutochunk}
            className="rounded-md border border-neutral-600 bg-neutral-800 px-4 py-2 text-sm font-semibold text-neutral-200 transition hover:border-neutral-400"
          >
            Autochunk (20 words)
          </button>
        </section>

        {isCutMode && (
          <p className="mb-4 rounded-md border border-sky-700 bg-sky-500/10 px-3 py-2 text-sm text-sky-200">
            Cut mode is active. Click inside any block to split at the clicked caret position.
          </p>
        )}

        <section className="space-y-4">
          {blocks.map((block, index) => {
            const isActive = index === activeIndex;
            const isJoinSelected = selectedForJoin.includes(index);

            return (
              <div
                key={block.id}
                className={`rounded-xl border p-3 transition ${
                  isActive ? "border-sky-500 bg-neutral-900" : "border-neutral-800 bg-neutral-900/70"
                } ${isJoinSelected ? "ring-2 ring-emerald-400/50" : ""}`}
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <label className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-emerald-300">
                    <input
                      type="checkbox"
                      checked={isJoinSelected}
                      onChange={() => toggleJoinSelection(index)}
                      className="h-4 w-4 accent-emerald-500"
                    />
                    Join
                  </label>
                  <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Block {String(index + 1)}
                  </span>
                </div>

                <textarea
                  value={block.text}
                  onChange={(event) => handleEdit(index, event.target.value)}
                  onFocus={() => setActiveIndex(index)}
                  onMouseUp={(event) => handleTextareaMouseUp(index, event.currentTarget.selectionStart)}
                  className="min-h-28 w-full resize-y rounded-md border border-neutral-700 bg-neutral-800 p-3 text-sm text-neutral-100 outline-none transition focus:border-sky-500"
                  placeholder="Type block text"
                />
              </div>
            );
          })}
        </section>
      </main>
    </div>
  );
}
