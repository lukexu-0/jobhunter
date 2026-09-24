import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openPipelineDatabase } from "../src/db/database.ts";
import { ApplicationSubmissionFinalError, ClaimRejectedError, PipelineRepository, RepositoryConflictError, RunArtifactsPrunedError, SourceDriftError, type ActiveStage } from "../src/db/repository.ts";
import { isProcessIdentityAlive, readProcessStartToken } from "../src/worker/claims.ts";
import { ApplicationSessionSnapshotDtoSchema } from "../src/contracts/index.ts";

const databases: Database[] = [];
const SUBMISSION_UNCERTAIN_WARNING =
  "The application submission could not be verified. Check the headed browser if it is still available, then close this session.";
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

function recordApplicationReview(
  repo: PipelineRepository,
  runId: string,
  sessionId: string,
): void {
  repo.recordApplicationSnapshot(runId, {
    slotReleased: false,
    generation: 1,
    sessionId,
    bridgeState: "awaiting_human_review",
    publicSnapshot: { state: "awaiting_human_review" },
  });
}

describe("pipeline repository claims", () => {
  test("acquires thirty distinct FIFO runs, waits at capacity, and reuses a released slot", () => {
    const { repo, tick, now } = fixture();
    const runs = Array.from({ length: 31 }, (_, index) => repo.createRun(
      `job-${index + 1}`,
      `run-${31 - index}`,
    ));
    const claims = Array.from({ length: 30 }, () => repo.acquire());

    expect(claims.map((claim) => claim?.runId)).toEqual(runs.slice(0, 30).map(({ id }) => id));
    expect(new Set(claims.map((claim) => claim?.runId)).size).toBe(30);
    for (const value of claims) {
      expect(value?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(value?.expiresAt).toBe(now() + 60_000);
    }
    expect(repo.acquire()).toBeNull();

    tick(20_000);
    const renewed = repo.heartbeat(claims[0]!);
    expect(renewed.expiresAt).toBe(now() + 60_000);
    reachStage(repo, claims[2]!, ["analyzing", "tailoring", "compiling", "deterministic_qa", "visual_qa"]);
    repo.transition(claims[2]!, "review");
    repo.release(claims[2]!);
    const thirtyFirst = repo.acquire();
    expect(thirtyFirst?.runId).toBe(runs[30]!.id);
    expect(repo.acquire()).toBeNull();
    expect(new Set([...claims.filter((_, index) => index !== 2), thirtyFirst].map((claim) => claim?.runId)).size).toBe(30);
  });

  test("heartbeat and release require the exact run and token in every claim slot", () => {
    const { repo } = fixture();
    repo.createRun("first");
    repo.createRun("second");
    const first = repo.acquire()!;
    const second = repo.acquire()!;

    expect(() => repo.heartbeat({ runId: first.runId, token: second.token })).toThrow(ClaimRejectedError);
    expect(() => repo.release({ runId: first.runId, token: second.token })).toThrow(ClaimRejectedError);
    expect(repo.heartbeat(first).runId).toBe(first.runId);
    expect(repo.heartbeat(second).runId).toBe(second.runId);

    repo.release(second);
    expect(() => repo.heartbeat(second)).toThrow(ClaimRejectedError);
    expect(repo.heartbeat(first).runId).toBe(first.runId);
  });

  test("recovers an expired non-first-slot claim after cancellation acknowledgement", () => {
    const { repo, tick } = fixture({ alive: true });
    const firstRun = repo.createRun("first");
    const secondRun = repo.createRun("second");
    const first = repo.acquire()!;
    const old = repo.acquire()!;
    expect(first.runId).toBe(firstRun.id);
    expect(old.runId).toBe(secondRun.id);
    repo.transition(old, "analyzing");
    const attempt = repo.startAttempt(old, "analyzing", { processPid: 42, processStartToken: "boot:1" });

    tick(20_000);
    repo.heartbeat(first);
    tick(40_001);
    expect(repo.acquire()).toBeNull();
    expect(repo.timeline(secondRun.id).attempts[0]?.status).toBe("cancel_requested");
    expect(repo.acknowledgeCancellation(attempt.id, "wrong")).toBeFalse();
    expect(repo.acknowledgeCancellation(attempt.id, old.token)).toBeTrue();
    const replacement = repo.acquire();
    expect(replacement?.runId).toBe(secondRun.id);
    expect(replacement?.token).not.toBe(old.token);
    expect(repo.heartbeat(first).runId).toBe(firstRun.id);
  });

  test("reclaims an expired non-first-slot claim after its process is known dead", () => {
    const { repo, tick } = fixture({ alive: false });
    const firstRun = repo.createRun("first");
    const secondRun = repo.createRun("second");
    const first = repo.acquire()!;
    const old = repo.acquire()!;
    expect(first.runId).toBe(firstRun.id);
    expect(old.runId).toBe(secondRun.id);
    repo.transition(old, "analyzing");
    const attempt = repo.startAttempt(old, "analyzing", { processPid: 42, processStartToken: "boot:1" });

    tick(20_000);
    repo.heartbeat(first);
    tick(40_001);
    const replacement = repo.acquire();
    expect(replacement?.runId).toBe(secondRun.id);
    expect(repo.timeline(secondRun.id).attempts.find((item) => item.id === attempt.id)?.status).toBe("cancelled");
    expect(repo.heartbeat(first).runId).toBe(firstRun.id);
  });
});

describe("run listing", () => {
  test("returns the newest bounded window in queue order", () => {
    const { repo } = fixture();
    const ids = Array.from({ length: 10_005 }, (_, index) =>
      repo.createRun(`job-${index + 1}`, `listed-${index + 1}`).id);

    expect(repo.listRuns(3).map(({ id }) => id)).toEqual(ids.slice(-3));
    expect(repo.listRuns().map(({ id }) => id)).toEqual(ids.slice(-10_000));
  });

  test("projects only the latest application session for a requested run set", () => {
    const { repo } = fixture();
    const hash = "9".repeat(64);
    const applyingRunId = createReview(repo, hash, false, "applying-projection");
    const ordinaryRun = repo.createRun("ordinary", "ordinary-projection");
    const firstSessionId = "91919191-9191-4191-8191-919191919191";
    const latestSessionId = "92929292-9292-4292-8292-929292929292";
    repo.approve(applyingRunId, hash);
    repo.reserveApplicationSession(applyingRunId, null, firstSessionId, hash);
    repo.recordApplicationSnapshot(applyingRunId, {
      slotReleased: true,
      generation: 1,
      sessionId: firstSessionId,
      bridgeState: "cancelled",
      publicSnapshot: { state: "cancelled" },
    });
    repo.reserveApplicationSession(
      applyingRunId,
      firstSessionId,
      latestSessionId,
      hash,
    );

    const activeStates = repo.listApplicationSessionStates([applyingRunId, ordinaryRun.id]);
    expect(activeStates.get(applyingRunId)).toMatchObject({ bridgeState: "reserved", generation: 2 });
    expect(activeStates.has(ordinaryRun.id)).toBe(false);

    repo.recordApplicationSnapshot(applyingRunId, {
      slotReleased: true,
      generation: 2,
      sessionId: latestSessionId,
      bridgeState: "failed",
      publicSnapshot: { state: "failed" },
    });

    const failedStates = repo.listApplicationSessionStates([applyingRunId, ordinaryRun.id]);
    expect(failedStates.get(applyingRunId)).toMatchObject({ bridgeState: "failed", generation: 2 });
    expect(repo.listApplicationSessionStates([ordinaryRun.id]).size).toBe(0);
  });
});

describe("application model selection", () => {
  test("uses the configured fallback until an explicit selection persists", () => {
    const { db, repo, now } = fixture();

    expect(repo.getApplicationModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(repo.getApplicationModel("gemini-3.8-flash")).toBe("gemini-3.8-flash");

    expect(repo.setApplicationModel("gemini-3.8-flash")).toBe("gemini-3.8-flash");
    const reopened = new PipelineRepository(db, { now });

    expect(reopened.getApplicationModel("gpt-5.6-sol")).toBe("gemini-3.8-flash");
  });
});

describe("persisted workflow commands", () => {
  test("persists independent immutable run modes and independently managed application status", () => {
    const { db, repo, tick, now } = fixture();
    expect(repo.createRun("Default JD", "default-setting")).toMatchObject({
      generateKeywordMap: true,
      skipReview: false,
      autoSubmit: false,
    });
    const created = repo.createRun("JD", "enabled-setting", true, true, true);
    expect(created).toMatchObject({
      applicationStatus: "pending",
      generateKeywordMap: true,
      skipReview: true,
      autoSubmit: true,
    });
    const eventCount = repo.timeline(created.id).events.length;

    tick(1_000);
    const updated = repo.setApplicationStatus(created.id, "interview");
    const secondRepo = new PipelineRepository(db, { now });

    expect(updated.applicationStatus).toBe("interview");
    expect(repo.getRun(created.id)?.applicationStatus).toBe("interview");
    expect(secondRepo.getRun(created.id)?.applicationStatus).toBe("interview");
    expect(secondRepo.getRun(created.id)).toMatchObject({
      generateKeywordMap: true,
      skipReview: true,
      autoSubmit: true,
    });
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

  test("persists classified opportunity kinds with canonical URLs", () => {
    const { repo } = fixture();
    const legacy = repo.createRun("Legacy JD", "legacy-job-url");
    const jobUrl = "https://jobs.example.test/role?gh_jid=123&source=repository";
    const canonical = repo.createQueuedRun(
      "Canonical JD",
      jobUrl,
      "event",
      {
        manifestSha256: "1".repeat(64),
        baselineSha256: "2".repeat(64),
        sourceHashes: {
          "resume-baseline": "2".repeat(64),
          automated: "3".repeat(64),
          shipment: "5".repeat(64),
          jobhunt: "6".repeat(64),
        },
      },
      {
        sha256: "6".repeat(64),
        path: "/tmp/canonical-job-description.txt",
        byteSize: 12,
      },
      "canonical-job-url",
    );

    expect(canonical).toMatchObject({ jobUrl, opportunityKind: "event" });
    expect(repo.getRun(canonical.id)).toMatchObject({ jobUrl, opportunityKind: "event" });
    expect(legacy).toMatchObject({ opportunityKind: "job" });
    expect(legacy).not.toHaveProperty("jobUrl");
    expect(repo.getRun(legacy.id)).toMatchObject({ opportunityKind: "job" });
    expect(repo.getRun(legacy.id)).not.toHaveProperty("jobUrl");
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

    const successorClaim = repo.acquire();
    expect(successorClaim?.runId).toBe(successor.id);
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
    repo.release(successorClaim!);
    expect(repo.acquire()?.runId).toBe(successor.id);
  });

  test("persists a bounded source snapshot, prevents mutation, and detects source drift", () => {
    const { db, repo } = fixture();
    const run = repo.createRun("JD");
    const snapshot = {
      manifestSha256: "1".repeat(64),
      baselineSha256: "2".repeat(64),
      sourceHashes: { "resume-baseline": "2".repeat(64), "additional-context": "3".repeat(64) },
    };
    expect(repo.attachSourceSnapshot(run.id, snapshot).sourceHashes).toEqual(snapshot.sourceHashes);
    expect(new PipelineRepository(db).getSourceSnapshot(run.id)).toMatchObject(snapshot);
    expect(() => repo.attachSourceSnapshot(run.id, snapshot)).toThrow();
    expect(() => db.query("UPDATE run_source_snapshots SET baseline_sha256=?").run("6".repeat(64))).toThrow();
    repo.assertSourceSnapshot(run.id, { ...snapshot, sourceHashes: { "additional-context": "3".repeat(64), "resume-baseline": "2".repeat(64) } });
    expect(() => repo.assertSourceSnapshot(run.id, {
      ...snapshot, sourceHashes: { ...snapshot.sourceHashes, "additional-context": "6".repeat(64) },
    })).toThrow(SourceDriftError);
    expect(() => repo.assertSourceSnapshot(run.id, {
      ...snapshot, sourceHashes: { "resume-baseline": "2".repeat(64) },
    })).toThrow(SourceDriftError);
  });

  test("accepts the manifest upper bound but rejects invalid or inconsistent provenance", () => {
    const { db, repo } = fixture();
    const run = repo.createRun("JD");
    const baseline = "2".repeat(64);
    const snapshot = { manifestSha256: "1".repeat(64), baselineSha256: baseline, sourceHashes: { "resume-baseline": baseline } };
    const invalid = [
      { ...snapshot, sourceHashes: {} },
      { ...snapshot, sourceHashes: { "other-source": baseline } },
      { ...snapshot, sourceHashes: { "resume-baseline": "3".repeat(64) } },
      { ...snapshot, sourceHashes: Object.assign(Object.create({ "resume-baseline": baseline }), { additional: "3".repeat(64) }) },
      { ...snapshot, sourceHashes: { ...snapshot.sourceHashes, "Bad-ID": "3".repeat(64) } },
      { ...snapshot, sourceHashes: { ...snapshot.sourceHashes, ["x".repeat(81)]: "3".repeat(64) } },
      { ...snapshot, sourceHashes: { ...snapshot.sourceHashes, additional: "A".repeat(64) } },
      { ...snapshot, manifestSha256: "A".repeat(64) },
      { ...snapshot, sourceHashes: { ...snapshot.sourceHashes, ...Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`source-${index}`, "3".repeat(64)]),
      ) } },
    ];
    for (const candidate of invalid) expect(() => repo.attachSourceSnapshot(run.id, candidate)).toThrow();
    expect(repo.getSourceSnapshot(run.id)).toBeNull();
    const atLimit = { ...snapshot, sourceHashes: { ...snapshot.sourceHashes, ...Object.fromEntries(
      Array.from({ length: 19 }, (_, index) => [`source-${index}`, "3".repeat(64)]),
    ) } };
    repo.attachSourceSnapshot(run.id, atLimit);
    expect(new PipelineRepository(db).getSourceSnapshot(run.id)).toMatchObject(atLimit);
  });

  test("changed resume sources restart a failed run without inheriting its old draft", () => {
    const { repo } = fixture();
    const run = repo.createRun("Original job description");
    const originalSources = {
      manifestSha256: "1".repeat(64),
      baselineSha256: "2".repeat(64),
      sourceHashes: { "resume-baseline": "2".repeat(64), automated: "3".repeat(64), shipment: "4".repeat(64), jobhunt: "5".repeat(64) },
    };
    repo.attachSourceSnapshot(run.id, originalSources);
    const claim = repo.acquire()!;
    reachStage(repo, claim, ["analyzing", "tailoring"]);
    const attempt = repo.startAttempt(claim, "tailoring");
    const oldDraft = repo.finalizeArtifact(claim, {
      attemptId: attempt.id, stage: "tailoring", kind: "tailored-tex",
      sha256: "6".repeat(64), path: "/tmp/old-draft.tex", byteSize: 1,
    });
    repo.finishAttempt(claim, attempt.id, "succeeded");
    repo.transition(claim, "compiling");
    repo.transition(claim, "failed", { failedStage: "compiling" });
    repo.release(claim);

    const currentSources = {
      ...originalSources,
      baselineSha256: "9".repeat(64),
      sourceHashes: { ...originalSources.sourceHashes, "resume-baseline": "9".repeat(64) },
    };
    const retried = repo.retry(run.id, currentSources);

    expect(retried).toMatchObject({ status: "analyzing", currentRevision: 2, jobDescription: "Original job description" });
    expect(repo.getArtifact(run.id, "tailored-tex")).toBeNull();
    expect(repo.getArtifact(run.id, "tailored-tex", 1)?.id).toBe(oldDraft.id);
    expect(repo.getSourceSnapshot(run.id, 1)?.baselineSha256).toBe("2".repeat(64));
    expect(repo.getSourceSnapshot(run.id)?.baselineSha256).toBe("9".repeat(64));
    expect(() => repo.assertSourceSnapshot(run.id, originalSources)).toThrow(SourceDriftError);
  });

  test("fresh-source retries discard obsolete edit ancestry across later retries", () => {
    const { repo } = fixture();
    const run = repo.createRun("JD");
    const originalSources = {
      manifestSha256: "1".repeat(64), baselineSha256: "2".repeat(64),
      sourceHashes: { "resume-baseline": "2".repeat(64), automated: "3".repeat(64), shipment: "4".repeat(64), jobhunt: "5".repeat(64) },
    };
    repo.attachSourceSnapshot(run.id, originalSources);
    const reviewClaim = repo.acquire()!;
    reachStage(repo, reviewClaim, ["analyzing", "tailoring", "compiling", "deterministic_qa", "visual_qa"]);
    const review = repo.startAttempt(reviewClaim, "visual_qa");
    const pdfHash = "6".repeat(64);
    repo.finalizeArtifact(reviewClaim, { attemptId: review.id, stage: "visual_qa", kind: "compiled-pdf", sha256: pdfHash, path: "/tmp/review.pdf", byteSize: 1 });
    repo.finishAttempt(reviewClaim, review.id, "succeeded");
    repo.transition(reviewClaim, "review");
    repo.release(reviewClaim);

    repo.editRun(run.id, "Edit the old resume", pdfHash);
    const editClaim = repo.acquire()!;
    const edit = repo.startAttempt(editClaim, "editing");
    const editReport = repo.finalizeArtifact(editClaim, { attemptId: edit.id, stage: "editing", kind: "edit-report", sha256: "7".repeat(64), path: "/tmp/edit-report.json", byteSize: 1 });
    repo.finishAttempt(editClaim, edit.id, "succeeded");
    repo.transition(editClaim, "compiling");
    repo.transition(editClaim, "failed", { failedStage: "compiling" });
    repo.release(editClaim);

    const currentSources = {
      ...originalSources, baselineSha256: "9".repeat(64),
      sourceHashes: { ...originalSources.sourceHashes, "resume-baseline": "9".repeat(64) },
    };
    repo.retry(run.id, currentSources);
    expect(repo.resolveRevisionOrigin(run.id, 3)).toBe("initial");
    expect(repo.getEditRequest(run.id)).toBeNull();
    const freshClaim = repo.acquire()!;
    repo.transition(freshClaim, "tailoring");
    const tailoring = repo.startAttempt(freshClaim, "tailoring");
    const freshDraft = repo.finalizeArtifact(freshClaim, { attemptId: tailoring.id, stage: "tailoring", kind: "tailored-tex", sha256: "a".repeat(64), path: "/tmp/fresh-draft.tex", byteSize: 1 });
    repo.finishAttempt(freshClaim, tailoring.id, "succeeded");
    repo.transition(freshClaim, "compiling");
    repo.transition(freshClaim, "failed", { failedStage: "compiling" });
    repo.release(freshClaim);

    expect(repo.retry(run.id, currentSources)).toMatchObject({ currentRevision: 4, status: "compiling" });
    expect(repo.getArtifact(run.id, "tailored-tex")?.id).toBe(freshDraft.id);
    expect(repo.getArtifact(run.id, "edit-report")).toBeNull();
    expect(repo.getEditRequest(run.id)).toBeNull();
    expect(repo.resolveRevisionOrigin(run.id, 4)).toBe("initial");
    expect(repo.getArtifact(run.id, "edit-report", 2)?.id).toBe(editReport.id);
    expect(repo.getEditRequest(run.id, 2)?.comments).toBe("Edit the old resume");
    expect(repo.getSourceSnapshot(run.id, 4)?.baselineSha256).toBe("9".repeat(64));
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

  test("approved human edits reopen only the artifact used by the latest cancelled application session", () => {
    const { repo } = fixture();
    const hash = "2".repeat(64);
    const runId = createReview(repo, hash, false, "cancelled-application-edit");
    const sessionId = "01010101-0101-4101-8101-010101010101";
    repo.approve(runId, hash);
    repo.reserveApplicationSession(runId, null, sessionId, hash);
    repo.recordApplicationSnapshot(runId, {
      slotReleased: true,
      generation: 1,
      sessionId,
      bridgeState: "cancelled",
      publicSnapshot: { state: "cancelled" },
    });

    const edited = repo.editRun(runId, "Tailor the summary to the reopened application.", hash);

    expect(edited).toMatchObject({
      status: "editing",
      currentRevision: 2,
      approvedPdfSha256: null,
    });
    expect(repo.getRevision(runId, 2)).toMatchObject({
      origin: "human_edit",
      source_revision: 1,
      status: "editing",
    });
    expect(repo.getEditRequest(runId, 2)).toMatchObject({
      sourceRevision: 1,
      targetRevision: 2,
      origin: "human_edit",
      comments: "Tailor the summary to the reopened application.",
      expectedPdfSha256: hash,
    });
    expect(repo.getLatestApplicationSession(runId)).toMatchObject({
      sessionId,
      resumeRevision: 1,
      pdfSha256: hash,
      bridgeState: "cancelled",
    });
  });

  test("approved human edits require a cancelled latest application session", () => {
    const latestStates = [null, "failed", "closed", "lost"] as const;

    for (const [index, latestState] of latestStates.entries()) {
      const { repo } = fixture();
      const hash = "3".repeat(64);
      const runId = createReview(repo, hash, false, `approved-edit-${latestState ?? "missing"}`);
      repo.approve(runId, hash);

      if (latestState !== null) {
        const cancelledSessionId =
          `02020202-0202-4202-8202-${String(index * 2 + 1).padStart(12, "0")}`;
        const latestSessionId =
          `02020202-0202-4202-8202-${String(index * 2 + 2).padStart(12, "0")}`;
        repo.reserveApplicationSession(runId, null, cancelledSessionId, hash);
        repo.recordApplicationSnapshot(runId, {
          slotReleased: true,
          generation: 1,
          sessionId: cancelledSessionId,
          bridgeState: "cancelled",
          publicSnapshot: { state: "cancelled" },
        });
        repo.reserveApplicationSession(runId, cancelledSessionId, latestSessionId, hash);
        if (latestState === "lost") {
          repo.recordApplicationSnapshot(runId, {
            slotReleased: false,
            generation: 2,
            sessionId: latestSessionId,
            bridgeState: "running",
            publicSnapshot: { state: "running" },
          });
          repo.markApplicationSessionLost(runId, {
            generation: 2,
            sessionId: latestSessionId,
            publicSnapshot: { state: "lost" },
          });
        } else {
          repo.recordApplicationSnapshot(runId, {
            slotReleased: true,
            generation: 2,
            sessionId: latestSessionId,
            bridgeState: latestState,
            publicSnapshot: { state: latestState },
          });
        }
      }

      expect(() => repo.editRun(runId, "This edit must remain blocked.", hash))
        .toThrow(RepositoryConflictError);
      expect(repo.getRun(runId)).toMatchObject({
        status: "approved",
        currentRevision: 1,
        approvedPdfSha256: hash,
      });
      expect(repo.getRevision(runId, 2)).toBeNull();
      expect(repo.getEditRequest(runId, 2)).toBeNull();
    }
  });

  test("approved human edits reject cancelled sessions for a different revision or PDF", () => {
    {
      const { db, repo } = fixture();
      const firstHash = "4".repeat(64);
      const approvedHash = "5".repeat(64);
      const runId = createReview(repo, firstHash, false, "cancelled-edit-revision-mismatch");
      repo.editRun(runId, "Create the second review revision.", firstHash);
      const claim = repo.acquire()!;
      reachStage(repo, claim, ["compiling", "deterministic_qa", "visual_qa"]);
      const attempt = repo.startAttempt(claim, "visual_qa");
      repo.finalizeArtifact(claim, {
        attemptId: attempt.id,
        stage: "visual_qa",
        kind: "compiled-pdf",
        sha256: approvedHash,
        path: `/tmp/${runId}-revision-2.pdf`,
        byteSize: 10,
      });
      repo.finishAttempt(claim, attempt.id, "succeeded");
      repo.transition(claim, "review");
      repo.release(claim);
      repo.approve(runId, approvedHash);
      const sessionId = "03030303-0303-4303-8303-030303030301";
      repo.reserveApplicationSession(runId, null, sessionId, approvedHash);
      repo.recordApplicationSnapshot(runId, {
        slotReleased: true,
        generation: 1,
        sessionId,
        bridgeState: "cancelled",
        publicSnapshot: { state: "cancelled" },
      });
      db.query("UPDATE run_application_sessions SET resume_revision=1 WHERE session_id=?").run(sessionId);

      expect(() => repo.editRun(runId, "Reject the stale session revision.", approvedHash))
        .toThrow(RepositoryConflictError);
      expect(repo.getRun(runId)).toMatchObject({
        status: "approved",
        currentRevision: 2,
        approvedPdfSha256: approvedHash,
      });
      expect(repo.getRevision(runId, 3)).toBeNull();
      expect(repo.getEditRequest(runId, 3)).toBeNull();
    }

    {
      const { db, repo } = fixture();
      const hash = "6".repeat(64);
      const runId = createReview(repo, hash, false, "cancelled-edit-hash-mismatch");
      const sessionId = "03030303-0303-4303-8303-030303030302";
      repo.approve(runId, hash);
      repo.reserveApplicationSession(runId, null, sessionId, hash);
      repo.recordApplicationSnapshot(runId, {
        slotReleased: true,
        generation: 1,
        sessionId,
        bridgeState: "cancelled",
        publicSnapshot: { state: "cancelled" },
      });
      db.query("UPDATE run_application_sessions SET pdf_sha256=? WHERE session_id=?")
        .run("7".repeat(64), sessionId);

      expect(() => repo.editRun(runId, "Reject the stale session PDF.", hash))
        .toThrow(RepositoryConflictError);
      expect(repo.getRun(runId)).toMatchObject({
        status: "approved",
        currentRevision: 1,
        approvedPdfSha256: hash,
      });
      expect(repo.getRevision(runId, 2)).toBeNull();
      expect(repo.getEditRequest(runId, 2)).toBeNull();
    }
  });

  test("machine regeneration remains blocked after a matching application cancellation", () => {
    const { repo } = fixture();
    const hash = "8".repeat(64);
    const runId = createReview(repo, hash, false, "cancelled-application-regenerate");
    const sessionId = "04040404-0404-4404-8404-040404040404";
    repo.approve(runId, hash);
    repo.reserveApplicationSession(runId, null, sessionId, hash);
    repo.recordApplicationSnapshot(runId, {
      slotReleased: true,
      generation: 1,
      sessionId,
      bridgeState: "cancelled",
      publicSnapshot: { state: "cancelled" },
    });

    expect(() => repo.regenerate(runId, hash)).toThrow(RepositoryConflictError);
    expect(repo.getRun(runId)).toMatchObject({
      status: "approved",
      currentRevision: 1,
      approvedPdfSha256: hash,
    });
    expect(repo.getRevision(runId, 2)).toBeNull();
    expect(repo.getEditRequest(runId, 2)).toBeNull();
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

  test("claim-fenced clean visual completion approves atomically with ordinary automatic evidence", () => {
    const { db, repo } = fixture();
    const hash = "6".repeat(64);
    const run = repo.createRun("JD", "automatic-approval", false, true, false);
    const claim = repo.acquire()!;
    reachStage(repo, claim, ["analyzing", "tailoring", "compiling", "deterministic_qa", "visual_qa"]);
    const attempt = repo.startAttempt(claim, "visual_qa");
    repo.finalizeArtifact(claim, {
      attemptId: attempt.id,
      stage: "visual_qa",
      kind: "compiled-pdf",
      sha256: hash,
      path: "/tmp/automatic-approval.pdf",
      byteSize: 10,
    });
    repo.finishAttempt(claim, attempt.id, "succeeded");

    expect(() => repo.completeVisualQa(
      { runId: run.id, token: "not-the-live-token" },
      hash,
      false,
    )).toThrow(ClaimRejectedError);
    const approved = repo.completeVisualQa(claim, hash, false);

    expect(approved).toMatchObject({
      status: "approved",
      approvedPdfSha256: hash,
      visualAcknowledgementRequired: false,
    });
    expect(db.query<{ run_status: string; revision_status: string; approved_pdf_sha256: string }, []>(`
      SELECT runs.status AS run_status, revisions.status AS revision_status, runs.approved_pdf_sha256
      FROM runs
      JOIN revisions ON revisions.run_id = runs.id AND revisions.revision = runs.current_revision
      WHERE runs.id = 'automatic-approval'
    `).get()).toEqual({
      run_status: "approved",
      revision_status: "approved",
      approved_pdf_sha256: hash,
    });
    expect(repo.timeline(run.id).events.at(-1)).toMatchObject({
      kind: "run.approved",
      revision: 1,
      payload: {
        pdfSha256: hash,
        visualAcknowledged: false,
        automatic: true,
      },
    });
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
      submissionPhase: "not_attempted",
      slotReleased: false,
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

  test("reserves eight application browser slots and reuses a released slot", () => {
    const { repo } = fixture();
    const hash = "4".repeat(64);
    const runIds = Array.from({ length: 9 }, (_, index) => {
      const runId = createReview(repo, hash, false, "capacity-run-" + (index + 1));
      repo.approve(runId, hash);
      return runId;
    });
    const sessionIds = [
      "41414141-4141-4141-8141-414141414141",
      "42424242-4242-4242-8242-424242424242",
      "43434343-4343-4343-8343-434343434343",
      "44444444-4444-4444-8444-444444444444",
      "45454545-4545-4545-8545-454545454545",
      "46464646-4646-4646-8646-464646464646",
      "47474747-4747-4747-8747-474747474747",
      "48484848-4848-4848-8848-484848484848",
      "49494949-4949-4949-8949-494949494949",
    ] as const;

    for (let index = 0; index < 8; index += 1) {
      repo.reserveApplicationSession(runIds[index]!, null, sessionIds[index]!, hash);
    }
    expect(repo.getUnreleasedApplicationSessions().map((session) => session.sessionId)).toEqual(
      sessionIds.slice(0, 8),
    );
    expect(() => repo.reserveApplicationSession(
      runIds[8]!,
      null,
      sessionIds[8],
      hash,
    )).toThrow(/capacity/i);

    repo.recordApplicationSnapshot(runIds[1]!, {
      generation: 1,
      sessionId: sessionIds[1],
      bridgeState: "closed",
      publicSnapshot: { state: "closed" },
      slotReleased: true,
    });
    expect(repo.reserveApplicationSession(
      runIds[8]!,
      null,
      sessionIds[8],
      hash,
    )).toMatchObject({ slotReleased: false });
    expect(repo.getUnreleasedApplicationSessions().map((session) => session.sessionId)).toEqual([
      sessionIds[0],
      ...sessionIds.slice(2),
    ]);
  });

  test("does not supersede a terminal session before its browser slot is released", () => {
    const { repo } = fixture();
    const hash = "8".repeat(64);
    const runId = createReview(repo, hash, false, "terminal-cleanup");
    repo.approve(runId, hash);
    const firstSessionId = "46464646-4646-4646-8646-464646464646";
    const nextSessionId = "47474747-4747-4747-8747-474747474747";
    repo.reserveApplicationSession(runId, null, firstSessionId, hash);
    repo.recordApplicationSnapshot(runId, {
      generation: 1,
      sessionId: firstSessionId,
      bridgeState: "closed",
      publicSnapshot: { state: "closed" },
      slotReleased: false,
    });

    expect(() => repo.reserveApplicationSession(
      runId,
      firstSessionId,
      nextSessionId,
      hash,
    )).toThrow(/slot is not released/);

    repo.releaseApplicationSessionSlot(runId, 1, firstSessionId);
    expect(repo.reserveApplicationSession(
      runId,
      firstSessionId,
      nextSessionId,
      hash,
    )).toMatchObject({ generation: 2, sessionId: nextSessionId });
  });
  test("abandons only an untouched application reservation", () => {
    const { repo } = fixture();
    const hash = "6".repeat(64);
    const runId = createReview(repo, hash, false, "abandoned-reservation");
    repo.approve(runId, hash);
    const sessionId = "45454545-4545-4545-8545-454545454545";
    const reserved = repo.reserveApplicationSession(runId, null, sessionId, hash);

    repo.abandonApplicationSessionReservation(
      runId,
      reserved.generation,
      sessionId,
    );

    expect(repo.getLatestApplicationSession(runId)).toMatchObject({
      generation: 1,
      sessionId,
      bridgeState: "closed",
      slotReleased: true,
      publicSnapshot: null,
    });
    expect(repo.getUnreleasedApplicationSessions()).toEqual([]);
    expect(() => repo.abandonApplicationSessionReservation(
      runId,
      reserved.generation,
      sessionId,
    )).toThrow(/reservation changed/);
  });

  test("selects automatic applications while fewer than eight browser slots are live", () => {
    const { repo } = fixture();
    const hash = "5".repeat(64);
    const manualRunId = createReview(repo, hash, false, "manual-approved");
    repo.approve(manualRunId, hash);

    const createAutomaticApproval = (
      id: string,
      autoSubmit: boolean,
      includeTailoredSource = true,
    ): string => {
      const run = repo.createRun("JD", id, false, true, autoSubmit);
      const claim = repo.acquire()!;
      expect(claim.runId).toBe(run.id);
      reachStage(repo, claim, ["analyzing", "tailoring", "compiling", "deterministic_qa", "visual_qa"]);
      const attempt = repo.startAttempt(claim, "visual_qa");
      repo.finalizeArtifact(claim, {
        attemptId: attempt.id,
        stage: "visual_qa",
        kind: "compiled-pdf",
        sha256: hash,
        path: "/tmp/" + id + ".pdf",
        byteSize: 10,
      });
      if (includeTailoredSource) {
        repo.finalizeArtifact(claim, {
          attemptId: attempt.id,
          stage: "visual_qa",
          kind: "tailored-tex",
          sha256: "a".repeat(64),
          path: "/tmp/" + id + ".tex",
          byteSize: 10,
        });
      }
      repo.finishAttempt(claim, attempt.id, "succeeded");
      repo.completeVisualQa(claim, hash, false);
      repo.release(claim);
      return run.id;
    };
    createAutomaticApproval("automatic-missing-source", false, false);
    const oldest = createAutomaticApproval("automatic-oldest", false);
    const next = createAutomaticApproval("automatic-next", true);
    const third = createAutomaticApproval("automatic-third", false);
    const last = createAutomaticApproval("automatic-last", false);

    expect(repo.getNextAutomaticApplicationStart()?.runId).toBe(oldest);

    const manualSessionId = "12121212-1212-4212-8212-121212121212";
    repo.reserveApplicationSession(manualRunId, null, manualSessionId, hash);
    for (let index = 0; index < 5; index += 1) {
      const runId = createReview(repo, hash, false, "extra-manual-" + index);
      repo.approve(runId, hash);
      repo.reserveApplicationSession(
        runId,
        null,
        "10000000-0000-4000-8000-00000000000" + index,
        hash,
      );
    }
    expect(repo.getNextAutomaticApplicationStart()?.runId).toBe(oldest);

    const oldestSessionId = "13131313-1313-4313-8313-131313131313";
    repo.reserveApplicationSession(oldest, null, oldestSessionId, hash);
    expect(repo.getNextAutomaticApplicationStart()?.runId).toBe(next);

    const nextSessionId = "14141414-1414-4414-8414-141414141414";
    repo.reserveApplicationSession(next, null, nextSessionId, hash);
    expect(repo.getNextAutomaticApplicationStart()).toBeNull();

    repo.recordApplicationSnapshot(manualRunId, {
      generation: 1,
      sessionId: manualSessionId,
      bridgeState: "closed",
      publicSnapshot: { state: "closed" },
      slotReleased: true,
    });
    expect(repo.getNextAutomaticApplicationStart()?.runId).toBe(third);

    const thirdSessionId = "15151515-1515-4515-8515-151515151515";
    repo.reserveApplicationSession(third, null, thirdSessionId, hash);
    expect(repo.getNextAutomaticApplicationStart()).toBeNull();

    repo.recordApplicationSnapshot(oldest, {
      generation: 1,
      sessionId: oldestSessionId,
      bridgeState: "closed",
      publicSnapshot: { state: "closed" },
      slotReleased: true,
    });
    expect(repo.getNextAutomaticApplicationStart()?.runId).toBe(last);

    repo.deleteRun(last);
    expect(repo.getNextAutomaticApplicationStart()).toBeNull();
  });

  test("selects an approved edited skip-review revision after its older session is closed", () => {
    const { repo } = fixture();
    const originalHash = "5".repeat(64);
    const editedHash = "6".repeat(64);
    const run = repo.createRun("JD", "automatic-edited", false, true, false);
    const originalClaim = repo.acquire()!;
    reachStage(repo, originalClaim, [
      "analyzing",
      "tailoring",
      "compiling",
      "deterministic_qa",
      "visual_qa",
    ]);
    const originalAttempt = repo.startAttempt(originalClaim, "visual_qa");
    repo.finalizeArtifact(originalClaim, {
      attemptId: originalAttempt.id,
      stage: "visual_qa",
      kind: "compiled-pdf",
      sha256: originalHash,
      path: "/tmp/automatic-edited-original.pdf",
      byteSize: 10,
    });
    repo.finishAttempt(originalClaim, originalAttempt.id, "succeeded");
    repo.completeVisualQa(originalClaim, originalHash, false);
    repo.release(originalClaim);

    const originalSessionId = "14141414-1414-4414-8414-141414141414";
    repo.reserveApplicationSession(run.id, null, originalSessionId, originalHash);
    repo.recordApplicationSnapshot(run.id, {
      slotReleased: true,
      generation: 1,
      sessionId: originalSessionId,
      bridgeState: "cancelled",
      publicSnapshot: { state: "cancelled" },
    });
    repo.editRun(run.id, "Emphasize platform ownership.", originalHash);
    repo.recordApplicationSnapshot(run.id, {
      slotReleased: true,
      generation: 1,
      sessionId: originalSessionId,
      bridgeState: "closed",
      publicSnapshot: { state: "closed" },
    });

    const editedClaim = repo.acquire()!;
    expect(editedClaim.runId).toBe(run.id);
    reachStage(repo, editedClaim, ["compiling", "deterministic_qa", "visual_qa"]);
    const editedAttempt = repo.startAttempt(editedClaim, "visual_qa");
    repo.finalizeArtifact(editedClaim, {
      attemptId: editedAttempt.id,
      stage: "visual_qa",
      kind: "compiled-pdf",
      sha256: editedHash,
      path: "/tmp/automatic-edited-revision-2.pdf",
      byteSize: 10,
    });
    repo.finalizeArtifact(editedClaim, {
      attemptId: editedAttempt.id,
      stage: "visual_qa",
      kind: "tailored-tex",
      sha256: "a".repeat(64),
      path: "/tmp/automatic-edited-revision-2.tex",
      byteSize: 10,
    });
    repo.finishAttempt(editedClaim, editedAttempt.id, "succeeded");
    repo.completeVisualQa(editedClaim, editedHash, false);
    repo.release(editedClaim);

    const blockerHash = "7".repeat(64);
    const blockerRunId = createReview(repo, blockerHash, false, "manual-blocker");
    repo.approve(blockerRunId, blockerHash);
    const blockerSessionId = "15151515-1515-4515-8515-151515151515";
    repo.reserveApplicationSession(blockerRunId, null, blockerSessionId, blockerHash);
    expect(repo.getNextAutomaticApplicationStart()).toEqual({
      runId: run.id,
      approvedPdfSha256: editedHash,
    });
    repo.recordApplicationSnapshot(blockerRunId, {
      slotReleased: true,
      generation: 1,
      sessionId: blockerSessionId,
      bridgeState: "closed",
      publicSnapshot: { state: "closed" },
    });

    expect(repo.getNextAutomaticApplicationStart()).toEqual({
      runId: run.id,
      approvedPdfSha256: editedHash,
    });
  });

  test("claims before submission and finalizes one durable outcome atomically", () => {
    const { db, repo, tick } = fixture();
    const hash = "8".repeat(64);
    const runId = createReview(repo, hash);
    repo.approve(runId, hash);
    const sessionId = "22222222-2222-4222-8222-222222222222";
    repo.reserveApplicationSession(runId, null, sessionId, hash);
    repo.recordApplicationSnapshot(runId, {
      slotReleased: false,
      generation: 1,
      sessionId,
      bridgeState: "awaiting_human_review",
      publicSnapshot: { state: "awaiting_human_review" },
    });
    expect(repo.getRun(runId)?.applicationStatus).toBe("pending");

    repo.claimApplicationSubmission(sessionId);

    expect(db.query<{
      bridge_state: string;
      submission_phase: string;
      submission_attempted_at: number | null;
      submission_confirmed_at: number | null;
    }, [string]>(`
      SELECT bridge_state, submission_phase, submission_attempted_at,
             submission_confirmed_at
      FROM run_application_sessions
      WHERE session_id = ?
    `).get(sessionId)).toEqual({
      bridge_state: "awaiting_human_review",
      submission_phase: "attempting",
      submission_attempted_at: 1_000,
      submission_confirmed_at: null,
    });
    expect(() => repo.claimApplicationSubmission(sessionId)).toThrow(/already claimed/);
    tick(25);

    repo.finalizeApplicationSubmission(sessionId, "submitted");

    const finalized = db.query<{
      submission_phase: string;
      submission_attempted_at: number;
      submission_confirmed_at: number | null;
    }, [string]>(`
      SELECT submission_phase, submission_attempted_at, submission_confirmed_at
      FROM run_application_sessions
      WHERE session_id = ?
    `).get(sessionId);
    expect(finalized).toEqual({
      submission_phase: "submitted",
      submission_attempted_at: 1_000,
      submission_confirmed_at: 1_025,
    });
    expect(repo.getRun(runId)?.applicationStatus).toBe("applied");
    repo.finalizeApplicationSubmission(sessionId, "submitted");
    expect(db.query<{
      submission_confirmed_at: number;
    }, [string]>(
      "SELECT submission_confirmed_at FROM run_application_sessions WHERE session_id = ?",
    ).get(sessionId)?.submission_confirmed_at).toBe(1_025);
    expect(() => repo.finalizeApplicationSubmission(sessionId, "uncertain"))
      .toThrow(/conflicting submission outcome/);
  });

  test("rejects claims without durable review readiness", () => {
    const { repo } = fixture();
    const hash = "d".repeat(64);
    const states = [
      { bridgeState: "running", expectedError: /not review-ready/ },
      { bridgeState: "cancelled", expectedError: /terminal/ },
    ] as const;
    for (const [index, { bridgeState, expectedError }] of states.entries()) {
      const runId = createReview(repo, hash, false, `claim-state-${bridgeState}`);
      repo.approve(runId, hash);
      const sessionId =
        `50505050-5050-4050-8050-${String(index + 1).padStart(12, "0")}`;
      repo.reserveApplicationSession(runId, null, sessionId, hash);
      repo.recordApplicationSnapshot(runId, {
        slotReleased: bridgeState === "cancelled",
        generation: 1,
        sessionId,
        bridgeState,
        publicSnapshot: { state: bridgeState },
      });

      expect(() => repo.claimApplicationSubmission(sessionId))
        .toThrow(expectedError);
      expect(repo.getLatestApplicationSession(runId)).toMatchObject({
        bridgeState,
        submissionPhase: "not_attempted",
      });
      if (bridgeState === "running") {
        repo.recordApplicationSnapshot(runId, {
          slotReleased: true,
          generation: 1,
          sessionId,
          bridgeState: "closed",
          publicSnapshot: { state: "closed" },
        });
      }
    }
  });

  test("claims after durable automatic review authorization without relaxing bridge state", () => {
    const { repo } = fixture();
    const hash = "a".repeat(64);
    const runId = createReview(repo, hash, false, "automatic-review-ready");
    repo.approve(runId, hash);
    const sessionId = "60606060-6060-4060-8060-000000000001";
    repo.reserveApplicationSession(runId, null, sessionId, hash);
    repo.recordApplicationSnapshot(runId, {
      slotReleased: false,
      generation: 1,
      sessionId,
      bridgeState: "running",
      publicSnapshot: { state: "running" },
    });

    repo.markAutomaticApplicationReviewReady(sessionId);
    expect(repo.getLatestApplicationSession(runId)).toMatchObject({
      bridgeState: "running",
      submissionPhase: "not_attempted",
    });
    repo.claimApplicationSubmission(sessionId);
    expect(repo.getLatestApplicationSession(runId)).toMatchObject({
      bridgeState: "running",
      submissionPhase: "attempting",
    });
    expect(() => repo.markAutomaticApplicationReviewReady(sessionId))
      .toThrow(/already claimed/);
  });

  test("automatic review authorization cannot claim a terminal session", () => {
    const { repo } = fixture();
    const hash = "b".repeat(64);
    const runId = createReview(repo, hash, false, "automatic-review-cancelled");
    repo.approve(runId, hash);
    const sessionId = "60606060-6060-4060-8060-000000000002";
    repo.reserveApplicationSession(runId, null, sessionId, hash);
    repo.markAutomaticApplicationReviewReady(sessionId);
    repo.recordApplicationSnapshot(runId, {
      slotReleased: true,
      generation: 1,
      sessionId,
      bridgeState: "cancelled",
      publicSnapshot: { state: "cancelled" },
    });

    expect(() => repo.claimApplicationSubmission(sessionId)).toThrow(/terminal/);
    expect(repo.getLatestApplicationSession(runId)).toMatchObject({
      bridgeState: "cancelled",
      submissionPhase: "not_attempted",
    });
  });

  test("submitted finalization advances eligible lifecycles while uncertainty preserves the prior status", () => {
    const { repo } = fixture();
    const hash = "c".repeat(64);
    const cases = [
      ["pending", "submitted", "applied"],
      ["did_not_apply", "submitted", "applied"],
      ["failed", "submitted", "applied"],
      ["applied", "submitted", "applied"],
      ["oa_received", "submitted", "oa_received"],
      ["oa_completed", "submitted", "oa_completed"],
      ["rejected", "submitted", "rejected"],
      ["interview", "submitted", "interview"],
      ["accepted", "submitted", "accepted"],
      ["pending", "uncertain", "pending"],
      ["did_not_apply", "uncertain", "did_not_apply"],
    ] as const;
    for (const [index, [before, outcome, expected]] of cases.entries()) {
      const runId = createReview(repo, hash, false, `final-status-${index}`);
      repo.approve(runId, hash);
      repo.setApplicationStatus(runId, before);
      const sessionId =
        `60606060-6060-4060-8060-${String(index + 1).padStart(12, "0")}`;
      repo.reserveApplicationSession(runId, null, sessionId, hash);
      recordApplicationReview(repo, runId, sessionId);
      repo.claimApplicationSubmission(sessionId);
      repo.finalizeApplicationSubmission(sessionId, outcome);
      expect(repo.getRun(runId)?.applicationStatus).toBe(expected);
      repo.recordApplicationSnapshot(runId, {
        slotReleased: true,
        generation: 1,
        sessionId,
        bridgeState: "closed",
        publicSnapshot: { state: "closed" },
      });
    }
  });

  test("final submission phases reject regression but permit explicit browser close", () => {
    const { repo } = fixture();
    const hash = "e".repeat(64);
    for (const [index, outcome] of (["submitted", "uncertain"] as const).entries()) {
      const runId = createReview(repo, hash, false, `final-regression-${outcome}`);
      repo.approve(runId, hash);
      const sessionId =
        `70707070-7070-4070-8070-${String(index + 1).padStart(12, "0")}`;
      repo.reserveApplicationSession(runId, null, sessionId, hash);
      recordApplicationReview(repo, runId, sessionId);
      repo.claimApplicationSubmission(sessionId);
      repo.finalizeApplicationSubmission(sessionId, outcome);
      const finalState = outcome === "submitted" ? "submitted" : "submission_uncertain";
      repo.recordApplicationSnapshot(runId, {
        slotReleased: false,
        generation: 1,
        sessionId,
        bridgeState: finalState,
        publicSnapshot: { state: finalState },
      });

      expect(() => repo.recordApplicationSnapshot(runId, {
        slotReleased: false,
        generation: 1,
        sessionId,
        bridgeState: "running",
        publicSnapshot: { state: "running" },
      })).toThrow(/submission phase/);
      const closed = repo.recordApplicationSnapshot(runId, {
        slotReleased: true,
        generation: 1,
        sessionId,
        bridgeState: "closed",
        publicSnapshot: { state: "closed" },
      });
      expect(closed).toMatchObject({
        bridgeState: "closed",
        submissionPhase: outcome,
      });
    }
  });

  test("reconciles every interrupted attempt to retained uncertainty before retry", () => {
    const { db, repo, tick } = fixture();
    const hash = "b".repeat(64);
    const sessionIds = [
      "90909090-9090-4090-8090-909090909090",
      "91919191-9191-4191-8191-919191919191",
    ] as const;
    for (const [index, sessionId] of sessionIds.entries()) {
      const runId = createReview(repo, hash, false, `reconcile-${index}`);
      repo.approve(runId, hash);
      repo.reserveApplicationSession(runId, null, sessionId, hash);
      if (index === 0) {
        repo.recordApplicationSnapshot(runId, {
          slotReleased: false,
          generation: 1,
          sessionId,
          bridgeState: "awaiting_human_review",
          publicSnapshot: {
            generation: 1,
            bridgeState: "awaiting_human_review",
            harnessState: "awaiting_human_review",
            submissionPhase: "not_attempted",
            createdAt: 1_000,
            updatedAt: 1_001,
            terminalAt: null,
            expiresAt: 9_000,
            company: "Example",
            role: "Engineer",
            fieldsFilled: [],
            fieldsNeedingHuman: [],
            filesAttached: ["resume.pdf"],
            warnings: [SUBMISSION_UNCERTAIN_WARNING, "Review changed"],
            revisionCount: 1,
            pendingAction: { type: "human_review" },
            error: null,
          },
        });
      } else {
        recordApplicationReview(repo, runId, sessionId);
      }
      repo.claimApplicationSubmission(sessionId);
      if (index === 1) {
        db.query(
          "UPDATE run_application_sessions SET public_snapshot_json = NULL WHERE session_id = ?",
        ).run(sessionId);
      }
      repo.releaseApplicationSessionSlot(runId, 1, sessionId);
    }
    tick(25);

    expect(repo.reconcileAttemptingApplicationSubmissions()).toBe(2);
    expect(repo.reconcileAttemptingApplicationSubmissions()).toBe(0);

    for (const [index, sessionId] of sessionIds.entries()) {
      const runId = `reconcile-${index}`;
      const reconciled = repo.getLatestApplicationSession(runId);
      expect(reconciled).toMatchObject({
        bridgeState: "submission_uncertain",
        submissionPhase: "uncertain",
        terminalAt: null,
      });
      const projection = ApplicationSessionSnapshotDtoSchema.parse(reconciled?.publicSnapshot);
      expect(projection).toMatchObject({
        bridgeState: "submission_uncertain",
        harnessState: "submission_uncertain",
        submissionPhase: "uncertain",
        pendingAction: null,
        terminalAt: null,
        error: null,
      });
      expect(projection.warnings.at(-1)).toBe(SUBMISSION_UNCERTAIN_WARNING);
      expect(projection.warnings.filter((warning) => warning === SUBMISSION_UNCERTAIN_WARNING))
        .toHaveLength(1);
      if (index === 0) {
        expect(projection.warnings).toEqual(["Review changed", SUBMISSION_UNCERTAIN_WARNING]);
        expect(projection.company).toBe("Example");
      } else {
        expect(projection.company).toBeNull();
      }
      repo.recordApplicationSnapshot(runId, {
        slotReleased: true,
        generation: 1,
        sessionId,
        bridgeState: "closed",
        publicSnapshot: {
          ...projection,
          bridgeState: "closed",
          harnessState: "closed",
          updatedAt: projection.updatedAt + 1,
          terminalAt: 1_025,
        },
      });
      expect(repo.getLatestApplicationSession(runId)?.submissionPhase).toBe("uncertain");
      expect(() => repo.reserveApplicationSession(
        runId,
        sessionId,
        index === 0
          ? "92929292-9292-4292-8292-929292929292"
          : "93939393-9393-4393-8393-939393939393",
        hash,
      )).toThrow(ApplicationSubmissionFinalError);
    }
  });

  test("reconciliation preserves an already closed browser while retaining uncertainty", () => {
    const { db, repo, tick } = fixture();
    const hash = "f".repeat(64);
    const runId = createReview(repo, hash, false, "reconcile-closed");
    repo.approve(runId, hash);
    const sessionId = "94949494-9494-4494-8494-949494949494";
    repo.reserveApplicationSession(runId, null, sessionId, hash);
    recordApplicationReview(repo, runId, sessionId);
    repo.claimApplicationSubmission(sessionId);
    db.query(`
      UPDATE run_application_sessions
      SET bridge_state = 'closed', slot_released = 1,
          terminal_at = 1010, public_snapshot_json = NULL
      WHERE session_id = ?
    `).run(sessionId);
    tick(25);

    expect(repo.reconcileAttemptingApplicationSubmissions()).toBe(1);

    const reconciled = repo.getLatestApplicationSession(runId);
    expect(reconciled).toMatchObject({
      bridgeState: "closed",
      submissionPhase: "uncertain",
      terminalAt: 1_010,
    });
    expect(ApplicationSessionSnapshotDtoSchema.parse(reconciled?.publicSnapshot)).toMatchObject({
      bridgeState: "closed",
      harnessState: null,
      submissionPhase: "uncertain",
      terminalAt: 1_010,
      warnings: [SUBMISSION_UNCERTAIN_WARNING],
    });
    const retrySessionId = "95959595-9595-4595-8595-959595959595";
    expect(() => repo.reserveApplicationSession(
      runId,
      sessionId,
      retrySessionId,
      hash,
    )).toThrow(ApplicationSubmissionFinalError);
    expect(repo.reserveApplicationSession(
      runId,
      sessionId,
      retrySessionId,
      hash,
      { allowTerminalApplicationRetry: true },
    )).toMatchObject({
      generation: 2,
      sessionId: retrySessionId,
      bridgeState: "reserved",
      submissionPhase: "not_attempted",
    });
  });

  test("retries closed uncertainty for every application status", () => {
    const { repo } = fixture();
    const hash = "7".repeat(64);
    const statuses = ["pending", "did_not_apply", "failed", "applied"] as const;

    for (const [index, applicationStatus] of statuses.entries()) {
      const runId = createReview(repo, hash, false, `uncertain-status-${applicationStatus}`);
      repo.approve(runId, hash);
      repo.setApplicationStatus(runId, applicationStatus);
      const sessionId = `96969696-9696-4696-8696-${String(index + 1).padStart(12, "0")}`;
      const retrySessionId = `97979797-9797-4797-8797-${String(index + 1).padStart(12, "0")}`;
      repo.reserveApplicationSession(runId, null, sessionId, hash);
      recordApplicationReview(repo, runId, sessionId);
      repo.claimApplicationSubmission(sessionId);
      repo.finalizeApplicationSubmission(sessionId, "uncertain");
      repo.recordApplicationSnapshot(runId, {
        slotReleased: true,
        generation: 1,
        sessionId,
        bridgeState: "closed",
        publicSnapshot: { state: "closed" },
      });

      expect(repo.reserveApplicationSession(
        runId,
        sessionId,
        retrySessionId,
        hash,
        { allowTerminalApplicationRetry: true },
      )).toMatchObject({
        generation: 2,
        sessionId: retrySessionId,
        bridgeState: "reserved",
        submissionPhase: "not_attempted",
      });
    }
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
      slotReleased: false,
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
    tick(50);
    const replayed = repo.recordApplicationSnapshot(runId, {
      slotReleased: false,
      generation: 1,
      sessionId,
      bridgeState: "running",
      publicSnapshot: { state: "running" },
      lastUpstreamEventId: 7,
    });
    expect(replayed).toMatchObject({
      bridgeState: "awaiting_human_navigation",
      publicSnapshot: snapshot,
      lastUpstreamEventId: 7,
      updatedAt: 1_050,
    });
    const stale = repo.recordApplicationSnapshot(runId, {
      slotReleased: false,
      generation: 1,
      sessionId,
      bridgeState: "running",
      publicSnapshot: { state: "running" },
      lastUpstreamEventId: 6,
    });
    expect(stale).toMatchObject({
      bridgeState: "awaiting_human_navigation",
      publicSnapshot: snapshot,
      lastUpstreamEventId: 7,
      updatedAt: 1_050,
    });
  });

  test("advances a higher cursor without replacing an equal-timestamp conflict", () => {
    const { repo } = fixture();
    const hash = "a".repeat(64);
    const runId = createReview(repo, hash);
    repo.approve(runId, hash);
    const sessionId = "34343434-3434-4434-8434-343434343434";
    repo.reserveApplicationSession(runId, null, sessionId, hash);
    const retainedSnapshot = {
      state: "awaiting_human_navigation",
      updatedAt: 200,
      pendingAction: { type: "human_navigation", instruction: "Complete login" },
    };
    repo.recordApplicationSnapshot(runId, {
      slotReleased: false,
      generation: 1,
      sessionId,
      bridgeState: "awaiting_human_navigation",
      publicSnapshot: retainedSnapshot,
      lastUpstreamEventId: 6,
    });
    const before = repo.getLatestApplicationSession(runId);

    const coalesced = repo.recordApplicationSnapshot(runId, {
      slotReleased: false,
      generation: 1,
      sessionId,
      bridgeState: "running",
      publicSnapshot: { state: "running", updatedAt: 200 },
      lastUpstreamEventId: 7,
    });

    expect(coalesced).toMatchObject({
      bridgeState: "awaiting_human_navigation",
      publicSnapshot: retainedSnapshot,
      lastUpstreamEventId: 7,
      updatedAt: before?.updatedAt,
    });
    expect(repo.getLatestApplicationSession(runId)).toEqual(coalesced);
  });

  test("marks an observed current session lost, closes it locally, and preserves prior generations", () => {
    const { db, repo, tick } = fixture();
    const hash = "5".repeat(64);
    const runId = createReview(repo, hash);
    repo.approve(runId, hash);
    const firstSessionId = "44444444-4444-4444-8444-444444444444";
    repo.reserveApplicationSession(runId, null, firstSessionId, hash);
    repo.recordApplicationSnapshot(runId, {
      slotReleased: false,
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
        slotReleased: bridgeState === "cancelled" || bridgeState === "failed" || bridgeState === "closed" || bridgeState === "lost",
        generation: 1,
        sessionId,
        bridgeState,
        publicSnapshot: { state: bridgeState },
      });
      tick(10);

      const closed = repo.recordApplicationSnapshot(runId, {
        slotReleased: true,
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
        slotReleased: false,
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

describe("artifact restoration markers", () => {
  test("enumerates complete pruned manifests and clears only the matching run and queue sequence", () => {
    const { db, repo } = fixture();
    const first = createReview(repo, "a".repeat(64), false, "pruned-first");
    const second = createReview(repo, "b".repeat(64), false, "pruning-second");
    const firstRun = repo.getRun(first)!;
    const secondRun = repo.getRun(second)!;
    db.query(`
      INSERT INTO run_artifact_retention(run_id, state, selected_at, pruned_at)
      VALUES (?, 'pruned', 1000, 1000)
    `).run(first);
    db.query(`
      INSERT INTO run_artifact_retention(run_id, state, selected_at)
      VALUES (?, 'pruning', 1000)
    `).run(second);

    expect(repo.listPrunedRunArtifactManifests()).toEqual([{
      runId: first,
      queueSequence: firstRun.queueSequence,
      artifacts: [{
        id: expect.any(String),
        path: `/tmp/${first}.pdf`,
        sha256: "a".repeat(64),
        byteSize: 10,
      }],
    }]);
    expect(() => repo.clearPrunedRunArtifactMarker(
      first,
      secondRun.queueSequence,
    )).toThrow(RepositoryConflictError);
    expect(repo.areRunArtifactsRetained(first)).toBe(false);

    repo.clearPrunedRunArtifactMarker(first, firstRun.queueSequence);
    expect(repo.listPrunedRunArtifactManifests()).toEqual([]);
    expect(repo.areRunArtifactsRetained(first)).toBe(true);
    expect(repo.areRunArtifactsRetained(second)).toBe(false);
    expect(() => repo.clearPrunedRunArtifactMarker(
      first,
      firstRun.queueSequence,
    )).toThrow(RepositoryConflictError);
  });

  test("includes a pruned run whose artifact manifest is empty", () => {
    const { db, repo } = fixture();
    const run = repo.createRun("JD", "empty-pruned-manifest");
    db.query(`
      INSERT INTO run_artifact_retention(run_id, state, selected_at, pruned_at)
      VALUES (?, 'pruned', 1000, 1000)
    `).run(run.id);

    expect(repo.listPrunedRunArtifactManifests()).toEqual([{
      runId: run.id,
      queueSequence: run.queueSequence,
      artifacts: [],
    }]);
  });

  test("preserves public pruned behavior until restoration clears the marker", () => {
    const { db, repo } = fixture();
    const hash = "e".repeat(64);
    const runId = createReview(repo, hash, false, "pruned-command");
    const queueSequence = repo.getRun(runId)!.queueSequence;
    db.query("UPDATE runs SET status='failed', failed_stage='compiling' WHERE id=?").run(runId);
    db.query(`
      INSERT INTO run_artifact_retention(run_id, state, selected_at, pruned_at)
      VALUES (?, 'pruned', 1000, 1000)
    `).run(runId);

    expect(() => repo.retry(runId)).toThrow(RunArtifactsPrunedError);
    expect(() => repo.regenerate(runId, hash)).toThrow(RunArtifactsPrunedError);
    expect(() => repo.editRun(runId, "change the layout", hash)).toThrow(RunArtifactsPrunedError);
    expect(() => repo.approve(runId, hash)).toThrow(RunArtifactsPrunedError);
    expect(repo.setApplicationStatus(runId, "rejected").applicationStatus).toBe("rejected");

    repo.clearPrunedRunArtifactMarker(runId, queueSequence);
    expect(repo.areRunArtifactsRetained(runId)).toBe(true);
  });

  test("never acquires a runnable run while its historical marker remains", () => {
    const { db, repo } = fixture();
    const pruned = repo.createRun("JD", "pruned-runnable");
    const available = repo.createRun("JD", "available-runnable");
    db.query(`
      INSERT INTO run_artifact_retention(run_id, state, selected_at, pruned_at)
      VALUES (?, 'pruned', 1000, 1000)
    `).run(pruned.id);

    expect(repo.acquire()?.runId).toBe(available.id);
  });
});

test.skipIf(process.platform !== "linux")("process start tokens distinguish the live worker from a reused or dead PID (requires Linux /proc)", () => {
  const startToken = readProcessStartToken();
  expect(startToken).toMatch(/^\d+$/);
  expect(isProcessIdentityAlive(process.pid, startToken!)).toBe(true);
  expect(isProcessIdentityAlive(process.pid, `${startToken}-stale`)).toBe(false);
  expect(isProcessIdentityAlive(2_147_483_647, startToken!)).toBe(false);
});

test.skipIf(process.platform !== "darwin")("process start tokens distinguish the live worker from a reused or dead PID on macOS", () => {
  const startToken = readProcessStartToken();
  expect(startToken).toBeDefined();
  expect(startToken).not.toBe("");
  expect(isProcessIdentityAlive(process.pid, startToken!)).toBe(true);
  expect(isProcessIdentityAlive(process.pid, `${startToken}-stale`)).toBe(false);
  expect(isProcessIdentityAlive(2_147_483_647, startToken!)).toBe(false);
});
