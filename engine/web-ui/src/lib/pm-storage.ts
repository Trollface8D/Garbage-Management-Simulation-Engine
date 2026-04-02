import type { SimulationComponent, SimulationProject } from "@/lib/simulation-components";

const PROJECTS_STORAGE_KEY = "pm.projects";
const COMPONENTS_STORAGE_KEY = "pm.components";
const TRASH_PROJECTS_STORAGE_KEY = "pm.trash.projects";
const TRASH_COMPONENTS_STORAGE_KEY = "pm.trash.components";
const RECENTS_STORAGE_KEY = "pm.recents";

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

function notifyPMStorageChanged(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new Event("pm-storage-changed"));
}

export function loadProjects(): SimulationProject[] {
  if (typeof window === "undefined") {
    return [];
  }

  return parseStoredJson<SimulationProject[]>(window.localStorage.getItem(PROJECTS_STORAGE_KEY), []);
}

export function saveProjects(projects: SimulationProject[]): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  notifyPMStorageChanged();
}

export function loadComponents(): SimulationComponent[] {
  if (typeof window === "undefined") {
    return [];
  }

  return parseStoredJson<SimulationComponent[]>(window.localStorage.getItem(COMPONENTS_STORAGE_KEY), []);
}

export function saveComponents(components: SimulationComponent[]): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(COMPONENTS_STORAGE_KEY, JSON.stringify(components));
  notifyPMStorageChanged();
}

export function loadDeletedProjects(): DeletedProject[] {
  if (typeof window === "undefined") {
    return [];
  }

  return parseStoredJson<DeletedProject[]>(
    window.localStorage.getItem(TRASH_PROJECTS_STORAGE_KEY),
    [],
  );
}

export function saveDeletedProjects(projects: DeletedProject[]): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(TRASH_PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  notifyPMStorageChanged();
}

export function loadDeletedComponents(): DeletedComponent[] {
  if (typeof window === "undefined") {
    return [];
  }

  return parseStoredJson<DeletedComponent[]>(
    window.localStorage.getItem(TRASH_COMPONENTS_STORAGE_KEY),
    [],
  );
}

export function saveDeletedComponents(components: DeletedComponent[]): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(TRASH_COMPONENTS_STORAGE_KEY, JSON.stringify(components));
  notifyPMStorageChanged();
}

export function loadRecentArtifacts(): RecentArtifact[] {
  if (typeof window === "undefined") {
    return [];
  }

  return parseStoredJson<RecentArtifact[]>(window.localStorage.getItem(RECENTS_STORAGE_KEY), []);
}

export function saveRecentArtifacts(items: RecentArtifact[]): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(items));
  notifyPMStorageChanged();
}

export function trackRecentArtifact(item: Omit<RecentArtifact, "openedAt">): void {
  const now = new Date().toISOString();
  const existing = loadRecentArtifacts();
  const next = [
    { ...item, openedAt: now },
    ...existing.filter((recent) => recent.componentId !== item.componentId),
  ].slice(0, 30);

  saveRecentArtifacts(next);
}

export function softDeleteComponent(componentId: string): void {
  const components = loadComponents();
  const target = components.find((component) => component.id === componentId);
  if (!target) {
    return;
  }

  saveComponents(components.filter((component) => component.id !== componentId));

  const deleted = loadDeletedComponents();
  saveDeletedComponents([
    { component: target, deletedAt: new Date().toISOString() },
    ...deleted.filter((entry) => entry.component.id !== componentId),
  ]);
}

