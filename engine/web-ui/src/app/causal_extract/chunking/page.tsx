"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import BackToHome from "../../components/back-to-home";
import {
    findComponentById,
    findProjectById,
    getProjectIdForComponent,
    getSeedBlocksForComponent,
    type SimulationProject,
} from "@/lib/simulation-components";
import { loadCausalSourceItem, loadProjects, loadTextChunksForItem, saveTextChunksForItem } from "@/lib/pm-storage";

type TextBlock = {
    id: string;
    text: string;
};

type ToolMode = "edit" | "split";

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

function CursorToolIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
            <path d="M5 3l10 10-4 1 2 6-2 1-2-6-4 4z" />
        </svg>
    );
}

function SplitToolIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" className={className}>
            <circle cx="5.4" cy="6.6" r="3" />
            <circle cx="5.4" cy="17.4" r="3" />
            <circle cx="10.8" cy="12" r="1" fill="currentColor" stroke="none" />
            <path d="M7.9 8.5 10.8 11.7" />
            <path d="M7.9 15.5 10.8 12.3" />
            <path d="M10.8 11.7 20.6 3.8" />
            <path d="M10.8 12.3 20.6 20.2" />
            <path d="M10.8 12 15.8 8.2" strokeWidth="2" />
        </svg>
    );
}

function JoinToolIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
            <path d="M12 5v14" />
            <path d="M5 12h14" />
        </svg>
    );
}

function AiToolIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
            <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z" />
            <path d="M19 14l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
            <path d="M5 14l.8 1.6L7.5 16l-1.7.4L5 18l-.8-1.6L2.5 16l1.7-.4z" />
        </svg>
    );
}

