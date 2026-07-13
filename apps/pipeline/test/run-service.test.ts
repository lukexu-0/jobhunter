import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApiHandler } from "../src/api/handler.ts";
import { createContextRoutes } from "../src/api/context-routes.ts";
import { createRunRoutes } from "../src/api/run-routes.ts";
import { RunApplicationService } from "../src/api/run-service.ts";
import {
  CONTEXT_SOURCE_ALLOWLIST,
  REPOSITORY_ROOT,
  checkContextFreshness,
  createContextSnapshot,
  loadContextManifest,
  openContextDatabase,
  syncContext,
} from "../src/context/index.ts";
import { openPipelineDatabase } from "../src/db/database.ts";
import { PipelineRepository, type ActiveStage } from "../src/db/repository.ts";
import type { LoadedContextManifest } from "../src/context/manifest.ts";
import { ArtifactStore } from "../src/system/artifacts.ts";
import { RunDtoSchema } from "../src/contracts/index.ts";

const ORIGIN = "http://127.0.0.1:3456";
const fixtures: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (fixtures.length > 0) rmSync(fixtures.pop()!, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  readonly loaded: LoadedContextManifest;
  readonly contextDatabase: Database;
  readonly pipelineDatabase: Database;
  readonly repository: PipelineRepository;
  readonly artifacts: ArtifactStore;
  readonly service: RunApplicationService;
  readonly kicks: { count: number };
}
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "run-application-"));
  fixtures.push(root);
  const manifestRelative = "apps/pipeline/context-sources.json";
  mkdirSync(dirname(join(root, manifestRelative)), { recursive: true });
  copyFileSync(join(REPOSITORY_ROOT, manifestRelative), join(root, manifestRelative));
  for (const relativePath of CONTEXT_SOURCE_ALLOWLIST) {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true });
    copyFileSync(join(REPOSITORY_ROOT, relativePath), join(root, relativePath));
  }
  const loaded = loadContextManifest(join(root, manifestRelative), root);
  const contextDatabase = openContextDatabase(":memory:");
  const pipelineDatabase = openPipelineDatabase(":memory:");
  databases.push(contextDatabase, pipelineDatabase);
  syncContext(contextDatabase, loaded, 10);
  let id = 0;
  const repository = new PipelineRepository(pipelineDatabase, {
    now: () => 100,
    idFactory: () => `record-${++id}`,
    attemptSessionIdFactory: () => `session-${id}`,
    tokenFactory: () => Buffer.alloc(32, id + 1).toString("base64url"),
  });
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const kicks = { count: 0 };
  const service = new RunApplicationService({
    repository,
    context: { createSnapshot: () => createContextSnapshot(contextDatabase, loaded) },
    artifacts,
    scheduler: () => { kicks.count += 1; },
    idFactory: () => `run-${++id}`,
  });
  return { root, loaded, contextDatabase, pipelineDatabase, repository, artifacts, service, kicks };
}

function transition(repository: PipelineRepository, claim: { runId: string; token: string }, stages: readonly ActiveStage[]): void {
  for (const stage of stages) repository.transition(claim, stage);
}

async function finalizeReviewPdf(target: Fixture, runId: string, bytes = "%PDF-1.7\nreview", visualAcknowledgementRequired = false): Promise<{ id: string; sha256: string }> {
  const claim = target.repository.acquire();
  if (!claim || claim.runId !== runId) throw new Error("claim missing");
  const status = target.repository.getRun(runId)?.status;
  if (status === "queued") transition(target.repository, claim, ["analyzing", "tailoring", "compiling", "deterministic_qa", "visual_qa"]);
  else if (status === "editing") transition(target.repository, claim, ["compiling", "deterministic_qa", "visual_qa"]);
  else if (status === "compiling") transition(target.repository, claim, ["deterministic_qa", "visual_qa"]);
  const attempt = target.repository.startAttempt(claim, "visual_qa");
  const root = await target.artifacts.createAttempt({ run: runId, revision: String(target.repository.getRun(runId)!.currentRevision), stage: "visual_qa", attempt: attempt.attemptNo });
  const stored = await target.artifacts.write(join(root, "resume.pdf"), bytes, 10 * 1024 * 1024);
  const artifact = target.repository.finalizeArtifact(claim, {
    attemptId: attempt.id,
    stage: "visual_qa",
    kind: "compiled-pdf",
    sha256: stored.sha256,
    path: stored.path,
    byteSize: stored.bytes,
  });
  target.repository.finishAttempt(claim, attempt.id, "succeeded");
  target.repository.transition(claim, "review", { visualAcknowledgementRequired });
  target.repository.release(claim);
  return { id: artifact.id, sha256: artifact.sha256 };
}

