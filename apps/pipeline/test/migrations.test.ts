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
      id TEXT PRIMARY KEY
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

function versionFourDatabase(): Database {
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
      status TEXT NOT NULL CHECK (status IN ('queued','failed')),
      current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision > 0),
      failed_stage TEXT,
      visual_ack_required INTEGER NOT NULL DEFAULT 0 CHECK (visual_ack_required IN (0,1)),
      approved_pdf_sha256 TEXT,
      queue_sequence INTEGER NOT NULL UNIQUE CHECK (queue_sequence > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      application_status TEXT NOT NULL DEFAULT 'applied'
        CHECK (application_status IN ('applied','rejected','interview','accepted','failed')),
      must_include TEXT NOT NULL DEFAULT ''
    ) STRICT;
    CREATE TABLE revisions (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL,
      PRIMARY KEY (run_id, revision)
    ) STRICT;
    CREATE INDEX runs_fifo ON runs(queue_sequence);
    INSERT INTO runs(id, job_description, must_include, status, queue_sequence, created_at, updated_at)
    VALUES
      ('run-1', 'First job', 'legacy directive one', 'queued', 1, 1000, 1000),
      ('run-2', 'Second job', 'legacy directive two', 'failed', 2, 1001, 1001);
    INSERT INTO revisions(run_id, revision) VALUES ('run-1', 1);
    INSERT INTO schema_migrations(version, applied_at) VALUES (1, 1000), (2, 1100), (3, 1200), (4, 1300);
    PRAGMA user_version = 4;
  `);
  return db;
}
test("migrates version four runs without the removed directive column or schema regressions", () => {
  const migrated = versionFourDatabase();

  migratePipelineDatabase(migrated, 2_000);

  expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(6);
  expect(migrated.query<{ version: number; applied_at: number }, []>(
    "SELECT version, applied_at FROM schema_migrations ORDER BY version",
  ).all()).toEqual([
    { version: 1, applied_at: 1000 },
    { version: 2, applied_at: 1100 },
    { version: 3, applied_at: 1200 },
    { version: 4, applied_at: 1300 },
    { version: 5, applied_at: 2000 },
    { version: 6, applied_at: 2000 },
  ]);
  expect(migrated.query<{ name: string }, []>("PRAGMA table_info(runs)").all().map(({ name }) => name)).not.toContain("must_include");
  expect(migrated.query<{ generate_keyword_map: number }, []>(
    "SELECT generate_keyword_map FROM runs WHERE id = 'run-1'",
  ).get()).toEqual({ generate_keyword_map: 0 });
  expect(() => migrated.exec("UPDATE runs SET generate_keyword_map = 2 WHERE id = 'run-1'")).toThrow(/check constraint/i);
  expect(migrated.query<{ id: string; job_description: string; status: string; application_status: string }, []>(
    "SELECT id, job_description, status, application_status FROM runs ORDER BY queue_sequence",
  ).all()).toEqual([
    { id: "run-1", job_description: "First job", status: "queued", application_status: "applied" },
    { id: "run-2", job_description: "Second job", status: "failed", application_status: "applied" },
  ]);
  expect(migrated.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'runs_fifo'",
  ).get()?.name).toBe("runs_fifo");
  expect(() => migrated.exec(
    "INSERT INTO runs(id, job_description, status, queue_sequence, created_at, updated_at) VALUES ('bad', 'Bad', 'invalid', 3, 2000, 2000)",
  )).toThrow(/check constraint/i);
  expect(() => migrated.exec(
    "INSERT INTO runs(id, job_description, status, queue_sequence, created_at, updated_at) VALUES ('duplicate', 'Duplicate', 'queued', 2, 2000, 2000)",
  )).toThrow(/unique constraint/i);
  expect(() => migrated.exec("DELETE FROM runs WHERE id = 'run-1'")).toThrow(/foreign key constraint/i);
});


test("migrates existing runs to application status applied atomically", () => {
  const migrated = versionOneDatabase();

  migratePipelineDatabase(migrated, 2_000);

  expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(6);
  expect(migrated.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(migrated.query<{ application_status: string; generate_keyword_map: number }, []>("SELECT application_status, generate_keyword_map FROM runs WHERE id = 'run-1'").get()).toEqual({ application_status: "applied", generate_keyword_map: 0 });

  const rolledBack = versionOneDatabase({ includesApplicationStatus: true });

  expect(() => migratePipelineDatabase(rolledBack, 2_000)).toThrow(/duplicate column name: application_status/i);
  expect(rolledBack.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(1);
  expect(rolledBack.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version)).toEqual([1]);
});

test("migrates version two retention state atomically without changing history", () => {
  const migrated = versionTwoDatabase();

  migratePipelineDatabase(migrated, 2_000);

  expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(6);
  expect(migrated.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(migrated.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_artifact_retention'").get()?.name).toBe("run_artifact_retention");
  expect(migrated.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'run_artifact_retention_state'").get()?.name).toBe("run_artifact_retention_state");
  expect(migrated.query<{ id: string }, []>("SELECT id FROM runs").all()).toEqual([{ id: "run-1" }]);
  expect(migrated.query<{ name: string }, []>("PRAGMA table_info(runs)").all().map(({ name }) => name)).not.toContain("must_include");
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
