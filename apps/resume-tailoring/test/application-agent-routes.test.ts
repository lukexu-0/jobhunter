import { describe, expect, spyOn, test } from "bun:test";
import {
  APPLICATION_AGENT_PATH,
  MAX_APPLICATION_AGENT_REQUEST_BYTES,
  createApplicationAgentRoutes,
  type ApplicationAgentRouteService,
} from "../src/api/application-agent-routes.ts";
import { createApiHandler } from "../src/api/handler.ts";
import { ApplicationAgentFailure } from "../src/agents/application-agent.ts";
import { ApplicationAgentSteeringConflict } from "../src/agents/application-agent-steering.ts";

const API_ORIGIN = "http://127.0.0.1:3457";
const TOKEN = "test-token-0123456789abcdef-0123456789";
const INPUT = {
  opportunityKind: "job" as const,
  sessionId: "123e4567-e89b-42d3-a456-426614174000",
  runtimeUrl: "http://127.0.0.1:8765",
  task: "Fill the application.",
  deadlineMs: 60_000,
  autoSubmit: false,
};
const RESULT = {
  status: "submitted" as const,
  company: "Example Co",
  role: "Engineer",
  job_url: "https://jobs.example.test/role",
  final_url: "https://apply.example.test/confirmation",
  fields_filled: [],
  fields_needing_human: [],
  files_attached: ["resume.pdf"],
  warnings: [],
  revision_count: 0,
  submit_attempted: true as const,
  submission_confirmation: {
    type: "post_submit_confirmation" as const,
    text: "Application received",
  },
};
const SUCCESS = {
  modelProvider: "openai-codex" as const,
  model: "gpt-5.6-sol" as const,
  reasoning: "high" as const,
  result: RESULT,
};

function fakeService(overrides: Partial<ApplicationAgentRouteService> = {}): ApplicationAgentRouteService {
  return {
    status: () => ({
      modelProvider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning: "high",
      oauth: "connected",
    }),
    invoke: async () => {
      throw new Error("unexpected invoke");
    },
    steer: async () => {
      throw new Error("unexpected steer");
    },
    ...overrides,
  };
}

function request(path = APPLICATION_AGENT_PATH, init: RequestInit = {}): Request {
  return new Request(`${API_ORIGIN}${path}`, init);
}

