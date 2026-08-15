import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { migratePipelineDatabase } from "../src/db/migrations.ts";
import { PipelineRepository } from "../src/db/repository.ts";
import { restorePrunedRunArtifacts } from "../src/system/run-artifact-restore.ts";

const databases: Database[] = [];
const roots: string[] = [];

interface RestoreFixture {
  readonly database: Database;
  readonly repository: PipelineRepository;
  readonly priorArtifactRoot: string;
  readonly artifactRoot: string;
}

interface ManifestArtifact {
  readonly relativePath: string;
  readonly expectedContents: string;
  readonly persistedPath?: string;
}

function fixture(): RestoreFixture {
  const root = mkdtempSync(join(tmpdir(), "run-artifact-restore-"));
  roots.push(root);
  const priorArtifactRoot = join(root, "prior-runs");
  const artifactRoot = join(root, "managed", "runs");
  mkdirSync(priorArtifactRoot, { recursive: true, mode: 0o700 });
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  migratePipelineDatabase(database, 1);
  return {
    database,
    repository: new PipelineRepository(database),
    priorArtifactRoot,
    artifactRoot,
  };
}

function insertPrunedRun(
  target: RestoreFixture,
  runId: string,
  queueSequence: number,
  artifacts: readonly ManifestArtifact[],
): void {
  target.database.query(`
    INSERT INTO runs(
      id, job_description, status, current_revision, queue_sequence, created_at, updated_at
    ) VALUES (?, ?, 'review', 1, ?, 1, 1)
  `).run(runId, `job:${runId}`, queueSequence);
  target.database.query(`
    INSERT INTO revisions(run_id, revision, origin, status, created_at)
    VALUES (?, 1, 'initial', 'review', 1)
  `).run(runId);
  for (const [index, artifact] of artifacts.entries()) {
    const destination = artifact.persistedPath ?? join(
      target.artifactRoot,
      String(queueSequence),
      artifact.relativePath,
    );
    target.database.query(`
      INSERT INTO artifacts(
        id, run_id, revision, stage, kind, sha256, path, byte_size, created_at
      ) VALUES (?, ?, 1, 'input', ?, ?, ?, ?, ?)
    `).run(
      `${runId}:artifact:${index}`,
      runId,
      `fixture-${index}`,
      createHash("sha256").update(artifact.expectedContents).digest("hex"),
      destination,
      Buffer.byteLength(artifact.expectedContents),
      index + 1,
    );
  }
  target.database.query(`
    INSERT INTO run_artifact_retention(run_id, state, selected_at, pruned_at)
    VALUES (?, 'pruned', 1, 1)
  `).run(runId);
}

function backupRoot(target: RestoreFixture, queueSequence: number): string {
  return join(target.priorArtifactRoot, `.${queueSequence}.jobhunter-migrated`);
}

function writePrivateFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function restore(target: RestoreFixture) {
  return restorePrunedRunArtifacts(target.repository, {
    artifactRoot: target.artifactRoot,
    priorArtifactRoot: target.priorArtifactRoot,
  });
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

test("restores a complete migrated backup atomically and re-enables its artifacts", () => {
  const target = fixture();
  const runId = "11111111-1111-4111-8111-111111111111";
  const artifacts = [
    { relativePath: "input/job-description.txt", expectedContents: "job description" },
    { relativePath: "review/resume.pdf", expectedContents: "%PDF fixture" },
  ] as const;
  insertPrunedRun(target, runId, 20, artifacts);
  const backup = backupRoot(target, 20);
  for (const artifact of artifacts) {
    writePrivateFile(join(backup, artifact.relativePath), artifact.expectedContents);
  }
  writePrivateFile(join(backup, "attempts/compile.log"), "retained diagnostic");
  chmodSync(join(backup, "attempts/compile.log"), 0o644);

  expect(restore(target)).toEqual({
    markers: 1,
    restored: 1,
    published: 1,
    reused: 0,
    unrecovered: 0,
    failures: [],
    omittedFailures: 0,
  });

  const destination = join(target.artifactRoot, "20");
  expect(readFileSync(join(destination, artifacts[0].relativePath), "utf8"))
    .toBe(artifacts[0].expectedContents);
  expect(existsSync(join(destination, "attempts/compile.log"))).toBe(false);
  expect(lstatSync(destination).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(destination, artifacts[1].relativePath)).mode & 0o777).toBe(0o600);
  expect(target.repository.areRunArtifactsRetained(runId)).toBe(true);
  expect(target.repository.listArtifacts(runId)).toHaveLength(2);
  expect(readFileSync(join(backup, artifacts[1].relativePath), "utf8"))
    .toBe(artifacts[1].expectedContents);
  expect(readFileSync(join(backup, "attempts/compile.log"), "utf8"))
    .toBe("retained diagnostic");
  expect(lstatSync(join(backup, "attempts/compile.log")).mode & 0o777).toBe(0o644);
});

