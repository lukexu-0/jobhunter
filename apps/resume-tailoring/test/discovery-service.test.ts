import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDiscoveryRoutes } from "../src/api/discovery-routes.ts";
import { createApiHandler } from "../src/api/handler.ts";
import { DiscoveryListRequestSchema, type RunDto } from "../src/contracts/index.ts";
import { openPipelineDatabase } from "../src/db/database.ts";
import { DiscoveryJobQueueConflictError } from "../src/db/repository.ts";
import { DiscoveryRepository } from "../src/discovery/repository.ts";
import { DiscoveryService } from "../src/discovery/service.ts";
import type { DiscoveredJobInput, DiscoveryConnector } from "../src/discovery/types.ts";

const ORIGIN = "http://127.0.0.1:3456";
const DESCRIPTION = "Build reliable production software with careful testing, ownership, collaboration, and measurable customer impact.";
const databases: Database[] = [];

function input(id: string, title = "Software Engineering Intern"): DiscoveredJobInput {
  return {
    sourceItemId: id,
    sourceUrl: `https://jobs.example.test/${id}`,
    canonicalUrl: `https://jobs.example.test/${id}`,
    applyUrl: `https://jobs.example.test/${id}/apply`,
    title,
    company: "Example",
    location: null,
    description: DESCRIPTION,
  };
}

function run(id: string): RunDto {
  return {
    id,
    jobUrl: `https://jobs.example.test/${id}`,
    status: "queued",
    opportunityKind: "job",
    applicationStatus: "pending",
    generateKeywordMap: true,
    skipReview: false,
    autoSubmit: false,
    queueSequence: 1,
    revision: 1,
    origin: "initial",
    createdAt: 1_000,
    updatedAt: 1_000,
    visualAcknowledgementRequired: false,
    attempts: [],
    artifacts: [],
    timeline: [],
  };
}

