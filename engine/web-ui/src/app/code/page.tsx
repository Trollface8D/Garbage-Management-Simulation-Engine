"use client";

import dynamic from "next/dynamic";
import { useParams, useRouter } from "next/navigation";
import { type ChangeEvent, type ComponentType, useEffect, useMemo, useRef, useState } from "react";
import ProjectPageHeader from "../components/project-page-header";
import UsedItemsSection from "@/app/code/used-items-section";
import CodeGenWorkspace from "@/app/code/code-gen-workspace";
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
import { groupEntitiesWithGemini } from "@/lib/code-gen-api-client";
import BackToHome from "../components/back-to-home";

type WordCloudWord = {
    text: string;
    value: number;
};

type WordCloudProps = {
    words: WordCloudWord[];
    options?: Record<string, unknown>;
    minSize?: [number, number];
    size?: [number, number];
};

const ReactWordcloud = dynamic(
    () => import("react-wordcloud").then((mod) => (mod && (mod.default ?? mod))),
    { ssr: false },
) as unknown as ComponentType<WordCloudProps>;

type GeneratedEntity = {
    id: string;
    name: string;
    count: number;
    selected: boolean;
};

type JsonImportItem = {
    id?: string;
    title?: string;
    name?: string;
    projectId?: string;
    projectName?: string;
    project?: string;
    lastEdited?: string;
    category?: string;
    sourceText?: string;
    rawExtraction?: ExtractionPayloadRecord[];
    extracted?: GeminiExtractedRelation[];
    pattern_type?: string;
    sentence_type?: string;
    marked_type?: string;
    explicit_type?: string;
    marker?: string;
    source_text?: string;
    head?: string;
    relationship?: string;
    tail?: string;
    detail?: string;
};

type JsonImportProject = {
    id?: string;
    name?: string;
};

type JsonImportPayload = {
    projects?: JsonImportProject[];
    causal?: JsonImportItem[];
    causalItems?: JsonImportItem[];
    map?: JsonImportItem[];
    mapItems?: JsonImportItem[];
    components?: JsonImportItem[];
};

type GeminiExtractedRelation = {
    head?: string;
    relationship?: string;
    tail?: string;
    detail?: string;
};

function sanitizeFilenameSegment(value: string): string {
    return value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "imported";
}

const PROGRESS_TICK_MS = 240;
const PROGRESS_STEP = 6;

type CausalComponentRef = { projectId: string; componentId: string };

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

function makeSlug(value: string): string {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
        return "untitled";
    }

    return trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";
}

function makeUniqueId(base: string, usedIds: Set<string>): string {
    let candidate = base;
    let seq = 2;
    while (usedIds.has(candidate)) {
        candidate = `${base}-${String(seq)}`;
        seq += 1;
    }
    usedIds.add(candidate);
    return candidate;
}

