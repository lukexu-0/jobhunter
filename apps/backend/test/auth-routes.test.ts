import { describe, expect, test } from "bun:test";
import {
  createAuthRoutes,
  type ApplicationModelSelectionService,
  type AuthRouteService,
} from "../src/api/auth-routes";
import { createApiHandler } from "../src/api/handler";
import {
  AuthStatusResponseSchema,
  type ApplicationModelId,
  type AuthProvider,
  type AuthSession,
  type AuthStatusResponse,
} from "../src/contracts";

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
      { provider: "google-antigravity", state: "disconnected" },
      { provider: "gmail", state: "disconnected" },
    ],
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

function request(
  service: AuthRouteService,
  path: string,
  init?: RequestInit,
  modelSelection: ApplicationModelSelectionService = {
    getApplicationModel: () => ({ model: "gpt-5.6-sol" as const }),
    setApplicationModel: (model: ApplicationModelId) => ({ model }),
  },
): Promise<Response> {
  const handler = createApiHandler({
    webOrigin: ORIGIN,
    route: createAuthRoutes(service, modelSelection),
  });
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
      providers: [
        { provider: "openai-codex", state: "disconnected" },
        { provider: "google-antigravity", state: "disconnected" },
        { provider: "gmail", state: "disconnected" },
      ],
    });
  });

  test("reads and selects a connected application model", async () => {
    let selected: ApplicationModelId = "gpt-5.6-sol";
    const modelSelection = {
      getApplicationModel: () => ({ model: selected }),
      setApplicationModel: (model: ApplicationModelId) => ({ model: (selected = model) }),
    };
    const service = fakeService({
      getAuthStatus: () => ({
        providers: [
          { provider: "openai-codex", state: "disconnected" },
          { provider: "google-antigravity", state: "connected" },
          { provider: "gmail", state: "disconnected" },
        ],
      }),
    });

    const initial = await request(service, "/v1/auth/application-model", undefined, modelSelection);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ model: "gpt-5.6-sol" });

    const updated = await request(
      service,
      "/v1/auth/application-model",
      jsonMutation("PUT", '{"model":"gemini-3.8-flash"}'),
      modelSelection,
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ model: "gemini-3.8-flash" });
  });

  test("rejects selecting a model whose provider is disconnected", async () => {
    let writes = 0;
    const response = await request(
      fakeService(),
      "/v1/auth/application-model",
      jsonMutation("PUT", '{"model":"gemini-3.8-flash"}'),
      {
        getApplicationModel: () => ({ model: "gpt-5.6-sol" }),
        setApplicationModel: (model: ApplicationModelId) => {
          writes += 1;
          return { model };
        },
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "AUTH_PROVIDER_DISCONNECTED",
        message: "Connect Google Antigravity before selecting Gemini 3.8 Flash",
      },
    });
    expect(writes).toBe(0);
  });

  test("validates the exact ordered model and Gmail provider statuses", () => {
    const providers = [
      { provider: "openai-codex", state: "disconnected" },
      { provider: "google-antigravity", state: "disconnected" },
      { provider: "gmail", state: "connected", identity: { email: "g***@example.test" } },
    ];
    expect(AuthStatusResponseSchema.safeParse({ providers }).success).toBe(true);
    expect(AuthStatusResponseSchema.safeParse({
      providers: [...providers, { provider: "indeed", state: "disconnected" }],
    }).success).toBe(false);
    expect(AuthStatusResponseSchema.safeParse({ providers: [] }).success).toBe(false);
    expect(AuthStatusResponseSchema.safeParse({ providers: [providers[1], providers[0], providers[2]] }).success).toBe(false);
    expect(AuthStatusResponseSchema.safeParse({
      providers: [providers[0], { ...providers[1], projectId: "private-project" }, providers[2]],
    }).success).toBe(false);
  });

  test.each(["openai-codex", "google-antigravity", "gmail"] as const)("starts the exact %s provider with an empty JSON object", async (provider) => {
    let started: AuthProvider | undefined;
    const expected = { ...session, provider };
    const response = await request(
      fakeService({ startSession: async (requested) => ((started = requested), expected) }),
      `/v1/auth/${provider}/sessions`,
      jsonMutation("POST"),
    );
    expect(response.status).toBe(201);
    expect(started).toBe(provider);
    expect(await response.json()).toEqual(expected);
  });

  test("returns public not-found for the retired Indeed routes", async () => {
    const callback = await request(
      fakeService(),
      "/v1/auth/indeed/callback?code=private&state=private",
    );
    expect(callback.status).toBe(404);

    const sessionResponse = await request(
      fakeService(),
      "/v1/auth/indeed/sessions",
      jsonMutation("POST"),
    );
    expect(sessionResponse.status).toBe(404);
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
