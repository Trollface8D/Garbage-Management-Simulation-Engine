"use client";

import { useParams, useRouter } from "next/navigation";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import ProjectPageHeader from "../components/project-page-header";
import UsedItemsSection from "@/app/code/used-items-section";
import CodeGenWorkspace, { type ArtifactFile } from "@/app/code/code-gen-workspace";
import SimulationViewer from "@/app/code/simulation-viewer";
import FloatingWorkspaceToolbar from "@/app/code/floating-workspace-toolbar";
import EntityExtractionPanel, { type GeneratedEntity } from "@/app/code/entity-extraction-panel";
import MetricsSelectionPanel, { type WorkspaceMetric } from "@/app/code/metrics-selection-panel";
import JsonImportHandler, {
    extractMapGraphPayload,
    inferImportItemCategory,
    normalizeImportPayload,
    normalizeExtractionPayload,
    type JsonImportPayload,
    type JsonImportItem,
} from "@/app/code/json-import-handler";
import {
    categoryPath,
    findComponentById as findSeedComponentById,
    findProjectById as findSeedProjectById,
    type SimulationComponent,
    type SimulationProject,
} from "@/lib/simulation-components";
import {
    createComponent,
    createProject,
    loadCausalArtifactsForItem,
    loadCausalSourceItems,
    loadComponents,
    loadProjects,
    saveCausalArtifactsForItem,
    saveCausalSourceItem,
    saveTextChunksForItem,
    softDeleteComponent,
    type ExtractionPayloadRecord,
} from "@/lib/pm-storage";
import {
    groupEntitiesWithGemini,
    exportWorkspaceArchive,
    importWorkspaceArchive,
    suggestMetrics,
    type SuggestedMetric,
} from "@/lib/code-gen-api-client";
import BackToHome from "../components/back-to-home";
import { makeSlug, makeUniqueId, buildChunkTextsFromRawExtraction, extractRawExtractionFromItem } from "@/app/code/utils-entity-metric";
import { useEntityExtraction } from "@/app/code/use-entity-extraction";
import JSZip from "jszip";
import { useMetricsManagement } from "@/app/code/use-metrics-management";
import { useSourceSelection } from "@/app/code/use-source-selection";
import { useArchiveManager, type ImportedWorkspaceSnapshot } from "@/app/code/use-archive-manager";
import { useWorkspacePersistence } from "@/app/code/use-workspace-persistence";
import { type MapGraphPayload } from "@/lib/map-types";


type CausalComponentRef = { projectId: string; componentId: string };
type UsedItem = { id: string; title: string; project: string; lastEdited: string };
type ImportedMapWorkspaceSnapshot = {
    graph: MapGraphPayload;
    jobId: string;
    selectedModel: string;
    overviewAdditionalInfo: string;
    binAdditionalInfo: string;
    overviewFileNames: string[];
    binFileNames: string[];
    changeLog: string[];
    editStatus: string;
    selection: null;
};

