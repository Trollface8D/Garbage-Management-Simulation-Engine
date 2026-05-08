import { asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SimulationComponent, SimulationProject } from "@/lib/simulation-components";
import drizzleDb from "./drizzle";
import {
  componentProjectLinks,
  componentTrash,
  projectComponents,
  projects,
  projectTrash,
  recents,
} from "./schema";
import type {
  ComponentProjectLinkRole,
  DeletedComponent,
  DeletedProject,
} from "./types";

type DbCategory = "Causal" | "Map" | "Code" | "Policy_Testing";
type DbRole = "PRIMARY" | "LEFT" | "RIGHT";

function toDbCategory(category: SimulationComponent["category"]): DbCategory {
  return category === "PolicyTesting" ? "Policy_Testing" : category;
}

function fromDbCategory(category: string): SimulationComponent["category"] {
  return category === "Policy_Testing" ? "PolicyTesting" : (category as SimulationComponent["category"]);
}

function toDbRole(role: ComponentProjectLinkRole): DbRole {
  if (role === "left") {
    return "LEFT";
  }
  if (role === "right") {
    return "RIGHT";
  }
  return "PRIMARY";
}

function fromDbRole(role: string): ComponentProjectLinkRole {
  if (role === "LEFT") {
    return "left";
  }
  if (role === "RIGHT") {
    return "right";
  }
  return "primary";
}

function toComponent(
  row: { id: string; title: string; category: string; lastEditedAt: string | null },
  linksByRole: Partial<Record<ComponentProjectLinkRole, string>>,
): SimulationComponent {
  const category = fromDbCategory(row.category);

  if (category === "PolicyTesting") {
    return {
      id: row.id,
      title: row.title,
      category,
      lastEdited: row.lastEditedAt ?? "",
      leftProjectId: linksByRole.left ?? "",
      rightProjectId: linksByRole.right ?? "",
    };
  }

  return {
    id: row.id,
    title: row.title,
    category,
    lastEdited: row.lastEditedAt ?? "",
    projectId: linksByRole.primary ?? "",
  };
}

function listComponentLinksByIds(componentIds: string[]): Map<string, Partial<Record<ComponentProjectLinkRole, string>>> {
  if (componentIds.length === 0) {
    return new Map();
  }

  const rows = drizzleDb
    .select({
      componentId: componentProjectLinks.componentId,
      projectId: componentProjectLinks.projectId,
      role: componentProjectLinks.role,
    })
    .from(componentProjectLinks)
    .where(inArray(componentProjectLinks.componentId, componentIds))
    .all();

  const linksMap = new Map<string, Partial<Record<ComponentProjectLinkRole, string>>>();
  for (const row of rows) {
    const existing = linksMap.get(row.componentId) ?? {};
    existing[fromDbRole(row.role)] = row.projectId;
    linksMap.set(row.componentId, existing);
  }

  return linksMap;
}

function listLinkedComponentIds(projectId: string): string[] {
  const rows = drizzleDb
    .select({ componentId: componentProjectLinks.componentId })
    .from(componentProjectLinks)
    .where(eq(componentProjectLinks.projectId, projectId))
    .all();

  return Array.from(new Set(rows.map((row) => row.componentId)));
}

function upsertComponentProjectLinks(component: SimulationComponent): void {
  const now = new Date().toISOString();

  drizzleDb.delete(componentProjectLinks).where(eq(componentProjectLinks.componentId, component.id)).run();

  if (component.category === "PolicyTesting") {
    const leftProjectId = (component.leftProjectId ?? "").trim();
    const rightProjectId = (component.rightProjectId ?? "").trim();

    if (leftProjectId) {
      drizzleDb
        .insert(componentProjectLinks)
        .values({
          id: `${component.id}:left`,
          componentId: component.id,
          projectId: leftProjectId,
          role: toDbRole("left"),
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: componentProjectLinks.id,
          set: {
            componentId: component.id,
            projectId: leftProjectId,
            role: toDbRole("left"),
            createdAt: now,
          },
        })
        .run();
    }

    if (rightProjectId) {
      drizzleDb
        .insert(componentProjectLinks)
        .values({
          id: `${component.id}:right`,
          componentId: component.id,
          projectId: rightProjectId,
          role: toDbRole("right"),
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: componentProjectLinks.id,
          set: {
            componentId: component.id,
            projectId: rightProjectId,
            role: toDbRole("right"),
            createdAt: now,
          },
        })
        .run();
    }

    return;
  }

  const projectId = (component.projectId ?? "").trim();
  if (!projectId) {
    return;
  }

  drizzleDb
    .insert(componentProjectLinks)
    .values({
      id: `${component.id}:primary`,
      componentId: component.id,
      projectId,
      role: toDbRole("primary"),
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: componentProjectLinks.id,
      set: {
        componentId: component.id,
        projectId,
        role: toDbRole("primary"),
        createdAt: now,
      },
    })
    .run();
}

