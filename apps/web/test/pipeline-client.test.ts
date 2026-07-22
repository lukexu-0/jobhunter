import { afterEach, describe, expect, test } from "bun:test";
import {
  type ApplicationSessionSnapshotDto,
  type ApplicationSessionView,
  type ArtifactDto,
  type RunDto,
  type RunStatus,
} from "@jobhunter/pipeline/contracts";
import {
  PipelineClientError,
  applicationEventsHref,
  approveRun,
  artifactHref,
  closeApplicationSession,
  createRun,
  deleteRun,
  editRun,
  getApplicationSession,
  getRun,
  listRuns,
  readJsonArtifact,
  regenerateRun,
  retryApplicationSession,
  retryRun,
  sendApplicationCommand,
  startApplicationSession,
  updateApplicationStatus,
  updateRunIdentity,
} from "../app/lib/pipeline-client";

const originalFetch = globalThis.fetch;
const sha256 = "a".repeat(64);
const statuses: RunStatus[] = [
  "queued",
  "analyzing",
  "tailoring",
  "editing",
  "compiling",
  "repairing",
  "deterministic_qa",
  "visual_qa",
  "review",
  "approved",
  "failed",
];

function run(status: RunStatus = "queued"): RunDto {
  return {
    id: `run ${status}`,
    status,
    applicationStatus: "applied",
    queueSequence: 1,
    generateKeywordMap: false,
    revision: 0,
    origin: "initial",
    createdAt: 1,
    updatedAt: 2,
    visualAcknowledgementRequired: false,
    attempts: [],
    artifacts: [],
    timeline: [],
  };
}

function artifact(overrides: Partial<ArtifactDto> = {}): ArtifactDto {
  return {
    id: "artifact-1",
    kind: "job-analysis",
    revision: 0,
    attempt: 1,
    sha256,
    bytes: 13,
    mediaType: "application/json",
    href: "/v1/runs/run%201/artifacts/artifact-1",
    public: true,
    createdAt: 3,
    ...overrides,
  };
}

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

const applicationView: ApplicationSessionView = {
  state: "not_started",
  canStart: true,
  canStartAfterApproval: false,
};

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function setFetchMock(mock: FetchMock): void {
  globalThis.fetch = mock as unknown as typeof fetch;
}

