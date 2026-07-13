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
  test("creates and lists runs then wakes the scheduler", async () => {
    const target = service();
    const created = await request(target, "/v1/runs", post({ jobDescription: "A sufficiently detailed job description that exceeds forty characters." }));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual(run);
    const listed = await request(target, "/v1/runs");
    expect(listed.status).toBe(200);
    expect((await listed.json()).runs).toEqual([run]);
    expect(target.kickCount()).toBe(2);
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

  test("rejects undersized descriptions and nonempty retry bodies", async () => {
    expect((await request(service(), "/v1/runs", post({ jobDescription: "short" }))).status).toBe(400);
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

  test("maps stale hashes to a public conflict and hides unexpected errors", async () => {
    const stale = await request(service({
      approveRun: async () => {
        throw Object.assign(new Error("PDF hash is stale"), { code: "STALE_PDF", status: 409 });
      },
    }), "/v1/runs/run-1/approve", post({ expectedPdfSha256: PDF_HASH, acknowledgeVisualIssues: false }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: { code: "STALE_PDF", message: "PDF hash is stale" } });

    const hidden = await request(service({ listRuns: () => { throw new Error("claim_token=secret"); } }), "/v1/runs");
    expect(hidden.status).toBe(500);
    expect(await hidden.text()).not.toContain("secret");
  });

  test("serves only addressed artifacts with no-store", async () => {
    const response = await request(service(), "/v1/runs/run-1/artifacts/artifact-1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("artifact");
  });
});