export function softDeleteProject(projectId: string): void {
  const projects = loadProjects();
  const components = loadComponents();
  const targetProject = projects.find((project) => project.id === projectId);
  if (!targetProject) {
    return;
  }

  const relatedComponents = components.filter((component) => {
    if (component.category === "Comparison") {
      return component.leftProjectId === projectId || component.rightProjectId === projectId;
    }
    return component.projectId === projectId;
  });

  saveProjects(projects.filter((project) => project.id !== projectId));
  saveComponents(
    components.filter((component) => {
      if (component.category === "Comparison") {
        return component.leftProjectId !== projectId && component.rightProjectId !== projectId;
      }
      return component.projectId !== projectId;
    }),
  );

  const deletedProjects = loadDeletedProjects();
  saveDeletedProjects([
    { project: targetProject, deletedAt: new Date().toISOString() },
    ...deletedProjects.filter((entry) => entry.project.id !== projectId),
  ]);

  const deletedComponents = loadDeletedComponents();
  const deletedComponentIds = new Set(relatedComponents.map((component) => component.id));
  saveDeletedComponents([
    ...relatedComponents.map((component) => ({
      component,
      deletedAt: new Date().toISOString(),
    })),
    ...deletedComponents.filter((entry) => !deletedComponentIds.has(entry.component.id)),
  ]);

  const recents = loadRecentArtifacts();
  saveRecentArtifacts(
    recents.filter((item) => {
      if (!item.projectId) {
        return true;
      }
      return item.projectId !== projectId;
    }),
  );
}

export function restoreDeletedComponent(componentId: string): void {
  const deleted = loadDeletedComponents();
  const target = deleted.find((entry) => entry.component.id === componentId);
  if (!target) {
    return;
  }

  const components = loadComponents();
  if (!components.some((component) => component.id === componentId)) {
    saveComponents([target.component, ...components]);
  }
  saveDeletedComponents(deleted.filter((entry) => entry.component.id !== componentId));
}

export function permanentlyDeleteComponent(componentId: string): void {
  const deleted = loadDeletedComponents();
  saveDeletedComponents(deleted.filter((entry) => entry.component.id !== componentId));

  const recents = loadRecentArtifacts();
  saveRecentArtifacts(recents.filter((item) => item.componentId !== componentId));
}

export function restoreDeletedProject(projectId: string): void {
  const deletedProjects = loadDeletedProjects();
  const targetProject = deletedProjects.find((entry) => entry.project.id === projectId);
  if (!targetProject) {
    return;
  }

  const projects = loadProjects();
  if (!projects.some((project) => project.id === projectId)) {
    saveProjects([targetProject.project, ...projects]);
  }
  saveDeletedProjects(deletedProjects.filter((entry) => entry.project.id !== projectId));

  const deletedComponents = loadDeletedComponents();
  const toRestore = deletedComponents.filter((entry) => {
    const component = entry.component;
    if (component.category === "Comparison") {
      return component.leftProjectId === projectId || component.rightProjectId === projectId;
    }
    return component.projectId === projectId;
  });

  const components = loadComponents();
  const existingIds = new Set(components.map((component) => component.id));
  const restoredComponents = toRestore
    .map((entry) => entry.component)
    .filter((component) => !existingIds.has(component.id));
  if (restoredComponents.length > 0) {
    saveComponents([...restoredComponents, ...components]);
  }

  const restoredIds = new Set(toRestore.map((entry) => entry.component.id));
  saveDeletedComponents(
    deletedComponents.filter((entry) => !restoredIds.has(entry.component.id)),
  );
}

export function permanentlyDeleteProject(projectId: string): void {
  const deletedProjects = loadDeletedProjects();
  saveDeletedProjects(deletedProjects.filter((entry) => entry.project.id !== projectId));

  const deletedComponents = loadDeletedComponents();
  saveDeletedComponents(
    deletedComponents.filter((entry) => {
      const component = entry.component;
      if (component.category === "Comparison") {
        return component.leftProjectId !== projectId && component.rightProjectId !== projectId;
      }
      return component.projectId !== projectId;
    }),
  );

  const recents = loadRecentArtifacts();
  saveRecentArtifacts(
    recents.filter((item) => {
      if (!item.projectId) {
        return true;
      }
      return item.projectId !== projectId;
    }),
  );
}