function capture(response: Response, requests: Array<{ input: RequestInfo | URL; init?: RequestInit }>) {
  setFetchMock(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return response;
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("pipeline run requests", () => {
  test("lists every valid public run state without caching", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    capture(json({ runs: statuses.map(run) }), requests);

    expect((await listRuns()).map((item) => item.status)).toEqual(statuses);
    expect(requests).toEqual([
      { input: "/api/pipeline/runs", init: { cache: "no-store", method: "GET" } },
    ]);
  });

  test("updates the user-managed application status", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const updated: RunDto = { ...run(), applicationStatus: "failed" };
    capture(json(updated), requests);

    await expect(updateApplicationStatus("run /1", "failed")).resolves.toEqual(updated);
    expect(requests).toEqual([
      {
        input: "/api/pipeline/runs/run%20%2F1",
        init: {
          body: JSON.stringify({ applicationStatus: "failed" }),
          cache: "no-store",
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      },
    ]);
  });

  test("updates run identity and accepts a successful bodyless delete response", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const updated: RunDto = {
      ...run(),
      titleOverride: "Principal Engineer",
      organizationOverride: "Example Labs",
    };
    setFetchMock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return init?.method === "DELETE" ? new Response(null, { status: 204 }) : json(updated);
    });

    await expect(updateRunIdentity("run /1", { title: "  Principal Engineer  " })).resolves.toEqual(updated);
    await expect(updateRunIdentity("run /1", { organization: "  Example Labs  " })).resolves.toEqual(updated);
    await expect(deleteRun("run /1")).resolves.toBeUndefined();

    expect(requests).toEqual([
      {
        input: "/api/pipeline/runs/run%20%2F1",
        init: {
          body: JSON.stringify({ title: "Principal Engineer" }),
          cache: "no-store",
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      },
      {
        input: "/api/pipeline/runs/run%20%2F1",
        init: {
          body: JSON.stringify({ organization: "Example Labs" }),
          cache: "no-store",
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      },
      {
        input: "/api/pipeline/runs/run%20%2F1",
        init: {
          cache: "no-store",
          method: "DELETE",
        },
      },
    ]);
  });

  test("rejects invalid run identity updates locally without fetching", () => {
    let fetchCalls = 0;
    setFetchMock(async () => {
      fetchCalls += 1;
      return json(run());
    });

    for (const identity of [
      {},
      { title: " " },
      { organization: "x".repeat(201) },
      { title: "Valid", extra: "not allowed" },
    ]) {
      expect(() => updateRunIdentity("run-1", identity)).toThrow(PipelineClientError);
    }
    expect(fetchCalls).toBe(0);
  });

  test("encodes run IDs and sends each mutation's exact body", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    setFetchMock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return json(run("review"));
    });

    await getRun("one/two ?");
    await createRun(" HTTPS://Jobs.Example.TEST:443/roles/Platform#apply ");
    await retryRun("one/two ?");
    await regenerateRun("one/two ?", sha256);
    await editRun("one/two ?", "Make the impact clearer.", sha256);
    await approveRun("one/two ?", sha256, true);

    expect(requests).toEqual([
      { input: "/api/pipeline/runs/one%2Ftwo%20%3F", init: { cache: "no-store", method: "GET" } },
      {
        input: "/api/pipeline/runs",
        init: {
          body: JSON.stringify({
            jobUrl: "https://jobs.example.test/roles/Platform",
            generateKeywordMap: true,
          }),
          cache: "no-store",
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      },
      {
        input: "/api/pipeline/runs/one%2Ftwo%20%3F/retry",
        init: { body: "{}", cache: "no-store", headers: { "content-type": "application/json" }, method: "POST" },
      },
      {
        input: "/api/pipeline/runs/one%2Ftwo%20%3F/regenerate",
        init: { body: JSON.stringify({ expectedPdfSha256: sha256 }), cache: "no-store", headers: { "content-type": "application/json" }, method: "POST" },
      },
      {
        input: "/api/pipeline/runs/one%2Ftwo%20%3F/edit",
        init: { body: JSON.stringify({ comments: "Make the impact clearer.", expectedPdfSha256: sha256 }), cache: "no-store", headers: { "content-type": "application/json" }, method: "POST" },
      },
      {
        input: "/api/pipeline/runs/one%2Ftwo%20%3F/approve",
        init: { body: JSON.stringify({ expectedPdfSha256: sha256, acknowledgeVisualIssues: true }), cache: "no-store", headers: { "content-type": "application/json" }, method: "POST" },
      },
    ]);
  });

  test("forwards an explicit keyword-map opt out", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    capture(json(run()), requests);

    await createRun("https://jobs.example.test/roles/platform", false);

    expect(requests).toEqual([
      {
        input: "/api/pipeline/runs",
        init: {
          body: JSON.stringify({
            jobUrl: "https://jobs.example.test/roles/platform",
            generateKeywordMap: false,
          }),
          cache: "no-store",
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      },
    ]);
  });

  test("rejects invalid job URLs locally without fetching", () => {
    let fetchCalls = 0;
    setFetchMock(async () => {
      fetchCalls += 1;
      return json(run());
    });

    const invalidUrls = [
      "/jobs/platform",
      "ftp://jobs.example.test/platform",
      "https://user:password@jobs.example.test/platform",
      `https://jobs.example.test/${"a".repeat(2_049)}`,
      `https://jobs.example.test/${"é".repeat(400)}`,
    ];

    for (const jobUrl of invalidUrls) {
      expect(() => createRun(jobUrl)).toThrow(PipelineClientError);
      try {
        createRun(jobUrl);
      } catch (error) {
        expect(error).toMatchObject({
          code: "INVALID_REQUEST",
          message: "The request is invalid.",
        });
      }
    }
    expect(fetchCalls).toBe(0);
  });


  test("rejects a successful response that does not match its public schema", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    capture(json({ ...run(), filesystemPath: "/private/resume.tex" }), requests);

    await expect(getRun("run-1")).rejects.toMatchObject({
      name: "PipelineClientError",
      code: "INVALID_RESPONSE",
      message: "The pipeline returned an invalid response.",
    });
  });

  test("maps public 4xx API errors and redacts bounded hostile messages", async () => {
    setFetchMock(async () => json({ error: { code: "BAD_REQUEST", message: `authorization=secret ${"x".repeat(1_000)}` } }, { status: 400 }));

    try {
      await getRun("run-1");
      throw new Error("Expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineClientError);
      expect(error).toMatchObject({ code: "BAD_REQUEST", status: 400 });
      expect((error as Error).message).not.toContain("secret");
      expect((error as Error).message.length).toBeLessThanOrEqual(240);
    }
  });

  test("fully redacts Bearer and Basic Authorization credentials", async () => {
    for (const [scheme, credential] of [
      ["Bearer", "supersecret"],
      ["Basic", "dXNlcjpwYXNz"],
    ] as const) {
      const authorizationValue = `${scheme} ${credential}`;
      const publicMessage = `Authorization: ${authorizationValue}`;
      setFetchMock(async () => json({
        error: {
          code: "BAD_REQUEST",
          message: publicMessage,
        },
      }, { status: 400 }));

      try {
        await getRun("run-1");
        throw new Error("Expected request to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(PipelineClientError);
        expect(error).toMatchObject({ code: "BAD_REQUEST", status: 400 });
        expect((error as Error).message).toContain("redacted");
        expect((error as Error).message).not.toContain(credential);
        expect((error as Error).message).not.toContain(authorizationValue);
      }
    }
  });

  test("does not expose malformed or server error bodies", async () => {
    setFetchMock(async () => json({ error: { code: "INTERNAL_ERROR", message: "/home/user/token=secret" } }, { status: 500 }));
    await expect(getRun("run-1")).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "The pipeline request failed.",
    });

    setFetchMock(async () => new Response("not json", { status: 502 }));
    await expect(getRun("run-1")).rejects.toMatchObject({
      code: "REQUEST_FAILED",
      status: 502,
      message: "The pipeline request failed.",
    });
  });

  test("exposes only fixed actionable extraction 5xx messages", async () => {
    for (const [code, status, message] of [
      ["JOB_EXTRACTION_UNAVAILABLE", 502, "Job description extraction failed"],
      ["JOB_EXTRACTION_TIMEOUT", 504, "Job description extraction timed out"],
    ] as const) {
      setFetchMock(async () => json({
        error: {
          code,
          message: "authorization=Bearer private-server-secret",
        },
      }, { status }));

      await expect(getRun("run-1")).rejects.toMatchObject({
        code,
        status,
        message,
      });
    }
  });

  test("rejects oversized error bodies before parsing their declared or streamed bytes", async () => {
    setFetchMock(async () => new Response(
      JSON.stringify({ error: { code: "BAD_REQUEST", message: "must not be parsed" } }),
      {
        headers: {
          "content-length": "1048577",
          "content-type": "application/json",
        },
        status: 400,
      },
    ));
    await expect(getRun("run-1")).rejects.toMatchObject({
      code: "REQUEST_FAILED",
      status: 400,
      message: "The pipeline request failed.",
    });

    let cancelled = false;
    const chunk = new Uint8Array(40 * 1024);
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    setFetchMock(async () => new Response(oversizedBody, {
      headers: { "content-type": "application/json" },
      status: 400,
    }));

    await expect(getRun("run-1")).rejects.toMatchObject({
      code: "REQUEST_FAILED",
      status: 400,
      message: "The pipeline request failed.",
    });
    expect(cancelled).toBe(true);
  });

});