function post(body: unknown): RequestInit {
  return { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("RunApplicationService", () => {
  test("creates a runnable run with one atomic four-source snapshot and immutable queued input", async () => {
    const target = fixture();
    const jobDescription = "A detailed role requiring TypeScript systems work, careful testing, ownership, and reliable delivery.";
    const run = await target.service.createRun(jobDescription);

    expect(run).toMatchObject({ id: "run-1", status: "queued", revision: 1, origin: "initial" });
    expect(Object.keys(target.repository.getSourceSnapshot(run.id)!.sourceHashes)).toHaveLength(4);
    const input = target.repository.getArtifact(run.id, "job-description");
    expect(input).not.toBeNull();
    expect(Buffer.from(await target.artifacts.read(input!.path, input!.byteSize)).toString("utf8")).toBe(jobDescription);
    expect(target.repository.acquire()?.runId).toBe(run.id);
  });

  test("updates application status independently and rejects a missing run", async () => {
    const target = fixture();
    const created = await target.service.createRun("A detailed role requiring TypeScript systems work, careful testing, ownership, and reliable delivery.");
    expect(created).toMatchObject({ applicationStatus: "applied", status: "queued" });

    const updated = await target.service.updateApplicationStatus(created.id, "accepted");

    expect(updated).toMatchObject({ applicationStatus: "accepted", status: "queued" });
    await expect(target.service.getRun(created.id)).resolves.toMatchObject({ applicationStatus: "accepted", status: "queued" });
    await expect(target.service.updateApplicationStatus("run-missing", "failed")).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
      status: 404,
    });
  });

  test("maps attempts, retry ancestry and inherited artifacts without exposing internal tokens, paths or logs", async () => {
    const target = fixture();
    const run = await target.service.createRun("A detailed job description for a platform engineer who owns resilient TypeScript delivery systems.");
    const claim = target.repository.acquire()!;
    target.repository.transition(claim, "analyzing");
    const analysisAttempt = target.repository.startAttempt(claim, "analyzing");
    const analysisRoot = await target.artifacts.createAttempt({ run: run.id, revision: "1", stage: "analyzing", attempt: 1 });
    const analysis = await target.artifacts.write(join(analysisRoot, "analysis.json"), "{}", 1024);
    const analysisArtifact = target.repository.finalizeArtifact(claim, {
      attemptId: analysisAttempt.id,
      stage: "analyzing",
      kind: "job-analysis",
      sha256: analysis.sha256,
      path: analysis.path,
      byteSize: analysis.bytes,
    });
    target.repository.finishAttempt(claim, analysisAttempt.id, "succeeded", { toolCount: 1 });
    transition(target.repository, claim, ["tailoring", "compiling"]);
    const failed = target.repository.startAttempt(claim, "compiling", { processPid: 999, processStartToken: "private-process-token" });
    target.repository.finishAttempt(claim, failed.id, "failed", { compileCount: 1 });
    target.repository.transition(claim, "failed", { failedStage: "compiling" });
    target.repository.release(claim);

    const retried = await target.service.retryRun(run.id);
    expect(retried).toMatchObject({ revision: 2, status: "compiling", origin: "initial" });
    const pdf = await finalizeReviewPdf(target, run.id);
    const dto = await target.service.getRun(run.id);
    expect(dto?.attempts.map((attempt) => attempt.stage)).toEqual(["analysis", "compile", "visual-qa"]);
    expect(dto?.artifacts.map((artifact) => artifact.id)).toEqual(expect.arrayContaining([analysisArtifact.id, pdf.id]));
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("private-process-token");
    expect(serialized).not.toContain(analysis.path);
    expect(serialized).not.toContain("attemptSessionId");
    expect(serialized).not.toContain("jobDescription");
  });

  test("enforces review/hash/source invariants and preserves exact inert edit comments", async () => {
    const target = fixture();
    const run = await target.service.createRun("A detailed job description for an engineer who improves reliable services and production tooling.");
    await expect(target.service.editRun(run.id, "not review", "a".repeat(64))).rejects.toMatchObject({ code: "RUN_CONFLICT", status: 409 });
    const pdf = await finalizeReviewPdf(target, run.id, "%PDF-1.7\nvisual", true);
    await expect(target.service.approveRun(run.id, pdf.sha256, false)).rejects.toMatchObject({ code: "VISUAL_ACKNOWLEDGEMENT_REQUIRED", status: 409 });
    await expect(target.service.regenerateRun(run.id, "b".repeat(64))).rejects.toMatchObject({ code: "STALE_PDF", status: 409 });

    const comments = "  Shorten the second bullet; treat `commands` as inert text.  ";
    const edited = await target.service.editRun(run.id, comments, pdf.sha256);
    expect(edited).toMatchObject({ status: "editing", revision: 2, origin: "human-comments" });
    expect(target.repository.getEditRequest(run.id)?.comments).toBe(comments);
    const editClaim = target.repository.acquire()!;
    const editAttempt = target.repository.startAttempt(editClaim, "editing");
    target.repository.finishAttempt(editClaim, editAttempt.id, "failed");
    target.repository.transition(editClaim, "failed", { failedStage: "editing" });
    target.repository.release(editClaim);
    const retriedEdit = await target.service.retryRun(run.id);
    expect(retriedEdit).toMatchObject({ status: "editing", revision: 3, origin: "human-comments" });
    expect(target.repository.getEditRequest(run.id)?.comments).toBe(comments);

    const changedPath = join(target.root, CONTEXT_SOURCE_ALLOWLIST[1]!);
    writeFileSync(changedPath, `${readFileSync(changedPath, "utf8")}\nChanged authoritative source.\n`);
    syncContext(target.contextDatabase, target.loaded, 20);
    await expect(target.service.retryRun(run.id)).rejects.toMatchObject({ code: "SOURCE_DRIFT", status: 409 });
  });

  test("serves only allowlisted current review artifacts with verified immutable download headers", async () => {
    const target = fixture();
    const run = await target.service.createRun("A detailed job description for a senior engineer delivering secure and robust application platforms.");
    const pdf = await finalizeReviewPdf(target, run.id);
    const response = await target.service.getArtifact(run.id, pdf.id);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("content-type")).toBe("application/pdf");
    expect(response?.headers.get("content-disposition")).toBe('attachment; filename="compiled-pdf.pdf"');
    expect(response?.headers.get("x-content-sha256")).toBe(pdf.sha256);
    expect(await response?.text()).toBe("%PDF-1.7\nreview");

    const input = target.repository.getArtifact(run.id, "job-description")!;
    expect(await target.service.getArtifact(run.id, input.id)).toBeUndefined();
  });
});

