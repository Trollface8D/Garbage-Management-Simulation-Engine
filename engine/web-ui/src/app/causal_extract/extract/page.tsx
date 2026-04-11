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
  loadCausalArtifactsForItem,
  loadProjects,
  loadTextChunksForItem,
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

type CausalExportPayload = {
  export_type: "causal";
  version: "1.0";
  exported_at: string;
  project_id: string;
  component_id: string;
  item_id: string;
  file_name: string;
  raw_extraction: ExtractionPayload[];
  follow_up: FollowUpExportRecord[];
  chunk_snapshot: Array<{
    index: number;
    metadata: {
      length: number;
      source: "text_chunks";
    };
    content: string;
  }>;
};

const CHUNK_OPTIONS = ["chunk 1", "chunk 2", "chunk 3", "chunk 4"];

const SINGLE_CHUNK_SOURCE_TEXT =
  "คนเก็บขยะ ใช้รุนแรง ชิบหาย ไอ้เหี้ย มึงใช้มือ พวกเหี้ย นี่ใช้ตีน ตี แตก แหกเนี่ย... พังหมด";

function buildClassRecords(contextLabel: string): ExtractionClass[] {
  if (contextLabel === "chunk 1") {
    return [
      {
        pattern_type: "C",
        sentence_type: "SB",
        marked_type: "M",
        explicit_type: "E",
        marker: "ทำให้ (makes/causes)",
        source_text: SINGLE_CHUNK_SOURCE_TEXT,
        extracted: [
          {
            head: "Garbage collectors using rough handling",
            relationship: "causes",
            tail: "equipment damage",
            detail: "using feet to hit bins",
          },
          {
            head: "Aggressive unloading routine",
            relationship: "causes",
            tail: "bin wheel failure",
            detail: "impact force damages wheel joints",
          },
        ],
      },
      {
        pattern_type: "C",
        sentence_type: "SB",
        marked_type: "M",
        explicit_type: "E",
        marker: "ส่งผลให้ (results in)",
        source_text:
          "การเทถังแรงและไม่ระวังส่งผลให้ขอบถังแตกและต้องหยุดใช้งานชั่วคราว",
        extracted: [
          {
            head: "Forceful dumping behavior",
            relationship: "causes",
            tail: "temporary bin downtime",
            detail: "cracked bin edges from repeated impacts",
          },
        ],
      },
    ];
  }

  return [
    {
      pattern_type: "C",
      sentence_type: "SB",
      marked_type: "M",
      explicit_type: "E",
      marker: "ทำให้ (makes/causes)",
      source_text: SINGLE_CHUNK_SOURCE_TEXT,
      extracted: [
        {
          head: `${contextLabel} rough collection practice`,
          relationship: "causes",
          tail: "equipment damage",
          detail: `localized impact in ${contextLabel}`,
        },
      ],
    },
  ];
}

