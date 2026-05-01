import { useRef, useState, useCallback, type ChangeEvent } from "react";
import {
    exportWorkspaceArchive,
    importWorkspaceArchive,
} from "@/lib/code-gen-api-client";
import { type ArtifactFile } from "@/app/code/code-gen-workspace";

export type ImportedWorkspaceSnapshot = {
    selectedCausalIds: Set<string>;
    selectedMapId: string | null;
    entities: unknown[];
    isExtracted: boolean;
    selectedModel: string;
    collapsedParentIds: Set<string>;
    metrics: unknown[];
    metricsExtracted: boolean;
    artifactFiles: ArtifactFile[];
    jobId: string | null;
};

type WorkspaceSnapshot = {
    schemaVersion: number;
    exportedAt: string;
    componentId: string | null;
    selectedCausalIds: string[];
    selectedMapId: string | null;
    entities: Array<{
        id: string;
        name: string;
        count: number;
        selected: boolean;
        parentId?: string;
        memberIds?: string[];
    }>;
    isExtracted: boolean;
    selectedModel: string;
    collapsedParentIds: string[];
    metrics: Array<{
        id: string;
        name: string;
        selected: boolean;
        [key: string]: unknown;
    }>;
    metricsExtracted: boolean;
    artifactFiles: ArtifactFile[];
    jobId: string | null;
};

/**
 * Custom hook for managing archive export/import and workspace persistence.
 * Keeps archive logic separate from the main page component.
 */
