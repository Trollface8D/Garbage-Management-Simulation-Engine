#!/usr/bin/env node

/* eslint-disable @typescript-eslint/no-require-imports */

const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.resolve(process.cwd(), "local.db");
const db = new Database(dbPath);

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
    CHECK (category IN ('Causal', 'Map', 'Code', 'PolicyTesting'))
  );

  CREATE TABLE IF NOT EXISTS recents (
    component_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    project_id TEXT,
    href TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    CHECK (category IN ('Causal', 'Map', 'Code', 'PolicyTesting'))
  );
`);

function nowIso() {
  return new Date().toISOString();
}

function printUsage() {
  console.log("PM CLI usage:");
  console.log("  node scripts/pm-crud.js projects:list");
  console.log("  node scripts/pm-crud.js projects:create <id> <name>");
  console.log("  node scripts/pm-crud.js projects:soft-delete <projectId>");
  console.log("  node scripts/pm-crud.js projects:restore <projectId>");
  console.log("  node scripts/pm-crud.js projects:hard-delete <projectId>");
  console.log("  node scripts/pm-crud.js components:list");
  console.log("  node scripts/pm-crud.js components:create <id> <title> <category> <projectId>");
  console.log("  node scripts/pm-crud.js components:soft-delete <componentId>");
  console.log("  node scripts/pm-crud.js components:restore <componentId>");
  console.log("  node scripts/pm-crud.js components:hard-delete <componentId>");
  console.log("  node scripts/pm-crud.js recents:list");
}

function listProjects() {
  const rows = db
    .prepare("SELECT id, name, deleted_at FROM projects ORDER BY id")
    .all();
  console.table(rows);
}

function createProject(id, name) {
  db.prepare(
    `INSERT INTO projects (id, name, deleted_at)
     VALUES (?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       deleted_at = NULL`,
  ).run(id, name);
  console.log(`Upserted project ${id}`);
}

function softDeleteProject(projectId) {
  const deletedAt = nowIso();
  db.prepare("UPDATE projects SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(deletedAt, projectId);
  db.prepare(
    `UPDATE components
     SET deleted_at = ?
     WHERE deleted_at IS NULL
       AND (project_id = ? OR left_project_id = ? OR right_project_id = ?)`,
  ).run(deletedAt, projectId, projectId, projectId);
  db.prepare("DELETE FROM recents WHERE project_id = ?").run(projectId);
  console.log(`Soft deleted project ${projectId}`);
}

function restoreProject(projectId) {
  db.prepare("UPDATE projects SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL").run(projectId);
  db.prepare(
    `UPDATE components
     SET deleted_at = NULL
     WHERE deleted_at IS NOT NULL
       AND (project_id = ? OR left_project_id = ? OR right_project_id = ?)`,
  ).run(projectId, projectId, projectId);
  console.log(`Restored project ${projectId}`);
}

function hardDeleteProject(projectId) {
  db.prepare("DELETE FROM projects WHERE id = ? AND deleted_at IS NOT NULL").run(projectId);
  db.prepare(
    `DELETE FROM components
     WHERE deleted_at IS NOT NULL
       AND (project_id = ? OR left_project_id = ? OR right_project_id = ?)`,
  ).run(projectId, projectId, projectId);
  db.prepare("DELETE FROM recents WHERE project_id = ?").run(projectId);
  console.log(`Hard deleted project ${projectId}`);
}

function listComponents() {
  const rows = db
    .prepare(
      `SELECT id, title, category, last_edited, project_id, left_project_id, right_project_id, deleted_at
       FROM components
       ORDER BY id`,
    )
    .all();
  console.table(rows);
}

function createComponent(id, title, category, projectId) {
  if (!["Causal", "Map", "Code", "PolicyTesting"].includes(category)) {
    throw new Error("Category must be one of: Causal, Map, Code, PolicyTesting");
  }

  const lastEdited = "just now";

  if (category === "PolicyTesting") {
    const leftProjectId = projectId;
    const rightProjectId = process.argv[7] || "";
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
    ).run(id, title, category, lastEdited, leftProjectId, rightProjectId);
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
    ).run(id, title, category, lastEdited, projectId || "");
  }

  console.log(`Upserted component ${id}`);
}

function softDeleteComponent(componentId) {
  db.prepare("UPDATE components SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(nowIso(), componentId);
  db.prepare("DELETE FROM recents WHERE component_id = ?").run(componentId);
  console.log(`Soft deleted component ${componentId}`);
}

function restoreComponent(componentId) {
  db.prepare("UPDATE components SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL").run(componentId);
  console.log(`Restored component ${componentId}`);
}

function hardDeleteComponent(componentId) {
  db.prepare("DELETE FROM components WHERE id = ? AND deleted_at IS NOT NULL").run(componentId);
  db.prepare("DELETE FROM recents WHERE component_id = ?").run(componentId);
  console.log(`Hard deleted component ${componentId}`);
}

function listRecents() {
  const rows = db
    .prepare("SELECT component_id, title, category, project_id, href, opened_at FROM recents ORDER BY opened_at DESC")
    .all();
  console.table(rows);
}

function main() {
  const command = process.argv[2];

  if (!command) {
    printUsage();
    process.exit(1);
  }

  try {
    switch (command) {
      case "projects:list":
        listProjects();
        break;
      case "projects:create":
        createProject(process.argv[3], process.argv.slice(4).join(" "));
        break;
      case "projects:soft-delete":
        softDeleteProject(process.argv[3]);
        break;
      case "projects:restore":
        restoreProject(process.argv[3]);
        break;
      case "projects:hard-delete":
        hardDeleteProject(process.argv[3]);
        break;
      case "components:list":
        listComponents();
        break;
      case "components:create":
        createComponent(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
        break;
      case "components:soft-delete":
        softDeleteComponent(process.argv[3]);
        break;
      case "components:restore":
        restoreComponent(process.argv[3]);
        break;
      case "components:hard-delete":
        hardDeleteComponent(process.argv[3]);
        break;
      case "recents:list":
        listRecents();
        break;
      default:
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
