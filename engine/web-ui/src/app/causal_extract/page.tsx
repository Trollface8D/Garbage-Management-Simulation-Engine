"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
    loadCausalArtifactsForItem,
    loadCausalSourceItems,
    loadComponents,
    loadProjects,
    saveCausalArtifactsForItem,
    saveTextChunksForItem,
    loadTextChunksForItem,
    saveCausalSourceItem,
    uploadCausalSourceFile,
    type CausalSourceItem,
    type FollowUpExportRecord,
    type ExtractionPayloadRecord,
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

type UploadProcessLogLevel = "info" | "success" | "error";
type UploadProcessFileKind = "txt" | "pdf" | "audio" | "unknown";

type UploadProcessLogEntry = {
    id: string;
    timestamp: string;
    fileName: string;
    fileKind: UploadProcessFileKind;
    level: UploadProcessLogLevel;
    message: string;
};

type ChunkingImportPayload = {
    export_type: "chunking";
    version: "1.0";
    file_name?: string;
    chunks: Array<{
        index: number;
        metadata?: Record<string, unknown>;
        content: string;
    }>;
};

type CausalImportPayload = {
    export_type: "causal";
    version: "1.0";
    file_name?: string;
    raw_extraction: ExtractionPayloadRecord[];
    follow_up?: FollowUpExportRecord[];
    chunk_snapshot?: Array<{
        index: number;
        metadata?: Record<string, unknown>;
        content: string;
    }>;
};

type ArtifactBundleExportPayload = {
    export_type: "causal_bundle";
    version: "1.0";
    exported_at: string;
    project_id: string;
    component_id: string;
    item: {
        id: string;
        label: string;
        file_name: string;
        source_type: SourceType;
        status: DataStatus;
        tags: string[];
    };
    chunks: Array<{
        index: number;
        metadata: {
            length: number;
            source: "text_chunks";
        };
        content: string;
    }>;
    raw_extraction: ExtractionPayloadRecord[];
    follow_up: FollowUpExportRecord[];
};

function isChunkingImportPayload(value: unknown): value is ChunkingImportPayload {
    if (!value || typeof value !== "object") {
        return false;
    }

    const payload = value as Partial<ChunkingImportPayload>;
    return payload.export_type === "chunking" && Array.isArray(payload.chunks);
}

function isCausalImportPayload(value: unknown): value is CausalImportPayload {
    if (!value || typeof value !== "object") {
        return false;
    }

    const payload = value as Partial<CausalImportPayload>;
    return payload.export_type === "causal" && Array.isArray(payload.raw_extraction);
}

function isArtifactBundleImportPayload(value: unknown): value is ArtifactBundleExportPayload {
    if (!value || typeof value !== "object") {
        return false;
    }

    const payload = value as Partial<ArtifactBundleExportPayload>;
    return payload.export_type === "causal_bundle" && payload.item !== undefined && Array.isArray(payload.chunks);
}

function isFeatureTab(value: string | null): value is FeatureTab {
    return value === "chunking" || value === "extract" || value === "follow_up";
}

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

function sanitizeFilenameSegment(value: string): string {
    return value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "item";
}

function downloadJsonFile(fileName: string, payload: unknown): void {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
}

function detectUploadProcessFileKind(file: File): UploadProcessFileKind {
    const lowerName = file.name.toLowerCase();

    if (file.type.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|flac|aac|webm)$/i.test(lowerName)) {
        return "audio";
    }

    if (file.type === "application/pdf" || lowerName.endsWith(".pdf")) {
        return "pdf";
    }

    if (lowerName.endsWith(".txt")) {
        return "txt";
    }

    return "unknown";
}

function normalizeLogPreview(text: string, maxLength = 140): string {
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= maxLength) {
        return compact;
    }
    return `${compact.slice(0, Math.max(1, maxLength - 3))}...`;
}

function getUploadKindLabel(kind: UploadProcessFileKind): string {
    if (kind === "audio") {
        return "audio";
    }
    if (kind === "pdf") {
        return "pdf";
    }
    if (kind === "txt") {
        return "txt";
    }
    return "file";
}

function getUploadLogLevelClass(level: UploadProcessLogLevel): string {
    if (level === "success") {
        return "text-emerald-300";
    }
    if (level === "error") {
        return "text-red-300";
    }
    return "text-neutral-300";
}

