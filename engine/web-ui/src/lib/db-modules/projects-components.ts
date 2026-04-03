import type { SimulationComponent, SimulationProject } from "@/lib/simulation-components";
import db from "./connection";
import type {
  ComponentProjectLinkRole,
  ComponentProjectLinkRow,
  ComponentRow,
  DeletedComponent,
  DeletedProject,
  ProjectRow,
} from "./types";

function toComponent(row: ComponentRow, linksByRole: Partial<Record<ComponentProjectLinkRole, string>>): SimulationComponent {
  if (row.category === "PolicyTesting") {
    return {
      id: row.id,
      title: row.title,
      category: "PolicyTesting",
      lastEdited: row.last_edited_at,
      leftProjectId: linksByRole.left ?? "",
      rightProjectId: linksByRole.right ?? "",
    };
  }

  return {
    id: row.id,
    title: row.title,
    category: row.category,
    lastEdited: row.last_edited_at,
    projectId: linksByRole.primary ?? "",
  };
}

function componentWhereClause(includeDeleted: boolean): string {
  return includeDeleted ? "" : "WHERE deleted_at IS NULL";
}

function projectWhereClause(includeDeleted: boolean): string {
  return includeDeleted ? "" : "WHERE deleted_at IS NULL";
}

function listComponentLinksByIds(componentIds: string[]): Map<string, Partial<Record<ComponentProjectLinkRole, string>>> {
  if (componentIds.length === 0) {
    return new Map();
  }

  const placeholders = componentIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, component_id, project_id, role
       FROM component_project_links
       WHERE component_id IN (${placeholders})`,
    )
    .all(...componentIds) as ComponentProjectLinkRow[];

  const linksMap = new Map<string, Partial<Record<ComponentProjectLinkRole, string>>>();
  for (const row of rows) {
    const existing = linksMap.get(row.component_id) ?? {};
    existing[row.role] = row.project_id;
    linksMap.set(row.component_id, existing);
  }

  return linksMap;
}

function upsertComponentProjectLinks(component: SimulationComponent): void {
  db.prepare("DELETE FROM component_project_links WHERE component_id = ?").run(component.id);

  if (component.category === "PolicyTesting") {
    const leftProjectId = (component.leftProjectId ?? "").trim();
    const rightProjectId = (component.rightProjectId ?? "").trim();

    if (leftProjectId) {
      db.prepare(
        `INSERT INTO component_project_links (id, component_id, project_id, role)
         VALUES (?, ?, ?, 'left')`,
      ).run(`${component.id}:left`, component.id, leftProjectId);
    }

    if (rightProjectId) {
      db.prepare(
        `INSERT INTO component_project_links (id, component_id, project_id, role)
         VALUES (?, ?, ?, 'right')`,
      ).run(`${component.id}:right`, component.id, rightProjectId);
    }

    return;
  }

  const projectId = (component.projectId ?? "").trim();
  if (!projectId) {
    return;
  }

  db.prepare(
    `INSERT INTO component_project_links (id, component_id, project_id, role)
     VALUES (?, ?, ?, 'primary')`,
  ).run(`${component.id}:primary`, component.id, projectId);
}

export function listProjects(includeDeleted = false): SimulationProject[] {
  const rows = db
    .prepare(
      `SELECT id, name, created_at, updated_at, deleted_at
       FROM projects
       ${projectWhereClause(includeDeleted)}
       ORDER BY id`,
    )
    .all() as ProjectRow[];

  return rows.map((row) => ({ id: row.id, name: row.name }));
}

export function listDeletedProjects(): DeletedProject[] {
  const rows = db
    .prepare(
      `SELECT id, name, created_at, updated_at, deleted_at
       FROM projects
       WHERE deleted_at IS NOT NULL
       ORDER BY deleted_at DESC`,
    )
    .all() as ProjectRow[];

  return rows.map((row) => ({
    project: { id: row.id, name: row.name },
    deletedAt: row.deleted_at ?? new Date().toISOString(),
  }));
}

export function createProject(project: SimulationProject): SimulationProject {
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO projects (id, name, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       updated_at = excluded.updated_at,
       deleted_at = NULL`,
  ).run(project.id, project.name, now, now);

  return project;
}

export function softDeleteProject(projectId: string): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare("UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
    .run(now, now, projectId);

  if (result.changes === 0) {
    return false;
  }

  db.prepare(
    `UPDATE simulation_components
     SET deleted_at = ?
     WHERE deleted_at IS NULL
       AND id IN (
         SELECT component_id
         FROM component_project_links
         WHERE project_id = ?
       )`,
  )
    .run(now, projectId);

  db.prepare("DELETE FROM recents WHERE project_id = ?").run(projectId);
  return true;
}

