import type { Database } from "bun:sqlite";
import { RUN_CLAIM_CAPACITY } from "../worker/claims.ts";

export const PIPELINE_SCHEMA_VERSION = 21;

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


const migration6 = `
ALTER TABLE runs ADD COLUMN generate_keyword_map INTEGER NOT NULL DEFAULT 0
  CHECK (generate_keyword_map IN (0,1));
`;

const migration9 = `
ALTER TABLE runs ADD COLUMN title_override TEXT;
ALTER TABLE runs ADD COLUMN organization_override TEXT;
ALTER TABLE runs ADD COLUMN deleted_at INTEGER;
`;

const migration10 = `
ALTER TABLE runs ADD COLUMN job_url TEXT
  CHECK (job_url IS NULL OR length(job_url) BETWEEN 1 AND 2048);

CREATE TABLE run_application_sessions (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  session_id TEXT NOT NULL UNIQUE CHECK (
    length(session_id) = 36
    AND substr(session_id, 9, 1) = '-'
    AND substr(session_id, 14, 1) = '-'
    AND substr(session_id, 19, 1) = '-'
    AND substr(session_id, 24, 1) = '-'
    AND replace(session_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  resume_revision INTEGER NOT NULL CHECK (resume_revision > 0),
  pdf_sha256 TEXT NOT NULL CHECK (length(pdf_sha256) = 64),
  bridge_state TEXT NOT NULL CHECK (
    bridge_state IN (
      'reserved',
      'starting',
      'running',
      'awaiting_human_navigation',
      'awaiting_origin_approval',
      'awaiting_additional_info',
      'awaiting_human_review',
      'ready_for_human_submit',
      'cancelled',
      'failed',
      'closed',
      'lost'
    )
  ),
  public_snapshot_json TEXT CHECK (
    public_snapshot_json IS NULL OR json_valid(public_snapshot_json)
  ),
  last_upstream_event_id INTEGER CHECK (
    last_upstream_event_id IS NULL OR last_upstream_event_id >= 0
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminal_at INTEGER,
  PRIMARY KEY (run_id, generation),
  FOREIGN KEY (run_id, resume_revision)
    REFERENCES revisions(run_id, revision) ON DELETE RESTRICT,
  CHECK (
    (bridge_state IN ('cancelled','failed','closed','lost') AND terminal_at IS NOT NULL)
    OR
    (bridge_state NOT IN ('cancelled','failed','closed','lost') AND terminal_at IS NULL)
  )
) STRICT;

CREATE INDEX run_application_sessions_latest
  ON run_application_sessions(run_id, generation DESC);

CREATE TRIGGER run_application_sessions_no_delete
BEFORE DELETE ON run_application_sessions
BEGIN
  SELECT RAISE(ABORT, 'application session history cannot be deleted');
END;
`;

const SUBMISSION_UNCERTAIN_WARNING =
  "The application submission could not be verified. Check the headed browser if it is still available, then close this session.";