function CausalExtractHomeContent() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const componentId = searchParams.get("componentId");
    const queryTitle = searchParams.get("title");
    const queryProjectId = searchParams.get("projectId");
    const featureFromQuery = searchParams.get("feature");

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
    const [activeFeature, setActiveFeature] = useState<FeatureTab>(
        isFeatureTab(featureFromQuery) ? featureFromQuery : "chunking",
    );
    const [includeImplicit, setIncludeImplicit] = useState<boolean>(true);
    const [inputText, setInputText] = useState<string>("");
    const [uploadedFiles, setUploadedFiles] = useState<UploadedLocalFile[]>([]);
    const [experimentItems, setExperimentItems] = useState<ExperimentItem[]>([]);
    const [chunkCountsByItemId, setChunkCountsByItemId] = useState<Record<string, number>>({});
    const [uploadStatus, setUploadStatus] = useState<string>("");
    const [uploadProcessLog, setUploadProcessLog] = useState<UploadProcessLogEntry[]>([]);
    const [isHydratingItems, setIsHydratingItems] = useState<boolean>(false);
    const filePickerRef = useRef<HTMLInputElement | null>(null);
    const importPickerRef = useRef<HTMLInputElement | null>(null);

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
        if (isFeatureTab(featureFromQuery) && featureFromQuery !== activeFeature) {
            setActiveFeature(featureFromQuery);
        }
    }, [activeFeature, featureFromQuery]);

    const handleSelectFeature = (feature: FeatureTab) => {
        setActiveFeature(feature);

        const nextQuery = new URLSearchParams(searchParams.toString());
        nextQuery.set("feature", feature);
        router.replace(`${pathname}?${nextQuery.toString()}`, { scroll: false });
    };

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

    const handleOpenImportPicker = () => {
        importPickerRef.current?.click();
    };

    const appendImportedItem = (saved: CausalSourceItem, sourceFileType = "application/json") => {
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

        setUploadedFiles((prev) => [
            {
                id: saved.id,
                fileName: saved.fileName,
                fileType: sourceFileType,
            },
            ...prev,
        ]);
    };

    const handleImportFilesSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const picked = Array.from(event.target.files ?? []);
        event.currentTarget.value = "";

        if (picked.length === 0) {
            return;
        }

        if (!selectedProjectId || !componentId) {
            setUploadStatus("Select a component first before importing artifacts.");
            return;
        }

        const errors: string[] = [];
        let importedCount = 0;

        for (const file of picked) {
            try {
                const text = await file.text();
                const parsed = JSON.parse(text) as unknown;

                if (isArtifactBundleImportPayload(parsed)) {
                    const chunks = [...parsed.chunks]
                        .sort((left, right) => left.index - right.index)
                        .map((entry) => (typeof entry.content === "string" ? entry.content.trim() : ""))
                        .filter(Boolean);

                    const extractionPayload = Array.isArray(parsed.raw_extraction) ? parsed.raw_extraction : [];
                    const followUpPayload = Array.isArray(parsed.follow_up) ? parsed.follow_up : [];

                    const status: DataStatus = extractionPayload.length > 0
                        ? "extracted"
                        : chunks.length > 0
                            ? "chunked"
                            : "raw_text";

                    const itemId = createLocalId("imported-bundle");
                    const inferredName =
                        parsed.item.file_name?.trim() || file.name || `${itemId}.txt`;

                    const sourceText = chunks.length > 0
                        ? chunks.join("\n\n")
                        : extractionPayload
                            .flatMap((chunk) => chunk.classes.map((item) => item.source_text).filter(Boolean))
                            .join("\n\n");

                    const savedItem = await saveCausalSourceItem({
                        id: itemId,
                        projectId: selectedProjectId,
                        componentId,
                        label: parsed.item.label?.trim() || "imported artifact bundle",
                        fileName: inferredName,
                        sourceType: parsed.item.source_type === "audio" ? "audio" : "text",
                        status,
                        tags: Array.from(new Set(["imported", "bundle", ...(parsed.item.tags ?? [])])),
                        textContent: sourceText,
                    });

                    if (chunks.length > 0) {
                        await saveTextChunksForItem({
                            experimentItemId: itemId,
                            projectId: selectedProjectId,
                            componentId,
                            chunks,
                            model: "imported-json",
                            chunkSizeWords: 20,
                            chunkOverlapWords: 0,
                        });
                    }

                    if (extractionPayload.length > 0 || followUpPayload.length > 0) {
                        await saveCausalArtifactsForItem({
                            experimentItemId: itemId,
                            rawExtraction: extractionPayload,
                            followUp: followUpPayload,
                        });
                    }

                    appendImportedItem({ ...savedItem, status }, file.type || "application/json");
                    importedCount += 1;
                    continue;
                }

                if (isChunkingImportPayload(parsed)) {
                    const chunks = [...parsed.chunks]
                        .sort((left, right) => left.index - right.index)
                        .map((entry) => (typeof entry.content === "string" ? entry.content.trim() : ""))
                        .filter(Boolean);

                    if (chunks.length === 0) {
                        throw new Error("Chunking file has no valid chunk content.");
                    }

                    const itemId = createLocalId("imported-chunk");
                    const inferredName = parsed.file_name?.trim() || file.name || `${itemId}.txt`;
                    const savedItem = await saveCausalSourceItem({
                        id: itemId,
                        projectId: selectedProjectId,
                        componentId,
                        label: "imported chunking artifact",
                        fileName: inferredName,
                        sourceType: "text",
                        status: "raw_text",
                        tags: ["imported", "chunking"],
                        textContent: chunks.join("\n\n"),
                    });

                    await saveTextChunksForItem({
                        experimentItemId: itemId,
                        projectId: selectedProjectId,
                        componentId,
                        chunks,
                        model: "imported-json",
                        chunkSizeWords: 20,
                        chunkOverlapWords: 0,
                    });

                    appendImportedItem({ ...savedItem, status: "chunked" }, file.type || "application/json");
                    importedCount += 1;
                    continue;
                }

                if (isCausalImportPayload(parsed)) {
                    const chunkSnapshot = [...(parsed.chunk_snapshot ?? [])]
                        .sort((left, right) => left.index - right.index)
                        .map((entry) => (typeof entry.content === "string" ? entry.content.trim() : ""))
                        .filter(Boolean);
                    const itemId = createLocalId("imported-causal");
                    const inferredName = parsed.file_name?.trim() || file.name || `${itemId}.txt`;

                    const sourceText = chunkSnapshot.length > 0
                        ? chunkSnapshot.join("\n\n")
                        : parsed.raw_extraction
                            .flatMap((chunk) => chunk.classes.map((item) => item.source_text).filter(Boolean))
                            .join("\n\n");

                    const savedItem = await saveCausalSourceItem({
                        id: itemId,
                        projectId: selectedProjectId,
                        componentId,
                        label: "imported causal artifact",
                        fileName: inferredName,
                        sourceType: "text",
                        status: "raw_text",
                        tags: ["imported", "causal"],
                        textContent: sourceText,
                    });

                    if (chunkSnapshot.length > 0) {
                        await saveTextChunksForItem({
                            experimentItemId: itemId,
                            projectId: selectedProjectId,
                            componentId,
                            chunks: chunkSnapshot,
                            model: "imported-json",
                            chunkSizeWords: 20,
                            chunkOverlapWords: 0,
                        });
                    }

                    await saveCausalArtifactsForItem({
                        experimentItemId: itemId,
                        rawExtraction: parsed.raw_extraction,
                        followUp: parsed.follow_up ?? [],
                    });

                    appendImportedItem({ ...savedItem, status: "extracted" }, file.type || "application/json");
                    importedCount += 1;
                    continue;
                }

                throw new Error("Unsupported export file type.");
            } catch (error) {
                const message = error instanceof Error ? error.message : "Unknown import error.";
                errors.push(`${file.name}: ${message}`);
            }
        }

        if (errors.length > 0) {
            setUploadStatus(
                `Imported ${String(importedCount)} file(s). Skipped ${String(errors.length)}: ${errors.join(" | ")}`,
            );
            return;
        }

        setUploadStatus(`Imported ${String(importedCount)} file(s) successfully.`);
    };

    const handleExportItemBundle = (item: ExperimentItem) => {
        void (async () => {
            if (!selectedProjectId || !componentId) {
                setUploadStatus("Select a component first before exporting artifacts.");
                return;
            }

            try {
                const [chunks, causalArtifacts] = await Promise.all([
                    loadTextChunksForItem(item.id).catch(() => []),
                    loadCausalArtifactsForItem(item.id).catch(() => ({ raw_extraction: [], follow_up: [] })),
                ]);

                const payload: ArtifactBundleExportPayload = {
                    export_type: "causal_bundle",
                    version: "1.0",
                    exported_at: new Date().toISOString(),
                    project_id: selectedProjectId,
                    component_id: componentId,
                    item: {
                        id: item.id,
                        label: item.label,
                        file_name: item.fileName,
                        source_type: item.sourceType,
                        status: item.status,
                        tags: item.tags,
                    },
                    chunks: chunks.map((content, index) => ({
                        index,
                        metadata: {
                            length: content.length,
                            source: "text_chunks",
                        },
                        content,
                    })),
                    raw_extraction: causalArtifacts.raw_extraction,
                    follow_up: causalArtifacts.follow_up,
                };

                const stamp = new Date().toISOString().replace(/[.:]/g, "-");
                const fileName = `${sanitizeFilenameSegment(item.fileName || item.id)}-bundle-${stamp}.json`;
                downloadJsonFile(fileName, payload);
                setUploadStatus(`Exported bundle for ${item.fileName}.`);
            } catch {
                setUploadStatus(`Unable to export bundle for ${item.fileName}.`);
            }
        })();
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

        const pushUploadLog = (
            fileName: string,
            fileKind: UploadProcessFileKind,
            level: UploadProcessLogLevel,
            message: string,
        ) => {
            const timestamp = new Date().toLocaleTimeString([], { hour12: false });
            setUploadProcessLog((prev) => [
                {
                    id: createLocalId("upload-log"),
                    timestamp,
                    fileName,
                    fileKind,
                    level,
                    message,
                },
                ...prev,
            ].slice(0, 120));
        };

        pushUploadLog(
            "batch",
            "unknown",
            "info",
            `Started processing ${String(picked.length)} selected file(s).`,
        );

        for (const file of picked) {
            const fileKind = detectUploadProcessFileKind(file);

            try {
                pushUploadLog(file.name, fileKind, "info", `Queued ${getUploadKindLabel(fileKind)} for upload.`);

                if (fileKind === "audio") {
                    pushUploadLog(file.name, fileKind, "info", "Uploading and transcribing audio on backend...");
                } else if (fileKind === "pdf") {
                    pushUploadLog(file.name, fileKind, "info", "Uploading and extracting text from PDF...");
                } else if (fileKind === "txt") {
                    pushUploadLog(file.name, fileKind, "info", "Uploading text file and indexing content...");
                } else {
                    pushUploadLog(file.name, fileKind, "info", "Uploading file and attempting text extraction...");
                }

                const saved = await uploadCausalSourceFile({
                    projectId: selectedProjectId,
                    componentId: componentId ?? "",
                    label: "file upload",
                    file,
                });

                const preview = normalizeLogPreview(saved.textContent || "");
                const textLen = saved.textContent?.length ?? 0;

                if (saved.sourceType === "audio") {
                    pushUploadLog(
                        file.name,
                        fileKind,
                        "success",
                        `Transcription complete (${String(textLen)} chars).${preview ? ` Preview: ${preview}` : ""}`,
                    );
                } else {
                    pushUploadLog(
                        file.name,
                        fileKind,
                        "success",
                        `Text ready (${String(textLen)} chars).${preview ? ` Preview: ${preview}` : ""}`,
                    );
                }

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
                pushUploadLog(file.name, fileKind, "error", message);
            }
        }

        if (nextUploads.length > 0) {
            setUploadedFiles((prev) => [...prev, ...nextUploads]);
            setExperimentItems((prev) => [...nextItems, ...prev]);
        }

        if (errors.length > 0) {
            pushUploadLog(
                "batch",
                "unknown",
                "error",
                `Finished with ${String(errors.length)} error(s). Uploaded ${String(nextUploads.length)} file(s).`,
            );
            setUploadStatus(`Uploaded ${String(nextUploads.length)} file(s). Skipped ${String(errors.length)}: ${errors.join(" | ")}`);
            return;
        }

        pushUploadLog(
            "batch",
            "unknown",
            "success",
            `Completed successfully. Uploaded ${String(nextUploads.length)} file(s).`,
        );
        setUploadStatus(`Uploaded ${String(nextUploads.length)} file(s) successfully.`);
    };

    const handleRemoveFile = (targetId: string) => {
        void (async () => {
            await deleteCausalSourceItem(targetId);
            setUploadedFiles((prev) => prev.filter((upload) => upload.id !== targetId));
            setExperimentItems((prev) => prev.filter((item) => item.id !== targetId));
            setChunkCountsByItemId((prev) => {
                const next = { ...prev };
                delete next[targetId];
                return next;
            });
        })();
    };

    const handleDeleteItemCard = (targetId: string) => {
        void (async () => {
            await deleteCausalSourceItem(targetId);
            setUploadedFiles((prev) => prev.filter((upload) => upload.id !== targetId));
            setExperimentItems((prev) => prev.filter((item) => item.id !== targetId));
            setChunkCountsByItemId((prev) => {
                const next = { ...prev };
                delete next[targetId];
                return next;
            });
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
                        {/* <span className="text-xs text-neutral-400">{selectedProjectName}</span> */}
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
                                Add .txt, .pdf, or audio files. Audio will be transcribed to text on the backend.
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
                                accept=".txt,.pdf,audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac,.webm"
                                onChange={(event) => {
                                    void handleFilesSelected(event);
                                }}
                                className="hidden"
                            />
                            <button
                                type="button"
                                onClick={handleOpenImportPicker}
                                className="mt-3 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-sky-600 bg-sky-500/10 px-4 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/20"
                                aria-label="Import artifact JSON"
                            >
                                <span>Import artifact bundle JSON</span>
                            </button>
                            <input
                                ref={importPickerRef}
                                type="file"
                                multiple
                                accept="application/json,.json"
                                onChange={(event) => {
                                    void handleImportFilesSelected(event);
                                }}
                                className="hidden"
                            />
                            <p className="mt-2 text-xs text-neutral-500">
                                {uploadedFiles.length > 0
                                    ? `${String(uploadedFiles.length)} file${uploadedFiles.length > 1 ? "s" : ""} selected`
                                    : "No files selected yet"}
                            </p>
                            <p className="mt-1 text-xs text-neutral-500">{uploadStatus}</p>

                            <div className="mt-3 rounded-lg border border-neutral-700 bg-neutral-950/70 p-2">
                                <div className="flex items-center justify-between gap-2">
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-300">
                                        Process log
                                    </p>
                                    <button
                                        type="button"
                                        onClick={() => setUploadProcessLog([])}
                                        className="rounded border border-neutral-700 px-2 py-1 text-[10px] font-semibold text-neutral-300 transition hover:border-neutral-500"
                                    >
                                        Clear
                                    </button>
                                </div>
                                <div className="mt-2 max-h-44 space-y-1 overflow-y-auto pr-1">
                                    {uploadProcessLog.length === 0 ? (
                                        <p className="text-[11px] text-neutral-500">
                                            Waiting for uploads. Logs for txt, pdf, and audio processing will appear here.
                                        </p>
                                    ) : (
                                        uploadProcessLog.map((entry) => (
                                            <article
                                                key={entry.id}
                                                className="rounded border border-neutral-800 bg-neutral-900/80 px-2 py-1"
                                            >
                                                <p className="text-[10px] text-neutral-500">
                                                    [{entry.timestamp}] {entry.fileName}
                                                </p>
                                                <p className={`text-[11px] ${getUploadLogLevelClass(entry.level)}`}>
                                                    {entry.message}
                                                </p>
                                            </article>
                                        ))
                                    )}
                                </div>
                            </div>
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
                                            onClick={() => handleSelectFeature(feature)}
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
                                                feature: activeFeature,
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
                                            <div className="flex items-center gap-2">
                                                <p className={`text-xs font-semibold ${chunkCount > 0 ? "text-emerald-300" : "text-neutral-400"}`}>
                                                    {String(chunkCount)} chunk{chunkCount === 1 ? "" : "s"}
                                                </p>
                                                <button
                                                    type="button"
                                                    onClick={(event) => {
                                                        event.preventDefault();
                                                        event.stopPropagation();
                                                        handleExportItemBundle(item);
                                                    }}
                                                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-sky-700 bg-sky-500/10 text-sky-200 transition hover:bg-sky-500/20"
                                                    aria-label={`Export bundle for ${item.fileName}`}
                                                    title="Export bundle JSON"
                                                >
                                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                                                        <path d="M12 3v12" />
                                                        <path d="M8 11l4 4 4-4" />
                                                        <path d="M5 19h14" />
                                                    </svg>
                                                </button>
                                                {(activeFeature === "chunking" || activeFeature === "extract") && (
                                                    <button
                                                        type="button"
                                                        onClick={(event) => {
                                                            event.preventDefault();
                                                            event.stopPropagation();
                                                            handleDeleteItemCard(item.id);
                                                        }}
                                                        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-red-800 bg-red-500/10 text-red-300 transition hover:bg-red-500/20"
                                                        aria-label={`Delete ${item.fileName}`}
                                                        title="Delete this item"
                                                    >
                                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                                                            <path d="M3 6h18" />
                                                            <path d="M8 6V4h8v2" />
                                                            <path d="M19 6l-1 14H6L5 6" />
                                                            <path d="M10 11v6" />
                                                            <path d="M14 11v6" />
                                                        </svg>
                                                    </button>
                                                )}
                                            </div>
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
