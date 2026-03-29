"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  categoryPath,
  filterOptions,
  getProjectName,
  isComparisonComponent,
  isProjectScopedComponent,
  simulationComponents,
  simulationProjects,
  type FilterOption,
  type SimulationProject,
} from "@/lib/simulation-components";

function FileThumbPlaceholder() {
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

function FileTypeIcon() {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-sky-600/20 text-xs font-semibold text-sky-300">
      F
    </span>
  );
}

export default function Home() {
  const [projects, setProjects] = useState<SimulationProject[]>(simulationProjects);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(simulationProjects[0]?.id ?? "");
  const [activeFilter, setActiveFilter] = useState<FilterOption>("All");

  const filteredComponents = useMemo(() => {
    return simulationComponents.filter((component) => {
      const matchesFilter = activeFilter === "All" || component.category === activeFilter;
      if (!matchesFilter) {
        return false;
      }

      if (isProjectScopedComponent(component)) {
        return component.projectId === selectedProjectId;
      }

      return component.leftProjectId === selectedProjectId || component.rightProjectId === selectedProjectId;
    });
  }, [activeFilter, selectedProjectId]);

  const selectedProjectName = useMemo(() => {
    return projects.find((project) => project.id === selectedProjectId)?.name ?? "Unselected project";
  }, [projects, selectedProjectId]);

  const handleProjectChange = (value: string) => {
    if (value !== "__add_new__") {
      setSelectedProjectId(value);
      return;
    }

    const nextNameRaw = window.prompt("Enter new project name:");
    const nextName = nextNameRaw?.trim();
    if (!nextName) {
      return;
    }

    const existingByName = projects.find((project) => project.name.toLowerCase() === nextName.toLowerCase());
    if (existingByName) {
      setSelectedProjectId(existingByName.id);
      return;
    }

    const slugBase = nextName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    let nextId = slugBase || `project-${String(projects.length + 1)}`;
    let index = 2;
    while (projects.some((project) => project.id === nextId)) {
      nextId = `${slugBase || "project"}-${String(index)}`;
      index += 1;
    }

    const nextProject: SimulationProject = { id: nextId, name: nextName };
    setProjects((prev) => [nextProject, ...prev]);
    setSelectedProjectId(nextProject.id);
  };

  return (
    <div className="min-h-screen bg-[#1e1e1e] text-neutral-100">
      <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
        <header className="mb-10">
          <h1 className="text-left text-3xl font-black uppercase tracking-tight text-neutral-100 md:text-5xl lg:text-6xl">
            Garbage Flow Simulation Engine
          </h1>
        </header>

        <section className="mb-8 flex flex-col gap-4 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4 backdrop-blur-sm md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <label htmlFor="team-project" className="text-sm font-medium text-neutral-300">
              Project
            </label>
            <select
              id="team-project"
              value={selectedProjectId}
              onChange={(event) => handleProjectChange(event.target.value)}
              className="rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 outline-none ring-offset-0 transition focus:border-sky-500"
            >
              <option value="__add_new__">+ Add new project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>

          <nav className="flex flex-wrap items-center gap-2" aria-label="Category filters">
            {filterOptions.map((option) => {
              const isActive = option === activeFilter;

              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => setActiveFilter(option)}
                  className={`rounded-md border px-3 py-1.5 text-sm font-semibold transition ${
                    isActive
                      ? "border-sky-500 bg-sky-500/20 text-sky-200"
                      : "border-neutral-700 bg-neutral-800 text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
                  }`}
                >
                  {option}
                </button>
              );
            })}
          </nav>
        </section>

        <section className="mb-8 rounded-xl border border-neutral-800 bg-neutral-900/50 px-4 py-3 text-sm text-neutral-300">
          <p>
            Active project: <span className="font-semibold text-neutral-100">{selectedProjectName}</span>
          </p>
          <p className="mt-1 text-xs text-neutral-400">
            Comparison is a feature for comparing result between 2 projects.
          </p>
        </section>

        <section className="grid grid-cols-1 gap-5 md:grid-cols-3 lg:grid-cols-4 lg:gap-8">
          {filteredComponents.map((component) => {
            const isCausalCard = component.category === "Causal";
            const targetPath = isCausalCard
              ? {
                  pathname: `/${categoryPath[component.category]}`,
                  query: {
                    componentId: component.id,
                    title: component.title,
                    projectId: isProjectScopedComponent(component) ? component.projectId : selectedProjectId,
                  },
                }
              : `/${categoryPath[component.category]}/${component.id}`;

            const metaText = isComparisonComponent(component)
              ? `Compare ${getProjectName(component.leftProjectId)} vs ${getProjectName(component.rightProjectId)}`
              : `Project: ${projects.find((project) => project.id === component.projectId)?.name ?? getProjectName(component.projectId)}`;

            return (
              <Link
                key={component.id}
                href={targetPath}
                className="group overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900/60 shadow-[0_0_0_1px_rgba(255,255,255,0.01)] transition duration-200 hover:scale-[1.02] hover:border-sky-500 hover:shadow-[0_0_0_2px_rgba(14,165,233,0.35)]"
              >
                <FileThumbPlaceholder />

                <div className="flex items-end justify-between gap-3 bg-neutral-900 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FileTypeIcon />
                      <p className="truncate text-sm font-semibold text-neutral-100">{component.title}</p>
                    </div>
                    <p className="mt-1 text-xs text-neutral-400">Edited {component.lastEdited}</p>
                    <p className="mt-1 text-xs text-neutral-500">{metaText}</p>
                  </div>
                </div>
              </Link>
            );
          })}
        </section>
      </main>
    </div>
  );
}
