import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { migratePipelineDatabase } from "../src/db/migrations.ts";
import { migrateRunOutputLayout } from "../src/system/run-output-migration.ts";

const databases: Database[] = [];
const roots: string[] = [];

const RUN_ONE = "11111111-1111-4111-8111-111111111111";
const RUN_TWO = "22222222-2222-4222-8222-222222222222";

function fixture(): {
  readonly database: Database;
  readonly legacyRoot: string;
  readonly priorRoot: string;
  readonly outputRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), "run-output-layout-"));
  roots.push(root);
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  migratePipelineDatabase(database, 1);
  return {
    database,
    legacyRoot: join(root, "legacy-runs"),
    priorRoot: join(root, "prior-runs"),
    outputRoot: join(root, "output", "runs"),
  };
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

test("relocates numbered run output from a prior root and is idempotent", () => {
  const { database, legacyRoot, priorRoot, outputRoot } = fixture();
  const originalPath = join(priorRoot, "7", "input", "job-description.txt");
  mkdirSync(join(priorRoot, "7", "input"), { recursive: true });
  writeFileSync(originalPath, "job");
  insertRun(database, RUN_ONE, 7, originalPath);

  expect(migrateRunOutputLayout(database, {
    outputRoot,
    legacyRoots: [legacyRoot],
    priorOutputRoots: [priorRoot],
  })).toEqual({
    movedRuns: 1,
    rewrittenArtifacts: 1,
  });

  const relocatedPath = join(outputRoot, "7", "input", "job-description.txt");
  expect(readFileSync(relocatedPath, "utf8")).toBe("job");
  expect(existsSync(join(priorRoot, "7"))).toBe(false);
  expect(database.query<{ path: string }, [string]>("SELECT path FROM artifacts WHERE run_id=?").get(RUN_ONE)?.path)
    .toBe(relocatedPath);
  expect(migrateRunOutputLayout(database, {
    outputRoot,
    legacyRoots: [legacyRoot],
    priorOutputRoots: [priorRoot],
  })).toEqual({
    movedRuns: 0,
    rewrittenArtifacts: 0,
  });

  const interruptedRetirement = join(priorRoot, ".7.jobhunter-migrated");
  mkdirSync(join(interruptedRetirement, "input"), { recursive: true });
  writeFileSync(join(interruptedRetirement, "input", "job-description.txt"), "job");

  expect(migrateRunOutputLayout(database, {
    outputRoot,
    legacyRoots: [legacyRoot],
    priorOutputRoots: [priorRoot],
  })).toEqual({
    movedRuns: 0,
    rewrittenArtifacts: 0,
  });
  expect(existsSync(interruptedRetirement)).toBe(true);
});

test("finishes a numbered relocation whose identical destination was already published", () => {
  const { database, legacyRoot, priorRoot, outputRoot } = fixture();
  const originalPath = join(priorRoot, "7", "input", "job-description.txt");
  const relocatedPath = join(outputRoot, "7", "input", "job-description.txt");
  mkdirSync(join(priorRoot, "7", "input"), { recursive: true });
  mkdirSync(join(outputRoot, "7", "input"), { recursive: true });
  writeFileSync(originalPath, "job");
  writeFileSync(relocatedPath, "job");
  insertRun(database, RUN_ONE, 7, originalPath);

  expect(migrateRunOutputLayout(database, {
    outputRoot,
    legacyRoots: [legacyRoot],
    priorOutputRoots: [priorRoot],
  })).toEqual({
    movedRuns: 0,
    rewrittenArtifacts: 1,
  });
  expect(existsSync(join(priorRoot, "7"))).toBe(false);
  expect(database.query<{ path: string }, [string]>("SELECT path FROM artifacts WHERE run_id=?").get(RUN_ONE)?.path)
    .toBe(relocatedPath);
});

