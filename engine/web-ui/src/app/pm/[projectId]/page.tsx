"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  categoryPath,
  isPolicyTestingComponent,
  isProjectScopedComponent,
  type Category,
  type SimulationProject,
  type SimulationComponent,
} from "@/lib/simulation-components";
import {
  createComponent,
  loadComponents,
  loadProjects,
  softDeleteComponent,
  trackRecentArtifact,
} from "@/lib/pm-storage";

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

function toArtifactId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "new-artifact";
}

const projectArtifactCategories: Category[] = ["Causal", "Map", "Code", "PolicyTesting"];

function getProjectName(projectId: string, projects: SimulationProject[]): string {
  return projects.find((project) => project.id === projectId)?.name ?? "Unknown project";
}

export default function ProjectDashboardPage() {
  const router = useRouter();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const [projects, setProjects] = useState<SimulationProject[]>([]);
  const [activeFilter, setActiveFilter] = useState<Category>("Causal");
  const [components, setComponents] = useState<SimulationComponent[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      try {
        const [nextProjects, nextComponents] = await Promise.all([
          loadProjects(),
          loadComponents(),
        ]);

        setProjects(nextProjects);
        setComponents(nextComponents);
      } finally {
        setIsLoadingData(false);
      }
    };

    void loadData();
  }, []);

  const project = useMemo(
    () => projects.find((candidateProject) => candidateProject.id === projectId),
    [projectId, projects],
  );

  const filteredComponents = useMemo(() => {
    return components.filter((component) => {
      if (component.category !== activeFilter) {
        return false;
      }

      if (isProjectScopedComponent(component)) {
        return component.projectId === projectId;
      }

      return component.leftProjectId === projectId || component.rightProjectId === projectId;
    });
  }, [activeFilter, components, projectId]);

  if (isLoadingData) {
    return (
      <div className="min-h-screen bg-[var(--surface-0)] text-[var(--text-1)]">
        <main className="mx-auto w-full max-w-4xl px-5 py-12 md:px-8 md:py-16">
          <p className="text-sm text-neutral-400">Loading project dashboard...</p>
        </main>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="min-h-screen bg-[var(--surface-0)] text-[var(--text-1)]">
        <main className="mx-auto w-full max-w-4xl px-5 py-12 md:px-8 md:py-16">
          <p className="text-sm text-neutral-400">
            <Link href="/" className="hover:text-neutral-200">
              Home
            </Link>{" "}
            / PM dashboard
          </p>
          <h1 className="mt-3 text-3xl font-black uppercase tracking-tight text-neutral-100 md:text-5xl">
            Project Not Found
          </h1>
          <p className="mt-4 text-sm text-neutral-300 md:text-base">
            This project does not exist yet. Add it from Home, then open its PM dashboard.
          </p>
        </main>
      </div>
    );
  }

  const handleAddArtifact = async () => {
    const rawTitle = window.prompt("Artifact title");
    if (!rawTitle) {
      return;
    }

    const title = rawTitle.trim();
    if (!title) {
      return;
    }

    const category = activeFilter;

    if (category === "PolicyTesting") {
      window.alert("Create PolicyTesting artifacts from the Policy Testing page.");
      return;
    }

    const existingIds = new Set(components.map((component) => component.id));
    const baseId = toArtifactId(title);
    let createdArtifactId = baseId;
    let suffix = 2;

    while (existingIds.has(createdArtifactId)) {
      createdArtifactId = `${baseId}-${suffix}`;
      suffix += 1;
    }

    const createdComponent: SimulationComponent = {
      id: createdArtifactId,
      title,
      category,
      lastEdited: "just now",
      projectId,
    };

    await createComponent(createdComponent);
    setComponents(await loadComponents());

    if (category === "Causal") {
      const targetHref = `/${categoryPath.Causal}/${encodeURIComponent(createdArtifactId)}`;
      await trackRecentArtifact({
        componentId: createdArtifactId,
        title,
        category: "Causal",
        projectId,
        href: targetHref,
      });
      router.push(targetHref);
      return;
    }

    if (category === "Map") {
      const targetHref = `/${categoryPath.Map}/${encodeURIComponent(createdArtifactId)}`;
      await trackRecentArtifact({
        componentId: createdArtifactId,
        title,
        category: "Map",
        projectId,
        href: targetHref,
      });
      router.push(targetHref);
      return;
    }

    if (category === "Code") {
      const targetHref = `/${categoryPath.Code}/${encodeURIComponent(createdArtifactId)}`;
      await trackRecentArtifact({
        componentId: createdArtifactId,
        title,
        category: "Code",
        projectId,
        href: targetHref,
      });
      router.push(targetHref);
    }
  };

  const handleSoftDeleteArtifact = async (componentId: string) => {
    if (!window.confirm("Move this artifact to Trash Can?")) {
      return;
    }

    await softDeleteComponent(componentId);
    setComponents(await loadComponents());
  };

  return (
    <div className="min-h-screen bg-[var(--surface-0)] text-[var(--text-1)]">
      <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
        <header className="mb-10">
          <p className="text-sm text-neutral-400">
            <Link href="/" className="hover:text-neutral-200">
              Home
            </Link>{" "}
            / PM dashboard
          </p>
          <h1 className="mt-2 text-left text-3xl font-black uppercase tracking-tight text-neutral-100 md:text-5xl lg:text-6xl">
            {project.name}
          </h1>
        </header>

        <section className="mb-8 flex flex-col gap-4 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4 backdrop-blur-sm md:flex-row md:items-center md:justify-between">
          <p className="text-sm text-neutral-300">Project dashboard components</p>

          <nav className="flex flex-wrap items-center gap-2" aria-label="Category filters">
            {projectArtifactCategories.map((option) => {
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
            Active project: <span className="font-semibold text-neutral-100">{project.name}</span>
          </p>
          <p className="mt-1 text-xs text-neutral-400">
            PolicyTesting is a feature for comparing results between two projects.
          </p>
        </section>

        <section className="grid grid-cols-1 gap-5 md:grid-cols-3 lg:grid-cols-4 lg:gap-8">
          <AddCard
            title="Add new artifact"
            subtitle={`Create a ${activeFilter} artifact`}
            onClick={() => void handleAddArtifact()}
          />

          {filteredComponents.map((component) => {
            const isQueryNavigationCategory =
              component.category === "PolicyTesting";
            const targetPath = isQueryNavigationCategory
              ? {
                  pathname: `/${categoryPath[component.category]}`,
                  query: {
                    componentId: component.id,
                    title: component.title,
                    projectId: isProjectScopedComponent(component) ? component.projectId : projectId,
                  },
                }
              : `/${categoryPath[component.category]}/${component.id}`;
            const targetHref = isQueryNavigationCategory
              ? `/${categoryPath[component.category]}?componentId=${encodeURIComponent(component.id)}&title=${encodeURIComponent(component.title)}&projectId=${encodeURIComponent(isProjectScopedComponent(component) ? component.projectId : projectId)}`
              : `/${categoryPath[component.category]}/${component.id}`;

            const metaText = isPolicyTestingComponent(component)
              ? `Compare ${getProjectName(component.leftProjectId, projects)} vs ${getProjectName(component.rightProjectId, projects)}`
              : `Project: ${getProjectName(component.projectId, projects)}`;

            return (
              <Link
                key={component.id}
                href={targetPath}
                onClick={() => {
                  void trackRecentArtifact({
                    componentId: component.id,
                    title: component.title,
                    category: component.category,
                    projectId: isProjectScopedComponent(component)
                      ? component.projectId
                      : projectId,
                    href: targetHref,
                  });
                }}
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

                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void handleSoftDeleteArtifact(component.id);
                    }}
                    className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-red-500/70 hover:text-red-200"
                    aria-label={`Delete ${component.title}`}
                  >
                    Delete
                  </button>
                </div>
              </Link>
            );
          })}
        </section>
      </main>
    </div>
  );
}
