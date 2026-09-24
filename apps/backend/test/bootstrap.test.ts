import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthRouteService } from "../src/api/auth-routes.ts";
import { HttpApplicationHarnessClient } from "../src/api/application-harness-client.ts";
import {
  createPipelineApplication,
  type PipelineApplication,
  type PipelineApplicationOptions,
  type PipelineApplicationSessionService,
  type PipelineWorkerHandle,
} from "../src/bootstrap.ts";
import {
  loadJobSourceFromUrl,
  type LoadedJobSource,
  type LoadJobSource,
} from "../src/api/job-source.ts";
import { RunApplicationService } from "../src/api/run-service.ts";
import {
  extractJobDescriptionWithLuna,
  LUNA_MODEL_NAME,
  type ExtractJobDescription,
} from "../src/models/luna-job-extractor.ts";
import { createContextApplicationService } from "../src/context/application-service.ts";
import { REPOSITORY_ROOT, loadContextManifest } from "../src/context/manifest.ts";
import { openContextDatabase } from "../src/context/database.ts";
import { openPipelineDatabase } from "../src/db/database.ts";
import { PipelineRepository } from "../src/db/repository.ts";
import { ArtifactStore } from "../src/system/artifacts.ts";
import { writeSyntheticContextSources } from "./private-context.fixture.ts";

const WEB_ORIGIN = "http://127.0.0.1:3456";
const JOB_URL = "https://jobs.example.test/platform";
const JOB_DESCRIPTION = "Platform Engineer\n\nBuild and maintain a reliable TypeScript platform for job seekers.";
const HARNESS_TOKEN = "bootstrap-harness-token-0123456789abcdef";
const MIGRATED_RUN_ID = "11111111-1111-4111-8111-111111111111";
const fixtures: string[] = [];
const TEMP_ROOT = realpathSync(tmpdir());

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

interface IngestionOverrides {
  readonly baselineOnlyContext?: boolean;
  readonly loadJobSource?: LoadJobSource;
  readonly extractJobDescription?: ExtractJobDescription;
  readonly browserHarnessToken?: string;
  readonly applicationHarness?: PipelineApplicationOptions["applicationHarness"];
  readonly useDefaultAuth?: boolean;
  readonly applicationSessions?: PipelineApplicationSessionService;
  readonly getAuthStatus?: AuthRouteService["getAuthStatus"];
  readonly webOrigin?: string;
  readonly artifactRoot?: string;
  readonly injectPipelineDatabase?: boolean;
  readonly beforeApplication?: (
    repository: PipelineRepository,
    database: Database,
  ) => void;
  readonly useDefaultWorker?: boolean;
  readonly workerOptions?: PipelineApplicationOptions["workerOptions"];
  readonly sourceHandoffs?: PipelineApplicationOptions["sourceHandoffs"];
}

