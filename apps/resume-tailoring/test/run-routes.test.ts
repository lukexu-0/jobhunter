import { describe, expect, test, vi } from "bun:test";
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
  ApplicationSessionCommand,
  ApplicationSessionView,
  OpportunityKind,
  ResumeIterationListResponse,
  RunDto,
} from "../src/contracts";
import { OpportunityKindSchema } from "../src/contracts";

const ORIGIN = "http://127.0.0.1:3456";
const PDF_HASH = "a".repeat(64);
const CANONICAL_JOB_URL = "https://jobs.example.test/role?gh_jid=123&source=route";
const run: RunDto = {
  id: "run-1",
  opportunityKind: "job",
  status: "queued",
  applicationStatus: "applied",
  queueSequence: 1,
  generateKeywordMap: true,
  skipReview: false,
  autoSubmit: false,
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
    listResumeIterations: async () => ({ artifactState: "retained", iterations: [] }),
    getResumeIterationArtifact: () =>
      new Response("iteration-artifact", { headers: { "content-type": "application/pdf" } }),
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
  test("accepts and forwards an explicit networking event opportunity kind", async () => {
    expect(OpportunityKindSchema.parse("networking_event")).toBe("networking_event");
    let receivedOpportunityKind: RunDto["opportunityKind"] | undefined;
    const target = service({
      createRun: async (request) => {
        if (!("jobUrl" in request)) throw new Error("Expected a URL request");
        receivedOpportunityKind = request.opportunityKind;
        return { ...run, opportunityKind: "networking_event" };
      },
    });

    const response = await request(target, "/v1/runs", post({
      jobUrl: "https://events.example.test/networking/platform-engineers",
      opportunityKind: "networking_event",
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ opportunityKind: "networking_event" });
    expect(receivedOpportunityKind).toBe("networking_event");
    expect(target.kickCount()).toBe(1);
  });

  test("forwards a normalized pasted request and request signal before kicking the scheduler", async () => {
    const queuedRun: RunDto = { ...run, applicationStatus: "pending" };
    let received: unknown[] | undefined;
    const target = service({
      createRun: async (...args: unknown[]) => {
        received = args;
        return queuedRun;
      },
    });
    const incoming = new Request("http://127.0.0.1:3457/v1/runs", post({
      jobTitle: "  Platform Engineer  ",
      jobDescription: "  Build reliable distributed systems and improve operational tooling.  ",
      generateKeywordMap: false,
    }));

    const response = await createApiHandler({ webOrigin: ORIGIN, route: createRunRoutes(target) })(incoming);

    expect(response.status).toBe(201);
    const responseBody = await response.json();
    expect(responseBody).toEqual(queuedRun);
    expect(responseBody).not.toHaveProperty("jobUrl");
    expect(received).toEqual([
      {
        jobTitle: "Platform Engineer",
        jobDescription: "Build reliable distributed systems and improve operational tooling.",
        generateKeywordMap: false,
      },
      incoming.signal,
    ]);
    expect(target.kickCount()).toBe(1);
  });

  test("canonicalizes the job URL, forwards independent run modes and request signal, and kicks only after persistence succeeds", async () => {
    let received: {
      jobUrl: string;
      generateKeywordMap: boolean;
      skipReview: boolean;
      autoSubmit: boolean;
      opportunityKind: OpportunityKind | undefined;
      signal: AbortSignal | undefined;
    } | undefined;
    const target = service({
      createRun: async (request, signal) => {
        if (!("jobUrl" in request)) throw new Error("Expected a URL request");
        const { jobUrl, generateKeywordMap, skipReview, autoSubmit, opportunityKind } = request;
        received = { jobUrl, generateKeywordMap, skipReview, autoSubmit, opportunityKind, signal };
        return { ...run, jobUrl, skipReview, autoSubmit };
      },
    });
    const incoming = new Request("http://127.0.0.1:3457/v1/runs", post({
      jobUrl: " HTTPS://Jobs.Example.Test:443/role?gh_jid=123&source=route#apply ",
      skipReview: true,
      autoSubmit: true,
    }));
    const created = await createApiHandler({ webOrigin: ORIGIN, route: createRunRoutes(target) })(incoming);
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(await created.json()).toEqual({
      ...run,
      jobUrl: CANONICAL_JOB_URL,
      skipReview: true,
      autoSubmit: true,
    });
    expect(received).toEqual({
      jobUrl: CANONICAL_JOB_URL,
      generateKeywordMap: true,
      skipReview: true,
      autoSubmit: true,
      opportunityKind: undefined,
      signal: incoming.signal,
    });
    expect(target.kickCount()).toBe(1);

    const failedTarget = service({
      createRun: async () => {
        throw Object.assign(new Error("The page does not contain a usable opportunity description"), {
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
        message: "The page does not contain a usable opportunity description",
      },
    });
    expect(failedTarget.kickCount()).toBe(0);

    let defaulted: {
      generateKeywordMap: boolean;
      skipReview: boolean;
      autoSubmit: boolean;
    } | undefined;
    const defaultTarget = service({
      createRun: async (request) => {
        if (!("jobUrl" in request)) throw new Error("Expected a URL request");
        const { generateKeywordMap, skipReview, autoSubmit } = request;
        defaulted = { generateKeywordMap, skipReview, autoSubmit };
        return run;
      },
    });
    expect((await request(defaultTarget, "/v1/runs", post({ jobUrl: "https://jobs.example.test/default" }))).status).toBe(201);
    expect(defaulted).toEqual({
      generateKeywordMap: true,
      skipReview: false,
      autoSubmit: false,
    });
  });

  test("returns canonical job URLs and omits them for legacy runs", async () => {
    const exposedRun: RunDto = { ...run, jobUrl: CANONICAL_JOB_URL };
    const target = service({
      listRuns: () => [exposedRun],
      getRun: () => exposedRun,
    });

    const listed = await request(target, "/v1/runs");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ runs: [exposedRun] });

    const retrieved = await request(target, "/v1/runs/run-1");
    expect(retrieved.status).toBe(200);
    expect(await retrieved.json()).toEqual(exposedRun);

    const legacy = await request(service(), "/v1/runs/run-1");
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).not.toHaveProperty("jobUrl");
  });

  test("accepts only application statuses without waking the scheduler", async () => {
    const applicationStatuses = [
      "pending",
      "did_not_apply",
      "applied",
      "oa_received",
      "oa_completed",
      "rejected",
      "interview",
      "accepted",
      "failed",
    ] as const;
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
      { applicationStatus: "waiting_for_review" },
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
      { jobUrl: "https://example.test/job", skipReview: "true" },
      { jobUrl: "https://example.test/job", opportunityKind: "conference" },
      { jobUrl: "https://example.test/job", autoSubmit: "true" },
      { jobUrl: "https://example.test/job", autoApply: true },
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
        message: "Opportunity description extraction failed",
      },
      {
        code: "JOB_EXTRACTION_TIMEOUT",
        status: 504,
        message: "Opportunity description extraction timed out",
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
        throw Object.assign(new Error("Connect OpenAI Codex OAuth before importing this opportunity page"), {
          code: "JOB_EXTRACTION_AUTH_REQUIRED",
          status: 409,
        });
      },
    }), "/v1/runs", post({ jobUrl: "https://jobs.example.test/role" }));
    expect(authRequired.status).toBe(409);
    expect(await authRequired.json()).toEqual({
      error: {
        code: "JOB_EXTRACTION_AUTH_REQUIRED",
        message: "Connect OpenAI Codex OAuth before importing this opportunity page",
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
      new Error("Historical run artifacts are unavailable"),
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
          message: "Historical run artifacts are unavailable",
        },
      });
    }

    const download = await request(target, "/v1/runs/run-1/artifacts/artifact-1");
    expect(download.status).toBe(410);
    expect(await download.json()).toEqual({
      error: {
        code: "RUN_ARTIFACTS_PRUNED",
        message: "Historical run artifacts are unavailable",
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

  test("lists strict iterations and serves only a canonical selected revision artifact", async () => {
    const iterations: ResumeIterationListResponse = {
      artifactState: "retained",
      iterations: [{
        revision: 2,
        origin: "human-comments",
        status: "review",
        createdAt: 2,
        pdfSha256: PDF_HASH,
        artifacts: [],
      }],
    };
    const artifactCalls: Array<{ runId: string; revision: number; artifactId: string }> = [];
    const target = service({
      listResumeIterations: async (runId) => {
        expect(runId).toBe("run-1");
        return iterations;
      },
      getResumeIterationArtifact: async (runId, revision, artifactId) => {
        artifactCalls.push({ runId, revision, artifactId });
        return new Response("historical-pdf", {
          headers: { "content-type": "application/pdf" },
        });
      },
    });

    const listed = await request(target, "/v1/runs/run-1/iterations");
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(await listed.json()).toEqual(iterations);

    const artifact = await request(
      target,
      "/v1/runs/run-1/iterations/2/artifacts/artifact-2",
    );
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get("cache-control")).toBe("no-store");
    expect(artifact.headers.get("content-type")).toBe("application/pdf");
    expect(await artifact.text()).toBe("historical-pdf");
    expect(artifactCalls).toEqual([{
      runId: "run-1",
      revision: 2,
      artifactId: "artifact-2",
    }]);

    for (const revision of ["0", "02", "9007199254740992", "nope"]) {
      const invalid = await request(
        target,
        `/v1/runs/run-1/iterations/${revision}/artifacts/artifact-2`,
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        error: {
          code: "INVALID_REQUEST",
          message: "Resume iteration revision is invalid",
        },
      });
    }
    expect(artifactCalls).toHaveLength(1);

    const missing = await request(
      service({ getResumeIterationArtifact: async () => undefined }),
      "/v1/runs/run-1/iterations/1/artifacts/missing",
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: "ARTIFACT_NOT_FOUND", message: "Artifact not found" },
    });
  });
});

