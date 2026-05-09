"use client";

import { useParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import {
  findComponentById as findSeedComponentById,
  findProjectById as findSeedProjectById,
  type SimulationComponent,
  type SimulationProject,
} from "@/lib/simulation-components";
import FollowUpGenerationPage, { type CausalItem } from "@/app/components/follow-up-generation-page";
import { loadCausalArtifactsForItem, loadCausalSourceItem, loadComponents, loadFollowUpRecordsForItem, loadProjects, type FollowUpRecord } from "@/lib/pm-storage";
import CausalWorkflowHeader from "../workflow-header";

const DEFAULT_ITEM_FILE_NAME = "selected file";

function CausalFollowUpPageContent() {
  const params = useParams<{ componentId?: string; itemId?: string }>();

  const componentId = params.componentId ?? null;
  const itemId = params.itemId ?? "";

  const [projects, setProjects] = useState<SimulationProject[]>([]);
  const [components, setComponents] = useState<SimulationComponent[]>([]);
  const [includeImplicit, setIncludeImplicit] = useState<boolean>(true);
  const [causalItems, setCausalItems] = useState<CausalItem[]>([]);
  const [followUpRecords, setFollowUpRecords] = useState<FollowUpRecord[]>([]);
  const [artifactLoadStatus, setArtifactLoadStatus] = useState<string>("");
  const [loadedItemId, setLoadedItemId] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [internetFilterEnabled, setInternetFilterEnabled] = useState<boolean>(false);

  useEffect(() => {
    const loadData = async () => {
      const [nextProjects, nextComponents] = await Promise.all([loadProjects(), loadComponents()]);
      setProjects(nextProjects);
      setComponents(nextComponents);
    };

    void loadData();
  }, []);

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

  const visibleCausalItems = useMemo(() => {
    if (!itemId || loadedItemId !== itemId) {
      return [];
    }

    return causalItems;
  }, [causalItems, itemId, loadedItemId]);

  const artifactStatus = useMemo(() => {
    if (!itemId) {
      return "No file selected. Open follow-up from an extracted source file.";
    }

    if (loadedItemId !== itemId) {
      return "Loading extracted causal artifacts...";
    }

    return artifactLoadStatus;
  }, [artifactLoadStatus, itemId, loadedItemId]);

  useEffect(() => {
    if (!itemId) {
      return;
    }

    let cancelled = false;

    const loadExtractedCausals = async () => {
      try {
        const [artifacts, storedFollowUps, sourceItem] = await Promise.all([
          loadCausalArtifactsForItem(itemId),
          loadFollowUpRecordsForItem(itemId).catch(() => [] as FollowUpRecord[]),
          loadCausalSourceItem(itemId).catch(() => null),
        ]);
        if (cancelled) {
          return;
        }

        const resolvedItemFileName = sourceItem?.fileName || DEFAULT_ITEM_FILE_NAME;

        const sourceChunkPayloads = artifacts.raw_extraction.filter((payload) =>
          /^chunk\s+\d+$/i.test((payload.chunk_label || "").trim()),
        );

        const flattenedItems: CausalItem[] = sourceChunkPayloads.flatMap((payload) =>
          payload.classes.map((item) => ({
            chunk_label: payload.chunk_label,
            pattern_type: item.pattern_type,
            sentence_type: item.sentence_type,
            marked_type: item.marked_type,
            explicit_type: item.explicit_type,
            marker: item.marker ?? null,
            source_text: item.source_text,
            extracted: (item.extracted ?? []).map((relation) => ({
              head: relation.head,
              relationship: relation.relationship,
              tail: relation.tail,
              detail: relation.detail ?? "",
            })),
          })),
        );

        setLoadedItemId(itemId);
        setCausalItems(flattenedItems);
        setFollowUpRecords(storedFollowUps);

        if (flattenedItems.length === 0) {
          setArtifactLoadStatus(`No extracted causal found for ${resolvedItemFileName}. Please run extraction first.`);
          return;
        }

        const skippedFollowUpDerived = artifacts.raw_extraction.length - sourceChunkPayloads.length;
        setArtifactLoadStatus(
          `Loaded ${String(flattenedItems.length)} extracted causal${flattenedItems.length === 1 ? "" : "s"} from ${resolvedItemFileName}.${
            skippedFollowUpDerived > 0
              ? ` Skipped ${String(skippedFollowUpDerived)} follow-up-derived chunk${skippedFollowUpDerived === 1 ? "" : "s"}.`
              : ""
          }`,
        );
      } catch {
        if (!cancelled) {
          setLoadedItemId(itemId);
          setCausalItems([]);
          setFollowUpRecords([]);
          setArtifactLoadStatus("Unable to load extracted causal artifacts.");
        }
      }
    };

    void loadExtractedCausals();

    return () => {
      cancelled = true;
    };
  }, [itemId]);

  return (
    <div className="min-h-screen bg-[var(--surface-0)] text-[var(--text-1)]">
      <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
        <CausalWorkflowHeader
          title="Causal Extract - Follow Up"
          selectedTitle={selectedTitle}
          selectedProjectName={selectedProjectName}
          selectedModel={selectedModel}
          onSelectedModelChange={setSelectedModel}
        />

        {artifactStatus ? <p className="mb-3 text-xs text-neutral-300">{artifactStatus}</p> : null}
        <FollowUpGenerationPage
          includeImplicit={includeImplicit}
          initialCausalItems={visibleCausalItems}
          experimentItemId={itemId}
          initialFollowUpRecords={loadedItemId === itemId ? followUpRecords : []}
          model={selectedModel}
          runFilterInternetAnswerable={internetFilterEnabled}
        />
      </main>

      <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
        <label className="inline-flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-800/95 px-3 py-2 text-sm text-neutral-200 shadow-lg backdrop-blur-sm">
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

        <label className="inline-flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-800/95 px-3 py-2 text-sm text-neutral-200 shadow-lg backdrop-blur-sm">
          <span>Run filter (internet-answerable)</span>
          <button
            type="button"
            onClick={() => setInternetFilterEnabled((prev) => !prev)}
            className={`rounded px-3 py-1 text-xs font-bold ${internetFilterEnabled ? "bg-sky-500/25 text-sky-200" : "bg-neutral-700 text-neutral-200"
              }`}
          >
            {internetFilterEnabled ? "ON" : "OFF"}
          </button>
        </label>
      </div>
    </div>
  );
}

export default function CausalFollowUpPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[var(--surface-0)] text-[var(--text-1)]" />}>
      <CausalFollowUpPageContent />
    </Suspense>
  );
}