test("refuses conflicting or symlinked numbered relocations without rewriting metadata", () => {
  const conflict = fixture();
  const originalPath = join(conflict.priorRoot, "7", "input", "job-description.txt");
  mkdirSync(join(conflict.priorRoot, "7", "input"), { recursive: true });
  mkdirSync(join(conflict.outputRoot, "7", "input"), { recursive: true });
  writeFileSync(originalPath, "old");
  writeFileSync(join(conflict.outputRoot, "7", "input", "job-description.txt"), "different");
  insertRun(conflict.database, RUN_ONE, 7, originalPath);

  expect(() => migrateRunOutputLayout(conflict.database, {
    outputRoot: conflict.outputRoot,
    legacyRoots: [conflict.legacyRoot],
    priorOutputRoots: [conflict.priorRoot],
  })).toThrow(/destination.*conflict/i);
  expect(conflict.database.query<{ path: string }, [string]>("SELECT path FROM artifacts WHERE run_id=?").get(RUN_ONE)?.path)
    .toBe(originalPath);

  const linked = fixture();
  const linkedPath = join(linked.priorRoot, "7", "input", "job-description.txt");
  const outside = mkdtempSync(join(tmpdir(), "run-output-outside-"));
  roots.push(outside);
  mkdirSync(join(linked.priorRoot, "7"), { recursive: true });
  symlinkSync(outside, join(linked.priorRoot, "7", "input"));
  insertRun(linked.database, RUN_ONE, 7, linkedPath);

  expect(() => migrateRunOutputLayout(linked.database, {
    outputRoot: linked.outputRoot,
    legacyRoots: [linked.legacyRoot],
    priorOutputRoots: [linked.priorRoot],
  })).toThrow(/symbolic link/i);
  expect(linked.database.query<{ path: string }, [string]>("SELECT path FROM artifacts WHERE run_id=?").get(RUN_ONE)?.path)
    .toBe(linkedPath);
  expect(existsSync(join(linked.outputRoot, "7"))).toBe(false);
});

test("refuses more than one source across numbered and UUID layouts", () => {
  const { database, legacyRoot, priorRoot, outputRoot } = fixture();
  const priorPath = join(priorRoot, "7", "input", "job-description.txt");
  mkdirSync(join(priorRoot, "7", "input"), { recursive: true });
  mkdirSync(join(legacyRoot, RUN_ONE, "input"), { recursive: true });
  writeFileSync(priorPath, "numeric");
  writeFileSync(join(legacyRoot, RUN_ONE, "input", "job-description.txt"), "uuid");
  insertRun(database, RUN_ONE, 7, priorPath);

  expect(() => migrateRunOutputLayout(database, {
    outputRoot,
    legacyRoots: [legacyRoot],
    priorOutputRoots: [priorRoot],
  })).toThrow(/multiple.*output roots/i);
  expect(database.query<{ path: string }, [string]>("SELECT path FROM artifacts WHERE run_id=?").get(RUN_ONE)?.path)
    .toBe(priorPath);
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

test("rejects an output root reached through a symlinked ancestor without deleting either tree", () => {
  const { database, legacyRoot, outputRoot } = fixture();
  const fixtureRoot = dirname(dirname(outputRoot));
  const canonicalOutputParent = join(fixtureRoot, "canonical-output");
  const canonicalOutputRoot = join(canonicalOutputParent, "runs");
  const aliasedOutputParent = join(fixtureRoot, "aliased-output");
  const sourcePath = join(legacyRoot, RUN_ONE, "input", "job-description.txt");
  const liveDestination = join(canonicalOutputRoot, "1", "live.txt");
  mkdirSync(dirname(sourcePath), { recursive: true });
  mkdirSync(dirname(liveDestination), { recursive: true });
  writeFileSync(sourcePath, "source");
  writeFileSync(liveDestination, "live");
  symlinkSync(canonicalOutputParent, aliasedOutputParent);
  insertRun(database, RUN_ONE, 1, sourcePath);

  expect(() => migrateRunOutputLayout(database, {
    outputRoot: join(aliasedOutputParent, "runs"),
    legacyRoots: [legacyRoot],
  })).toThrow(/canonical path differs/i);
  expect(readFileSync(sourcePath, "utf8")).toBe("source");
  expect(readFileSync(liveDestination, "utf8")).toBe("live");
  expect(database.query<{ path: string }, [string]>("SELECT path FROM artifacts WHERE run_id=?").get(RUN_ONE)?.path)
    .toBe(sourcePath);
});

test("rejects identical source and destination file identities without retiring the source", () => {
  const { database, legacyRoot, priorRoot, outputRoot } = fixture();
  const sourcePath = join(priorRoot, "7", "input", "job-description.txt");
  const destinationPath = join(outputRoot, "7", "input", "job-description.txt");
  mkdirSync(dirname(sourcePath), { recursive: true });
  mkdirSync(dirname(destinationPath), { recursive: true });
  writeFileSync(sourcePath, "job");
  linkSync(sourcePath, destinationPath);
  insertRun(database, RUN_ONE, 7, sourcePath);

  expect(() => migrateRunOutputLayout(database, {
    outputRoot,
    legacyRoots: [legacyRoot],
    priorOutputRoots: [priorRoot],
  })).toThrow(/same filesystem object/i);
  expect(readFileSync(sourcePath, "utf8")).toBe("job");
  expect(readFileSync(destinationPath, "utf8")).toBe("job");
  expect(database.query<{ path: string }, [string]>("SELECT path FROM artifacts WHERE run_id=?").get(RUN_ONE)?.path)
    .toBe(sourcePath);
});

test("rejects source directories that are group or world writable", () => {
  const { database, legacyRoot, outputRoot } = fixture();
  const sourcePath = join(legacyRoot, RUN_ONE, "input", "job-description.txt");
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, "job");
  chmodSync(dirname(sourcePath), 0o777);
  insertRun(database, RUN_ONE, 1, sourcePath);

  expect(() => migrateRunOutputLayout(database, {
    outputRoot,
    legacyRoots: [legacyRoot],
  })).toThrow(/group or world writable/i);
  expect(readFileSync(sourcePath, "utf8")).toBe("job");
  expect(existsSync(join(outputRoot, "1"))).toBe(false);
});

test("rejects source trees deeper than the migration limit without retiring them", () => {
  const { database, legacyRoot, outputRoot } = fixture();
  const sourcePath = join(legacyRoot, RUN_ONE, "one", "two", "three", "artifact.txt");
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, "job");
  insertRun(database, RUN_ONE, 1, sourcePath);

  expect(() => migrateRunOutputLayout(database, {
    outputRoot,
    legacyRoots: [legacyRoot],
    limits: { maxDepth: 2, maxEntries: 20, maxBytes: 20 },
  })).toThrow(/depth limit/i);
  expect(readFileSync(sourcePath, "utf8")).toBe("job");
  expect(existsSync(join(outputRoot, "1"))).toBe(false);
});

