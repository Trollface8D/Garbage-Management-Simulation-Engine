"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import BackToHome from "../components/back-to-home";
import {
    findComponentById as findSeedComponentById,
    findProjectById as findSeedProjectById,
    getProjectIdForComponent,
    type SimulationComponent,
    type SimulationProject,
} from "@/lib/simulation-components";
import {
    deleteCausalSourceItem,
    loadCausalSourceItems,
    loadComponents,
    loadProjects,
    loadTextChunksForItem,
    saveCausalSourceItem,
    uploadCausalSourceFile,
    type CausalSourceItem,
} from "@/lib/pm-storage";

type FeatureTab = "chunking" | "extract" | "follow_up";
type DataStatus = "raw_text" | "chunked" | "extracted";
type SourceType = "text" | "audio";

type ExperimentItem = {
    id: string;
    label: string;
    fileName: string;
    sourceType: SourceType;
    status: DataStatus;
    tags: string[];
};

type UploadedLocalFile = {
    id: string;
    fileName: string;
    fileType: string;
};

const STATUS_RANK: Record<DataStatus, number> = {
    raw_text: 0,
    chunked: 1,
    extracted: 2,
};

const FEATURE_MIN_STATUS: Record<FeatureTab, DataStatus> = {
    chunking: "raw_text",
    extract: "chunked",
    follow_up: "extracted",
};

const STATUS_LABEL: Record<DataStatus, string> = {
    raw_text: "not chunked",
    chunked: "chunked",
    extracted: "extracted",
};

const FEATURE_PATH: Record<FeatureTab, string> = {
    chunking: "/causal_extract/chunking",
    extract: "/causal_extract/extract",
    follow_up: "/causal_extract/follow_up",
};

