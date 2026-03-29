"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";
import {
  findComponentById,
  findProjectById,
  getProjectIdForComponent,
} from "@/lib/simulation-components";

function CausalExtractPageContent() {
  const searchParams = useSearchParams();

  const componentId = searchParams.get("componentId");
  const queryProjectId = searchParams.get("projectId");
  const queryTitle = searchParams.get("title");

  const selectedComponent = useMemo(() => findComponentById(componentId), [componentId]);
  const selectedProjectId = queryProjectId ?? getProjectIdForComponent(componentId);
  const selectedTitle = queryTitle ?? selectedComponent?.title ?? "Unselected component";
  const selectedProjectName = findProjectById(selectedProjectId)?.name ?? "Unselected project";

  return (
    <div className="min-h-screen bg-[#1e1e1e] text-neutral-100">
      <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black uppercase tracking-tight md:text-4xl">Causal Extract - Extract</h1>
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
          <Link
            href="/causal_extract"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm font-semibold text-neutral-200 transition hover:border-sky-500 hover:text-sky-200"
          >
            Back to causal extraction home
          </Link>
        </header>

        <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5 backdrop-blur-sm md:p-6">
          <h2 className="text-2xl font-bold text-neutral-100">Extract</h2>
          <p className="mt-2 max-w-3xl text-sm text-neutral-300">
            This workspace is for extracting causal data from chunked inputs.
          </p>

          <div className="mt-6 rounded-xl border border-neutral-700 bg-neutral-900/70 p-4 text-sm text-neutral-300">
            Extraction panel placeholder. The /causal_extract home page already filters experiment items so only
            chunked and extracted data appear for this feature.
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
