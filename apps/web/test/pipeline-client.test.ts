import { afterEach, describe, expect, test } from "bun:test";
import { type ArtifactDto, type RunDto, type RunStatus } from "@jobhunter/pipeline/contracts";
import {
  PipelineClientError,
  approveRun,
  artifactHref,
  createRun,
  editRun,
  getRun,
  listRuns,
  readJsonArtifact,
  regenerateRun,
  retryRun,
  updateApplicationStatus,
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
