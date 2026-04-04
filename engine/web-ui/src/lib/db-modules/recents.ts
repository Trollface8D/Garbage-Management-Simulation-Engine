import { desc, sql } from "drizzle-orm";
import drizzleDb from "./drizzle";
import { recents } from "./schema";
import type { RecentArtifact } from "./types";

export function listRecents(): RecentArtifact[] {
  const rows = drizzleDb
    .select()
    .from(recents)
    .orderBy(desc(recents.openedAt))
    .all();

  return rows.map((row) => ({
    componentId: row.componentId,
    title: row.title,
    category: row.category as RecentArtifact["category"],
    projectId: row.projectId ?? undefined,
    href: row.href,
    openedAt: row.openedAt,
  }));
}

export function trackRecent(item: Omit<RecentArtifact, "openedAt">): RecentArtifact {
  const openedAt = new Date().toISOString();

  drizzleDb
    .insert(recents)
    .values({
      componentId: item.componentId,
      title: item.title,
      category: item.category,
      projectId: item.projectId ?? null,
      href: item.href,
      openedAt,
    })
    .onConflictDoUpdate({
      target: recents.componentId,
      set: {
        title: item.title,
        category: item.category,
        projectId: item.projectId ?? null,
        href: item.href,
        openedAt,
      },
    })
    .run();

  pruneRecents(30);

  return {
    ...item,
    openedAt,
  };
}

export function upsertRecentForMigration(recent: RecentArtifact, fallbackOpenedAt: string): void {
  drizzleDb
    .insert(recents)
    .values({
      componentId: recent.componentId,
      title: recent.title,
      category: recent.category,
      projectId: recent.projectId ?? null,
      href: recent.href,
      openedAt: recent.openedAt || fallbackOpenedAt,
    })
    .onConflictDoUpdate({
      target: recents.componentId,
      set: {
        title: recent.title,
        category: recent.category,
        projectId: recent.projectId ?? null,
        href: recent.href,
        openedAt: recent.openedAt || fallbackOpenedAt,
      },
    })
    .run();
}

export function pruneRecents(maxItems: number): void {
  const safeLimit = Math.max(0, Math.floor(maxItems));

  drizzleDb.run(sql`
    DELETE FROM recents
    WHERE component_id NOT IN (
      SELECT component_id
      FROM recents
      ORDER BY opened_at DESC
      LIMIT ${safeLimit}
    )
  `);
}