function connector(
  id: string,
  sync: DiscoveryConnector["sync"],
): DiscoveryConnector {
  return { id, name: `Source ${id}`, kind: "job_board", sync };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("discovery synchronization", () => {
  test("keeps successful source data when another source fails and redacts upstream URLs", async () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    const repository = new DiscoveryRepository(database, {
      now: () => 1_000,
      idFactory: () => "job-1",
    });
    const service = new DiscoveryService({
      repository,
      runs: {
        createRunFromDescription: async () => run("unused"),
        kick: () => undefined,
      },
      connectors: [
        connector("working", async () => ({ items: [input("one")], completeSnapshot: true })),
        connector("failing", async () => {
          throw new Error("blocked by https://upstream.example.test/private?token=secret");
        }),
      ],
      now: () => 1_100,
    });

    const result = await service.sync(new AbortController().signal);

    expect(result.totals).toMatchObject({ sources: 2, succeeded: 1, failed: 1, created: 1 });
    expect(result.sources[1]?.error).not.toContain("upstream.example.test");
    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null })).total).toBe(1);
  });

  test("rejects private literals and public HTTP connector destinations", async () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    const repository = new DiscoveryRepository(database);
    const privateInput = input("private");
    const service = new DiscoveryService({
      repository,
      runs: {
        createRunFromDescription: async () => run("unused"),
        kick: () => undefined,
      },
      connectors: [
        connector("private", async () => ({
          items: [{
            ...privateInput,
            sourceUrl: "https://127.0.0.1/source",
            canonicalUrl: "https://127.0.0.1/job",
            applyUrl: "https://127.0.0.1/apply",
          }],
          completeSnapshot: true,
        })),
        connector("http", async () => ({
          items: [{
            ...input("http"),
            sourceUrl: "http://jobs.example.com/source",
            canonicalUrl: "http://jobs.example.com/job",
            applyUrl: "http://jobs.example.com/apply",
          }],
          completeSnapshot: true,
        })),
      ],
    });

    const result = await service.sync(new AbortController().signal);

    expect(result.sources[0]).toMatchObject({ status: "failed", completeSnapshot: false });
    expect(result.sources[1]).toMatchObject({ status: "failed", completeSnapshot: false });
    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null })).total).toBe(0);
  });

  test("rejects a concurrent synchronization without starting its connectors", async () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    const repository = new DiscoveryRepository(database);
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new DiscoveryService({
      repository,
      runs: {
        createRunFromDescription: async () => run("unused"),
        kick: () => undefined,
      },
      connectors: [connector("waiting", async () => {
        calls += 1;
        await gate;
        return { items: [], completeSnapshot: true };
      })],
    });
    const first = service.sync(new AbortController().signal);

    await expect(service.sync(new AbortController().signal)).rejects.toMatchObject({
      code: "DISCOVERY_SYNC_IN_PROGRESS",
      status: 409,
    });
    expect(calls).toBe(1);
    release();
    await first;
  });

  test("aborts active connector work and drains it before service close settles", async () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    const repository = new DiscoveryRepository(database);
    const connectorStarted = Promise.withResolvers<void>();
    const connectorAborted = Promise.withResolvers<void>();
    const connectorRelease = Promise.withResolvers<void>();
    let connectorSignal: AbortSignal | undefined;
    const service = new DiscoveryService({
      repository,
      runs: {
        createRunFromDescription: async () => run("unused"),
        kick: () => undefined,
      },
      connectors: [connector("waiting", async (signal) => {
        connectorSignal = signal;
        signal.addEventListener("abort", () => connectorAborted.resolve(), { once: true });
        connectorStarted.resolve();
        await connectorRelease.promise;
        return { items: [input("late-item")], completeSnapshot: true };
      })],
    });
    const caller = new AbortController();
    const syncing = service.sync(caller.signal);
    await connectorStarted.promise;

    const firstClose = service.close();
    const secondClose = service.close();
    let closeSettled = false;
    void firstClose.then(() => { closeSettled = true; });

    expect(secondClose).toBe(firstClose);
    await connectorAborted.promise;
    expect(connectorSignal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    await expect(syncing).rejects.toMatchObject({
      code: "DISCOVERY_SERVICE_CLOSED",
      status: 409,
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null })).total).toBe(0);
    await expect(service.sync(caller.signal)).rejects.toMatchObject({
      code: "DISCOVERY_SERVICE_CLOSED",
      status: 409,
    });

    connectorRelease.resolve();
    await firstClose;
    expect(closeSettled).toBe(true);
    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null })).total).toBe(0);
    expect(service.close()).toBe(firstClose);
  });

  test("preserves caller cancellation and drains late connector work on close", async () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    const repository = new DiscoveryRepository(database);
    let connectorCalls = 0;
    let releaseConnector!: () => void;
    let reportStarted!: () => void;
    const connectorStarted = new Promise<void>((resolve) => { reportStarted = resolve; });
    const connectorRelease = new Promise<void>((resolve) => { releaseConnector = resolve; });
    const lateConnectorError = new Error("connector rejected after cancellation");
    const service = new DiscoveryService({
      repository,
      runs: {
        createRunFromDescription: async () => run("unused"),
        kick: () => undefined,
      },
      connectors: [connector("waiting", async () => {
        connectorCalls += 1;
        reportStarted();
        await connectorRelease;
        throw lateConnectorError;
      })],
    });
    const controller = new AbortController();
    const callerReason = new Error("caller stopped discovery");
    const syncing = service.sync(controller.signal);
    await connectorStarted;

    controller.abort(callerReason);
    await expect(syncing).rejects.toBe(callerReason);
    const firstClose = service.close();
    const secondClose = service.close();
    let closeSettled = false;
    void firstClose.then(() => { closeSettled = true; });

    expect(secondClose).toBe(firstClose);
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    await expect(service.sync(new AbortController().signal)).rejects.toMatchObject({
      code: "DISCOVERY_SERVICE_CLOSED",
      status: 409,
    });
    expect(connectorCalls).toBe(1);

    releaseConnector();
    await firstClose;
    expect(closeSettled).toBe(true);
    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null })).total).toBe(0);
    expect(service.close()).toBe(firstClose);
  });

  test("limits connector synchronization concurrency to four sources", async () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    const repository = new DiscoveryRepository(database);
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    let firstWaveReady!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstWave = new Promise<void>((resolve) => { firstWaveReady = resolve; });
    const connectors = Array.from({ length: 8 }, (_, index) =>
      connector(`source-${index}`, async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (calls === 4) firstWaveReady();
        await gate;
        active -= 1;
        return { items: [], completeSnapshot: true };
      }));
    const service = new DiscoveryService({
      repository,
      connectors,
      runs: {
        createRunFromDescription: async () => run("unused"),
        kick: () => undefined,
      },
    });

    const syncing = service.sync(new AbortController().signal);
    await firstWave;
    expect(calls).toBe(4);
    expect(maximumActive).toBe(4);
    release();
    await syncing;
    expect(calls).toBe(8);
    expect(maximumActive).toBe(4);
  });
  test("omits invalid and duplicate connector records without poisoning valid jobs", async () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    const repository = new DiscoveryRepository(database, {
      now: () => 1_000,
      idFactory: () => "job-valid",
    });
    const valid = input("valid");
    const invalid = {
      ...input("oversized"),
      title: "x".repeat(501),
    } as DiscoveredJobInput;
    const invalidTimestamp = {
      ...input("future"),
      postedAt: 8_640_000_000_000_001,
    } as DiscoveredJobInput;
    const service = new DiscoveryService({
      repository,
      runs: {
        createRunFromDescription: async () => run("unused"),
        kick: () => undefined,
      },
      connectors: [connector("mixed", async () => ({
        items: [valid, invalid, invalidTimestamp, { ...valid }],
        completeSnapshot: true,
      }))],
    });

    const result = await service.sync(new AbortController().signal);

    expect(result.sources[0]).toMatchObject({
      status: "succeeded",
      completeSnapshot: false,
      received: 1,
      created: 1,
      provenance: "service omitted invalid records: 3",
    });
    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null })).total).toBe(1);
  });

});

