import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openPipelineDatabase } from "../src/db/database.ts";
import { ClaimRejectedError, PipelineRepository, RepositoryConflictError, RunArtifactsPrunedError, SourceDriftError, type ActiveStage } from "../src/db/repository.ts";
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

function createReview(repo: PipelineRepository, hash = "a".repeat(64), visualAck = false, id?: string, generateKeywordMap = false) {
  const run = repo.createRun("JD", id, generateKeywordMap);
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
  test("persists immutable run metadata and independently managed application status", () => {
    const { db, repo, tick, now } = fixture();
    expect(repo.createRun("Default JD", "default-setting").generateKeywordMap).toBe(true);
    const created = repo.createRun("JD", "enabled-setting", true);
    expect(created).toMatchObject({ applicationStatus: "pending", generateKeywordMap: true });
    const eventCount = repo.timeline(created.id).events.length;

    tick(1_000);
    const updated = repo.setApplicationStatus(created.id, "interview");
    const secondRepo = new PipelineRepository(db, { now });

    expect(updated.applicationStatus).toBe("interview");
    expect(repo.getRun(created.id)?.applicationStatus).toBe("interview");
    expect(secondRepo.getRun(created.id)?.applicationStatus).toBe("interview");
    expect(secondRepo.getRun(created.id)?.generateKeywordMap).toBe(true);
    expect(updated.status).toBe("queued");
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
    expect(repo.timeline(created.id).events).toHaveLength(eventCount);

    const updatedAt = updated.updatedAt;
    tick(1_000);
    const unchanged = repo.setApplicationStatus(created.id, "interview");

    expect(unchanged.updatedAt).toBe(updatedAt);
    expect(repo.timeline(created.id).events).toHaveLength(eventCount);
  });

  test("persists partial run identity overrides and omits unset values", () => {
    const { db, repo, tick, now } = fixture();
    const created = repo.createRun("JD", "identity-run");
    expect(created).not.toHaveProperty("titleOverride");
    expect(created).not.toHaveProperty("organizationOverride");

    tick(1_000);
    const titled = repo.setIdentity(created.id, { title: "Staff Engineer" });
    expect(titled).toMatchObject({ titleOverride: "Staff Engineer" });
    expect(titled).not.toHaveProperty("organizationOverride");

    tick(1_000);
    const identified = repo.setIdentity(created.id, { organization: "Acme Corp" });
    const secondRepo = new PipelineRepository(db, { now });
    expect(identified).toMatchObject({
      titleOverride: "Staff Engineer",
      organizationOverride: "Acme Corp",
    });
    expect(secondRepo.getRun(created.id)).toMatchObject({
      titleOverride: "Staff Engineer",
      organizationOverride: "Acme Corp",
    });
    expect(() => repo.setIdentity(created.id, {})).toThrow(/required/);
    expect(() => repo.setIdentity(created.id, { title: " padded " })).toThrow(/trimmed/);
  });

  test("soft deletion preserves history while hiding runs, artifacts, and scheduler candidates", () => {
    const { db, repo, tick } = fixture();
    const deleted = repo.createRun("deleted", "deleted-run");
    const successor = repo.createRun("successor", "successor-run");
    const claim = repo.acquire()!;
    repo.transition(claim, "analyzing");
    const attempt = repo.startAttempt(claim, "analyzing");
    const artifact = repo.finalizeArtifact(claim, {
      attemptId: attempt.id,
      stage: "analyzing",
      kind: "job-analysis",
      sha256: "a".repeat(64),
      path: "/tmp/deleted-analysis",
      byteSize: 1,
    });

    expect(() => repo.deleteRun(deleted.id)).toThrow(/live claim/);
    tick(60_001);
    let deletionError: unknown;
    try {
      repo.deleteRun(deleted.id);
    } catch (error) {
      deletionError = error;
    }
    expect(deletionError).toBeInstanceOf(RepositoryConflictError);
    expect((deletionError as Error).message).toBe("run has an active attempt");
    expect(repo.getRun(deleted.id)?.status).toBe("analyzing");
    expect(repo.listRuns().map(({ id }) => id)).toEqual([deleted.id, successor.id]);
    expect(repo.timeline(deleted.id).attempts.find(({ id }) => id === attempt.id)?.status).toBe("running");

    expect(repo.acquire()).toBeNull();
    expect(repo.timeline(deleted.id).attempts.find(({ id }) => id === attempt.id)?.status).toBe("cancel_requested");
    expect(() => repo.deleteRun(deleted.id)).toThrow(/active attempt/);
    expect(repo.acknowledgeCancellation(attempt.id, claim.token)).toBeTrue();
    expect(repo.timeline(deleted.id).attempts.find(({ id }) => id === attempt.id)?.status).toBe("cancelled");
    repo.deleteRun(deleted.id);

    expect(repo.getRun(deleted.id)).toBeNull();
    expect(repo.listRuns().map(({ id }) => id)).toEqual([successor.id]);
    expect(repo.getArtifactById(deleted.id, artifact.id)).toBeNull();
    expect(() => repo.getArtifact(deleted.id, "job-analysis")).toThrow(/run not found/);
    expect(() => repo.setApplicationStatus(deleted.id, "accepted")).toThrow(/run not found/);
    expect(() => repo.setIdentity(deleted.id, { title: "Hidden" })).toThrow(/run not found/);
    expect(db.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM events WHERE run_id = 'deleted-run'",
    ).get()?.count).toBeGreaterThan(0);
    expect(db.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM artifacts WHERE run_id = 'deleted-run'",
    ).get()?.count).toBe(1);
    expect(repo.acquire()?.runId).toBe(successor.id);
  });

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

  test("selects tied artifact timestamps by append-only insertion order", () => {
    const { db, repo, now } = fixture({ now: 1_234 });
    const run = repo.createRun("JD");
    const claim = repo.acquire()!;
    repo.transition(claim, "analyzing");

    const firstAttempt = repo.startAttempt(claim, "analyzing");
    const first = repo.finalizeArtifact(claim, {
      attemptId: firstAttempt.id,
      stage: "analyzing",
      kind: "analysis",
      sha256: "a".repeat(64),
      path: "/tmp/first-analysis",
      byteSize: 1,
    });
    repo.finishAttempt(claim, firstAttempt.id, "succeeded");

    db.query(`
      INSERT INTO artifacts(id, run_id, revision, attempt_id, stage, kind, sha256, path, byte_size, created_at)
      VALUES (?, ?, 1, ?, 'analyzing', 'analysis', ?, ?, 1, ?)
    `).run("eventless-artifact", run.id, "legacy-attempt", "b".repeat(64), "/tmp/eventless-analysis", now());
    expect(repo.getArtifact(run.id, "analysis")?.id).toBe("eventless-artifact");

    const secondAttempt = repo.startAttempt(claim, "analyzing");
    const second = repo.finalizeArtifact(claim, {
      attemptId: secondAttempt.id,
      stage: "analyzing",
      kind: "analysis",
      sha256: "c".repeat(64),
      path: "/tmp/second-analysis",
      byteSize: 1,
    });
    repo.finishAttempt(claim, secondAttempt.id, "succeeded");

    expect(secondAttempt.id).not.toBe(firstAttempt.id);
    expect([first.createdAt, second.createdAt]).toEqual([now(), now()]);
    expect(repo.getArtifact(run.id, "analysis")).toMatchObject({
      id: second.id,
      attemptId: secondAttempt.id,
      sha256: "c".repeat(64),
    });
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
    const run = repo.createRun("JD", undefined, true);
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
    expect(retried.generateKeywordMap).toBe(true);
    expect(repo.getRevision(run.id, 2)?.origin).toBe("retry");
    expect(repo.getArtifact(run.id, "job-analysis", 2)?.sha256).toBe("f".repeat(64));
    expect(repo.getArtifact(run.id, "latex-log", 2)).toBeNull();
  });

  test("late-stage retry keeps the inherited review PDF valid for approval", () => {
    const { repo } = fixture();
    const hash = "7".repeat(64);
    const run = repo.createRun("JD");
    const claim = repo.acquire()!;
    reachStage(repo, claim, ["analyzing", "tailoring", "compiling"]);
    const compileAttempt = repo.startAttempt(claim, "compiling");
    repo.finalizeArtifact(claim, {
      attemptId: compileAttempt.id,
      stage: "compiling",
      kind: "compiled-pdf",
      sha256: hash,
      path: `/tmp/${run.id}.pdf`,
      byteSize: 10,
    });
    repo.finishAttempt(claim, compileAttempt.id, "succeeded");
    repo.transition(claim, "deterministic_qa");
    repo.transition(claim, "visual_qa");
    const visualAttempt = repo.startAttempt(claim, "visual_qa");
    repo.finishAttempt(claim, visualAttempt.id, "failed");
    repo.transition(claim, "failed", { failedStage: "visual_qa" });
    repo.release(claim);

    expect(repo.retry(run.id).status).toBe("visual_qa");
    const retryClaim = repo.acquire()!;
    const retryAttempt = repo.startAttempt(retryClaim, "visual_qa");
    repo.finishAttempt(retryClaim, retryAttempt.id, "succeeded");
    repo.transition(retryClaim, "review");
    repo.release(retryClaim);

    expect(repo.listReviewableRevisions(run.id)).toEqual([{
      revision: 2,
      status: "review",
      createdAt: 1_000,
      pdfSha256: hash,
    }]);
    expect(repo.resolveRevisionOrigin(run.id, 2)).toBe("initial");
    expect(repo.listResolvedArtifacts(run.id, 2).map((artifact) => artifact.kind))
      .toContain("compiled-pdf");

    expect(repo.getArtifact(run.id, "compiled-pdf", 2)?.sha256).toBe(hash);
    expect(repo.approve(run.id, hash).status).toBe("approved");
  });

  test("review edits validate hash, skip analysis, and preserve immutable request origin", () => {
    const { repo, db } = fixture();
    const hash = "1".repeat(64);
    const runId = createReview(repo, hash, false, undefined, true);
    expect(() => repo.editRun(runId, "shorten a bullet", "2".repeat(64))).toThrow(RepositoryConflictError);
    const edited = repo.editRun(runId, "shorten a bullet", hash);
    expect(edited.status).toBe("editing");
    expect(edited.currentRevision).toBe(2);
    expect(edited.generateKeywordMap).toBe(true);
    const revision = repo.getRevision(runId, 2);
    expect(revision?.origin).toBe("human_edit");
    expect(revision?.source_revision).toBe(1);
    const request = db.query<{ comments: string; origin: string }, []>("SELECT comments,origin FROM edit_requests").get();
    expect(request).toEqual({ comments: "shorten a bullet", origin: "human_edit" });
    expect(repo.listReviewableRevisions(runId)).toEqual([{
      revision: 1,
      status: "review",
      createdAt: 1_000,
      pdfSha256: hash,
    }]);
    expect(repo.resolveRevisionOrigin(runId, 1)).toBe("initial");
    expect(repo.resolveRevisionOrigin(runId, 2)).toBe("human_edit");
    expect(repo.listResolvedArtifacts(runId, 1).map((artifact) => artifact.kind))
      .toEqual(["compiled-pdf"]);
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
    expect(approved.visualAcknowledgementRequired).toBe(false);
  });
});

