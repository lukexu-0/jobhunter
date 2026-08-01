import { describe, expect, test } from "bun:test";
import { createAuthRoutes, type AuthRouteService } from "../src/api/auth-routes";
import { createApiHandler } from "../src/api/handler";
import { AuthStatusResponseSchema, type AuthSession, type AuthStatusResponse, type OAuthProvider } from "../src/contracts";

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
    providers: [{ provider: "openai-codex", state: "disconnected" }],
  };
  return {
    getAuthStatus: () => status,
    startSession: async () => session,
    getSession: () => session,
    answerPrompt: async () => session,
    cancelSession: async () => ({ ...session, state: "cancelled" }),
    logout: async () => undefined,
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

describe("OAuth HTTP routes", () => {
  test("lists only redacted provider status", async () => {
    const response = await request(fakeService(), "/v1/auth");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      providers: [{ provider: "openai-codex", state: "disconnected" }],
    });
  });

  test("validates exactly one OpenAI Codex provider status", () => {
    const providers = [{ provider: "openai-codex", state: "disconnected" }];
    expect(AuthStatusResponseSchema.safeParse({ providers }).success).toBe(true);
    expect(AuthStatusResponseSchema.safeParse({
      providers: [...providers, { provider: "google-antigravity", state: "disconnected" }],
    }).success).toBe(false);
    expect(AuthStatusResponseSchema.safeParse({ providers: [] }).success).toBe(false);
  });

  test("starts the exact provider with an empty JSON object", async () => {
    let started: OAuthProvider | undefined;
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
