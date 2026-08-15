import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApiHandler } from "../src/api/handler.ts";
import { createContextRoutes } from "../src/api/context-routes.ts";
import { createRunRoutes } from "../src/api/run-routes.ts";
import { RunApplicationService } from "../src/api/run-service.ts";
import {
  JobSourceError,
  type JobSourceErrorCode,
  type LoadedJobSource,
  type LoadJobSource,
} from "../src/api/job-source.ts";
import { OAuthRequiredError } from "../src/auth/oauth-only-resolver.ts";
import {
  LunaJobExtractionError,
  type ExtractJobDescription,
} from "../src/models/luna-job-extractor.ts";
import type { ContextSnapshot } from "../src/context/types.ts";
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
import {
  type OpportunityKind,
  ResumeIterationDtoSchema,
  ResumeIterationListResponseSchema,
  RunDtoSchema,
} from "../src/contracts/index.ts";

const ORIGIN = "http://127.0.0.1:3456";
const JOB_URL = "https://jobs.example.test/role?gh_jid=123&source=service";
const JOB_DESCRIPTION = "A detailed role requiring TypeScript systems work, careful testing, ownership, and reliable delivery.";
const fixtures: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (fixtures.length > 0) rmSync(fixtures.pop()!, { recursive: true, force: true });
});

interface FixtureOptions {
  readonly loadJobSource?: LoadJobSource;
  readonly extractJobDescription?: ExtractJobDescription;
  readonly createSnapshot?: (defaultSnapshot: () => ContextSnapshot) => ContextSnapshot | Promise<ContextSnapshot>;
  readonly syncContext?: (defaultSync: () => void) => void | Promise<void>;
  readonly idFactory?: () => string;
  readonly validatePublicJobUrl?: (url: string, signal?: AbortSignal) => Promise<void>;
}

interface Fixture {
  readonly root: string;
  readonly loaded: LoadedContextManifest;
  readonly contextDatabase: Database;
  readonly pipelineDatabase: Database;
  readonly repository: PipelineRepository;
  readonly artifacts: ArtifactStore;
  readonly service: RunApplicationService;
  readonly ids: { count: number };
  readonly kicks: { count: number };
  readonly syncs: { count: number };
}
function fixture(options: FixtureOptions = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "run-application-")));
  fixtures.push(root);
  const manifestRelative = "apps/resume-tailoring/context-sources.json";
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
  let repositoryId = 0;
  const repository = new PipelineRepository(pipelineDatabase, {
    now: () => 100,
    idFactory: () => `record-${++repositoryId}`,
    attemptSessionIdFactory: () => `session-${repositoryId}`,
    tokenFactory: () => Buffer.alloc(32, repositoryId + 1).toString("base64url"),
  });
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const kicks = { count: 0 };
  const ids = { count: 0 };
  const syncs = { count: 0 };
  const service = new RunApplicationService({
    repository,
    context: {
      createSnapshot: () => options.createSnapshot
        ? options.createSnapshot(() => createContextSnapshot(contextDatabase, loaded))
        : createContextSnapshot(contextDatabase, loaded),
      syncContext: async () => {
        syncs.count += 1;
        if (options.syncContext) {
          await options.syncContext(() => { syncContext(contextDatabase, loaded, 20); });
        } else {
          syncContext(contextDatabase, loaded, 20);
        }
      },
    },
    artifacts,
    scheduler: () => { kicks.count += 1; },
    idFactory: () => {
      ids.count += 1;
      return options.idFactory?.() ?? `run-${ids.count}`;
    },
    loadJobSource: options.loadJobSource
      ?? (async () => ({
        kind: "description",
        opportunityKind: "job",
        jobDescription: JOB_DESCRIPTION,
      })),
    ...(options.extractJobDescription ? { extractJobDescription: options.extractJobDescription } : {}),
    validatePublicJobUrl: options.validatePublicJobUrl ?? (async () => undefined),
  });
  return { root, loaded, contextDatabase, pipelineDatabase, repository, artifacts, service, kicks, ids, syncs };
}
interface PersistenceCounts {
  readonly runs: number;
  readonly revisions: number;
  readonly snapshots: number;
  readonly artifacts: number;
  readonly events: number;
}

function persistenceCounts(database: Database): PersistenceCounts {
  const count = (table: string) =>
    database.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()!.count;
  return {
    runs: count("runs"),
    revisions: count("revisions"),
    snapshots: count("run_source_snapshots"),
    artifacts: count("artifacts"),
    events: count("events"),
  };
}

function expectNoPersistence(target: Fixture): void {
  expect(persistenceCounts(target.pipelineDatabase)).toEqual({
    runs: 0,
    revisions: 0,
    snapshots: 0,
    artifacts: 0,
    events: 0,
  });
  expect(target.ids.count).toBe(0);
  expect(target.kicks.count).toBe(0);
  expect(existsSync(join(target.root, "artifacts"))).toBe(false);
}

function transition(repository: PipelineRepository, claim: { runId: string; token: string }, stages: readonly ActiveStage[]): void {
  for (const stage of stages) repository.transition(claim, stage);
}

async function finalizeReviewPdf(target: Fixture, runId: string, bytes = "%PDF-1.7\nreview", visualAcknowledgementRequired = false, keywordMapBytes?: string, tailoredTexBytes?: string): Promise<{ id: string; sha256: string; keywordMapId?: string; keywordCoverageId?: string; tailoredTexId?: string }> {
  const claim = target.repository.acquire();
  if (!claim || claim.runId !== runId) throw new Error("claim missing");
  const run = target.repository.getRun(runId);
  if (!run) throw new Error(`run missing: ${runId}`);
  const status = run.status;
  if (status === "queued") transition(target.repository, claim, ["analyzing", "tailoring", "compiling", "deterministic_qa", "visual_qa"]);
  else if (status === "editing") transition(target.repository, claim, ["compiling", "deterministic_qa", "visual_qa"]);
  else if (status === "compiling") transition(target.repository, claim, ["deterministic_qa", "visual_qa"]);
  const attempt = target.repository.startAttempt(claim, "visual_qa");
  const root = await target.artifacts.createAttempt({ run: run.queueSequence, revision: String(run.currentRevision), stage: "visual_qa", attempt: attempt.attemptNo });
  const stored = await target.artifacts.write(join(root, "resume.pdf"), bytes, 10 * 1024 * 1024);
  const artifact = target.repository.finalizeArtifact(claim, {
    attemptId: attempt.id,
    stage: "visual_qa",
    kind: "compiled-pdf",
    sha256: stored.sha256,
    path: stored.path,
    byteSize: stored.bytes,
  });
  let tailoredTexId: string | undefined;
  if (tailoredTexBytes !== undefined) {
    const tex = await target.artifacts.write(join(root, "resume.tex"), tailoredTexBytes, 256 * 1024);
    tailoredTexId = target.repository.finalizeArtifact(claim, {
      attemptId: attempt.id,
      stage: "visual_qa",
      kind: "tailored-tex",
      sha256: tex.sha256,
      path: tex.path,
      byteSize: tex.bytes,
    }).id;
  }
  let keywordCoverageId: string | undefined;
  let keywordMapId: string | undefined;
  if (keywordMapBytes !== undefined) {
    const map = await target.artifacts.write(join(root, "keyword-map.pdf"), keywordMapBytes, 10 * 1024 * 1024);
    keywordMapId = target.repository.finalizeArtifact(claim, {
      attemptId: attempt.id,
      stage: "visual_qa",
      kind: "keyword-map-pdf",
      sha256: map.sha256,
      path: map.path,
      byteSize: map.bytes,
      sourceArtifactId: artifact.id,
    }).id;
    const coverage = await target.artifacts.write(
      join(root, "keyword-map.json"),
      JSON.stringify({
        schemaVersion: 1,
        pdfSha256: artifact.sha256,
        keywords: [{ id: "keyword-platform", phrase: "Platform", found: true }],
      }),
      1024 * 1024,
    );
    keywordCoverageId = target.repository.finalizeArtifact(claim, {
      attemptId: attempt.id,
      stage: "visual_qa",
      kind: "keyword-map",
      sha256: coverage.sha256,
      path: coverage.path,
      byteSize: coverage.bytes,
      sourceArtifactId: artifact.id,
    }).id;
  }
  target.repository.finishAttempt(claim, attempt.id, "succeeded");
  target.repository.transition(claim, "review", { visualAcknowledgementRequired });
  target.repository.release(claim);
  return {
    id: artifact.id,
    sha256: artifact.sha256,
    ...(keywordMapId ? { keywordMapId } : {}),
    ...(keywordCoverageId ? { keywordCoverageId } : {}),
    ...(tailoredTexId ? { tailoredTexId } : {}),
  };
}

