import type { SimulationComponent, SimulationProject } from "@/lib/simulation-components";

const PM_API_PATH = "/api/pm";
const LEGACY_PROJECTS_STORAGE_KEY = "pm.projects";
const LEGACY_COMPONENTS_STORAGE_KEY = "pm.components";
const LEGACY_TRASH_PROJECTS_STORAGE_KEY = "pm.trash.projects";
const LEGACY_TRASH_COMPONENTS_STORAGE_KEY = "pm.trash.components";
const LEGACY_RECENTS_STORAGE_KEY = "pm.recents";
const PM_MIGRATION_DONE_KEY = "pm.db.migration.v1";
const ENABLE_BROWSER_LEGACY_MIGRATION = true;

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

export type CausalSourceItemStatus = "raw_text" | "chunked" | "extracted";
export type CausalSourceItemSourceType = "text" | "audio";

export type CausalSourceItem = {
  id: string;
  projectId: string;
  componentId: string;
  label: string;
  fileName: string;
  sourceType: CausalSourceItemSourceType;
  status: CausalSourceItemStatus;
  tags: string[];
  textContent: string;
  hasOriginalFile?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CausalSourceItemInput = {
  id: string;
  projectId: string;
  componentId: string;
  label: string;
  fileName: string;
  sourceType: CausalSourceItemSourceType;
  status: CausalSourceItemStatus;
  tags: string[];
  textContent: string;
};

type PMGetResource =
  | "projects"
  | "components"
  | "trash-projects"
  | "trash-components"
  | "recents"
  | "causal-source-items"
  | "causal-source-item"
  | "text-chunks";

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
  | "track-recent"
  | "upsert-causal-source-item"
  | "delete-causal-source-item"
  | "save-text-chunks";

export type SaveTextChunksInput = {
  experimentItemId: string;
  projectId: string;
  componentId: string;
  chunks: string[];
  model?: string;
  chunkSizeWords?: number;
  chunkOverlapWords?: number;
};

export type SaveTextChunksResult = {
  pipelineJobId: string;
  savedChunks: number;
};

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

  if (!ENABLE_BROWSER_LEGACY_MIGRATION) {
    window.localStorage.setItem(PM_MIGRATION_DONE_KEY, "1");
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
      try {
        await pmPostRaw("migrate-legacy", {
          projects,
          components,
          deletedProjects,
          deletedComponents,
          recents,
        });
      } catch {
        // Do not block page usage when best-effort legacy migration fails.
      }
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

export async function loadCausalSourceItems(projectId: string, componentId?: string): Promise<CausalSourceItem[]> {
  await ensureLegacyMigration();

  const url = new URL(PM_API_PATH, window.location.origin);
  url.searchParams.set("resource", "causal-source-items");
  url.searchParams.set("projectId", projectId);
  if (componentId?.trim()) {
    url.searchParams.set("componentId", componentId.trim());
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`PM GET failed (${String(response.status)}): causal-source-items`);
  }

  return (await response.json()) as CausalSourceItem[];
}

export async function loadCausalSourceItem(itemId: string): Promise<CausalSourceItem> {
  await ensureLegacyMigration();

  const url = new URL(PM_API_PATH, window.location.origin);
  url.searchParams.set("resource", "causal-source-item");
  url.searchParams.set("itemId", itemId);

  const response = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`PM GET failed (${String(response.status)}): causal-source-item`);
  }

  return (await response.json()) as CausalSourceItem;
}

export async function loadTextChunksForItem(itemId: string): Promise<string[]> {
  await ensureLegacyMigration();

  const url = new URL(PM_API_PATH, window.location.origin);
  url.searchParams.set("resource", "text-chunks");
  url.searchParams.set("itemId", itemId);

  const response = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`PM GET failed (${String(response.status)}): text-chunks`);
  }

  return (await response.json()) as string[];
}

export async function saveCausalSourceItem(item: CausalSourceItemInput): Promise<CausalSourceItem> {
  const saved = await pmPost<CausalSourceItem>("upsert-causal-source-item", item);
  notifyPMStorageChanged();
  return saved;
}

export async function uploadCausalSourceFile(input: {
  projectId: string;
  componentId: string;
  file: File;
  label?: string;
}): Promise<CausalSourceItem> {
  await ensureLegacyMigration();

  const formData = new FormData();
  formData.set("projectId", input.projectId);
  formData.set("componentId", input.componentId);
  formData.set("label", input.label ?? "file upload");
  formData.set("file", input.file);

  const response = await fetch("/api/causal-source/ingest", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error || `Upload failed with status ${String(response.status)}.`);
  }

  const payload = (await response.json()) as { item: CausalSourceItem };
  notifyPMStorageChanged();
  return payload.item;
}

export async function deleteCausalSourceItem(itemId: string): Promise<void> {
  await pmPost<{ ok: boolean }>("delete-causal-source-item", { itemId });
  notifyPMStorageChanged();
}

export async function saveTextChunksForItem(input: SaveTextChunksInput): Promise<SaveTextChunksResult> {
  const result = await pmPost<SaveTextChunksResult>("save-text-chunks", input);
  notifyPMStorageChanged();
  return result;
}
