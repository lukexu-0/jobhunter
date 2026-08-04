import { describe, expect, test } from "bun:test";
import { createAuthRoutes, type AuthRouteService } from "../src/api/auth-routes";
import { createApiHandler } from "../src/api/handler";
import { AuthStatusResponseSchema, type AuthProvider, type AuthSession, type AuthStatusResponse } from "../src/contracts";

const ORIGIN = "http://127.0.0.1:3456";
const session: AuthSession = {
  id: "session-1",
  provider: "openai-codex",
  state: "pending",
  progress: [],
  expiresAt: 1_000,
};

function fakeService(overrides: Partial<AuthRouteService> = {}): AuthRouteService {
  const status: AuthStatusResponse = {
    providers: [
      { provider: "openai-codex", state: "disconnected" },
      { provider: "indeed", state: "disconnected" },
    ],
  };
  return {
    getAuthStatus: () => status,
    startSession: async () => session,
    getSession: () => session,
    answerPrompt: async () => session,
    cancelSession: async () => ({ ...session, state: "cancelled" }),
    logout: async () => undefined,
    completeIndeedCallback: async () => undefined,
    ...overrides,
  };
}

function request(service: AuthRouteService, path: string, init?: RequestInit): Promise<Response> {
  const handler = createApiHandler({ webOrigin: ORIGIN, route: createAuthRoutes(service) });
  return handler(new Request(`http://127.0.0.1:3457${path}`, init));
}

const jsonMutation = (method: string, body = "{}"): RequestInit => ({
  method,
  headers: { origin: ORIGIN, "content-type": "application/json" },
  body,
});

function expectCallbackSecurityHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("OAuth HTTP routes", () => {
  test("lists only redacted provider status", async () => {
    const response = await request(fakeService(), "/v1/auth");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      providers: [
        { provider: "openai-codex", state: "disconnected" },
        { provider: "indeed", state: "disconnected" },
      ],
    });
  });

  test("validates exactly the Codex and Indeed provider statuses", () => {
    const providers = [
      { provider: "openai-codex", state: "disconnected" },
      { provider: "indeed", state: "disconnected" },
    ];
    expect(AuthStatusResponseSchema.safeParse({ providers }).success).toBe(true);
    expect(AuthStatusResponseSchema.safeParse({
      providers: [...providers, { provider: "google-antigravity", state: "disconnected" }],
    }).success).toBe(false);
    expect(AuthStatusResponseSchema.safeParse({ providers: providers.slice(0, 1) }).success).toBe(false);
    expect(AuthStatusResponseSchema.safeParse({ providers: [...providers].reverse() }).success).toBe(false);
  });

  test("starts the exact provider with an empty JSON object", async () => {
    let started: AuthProvider | undefined;
    const response = await request(
      fakeService({ startSession: async (provider) => ((started = provider), session) }),
      "/v1/auth/openai-codex/sessions",
      jsonMutation("POST"),
    );
    expect(response.status).toBe(201);
    expect(started).toBe("openai-codex");
    expect(await response.json()).toEqual(session);
  });
  test("returns public not-found for the retired Google provider route without starting a session", async () => {
    let started = false;
    const response = await request(
      fakeService({
        startSession: async () => {
          started = true;
          return session;
        },
      }),
      "/v1/auth/google-antigravity/sessions",
      jsonMutation("POST"),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found" } });
    expect(started).toBe(false);
  });


  test("rejects nonempty start bodies and unknown providers", async () => {
    const invalid = await request(
      fakeService(),
      "/v1/auth/openai-codex/sessions",
      jsonMutation("POST", '{"apiKey":"secret"}'),
    );
    expect(invalid.status).toBe(400);
    const unknown = await request(fakeService(), "/v1/auth/openai/sessions", jsonMutation("POST"));
    expect(unknown.status).toBe(404);
  });

  test("completes the Indeed callback with an empty no-store response and never reflects query values", async () => {
    const code = "callback-code-private";
    const state = "callback-state-private";
    let receivedExactValues = false;
    const response = await request(
      fakeService({
        completeIndeedCallback: async (input) => {
          receivedExactValues = input.code === code
            && input.state === state
            && input.issuer === "https://secure.indeed.com";
        },
      }),
      `/v1/auth/indeed/callback?code=${code}&state=${state}&iss=${encodeURIComponent("https://secure.indeed.com")}`,
    );
    expect(response.status).toBe(204);
    expectCallbackSecurityHeaders(response);
    expect(await response.text()).toBe("");
    expect(receivedExactValues).toBe(true);
  });

  test("accepts and safely rejects a bounded Indeed OAuth denial callback", async () => {
    const state = "denial-state-private";
    const description = "denial-description-private";
    const errorUri = "https://secure.indeed.com/oauth/errors/private";
    let receivedExactValues = false;
    const response = await request(
      fakeService({
        completeIndeedCallback: async (input) => {
          receivedExactValues = input.state === state
            && input.issuer === "https://secure.indeed.com"
            && input.error === "access_denied"
            && input.errorDescription === description
            && input.errorUri === errorUri;
          throw Object.assign(new Error(description), {
            code: "AUTH_CALLBACK_INVALID",
            status: 400,
          });
        },
      }),
      `/v1/auth/indeed/callback?error=access_denied&error_description=${description}&error_uri=${encodeURIComponent(errorUri)}&state=${state}&iss=${encodeURIComponent("https://secure.indeed.com")}`,
    );
    expect(response.status).toBe(400);
    expectCallbackSecurityHeaders(response);
    const body = await response.text();
    expect(body).toBe(JSON.stringify({
      error: {
        code: "AUTH_CALLBACK_INVALID",
        message: "Indeed authentication callback is invalid",
      },
    }));
    expect(body).not.toContain(description);
    expect(body).not.toContain(errorUri);
    expect(body).not.toContain(state);
    expect(receivedExactValues).toBe(true);
  });

  test("forwards omitted and wrong callback issuers so the matching state can be consumed", async () => {
    let sawOmittedIssuer = false;
    let sawWrongIssuer = false;
    const service = fakeService({
      completeIndeedCallback: async (input) => {
        sawOmittedIssuer ||= input.issuer === undefined;
        sawWrongIssuer ||= input.issuer === "https://issuer.invalid";
        throw Object.assign(new Error("fixed"), {
          code: "AUTH_CALLBACK_INVALID",
          status: 400,
        });
      },
    });
    for (const path of [
      "/v1/auth/indeed/callback?code=private-code&state=private-state",
      `/v1/auth/indeed/callback?code=private-code&state=private-state&iss=${encodeURIComponent("https://issuer.invalid")}`,
    ]) {
      const response = await request(service, path);
      expect(response.status).toBe(400);
      expectCallbackSecurityHeaders(response);
      expect(await response.text()).not.toContain("private-state");
    }
    expect(sawOmittedIssuer).toBe(true);
    expect(sawWrongIssuer).toBe(true);
  });

  test("rejects malformed callback queries without invoking the service or reflecting them", async () => {
    let called = false;
    const secret = "callback-secret-must-not-echo";
    const service = fakeService({
      completeIndeedCallback: async () => { called = true; },
    });
    const response = await request(
      service,
      `/v1/auth/indeed/callback?code=${secret}&state=one&state=two`,
    );
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).not.toContain(secret);
    expect(body).not.toContain("one");
    expect(body).not.toContain("two");
    expectCallbackSecurityHeaders(response);

    const malformedDenials = [
      "/v1/auth/indeed/callback?error=access_denied&error=server_error&state=private-state",
      "/v1/auth/indeed/callback?error=access_denied&state=private-state&unexpected=value",
      `/v1/auth/indeed/callback?error=access_denied&error_description=${"x".repeat(1_025)}&state=private-state`,
      "/v1/auth/indeed/callback?code=private-code&error=access_denied&state=private-state",
      `/v1/auth/indeed/callback?${Array.from({ length: 7 }, () => "state=private-state").join("&")}`,
      `/v1/auth/indeed/callback?state=${"x".repeat(12_801)}`,
    ];
    for (const path of malformedDenials) {
      const malformed = await request(service, path);
      expect(malformed.status).toBe(400);
      expectCallbackSecurityHeaders(malformed);
      expect(await malformed.text()).not.toContain("private-state");
    }
    expect(called).toBe(false);
  });
  test("bounds callback service failures without reflecting provider or query details", async () => {
    const secret = "callback-provider-secret";
    const response = await request(
      fakeService({
        completeIndeedCallback: async () => {
          throw Object.assign(new Error(secret), {
            code: "AUTH_CALLBACK_INVALID",
            status: 400,
          });
        },
      }),
      `/v1/auth/indeed/callback?code=private-code&state=private-state&iss=${encodeURIComponent("https://secure.indeed.com")}`,
    );
    expect(response.status).toBe(400);
    expectCallbackSecurityHeaders(response);
    const body = await response.text();
    expect(body).toBe(JSON.stringify({
      error: {
        code: "AUTH_CALLBACK_INVALID",
        message: "Indeed authentication callback is invalid",
      },
    }));
    expect(body).not.toContain(secret);
    expect(body).not.toContain("private-code");
    expect(body).not.toContain("private-state");
  });


  test("answers and cancels a session without exposing service exceptions", async () => {
    let answer: string | undefined;
    const service = fakeService({
      answerPrompt: async (_id, value) => ((answer = value), session),
    });
    const prompt = await request(
      service,
      "/v1/auth/sessions/session-1/prompt",
      jsonMutation("POST", '{"value":"oauth-code"}'),
    );
    expect(prompt.status).toBe(200);
    expect(answer).toBe("oauth-code");

    const cancelled = await request(service, "/v1/auth/sessions/session-1", {
      method: "DELETE",
      headers: { origin: ORIGIN },
    });
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).state).toBe("cancelled");
  });

  test("maps expected conflicts and redacts unexpected errors", async () => {
    const conflict = await request(
      fakeService({
        startSession: async () => {
          throw Object.assign(new Error("Already connected"), { code: "AUTH_ALREADY_CONNECTED", status: 409 });
        },
      }),
      "/v1/auth/openai-codex/sessions",
      jsonMutation("POST"),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: "AUTH_ALREADY_CONNECTED", message: "Already connected" } });

    const failure = await request(
      fakeService({ getAuthStatus: () => { throw new Error("token=should-never-leak"); } }),
      "/v1/auth",
    );
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain("should-never-leak");
  });
});