const migration11ApplicationSessionsTable = `
CREATE TABLE run_application_sessions_pending_migration (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  session_id TEXT NOT NULL UNIQUE CHECK (
    length(session_id) = 36
    AND substr(session_id, 9, 1) = '-'
    AND substr(session_id, 14, 1) = '-'
    AND substr(session_id, 19, 1) = '-'
    AND substr(session_id, 24, 1) = '-'
    AND replace(session_id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  resume_revision INTEGER NOT NULL CHECK (resume_revision > 0),
  pdf_sha256 TEXT NOT NULL CHECK (length(pdf_sha256) = 64),
  bridge_state TEXT NOT NULL CHECK (
    bridge_state IN (
      'reserved',
      'starting',
      'running',
      'awaiting_human_navigation',
      'awaiting_origin_approval',
      'awaiting_additional_info',
      'awaiting_human_review',
      'submitting',
      'submitted',
      'submission_uncertain',
      'cancelled',
      'failed',
      'closed',
      'lost'
    )
  ),
  submission_phase TEXT NOT NULL DEFAULT 'not_attempted' CHECK (
    submission_phase IN ('not_attempted','attempting','submitted','uncertain')
  ),
  submission_attempted_at INTEGER,
  submission_confirmed_at INTEGER,
  public_snapshot_json TEXT CHECK (
    public_snapshot_json IS NULL OR json_valid(public_snapshot_json)
  ),
  last_upstream_event_id INTEGER CHECK (
    last_upstream_event_id IS NULL OR last_upstream_event_id >= 0
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminal_at INTEGER,
  PRIMARY KEY (run_id, generation),
  FOREIGN KEY (run_id, resume_revision)
    REFERENCES revisions(run_id, revision) ON DELETE RESTRICT,
  CHECK (
    (bridge_state IN ('cancelled','failed','closed','lost') AND terminal_at IS NOT NULL)
    OR
    (bridge_state NOT IN ('cancelled','failed','closed','lost') AND terminal_at IS NULL)
  ),
  CHECK (
    (
      submission_phase = 'not_attempted'
      AND submission_attempted_at IS NULL
      AND submission_confirmed_at IS NULL
    )
    OR
    (
      submission_phase = 'attempting'
      AND submission_attempted_at IS NOT NULL
      AND submission_confirmed_at IS NULL
    )
    OR
    (
      submission_phase = 'submitted'
      AND submission_attempted_at IS NOT NULL
      AND submission_confirmed_at IS NOT NULL
    )
    OR
    (
      submission_phase = 'uncertain'
      AND submission_attempted_at IS NOT NULL
      AND submission_confirmed_at IS NULL
    )
  )
) STRICT;
`;

interface LegacyApplicationSessionMigrationRow {
  run_id: string;
  generation: number;
  session_id: string;
  resume_revision: number;
  pdf_sha256: string;
  bridge_state: string;
  public_snapshot_json: string | null;
  last_upstream_event_id: number | null;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

function migratedApplicationSnapshot(
  row: LegacyApplicationSessionMigrationRow,
  now: number,
): { readonly json: string | null; readonly updatedAt: number } {
  if (row.public_snapshot_json === null) {
    return {
      json: null,
      updatedAt: row.bridge_state === "ready_for_human_submit"
        ? Math.max(row.updated_at + 1, now)
        : row.updated_at,
    };
  }
  const parsed = JSON.parse(row.public_snapshot_json) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("application session snapshot is not an object");
  }
  const snapshot = parsed as Record<string, unknown>;
  if (row.bridge_state !== "ready_for_human_submit") {
    return {
      json: JSON.stringify({ ...snapshot, submissionPhase: "not_attempted" }),
      updatedAt: row.updated_at,
    };
  }

  const snapshotUpdatedAt = Number.isSafeInteger(snapshot.updatedAt)
    && (snapshot.updatedAt as number) >= 0
    ? snapshot.updatedAt as number
    : row.updated_at;
  const updatedAt = Math.max(row.updated_at + 1, snapshotUpdatedAt + 1, now);
  const warnings = Array.isArray(snapshot.warnings)
    ? snapshot.warnings.filter(
      (warning): warning is string => typeof warning === "string"
        && warning !== SUBMISSION_UNCERTAIN_WARNING,
    ).slice(0, 99)
    : [];
  return {
    json: JSON.stringify({
      ...snapshot,
      bridgeState: "submission_uncertain",
      harnessState: "submission_uncertain",
      submissionPhase: "uncertain",
      pendingAction: null,
      terminalAt: null,
      error: null,
      updatedAt,
      warnings: [...warnings, SUBMISSION_UNCERTAIN_WARNING],
    }),
    updatedAt,
  };
}