function post(body: unknown): RequestInit {
  return { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("RunApplicationService", () => {
  test("defines strict reviewable resume iteration projections", () => {
    const iteration = {
      revision: 2,
      origin: "human-comments" as const,
      status: "review" as const,
      createdAt: 123,
      pdfSha256: "a".repeat(64),
      artifacts: [],
    };

    expect(ResumeIterationDtoSchema.parse(iteration)).toEqual(iteration);
    expect(ResumeIterationListResponseSchema.parse({
      artifactState: "pruned",
      iterations: [iteration],
    })).toEqual({
      artifactState: "pruned",
      iterations: [iteration],
    });
    expect(ResumeIterationDtoSchema.safeParse({ ...iteration, status: "queued" }).success).toBeFalse();
    expect(ResumeIterationListResponseSchema.safeParse({
      artifactState: "retained",
      iterations: [{ ...iteration, privatePath: "/tmp/resume.pdf" }],
    }).success).toBeFalse();
  });
  test("creates a runnable run with one atomic four-source snapshot and independent default-off modes", async () => {
    const target = fixture();
    const jobDescription = JOB_DESCRIPTION;
    const run = await target.service.createRun(JOB_URL);

    expect(run).toMatchObject({
      id: "run-1",
      status: "queued",
      revision: 1,
      origin: "initial",
      skipReview: false,
      autoSubmit: false,
    });
    expect(target.repository.getRun(run.id)?.generateKeywordMap).toBe(true);
    expect(target.repository.getRunJobUrl(run.id)).toBe(JOB_URL);
    expect(run.jobUrl).toBe(JOB_URL);
    const skipOnly = await target.service.createRun(JOB_URL, false, true, false);
    expect(target.repository.getRun(skipOnly.id)).toMatchObject({
      generateKeywordMap: false,
      skipReview: true,
      autoSubmit: false,
    });
    const submitOnly = await target.service.createRun(JOB_URL, true, false, true);
    expect(target.repository.getRun(submitOnly.id)).toMatchObject({
      generateKeywordMap: true,
      skipReview: false,
      autoSubmit: true,
    });
    expect(Object.keys(target.repository.getSourceSnapshot(run.id)!.sourceHashes)).toHaveLength(4);
    const input = target.repository.getArtifact(run.id, "job-description");
    expect(input).not.toBeNull();
    expect(Buffer.from(await target.artifacts.read(input!.path, input!.byteSize)).toString("utf8")).toBe(jobDescription);
    expect(target.repository.acquire()?.runId).toBe(run.id);
  });
  test("persists and returns an explicit networking event kind over deterministic source inference", async () => {
    const eventDescription = [
      "Platform engineering networking evening",
      "Meet infrastructure engineers and discuss reliable systems over structured small-group sessions.",
    ].join("\n");
    const target = fixture({
      loadJobSource: async () => ({
        kind: "description",
        opportunityKind: "job",
        jobDescription: eventDescription,
      }),
    });

    const run = await target.service.createRun(JOB_URL, true, false, false, undefined, "networking_event");

    expect(run.opportunityKind).toBe("networking_event");
    expect(target.repository.getRun(run.id)?.opportunityKind).toBe("networking_event");
    expect(target.repository.getArtifact(run.id, "job-description")).not.toBeNull();
  });


  test("synchronizes stale context once and creates the run from the refreshed snapshot", async () => {
    let snapshotCalls = 0;
    const target = fixture({
      createSnapshot: (defaultSnapshot) => {
        snapshotCalls += 1;
        return defaultSnapshot();
      },
    });
    const changedPath = join(target.root, CONTEXT_SOURCE_ALLOWLIST[0]!);
    writeFileSync(changedPath, `${readFileSync(changedPath, "utf8")}\nRefreshed baseline.\n`);

    const run = await target.service.createRun(JOB_URL);

    expect(run).toMatchObject({ id: "run-1", status: "queued", revision: 1 });
    expect(target.syncs.count).toBe(1);
    expect(snapshotCalls).toBe(2);
    expect(persistenceCounts(target.pipelineDatabase)).toEqual({
      runs: 1,
      revisions: 1,
      snapshots: 1,
      artifacts: 1,
      events: 3,
    });
  });

  test("returns a bounded HTTP synchronization failure without persisting a run", async () => {
    let snapshotCalls = 0;
    const target = fixture({
      createSnapshot: (defaultSnapshot) => {
        snapshotCalls += 1;
        return defaultSnapshot();
      },
      syncContext: () => {
        throw new Error("private database failure");
      },
    });
    const changedPath = join(target.root, CONTEXT_SOURCE_ALLOWLIST[0]!);
    writeFileSync(changedPath, `${readFileSync(changedPath, "utf8")}\nUnsynchronized baseline.\n`);
    const route = createApiHandler({ webOrigin: ORIGIN, route: createRunRoutes(target.service) });

    const response = await route(new Request("http://127.0.0.1:3457/v1/runs", post({
      jobUrl: JOB_URL,
    })));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "CONTEXT_SYNC_FAILED",
        message: "Context synchronization failed",
      },
    });
    expect(target.syncs.count).toBe(1);
    expect(snapshotCalls).toBe(1);
    expectNoPersistence(target);
  });

  test("retries the snapshot once after a no-op synchronization and returns stale context", async () => {
    let snapshotCalls = 0;
    const target = fixture({
      createSnapshot: (defaultSnapshot) => {
        snapshotCalls += 1;
        return defaultSnapshot();
      },
      syncContext: () => {},
    });
    const changedPath = join(target.root, CONTEXT_SOURCE_ALLOWLIST[0]!);
    writeFileSync(changedPath, `${readFileSync(changedPath, "utf8")}\nStill stale baseline.\n`);

    await expect(target.service.createRun(JOB_URL)).rejects.toMatchObject({
      code: "CONTEXT_STALE",
      status: 409,
    });
    expect(target.syncs.count).toBe(1);
    expect(snapshotCalls).toBe(2);
    expectNoPersistence(target);
  });

  test("does not synchronize after a generic first-snapshot exception", async () => {
    const snapshotFailure = new Error("snapshot storage failed");
    let snapshotCalls = 0;
    const target = fixture({
      createSnapshot: () => {
        snapshotCalls += 1;
        throw snapshotFailure;
      },
    });

    await expect(target.service.createRun(JOB_URL)).rejects.toBe(snapshotFailure);
    expect(target.syncs.count).toBe(0);
    expect(snapshotCalls).toBe(1);
    expectNoPersistence(target);
  });
  test("exposes durable run modes and canonical job URLs on created, listed, and retrieved DTOs", async () => {
    const target = fixture();
    const created = await target.service.createRun(JOB_URL, false, true, true);
    const listed = await target.service.listRuns();
    const retrieved = await target.service.getRun(created.id);

    expect(created).toMatchObject({
      queueSequence: 1,
      generateKeywordMap: false,
      skipReview: true,
      autoSubmit: true,
      jobUrl: JOB_URL,
      isApplying: false,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      queueSequence: 1,
      generateKeywordMap: false,
      skipReview: true,
      autoSubmit: true,
      jobUrl: JOB_URL,
      isApplying: false,
    });
    expect(retrieved).toMatchObject({
      queueSequence: 1,
      generateKeywordMap: false,
      skipReview: true,
      autoSubmit: true,
      jobUrl: JOB_URL,
      isApplying: false,
    });
    const legacyDto = { ...created };
    delete legacyDto.isApplying;
    expect(RunDtoSchema.parse(legacyDto)).not.toHaveProperty("isApplying");
  });

  test("projects the latest application session without per-run list lookups", async () => {
    const target = fixture();
    const applying = await target.service.createRun(JOB_URL);
    const pdf = await finalizeReviewPdf(target, applying.id);
    const approved = await target.service.approveRun(applying.id, pdf.sha256, false);
    expect(approved.isApplying).toBe(false);

    const sessionId = "93939393-9393-4393-8393-939393939393";
    target.repository.reserveApplicationSession(
      applying.id,
      null,
      sessionId,
      pdf.sha256,
    );
    const ordinary = await target.service.createRun(`${JOB_URL}&ordinary=1`);

    await expect(target.service.getRun(applying.id)).resolves.toMatchObject({
      isApplying: true,
    });
    await expect(
      target.service.updateApplicationStatus(applying.id, "oa_received"),
    ).resolves.toMatchObject({
      applicationStatus: "oa_received",
      isApplying: true,
    });

    const originalBatchProjection =
      target.repository.listApplyingRunIds.bind(target.repository);
    const originalSingleProjection =
      target.repository.isRunApplying.bind(target.repository);
    let batchProjectionCalls = 0;
    target.repository.listApplyingRunIds = (runIds) => {
      batchProjectionCalls += 1;
      return originalBatchProjection(runIds);
    };
    target.repository.isRunApplying = () => {
      throw new Error("list projection queried application state per run");
    };
    const listed = await target.service.listRuns();
    target.repository.listApplyingRunIds = originalBatchProjection;
    target.repository.isRunApplying = originalSingleProjection;

    expect(batchProjectionCalls).toBe(1);
    expect(listed.find(({ id }) => id === applying.id)?.isApplying).toBe(true);
    expect(listed.find(({ id }) => id === ordinary.id)?.isApplying).toBe(false);

    target.repository.recordApplicationSnapshot(applying.id, {
      slotReleased: false,
      generation: 1,
      sessionId,
      bridgeState: "awaiting_human_review",
      publicSnapshot: { state: "awaiting_human_review" },
    });
    target.repository.claimApplicationSubmission(sessionId);
    target.repository.recordApplicationSnapshot(applying.id, {
      slotReleased: false,
      generation: 1,
      sessionId,
      bridgeState: "submitting",
      publicSnapshot: { state: "submitting" },
    });
    await expect(target.service.getRun(applying.id)).resolves.toMatchObject({
      isApplying: true,
    });

    target.repository.finalizeApplicationSubmission(sessionId, "submitted");
    target.repository.recordApplicationSnapshot(applying.id, {
      slotReleased: false,
      generation: 1,
      sessionId,
      bridgeState: "submitted",
      publicSnapshot: { state: "submitted" },
    });

    await expect(target.service.getRun(applying.id)).resolves.toMatchObject({
      isApplying: false,
    });
    await expect(
      target.service.updateApplicationStatus(applying.id, "rejected"),
    ).resolves.toMatchObject({
      applicationStatus: "rejected",
      isApplying: false,
    });
    expect(
      (await target.service.listRuns()).find(({ id }) => id === applying.id),
    ).toMatchObject({ isApplying: false });
  });
  test("omits the job URL for legacy runs", async () => {
    const target = fixture();
    const legacy = target.repository.createRun(JOB_DESCRIPTION, "legacy-run");

    expect(legacy).not.toHaveProperty("jobUrl");
    expect(await target.service.getRun(legacy.id)).not.toHaveProperty("jobUrl");
  });
  test("omits the hint so fallback extraction keeps its inferred opportunity kind", async () => {
    const controller = new AbortController();
    const lines = [
      "Senior Platform Engineer",
      "Example Systems",
      "Own reliable TypeScript services and production delivery.",
    ] as const;
    const selected = `${lines[0]}\n\n${lines[2]}`;
    const observed: {
      loader?: {
        jobUrl: string;
        signal: AbortSignal | undefined;
        opportunityKindHint: OpportunityKind | undefined;
      };
      extractor?: {
        lines: readonly string[];
        signal: AbortSignal | undefined;
        opportunityKindHint: OpportunityKind | undefined;
      };
    } = {};
    const target = fixture({
      loadJobSource: async (jobUrl, signal, opportunityKindHint) => {
        observed.loader = { jobUrl, signal, opportunityKindHint };
        return { kind: "model-fallback", lines };
      },
      extractJobDescription: async (sourceLines, signal, opportunityKindHint) => {
        observed.extractor = { lines: sourceLines, signal, opportunityKindHint };
        return { opportunityKind: "competition", jobDescription: selected };
      },
    });

    const run = await target.service.createRun(JOB_URL, true, false, false, controller.signal);

    expect(observed).toEqual({
      loader: {
        jobUrl: JOB_URL,
        signal: controller.signal,
        opportunityKindHint: undefined,
      },
      extractor: { lines, signal: controller.signal, opportunityKindHint: undefined },
    });
    const input = target.repository.getArtifact(run.id, "job-description")!;
    expect(Buffer.from(await target.artifacts.read(input.path, input.byteSize)).toString("utf8")).toBe(selected);
    expect(target.pipelineDatabase.query<{ job_description: string }, [string]>(
      "SELECT job_description FROM runs WHERE id = ?",
    ).get(run.id)?.job_description).toBe(selected);
    expect(run.jobUrl).toBe(JOB_URL);
    expect(run.opportunityKind).toBe("competition");
  });

  test("keeps an explicit networking event kind authoritative through model-fallback extraction", async () => {
    const lines = [
      "Platform Engineering Networking Evening",
      "Example Systems",
      "Meet engineers working on reliable TypeScript services and production delivery.",
    ] as const;
    const selected = `${lines[0]}\n\n${lines[2]}`;
    const observed: {
      loaderHint: OpportunityKind | undefined;
      extractorHint: OpportunityKind | undefined;
    } = { loaderHint: undefined, extractorHint: undefined };
    const target = fixture({
      loadJobSource: async (_jobUrl, _signal, opportunityKindHint) => {
        observed.loaderHint = opportunityKindHint;
        return { kind: "model-fallback", lines };
      },
      extractJobDescription: async (_sourceLines, _signal, opportunityKindHint) => {
        observed.extractorHint = opportunityKindHint;
        return { opportunityKind: "competition", jobDescription: selected };
      },
    });

    const run = await target.service.createRun(JOB_URL, true, false, false, undefined, "networking_event");

    expect(observed).toEqual({
      loaderHint: "networking_event",
      extractorHint: "networking_event",
    });
    expect(run.opportunityKind).toBe("networking_event");
    expect(target.repository.getRun(run.id)?.opportunityKind).toBe("networking_event");
  });

  test("bubbles loader failures and maps only fixed fallback failures before persistence", async () => {
    for (const code of [
      "JOB_URL_BLOCKED",
      "JOB_SOURCE_UNAVAILABLE",
      "JOB_SOURCE_UNSUPPORTED",
      "JOB_SOURCE_TOO_LARGE",
      "JOB_DESCRIPTION_UNAVAILABLE",
    ] satisfies readonly JobSourceErrorCode[]) {
      const sourceError = new JobSourceError(code);
      const sourceTarget = fixture({
        loadJobSource: async () => { throw sourceError; },
      });
      await expect(sourceTarget.service.createRun(JOB_URL)).rejects.toBe(sourceError);
      expectNoPersistence(sourceTarget);
    }
    const nullTarget = fixture({
      loadJobSource: async () => ({ kind: "model-fallback", lines: ["safe source"] }),
      extractJobDescription: async () => null,
    });
    await expect(nullTarget.service.createRun(JOB_URL)).rejects.toMatchObject({
      code: "JOB_DESCRIPTION_UNAVAILABLE",
      status: 422,
      message: "The page does not contain a usable opportunity description",
    });
    expectNoPersistence(nullTarget);

    for (const failure of [
      {
        error: new OAuthRequiredError("openai-codex"),
        expected: {
          code: "JOB_EXTRACTION_AUTH_REQUIRED",
          status: 409,
          message: "Connect OpenAI Codex OAuth before importing this opportunity page",
        },
      },
      {
        error: new LunaJobExtractionError("timeout", "private timeout detail"),
        expected: {
          code: "JOB_EXTRACTION_TIMEOUT",
          status: 504,
          message: "Opportunity description extraction timed out",
        },
      },
      {
        error: new LunaJobExtractionError("unavailable", "private model detail"),
        expected: {
          code: "JOB_EXTRACTION_UNAVAILABLE",
          status: 502,
          message: "Opportunity description extraction failed",
        },
      },
    ]) {
      const target = fixture({
        loadJobSource: async () => ({ kind: "model-fallback", lines: ["safe source"] }),
        extractJobDescription: async () => { throw failure.error; },
      });
      await expect(target.service.createRun(JOB_URL)).rejects.toMatchObject(failure.expected);
      expectNoPersistence(target);
    }

    const programmingError = new Error("unexpected extractor bug");
    const programmingTarget = fixture({
      loadJobSource: async () => ({ kind: "model-fallback", lines: ["safe source"] }),
      extractJobDescription: async () => { throw programmingError; },
    });
    await expect(programmingTarget.service.createRun(JOB_URL)).rejects.toBe(programmingError);
    expectNoPersistence(programmingTarget);
  });

  test("revalidates and outer-trims every final description before the commit point", async () => {
    const padded = `  ${JOB_DESCRIPTION}  `;
    const validTarget = fixture({
      loadJobSource: async () => ({ kind: "description", opportunityKind: "job", jobDescription: padded }),
    });
    const validRun = await validTarget.service.createRun(JOB_URL);
    const input = validTarget.repository.getArtifact(validRun.id, "job-description")!;
    expect(Buffer.from(
      await validTarget.artifacts.read(input.path, input.byteSize),
    ).toString("utf8")).toBe(JOB_DESCRIPTION);

    for (const invalidDescription of ["too short", "x".repeat(50_001)]) {
      const invalidTarget = fixture({
        loadJobSource: async () => ({ kind: "description", opportunityKind: "job", jobDescription: invalidDescription }),
      });
      await expect(invalidTarget.service.createRun(JOB_URL)).rejects.toMatchObject({
        name: "ZodError",
      });
      expectNoPersistence(invalidTarget);
    }
  });

  test("preserves abort reasons and allocates nothing at every pre-commit cancellation boundary", async () => {
    const beforeLoadController = new AbortController();
    const beforeLoadReason = new Error("cancelled before loading");
    beforeLoadController.abort(beforeLoadReason);
    let loadCalls = 0;
    const beforeLoadTarget = fixture({
      loadJobSource: async () => {
        loadCalls += 1;
        return { kind: "description", opportunityKind: "job", jobDescription: JOB_DESCRIPTION };
      },
    });
    await expect(beforeLoadTarget.service.createRun(
      JOB_URL,
      true,
      false,
      false,
      beforeLoadController.signal,
    )).rejects.toBe(beforeLoadReason);
    expect(loadCalls).toBe(0);
    expectNoPersistence(beforeLoadTarget);

    const loading = Promise.withResolvers<LoadedJobSource>();
    const loadingController = new AbortController();
    const loadingReason = new Error("cancelled while loading");
    let loaderSignal: AbortSignal | undefined;
    const loadingTarget = fixture({
      loadJobSource: (_jobUrl, signal) => {
        loaderSignal = signal;
        return loading.promise;
      },
    });
    const loadingRun = loadingTarget.service.createRun(
      JOB_URL,
      true,
      false,
      false,
      loadingController.signal,
    );
    expect(loaderSignal).toBe(loadingController.signal);
    loadingController.abort(loadingReason);
    loading.resolve({ kind: "description", opportunityKind: "job", jobDescription: JOB_DESCRIPTION });
    await expect(loadingRun).rejects.toBe(loadingReason);
    expectNoPersistence(loadingTarget);

    const extracting = Promise.withResolvers<{
      readonly opportunityKind: "job";
      readonly jobDescription: string;
    } | null>();
    const extractorStarted = Promise.withResolvers<void>();
    const extractingController = new AbortController();
    const extractingReason = new Error("cancelled while extracting");
    let extractorSignal: AbortSignal | undefined;
    const extractingTarget = fixture({
      loadJobSource: async () => ({ kind: "model-fallback", lines: ["bounded", "visible", "source"] }),
      extractJobDescription: (_lines, signal) => {
        extractorSignal = signal;
        extractorStarted.resolve();
        return extracting.promise;
      },
    });
    const extractingRun = extractingTarget.service.createRun(
      JOB_URL,
      true,
      false,
      false,
      extractingController.signal,
    );
    await extractorStarted.promise;
    expect(extractorSignal).toBe(extractingController.signal);
    extractingController.abort(extractingReason);
    extracting.resolve({ opportunityKind: "job", jobDescription: JOB_DESCRIPTION });
    await expect(extractingRun).rejects.toBe(extractingReason);
    expectNoPersistence(extractingTarget);

    const snapshot = Promise.withResolvers<ContextSnapshot>();
    const snapshotStarted = Promise.withResolvers<void>();
    const snapshotController = new AbortController();
    const snapshotReason = new Error("cancelled while snapshotting");
    let resolvedSnapshot: ContextSnapshot | undefined;
    const snapshotTarget = fixture({
      createSnapshot: (defaultSnapshot) => {
        resolvedSnapshot = defaultSnapshot();
        snapshotStarted.resolve();
        return snapshot.promise;
      },
    });
    const snapshotRun = snapshotTarget.service.createRun(
      JOB_URL,
      true,
      false,
      false,
      snapshotController.signal,
    );
    await snapshotStarted.promise;
    snapshotController.abort(snapshotReason);
    snapshot.resolve(resolvedSnapshot!);
    await expect(snapshotRun).rejects.toBe(snapshotReason);
    expectNoPersistence(snapshotTarget);

    const afterSnapshotController = new AbortController();
    const afterSnapshotReason = new Error("cancelled immediately after snapshot");
    const afterSnapshotTarget = fixture({
      createSnapshot: (defaultSnapshot) => {
        const value = defaultSnapshot();
        afterSnapshotController.abort(afterSnapshotReason);
        return value;
      },
    });
    await expect(
      afterSnapshotTarget.service.createRun(
        JOB_URL,
        true,
        false,
        false,
        afterSnapshotController.signal,
      ),
    ).rejects.toBe(afterSnapshotReason);
    expectNoPersistence(afterSnapshotTarget);
  });

  test("ignores a late request abort after the snapshot commit point and completes the queued run", async () => {
    const controller = new AbortController();
    const lateReason = new Error("late disconnect");
    const target = fixture({
      idFactory: () => {
        controller.abort(lateReason);
        return "run-late";
      },
    });
    const route = createApiHandler({ webOrigin: ORIGIN, route: createRunRoutes(target.service) });
    const request = new Request("http://127.0.0.1:3457/v1/runs", {
      ...post({ jobUrl: JOB_URL }),
      signal: controller.signal,
    });

    const response = await route(request);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: "run-late", status: "queued", revision: 1 });
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toBe(lateReason);
    expect(target.ids.count).toBe(1);
    expect(target.kicks.count).toBe(1);
    expect(persistenceCounts(target.pipelineDatabase)).toEqual({
      runs: 1,
      revisions: 1,
      snapshots: 1,
      artifacts: 1,
      events: 3,
    });
    const input = target.repository.getArtifact("run-late", "job-description")!;
    expect(Buffer.from(await target.artifacts.read(input.path, input.byteSize)).toString("utf8")).toBe(JOB_DESCRIPTION);
    expect(target.repository.getRun("run-late")).toMatchObject({
      id: "run-late",
      status: "queued",
      jobDescription: JOB_DESCRIPTION,
    });
  });

  test("updates application status independently and rejects a missing run", async () => {
    const target = fixture();
    const created = await target.service.createRun(JOB_URL);
    expect(created).toMatchObject({ applicationStatus: "pending", status: "queued" });

    const updated = await target.service.updateApplicationStatus(created.id, "accepted");

    expect(updated).toMatchObject({ applicationStatus: "accepted", status: "queued" });
    await expect(target.service.getRun(created.id)).resolves.toMatchObject({ applicationStatus: "accepted", status: "queued" });
    await expect(target.service.updateApplicationStatus("run-missing", "failed")).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
      status: 404,
    });
  });

  test("returns durable identity overrides and maps soft deletion conflicts and visibility", async () => {
    const target = fixture();
    const created = await target.service.createRun(JOB_URL);
    expect(created).not.toHaveProperty("titleOverride");
    expect(created).not.toHaveProperty("organizationOverride");

    const titled = await target.service.updateRunIdentity(created.id, { title: "Platform Engineer" });
    expect(RunDtoSchema.parse(titled)).toMatchObject({ titleOverride: "Platform Engineer" });
    expect(titled).not.toHaveProperty("organizationOverride");
    const identified = await target.service.updateRunIdentity(created.id, { organization: "Example Labs" });
    expect(identified).toMatchObject({
      titleOverride: "Platform Engineer",
      organizationOverride: "Example Labs",
    });

    const claim = target.repository.acquire()!;
    await expect(target.service.deleteRun(created.id)).rejects.toMatchObject({
      code: "RUN_CLAIMED",
      status: 409,
    });
    target.repository.release(claim);
    await target.service.deleteRun(created.id);

    await expect(target.service.getRun(created.id)).resolves.toBeUndefined();
    await expect(target.service.listRuns()).resolves.toEqual([]);
    await expect(target.service.getArtifact(created.id, "any-artifact")).resolves.toBeUndefined();
    await expect(target.service.updateApplicationStatus(created.id, "failed")).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
      status: 404,
    });
    await expect(
      target.service.updateRunIdentity(created.id, { title: "Hidden" }),
    ).rejects.toMatchObject({ code: "RUN_NOT_FOUND", status: 404 });
    expect(target.pipelineDatabase.query<{ deleted_at: number | null }, [string]>(
      "SELECT deleted_at FROM runs WHERE id = ?",
    ).get(created.id)?.deleted_at).toBeNumber();
  });

  test("maps a retry event to the compiling status that starts the new revision", async () => {
    const target = fixture();
    const run = await target.service.createRun(JOB_URL);
    const claim = target.repository.acquire()!;
    transition(target.repository, claim, ["analyzing", "tailoring", "compiling"]);
    target.repository.transition(claim, "failed", { failedStage: "compiling" });
    target.repository.release(claim);

    const retried = await target.service.retryRun(run.id);
    const finalTimelineEntry = retried.timeline.at(-1);

    expect(finalTimelineEntry?.type).toBe("run.retried");
    expect(finalTimelineEntry?.revision).toBe(2);
    expect(finalTimelineEntry?.status).toBe("compiling");
  });

  test("maps an edit-request event to the editing status that starts the new revision", async () => {
    const target = fixture();
    const run = await target.service.createRun(JOB_URL);
    const pdf = await finalizeReviewPdf(target, run.id);

    const edited = await target.service.editRun(run.id, "Shorten the opening paragraph.", pdf.sha256);
    const finalTimelineEntry = edited.timeline.at(-1);

    expect(finalTimelineEntry?.type).toBe("run.edit_requested");
    expect(finalTimelineEntry?.revision).toBe(2);
    expect(finalTimelineEntry?.status).toBe("editing");
  });

  test("maps attempts, retry ancestry and inherited artifacts without exposing internal tokens, paths or logs", async () => {
    const target = fixture();
    const run = await target.service.createRun(JOB_URL);
    const claim = target.repository.acquire()!;
    target.repository.transition(claim, "analyzing");
    const analysisAttempt = target.repository.startAttempt(claim, "analyzing");
    const analysisRoot = await target.artifacts.createAttempt({ run: target.repository.getRun(run.id)!.queueSequence, revision: "1", stage: "analyzing", attempt: 1 });
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
    const retryIterations = await target.service.listResumeIterations(run.id);
    expect(retryIterations.iterations).toHaveLength(1);
    expect(retryIterations.iterations[0]).toMatchObject({
      revision: 2,
      origin: "initial",
      status: "review",
      artifacts: expect.arrayContaining([
        expect.objectContaining({ id: analysisArtifact.id }),
        expect.objectContaining({ id: pdf.id }),
      ]),
    });
    const dto = await target.service.getRun(run.id);
    expect(dto?.attempts.map((attempt) => attempt.stage)).toEqual(["analysis", "compile", "visual-qa"]);
    expect(dto?.artifacts.map((artifact) => artifact.id)).toEqual(expect.arrayContaining([analysisArtifact.id, pdf.id]));
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("private-process-token");
    expect(serialized).not.toContain(analysis.path);
    expect(serialized).not.toContain("attemptSessionId");
    expect(serialized).not.toContain("jobDescription");
  });

  test("exposes only the inherited current job analysis for a retained failed revision", async () => {
    const target = fixture();
    const run = await target.service.createRun(JOB_URL);
    const claim = target.repository.acquire()!;
    target.repository.transition(claim, "analyzing");
    const analysisAttempt = target.repository.startAttempt(claim, "analyzing");
    const analysisRoot = await target.artifacts.createAttempt({
      run: target.repository.getRun(run.id)!.queueSequence,
      revision: "1",
      stage: "analyzing",
      attempt: analysisAttempt.attemptNo,
    });
    const analysisBody = JSON.stringify({
      jobTitle: "Platform Engineer",
      organization: "Example Labs",
    });
    const storedAnalysis = await target.artifacts.write(
      join(analysisRoot, "analysis.json"),
      analysisBody,
      1024 * 1024,
    );
    const analysisArtifact = target.repository.finalizeArtifact(claim, {
      attemptId: analysisAttempt.id,
      stage: "analyzing",
      kind: "job-analysis",
      sha256: storedAnalysis.sha256,
      path: storedAnalysis.path,
      byteSize: storedAnalysis.bytes,
    });
    const extractionBody = JSON.stringify({
      keywords: [{ id: "keyword-typescript", phrase: "TypeScript", jdQuote: "TypeScript" }],
    });
    const storedExtraction = await target.artifacts.write(
      join(analysisRoot, "ats-keyword-extraction.json"),
      extractionBody,
      1024 * 1024,
    );
    const extractionArtifact = target.repository.finalizeArtifact(claim, {
      attemptId: analysisAttempt.id,
      stage: "analyzing",
      kind: "ats-keyword-extraction",
      sha256: storedExtraction.sha256,
      path: storedExtraction.path,
      byteSize: storedExtraction.bytes,
    });
    target.repository.finishAttempt(claim, analysisAttempt.id, "succeeded");
    transition(target.repository, claim, ["tailoring", "compiling"]);
    target.repository.transition(claim, "failed", { failedStage: "compiling" });
    target.repository.release(claim);

    await target.service.retryRun(run.id);
    const revisedClaim = target.repository.acquire()!;
    target.repository.transition(revisedClaim, "failed", { failedStage: "compiling" });
    target.repository.release(revisedClaim);

    const failedDto = RunDtoSchema.parse(await target.service.getRun(run.id));
    expect(failedDto).toMatchObject({ status: "failed", revision: 2 });
    expect(failedDto.artifacts).toEqual([
      expect.objectContaining({
        id: analysisArtifact.id,
        kind: "job-analysis",
        revision: 1,
        href: `/v1/runs/${run.id}/artifacts/${analysisArtifact.id}`,
      }),
    ]);
    expect(failedDto.artifacts.some((artifact) => artifact.id === extractionArtifact.id)).toBeFalse();

    const analysisResponse = await target.service.getArtifact(run.id, analysisArtifact.id);
    expect(analysisResponse?.status).toBe(200);
    expect(analysisResponse?.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(analysisResponse?.headers.get("x-content-sha256")).toBe(analysisArtifact.sha256);
    expect(await analysisResponse?.json()).toEqual({
      jobTitle: "Platform Engineer",
      organization: "Example Labs",
    });
    expect(await target.service.getArtifact(run.id, extractionArtifact.id)).toBeUndefined();

    target.pipelineDatabase.query(`
      INSERT INTO run_artifact_retention(run_id, state, selected_at)
      VALUES (?, 'pruning', 100)
    `).run(run.id);
    expect(RunDtoSchema.parse(await target.service.getRun(run.id)).artifacts).toEqual([]);
    await expect(target.service.getArtifact(run.id, analysisArtifact.id)).rejects.toMatchObject({
      code: "RUN_ARTIFACTS_PRUNED",
      status: 410,
    });
  });

  test("enforces review/hash/source invariants and preserves exact inert edit comments", async () => {
    const target = fixture();
    const run = await target.service.createRun(JOB_URL);
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
    await expect(target.service.retryRun(run.id)).rejects.toMatchObject({ code: "SOURCE_DRIFT", status: 409 });
    expect(target.syncs.count).toBe(1);
  });

  test("maps every artifact-dependent command on a reserved run to HTTP 410", async () => {
    let contextAvailable = true;
    const target = fixture({
      createSnapshot: (defaultSnapshot) => {
        if (!contextAvailable) throw new Error("context unavailable");
        return defaultSnapshot();
      },
    });
    const reviews: { id: string; artifactId: string; pdfSha256: string }[] = [];
    for (let index = 0; index < 12; index++) {
      const run = await target.service.createRun(JOB_URL);
      const pdf = await finalizeReviewPdf(target, run.id);
      reviews.push({ id: run.id, artifactId: pdf.id, pdfSha256: pdf.sha256 });
    }
    target.pipelineDatabase.query("UPDATE runs SET status='failed', failed_stage='compiling' WHERE id=?").run(reviews[0]!.id);
    target.pipelineDatabase.query(`
      INSERT INTO run_artifact_retention(run_id, state, selected_at, pruned_at)
      VALUES (?, 'pruned', 1, 1), (?, 'pruned', 1, 1)
    `).run(reviews[0]!.id, reviews[1]!.id);
    const prunedDto = await target.service.getRun(reviews[1]!.id);
    expect(prunedDto).toMatchObject({
      status: "review",
      applicationStatus: "pending",
      artifacts: [],
    });
    expect(prunedDto).not.toHaveProperty("currentPdfSha256");
    expect(prunedDto!.attempts.length).toBeGreaterThan(0);
    expect(prunedDto!.timeline.length).toBeGreaterThan(0);
    await expect(target.service.updateApplicationStatus(reviews[1]!.id, "interview")).resolves.toMatchObject({
      status: "review",
      applicationStatus: "interview",
      artifacts: [],
    });
    contextAvailable = false;
    const expected = {
      code: "RUN_ARTIFACTS_PRUNED",
      message: "Historical run artifacts are unavailable",
      status: 410,
    };

    await expect(target.service.retryRun(reviews[0]!.id)).rejects.toMatchObject(expected);
    await expect(target.service.regenerateRun(reviews[1]!.id, reviews[1]!.pdfSha256)).rejects.toMatchObject(expected);
    await expect(target.service.editRun(reviews[1]!.id, "change layout", reviews[1]!.pdfSha256)).rejects.toMatchObject(expected);
    await expect(target.service.approveRun(reviews[1]!.id, reviews[1]!.pdfSha256, false)).rejects.toMatchObject(expected);
    await expect(target.service.getArtifact(reviews[1]!.id, reviews[1]!.artifactId)).rejects.toMatchObject(expected);
  });
  test("translates a download race with a new pruning reservation to HTTP 410", async () => {
    const target = fixture();
    const run = await target.service.createRun(JOB_URL);
    const pdf = await finalizeReviewPdf(target, run.id);
    target.artifacts.read = async () => {
      target.pipelineDatabase.query(`
        INSERT INTO run_artifact_retention(run_id, state, selected_at)
        VALUES (?, 'pruning', 100)
      `).run(run.id);
      throw Object.assign(new Error("artifact disappeared"), { code: "ENOENT" });
    };

    await expect(target.service.getArtifact(run.id, pdf.id)).rejects.toMatchObject({
      code: "RUN_ARTIFACTS_PRUNED",
      message: "Historical run artifacts are unavailable",
      status: 410,
    });
  });

  test("lists retained historical iterations and authorizes exact revision artifacts", async () => {
    const target = fixture();
    const run = await target.service.createRun(JOB_URL);
    const first = await finalizeReviewPdf(
      target,
      run.id,
      "%PDF-1.7\niteration-one",
      false,
      undefined,
      "\\documentclass{article}\\begin{document}One\\end{document}",
    );

    await target.service.editRun(run.id, "Emphasize platform ownership", first.sha256);
    const whileEditing = ResumeIterationListResponseSchema.parse(
      await target.service.listResumeIterations(run.id),
    );
    expect(whileEditing.iterations).toHaveLength(1);
    expect(whileEditing.iterations[0]).toMatchObject({
      revision: 1,
      origin: "initial",
      status: "review",
      pdfSha256: first.sha256,
    });
    expect(await target.service.getResumeIterationArtifact(run.id, 2, first.id))
      .toBeUndefined();

    const second = await finalizeReviewPdf(
      target,
      run.id,
      "%PDF-1.7\niteration-two",
    );
    await target.service.regenerateRun(run.id, second.sha256);
    const third = await finalizeReviewPdf(
      target,
      run.id,
      "%PDF-1.7\niteration-three",
    );
    await target.service.approveRun(run.id, third.sha256, false);
    const listed = ResumeIterationListResponseSchema.parse(
      await target.service.listResumeIterations(run.id),
    );

    expect(listed.artifactState).toBe("retained");
    expect(listed.iterations.map((iteration) => ({
      revision: iteration.revision,
      origin: iteration.origin,
      status: iteration.status,
      pdfSha256: iteration.pdfSha256,
    }))).toEqual([
      { revision: 1, origin: "initial", status: "review", pdfSha256: first.sha256 },
      { revision: 2, origin: "human-comments", status: "review", pdfSha256: second.sha256 },
      { revision: 3, origin: "machine-regeneration", status: "approved", pdfSha256: third.sha256 },
    ]);
    expect(
      listed.iterations[0]?.artifacts.find((artifact) => artifact.id === first.id)?.href,
    ).toBe(`/v1/runs/${run.id}/iterations/1/artifacts/${first.id}`);
    expect(
      listed.iterations[1]?.artifacts.find((artifact) => artifact.id === second.id)?.href,
    ).toBe(`/v1/runs/${run.id}/iterations/2/artifacts/${second.id}`);
    expect(
      listed.iterations[2]?.artifacts.find((artifact) => artifact.id === third.id)?.href,
    ).toBe(`/v1/runs/${run.id}/iterations/3/artifacts/${third.id}`);
    const historical = await target.service.getResumeIterationArtifact(run.id, 1, first.id);
    expect(historical?.status).toBe(200);
    expect(await historical?.text()).toBe("%PDF-1.7\niteration-one");
    expect(await target.service.getResumeIterationArtifact(run.id, 2, first.id))
      .toBeUndefined();
    const input = target.repository.getArtifact(run.id, "job-description")!;
    expect(await target.service.getResumeIterationArtifact(run.id, 1, input.id))
      .toBeUndefined();

    target.pipelineDatabase.query(`
      INSERT INTO run_artifact_retention(run_id, state, selected_at)
      VALUES (?, 'pruning', 100)
    `).run(run.id);
    const pruned = ResumeIterationListResponseSchema.parse(
      await target.service.listResumeIterations(run.id),
    );
    expect(pruned.artifactState).toBe("pruned");
    expect(pruned.iterations.map(({ revision, pdfSha256, artifacts }) => ({
      revision,
      pdfSha256,
      artifacts,
    }))).toEqual([
      { revision: 1, pdfSha256: first.sha256, artifacts: [] },
      { revision: 2, pdfSha256: second.sha256, artifacts: [] },
      { revision: 3, pdfSha256: third.sha256, artifacts: [] },
    ]);
    await expect(
      target.service.getResumeIterationArtifact(run.id, 1, first.id),
    ).rejects.toMatchObject({ code: "RUN_ARTIFACTS_PRUNED", status: 410 });
  });

  test("serves public resume and JSON artifacts with their public media metadata", async () => {
    const target = fixture();
    const run = await target.service.createRun(JOB_URL, true);
    const claim = target.repository.acquire()!;
    target.repository.transition(claim, "analyzing");
    const analysisAttempt = target.repository.startAttempt(claim, "analyzing");
    const analysisRoot = await target.artifacts.createAttempt({
      run: target.repository.getRun(run.id)!.queueSequence,
      revision: "1",
      stage: "analyzing",
      attempt: analysisAttempt.attemptNo,
    });
    const extractionBody = JSON.stringify({
      keywords: [{ id: "keyword-typescript", phrase: "TypeScript", jdQuote: "TypeScript" }],
    });
    const storedExtraction = await target.artifacts.write(
      join(analysisRoot, "ats-keyword-extraction.json"),
      extractionBody,
      1024 * 1024,
    );
    const extraction = target.repository.finalizeArtifact(claim, {
      attemptId: analysisAttempt.id,
      stage: "analyzing",
      kind: "ats-keyword-extraction",
      sha256: storedExtraction.sha256,
      path: storedExtraction.path,
      byteSize: storedExtraction.bytes,
    });
    target.repository.finishAttempt(claim, analysisAttempt.id, "succeeded");
    const latestAnalysisAttempt = target.repository.startAttempt(claim, "analyzing");
    const latestExtractionBody = JSON.stringify({
      keywords: [{ id: "keyword-platform", phrase: "Platform", jdQuote: "Platform" }],
    });
    const storedLatestExtraction = await target.artifacts.write(
      join(analysisRoot, "ats-keyword-extraction-latest.json"),
      latestExtractionBody,
      1024 * 1024,
    );
    const latestExtraction = target.repository.finalizeArtifact(claim, {
      attemptId: latestAnalysisAttempt.id,
      stage: "analyzing",
      kind: "ats-keyword-extraction",
      sha256: storedLatestExtraction.sha256,
      path: storedLatestExtraction.path,
      byteSize: storedLatestExtraction.bytes,
    });
    target.repository.finishAttempt(claim, latestAnalysisAttempt.id, "succeeded");
    transition(target.repository, claim, ["tailoring", "compiling", "deterministic_qa", "visual_qa"]);
    target.repository.release(claim);
    const pdf = await finalizeReviewPdf(target, run.id, "%PDF-1.7\nreview", false, "%PDF-1.7\nkeyword-map", "\\documentclass{article}");
    const response = await target.service.getArtifact(run.id, pdf.id);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("content-type")).toBe("application/pdf");
    expect(response?.headers.get("content-disposition")).toBe('inline; filename="Alex_Example_Resume.pdf"');
    expect(response?.headers.get("x-content-sha256")).toBe(pdf.sha256);
    expect(await response?.text()).toBe("%PDF-1.7\nreview");

    const tex = await target.service.getArtifact(run.id, pdf.tailoredTexId!);
    expect(tex?.status).toBe(200);
    expect(tex?.headers.get("content-type")).toBe("text/x-tex; charset=utf-8");
    expect(tex?.headers.get("content-disposition")).toBe('attachment; filename="Alex_Example_Resume.tex"');
    expect(await tex?.text()).toBe("\\documentclass{article}");

    const map = await target.service.getArtifact(run.id, pdf.keywordMapId!);
    expect(map?.status).toBe(200);
    expect(map?.headers.get("content-type")).toBe("application/pdf");
    expect(map?.headers.get("content-disposition")).toBe('inline; filename="keyword-map-pdf.pdf"');
    expect(await map?.text()).toBe("%PDF-1.7\nkeyword-map");

    const coverage = await target.service.getArtifact(run.id, pdf.keywordCoverageId!);
    expect(coverage?.status).toBe(200);
    expect(coverage?.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(coverage?.headers.get("content-disposition")).toBe('attachment; filename="keyword-map.json"');
    expect(await coverage?.json()).toMatchObject({
      schemaVersion: 1,
      pdfSha256: pdf.sha256,
      keywords: [{ id: "keyword-platform", phrase: "Platform", found: true }],
    });

    const dto = RunDtoSchema.parse(await target.service.getRun(run.id));
    expect(dto?.artifacts.find((artifact) => artifact.id === pdf.keywordMapId)).toMatchObject({
      kind: "keyword-map-pdf",
      mediaType: "application/pdf",
      public: true,
    });
    expect(dto?.artifacts.find((artifact) => artifact.id === pdf.keywordCoverageId)).toMatchObject({
      kind: "keyword-map",
      mediaType: "application/json; charset=utf-8",
      public: true,
    });
    expect(dto.artifacts.find((artifact) => artifact.id === latestExtraction.id)).toMatchObject({
      kind: "ats-keyword-extraction",
      mediaType: "application/json; charset=utf-8",
      public: true,
    });
    const extractionResponse = await target.service.getArtifact(run.id, latestExtraction.id);
    expect(extractionResponse?.status).toBe(200);
    expect(extractionResponse?.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await extractionResponse?.text()).toBe(latestExtractionBody);
    await target.service.approveRun(run.id, pdf.sha256, false);
    expect(await target.service.getArtifact(run.id, extraction.id)).toBeUndefined();
    const input = target.repository.getArtifact(run.id, "job-description")!;
    expect(await target.service.getArtifact(run.id, input.id)).toBeUndefined();
  });

  test("serves the current resume diff as public JSON", async () => {
    const target = fixture();
    const run = await target.service.createRun(JOB_URL);
    const claim = target.repository.acquire()!;
    transition(target.repository, claim, ["analyzing", "tailoring"]);
    const attempt = target.repository.startAttempt(claim, "tailoring");
    const root = await target.artifacts.createAttempt({
      run: target.repository.getRun(run.id)!.queueSequence,
      revision: "1",
      stage: "tailoring",
      attempt: attempt.attemptNo,
    });
    const body = JSON.stringify({ schemaVersion: 1, sections: [] });
    const stored = await target.artifacts.write(join(root, "resume-diff.json"), body, 1024 * 1024);
    const artifact = target.repository.finalizeArtifact(claim, {
      attemptId: attempt.id,
      stage: "tailoring",
      kind: "resume-diff",
      sha256: stored.sha256,
      path: stored.path,
      byteSize: stored.bytes,
    });
    target.repository.finishAttempt(claim, attempt.id, "succeeded");
    transition(target.repository, claim, ["compiling", "deterministic_qa", "visual_qa"]);
    target.repository.release(claim);
    await finalizeReviewPdf(target, run.id);

    const dto = RunDtoSchema.parse(await target.service.getRun(run.id));
    expect(dto.artifacts.find((candidate) => candidate.id === artifact.id)).toMatchObject({
      kind: "resume-diff",
      mediaType: "application/json; charset=utf-8",
      public: true,
    });
    const response = await target.service.getArtifact(run.id, artifact.id);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response?.headers.get("content-disposition")).toBe('attachment; filename="resume-diff.json"');
    expect(await response?.text()).toBe(body);
  });
});

