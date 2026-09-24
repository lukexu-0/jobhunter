import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openPipelineDatabase } from "../src/db/database.ts";
import { ClaimRejectedError, PipelineRepository, RepositoryConflictError, type ActiveStage } from "../src/db/repository.ts";

const databases: Database[] = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

function fixture(options: { now?: number } = {}) {
  let now = options.now ?? 1_000;
  let id = 0;
  let token = 0;
  const db = openPipelineDatabase(":memory:", { now: () => now });
  databases.push(db);
  const repo = new PipelineRepository(db, {
    now: () => now,
    idFactory: () => `id-${++id}`,
    tokenFactory: () => Buffer.alloc(32, ++token).toString("base64url"),
    isProcessAlive: () => true,
  });
  return { db, repo, tick(ms: number) { now += ms; }, now: () => now };
}

function reachStage(repo: PipelineRepository, claim: { runId: string; token: string }, targets: ActiveStage[]) {
  for (const target of targets) repo.transition(claim, target);
}

describe("artifact publication and inheritance", () => {
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

  test("rejects artifact provenance from another run without publishing an artifact", () => {
    const { repo } = fixture();
    const sourceRun = repo.createRun("Source job");
    const sourceClaim = repo.acquire()!;
    repo.transition(sourceClaim, "analyzing");
    const sourceAttempt = repo.startAttempt(sourceClaim, "analyzing");
    const source = repo.finalizeArtifact(sourceClaim, {
      attemptId: sourceAttempt.id, stage: "analyzing", kind: "job-analysis",
      sha256: "a".repeat(64), path: "/synthetic/source-analysis.json", byteSize: 1,
    });
    const targetRun = repo.createRun("Target job");
    const targetClaim = repo.acquire()!;
    repo.transition(targetClaim, "analyzing");
    const targetAttempt = repo.startAttempt(targetClaim, "analyzing");
    const before = repo.timeline(targetRun.id);

    expect(() => repo.finalizeArtifact(targetClaim, {
      attemptId: targetAttempt.id, stage: "analyzing", kind: "job-analysis",
      sha256: "b".repeat(64), path: "/synthetic/target-analysis.json", byteSize: 1,
      sourceArtifactId: source.id,
    })).toThrow(RepositoryConflictError);

    expect(repo.getArtifact(targetRun.id, "job-analysis")).toBeNull();
    expect(repo.timeline(targetRun.id)).toEqual(before);
    expect(repo.getArtifact(sourceRun.id, "job-analysis")).toEqual(source);
  });

  test("rolls back the entire attempt publication when a diagnostic has foreign provenance", () => {
    const { repo } = fixture();
    repo.createRun("Source job");
    const sourceClaim = repo.acquire()!;
    repo.transition(sourceClaim, "analyzing");
    const sourceAttempt = repo.startAttempt(sourceClaim, "analyzing");
    const source = repo.finalizeArtifact(sourceClaim, {
      attemptId: sourceAttempt.id, stage: "analyzing", kind: "job-analysis",
      sha256: "a".repeat(64), path: "/synthetic/batch-source.json", byteSize: 1,
    });
    const targetRun = repo.createRun("Target job");
    const targetClaim = repo.acquire()!;
    repo.transition(targetClaim, "analyzing");
    const targetAttempt = repo.startAttempt(targetClaim, "analyzing");
    const before = repo.timeline(targetRun.id);

    expect(() => repo.finishAttempt(targetClaim, targetAttempt.id, "failed", {}, [
      {
        stage: "analyzing", kind: "stage-error", sha256: "b".repeat(64),
        path: "/synthetic/first-diagnostic.json", byteSize: 1,
      },
      {
        stage: "analyzing", kind: "agent-transcript", sha256: "c".repeat(64),
        path: "/synthetic/foreign-diagnostic.json", byteSize: 1, sourceArtifactId: source.id,
      },
    ])).toThrow(RepositoryConflictError);

    expect(repo.listArtifacts(targetRun.id)).toEqual([]);
    expect(repo.timeline(targetRun.id)).toEqual(before);
  });

  test("rejects artifact stages that disagree with the owned attempt", () => {
    const { repo } = fixture();
    const run = repo.createRun("Job description");
    const claim = repo.acquire()!;
    repo.transition(claim, "analyzing");
    const attempt = repo.startAttempt(claim, "analyzing");
    const before = repo.timeline(run.id);
    const artifact = {
      stage: "visual_qa", kind: "job-analysis", sha256: "a".repeat(64),
      path: "/synthetic/wrong-stage.json", byteSize: 1,
    };

    expect(() => repo.finalizeArtifact(claim, { ...artifact, attemptId: attempt.id }))
      .toThrow(RepositoryConflictError);
    expect(() => repo.finishAttempt(claim, attempt.id, "failed", {}, [artifact]))
      .toThrow(RepositoryConflictError);
    expect(repo.listArtifacts(run.id)).toEqual([]);
    expect(repo.timeline(run.id)).toEqual(before);
  });

  test("atomically finalizes failure diagnostics with the failed attempt outcome", () => {
    const { repo } = fixture();
    const run = repo.createRun("JD");
    const claim = repo.acquire()!;
    repo.transition(claim, "analyzing");
    const attempt = repo.startAttempt(claim, "analyzing");
    const duplicateDiagnostics = [
      { stage: "analyzing", kind: "stage-error", sha256: "a".repeat(64), path: "/tmp/error-one", byteSize: 1 },
      { stage: "analyzing", kind: "stage-error", sha256: "b".repeat(64), path: "/tmp/error-two", byteSize: 1 },
    ] as const;

    expect(() => repo.finishAttempt(
      claim,
      attempt.id,
      "failed",
      {},
      duplicateDiagnostics,
    )).toThrow();
    expect(repo.getArtifact(run.id, "stage-error")).toBeNull();
    expect(repo.timeline(run.id).attempts.at(-1)?.status).toBe("running");

    const diagnostic = {
      stage: "analyzing",
      kind: "stage-error",
      sha256: "c".repeat(64),
      path: "/tmp/error-final",
      byteSize: 1,
    } as const;
    repo.finishAttempt(claim, attempt.id, "failed", {}, [diagnostic]);
    expect(repo.getArtifact(run.id, "stage-error")).toMatchObject({
      attemptId: attempt.id,
      sha256: diagnostic.sha256,
    });
    expect(repo.timeline(run.id).attempts.at(-1)?.status).toBe("failed");
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

  test("compile retry preserves the failed source across empty retries without stale outputs", () => {
    const { repo } = fixture();
    const run = repo.createRun("JD", undefined, true);
    const claim = repo.acquire()!;
    repo.transition(claim, "analyzing");
    const analysisAttempt = repo.startAttempt(claim, "analyzing");
    const analysis = repo.finalizeArtifact(claim, { attemptId: analysisAttempt.id, stage: "analyzing", kind: "job-analysis", sha256: "f".repeat(64), path: "/tmp/upstream", byteSize: 1 });
    repo.finishAttempt(claim, analysisAttempt.id, "succeeded");
    repo.transition(claim, "tailoring");
    const tailoringAttempt = repo.startAttempt(claim, "tailoring");
    const tailored = repo.finalizeArtifact(claim, { attemptId: tailoringAttempt.id, stage: "tailoring", kind: "tailored-tex", sha256: "a".repeat(64), path: "/tmp/tailored.tex", byteSize: 1 });
    repo.finishAttempt(claim, tailoringAttempt.id, "succeeded");
    repo.transition(claim, "compiling");
    const priorCompile = repo.startAttempt(claim, "compiling");
    repo.finalizeArtifact(claim, { attemptId: priorCompile.id, stage: "compiling", kind: "compiled-pdf", sha256: "b".repeat(64), path: "/tmp/stale.pdf", byteSize: 1, sourceArtifactId: tailored.id });
    repo.finishAttempt(claim, priorCompile.id, "succeeded");
    const compileAttempt = repo.startAttempt(claim, "compiling");
    const failedTex = repo.finalizeArtifact(claim, { attemptId: compileAttempt.id, stage: "compiling", kind: "tailored-tex", sha256: tailored.sha256, path: "/tmp/failed.tex", byteSize: 1, sourceArtifactId: tailored.id });
    repo.finalizeArtifact(claim, { attemptId: compileAttempt.id, stage: "compiling", kind: "latex-log", sha256: "e".repeat(64), path: "/tmp/failed-log", byteSize: 1, sourceArtifactId: tailored.id });
    repo.finishAttempt(claim, compileAttempt.id, "failed");
    repo.transition(claim, "failed", { failedStage: "compiling" });
    repo.release(claim);

    for (let revision = 2; revision <= 4; revision++) {
      const retried = repo.retry(run.id);
      expect(retried).toMatchObject({ currentRevision: revision, status: "compiling", generateKeywordMap: true });
      expect(repo.getRevision(run.id, revision)?.origin).toBe("retry");
      expect(repo.getArtifact(run.id, "job-analysis")).toEqual(analysis);
      expect(repo.getArtifact(run.id, "tailored-tex")).toEqual(failedTex);
      expect(repo.getArtifact(run.id, "latex-log")).toBeNull();
      expect(repo.getArtifact(run.id, "compiled-pdf")).toBeNull();
      const retryClaim = repo.acquire()!;
      repo.transition(retryClaim, "failed", { failedStage: "compiling" });
      repo.release(retryClaim);
    }
  });

  test("repair retry inherits failed source and diagnostics but not the prior repair result", () => {
    const { repo } = fixture();
    const run = repo.createRun("JD");
    const claim = repo.acquire()!;
    reachStage(repo, claim, ["analyzing", "tailoring", "compiling"]);
    const compiling = repo.startAttempt(claim, "compiling");
    const failedTex = repo.finalizeArtifact(claim, { attemptId: compiling.id, stage: "compiling", kind: "tailored-tex", sha256: "a".repeat(64), path: "/tmp/failed.tex", byteSize: 1 });
    const log = repo.finalizeArtifact(claim, { attemptId: compiling.id, stage: "compiling", kind: "latex-log", sha256: "b".repeat(64), path: "/tmp/failed.log", byteSize: 1, sourceArtifactId: failedTex.id });
    repo.finishAttempt(claim, compiling.id, "failed");
    repo.transition(claim, "repairing");
    const repairing = repo.startAttempt(claim, "repairing");
    repo.finalizeArtifact(claim, { attemptId: repairing.id, stage: "repairing", kind: "repair-report", sha256: "c".repeat(64), path: "/tmp/repair-report.json", byteSize: 1, sourceArtifactId: log.id });
    repo.finishAttempt(claim, repairing.id, "failed");
    repo.transition(claim, "failed", { failedStage: "repairing" });
    repo.release(claim);

    expect(repo.retry(run.id).status).toBe("repairing");
    expect(repo.getArtifact(run.id, "tailored-tex")).toEqual(failedTex);
    expect(repo.getArtifact(run.id, "latex-log")).toEqual(log);
    expect(repo.getArtifact(run.id, "repair-report")).toBeNull();
    const retryClaim = repo.acquire()!;
    const retryAttempt = repo.startAttempt(retryClaim, "repairing");
    const repaired = repo.finalizeArtifact(retryClaim, { attemptId: retryAttempt.id, stage: "repairing", kind: "tailored-tex", sha256: "d".repeat(64), path: "/tmp/repaired.tex", byteSize: 1, sourceArtifactId: failedTex.id });
    expect(repo.getArtifact(run.id, "tailored-tex")).toEqual(repaired);
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
});
