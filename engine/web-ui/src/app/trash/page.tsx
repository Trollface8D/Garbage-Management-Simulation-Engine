"use client";

import { useEffect, useState } from "react";
import type { DeletedComponent, DeletedProject } from "@/lib/pm-storage";
import {
  loadDeletedComponents,
  loadDeletedProjects,
  permanentlyDeleteComponent,
  permanentlyDeleteProject,
  restoreDeletedComponent,
  restoreDeletedProject,
} from "@/lib/pm-storage";

function SectionTitle({ title }: { title: string }) {
  return <h2 className="text-lg font-semibold text-neutral-100">{title}</h2>;
}

export default function TrashPage() {
  const [deletedProjects, setDeletedProjects] = useState<DeletedProject[]>([]);
  const [deletedComponents, setDeletedComponents] = useState<DeletedComponent[]>([]);

  const refresh = async () => {
    const [projects, components] = await Promise.all([
      loadDeletedProjects(),
      loadDeletedComponents(),
    ]);

    setDeletedProjects(projects);
    setDeletedComponents(components);
  };

  useEffect(() => {
    const loadInitial = async () => {
      const [projects, components] = await Promise.all([
        loadDeletedProjects(),
        loadDeletedComponents(),
      ]);

      setDeletedProjects(projects);
      setDeletedComponents(components);
    };

    void loadInitial();
  }, []);

  return (
    <div className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
      <header className="mb-8">
        <h1 className="text-3xl font-black uppercase tracking-tight text-neutral-100 md:text-5xl">Trash Can</h1>
        <p className="mt-2 text-sm text-neutral-400">Restore items or permanently delete them from this page only.</p>
      </header>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section>
          <SectionTitle title="Deleted Projects" />
          <div className="mt-3 space-y-3">
            {deletedProjects.length === 0 ? (
              <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 text-sm text-neutral-400">No deleted projects.</div>
            ) : (
              deletedProjects.map((entry) => (
                <div
                  key={entry.project.id}
                  className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4"
                >
                  <p className="text-sm font-semibold text-neutral-100">{entry.project.name}</p>
                  <p className="mt-1 text-xs text-neutral-400">
                    Deleted {new Date(entry.deletedAt).toLocaleString()}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void (async () => {
                          await restoreDeletedProject(entry.project.id);
                          await refresh();
                        })();
                      }}
                      className="rounded-md border border-sky-500/70 bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-200"
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!window.confirm("Permanently delete this project? This cannot be undone.")) {
                          return;
                        }

                        void (async () => {
                          await permanentlyDeleteProject(entry.project.id);
                          await refresh();
                        })();
                      }}
                      className="rounded-md border border-red-500/70 bg-red-500/15 px-3 py-1.5 text-xs font-semibold text-red-200"
                    >
                      Permanently Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section>
          <SectionTitle title="Deleted Artifacts" />
          <div className="mt-3 space-y-3">
            {deletedComponents.length === 0 ? (
              <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 text-sm text-neutral-400">No deleted artifacts.</div>
            ) : (
              deletedComponents.map((entry) => (
                <div
                  key={entry.component.id}
                  className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4"
                >
                  <p className="text-sm font-semibold text-neutral-100">{entry.component.title}</p>
                  <p className="mt-1 text-xs text-neutral-400">
                    {entry.component.category} • Deleted {new Date(entry.deletedAt).toLocaleString()}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void (async () => {
                          await restoreDeletedComponent(entry.component.id);
                          await refresh();
                        })();
                      }}
                      className="rounded-md border border-sky-500/70 bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-200"
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!window.confirm("Permanently delete this artifact? This cannot be undone.")) {
                          return;
                        }

                        void (async () => {
                          await permanentlyDeleteComponent(entry.component.id);
                          await refresh();
                        })();
                      }}
                      className="rounded-md border border-red-500/70 bg-red-500/15 px-3 py-1.5 text-xs font-semibold text-red-200"
                    >
                      Permanently Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
