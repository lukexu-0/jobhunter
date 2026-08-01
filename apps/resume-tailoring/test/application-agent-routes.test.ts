import { describe, expect, spyOn, test } from "bun:test";
import {
  APPLICATION_AGENT_PATH,
  createApplicationAgentRoutes,
  type ApplicationAgentRouteService,
} from "../src/api/application-agent-routes.ts";
import { createApiHandler } from "../src/api/handler.ts";
import { ApplicationAgentFailure } from "../src/agents/application-agent.ts";

const API_ORIGIN = "http://127.0.0.1:3457";
const TOKEN = "test-token-0123456789abcdef-0123456789";
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const INPUT = {
  sessionId: "123e4567-e89b-42d3-a456-426614174000",
  runtimeUrl: "http://127.0.0.1:8765",
  task: "Fill the application.",
  maxTurns: 40,
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
    ] as const) {
      expect(await route(request(path, { method }), new URL(`${API_ORIGIN}${path}`))).toBeNull();
    }
  });
  test("returns the same hidden-route 404 for GET and POST when no token is configured", async () => {
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
  test("enforces both declared and streamed 4 MiB request limits", async () => {
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
        "content-length": String(MAX_REQUEST_BYTES + 1),
      },
      body: "{}",
    }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));
    expect(declared?.status).toBe(413);
    expect(await declared?.json()).toEqual({
      error: { code: "REQUEST_TOO_LARGE", message: "The model request is too large" },
    });

    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_REQUEST_BYTES));
        controller.enqueue(new Uint8Array([1]));
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
    const reader = {
      read: () => {
        controller.abort(abortReason);
        return Promise.resolve({
          done: false as const,
          value: new Uint8Array(MAX_REQUEST_BYTES + 1),
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
      body: JSON.stringify(INPUT),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual(SUCCESS);
    expect(seenInput).toEqual(INPUT);
    expect(seenSignal?.aborted).toBe(false);
  });
  test("bounds only the streamed body read with the injectable body timeout", async () => {
    let cancelled = false;
    let invokes = 0;
    const timeoutController = new AbortController();
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    try {
      const stream = new ReadableStream<Uint8Array>({
        pull() {
          timeoutController.abort(new DOMException("Body timed out", "TimeoutError"));
        },
        cancel() {
          cancelled = true;
        },
      });
      const route = createApplicationAgentRoutes(fakeService({
        invoke: async () => {
          invokes += 1;
          return SUCCESS;
        },
      }), TOKEN, { bodyTimeoutMs: 5 });
      const response = await route(request(APPLICATION_AGENT_PATH, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: stream,
      }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));
      expect(response?.status).toBe(504);
      expect(await response?.json()).toEqual({
        error: { code: "MODEL_TIMEOUT", message: "The model request timed out" },
      });
      expect(cancelled).toBe(true);
      expect(invokes).toBe(0);
    } finally {
      timeoutSpy.mockRestore();
    }
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

  test("uses the per-input deadline without capping runs at the body-read timeout", async () => {
    const timeoutCalls: number[] = [];
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      timeoutCalls.push(milliseconds);
      return new AbortController().signal;
    });
    try {
      const longInput = { ...INPUT, deadlineMs: 400_001 };
      const route = createApplicationAgentRoutes(fakeService({
        invoke: async (_input, signal) => {
          expect(signal.aborted).toBe(false);
          return SUCCESS;
        },
      }), TOKEN, { bodyTimeoutMs: 5 });
      const response = await route(request(APPLICATION_AGENT_PATH, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(longInput),
      }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));
      expect(response?.status).toBe(200);
      expect(timeoutCalls).toEqual([5, 400_001]);
    } finally {
      timeoutSpy.mockRestore();
    }

    let seenSignal: AbortSignal | undefined;
    const bodyController = new AbortController();
    const deadlineController = new AbortController();
    let timeoutIndex = 0;
    const deadlineTimeoutCalls: number[] = [];
    const deadlineSpy = spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      deadlineTimeoutCalls.push(milliseconds);
      return timeoutIndex++ === 0 ? bodyController.signal : deadlineController.signal;
    });
    try {
      const deadlineRoute = createApplicationAgentRoutes(fakeService({
        invoke: async (_input, signal) => {
          seenSignal = signal;
          const privateError = new Error("private provider timeout body");
          deadlineController.abort(privateError);
          throw privateError;
        },
      }), TOKEN);
      const timedOut = await deadlineRoute(request(APPLICATION_AGENT_PATH, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ...INPUT, deadlineMs: 1_000 }),
      }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));
      expect(seenSignal?.aborted).toBe(true);
      expect(deadlineTimeoutCalls).toEqual([300_000, 1_000]);
      expect(timedOut?.status).toBe(504);
      expect(await timedOut?.json()).toEqual({
        error: { code: "MODEL_TIMEOUT", message: "The model request timed out" },
      });
    } finally {
      deadlineSpy.mockRestore();
    }
  });
  test("returns MODEL_TIMEOUT when invocation ignores the expired deadline signal", async () => {
    const bodyController = new AbortController();
    const deadlineController = new AbortController();
    const invocation = Promise.withResolvers<typeof SUCCESS>();
    const invocationStarted = Promise.withResolvers<void>();
    let seenSignal: AbortSignal | undefined;
    let timeoutIndex = 0;
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(() => (
      timeoutIndex++ === 0 ? bodyController.signal : deadlineController.signal
    ));
    let responsePromise: Promise<Response | null> | undefined;
    try {
      const route = createApplicationAgentRoutes(fakeService({
        invoke: (_input, signal) => {
          seenSignal = signal;
          invocationStarted.resolve();
          return invocation.promise;
        },
      }), TOKEN);
      responsePromise = route(request(APPLICATION_AGENT_PATH, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ...INPUT, deadlineMs: 1_000 }),
      }), new URL(`${API_ORIGIN}${APPLICATION_AGENT_PATH}`));
      await invocationStarted.promise;

      deadlineController.abort(new DOMException("Deadline expired", "TimeoutError"));
      expect(seenSignal?.aborted).toBe(true);
      const settledPromptly = (async (): Promise<never> => {
        for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
        throw new Error("application-agent POST did not settle after its deadline");
      })();
      const response = await Promise.race([responsePromise, settledPromptly]);

      expect(response?.status).toBe(504);
      expect(await response?.json()).toEqual({
        error: { code: "MODEL_TIMEOUT", message: "The model request timed out" },
      });
    } finally {
      invocation.resolve(SUCCESS);
      await responsePromise?.catch(() => undefined);
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
      ["OAUTH_REQUIRED", 409, "Connect OpenAI Codex in Provider access"],
      ["MODEL_TIMEOUT", 504, "The model request timed out"],
      ["INVALID_MODEL_OUTPUT", 502, "The model returned invalid output"],
      ["MODEL_PROVIDER_FAILED", 502, "The model request failed"],
      ["APPLICATION_MISMATCH", 409, "The open page does not match the requested job"],
      ["STEP_LIMIT", 409, "The application step limit was reached"],
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
      error: { code: "OAUTH_REQUIRED", message: "Connect OpenAI Codex in Provider access" },
    });
  });
});