function createFixture(suppliedRuns = false, ingestion: IngestionOverrides = {}) {
  const pipelineDatabase = openPipelineDatabase(":memory:");
  const contextDatabase = openContextDatabase(":memory:");
  const artifactRoot = ingestion.artifactRoot
    ?? join(mkdtempSync(join(TEMP_ROOT, "pipeline-bootstrap-")), "runs");
  fixtures.push(join(artifactRoot, ".."));
  const calls = {
    kick: 0,
    close: [] as string[],
    startAuth: 0,
    loadedUrls: [] as string[],
    loadedSignals: [] as (AbortSignal | undefined)[],
    extractedLines: [] as (readonly string[])[],
    extractedSignals: [] as (AbortSignal | undefined)[],
    suppliedLoads: 0,
  };
  const worker: PipelineWorkerHandle = {
    kick: () => { calls.kick += 1; },
    close: async () => { calls.close.push("worker"); },
  };
  const auth: AuthRouteService & { close(): void } = {
    getAuthStatus: ingestion.getAuthStatus ?? (() => ({
      providers: [
        { provider: "openai-codex", state: "disconnected" },
        { provider: "google-antigravity", state: "disconnected" },
        { provider: "gmail", state: "disconnected" },
      ],
    })),
    startSession: async () => {
      calls.startAuth += 1;
      throw new Error("authentication must not start in this test");
    },
    getSession: () => undefined,
    answerPrompt: () => { throw new Error("unexpected prompt"); },
    cancelSession: async () => undefined,
    logout: async () => undefined,
    close: () => { calls.close.push("auth"); },
  };
  const contextRoot = realpathSync(mkdtempSync(join(TEMP_ROOT, "pipeline-context-")));
  fixtures.push(contextRoot);
  const manifestRelative = "apps/backend/context-sources.json";
  mkdirSync(join(contextRoot, "apps/backend"), { recursive: true });
  copyFileSync(join(REPOSITORY_ROOT, manifestRelative), join(contextRoot, manifestRelative));
  if (ingestion.baselineOnlyContext) {
    const path = join(contextRoot, manifestRelative);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.sources = manifest.sources.filter((source: { id: string }) => source.id === "resume-baseline");
    writeFileSync(path, JSON.stringify(manifest));
  }
  writeSyntheticContextSources(contextRoot);
  const loadedManifest = loadContextManifest(join(contextRoot, manifestRelative), contextRoot);
  const context = createContextApplicationService({ database: contextDatabase, loadedManifest });
  const closeContext = context.close.bind(context);
  context.close = () => {
    calls.close.push("context");
    closeContext();
  };
  const closePipelineDatabase = pipelineDatabase.close.bind(pipelineDatabase);
  pipelineDatabase.close = () => {
    calls.close.push("pipeline-database");
    closePipelineDatabase();
  };
  const closeContextDatabase = contextDatabase.close.bind(contextDatabase);
  contextDatabase.close = () => {
    calls.close.push("context-database");
    closeContextDatabase();
  };
  const artifacts = new ArtifactStore(artifactRoot);
  const repository = new PipelineRepository(pipelineDatabase);
  ingestion.beforeApplication?.(repository, pipelineDatabase);
  const runs = suppliedRuns
    ? new RunApplicationService({
        repository,
        context,
        artifacts,
        scheduler: worker,
        loadJobSource: async () => {
          calls.suppliedLoads += 1;
          return { kind: "description", opportunityKind: "job", jobDescription: JOB_DESCRIPTION };
        },
        extractJobDescription: async () => {
          throw new Error("deterministic source must not invoke extraction");
        },
      })
    : undefined;
  const app = createPipelineApplication({
    webOrigin: ingestion.webOrigin ?? WEB_ORIGIN,
    ...(ingestion.injectPipelineDatabase === false ? {} : { pipelineDatabase }),
    contextDatabase,
    repository,
    artifacts,
    context,
    ...(ingestion.useDefaultWorker
      ? (ingestion.workerOptions ? { workerOptions: ingestion.workerOptions } : {})
      : { worker }),
    ...(ingestion.useDefaultAuth ? {} : { auth }),
    ...(runs ? { runs } : {}),
    ...(ingestion.applicationHarness ? { applicationHarness: ingestion.applicationHarness } : {}),
    ...(ingestion.browserHarnessToken
      ? { browserHarnessToken: ingestion.browserHarnessToken }
      : {}),
    ...(ingestion.applicationSessions
      ? { applicationSessions: ingestion.applicationSessions }
      : {}),
    ...(ingestion.sourceHandoffs
      ? { sourceHandoffs: ingestion.sourceHandoffs }
      : {}),
    loadJobSource: ingestion.loadJobSource ?? (async (jobUrl, signal): Promise<LoadedJobSource> => {
      calls.loadedUrls.push(jobUrl);
      calls.loadedSignals.push(signal);
      return {
        kind: "model-fallback",
        lines: ["Platform Engineer", "Build and maintain a reliable TypeScript platform for job seekers."],
      };
    }),
    extractJobDescription: ingestion.extractJobDescription ?? (async (lines, signal) => {
      calls.extractedLines.push(lines);
      calls.extractedSignals.push(signal);
      return { opportunityKind: "job", jobDescription: JOB_DESCRIPTION };
    }),
  });
  return { app, artifactRoot, calls, pipelineDatabase, contextDatabase };
}

