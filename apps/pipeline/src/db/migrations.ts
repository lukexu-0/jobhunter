import type { Database } from "bun:sqlite";

export const PIPELINE_SCHEMA_VERSION = 6;

const migration1 = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  job_description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','analyzing','tailoring','editing','compiling','repairing','deterministic_qa','visual_qa','review','approved','failed')),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  failed_stage TEXT CHECK (failed_stage IS NULL OR failed_stage IN ('analyzing','tailoring','editing','compiling','repairing','deterministic_qa','visual_qa')),
  visual_ack_required INTEGER NOT NULL DEFAULT 0 CHECK (visual_ack_required IN (0,1)),
  approved_pdf_sha256 TEXT,
  queue_sequence INTEGER NOT NULL UNIQUE CHECK (queue_sequence > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE revisions (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  origin TEXT NOT NULL CHECK (origin IN ('initial','retry','machine_regenerate','human_edit')),
  source_revision INTEGER,
  retry_stage TEXT CHECK (retry_stage IS NULL OR retry_stage IN ('analyzing','tailoring','editing','compiling','repairing','deterministic_qa','visual_qa')),
  status TEXT NOT NULL CHECK (status IN ('queued','analyzing','tailoring','editing','compiling','repairing','deterministic_qa','visual_qa','review','approved','failed')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, revision),
  FOREIGN KEY (run_id, source_revision) REFERENCES revisions(run_id, revision)
) STRICT;

CREATE TABLE run_source_snapshots (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  baseline_sha256 TEXT NOT NULL CHECK (length(baseline_sha256) = 64),
  source_hashes_json TEXT NOT NULL CHECK (json_valid(source_hashes_json)),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('analyzing','tailoring','editing','compiling','repairing','deterministic_qa','visual_qa')),
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  origin TEXT NOT NULL CHECK (origin IN ('initial','retry','machine_regenerate','human_edit','repair_loop')),
  claim_token TEXT NOT NULL,
  attempt_session_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('running','cancel_requested','cancelled','succeeded','failed')),
  process_pid INTEGER,
  process_start_token TEXT,
  tool_count INTEGER NOT NULL DEFAULT 0 CHECK (tool_count >= 0),
  compile_count INTEGER NOT NULL DEFAULT 0 CHECK (compile_count >= 0),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  cancellation_ack_at INTEGER,
  UNIQUE (run_id, revision, stage, attempt_no),
  FOREIGN KEY (run_id, revision) REFERENCES revisions(run_id, revision) ON DELETE RESTRICT
) STRICT;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  revision INTEGER,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (run_id, revision) REFERENCES revisions(run_id, revision) ON DELETE RESTRICT
) STRICT;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  attempt_id TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL CHECK (stage IN ('input','analyzing','tailoring','editing','compiling','repairing','deterministic_qa','visual_qa','review')),
  kind TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  path TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  source_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, revision, attempt_id, kind),
  UNIQUE (path),
  FOREIGN KEY (run_id, revision) REFERENCES revisions(run_id, revision) ON DELETE RESTRICT
) STRICT;

CREATE TABLE edit_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  target_revision INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('machine_regenerate','human_edit')),
  comments TEXT NOT NULL,
  expected_pdf_sha256 TEXT NOT NULL CHECK (length(expected_pdf_sha256) = 64),
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, target_revision),
  FOREIGN KEY (run_id, source_revision) REFERENCES revisions(run_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (run_id, target_revision) REFERENCES revisions(run_id, revision) ON DELETE RESTRICT
) STRICT;

CREATE TABLE run_claim (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
  claim_token TEXT,
  expires_at INTEGER,
  CHECK ((run_id IS NULL AND claim_token IS NULL AND expires_at IS NULL) OR
         (run_id IS NOT NULL AND claim_token IS NOT NULL AND expires_at IS NOT NULL))
) STRICT;
INSERT INTO run_claim(id, run_id, claim_token, expires_at) VALUES (1, NULL, NULL, NULL);

CREATE INDEX runs_fifo ON runs(queue_sequence);
CREATE INDEX attempts_active ON attempts(run_id, status, started_at);
CREATE INDEX artifacts_lookup ON artifacts(run_id, revision, kind, created_at);
CREATE INDEX events_timeline ON events(run_id, sequence);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER artifacts_no_update BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT, 'artifacts are immutable'); END;
CREATE TRIGGER artifacts_no_delete BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT, 'artifacts are immutable'); END;
CREATE TRIGGER edit_requests_no_update BEFORE UPDATE ON edit_requests BEGIN SELECT RAISE(ABORT, 'edit requests are immutable'); END;
CREATE TRIGGER edit_requests_no_delete BEFORE DELETE ON edit_requests BEGIN SELECT RAISE(ABORT, 'edit requests are immutable'); END;
CREATE TRIGGER run_source_snapshots_no_update BEFORE UPDATE ON run_source_snapshots BEGIN SELECT RAISE(ABORT, 'source snapshots are immutable'); END;
CREATE TRIGGER run_source_snapshots_no_delete BEFORE DELETE ON run_source_snapshots BEGIN SELECT RAISE(ABORT, 'source snapshots are immutable'); END;
`;

const migration2 = `
ALTER TABLE runs ADD COLUMN application_status TEXT NOT NULL DEFAULT 'applied'
  CHECK (application_status IN ('applied','rejected','interview','accepted','failed'));
`;

const migration3 = `
CREATE TABLE run_artifact_retention (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('pruning','pruned')),
  selected_at INTEGER NOT NULL,
  pruned_at INTEGER,
  CHECK ((state = 'pruning' AND pruned_at IS NULL) OR
         (state = 'pruned' AND pruned_at IS NOT NULL))
) STRICT;
CREATE INDEX run_artifact_retention_state ON run_artifact_retention(state, selected_at);
`;

const migration4 = `
ALTER TABLE runs ADD COLUMN must_include TEXT NOT NULL DEFAULT '';
`;

const migration5 = `
ALTER TABLE runs DROP COLUMN must_include;
`;

const migration6 = `
ALTER TABLE runs ADD COLUMN generate_keyword_map INTEGER NOT NULL DEFAULT 0
  CHECK (generate_keyword_map IN (0,1));
`;

export function migratePipelineDatabase(db: Database, now = Date.now()): void {
  const version = Number(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0);
  if (version > PIPELINE_SCHEMA_VERSION) throw new Error(`pipeline database version ${version} is newer than supported ${PIPELINE_SCHEMA_VERSION}`);
  if (version === PIPELINE_SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (version === 0) {
      db.exec(migration1);
      db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, now);
    }
    if (version < 2) {
      db.exec(migration2);
      db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(2, now);
    }
    if (version < 3) {
      db.exec(migration3);
      db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(3, now);
    }
    if (version < 4) {
      db.exec(migration4);
      db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(4, now);
    }
    if (version < 5) {
      db.exec(migration5);
      db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(5, now);
    }
    if (version < 6) {
      db.exec(migration6);
      db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(6, now);
    }
    db.exec(`PRAGMA user_version = ${PIPELINE_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
