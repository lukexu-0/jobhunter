import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openPipelineDatabase } from "../src/db/database.ts";
import { ClaimRejectedError, PipelineRepository, RepositoryConflictError, SourceDriftError, type ActiveStage } from "../src/db/repository.ts";
import { isProcessIdentityAlive, readProcessStartToken } from "../src/worker/claims.ts";

const databases: Database[] = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

function fixture(options: { now?: number; alive?: boolean } = {}) {
  let now = options.now ?? 1_000;
  let id = 0;
  let token = 0;
  const db = openPipelineDatabase(":memory:", { now: () => now });
  databases.push(db);
  const repo = new PipelineRepository(db, {
    now: () => now,
    idFactory: () => `id-${++id}`,
    tokenFactory: () => Buffer.alloc(32, ++token).toString("base64url"),
    isProcessAlive: () => options.alive ?? true,
  });
  return { db, repo, tick(ms: number) { now += ms; }, now: () => now };
}

function reachStage(repo: PipelineRepository, claim: { runId: string; token: string }, targets: ActiveStage[]) {
  for (const target of targets) repo.transition(claim, target);
}

function createReview(repo: PipelineRepository, hash = "a".repeat(64), visualAck = false) {
  const run = repo.createRun("JD");
  const claim = repo.acquire();
  if (!claim) throw new Error("claim missing");
  reachStage(repo, claim, ["analyzing", "tailoring", "compiling", "deterministic_qa", "visual_qa"]);
  const attempt = repo.startAttempt(claim, "visual_qa");
  repo.finalizeArtifact(claim, { attemptId: attempt.id, stage: "visual_qa", kind: "compiled-pdf", sha256: hash, path: `/tmp/${run.id}.pdf`, byteSize: 10 });
  repo.finishAttempt(claim, attempt.id, "succeeded");
  repo.transition(claim, "review", { visualAcknowledgementRequired: visualAck });
  repo.release(claim);
  return run.id;
}