const applicationSnapshot: ApplicationSessionSnapshotDto = {
  generation: 2,
  bridgeState: "running",
  harnessState: "running",
  submissionPhase: "not_attempted",
  createdAt: 1,
  updatedAt: 2,
  terminalAt: null,
  expiresAt: 60_001,
  company: "Example Corp",
  role: "Staff Engineer",
  fieldsFilled: [],
  fieldsNeedingHuman: [],
  filesAttached: ["resume.pdf"],
  playwrightCliDiagnostics: [],
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
    suggestions: async () => ({ suggestions: [] }),
    professionalize: async () => ({ answer: "Professional answer." }),
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

  test("serves strict current-question suggestions and professionalization DTOs", async () => {
    const calls: unknown[] = [];
    const target = applicationService({
      suggestions: async (runId, questionId, requestSignal) => {
        calls.push({ operation: "suggestions", runId, questionId, signal: requestSignal });
        return {
          suggestions: [{
            question: "What impact did you have?",
            answer: "I improved reliability using the supplied evidence.",
          }],
        };
      },
      professionalize: async (runId, questionId, body, requestSignal) => {
        calls.push({
          operation: "professionalize",
          runId,
          questionId,
          body,
          signal: requestSignal,
        });
        return { answer: "I improved reliability using the supplied evidence." };
      },
    });

    const suggestions = await applicationRequest(
      target,
      "/v1/runs/run-1/application/additional-info/impact/suggestions",
      post({}),
    );
    expect(suggestions.status).toBe(200);
    expect(suggestions.headers.get("cache-control")).toBe("no-store");
    expect(await suggestions.json()).toEqual({
      suggestions: [{
        question: "What impact did you have?",
        answer: "I improved reliability using the supplied evidence.",
      }],
    });

    const professionalized = await applicationRequest(
      target,
      "/v1/runs/run-1/application/additional-info/impact/professionalize",
      post({
        promptId: "default",
        draft: "  improved reliability  ",
        instruction: "  Use a complete sentence.  ",
      }),
    );
    expect(professionalized.status).toBe(200);
    expect(professionalized.headers.get("cache-control")).toBe("no-store");
    expect(await professionalized.json()).toEqual({
      answer: "I improved reliability using the supplied evidence.",
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
        body: {
          promptId: "default",
          draft: "improved reliability",
          instruction: "Use a complete sentence.",
        },
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  test("bounds and strictly validates answer-tool route inputs and outputs", async () => {
    let professionalizeCalls = 0;
    let suggestionCalls = 0;
    const target = applicationService({
      professionalize: async () => {
        professionalizeCalls += 1;
        return {
          answer: "Safe answer.",
          rawValue: "PRIVATE RAW VALUE",
        } as never;
      },
      suggestions: async () => {
        suggestionCalls += 1;
        return {
          suggestions: [{
            question: "Question",
            answer: "Answer",
            key: "private.storage.key",
          }],
        } as never;
      },
    });

    const badQuestionId = await applicationRequest(
      target,
      "/v1/runs/run-1/application/additional-info/INVALID-ID/suggestions",
      post({}),
    );
    expect(badQuestionId.status).toBe(400);
    expect(await badQuestionId.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "Application question is invalid" },
    });

    const legacyGet = await applicationRequest(
      target,
      "/v1/runs/run-1/application/additional-info/impact/suggestions",
    );
    expect(legacyGet.status).toBe(404);
    for (const init of [
      post({ extra: true }),
      {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
      },
    ]) {
      const response = await applicationRequest(
        target,
        "/v1/runs/run-1/application/additional-info/impact/suggestions",
        init,
      );
      expect(response.status).toBe(400);
    }
    expect(suggestionCalls).toBe(0);

    for (const body of [
      {},
      { promptId: "custom", draft: "draft" },
      { promptId: "default", draft: "" },
      { promptId: "default", draft: "draft", extra: true },
    ]) {
      const response = await applicationRequest(
        target,
        "/v1/runs/run-1/application/additional-info/impact/professionalize",
        post(body),
      );
      expect(response.status).toBe(400);
    }
    const oversized = await applicationRequest(
      target,
      "/v1/runs/run-1/application/additional-info/impact/professionalize",
      post({
        promptId: "default",
        draft: "x".repeat(16 * 1024),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(professionalizeCalls).toBe(0);

    const privateSuggestions = await applicationRequest(
      target,
      "/v1/runs/run-1/application/additional-info/impact/suggestions",
      post({}),
    );
    expect(privateSuggestions.status).toBe(500);
    expect(JSON.stringify(await privateSuggestions.json())).not.toContain("private.storage.key");
    expect(suggestionCalls).toBe(1);

    const privateProfessionalized = await applicationRequest(
      target,
      "/v1/runs/run-1/application/additional-info/impact/professionalize",
      post({ promptId: "default", draft: "draft" }),
    );
    expect(privateProfessionalized.status).toBe(500);
    expect(JSON.stringify(await privateProfessionalized.json())).not.toContain("PRIVATE RAW VALUE");
    const abortController = new AbortController();
    const abortReason = new Error("caller closed answer request");
    const aborting = applicationRequest(
      applicationService({
        professionalize: async (_runId, _questionId, _body, requestSignal) => {
          abortController.abort(abortReason);
          requestSignal.throwIfAborted();
          throw new Error("unreachable");
        },
      }),
      "/v1/runs/run-1/application/additional-info/impact/professionalize",
      {
        ...post({ promptId: "default", draft: "draft" }),
        signal: abortController.signal,
      },
    );
    await expect(aborting).rejects.toBe(abortReason);
  });


  test("allows only navigation or credential markers while awaiting human navigation", async () => {
    const pendingActions = [
      { type: "credentials" as const },
      {
        type: "human_navigation" as const,
        instruction: "Complete the CAPTCHA.",
      },
    ];
    for (const pendingAction of pendingActions) {
      const snapshot: ApplicationSessionSnapshotDto = {
        ...applicationSnapshot,
        bridgeState: "awaiting_human_navigation",
        harnessState: "awaiting_human_navigation",
        pendingAction,
      };
      const response = await applicationRequest(
        applicationService({ get: async () => snapshot }),
        "/v1/runs/run-1/application",
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        bridgeState: "awaiting_human_navigation",
        pendingAction,
      });
    }

    const invalid = await applicationRequest(
      applicationService({
        get: async () => ({
          ...applicationSnapshot,
          pendingAction: { type: "credentials" },
        }),
      }),
      "/v1/runs/run-1/application",
    );
    expect(invalid.status).toBe(500);
    expect(await invalid.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Request failed" },
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

  test("forwards credentials with Python username stripping and exact passwords", async () => {
    const received: ApplicationSessionCommand[] = [];
    const target = applicationService({
      command: async (_runId, command) => {
        received.push(command);
      },
    });
    const signInPassword = "  exact sign-in password  ";
    const savedPassword = " exact saved password ";
    const inputs = [
      {
        type: "sign_in",
        username: "\u001c\u0085applicant@example.test\u001f",
        password: signInPassword,
      },
      {
        type: "save_credentials",
        username: "\ufeffsaved@example.test\ufeff",
        password: savedPassword,
      },
    ] as const;

    const responses: Response[] = [];
    for (const command of inputs) {
      responses.push(await applicationRequest(
        target,
        "/v1/runs/run-1/application/commands",
        post(command),
      ));
    }

    expect(received).toEqual([
      {
        type: "sign_in",
        username: "applicant@example.test",
        password: signInPassword,
      },
      {
        type: "save_credentials",
        username: "\ufeffsaved@example.test\ufeff",
        password: savedPassword,
      },
    ]);
    for (const response of responses) {
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
  });

  test("normalizes and forwards strict steering with an empty no-store 202", async () => {
    const received: ApplicationSessionCommand[] = [];
    const target = applicationService({
      command: async (_runId, command) => {
        received.push(command);
      },
    });
    const privateMessage = "Prefer the distributed-systems example.";

    const response = await applicationRequest(
      target,
      "/v1/runs/run-1/application/commands",
      post({
        type: "steer",
        message: `\u001c  ${privateMessage}  \u0085`,
      }),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(received).toEqual([{ type: "steer", message: privateMessage }]);
  });

  test("rejects malformed requests through the public Origin and JSON boundary", async () => {
    let starts = 0;
    let suggestions = 0;
    let commands = 0;
    let closes = 0;
    const target = applicationService({
      start: async () => {
        starts += 1;
        return applicationSnapshot;
      },
      suggestions: async () => {
        suggestions += 1;
        return { suggestions: [] };
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

    for (const headers of [
      new Headers({ "content-type": "application/json" }),
      new Headers({
        origin: "https://attacker.invalid",
        "content-type": "application/json",
      }),
    ]) {
      const rejectedSuggestions = await applicationRequest(
        target,
        "/v1/runs/run-1/application/additional-info/impact/suggestions",
        { method: "POST", headers, body: "{}" },
      );
      expect(rejectedSuggestions.status).toBe(403);
      expect(await rejectedSuggestions.json()).toEqual({
        error: { code: "ORIGIN_REJECTED", message: "Mutation origin is not allowed" },
      });
    }
    expect(suggestions).toBe(0);

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
      { type: "ready" },
      { type: "steer", message: " " },
      { type: "steer", message: "x".repeat(8_001) },
      { type: "steer", message: "before\u0000after" },
      { type: "steer", message: "\ud800" },
      { type: "steer", message: "valid", extra: true },
      { type: "sign_in", username: " ", password: "private" },
      { type: "sign_in", username: "😀".repeat(321), password: "private" },
      { type: "sign_in", username: "applicant@example.test", password: "" },
      { type: "sign_in", username: "\ud800", password: "private" },
      { type: "sign_in", username: "applicant@example.test", password: "\udfff" },
      { type: "sign_in", username: "applicant\u0000@example.test", password: "private" },
      {
        type: "save_credentials",
        username: "applicant@example.test",
        password: "private\u0000password",
      },
      {
        type: "sign_in",
        username: "applicant@example.test",
        password: "😀".repeat(4_097),
      },
      {
        type: "sign_in",
        username: "applicant@example.test",
        password: "private",
        extra: true,
      },
      { type: "save_credentials", username: "applicant@example.test" },
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

    const submissionFinal = await applicationRequest(
      applicationService({
        retry: async () => {
          throw new ApplicationSessionServiceError("APPLICATION_SUBMISSION_FINAL");
        },
      }),
      "/v1/runs/run-1/application/retry",
      post({ expectedApprovedPdfSha256: PDF_HASH }),
    );
    expect(submissionFinal.status).toBe(409);
    expect(await submissionFinal.json()).toEqual({
      error: {
        code: "APPLICATION_SUBMISSION_FINAL",
        message: "The application submission cannot be retried",
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

    for (const [code, status, message] of [
      [
        "APPLICATION_QUESTION_STALE",
        409,
        "The application question changed; review the latest session state",
      ],
      ["OAUTH_REQUIRED", 409, "Connect OpenAI Codex in Provider access"],
      ["MODEL_TIMEOUT", 504, "The model request timed out"],
      ["INVALID_MODEL_OUTPUT", 502, "The model returned invalid output"],
      ["MODEL_PROVIDER_FAILED", 502, "The model request failed"],
    ] as const) {
      const response = await applicationRequest(
        applicationService({
          professionalize: async () => {
            throw new ApplicationSessionServiceError(code);
          },
        }),
        "/v1/runs/run-1/application/additional-info/impact/professionalize",
        post({ promptId: "default", draft: "draft" }),
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: { code, message } });
    }

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

  test("maps event preflight failures before committing stream headers", async () => {
    const response = await applicationRequest(
      applicationService({
        events: async () => {
          throw new ApplicationSessionServiceError("APPLICATION_HARNESS_UNAVAILABLE");
        },
      }),
      "/v1/runs/run-1/application/events",
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({
      error: {
        code: "APPLICATION_HARNESS_UNAVAILABLE",
        message: "The local application service is unavailable",
      },
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
      + "data: {\"generation\":2,\"session\":{\"generation\":2,\"bridgeState\":\"running\",\"harnessState\":\"running\",\"submissionPhase\":\"not_attempted\",\"createdAt\":1,\"updatedAt\":2,\"terminalAt\":null,\"expiresAt\":60001,\"company\":\"Example Corp\",\"role\":\"Staff Engineer\",\"fieldsFilled\":[],\"fieldsNeedingHuman\":[],\"filesAttached\":[\"resume.pdf\"],\"warnings\":[],\"revisionCount\":0,\"playwrightCliDiagnostics\":[],\"pendingAction\":null,\"error\":null},\"event\":\"snapshot\",\"detail\":{}}\n\n",
    );
  });

  test("heartbeats an idle event stream without advancing its iterator", async () => {
    const HEARTBEAT_INTERVAL_MS = 15_000;
    const nextResult = Promise.withResolvers<IteratorResult<ApplicationSessionStreamItem>>();
    let nextCalls = 0;
    let nextCallsInFlight = 0;
    let maximumConcurrentNextCalls = 0;
    let returnCalls = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const settleMicrotasks = async (): Promise<void> => {
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    };
    const target = applicationService({
      events: () => ({
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<ApplicationSessionStreamItem>> {
              nextCalls += 1;
              nextCallsInFlight += 1;
              maximumConcurrentNextCalls = Math.max(
                maximumConcurrentNextCalls,
                nextCallsInFlight,
              );
              return nextResult.promise.finally(() => {
                nextCallsInFlight -= 1;
              });
            },
            async return(): Promise<IteratorResult<ApplicationSessionStreamItem>> {
              returnCalls += 1;
              return { done: true, value: undefined };
            },
          };
        },
      }),
    });

    vi.useFakeTimers();
    try {
      const response = await applicationRequest(
        target,
        "/v1/runs/run-1/application/events",
      );
      reader = response.body!.getReader();
      let heartbeatSettled = false;
      const heartbeatRead = reader.read().then((result) => {
        heartbeatSettled = true;
        return result;
      });
      await settleMicrotasks();
      expect(nextCalls).toBe(1);

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1);
      await settleMicrotasks();
      expect(heartbeatSettled).toBe(false);
      vi.advanceTimersByTime(1);
      await settleMicrotasks();
      expect(heartbeatSettled).toBe(true);

      const heartbeat = await heartbeatRead;
      expect(heartbeat.done).toBe(false);
      expect(new TextDecoder().decode(heartbeat.value)).toBe(": heartbeat\n\n");
      expect(nextCalls).toBe(1);
      expect(maximumConcurrentNextCalls).toBe(1);

      const eventRead = reader.read();
      await settleMicrotasks();
      expect(nextCalls).toBe(1);
      expect(maximumConcurrentNextCalls).toBe(1);
      nextResult.resolve({
        done: false,
        value: { id: "2:7", event: applicationEvent },
      });
      const event = await eventRead;
      expect(event.done).toBe(false);
      expect(new TextDecoder().decode(event.value)).toBe(
        "id: 2:7\n"
        + "event: snapshot\n"
        + "data: {\"generation\":2,\"session\":{\"generation\":2,\"bridgeState\":\"running\",\"harnessState\":\"running\",\"submissionPhase\":\"not_attempted\",\"createdAt\":1,\"updatedAt\":2,\"terminalAt\":null,\"expiresAt\":60001,\"company\":\"Example Corp\",\"role\":\"Staff Engineer\",\"fieldsFilled\":[],\"fieldsNeedingHuman\":[],\"filesAttached\":[\"resume.pdf\"],\"warnings\":[],\"revisionCount\":0,\"playwrightCliDiagnostics\":[],\"pendingAction\":null,\"error\":null},\"event\":\"snapshot\",\"detail\":{}}\n\n",
      );

      await reader.cancel("view closed");
      expect(returnCalls).toBe(1);
    } finally {
      const cancellation = reader?.cancel("test cleanup");
      nextResult.resolve({ done: true, value: undefined });
      await cancellation?.catch(() => {});
      vi.useRealTimers();
    }
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

  test("closes aborted streams and propagates reader cancellation through iterator return", async () => {
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
    expect(await abortedReader.read()).toEqual({ done: true, value: undefined });
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