describe("discovery queueing", () => {
  test("returns deterministic skips, uses the saved description, and kicks exactly once", async () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    let nextId = 0;
    const repository = new DiscoveryRepository(database, {
      now: () => 1_000,
      idFactory: () => `job-${++nextId}`,
    });
    repository.reconcileSource({
      id: "open-source",
      name: "Open source",
      kind: "job_board",
      items: [input("open"), input("race")],
      completeSnapshot: true,
    });
    repository.reconcileSource({
      id: "closed-source",
      name: "Closed source",
      kind: "job_board",
      items: [input("closed", "Data Science Intern")],
      completeSnapshot: true,
    });
    repository.reconcileSource({
      id: "closed-source",
      name: "Closed source",
      kind: "job_board",
      items: [],
      completeSnapshot: true,
    });
    const all = repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null, status: "all" }));
    const idByTitle = Object.fromEntries(all.jobs.map((job) => [job.title, job.id]));
    const openJobs = all.jobs.filter((job) => job.title === "Software Engineering Intern");
    const openId = openJobs[0]!.id;
    const raceId = openJobs[1]!.id;
    const closedId = idByTitle["Data Science Intern"]!;
    let kicks = 0;
    const savedDescriptions: string[] = [];
    const service = new DiscoveryService({
      repository,
      connectors: [],
      runs: {
        createRunFromDescription: async (jobId, _url, description) => {
          savedDescriptions.push(description);
          if (jobId === raceId) throw new DiscoveryJobQueueConflictError("already_queued");
          return run(`run-${jobId}`);
        },
        kick: () => { kicks += 1; },
      },
    });

    const result = await service.queue({
      jobIds: ["missing", closedId, raceId, openId],
      generateKeywordMap: true,
      skipReview: false,
      autoSubmit: false,
    });

    expect(result.queued.map(({ jobId }) => jobId)).toEqual([openId]);
    expect(result.skipped).toEqual([
      { jobId: "missing", reason: "not_found" },
      { jobId: closedId, reason: "closed" },
      { jobId: raceId, reason: "already_queued" },
    ]);
    expect(savedDescriptions).toEqual([DESCRIPTION, DESCRIPTION]);
    expect(kicks).toBe(1);
  });

  test("returns successful batch members and a safe skip when one run creation fails", async () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    let nextId = 0;
    const repository = new DiscoveryRepository(database, {
      now: () => 1_000,
      idFactory: () => `job-${++nextId}`,
    });
    repository.reconcileSource({
      id: "mixed-source",
      name: "Mixed source",
      kind: "job_board",
      items: [
        input("first", "First internship"),
        input("failing", "Failing internship"),
        input("last", "Last internship"),
      ],
      completeSnapshot: true,
    });
    const jobs = repository.list(DiscoveryListRequestSchema.parse({
      maxAgeDays: null,
      status: "all",
    })).jobs;
    const idByTitle = Object.fromEntries(jobs.map((job) => [job.title, job.id]));
    const firstId = idByTitle["First internship"]!;
    const failingId = idByTitle["Failing internship"]!;
    const lastId = idByTitle["Last internship"]!;
    let kicks = 0;
    const attempted: string[] = [];
    const service = new DiscoveryService({
      repository,
      connectors: [],
      runs: {
        createRunFromDescription: async (jobId) => {
          attempted.push(jobId);
          if (jobId === failingId) throw new Error("database detail that must not escape");
          return run(`run-${jobId}`);
        },
        kick: () => { kicks += 1; },
      },
    });

    const result = await service.queue({
      jobIds: [firstId, failingId, lastId],
      generateKeywordMap: true,
      skipReview: false,
      autoSubmit: false,
    });

    expect(attempted).toEqual([firstId, failingId, lastId]);
    expect(result.queued.map(({ jobId }) => jobId)).toEqual([firstId, lastId]);
    expect(result.skipped).toEqual([{ jobId: failingId, reason: "queue_failed" }]);
    expect(kicks).toBe(1);
  });

  test("rethrows an abort while still kicking a successful earlier batch member", async () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    let nextId = 0;
    const repository = new DiscoveryRepository(database, {
      now: () => 1_000,
      idFactory: () => `job-${++nextId}`,
    });
    repository.reconcileSource({
      id: "abort-source",
      name: "Abort source",
      kind: "job_board",
      items: [input("first", "First internship"), input("abort", "Abort internship")],
      completeSnapshot: true,
    });
    const jobs = repository.list(DiscoveryListRequestSchema.parse({
      maxAgeDays: null,
      status: "all",
    })).jobs;
    const idByTitle = Object.fromEntries(jobs.map((job) => [job.title, job.id]));
    const firstId = idByTitle["First internship"]!;
    const abortId = idByTitle["Abort internship"]!;
    const controller = new AbortController();
    const abortReason = new Error("stop queueing");
    let kicks = 0;
    const service = new DiscoveryService({
      repository,
      connectors: [],
      runs: {
        createRunFromDescription: async (jobId) => {
          if (jobId === abortId) {
            controller.abort(abortReason);
            throw new Error("run creation stopped");
          }
          return run(`run-${jobId}`);
        },
        kick: () => { kicks += 1; },
      },
    });

    await expect(service.queue({
      jobIds: [firstId, abortId],
      generateKeywordMap: true,
      skipReview: false,
      autoSubmit: false,
    }, controller.signal)).rejects.toBe(abortReason);
    expect(kicks).toBe(1);
  });
});