function migrateApplicationSubmissionLedger(db: Database, now: number): void {
  const rows = db.query<LegacyApplicationSessionMigrationRow, []>(
    "SELECT * FROM run_application_sessions ORDER BY run_id, generation",
  ).all();
  db.exec(migration11ApplicationSessionsTable);
  const insert = db.query(`
    INSERT INTO run_application_sessions_pending_migration(
      run_id, generation, session_id, resume_revision, pdf_sha256, bridge_state,
      submission_phase, submission_attempted_at, submission_confirmed_at,
      public_snapshot_json, last_upstream_event_id, created_at, updated_at, terminal_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    const legacyReady = row.bridge_state === "ready_for_human_submit";
    const snapshot = migratedApplicationSnapshot(row, now);
    insert.run(
      row.run_id,
      row.generation,
      row.session_id,
      row.resume_revision,
      row.pdf_sha256,
      legacyReady ? "submission_uncertain" : row.bridge_state,
      legacyReady ? "uncertain" : "not_attempted",
      legacyReady ? row.updated_at : null,
      null,
      snapshot.json,
      row.last_upstream_event_id,
      row.created_at,
      snapshot.updatedAt,
      legacyReady ? null : row.terminal_at,
    );
  }
  db.exec("DROP TABLE run_application_sessions");
  db.exec(
    "ALTER TABLE run_application_sessions_pending_migration RENAME TO run_application_sessions",
  );
  db.exec(`
    CREATE INDEX run_application_sessions_latest
      ON run_application_sessions(run_id, generation DESC);
    CREATE TRIGGER run_application_sessions_no_delete
    BEFORE DELETE ON run_application_sessions
    BEGIN
      SELECT RAISE(ABORT, 'application session history cannot be deleted');
    END;
  `);
  const foreignKeyFailures = db.query<{ table: string }, []>(
    "PRAGMA foreign_key_check",
  ).all();
  if (foreignKeyFailures.length > 0) {
    throw new Error("foreign key integrity check failed after application session migration");
  }
}

const runsTableDeclaration = /^CREATE TABLE\s+(?:"runs"|runs)(?=\s*\()/i;

function replaceRunsTable(db: Database, upgradedRunsSql: string): void {
  const dependentObjects = db.query<{ sql: string }, []>(`
    SELECT sql
    FROM sqlite_schema
    WHERE tbl_name = 'runs'
      AND type IN ('index', 'trigger')
      AND sql IS NOT NULL
    ORDER BY type, name
  `).all();

  db.exec(upgradedRunsSql);
  db.exec("INSERT INTO runs_pending_migration SELECT * FROM runs");
  db.exec("DROP TABLE runs");
  db.exec("ALTER TABLE runs_pending_migration RENAME TO runs");
  for (const object of dependentObjects) db.exec(object.sql);

  const foreignKeyFailures = db.query<{ table: string }, []>("PRAGMA foreign_key_check").all();
  if (foreignKeyFailures.length > 0) throw new Error("foreign key integrity check failed after runs migration");
}

const previousApplicationStatusCheck =
  /CHECK\s*\(\s*application_status\s+IN\s*\(\s*'applied'\s*,\s*'rejected'\s*,\s*'interview'\s*,\s*'accepted'\s*,\s*'failed'\s*\)\s*\)/i;

function migrateApplicationStatusPending(db: Database): void {
  const runsSql = db.query<{ sql: string | null }, []>(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'runs'",
  ).get()?.sql;
  if (!runsSql || !previousApplicationStatusCheck.test(runsSql) || !runsTableDeclaration.test(runsSql)) {
    throw new Error("runs application_status constraint does not match schema version 6");
  }

  const upgradedRunsSql = runsSql
    .replace(runsTableDeclaration, "CREATE TABLE runs_pending_migration")
    .replace(
      previousApplicationStatusCheck,
      "CHECK (application_status IN ('pending','applied','rejected','interview','accepted','failed'))",
    );
  replaceRunsTable(db, upgradedRunsSql);
}

const currentApplicationStatusCheck =
  /CHECK\s*\(\s*application_status\s+IN\s*\(\s*'pending'\s*,\s*'applied'\s*,\s*'rejected'\s*,\s*'interview'\s*,\s*'accepted'\s*,\s*'failed'\s*\)\s*\)/i;
const appliedApplicationStatusDefault =
  /application_status\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'applied'/i;

function migrateApplicationStatusDefaultPending(db: Database): void {
  const runsSql = db.query<{ sql: string | null }, []>(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'runs'",
  ).get()?.sql;
  if (
    !runsSql
    || !currentApplicationStatusCheck.test(runsSql)
    || !appliedApplicationStatusDefault.test(runsSql)
    || !runsTableDeclaration.test(runsSql)
  ) {
    throw new Error("runs application_status default does not match schema version 7");
  }

  const upgradedRunsSql = runsSql
    .replace(runsTableDeclaration, "CREATE TABLE runs_pending_migration")
    .replace(
      appliedApplicationStatusDefault,
      "application_status TEXT NOT NULL DEFAULT 'pending'",
    );
  replaceRunsTable(db, upgradedRunsSql);
}
const migration12 = `
ALTER TABLE run_claim RENAME TO run_claim_v11;

CREATE TABLE run_claim (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND ${RUN_CLAIM_CAPACITY}),
  run_id TEXT UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
  claim_token TEXT UNIQUE,
  expires_at INTEGER,
  CHECK ((run_id IS NULL AND claim_token IS NULL AND expires_at IS NULL) OR
         (run_id IS NOT NULL AND claim_token IS NOT NULL AND expires_at IS NOT NULL))
) STRICT;

WITH RECURSIVE claim_slots(id) AS (
  SELECT 1
  UNION ALL
  SELECT id + 1 FROM claim_slots WHERE id < ${RUN_CLAIM_CAPACITY}
)
INSERT INTO run_claim(id, run_id, claim_token, expires_at)
SELECT
  claim_slots.id,
  CASE WHEN claim_slots.id = 1 THEN run_claim_v11.run_id ELSE NULL END,
  CASE WHEN claim_slots.id = 1 THEN run_claim_v11.claim_token ELSE NULL END,
  CASE WHEN claim_slots.id = 1 THEN run_claim_v11.expires_at ELSE NULL END
FROM claim_slots
LEFT JOIN run_claim_v11 ON run_claim_v11.id = 1;

DROP TABLE run_claim_v11;
`;

function migrateRunClaimCapacity(db: Database): void {
  const existing = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_claim'",
  ).get();
  if (existing) {
    db.exec(migration12);
    return;
  }
  db.exec(`
    CREATE TABLE run_claim (
      id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND ${RUN_CLAIM_CAPACITY}),
      run_id TEXT UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
      claim_token TEXT UNIQUE,
      expires_at INTEGER,
      CHECK ((run_id IS NULL AND claim_token IS NULL AND expires_at IS NULL) OR
             (run_id IS NOT NULL AND claim_token IS NOT NULL AND expires_at IS NOT NULL))
    ) STRICT;

    WITH RECURSIVE claim_slots(id) AS (
      SELECT 1
      UNION ALL
      SELECT id + 1 FROM claim_slots WHERE id < ${RUN_CLAIM_CAPACITY}
    )
    INSERT INTO run_claim(id, run_id, claim_token, expires_at)
    SELECT id, NULL, NULL, NULL FROM claim_slots;
  `);
}

const migration13 = `
ALTER TABLE run_application_sessions
ADD COLUMN automatic_review_ready INTEGER NOT NULL DEFAULT 0
  CHECK (automatic_review_ready IN (0,1));
