import Database from "better-sqlite3";
import path from "path";
import type { SimulationComponent, SimulationProject } from "@/lib/simulation-components";

type RecentArtifact = {
  componentId: string;
  title: string;
  category: SimulationComponent["category"];
  projectId?: string;
  href: string;
  openedAt: string;
};

type DeletedProject = {
  project: SimulationProject;
  deletedAt: string;
};

type DeletedComponent = {
  component: SimulationComponent;
  deletedAt: string;
};

export type LegacyMigrationPayload = {
  projects: SimulationProject[];
  components: SimulationComponent[];
  deletedProjects: DeletedProject[];
  deletedComponents: DeletedComponent[];
  recents: RecentArtifact[];
};

type MigrationSummary = {
  projects: number;
  components: number;
  deletedProjects: number;
  deletedComponents: number;
  recents: number;
};

type ProjectRow = {
  id: string;
  name: string;
  deleted_at: string | null;
};

type ComponentRow = {
  id: string;
  title: string;
  category: SimulationComponent["category"];
  last_edited: string;
  project_id: string | null;
  left_project_id: string | null;
  right_project_id: string | null;
  deleted_at: string | null;
};

type RecentRow = {
  component_id: string;
  title: string;
  category: SimulationComponent["category"];
  project_id: string | null;
  href: string;
  opened_at: string;
};

