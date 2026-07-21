import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migratePipelineDatabase } from "../src/db/migrations.ts";

const databases: Database[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function versionOneDatabase(options: { readonly includesApplicationStatus?: boolean } = {}): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY${options.includesApplicationStatus ? ",\n      application_status TEXT NOT NULL DEFAULT 'applied'" : ""}
    ) STRICT;
    INSERT INTO runs(id) VALUES ('run-1');
    INSERT INTO schema_migrations(version, applied_at) VALUES (1, 1000);
    PRAGMA user_version = 1;
  `);
  return db;
}

function versionTwoDatabase(options: { readonly includesRetentionTable?: boolean } = {}): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      application_status TEXT NOT NULL DEFAULT 'applied'
        CHECK (application_status IN ('applied','rejected','interview','accepted','failed'))
    ) STRICT;
    CREATE TABLE attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE run_source_snapshots (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
      manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
      baseline_sha256 TEXT NOT NULL CHECK (length(baseline_sha256) = 64),
      source_hashes_json TEXT NOT NULL CHECK (json_valid(source_hashes_json)),
      created_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO runs(id) VALUES ('run-1');
    INSERT INTO attempts(id, run_id) VALUES ('attempt-1', 'run-1');
    INSERT INTO events(id, run_id) VALUES (1, 'run-1');
    INSERT INTO artifacts(id, run_id) VALUES ('artifact-1', 'run-1');
    INSERT INTO run_source_snapshots(run_id, manifest_sha256, baseline_sha256, source_hashes_json, created_at)
    VALUES ('run-1', '${"1".repeat(64)}', '${"2".repeat(64)}', '{"source":"${"3".repeat(64)}"}', 1000);
    INSERT INTO schema_migrations(version, applied_at) VALUES (1, 1000), (2, 1500);
    PRAGMA user_version = 2;
  `);
  if (options.includesRetentionTable) {
    db.exec("CREATE TABLE run_artifact_retention (run_id TEXT PRIMARY KEY) STRICT");
  }
  return db;
}

function versionSixDatabase(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      job_description TEXT NOT NULL,
      status TEXT NOT NULL,
      current_revision INTEGER NOT NULL DEFAULT 1,
      failed_stage TEXT,
      visual_ack_required INTEGER NOT NULL DEFAULT 0,
      approved_pdf_sha256 TEXT,
      queue_sequence INTEGER NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      application_status TEXT NOT NULL DEFAULT 'applied'
        CHECK (application_status IN ('applied','rejected','interview','accepted','failed')),
      generate_keyword_map INTEGER NOT NULL DEFAULT 0 CHECK (generate_keyword_map IN (0,1))
    ) STRICT;
    CREATE TABLE revisions (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL,
      PRIMARY KEY (run_id, revision)
    ) STRICT;
    CREATE TABLE attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      FOREIGN KEY (run_id, revision) REFERENCES revisions(run_id, revision) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE run_artifact_retention (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
      state TEXT NOT NULL,
      selected_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX runs_fifo ON runs(queue_sequence);
    CREATE INDEX run_artifact_retention_state ON run_artifact_retention(state, selected_at);
    INSERT INTO runs(
      id, job_description, status, queue_sequence, created_at, updated_at,
      application_status, generate_keyword_map
    ) VALUES ('run-6', 'preserved job description', 'review', 9, 1000, 1500, 'interview', 1);
    INSERT INTO revisions(run_id, revision) VALUES ('run-6', 1);
    INSERT INTO attempts(id, run_id, revision) VALUES ('attempt-6', 'run-6', 1);
    INSERT INTO run_artifact_retention(run_id, state, selected_at) VALUES ('run-6', 'pruning', 1750);
    INSERT INTO schema_migrations(version, applied_at)
      VALUES (1, 1000), (2, 1100), (3, 1200), (6, 1300);
    PRAGMA user_version = 6;
  `);
  return db;
}
function versionSevenDatabase(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      application_status TEXT NOT NULL DEFAULT 'applied'
        CHECK (application_status IN ('pending','applied','rejected','interview','accepted','failed'))
    ) STRICT;
    INSERT INTO runs(id) VALUES ('existing-run');
    INSERT INTO schema_migrations(version, applied_at)
      VALUES (1, 1000), (2, 1100), (3, 1200), (6, 1300), (7, 1400);
    PRAGMA user_version = 7;
  `);
  return db;
}