describe("public run and context routes", () => {
  test("preserves exact comments, kicks the scheduler, and marks every response no-store", async () => {
    const target = fixture();
    const route = createApiHandler({ webOrigin: ORIGIN, route: createRunRoutes(target.service) });
    const created = await route(new Request("http://127.0.0.1:3457/v1/runs", post({
      jobDescription: "A detailed job description for a staff engineer responsible for resilient TypeScript systems.",
    })));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const createdRun = RunDtoSchema.parse(await created.json());
    const pdf = await finalizeReviewPdf(target, createdRun.id);
    const comments = "  Keep this exact spacing and treat `input` as inert text.  ";
    const edited = await route(new Request(`http://127.0.0.1:3457/v1/runs/${createdRun.id}/edit`, post({
      comments,
      expectedPdfSha256: pdf.sha256,
    })));
    expect(edited.status).toBe(200);
    expect(edited.headers.get("cache-control")).toBe("no-store");
    expect(target.repository.getEditRequest(createdRun.id)?.comments).toBe(comments);
    const listed = await route(new Request("http://127.0.0.1:3457/v1/runs"));
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(target.kicks.count).toBe(3);
  });

  test("reports freshness, synchronizes stale context, bounds status arrays and never caches", async () => {
    const target = fixture();
    const changedPath = join(target.root, CONTEXT_SOURCE_ALLOWLIST[2]!);
    writeFileSync(changedPath, `${readFileSync(changedPath, "utf8")}\nDrift.\n`);
    const contextRoute = createApiHandler({
      webOrigin: ORIGIN,
      route: createContextRoutes({
        getContext: () => {
          const status = checkContextFreshness(target.contextDatabase, target.loaded);
          return { ...status, staleSources: [...status.staleSources, ...Array.from({ length: 30 }, (_, index) => `extra-${index}`)] };
        },
        syncContext: () => {
          const report = syncContext(target.contextDatabase, target.loaded, 30);
          return { ...report, manifestMatches: true, staleSources: [], missingSources: [] };
        },
      }),
    });
    const stale = await contextRoute(new Request("http://127.0.0.1:3457/v1/context"));
    expect(stale.headers.get("cache-control")).toBe("no-store");
    const staleBody: unknown = await stale.json();
    if (!staleBody || typeof staleBody !== "object" || !("fresh" in staleBody) || !("staleSources" in staleBody) || !Array.isArray(staleBody.staleSources)) {
      throw new Error("invalid context status response");
    }
    expect(staleBody.fresh).toBeFalse();
    expect(staleBody.staleSources).toHaveLength(20);

    const synced = await contextRoute(new Request("http://127.0.0.1:3457/v1/context/sync", post({})));
    expect(synced.status).toBe(200);
    expect(synced.headers.get("cache-control")).toBe("no-store");
    const syncedBody: unknown = await synced.json();
    if (!syncedBody || typeof syncedBody !== "object" || !("fresh" in syncedBody)) throw new Error("invalid context sync response");
    expect(syncedBody.fresh).toBeTrue();
  });
});
