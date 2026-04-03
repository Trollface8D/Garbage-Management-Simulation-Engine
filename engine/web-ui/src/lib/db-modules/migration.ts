import db from "./connection";
import {
  pruneRecents,
  upsertRecentForMigration,
} from "./recents";
import {
  upsertComponentWithDeletedAt,
  upsertProjectWithDeletedAt,
} from "./projects-components";
import type { LegacyMigrationPayload, MigrationSummary } from "./types";

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

      upsertRecentForMigration(recent, now);
      summary.recents += 1;
    }

    pruneRecents(30);

    return summary;
  });

  return migrateInTransaction(payload);
}