function mutation(path: string, body: object, origin = WEB_ORIGIN): Request {
  return new Request(`http://127.0.0.1:3457${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("pipeline application bootstrap", () => {
  test("starting an application does not copy artifacts from a launcher-supplied prior root", async () => {
    const root = mkdtempSync(join(TEMP_ROOT, "pipeline-bootstrap-migration-"));
    fixtures.push(root);
    const priorRoot = join(root, "checkout-runs");
    const namespaceRoot = join(root, "runtime");
    const artifactRoot = join(namespaceRoot, "runs");
    const originalPath = join(priorRoot, "1", "input", "job-description.txt");
    const relocatedPath = join(artifactRoot, "1", "input", "job-description.txt");
    mkdirSync(join(priorRoot, "1", "input"), { recursive: true });
    writeFileSync(originalPath, "job");
    const previousPriorRoot = process.env.JOBHUNT_PRIOR_ARTIFACT_ROOT;
    process.env.JOBHUNT_PRIOR_ARTIFACT_ROOT = priorRoot;
    let application: PipelineApplication | undefined;
    try {
      const fixture = createFixture(false, {
        artifactRoot,
        beforeApplication: (repository, database) => {
          repository.createRun("job", MIGRATED_RUN_ID);
          database.query(
            "INSERT INTO artifacts(id,run_id,revision,attempt_id,stage,kind,sha256,path,byte_size,created_at) VALUES (?,?,1,'','input','job-description',?,?,3,1)",
          ).run("artifact:migrated", MIGRATED_RUN_ID, "a".repeat(64), originalPath);
        },
      });
      application = fixture.app;

      expect(existsSync(relocatedPath)).toBe(false);
      expect(readFileSync(originalPath, "utf8")).toBe("job");
      expect(existsSync(join(priorRoot, ".1.jobhunt-migrated"))).toBe(false);
      expect(
        fixture.pipelineDatabase.query<{ path: string }, [string]>(
          "SELECT path FROM artifacts WHERE run_id=?",
        ).get(MIGRATED_RUN_ID)?.path,
      ).toBe(originalPath);
    } finally {
      if (previousPriorRoot === undefined) delete process.env.JOBHUNT_PRIOR_ARTIFACT_ROOT;
      else process.env.JOBHUNT_PRIOR_ARTIFACT_ROOT = previousPriorRoot;
      if (application !== undefined) await application.close();
    }
  });

  test("import and factory construction leave external work idle while health stays no-store", async () => {
    const fixture = createFixture();
    expect(fixture.calls.kick).toBe(0);
    expect(existsSync(fixture.artifactRoot)).toBe(false);
    expect(fixture.contextDatabase.query<{ count: number }, []>("SELECT count(*) AS count FROM context_metadata").get()?.count).toBe(0);

    const response = await fixture.app.fetch(new Request("http://127.0.0.1:3457/v1/health"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
    expect(fixture.calls.kick).toBe(0);
    await fixture.app.close();
  });

  test("does not expose recruiting event routes", async () => {
    const fixture = createFixture();
    const response = await fixture.app.fetch(
      new Request("http://127.0.0.1:3457/v1/events"),
    );

    expect(response.status).toBe(404);
    await fixture.app.close();
  });

  test("composes auth, context, and run routes over real in-memory application boundaries", async () => {
    const fixture = createFixture();
    const authResponse = await fixture.app.fetch(new Request("http://127.0.0.1:3457/v1/auth"));
    expect(authResponse.status).toBe(200);

    const staleResponse = await fixture.app.fetch(new Request("http://127.0.0.1:3457/v1/context"));
    expect(staleResponse.status).toBe(200);
    expect((await staleResponse.json()).fresh).toBe(false);

    const syncResponse = await fixture.app.fetch(mutation("/v1/context/sync", {}));
    expect(syncResponse.status).toBe(200);
    expect((await syncResponse.json()).fresh).toBe(true);

    for (const retiredRequest of [
      new Request("http://127.0.0.1:3457/v1/discovery?maxAgeDays=all"),
      mutation("/v1/discovery/sync", {}),
      mutation("/v1/discovery/queue", { jobIds: ["retired-job"] }),
    ]) {
      const response = await fixture.app.fetch(retiredRequest);
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("NOT_FOUND");
    }

    const request = mutation("/v1/runs", {
      jobUrl: JOB_URL,
    });
    const createdResponse = await fixture.app.fetch(request);
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created).toMatchObject({ status: "queued", revision: 1, origin: "initial" });
    expect(fixture.calls.loadedUrls).toEqual([JOB_URL]);
    expect(fixture.calls.loadedSignals).toEqual([request.signal]);
    expect(fixture.calls.extractedLines).toEqual([
      ["Platform Engineer", "Build and maintain a reliable TypeScript platform for job seekers."],
    ]);
    expect(fixture.calls.extractedSignals).toEqual([request.signal]);
    const input = fixture.app.services.repository.getArtifact(created.id, "job-description")!;
    expect(Buffer.from(
      await fixture.app.services.artifacts.read(input.path, input.byteSize),
    ).toString("utf8")).toBe(JOB_DESCRIPTION);

    const listedResponse = await fixture.app.fetch(new Request("http://127.0.0.1:3457/v1/runs"));
    expect(listedResponse.status).toBe(200);
    const listed = await listedResponse.json();
    expect(listed.runs).toHaveLength(1);
    expect(listed.runs[0].id).toBe(created.id);

    const applicationResponse = await fixture.app.fetch(new Request(
      `http://127.0.0.1:3457/v1/runs/${created.id}/application`,
    ));
    expect(applicationResponse.status).toBe(200);
    const application = await applicationResponse.json();
    expect(application).toEqual({
      state: "not_started",
      canStart: false,
      canStartAfterApproval: false,
      blockedReason: "resume_not_approved",
    });

    const publicBodies = JSON.stringify([
      await authResponse.clone().json(),
      await fixture.app.fetch(new Request("http://127.0.0.1:3457/v1/context")).then((response) => response.json()),
      created,
      listed,
      application,
    ]);
    expect(publicBodies).not.toContain(fixture.artifactRoot);
    expect(publicBodies).not.toContain("secret-value");
    expect(publicBodies.toLowerCase()).not.toContain("token");
    await fixture.app.close();
  });

  test("queues a run from a fresh baseline-only context without a server error", async () => {
    const fixture = createFixture(false, { baselineOnlyContext: true });
    try {
      expect((await fixture.app.fetch(mutation("/v1/context/sync", {}))).status).toBe(200);
      const createdResponse = await fixture.app.fetch(mutation("/v1/runs", { jobUrl: JOB_URL }));
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json();
      const snapshot = fixture.app.services.repository.getSourceSnapshot(created.id);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.sourceHashes).toEqual({ "resume-baseline": snapshot!.baselineSha256 });
      expect(fixture.app.services.repository.getRun(created.id)?.status).toBe("queued");
    } finally {
      await fixture.app.close();
    }
  });

  test("wires the default Gmail provider through the bearer-auth harness client", async () => {
    const authRoot = mkdtempSync(join(TEMP_ROOT, "pipeline-bootstrap-gmail-auth-"));
    fixtures.push(authRoot);
    const previousDatabase = process.env.JOBHUNT_AUTH_DATABASE;
    process.env.JOBHUNT_AUTH_DATABASE = join(authRoot, "auth.sqlite");
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const applicationHarness = new HttpApplicationHarnessClient({
      origin: "http://127.0.0.1:8765",
      token: HARNESS_TOKEN,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (!url.endsWith("/v1/gmail-auth")) {
          return new Response(null, { status: 204 });
        }
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({
          state: "connected",
          identity: { email: "person@gmail.test" },
        });
      },
    });
    const fixture = createFixture(false, {
      applicationHarness,
      useDefaultAuth: true,
    });

    try {
      const response = await fixture.app.fetch(new Request("http://127.0.0.1:3457/v1/auth"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        providers: [
          { provider: "openai-codex", state: "disconnected" },
          { provider: "google-antigravity", state: "disconnected" },
          { provider: "gmail", state: "connected", identity: { email: "person@gmail.test" } },
        ],
      });
      expect(requests).toEqual([
        {
          url: "http://127.0.0.1:8765/v1/gmail-auth",
          authorization: `Bearer ${HARNESS_TOKEN}`,
        },
        {
          url: "http://127.0.0.1:8765/v1/gmail-auth",
          authorization: `Bearer ${HARNESS_TOKEN}`,
        },
      ]);
    } finally {
      await fixture.app.close();
      if (previousDatabase === undefined) delete process.env.JOBHUNT_AUTH_DATABASE;
      else process.env.JOBHUNT_AUTH_DATABASE = previousDatabase;
    }
  });

  test("composes the injected application answer tools through the public route boundary", async () => {
    const calls: unknown[] = [];
    const applicationSessions: PipelineApplicationSessionService = {
      get: async () => ({
        state: "not_started",
        canStart: false,
        canStartAfterApproval: false,
        blockedReason: "resume_not_approved",
      }),
      start: async () => { throw new Error("unexpected start"); },
      retry: async () => { throw new Error("unexpected retry"); },
      suggestions: async (runId, questionId, signal) => {
        calls.push({ operation: "suggestions", runId, questionId, signal });
        return {
          suggestions: [{
            question: "What impact did you have?",
            answer: "I improved reliability.",
          }],
        };
      },
      professionalize: async (runId, questionId, request, signal) => {
        calls.push({ operation: "professionalize", runId, questionId, request, signal });
        return { answer: "I improved reliability." };
      },
      events: async function* () {},
      command: async () => {},
      openBrowser: async () => {},
      close: async () => {},
      startNextAutomaticApplication: async () => false,
    };
    const fixture = createFixture(false, { applicationSessions });

    const suggestionsPath =
      "/v1/runs/run-1/application/additional-info/impact/suggestions";
    for (const rejectedRequest of [
      new Request(`http://127.0.0.1:3457${suggestionsPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      mutation(suggestionsPath, {}, "https://attacker.invalid"),
    ]) {
      const rejected = await fixture.app.fetch(rejectedRequest);
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toEqual({
        error: { code: "ORIGIN_REJECTED", message: "Mutation origin is not allowed" },
      });
    }
    expect(calls).toEqual([]);

    const suggestions = await fixture.app.fetch(mutation(suggestionsPath, {}));
    expect(suggestions.status).toBe(200);
    expect(await suggestions.json()).toEqual({
      suggestions: [{
        question: "What impact did you have?",
        answer: "I improved reliability.",
      }],
    });

    const professionalized = await fixture.app.fetch(mutation(
      "/v1/runs/run-1/application/additional-info/impact/professionalize",
      { promptId: "default", draft: "improved reliability" },
    ));
    expect(professionalized.status).toBe(200);
    expect(await professionalized.json()).toEqual({
      answer: "I improved reliability.",
    });
    expect(calls).toEqual([
      {
        operation: "suggestions",
        runId: "run-1",
        questionId: "impact",
        signal: expect.any(AbortSignal),
      },
      {
        operation: "professionalize",
        runId: "run-1",
        questionId: "impact",
        request: { promptId: "default", draft: "improved reliability" },
        signal: expect.any(AbortSignal),
      },
    ]);
    await fixture.app.close();
  });

  test("ingests fallback HTML through Codex Luna ranges before the route commits exact source text", async () => {
    const fallbackLines = [
      "Senior Platform Engineer",
      "Acme Systems",
      "Build reliable distributed systems and mentor a collaborative engineering team.",
    ] as const;
    const selectedDescription = fallbackLines.join("\n");
    let extractedLines: readonly string[] = [];
    const fixture = createFixture(false, {
      loadJobSource: (jobUrl, signal) => loadJobSourceFromUrl(jobUrl, signal, {
        deadlineMs: 1_000,
        resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchImpl: async () => new Response([
          "<body><header>Discard navigation</header><main>",
          `<h1>${fallbackLines[0]}</h1>`,
          `<p>${fallbackLines[1]}</p>`,
          `<section>${fallbackLines[2]}</section>`,
          "</main><footer>Discard legal links</footer></body>",
        ].join(""), {
          headers: { "content-type": "text/html" },
        }),
      }),
      extractJobDescription: async (lines, signal) => {
        extractedLines = lines;
        return extractJobDescriptionWithLuna(lines, signal, {
          sessionIdFactory: () => "job-ingestion-bootstrap",
          resolverFactory: () => async () => "injected-openai-codex-oauth-token",
          transport: async () => ({
            role: "assistant",
            api: "openai-codex-responses",
            provider: "openai-codex",
            model: LUNA_MODEL_NAME,
            content: [{
              type: "text",
              text: JSON.stringify({ kind: "job", ranges: [{ startLine: 1, endLine: 3 }] }),
            }],
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1,
          }),
        });
      },
    });
    expect((await fixture.app.fetch(mutation("/v1/context/sync", {}))).status).toBe(200);

    const response = await fixture.app.fetch(mutation("/v1/runs", { jobUrl: JOB_URL }));

    expect(response.status).toBe(201);
    const created = await response.json();
    expect(extractedLines).toEqual(fallbackLines);
    expect(fixture.calls.kick).toBe(1);
    const input = fixture.app.services.repository.getArtifact(created.id, "job-description")!;
    expect(Buffer.from(
      await fixture.app.services.artifacts.read(input.path, input.byteSize),
    ).toString("utf8")).toBe(selectedDescription);
    expect(fixture.pipelineDatabase.query<{ job_description: string }, [string]>(
      "SELECT job_description FROM runs WHERE id = ?",
    ).get(created.id)?.job_description).toBe(selectedDescription);
    expect(created.jobUrl).toBe(JOB_URL);
    await fixture.app.close();
  });
  test("creates and persists an explicit networking event through the public boundary", async () => {
    const eventDescription = [
      "Platform engineering networking evening",
      "Meet infrastructure engineers and discuss reliable systems in structured small-group sessions.",
    ].join("\n");
    const fixture = createFixture(false, {
      loadJobSource: async () => ({
        kind: "description",
        opportunityKind: "job",
        jobDescription: eventDescription,
      }),
    });
    expect((await fixture.app.fetch(mutation("/v1/context/sync", {}))).status).toBe(200);

    const response = await fixture.app.fetch(mutation("/v1/runs", {
      jobUrl: "https://events.example.test/networking/platform-engineers",
      opportunityKind: "networking_event",
    }));

    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({
      opportunityKind: "networking_event",
      jobUrl: "https://events.example.test/networking/platform-engineers",
      status: "queued",
    });
    expect(fixture.pipelineDatabase.query<{ opportunity_kind: string }, [string]>(
      "SELECT opportunity_kind FROM runs WHERE id = ?",
    ).get(created.id)?.opportunity_kind).toBe("networking_event");
    await fixture.app.close();
  });


  test("keeps a supplied run service authoritative over default ingestion options", async () => {
    const fixture = createFixture(true);
    const synced = await fixture.app.fetch(mutation("/v1/context/sync", {}));
    expect(synced.status).toBe(200);

    const createdResponse = await fixture.app.fetch(mutation("/v1/runs", { jobUrl: JOB_URL }));

    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(fixture.calls.suppliedLoads).toBe(1);
    expect(fixture.calls.loadedUrls).toEqual([]);
    expect(fixture.calls.extractedLines).toEqual([]);
    const input = fixture.app.services.repository.getArtifact(created.id, "job-description")!;
    expect(Buffer.from(
      await fixture.app.services.artifacts.read(input.path, input.byteSize),

    ).toString("utf8")).toBe(JOB_DESCRIPTION);
    await fixture.app.close();
  });
  test("composes source handoff creation and bodyless completion through the public handler", async () => {
    const handoffId = "123e4567-e89b-42d3-a456-426614174000";
    const handoff = {
      id: handoffId,
      state: "awaiting_human_verification" as const,
      jobUrl: JOB_URL,
    };
    const queued = {
      id: "run-source-handoff",
      jobUrl: JOB_URL,
      opportunityKind: "job" as const,
      status: "queued" as const,
      applicationStatus: "pending" as const,
      isApplying: false,
      generateKeywordMap: true,
      skipReview: false,
      autoSubmit: false,
      queueSequence: 1,
      revision: 1,
      origin: "initial" as const,
      createdAt: 1_000_000,
      updatedAt: 1_000_000,
      visualAcknowledgementRequired: false,
      attempts: [],
      artifacts: [],
      timeline: [],
    };
    const calls: string[] = [];
    const sourceHandoffs: NonNullable<PipelineApplicationOptions["sourceHandoffs"]> = {
      create: async () => {
        calls.push("create");
        return handoff;
      },
      get: async () => handoff,
      complete: async () => {
        calls.push("complete");
        return queued;
      },
      delete: async () => { calls.push("delete"); },
      close: async () => { calls.push("close"); },
    };
    const fixture = createFixture(false, { sourceHandoffs });

    const created = await fixture.app.fetch(mutation(
      "/v1/source-handoffs",
      { jobUrl: JOB_URL },
    ));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual(handoff);

    const completed = await fixture.app.fetch(new Request(
      `http://127.0.0.1:3457/v1/source-handoffs/${handoffId}/complete`,
      { method: "POST", headers: { origin: WEB_ORIGIN } },
    ));
    expect(completed.status).toBe(201);
    expect(await completed.json()).toEqual(queued);
    expect(calls).toEqual(["create", "complete"]);
    await fixture.app.close();
  });

  test("retains same-origin mutation policy before route dispatch", async () => {
    const fixture = createFixture();
    const response = await fixture.app.fetch(mutation("/v1/auth/openai-codex/sessions", {}, "https://attacker.invalid"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "ORIGIN_REJECTED", message: "Mutation origin is not allowed" } });
    expect(fixture.calls.startAuth).toBe(0);
    await fixture.app.close();
  });

  test("reconciles interrupted application submissions before serving recovery", async () => {
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const fixture = createFixture(false, {
      beforeApplication: (repository, database) => {
        const run = repository.createRun("Interrupted application", "attempting-run");
        database.query(`
          INSERT INTO run_application_sessions(
            run_id, generation, session_id, resume_revision, pdf_sha256, bridge_state,
            submission_phase, submission_attempted_at, submission_confirmed_at,
            public_snapshot_json, last_upstream_event_id, created_at, updated_at, terminal_at
          ) VALUES (?, 1, ?, 1, ?, 'running', 'attempting', 900, NULL, NULL, NULL, 800, 900, NULL)
        `).run(run.id, sessionId, "a".repeat(64));
      },
    });

    expect(fixture.app.services.repository.getLatestApplicationSession("attempting-run"))
      .toMatchObject({
        bridgeState: "submission_uncertain",
        submissionPhase: "uncertain",
        publicSnapshot: expect.objectContaining({
          bridgeState: "submission_uncertain",
          harnessState: "submission_uncertain",

          submissionPhase: "uncertain",
        }),
      });
    await fixture.app.close();
  });

  test("rejects a non-loopback HTTP web origin", () => {
    expect(() => createPipelineApplication({
      webOrigin: "http://jobs.example.test:3456",
    })).toThrow("JOBHUNT_WEB_ORIGIN must be an exact HTTPS or loopback HTTP origin");
  });

  test("rejects a wildcard HTTPS web origin before constructing dependencies", () => {
    expect(() => createPipelineApplication({
      webOrigin: "https://*.example.com",
    })).toThrow("JOBHUNT_WEB_ORIGIN must be an exact HTTPS or loopback HTTP origin");
  });
  test("rejects a short harness token before constructing dependencies", () => {
    expect(() => createPipelineApplication({
      browserHarnessToken: "too-short",
    })).toThrow("JOBHUNT_HARNESS_TOKEN must contain at least 32 characters");
  });

  test("starts worker scheduling only when kicked and exactly once per startup kick", async () => {
    const fixture = createFixture();
    expect(fixture.calls.kick).toBe(0);
    fixture.app.kick();
    expect(fixture.calls.kick).toBe(1);
    expect(existsSync(fixture.artifactRoot)).toBe(false);
    await fixture.app.close();
  });

  test("an empty startup kick preserves artifacts and fills automatic application capacity after maintenance", async () => {
    const pipelineDatabase = openPipelineDatabase(":memory:");
    const contextDatabase = openContextDatabase(":memory:");
    const artifactRoot = join(mkdtempSync(join(TEMP_ROOT, "pipeline-empty-startup-")), "runs");
    fixtures.push(join(artifactRoot, ".."));
    const artifacts = new ArtifactStore(artifactRoot);
    const seedRepository = new PipelineRepository(pipelineDatabase);
    const artifactFiles: string[] = [];
    for (let index = 0; index < 11; index++) {
      const run = seedRepository.createRun(`old run ${index}`, `old-run-${index}`);
      pipelineDatabase.query("UPDATE runs SET status='failed', failed_stage='compiling' WHERE id=?")
        .run(run.id);
      pipelineDatabase.query("UPDATE revisions SET status='failed' WHERE run_id=? AND revision=1")
        .run(run.id);
      const runRoot = join(artifactRoot, String(run.queueSequence));
      mkdirSync(runRoot, { recursive: true });
      const artifactFile = join(runRoot, "artifact.txt");
      writeFileSync(artifactFile, `artifact ${index}`);
      artifactFiles.push(artifactFile);
    }
    let providerCalls = 0;
    const maintenanceOrder: string[] = [];
    const context = createContextApplicationService({ database: contextDatabase });
    const auth: AuthRouteService & { close(): void } = {
      getAuthStatus: () => ({
        providers: [
          { provider: "openai-codex", state: "disconnected" },
          { provider: "google-antigravity", state: "disconnected" },
          { provider: "gmail", state: "disconnected" },
        ],
      }),
      startSession: async () => { throw new Error("unexpected authentication"); },
      getSession: () => undefined,
      answerPrompt: () => { throw new Error("unexpected prompt"); },
      cancelSession: async () => ({
        id: "unused-auth-session",
        provider: "openai-codex",
        state: "pending",
        progress: [],
        expiresAt: 0,
      }),
      logout: async () => undefined,
      close: () => undefined,
    };
    const app = createPipelineApplication({
      pipelineDatabase,
      contextDatabase,
      artifacts,
      context,
      auth,
      workerOptions: {
        agentRuntime: {
          providerFactory: () => {
            providerCalls += 1;
            throw new Error("provider must remain lazy");
          },
        },
        scheduler: {
          afterDrain: async () => { maintenanceOrder.push("injected"); },
        },
      },
    });
    let automaticStarts = 0;
    let signalAutomaticStarts!: () => void;
    const automaticStartsFinished = new Promise<void>((resolve) => {
      signalAutomaticStarts = resolve;
    });
    app.services.applicationSessions.startNextAutomaticApplication = async (signal) => {
      expect(signal.aborted).toBe(false);
      maintenanceOrder.push("automatic-application");
      automaticStarts += 1;
      if (automaticStarts === 4) signalAutomaticStarts();
      return automaticStarts < 4;
    };

    app.kick();
    await automaticStartsFinished;
    const artifactContents = artifactFiles.map((artifactFile) =>
      existsSync(artifactFile) ? readFileSync(artifactFile, "utf8") : undefined,
    );
    const retentionMarkerCount = pipelineDatabase.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM run_artifact_retention",
    ).get()?.count;
    await app.close();

    expect(providerCalls).toBe(0);
    expect(maintenanceOrder).toEqual([
      "injected",
      "automatic-application",
      "automatic-application",
      "automatic-application",
      "automatic-application",
    ]);
    expect(artifactContents).toEqual(
      artifactFiles.map((_, index) => `artifact ${index}`),
    );
    expect(retentionMarkerCount).toBe(0);
  });

  test("reports automatic application startup failures through the worker error handler", async () => {
    const reportedError = new Error("automatic application startup failed");
    const reported: unknown[] = [];
    let signalReported!: () => void;
    const errorReported = new Promise<void>((resolve) => { signalReported = resolve; });
    const fixture = createFixture(false, {
      useDefaultWorker: true,
      workerOptions: {
        scheduler: {
          onError: (error) => {
            reported.push(error);
            signalReported();
          },
        },
      },
    });
    fixture.app.services.applicationSessions.startNextAutomaticApplication = async () => {
      throw reportedError;
    };

    fixture.app.kick();
    await errorReported;

    expect(reported).toEqual([reportedError]);
    await fixture.app.close();
  });

  test("closes an active source-handoff boundary before closing databases", async () => {
    let pipelineDatabase: Database | undefined;
    let closeCalls: string[] | undefined;
    const sourceHandoffs = {
      create: async () => { throw new Error("not used"); },
      get: async () => { throw new Error("not used"); },
      complete: async () => { throw new Error("not used"); },
      delete: async () => { throw new Error("not used"); },
      close: async () => {
        closeCalls!.push("source-handoffs");
        expect(pipelineDatabase!.query("SELECT 1").get()).toBeDefined();
      },
    } as NonNullable<PipelineApplicationOptions["sourceHandoffs"]>;
    const fixture = createFixture(false, { sourceHandoffs });
    pipelineDatabase = fixture.pipelineDatabase;
    closeCalls = fixture.calls.close;

    await fixture.app.close();

    expect(fixture.calls.close.indexOf("source-handoffs")).toBeLessThan(
      fixture.calls.close.indexOf("pipeline-database"),
    );
  });

  test("closes worker, auth, context, and owned databases in order exactly once", async () => {
    const fixture = createFixture();
    fixture.app.services.applicationSessions.dispose = async () => {
      fixture.calls.close.push("application-sessions");
    };
    const first = fixture.app.close();
    const second = fixture.app.close();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(fixture.calls.close).toEqual([
      "worker",
      "application-sessions",
      "auth",
      "context",
      "pipeline-database",
      "context-database",
    ]);
    expect(() => fixture.pipelineDatabase.query("SELECT 1").get()).toThrow();
    expect(() => fixture.contextDatabase.query("SELECT 1").get()).toThrow();
    await fixture.app.close();
    expect(fixture.calls.close).toHaveLength(6);
  });

  test("synchronizes persisted and updated application models with the harness", async () => {
    const mirroredModels: string[] = [];
    const harness = new HttpApplicationHarnessClient({
      token: HARNESS_TOKEN,
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/v1/application-model")) {
          mirroredModels.push(String(init?.body ? JSON.parse(String(init.body)).model : ""));
        }
        return new Response(null, { status: 204 });
      },
    });
    const fixture = createFixture(false, {
      applicationHarness: harness,
      beforeApplication: (repository) => { repository.setApplicationModel("gemini-3.8-flash"); },
      getAuthStatus: () => ({
        providers: [
          { provider: "openai-codex", state: "connected" },
          { provider: "google-antigravity", state: "connected" },
          { provider: "gmail", state: "disconnected" },
        ],
      }),
    });

    const initial = await fixture.app.fetch(new Request(
      "http://127.0.0.1:3457/v1/auth/application-model",
      { headers: { origin: WEB_ORIGIN } },
    ));
    const updated = await fixture.app.fetch(new Request(
      "http://127.0.0.1:3457/v1/auth/application-model",
      {
        method: "PUT",
        headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol" }),
      },
    ));

    expect(initial.status).toBe(200);
    expect(updated.status).toBe(200);
    expect(mirroredModels).toEqual(["gemini-3.8-flash", "gpt-5.6-sol"]);
    await fixture.app.close();
  });
});
