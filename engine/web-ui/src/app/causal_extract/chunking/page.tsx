"use client";

import { useParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
    findComponentById as findSeedComponentById,
    findProjectById as findSeedProjectById,
    type SimulationComponent,
    type SimulationProject,
} from "@/lib/simulation-components";
import { loadCausalSourceItem, loadComponents, loadProjects, loadTextChunksForItem, saveTextChunksForItem } from "@/lib/pm-storage";
import CausalWorkflowHeader from "../workflow-header";

type TextBlock = {
    id: string;
    text: string;
};

type ToolMode = "edit" | "split";

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
        return [createBlock("")];
    }
    return cleaned.map((text) => createBlock(text));
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

function SaveIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
            <path d="M5 3h12l4 4v14H3V3h2z" />
            <path d="M7 3v6h10V3" />
            <path d="M8 21v-7h8v7" />
        </svg>
    );
}

function CausalExtractChunkingContent() {
    const params = useParams<{ componentId?: string; itemId?: string }>();

    const componentId = params.componentId ?? null;
    const initialItemId = params.itemId ?? "";

    const [blocks, setBlocks] = useState<TextBlock[]>(() => buildBlocksFromTexts([]));
    const [activeIndex, setActiveIndex] = useState<number>(0);
    const [toolMode, setToolMode] = useState<ToolMode>("edit");
    const [selectedForJoin, setSelectedForJoin] = useState<number[]>([]);
    const [loadStatus, setLoadStatus] = useState<string>("");
    const [chunkSaveStatus, setChunkSaveStatus] = useState<string>("");
    const [isSavingChunks, setIsSavingChunks] = useState<boolean>(false);
    const [projects, setProjects] = useState<SimulationProject[]>([]);
    const [components, setComponents] = useState<SimulationComponent[]>([]);
    const [itemSourceType, setItemSourceType] = useState<string>("");
    const [itemFileName, setItemFileName] = useState<string>("");
    const [selectedModel, setSelectedModel] = useState<string>("");

    const isCutMode = toolMode === "split";

    const selectedComponent = useMemo(
        () => (componentId
            ? components.find((component) => component.id === componentId) ?? findSeedComponentById(componentId)
            : undefined),
        [componentId, components],
    );

    const selectedProjectId = useMemo(() => {
        if (!selectedComponent || selectedComponent.category === "PolicyTesting") {
            return "";
        }

        return selectedComponent.projectId;
    }, [selectedComponent]);

    const selectedTitle = selectedComponent?.title ?? "Unselected component";

    const selectedProjectName = useMemo(
        () => projects.find((project) => project.id === selectedProjectId)?.name ?? findSeedProjectById(selectedProjectId)?.name ?? "Unselected project",
        [projects, selectedProjectId],
    );
    const hasOriginalAttachment = Boolean(
        initialItemId && (itemSourceType === "audio" || !/\.txt$/i.test(itemFileName)),
    );
    const attachmentHref = initialItemId
        ? `/api/causal-source/file?itemId=${encodeURIComponent(initialItemId)}`
        : "";

    useEffect(() => {
        const loadData = async () => {
            const [nextProjects, nextComponents] = await Promise.all([loadProjects(), loadComponents()]);
            setProjects(nextProjects);
            setComponents(nextComponents);
        };

        void loadData();
    }, []);

    useEffect(() => {
        setBlocks(buildBlocksFromTexts([]));
        setActiveIndex(0);
        setSelectedForJoin([]);
        setToolMode("edit");

        if (!componentId) {
            setLoadStatus("No component was selected from the dashboard.");
            return;
        }

        if (initialItemId) {
            void (async () => {
                try {
                    const savedItem = await loadCausalSourceItem(initialItemId);
                    setItemSourceType(savedItem.sourceType);
                    setItemFileName(savedItem.fileName);

                    const savedChunks = await loadTextChunksForItem(initialItemId);
                    if (savedChunks.length > 0) {
                        setBlocks(buildBlocksFromTexts(savedChunks));
                        setActiveIndex(0);
                        setSelectedForJoin([]);
                        setToolMode("edit");
                        setLoadStatus(`Loaded ${String(savedChunks.length)} saved chunks from this file.`);
                        return;
                    }

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
                    setItemSourceType("");
                    setItemFileName("");
                    setLoadStatus("Unable to load saved source content.");
                }
            })();
            return;
        }

        setItemSourceType("");
        setItemFileName("");
        setLoadStatus("No stored source item selected. Upload or open a saved source file first.");
    }, [componentId, initialItemId]);

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
                model: selectedModel.trim() || "manual-chunking",
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
    }, [blocks, componentId, initialItemId, selectedModel, selectedProjectId]);

    return (
        <div className="min-h-screen bg-[#1e1e1e] text-neutral-100">
            <main className="mx-auto w-full max-w-6xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
                <CausalWorkflowHeader
                    title="Causal Extract - Chunking"
                    selectedTitle={selectedTitle}
                    selectedProjectName={selectedProjectName}
                    selectedModel={selectedModel}
                    onSelectedModelChange={setSelectedModel}
                    actionsClassName="ml-auto flex flex-wrap items-center justify-end gap-2"
                />

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

                        <button
                            type="button"
                            onClick={() => void handleSaveChunks()}
                            disabled={isSavingChunks || !initialItemId || !selectedProjectId || !componentId}
                            className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md border border-emerald-700 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50 lg:w-auto"
                        >
                            <SaveIcon className="h-4 w-4" />
                            {isSavingChunks ? "Saving..." : "Save chunks"}
                        </button>

                        {hasOriginalAttachment && (
                            <article className="mt-3 w-full max-w-xs rounded-lg border border-neutral-700 bg-neutral-900/70 p-3">
                                <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Original file</p>
                                <p className="mt-1 break-all text-sm text-neutral-200">{itemFileName || "attachment"}</p>
                                <a
                                    href={attachmentHref}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="mt-3 inline-flex items-center rounded-md border border-sky-700 bg-sky-500/10 px-3 py-2 text-xs font-semibold text-sky-200 transition hover:bg-sky-500/20"
                                >
                                    Open attachment
                                </a>
                            </article>
                        )}

                        <p className="mt-3 text-xs text-neutral-400">Join selected: {String(selectedForJoin.length)}</p>
                        <p className="mt-2 max-w-xs text-xs text-neutral-400">{loadStatus}</p>
                        <p className="mt-1 max-w-xs text-xs text-emerald-300">{chunkSaveStatus}</p>
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
