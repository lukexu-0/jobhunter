import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthRouteService } from "../src/api/auth-routes.ts";
import { createPipelineApplication, type PipelineWorkerHandle } from "../src/bootstrap.ts";
import { createContextApplicationService } from "../src/context/application-service.ts";
import { openContextDatabase } from "../src/context/database.ts";
import { openPipelineDatabase } from "../src/db/database.ts";
import { ArtifactStore } from "../src/system/artifacts.ts";

const WEB_ORIGIN = "http://127.0.0.1:3456";
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function createFixture() {
  const pipelineDatabase = openPipelineDatabase(":memory:");
  const contextDatabase = openContextDatabase(":memory:");
  const artifactRoot = join(mkdtempSync(join(tmpdir(), "pipeline-bootstrap-")), "runs");
  fixtures.push(join(artifactRoot, ".."));
  const calls = { kick: 0, close: [] as string[], startAuth: 0 };
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
  const app = createPipelineApplication({
    webOrigin: WEB_ORIGIN,
    pipelineDatabase,
    contextDatabase,
    artifacts: new ArtifactStore(artifactRoot),
    context,
    worker,
    auth,
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

    const createdResponse = await fixture.app.fetch(mutation("/v1/runs", {
      jobDescription: "Build and maintain a reliable TypeScript platform for job seekers.",
    }));
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created).toMatchObject({ status: "queued", revision: 1, origin: "initial" });

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

  test("an empty startup kick does not construct a provider or invoke a model", async () => {
    const pipelineDatabase = openPipelineDatabase(":memory:");
    const contextDatabase = openContextDatabase(":memory:");
    const artifactRoot = join(mkdtempSync(join(tmpdir(), "pipeline-empty-startup-")), "runs");
    fixtures.push(join(artifactRoot, ".."));
    let providerCalls = 0;
    const context = createContextApplicationService({ database: contextDatabase });
    const auth: AuthRouteService & { close(): void } = {
      getAuthStatus: () => ({ providers: [] }),
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
      },
    });

    app.kick();
    await app.close();
    expect(providerCalls).toBe(0);
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