describe("public run and context routes", () => {
  test("preserves exact comments, kicks the scheduler, and marks every response no-store", async () => {
    const target = fixture();
    const route = createApiHandler({ webOrigin: ORIGIN, route: createRunRoutes(target.service) });
    const created = await route(new Request("http://127.0.0.1:3457/v1/runs", post({
      jobUrl: JOB_URL,
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

describe("saved discovery descriptions", () => {
  test("creates and atomically links a run without loading or extracting the job URL", async () => {
    let loads = 0;
    let extractions = 0;
    const target = fixture({
      loadJobSource: async () => {
        loads += 1;
        throw new Error("the URL loader must not run");
      },
      extractJobDescription: async () => {
        extractions += 1;
        throw new Error("the Luna extractor must not run");
      },
    });
    target.pipelineDatabase.query(`
      INSERT INTO discovery_jobs(
        id, catalog_source_id, catalog_source_item_id,
        title, company, location, canonical_url, apply_url,
        description, posted_at, first_seen_at, last_seen_at, closed
      ) VALUES (?, 'fixture-source', 'fixture-item', ?, ?, NULL, ?, ?, ?, NULL, 90, 90, 0)
    `).run(
      "discovery-job-1",
      "Software Engineering Intern",
      "Example",
      JOB_URL,
      JOB_URL,
      JOB_DESCRIPTION,
    );
    target.pipelineDatabase.query(
      "INSERT INTO discovery_job_roles(job_id, role) VALUES (?, 'software_engineering')",
    ).run("discovery-job-1");

    const run = await target.service.createRunFromDescription(
      "discovery-job-1",
      JOB_URL,
      JOB_DESCRIPTION,
      true,
      false,
      false,
    );

    expect(loads).toBe(0);
    expect(extractions).toBe(0);
    expect(target.repository.getRunJobUrl(run.id)).toBe(JOB_URL);
    expect(target.pipelineDatabase.query<{ run_id: string }, [string]>(
      "SELECT run_id FROM discovery_run_links WHERE job_id = ?",
    ).get("discovery-job-1")?.run_id).toBe(run.id);
    const input = target.repository.listArtifacts(run.id)
      .find((artifact) => artifact.kind === "job-description");
    expect(input).toBeDefined();
    expect(readFileSync(input!.path, "utf8")).toBe(JOB_DESCRIPTION);

    await expect(target.service.createRunFromDescription(
      "discovery-job-1",
      JOB_URL,
      JOB_DESCRIPTION,
    )).rejects.toMatchObject({ reason: "already_queued" });
    expect(target.repository.listRuns()).toHaveLength(1);
    await target.service.deleteRun(run.id);
    const requeued = await target.service.createRunFromDescription(
      "discovery-job-1",
      JOB_URL,
      JOB_DESCRIPTION,
    );
    expect(requeued.id).not.toBe(run.id);
    expect(target.pipelineDatabase.query<{ run_id: string }, [string]>(
      "SELECT run_id FROM discovery_run_links WHERE job_id = ?",
    ).get("discovery-job-1")?.run_id).toBe(requeued.id);
    expect(target.repository.listRuns()).toHaveLength(1);
  });

  test("validates a saved discovery destination before reserving run state", async () => {
    const blocked = new JobSourceError("JOB_URL_BLOCKED");
    const target = fixture({
      validatePublicJobUrl: async () => {
        throw blocked;
      },
    });
    target.pipelineDatabase.query(`
      INSERT INTO discovery_jobs(
        id, catalog_source_id, catalog_source_item_id,
        title, company, location, canonical_url, apply_url,
        description, posted_at, first_seen_at, last_seen_at, closed
      ) VALUES (?, 'fixture-source', 'fixture-item-blocked', ?, ?, NULL, ?, ?, ?, NULL, 90, 90, 0)
    `).run(
      "discovery-job-blocked",
      "Software Engineering Intern",
      "Example",
      JOB_URL,
      JOB_URL,
      JOB_DESCRIPTION,
    );
    target.pipelineDatabase.query(
      "INSERT INTO discovery_job_roles(job_id, role) VALUES (?, 'software_engineering')",
    ).run("discovery-job-blocked");

    await expect(target.service.createRunFromDescription(
      "discovery-job-blocked",
      JOB_URL,
      JOB_DESCRIPTION,
    )).rejects.toBe(blocked);
    expect(target.repository.listRuns()).toEqual([]);
    expect(target.pipelineDatabase.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM discovery_run_links",
    ).get()?.count).toBe(0);
  });
});
