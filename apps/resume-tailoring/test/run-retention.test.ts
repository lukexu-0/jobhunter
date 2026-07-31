import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunApplicationService } from "../src/api/run-service.ts";
import { openPipelineDatabase } from "../src/db/database.ts";
import { PipelineRepository, type PublicRun } from "../src/db/repository.ts";
import { ArtifactStore } from "../src/system/artifacts.ts";
import { enforceRunArtifactRetention, RUN_ARTIFACT_RETENTION_COUNT } from "../src/system/run-retention.ts";

const databases: Database[] = [];
const roots: string[] = [];
const SOURCE_SNAPSHOT = {
  manifestSha256: "1".repeat(64),
  baselineSha256: "2".repeat(64),
  sourceHashes: {
    baseline: "2".repeat(64),
    automated: "3".repeat(64),
    scheduler: "4".repeat(64),
    sampleProject: "5".repeat(64),
  },
  sources: [],
  evidence: [],
  mustIncludeDirectives: [],
  explicitEntityBindings: {},
} as const;
const REVIEW_STAGES = ["analyzing", "tailoring", "compiling", "deterministic_qa", "visual_qa"] as const;

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function persistedReviewWindow(ids: readonly string[]) {
  const parent = mkdtempSync(join(tmpdir(), "pipeline-retention-"));
  roots.push(parent);
  const db = openPipelineDatabase(":memory:", { now: () => 1_000 });
  databases.push(db);
  let record = 0;
  let token = 0;
  const repository = new PipelineRepository(db, {
    now: () => 1_000,
    idFactory: () => `record-${++record}`,
    attemptSessionIdFactory: () => `session-${record}`,
    tokenFactory: () => Buffer.alloc(32, ++token).toString("base64url"),
  });
  const artifacts = new ArtifactStore(join(parent, "runs"));
  const records: { id: string; queueSequence: number; pdf: { id: string; path: string; byteSize: number; content: string } }[] = [];
  for (const id of ids) {
    const queueSequence = repository.nextQueueSequence();
    const inputRoot = await artifacts.createRunInput({ run: queueSequence });
    const input = await artifacts.write(join(inputRoot, "job-description.txt"), `job:${id}`, 1024);
    const run = repository.createQueuedRun(`job:${id}`, `https://jobs.example.test/${id}`, SOURCE_SNAPSHOT, {
      sha256: input.sha256,
      path: input.path,
      byteSize: input.bytes,
    }, id, true, queueSequence);
    const claim = repository.acquire();
    if (!claim || claim.runId !== id) throw new Error(`claim missing for ${id}`);
    for (const stage of REVIEW_STAGES) repository.transition(claim, stage);
    const attempt = repository.startAttempt(claim, "visual_qa");
    const attemptRoot = await artifacts.createAttempt({
      run: run.queueSequence,
      revision: "1",
      stage: "visual_qa",
      attempt: attempt.attemptNo,
    });
    const content = `pdf:${id}`;
    const stored = await artifacts.write(join(attemptRoot, "resume.pdf"), content, 1024);
    const pdf = repository.finalizeArtifact(claim, {
      attemptId: attempt.id,
      stage: "visual_qa",
      kind: "compiled-pdf",
      sha256: stored.sha256,
      path: stored.path,
      byteSize: stored.bytes,
    });
    repository.finishAttempt(claim, attempt.id, "succeeded");
    repository.transition(claim, "review");
    repository.release(claim);
    records.push({ id, queueSequence: run.queueSequence, pdf: { id: pdf.id, path: pdf.path, byteSize: pdf.byteSize, content } });
  }
  return { artifacts, db, records, repository };
}

function historyCounts(db: Database): Record<string, number> {
  const result: Record<string, number> = {};
  for (const table of ["runs", "attempts", "events", "artifacts", "run_source_snapshots"]) {
    result[table] = db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()!.count;
  }
  return result;
}


test("reserves candidates before sequential removal and marks terminal absence", async () => {
  const calls: string[] = [];
  const repository = {
    reserveArtifactPruneCandidates(retainCount: number): string[] {
      calls.push(`reserve:${retainCount}`);
      return ["run-oldest", "run-missing"];
    },
    getRun(runId: string) {
      const queueSequence = runId === "run-oldest" ? 1 : runId === "run-missing" ? 2 : undefined;
      return queueSequence === undefined
        ? null
        : { queueSequence } as PublicRun;
    },
    markRunArtifactsPruned(runId: string): void {
      calls.push(`mark:${runId}`);
    },
  };
  const artifacts = {
    async removeRun(queueSequence: number): Promise<boolean> {
      calls.push(`remove:${queueSequence}`);
      return queueSequence === 1;
    },
  };

  await expect(enforceRunArtifactRetention(repository, artifacts)).resolves.toBe(2);
  expect(calls).toEqual([
    `reserve:${RUN_ARTIFACT_RETENTION_COUNT}`,
    "remove:1",
    "mark:run-oldest",
    "remove:2",
    "mark:run-missing",
  ]);
});