export function useArchiveManager(componentId: string | null, currentJobId: string | null) {
    const [archiveBusy, setArchiveBusy] = useState<"idle" | "exporting" | "importing">("idle");
    const [archiveMessage, setArchiveMessage] = useState<string>("");
    const [archiveError, setArchiveError] = useState<string>("");

    const buildWorkspaceSnapshot = useCallback(
        (data: {
            selectedCausalIds: Set<string>;
            selectedMapId: string | null;
            entities: unknown[];
            isExtracted: boolean;
            selectedModel: string;
            collapsedParentIds: Set<string>;
            metrics: unknown[];
            metricsExtracted: boolean;
            artifactFiles: ArtifactFile[];
        }): WorkspaceSnapshot => ({
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            componentId,
            selectedCausalIds: Array.from(data.selectedCausalIds),
            selectedMapId: data.selectedMapId,
            entities: data.entities as WorkspaceSnapshot["entities"],
            isExtracted: data.isExtracted,
            selectedModel: data.selectedModel,
            collapsedParentIds: Array.from(data.collapsedParentIds),
            metrics: data.metrics as WorkspaceSnapshot["metrics"],
            metricsExtracted: data.metricsExtracted,
            artifactFiles: data.artifactFiles,
            jobId: currentJobId,
        }),
        [componentId, currentJobId],
    );

    const handleExportArchive = useCallback(
        async (snapshot: WorkspaceSnapshot) => {
            if (archiveBusy !== "idle") return;

            setArchiveBusy("exporting");
            setArchiveError("");
            setArchiveMessage("");

            try {
                const blob = await exportWorkspaceArchive(snapshot, currentJobId);
                const url = URL.createObjectURL(blob);
                const stamp = new Date()
                    .toISOString()
                    .replace(/[:.]/g, "-")
                    .replace("T", "_")
                    .slice(0, 19);
                const stub = currentJobId || componentId || "workspace";
                const a = document.createElement("a");
                a.href = url;
                a.download = `code-workspace-${stub}-${stamp}.zip`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                setArchiveMessage("Workspace exported.");
            } catch (err) {
                setArchiveError(err instanceof Error ? err.message : "Export failed.");
            } finally {
                setArchiveBusy("idle");
            }
        },
        [archiveBusy, currentJobId, componentId],
    );

    const restoreFromMetadata = useCallback(
        (parsed: Record<string, unknown>): {
            success: boolean;
            data?: ImportedWorkspaceSnapshot;
        } => {
            try {
                const data = {
                    selectedCausalIds: new Set<string>(),
                    selectedMapId: null as string | null,
                    entities: [] as unknown[],
                    isExtracted: false,
                    selectedModel: "",
                    collapsedParentIds: new Set<string>(),
                    metrics: [] as unknown[],
                    metricsExtracted: false,
                    artifactFiles: [] as ArtifactFile[],
                    jobId: null as string | null,
                };

                if (Array.isArray(parsed.selectedCausalIds)) {
                    data.selectedCausalIds = new Set(
                        (parsed.selectedCausalIds as unknown[])
                            .filter((v): v is string => typeof v === "string" && v.length > 0),
                    );
                }

                if (typeof parsed.selectedMapId === "string" || parsed.selectedMapId === null) {
                    data.selectedMapId = (parsed.selectedMapId as string | null) ?? null;
                }

                if (Array.isArray(parsed.entities)) {
                    data.entities = parsed.entities;
                }

                if (typeof parsed.isExtracted === "boolean") {
                    data.isExtracted = parsed.isExtracted;
                }

                if (typeof parsed.selectedModel === "string") {
                    data.selectedModel = parsed.selectedModel;
                }

                if (Array.isArray(parsed.collapsedParentIds)) {
                    data.collapsedParentIds = new Set(
                        (parsed.collapsedParentIds as unknown[])
                            .filter((v): v is string => typeof v === "string" && v.length > 0),
                    );
                }

                if (Array.isArray(parsed.metrics)) {
                    data.metrics = parsed.metrics;
                }

                if (typeof parsed.metricsExtracted === "boolean") {
                    data.metricsExtracted = parsed.metricsExtracted;
                }

                if (Array.isArray(parsed.artifactFiles)) {
                    data.artifactFiles = parsed.artifactFiles as ArtifactFile[];
                }

                if (typeof parsed.jobId === "string") {
                    data.jobId = parsed.jobId.trim() || null;
                }

                return { success: true, data };
            } catch {
                return { success: false };
            }
        },
        [],
    );

    const handleImportArchiveFile = useCallback(
        async (event: ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            event.target.value = "";

            if (!file) return { success: false };

            setArchiveBusy("importing");
            setArchiveError("");
            setArchiveMessage("");

            try {
                const {
                    metadata,
                    artifactNames,
                    restoredJobId,
                    restoredArtifactCount,
                    restoredCheckpointCount,
                } = await importWorkspaceArchive(file);
                const result = restoreFromMetadata(metadata);

                if (!result.success) {
                    setArchiveError("Imported metadata could not be applied.");
                    return { success: false };
                }

                const artifactNote =
                    artifactNames.length > 0
                        ? ` Restored ${String(restoredArtifactCount ?? artifactNames.length)} generated code file${(restoredArtifactCount ?? artifactNames.length) === 1 ? "" : "s"} into engine storage.`
                        : "";

                const checkpointCount = restoredCheckpointCount ?? 0;
                const checkpointNote =
                    checkpointCount > 0
                        ? ` Restored ${String(checkpointCount)} stage checkpoint file${checkpointCount === 1 ? "" : "s"}.`
                        : "";

                const rebindNote = restoredJobId
                    ? ` Rebound workspace to restored job ${restoredJobId}.`
                    : "";

                setArchiveMessage(
                    `Workspace restored from ${file.name}.${artifactNote}${checkpointNote}${rebindNote}`,
                );
                return { success: true, data: result.data };
            } catch (err) {
                setArchiveError(err instanceof Error ? err.message : "Import failed.");
                return { success: false };
            } finally {
                setArchiveBusy("idle");
            }
        },
        [restoreFromMetadata],
    );

    return {
        // State
        archiveBusy,
        archiveMessage,
        archiveError,

        // Handlers
        handleExportArchive,
        handleImportArchiveFile,
        buildWorkspaceSnapshot,
    };
}