export function restoreProject(projectId: string): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare("UPDATE projects SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL")
    .run(now, projectId);

  if (result.changes === 0) {
    return false;
  }

  db.prepare(
    `UPDATE simulation_components
     SET deleted_at = NULL
     WHERE deleted_at IS NOT NULL
       AND id IN (
         SELECT component_id
         FROM component_project_links
         WHERE project_id = ?
       )`,
  ).run(projectId);

  return true;
}

export function hardDeleteProject(projectId: string): boolean {
  const relatedComponentIds = db
    .prepare(
      `SELECT component_id
       FROM component_project_links
       WHERE project_id = ?`,
    )
    .all(projectId) as Array<{ component_id: string }>;

  const result = db
    .prepare("DELETE FROM projects WHERE id = ? AND deleted_at IS NOT NULL")
    .run(projectId);

  if (result.changes === 0) {
    return false;
  }

  for (const { component_id: componentId } of relatedComponentIds) {
    const stillLinked = db
      .prepare(
        `SELECT COUNT(1) AS count
         FROM component_project_links
         WHERE component_id = ?`,
      )
      .get(componentId) as { count: number };

    if (stillLinked.count === 0) {
      db.prepare("DELETE FROM simulation_components WHERE id = ? AND deleted_at IS NOT NULL").run(componentId);
    }
  }

  db.prepare("DELETE FROM recents WHERE project_id = ?").run(projectId);
  return true;
}

export function listComponents(includeDeleted = false): SimulationComponent[] {
  const rows = db
    .prepare(
      `SELECT id, title, category, last_edited_at, deleted_at
       FROM simulation_components
       ${componentWhereClause(includeDeleted)}
       ORDER BY id`,
    )
    .all() as ComponentRow[];

  const linksMap = listComponentLinksByIds(rows.map((row) => row.id));
  return rows.map((row) => toComponent(row, linksMap.get(row.id) ?? {}));
}

export function listDeletedComponents(): DeletedComponent[] {
  const rows = db
    .prepare(
      `SELECT id, title, category, last_edited_at, deleted_at
       FROM simulation_components
       WHERE deleted_at IS NOT NULL
       ORDER BY deleted_at DESC`,
    )
    .all() as ComponentRow[];

  const linksMap = listComponentLinksByIds(rows.map((row) => row.id));

  return rows.map((row) => ({
    component: toComponent(row, linksMap.get(row.id) ?? {}),
    deletedAt: row.deleted_at ?? new Date().toISOString(),
  }));
}

export function createComponent(component: SimulationComponent): SimulationComponent {
  db.prepare(
    `INSERT INTO simulation_components (id, title, category, last_edited_at, deleted_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       category = excluded.category,
       last_edited_at = excluded.last_edited_at,
       deleted_at = NULL`,
  ).run(component.id, component.title, component.category, component.lastEdited);

  upsertComponentProjectLinks(component);

  return component;
}

export function softDeleteComponent(componentId: string): boolean {
  const result = db
    .prepare("UPDATE simulation_components SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
    .run(new Date().toISOString(), componentId);

  if (result.changes > 0) {
    db.prepare("DELETE FROM recents WHERE component_id = ?").run(componentId);
    return true;
  }

  return false;
}

export function restoreComponent(componentId: string): boolean {
  const result = db
    .prepare("UPDATE simulation_components SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL")
    .run(componentId);

  return result.changes > 0;
}

export function hardDeleteComponent(componentId: string): boolean {
  const result = db
    .prepare("DELETE FROM simulation_components WHERE id = ? AND deleted_at IS NOT NULL")
    .run(componentId);

  if (result.changes > 0) {
    db.prepare("DELETE FROM recents WHERE component_id = ?").run(componentId);
    return true;
  }

  return false;
}

export function upsertProjectWithDeletedAt(project: SimulationProject, deletedAt: string | null): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (id, name, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at`,
  ).run(project.id, project.name, now, now, deletedAt);
}

export function upsertComponentWithDeletedAt(component: SimulationComponent, deletedAt: string | null): void {
  const lastEdited = component.lastEdited || "unknown";

  db.prepare(
    `INSERT INTO simulation_components (id, title, category, last_edited_at, deleted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       category = excluded.category,
       last_edited_at = excluded.last_edited_at,
       deleted_at = excluded.deleted_at`,
  ).run(component.id, component.title, component.category, lastEdited, deletedAt);

  upsertComponentProjectLinks(component);
}