test("continues after deletion failures and leaves failed reservations retryable", async () => {
  const pruning = new Set(["run-a", "run-b", "run-c"]);
  const marked: string[] = [];
  const removed: number[] = [];
  let failRunA = true;
  const repository = {
    reserveArtifactPruneCandidates(): string[] {
      return [...pruning];
    },
    getRun(runId: string) {
      const queueSequence = runId === "run-a" ? 1 : runId === "run-b" ? 2 : runId === "run-c" ? 3 : undefined;
      return queueSequence === undefined
        ? null
        : { queueSequence } as PublicRun;
    },
    markRunArtifactsPruned(runId: string): void {
      marked.push(runId);
      pruning.delete(runId);
    },
  };
  const artifacts = {
    async removeRun(queueSequence: number): Promise<boolean> {
      removed.push(queueSequence);
      if (queueSequence === 1 && failRunA) throw new Error("injected deletion failure");
      return queueSequence !== 2;
    },
  };

  const firstSweep = enforceRunArtifactRetention(repository, artifacts);
  await expect(firstSweep).rejects.toBeInstanceOf(AggregateError);
  expect(marked).toEqual(["run-b", "run-c"]);
  expect([...pruning]).toEqual(["run-a"]);
  expect(removed).toEqual([1, 2, 3]);

  failRunA = false;
  await expect(enforceRunArtifactRetention(repository, artifacts)).resolves.toBe(1);
  expect(marked).toEqual(["run-b", "run-c", "run-a"]);
  expect(removed).toEqual([1, 2, 3, 1]);
  expect([...pruning]).toEqual([]);
});

test("prunes only the two oldest inactive run trees while preserving all SQLite history", async () => {
  const ids = ["run-z", "run-2", "run-10", "run-a", "run-01", "run-y", "run-3", "run-b", "run-x", "run-20", "run-c", "run-1"];
  const { artifacts, db, records, repository } = await persistedReviewWindow(ids);
  db.query("UPDATE runs SET status='failed', failed_stage='compiling' WHERE id=?").run(ids[0]!);
  db.query("UPDATE revisions SET status='failed' WHERE run_id=? AND revision=1").run(ids[0]!);
  const before = historyCounts(db);

  await expect(enforceRunArtifactRetention(repository, artifacts)).resolves.toBe(2);

  expect(existsSync(join(artifacts.root, String(records[0]!.queueSequence)))).toBeFalse();
  expect(existsSync(join(artifacts.root, String(records[1]!.queueSequence)))).toBeFalse();
  for (const record of records.slice(2)) {
    expect(Buffer.from(await artifacts.read(record.pdf.path, record.pdf.byteSize)).toString("utf8")).toBe(record.pdf.content);
  }
  expect(historyCounts(db)).toEqual(before);
  expect(db.query<{ run_id: string; state: string }, []>(
    "SELECT run_id,state FROM run_artifact_retention ORDER BY selected_at,run_id",
  ).all()).toEqual([
    { run_id: ids[1]!, state: "pruned" },
    { run_id: ids[0]!, state: "pruned" },
  ]);

  const service = new RunApplicationService({
    repository,
    artifacts,
    context: { createSnapshot: () => SOURCE_SNAPSHOT },
    scheduler: () => undefined,
  });
  await expect(service.getArtifact(ids[0]!, records[0]!.pdf.id)).rejects.toMatchObject({
    code: "RUN_ARTIFACTS_PRUNED",
    status: 410,
  });
  await expect(service.retryRun(ids[0]!)).rejects.toMatchObject({
    code: "RUN_ARTIFACTS_PRUNED",
    status: 410,
  });
});

test("parks submitted artifacts until browser close, then releases only liveness", async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `submitted-${index}`);
  const { artifacts, records, repository } = await persistedReviewWindow(ids);
  const runId = ids[0]!;
  const pdf = repository.getArtifact(runId, "compiled-pdf", 1);
  if (!pdf) throw new Error("compiled PDF missing");
  repository.approve(runId, pdf.sha256);
  const sessionId = "70707070-7070-4070-8070-707070707070";
  repository.reserveApplicationSession(runId, null, sessionId, pdf.sha256);
  repository.recordApplicationSnapshot(runId, {
    generation: 1,
    sessionId,
    bridgeState: "awaiting_human_review",
    publicSnapshot: { state: "awaiting_human_review" },
  });
  repository.claimApplicationSubmission(sessionId);
  repository.finalizeApplicationSubmission(sessionId, "submitted");
  repository.recordApplicationSnapshot(runId, {
    generation: 1,
    sessionId,
    bridgeState: "submitted",
    publicSnapshot: { state: "submitted" },
  });

  await expect(enforceRunArtifactRetention(repository, artifacts)).resolves.toBe(1);
  expect(existsSync(join(artifacts.root, String(records[0]!.queueSequence)))).toBeTrue();
  expect(existsSync(join(artifacts.root, String(records[1]!.queueSequence)))).toBeFalse();

  repository.recordApplicationSnapshot(runId, {
    generation: 1,
    sessionId,
    bridgeState: "closed",
    publicSnapshot: { state: "closed" },
  });
  expect(repository.getLatestApplicationSession(runId)?.submissionPhase).toBe("submitted");
  await expect(enforceRunArtifactRetention(repository, artifacts)).resolves.toBe(1);
  expect(existsSync(join(artifacts.root, String(records[0]!.queueSequence)))).toBeFalse();
});

test("temporarily keeps an old active run and prunes it after it becomes inactive", async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `active-${index === 0 ? "z" : index}`);
  const { artifacts, db, repository } = await persistedReviewWindow(ids);
  db.query("UPDATE runs SET status='analyzing' WHERE id=?").run(ids[0]!);

  await expect(enforceRunArtifactRetention(repository, artifacts)).resolves.toBe(1);
  expect(existsSync(join(artifacts.root, String(repository.getRun(ids[0]!)!.queueSequence)))).toBeTrue();
  expect(existsSync(join(artifacts.root, String(repository.getRun(ids[1]!)!.queueSequence)))).toBeFalse();
  expect(await readdir(artifacts.root)).toHaveLength(11);

  db.query("UPDATE runs SET status='review' WHERE id=?").run(ids[0]!);
  await expect(enforceRunArtifactRetention(repository, artifacts)).resolves.toBe(1);
  expect(existsSync(join(artifacts.root, String(repository.getRun(ids[0]!)!.queueSequence)))).toBeFalse();
  expect(await readdir(artifacts.root)).toHaveLength(10);
});
