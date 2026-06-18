import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/**
 * Data dir holds the SQLite database (settings, run records, logs).
 * Lives outside the project source tree so Turbopack file-watcher doesn't try
 * to scan SQLite shm/wal files (which can be locked on Windows).
 *
 * Override via CONVEYER_GUILHERME_DATA_DIR environment variable.
 */
export const DATA_DIR =
  process.env.CONVEYER_GUILHERME_DATA_DIR ??
  path.join(os.homedir(), ".conveyer-guilherme");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "guilherme.db"));
// Without WAL: on Windows the .shm file can lock external readers.
db.pragma("journal_mode = DELETE");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS prompts (
    name TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    title TEXT,
    folder_name TEXT,
    status TEXT NOT NULL,
    script TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    output_path TEXT
  );

  CREATE TABLE IF NOT EXISTS run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    -- ISO 8601 with Z so the client renders local time correctly
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    level TEXT NOT NULL,
    stage TEXT,
    message TEXT NOT NULL,
    data_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_run_logs_run ON run_logs(run_id, id);

  CREATE TABLE IF NOT EXISTS search_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS download_cache (
    dedupe_id TEXT PRIMARY KEY,
    source_url TEXT,
    cached_filename TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_download_cache_url ON download_cache(source_url);

  CREATE TABLE IF NOT EXISTS vision_cache (
    key TEXT PRIMARY KEY,
    score REAL NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// Migrations for older DBs. SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT
// EXISTS`, so we attempt and ignore failure when the column already exists.
function tryAddColumn(table: string, columnDecl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDecl}`);
  } catch {
    // column already exists
  }
}

tryAddColumn("runs", "folder_name TEXT");

export default db;
