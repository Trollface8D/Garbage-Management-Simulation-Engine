"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CausalUsedCard, MapUsedCard } from "../causal_extract/used-item-cards";

type UsedItem = {
  id: string;
  title: string;
  project: string;
  lastEdited: string;
};

type GeneratedEntity = {
  id: string;
  name: string;
  count: number;
  selected: boolean;
};

const EXTRACTION_DELAY_MS = 1300;
const PROGRESS_TICK_MS = 240;
const PROGRESS_STEP = 6;

const INITIAL_CAUSAL_ITEMS: UsedItem[] = [
  { id: "causal-1", title: "City Waste Flow A", project: "Bangkok Pilot", lastEdited: "2h ago" },
  { id: "causal-2", title: "Worker Shift Constraints", project: "Bangkok Pilot", lastEdited: "5h ago" },
  { id: "causal-3", title: "Transfer Route Causal", project: "Nonthaburi Study", lastEdited: "1d ago" },
  { id: "causal-4", title: "Vehicle Downtime Effects", project: "Phuket Ops", lastEdited: "3d ago" },
];

const INITIAL_MAP_ITEMS: UsedItem[] = [
  { id: "map-1", title: "District Collection Map", project: "Bangkok Pilot", lastEdited: "4h ago" },
  { id: "map-2", title: "Depot Access Heatmap", project: "Phuket Ops", lastEdited: "1d ago" },
];

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
  const [causalItems, setCausalItems] = useState<UsedItem[]>(INITIAL_CAUSAL_ITEMS);
  const [mapItems, setMapItems] = useState<UsedItem[]>(INITIAL_MAP_ITEMS);
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId");
  const projectBackHref = projectId ? `/pm/${encodeURIComponent(projectId)}` : "/";

  const [entities, setEntities] = useState<GeneratedEntity[]>(INITIAL_ENTITIES);
  const [isExtracted, setIsExtracted] = useState<boolean>(false);
  const [isExtracting, setIsExtracting] = useState<boolean>(false);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);

  const progressTimerRef = useRef<number | null>(null);

  const selectedEntities = useMemo(
    () => entities.filter((entity) => entity.selected),
    [entities],
  );
  const totalEntityCount = useMemo(
    () => selectedEntities.reduce((sum, entity) => sum + entity.count, 0),
    [selectedEntities],
  );

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

  const handleDeleteCausalItem = (targetId: string) => {
    setCausalItems((prev) => prev.filter((item) => item.id !== targetId));
  };

  const handleDeleteMapItem = (targetId: string) => {
    setMapItems((prev) => prev.filter((item) => item.id !== targetId));
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

  return (
    <div className="min-h-screen bg-[#1e1e1e] text-neutral-100">
      <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-black tracking-tight text-neutral-100 md:text-4xl">
            Simulation object generation config
          </h1>

          <Link
            href={projectBackHref}
            className="rounded-md border border-neutral-700 bg-neutral-800 px-4 py-2 text-sm font-semibold text-white transition hover:border-sky-500"
          >
            Back to code generation home
          </Link>
        </header>

        <section className="space-y-8">
          <div>
            <h2 className="mb-4 text-xl font-bold text-neutral-100 md:text-2xl">Causal used</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {causalItems.map((item) => (
                <CausalUsedCard
                  key={item.id}
                  title={item.title}
                  project={item.project}
                  lastEdited={item.lastEdited}
                  onDelete={() => handleDeleteCausalItem(item.id)}
                />
              ))}
            </div>
          </div>

          <div>
            <h2 className="mb-4 text-xl font-bold text-neutral-100 md:text-2xl">Map used</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {mapItems.map((item) => (
                <MapUsedCard
                  key={item.id}
                  title={item.title}
                  project={item.project}
                  lastEdited={item.lastEdited}
                  onDelete={() => handleDeleteMapItem(item.id)}
                />
              ))}
            </div>
          </div>

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