export function listProjects(includeDeleted = false): SimulationProject[] {
  if (includeDeleted) {
    const rows = drizzleDb
      .select({
        id: projects.id,
        name: projects.name,
      })
      .from(projects)
      .orderBy(asc(projects.id))
      .all();

    return rows.map((row) => ({ id: row.id, name: row.name }));
  }

  const rows = drizzleDb
    .select({
      id: projects.id,
      name: projects.name,
    })
    .from(projects)
    .leftJoin(projectTrash, eq(projectTrash.projectId, projects.id))
    .where(isNull(projectTrash.projectId))
    .orderBy(asc(projects.id))
    .all();

  return rows.map((row) => ({ id: row.id, name: row.name }));
}

export function listDeletedProjects(): DeletedProject[] {
  const rows = drizzleDb
    .select({
      id: projects.id,
      name: projects.name,
      deletedAt: projectTrash.deletedAt,
    })
    .from(projectTrash)
    .innerJoin(projects, eq(projects.id, projectTrash.projectId))
    .orderBy(sql`${projectTrash.deletedAt} DESC`)
    .all();

  return rows.map((row) => ({
    project: { id: row.id, name: row.name },
    deletedAt: row.deletedAt,
  }));
}

export function createProject(project: SimulationProject): SimulationProject {
  const now = new Date().toISOString();

  drizzleDb
    .insert(projects)
    .values({
      id: project.id,
      name: project.name,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: projects.id,
      set: {
        name: project.name,
        updatedAt: now,
      },
    })
    .run();

  drizzleDb.delete(projectTrash).where(eq(projectTrash.projectId, project.id)).run();

  return project;
}

export function softDeleteProject(projectId: string): boolean {
  const trimmedProjectId = projectId.trim();
  if (!trimmedProjectId) {
    return false;
  }

  const now = new Date().toISOString();

  const softDeleted = drizzleDb
    .insert(projectTrash)
    .values({
      projectId: trimmedProjectId,
      deletedAt: now,
    })
    .onConflictDoNothing()
    .run();

  if ((softDeleted.changes ?? 0) === 0) {
    return false;
  }

  const componentIds = listLinkedComponentIds(trimmedProjectId);

  for (const componentId of componentIds) {
    drizzleDb
      .insert(componentTrash)
      .values({ componentId, deletedAt: now })
      .onConflictDoUpdate({
        target: componentTrash.componentId,
        set: { deletedAt: now },
      })
      .run();

    drizzleDb.delete(recents).where(eq(recents.componentId, componentId)).run();
  }

  drizzleDb.delete(recents).where(eq(recents.projectId, trimmedProjectId)).run();

  return true;
}

export function restoreProject(projectId: string): boolean {
  const trimmedProjectId = projectId.trim();
  if (!trimmedProjectId) {
    return false;
  }

  const result = drizzleDb.delete(projectTrash).where(eq(projectTrash.projectId, trimmedProjectId)).run();
  if ((result.changes ?? 0) === 0) {
    return false;
  }

  const componentIds = listLinkedComponentIds(trimmedProjectId);

  for (const componentId of componentIds) {
    const linkedToDeletedProject = drizzleDb
      .select({ count: sql<number>`count(1)` })
      .from(componentProjectLinks)
      .innerJoin(projectTrash, eq(projectTrash.projectId, componentProjectLinks.projectId))
      .where(eq(componentProjectLinks.componentId, componentId))
      .get();

    if ((linkedToDeletedProject?.count ?? 0) === 0) {
      drizzleDb.delete(componentTrash).where(eq(componentTrash.componentId, componentId)).run();
    }
  }

  return true;
}

export function hardDeleteProject(projectId: string): boolean {
  const trimmedProjectId = projectId.trim();
  if (!trimmedProjectId) {
    return false;
  }

  const inTrash = drizzleDb
    .select({ projectId: projectTrash.projectId })
    .from(projectTrash)
    .where(eq(projectTrash.projectId, trimmedProjectId))
    .get();

  if (!inTrash) {
    return false;
  }

  const relatedComponentIds = listLinkedComponentIds(trimmedProjectId);

  const deleted = drizzleDb.delete(projects).where(eq(projects.id, trimmedProjectId)).run();
  if ((deleted.changes ?? 0) === 0) {
    return false;
  }

  drizzleDb.delete(recents).where(eq(recents.projectId, trimmedProjectId)).run();

  for (const componentId of relatedComponentIds) {
    const stillLinked = drizzleDb
      .select({ count: sql<number>`count(1)` })
      .from(componentProjectLinks)
      .where(eq(componentProjectLinks.componentId, componentId))
      .get();

    if ((stillLinked?.count ?? 0) === 0) {
      const isTrashed = drizzleDb
        .select({ componentId: componentTrash.componentId })
        .from(componentTrash)
        .where(eq(componentTrash.componentId, componentId))
        .get();

      if (isTrashed) {
        drizzleDb.delete(projectComponents).where(eq(projectComponents.id, componentId)).run();
        drizzleDb.delete(recents).where(eq(recents.componentId, componentId)).run();
      }
    }
  }

  return true;
}