async function aggregateEntitiesFromCausalComponents(
    refs: CausalComponentRef[],
): Promise<GeneratedEntity[]> {
    const counts = new Map<string, number>();
    let sourceCount = 0;
    let artifactCount = 0;
    let relationCount = 0;

    for (const { projectId, componentId } of refs) {
        if (!projectId || !componentId) {
            continue;
        }
        const sources = await loadCausalSourceItems(projectId, componentId);
        sourceCount += sources.length;
        for (const source of sources) {
            const artifacts = await loadCausalArtifactsForItem(source.id);
            const chunks = artifacts.raw_extraction || [];
            if (chunks.length > 0) {
                artifactCount += 1;
            }
            for (const chunk of chunks) {
                for (const cls of chunk.classes || []) {
                    for (const rel of cls.extracted || []) {
                        relationCount += 1;
                        for (const term of [rel.head, rel.tail]) {
                            const trimmed = (term || "").trim();
                            if (!trimmed) continue;
                            counts.set(trimmed, (counts.get(trimmed) || 0) + 1);
                        }
                    }
                }
            }
        }
    }

    if (counts.size === 0) {
        console.info(
            "[code-gen] aggregator found 0 entities",
            { refs, sourceCount, artifactCount, relationCount },
        );
    }

    return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, count], idx) => ({
            id: `entity-${String(idx)}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
            name,
            count,
            selected: true,
        }));
}

function toUsedItem(component: SimulationComponent, projectNameById: Map<string, string>): UsedItem {
    const projectId = component.category === "PolicyTesting" ? "" : component.projectId;
    const resolvedProject =
        projectNameById.get(projectId) || findSeedProjectById(projectId)?.name || "Unknown project";

    return {
        id: component.id,
        title: component.title,
        project: resolvedProject,
        lastEdited: component.lastEdited || "just now",
    };
}


export default function CodePage() {
    const router = useRouter();
    const params = useParams<{ componentId?: string }>();
    const componentId = params.componentId ?? null;

    const [projects, setProjects] = useState<SimulationProject[]>([]);
    const [components, setComponents] = useState<SimulationComponent[]>([]);
    const [isImporting, setIsImporting] = useState<boolean>(false);
    const [importMessage, setImportMessage] = useState<string>("");
    const [importError, setImportError] = useState<string>("");
    const [isCodeGenRunning, setIsCodeGenRunning] = useState<boolean>(false);
    const [selectedModel, setSelectedModel] = useState<string>("");
    const [manualEntityName, setManualEntityName] = useState<string>("");
    const [manualEntityError, setManualEntityError] = useState<string>("");
    const [manualMetricName, setManualMetricName] = useState<string>("");
    const [manualMetricError, setManualMetricError] = useState<string>("");
    const [artifactFiles, setArtifactFiles] = useState<ArtifactFile[]>([]);

    // Custom hooks for state management
    const entityHook = useEntityExtraction();
    const metricsHook = useMetricsManagement();
    const sourceHook = useSourceSelection();
    const persistenceHook = useWorkspacePersistence(componentId);
    const archiveHook = useArchiveManager(componentId, componentId ? `job-${componentId}` : null);

    // Destructure hook returns for easier access
    const {
        entities,
        setEntities,
        isExtracted,
        setIsExtracted,
        isExtracting,
        isGroupingEntities,
        groupError,
        setGroupError,
        extractError,
        setExtractError,
        collapsedParentIds,
        setCollapsedParentIds,
        groupLog,
        setGroupLog,
        handleGroupWithGemini: hookHandleGroupWithGemini,
        handleCancelGrouping: hookHandleCancelGrouping,
        handleToggleEntity,
        handleAddManualEntity: hookHandleAddManualEntity,
        appendGroupLog,
    } = entityHook;

    const {
        metrics,
        setMetrics,
        metricsExtracted,
        setMetricsExtracted,
        metricsError,
        setMetricsError,
        isSuggestingMetrics,
        metricsLog,
        setMetricsLog,
        handleSuggestMetrics: hookHandleSuggestMetrics,
        handleCancelMetricsSuggest: hookHandleCancelMetricsSuggest,
        handleToggleMetric,
        handleAddManualMetric: hookHandleAddManualMetric,
    } = metricsHook;

    const {
        selectedCausalIds,
        selectedMapId,
        setSelectedCausalIds,
        setSelectedMapId,
        handleToggleCausalSelection: hookHandleToggleCausalSelection,
        handleToggleMapSelection: hookHandleToggleMapSelection,
        handleDeleteComponent: hookHandleDeleteComponent,
    } = sourceHook;

    const { hydrated, loadPersistedSnapshot, persistSnapshot } = persistenceHook;

    const {
        archiveBusy,
        archiveMessage,
        archiveError,
        buildWorkspaceSnapshot,
        handleExportArchive: hookHandleExportArchive,
        handleImportArchiveFile: hookHandleImportArchiveFile,
    } = archiveHook;

    const [currentJobId, setCurrentJobId] = useState<string | null>(null);

    const inputsLocked = isCodeGenRunning;

    const wordCloudHostRef = useRef<HTMLDivElement | null>(null);

    const selectedEntities = useMemo(
        () => entities.filter((entity) => entity.selected),
        [entities],
    );

    const wordCloudWords = useMemo(
        () =>
            selectedEntities.map((entity) => ({
                text: entity.name,
                value: entity.count,
            })),
        [selectedEntities],
    );

    const wordCloudOptions = useMemo(
        () => ({
            colors: ["#34d399", "#60a5fa", "#f59e0b", "#22d3ee", "#f472b6"],
            enableTooltip: false,
            fontFamily: "Georgia, serif",
            fontSizes: [18, 48] as [number, number],
            padding: 2,
            rotations: 1,
            rotationAngles: [0, 0] as [number, number],
            scale: "sqrt" as const,
            spiral: "archimedean" as const,
            transitionDuration: 500,
        }),
        [],
    );

    const totalEntityCount = useMemo(() => selectedEntities.length, [selectedEntities]);

    const selectedComponent = useMemo(() => {
        if (!componentId) {
            return undefined;
        }

        return (
            components.find((component) => component.id === componentId) ??
            findSeedComponentById(componentId)
        );
    }, [componentId, components]);

    const resolvedProjectId = useMemo(() => {
        if (!selectedComponent || selectedComponent.category === "PolicyTesting") {
            return null;
        }

        return selectedComponent.projectId;
    }, [selectedComponent]);

    const projectBackHref = resolvedProjectId ? `/pm/${encodeURIComponent(resolvedProjectId)}` : "/";

    const selectedProjectName = useMemo(() => {
        if (!resolvedProjectId) {
            return "Unselected project";
        }

        return (
            projects.find((project) => project.id === resolvedProjectId)?.name ||
            findSeedProjectById(resolvedProjectId)?.name ||
            "Unselected project"
        );
    }, [resolvedProjectId, projects]);

    const projectNameById = useMemo(
        () => new Map(projects.map((project) => [project.id, project.name])),
        [projects],
    );

    const causalItems = useMemo(
        () =>
            components
                .filter((component) => component.category === "Causal")
                .map((component) => toUsedItem(component, projectNameById)),
        [components, projectNameById],
    );

    const mapItems = useMemo(
        () =>
            components
                .filter((component) => component.category === "Map")
                .map((component) => toUsedItem(component, projectNameById)),
        [components, projectNameById],
    );

    const refreshPmData = async () => {
        const [nextProjects, nextComponents] = await Promise.all([loadProjects(), loadComponents()]);
        setProjects(nextProjects);
        setComponents(nextComponents);
    };

    useEffect(() => {
        void refreshPmData();
    }, []);

    const snapshotKey = useMemo(
        () => `gms.code.workspace.v1:${componentId ?? "default"}`,
        [componentId],
    );

    // Load persisted snapshot on first mount (per-component key).
    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }
        const saved = loadPersistedSnapshot();
        if (!saved) {
            return;
        }
        try {
            if (Array.isArray(saved.selectedCausalIds)) {
                sourceHook.setSelectedCausalIds(new Set(saved.selectedCausalIds.filter(Boolean)));
            }
            if (typeof saved.selectedMapId === "string" || saved.selectedMapId === null) {
                sourceHook.setSelectedMapId(saved.selectedMapId ?? null);
            }
            if (Array.isArray(saved.entities)) {
                setEntities(saved.entities);
            }
            if (typeof saved.isExtracted === "boolean") {
                setIsExtracted(saved.isExtracted);
            }
            if (typeof saved.selectedModel === "string") {
                setSelectedModel(saved.selectedModel);
            }
            if (Array.isArray(saved.collapsedParentIds)) {
                setCollapsedParentIds(new Set(saved.collapsedParentIds.filter(Boolean)));
            }
            if (Array.isArray(saved.metrics)) {
                setMetrics(saved.metrics);
            }
            if (typeof saved.metricsExtracted === "boolean") {
                metricsHook.setMetricsExtracted(saved.metricsExtracted);
            }
            if (Array.isArray(saved.artifactFiles)) {
                setArtifactFiles(saved.artifactFiles as ArtifactFile[]);
            }
            if (typeof saved.jobId === "string") {
                setCurrentJobId(saved.jobId || null);
            }
        } catch {
            // Ignore corrupted snapshot.
        }
    }, [loadPersistedSnapshot]);

    // Persist snapshot whenever relevant state changes.
    useEffect(() => {
        if (!hydrated || typeof window === "undefined") return;
        const snapshot = {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            componentId,
            selectedCausalIds: Array.from(selectedCausalIds),
            selectedMapId,
            entities,
            isExtracted,
            selectedModel,
            collapsedParentIds: Array.from(collapsedParentIds),
            metrics,
            metricsExtracted,
            artifactFiles,
            jobId: currentJobId,
        };
        persistSnapshot(snapshot);
    }, [
        hydrated,
        componentId,
        selectedCausalIds,
        selectedMapId,
        entities,
        isExtracted,
        selectedModel,
        collapsedParentIds,
        metrics,
        metricsExtracted,
        artifactFiles,
        currentJobId,
        persistSnapshot,
    ]);

    useEffect(() => {
        if (!isExtracted || wordCloudWords.length === 0) {
            return;
        }

        const recenterWordCloud = () => {
            const host = wordCloudHostRef.current;
            if (!host) {
                return;
            }

            const svg = host.querySelector("svg") as SVGSVGElement | null;
            const group = svg?.querySelector("g") as SVGGElement | null;

            if (!svg || !group) {
                return;
            }

            const svgRect = svg.getBoundingClientRect();
            const groupRect = group.getBoundingClientRect();

            if (
                svgRect.width === 0 ||
                svgRect.height === 0 ||
                groupRect.width === 0 ||
                groupRect.height === 0
            ) {
                return;
            }

            const deltaPxX =
                svgRect.left + svgRect.width / 2 - (groupRect.left + groupRect.width / 2);
            const deltaPxY =
                svgRect.top + svgRect.height / 2 - (groupRect.top + groupRect.height / 2);

            const baseTransform = group.transform.baseVal.consolidate();
            const currentX = baseTransform?.matrix.e ?? 0;
            const currentY = baseTransform?.matrix.f ?? 0;

            const viewBox = svg.viewBox.baseVal;
            const unitsWidth = viewBox.width > 0 ? viewBox.width : svgRect.width;
            const unitsHeight = viewBox.height > 0 ? viewBox.height : svgRect.height;
            const scaleX = svgRect.width / unitsWidth || 1;
            const scaleY = svgRect.height / unitsHeight || 1;

            const nextX = currentX + deltaPxX / scaleX;
            const nextY = currentY + deltaPxY / scaleY;

            group.setAttribute("transform", `translate(${String(nextX)}, ${String(nextY)})`);
        };

        const frameId = window.requestAnimationFrame(() => {
            window.requestAnimationFrame(recenterWordCloud);
        });

        const timeoutId = window.setTimeout(recenterWordCloud, 620);

        return () => {
            window.cancelAnimationFrame(frameId);
            window.clearTimeout(timeoutId);
        };
    }, [isExtracted, wordCloudWords]);

    const buildWorkspaceSnapshotData = () => ({
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        componentId,
        selectedCausalIds: Array.from(selectedCausalIds),
        selectedMapId,
        entities,
        isExtracted,
        selectedModel,
        collapsedParentIds: Array.from(collapsedParentIds),
        metrics,
        metricsExtracted,
        artifactFiles,
        jobId: currentJobId,
    });

    const applyImportedWorkspaceSnapshot = (snapshot: ImportedWorkspaceSnapshot) => {
        setSelectedCausalIds(new Set(snapshot.selectedCausalIds));
        setSelectedMapId(snapshot.selectedMapId);
        setEntities(snapshot.entities as GeneratedEntity[]);
        setIsExtracted(snapshot.isExtracted);
        setSelectedModel(snapshot.selectedModel);
        setCollapsedParentIds(new Set(snapshot.collapsedParentIds));
        setMetrics(snapshot.metrics as WorkspaceMetric[]);
        setMetricsExtracted(snapshot.metricsExtracted);
        setArtifactFiles(snapshot.artifactFiles);
        setCurrentJobId(snapshot.jobId);

        setManualEntityName("");
        setManualEntityError("");
        setManualMetricName("");
        setManualMetricError("");
        setExtractError("");
        setGroupError("");
        setMetricsError("");
        setImportError("");
    };

    const handleExportArchive = () => {
        if (archiveBusy !== "idle") return;
        void hookHandleExportArchive(buildWorkspaceSnapshotData());
    };

    const handleImportArchiveFile = async (event: ChangeEvent<HTMLInputElement>) => {
        const result = await hookHandleImportArchiveFile(event);
        if (result.success && result.data) {
            applyImportedWorkspaceSnapshot(result.data);
            await refreshPmData();
            setImportMessage(
                `Imported workspace snapshot${result.data.jobId ? ` and bound job ${result.data.jobId}` : ""}.`,
            );
        }
    };

    const handleExtractFromCausal = () => {
        if (isExtracting) {
            return;
        }
        if (selectedCausalIds.size === 0) {
            setExtractError("Select at least one causal artifact above before extracting.");
            return;
        }

        setExtractError("");
        setGroupError("");
        setCollapsedParentIds(new Set());

        const refs: Array<{ projectId: string; componentId: string }> = [];
        for (const id of selectedCausalIds) {
            const component =
                components.find((c) => c.id === id) ?? findSeedComponentById(id);
            if (!component || component.category !== "Causal") {
                continue;
            }
            refs.push({ projectId: component.projectId, componentId: component.id });
        }

        void (async () => {
            try {
                const aggregated = await aggregateEntitiesFromCausalComponents(refs);
                setEntities(aggregated);
                setIsExtracted(true);
                if (aggregated.length === 0) {
                    setExtractError(
                        "No extracted relations found in the selected causal artifacts.",
                    );
                }
            } catch (err) {
                setExtractError(
                    err instanceof Error ? err.message : "Causal aggregation failed.",
                );
            }
        })();
    };

    const handleGroupWithGemini = () => {
        hookHandleGroupWithGemini(entities, selectedModel, inputsLocked);
    };

    const handleCancelGrouping = () => {
        hookHandleCancelGrouping();
    };

    const handleAddManualEntity = () => {
        if (inputsLocked) return;
        const trimmed = manualEntityName.trim();
        if (!trimmed) {
            setManualEntityError("Type a name first.");
            return;
        }
        const exists = entities.some(
            (entity) => entity.name.toLowerCase() === trimmed.toLowerCase(),
        );
        if (exists) {
            setManualEntityError(`"${trimmed}" is already in the list.`);
            return;
        }
        const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const newEntity: GeneratedEntity = {
            id: `entity-manual-${String(Date.now())}-${slug}`,
            name: trimmed,
            count: 1,
            selected: true,
        };
        setEntities((prev) => [...prev, newEntity]);
        setIsExtracted(true);
        setManualEntityName("");
        setManualEntityError("");
    };

    const handleSuggestMetrics = () => {
        const sourceEntities = entities.filter(
            (e) => !(e.memberIds && e.memberIds.length > 0),
        );
        hookHandleSuggestMetrics(sourceEntities, selectedModel, isSuggestingMetrics, inputsLocked);
    };

    const handleCancelMetricsSuggest = () => {
        hookHandleCancelMetricsSuggest();
    };

    const handleAddManualMetric = () => {
        if (inputsLocked) return;
        const trimmed = manualMetricName.trim();
        if (!trimmed) {
            setManualMetricError("Type a metric name first.");
            return;
        }
        const exists = metrics.some(
            (m) => m.name.toLowerCase() === trimmed.toLowerCase(),
        );
        if (exists) {
            setManualMetricError(`"${trimmed}" is already in the list.`);
            return;
        }
        const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
        const id = `metric-manual-${String(Date.now())}-${slug || "metric"}`;
        const newMetric: WorkspaceMetric = {
            id,
            name: slug || `metric_${String(Date.now())}`,
            label: trimmed,
            unit: "",
            agg: "count",
            entities: [],
            viz: "line",
            rationale: "(manual)",
            selected: true,
        };
        setMetrics((prev) => [...prev, newMetric]);
        setMetricsExtracted(true);
        setManualMetricName("");
        setManualMetricError("");
    };

    const handleToggleCausalSelection = (id: string) => {
        if (inputsLocked) return;
        hookHandleToggleCausalSelection(id, inputsLocked, () => {
            setIsExtracted(false);
            setEntities([]);
            setExtractError("");
            setGroupError("");
            setCollapsedParentIds(new Set());
        });
    };

    const handleToggleMapSelection = (id: string) => {
        if (inputsLocked) return;
        hookHandleToggleMapSelection(id, inputsLocked);
    };

    const handleDeleteComponent = (targetId: string) => {
        void (async () => {
            try {
                await hookHandleDeleteComponent(targetId, refreshPmData);
            } catch {
                setImportError("Unable to delete component from database.");
            }
        })();
    };

    const selectedMetrics = useMemo(() => metrics.filter((m) => m.selected), [metrics]);

    const missingRequirements = useMemo(() => {
        const missing: string[] = [];
        if (selectedCausalIds.size === 0) {
            missing.push("Select at least one causal source above.");
        }
        if (!selectedMapId) {
            missing.push("Select a Map artifact as the target for code generation.");
        }
        if (!isExtracted) {
            missing.push('Run "Extract from causal" to populate the entity list.');
        } else if (selectedEntities.length === 0) {
            missing.push("Select at least one entity in the entity list.");
        }
        if (!metricsExtracted || metrics.length === 0) {
            missing.push(
                'Generate or manually add metrics in the "Metric to be tracked" section.',
            );
        } else if (selectedMetrics.length === 0) {
            missing.push("Select at least one metric in the metric list.");
        }
        console.info("[code-gen] missing requirements", missing);
        return missing;
    }, [
        selectedCausalIds,
        selectedMapId,
        isExtracted,
        selectedEntities,
        metricsExtracted,
        metrics,
        selectedMetrics,
    ]);

    const resolveProjectIdForCreate = (): string | null => {
        if (resolvedProjectId) {
            return resolvedProjectId;
        }

        if (projects.length > 0) {
            return projects[0].id;
        }

        return null;
    };

    const handleCreateFromEmptySection = (category: "Causal" | "Map") => {
        void (async () => {
            setImportError("");

            const rawTitle = window.prompt(`${category} name`);
            if (!rawTitle) {
                return;
            }

            const title = rawTitle.trim();
            if (!title) {
                return;
            }

            const projectId = resolveProjectIdForCreate();
            if (!projectId) {
                setImportError("No project found. Create a project first before adding artifacts.");
                return;
            }

            const existingIds = new Set(components.map((component) => component.id));
            const baseId = `${category.toLowerCase()}-${makeSlug(title)}`;
            const id = makeUniqueId(baseId, existingIds);

            await createComponent({
                id,
                title,
                category,
                projectId,
                lastEdited: "just now",
            });

            await refreshPmData();
            router.push(`/${categoryPath[category]}/${encodeURIComponent(id)}`);
        })();
    };

    const persistImportedCausalArtifacts = async (
        entry: JsonImportItem,
        component: SimulationComponent,
        projectId: string,
    ): Promise<void> => {
        const rawExtraction = extractRawExtractionFromItem(entry);
        const extractedRelationCount = rawExtraction.reduce(
            (total: number, chunk: ExtractionPayloadRecord) =>
                total + chunk.classes.reduce((chunkTotal: number, classItem) => chunkTotal + classItem.extracted.length, 0),
            0,
        );

        if (extractedRelationCount === 0) {
            return;
        }

        const sourceTextFromPayload = rawExtraction
            .flatMap((chunk: ExtractionPayloadRecord) => chunk.classes.map((classItem) => classItem.source_text))
            .filter(Boolean)
            .join("\n\n");

        const sourceText = sourceTextFromPayload || entry.sourceText?.trim() || component.title;
        const documentId = `causal-doc-${component.id}`;

        await saveCausalSourceItem({
            id: documentId,
            projectId,
            componentId: component.id,
            label: component.title,
            fileName: `${component.title}.json`,
            sourceType: "text",
            status: "extracted",
            tags: ["imported", "json"],
            textContent: sourceText,
        });

        const chunkTexts = buildChunkTextsFromRawExtraction(rawExtraction);
        await saveTextChunksForItem({
            experimentItemId: documentId,
            projectId,
            componentId: component.id,
            chunks: chunkTexts,
            model: "imported-json",
            chunkSizeWords: 20,
            chunkOverlapWords: 0,
        });

        await saveCausalArtifactsForItem({
            experimentItemId: documentId,
            rawExtraction,
            followUp: [],
        });
    };

    const persistImportedMapArtifacts = async (
        entry: JsonImportItem,
        component: SimulationComponent,
    ): Promise<void> => {
        if (typeof window === "undefined") {
            return;
        }

        const graph = extractMapGraphPayload(entry);
        if (!graph) {
            return;
        }

        const snapshotFromEntry = entry.snapshot;
        const snapshot: ImportedMapWorkspaceSnapshot = {
            graph,
            jobId: "",
            selectedModel: snapshotFromEntry?.selectedModel?.trim() || "",
            overviewAdditionalInfo: snapshotFromEntry?.overviewAdditionalInfo || "",
            binAdditionalInfo: snapshotFromEntry?.binAdditionalInfo || "",
            overviewFileNames: snapshotFromEntry?.overviewFileNames ?? [],
            binFileNames: snapshotFromEntry?.binFileNames ?? [],
            changeLog: snapshotFromEntry?.changeLog ?? [],
            editStatus: snapshotFromEntry?.editStatus || "Imported map extraction artifacts.",
            selection: null,
        };

        window.localStorage.setItem(`map-workspace:${component.id}`, JSON.stringify(snapshot));
    };

    const resolveImportedMapSnapshot = (payload: unknown): ImportedMapWorkspaceSnapshot | null => {
        if (!payload || typeof payload !== "object") {
            return null;
        }

        const asRecord = payload as Record<string, unknown>;
        if (asRecord.snapshot && typeof asRecord.snapshot === "object") {
            const snapshotPayload = asRecord.snapshot as Record<string, unknown>;
            const graph = extractMapGraphPayload(snapshotPayload.graph || snapshotPayload);
            if (!graph) {
                return null;
            }

            return {
                graph,
                jobId: typeof snapshotPayload.jobId === "string" ? snapshotPayload.jobId : "",
                selectedModel: typeof snapshotPayload.selectedModel === "string" ? snapshotPayload.selectedModel : "",
                overviewAdditionalInfo: typeof snapshotPayload.overviewAdditionalInfo === "string" ? snapshotPayload.overviewAdditionalInfo : "",
                binAdditionalInfo: typeof snapshotPayload.binAdditionalInfo === "string" ? snapshotPayload.binAdditionalInfo : "",
                overviewFileNames: Array.isArray(snapshotPayload.overviewFileNames) ? snapshotPayload.overviewFileNames.filter((f): f is string => typeof f === "string") : [],
                binFileNames: Array.isArray(snapshotPayload.binFileNames) ? snapshotPayload.binFileNames.filter((f): f is string => typeof f === "string") : [],
                changeLog: Array.isArray(snapshotPayload.changeLog) ? snapshotPayload.changeLog.filter((f): f is string => typeof f === "string") : [],
                editStatus: typeof snapshotPayload.editStatus === "string" ? snapshotPayload.editStatus : "Imported map extraction artifacts.",
                selection: null,
            } as ImportedMapWorkspaceSnapshot;
        }

        const directSnapshot = payload as Partial<ImportedMapWorkspaceSnapshot>;
        if (directSnapshot.graph && Array.isArray(directSnapshot.graph.vertices) && Array.isArray(directSnapshot.graph.edges)) {
            return {
                graph: directSnapshot.graph,
                jobId: "",
                selectedModel: "",
                overviewAdditionalInfo: "",
                binAdditionalInfo: "",
                overviewFileNames: [],
                binFileNames: [],
                changeLog: [],
                editStatus: "Imported map extraction artifacts.",
                selection: null,
            };
        }

        return null;
    };

    const extractMapArtifactBundleFromZip = async (file: File): Promise<JsonImportPayload | null> => {
        try {
            const lowerName = file.name.toLowerCase();
            const isZipFile = lowerName.endsWith(".zip") || file.type === "application/zip" || file.type === "application/x-zip-compressed";
            if (!isZipFile) {
                return null;
            }

            const zip = await JSZip.loadAsync(await file.arrayBuffer());
            const bundleFile = zip.file("bundle.json");
            if (!bundleFile) {
                return null;
            }

            const bundleText = await bundleFile.async("string");
            const parsed = JSON.parse(bundleText) as unknown;

            const maybeBundle = parsed as Partial<{
                artifactType?: string;
                artifactVersion?: number;
                componentId?: string;
                title?: string;
                projectName?: string;
                snapshot?: unknown;
            }>;

            if (maybeBundle.artifactType !== "map_extract_workspace") {
                return null;
            }

            const snapshot = resolveImportedMapSnapshot(maybeBundle);
            if (!snapshot) {
                return null;
            }

            const cleanFileName = file.name.replace(/\.zip$/i, "").trim() || "imported-map-artifact";
            const baseName = cleanFileName.replace(/\.[^/.]+$/, "");

            return {
                mapItems: [
                    {
                        id: `map-zip-${sanitizeFileNameForId(baseName.toLowerCase())}`,
                        title: cleanFileName,
                        lastEdited: "imported",
                        graph: snapshot.graph,
                        snapshot: {
                            graph: snapshot.graph,
                            selectedModel: snapshot.selectedModel,
                            overviewAdditionalInfo: snapshot.overviewAdditionalInfo,
                            binAdditionalInfo: snapshot.binAdditionalInfo,
                            overviewFileNames: snapshot.overviewFileNames,
                            binFileNames: snapshot.binFileNames,
                            changeLog: snapshot.changeLog,
                            editStatus: snapshot.editStatus,
                        },
                        artifactType: "map_extract_workspace",
                    },
                ],
            } as JsonImportPayload;
        } catch {
            return null;
        }
    };

    const sanitizeFileNameForId = (name: string): string => {
        return name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "imported";
    };

    const readImportItems = (payload: JsonImportPayload, category: "Causal" | "Map"): JsonImportItem[] => {
        const taggedItems: Array<{ item: JsonImportItem; fallbackCategory: "Causal" | "Map" }> = [];

        if (category === "Causal") {
            taggedItems.push(
                ...(payload.causal ?? []).map((item) => ({ item, fallbackCategory: "Causal" as const })),
                ...(payload.causalItems ?? []).map((item) => ({ item, fallbackCategory: "Causal" as const })),
            );
        } else {
            taggedItems.push(
                ...(payload.map ?? []).map((item) => ({ item, fallbackCategory: "Map" as const })),
                ...(payload.mapItems ?? []).map((item) => ({ item, fallbackCategory: "Map" as const })),
            );
        }

        const itemsFromComponents = (payload.components ?? [])
            .map((item) => {
                const explicitCategory = (item.category || "").trim().toLowerCase();
                if (explicitCategory === "causal") {
                    return { item, fallbackCategory: "Causal" as const };
                }
                if (explicitCategory === "map") {
                    return { item, fallbackCategory: "Map" as const };
                }

                const inferred = inferImportItemCategory(item);
                if (inferred) {
                    return { item, fallbackCategory: inferred };
                }

                return null;
            })
            .filter((entry): entry is { item: JsonImportItem; fallbackCategory: "Causal" | "Map" } => entry !== null);

        taggedItems.push(...itemsFromComponents);

        return taggedItems
            .filter(({ item, fallbackCategory }) => {
                const inferred = inferImportItemCategory(item);
                const resolvedCategory = inferred || fallbackCategory;
                return resolvedCategory === category;
            })
            .map(({ item }) => item);
    };

    const resolveProjectIdFromItem = async (
        item: JsonImportItem,
        context: {
            projectsById: Map<string, SimulationProject>;
            projectIdByName: Map<string, string>;
            fallbackProjectId: string | null;
            usedProjectIds: Set<string>;
        },
    ): Promise<string> => {
        const incomingProjectId = item.projectId?.trim() || "";
        const incomingProjectName = item.projectName?.trim() || item.project?.trim() || "";

        if (incomingProjectId && context.projectsById.has(incomingProjectId)) {
            return incomingProjectId;
        }

        if (incomingProjectName) {
            const key = incomingProjectName.toLowerCase();
            const existingByName = context.projectIdByName.get(key);
            if (existingByName) {
                return existingByName;
            }

            const projectIdBase = incomingProjectId || `project-${makeSlug(incomingProjectName)}`;
            const projectId = makeUniqueId(projectIdBase, context.usedProjectIds);
            const created = await createProject({ id: projectId, name: incomingProjectName });
            context.projectsById.set(created.id, created);
            context.projectIdByName.set(created.name.toLowerCase(), created.id);
            return created.id;
        }

        if (context.fallbackProjectId) {
            return context.fallbackProjectId;
        }

        if (context.projectsById.size > 0) {
            return Array.from(context.projectsById.keys())[0];
        }

        const defaultProjectId = makeUniqueId("project-imported", context.usedProjectIds);
        const created = await createProject({ id: defaultProjectId, name: "Imported Project" });
        context.projectsById.set(created.id, created);
        context.projectIdByName.set(created.name.toLowerCase(), created.id);
        return created.id;
    };

    const insertImportedCategory = async (
        payloadItems: JsonImportItem[],
        category: "Causal" | "Map",
        context: {
            projectsById: Map<string, SimulationProject>;
            projectIdByName: Map<string, string>;
            fallbackProjectId: string | null;
            usedProjectIds: Set<string>;
            usedComponentIds: Set<string>;
        },
    ): Promise<SimulationComponent[]> => {
        const created: SimulationComponent[] = [];

        for (const entry of payloadItems) {
            const title = (entry.title || entry.name || "").trim() || `${category} Item`;
            const projectId = await resolveProjectIdFromItem(entry, context);
            const lastEdited = entry.lastEdited?.trim() || "just now";
            const baseId = entry.id?.trim() || `${category.toLowerCase()}-${makeSlug(title)}`;
            const id = makeUniqueId(baseId, context.usedComponentIds);

            const component: SimulationComponent = {
                id,
                title,
                category,
                projectId,
                lastEdited,
            };

            await createComponent(component);

            if (category === "Causal") {
                await persistImportedCausalArtifacts(entry, component, projectId);
            } else {
                await persistImportedMapArtifacts(entry, component);
            }

            created.push(component);
        }

        return created;
    };

    const handleImportJson = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";

        if (!file) {
            return;
        }

        setImportMessage("");
        setImportError("");
        setIsImporting(true);

        try {
            let payload: JsonImportPayload;

            const lowerName = file.name.toLowerCase();
            const isZipFile = lowerName.endsWith(".zip") || file.type === "application/zip" || file.type === "application/x-zip-compressed";

            if (isZipFile) {
                const zipPayload = await extractMapArtifactBundleFromZip(file);
                if (!zipPayload || !zipPayload.mapItems || zipPayload.mapItems.length === 0) {
                    throw new Error(
                        "Invalid ZIP artifact format. Expected a map extraction workspace bundle with bundle.json.",
                    );
                }
                payload = zipPayload;
            } else {
                const raw = await file.text();
                payload = normalizeImportPayload(JSON.parse(raw) as unknown, file.name);
            }

            const causalPayload = readImportItems(payload, "Causal");
            const mapPayload = readImportItems(payload, "Map");

            if (causalPayload.length === 0 && mapPayload.length === 0) {
                throw new Error(
                    "No causal/map items found in JSON. Expected keys: causal, causalItems, map, mapItems, components, or transcript extracted array entries.",
                );
            }

            const latestProjects = await loadProjects();
            const latestComponents = await loadComponents();
            const projectsById = new Map(latestProjects.map((project) => [project.id, project]));
            const projectIdByName = new Map(latestProjects.map((project) => [project.name.toLowerCase(), project.id]));
            const usedProjectIds = new Set(latestProjects.map((project) => project.id));
            const usedComponentIds = new Set(latestComponents.map((component) => component.id));

            for (const project of payload.projects ?? []) {
                const name = (project.name || "").trim();
                if (!name) {
                    continue;
                }

                const existingProjectId = projectIdByName.get(name.toLowerCase());
                if (existingProjectId) {
                    continue;
                }

                const baseId = project.id?.trim() || `project-${makeSlug(name)}`;
                const id = makeUniqueId(baseId, usedProjectIds);
                const created = await createProject({ id, name });
                projectsById.set(created.id, created);
                projectIdByName.set(created.name.toLowerCase(), created.id);
            }

            const context = {
                projectsById,
                projectIdByName,
                fallbackProjectId: resolvedProjectId,
                usedProjectIds,
                usedComponentIds,
            };

            const [createdCausal, createdMap] = await Promise.all([
                insertImportedCategory(causalPayload, "Causal", context),
                insertImportedCategory(mapPayload, "Map", context),
            ]);

            await refreshPmData();

            setImportMessage(
                `Imported ${String(createdCausal.length)} causal and ${String(createdMap.length)} map component(s).`,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown import error.";
            setImportError(message);
        } finally {
            setIsImporting(false);
        }
    };

    return (
        <div className="min-h-screen bg-[#1e1e1e] text-neutral-100">
            <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
                <ProjectPageHeader
                    title="Simulation object generation config"
                    projectName={selectedProjectName}
                    containerClassName="mb-8 flex flex-wrap items-center justify-between gap-4"
                    titleClassName="text-3xl font-black uppercase tracking-tight text-neutral-100 md:text-4xl"
                    actions={
                        <BackToHome
                            href={projectBackHref}
                            label="Back to project"
                            containerClassName=""
                            className="rounded-md px-3 py-2"
                        />
                    }
                />

                <section className="space-y-8">
                    <UsedItemsSection
                        title="Causal used"
                        category="Causal"
                        items={causalItems}
                        onDelete={handleDeleteComponent}
                        onCreate={handleCreateFromEmptySection}
                        selectedIds={selectedCausalIds}
                        onToggleSelect={handleToggleCausalSelection}
                    />

                    <UsedItemsSection
                        title="Map used"
                        category="Map"
                        items={mapItems}
                        onDelete={handleDeleteComponent}
                        onCreate={handleCreateFromEmptySection}
                        selectedIds={selectedMapId ? new Set([selectedMapId]) : undefined}
                        onToggleSelect={handleToggleMapSelection}
                    />

                    <EntityExtractionPanel
                        entities={entities}
                        isExtracted={isExtracted}
                        isExtracting={isExtracting}
                        isGroupingEntities={isGroupingEntities}
                        extractError={extractError}
                        groupError={groupError}
                        groupLog={groupLog}
                        inputsLocked={inputsLocked}
                        selectedCausalIds={selectedCausalIds}
                        selectedModel={selectedModel}
                        manualEntityName={manualEntityName}
                        manualEntityError={manualEntityError}
                        collapsedParentIds={collapsedParentIds}
                        onExtract={handleExtractFromCausal}
                        onGroupWithGemini={handleGroupWithGemini}
                        onCancelGrouping={handleCancelGrouping}
                        onToggleEntity={handleToggleEntity}
                        onAddManualEntity={handleAddManualEntity}
                        onUpdateManualEntityName={setManualEntityName}
                        onClearGroupLog={() => setGroupLog([])}
                        onToggleCollapse={(parentId) =>
                            setCollapsedParentIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(parentId)) next.delete(parentId);
                                else next.add(parentId);
                                return next;
                            })
                        }
                        onModelChange={setSelectedModel}
                    />

                    <MetricsSelectionPanel
                        metrics={metrics}
                        isExtracted={isExtracted}
                        isSuggestingMetrics={isSuggestingMetrics}
                        metricsError={metricsError}
                        metricsLog={metricsLog}
                        inputsLocked={inputsLocked}
                        manualMetricName={manualMetricName}
                        manualMetricError={manualMetricError}
                        selectedEntityCount={selectedEntities.length}
                        onSuggestMetrics={handleSuggestMetrics}
                        onCancelMetricsSuggest={handleCancelMetricsSuggest}
                        onToggleMetric={handleToggleMetric}
                        onAddManualMetric={handleAddManualMetric}
                        onUpdateManualMetricName={setManualMetricName}
                        onClearMetricsLog={() => setMetricsLog([])}
                    />

                    <CodeGenWorkspace
                        componentId={componentId ?? ""}
                        causalSourceRefs={(selectedCausalIds.size > 0
                            ? causalItems.filter((item) => selectedCausalIds.has(item.id))
                            : []
                        ).flatMap((item) => {
                            const component =
                                components.find((c) => c.id === item.id) ??
                                findSeedComponentById(item.id);
                            if (!component || component.category !== "Causal") {
                                return [];
                            }
                            return [{ projectId: component.projectId, componentId: item.id }];
                        })}
                        selectedMapId={selectedMapId}
                        selectedMapLabel={
                            selectedMapId
                                ? mapItems.find((item) => item.id === selectedMapId)?.title ?? null
                                : null
                        }
                        model={selectedModel}
                        selectedMetrics={selectedMetrics.map((m) => ({
                            name: m.name,
                            label: m.label,
                            unit: m.unit,
                            agg: m.agg,
                            entities: m.entities,
                            viz: m.viz,
                            chart_group: m.chart_group ?? null,
                            grounding: m.grounding ?? "domain_inference",
                            required_attrs: m.required_attrs ?? [],
                            sampling_event: m.sampling_event ?? "tick",
                            rationale: m.rationale,
                        }))}
                        pageEntities={selectedEntities.map((e) => ({
                            id: e.id,
                            label: e.name,
                            type: "actor",
                            frequency: e.count,
                        }))}
                        missingRequirements={missingRequirements}
                        onRunningChange={setIsCodeGenRunning}
                        onJobIdChange={setCurrentJobId}
                        artifactFiles={artifactFiles}
                        onArtifactFilesChange={setArtifactFiles}
                    />

                    <SimulationViewer
                        jobId={currentJobId}
                        selectedMetrics={selectedMetrics.map((m) => ({
                            name: m.name,
                            label: m.label,
                            unit: m.unit,
                            agg: m.agg,
                            entities: m.entities,
                            viz: m.viz,
                            chart_group: m.chart_group ?? null,
                            grounding: m.grounding ?? "domain_inference",
                            required_attrs: m.required_attrs ?? [],
                            sampling_event: m.sampling_event ?? "tick",
                            rationale: m.rationale,
                        }))}
                    />
                </section>
            </main>
            <FloatingWorkspaceToolbar
                archiveBusy={archiveBusy}
                archiveError={archiveError}
                archiveMessage={archiveMessage}
                importError={importError}
                importMessage={importMessage}
                isImporting={isImporting}
                inputsLocked={inputsLocked}
                onExport={handleExportArchive}
                onArchiveFileChange={handleImportArchiveFile}
                onJsonFileChange={handleImportJson}
            />
        </div>
    );
}