function createLocalId(prefix: string): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return `${prefix}-${crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function CausalExtractHomeContent() {
    const searchParams = useSearchParams();

    const componentId = searchParams.get("componentId");
    const queryTitle = searchParams.get("title");
    const queryProjectId = searchParams.get("projectId");

    const [projects, setProjects] = useState<SimulationProject[]>([]);
    const [components, setComponents] = useState<SimulationComponent[]>([]);

    useEffect(() => {
        const loadData = async () => {
            const [nextProjects, nextComponents] = await Promise.all([
                loadProjects(),
                loadComponents(),
            ]);

            setProjects(nextProjects);
            setComponents(nextComponents);
        };

        void loadData();
    }, []);

    const selectedComponent = useMemo(
        () => components.find((component) => component.id === componentId) ?? findSeedComponentById(componentId),
        [componentId, components],
    );
    const selectedTitle = queryTitle ?? selectedComponent?.title ?? "Causal Experiment";
    const selectedProjectId =
        queryProjectId ??
        (selectedComponent && selectedComponent.category !== "PolicyTesting" ? selectedComponent.projectId : undefined) ??
        getProjectIdForComponent(componentId) ??
        projects[0]?.id ??
        "";
    const [activeFeature, setActiveFeature] = useState<FeatureTab>("chunking");
    const [includeImplicit, setIncludeImplicit] = useState<boolean>(true);
    const [inputText, setInputText] = useState<string>("");
    const [uploadedFiles, setUploadedFiles] = useState<UploadedLocalFile[]>([]);
    const [experimentItems, setExperimentItems] = useState<ExperimentItem[]>([]);
    const [chunkCountsByItemId, setChunkCountsByItemId] = useState<Record<string, number>>({});
    const [uploadStatus, setUploadStatus] = useState<string>("");
    const [isHydratingItems, setIsHydratingItems] = useState<boolean>(false);
    const filePickerRef = useRef<HTMLInputElement | null>(null);

    const selectedProjectName = useMemo(
        () =>
            projects.find((project) => project.id === selectedProjectId)?.name ??
            findSeedProjectById(selectedProjectId)?.name ??
            "Unselected project",
        [projects, selectedProjectId],
    );

    const visibleItems = useMemo(() => {
        const minStatus = FEATURE_MIN_STATUS[activeFeature];

        return experimentItems.filter((item) => {
            if (STATUS_RANK[item.status] < STATUS_RANK[minStatus]) {
                return false;
            }

            if (activeFeature === "follow_up" && !includeImplicit && item.tags.includes("implicit")) {
                return false;
            }

            return true;
        });
    }, [activeFeature, experimentItems, includeImplicit]);

    const hydrateItemsFromDb = useCallback(async (projectId: string, targetComponentId: string) => {
        if (!projectId || !targetComponentId) {
            setExperimentItems([]);
            setUploadedFiles([]);
            return;
        }

        setIsHydratingItems(true);
        try {
            const items = await loadCausalSourceItems(projectId, targetComponentId);

            const mappedItems: ExperimentItem[] = items.map((item: CausalSourceItem) => ({
                id: item.id,
                label: item.label,
                fileName: item.fileName,
                sourceType: item.sourceType,
                status: item.status,
                tags: item.tags,
            }));

            const mappedUploads: UploadedLocalFile[] = items
                .filter((item) => item.tags.includes("uploaded"))
                .map((item) => ({
                    id: item.id,
                    fileName: item.fileName,
                    fileType: item.sourceType === "audio" ? "audio/*" : "text/plain",
                }));

            setExperimentItems(mappedItems);
            setUploadedFiles(mappedUploads);
        } catch {
            setUploadStatus("Unable to load saved source files for this project.");
        } finally {
            setIsHydratingItems(false);
        }
    }, []);

    useEffect(() => {
        void hydrateItemsFromDb(selectedProjectId, componentId ?? "");
    }, [componentId, hydrateItemsFromDb, selectedProjectId]);

    useEffect(() => {
        if (experimentItems.length === 0) {
            setChunkCountsByItemId({});
            return;
        }

        let isCancelled = false;

        const hydrateChunkCounts = async () => {
            const countEntries = await Promise.all(
                experimentItems.map(async (item) => {
                    try {
                        const chunks = await loadTextChunksForItem(item.id);
                        return [item.id, chunks.length] as const;
                    } catch {
                        return [item.id, 0] as const;
                    }
                }),
            );

            if (!isCancelled) {
                setChunkCountsByItemId(Object.fromEntries(countEntries));
            }
        };

        void hydrateChunkCounts();

        return () => {
            isCancelled = true;
        };
    }, [experimentItems]);

    const handleOpenFilePicker = () => {
        filePickerRef.current?.click();
    };

    const handleFilesSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const picked = Array.from(event.target.files ?? []);
        event.currentTarget.value = "";

        if (picked.length === 0) {
            return;
        }

        if (!selectedProjectId || !componentId) {
            setUploadStatus("Select a component first before uploading files.");
            return;
        }

        const nextUploads: UploadedLocalFile[] = [];
        const nextItems: ExperimentItem[] = [];
        const errors: string[] = [];

        for (const file of picked) {
            try {
                const saved = await uploadCausalSourceFile({
                    projectId: selectedProjectId,
                    componentId: componentId ?? "",
                    label: "file upload",
                    file,
                });

                nextUploads.push({
                    id: saved.id,
                    fileName: saved.fileName,
                    fileType: file.type || "unknown file type",
                });

                nextItems.push({
                    id: saved.id,
                    label: saved.label,
                    fileName: saved.fileName,
                    sourceType: saved.sourceType,
                    status: saved.status,
                    tags: saved.tags,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : "Unknown upload error.";
                errors.push(`${file.name}: ${message}`);
            }
        }

        if (nextUploads.length > 0) {
            setUploadedFiles((prev) => [...prev, ...nextUploads]);
            setExperimentItems((prev) => [...nextItems, ...prev]);
        }

        if (errors.length > 0) {
            setUploadStatus(`Uploaded ${String(nextUploads.length)} file(s). Skipped ${String(errors.length)}: ${errors.join(" | ")}`);
            return;
        }

        setUploadStatus(`Uploaded ${String(nextUploads.length)} file(s) successfully.`);
    };

    const handleRemoveFile = (targetId: string) => {
        void (async () => {
            await deleteCausalSourceItem(targetId);
            setUploadedFiles((prev) => prev.filter((upload) => upload.id !== targetId));
            setExperimentItems((prev) => prev.filter((item) => item.id !== targetId));
        })();
    };

    const handleSubmit = () => {
        const trimmed = inputText.trim();
        if (!trimmed) {
            return;
        }

        if (!selectedProjectId || !componentId) {
            setUploadStatus("Select a component first before submitting text.");
            return;
        }

        const noteCount = experimentItems.filter((item) => /^note\d+\.txt$/i.test(item.fileName)).length;
        const nextNoteFileName = `note${String(noteCount + 1)}.txt`;

        const noteItem: ExperimentItem = {
            id: createLocalId("note"),
            label: "text note",
            fileName: nextNoteFileName,
            sourceType: "text",
            status: "raw_text",
            tags: ["manual note"],
        };

        void (async () => {
            const saved = await saveCausalSourceItem({
                id: noteItem.id,
                projectId: selectedProjectId,
                componentId: componentId ?? "",
                label: noteItem.label,
                fileName: noteItem.fileName,
                sourceType: noteItem.sourceType,
                status: noteItem.status,
                tags: noteItem.tags,
                textContent: trimmed,
            });

            setExperimentItems((prev) => [
                {
                    id: saved.id,
                    label: saved.label,
                    fileName: saved.fileName,
                    sourceType: saved.sourceType,
                    status: saved.status,
                    tags: saved.tags,
                },
                ...prev,
            ]);
            setInputText("");
        })();
    };

    const activeFeaturePath = FEATURE_PATH[activeFeature];
    const projectBackHref = selectedProjectId ? `/pm/${encodeURIComponent(selectedProjectId)}` : "/";

    return (
        <div className="min-h-screen bg-[#1e1e1e] text-neutral-100">
            <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
                <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
                    <h1 className="text-left text-3xl font-black uppercase tracking-tight text-neutral-100 md:text-5xl lg:text-6xl">
                        Garbage Flow Simulation Engine
                    </h1>
                    <div className="mt-5 flex flex-wrap items-center gap-3">
                        <span className="text-sm font-semibold text-neutral-300">
                            Project
                        </span>
                        <span className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100">
                            {selectedProjectName}
                        </span>
                        <span className="text-xs text-neutral-400">{selectedProjectName}</span>
                    </div>
                    <BackToHome
                        href={projectBackHref}
                        label="Back to project"
                        containerClassName=""
                        className="rounded-md px-3 py-2"
                    />
                </header>

                <section className="grid gap-6 lg:grid-cols-[280px_1fr]">
                    <aside className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
                        <h2 className="text-2xl font-bold text-neutral-100">Input section</h2>
                        <label htmlFor="causal-input" className="mt-5 block text-sm text-neutral-300">
                            Text document
                        </label>
                        <textarea
                            id="causal-input"
                            value={inputText}
                            onChange={(event) => setInputText(event.target.value)}
                            placeholder="input text here"
                            className="mt-2 min-h-28 w-full rounded-md border border-neutral-700 bg-neutral-800 p-3 text-sm text-neutral-100 outline-none transition focus:border-sky-500"
                        />

                        <button
                            type="button"
                            onClick={handleSubmit}
                            className="mt-4 w-full rounded-md border border-neutral-700 bg-neutral-800 px-4 py-3 text-sm font-semibold text-neutral-100 transition hover:border-sky-500"
                        >
                            Submit
                        </button>

                        <div className="mt-4 rounded-xl border border-dashed border-neutral-600 bg-neutral-900/70 p-4">
                            <p className="text-sm font-semibold text-neutral-200">Upload source files</p>
                            <p className="mt-1 text-xs text-neutral-400">
                                Add text, PDF, or audio files. Audio will be transcribed to text on the backend.
                            </p>
                            <button
                                type="button"
                                onClick={handleOpenFilePicker}
                                className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-neutral-600 bg-neutral-800 px-4 py-3 text-sm font-semibold text-neutral-100 transition hover:border-sky-500 hover:bg-neutral-800/90"
                                aria-label="Upload files"
                            >
                                <span className="text-lg leading-none">+</span>
                                <span>Choose files</span>
                            </button>
                            <input
                                ref={filePickerRef}
                                type="file"
                                multiple
                                accept=".txt,.pdf,text/plain,application/pdf,audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac"
                                onChange={(event) => {
                                    void handleFilesSelected(event);
                                }}
                                className="hidden"
                            />
                            <p className="mt-2 text-xs text-neutral-500">
                                {uploadedFiles.length > 0
                                    ? `${String(uploadedFiles.length)} file${uploadedFiles.length > 1 ? "s" : ""} selected`
                                    : "No files selected yet"}
                            </p>
                            <p className="mt-1 text-xs text-neutral-500">{uploadStatus}</p>
                        </div>

                        {uploadedFiles.length > 0 && (
                            <div className="mt-3 space-y-2">
                                {uploadedFiles.map((upload) => (
                                    <article
                                        key={upload.id}
                                        className="relative rounded-lg border border-neutral-700 bg-neutral-800/80 p-3 pr-10"
                                    >
                                        <p className="text-xs font-semibold text-neutral-100">{upload.fileName}</p>
                                        <p className="mt-1 text-[11px] text-neutral-400">{upload.fileType || "unknown file type"}</p>
                                        <button
                                            type="button"
                                            onClick={() => handleRemoveFile(upload.id)}
                                            className="absolute bottom-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-md border border-red-800 bg-red-500/10 text-red-300 transition hover:bg-red-500/20"
                                            aria-label={`Delete ${upload.fileName}`}
                                        >
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                                                <path d="M3 6h18" />
                                                <path d="M8 6V4h8v2" />
                                                <path d="M19 6l-1 14H6L5 6" />
                                                <path d="M10 11v6" />
                                                <path d="M14 11v6" />
                                            </svg>
                                        </button>
                                    </article>
                                ))}
                            </div>
                        )}
                    </aside>

                    <section className="rounded-xl border border-neutral-700 bg-neutral-900/50 p-4">
                        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                            <div className="flex flex-wrap items-center gap-2">
                                {(["chunking", "extract", "follow_up"] as FeatureTab[]).map((feature) => {
                                    const isActive = feature === activeFeature;
                                    const label = feature === "follow_up" ? "follow_up" : feature;

                                    return (
                                        <button
                                            key={feature}
                                            type="button"
                                            onClick={() => setActiveFeature(feature)}
                                            className={`rounded-md border px-4 py-2 text-sm font-semibold transition ${isActive
                                                    ? "border-sky-500 bg-sky-500/25 text-sky-100"
                                                    : "border-neutral-700 bg-neutral-800 text-neutral-300 hover:border-neutral-500"
                                                }`}
                                        >
                                            {label}
                                        </button>
                                    );
                                })}
                            </div>

                            {activeFeature === "follow_up" && (
                                <label className="inline-flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-200">
                                    <span>Toggle implicit causal</span>
                                    <button
                                        type="button"
                                        onClick={() => setIncludeImplicit((prev) => !prev)}
                                        className={`rounded px-3 py-1 text-xs font-bold ${includeImplicit ? "bg-emerald-500/25 text-emerald-200" : "bg-neutral-700 text-neutral-200"
                                            }`}
                                    >
                                        {includeImplicit ? "ON" : "OFF"}
                                    </button>
                                </label>
                            )}
                        </div>

                        <div className="space-y-3">
                            {isHydratingItems ? (
                                <div className="flex min-h-72 items-center justify-center rounded-lg border border-dashed border-neutral-700 bg-neutral-900/60 p-6 text-center">
                                    <p className="max-w-md text-sm text-neutral-300">Loading saved source items...</p>
                                </div>
                            ) : visibleItems.length === 0 ? (
                                <div className="flex min-h-72 items-center justify-center rounded-lg border border-dashed border-neutral-700 bg-neutral-900/60 p-6 text-center">
                                    <p className="max-w-md text-sm text-neutral-300">
                                        There is no upload data yet currently. Please upload a file or add a text description and submit.
                                    </p>
                                </div>
                            ) : (
                                visibleItems.map((item) => (
                                    (() => {
                                        const chunkCount = chunkCountsByItemId[item.id] ?? 0;
                                        const isChunked = STATUS_RANK[item.status] >= STATUS_RANK.chunked || chunkCount > 0;

                                        return (
                                    <Link
                                        key={item.id}
                                        href={{
                                            pathname: activeFeaturePath,
                                            query: {
                                                componentId: componentId ?? "",
                                                title: selectedTitle,
                                                projectId: selectedProjectId,
                                                itemId: item.id,
                                                itemStatus: item.status,
                                                sourceType: item.sourceType,
                                                fileName: item.fileName,
                                            },
                                        }}
                                        className={`block rounded-lg border bg-neutral-900/80 p-4 transition hover:border-sky-500/70 ${
                                            isChunked ? "border-emerald-600/80" : "border-neutral-700"
                                        }`}
                                    >
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                            <div>
                                                <p className="text-sm font-semibold text-neutral-100">{item.label}</p>
                                                <p className="mt-1 text-sm text-neutral-400">{item.fileName}</p>
                                            </div>
                                            <div>
                                                <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Status</p>
                                                <p className="text-sm text-neutral-200">{STATUS_LABEL[item.status]}</p>
                                            </div>
                                        </div>
                                        <div className="mt-3 flex items-end justify-between gap-3">
                                            <div className="flex flex-wrap gap-2">
                                                {item.tags.map((tag) => (
                                                    <span key={`${item.id}-${tag}`} className="rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300">
                                                        {tag}
                                                    </span>
                                                ))}
                                            </div>
                                            <p className={`text-xs font-semibold ${chunkCount > 0 ? "text-emerald-300" : "text-neutral-400"}`}>
                                                {String(chunkCount)} chunk{chunkCount === 1 ? "" : "s"}
                                            </p>
                                        </div>
                                    </Link>
                                        );
                                    })()
                                ))
                            )}
                        </div>

                        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                            <p className="text-xs text-neutral-400">
                                Current component: <span className="font-semibold text-neutral-200">{selectedTitle}</span>
                            </p>
                            <p className="text-xs text-neutral-400">
                                Click any item card above to open {activeFeature === "follow_up" ? "follow-up" : activeFeature} for that item.
                            </p>
                        </div>
                    </section>
                </section>
            </main>
        </div>
    );
}

export default function CausalExtractHomePage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-[#1e1e1e] text-neutral-100" />}>
            <CausalExtractHomeContent />
        </Suspense>
    );
}