function CausalExtractChunkingContent() {
    const searchParams = useSearchParams();

    const componentId = searchParams.get("componentId");
    const queryProjectId = searchParams.get("projectId");
    const initialJobId = searchParams.get("jobId") ?? "";
    const queryTitle = searchParams.get("title");
    const initialItemId = searchParams.get("itemId") ?? "";
    const initialItemStatus = searchParams.get("itemStatus") ?? "";

    const selectedComponent = useMemo(() => findComponentById(componentId), [componentId]);
    const selectedProjectId = queryProjectId ?? getProjectIdForComponent(componentId);

    const selectedTitle = queryTitle ?? selectedComponent?.title ?? "Unselected component";
    const engineApiBase = process.env.NEXT_PUBLIC_ENGINE_API_BASE ?? "http://127.0.0.1:8000";

    const [blocks, setBlocks] = useState<TextBlock[]>(() => buildBlocksFromTexts([]));
    const [activeIndex, setActiveIndex] = useState<number>(0);
    const [toolMode, setToolMode] = useState<ToolMode>("edit");
    const [selectedForJoin, setSelectedForJoin] = useState<number[]>([]);
    const [jobIdInput, setJobIdInput] = useState<string>(initialJobId);
    const [isLoadingBackend, setIsLoadingBackend] = useState<boolean>(false);
    const [loadStatus, setLoadStatus] = useState<string>("");
    const [chunkSaveStatus, setChunkSaveStatus] = useState<string>("");
    const [isSavingChunks, setIsSavingChunks] = useState<boolean>(false);
    const [projects, setProjects] = useState<SimulationProject[]>([]);

    const isCutMode = toolMode === "split";

    const selectedProjectName = useMemo(
        () => projects.find((project) => project.id === selectedProjectId)?.name ?? findProjectById(selectedProjectId)?.name ?? "Unselected project",
        [projects, selectedProjectId],
    );
    const projectBackHref = selectedProjectId ? `/pm/${encodeURIComponent(selectedProjectId)}` : "/";

    useEffect(() => {
        const loadProjectList = async () => {
            setProjects(await loadProjects());
        };

        void loadProjectList();
    }, []);

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
                setToolMode("edit");
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
        const seedTexts = getSeedBlocksForComponent(componentId);
        const initialTexts = seedTexts.length > 0 ? seedTexts : [DEFAULT_EDITOR_TEXT];

        setBlocks(buildBlocksFromTexts(initialTexts));
        setActiveIndex(0);
        setSelectedForJoin([]);
        setToolMode("edit");

        if (!componentId) {
            setLoadStatus("No component was selected from the dashboard. Showing default editor text.");
            return;
        }

        if (initialJobId.trim()) {
            void loadFromBackend(initialJobId, { silentFailure: true });
            return;
        }

        if (initialItemId) {
            void (async () => {
                try {
                    if (initialItemStatus === "chunked") {
                        const savedChunks = await loadTextChunksForItem(initialItemId);
                        if (savedChunks.length > 0) {
                            setBlocks(buildBlocksFromTexts(savedChunks));
                            setActiveIndex(0);
                            setSelectedForJoin([]);
                            setToolMode("edit");
                            setLoadStatus(`Loaded ${String(savedChunks.length)} saved chunks from this file.`);
                            return;
                        }
                    }

                    const savedItem = await loadCausalSourceItem(initialItemId);
                    if (savedItem.textContent.trim()) {
                        setBlocks(buildBlocksFromTexts([savedItem.textContent]));
                        setActiveIndex(0);
                        setSelectedForJoin([]);
                        setToolMode("edit");
                        setLoadStatus(`Loaded source content for ${savedItem.fileName}.`);
                        return;
                    }

                    setLoadStatus("Selected item has no saved text content.");
                } catch {
                    setLoadStatus("Unable to load saved source content.");
                }
            })();
            return;
        }

        setLoadStatus("Loaded seed text based on the selected dashboard component.");
    }, [componentId, initialItemId, initialItemStatus, initialJobId, loadFromBackend]);

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
        setToolMode("edit");
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
        setToolMode("edit");
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
        setToolMode("edit");
        setLoadStatus(`AI chunking completed with ${String(rechunked.length)} blocks.`);
    };

    const handleSaveChunks = useCallback(async () => {
        if (!initialItemId || !selectedProjectId || !componentId) {
            setChunkSaveStatus("Save unavailable: this page is not linked to a stored source item.");
            return;
        }

        const chunkTexts = blocks.map((block) => block.text.trim()).filter(Boolean);
        if (chunkTexts.length === 0) {
            setChunkSaveStatus("No chunks to save.");
            return;
        }

        setIsSavingChunks(true);
        setChunkSaveStatus("Saving chunks...");

        try {
            const result = await saveTextChunksForItem({
                experimentItemId: initialItemId,
                projectId: selectedProjectId,
                componentId,
                chunks: chunkTexts,
                model: "manual-chunking",
                chunkSizeWords: 20,
                chunkOverlapWords: 0,
            });

            setChunkSaveStatus(
                `Saved ${String(result.savedChunks)} chunk${result.savedChunks === 1 ? "" : "s"} to TextChunk.`,
            );
        } catch {
            setChunkSaveStatus("Unable to save chunks to TextChunk.");
        } finally {
            setIsSavingChunks(false);
        }
    }, [blocks, componentId, initialItemId, selectedProjectId]);

    return (
        <div className="min-h-screen bg-[#1e1e1e] text-neutral-100">
            <main className="mx-auto w-full max-w-6xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
                <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h1 className="text-3xl font-black uppercase tracking-tight md:text-4xl">Causal Extract - Chunking</h1>
                        <p className="mt-2 text-sm text-neutral-300">
                            Selected component: <span className="font-semibold text-neutral-100">{selectedTitle}</span>
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                            <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                                Project
                            </span>
                            <span className="text-sm text-neutral-300">{selectedProjectName}</span>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <BackToHome
                            href={projectBackHref}
                            label="Back to project"
                            containerClassName=""
                            className="rounded-md px-3 py-2"
                        />
                        <button
                            type="button"
                            onClick={() => void handleSaveChunks()}
                            disabled={isSavingChunks || !initialItemId || !selectedProjectId || !componentId}
                            className="rounded-md border border-emerald-600 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-55"
                        >
                            {isSavingChunks ? "Saving..." : "Save chunks"}
                        </button>
                    </div>
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
                    <p className="mt-1 text-xs text-emerald-300">{chunkSaveStatus}</p>
                </section>

                <section className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-[auto_1fr] lg:items-start">
                    <aside className="lg:sticky lg:top-6">
                        <div className="flex w-fit items-center gap-2 rounded-2xl border border-neutral-800 bg-neutral-900/70 p-2 lg:flex-col">
                            <button
                                type="button"
                                onClick={() => setToolMode("edit")}
                                title="Edit mode"
                                aria-label="Edit mode"
                                className={`rounded-xl border p-3 transition ${!isCutMode
                                        ? "border-sky-400 bg-sky-500/25 text-sky-100"
                                        : "border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-neutral-500"
                                    }`}
                            >
                                <CursorToolIcon className="h-5 w-5" />
                            </button>

                            <button
                                type="button"
                                onClick={() => setToolMode("split")}
                                title="Split by next click"
                                aria-label="Split by next click"
                                className={`rounded-xl border p-3 transition ${isCutMode
                                        ? "border-sky-400 bg-sky-500/25 text-sky-100"
                                        : "border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-neutral-500"
                                    }`}
                            >
                                <SplitToolIcon className="h-5 w-5" />
                            </button>

                            <button
                                type="button"
                                onClick={handleJoinSelected}
                                title={`Join selected (${String(selectedForJoin.length)})`}
                                aria-label={`Join selected (${String(selectedForJoin.length)})`}
                                disabled={selectedForJoin.length < 2}
                                className="rounded-xl border border-emerald-700 bg-emerald-500/10 p-3 text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <JoinToolIcon className="h-5 w-5" />
                            </button>

                            <button
                                type="button"
                                onClick={handleAutochunk}
                                title="AI chunking"
                                aria-label="AI chunking"
                                className="rounded-xl border border-violet-700 bg-violet-500/10 p-3 text-violet-200 transition hover:bg-violet-500/20"
                            >
                                <AiToolIcon className="h-5 w-5" />
                            </button>
                        </div>

                        <p className="mt-3 text-xs text-neutral-400">Join selected: {String(selectedForJoin.length)}</p>
                    </aside>

                    <div>
                        {isCutMode && (
                            <p className="mb-4 rounded-md border border-sky-700 bg-sky-500/10 px-3 py-2 text-sm text-sky-200">
                                Split mode is active. Click inside any block to split at the clicked caret position.
                            </p>
                        )}

                        <section className="space-y-4">
                            {blocks.map((block, index) => {
                                const isActive = index === activeIndex;
                                const isJoinSelected = selectedForJoin.includes(index);

                                return (
                                    <div
                                        key={block.id}
                                        className={`rounded-xl border p-3 transition ${isActive ? "border-sky-500 bg-neutral-900" : "border-neutral-800 bg-neutral-900/70"
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
                    </div>
                </section>
            </main>
        </div>
    );
}

export default function CausalExtractChunkingPage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-[#1e1e1e] text-neutral-100" />}>
            <CausalExtractChunkingContent />
        </Suspense>
    );
}