test("leaves a marker pruned when a persisted artifact is missing from its backup", () => {
  const target = fixture();
  const runId = "22222222-2222-4222-8222-222222222222";
  insertPrunedRun(target, runId, 22, [
    { relativePath: "input/job-description.txt", expectedContents: "required" },
    { relativePath: "review/resume.pdf", expectedContents: "missing" },
  ]);
  writePrivateFile(join(backupRoot(target, 22), "input/job-description.txt"), "required");

  const summary = restore(target);

  expect(summary).toMatchObject({ markers: 1, restored: 0, unrecovered: 1 });
  expect(summary.failures[0]?.message).toMatch(/ENOENT|no such file/i);
  expect(target.repository.areRunArtifactsRetained(runId)).toBe(false);
  expect(existsSync(join(target.artifactRoot, "22"))).toBe(false);
});

test("rejects a backup artifact whose hash differs from its persisted manifest", () => {
  const target = fixture();
  const runId = "33333333-3333-4333-8333-333333333333";
  insertPrunedRun(target, runId, 23, [
    { relativePath: "review/resume.pdf", expectedContents: "expected bytes" },
  ]);
  writePrivateFile(join(backupRoot(target, 23), "review/resume.pdf"), "tampered bytes");

  const summary = restore(target);

  expect(summary).toMatchObject({ restored: 0, published: 0, unrecovered: 1 });
  expect(summary.failures[0]?.message).toMatch(/byte size|SHA-256/);
  expect(target.repository.areRunArtifactsRetained(runId)).toBe(false);
});

test("rejects symbolic links in a migrated backup without touching their targets", () => {
  const target = fixture();
  const runId = "44444444-4444-4444-8444-444444444444";
  insertPrunedRun(target, runId, 25, [
    { relativePath: "input/job-description.txt", expectedContents: "outside" },
  ]);
  const outside = join(dirname(target.priorArtifactRoot), "outside.txt");
  writePrivateFile(outside, "outside");
  const backup = backupRoot(target, 25);
  mkdirSync(join(backup, "input"), { recursive: true, mode: 0o700 });
  symlinkSync(outside, join(backup, "input/job-description.txt"));

  const summary = restore(target);

  expect(summary).toMatchObject({ restored: 0, unrecovered: 1 });
  expect(summary.failures[0]?.message).toMatch(/symbolic link/);
  expect(readFileSync(outside, "utf8")).toBe("outside");
  expect(target.repository.areRunArtifactsRetained(runId)).toBe(false);
});

test("rejects an existing wrong destination and preserves both trees", () => {
  const target = fixture();
  const runId = "55555555-5555-4555-8555-555555555555";
  insertPrunedRun(target, runId, 26, [
    { relativePath: "review/resume.pdf", expectedContents: "correct" },
  ]);
  const backupFile = join(backupRoot(target, 26), "review/resume.pdf");
  const destinationFile = join(target.artifactRoot, "26/review/resume.pdf");
  writePrivateFile(backupFile, "correct");
  writePrivateFile(destinationFile, "wrong!!");

  const summary = restore(target);

  expect(summary).toMatchObject({ restored: 0, unrecovered: 1 });
  expect(summary.failures[0]?.message).toMatch(/conflicts/);
  expect(readFileSync(backupFile, "utf8")).toBe("correct");
  expect(readFileSync(destinationFile, "utf8")).toBe("wrong!!");
  expect(target.repository.areRunArtifactsRetained(runId)).toBe(false);
});

test("rejects a symbolic-link destination and leaves its target unchanged", () => {
  const target = fixture();
  const runId = "56565656-5656-4656-8656-565656565656";
  insertPrunedRun(target, runId, 28, [
    { relativePath: "review/resume.pdf", expectedContents: "correct" },
  ]);
  writePrivateFile(join(backupRoot(target, 28), "review/resume.pdf"), "correct");
  const outside = join(dirname(target.artifactRoot), "outside-run");
  writePrivateFile(join(outside, "review/resume.pdf"), "outside");
  symlinkSync(outside, join(target.artifactRoot, "28"));

  const summary = restore(target);

  expect(summary).toMatchObject({ restored: 0, unrecovered: 1 });
  expect(summary.failures[0]?.message).toMatch(/symbolic link/);
  expect(readFileSync(join(outside, "review/resume.pdf"), "utf8")).toBe("outside");
  expect(target.repository.areRunArtifactsRetained(runId)).toBe(false);
});

