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
import {
  loadChunkExtractionsForItem,
  loadProjects,
  loadTextChunkRecordsForItem,
  loadCausalArtifactsForItem,
  saveCausalArtifactsForItem,
  type FollowUpExportRecord,
} from "@/lib/pm-storage";

type ExtractedTriple = {
  head: string;
  relationship: string;
  tail: string;
  detail: string;
};

type ExtractionClass = {
  pattern_type: string;
  sentence_type: string;
  marked_type: string;
  explicit_type: string;
  marker: string;
  source_text: string;
  extracted: ExtractedTriple[];
};

type ExtractionPayload = {
  chunk_label: string;
  classes: ExtractionClass[];
};

type ChunkOption = {
  id: string;
  label: string;
  text: string;
};

type ExtractApiResponse = {
  records?: ExtractionClass[];
  error?: string;
  detail?: string;
};

type ChunkExtractResult = {
  ok: boolean;
  classes: ExtractionClass[];
  error?: string;
};

type DisplayChunkOption = ChunkOption & {
  sourceKind: "chunk" | "follow_up";
  questionText?: string;
  sourceText?: string;
};

type DisplayExtractionPayload = ExtractionPayload & {
  id: string;
  sourceKind: "chunk" | "follow_up";
  questionText?: string;
  sourceText?: string;
};

const SINGLE_CHUNK_SOURCE_TEXT =
  "คนเก็บขยะ ใช้รุนแรง ชิบหาย ไอ้เหี้ย มึงใช้มือ พวกเหี้ย นี่ใช้ตีน ตี แตก แหกเนี่ย... พังหมด";

const FALLBACK_CHUNKS: ChunkOption[] = [
  {
    id: "fallback-chunk-1",
    label: "chunk 1",
    text: SINGLE_CHUNK_SOURCE_TEXT,
  },
];

function buildSingleChunkPayload(selectedChunk: ChunkOption, classes: ExtractionClass[]): ExtractionPayload {
  return {
    chunk_label: selectedChunk.label,
    classes,
  };
}

