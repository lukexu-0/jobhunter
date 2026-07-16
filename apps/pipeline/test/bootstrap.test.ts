import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthRouteService } from "../src/api/auth-routes.ts";
import { createPipelineApplication, type PipelineWorkerHandle } from "../src/bootstrap.ts";
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
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

interface IngestionOverrides {
  readonly loadJobSource?: LoadJobSource;
  readonly extractJobDescription?: ExtractJobDescription;
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
    getAuthStatus: () => ({
      providers: [
        { provider: "openai-codex", state: "disconnected" },
        { provider: "google-antigravity", state: "disconnected" },
      ],
    }),
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
    webOrigin: WEB_ORIGIN,
    pipelineDatabase,
    contextDatabase,
    repository,
    artifacts,
    context,
    worker,
    auth,
    ...(runs ? { runs } : {}),
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

    const publicBodies = JSON.stringify([
      await authResponse.clone().json(),
      await fixture.app.fetch(new Request("http://127.0.0.1:3457/v1/context")).then((response) => response.json()),
      created,
      listed,
    ]);
    expect(publicBodies).not.toContain(fixture.artifactRoot);
    expect(publicBodies).not.toContain("secret-value");
    expect(publicBodies.toLowerCase()).not.toContain("token");
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
    expect(JSON.stringify(created)).not.toContain(JOB_URL);
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

  test("starts worker scheduling only when kicked and exactly once per startup kick", async () => {
    const fixture = createFixture();
    expect(fixture.calls.kick).toBe(0);
    fixture.app.kick();
    expect(fixture.calls.kick).toBe(1);
    expect(existsSync(fixture.artifactRoot)).toBe(false);
    await fixture.app.close();
  });

  test("an empty startup kick composes injected maintenance before retention without constructing providers", async () => {
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
          { provider: "google-antigravity", state: "disconnected" },
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

    app.kick();
    await app.close();
    expect(providerCalls).toBe(0);
    expect(maintenanceOrder).toEqual(["injected", "retention:10"]);
    expect(existsSync(artifactRoot)).toBe(false);
  });

  test("closes worker, auth, context, and owned databases in order exactly once", async () => {
    const fixture = createFixture();
    const first = fixture.app.close();
    const second = fixture.app.close();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(fixture.calls.close).toEqual([
      "worker",
      "auth",
      "context",
      "pipeline-database",
      "context-database",
    ]);
    expect(() => fixture.pipelineDatabase.query("SELECT 1").get()).toThrow();
    expect(() => fixture.contextDatabase.query("SELECT 1").get()).toThrow();
    await fixture.app.close();
    expect(fixture.calls.close).toHaveLength(5);
  });
});