describe("pipeline repository claims", () => {
  test("acquires FIFO with a private 256-bit token and heartbeats for 60 seconds", () => {
    const { repo, tick, now } = fixture();
    const first = repo.createRun("first", "z");
    repo.createRun("second", "a");
    const claim = repo.acquire();
    expect(claim?.runId).toBe(first.id);
    expect(claim?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(claim?.expiresAt).toBe(now() + 60_000);
    tick(20_000);
    const renewed = repo.heartbeat(claim!);
    expect(renewed.expiresAt).toBe(now() + 60_000);
    expect(repo.acquire()).toBeNull();
  });

  test("rejects expired and reclaimed owners and requires exact-token release", () => {
    const { repo, tick } = fixture();
    repo.createRun("one");
    const old = repo.acquire()!;
    expect(() => repo.release({ runId: old.runId, token: "x".repeat(43) })).toThrow(ClaimRejectedError);
    tick(60_001);
    const replacement = repo.acquire()!;
    expect(replacement.token).not.toBe(old.token);
    expect(() => repo.heartbeat(old)).toThrow(ClaimRejectedError);
    expect(() => repo.transition(old, "analyzing")).toThrow(ClaimRejectedError);
    repo.release(replacement);
  });

  test("blocks every successor until cancellation acknowledgement", () => {
    const { repo, tick } = fixture({ alive: true });
    const first = repo.createRun("first");
    repo.createRun("second");
    const old = repo.acquire()!;
    repo.transition(old, "analyzing");
    const attempt = repo.startAttempt(old, "analyzing", { processPid: 42, processStartToken: "boot:1" });
    tick(60_001);
    expect(repo.acquire()).toBeNull();
    expect(repo.timeline(first.id).attempts[0]?.status).toBe("cancel_requested");
    expect(repo.acknowledgeCancellation(attempt.id, "wrong")).toBeFalse();
    expect(repo.acknowledgeCancellation(attempt.id, old.token)).toBeTrue();
    const replacement = repo.acquire();
    expect(replacement?.runId).toBe(first.id);
    expect(replacement?.token).not.toBe(old.token);
  });

  test("can reclaim after a recorded process identity is known dead", () => {
    const { repo, tick } = fixture({ alive: false });
    const run = repo.createRun("first");
    const old = repo.acquire()!;
    repo.transition(old, "analyzing");
    const attempt = repo.startAttempt(old, "analyzing", { processPid: 42, processStartToken: "boot:1" });
    tick(60_001);
    const replacement = repo.acquire();
    expect(replacement?.runId).toBe(run.id);
    expect(repo.timeline(run.id).attempts.find((item) => item.id === attempt.id)?.status).toBe("cancelled");
  });
});

describe("persisted workflow commands", () => {
  test("stores one immutable four-source snapshot and detects drift", () => {
    const { db, repo } = fixture();
    const run = repo.createRun("JD");
    const snapshot = {
      manifestSha256: "1".repeat(64),
      baselineSha256: "2".repeat(64),
      sourceHashes: {
        baseline: "2".repeat(64),
        automated: "3".repeat(64),
        scheduler: "4".repeat(64),
        sampleProject: "5".repeat(64),
      },
    };
    expect(repo.attachSourceSnapshot(run.id, snapshot).sourceHashes).toEqual(snapshot.sourceHashes);
    expect(repo.getSourceSnapshot(run.id)).toMatchObject(snapshot);
    expect(() => repo.attachSourceSnapshot(run.id, snapshot)).toThrow();
    expect(() => db.query("UPDATE run_source_snapshots SET baseline_sha256=?").run("6".repeat(64))).toThrow();
    repo.assertSourceSnapshot(run.id, snapshot);
    expect(() => repo.assertSourceSnapshot(run.id, {
      ...snapshot,
      sourceHashes: { ...snapshot.sourceHashes, sampleProject: "6".repeat(64) },
    })).toThrow(SourceDriftError);
  });
  test("guards artifacts and worker transitions and keeps public serialization token-free", () => {
    const { repo, tick } = fixture();
    const run = repo.createRun("JD");
    const claim = repo.acquire()!;
    repo.transition(claim, "analyzing");
    const attempt = repo.startAttempt(claim, "analyzing");
    expect(attempt.attemptSessionId).toMatch(/^[0-9a-f-]{36}$/);
    const artifact = repo.finalizeArtifact(claim, { attemptId: attempt.id, stage: "analyzing", kind: "job-analysis", sha256: "b".repeat(64), path: "/tmp/a.json", byteSize: 5 });
    expect(repo.getArtifact(run.id, "job-analysis")?.id).toBe(artifact.id);
    tick(60_001);
    expect(() => repo.finalizeArtifact(claim, { attemptId: attempt.id, stage: "analyzing", kind: "plan", sha256: "c".repeat(64), path: "/tmp/b.json", byteSize: 4 })).toThrow(ClaimRejectedError);
    const serialized = JSON.stringify({ run: repo.getRun(run.id), timeline: repo.timeline(run.id) });
    expect(serialized).not.toContain(claim.token);
    expect(serialized.toLowerCase()).not.toContain("claim_token");
  });

  test("database enforces append-only events and immutable unique artifacts", () => {
    const { db, repo } = fixture();
    const run = repo.createRun("JD");
    const claim = repo.acquire()!;
    repo.transition(claim, "analyzing");
    const attempt = repo.startAttempt(claim, "analyzing");
    repo.finalizeArtifact(claim, { attemptId: attempt.id, stage: "analyzing", kind: "analysis", sha256: "d".repeat(64), path: "/tmp/immutable", byteSize: 1 });
    expect(() => db.query("UPDATE artifacts SET byte_size=2").run()).toThrow();
    expect(() => db.query("DELETE FROM events WHERE run_id=?").run(run.id)).toThrow();
    expect(() => repo.finalizeArtifact(claim, { attemptId: attempt.id, stage: "analyzing", kind: "analysis", sha256: "e".repeat(64), path: "/tmp/other", byteSize: 1 })).toThrow();
  });

  test("retry creates retry revision at failed stage and resolves preserved upstream artifacts", () => {
    const { repo } = fixture();
    const run = repo.createRun("JD");
    const claim = repo.acquire()!;
    repo.transition(claim, "analyzing");
    const analysisAttempt = repo.startAttempt(claim, "analyzing");
    repo.finalizeArtifact(claim, { attemptId: analysisAttempt.id, stage: "analyzing", kind: "job-analysis", sha256: "f".repeat(64), path: "/tmp/upstream", byteSize: 1 });
    repo.finishAttempt(claim, analysisAttempt.id, "succeeded");
    repo.transition(claim, "tailoring");
    repo.transition(claim, "compiling");
    const compileAttempt = repo.startAttempt(claim, "compiling");
    repo.finalizeArtifact(claim, { attemptId: compileAttempt.id, stage: "compiling", kind: "latex-log", sha256: "e".repeat(64), path: "/tmp/failed-log", byteSize: 1 });
    repo.finishAttempt(claim, compileAttempt.id, "failed");
    repo.transition(claim, "failed", { failedStage: "compiling" });
    repo.release(claim);
    const retried = repo.retry(run.id);
    expect(retried.currentRevision).toBe(2);
    expect(retried.status).toBe("compiling");
    expect(repo.getRevision(run.id, 2)?.origin).toBe("retry");
    expect(repo.getArtifact(run.id, "job-analysis", 2)?.sha256).toBe("f".repeat(64));
    expect(repo.getArtifact(run.id, "latex-log", 2)).toBeNull();
  });

  test("review edits validate hash, skip analysis, and preserve immutable request origin", () => {
    const { repo, db } = fixture();
    const hash = "1".repeat(64);
    const runId = createReview(repo, hash);
    expect(() => repo.editRun(runId, "shorten a bullet", "2".repeat(64))).toThrow(RepositoryConflictError);
    const edited = repo.editRun(runId, "shorten a bullet", hash);
    expect(edited.status).toBe("editing");
    expect(edited.currentRevision).toBe(2);
    const revision = repo.getRevision(runId, 2);
    expect(revision?.origin).toBe("human_edit");
    expect(revision?.source_revision).toBe(1);
    const request = db.query<{ comments: string; origin: string }, []>("SELECT comments,origin FROM edit_requests").get();
    expect(request).toEqual({ comments: "shorten a bullet", origin: "human_edit" });
    expect(() => db.query("UPDATE edit_requests SET comments='changed'").run()).toThrow();
  });

  test("approval rejects stale PDF and requires visual acknowledgement", () => {
    const { repo } = fixture();
    const hash = "9".repeat(64);
    const runId = createReview(repo, hash, true);
    expect(() => repo.approve(runId, "8".repeat(64), true)).toThrow(RepositoryConflictError);
    expect(() => repo.approve(runId, hash)).toThrow(RepositoryConflictError);
    const approved = repo.approve(runId, hash, true);
    expect(approved.status).toBe("approved");
    expect(approved.approvedPdfSha256).toBe(hash);
  });
});

test("process start tokens distinguish the live worker from a reused or dead PID", () => {
  const startToken = readProcessStartToken();
  expect(startToken).toMatch(/^\d+$/);
  expect(isProcessIdentityAlive(process.pid, startToken!)).toBe(true);
  expect(isProcessIdentityAlive(process.pid, `${startToken}-stale`)).toBe(false);
  expect(isProcessIdentityAlive(2_147_483_647, startToken!)).toBe(false);
});
