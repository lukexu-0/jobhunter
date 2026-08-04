import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthRouteService } from "../src/api/auth-routes.ts";
import type { ApplicationAgentRouteService } from "../src/agents/application-agent-service.ts";
import {
  createPipelineApplication,
  type PipelineApplicationOptions,
  type PipelineApplicationSessionService,
  type PipelineWorkerHandle,
  type PipelineRecruitingEventService,
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
import { openContextDatabase } from "../src/context/database.ts";
import { openPipelineDatabase } from "../src/db/database.ts";
import { PipelineRepository } from "../src/db/repository.ts";
import { ArtifactStore } from "../src/system/artifacts.ts";

const WEB_ORIGIN = "http://127.0.0.1:3456";
const JOB_URL = "https://jobs.example.test/platform";
const JOB_DESCRIPTION = "Platform Engineer\n\nBuild and maintain a reliable TypeScript platform for job seekers.";
const HARNESS_TOKEN = "bootstrap-harness-token-0123456789abcdef";
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

interface IngestionOverrides {
  readonly loadJobSource?: LoadJobSource;
  readonly extractJobDescription?: ExtractJobDescription;
  readonly browserHarnessToken?: string;
  readonly applicationAgent?: ApplicationAgentRouteService;
  readonly applicationSessions?: PipelineApplicationSessionService;
  readonly getAuthStatus?: AuthRouteService["getAuthStatus"];
  readonly webOrigin?: string;
  readonly recruitingEvents?: PipelineRecruitingEventService;
  readonly beforeApplication?: (
    repository: PipelineRepository,
    database: Database,
  ) => void;
  readonly useDefaultWorker?: boolean;
  readonly workerOptions?: PipelineApplicationOptions["workerOptions"];
}

function createFixture(suppliedRuns = false, ingestion: IngestionOverrides = {}) {
  const pipelineDatabase = openPipelineDatabase(":memory:");
  const contextDatabase = openContextDatabase(":memory:");
  const artifactRoot = join(mkdtempSync(join(tmpdir(), "pipeline-bootstrap-")), "runs");
  fixtures.push(join(artifactRoot, ".."));
  const calls = {
    kick: 0,
    close: [] as string[],
    startAuth: 0,
    loadedUrls: [] as string[],
    authCallbackOrigins: [] as string[],
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
        { provider: "indeed", state: "disconnected" },
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
    completeIndeedCallback: async () => undefined,
    configureAuthCallbackOrigin: (origin) => { calls.authCallbackOrigins.push(origin); },
    close: () => { calls.close.push("auth"); },
  };
  const context = createContextApplicationService({ database: contextDatabase });
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
          return { kind: "description", jobDescription: JOB_DESCRIPTION };
        },
        extractJobDescription: async () => {
          throw new Error("deterministic source must not invoke extraction");
        },
      })
    : undefined;
  const app = createPipelineApplication({
    webOrigin: ingestion.webOrigin ?? WEB_ORIGIN,
    pipelineDatabase,
    contextDatabase,
    repository,
    artifacts,
    context,
    ...(ingestion.useDefaultWorker
      ? (ingestion.workerOptions ? { workerOptions: ingestion.workerOptions } : {})
      : { worker }),
    auth,
    ...(runs ? { runs } : {}),
    ...(ingestion.browserHarnessToken
      ? { browserHarnessToken: ingestion.browserHarnessToken }
      : {}),
    ...(ingestion.applicationAgent
      ? { applicationAgent: ingestion.applicationAgent }
      : {}),
    ...(ingestion.applicationSessions
      ? { applicationSessions: ingestion.applicationSessions }
      : {}),
    ...(ingestion.recruitingEvents
      ? { recruitingEvents: ingestion.recruitingEvents }
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
      return JOB_DESCRIPTION;
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

  test("composes recruiting event routes and owns the event service lifecycle", async () => {
    const calls: string[] = [];
    const run = {
      id: "scrape-1",
      trigger: "manual" as const,
      state: "running" as const,
      startedAt: 1,
      sourceCount: 1,
      succeededSourceCount: 0,
      failedSourceCount: 0,
      eventCount: 0,
    };
    const recruitingEvents: PipelineRecruitingEventService = {
      start: () => { calls.push("start"); },
      close: () => { calls.push("close"); },
      getDashboard: () => ({
        preferences: { school: null },
        schedule: {
          cadenceHours: 24,
          nextRunAt: null,
          running: false,
          sourceCount: 1,
        },
        latestRun: null,
        events: [],
        issues: [],
      }),
      setPreferences: ({ school }) => {
        calls.push(`school:${school}`);
        return { school };
      },
      requestScrape: () => {
        calls.push("scrape");
        return run;
      },
    };
    const fixture = createFixture(false, { recruitingEvents });

    const dashboard = await fixture.app.fetch(
      new Request("http://127.0.0.1:3457/v1/events"),
    );
    expect(dashboard.status).toBe(200);
    expect(await dashboard.json()).toMatchObject({ preferences: { school: null } });

    const preference = await fixture.app.fetch(new Request(
      "http://127.0.0.1:3457/v1/events/preferences",
      {
        method: "PUT",
        headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ school: "Example University" }),
      },
    ));
    expect(preference.status).toBe(200);

    const scrape = await fixture.app.fetch(mutation("/v1/events/scrape", {}));
    expect(scrape.status).toBe(202);
    expect(await scrape.json()).toEqual({ run });
    expect(calls).toEqual(["school:Example University", "scrape"]);

    await fixture.app.close();
    expect(calls).toEqual(["school:Example University", "scrape", "close"]);
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

    expect(fixture.app.services.discoveryRepository).toBeDefined();
    expect(fixture.app.services.discovery).toBeDefined();
    const discoveryResponse = await fixture.app.fetch(new Request(
      "http://127.0.0.1:3457/v1/discovery?maxAgeDays=all",
    ));
    expect(discoveryResponse.status).toBe(200);
    expect(await discoveryResponse.json()).toEqual({
      jobs: [],
      total: 0,
      lastSyncAt: null,
    });

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
              text: JSON.stringify({ ranges: [{ startLine: 1, endLine: 3 }] }),
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

  test("retains same-origin mutation policy before route dispatch", async () => {
    const fixture = createFixture();
    const response = await fixture.app.fetch(mutation("/v1/auth/openai-codex/sessions", {}, "https://attacker.invalid"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "ORIGIN_REJECTED", message: "Mutation origin is not allowed" } });
    expect(fixture.calls.startAuth).toBe(0);
    await fixture.app.close();
  });

  test("wires the authenticated application agent before public origin policy", async () => {
    let invocations = 0;
    const result = {
      status: "cancelled" as const,
      company: null,
      role: null,
      job_url: "https://jobs.example.test/platform",
      final_url: "https://jobs.example.test/platform",
      fields_filled: [],
      fields_needing_human: [],
      files_attached: [],
      warnings: [],
      revision_count: 0,
      submit_attempted: false as const,
      submission_confirmation: null,
    };
    const applicationAgent: ApplicationAgentRouteService = {
      status: () => ({
        modelProvider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoning: "high",
        oauth: "connected",
      }),
      invoke: async () => {
        invocations += 1;
        return {
          modelProvider: "openai-codex",
          model: "gpt-5.6-sol",
          reasoning: "high",
          result,
        };
      },
    };
    const fixture = createFixture(false, {
      browserHarnessToken: HARNESS_TOKEN,
      applicationAgent,
    });
    const response = await fixture.app.fetch(
      new Request("http://127.0.0.1:3457/v1/internal/application-agent", {
        method: "POST",
        headers: {
          authorization: `Bearer ${HARNESS_TOKEN}`,
          "content-type": "application/json",
          origin: "https://attacker.invalid",
        },
        body: JSON.stringify({
          sessionId: "123e4567-e89b-42d3-a456-426614174000",
          runtimeUrl: "http://127.0.0.1:8765",
          task: "Complete the application",
          maxTurns: 25,
          deadlineMs: 30_000,
          autoSubmit: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      modelProvider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning: "high",
      result,
    });
    expect(invocations).toBe(1);
    await fixture.app.close();
  });

  test("shares the injected auth status with the default application agent", async () => {
    let authStatusReads = 0;
    const fixture = createFixture(false, {
      browserHarnessToken: HARNESS_TOKEN,
      getAuthStatus: () => {
        authStatusReads += 1;
        return {
          providers: [
            { provider: "openai-codex", state: "connected" },
            { provider: "indeed", state: "disconnected" },
          ],
        };
      },
    });

    const response = await fixture.app.fetch(new Request(
      "http://127.0.0.1:3457/v1/internal/application-agent",
      { headers: { authorization: `Bearer ${HARNESS_TOKEN}` } },
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      modelProvider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning: "high",
      oauth: "connected",
    });
    expect(authStatusReads).toBe(1);
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

  test("wires the exact validated web origin into the Indeed callback configuration", async () => {
    const fixture = createFixture();
    expect(fixture.calls.authCallbackOrigins).toEqual([WEB_ORIGIN]);
    await fixture.app.close();

    const secureFixture = createFixture(false, { webOrigin: "https://jobhunter.example.test" });
    expect(secureFixture.calls.authCallbackOrigins).toEqual(["https://jobhunter.example.test"]);
    await secureFixture.app.close();

    expect(() => createPipelineApplication({
      webOrigin: "http://jobs.example.test:3456",
    })).toThrow("JOBHUNTER_WEB_ORIGIN must be an exact HTTPS or loopback HTTP origin");
  });
  test("rejects a short harness token before constructing dependencies", () => {
    expect(() => createPipelineApplication({
      browserHarnessToken: "too-short",
    })).toThrow("JOBHUNTER_HARNESS_TOKEN must contain at least 32 characters");
  });

  test("starts worker scheduling only when kicked and exactly once per startup kick", async () => {
    const fixture = createFixture();
    expect(fixture.calls.kick).toBe(0);
    fixture.app.kick();
    expect(fixture.calls.kick).toBe(1);
    expect(existsSync(fixture.artifactRoot)).toBe(false);
    await fixture.app.close();
  });

  test("an empty startup kick runs automatic application startup after injected maintenance and retention", async () => {
    const pipelineDatabase = openPipelineDatabase(":memory:");
    const contextDatabase = openContextDatabase(":memory:");
    const artifactRoot = join(mkdtempSync(join(tmpdir(), "pipeline-empty-startup-")), "runs");
    fixtures.push(join(artifactRoot, ".."));
    let providerCalls = 0;
    const maintenanceOrder: string[] = [];
    const context = createContextApplicationService({ database: contextDatabase });
    const auth: AuthRouteService & { close(): void } = {
      getAuthStatus: () => ({
        providers: [
          { provider: "openai-codex", state: "disconnected" },
          { provider: "indeed", state: "disconnected" },
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
      completeIndeedCallback: async () => undefined,
      close: () => undefined,
    };
    const app = createPipelineApplication({
      pipelineDatabase,
      contextDatabase,
      artifacts: new ArtifactStore(artifactRoot),
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
    const reserveCandidates = app.services.repository.reserveArtifactPruneCandidates.bind(app.services.repository);
    app.services.repository.reserveArtifactPruneCandidates = (retainCount) => {
      maintenanceOrder.push(`retention:${retainCount}`);
      return reserveCandidates(retainCount);
    };
    let signalAutomaticStart!: () => void;
    const automaticStart = new Promise<void>((resolve) => { signalAutomaticStart = resolve; });
    app.services.applicationSessions.startNextAutomaticApplication = async (signal) => {
      expect(signal.aborted).toBe(false);
      maintenanceOrder.push("automatic-application");
      signalAutomaticStart();
      return false;
    };

    app.kick();
    await automaticStart;
    await app.close();
    expect(providerCalls).toBe(0);
    expect(maintenanceOrder).toEqual([
      "injected",
      "retention:10",
      "automatic-application",
    ]);
    expect(existsSync(artifactRoot)).toBe(false);
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
});
