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

test("migrates existing runs to application status applied atomically", () => {
  const migrated = versionOneDatabase();

  migratePipelineDatabase(migrated, 2_000);

  expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
  expect(migrated.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version)).toEqual([1, 2]);
  expect(migrated.query<{ application_status: string }, []>("SELECT application_status FROM runs WHERE id = 'run-1'").get()?.application_status).toBe("applied");

  const rolledBack = versionOneDatabase({ includesApplicationStatus: true });

  expect(() => migratePipelineDatabase(rolledBack, 2_000)).toThrow(/duplicate column name: application_status/i);
  expect(rolledBack.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(1);
  expect(rolledBack.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version)).toEqual([1]);
});