export function listComponents(includeDeleted = false): SimulationComponent[] {
  const baseRows = includeDeleted
    ? drizzleDb
        .select({
          id: projectComponents.id,
          title: projectComponents.title,
          category: projectComponents.category,
          lastEditedAt: projectComponents.lastEditedAt,
        })
        .from(projectComponents)
        .orderBy(asc(projectComponents.id))
        .all()
    : drizzleDb
        .select({
          id: projectComponents.id,
          title: projectComponents.title,
          category: projectComponents.category,
          lastEditedAt: projectComponents.lastEditedAt,
        })
        .from(projectComponents)
        .leftJoin(componentTrash, eq(componentTrash.componentId, projectComponents.id))
        .where(isNull(componentTrash.componentId))
        .orderBy(asc(projectComponents.id))
        .all();

  const linksMap = listComponentLinksByIds(baseRows.map((row) => row.id));
  return baseRows.map((row) => toComponent(row, linksMap.get(row.id) ?? {}));
}

export function listDeletedComponents(): DeletedComponent[] {
  const rows = drizzleDb
    .select({
      id: projectComponents.id,
      title: projectComponents.title,
      category: projectComponents.category,
      lastEditedAt: projectComponents.lastEditedAt,
      deletedAt: componentTrash.deletedAt,
    })
    .from(componentTrash)
    .innerJoin(projectComponents, eq(projectComponents.id, componentTrash.componentId))
    .orderBy(sql`${componentTrash.deletedAt} DESC`)
    .all();

  const linksMap = listComponentLinksByIds(rows.map((row) => row.id));

  return rows.map((row) => ({
    component: toComponent(
      {
        id: row.id,
        title: row.title,
        category: row.category,
        lastEditedAt: row.lastEditedAt,
      },
      linksMap.get(row.id) ?? {},
    ),
    deletedAt: row.deletedAt,
  }));
}

export function createComponent(component: SimulationComponent): SimulationComponent {
  const now = new Date().toISOString();

  drizzleDb
    .insert(projectComponents)
    .values({
      id: component.id,
      title: component.title,
      category: toDbCategory(component.category),
      lastEditedAt: component.lastEdited,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: projectComponents.id,
      set: {
        title: component.title,
        category: toDbCategory(component.category),
        lastEditedAt: component.lastEdited,
        updatedAt: now,
      },
    })
    .run();

  upsertComponentProjectLinks(component);
  drizzleDb.delete(componentTrash).where(eq(componentTrash.componentId, component.id)).run();

  return component;
}

export function updateComponentTitle(componentId: string, newTitle: string): boolean {
  const id = componentId.trim();
  const title = newTitle.trim();
  if (!id || !title) return false;
  const now = new Date().toISOString();
  const result = drizzleDb
    .update(projectComponents)
    .set({ title, updatedAt: now })
    .where(eq(projectComponents.id, id))
    .run();
  return (result.changes ?? 0) > 0;
}

export function softDeleteComponent(componentId: string): boolean {
  const trimmedComponentId = componentId.trim();
  if (!trimmedComponentId) {
    return false;
  }

  const now = new Date().toISOString();

  const result = drizzleDb
    .insert(componentTrash)
    .values({ componentId: trimmedComponentId, deletedAt: now })
    .onConflictDoNothing()
    .run();

  if ((result.changes ?? 0) === 0) {
    return false;
  }

  drizzleDb.delete(recents).where(eq(recents.componentId, trimmedComponentId)).run();
  return true;
}

export function restoreComponent(componentId: string): boolean {
  const trimmedComponentId = componentId.trim();
  if (!trimmedComponentId) {
    return false;
  }

  const result = drizzleDb.delete(componentTrash).where(eq(componentTrash.componentId, trimmedComponentId)).run();

  return (result.changes ?? 0) > 0;
}

export function hardDeleteComponent(componentId: string): boolean {
  const trimmedComponentId = componentId.trim();
  if (!trimmedComponentId) {
    return false;
  }

  const inTrash = drizzleDb
    .select({ componentId: componentTrash.componentId })
    .from(componentTrash)
    .where(eq(componentTrash.componentId, trimmedComponentId))
    .get();

  if (!inTrash) {
    return false;
  }

  const result = drizzleDb.delete(projectComponents).where(eq(projectComponents.id, trimmedComponentId)).run();

  if ((result.changes ?? 0) > 0) {
    drizzleDb.delete(recents).where(eq(recents.componentId, trimmedComponentId)).run();
    return true;
  }

  return false;
}

export function upsertProjectWithDeletedAt(project: SimulationProject, deletedAt: string | null): void {
  createProject(project);

  if (deletedAt) {
    drizzleDb
      .insert(projectTrash)
      .values({ projectId: project.id, deletedAt })
      .onConflictDoUpdate({
        target: projectTrash.projectId,
        set: { deletedAt },
      })
      .run();
  }
}

export function upsertComponentWithDeletedAt(component: SimulationComponent, deletedAt: string | null): void {
  createComponent(component);

  if (deletedAt) {
    drizzleDb
      .insert(componentTrash)
      .values({ componentId: component.id, deletedAt })
      .onConflictDoUpdate({
        target: componentTrash.componentId,
        set: { deletedAt },
      })
      .run();
  }
}
