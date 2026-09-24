import { describe, expect, test } from "bun:test";

import {
  createApplicationSubmissionRoutes,
  type ApplicationSubmissionRouteService,
} from "../src/api/application-submission-routes.ts";

const ORIGIN = "http://127.0.0.1:3457";
const TOKEN = "test-token-0123456789abcdef-0123456789";
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

function fakeService(calls: string[]): ApplicationSubmissionRouteService {
  return {
    markReviewReady(sessionId) { calls.push(`review:${sessionId}`); },
    claim(sessionId) { calls.push(`claim:${sessionId}`); },
    finalize(sessionId, outcome) { calls.push(`finalize:${sessionId}:${outcome}`); },
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

describe("application submission control HTTP boundary", () => {
  test("executes authenticated review, claim, and finalize transitions", async () => {
    const calls: string[] = [];
    const route = createApplicationSubmissionRoutes(fakeService(calls), TOKEN);
    const headers = { authorization: `Bearer ${TOKEN}` };
    const paths = [
      `/v1/internal/application-submissions/${SESSION_ID}/review-ready`,
      `/v1/internal/application-submissions/${SESSION_ID}/claim`,
    ];

    for (const path of paths) {
      const response = await route(request(path, { method: "POST", headers }), new URL(`${ORIGIN}${path}`));
      expect(response?.status).toBe(204);
      expect(response?.headers.get("cache-control")).toBe("no-store");
      expect(await response?.text()).toBe("");
    }
    const finalizePath = `/v1/internal/application-submissions/${SESSION_ID}/finalize`;
    const finalized = await route(request(finalizePath, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ outcome: "submitted" }),
    }), new URL(`${ORIGIN}${finalizePath}`));

    expect(finalized?.status).toBe(204);
    expect(calls).toEqual([
      `review:${SESSION_ID}`,
      `claim:${SESSION_ID}`,
      `finalize:${SESSION_ID}:submitted`,
    ]);
  });

  test("hides disabled routes and rejects every invalid bearer identically", async () => {
    const path = `/v1/internal/application-submissions/${SESSION_ID}/claim`;
    const hidden = await createApplicationSubmissionRoutes(fakeService([]), undefined)(
      request(path, { method: "POST" }),
      new URL(`${ORIGIN}${path}`),
    );
    expect(hidden?.status).toBe(404);

    const route = createApplicationSubmissionRoutes(fakeService([]), TOKEN);
    const bodies: string[] = [];
    for (const authorization of [undefined, "Basic ignored", `Bearer ${TOKEN.slice(0, -1)}x`]) {
      const headers = new Headers();
      if (authorization !== undefined) headers.set("authorization", authorization);
      const response = await route(request(path, { method: "POST", headers }), new URL(`${ORIGIN}${path}`));
      expect(response?.status).toBe(401);
      bodies.push(await response!.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });

  test("rejects malformed paths, bodies, queries, and outcomes before mutation", async () => {
    const calls: string[] = [];
    const route = createApplicationSubmissionRoutes(fakeService(calls), TOKEN);
    const authorization = `Bearer ${TOKEN}`;
    const invalidRequests = [
      request(`/v1/internal/application-submissions/not-a-uuid/claim`, { method: "POST", headers: { authorization } }),
      request(`/v1/internal/application-submissions/${SESSION_ID}/claim?retry=1`, { method: "POST", headers: { authorization } }),
      request(`/v1/internal/application-submissions/${SESSION_ID}/review-ready`, { method: "POST", headers: { authorization }, body: "unexpected" }),
      request(`/v1/internal/application-submissions/${SESSION_ID}/finalize`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: "{}" }),
      request(`/v1/internal/application-submissions/${SESSION_ID}/finalize`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ outcome: "submitted", extra: true }) }),
      request(`/v1/internal/application-submissions/${SESSION_ID}/finalize`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ outcome: "maybe" }) }),
    ];

    for (const invalid of invalidRequests) {
      const response = await route(invalid, new URL(invalid.url));
      expect(response?.status).toBe(422);
    }
    expect(calls).toEqual([]);
    expect(await route(request(`/v1/internal/application-submissions/${SESSION_ID}/claim`, { method: "GET" }), new URL(`${ORIGIN}/v1/internal/application-submissions/${SESSION_ID}/claim`))).toBeNull();
  });
});
