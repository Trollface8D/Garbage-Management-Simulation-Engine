"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import {
  findComponentById,
  findProjectById,
  getProjectIdForComponent,
  type SimulationProject,
} from "@/lib/simulation-components";
import BackToHome from "../../components/back-to-home";
import FollowUpGenerationPage, { type CausalItem } from "@/app/components/follow-up-generation-page";
import { loadCausalArtifactsForItem, loadFollowUpRecordsForItem, loadProjects, type FollowUpRecord } from "@/lib/pm-storage";

function CausalFollowUpPageContent() {
  const searchParams = useSearchParams();

  const componentId = searchParams.get("componentId");
  const queryProjectId = searchParams.get("projectId");
  const queryTitle = searchParams.get("title");
  const itemId = searchParams.get("itemId") ?? "";
  const itemFileName = searchParams.get("fileName") ?? "selected file";

  const selectedComponent = useMemo(() => findComponentById(componentId), [componentId]);
  const selectedProjectId = queryProjectId ?? getProjectIdForComponent(componentId);
  const selectedTitle = queryTitle ?? selectedComponent?.title ?? "Unselected component";
  const [projects, setProjects] = useState<SimulationProject[]>([]);
  const [includeImplicit, setIncludeImplicit] = useState<boolean>(true);
  const [causalItems, setCausalItems] = useState<CausalItem[]>([]);
  const [followUpRecords, setFollowUpRecords] = useState<FollowUpRecord[]>([]);
  const [artifactLoadStatus, setArtifactLoadStatus] = useState<string>("");
  const [loadedItemId, setLoadedItemId] = useState<string>("");

  useEffect(() => {
    const loadProjectList = async () => {
      setProjects(await loadProjects());
    };

    void loadProjectList();
  }, []);

  const selectedProjectName = useMemo(
    () => projects.find((project) => project.id === selectedProjectId)?.name ?? findProjectById(selectedProjectId)?.name ?? "Unselected project",
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
        const [artifacts, storedFollowUps] = await Promise.all([
          loadCausalArtifactsForItem(itemId),
          loadFollowUpRecordsForItem(itemId).catch(() => [] as FollowUpRecord[]),
        ]);
        if (cancelled) {
          return;
        }

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
          setArtifactLoadStatus(`No extracted causal found for ${itemFileName}. Please run extraction first.`);
          return;
        }

        const skippedFollowUpDerived = artifacts.raw_extraction.length - sourceChunkPayloads.length;
        setArtifactLoadStatus(
          `Loaded ${String(flattenedItems.length)} extracted causal${flattenedItems.length === 1 ? "" : "s"} from ${itemFileName}.${
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
  }, [itemFileName, itemId]);

  return (
    <div className="min-h-screen bg-[#1e1e1e] text-neutral-100">
      <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black uppercase tracking-tight md:text-4xl">Causal Extract - Follow Up</h1>
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
          <BackToHome
            href="/"
            label="Back to project"
            useHistoryBack
            containerClassName=""
            className="rounded-md px-3 py-2"
          />
        </header>

        {artifactStatus ? <p className="mb-3 text-xs text-neutral-300">{artifactStatus}</p> : null}
        <FollowUpGenerationPage
          includeImplicit={includeImplicit}
          initialCausalItems={visibleCausalItems}
          experimentItemId={itemId}
          initialFollowUpRecords={loadedItemId === itemId ? followUpRecords : []}
        />
      </main>

      <label className="fixed bottom-4 right-4 z-50 inline-flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-800/95 px-3 py-2 text-sm text-neutral-200 shadow-lg backdrop-blur-sm">
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
    </div>
  );
}

export default function CausalFollowUpPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#1e1e1e] text-neutral-100" />}>
      <CausalFollowUpPageContent />
    </Suspense>
  );
}