test("rejects persisted paths outside the numeric run destination", () => {
  const target = fixture();
  const runId = "57575757-5757-4757-8757-575757575757";
  insertPrunedRun(target, runId, 29, [{
    relativePath: "review/resume.pdf",
    expectedContents: "correct",
    persistedPath: join(target.artifactRoot, "30/review/resume.pdf"),
  }]);
  writePrivateFile(join(backupRoot(target, 29), "review/resume.pdf"), "correct");

  const summary = restore(target);

  expect(summary).toMatchObject({ restored: 0, unrecovered: 1 });
  expect(summary.failures[0]?.message).toMatch(/outside its numeric run destination/);
  expect(existsSync(join(target.artifactRoot, "29"))).toBe(false);
  expect(target.repository.areRunArtifactsRetained(runId)).toBe(false);
});

test("rejects a persisted backup artifact that is not owner-private", () => {
  const target = fixture();
  const runId = "58585858-5858-4858-8858-585858585858";
  insertPrunedRun(target, runId, 32, [
    { relativePath: "review/resume.pdf", expectedContents: "correct" },
  ]);
  const backupFile = join(backupRoot(target, 32), "review/resume.pdf");
  writePrivateFile(backupFile, "correct");
  chmodSync(backupFile, 0o644);

  const summary = restore(target);

  expect(summary).toMatchObject({ restored: 0, unrecovered: 1 });
  expect(summary.failures[0]?.message).toMatch(/owner-private/);
  expect(target.repository.areRunArtifactsRetained(runId)).toBe(false);
});

test("continues restoring later complete runs after an incomplete historical run", () => {
  const target = fixture();
  const incomplete = "66666666-6666-4666-8666-666666666666";
  const complete = "77777777-7777-4777-8777-777777777777";
  insertPrunedRun(target, incomplete, 27, [
    { relativePath: "review/resume.pdf", expectedContents: "absent" },
  ]);
  insertPrunedRun(target, complete, 30, [
    { relativePath: "review/resume.pdf", expectedContents: "complete" },
  ]);
  mkdirSync(backupRoot(target, 27), { mode: 0o700 });
  writePrivateFile(join(backupRoot(target, 30), "review/resume.pdf"), "complete");

  const summary = restore(target);

  expect(summary).toMatchObject({
    markers: 2,
    restored: 1,
    published: 1,
    unrecovered: 1,
  });
  expect(summary.failures).toHaveLength(1);
  expect(summary.failures[0]?.runId).toBe(incomplete);
  expect(target.repository.areRunArtifactsRetained(incomplete)).toBe(false);
  expect(target.repository.areRunArtifactsRetained(complete)).toBe(true);
});

test("retries idempotently after publication succeeds before marker clearing", () => {
  const target = fixture();
  const runId = "88888888-8888-4888-8888-888888888888";
  insertPrunedRun(target, runId, 31, [
    { relativePath: "review/resume.pdf", expectedContents: "published once" },
  ]);
  writePrivateFile(join(backupRoot(target, 31), "review/resume.pdf"), "published once");
  let firstClear = true;
  const interruptedRepository = {
    listPrunedRunArtifactManifests: () => target.repository.listPrunedRunArtifactManifests(),
    clearPrunedRunArtifactMarker: (selectedRunId: string, queueSequence: number) => {
      if (firstClear) {
        firstClear = false;
        throw new Error("simulated crash before marker transaction");
      }
      target.repository.clearPrunedRunArtifactMarker(selectedRunId, queueSequence);
    },
  };

  const interrupted = restorePrunedRunArtifacts(interruptedRepository, {
    artifactRoot: target.artifactRoot,
    priorArtifactRoot: target.priorArtifactRoot,
  });
  expect(interrupted).toMatchObject({
    restored: 0,
    published: 0,
    unrecovered: 1,
  });
  expect(readFileSync(join(target.artifactRoot, "31/review/resume.pdf"), "utf8"))
    .toBe("published once");

  expect(restore(target)).toEqual({
    markers: 1,
    restored: 1,
    published: 0,
    reused: 1,
    unrecovered: 0,
    failures: [],
    omittedFailures: 0,
  });
  expect(readFileSync(join(backupRoot(target, 31), "review/resume.pdf"), "utf8"))
    .toBe("published once");
});