function CausalExtractPageContent() {
  const searchParams = useSearchParams();

  const componentId = searchParams.get("componentId");
  const queryProjectId = searchParams.get("projectId");
  const queryTitle = searchParams.get("title");
  const itemId = searchParams.get("itemId") ?? "";
  const itemFileName = searchParams.get("fileName") ?? "causal-source.txt";

  const selectedComponent = useMemo(() => findComponentById(componentId), [componentId]);
  const selectedProjectId = queryProjectId ?? getProjectIdForComponent(componentId);
  const selectedTitle = queryTitle ?? selectedComponent?.title ?? "Unselected component";
  const [projects, setProjects] = useState<SimulationProject[]>([]);

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

  const [chunkOptions, setChunkOptions] = useState<ChunkOption[]>([]);
  const [chunkLoadStatus, setChunkLoadStatus] = useState<string>("");
  const [selectedChunkId, setSelectedChunkId] = useState<string>("");
  const [isExtracted, setIsExtracted] = useState<boolean>(false);
  const [viewAllMode, setViewAllMode] = useState<boolean>(false);
  const [extractionData, setExtractionData] = useState<DisplayExtractionPayload | null>(null);
  const [isExtracting, setIsExtracting] = useState<boolean>(false);
  const [isExtractingAll, setIsExtractingAll] = useState<boolean>(false);
  const [chunkExtractionMap, setChunkExtractionMap] = useState<Record<string, ExtractionPayload>>({});
  const [followUpRecords, setFollowUpRecords] = useState<FollowUpExportRecord[]>([]);
  const [extractStatus, setExtractStatus] = useState<string>("");

  useEffect(() => {
    if (!itemId) {
      setFollowUpRecords([]);
      return;
    }

    let cancelled = false;

    const loadArtifacts = async () => {
      try {
        const artifacts = await loadCausalArtifactsForItem(itemId);
        if (cancelled) {
          return;
        }

        setFollowUpRecords(artifacts.follow_up ?? []);
      } catch {
        if (!cancelled) {
          setExtractStatus("Unable to load saved extraction artifacts.");
        }
      }
    };

    void loadArtifacts();

    return () => {
      cancelled = true;
    };
  }, [itemId]);

  useEffect(() => {
    let isCancelled = false;

    const hydrateChunks = async () => {
      if (!itemId) {
        setChunkOptions(FALLBACK_CHUNKS);
        setSelectedChunkId(FALLBACK_CHUNKS[0]?.id ?? "");
        setChunkLoadStatus("No file selected. Showing fallback chunk list.");
        setIsExtracted(false);
        setExtractionData(null);
        setViewAllMode(false);
        setChunkExtractionMap({});
        return;
      }

      try {
        const [savedChunks, existingExtractions] = await Promise.all([
          loadTextChunkRecordsForItem(itemId),
          loadChunkExtractionsForItem(itemId),
        ]);
        if (isCancelled) {
          return;
        }

        if (savedChunks.length === 0) {
          setChunkOptions([]);
          setSelectedChunkId("");
          setChunkLoadStatus(
            `No saved chunks found for ${itemFileName || "this file"}. Please chunk and save first.`,
          );
          setIsExtracted(false);
          setExtractionData(null);
          setViewAllMode(false);
          setChunkExtractionMap({});
          return;
        }

        const nextChunkOptions: ChunkOption[] = savedChunks
          .map((chunk) => ({
            id: chunk.id,
            chunkIndex: chunk.chunkIndex,
            text: chunk.text.trim(),
          }))
          .filter((chunk) => chunk.text.length > 0)
          .sort((a, b) => a.chunkIndex - b.chunkIndex)
          .map((chunk, index) => ({
            id: chunk.id,
            label: `chunk ${String(index + 1)}`,
            text: chunk.text,
          }));

        const chunkLabelMap = new Map(nextChunkOptions.map((chunk) => [chunk.id, chunk.label]));
        const hydratedMap: Record<string, ExtractionPayload> = {};
        for (const extraction of existingExtractions) {
          const label = chunkLabelMap.get(extraction.chunkId);
          if (!label) {
            continue;
          }
          hydratedMap[extraction.chunkId] = {
            chunk_label: label,
            classes: extraction.classes.map((record) => ({
              ...record,
              extracted: record.extracted.map((relation) => ({
                ...relation,
                detail: relation.detail ?? "",
              })),
            })),
          };
        }

        setChunkOptions(nextChunkOptions);
        setSelectedChunkId(nextChunkOptions[0].id);
        setChunkLoadStatus(
          `Loaded ${String(nextChunkOptions.length)} chunk${nextChunkOptions.length === 1 ? "" : "s"} from ${itemFileName || "selected file"} (${String(Object.keys(hydratedMap).length)} already extracted).`,
        );
        const firstChunkPayload = hydratedMap[nextChunkOptions[0].id]
          ? {
              id: nextChunkOptions[0].id,
              chunk_label: hydratedMap[nextChunkOptions[0].id].chunk_label,
              classes: hydratedMap[nextChunkOptions[0].id].classes,
              sourceKind: "chunk" as const,
            }
          : null;
        setIsExtracted(Boolean(firstChunkPayload));
        setExtractionData(firstChunkPayload);
        setViewAllMode(false);
        setChunkExtractionMap(hydratedMap);
      } catch {
        if (isCancelled) {
          return;
        }
        setChunkOptions([]);
        setSelectedChunkId("");
        setChunkLoadStatus("Unable to load saved chunks for this file.");
        setIsExtracted(false);
        setExtractionData(null);
        setViewAllMode(false);
        setChunkExtractionMap({});
      }
    };

    void hydrateChunks();

    return () => {
      isCancelled = true;
    };
  }, [itemFileName, itemId]);

  const followUpChunkOptions = useMemo<DisplayChunkOption[]>(() => {
    const options: DisplayChunkOption[] = [];
    let index = 1;

    for (const followUpItem of followUpRecords) {
      for (const question of followUpItem.questions ?? []) {
        const derivedRows = Array.isArray(question.derived_causal) ? question.derived_causal : [];
        if (derivedRows.length === 0) {
          continue;
        }

        const questionText = (question.question_text || "").trim();
        options.push({
          id: `follow-up-${String(index)}`,
          label: `follow-up chunk ${String(index)}`,
          text: questionText || followUpItem.source_text,
          sourceKind: "follow_up",
          questionText,
          sourceText: followUpItem.source_text,
        });
        index += 1;
      }
    }

    return options;
  }, [followUpRecords]);

  const displayChunkOptions = useMemo<DisplayChunkOption[]>(() => {
    const baseOptions: DisplayChunkOption[] = chunkOptions.map((chunk) => ({
      ...chunk,
      sourceKind: "chunk",
    }));
    return [...baseOptions, ...followUpChunkOptions];
  }, [chunkOptions, followUpChunkOptions]);

  const followUpPayloadMap = useMemo<Record<string, DisplayExtractionPayload>>(() => {
    const payloadMap: Record<string, DisplayExtractionPayload> = {};
    let index = 1;

    for (const followUpItem of followUpRecords) {
      for (const question of followUpItem.questions ?? []) {
        const derivedRows = Array.isArray(question.derived_causal)
          ? question.derived_causal.map((row) => ({
              pattern_type: row.pattern_type,
              sentence_type: row.sentence_type,
              marked_type: row.marked_type,
              explicit_type: row.explicit_type,
              marker: row.marker,
              source_text: row.source_text,
              extracted: (row.extracted ?? []).map((relation) => ({
                head: relation.head,
                relationship: relation.relationship,
                tail: relation.tail,
                detail: relation.detail ?? "",
              })),
            }))
          : [];

        if (derivedRows.length === 0) {
          continue;
        }

        const id = `follow-up-${String(index)}`;
        payloadMap[id] = {
          id,
          chunk_label: `follow-up chunk ${String(index)}`,
          classes: derivedRows,
          sourceKind: "follow_up",
          questionText: question.question_text,
          sourceText: followUpItem.source_text,
        };
        index += 1;
      }
    }

    return payloadMap;
  }, [followUpRecords]);

  const displayPayloadMap = useMemo<Record<string, DisplayExtractionPayload>>(() => {
    const payloadMap: Record<string, DisplayExtractionPayload> = {};

    for (const chunk of chunkOptions) {
      const payload = chunkExtractionMap[chunk.id] ?? buildSingleChunkPayload(chunk, []);
      payloadMap[chunk.id] = {
        id: chunk.id,
        chunk_label: payload.chunk_label,
        classes: payload.classes,
        sourceKind: "chunk",
      };
    }

    for (const [key, payload] of Object.entries(followUpPayloadMap)) {
      payloadMap[key] = payload;
    }

    return payloadMap;
  }, [chunkExtractionMap, chunkOptions, followUpPayloadMap]);

  const viewAllPayloads = displayChunkOptions.map(
    (chunk) =>
      displayPayloadMap[chunk.id] ?? {
        id: chunk.id,
        chunk_label: chunk.label,
        classes: [],
        sourceKind: chunk.sourceKind,
        questionText: chunk.questionText,
        sourceText: chunk.sourceText,
      },
  );

  const handleSelectSingleChunk = (chunkId: string) => {
    setSelectedChunkId(chunkId);
    setViewAllMode(false);
    setExtractStatus("");

    const existingPayload = displayPayloadMap[chunkId] ?? null;
    if (existingPayload) {
      setIsExtracted(true);
      setExtractionData(existingPayload);
      return;
    }

    setIsExtracted(false);
    setExtractionData(null);
  };

  const requestChunkExtraction = async (chunk: ChunkOption): Promise<ChunkExtractResult> => {
    try {
      const response = await fetch("/api/causal-extract/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputText: chunk.text,
          causalProjectDocumentId: itemId || undefined,
          chunkId: chunk.id,
        }),
      });

      const payload = (await response.json()) as ExtractApiResponse;
      if (!response.ok) {
        return {
          ok: false,
          classes: [],
          error: payload.error || payload.detail || "Extraction request failed.",
        };
      }

      const normalizedRecords = Array.isArray(payload.records)
        ? payload.records.map((record) => ({
            ...record,
            extracted: Array.isArray(record.extracted)
              ? record.extracted.map((relation) => ({
                  ...relation,
                  detail: relation.detail ?? "",
                }))
              : [],
          }))
        : [];

      return {
        ok: true,
        classes: normalizedRecords,
      };
    } catch {
      return {
        ok: false,
        classes: [],
        error: "Failed to call extraction API.",
      };
    }
  };

  const persistArtifacts = (nextMap: Record<string, ExtractionPayload>) => {
    if (!itemId) {
      return;
    }

    const rawExtraction = Object.values(nextMap);
    void saveCausalArtifactsForItem({
      experimentItemId: itemId,
      rawExtraction,
      followUp: followUpRecords,
    }).catch(() => {
      setExtractStatus("Extraction generated but failed to persist artifacts.");
    });
  };

  const handleExtract = async () => {
    const selectedChunkData = chunkOptions.find((chunk) => chunk.id === selectedChunkId);
    if (!selectedChunkData) {
      return;
    }

    setIsExtracting(true);
    setExtractStatus("");

    try {
      const result = await requestChunkExtraction(selectedChunkData);
      if (!result.ok) {
        const message = result.error || "Extraction request failed.";
        setIsExtracted(false);
        setExtractionData(null);
        setExtractStatus(message);
        return;
      }

      const classes = result.classes;
      const chunkPayload = buildSingleChunkPayload(selectedChunkData, classes);
      const nextSinglePayload: DisplayExtractionPayload = {
        id: selectedChunkData.id,
        chunk_label: chunkPayload.chunk_label,
        classes: chunkPayload.classes,
        sourceKind: "chunk",
      };

      setChunkExtractionMap((prev) => {
        const next = {
          ...prev,
          [selectedChunkData.id]: chunkPayload,
        };
        persistArtifacts(next);
        return next;
      });
      setExtractionData(nextSinglePayload);
      setIsExtracted(true);
      setExtractStatus(
        `Extracted ${String(classes.length)} class${classes.length === 1 ? "" : "es"} from ${selectedChunkData.label}.`,
      );
    } catch {
      setIsExtracted(false);
      setExtractionData(null);
      setExtractStatus("Failed to call extraction API.");
    } finally {
      setIsExtracting(false);
    }
  };

  const handleExtractAll = async () => {
    if (chunkOptions.length === 0) {
      return;
    }

    setIsExtractingAll(true);

    let successCount = 0;
    let failedCount = 0;
    const failedLabels: string[] = [];

    const nextMap: Record<string, ExtractionPayload> = { ...chunkExtractionMap };
    const chunksToExtract = chunkOptions.filter((chunk) => !nextMap[chunk.id]);
    const skippedCount = chunkOptions.length - chunksToExtract.length;

    try {
      if (chunksToExtract.length === 0) {
        setViewAllMode(true);
        setSelectedChunkId("view-all");
        setExtractionData(null);
        setIsExtracted(false);
        setExtractStatus("All chunks are already extracted. Nothing to process.");
        return;
      }

      setExtractStatus(
        `Extracting 0/${String(chunksToExtract.length)} chunk${chunksToExtract.length === 1 ? "" : "s"}${
          skippedCount > 0 ? ` (${String(skippedCount)} already extracted)` : ""
        }...`,
      );

      for (let index = 0; index < chunksToExtract.length; index += 1) {
        const chunk = chunksToExtract[index];
        setExtractStatus(
          `Extracting ${String(index + 1)}/${String(chunksToExtract.length)}: ${chunk.label}${
            skippedCount > 0 ? ` (${String(skippedCount)} already extracted)` : ""
          }`,
        );

        const result = await requestChunkExtraction(chunk);
        if (!result.ok) {
          failedCount += 1;
          failedLabels.push(chunk.label);
          continue;
        }

        const chunkPayload = buildSingleChunkPayload(chunk, result.classes);
        nextMap[chunk.id] = chunkPayload;
        setChunkExtractionMap((prev) => ({
          ...prev,
          [chunk.id]: chunkPayload,
        }));
        successCount += 1;
      }

      persistArtifacts(nextMap);

      setViewAllMode(true);
      setSelectedChunkId("view-all");
      setExtractionData(null);
      setIsExtracted(false);

      if (failedCount === 0) {
        setExtractStatus(
          `Extracted ${String(successCount)} chunk${successCount === 1 ? "" : "s"} successfully${
            skippedCount > 0 ? `, skipped ${String(skippedCount)} already extracted.` : "."
          }`,
        );
      } else {
        setExtractStatus(
          `Extracted ${String(successCount)} chunk${successCount === 1 ? "" : "s"}, failed ${String(failedCount)} (${failedLabels.join(", ")})${
            skippedCount > 0 ? `, skipped ${String(skippedCount)} already extracted.` : "."
          }`,
        );
      }
    } finally {
      setIsExtractingAll(false);
    }
  };

  const handleActivateViewAll = () => {
    if (chunkOptions.length === 0) {
      return;
    }
    setSelectedChunkId("view-all");
    setViewAllMode(true);
    setExtractStatus("");
  };

  return (
    <div className="min-h-screen bg-[#1e1e1e] text-neutral-100">
      <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="max-w-4xl">
            <h1 className="text-3xl font-black tracking-tight md:text-4xl">Causal extraction section</h1>
            <p className="mt-2 text-sm text-neutral-300">
              The objective of this section is to extract causalities from the system that we are interested in
              <br/>as many as possible in order to improve simulation output.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Selected component
              </span>
              <span className="text-sm text-neutral-300">{selectedTitle}</span>
              <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Project
              </span>
              <span className="text-sm text-neutral-300">{selectedProjectName}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <BackToHome
              href="/"
              label="Back to project"
              useHistoryBack
              containerClassName=""
              className="rounded-md px-3 py-2"
            />
          </div>
        </header>

        {extractStatus ? <p className="mb-3 text-xs text-emerald-300">{extractStatus}</p> : null}

        <section className="grid gap-5 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5 backdrop-blur-sm md:grid-cols-[280px_1fr] md:p-6">
          <aside className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-4">
            <h2 className="text-lg font-bold text-neutral-100">Chunk list</h2>
            <p className="mt-1 text-xs text-neutral-400">Select a single chunk or use view all mode.</p>
            <p className="mt-2 text-xs text-neutral-500">{chunkLoadStatus}</p>
            <p className="mt-1 text-xs text-emerald-300">{extractStatus}</p>

            <div className="mt-4 space-y-2">
              {displayChunkOptions.map((chunk) => {
                const isActive = !viewAllMode && selectedChunkId === chunk.id;
                const payload = displayPayloadMap[chunk.id];
                const isChunkExtracted = Boolean(payload && payload.classes.length > 0);

                return (
                  <button
                    type="button"
                    key={chunk.id}
                    onClick={() => handleSelectSingleChunk(chunk.id)}
                    className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm transition ${
                      isActive
                        ? "border-sky-500 bg-sky-950/30 text-sky-200"
                        : "border-neutral-700 bg-neutral-900 text-neutral-200 hover:border-neutral-500"
                    } w-full text-left`}
                  >
                    <span>
                      <span className="block font-medium">{chunk.label}</span>
                      {isChunkExtracted && (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <span className="inline-flex rounded-full border border-emerald-700 bg-emerald-900/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-200">
                            extracted
                          </span>
                          {chunk.sourceKind === "follow_up" ? (
                            <span className="inline-flex rounded-full border border-sky-700 bg-sky-900/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-200">
                              follow_up
                            </span>
                          ) : null}
                        </div>
                      )}
                      <span className="mt-1 block text-xs text-neutral-400">
                        {chunk.text.length > 60 ? `${chunk.text.slice(0, 60)}...` : chunk.text}
                      </span>
                    </span>
                  </button>
                );
              })}
              {displayChunkOptions.length === 0 && (
                <p className="rounded-md border border-dashed border-neutral-700 px-3 py-2 text-xs text-neutral-400">
                  No chunks available for this file.
                </p>
              )}
            </div>

            <div className="mt-4 rounded-md border border-neutral-700 bg-neutral-900 p-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleActivateViewAll}
                  disabled={chunkOptions.length === 0 || isExtractingAll}
                  className={`rounded-md px-3 py-2 text-sm font-semibold transition ${
                    viewAllMode
                      ? "bg-sky-950/40 text-sky-200"
                      : "bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  view all
                </button>
                <button
                  type="button"
                  onClick={handleExtractAll}
                  disabled={chunkOptions.length === 0 || isExtracting || isExtractingAll}
                  className="rounded-md bg-sky-900/40 px-3 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-900/60 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isExtractingAll ? "Extracting all..." : "Extract all"}
                </button>
              </div>
            </div>
          </aside>

          <div className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-5">
            {viewAllMode ? (
              <div className="space-y-6">
                {viewAllPayloads.map((payload) => (
                  <div key={payload.chunk_label}>
                    <div className="mb-3 inline-flex rounded-full border border-neutral-700 bg-neutral-800 px-3 py-1 text-xs text-neutral-300">
                      {payload.chunk_label}
                    </div>
                    {payload.sourceKind === "follow_up" ? (
                      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-sky-200">
                        <span className="inline-flex rounded-full border border-sky-700 bg-sky-900/30 px-2 py-0.5 font-semibold uppercase tracking-wide">
                          follow_up
                        </span>
                        {payload.questionText ? <span>Q: {payload.questionText}</span> : null}
                      </div>
                    ) : null}
                    <div className="space-y-4">
                      {payload.classes.map((item, index) => (
                        <div
                          key={`${payload.chunk_label}-${item.marker}-${String(index)}`}
                          className="rounded-xl border border-neutral-700 bg-neutral-900 p-4 text-sm text-neutral-200"
                        >
                          <div className="mb-3 inline-flex rounded-full border border-neutral-700 bg-neutral-800 px-2 py-1 text-[11px] uppercase tracking-wide text-neutral-300">
                            class {String(index + 1)}
                          </div>
                          {payload.sourceKind === "follow_up" ? (
                            <div className="mb-3 inline-flex rounded-full border border-sky-700 bg-sky-900/30 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-sky-200">
                              follow_up
                            </div>
                          ) : null}

                          <dl className="grid gap-3 md:grid-cols-2">
                            <div>
                              <dt className="text-xs uppercase tracking-wide text-neutral-400">pattern_type</dt>
                              <dd className="mt-1 font-semibold text-neutral-100">{item.pattern_type}</dd>
                            </div>
                            <div>
                              <dt className="text-xs uppercase tracking-wide text-neutral-400">sentence_type</dt>
                              <dd className="mt-1 font-semibold text-neutral-100">{item.sentence_type}</dd>
                            </div>
                            <div>
                              <dt className="text-xs uppercase tracking-wide text-neutral-400">marked_type</dt>
                              <dd className="mt-1 font-semibold text-neutral-100">{item.marked_type}</dd>
                            </div>
                            <div>
                              <dt className="text-xs uppercase tracking-wide text-neutral-400">explicit_type</dt>
                              <dd className="mt-1 font-semibold text-neutral-100">{item.explicit_type}</dd>
                            </div>
                          </dl>

                          <div className="mt-4">
                            <p className="text-xs uppercase tracking-wide text-neutral-400">marker</p>
                            <p className="mt-1 text-neutral-100">{item.marker}</p>
                          </div>

                          <div className="mt-4">
                            <p className="text-xs uppercase tracking-wide text-neutral-400">source_text</p>
                            <p className="mt-1 rounded-md border border-neutral-700 bg-neutral-800/70 p-3 text-neutral-200">
                              {item.source_text}
                            </p>
                          </div>

                          <div className="mt-4 rounded-lg border border-neutral-700 bg-neutral-800/70 p-4">
                            <p className="text-xs uppercase tracking-wide text-neutral-400">extracted</p>
                            <div className="mt-3 space-y-3">
                              {item.extracted.length === 0 && (
                                <p className="text-xs text-neutral-400">No extracted relations returned.</p>
                              )}
                              {item.extracted.map((relation, relationIndex) => (
                                <dl
                                  key={`${payload.chunk_label}-${String(index)}-${String(relationIndex)}`}
                                  className="rounded-md border border-neutral-700 bg-neutral-900/70 p-3"
                                >
                                  <div>
                                    <dt className="text-xs text-neutral-400">head</dt>
                                    <dd className="text-neutral-100">{relation.head}</dd>
                                  </div>
                                  <div>
                                    <dt className="text-xs text-neutral-400">relationship</dt>
                                    <dd className="text-neutral-100">{relation.relationship}</dd>
                                  </div>
                                  <div>
                                    <dt className="text-xs text-neutral-400">tail</dt>
                                    <dd className="text-neutral-100">{relation.tail}</dd>
                                  </div>
                                  <div>
                                    <dt className="text-xs text-neutral-400">detail</dt>
                                    <dd className="text-neutral-100">{relation.detail}</dd>
                                  </div>
                                </dl>
                              ))}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : chunkOptions.length === 0 ? (
              <div className="flex min-h-90 items-center justify-center text-sm text-neutral-400">
                No chunked data found for this file yet. Open chunking page and save chunks first.
              </div>
            ) : !isExtracted ? (
              <div className="flex min-h-90 items-center justify-center">
                <button
                  type="button"
                  onClick={handleExtract}
                  disabled={isExtracting || isExtractingAll}
                  className="rounded-lg border border-neutral-600 bg-neutral-800 px-8 py-3 text-base font-semibold text-neutral-100 transition hover:border-sky-500 hover:text-sky-200 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isExtracting ? "Extracting..." : "Extract"}
                </button>
              </div>
            ) : extractionData ? (
              <div>
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-neutral-700 bg-neutral-800 px-3 py-1 text-xs text-neutral-300">
                    {`Extracted from ${extractionData.chunk_label}`}
                  </span>
                  {extractionData.sourceKind === "follow_up" ? (
                    <span className="rounded-full border border-sky-700 bg-sky-900/30 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-sky-200">
                      follow_up
                    </span>
                  ) : null}
                </div>

                <div className="space-y-4">
                  {extractionData.classes.map((item, index) => (
                    <div
                      key={`${extractionData.chunk_label}-${item.marker}-${String(index)}`}
                      className="rounded-xl border border-neutral-700 bg-neutral-900 p-4 text-sm text-neutral-200"
                    >
                      <div className="mb-3 inline-flex rounded-full border border-neutral-700 bg-neutral-800 px-2 py-1 text-[11px] uppercase tracking-wide text-neutral-300">
                        class {String(index + 1)}
                      </div>
                      {extractionData.sourceKind === "follow_up" ? (
                        <div className="mb-3 inline-flex rounded-full border border-sky-700 bg-sky-900/30 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-sky-200">
                          follow_up
                        </div>
                      ) : null}

                      <dl className="grid gap-3 md:grid-cols-2">
                        <div>
                          <dt className="text-xs uppercase tracking-wide text-neutral-400">pattern_type</dt>
                          <dd className="mt-1 font-semibold text-neutral-100">{item.pattern_type}</dd>
                        </div>
                        <div>
                          <dt className="text-xs uppercase tracking-wide text-neutral-400">sentence_type</dt>
                          <dd className="mt-1 font-semibold text-neutral-100">{item.sentence_type}</dd>
                        </div>
                        <div>
                          <dt className="text-xs uppercase tracking-wide text-neutral-400">marked_type</dt>
                          <dd className="mt-1 font-semibold text-neutral-100">{item.marked_type}</dd>
                        </div>
                        <div>
                          <dt className="text-xs uppercase tracking-wide text-neutral-400">explicit_type</dt>
                          <dd className="mt-1 font-semibold text-neutral-100">{item.explicit_type}</dd>
                        </div>
                      </dl>

                      <div className="mt-4">
                        <p className="text-xs uppercase tracking-wide text-neutral-400">marker</p>
                        <p className="mt-1 text-neutral-100">{item.marker}</p>
                      </div>

                      <div className="mt-4">
                        <p className="text-xs uppercase tracking-wide text-neutral-400">source_text</p>
                        <p className="mt-1 rounded-md border border-neutral-700 bg-neutral-800/70 p-3 text-neutral-200">
                          {item.source_text}
                        </p>
                      </div>

                      <div className="mt-4 rounded-lg border border-neutral-700 bg-neutral-800/70 p-4">
                        <p className="text-xs uppercase tracking-wide text-neutral-400">extracted</p>
                        <div className="mt-3 space-y-3">
                          {item.extracted.length === 0 && (
                            <p className="text-xs text-neutral-400">No extracted relations returned.</p>
                          )}
                          {item.extracted.map((relation, relationIndex) => (
                            <dl
                              key={`${extractionData.chunk_label}-${String(index)}-${String(relationIndex)}`}
                              className="rounded-md border border-neutral-700 bg-neutral-900/70 p-3"
                            >
                              <div>
                                <dt className="text-xs text-neutral-400">head</dt>
                                <dd className="text-neutral-100">{relation.head}</dd>
                              </div>
                              <div>
                                <dt className="text-xs text-neutral-400">relationship</dt>
                                <dd className="text-neutral-100">{relation.relationship}</dd>
                              </div>
                              <div>
                                <dt className="text-xs text-neutral-400">tail</dt>
                                <dd className="text-neutral-100">{relation.tail}</dd>
                              </div>
                              <div>
                                <dt className="text-xs text-neutral-400">detail</dt>
                                <dd className="text-neutral-100">{relation.detail}</dd>
                              </div>
                            </dl>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex min-h-90 items-center justify-center text-sm text-neutral-400">
                Select chunks to see aggregated extraction output.
              </div>
            )}

          </div>
        </section>
      </main>
    </div>
  );
}

export default function CausalExtractPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#1e1e1e] text-neutral-100" />}>
      <CausalExtractPageContent />
    </Suspense>
  );
}
