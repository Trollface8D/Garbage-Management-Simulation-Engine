"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import ProjectPageHeader from "../components/project-page-header";
import UsedItemsSection, { type UsedItem } from "@/app/code/used-items-section";
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
  loadComponents,
  loadProjects,
  saveCausalArtifactsForItem,
  saveCausalSourceItem,
  saveTextChunksForItem,
  softDeleteComponent,
  type ExtractionPayloadRecord,
} from "@/lib/pm-storage";

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

type GeminiRawChunkItem = {
  pattern_type?: string;
  sentence_type?: string;
  marked_type?: string;
  explicit_type?: string;
  marker?: string;
  source_text?: string;
  extracted?: GeminiExtractedRelation[];
};

function sanitizeFilenameSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "imported";
}
const EXTRACTION_DELAY_MS = 1300;
const PROGRESS_TICK_MS = 240;
const PROGRESS_STEP = 6;

const INITIAL_ENTITIES: GeneratedEntity[] = [
  { id: "entity-1", name: "Janitor", count: 8, selected: true },
  { id: "entity-2", name: "Garbage Truck", count: 14, selected: true },
  { id: "entity-3", name: "Transfer Station", count: 4, selected: true },
  { id: "entity-4", name: "Recycling Crew", count: 6, selected: true },
  { id: "entity-5", name: "Entity 1", count: 11, selected: true },
  { id: "entity-6", name: "Entity 2", count: 5, selected: true },
  { id: "entity-7", name: "Entity 3", count: 3, selected: true },
];

