import Database from "better-sqlite3";
import path from "path";

const dbPath = path.resolve(process.cwd(), "local.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS simulation_components (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    last_edited_at TEXT NOT NULL,
    deleted_at TEXT,
    CHECK (category IN ('Causal', 'Map', 'Code', 'PolicyTesting'))
  );

  CREATE TABLE IF NOT EXISTS component_project_links (
    id TEXT PRIMARY KEY,
    component_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    role TEXT NOT NULL,
    UNIQUE(component_id, role),
    FOREIGN KEY(component_id) REFERENCES simulation_components(id) ON DELETE CASCADE,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CHECK (role IN ('primary', 'left', 'right'))
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

  CREATE INDEX IF NOT EXISTS idx_projects_deleted_at ON projects(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_simulation_components_deleted_at ON simulation_components(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_component_project_links_component_id ON component_project_links(component_id);
  CREATE INDEX IF NOT EXISTS idx_component_project_links_project_id ON component_project_links(project_id);
  CREATE INDEX IF NOT EXISTS idx_recents_opened_at ON recents(opened_at DESC);

  CREATE TABLE IF NOT EXISTS experiment_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    component_id TEXT NOT NULL,
    label TEXT NOT NULL,
    file_name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    status TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(component_id) REFERENCES simulation_components(id) ON DELETE CASCADE,
    CHECK (source_type IN ('text', 'audio')),
    CHECK (status IN ('raw_text', 'chunked', 'extracted'))
  );

  CREATE INDEX IF NOT EXISTS idx_experiment_items_project_component
    ON experiment_items(project_id, component_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS input_documents (
    id TEXT PRIMARY KEY,
    experiment_item_id TEXT NOT NULL,
    input_mode TEXT NOT NULL,
    source_type TEXT NOT NULL,
    original_file_name TEXT NOT NULL,
    storage_path_or_blob TEXT,
    raw_text TEXT,
    transcript_text TEXT,
    uploaded_at TEXT NOT NULL,
    FOREIGN KEY(experiment_item_id) REFERENCES experiment_items(id) ON DELETE CASCADE,
    CHECK (input_mode IN ('upload', 'manual_text', 'api', 'other')),
    CHECK (source_type IN ('text', 'audio'))
  );

  CREATE INDEX IF NOT EXISTS idx_input_documents_experiment_item
    ON input_documents(experiment_item_id, uploaded_at DESC);

  CREATE TABLE IF NOT EXISTS pipeline_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    component_id TEXT NOT NULL,
    input_document_id TEXT NOT NULL,
    status TEXT NOT NULL,
    model TEXT NOT NULL,
    chunk_size_words INTEGER NOT NULL,
    chunk_overlap_words INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error_message TEXT,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(component_id) REFERENCES simulation_components(id) ON DELETE CASCADE,
    FOREIGN KEY(input_document_id) REFERENCES input_documents(id) ON DELETE CASCADE,
    CHECK (status IN ('queued', 'running', 'completed', 'failed'))
  );

  CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_project_component
    ON pipeline_jobs(project_id, component_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS text_chunks (
    id TEXT PRIMARY KEY,
    pipeline_job_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(pipeline_job_id) REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
    UNIQUE(pipeline_job_id, chunk_index)
  );

  CREATE INDEX IF NOT EXISTS idx_text_chunks_pipeline_job
    ON text_chunks(pipeline_job_id, chunk_index);

  CREATE TABLE IF NOT EXISTS extraction_classes (
    id TEXT PRIMARY KEY,
    pipeline_job_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    pattern_type TEXT,
    sentence_type TEXT,
    marked_type TEXT,
    explicit_type TEXT,
    marker TEXT,
    source_text TEXT,
    FOREIGN KEY(pipeline_job_id) REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
    FOREIGN KEY(chunk_id) REFERENCES text_chunks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS causal_triples (
    id TEXT PRIMARY KEY,
    extraction_class_id TEXT NOT NULL,
    head TEXT NOT NULL,
    relationship TEXT NOT NULL,
    tail TEXT NOT NULL,
    detail TEXT,
    FOREIGN KEY(extraction_class_id) REFERENCES extraction_classes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS follow_up_questions (
    id TEXT PRIMARY KEY,
    causal_triple_id TEXT NOT NULL,
    source_text TEXT,
    sentence_type TEXT,
    question_text TEXT NOT NULL,
    generated_by TEXT,
    generated_at TEXT,
    is_filtered_in INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY(causal_triple_id) REFERENCES causal_triples(id) ON DELETE CASCADE,
    CHECK (is_filtered_in IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS follow_up_answers (
    id TEXT PRIMARY KEY,
    follow_up_question_id TEXT NOT NULL,
    answer_text TEXT NOT NULL,
    answered_by TEXT,
    answered_at TEXT,
    FOREIGN KEY(follow_up_question_id) REFERENCES follow_up_questions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS submission_batches (
    id TEXT PRIMARY KEY,
    pipeline_job_id TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_ref TEXT NOT NULL,
    submitted_count INTEGER NOT NULL,
    status_message TEXT,
    submitted_at TEXT NOT NULL,
    FOREIGN KEY(pipeline_job_id) REFERENCES pipeline_jobs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS pipeline_artifacts (
    id TEXT PRIMARY KEY,
    pipeline_job_id TEXT NOT NULL,
    artifact_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_format TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(pipeline_job_id) REFERENCES pipeline_jobs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS generated_entities (
    id TEXT PRIMARY KEY,
    pipeline_job_id TEXT NOT NULL,
    entity_name TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    FOREIGN KEY(pipeline_job_id) REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
    FOREIGN KEY(artifact_id) REFERENCES pipeline_artifacts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS causal_source_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    component_id TEXT NOT NULL,
    label TEXT NOT NULL,
    file_name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    status TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    text_content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (source_type IN ('text', 'audio')),
    CHECK (status IN ('raw_text', 'chunked', 'extracted'))
  );

  CREATE INDEX IF NOT EXISTS idx_causal_source_items_project_component
    ON causal_source_items(project_id, component_id, updated_at DESC);
`);

function tableExists(tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  return Boolean(row?.name);
}

function columnExists(tableName: string, columnName: string): boolean {
  if (!tableExists(tableName)) {
    return false;
  }

  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  return columns.some((column) => column.name === columnName);
}

function migrateProjectsTableColumns(): void {
  if (!tableExists("projects")) {
    return;
  }

  if (!columnExists("projects", "created_at")) {
    db.exec("ALTER TABLE projects ADD COLUMN created_at TEXT");
    db.exec("UPDATE projects SET created_at = datetime('now') WHERE created_at IS NULL");
  }

  if (!columnExists("projects", "updated_at")) {
    db.exec("ALTER TABLE projects ADD COLUMN updated_at TEXT");
    db.exec("UPDATE projects SET updated_at = datetime('now') WHERE updated_at IS NULL");
  }
}

function migrateLegacyComponents(): void {
  if (!tableExists("components")) {
    return;
  }

  const rows = db
    .prepare(
      `SELECT id, title, category, last_edited, project_id, left_project_id, right_project_id, deleted_at
       FROM components`,
    )
    .all() as Array<{
      id: string;
      title: string;
      category: string;
      last_edited: string;
      project_id: string | null;
      left_project_id: string | null;
      right_project_id: string | null;
      deleted_at: string | null;
    }>;

  const migrateRow = db.transaction((inputRows: typeof rows) => {
    for (const row of inputRows) {
      db.prepare(
        `INSERT INTO simulation_components (id, title, category, last_edited_at, deleted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           category = excluded.category,
           last_edited_at = excluded.last_edited_at,
           deleted_at = excluded.deleted_at`,
      ).run(row.id, row.title, row.category, row.last_edited, row.deleted_at ?? null);

      db.prepare("DELETE FROM component_project_links WHERE component_id = ?").run(row.id);

      if (row.category === "PolicyTesting") {
        if (row.left_project_id) {
          db.prepare(
            `INSERT OR IGNORE INTO component_project_links (id, component_id, project_id, role)
             VALUES (?, ?, ?, 'left')`,
          ).run(`${row.id}:left`, row.id, row.left_project_id);
        }
        if (row.right_project_id) {
          db.prepare(
            `INSERT OR IGNORE INTO component_project_links (id, component_id, project_id, role)
             VALUES (?, ?, ?, 'right')`,
          ).run(`${row.id}:right`, row.id, row.right_project_id);
        }
      } else if (row.project_id) {
        db.prepare(
          `INSERT OR IGNORE INTO component_project_links (id, component_id, project_id, role)
           VALUES (?, ?, ?, 'primary')`,
        ).run(`${row.id}:primary`, row.id, row.project_id);
      }
    }
  });

  migrateRow(rows);
}

function migrateLegacyCausalSourceItems(): void {
  if (!tableExists("causal_source_items")) {
    return;
  }

  const rows = db
    .prepare(
      `SELECT id, project_id, component_id, label, file_name, source_type, status, tags_json, text_content, created_at, updated_at
       FROM causal_source_items`,
    )
    .all() as Array<{
      id: string;
      project_id: string;
      component_id: string;
      label: string;
      file_name: string;
      source_type: string;
      status: string;
      tags_json: string;
      text_content: string;
      created_at: string;
      updated_at: string;
    }>;

  const migrateRow = db.transaction((inputRows: typeof rows) => {
    for (const row of inputRows) {
      db.prepare(
        `INSERT INTO experiment_items (id, project_id, component_id, label, file_name, source_type, status, tags_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           component_id = excluded.component_id,
           label = excluded.label,
           file_name = excluded.file_name,
           source_type = excluded.source_type,
           status = excluded.status,
           tags_json = excluded.tags_json`,
      ).run(
        row.id,
        row.project_id,
        row.component_id,
        row.label,
        row.file_name,
        row.source_type,
        row.status,
        row.tags_json,
        row.created_at || row.updated_at,
      );

      db.prepare(
        `INSERT OR IGNORE INTO input_documents (
          id,
          experiment_item_id,
          input_mode,
          source_type,
          original_file_name,
          storage_path_or_blob,
          raw_text,
          transcript_text,
          uploaded_at
        ) VALUES (?, ?, 'other', ?, ?, NULL, ?, NULL, ?)`,
      ).run(
        `${row.id}:legacy-input`,
        row.id,
        row.source_type,
        row.file_name,
        row.text_content,
        row.updated_at || row.created_at,
      );
    }
  });

  migrateRow(rows);
}

migrateProjectsTableColumns();
migrateLegacyComponents();
migrateLegacyCausalSourceItems();

export default db;