function buildSingleChunkPayload(selectedChunk: string): ExtractionPayload {
  return {
    chunk_label: selectedChunk,
    classes: buildClassRecords(selectedChunk),
  };
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

  const [selectedChunk, setSelectedChunk] = useState<string>("chunk 1");
  const [isExtracted, setIsExtracted] = useState<boolean>(false);
  const [viewAllMode, setViewAllMode] = useState<boolean>(false);
  const [extractionData, setExtractionData] = useState<ExtractionPayload | null>(null);
  const [isExtracting, setIsExtracting] = useState<boolean>(false);
  const [chunkExtractionMap, setChunkExtractionMap] = useState<Record<string, ExtractionPayload>>({});
  const [followUpRecords, setFollowUpRecords] = useState<FollowUpExportRecord[]>([]);
  const [extractStatus, setExtractStatus] = useState<string>("");
  const [exportStatus, setExportStatus] = useState<string>("");

  useEffect(() => {
    if (!itemId) {
      setChunkExtractionMap({});
      setFollowUpRecords([]);
      setIsExtracted(false);
      setExtractionData(null);
      return;
    }

    let cancelled = false;

    const loadArtifacts = async () => {
      try {
        const artifacts = await loadCausalArtifactsForItem(itemId);
        if (cancelled) {
          return;
        }

        const nextMap: Record<string, ExtractionPayload> = {};
        for (const chunk of artifacts.raw_extraction) {
          nextMap[chunk.chunk_label] = {
            chunk_label: chunk.chunk_label,
            classes: chunk.classes,
          };
        }

        setChunkExtractionMap(nextMap);
        setFollowUpRecords(artifacts.follow_up ?? []);
        if (nextMap[selectedChunk]) {
          setExtractionData(nextMap[selectedChunk]);
          setIsExtracted(true);
        } else {
          setExtractionData(null);
          setIsExtracted(false);
        }
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
  }, [itemId, selectedChunk]);

  const viewAllPayloads = CHUNK_OPTIONS.map((chunk) => chunkExtractionMap[chunk] ?? buildSingleChunkPayload(chunk));

  const handleSelectSingleChunk = (chunk: string) => {
    setSelectedChunk(chunk);
    setViewAllMode(false);

    const existingPayload = chunkExtractionMap[chunk] ?? null;
    if (existingPayload) {
      setIsExtracted(true);
      setExtractionData(existingPayload);
      return;
    }

    setIsExtracted(false);
    setExtractionData(null);
  };

  const handleExtract = async () => {
    setIsExtracting(true);
    setExtractStatus("");

    await new Promise((resolve) => {
      window.setTimeout(resolve, 500);
    });

    const payload = buildSingleChunkPayload(selectedChunk);

    setChunkExtractionMap((prev) => {
      const next = {
        ...prev,
        [selectedChunk]: payload,
      };

      if (itemId) {
        const rawExtraction = Object.values(next);
        void saveCausalArtifactsForItem({
          experimentItemId: itemId,
          rawExtraction,
          followUp: followUpRecords,
        }).catch(() => {
          setExtractStatus("Extraction generated but failed to persist artifacts.");
        });
      }

      return next;
    });
    setExtractionData(payload);
    setIsExtracted(true);
    setIsExtracting(false);
    setExtractStatus("Extraction generated.");
  };

  const handleExportCausal = async () => {
    if (!itemId || !selectedProjectId || !componentId) {
      setExportStatus("Export unavailable: no item selected.");
      return;
    }

    const rawExtraction = Object.values(chunkExtractionMap);
    if (rawExtraction.length === 0) {
      setExportStatus("No extraction artifact available to export.");
      return;
    }

    try {
      const chunks = await loadTextChunksForItem(itemId);
      const payload: CausalExportPayload = {
        export_type: "causal",
        version: "1.0",
        exported_at: new Date().toISOString(),
        project_id: selectedProjectId,
        component_id: componentId,
        item_id: itemId,
        file_name: itemFileName,
        raw_extraction: rawExtraction,
        follow_up: followUpRecords,
        chunk_snapshot: chunks.map((content, index) => ({
          index,
          metadata: {
            length: content.length,
            source: "text_chunks",
          },
          content,
        })),
      };

      const stamp = new Date().toISOString().replace(/[.:]/g, "-");
      const fileName = `${sanitizeFilenameSegment(itemFileName || itemId)}-causal-${stamp}.json`;
      downloadJsonFile(fileName, payload);
      setExportStatus("Causal artifact exported.");
    } catch {
      setExportStatus("Unable to export causal artifact.");
    }
  };

  const handleActivateViewAll = () => {
    setSelectedChunk("view all");
    setViewAllMode(true);
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
            <button
              type="button"
              onClick={() => void handleExportCausal()}
              disabled={!itemId}
              className="rounded-md border border-sky-600 bg-sky-500/10 px-3 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-55"
            >
              Export causal
            </button>
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
        {exportStatus ? <p className="mb-3 text-xs text-sky-200">{exportStatus}</p> : null}

        <section className="grid gap-5 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5 backdrop-blur-sm md:grid-cols-[280px_1fr] md:p-6">
          <aside className="rounded-xl border border-neutral-800 bg-neutral-900/70 p-4">
            <h2 className="text-lg font-bold text-neutral-100">Chunk list</h2>
            <p className="mt-1 text-xs text-neutral-400">Select a single chunk or use view all mode.</p>

            <div className="mt-4 space-y-2">
              {CHUNK_OPTIONS.map((chunk) => {
                const isActive = !viewAllMode && selectedChunk === chunk;

                return (
                  <button
                    type="button"
                    key={chunk}
                    onClick={() => handleSelectSingleChunk(chunk)}
                    className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm transition ${
                      isActive
                        ? "border-sky-500 bg-sky-950/30 text-sky-200"
                        : "border-neutral-700 bg-neutral-900 text-neutral-200 hover:border-neutral-500"
                    } w-full text-left`}
                  >
                    <span className="font-medium">
                      {chunk}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-4 rounded-md border border-neutral-700 bg-neutral-900 p-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleActivateViewAll}
                  className={`rounded-md px-3 py-2 text-sm font-semibold transition ${
                    viewAllMode
                      ? "bg-sky-950/40 text-sky-200"
                      : "bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
                  }`}
                >
                  view all
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
                    <div className="space-y-4">
                      {payload.classes.map((item, index) => (
                        <div
                          key={`${payload.chunk_label}-${item.marker}-${String(index)}`}
                          className="rounded-xl border border-neutral-700 bg-neutral-900 p-4 text-sm text-neutral-200"
                        >
                          <div className="mb-3 inline-flex rounded-full border border-neutral-700 bg-neutral-800 px-2 py-1 text-[11px] uppercase tracking-wide text-neutral-300">
                            class {String(index + 1)}
                          </div>

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
            ) : !isExtracted ? (
              <div className="flex min-h-90 items-center justify-center">
                <button
                  type="button"
                  onClick={handleExtract}
                  disabled={isExtracting}
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
