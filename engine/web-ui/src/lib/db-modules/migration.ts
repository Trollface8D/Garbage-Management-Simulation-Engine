import { pruneRecents, upsertRecentForMigration } from "./recents";
import { upsertComponentWithDeletedAt, upsertProjectWithDeletedAt } from "./projects-components";
import type { LegacyMigrationPayload, MigrationSummary } from "./types";

export type DbmlImportPayload = LegacyMigrationPayload;

export function importDbmlSnapshot(payload: DbmlImportPayload): MigrationSummary {
  const now = new Date().toISOString();

  const summary: MigrationSummary = {
    projects: 0,
    components: 0,
    deletedProjects: 0,
    deletedComponents: 0,
    recents: 0,
  };

  for (const project of payload.projects) {
    if (!project?.id || !project?.name) {
      continue;
    }

    upsertProjectWithDeletedAt(project, null);
    summary.projects += 1;
  }

  for (const component of payload.components) {
    if (!component?.id || !component?.title) {
      continue;
    }

    upsertComponentWithDeletedAt(component, null);
    summary.components += 1;
  }

  for (const entry of payload.deletedProjects) {
    const project = entry?.project;
    if (!project?.id || !project?.name) {
      continue;
    }

    upsertProjectWithDeletedAt(project, entry.deletedAt || now);
    summary.deletedProjects += 1;
  }

  for (const entry of payload.deletedComponents) {
    const component = entry?.component;
    if (!component?.id || !component?.title) {
      continue;
    }

    upsertComponentWithDeletedAt(component, entry.deletedAt || now);
    summary.deletedComponents += 1;
  }

  for (const recent of payload.recents) {
    if (!recent?.componentId || !recent?.title || !recent?.category || !recent?.href) {
      continue;
    }

    upsertRecentForMigration(recent, now);
    summary.recents += 1;
  }

  pruneRecents(30);

  return summary;
}

// Backward-compatible alias for existing API action name.
export function migrateLegacyData(payload: LegacyMigrationPayload): MigrationSummary {
  return importDbmlSnapshot(payload);
}
