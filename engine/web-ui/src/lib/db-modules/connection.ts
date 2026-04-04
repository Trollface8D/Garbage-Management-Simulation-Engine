import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const dbPath = path.resolve(process.cwd(), "local.db");
const migrationsFolder = path.resolve(process.cwd(), "drizzle");
const journalPath = path.resolve(migrationsFolder, "meta", "_journal.json");

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

let didRunMigrations = false;

function tableExists(tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as { name?: string } | undefined;

  return row?.name === tableName;
}

function getLatestJournalMillis(): number | null {
  try {
    if (!fs.existsSync(journalPath)) {
      return null;
    }

    const journalRaw = fs.readFileSync(journalPath, "utf-8");
    const journal = JSON.parse(journalRaw) as {
      entries?: Array<{ when?: number }>;
    };

    const millis = (journal.entries ?? [])
      .map((entry) => Number(entry.when))
      .filter((value) => Number.isFinite(value));

    if (millis.length === 0) {
      return null;
    }

    return Math.max(...millis);
  } catch {
    return null;
  }
}

function seedMigrationBaselineIfNeeded(): void {
  // If legacy/manual bootstrap already created tables, mark existing migrations as applied.
  const hasDomainTables = tableExists("projects") || tableExists("project_components") || tableExists("causal");

  db.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    );
  `);

  const lastApplied = db
    .prepare("SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1")
    .get() as { created_at?: number } | undefined;

  if (lastApplied || !hasDomainTables) {
    return;
  }

  const latestJournalMillis = getLatestJournalMillis();
  if (!latestJournalMillis) {
    return;
  }

  db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run("baseline", latestJournalMillis);
}

export function bootstrapDatabase(): void {
  if (didRunMigrations) {
    return;
  }

  seedMigrationBaselineIfNeeded();

  const drizzleDb = drizzle(db);
  migrate(drizzleDb, { migrationsFolder });

  didRunMigrations = true;
}

export const databasePath = dbPath;

bootstrapDatabase();

export default db;