`;

const migration14 = `
ALTER TABLE runs
ADD COLUMN auto_apply INTEGER NOT NULL DEFAULT 0
  CHECK (auto_apply IN (0,1));
`;

const migration15 = `
ALTER TABLE runs
RENAME COLUMN auto_apply TO auto_submit;

ALTER TABLE runs
ADD COLUMN skip_review INTEGER NOT NULL DEFAULT 0
  CHECK (skip_review IN (0,1));
`;

const migration16 = `
ALTER TABLE run_application_sessions
ADD COLUMN slot_released INTEGER NOT NULL DEFAULT 0
  CHECK (slot_released IN (0,1));

UPDATE run_application_sessions
SET slot_released = 1
WHERE bridge_state IN ('cancelled','failed','closed','lost');

CREATE INDEX run_application_sessions_unreleased_slot
  ON run_application_sessions(slot_released)
  WHERE slot_released = 0;
`;

const migration17 = `
CREATE TABLE discovery_jobs (
  id TEXT PRIMARY KEY,
  catalog_source_id TEXT NOT NULL CHECK (length(catalog_source_id) BETWEEN 1 AND 200),
  catalog_source_item_id TEXT NOT NULL CHECK (length(catalog_source_item_id) BETWEEN 1 AND 500),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  company TEXT NOT NULL CHECK (length(company) BETWEEN 1 AND 500),
  location TEXT CHECK (location IS NULL OR length(location) BETWEEN 1 AND 500),
  role TEXT NOT NULL CHECK (
    role IN (
      'software_engineering',
      'machine_learning',
      'data',
      'security',
      'product',
      'hardware',
      'other'
    )
  ),
  canonical_url TEXT NOT NULL CHECK (length(canonical_url) BETWEEN 1 AND 2048),
  apply_url TEXT NOT NULL CHECK (length(apply_url) BETWEEN 1 AND 2048),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 40 AND 50000),
  posted_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0,1)),
  CHECK (posted_at IS NULL OR posted_at >= 0),
  CHECK (first_seen_at >= 0 AND last_seen_at >= first_seen_at)
) STRICT;

