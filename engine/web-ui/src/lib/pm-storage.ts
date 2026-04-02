import type { SimulationComponent, SimulationProject } from "@/lib/simulation-components";

const PM_API_PATH = "/api/pm";
const LEGACY_PROJECTS_STORAGE_KEY = "pm.projects";
const LEGACY_COMPONENTS_STORAGE_KEY = "pm.components";
const LEGACY_TRASH_PROJECTS_STORAGE_KEY = "pm.trash.projects";
const LEGACY_TRASH_COMPONENTS_STORAGE_KEY = "pm.trash.components";
const LEGACY_RECENTS_STORAGE_KEY = "pm.recents";
const PM_MIGRATION_DONE_KEY = "pm.db.migration.v1";

export type DeletedProject = {
  project: SimulationProject;
  deletedAt: string;
};

export type DeletedComponent = {
  component: SimulationComponent;
  deletedAt: string;
};

export type RecentArtifact = {
  componentId: string;
  title: string;
  category: SimulationComponent["category"];
  projectId?: string;
  href: string;
  openedAt: string;
};

type PMGetResource = "projects" | "components" | "trash-projects" | "trash-components" | "recents";

type PMAction =
  | "create-project"
  | "create-component"
  | "migrate-legacy"
  | "soft-delete-project"
  | "soft-delete-component"
  | "restore-project"
  | "restore-component"
  | "hard-delete-project"
  | "hard-delete-component"
  | "track-recent";

let migrationPromise: Promise<void> | null = null;

function parseStoredJson<T>(rawValue: string | null, fallback: T): T {
  if (!rawValue) {
    return fallback;
  }

  try {
    return JSON.parse(rawValue) as T;
  } catch {
    return fallback;
  }
}

async function pmPostRaw<T>(action: PMAction, payload?: unknown): Promise<T> {
  const response = await fetch(PM_API_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, payload }),
  });

  if (!response.ok) {
    throw new Error(`PM action failed (${String(response.status)}): ${action}`);
  }

  return (await response.json()) as T;
}

function clearLegacyStorage(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(LEGACY_PROJECTS_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_COMPONENTS_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_TRASH_PROJECTS_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_TRASH_COMPONENTS_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_RECENTS_STORAGE_KEY);
}

async function ensureLegacyMigration(): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }

  if (window.localStorage.getItem(PM_MIGRATION_DONE_KEY) === "1") {
    return;
  }

  if (migrationPromise) {
    await migrationPromise;
    return;
  }

  migrationPromise = (async () => {
    const projects = parseStoredJson<SimulationProject[]>(
      window.localStorage.getItem(LEGACY_PROJECTS_STORAGE_KEY),
      [],
    );
    const components = parseStoredJson<SimulationComponent[]>(
      window.localStorage.getItem(LEGACY_COMPONENTS_STORAGE_KEY),
      [],
    );
    const deletedProjects = parseStoredJson<DeletedProject[]>(
      window.localStorage.getItem(LEGACY_TRASH_PROJECTS_STORAGE_KEY),
      [],
    );
    const deletedComponents = parseStoredJson<DeletedComponent[]>(
      window.localStorage.getItem(LEGACY_TRASH_COMPONENTS_STORAGE_KEY),
      [],
    );
    const recents = parseStoredJson<RecentArtifact[]>(
      window.localStorage.getItem(LEGACY_RECENTS_STORAGE_KEY),
      [],
    );

    const hasLegacyData =
      projects.length > 0 ||
      components.length > 0 ||
      deletedProjects.length > 0 ||
      deletedComponents.length > 0 ||
      recents.length > 0;

    if (hasLegacyData) {
      await pmPostRaw("migrate-legacy", {
        projects,
        components,
        deletedProjects,
        deletedComponents,
        recents,
      });
    }

    clearLegacyStorage();
    window.localStorage.setItem(PM_MIGRATION_DONE_KEY, "1");
  })();

  try {
    await migrationPromise;
  } finally {
    migrationPromise = null;
  }
}

async function pmGet<T>(resource: PMGetResource): Promise<T> {
  await ensureLegacyMigration();

  const response = await fetch(`${PM_API_PATH}?resource=${encodeURIComponent(resource)}`, {
    method: "GET",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`PM GET failed (${String(response.status)}): ${resource}`);
  }

  return (await response.json()) as T;
}

async function pmPost<T>(action: PMAction, payload?: unknown): Promise<T> {
  if (action !== "migrate-legacy") {
    await ensureLegacyMigration();
  }

  return pmPostRaw<T>(action, payload);
}

function notifyPMStorageChanged(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new Event("pm-storage-changed"));
}

export async function loadProjects(): Promise<SimulationProject[]> {
  return pmGet<SimulationProject[]>("projects");
}

export async function loadComponents(): Promise<SimulationComponent[]> {
  return pmGet<SimulationComponent[]>("components");
}

export async function createProject(project: SimulationProject): Promise<SimulationProject> {
  const created = await pmPost<SimulationProject>("create-project", project);
  notifyPMStorageChanged();
  return created;
}

export async function createComponent(component: SimulationComponent): Promise<SimulationComponent> {
  const created = await pmPost<SimulationComponent>("create-component", component);
  notifyPMStorageChanged();
  return created;
}

export async function loadDeletedProjects(): Promise<DeletedProject[]> {
  return pmGet<DeletedProject[]>("trash-projects");
}

export async function loadDeletedComponents(): Promise<DeletedComponent[]> {
  return pmGet<DeletedComponent[]>("trash-components");
}

export async function loadRecentArtifacts(): Promise<RecentArtifact[]> {
  return pmGet<RecentArtifact[]>("recents");
}

export async function trackRecentArtifact(item: Omit<RecentArtifact, "openedAt">): Promise<void> {
  await pmPost<RecentArtifact>("track-recent", item);
  notifyPMStorageChanged();
}

export async function softDeleteComponent(componentId: string): Promise<void> {
  await pmPost<{ ok: boolean }>("soft-delete-component", { componentId });
  notifyPMStorageChanged();
}

export async function softDeleteProject(projectId: string): Promise<void> {
  await pmPost<{ ok: boolean }>("soft-delete-project", { projectId });
  notifyPMStorageChanged();
}

export async function restoreDeletedComponent(componentId: string): Promise<void> {
  await pmPost<{ ok: boolean }>("restore-component", { componentId });
  notifyPMStorageChanged();
}

export async function permanentlyDeleteComponent(componentId: string): Promise<void> {
  await pmPost<{ ok: boolean }>("hard-delete-component", { componentId });
  notifyPMStorageChanged();
}

export async function restoreDeletedProject(projectId: string): Promise<void> {
  await pmPost<{ ok: boolean }>("restore-project", { projectId });
  notifyPMStorageChanged();
}

export async function permanentlyDeleteProject(projectId: string): Promise<void> {
  await pmPost<{ ok: boolean }>("hard-delete-project", { projectId });
  notifyPMStorageChanged();
}