describe("discovery routes", () => {
  test("strictly validates queries and mutations behind the shared origin guard", async () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    const repository = new DiscoveryRepository(database, { now: () => 1_000 });
    const service = new DiscoveryService({
      repository,
      connectors: [],
      runs: {
        createRunFromDescription: async () => run("unused"),
        kick: () => undefined,
      },
      now: () => 1_000,
    });
    const fetch = createApiHandler({ webOrigin: ORIGIN, route: createDiscoveryRoutes(service) });

    expect((await fetch(new Request(
      "http://127.0.0.1:3457/v1/discovery?unexpected=true",
    ))).status).toBe(400);
    expect((await fetch(new Request(
      "http://127.0.0.1:3457/v1/discovery?role=",
    ))).status).toBe(400);
    expect((await fetch(new Request(
      "http://127.0.0.1:3457/v1/discovery?status=",
    ))).status).toBe(400);
    expect((await fetch(new Request("http://127.0.0.1:3457/v1/discovery/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }))).status).toBe(403);
    expect((await fetch(new Request("http://127.0.0.1:3457/v1/discovery/queue", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ jobIds: ["same", "same"] }),
    }))).status).toBe(400);
    const oversized = await fetch(new Request("http://127.0.0.1:3457/v1/discovery/queue", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ payload: "x".repeat(256 * 1024) }),
    }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: { code: "REQUEST_TOO_LARGE", message: "Discovery request is too large" },
    });

    const listed = await fetch(new Request(
      "http://127.0.0.1:3457/v1/discovery?maxAgeDays=all&limit=1000",
    ));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ jobs: [], total: 0, lastSyncAt: null });
  });

  test("maps concurrent synchronization to HTTP 409", async () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    const repository = new DiscoveryRepository(database);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new DiscoveryService({
      repository,
      connectors: [connector("waiting", async () => {
        await gate;
        return { items: [], completeSnapshot: true };
      })],
      runs: {
        createRunFromDescription: async () => run("unused"),
        kick: () => undefined,
      },
    });
    const fetch = createApiHandler({ webOrigin: ORIGIN, route: createDiscoveryRoutes(service) });
    const syncRequest = () => new Request("http://127.0.0.1:3457/v1/discovery/sync", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: "{}",
    });
    const first = fetch(syncRequest());
    const concurrent = await fetch(syncRequest());

    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toEqual({
      error: {
        code: "DISCOVERY_SYNC_IN_PROGRESS",
        message: "A discovery synchronization is already running",
      },
    });
    release();
    expect((await first).status).toBe(200);
  });
});