CREATE TABLE discovery_sources (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  kind TEXT NOT NULL CHECK (
    kind IN (
      'simplify',
      'zapply',
      'speedyapply',
      'linkedin',
      'greenhouse',
      'lever',
      'ashby',
      'smartrecruiters',
      'workable',
      'recruitee',
      'personio',
      'workday',
      'job_board'
    )
  ),
  last_sync_at INTEGER,
  last_success_at INTEGER,
  last_sync_status TEXT CHECK (
    last_sync_status IS NULL OR last_sync_status IN ('succeeded','failed')
  ),
  last_error TEXT,
  provenance TEXT
) STRICT;

CREATE TABLE discovery_observations (
  source_id TEXT NOT NULL REFERENCES discovery_sources(id) ON DELETE RESTRICT,
  source_item_id TEXT NOT NULL CHECK (length(source_item_id) BETWEEN 1 AND 500),
  job_id TEXT NOT NULL REFERENCES discovery_jobs(id) ON DELETE RESTRICT,
  source_url TEXT NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2048),
  canonical_url TEXT NOT NULL CHECK (length(canonical_url) BETWEEN 1 AND 2048),
  apply_url TEXT NOT NULL CHECK (length(apply_url) BETWEEN 1 AND 2048),
  requisition_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, source_item_id),
  CHECK (first_seen_at >= 0 AND last_seen_at >= first_seen_at)
) STRICT;