function toUsedItem(component: SimulationComponent, projectNameById: Map<string, string>) {
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

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const readText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const clip = (value: string, max: number): string =>
    value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;

const normalizeChunkLabel = (label: string, index: number): string => {
    const trimmed = label.trim();
    const match = /chunk\s*[-_]?\s*(\d+)/i.exec(trimmed);
    if (match) {
        return `chunk ${String(match[1])}`;
    }

    return `chunk ${String(index + 1)}`;
};

const normalizeExtractedRelation = (
    value: unknown,
): { head: string; relationship: string; tail: string; detail: string } | null => {
    if (!isObject(value)) {
        return null;
    }

    const head = readText(value.head);
    const relationship = readText(value.relationship);
    const tail = readText(value.tail);
    const detail = readText(value.detail);

    if (!head && !relationship && !tail && !detail) {
        return null;
    }

    return { head, relationship, tail, detail };
};

const normalizeExtractionClass = (
    value: unknown,
    fallbackSourceText: string,
): {
    pattern_type: string;
    sentence_type: string;
    marked_type: string;
    explicit_type: string;
    marker: string;
    source_text: string;
    extracted: Array<{ head: string; relationship: string; tail: string; detail: string }>;
} | null => {
    if (!isObject(value)) {
        return null;
    }

    const extractedSource = Array.isArray(value.extracted) ? value.extracted : [value];
    const extracted = extractedSource
        .map((entry) => normalizeExtractedRelation(entry))
        .filter(
            (entry): entry is { head: string; relationship: string; tail: string; detail: string } =>
                entry !== null,
        );

    if (extracted.length === 0) {
        return null;
    }

    return {
        pattern_type: readText(value.pattern_type),
        sentence_type: readText(value.sentence_type),
        marked_type: readText(value.marked_type),
        explicit_type: readText(value.explicit_type),
        marker: readText(value.marker),
        source_text: readText(value.source_text) || fallbackSourceText || extracted[0].head || "Imported source",
        extracted,
    };
};

const normalizeExtractionPayload = (value: unknown): ExtractionPayloadRecord[] => {
    if (!Array.isArray(value)) {
        return [];
    }

    const hasChunkStructure = value.some(
        (entry) => isObject(entry) && (Array.isArray(entry.classes) || typeof entry.chunk_label === "string"),
    );

    if (hasChunkStructure) {
        return value
            .map((chunkEntry, index) => {
                if (!isObject(chunkEntry)) {
                    return null;
                }

                const classesInput = Array.isArray(chunkEntry.classes) ? chunkEntry.classes : [];
                const classes = classesInput
                    .map((classValue) => normalizeExtractionClass(classValue, ""))
                    .filter(
                        (classValue): classValue is {
                            pattern_type: string;
                            sentence_type: string;
                            marked_type: string;
                            explicit_type: string;
                            marker: string;
                            source_text: string;
                            extracted: Array<{ head: string; relationship: string; tail: string; detail: string }>;
                        } => classValue !== null,
                    );

                if (classes.length === 0) {
                    return null;
                }

                return {
                    chunk_label: normalizeChunkLabel(readText(chunkEntry.chunk_label), index),
                    classes,
                } satisfies ExtractionPayloadRecord;
            })
            .filter((chunk): chunk is ExtractionPayloadRecord => chunk !== null);
    }

    return value
        .map((classEntry, index) => {
            const normalizedClass = normalizeExtractionClass(classEntry, "");
            if (!normalizedClass) {
                return null;
            }

            return {
                chunk_label: `chunk ${String(index + 1)}`,
                classes: [normalizedClass],
            } satisfies ExtractionPayloadRecord;
        })
        .filter((chunk): chunk is ExtractionPayloadRecord => chunk !== null);
};

const buildChunkTextsFromRawExtraction = (rawExtraction: ExtractionPayloadRecord[]): string[] =>
    rawExtraction.map((chunk, index) => {
        const joined = chunk.classes
            .map((classItem) => classItem.source_text?.trim() || "")
            .filter(Boolean)
            .join("\n\n")
            .trim();

        return joined || `Imported extraction chunk ${String(index + 1)}`;
    });

const extractRawExtractionFromItem = (item: JsonImportItem): ExtractionPayloadRecord[] => {
    const record = item as unknown as Record<string, unknown>;
    const direct = normalizeExtractionPayload(item.rawExtraction);
    if (direct.length > 0) {
        return direct;
    }

    const snakeCase = normalizeExtractionPayload(record.raw_extraction);
    if (snakeCase.length > 0) {
        return snakeCase;
    }

    return normalizeExtractionPayload([item]);
};

const normalizeGeminiTranscriptArray = (input: unknown[], sourceFileName: string): JsonImportPayload => {
    const rawExtraction = normalizeExtractionPayload(input);
    const relationCount = rawExtraction.reduce(
        (total, chunk) =>
            total + chunk.classes.reduce((chunkTotal, classItem) => chunkTotal + classItem.extracted.length, 0),
        0,
    );

    const firstSourceText =
        rawExtraction
            .flatMap((chunk) => chunk.classes.map((classItem) => classItem.source_text))
            .find((text) => readText(text)) || "";

    if (relationCount === 0) {
        return { causalItems: [] };
    }

    const cleanFileName = sourceFileName.trim() || "imported-transcript.json";
    const baseName = cleanFileName.replace(/\.[^/.]+$/, "");
    const title = clip(cleanFileName || firstSourceText || "imported-transcript", 180);

    return {
        causalItems: [
            {
                id: `causal-gemini-file-${sanitizeFilenameSegment(baseName.toLowerCase())}`,
                title,
                lastEdited: "extracted",
                sourceText: firstSourceText,
                rawExtraction,
            },
        ],
    };
};

const normalizeImportPayload = (value: unknown, sourceFileName: string): JsonImportPayload => {
    if (Array.isArray(value)) {
        const normalized = normalizeGeminiTranscriptArray(value, sourceFileName);
        if ((normalized.causalItems?.length ?? 0) > 0) {
            return normalized;
        }

        throw new Error(
            "Unsupported JSON array format. For array payloads, provide transcript items with an extracted list.",
        );
    }

    if (isObject(value)) {
        const record = value as Record<string, unknown>;
        const rawExtraction = normalizeExtractionPayload(record.raw_extraction);

        if (rawExtraction.length > 0) {
            const cleanFileName = sourceFileName.trim() || "imported-causal.json";
            const baseName = cleanFileName.replace(/\.[^/.]+$/, "");

            return {
                projects: Array.isArray(record.projects) ? (record.projects as JsonImportProject[]) : undefined,
                causalItems: [
                    {
                        id: `causal-file-${sanitizeFilenameSegment(baseName.toLowerCase())}`,
                        title: cleanFileName,
                        lastEdited: "extracted",
                        rawExtraction,
                    },
                ],
            };
        }

        return value as JsonImportPayload;
    }

    throw new Error("Invalid JSON format. Expected an object payload or transcript array payload.");
};

export default function CodePage() {
    const router = useRouter();
    const params = useParams<{ componentId?: string }>();
    const componentId = params.componentId ?? null;

    const [projects, setProjects] = useState<SimulationProject[]>([]);
    const [components, setComponents] = useState<SimulationComponent[]>([]);
    const [entities, setEntities] = useState<GeneratedEntity[]>([]);
    const [isExtracted, setIsExtracted] = useState<boolean>(false);
    const [isExtracting, setIsExtracting] = useState<boolean>(false);
    const [extractError, setExtractError] = useState<string>("");
    const [isGenerating, setIsGenerating] = useState<boolean>(false);
    const [progress, setProgress] = useState<number>(0);
    const [isImporting, setIsImporting] = useState<boolean>(false);
    const [importMessage, setImportMessage] = useState<string>("");
    const [importError, setImportError] = useState<string>("");
    const [selectedCausalIds, setSelectedCausalIds] = useState<Set<string>>(new Set());
    const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
    const [isCodeGenRunning, setIsCodeGenRunning] = useState<boolean>(false);
    const [isGroupingEntities, setIsGroupingEntities] = useState<boolean>(false);
    const [groupError, setGroupError] = useState<string>("");

    const inputsLocked = isCodeGenRunning;

    const progressTimerRef = useRef<number | null>(null);
    const importInputRef = useRef<HTMLInputElement | null>(null);
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

    const totalEntityCount = useMemo(
        () => selectedEntities.reduce((sum, entity) => sum + entity.count, 0),
        [selectedEntities],
    );

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

    useEffect(() => {
        return () => {
            if (progressTimerRef.current) {
                clearInterval(progressTimerRef.current);
            }
        };
    }, []);

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

    const stopGeneration = () => {
        if (progressTimerRef.current) {
            clearInterval(progressTimerRef.current);
            progressTimerRef.current = null;
        }

        setIsGenerating(false);
    };

    const handleExtractFromCausal = () => {
        if (isExtracting) {
            return;
        }
        if (selectedCausalIds.size === 0) {
            setExtractError("Select at least one causal artifact above before extracting.");
            return;
        }

        stopGeneration();
        setProgress(0);
        setExtractError("");
        setGroupError("");
        setIsExtracting(true);

        const refs: CausalComponentRef[] = [];
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
                setProgress(aggregated.length > 0 ? 12 : 0);
                if (aggregated.length === 0) {
                    setExtractError(
                        "No extracted relations found in the selected causal artifacts.",
                    );
                }
            } catch (err) {
                setExtractError(
                    err instanceof Error ? err.message : "Causal aggregation failed.",
                );
            } finally {
                setIsExtracting(false);
            }
        })();
    };

    const handleGroupWithGemini = () => {
        if (isGroupingEntities || inputsLocked) return;
        if (entities.length === 0) {
            setGroupError("Extract entities first before grouping.");
            return;
        }
        setGroupError("");
        setIsGroupingEntities(true);
        const counts: Record<string, number> = {};
        for (const entity of entities) {
            counts[entity.name] = (counts[entity.name] || 0) + entity.count;
        }
        void (async () => {
            try {
                const grouped = await groupEntitiesWithGemini(counts);
                const next: GeneratedEntity[] = Object.entries(grouped)
                    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                    .map(([name, count], idx) => ({
                        id: `entity-grouped-${String(idx)}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
                        name,
                        count,
                        selected: true,
                    }));
                if (next.length === 0) {
                    setGroupError("Gemini returned no grouped entities.");
                    return;
                }
                setEntities(next);
            } catch (err) {
                setGroupError(
                    err instanceof Error ? err.message : "Semantic grouping failed.",
                );
            } finally {
                setIsGroupingEntities(false);
            }
        })();
    };

    const handleToggleCausalSelection = (id: string) => {
        if (inputsLocked) return;
        setSelectedCausalIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
        setIsExtracted(false);
        setEntities([]);
        setProgress(0);
        setExtractError("");
        setGroupError("");
    };

    const handleToggleMapSelection = (id: string) => {
        if (inputsLocked) return;
        setSelectedMapId((prev) => (prev === id ? null : id));
    };

    const handleGenerate = () => {
        if (!isExtracted || isGenerating) {
            return;
        }

        if (progress >= 100) {
            setProgress(0);
        }

        setIsGenerating(true);

        progressTimerRef.current = window.setInterval(() => {
            setProgress((currentProgress) => {
                const next = Math.min(100, currentProgress + PROGRESS_STEP);
                if (next >= 100) {
                    stopGeneration();
                }
                return next;
            });
        }, PROGRESS_TICK_MS);
    };

    const handleDeleteComponent = (targetId: string) => {
        void (async () => {
            try {
                await softDeleteComponent(targetId);
                await refreshPmData();
            } catch {
                setImportError("Unable to delete component from database.");
            }
        })();
    };

    const handleToggleEntity = (targetId: string) => {
        if (inputsLocked) return;
        setEntities((prev) =>
            prev.map((entity) =>
                entity.id === targetId ? { ...entity, selected: !entity.selected } : entity,
            ),
        );
    };

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

    const handleOpenImportDialog = () => {
        importInputRef.current?.click();
    };

    const persistImportedCausalArtifacts = async (
        entry: JsonImportItem,
        component: SimulationComponent,
        projectId: string,
    ): Promise<void> => {
        const rawExtraction = extractRawExtractionFromItem(entry);
        const extractedRelationCount = rawExtraction.reduce(
            (total, chunk) =>
                total + chunk.classes.reduce((chunkTotal, classItem) => chunkTotal + classItem.extracted.length, 0),
            0,
        );

        if (extractedRelationCount === 0) {
            return;
        }

        const sourceTextFromPayload = rawExtraction
            .flatMap((chunk) => chunk.classes.map((classItem) => classItem.source_text))
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

    const readImportItems = (payload: JsonImportPayload, category: "Causal" | "Map"): JsonImportItem[] => {
        const itemsFromDedicatedList =
            category === "Causal"
                ? [...(payload.causal ?? []), ...(payload.causalItems ?? [])]
                : [...(payload.map ?? []), ...(payload.mapItems ?? [])];

        const itemsFromComponents = (payload.components ?? []).filter(
            (entry) => entry.category?.toLowerCase() === category.toLowerCase(),
        );

        return [...itemsFromDedicatedList, ...itemsFromComponents];
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
            const raw = await file.text();
            const payload = normalizeImportPayload(JSON.parse(raw) as unknown, file.name);

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

                <div className="mb-4 flex justify-start">
                    <input
                        ref={importInputRef}
                        type="file"
                        accept="application/json,.json"
                        className="hidden"
                        onChange={handleImportJson}
                    />

                    <button
                        type="button"
                        onClick={handleOpenImportDialog}
                        disabled={isImporting || inputsLocked}
                        className="rounded-md border border-emerald-700 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {isImporting ? "Importing JSON..." : "Import JSON (Causal/Map)"}
                    </button>
                </div>

                {importMessage ? (
                    <div className="mb-4 rounded-md border border-emerald-700/70 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
                        {importMessage}
                    </div>
                ) : null}

                {importError ? (
                    <div className="mb-4 rounded-md border border-red-800/70 bg-red-500/10 px-4 py-2 text-sm text-red-200">
                        Import failed: {importError}
                    </div>
                ) : null}

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

                    <div>
                        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                            <h2 className="text-xl font-bold text-neutral-100 md:text-2xl">
                                Entity that will be generated
                            </h2>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={handleGroupWithGemini}
                                    disabled={
                                        isGroupingEntities ||
                                        inputsLocked ||
                                        !isExtracted ||
                                        entities.length === 0
                                    }
                                    title="Semantic grouping with Gemini — merges related names and sums counts"
                                    aria-label="Group entities with Gemini"
                                    className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-purple-600/70 bg-purple-500/10 text-purple-200 transition hover:bg-purple-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {isGroupingEntities ? (
                                        <svg
                                            className="h-4 w-4 animate-spin"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                        >
                                            <path d="M21 12a9 9 0 1 1-6.2-8.55" strokeLinecap="round" />
                                        </svg>
                                    ) : (
                                        <svg
                                            className="h-4 w-4"
                                            viewBox="0 0 24 24"
                                            fill="currentColor"
                                            aria-hidden="true"
                                        >
                                            <path d="M12 2 L13.8 8.2 L20 10 L13.8 11.8 L12 18 L10.2 11.8 L4 10 L10.2 8.2 Z" />
                                            <path d="M19 16 L19.7 18.3 L22 19 L19.7 19.7 L19 22 L18.3 19.7 L16 19 L18.3 18.3 Z" />
                                        </svg>
                                    )}
                                </button>
                                <button
                                    type="button"
                                    onClick={handleExtractFromCausal}
                                    disabled={isExtracting || inputsLocked}
                                    className="rounded-md border border-sky-600 bg-sky-500/10 px-4 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    {isExtracting
                                        ? "Extracting..."
                                        : isExtracted
                                          ? "Re-extract from causal"
                                          : "Extract from causal"}
                                </button>
                            </div>
                        </div>

                        {extractError ? (
                            <div className="mb-3 rounded-md border border-red-800/70 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                                {extractError}
                            </div>
                        ) : null}
                        {groupError ? (
                            <div className="mb-3 rounded-md border border-red-800/70 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                                {groupError}
                            </div>
                        ) : null}

                        <div className="rounded-xl border border-neutral-700 bg-neutral-900/60 p-4 md:p-6">
                            {!isExtracted ? (
                                <div className="relative min-h-90 rounded-lg border border-dashed border-neutral-700 bg-neutral-900/60 p-6">
                                    <div className="flex h-full min-h-75 flex-col items-center justify-center gap-3 text-center">
                                        <p className="max-w-md text-sm text-neutral-400">
                                            {selectedCausalIds.size === 0
                                                ? "Click one or more causal cards above to select them, then run extraction."
                                                : `Selected ${String(selectedCausalIds.size)} causal source(s). Click "Extract from causal" to aggregate entities.`}
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <div className="grid min-h-90 gap-4 lg:grid-cols-2">
                                    <div className="flex min-h-75 items-center justify-center rounded-lg border border-neutral-700 bg-linear-to-br from-neutral-900 to-neutral-800 p-6">
                                        <div className="w-full max-w-sm rounded-lg border border-neutral-700 bg-neutral-950/70 p-5">
                                            {wordCloudWords.length > 0 ? (
                                                <div
                                                    aria-label="Generated entity word cloud"
                                                    className="flex h-55 w-full items-center justify-center"
                                                >
                                                    <div ref={wordCloudHostRef} className="h-55 w-55">
                                                        <ReactWordcloud
                                                            minSize={[220, 220]}
                                                            size={[220, 220]}
                                                            options={wordCloudOptions}
                                                            words={wordCloudWords}
                                                        />
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="flex h-55 items-center justify-center text-center">
                                                    <p className="text-sm font-semibold text-neutral-300">
                                                        Select at least one entity to render the word cloud.
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    <div className="rounded-lg border border-neutral-700 bg-neutral-900/70 p-4">
                                        <p className="text-sm font-semibold text-neutral-100">
                                            system will create {String(totalEntityCount)} entity
                                        </p>

                                        <div className="mt-4 max-h-65 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900/70">
                                            {entities.map((entity) => (
                                                <label
                                                    key={entity.id}
                                                    className="flex items-center justify-between gap-3 border-b border-neutral-800 px-3 py-2 last:border-b-0"
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <input
                                                            type="checkbox"
                                                            checked={entity.selected}
                                                            onChange={() => handleToggleEntity(entity.id)}
                                                            disabled={inputsLocked}
                                                            className="h-4 w-4 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                                                        />
                                                        <span className="text-sm text-neutral-200">{entity.name}</span>
                                                    </div>

                                                    <span className="text-xs font-semibold text-neutral-400">
                                                        Count: {String(entity.count)}
                                                    </span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {isExtracted ? (
                            <div className="mt-4 space-y-4">
                                <div className="flex flex-wrap items-center gap-3">
                                    <button
                                        type="button"
                                        onClick={handleGenerate}
                                        disabled={isGenerating}
                                        className="rounded-md border border-emerald-700 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                                    >
                                        {isGenerating ? "generating..." : "generate"}
                                    </button>

                                    <button
                                        type="button"
                                        onClick={stopGeneration}
                                        className="rounded-md border border-red-800 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-300 transition hover:bg-red-500/20"
                                    >
                                        stop
                                    </button>
                                </div>

                                <div className="rounded-lg border border-neutral-700 bg-neutral-900/70 p-3">
                                    <div className="h-4 w-full overflow-hidden rounded-md bg-neutral-800">
                                        <div
                                            className="h-full rounded-md bg-sky-500 transition-[width] duration-200"
                                            style={{ width: `${String(progress)}%` }}
                                        />
                                    </div>
                                    <p className="mt-2 text-right text-xs font-semibold text-neutral-300">
                                        {String(progress)}%
                                    </p>
                                </div>
                            </div>
                        ) : null}
                    </div>

                    <CodeGenWorkspace
                        causalComponentIds={
                            selectedCausalIds.size > 0
                                ? causalItems
                                      .map((item) => item.id)
                                      .filter((id) => selectedCausalIds.has(id))
                                : causalItems.map((item) => item.id)
                        }
                        selectedMapLabel={
                            selectedMapId
                                ? mapItems.find((item) => item.id === selectedMapId)?.title ?? null
                                : null
                        }
                        onRunningChange={setIsCodeGenRunning}
                    />
                </section>
            </main>
        </div>
    );
}
