import { describe, expect, test } from "bun:test";
import {
  createApplicationSessionRoutes,
  type ApplicationSessionRouteService,
} from "../src/api/application-session-routes";
import {
  ApplicationSessionServiceError,
  type ApplicationSessionStreamItem,
} from "../src/api/application-session-service";
import { createApiHandler } from "../src/api/handler";
import { createRunRoutes, type RunRouteService } from "../src/api/run-routes";
import { RunServiceError } from "../src/api/run-service";
import type {
  ApplicationSessionEventDto,
  ApplicationSessionSnapshotDto,
  ApplicationSessionView,
  RunDto,
} from "../src/contracts";

const ORIGIN = "http://127.0.0.1:3456";
const PDF_HASH = "a".repeat(64);
const run: RunDto = {
  id: "run-1",
  status: "queued",
  applicationStatus: "applied",
  queueSequence: 1,
  generateKeywordMap: true,
  revision: 0,
  origin: "initial",
  createdAt: 1,
  updatedAt: 1,
  visualAcknowledgementRequired: false,
  attempts: [],
  artifacts: [],
  timeline: [],
};

function service(overrides: Partial<RunRouteService> = {}) {
  let kicks = 0;
  const value: RunRouteService & { kickCount(): number } = {
    listRuns: () => [run],
    getRun: () => run,
    createRun: async () => run,
    updateApplicationStatus: async (_id, applicationStatus) => ({ ...run, applicationStatus }),
    updateRunIdentity: async (_id, identity) => ({
      ...run,
      ...(identity.title !== undefined ? { titleOverride: identity.title } : {}),
      ...(identity.organization !== undefined ? { organizationOverride: identity.organization } : {}),
    }),
    deleteRun: async () => {},
    retryRun: async () => run,
    regenerateRun: async () => ({ ...run, revision: 1, origin: "machine-regeneration", status: "editing" }),
    editRun: async () => ({ ...run, revision: 1, origin: "human-comments", status: "editing" }),
    approveRun: async () => ({ ...run, status: "approved" }),
    getArtifact: () => new Response("artifact", { headers: { "content-type": "text/plain" } }),
    kick: () => { kicks += 1; },
    kickCount: () => kicks,
    ...overrides,
  };
  return value;
}