describe("application session ledger", () => {
  test("reserves the approved PDF revision with compare-and-swap generation ownership", () => {
    const { repo } = fixture();
    const hash = "7".repeat(64);
    const runId = createReview(repo, hash);
    repo.approve(runId, hash);

    const reserved = repo.reserveApplicationSession(
      runId,
      null,
      "11111111-1111-4111-8111-111111111111",
      hash,
    );

    expect(reserved).toEqual({
      runId,
      generation: 1,
      sessionId: "11111111-1111-4111-8111-111111111111",
      resumeRevision: 1,
      pdfSha256: hash,
      bridgeState: "reserved",
      publicSnapshot: null,
      lastUpstreamEventId: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      terminalAt: null,
    });
    expect(repo.getLatestApplicationSession(runId)).toEqual(reserved);
    expect(() => repo.reserveApplicationSession(
      runId,
      null,
      "22222222-2222-4222-8222-222222222222",
      hash,
    )).toThrow(/changed/);
  });

  test("records projected snapshots and monotonic upstream cursors for only the current generation", () => {
    const { repo, tick } = fixture();
    const hash = "6".repeat(64);
    const runId = createReview(repo, hash);
    repo.approve(runId, hash);
    const sessionId = "33333333-3333-4333-8333-333333333333";
    repo.reserveApplicationSession(runId, null, sessionId, hash);
    tick(50);

    const snapshot = {
      state: "awaiting_human_navigation",
      pendingAction: { type: "human_navigation", instruction: "Complete login" },
    };
    const recorded = repo.recordApplicationSnapshot(runId, {
      generation: 1,
      sessionId,
      bridgeState: "awaiting_human_navigation",
      publicSnapshot: snapshot,
      lastUpstreamEventId: 7,
    });

    expect(recorded).toMatchObject({
      generation: 1,
      bridgeState: "awaiting_human_navigation",
      publicSnapshot: snapshot,
      lastUpstreamEventId: 7,
      updatedAt: 1_050,
      terminalAt: null,
    });
    expect(() => repo.recordApplicationSnapshot(runId, {
      generation: 1,
      sessionId,
      bridgeState: "running",
      publicSnapshot: { state: "running" },
      lastUpstreamEventId: 6,
    })).toThrow(/cursor/);
  });

  test("marks an observed current session lost, closes it locally, and preserves prior generations", () => {
    const { db, repo, tick } = fixture();
    const hash = "5".repeat(64);
    const runId = createReview(repo, hash);
    repo.approve(runId, hash);
    const firstSessionId = "44444444-4444-4444-8444-444444444444";
    repo.reserveApplicationSession(runId, null, firstSessionId, hash);
    repo.recordApplicationSnapshot(runId, {
      generation: 1,
      sessionId: firstSessionId,
      bridgeState: "running",
      publicSnapshot: { state: "running" },
      lastUpstreamEventId: 3,
    });
    tick(25);

    const lost = repo.markApplicationSessionLost(runId, {
      generation: 1,
      sessionId: firstSessionId,
      publicSnapshot: { state: "lost", warning: "Verify submission state before retrying" },
    });
    expect(lost).toMatchObject({ bridgeState: "lost", terminalAt: 1_025, updatedAt: 1_025 });
    tick(25);
    const closed = repo.closeLostApplicationSession(runId, {
      generation: 1,
      sessionId: firstSessionId,
      publicSnapshot: { state: "closed" },
    });
    expect(closed).toMatchObject({ bridgeState: "closed", terminalAt: 1_025, updatedAt: 1_050 });

    const second = repo.reserveApplicationSession(
      runId,
      firstSessionId,
      "55555555-5555-4555-8555-555555555555",
      hash,
    );
    expect(second).toMatchObject({ generation: 2, bridgeState: "reserved" });
    expect(db.query<{ generation: number; bridge_state: string }, []>(
      "SELECT generation,bridge_state FROM run_application_sessions ORDER BY generation",
    ).all()).toEqual([
      { generation: 1, bridge_state: "closed" },
      { generation: 2, bridge_state: "reserved" },
    ]);
    expect(() => repo.closeLostApplicationSession(runId, {
      generation: 1,
      sessionId: firstSessionId,
      publicSnapshot: { state: "closed" },
    })).toThrow(/current generation/);
  });


  test("allows only explicit cancelled or failed cleanup to transition terminal sessions to closed", () => {
    const { repo, tick } = fixture();
    const hash = "9".repeat(64);
    for (const [index, bridgeState] of (["cancelled", "failed"] as const).entries()) {
      const runId = createReview(repo, hash, false, `terminal-close-${bridgeState}`);
      repo.approve(runId, hash);
      const sessionId = index === 0
        ? "77777777-7777-4777-8777-777777777777"
        : "88888888-8888-4888-8888-888888888888";
      repo.reserveApplicationSession(runId, null, sessionId, hash);
      const terminal = repo.recordApplicationSnapshot(runId, {
        generation: 1,
        sessionId,
        bridgeState,
        publicSnapshot: { state: bridgeState },
      });
      tick(10);

      const closed = repo.recordApplicationSnapshot(runId, {
        generation: 1,
        sessionId,
        bridgeState: "closed",
        publicSnapshot: { state: "closed" },
      });

      expect(closed).toMatchObject({
        bridgeState: "closed",
        terminalAt: terminal.terminalAt,
      });
      expect(closed.updatedAt).toBeGreaterThan(terminal.updatedAt);
      expect(() => repo.recordApplicationSnapshot(runId, {
        generation: 1,
        sessionId,
        bridgeState: "running",
        publicSnapshot: { state: "running" },
      })).toThrow(/terminal/);
      tick(10);
    }
  });
  test("reserves only a retained approved current PDF with a matching caller hash", () => {
    const { db, repo } = fixture();
    const hash = "4".repeat(64);
    const runId = createReview(repo, hash);
    const sessionId = "66666666-6666-4666-8666-666666666666";

    expect(() => repo.reserveApplicationSession(runId, null, sessionId, hash)).toThrow(/approved PDF changed/);
    repo.approve(runId, hash);
    expect(() => repo.reserveApplicationSession(
      runId,
      null,
      sessionId,
      "3".repeat(64),
    )).toThrow(/approved PDF changed/);
    db.query(`
      INSERT INTO run_artifact_retention(run_id, state, selected_at)
      VALUES (?, 'pruning', 1000)
    `).run(runId);
    expect(() => repo.reserveApplicationSession(runId, null, sessionId, hash)).toThrow(RunArtifactsPrunedError);
    expect(repo.getLatestApplicationSession(runId)).toBeNull();
  });
});