CREATE TABLE discovery_dedupe_keys (
  source_id TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 4096),
  job_id TEXT NOT NULL REFERENCES discovery_jobs(id) ON DELETE RESTRICT,
  PRIMARY KEY (source_id, source_item_id, dedupe_key),
  FOREIGN KEY (source_id, source_item_id)
    REFERENCES discovery_observations(source_id, source_item_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE discovery_run_links (
  job_id TEXT PRIMARY KEY REFERENCES discovery_jobs(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX discovery_jobs_recency
  ON discovery_jobs(closed, coalesce(posted_at, first_seen_at) DESC, id);
CREATE INDEX discovery_jobs_role_recency
  ON discovery_jobs(role, closed, coalesce(posted_at, first_seen_at) DESC, id);
CREATE INDEX discovery_observations_job
  ON discovery_observations(job_id, active, source_id);
CREATE INDEX discovery_dedupe_keys_key
  ON discovery_dedupe_keys(dedupe_key, job_id);
CREATE INDEX discovery_dedupe_keys_job
  ON discovery_dedupe_keys(job_id);
`;

const migration18 = `
CREATE TABLE discovery_sources_v18 (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  kind TEXT NOT NULL CHECK (
    kind IN (
      'simplify',
      'zapply',
      'speedyapply',
      'linkedin',
      'indeed',
      'greenhouse',
      'lever',
      'ashby',
      'smartrecruiters',
      'workable',
      'recruitee',
      'personio',
      'workday',
      'job_board'
    )
  ),
  last_sync_at INTEGER,
  last_success_at INTEGER,
  last_sync_status TEXT CHECK (
    last_sync_status IS NULL OR last_sync_status IN ('succeeded','failed')
  ),
  last_error TEXT,
  provenance TEXT
) STRICT;

INSERT INTO discovery_sources_v18(
  id, name, kind, last_sync_at, last_success_at, last_sync_status, last_error, provenance
)
SELECT
  id, name, kind, last_sync_at, last_success_at, last_sync_status, last_error, provenance
FROM discovery_sources;

DROP TABLE discovery_sources;
ALTER TABLE discovery_sources_v18 RENAME TO discovery_sources;
`;

const migration19 = `
CREATE TABLE recruiting_event_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  school TEXT,
  updated_at INTEGER NOT NULL
) STRICT;

INSERT INTO recruiting_event_preferences(id, school, updated_at)
VALUES (1, NULL, 0);

CREATE TABLE recruiting_event_scrape_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('startup','scheduled','manual')),
  state TEXT NOT NULL CHECK (state IN ('running','completed','partial','failed')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  preferences_json TEXT NOT NULL CHECK (json_valid(preferences_json)),
  source_count INTEGER NOT NULL CHECK (source_count >= 0),
  succeeded_source_count INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_source_count >= 0),
  failed_source_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_source_count >= 0),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  CHECK (
    (state = 'running' AND completed_at IS NULL)
    OR (state <> 'running' AND completed_at IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX recruiting_event_one_running_scrape
  ON recruiting_event_scrape_runs(state)
  WHERE state = 'running';
CREATE INDEX recruiting_event_scrape_runs_started
  ON recruiting_event_scrape_runs(started_at DESC);

CREATE TABLE recruiting_event_source_attempts (
  run_id TEXT NOT NULL REFERENCES recruiting_event_scrape_runs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('succeeded','failed')),
  parser TEXT NOT NULL CHECK (parser IN ('deterministic','llm','none')),
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  issue_code TEXT,
  issue_message TEXT,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, source_id),
  CHECK (
    (state = 'succeeded' AND issue_code IS NULL AND issue_message IS NULL)
    OR (state = 'failed' AND parser = 'none' AND issue_code IS NOT NULL AND issue_message IS NOT NULL)
  )
) STRICT;

