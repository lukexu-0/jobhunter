import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DEFAULT_CONTEXT_DATABASE_PATH = resolve(import.meta.dir, "../../data/context/context.sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS context_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS source_versions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('baseline', 'authoritative-markdown')),
  entity_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  baseline_entity_ids_json TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  indexed_at INTEGER NOT NULL,
  UNIQUE(source_id, sha256)
) STRICT;
CREATE TABLE IF NOT EXISTS evidence_blocks (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id),
  source_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  heading_path_json TEXT NOT NULL,
  text TEXT NOT NULL,
  caveats_json TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  UNIQUE(source_version_id, ordinal)
) STRICT;
CREATE TABLE IF NOT EXISTS source_heads (
  source_id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id)
) STRICT;
CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
  evidence_id UNINDEXED,
  source_id UNINDEXED,
  entity_id UNINDEXED,
  heading_path,
  text,
  caveats,
  tokenize = 'unicode61'
);
CREATE TRIGGER IF NOT EXISTS source_versions_no_update
BEFORE UPDATE ON source_versions BEGIN SELECT RAISE(ABORT, 'source_versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS source_versions_no_delete
BEFORE DELETE ON source_versions BEGIN SELECT RAISE(ABORT, 'source_versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS evidence_blocks_no_update
BEFORE UPDATE ON evidence_blocks BEGIN SELECT RAISE(ABORT, 'evidence_blocks are immutable'); END;
CREATE TRIGGER IF NOT EXISTS evidence_blocks_no_delete
BEFORE DELETE ON evidence_blocks BEGIN SELECT RAISE(ABORT, 'evidence_blocks are immutable'); END;
`;

export function openContextDatabase(path = DEFAULT_CONTEXT_DATABASE_PATH): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path, { create: true, strict: true });
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(SCHEMA);
  if (path !== ":memory:") {
    chmodSync(dirname(path), 0o700);
    chmodSync(path, 0o600);
  }
  return database;
}
