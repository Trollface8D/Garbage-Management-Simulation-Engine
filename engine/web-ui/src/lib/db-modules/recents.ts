import db from "./connection";
import type { RecentArtifact, RecentRow } from "./types";

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

export function upsertRecentForMigration(recent: RecentArtifact, fallbackOpenedAt: string): void {
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
    recent.openedAt || fallbackOpenedAt,
  );
}

export function pruneRecents(maxItems: number): void {
  db.prepare(
    `DELETE FROM recents
     WHERE component_id NOT IN (
       SELECT component_id
       FROM recents
       ORDER BY opened_at DESC
       LIMIT ?
     )`,
  ).run(maxItems);
}