CREATE TABLE recruiting_events (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  organizer TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  timezone TEXT,
  location TEXT,
  attendance TEXT NOT NULL CHECK (attendance IN ('virtual','in_person','hybrid','unknown')),
  registration_url TEXT NOT NULL,
  description TEXT,
  eligibility_summary TEXT,
  matched_for_applicant INTEGER NOT NULL CHECK (matched_for_applicant IN (0,1)),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_scrape_run_id TEXT NOT NULL REFERENCES recruiting_event_scrape_runs(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX recruiting_events_upcoming
  ON recruiting_events(start_at, title);

CREATE TABLE recruiting_event_sources (
  event_id TEXT NOT NULL REFERENCES recruiting_events(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, source_id)
) STRICT;
`;

function hasCompleteDiscoverySchema(db: Database): boolean {
  const count = Number(db.query<{ count: number }, []>(`
    SELECT count(*) AS count
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN (
        'discovery_jobs',
        'discovery_sources',
        'discovery_observations',
        'discovery_dedupe_keys',
        'discovery_run_links'
      )
  `).get()?.count ?? 0);
  if (count === 0) return false;
  if (count !== 5) throw new Error("pipeline database has a partial discovery schema");
  return true;
}

function hasCompleteRecruitingEventSchema(db: Database): boolean {
  const count = Number(db.query<{ count: number }, []>(`
    SELECT count(*) AS count
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN (
        'recruiting_event_preferences',
        'recruiting_event_scrape_runs',
        'recruiting_event_source_attempts',
        'recruiting_events',
        'recruiting_event_sources'
      )
  `).get()?.count ?? 0);
  if (count === 0) return false;
  if (count !== 5) throw new Error("pipeline database has a partial recruiting event schema");
  return true;
}


const migration20 = `
ALTER TABLE runs
ADD COLUMN opportunity_kind TEXT NOT NULL DEFAULT 'job'
  CHECK (opportunity_kind IN ('job','hackathon','competition','event'));
`;

function hasOpportunityKindColumn(db: Database): boolean {
  return db.query<{ name: string }, []>("PRAGMA table_info(runs)")
    .all()
    .some(({ name }) => name === "opportunity_kind");
}

const previousLifecycleApplicationStatusCheck =
  /CHECK\s*\(\s*application_status\s+IN\s*\(\s*'pending'\s*,\s*'applied'\s*,\s*'rejected'\s*,\s*'interview'\s*,\s*'accepted'\s*,\s*'failed'\s*\)\s*\)/i;

function migrateApplicationLifecycleStatuses(db: Database): void {
  const runsSql = db.query<{ sql: string | null }, []>(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'runs'",
  ).get()?.sql;
  if (
    !runsSql
    || !previousLifecycleApplicationStatusCheck.test(runsSql)
    || !runsTableDeclaration.test(runsSql)
  ) {
    throw new Error("runs application_status constraint does not match schema version 20");
  }

  const upgradedRunsSql = runsSql
    .replace(runsTableDeclaration, "CREATE TABLE runs_pending_migration")
    .replace(
      previousLifecycleApplicationStatusCheck,
      "CHECK (application_status IN ('pending','did_not_apply','applied','oa_received','oa_completed','rejected','interview','accepted','failed'))",
    );
  replaceRunsTable(db, upgradedRunsSql);
}


export function migratePipelineDatabase(db: Database, now = Date.now()): void {
  const version = Number(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0);
  if (version > PIPELINE_SCHEMA_VERSION) throw new Error(`pipeline database version ${version} is newer than supported ${PIPELINE_SCHEMA_VERSION}`);
  if (version === PIPELINE_SCHEMA_VERSION) return;

  const foreignKeysEnabled =
    Number(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys ?? 0) === 1;
  if (foreignKeysEnabled) db.exec("PRAGMA foreign_keys = OFF");
  try {
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
      if (version < 6) {
        db.exec(migration6);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(6, now);
      }
      if (version < 7) {
        migrateApplicationStatusPending(db);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(7, now);
      }
      if (version < 8) {
        migrateApplicationStatusDefaultPending(db);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(8, now);
      }
      if (version < 9) {
        db.exec(migration9);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(9, now);
      }
      if (version < 10) {
        db.exec(migration10);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(10, now);
      }
      if (version < 11) {
        migrateApplicationSubmissionLedger(db, now);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(11, now);
      }
      if (version < 12) {
        migrateRunClaimCapacity(db);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(12, now);
      }
      if (version < 13) {
        db.exec(migration13);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(13, now);
      }
      if (version < 14) {
        db.exec(migration14);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(14, now);
      }
      if (version < 15) {
        db.exec(migration15);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(15, now);
      }
      if (version < 16) {
        db.exec(migration16);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(16, now);
      }
      if (version < 17) {
        db.exec(migration17);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(17, now);
      }
      if (version < 18) {
        if (!hasCompleteDiscoverySchema(db)) db.exec(migration17);
        db.exec(migration18);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(18, now);
      }
      if (version < 19) {
        if (!hasCompleteRecruitingEventSchema(db)) db.exec(migration19);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(19, now);
      }
      if (version < 20) {
        if (!hasOpportunityKindColumn(db)) db.exec(migration20);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(20, now);
      }
      if (version < 21) {
        migrateApplicationLifecycleStatuses(db);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(21, now);
      }
      db.exec(`PRAGMA user_version = ${PIPELINE_SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    if (foreignKeysEnabled) db.exec("PRAGMA foreign_keys = ON");
  }
}