test("rejects source trees with too many aggregate entries without retiring them", () => {
  const { database, legacyRoot, outputRoot } = fixture();
  const sourcePath = join(legacyRoot, RUN_ONE, "input", "job-description.txt");
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, "job");
  writeFileSync(join(dirname(sourcePath), "second.txt"), "two");
  insertRun(database, RUN_ONE, 1, sourcePath);

  expect(() => migrateRunOutputLayout(database, {
    outputRoot,
    legacyRoots: [legacyRoot],
    limits: { maxDepth: 5, maxEntries: 2, maxBytes: 20 },
  })).toThrow(/entry limit/i);
  expect(readFileSync(sourcePath, "utf8")).toBe("job");
  expect(existsSync(join(outputRoot, "1"))).toBe(false);
});

test("applies entry limits across every run in one migration", () => {
  const { database, legacyRoot, outputRoot } = fixture();
  const firstPath = join(legacyRoot, RUN_ONE, "input", "job-description.txt");
  const secondPath = join(legacyRoot, RUN_TWO, "input", "job-description.txt");
  mkdirSync(dirname(firstPath), { recursive: true });
  mkdirSync(dirname(secondPath), { recursive: true });
  writeFileSync(firstPath, "one");
  writeFileSync(secondPath, "two");
  insertRun(database, RUN_ONE, 1, firstPath);
  insertRun(database, RUN_TWO, 2, secondPath);

  expect(() => migrateRunOutputLayout(database, {
    outputRoot,
    legacyRoots: [legacyRoot],
    limits: {
      maxDepth: 5,
      maxEntries: 3,
      maxBytes: 20,
      maxRuns: 2,
      maxArtifacts: 2,
    },
  })).toThrow(/entry limit/i);
  expect(readFileSync(firstPath, "utf8")).toBe("one");
  expect(readFileSync(secondPath, "utf8")).toBe("two");
});

test("rejects database row cardinality above the migration limits", () => {
  const { database, legacyRoot, outputRoot } = fixture();
  insertRun(database, RUN_ONE, 1, join(legacyRoot, RUN_ONE, "missing.txt"));
  insertRun(database, RUN_TWO, 2, join(legacyRoot, RUN_TWO, "missing.txt"));

  expect(() => migrateRunOutputLayout(database, {
    outputRoot,
    legacyRoots: [legacyRoot],
    limits: {
      maxDepth: 5,
      maxEntries: 20,
      maxBytes: 20,
      maxRuns: 1,
      maxArtifacts: 2,
    },
  })).toThrow(/run row limit/i);

  expect(() => migrateRunOutputLayout(database, {
    outputRoot,
    legacyRoots: [legacyRoot],
    limits: {
      maxDepth: 5,
      maxEntries: 20,
      maxBytes: 20,
      maxRuns: 2,
      maxArtifacts: 1,
    },
  })).toThrow(/artifact row limit/i);
});

test("rejects source trees over the aggregate byte limit without retiring them", () => {
  const { database, legacyRoot, outputRoot } = fixture();
  const sourcePath = join(legacyRoot, RUN_ONE, "input", "job-description.txt");
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, "four");
  insertRun(database, RUN_ONE, 1, sourcePath);

  expect(() => migrateRunOutputLayout(database, {
    outputRoot,
    legacyRoots: [legacyRoot],
    limits: { maxDepth: 5, maxEntries: 5, maxBytes: 3 },
  })).toThrow(/byte limit/i);
  expect(readFileSync(sourcePath, "utf8")).toBe("four");
  expect(existsSync(join(outputRoot, "1"))).toBe(false);
});