function versionNineDatabase(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      job_description TEXT NOT NULL,
      status TEXT NOT NULL,
      current_revision INTEGER NOT NULL,
      approved_pdf_sha256 TEXT,
      queue_sequence INTEGER NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      application_status TEXT NOT NULL DEFAULT 'pending',
      generate_keyword_map INTEGER NOT NULL DEFAULT 0,
      title_override TEXT,
      organization_override TEXT,
      deleted_at INTEGER
    ) STRICT;
    CREATE TABLE revisions (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL,
      PRIMARY KEY (run_id, revision)
    ) STRICT;
    INSERT INTO runs(
      id, job_description, status, current_revision, approved_pdf_sha256,
      queue_sequence, created_at, updated_at
    ) VALUES (
      'existing-run', 'preserved private description', 'approved', 2,
      '${"a".repeat(64)}', 1, 1000, 1500
    );
    INSERT INTO revisions(run_id, revision) VALUES ('existing-run', 2);
    INSERT INTO schema_migrations(version, applied_at)
      VALUES (1, 1000), (2, 1100), (3, 1200), (6, 1300), (7, 1400), (8, 1500), (9, 1600);
    PRAGMA user_version = 9;
  `);
  return db;
}

test("migration ten preserves version nine runs and creates the durable application ledger", () => {
  const db = versionNineDatabase();

  migratePipelineDatabase(db, 2_000);

  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(10);
  expect(db.query<{ job_url: string | null }, []>(
    "SELECT job_url FROM runs WHERE id = 'existing-run'",
  ).get()).toEqual({ job_url: null });
  expect(db.query<{ version: number; applied_at: number }, []>(
    "SELECT version, applied_at FROM schema_migrations WHERE version = 10",
  ).get()).toEqual({ version: 10, applied_at: 2_000 });
  expect(db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'run_application_sessions_latest'",
  ).get()?.name).toBe("run_application_sessions_latest");

  db.query(`
    INSERT INTO run_application_sessions(
      run_id, generation, session_id, resume_revision, pdf_sha256, bridge_state,
      public_snapshot_json, last_upstream_event_id, created_at, updated_at, terminal_at
    ) VALUES (?, 1, ?, 2, ?, 'reserved', NULL, NULL, 2000, 2000, NULL)
  `).run("existing-run", "11111111-1111-4111-8111-111111111111", "a".repeat(64));

  expect(() => db.query(`
    INSERT INTO run_application_sessions(
      run_id, generation, session_id, resume_revision, pdf_sha256, bridge_state,
      public_snapshot_json, last_upstream_event_id, created_at, updated_at, terminal_at
    ) VALUES (?, 2, ?, 2, ?, 'running', '{}', -1, 2000, 2000, NULL)
  `).run("existing-run", "22222222-2222-4222-8222-222222222222", "a".repeat(64))).toThrow();
  expect(() => db.query(
    "DELETE FROM run_application_sessions WHERE run_id = 'existing-run' AND generation = 1",
  ).run()).toThrow(/history/i);
  expect(db.query<{ table: string }, []>("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("fresh databases default to pending while accepting applied", () => {
  const db = new Database(":memory:");
  databases.push(db);

  migratePipelineDatabase(db, 2_000);
  db.exec(`
    INSERT INTO runs(
      id, job_description, status, application_status, queue_sequence, created_at, updated_at
    ) VALUES ('applied-run', 'applied job description', 'queued', 'applied', 1, 2000, 2000);
    INSERT INTO runs(
      id, job_description, status, queue_sequence, created_at, updated_at
    ) VALUES ('default-run', 'default job description', 'queued', 2, 2000, 2000);
  `);

  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(10);
  expect(db.query<{ application_status: string }, []>(
    "SELECT application_status FROM runs ORDER BY queue_sequence",
  ).all()).toEqual([
    { application_status: "applied" },
    { application_status: "pending" },
  ]);
  expect(db.query<{
    title_override: string | null;
    organization_override: string | null;
    deleted_at: number | null;
  }, []>(
    "SELECT title_override, organization_override, deleted_at FROM runs WHERE id = 'default-run'",
  ).get()).toEqual({
    title_override: null,
    organization_override: null,
    deleted_at: null,
  });
  expect(() => db.query(
    "UPDATE runs SET application_status = 'queued' WHERE id = 'default-run'",
  ).run()).toThrow();
});

test("migrates version seven defaults without changing existing statuses", () => {
  const db = versionSevenDatabase();

  migratePipelineDatabase(db, 2_000);
  db.exec("INSERT INTO runs(id) VALUES ('new-run')");

  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(10);
  expect(db.query<{ version: number }, []>(
    "SELECT version FROM schema_migrations ORDER BY version",
  ).all().map(({ version }) => version)).toEqual([1, 2, 3, 6, 7, 8, 9, 10]);
  expect(db.query<{ id: string; application_status: string }, []>(
    "SELECT id, application_status FROM runs ORDER BY id",
  ).all()).toEqual([
    { id: "existing-run", application_status: "applied" },
    { id: "new-run", application_status: "pending" },
  ]);
});

test("migrates version six runs without breaking data, foreign keys, indexes, or history", () => {
  const db = versionSixDatabase();

  migratePipelineDatabase(db, 2_000);

  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(10);
  expect(db.query<{ version: number; applied_at: number }, []>(
    "SELECT version, applied_at FROM schema_migrations ORDER BY version",
  ).all()).toEqual([
    { version: 1, applied_at: 1000 },
    { version: 2, applied_at: 1100 },
    { version: 3, applied_at: 1200 },
    { version: 6, applied_at: 1300 },
    { version: 7, applied_at: 2000 },
    { version: 8, applied_at: 2000 },
    { version: 9, applied_at: 2000 },
    { version: 10, applied_at: 2000 },
  ]);
  expect(db.query<{
    id: string;
    application_status: string;
    generate_keyword_map: number;
  }, []>(
    "SELECT id, application_status, generate_keyword_map FROM runs",
  ).get()).toEqual({
    id: "run-6",
    application_status: "interview",
    generate_keyword_map: 1,
  });
  expect(db.query<{ id: string }, []>("SELECT id FROM attempts").all()).toEqual([{ id: "attempt-6" }]);
  expect(db.query<{ run_id: string }, []>("SELECT run_id FROM run_artifact_retention").all()).toEqual([
    { run_id: "run-6" },
  ]);
  expect(db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'runs_fifo'",
  ).get()?.name).toBe("runs_fifo");
  expect(db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'run_artifact_retention_state'",
  ).get()?.name).toBe("run_artifact_retention_state");
  expect(db.query<{ table: string }, []>("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);

  db.query("UPDATE runs SET application_status = 'pending' WHERE id = 'run-6'").run();
  expect(db.query<{ application_status: string }, []>(
    "SELECT application_status FROM runs WHERE id = 'run-6'",
  ).get()?.application_status).toBe("pending");
  expect(() => db.query(
    "UPDATE runs SET application_status = 'queued' WHERE id = 'run-6'",
  ).run()).toThrow();
});


test("migrates existing runs to application status applied atomically", () => {
  const migrated = versionOneDatabase();

  migratePipelineDatabase(migrated, 2_000);

  expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(10);
  expect(migrated.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version)).toEqual([1, 2, 3, 6, 7, 8, 9, 10]);
  expect(migrated.query<{
    application_status: string;
    generate_keyword_map: number;
    title_override: string | null;
    organization_override: string | null;
    deleted_at: number | null;
  }, []>(
    "SELECT application_status, generate_keyword_map, title_override, organization_override, deleted_at FROM runs WHERE id = 'run-1'",
  ).get()).toEqual({
    application_status: "applied",
    generate_keyword_map: 0,
    title_override: null,
    organization_override: null,
    deleted_at: null,
  });

  const rolledBack = versionOneDatabase({ includesApplicationStatus: true });

  expect(() => migratePipelineDatabase(rolledBack, 2_000)).toThrow(/duplicate column name: application_status/i);
  expect(rolledBack.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(1);
  expect(rolledBack.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version)).toEqual([1]);
});

test("migrates version two retention state atomically without changing history", () => {
  const migrated = versionTwoDatabase();

  migratePipelineDatabase(migrated, 2_000);

  expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(10);
  expect(migrated.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version)).toEqual([1, 2, 3, 6, 7, 8, 9, 10]);
  expect(migrated.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_artifact_retention'").get()?.name).toBe("run_artifact_retention");
  expect(migrated.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'run_artifact_retention_state'").get()?.name).toBe("run_artifact_retention_state");
  expect(migrated.query<{ id: string }, []>("SELECT id FROM runs").all()).toEqual([{ id: "run-1" }]);
  expect(migrated.query<{ id: string }, []>("SELECT id FROM attempts").all()).toEqual([{ id: "attempt-1" }]);
  expect(migrated.query<{ id: number }, []>("SELECT id FROM events").all()).toEqual([{ id: 1 }]);
  expect(migrated.query<{ id: string }, []>("SELECT id FROM artifacts").all()).toEqual([{ id: "artifact-1" }]);
  expect(migrated.query<{ run_id: string }, []>("SELECT run_id FROM run_source_snapshots").all()).toEqual([{ run_id: "run-1" }]);

  const rolledBack = versionTwoDatabase({ includesRetentionTable: true });

  expect(() => migratePipelineDatabase(rolledBack, 2_000)).toThrow(/run_artifact_retention/i);
  expect(rolledBack.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
  expect(rolledBack.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version)).toEqual([1, 2]);
  expect(rolledBack.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'run_artifact_retention_state'").get()).toBeNull();
  expect(rolledBack.query<{ id: string }, []>("SELECT id FROM runs").all()).toEqual([{ id: "run-1" }]);
});
