"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  type SimulationComponent,
  type SimulationProject,
} from "@/lib/simulation-components";
import {
  createProject,
  loadComponents,
  loadProjects,
  softDeleteProject,
} from "@/lib/pm-storage";

function ProjectThumbPlaceholder() {
  return (
    <div className="relative h-40 w-full overflow-hidden rounded-t-xl border-b border-neutral-700 bg-neutral-800 p-3">
      <div className="mb-2 h-3 w-24 rounded bg-neutral-600/80" />
      <div className="grid h-[calc(100%-1.25rem)] grid-cols-3 gap-2">
        <div className="rounded bg-neutral-700/90 p-2">
          <div className="mb-1 h-1.5 w-8 rounded bg-neutral-500" />
          <div className="h-1.5 w-12 rounded bg-neutral-500" />
        </div>
        <div className="rounded bg-neutral-700/90 p-2">
          <div className="mb-1 h-1.5 w-9 rounded bg-neutral-500" />
          <div className="mb-1 h-1.5 w-11 rounded bg-neutral-500" />
          <div className="h-1.5 w-8 rounded bg-neutral-500" />
        </div>
        <div className="rounded bg-neutral-700/90 p-2">
          <div className="mb-1 h-1.5 w-10 rounded bg-neutral-500" />
          <div className="h-6 w-full rounded bg-neutral-600/80" />
        </div>
      </div>
    </div>
  );
}

function FolderTypeIcon() {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-sky-600/20 text-xs font-semibold text-sky-300">
      P
    </span>
  );
}

function AddCard({
  title,
  subtitle,
  onClick,
}: {
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group overflow-hidden rounded-xl border border-dashed border-neutral-600 bg-neutral-900/40 text-left shadow-[0_0_0_1px_rgba(255,255,255,0.01)] transition duration-200 hover:scale-[1.02] hover:border-sky-500"
    >
      <div className="relative flex h-40 w-full items-center justify-center overflow-hidden rounded-t-xl border-b border-neutral-700 bg-neutral-800/80 p-3">
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-sky-500 text-2xl text-white">+</span>
      </div>
      <div className="bg-neutral-900 px-4 py-3">
        <p className="text-sm font-semibold text-neutral-100">{title}</p>
        <p className="mt-1 text-xs text-neutral-400">{subtitle}</p>
      </div>
    </button>
  );
}

function toProjectId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "new-project";
}

function getProjectSummary(projectId: string, components: SimulationComponent[]) {
  const projectComponents = components.filter((component) => {
    if (component.category === "PolicyTesting") {
      return component.leftProjectId === projectId || component.rightProjectId === projectId;
    }
    return component.projectId === projectId;
  });

  return {
    total: projectComponents.length,
    causal: projectComponents.filter((component) => component.category === "Causal").length,
    map: projectComponents.filter((component) => component.category === "Map").length,
    code: projectComponents.filter((component) => component.category === "Code").length,
    policytesting: projectComponents.filter((component) => component.category === "PolicyTesting").length,
    latestEdited: projectComponents[0]?.lastEdited ?? "No activity",
  };
}

export default function Home() {
  const [projects, setProjects] = useState<SimulationProject[]>([]);
  const [components, setComponents] = useState<SimulationComponent[]>([]);

  useEffect(() => {
    const loadData = async () => {
      const [nextProjects, nextComponents] = await Promise.all([
        loadProjects(),
        loadComponents(),
      ]);

      setProjects(nextProjects);
      setComponents(nextComponents);
    };

    void loadData();
  }, []);

  const projectSummaries = useMemo(() => {
    return projects.map((project) => ({
      project,
      summary: getProjectSummary(project.id, components),
    }));
  }, [components, projects]);

  const handleAddProject = async () => {
    const rawName = window.prompt("Project name");
    if (!rawName) {
      return;
    }

    const name = rawName.trim();
    if (!name) {
      return;
    }

    const baseId = toProjectId(name);
    const existingIds = new Set(projects.map((project) => project.id));
    let candidateId = baseId;
    let suffix = 2;

    while (existingIds.has(candidateId)) {
      candidateId = `${baseId}-${suffix}`;
      suffix += 1;
    }

    await createProject({ id: candidateId, name });
    setProjects(await loadProjects());
  };

  const handleSoftDeleteProject = async (projectId: string) => {
    if (!window.confirm("Move this project to Trash Can?")) {
      return;
    }

    await softDeleteProject(projectId);

    const [nextProjects, nextComponents] = await Promise.all([
      loadProjects(),
      loadComponents(),
    ]);

    setProjects(nextProjects);
    setComponents(nextComponents);
  };

  return (
    <div className="min-h-screen bg-[var(--surface-0)] text-[var(--text-1)]">
      <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
        <header className="mb-10">
          <h1 className="text-left text-3xl font-black uppercase tracking-tight text-neutral-100 md:text-5xl lg:text-6xl">
            Garbage Flow Simulation Engine
          </h1>
          <p className="mt-3 max-w-3xl text-sm text-neutral-400 md:text-base">
            Select a project to open its PM dashboard for causal exploration, map views, code generation, and policy testing.
          </p>
        </header>

        <section className="grid grid-cols-1 gap-5 md:grid-cols-3 lg:grid-cols-4 lg:gap-8">
          <AddCard
            title="Add new project"
            subtitle="Create a PM dashboard for a new project"
            onClick={handleAddProject}
          />

          {projectSummaries.map(({ project, summary }) => {
            return (
              <Link
                key={project.id}
                href={`/pm/${project.id}`}
                className="group overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900/60 shadow-[0_0_0_1px_rgba(255,255,255,0.01)] transition duration-200 hover:scale-[1.02] hover:border-sky-500 hover:shadow-[0_0_0_2px_rgba(14,165,233,0.35)]"
              >
                <ProjectThumbPlaceholder />

                <div className="flex items-end justify-between gap-3 bg-neutral-900 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FolderTypeIcon />
                      <p className="truncate text-sm font-semibold text-neutral-100">{project.name}</p>
                    </div>
                    <p className="mt-1 text-xs text-neutral-400">Last activity: {summary.latestEdited}</p>
                    <p className="mt-1 text-xs text-neutral-500">
                      {summary.total} components • Causal {summary.causal} • Map {summary.map} • Code {summary.code} • PolicyTesting {summary.policytesting}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void handleSoftDeleteProject(project.id);
                    }}
                    className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-red-500/70 hover:text-red-200"
                    aria-label={`Delete ${project.name}`}
                  >
                    Delete
                  </button>
                </div>
              </Link>
            );
          })}

          {projectSummaries.length === 0 ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 text-sm text-neutral-400">
              No projects yet. Use the add card to create your first PM project.
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}