export default function CodePage() {
  const router = useRouter();
  const [projects, setProjects] = useState<SimulationProject[]>([]);
  const [components, setComponents] = useState<SimulationComponent[]>([]);
  const params = useParams<{ componentId?: string }>();
  const componentId = params.componentId ?? null;

  const [entities, setEntities] = useState<GeneratedEntity[]>(INITIAL_ENTITIES);
  const [isExtracted, setIsExtracted] = useState<boolean>(false);
  const [isExtracting, setIsExtracting] = useState<boolean>(false);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [importMessage, setImportMessage] = useState<string>("");
  const [importError, setImportError] = useState<string>("");

  const progressTimerRef = useRef<number | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const selectedEntities = useMemo(
    () => entities.filter((entity) => entity.selected),
    [entities],
  );
  const totalEntityCount = useMemo(
    () => selectedEntities.reduce((sum, entity) => sum + entity.count, 0),
    [selectedEntities],
  );

  const selectedComponent = useMemo(() => {
    if (!componentId) {
      return undefined;
    }

    return components.find((component) => component.id === componentId) ?? findSeedComponentById(componentId);
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

    return projects.find((project) => project.id === resolvedProjectId)?.name ?? findSeedProjectById(resolvedProjectId)?.name ?? "Unselected project";
  }, [resolvedProjectId, projects]);

  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  const causalItems = useMemo(
    () => components
      .filter((component) => component.category === "Causal")
      .map((component) => toUsedItem(component, projectNameById)),
    [components, projectNameById],
  );

  const mapItems = useMemo(
    () => components
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

    stopGeneration();
    setProgress(0);
    setIsExtracting(true);

    window.setTimeout(() => {
      setIsExtracted(true);
      setIsExtracting(false);
      setProgress(12);
    }, EXTRACTION_DELAY_MS);
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
    setEntities((prev) =>
      prev.map((entity) =>
        entity.id === targetId
          ? { ...entity, selected: !entity.selected }
          : entity,
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
  const makeSlug = (value: string): string => {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      return "untitled";
    }

    return trimmed
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled";
  };

  const makeUniqueId = (base: string, usedIds: Set<string>): string => {
    let candidate = base;
    let seq = 2;
    while (usedIds.has(candidate)) {
      candidate = `${base}-${String(seq)}`;
      seq += 1;
    }
    usedIds.add(candidate);
    return candidate;
  };

  function toUsedItem(
    component: SimulationComponent,
    projectNameById: Map<string, string>,
  ): UsedItem {
    const projectId = component.category === "PolicyTesting" ? "" : component.projectId;
    const resolvedProject =
      projectNameById.get(projectId) ||
      findSeedProjectById(projectId)?.name ||
      "Unknown project";

    return {
      id: component.id,
      title: component.title,
      project: resolvedProject,
      lastEdited: component.lastEdited || "just now",
    };
  }

  const handleOpenImportDialog = () => {
    importInputRef.current?.click();
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

  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

  const readText = (value: unknown): string =>
    typeof value === "string" ? value.trim() : "";

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

    return {
      head,
      relationship,
      tail,
      detail,
    };
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
      .filter((entry): entry is { head: string; relationship: string; tail: string; detail: string } => entry !== null);

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
  };

  const normalizeGeminiTranscriptArray = (input: unknown[], sourceFileName: string): JsonImportPayload => {
    const rawExtraction = normalizeExtractionPayload(input);
    const relationCount = rawExtraction.reduce(
      (total, chunk) =>
        total + chunk.classes.reduce((chunkTotal, classItem) => chunkTotal + classItem.extracted.length, 0),
      0,
    );

    const firstSourceText = rawExtraction
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

    const defaultProjectName = "Imported Project";
    const defaultProjectId = makeUniqueId("project-imported", context.usedProjectIds);
    const created = await createProject({ id: defaultProjectId, name: defaultProjectName });
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
      const baseId = (entry.id?.trim() || `${category.toLowerCase()}-${makeSlug(title)}`);
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
        throw new Error("No causal/map items found in JSON. Expected keys: causal, causalItems, map, mapItems, components, or transcript extracted array entries.");
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

        const baseId = (project.id?.trim() || `project-${makeSlug(name)}`);
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
            <Link
              href={projectBackHref}
              className="rounded-md border border-neutral-700 bg-neutral-800 px-4 py-2 text-sm font-semibold text-white transition hover:border-sky-500"
            >
              Back to code generation home
            </Link>
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
            disabled={isImporting}
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
          />

          <UsedItemsSection
            title="Map used"
            category="Map"
            items={mapItems}
            onDelete={handleDeleteComponent}
            onCreate={handleCreateFromEmptySection}
          />

          <div>
            <h2 className="mb-4 text-xl font-bold text-neutral-100 md:text-2xl">Entity that will be generated</h2>

            <div className="rounded-xl border border-neutral-700 bg-neutral-900/60 p-4 md:p-6">
              {!isExtracted ? (
                <div className="relative min-h-[360px] rounded-lg border border-dashed border-neutral-700 bg-neutral-900/60 p-6">
                  <div className="absolute right-4 top-4">
                    <button
                      type="button"
                      onClick={handleExtractFromCausal}
                      disabled={isExtracting}
                      className="rounded-md border border-sky-600 bg-sky-500/10 px-4 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isExtracting ? "Extracting..." : "Extract from causal"}
                    </button>
                  </div>

                  <div className="flex h-full min-h-[300px] items-center justify-center text-center">
                    <p className="max-w-md text-sm text-neutral-400">
                      Run extraction to populate entity candidates and generation controls.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="grid min-h-[360px] gap-4 lg:grid-cols-2">
                  <div className="flex min-h-[300px] items-center justify-center rounded-lg border border-neutral-700 bg-gradient-to-br from-neutral-900 to-neutral-800 p-6">
                    <div className="w-full max-w-sm rounded-lg border border-neutral-700 bg-neutral-950/70 p-5">
                      <div className="mb-4 h-2 w-24 rounded bg-neutral-700" />
                      <div className="mb-2 h-20 rounded bg-sky-500/10" />
                      <div className="grid grid-cols-3 gap-2">
                        <div className="h-10 rounded bg-emerald-500/15" />
                        <div className="h-10 rounded bg-sky-500/15" />
                        <div className="h-10 rounded bg-amber-500/15" />
                      </div>
                      <p className="mt-4 text-center text-sm font-semibold text-neutral-300">Word Cloud Placeholder</p>
                    </div>
                  </div>

                  <div className="rounded-lg border border-neutral-700 bg-neutral-900/70 p-4">
                    <p className="text-sm font-semibold text-neutral-100">
                      system will create {String(totalEntityCount)} entity
                    </p>

                    <div className="mt-4 max-h-[260px] overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900/70">
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
                              className="h-4 w-4 accent-sky-500"
                            />
                            <span className="text-sm text-neutral-200">{entity.name}</span>
                          </div>

                          <span className="text-xs font-semibold text-neutral-400">Count: {String(entity.count)}</span>
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
        </section>
      </main>
    </div>
  );
}