describe("pipeline application session requests", () => {
  test("uses only same-origin run-scoped paths with exact methods and bodies", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    setFetchMock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      const path = String(input);
      if (init?.method === "GET") return json(applicationView);
      if (path.endsWith("/commands")) return new Response(null, { status: 202 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json(applicationSnapshot, { status: 202 });
    });

    const id = "run /1?";
    await expect(getApplicationSession(id)).resolves.toEqual(applicationView);
    await expect(startApplicationSession(id, sha256)).resolves.toEqual(applicationSnapshot);
    await expect(retryApplicationSession(id, sha256)).resolves.toEqual(applicationSnapshot);
    await expect(sendApplicationCommand(id, {
      type: "approve_origin",
      origin: "https://apply.example.test",
    })).resolves.toBeUndefined();
    await expect(closeApplicationSession(id)).resolves.toBeUndefined();
    expect(applicationEventsHref(id)).toBe(
      "/api/pipeline/runs/run%20%2F1%3F/application/events",
    );

    expect(requests).toEqual([
      {
        input: "/api/pipeline/runs/run%20%2F1%3F/application",
        init: { cache: "no-store", method: "GET" },
      },
      {
        input: "/api/pipeline/runs/run%20%2F1%3F/application",
        init: {
          body: JSON.stringify({ expectedApprovedPdfSha256: sha256 }),
          cache: "no-store",
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      },
      {
        input: "/api/pipeline/runs/run%20%2F1%3F/application/retry",
        init: {
          body: JSON.stringify({ expectedApprovedPdfSha256: sha256 }),
          cache: "no-store",
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      },
      {
        input: "/api/pipeline/runs/run%20%2F1%3F/application/commands",
        init: {
          body: JSON.stringify({
            type: "approve_origin",
            origin: "https://apply.example.test",
          }),
          cache: "no-store",
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      },
      {
        input: "/api/pipeline/runs/run%20%2F1%3F/application",
        init: { cache: "no-store", method: "DELETE" },
      },
    ]);
    expect(JSON.stringify(requests)).not.toContain("127.0.0.1:8765");
    expect(JSON.stringify(requests)).not.toContain("authorization");
    expect(JSON.stringify(requests)).not.toContain("JOBHUNTER_HARNESS_TOKEN");
  });

  test("rejects malformed application requests locally and strict private responses", async () => {
    let fetchCalls = 0;
    setFetchMock(async () => {
      fetchCalls += 1;
      return json(applicationSnapshot);
    });
    expect(() => startApplicationSession("run-1", sha256.toUpperCase())).toThrow(
      PipelineClientError,
    );
    expect(() => retryApplicationSession("run-1", "short")).toThrow(
      PipelineClientError,
    );
    expect(() => sendApplicationCommand(
      "run-1",
      { type: "continue", answer: "private" } as never,
    )).toThrow(PipelineClientError);
    expect(fetchCalls).toBe(0);

    setFetchMock(async () => json({
      ...applicationSnapshot,
      sessionId: "6984d92f-fef5-4a75-8fb5-bb8d6316bb14",
      jobUrl: "https://private.example.test/jobs/1",
      profilePath: "/home/user/applicant-profile.md",
    }));
    await expect(getApplicationSession("run-1")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "The pipeline returned an invalid response.",
    });

    setFetchMock(async () => json({
      ...applicationView,
      harnessOrigin: "http://127.0.0.1:8765",
      bearer: "private-token",
    }));
    await expect(getApplicationSession("run-1")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  test("requires exact application response statuses and empty command bodies", async () => {
    setFetchMock(async () => json(applicationSnapshot));
    await expect(startApplicationSession("run-1", sha256)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    setFetchMock(async () => new Response("saved answer", { status: 202 }));
    await expect(sendApplicationCommand("run-1", { type: "continue" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    setFetchMock(async () => new Response(null, { status: 200 }));
    await expect(closeApplicationSession("run-1")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  test("uses the fixed public harness-unavailable message without exposing server details", async () => {
    setFetchMock(async () => json({
      error: {
        code: "APPLICATION_HARNESS_UNAVAILABLE",
        message: "Bearer private-token at /home/user/harness",
      },
    }, { status: 503 }));

    await expect(getApplicationSession("run-1")).rejects.toMatchObject({
      code: "APPLICATION_HARNESS_UNAVAILABLE",
      status: 503,
      message: "The local application service is unavailable",
    });
  });
});

describe("pipeline artifacts", () => {
  test("prefixes only same-origin public pipeline artifact paths", () => {
    expect(artifactHref("/v1/runs/run%201/artifacts/artifact-1")).toBe(
      "/api/pipeline/runs/run%201/artifacts/artifact-1",
    );

    for (const href of [
      "https://attacker.invalid/v1/runs/a/artifacts/b",
      "//attacker.invalid/v1/runs/a/artifacts/b",
      "/v1/../secrets",
      "/v1/runs/a/artifacts/b?token=secret",
      "/api/pipeline/v1/runs/a/artifacts/b",
      "/v1/runs/a/other/b",
    ]) {
      expect(() => artifactHref(href)).toThrow("The artifact link is invalid.");
    }
  });

  test("reads and validates a JSON artifact through its prefixed href", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    capture(json({ title: "Staff Engineer", skills: ["TypeScript"] }), requests);

    await expect(readJsonArtifact(artifact())).resolves.toEqual({
      title: "Staff Engineer",
      skills: ["TypeScript"],
    });
    expect(requests).toEqual([
      {
        input: "/api/pipeline/runs/run%201/artifacts/artifact-1",
        init: { cache: "no-store", method: "GET" },
      },
    ]);
  });

  test("rejects non-JSON artifacts and hostile artifact DTO hrefs before fetching", async () => {
    let calls = 0;
    setFetchMock(async () => {
      calls += 1;
      return json({});
    });

    await expect(readJsonArtifact(artifact({ mediaType: "application/pdf" }))).rejects.toThrow(
      "The artifact is not JSON.",
    );
    await expect(readJsonArtifact(artifact({ href: "https://attacker.invalid/steal" }))).rejects.toThrow(
      "The artifact link is invalid.",
    );
    expect(calls).toBe(0);
  });

  test("rejects unreadable, invalid, incorrectly typed, and oversized JSON", async () => {
    const unreadable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("private transport failure"));
      },
    });
    setFetchMock(async () => new Response(unreadable, { headers: { "content-type": "application/json" } }));
    await expect(readJsonArtifact(artifact())).rejects.toThrow("The artifact could not be read.");

    setFetchMock(async () => new Response("{", { headers: { "content-type": "application/json" } }));
    await expect(readJsonArtifact(artifact())).rejects.toThrow("The artifact contains invalid JSON.");

    setFetchMock(async () => new Response("undefined", { headers: { "content-type": "application/json" } }));
    await expect(readJsonArtifact(artifact())).rejects.toThrow("The artifact contains invalid JSON.");

    setFetchMock(async () => new Response("{}", { headers: { "content-type": "text/plain" } }));
    await expect(readJsonArtifact(artifact())).rejects.toThrow("The artifact response is not JSON.");

    setFetchMock(async () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "1048577" } }));
    await expect(readJsonArtifact(artifact())).rejects.toThrow("The artifact is too large to read.");
  });
});
