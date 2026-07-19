import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migratePipelineDatabase } from "../src/db/migrations.ts";
import { migrateRunOutputLayout } from "../src/system/run-output-migration.ts";

const databases: Database[] = [];
const roots: string[] = [];

const RUN_ONE = "11111111-1111-4111-8111-111111111111";
const RUN_TWO = "22222222-2222-4222-8222-222222222222";

function fixture(): { readonly database: Database; readonly legacyRoot: string; readonly outputRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "run-output-layout-"));
  roots.push(root);
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  migratePipelineDatabase(database, 1);
  return { database, legacyRoot: join(root, "legacy-runs"), outputRoot: join(root, "output", "runs") };
}

function insertRun(database: Database, id: string, sequence: number, artifactPath: string): void {
  database.query("INSERT INTO runs(id,job_description,status,current_revision,queue_sequence,created_at,updated_at) VALUES (?,?,'review',1,?,1,1)")
    .run(id, `job:${id}`, sequence);
  database.query("INSERT INTO revisions(run_id,revision,origin,status,created_at) VALUES (?,1,'initial','review',1)").run(id);
  database.query("INSERT INTO artifacts(id,run_id,revision,stage,kind,sha256,path,byte_size,created_at) VALUES (?,?,1,'input','job-description',?,?,3,1)")
    .run(`artifact:${id}`, id, "a".repeat(64), artifactPath);
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

test("moves legacy UUID trees into numbered output folders and rewrites immutable metadata", () => {
  const { database, legacyRoot, outputRoot } = fixture();
  const existingPath = join(legacyRoot, RUN_ONE, "input", "job-description.txt");
  mkdirSync(join(legacyRoot, RUN_ONE, "input"), { recursive: true });
  writeFileSync(existingPath, "job");
  const missingPrunedPath = join(legacyRoot, RUN_TWO, "input", "job-description.txt");
  mkdirSync(join(legacyRoot, "unknown-sibling"), { recursive: true });
  writeFileSync(join(legacyRoot, "unknown-sibling", "keep.txt"), "keep");
  insertRun(database, RUN_ONE, 1, existingPath);
  insertRun(database, RUN_TWO, 2, missingPrunedPath);
  database.query("INSERT INTO run_artifact_retention(run_id,state,selected_at,pruned_at) VALUES (?,'pruned',1,2)").run(RUN_TWO);

  expect(migrateRunOutputLayout(database, { outputRoot, legacyRoots: [legacyRoot] })).toEqual({
    movedRuns: 1,
    rewrittenArtifacts: 2,
  });

  const firstPath = join(outputRoot, "1", "input", "job-description.txt");
  expect(readFileSync(firstPath, "utf8")).toBe("job");
  expect(readFileSync(join(legacyRoot, "unknown-sibling", "keep.txt"), "utf8")).toBe("keep");
  expect(database.query<{ path: string }, [string]>("SELECT path FROM artifacts WHERE run_id=?").get(RUN_ONE)?.path).toBe(firstPath);
  expect(database.query<{ path: string }, [string]>("SELECT path FROM artifacts WHERE run_id=?").get(RUN_TWO)?.path)
    .toBe(join(outputRoot, "2", "input", "job-description.txt"));
  expect(migrateRunOutputLayout(database, { outputRoot, legacyRoots: [legacyRoot] })).toEqual({
    movedRuns: 0,
    rewrittenArtifacts: 0,
  });
  expect(() => database.query("UPDATE artifacts SET byte_size=4 WHERE run_id=?").run(RUN_ONE)).toThrow(/artifacts are immutable/i);
});

test("refuses conflicting destination folders without rewriting metadata", () => {
  const { database, legacyRoot, outputRoot } = fixture();
  const originalPath = join(legacyRoot, RUN_ONE, "input", "job-description.txt");
  mkdirSync(join(legacyRoot, RUN_ONE, "input"), { recursive: true });
  writeFileSync(originalPath, "job");
  mkdirSync(join(outputRoot, "1"), { recursive: true });
  insertRun(database, RUN_ONE, 1, originalPath);

  expect(() => migrateRunOutputLayout(database, { outputRoot, legacyRoots: [legacyRoot] })).toThrow(/destination already exists/i);
  expect(database.query<{ path: string }, [string]>("SELECT path FROM artifacts WHERE run_id=?").get(RUN_ONE)?.path).toBe(originalPath);
});

test("rejects symlinked legacy trees and artifact paths outside known roots", () => {
  const linked = fixture();
  mkdirSync(linked.legacyRoot, { recursive: true });
  const outside = mkdtempSync(join(tmpdir(), "run-output-outside-"));
  roots.push(outside);
  symlinkSync(outside, join(linked.legacyRoot, RUN_ONE));
  insertRun(linked.database, RUN_ONE, 1, join(linked.legacyRoot, RUN_ONE, "input", "job-description.txt"));
  expect(() => migrateRunOutputLayout(linked.database, { outputRoot: linked.outputRoot, legacyRoots: [linked.legacyRoot] })).toThrow(/real directory/i);

  const unknown = fixture();
  insertRun(unknown.database, RUN_ONE, 1, join(outside, "job-description.txt"));
  expect(() => migrateRunOutputLayout(unknown.database, { outputRoot: unknown.outputRoot, legacyRoots: [unknown.legacyRoot] })).toThrow(/outside known run output roots/i);
});
