"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import {
  findComponentById,
  findProjectById,
  getProjectIdForComponent,
} from "@/lib/simulation-components";
import BackToHome from "../../components/back-to-home";
import { loadProjects } from "@/lib/pm-storage";

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

function CausalExtractPageContent() {
  const searchParams = useSearchParams();

  const componentId = searchParams.get("componentId");
  const queryProjectId = searchParams.get("projectId");
  const queryTitle = searchParams.get("title");

  const selectedComponent = useMemo(() => findComponentById(componentId), [componentId]);
  const selectedProjectId = queryProjectId ?? getProjectIdForComponent(componentId);
  const selectedTitle = queryTitle ?? selectedComponent?.title ?? "Unselected component";
  const selectedProjectName = useMemo(
    () => loadProjects().find((project) => project.id === selectedProjectId)?.name ?? findProjectById(selectedProjectId)?.name ?? "Unselected project",
    [selectedProjectId],
  );
  const projectBackHref = selectedProjectId ? `/pm/${encodeURIComponent(selectedProjectId)}` : "/";

  const [selectedChunk, setSelectedChunk] = useState<string>("chunk 1");
  const [isExtracted, setIsExtracted] = useState<boolean>(false);
  const [viewAllMode, setViewAllMode] = useState<boolean>(false);
  const [extractionData, setExtractionData] = useState<ExtractionPayload | null>(null);
  const [isExtracting, setIsExtracting] = useState<boolean>(false);
  const [chunkExtractionMap, setChunkExtractionMap] = useState<Record<string, ExtractionPayload>>({});

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

    await new Promise((resolve) => {
      window.setTimeout(resolve, 500);
    });

    const payload = buildSingleChunkPayload(selectedChunk);

    setChunkExtractionMap((prev) => ({
      ...prev,
      [selectedChunk]: payload,
    }));
    setExtractionData(payload);
    setIsExtracted(true);
    setIsExtracting(false);
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
          <BackToHome
            href={projectBackHref}
            label="Back to project"
            containerClassName=""
            className="rounded-md px-3 py-2"
          />
        </header>

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
              <div className="flex min-h-[360px] items-center justify-center">
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
              <div className="flex min-h-[360px] items-center justify-center text-sm text-neutral-400">
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
