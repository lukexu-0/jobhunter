import { describe, expect, test } from "bun:test";
import { createApiHandler } from "../src/api/handler";
import { createRunRoutes, type RunRouteService } from "../src/api/run-routes";
import type { RunDto } from "../src/contracts";

const ORIGIN = "http://127.0.0.1:3456";
const PDF_HASH = "a".repeat(64);
const run: RunDto = {
  id: "run-1",
  status: "queued",
  applicationStatus: "applied",
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
  test("canonicalizes the job URL, forwards the request signal, and kicks only after persistence succeeds", async () => {
    let received: { jobUrl: string; signal: AbortSignal | undefined } | undefined;
    const target = service({
      createRun: async (jobUrl, signal) => {
        received = { jobUrl, signal };
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
    expect(received).toEqual({ jobUrl: "https://jobs.example.test/role", signal: incoming.signal });
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
  });

  test("accepts only application statuses without waking the scheduler", async () => {
    const applicationStatuses = ["applied", "rejected", "interview", "accepted", "failed"] as const;
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
      { jobUrl: "https://example.test/job", extra: true },
    ]) {
      const response = await request(target, "/v1/runs", post(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "INVALID_REQUEST", message: "Job URL must be a valid HTTP(S) URL" },
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