const dbPath = path.resolve(process.cwd(), "local.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS components (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    last_edited TEXT NOT NULL,
    project_id TEXT,
    left_project_id TEXT,
    right_project_id TEXT,
    deleted_at TEXT,
    CHECK (category IN ('Causal', 'Map', 'Code', 'Comparison'))
  );

  CREATE TABLE IF NOT EXISTS recents (
    component_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    project_id TEXT,
    href TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    CHECK (category IN ('Causal', 'Map', 'Code', 'Comparison'))
  );

  CREATE INDEX IF NOT EXISTS idx_projects_deleted_at ON projects(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_components_deleted_at ON components(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_recents_opened_at ON recents(opened_at DESC);
`);

function toComponent(row: ComponentRow): SimulationComponent {
  if (row.category === "Comparison") {
    return {
      id: row.id,
      title: row.title,
      category: "Comparison",
      lastEdited: row.last_edited,
      leftProjectId: row.left_project_id ?? "",
      rightProjectId: row.right_project_id ?? "",
    };
  }

  return {
    id: row.id,
    title: row.title,
    category: row.category,
    lastEdited: row.last_edited,
    projectId: row.project_id ?? "",
  };
}

function componentWhereClause(includeDeleted: boolean): string {
  return includeDeleted ? "" : "WHERE deleted_at IS NULL";
}

function projectWhereClause(includeDeleted: boolean): string {
  return includeDeleted ? "" : "WHERE deleted_at IS NULL";
}

export function listProjects(includeDeleted = false): SimulationProject[] {
  const rows = db
    .prepare(
      `SELECT id, name, deleted_at
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
      `SELECT id, name, deleted_at
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
  db.prepare(
    `INSERT INTO projects (id, name, deleted_at)
     VALUES (?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       deleted_at = NULL`,
  ).run(project.id, project.name);

  return project;
}

export function softDeleteProject(projectId: string): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare("UPDATE projects SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
    .run(now, projectId);

  if (result.changes === 0) {
    return false;
  }

  db.prepare(
    `UPDATE components
     SET deleted_at = ?
     WHERE deleted_at IS NULL
       AND (
         project_id = ? OR
         left_project_id = ? OR
         right_project_id = ?
       )`,
  ).run(now, projectId, projectId, projectId);

  db.prepare("DELETE FROM recents WHERE project_id = ?").run(projectId);
  return true;
}

export function restoreProject(projectId: string): boolean {
  const result = db
    .prepare("UPDATE projects SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL")
    .run(projectId);

  if (result.changes === 0) {
    return false;
  }

  db.prepare(
    `UPDATE components
     SET deleted_at = NULL
     WHERE deleted_at IS NOT NULL
       AND (
         project_id = ? OR
         left_project_id = ? OR
         right_project_id = ?
       )`,
  ).run(projectId, projectId, projectId);

  return true;
}

export function hardDeleteProject(projectId: string): boolean {
  const result = db
    .prepare("DELETE FROM projects WHERE id = ? AND deleted_at IS NOT NULL")
    .run(projectId);

  if (result.changes === 0) {
    return false;
  }

  db.prepare(
    `DELETE FROM components
     WHERE deleted_at IS NOT NULL
       AND (
         project_id = ? OR
         left_project_id = ? OR
         right_project_id = ?
       )`,
  ).run(projectId, projectId, projectId);

  db.prepare("DELETE FROM recents WHERE project_id = ?").run(projectId);
  return true;
}

export function listComponents(includeDeleted = false): SimulationComponent[] {
  const rows = db
    .prepare(
      `SELECT id, title, category, last_edited, project_id, left_project_id, right_project_id, deleted_at
       FROM components
       ${componentWhereClause(includeDeleted)}
       ORDER BY id`,
    )
    .all() as ComponentRow[];

  return rows.map(toComponent);
}

export function listDeletedComponents(): DeletedComponent[] {
  const rows = db
    .prepare(
      `SELECT id, title, category, last_edited, project_id, left_project_id, right_project_id, deleted_at
       FROM components
       WHERE deleted_at IS NOT NULL
       ORDER BY deleted_at DESC`,
    )
    .all() as ComponentRow[];

  return rows.map((row) => ({
    component: toComponent(row),
    deletedAt: row.deleted_at ?? new Date().toISOString(),
  }));
}

export function createComponent(component: SimulationComponent): SimulationComponent {
  if (component.category === "Comparison") {
    db.prepare(
      `INSERT INTO components (id, title, category, last_edited, project_id, left_project_id, right_project_id, deleted_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         category = excluded.category,
         last_edited = excluded.last_edited,
         project_id = NULL,
         left_project_id = excluded.left_project_id,
         right_project_id = excluded.right_project_id,
         deleted_at = NULL`,
    ).run(
      component.id,
      component.title,
      component.category,
      component.lastEdited,
      component.leftProjectId,
      component.rightProjectId,
    );
  } else {
    db.prepare(
      `INSERT INTO components (id, title, category, last_edited, project_id, left_project_id, right_project_id, deleted_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         category = excluded.category,
         last_edited = excluded.last_edited,
         project_id = excluded.project_id,
         left_project_id = NULL,
         right_project_id = NULL,
         deleted_at = NULL`,
    ).run(
      component.id,
      component.title,
      component.category,
      component.lastEdited,
      component.projectId,
    );
  }

  return component;
}

export function softDeleteComponent(componentId: string): boolean {
  const result = db
    .prepare("UPDATE components SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
    .run(new Date().toISOString(), componentId);

  if (result.changes > 0) {
    db.prepare("DELETE FROM recents WHERE component_id = ?").run(componentId);
    return true;
  }

  return false;
}

export function restoreComponent(componentId: string): boolean {
  const result = db
    .prepare("UPDATE components SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL")
    .run(componentId);

  return result.changes > 0;
}

export function hardDeleteComponent(componentId: string): boolean {
  const result = db
    .prepare("DELETE FROM components WHERE id = ? AND deleted_at IS NOT NULL")
    .run(componentId);

  if (result.changes > 0) {
    db.prepare("DELETE FROM recents WHERE component_id = ?").run(componentId);
    return true;
  }

  return false;
}

export function listRecents(): RecentArtifact[] {
  const rows = db
    .prepare(
      `SELECT component_id, title, category, project_id, href, opened_at
       FROM recents
       ORDER BY opened_at DESC`,
    )
    .all() as RecentRow[];

  return rows.map((row) => ({
    componentId: row.component_id,
    title: row.title,
    category: row.category,
    projectId: row.project_id ?? undefined,
    href: row.href,
    openedAt: row.opened_at,
  }));
}

export function trackRecent(item: Omit<RecentArtifact, "openedAt">): RecentArtifact {
  const openedAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO recents (component_id, title, category, project_id, href, opened_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(component_id) DO UPDATE SET
       title = excluded.title,
       category = excluded.category,
       project_id = excluded.project_id,
       href = excluded.href,
       opened_at = excluded.opened_at`,
  ).run(item.componentId, item.title, item.category, item.projectId ?? null, item.href, openedAt);

  db.prepare(
    `DELETE FROM recents
     WHERE component_id NOT IN (
       SELECT component_id
       FROM recents
       ORDER BY opened_at DESC
       LIMIT 30
     )`,
  ).run();

  return {
    ...item,
    openedAt,
  };
}

function upsertProjectWithDeletedAt(project: SimulationProject, deletedAt: string | null): void {
  db.prepare(
    `INSERT INTO projects (id, name, deleted_at)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       deleted_at = excluded.deleted_at`,
  ).run(project.id, project.name, deletedAt);
}

function upsertComponentWithDeletedAt(component: SimulationComponent, deletedAt: string | null): void {
  const lastEdited = component.lastEdited || "unknown";

  if (component.category === "Comparison") {
    db.prepare(
      `INSERT INTO components (id, title, category, last_edited, project_id, left_project_id, right_project_id, deleted_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         category = excluded.category,
         last_edited = excluded.last_edited,
         project_id = NULL,
         left_project_id = excluded.left_project_id,
         right_project_id = excluded.right_project_id,
         deleted_at = excluded.deleted_at`,
    ).run(
      component.id,
      component.title,
      component.category,
      lastEdited,
      component.leftProjectId || "",
      component.rightProjectId || "",
      deletedAt,
    );
    return;
  }

  db.prepare(
    `INSERT INTO components (id, title, category, last_edited, project_id, left_project_id, right_project_id, deleted_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       category = excluded.category,
       last_edited = excluded.last_edited,
       project_id = excluded.project_id,
       left_project_id = NULL,
       right_project_id = NULL,
       deleted_at = excluded.deleted_at`,
  ).run(
    component.id,
    component.title,
    component.category,
    lastEdited,
    component.projectId || "",
    deletedAt,
  );
}

export function migrateLegacyData(payload: LegacyMigrationPayload): MigrationSummary {
  const now = new Date().toISOString();

  const migrateInTransaction = db.transaction((input: LegacyMigrationPayload): MigrationSummary => {
    const summary: MigrationSummary = {
      projects: 0,
      components: 0,
      deletedProjects: 0,
      deletedComponents: 0,
      recents: 0,
    };

    for (const project of input.projects) {
      if (!project?.id || !project?.name) {
        continue;
      }
      upsertProjectWithDeletedAt(project, null);
      summary.projects += 1;
    }

    for (const component of input.components) {
      if (!component?.id || !component?.title) {
        continue;
      }
      upsertComponentWithDeletedAt(component, null);
      summary.components += 1;
    }

    for (const entry of input.deletedProjects) {
      const project = entry?.project;
      if (!project?.id || !project?.name) {
        continue;
      }
      upsertProjectWithDeletedAt(project, entry.deletedAt || now);
      summary.deletedProjects += 1;
    }

    for (const entry of input.deletedComponents) {
      const component = entry?.component;
      if (!component?.id || !component?.title) {
        continue;
      }
      upsertComponentWithDeletedAt(component, entry.deletedAt || now);
      summary.deletedComponents += 1;
    }

    for (const recent of input.recents) {
      if (!recent?.componentId || !recent?.title || !recent?.category || !recent?.href) {
        continue;
      }

      db.prepare(
        `INSERT INTO recents (component_id, title, category, project_id, href, opened_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(component_id) DO UPDATE SET
           title = excluded.title,
           category = excluded.category,
           project_id = excluded.project_id,
           href = excluded.href,
           opened_at = excluded.opened_at`,
      ).run(
        recent.componentId,
        recent.title,
        recent.category,
        recent.projectId ?? null,
        recent.href,
        recent.openedAt || now,
      );

      summary.recents += 1;
    }

    db.prepare(
      `DELETE FROM recents
       WHERE component_id NOT IN (
         SELECT component_id
         FROM recents
         ORDER BY opened_at DESC
         LIMIT 30
       )`,
    ).run();

    return summary;
  });

  return migrateInTransaction(payload);
}

export default db;