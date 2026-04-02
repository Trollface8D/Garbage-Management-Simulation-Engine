"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";
import {
  findComponentById,
  findProjectById,
  getProjectIdForComponent,
} from "@/lib/simulation-components";
import BackToHome from "../../components/back-to-home";
import FollowUpGenerationPage from "../../components/follow-up-generation-page";
import { loadProjects } from "@/lib/pm-storage";

function CausalFollowUpPageContent() {
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
            href={projectBackHref}
            label="Back to project"
            containerClassName=""
            className="rounded-md px-3 py-2"
          />
        </header>

        <FollowUpGenerationPage />
      </main>
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