async function request(routeService: RunRouteService, path: string, init?: RequestInit): Promise<Response> {
  return createApiHandler({ webOrigin: ORIGIN, route: createRunRoutes(routeService) })(
    new Request(`http://127.0.0.1:3457${path}`, init),
  );
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function patch(body: unknown): RequestInit {
  return {
    method: "PATCH",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("run HTTP routes", () => {
  test("canonicalizes the job URL, forwards the default map option and request signal, and kicks only after persistence succeeds", async () => {
    let received: { jobUrl: string; generateKeywordMap: boolean; signal: AbortSignal | undefined } | undefined;
    const target = service({
      createRun: async (jobUrl, generateKeywordMap, signal) => {
        received = { jobUrl, generateKeywordMap, signal };
        return run;
      },
    });
    const incoming = new Request("http://127.0.0.1:3457/v1/runs", post({
      jobUrl: " HTTPS://Jobs.Example.Test:443/role#apply ",
    }));
    const created = await createApiHandler({ webOrigin: ORIGIN, route: createRunRoutes(target) })(incoming);
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(await created.json()).toEqual(run);
    expect(received).toEqual({
      jobUrl: "https://jobs.example.test/role",
      generateKeywordMap: true,
      signal: incoming.signal,
    });
    expect(target.kickCount()).toBe(1);

    const failedTarget = service({
      createRun: async () => {
        throw Object.assign(new Error("The page does not contain a usable job description"), {
          code: "JOB_DESCRIPTION_UNAVAILABLE",
          status: 422,
        });
      },
    });
    const failed = await request(failedTarget, "/v1/runs", post({ jobUrl: "https://jobs.example.test/role" }));
    expect(failed.status).toBe(422);
    expect(await failed.json()).toEqual({
      error: {
        code: "JOB_DESCRIPTION_UNAVAILABLE",
        message: "The page does not contain a usable job description",
      },
    });
    expect(failedTarget.kickCount()).toBe(0);

    let defaulted: boolean | undefined;
    const defaultTarget = service({
      createRun: async (_jobUrl, generateKeywordMap) => {
        defaulted = generateKeywordMap;
        return run;
      },
    });
    expect((await request(defaultTarget, "/v1/runs", post({ jobUrl: "https://jobs.example.test/default" }))).status).toBe(201);
    expect(defaulted).toBe(true);
  });

  test("accepts only application statuses without waking the scheduler", async () => {
    const applicationStatuses = ["pending", "applied", "rejected", "interview", "accepted", "failed"] as const;
    const received: string[] = [];
    let updateCalls = 0;
    const target = service({
      updateApplicationStatus: async (_id, applicationStatus) => {
        updateCalls += 1;
        received.push(applicationStatus);
        return { ...run, applicationStatus };
      },
    });

    for (const body of [
      { applicationStatus: "queued" },
      {},
      { applicationStatus: "applied", extra: true },
    ]) {
      const response = await request(target, "/v1/runs/run-1", patch(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "INVALID_REQUEST", message: "Application status is invalid" },
      });
      expect(updateCalls).toBe(0);
      expect(target.kickCount()).toBe(0);
    }

    for (const applicationStatus of applicationStatuses) {
      const response = await request(target, "/v1/runs/run-1", patch({ applicationStatus }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...run, applicationStatus });
    }

    expect(received).toEqual([...applicationStatuses]);
    expect(target.kickCount()).toBe(0);
  });

  test("strictly validates identity overrides without waking the scheduler", async () => {
    const received: Array<{
      id: string;
      identity: {
        readonly title?: string | undefined;
        readonly organization?: string | undefined;
      };
    }> = [];
    const target = service({
      updateRunIdentity: async (id, identity) => {
        received.push({ id, identity });
        return {
          ...run,
          ...(identity.title !== undefined ? { titleOverride: identity.title } : {}),
          ...(identity.organization !== undefined ? { organizationOverride: identity.organization } : {}),
        };
      },
    });

    for (const body of [
      { title: "" },
      { organization: "   " },
      { title: "x".repeat(201) },
      { organization: "Acme", extra: true },
      { title: "Engineer", applicationStatus: "applied" },
    ]) {
      const response = await request(target, "/v1/runs/run-1", patch(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "INVALID_REQUEST", message: "Run identity is invalid" },
      });
    }
    expect(received).toEqual([]);

    const titleResponse = await request(
      target,
      "/v1/runs/run-1",
      patch({ title: "  Staff Engineer  " }),
    );
    expect(titleResponse.status).toBe(200);
    expect(await titleResponse.json()).toMatchObject({ titleOverride: "Staff Engineer" });
    const organizationResponse = await request(
      target,
      "/v1/runs/run-1",
      patch({ organization: "Example Labs" }),
    );
    expect(organizationResponse.status).toBe(200);
    expect(await organizationResponse.json()).toMatchObject({
      organizationOverride: "Example Labs",
    });
    expect(received).toEqual([
      { id: "run-1", identity: { title: "Staff Engineer" } },
      { id: "run-1", identity: { organization: "Example Labs" } },
    ]);
    expect(target.kickCount()).toBe(0);
  });

  test("deletes bodylessly with 204, wakes the scheduler, and maps live claims without waking it", async () => {
    const deleted: string[] = [];
    const target = service({
      deleteRun: async (id) => {
        deleted.push(id);
      },
    });
    const response = await request(target, "/v1/runs/run-1", {
      method: "DELETE",
      headers: { origin: ORIGIN },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBeNull();
    expect(await response.text()).toBe("");
    expect(deleted).toEqual(["run-1"]);
    expect(target.kickCount()).toBe(1);

    const claimedTarget = service({
      deleteRun: async () => {
        throw Object.assign(new Error("run has a live claim"), {
          code: "RUN_CLAIMED",
          status: 409,
        });
      },
    });
    const claimed = await request(claimedTarget, "/v1/runs/run-1", {
      method: "DELETE",
      headers: { origin: ORIGIN },
    });
    expect(claimed.status).toBe(409);
    expect(await claimed.json()).toEqual({
      error: { code: "RUN_CLAIMED", message: "run has a live claim" },
    });
    expect(claimedTarget.kickCount()).toBe(0);
  });

  test("rejects legacy, malformed, and unsupported create payloads without dispatch or scheduler effects", async () => {
    let createCalls = 0;
    const target = service({
      createRun: async () => {
        createCalls += 1;
        return run;
      },
    });
    for (const body of [
      { jobDescription: "A sufficiently detailed legacy job description that is no longer accepted." },
      { jobUrl: "example.test/job" },
      { jobUrl: "ftp://example.test/job" },
      { jobUrl: "https://user:secret@example.test/job" },
      { jobUrl: "https://example.test/job", generateKeywordMap: "true" },
      { jobUrl: "https://example.test/job", extra: true },
      {},
    ]) {
      const response = await request(target, "/v1/runs", post(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "INVALID_REQUEST", message: "Run request is invalid" },
      });
    }
    expect(createCalls).toBe(0);
    expect(target.kickCount()).toBe(0);
    expect((await request(service(), "/v1/runs/run-1/retry", post({ force: true }))).status).toBe(400);
  });


  test("passes immutable edit comments and expected PDF hash", async () => {
    let received: unknown;
    const target = service({
      editRun: async (id, comments, expectedPdfSha256) => {
        received = { id, comments, expectedPdfSha256 };
        return { ...run, revision: 1, origin: "human-comments", status: "editing" };
      },
    });
    const response = await request(target, "/v1/runs/run-1/edit", post({
      comments: "Shorten the second experience bullet without adding evidence.",
      expectedPdfSha256: PDF_HASH,
    }));
    expect(response.status).toBe(200);
    expect(received).toEqual({
      id: "run-1",
      comments: "Shorten the second experience bullet without adding evidence.",
      expectedPdfSha256: PDF_HASH,
    });
  });

  test("exposes only allowlisted fixed extraction 5xx messages and hides arbitrary server details", async () => {
    for (const expected of [
      {
        code: "JOB_EXTRACTION_UNAVAILABLE",
        status: 502,
        message: "Job description extraction failed",
      },
      {
        code: "JOB_EXTRACTION_TIMEOUT",
        status: 504,
        message: "Job description extraction timed out",
      },
    ]) {
      const response = await request(service({
        createRun: async () => {
          throw Object.assign(new Error("provider_token=secret"), {
            code: expected.code,
            status: expected.status,
          });
        },
      }), "/v1/runs", post({ jobUrl: "https://jobs.example.test/role" }));
      expect(response.status).toBe(expected.status);
      expect(await response.json()).toEqual({
        error: { code: expected.code, message: expected.message },
      });
    }

    const authRequired = await request(service({
      createRun: async () => {
        throw Object.assign(new Error("Connect OpenAI Codex OAuth before importing this job page"), {
          code: "JOB_EXTRACTION_AUTH_REQUIRED",
          status: 409,
        });
      },
    }), "/v1/runs", post({ jobUrl: "https://jobs.example.test/role" }));
    expect(authRequired.status).toBe(409);
    expect(await authRequired.json()).toEqual({
      error: {
        code: "JOB_EXTRACTION_AUTH_REQUIRED",
        message: "Connect OpenAI Codex OAuth before importing this job page",
      },
    });

    const hidden = await request(service({
      createRun: async () => {
        throw Object.assign(new Error("claim_token=secret"), { code: "ARBITRARY_FAILURE", status: 502 });
      },
    }), "/v1/runs", post({ jobUrl: "https://jobs.example.test/role" }));
    expect(hidden.status).toBe(502);
    expect(await hidden.json()).toEqual({
      error: { code: "ARBITRARY_FAILURE", message: "Request failed" },
    });
  });

  test("returns stable HTTP 410 responses for pruned downloads and lifecycle commands", async () => {
    const pruned = Object.assign(
      new Error("Run artifacts were removed by the ten-run retention policy"),
      { code: "RUN_ARTIFACTS_PRUNED", status: 410 },
    );
    const target = service({
      retryRun: async () => { throw pruned; },
      regenerateRun: async () => { throw pruned; },
      editRun: async () => { throw pruned; },
      approveRun: async () => { throw pruned; },
      getArtifact: async () => { throw pruned; },
    });
    const commands: readonly [string, unknown][] = [
      ["/v1/runs/run-1/retry", {}],
      ["/v1/runs/run-1/regenerate", { expectedPdfSha256: PDF_HASH }],
      ["/v1/runs/run-1/edit", { comments: "change layout", expectedPdfSha256: PDF_HASH }],
      ["/v1/runs/run-1/approve", { expectedPdfSha256: PDF_HASH, acknowledgeVisualIssues: false }],
    ];
    for (const [path, body] of commands) {
      const response = await request(target, path, post(body));
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({
        error: {
          code: "RUN_ARTIFACTS_PRUNED",
          message: "Run artifacts were removed by the ten-run retention policy",
        },
      });
    }

    const download = await request(target, "/v1/runs/run-1/artifacts/artifact-1");
    expect(download.status).toBe(410);
    expect(await download.json()).toEqual({
      error: {
        code: "RUN_ARTIFACTS_PRUNED",
        message: "Run artifacts were removed by the ten-run retention policy",
      },
    });
    const applicationStatus = await request(target, "/v1/runs/run-1", patch({ applicationStatus: "interview" }));
    expect(applicationStatus.status).toBe(200);
    expect(await applicationStatus.json()).toMatchObject({ applicationStatus: "interview" });
    expect(target.kickCount()).toBe(0);
  });

  test("serves only addressed artifacts with no-store", async () => {
    const response = await request(service(), "/v1/runs/run-1/artifacts/artifact-1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("artifact");
  });
});

const applicationSnapshot: ApplicationSessionSnapshotDto = {
  generation: 2,
  bridgeState: "running",
  harnessState: "running",
  createdAt: 1,
  updatedAt: 2,
  terminalAt: null,
  expiresAt: 60_001,
  company: "Example Corp",
  role: "Staff Engineer",
  fieldsFilled: [],
  fieldsNeedingHuman: [],
  filesAttached: ["resume.pdf"],
  warnings: [],
  revisionCount: 0,
  pendingAction: null,
  error: null,
};

const applicationEvent: ApplicationSessionEventDto = {
  generation: 2,
  event: "snapshot",
  session: applicationSnapshot,
  detail: {},
};

const applicationView: ApplicationSessionView = {
  state: "not_started",
  canStart: true,
  canStartAfterApproval: false,
};

function applicationService(
  overrides: Partial<ApplicationSessionRouteService> = {},
): ApplicationSessionRouteService {
  return {
    get: async () => applicationView,
    start: async () => applicationSnapshot,
    retry: async () => applicationSnapshot,
    events: async function* (): AsyncGenerator<ApplicationSessionStreamItem> {},
    command: async () => {},
    close: async () => {},
    ...overrides,
  };
}

async function applicationRequest(
  routeService: ApplicationSessionRouteService,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return createApiHandler({
    webOrigin: ORIGIN,
    route: createApplicationSessionRoutes(routeService),
  })(new Request(`http://127.0.0.1:3457${path}`, init));
}

describe("application session HTTP routes", () => {
  test("gets a validated view and starts with the exact approved hash", async () => {
    let received:
      | { runId: string; expectedApprovedPdfSha256: string; signal: AbortSignal }
      | undefined;
    const target = applicationService({
      start: async (runId, expectedApprovedPdfSha256, signal) => {
        received = { runId, expectedApprovedPdfSha256, signal };
        return applicationSnapshot;
      },
    });

    const view = await applicationRequest(target, "/v1/runs/run-1/application");
    expect(view.status).toBe(200);
    expect(view.headers.get("cache-control")).toBe("no-store");
    expect(await view.json()).toEqual(applicationView);

    const started = await applicationRequest(
      target,
      "/v1/runs/run-1/application",
      post({ expectedApprovedPdfSha256: PDF_HASH }),
    );
    expect(started.status).toBe(202);
    expect(started.headers.get("cache-control")).toBe("no-store");
    expect(await started.json()).toEqual(applicationSnapshot);
    expect(received).toEqual({
      runId: "run-1",
      expectedApprovedPdfSha256: PDF_HASH,
      signal: expect.any(AbortSignal),
    });
  });

  test("retries, sends a validated command, and closes with empty no-store responses", async () => {
    const calls: string[] = [];
    const target = applicationService({
      retry: async (runId, expectedApprovedPdfSha256, signal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        calls.push(`retry:${runId}:${expectedApprovedPdfSha256}`);
        return applicationSnapshot;
      },
      command: async (runId, command, signal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        calls.push(`command:${runId}:${JSON.stringify(command)}`);
      },
      close: async (runId, signal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        calls.push(`close:${runId}`);
      },
    });

    const retried = await applicationRequest(
      target,
      "/v1/runs/run%20one/application/retry",
      post({ expectedApprovedPdfSha256: PDF_HASH }),
    );
    expect(retried.status).toBe(202);
    expect(await retried.json()).toEqual(applicationSnapshot);

    const commanded = await applicationRequest(
      target,
      "/v1/runs/run%20one/application/commands",
      post({ type: "revise", context: "  Emphasize the platform work.  " }),
    );
    expect(commanded.status).toBe(202);
    expect(commanded.headers.get("cache-control")).toBe("no-store");
    expect(await commanded.text()).toBe("");

    const closed = await applicationRequest(
      target,
      "/v1/runs/run%20one/application",
      { method: "DELETE", headers: { origin: ORIGIN } },
    );
    expect(closed.status).toBe(204);
    expect(closed.headers.get("cache-control")).toBe("no-store");
    expect(await closed.text()).toBe("");
    expect(calls).toEqual([
      `retry:run%20one:${PDF_HASH}`,
      "command:run%20one:{\"type\":\"revise\",\"context\":\"Emphasize the platform work.\"}",
      "close:run%20one",
    ]);
  });

  test("rejects malformed requests through the public Origin and JSON boundary", async () => {
    let starts = 0;
    let commands = 0;
    let closes = 0;
    const target = applicationService({
      start: async () => {
        starts += 1;
        return applicationSnapshot;
      },
      command: async () => {
        commands += 1;
      },
      close: async () => {
        closes += 1;
      },
    });

    const missingOrigin = await applicationRequest(
      target,
      "/v1/runs/run-1/application",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedApprovedPdfSha256: PDF_HASH }),
      },
    );
    expect(missingOrigin.status).toBe(403);
    expect(await missingOrigin.json()).toEqual({
      error: { code: "ORIGIN_REJECTED", message: "Mutation origin is not allowed" },
    });

    const wrongMediaType = await applicationRequest(
      target,
      "/v1/runs/run-1/application",
      {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "text/plain" },
        body: JSON.stringify({ expectedApprovedPdfSha256: PDF_HASH }),
      },
    );
    expect(wrongMediaType.status).toBe(415);

    const invalidJson = await applicationRequest(
      target,
      "/v1/runs/run-1/application",
      {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: "{",
      },
    );
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({
      error: { code: "INVALID_JSON", message: "Request body is not valid JSON" },
    });

    for (const body of [
      {},
      { expectedApprovedPdfSha256: PDF_HASH.toUpperCase() },
      { expectedApprovedPdfSha256: PDF_HASH, extra: true },
    ]) {
      const response = await applicationRequest(
        target,
        "/v1/runs/run-1/application",
        post(body),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }

    for (const command of [
      {},
      { type: "continue", extra: true },
      { type: "approve_origin", origin: "https://example.test/path" },
      { type: "provide_additional_info", answers: [] },
      { type: "ready", answer: "private" },
    ]) {
      const response = await applicationRequest(
        target,
        "/v1/runs/run-1/application/commands",
        post(command),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "INVALID_REQUEST", message: "Application command is invalid" },
      });
    }

    const closeWithBody = await applicationRequest(
      target,
      "/v1/runs/run-1/application",
      { ...post({}), method: "DELETE" },
    );
    expect(closeWithBody.status).toBe(400);
    expect(await closeWithBody.json()).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "Application close request must be bodyless",
      },
    });
    expect({ starts, commands, closes }).toEqual({ starts: 0, commands: 0, closes: 0 });
  });

  test("preserves stable service errors and fixes unexpected failures", async () => {
    const unavailable = await applicationRequest(
      applicationService({
        start: async () => {
          throw new ApplicationSessionServiceError("APPLICATION_HARNESS_UNAVAILABLE");
        },
      }),
      "/v1/runs/run-1/application",
      post({ expectedApprovedPdfSha256: PDF_HASH }),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: {
        code: "APPLICATION_HARNESS_UNAVAILABLE",
        message: "The local application service is unavailable",
      },
    });

    const conflict = await applicationRequest(
      applicationService({
        command: async () => {
          throw new RunServiceError("RUN_CONFLICT", "application session is not live", 409);
        },
      }),
      "/v1/runs/run-1/application/commands",
      post({ type: "continue" }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: { code: "RUN_CONFLICT", message: "application session is not live" },
    });

    const unexpected = await applicationRequest(
      applicationService({
        get: async () => {
          throw new Error("Bearer private-token at /home/user/profile.md");
        },
      }),
      "/v1/runs/run-1/application",
    );
    expect(unexpected.status).toBe(500);
    expect(unexpected.headers.get("cache-control")).toBe("no-store");
    expect(await unexpected.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Request failed" },
    });
  });

  test("accepts only canonical generation-qualified cursors and streams one exact event", async () => {
    let received:
      | { runId: string; cursor: { generation: number; upstreamEventId: number } | undefined; signal: AbortSignal }
      | undefined;
    let nextCalls = 0;
    const target = applicationService({
      events: (runId, cursor, signal) => {
        received = { runId, cursor, signal };
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<ApplicationSessionStreamItem>> {
                nextCalls += 1;
                return nextCalls === 1
                  ? { done: false, value: { id: "2:7", event: applicationEvent } }
                  : { done: true, value: undefined };
              },
            };
          },
        };
      },
    });

    const response = await applicationRequest(
      target,
      "/v1/runs/run-1/application/events",
      { headers: { "last-event-id": "2:6" } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(nextCalls).toBe(0);
    expect(received).toEqual({
      runId: "run-1",
      cursor: { generation: 2, upstreamEventId: 6 },
      signal: expect.any(AbortSignal),
    });
    expect(await response.text()).toBe(
      "id: 2:7\n"
      + "event: snapshot\n"
      + "data: {\"generation\":2,\"session\":{\"generation\":2,\"bridgeState\":\"running\",\"harnessState\":\"running\",\"createdAt\":1,\"updatedAt\":2,\"terminalAt\":null,\"expiresAt\":60001,\"company\":\"Example Corp\",\"role\":\"Staff Engineer\",\"fieldsFilled\":[],\"fieldsNeedingHuman\":[],\"filesAttached\":[\"resume.pdf\"],\"warnings\":[],\"revisionCount\":0,\"pendingAction\":null,\"error\":null},\"event\":\"snapshot\",\"detail\":{}}\n\n",
    );
  });

  test("rejects ambiguous or unsafe Last-Event-ID values before opening a stream", async () => {
    let calls = 0;
    const target = applicationService({
      events: () => {
        calls += 1;
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<ApplicationSessionStreamItem> {},
        };
      },
    });

    for (const cursor of [
      "",
      "2 :7",
      "2: 7",
      "02:7",
      "2:07",
      "+2:7",
      "2:+7",
      "0:0",
      "2:-1",
      "2",
      "2:",
      "2:9007199254740992",
      "9007199254740992:1",
    ]) {
      const response = await applicationRequest(
        target,
        "/v1/runs/run-1/application/events",
        { headers: { "last-event-id": cursor } },
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: {
          code: "INVALID_REQUEST",
          message: "Application event cursor is invalid",
        },
      });
    }
    expect(calls).toBe(0);

    const absent = await applicationRequest(
      target,
      "/v1/runs/run-1/application/events",
    );
    expect(absent.status).toBe(200);
    expect(calls).toBe(1);
  });

  test("propagates request aborts and reader cancellation through iterator return", async () => {
    const createTarget = () => {
      let signal: AbortSignal | undefined;
      let returns = 0;
      const target = applicationService({
        events: (_runId, _cursor, requestSignal) => {
          signal = requestSignal;
          let emitted = false;
          return {
            [Symbol.asyncIterator]() {
              return {
                async next(): Promise<IteratorResult<ApplicationSessionStreamItem>> {
                  if (!emitted) {
                    emitted = true;
                    return { done: false, value: { id: "2:7", event: applicationEvent } };
                  }
                  return Promise.withResolvers<IteratorResult<ApplicationSessionStreamItem>>().promise;
                },
                async return(): Promise<IteratorResult<ApplicationSessionStreamItem>> {
                  returns += 1;
                  return { done: true, value: undefined };
                },
              };
            },
          };
        },
      });
      return {
        target,
        signal: () => signal,
        returns: () => returns,
      };
    };

    const abortedTarget = createTarget();
    const abortController = new AbortController();
    const abortedResponse = await applicationRequest(
      abortedTarget.target,
      "/v1/runs/run-1/application/events",
      { signal: abortController.signal },
    );
    const abortedReader = abortedResponse.body!.getReader();
    expect((await abortedReader.read()).done).toBe(false);
    abortController.abort(new DOMException("Client disconnected", "AbortError"));
    await expect(abortedReader.read()).rejects.toThrow("Client disconnected");
    expect(abortedTarget.signal()?.aborted).toBe(true);
    expect(abortedTarget.returns()).toBe(1);

    const cancelledTarget = createTarget();
    const cancelledResponse = await applicationRequest(
      cancelledTarget.target,
      "/v1/runs/run-1/application/events",
    );
    const cancelledReader = cancelledResponse.body!.getReader();
    expect((await cancelledReader.read()).done).toBe(false);
    await cancelledReader.cancel("view closed");
    expect(cancelledTarget.returns()).toBe(1);
  });

  test("refuses to stream service events containing private fields", async () => {
    let returns = 0;
    const privateEvent = {
      ...applicationEvent,
      session: {
        ...applicationSnapshot,
        sessionId: "6984d92f-fef5-4a75-8fb5-bb8d6316bb14",
        jobUrl: "https://private.example.test/jobs/1",
        bearer: "private-token",
      },
    } as unknown as ApplicationSessionEventDto;
    const target = applicationService({
      events: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<ApplicationSessionStreamItem>> {
              return { done: false, value: { id: "2:7", event: privateEvent } };
            },
            async return(): Promise<IteratorResult<ApplicationSessionStreamItem>> {
              returns += 1;
              return { done: true, value: undefined };
            },
          };
        },
      }),
    });
    const response = await applicationRequest(
      target,
      "/v1/runs/run-1/application/events",
    );
    await expect(response.text()).rejects.toThrow();
    expect(returns).toBe(1);
  });
});