describe("application agent HTTP boundary", () => {
  test("falls through for every non-exact path and unsupported method", async () => {
    const route = createApplicationAgentRoutes(fakeService(), TOKEN);
    for (const [path, method] of [
      [APPLICATION_AGENT_PATH, "PUT"],
      [APPLICATION_AGENT_PATH, "PATCH"],
      [APPLICATION_AGENT_PATH, "DELETE"],
      [APPLICATION_AGENT_PATH, "HEAD"],
      [APPLICATION_AGENT_PATH, "OPTIONS"],
      [`${APPLICATION_AGENT_PATH}/`, "GET"],
      ["/v1/internal/application-agent-extra", "POST"],
      ["/v1/internal/Application-agent", "GET"],
      [`${APPLICATION_AGENT_PATH}/${INPUT.sessionId}/steer`, "GET"],
      [`${APPLICATION_AGENT_PATH}/${INPUT.sessionId}/steer/`, "POST"],
      [`${APPLICATION_AGENT_PATH}//steer`, "POST"],
    ] as const) {
      expect(await route(request(path, { method }), new URL(`${API_ORIGIN}${path}`))).toBeNull();
    }
  });
  test("returns the same hidden-route 404 for every route when no token is configured", async () => {
    for (const token of [undefined, ""]) {
      const route = createApplicationAgentRoutes(fakeService(), token);
      for (const method of ["GET", "POST"]) {
        const init: RequestInit = method === "POST"
          ? { method, headers: { "content-type": "text/plain" }, body: "not-json" }
          : { method };
        const response = await route(request(APPLICATION_AGENT_PATH, init), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));
        expect(response?.status).toBe(404);
        expect(await response?.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found" } });
      }
      const steerPath = `${APPLICATION_AGENT_PATH}/${INPUT.sessionId}/steer`;
      const steerResponse = await route(request(steerPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "private guidance" }),
      }), new URL(`${API_ORIGIN}${steerPath}`));
      expect(steerResponse?.status).toBe(404);
      expect(await steerResponse?.json()).toEqual({
        error: { code: "NOT_FOUND", message: "Route not found" },
      });
    }
  });
  test("uses constant-time exact bearer comparison with an undifferentiated 401", async () => {
    const route = createApplicationAgentRoutes(fakeService(), TOKEN);
    const rejectedBodies: unknown[] = [];
    for (const authorization of [
      undefined,
      "Basic ignored",
      "Bearer",
      `bearer ${TOKEN}`,
      `Bearer  ${TOKEN}`,
      `Bearer ${TOKEN.slice(0, -1)}x`,
      `Bearer ${"é".repeat(80)}`,
    ]) {
      const headers = new Headers();
      if (authorization !== undefined) headers.set("authorization", authorization);
      const response = await route(request(APPLICATION_AGENT_PATH, { headers }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));
      expect(response?.status).toBe(401);
      rejectedBodies.push(await response?.json());
    }
    expect(new Set(rejectedBodies.map((body) => JSON.stringify(body)))).toEqual(new Set([
      JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }),
    ]));
  });
  test("returns the exact authenticated GET status with no-store", async () => {
    const route = createApplicationAgentRoutes(fakeService(), TOKEN);
    const response = await route(request(APPLICATION_AGENT_PATH, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response?.json()).toEqual({
      modelProvider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning: "high",
      oauth: "connected",
    });
  });

  test("queues an authenticated strict steer request with an empty no-store 202", async () => {
    const steerPath = `${APPLICATION_AGENT_PATH}/${INPUT.sessionId}/steer`;
    const calls: unknown[][] = [];
    const route = createApplicationAgentRoutes(fakeService({
      steer: async (...args) => {
        calls.push(args);
      },
    }), TOKEN);
    const steerRequest = request(steerPath, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ message: "\u001c  Prefer the platform example. \u0085" }),
    });

    const response = await route(steerRequest, new URL(`${API_ORIGIN}${steerPath}`));

    expect(response?.status).toBe(202);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.text()).toBe("");
    expect(calls).toEqual([[
      INPUT.sessionId,
      { message: "Prefer the platform example." },
      steerRequest.signal,
    ]]);
  });

  test("rejects unauthenticated or invalid steer requests before the service", async () => {
    const steerPath = `${APPLICATION_AGENT_PATH}/${INPUT.sessionId}/steer`;
    let calls = 0;
    const route = createApplicationAgentRoutes(fakeService({
      steer: async () => {
        calls += 1;
      },
    }), TOKEN);
    const unauthorized = await route(request(steerPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "private guidance" }),
    }), new URL(`${API_ORIGIN}${steerPath}`));
    expect(unauthorized?.status).toBe(401);

    for (const body of [
      {},
      { message: " " },
      { message: "x".repeat(8_001) },
      { message: "before\u0000after" },
      { message: "\ud800" },
      { message: "valid", extra: true },
    ]) {
      const response = await route(request(steerPath, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }), new URL(`${API_ORIGIN}${steerPath}`));
      expect(response?.status).toBe(422);
      expect(await response?.json()).toEqual({
        error: { code: "INVALID_REQUEST", message: "Request is invalid" },
      });
    }
    const invalidSessionPath = `${APPLICATION_AGENT_PATH}/not-a-session/steer`;
    const invalidSession = await route(request(invalidSessionPath, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "private guidance" }),
    }), new URL(`${API_ORIGIN}${invalidSessionPath}`));
    expect(invalidSession?.status).toBe(422);
    expect(calls).toBe(0);
  });

  test("maps every unavailable steering inbox to one fixed conflict without text", async () => {
    const privateMessage = "PRIVATE OPERATOR GUIDANCE";
    const steerPath = `${APPLICATION_AGENT_PATH}/${INPUT.sessionId}/steer`;
    const route = createApplicationAgentRoutes(fakeService({
      steer: async () => {
        throw new ApplicationAgentSteeringConflict();
      },
    }), TOKEN);

    const response = await route(request(steerPath, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: privateMessage }),
    }), new URL(`${API_ORIGIN}${steerPath}`));

    expect(response?.status).toBe(409);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    const responseText = await response?.text();
    expect(responseText).toBe(JSON.stringify({
      error: {
        code: "APPLICATION_COMMAND_CONFLICT",
        message: "The application state changed; review the latest session state",
      },
    }));
    expect(responseText).not.toContain(privateMessage);
  });
  test("passes the request signal into authenticated GET status reads", async () => {
    const controller = new AbortController();
    const abortReason = new Error("caller stopped pending status read");
    let seenSignal: AbortSignal | undefined;
    const route = createApplicationAgentRoutes(fakeService({
      status: async (signal?: AbortSignal) => {
        seenSignal = signal;
        controller.abort(abortReason);
        signal?.throwIfAborted();
        return {
          modelProvider: "openai-codex",
          model: "gpt-5.6-sol",
          reasoning: "high",
          oauth: "connected",
        };
      },
    }), TOKEN);

    const response = route(request(APPLICATION_AGENT_PATH, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));

    await expect(response).rejects.toBe(abortReason);
    expect(seenSignal).toBe(controller.signal);
  });

  test("requires application/json before reading or invoking POST requests", async () => {
    let invokes = 0;
    const route = createApplicationAgentRoutes(fakeService({
      invoke: async () => {
        invokes += 1;
        throw new Error("unexpected invoke");
      },
    }), TOKEN);
    for (const contentType of [undefined, "text/plain", "application/problem+json"]) {
      const headers = new Headers({ authorization: `Bearer ${TOKEN}` });
      if (contentType !== undefined) headers.set("content-type", contentType);
      const response = await route(request(APPLICATION_AGENT_PATH, {
        method: "POST",
        headers,
        body: "{}",
      }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));
      expect(response?.status).toBe(415);
      expect(await response?.json()).toEqual({
        error: { code: "JSON_REQUIRED", message: "Model requests must use application/json" },
      });
    }
    expect(invokes).toBe(0);
  });
  test("enforces both declared and streamed 20 MiB request limits", async () => {
    let invokes = 0;
    const route = createApplicationAgentRoutes(fakeService({
      invoke: async () => {
        invokes += 1;
        throw new Error("unexpected invoke");
      },
    }), TOKEN);
    const declared = await route(request(APPLICATION_AGENT_PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "content-length": String(MAX_APPLICATION_AGENT_REQUEST_BYTES + 1),
      },
      body: "{}",
    }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));
    expect(declared?.status).toBe(413);
    expect(await declared?.json()).toEqual({
      error: { code: "REQUEST_TOO_LARGE", message: "The model request is too large" },
    });

    let cancelled = false;
    const chunk = new Uint8Array(1_048_576);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (
          let bytes = 0;
          bytes < MAX_APPLICATION_AGENT_REQUEST_BYTES;
          bytes += chunk.byteLength
        ) {
          controller.enqueue(chunk);
        }
        controller.enqueue(Uint8Array.of(1));
      },
      cancel() {
        cancelled = true;
        throw new Error("private stream cancellation failure");
      },
    });
    const streamed = await route(request(APPLICATION_AGENT_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: stream,
    }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));
    expect(streamed?.status).toBe(413);
    expect(await streamed?.json()).toEqual({
      error: { code: "REQUEST_TOO_LARGE", message: "The model request is too large" },
    });
    expect(cancelled).toBe(true);
    expect(invokes).toBe(0);
  });
  test("gives request cancellation precedence over a concurrent streamed size failure", async () => {
    const controller = new AbortController();
    const abortReason = new Error("caller stopped oversized body");
    const oversizedChunk = Uint8Array.of(1);
    Object.defineProperty(oversizedChunk, "byteLength", {
      value: MAX_APPLICATION_AGENT_REQUEST_BYTES + 1,
    });
    const reader = {
      read: () => {
        controller.abort(abortReason);
        return Promise.resolve({
          done: false as const,
          value: oversizedChunk,
        });
      },
      cancel: () => Promise.resolve(),
      releaseLock: () => undefined,
    };
    const body = {
      getReader: () => reader,
    } as unknown as ReadableStream<Uint8Array>;
    const abortedRequest = {
      method: "POST",
      headers: new Headers({
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      }),
      body,
      signal: controller.signal,
    } as Request;
    const route = createApplicationAgentRoutes(fakeService(), TOKEN);

    const response = route(
      abortedRequest,
      new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`),
    );

    await expect(response).rejects.toBe(abortReason);
  });

  test("returns fixed 422 for fatal UTF-8, malformed JSON, and strict input violations", async () => {
    let invokes = 0;
    const route = createApplicationAgentRoutes(fakeService({
      invoke: async () => {
        invokes += 1;
        throw new Error("unexpected invoke");
      },
    }), TOKEN);
    const bodies: BodyInit[] = [
      new Uint8Array([0xc3, 0x28]),
      "{",
      "{\"private\":\"private-invalid-request-body\"",
      JSON.stringify({ ...INPUT, extra: true }),
      JSON.stringify({ ...INPUT, maxTurns: 40 }),
      JSON.stringify({ ...INPUT, runtimeUrl: "https://example.com" }),
      JSON.stringify({ ...INPUT, deadlineMs: 999 }),
    ];
    for (const body of bodies) {
      const response = await route(request(APPLICATION_AGENT_PATH, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body,
      }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));
      expect(response?.status).toBe(422);
      expect(await response?.json()).toEqual({
        error: { code: "INVALID_REQUEST", message: "Request is invalid" },
      });
    }
    expect(invokes).toBe(0);
  });
  test("dispatches the exact POST before Origin policy and returns the exact success", async () => {
    let seenInput: unknown;
    let seenSignal: AbortSignal | undefined;
    const unlimitedInput = { ...INPUT, deadlineMs: null };
    const handler = createApiHandler({
      webOrigin: "http://127.0.0.1:3456",
      internalRoute: createApplicationAgentRoutes(fakeService({
        invoke: async (input, signal) => {
          seenInput = input;
          seenSignal = signal;
          return SUCCESS;
        },
      }), TOKEN),
    });
    const response = await handler(request(APPLICATION_AGENT_PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json; charset=utf-8",
        origin: "https://attacker.invalid",
      },
      body: JSON.stringify(unlimitedInput),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual(SUCCESS);
    expect(seenInput).toEqual(unlimitedInput);
    expect(seenSignal?.aborted).toBe(false);
  });
  test("settles on request abort when a streamed read and cancellation both stall", async () => {
    const controller = new AbortController();
    const abortReason = new Error("caller stopped stalled body read");
    const {
      promise: readStarted,
      resolve: markReadStarted,
    } = Promise.withResolvers<void>();
    const { promise: pendingRead } = Promise.withResolvers<never>();
    const { promise: pendingCancel } = Promise.withResolvers<never>();
    let cancelCalled = false;
    const reader = {
      read: () => {
        markReadStarted();
        return pendingRead;
      },
      cancel: () => {
        cancelCalled = true;
        return pendingCancel;
      },
      releaseLock: () => undefined,
    };
    const body = {
      getReader: () => reader,
    } as unknown as ReadableStream<Uint8Array>;
    const stalledRequest = {
      method: "POST",
      headers: new Headers({
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      }),
      body,
      signal: controller.signal,
    } as Request;
    const route = createApplicationAgentRoutes(fakeService(), TOKEN);

    const response = route(
      stalledRequest,
      new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`),
    );
    await readStarted;
    controller.abort(abortReason);

    await expect(response).rejects.toBe(abortReason);
    expect(cancelCalled).toBe(true);
  });

  test("uses only the request cancellation signal for body reading and invocation", async () => {
    const controller = new AbortController();
    const timeoutSpy = spyOn(AbortSignal, "timeout");
    let seenSignal: AbortSignal | undefined;
    try {
      const route = createApplicationAgentRoutes(fakeService({
        invoke: async (_input, signal) => {
          seenSignal = signal;
          return SUCCESS;
        },
      }), TOKEN);
      const response = await route(request(APPLICATION_AGENT_PATH, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ...INPUT, deadlineMs: 400_001 }),
        signal: controller.signal,
      }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));

      expect(response?.status).toBe(200);
      expect(seenSignal).toBe(controller.signal);
      expect(timeoutSpy).not.toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
    }
  });
  test("propagates the request abort reason by identity", async () => {
    const controller = new AbortController();
    const abortReason = new Error("caller cancellation identity");
    const route = createApplicationAgentRoutes(fakeService({
      invoke: async (_input, signal) => {
        expect(signal.aborted).toBe(false);
        controller.abort(abortReason);
        return SUCCESS;
      },
    }), TOKEN);
    const responsePromise = route(request(APPLICATION_AGENT_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(INPUT),
      signal: controller.signal,
    }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));
    await expect(responsePromise).rejects.toBe(abortReason);
  });
  test("maps every typed service failure and untyped provider failure to fixed sanitized errors", async () => {
    const privateProviderBody = [
      "private-provider-body",
      INPUT.runtimeUrl,
      INPUT.task,
    ].join(":");
    const cases = [
      ["INVALID_REQUEST", 422, "Request is invalid"],
      ["OAUTH_REQUIRED", 409, "Connect OpenAI Codex in Credentials"],
      ["INVALID_MODEL_OUTPUT", 502, "The model returned invalid output"],
      ["MODEL_PROVIDER_FAILED", 502, "The model request failed"],
      ["APPLICATION_MISMATCH", 409, "The open page does not match the requested job"],
      ["BROWSER_FAILED", 502, "The browser session failed"],
    ] as const;
    for (const [code, status, message] of cases) {
      const failure = Object.assign(new ApplicationAgentFailure(code), {
        privateProviderBody,
      });
      const route = createApplicationAgentRoutes(fakeService({
        invoke: async () => {
          throw failure;
        },
      }), TOKEN);
      const response = await route(request(APPLICATION_AGENT_PATH, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(INPUT),
      }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));
      expect(response?.status).toBe(status);
      const serialized = await response?.text() ?? "";
      expect(JSON.parse(serialized)).toEqual({ error: { code, message } });
      expect(serialized).not.toContain(privateProviderBody);
      expect(serialized).not.toContain(INPUT.runtimeUrl);
      expect(serialized).not.toContain(INPUT.task);
    }

    const untypedRoute = createApplicationAgentRoutes(fakeService({
      invoke: async () => {
        throw new Error(privateProviderBody);
      },
    }), TOKEN);
    const untyped = await untypedRoute(request(APPLICATION_AGENT_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(INPUT),
    }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));
    expect(untyped?.status).toBe(502);
    const untypedBody = await untyped?.text() ?? "";
    expect(JSON.parse(untypedBody)).toEqual({
      error: { code: "MODEL_PROVIDER_FAILED", message: "The model request failed" },
    });
    expect(untypedBody).not.toContain(privateProviderBody);

    const statusRoute = createApplicationAgentRoutes(fakeService({
      status: () => {
        throw new ApplicationAgentFailure("OAUTH_REQUIRED");
      },
    }), TOKEN);
    const statusResponse = await statusRoute(request(APPLICATION_AGENT_PATH, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));
    expect(statusResponse?.status).toBe(409);
    expect(await statusResponse?.json()).toEqual({
      error: { code: "OAUTH_REQUIRED", message: "Connect OpenAI Codex in Credentials" },
    });
  });
});