describe("artifact retention reservations", () => {
  test("reserves only inactive runs outside the newest ten by queue sequence", () => {
    const { repo } = fixture();
    const ids = ["run-z", "run-2", "run-10", "run-a", "run-01", "run-y", "run-3", "run-b", "run-x", "run-20", "run-c", "run-1"];
    for (const id of ids) createReview(repo, "a".repeat(64), false, id);
    repo.setApplicationStatus(ids[0]!, "accepted");

    expect(repo.reserveArtifactPruneCandidates(10)).toEqual(ids.slice(0, 2));
    expect(repo.areRunArtifactsRetained(ids[0]!)).toBeFalse();
    expect(repo.areRunArtifactsRetained(ids[1]!)).toBeFalse();
    expect(repo.areRunArtifactsRetained(ids[2]!)).toBeTrue();
    expect(repo.areRunArtifactsRetained(ids[11]!)).toBeTrue();
    expect(() => repo.reserveArtifactPruneCandidates(0)).toThrow(/positive integer/);
    expect(() => repo.areRunArtifactsRetained("missing-run")).toThrow(RepositoryConflictError);
  });


  test("live application sessions block deletion and pruning until terminal", () => {
    const { repo } = fixture();
    const hash = "2".repeat(64);
    const ids = Array.from({ length: 12 }, (_, index) => `application-retention-${index}`);
    for (const id of ids) {
      createReview(repo, hash, false, id);
      repo.approve(id, hash);
    }
    const firstSessionId = "77777777-7777-4777-8777-777777777777";
    const secondSessionId = "88888888-8888-4888-8888-888888888888";
    repo.reserveApplicationSession(ids[0]!, null, firstSessionId, hash);
    repo.reserveApplicationSession(ids[1]!, null, secondSessionId, hash);

    expect(() => repo.deleteRun(ids[1]!)).toThrow(/close the browser session first/);
    expect(repo.reserveArtifactPruneCandidates(10)).toEqual([]);

    repo.recordApplicationSnapshot(ids[0]!, {
      generation: 1,
      sessionId: firstSessionId,
      bridgeState: "cancelled",
      publicSnapshot: { state: "cancelled" },
    });
    repo.recordApplicationSnapshot(ids[1]!, {
      generation: 1,
      sessionId: secondSessionId,
      bridgeState: "closed",
      publicSnapshot: { state: "closed" },
    });
    repo.deleteRun(ids[1]!);

    expect(repo.getRun(ids[1]!)).toBeNull();
    expect(repo.reserveArtifactPruneCandidates(10)).toEqual([ids[0]!]);
  });
  test("excludes tombstoned runs from retention selection and reservations", () => {
    const { db, repo } = fixture();
    const ids = Array.from({ length: 13 }, (_, index) => `tombstone-retention-${index}`);
    for (const id of ids) createReview(repo, "a".repeat(64), false, id);
    repo.deleteRun(ids[2]!);

    expect(repo.reserveArtifactPruneCandidates(12)).toEqual([]);
    expect(repo.reserveArtifactPruneCandidates(10)).toEqual(ids.slice(0, 2));
    expect(db.query<{ run_id: string; state: string }, []>(
      "SELECT run_id,state FROM run_artifact_retention ORDER BY run_id",
    ).all()).toEqual([
      { run_id: ids[0]!, state: "pruning" },
      { run_id: ids[1]!, state: "pruning" },
    ]);
    expect(() => repo.deleteRun(ids[0]!)).toThrow(/being pruned/);
    expect(repo.getRun(ids[0]!)).not.toBeNull();
  });

  test("retries pruning rows and defers queued, active, claimed, and active-attempt runs", () => {
    const { db, repo, tick } = fixture();
    const ids = Array.from({ length: 16 }, (_, index) => `retention-${index === 0 ? "z" : index}`);
    for (const id of ids) createReview(repo, "b".repeat(64), false, id);
    db.query("UPDATE runs SET status='queued' WHERE id=?").run(ids[0]!);
    db.query("UPDATE runs SET status='analyzing' WHERE id=?").run(ids[4]!);
    db.query("UPDATE run_claim SET run_id=?, claim_token=?, expires_at=? WHERE id=1").run(ids[1]!, "c".repeat(43), 99_999);
    for (const [index, status] of [[2, "running"], [3, "cancel_requested"]] as const) {
      db.query(`
        INSERT INTO attempts(
          id, run_id, revision, stage, attempt_no, origin, claim_token,
          attempt_session_id, status, started_at
        ) VALUES (?, ?, 1, 'analyzing', 1, 'initial', ?, ?, ?, 1000)
      `).run(`active-${index}`, ids[index]!, "d".repeat(43), `session-${index}`, status);
    }

    expect(repo.reserveArtifactPruneCandidates(10)).toEqual([ids[5]!]);
    expect(repo.reserveArtifactPruneCandidates(10)).toEqual([ids[5]!]);

    db.query("UPDATE runs SET status='review' WHERE id IN (?, ?)").run(ids[0]!, ids[4]!);
    db.query("UPDATE run_claim SET run_id=NULL, claim_token=NULL, expires_at=NULL WHERE id=1").run();
    db.query("UPDATE attempts SET status='succeeded', finished_at=2000 WHERE id IN ('active-2','active-3')").run();

    expect(repo.reserveArtifactPruneCandidates(10)).toEqual(ids.slice(0, 6));
    tick(1_000);
    repo.markRunArtifactsPruned(ids[0]!);
    repo.markRunArtifactsPruned(ids[0]!);
    repo.markRunArtifactsPruned("unreserved-run");

    expect(repo.reserveArtifactPruneCandidates(10)).toEqual(ids.slice(1, 6));
    expect(db.query<{ state: string; pruned_at: number }, [string]>(
      "SELECT state,pruned_at FROM run_artifact_retention WHERE run_id=?",
    ).get(ids[0]!)).toEqual({ state: "pruned", pruned_at: 2_000 });
  });

  test("rejects every artifact-dependent lifecycle command after reservation", () => {
    const { db, repo } = fixture();
    const ids = Array.from({ length: 12 }, (_, index) => `command-${index === 0 ? "z" : index}`);
    for (const id of ids) createReview(repo, "e".repeat(64), false, id);
    db.query("UPDATE runs SET status='failed', failed_stage='compiling' WHERE id=?").run(ids[0]!);
    expect(repo.reserveArtifactPruneCandidates(10)).toEqual(ids.slice(0, 2));

    expect(() => repo.retry(ids[0]!)).toThrow(RunArtifactsPrunedError);
    expect(() => repo.regenerate(ids[1]!, "e".repeat(64))).toThrow(RunArtifactsPrunedError);
    expect(() => repo.editRun(ids[1]!, "change the layout", "e".repeat(64))).toThrow(RunArtifactsPrunedError);
    expect(() => repo.approve(ids[1]!, "e".repeat(64))).toThrow(RunArtifactsPrunedError);
    expect(repo.setApplicationStatus(ids[1]!, "rejected").applicationStatus).toBe("rejected");
  });

  test("never reacquires a runnable run with a retention reservation", () => {
    const { db, repo } = fixture();
    const ids = Array.from({ length: 12 }, (_, index) => `acquire-${index === 0 ? "z" : index}`);
    for (const id of ids) createReview(repo, "f".repeat(64), false, id);
    expect(repo.reserveArtifactPruneCandidates(10)).toEqual(ids.slice(0, 2));
    db.query("UPDATE runs SET status='queued' WHERE id IN (?, ?)").run(ids[0]!, ids[11]!);
    db.query("UPDATE run_claim SET run_id=?, claim_token=?, expires_at=0 WHERE id=1").run(ids[0]!, "g".repeat(43));

    expect(repo.acquire()?.runId).toBe(ids[11]);
  });
});

test.skipIf(process.platform !== "linux")("process start tokens distinguish the live worker from a reused or dead PID (requires Linux /proc)", () => {
  const startToken = readProcessStartToken();
  expect(startToken).toMatch(/^\d+$/);
  expect(isProcessIdentityAlive(process.pid, startToken!)).toBe(true);
  expect(isProcessIdentityAlive(process.pid, `${startToken}-stale`)).toBe(false);
  expect(isProcessIdentityAlive(2_147_483_647, startToken!)).toBe(false);
});
