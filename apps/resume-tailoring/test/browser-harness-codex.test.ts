import { describe, expect, test } from "bun:test";
import type { ModelRequest, ModelResponse } from "@openai/agents-core";
import type { JsonObjectSchema } from "@openai/agents-core/types";
import {
  BROWSER_HARNESS_CODEX_PATH,
  createBrowserHarnessCodexRoutes,
  type BrowserHarnessCodexRouteService,
} from "../src/api/browser-harness-codex-routes";
import { createApiHandler } from "../src/api/handler";
import { createPipelineApplication } from "../src/bootstrap";
import {
  BrowserHarnessCodexService,
  type BrowserHarnessCodexCompletion,
  type BrowserHarnessCodexInput,
} from "../src/models/browser-harness-codex";

const WEB_ORIGIN = "http://127.0.0.1:3456";
const API_ORIGIN = "http://127.0.0.1:3457";
const TOKEN = "test-token-0123456789abcdef-0123456789";
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const SYSTEM_PROMPT = "private-system-prompt";
const TRANSCRIPT = "private-transcript";
const REASONING_SECRET = "private-reasoning-summary";
const OAUTH_SECRET = "private-oauth-token";
const PROVIDER_SECRET = "private-provider-error-body";
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

const INPUT: BrowserHarnessCodexInput = {
  sessionId: SESSION_ID,
  systemPrompt: SYSTEM_PROMPT,
  transcript: TRANSCRIPT,
};

const OUTPUT_SCHEMA: JsonObjectSchema<{ answer: { type: string } }> = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

const COMPLETION: BrowserHarnessCodexCompletion = {
  modelProvider: "openai-codex",
  model: "gpt-5.6-sol",
  reasoning: "high",
  output: { type: "text", text: "ok" },
  usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
};

function connectedStatus() {
  return {
    providers: [
      { provider: "openai-codex" as const, state: "connected" as const },
      { provider: "google-antigravity" as const, state: "disconnected" as const },
    ],
  };
}

function disconnectedStatus() {
  return {
    providers: [
      { provider: "openai-codex" as const, state: "disconnected" as const },
      { provider: "google-antigravity" as const, state: "disconnected" as const },
    ],
  };
}

function modelResponse(output: unknown[], usage = { inputTokens: 11, outputTokens: 7, totalTokens: 18 }): ModelResponse {
  return {
    output,
    usage: { requests: 1, ...usage },
    responseId: "response-test",
  } as unknown as ModelResponse;
}

function textResponse(...parts: string[]): ModelResponse {
  return modelResponse([
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: parts.map((text) => ({ type: "output_text", text })),
    },
    {
      type: "reasoning",
      id: "reason-test",
      content: [{ type: "input_text", text: REASONING_SECRET }],
      rawContent: [{ type: "reasoning_text", text: REASONING_SECRET }],
    },
  ]);
}

function fakeRouteService(overrides: Partial<BrowserHarnessCodexRouteService> = {}): BrowserHarnessCodexRouteService {
  return {
    status: () => ({
      modelProvider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning: "high",
      oauth: "connected",
    }),
    invoke: async () => COMPLETION,
    ...overrides,
  };
}

function gatewayHandler(
  service: BrowserHarnessCodexRouteService,
  token: string | undefined = TOKEN,
  timeoutMs?: number,
) {
  return createApiHandler({
    webOrigin: WEB_ORIGIN,
    internalRoute: createBrowserHarnessCodexRoutes(service, token, timeoutMs === undefined ? {} : { timeoutMs }),
    route: (_request, url) => url.pathname === "/v1/public-mutation"
      ? Response.json({ routed: true })
      : null,
  });
}

function gatewayRequest(init: RequestInit = {}, path = BROWSER_HARNESS_CODEX_PATH): Request {
  return new Request(`${API_ORIGIN}${path}`, init);
}

function authenticatedPost(body: unknown, overrides: RequestInit = {}): Request {
  return gatewayRequest({
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(overrides.headers)),
    },
    body: JSON.stringify(body),
    ...overrides,
  });
}

async function bodyText(response: Response): Promise<string> {
  return response.text();
}

function assertNoSecrets(serialized: string): void {
  for (const secret of [OAUTH_SECRET, SYSTEM_PROMPT, TRANSCRIPT, REASONING_SECRET, PROVIDER_SECRET]) {
    expect(serialized).not.toContain(secret);
  }
}

describe("Browser Harness Codex HTTP boundary", () => {
  test("handles the exact internal POST before the public Origin policy", async () => {
    let invokes = 0;
    const response = await gatewayHandler(fakeRouteService({
      invoke: async () => {
        invokes += 1;
        return COMPLETION;
      },
    }))(authenticatedPost(INPUT));

    expect(response.status).toBe(200);
    expect(invokes).toBe(1);
    expect(await response.json()).toEqual(COMPLETION);
  });

  test("does not let any other route bypass the public mutation Origin policy", async () => {
    let statusCalls = 0;
    const handler = gatewayHandler(fakeRouteService({
      status: () => {
        statusCalls += 1;
        return {
          modelProvider: "openai-codex",
          model: "gpt-5.6-sol",
          reasoning: "high",
          oauth: "connected",
        };
      },
    }));

    const rejected = await handler(gatewayRequest({
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", origin: "https://attacker.invalid" },
      body: "{}",
    }, "/v1/public-mutation"));
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: { code: "ORIGIN_REJECTED", message: "Mutation origin is not allowed" } });
    expect(statusCalls).toBe(0);

    const accepted = await handler(gatewayRequest({
      method: "POST",
      headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
      body: "{}",
    }, "/v1/public-mutation"));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ routed: true });
  });

  test("returns the same exact-path 404 for GET and POST when no token is configured", async () => {
    const handler = createApiHandler({
      webOrigin: WEB_ORIGIN,
      internalRoute: createBrowserHarnessCodexRoutes(fakeRouteService(), undefined),
    });
    for (const method of ["GET", "POST"]) {
      const init: RequestInit = method === "POST"
        ? {
            method,
            headers: { origin: "https://attacker.invalid", "content-type": "text/plain" },
            body: "not-json",
          }
        : { method };
      const response = await handler(gatewayRequest(init));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found" } });
    }
  });

  test("rejects every configured startup token shorter than 32 characters before constructing dependencies", () => {
    for (const token of ["", "too-short"]) {
      expect(() => createPipelineApplication({ browserHarnessToken: token })).toThrow(
        "JOBHUNTER_HARNESS_TOKEN must contain at least 32 characters",
      );
    }
  });

  test("returns an undifferentiated 401 for missing, malformed, and wrong bearer credentials", async () => {
    const handler = gatewayHandler(fakeRouteService());
    const authorizations = [undefined, "Basic ignored", "Bearer", "Bearer wrong-token"];
    const bodies: unknown[] = [];
    for (const authorization of authorizations) {
      const headers = new Headers();
      if (authorization !== undefined) headers.set("authorization", authorization);
      const response = await handler(gatewayRequest({ headers }));
      expect(response.status).toBe(401);
      bodies.push(await response.json());
    }
    expect(new Set(bodies.map((body) => JSON.stringify(body)))).toEqual(new Set([
      JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }),
    ]));
  });

  test("requires application/json before reading or invoking POST requests", async () => {
    let invokes = 0;
    const handler = gatewayHandler(fakeRouteService({ invoke: async () => { invokes += 1; return COMPLETION; } }));
    for (const contentType of [undefined, "text/plain", "application/problem+json"]) {
      const headers = new Headers({ authorization: `Bearer ${TOKEN}` });
      if (contentType !== undefined) headers.set("content-type", contentType);
      const response = await handler(gatewayRequest({ method: "POST", headers, body: "{}" }));
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({
        error: { code: "JSON_REQUIRED", message: "Model requests must use application/json" },
      });
    }
    expect(invokes).toBe(0);
  });

  test("returns fixed 422 errors for malformed JSON and strict input violations", async () => {
    let invokes = 0;
    const handler = gatewayHandler(fakeRouteService({ invoke: async () => { invokes += 1; return COMPLETION; } }));
    const invalidBodies = [
      "{",
      JSON.stringify({ ...INPUT, extra: true }),
      JSON.stringify({ ...INPUT, sessionId: "not-a-uuid" }),
      JSON.stringify({ ...INPUT, systemPrompt: "é".repeat(524_289) }),
      JSON.stringify({ ...INPUT, transcript: "x".repeat(3 * 1024 * 1024 + 1) }),
      JSON.stringify({ ...INPUT, outputSchema: { type: "array" } }),
    ];
    for (const body of invalidBodies) {
      const response = await handler(gatewayRequest({
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body,
      }));
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: { code: "INVALID_REQUEST", message: "The model request is invalid" },
      });
    }
    expect(invokes).toBe(0);
  });

  test("rejects an oversized Content-Length before invoking the model", async () => {
    let invokes = 0;
    const response = await gatewayHandler(fakeRouteService({ invoke: async () => { invokes += 1; return COMPLETION; } }))(
      gatewayRequest({
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "content-length": String(MAX_REQUEST_BYTES + 1),
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { code: "REQUEST_TOO_LARGE", message: "The model request is too large" },
    });
    expect(invokes).toBe(0);
  });

  test("rejects a streamed body as soon as it exceeds 4 MiB", async () => {
    let invokes = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_REQUEST_BYTES));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const response = await gatewayHandler(fakeRouteService({ invoke: async () => { invokes += 1; return COMPLETION; } }))(
      gatewayRequest({
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: stream,
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { code: "REQUEST_TOO_LARGE", message: "The model request is too large" },
    });
    expect(invokes).toBe(0);
  });
});

describe("BrowserHarnessCodexService model contract", () => {
  test("reports only fixed connected metadata and maps disconnected OAuth to a fixed 409", async () => {
    const connected = new BrowserHarnessCodexService({ authStatusReader: connectedStatus });
    const connectedResponse = await gatewayHandler(connected)(gatewayRequest({
      headers: { authorization: `Bearer ${TOKEN}` },
    }));
    expect(connectedResponse.status).toBe(200);
    expect(await connectedResponse.json()).toEqual({
      modelProvider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning: "high",
      oauth: "connected",
    });

    const disconnected = new BrowserHarnessCodexService({ authStatusReader: disconnectedStatus });
    const disconnectedResponse = await gatewayHandler(disconnected)(gatewayRequest({
      headers: { authorization: `Bearer ${TOKEN}` },
    }));
    expect(disconnectedResponse.status).toBe(409);
    expect(await disconnectedResponse.json()).toEqual({
      error: { code: "OAUTH_REQUIRED", message: "Connect OpenAI Codex in Provider access" },
    });
  });

  test("uses the exact high-reasoning, no-storage, no-retry unstructured request and concatenates assistant text", async () => {
    let capturedSessionId: string | undefined;
    let capturedRequest: ModelRequest | undefined;
    const service = new BrowserHarnessCodexService({
      authStatusReader: connectedStatus,
      modelFactory: (sessionId) => {
        capturedSessionId = sessionId;
        return {
          getResponse: async (request) => {
            capturedRequest = request;
            return textResponse("first", " second");
          },
        };
      },
    });
    const completion = await service.invoke(INPUT);

    expect(capturedSessionId).toBe(SESSION_ID);
    expect(capturedRequest).toEqual({
      systemInstructions: SYSTEM_PROMPT,
      input: TRANSCRIPT,
      modelSettings: {
        store: false,
        reasoning: { effort: "high" },
        text: { verbosity: "low" },
        maxTokens: 16_384,
        parallelToolCalls: false,
        toolChoice: "none",
        retry: { maxRetries: 0 },
      },
      tools: [],
      outputType: "text",
      handoffs: [],
      tracing: false,
    });
    expect(completion).toEqual({
      modelProvider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning: "high",
      output: { type: "text", text: "first second" },
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    });
    assertNoSecrets(JSON.stringify(completion));
  });

  test("installs only strict emit_browser_use_output, forces it, and accepts exactly one completed call", async () => {
    let capturedRequest: ModelRequest | undefined;
    const service = new BrowserHarnessCodexService({
      authStatusReader: connectedStatus,
      modelFactory: () => ({
        getResponse: async (request) => {
          capturedRequest = request;
          return modelResponse([
            { type: "reasoning", id: "reason-test", content: [{ type: "input_text", text: REASONING_SECRET }] },
            {
              type: "function_call",
              callId: "call-test",
              name: "emit_browser_use_output",
              arguments: "{\"answer\":\"yes\"}",
              status: "completed",
            },
          ]);
        },
      }),
    });
    const completion = await service.invoke({ ...INPUT, outputSchema: OUTPUT_SCHEMA });

    expect(capturedRequest?.modelSettings).toEqual({
      store: false,
      reasoning: { effort: "high" },
      text: { verbosity: "low" },
      maxTokens: 16_384,
      parallelToolCalls: false,
      toolChoice: "emit_browser_use_output",
      retry: { maxRetries: 0 },
    });
    expect(capturedRequest?.tools).toEqual([{
      type: "function",
      name: "emit_browser_use_output",
      description: "Return the Browser Use response matching the required schema.",
      parameters: OUTPUT_SCHEMA,
      strict: true,
    }]);
    expect(completion.output).toEqual({ type: "structured", value: { answer: "yes" } });
    assertNoSecrets(JSON.stringify(completion));
  });

  test("passes the caller abort signal unchanged to the model", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const service = new BrowserHarnessCodexService({
      authStatusReader: connectedStatus,
      modelFactory: () => ({
        getResponse: async (request) => {
          seenSignal = request.signal;
          return textResponse("ok");
        },
      }),
    });
    await service.invoke(INPUT, controller.signal);
    expect(seenSignal).toBe(controller.signal);
  });

  test("accepts a version 7 UUID session identifier", async () => {
    const service = new BrowserHarnessCodexService({
      authStatusReader: connectedStatus,
      modelFactory: () => ({ getResponse: async () => textResponse("ok") }),
    });
    const completion = await service.invoke({
      ...INPUT,
      sessionId: "018f0e1b-4f6d-7cc3-98c8-4c0b2d8f74a1",
    });
    expect(completion.output).toEqual({ type: "text", text: "ok" });
  });

  test("rechecks OAuth after a model-resolution failure and reports a logout race as OAuth required", async () => {
    let statusReads = 0;
    const service = new BrowserHarnessCodexService({
      authStatusReader: () => {
        statusReads += 1;
        return statusReads === 1 ? connectedStatus() : disconnectedStatus();
      },
      modelFactory: () => ({
        getResponse: async () => {
          throw new Error(`${PROVIDER_SECRET}:${OAUTH_SECRET}`);
        },
      }),
    });
    const response = await gatewayHandler(service)(authenticatedPost(INPUT));
    expect(response.status).toBe(409);
    const serialized = await response.text();
    expect(JSON.parse(serialized)).toEqual({
      error: { code: "OAUTH_REQUIRED", message: "Connect OpenAI Codex in Provider access" },
    });
    assertNoSecrets(serialized);
  });

  test("rejects malformed structured and unstructured model output with the fixed sanitized 502", async () => {
    const malformedCases: ReadonlyArray<{ output: unknown[]; structured: boolean }> = [
      { output: [], structured: false },
      { output: [{ type: "message", role: "assistant", status: "completed", content: [] }], structured: false },
      {
        output: [{ type: "function_call", callId: "call", name: "unexpected", arguments: "{}", status: "completed" }],
        structured: false,
      },
      {
        output: [{ type: "function_call", callId: "call", name: "wrong_tool", arguments: "{}", status: "completed" }],
        structured: true,
      },
      {
        output: [{ type: "function_call", callId: "call", name: "emit_browser_use_output", arguments: "{}", status: "in_progress" }],
        structured: true,
      },
      {
        output: [{ type: "function_call", callId: "call", name: "emit_browser_use_output", arguments: "not-json", status: "completed" }],
        structured: true,
      },
      {
        output: [{ type: "function_call", callId: "call", name: "emit_browser_use_output", arguments: "[]", status: "completed" }],
        structured: true,
      },
      {
        output: [
          { type: "function_call", callId: "one", name: "emit_browser_use_output", arguments: "{}", status: "completed" },
          { type: "function_call", callId: "two", name: "emit_browser_use_output", arguments: "{}", status: "completed" },
        ],
        structured: true,
      },
    ];

    for (const { output, structured } of malformedCases) {
      const service = new BrowserHarnessCodexService({
        authStatusReader: connectedStatus,
        modelFactory: () => ({ getResponse: async () => modelResponse(output) }),
      });
      const response = await gatewayHandler(service)(authenticatedPost(
        structured ? { ...INPUT, outputSchema: OUTPUT_SCHEMA } : INPUT,
      ));
      expect(response.status).toBe(502);
      const serialized = await bodyText(response);
      expect(JSON.parse(serialized)).toEqual({
        error: { code: "INVALID_MODEL_OUTPUT", message: "The model returned invalid output" },
      });
      assertNoSecrets(serialized);
    }
  });
});

describe("Browser Harness Codex cancellation and error sanitization", () => {
  test("combines request cancellation into the signal passed to the service", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const invoked = Promise.withResolvers<void>();
    const responsePromise = gatewayHandler(fakeRouteService({
      invoke: async (_input, signal) => {
        seenSignal = signal;
        invoked.resolve();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return COMPLETION;
      },
    }), TOKEN, 1_000)(authenticatedPost(INPUT, { signal: controller.signal }));

    await invoked.promise;
    controller.abort(new Error("cancelled by caller"));
    const response = await responsePromise;
    expect(seenSignal?.aborted).toBe(true);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "MODEL_PROVIDER_FAILED", message: "The model request failed" },
    });
  });


  test("applies the model deadline while consuming a stalled streamed body", async () => {
    let cancelled = false;
    let invokes = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await gatewayHandler(fakeRouteService({
      invoke: async () => {
        invokes += 1;
        return COMPLETION;
      },
    }), TOKEN, 5)(gatewayRequest({
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: stream,
    }));
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: { code: "MODEL_TIMEOUT", message: "The model request timed out" },
    });
    expect(cancelled).toBe(true);
    expect(invokes).toBe(0);
  });
  test("aborts a slow model at the configured timeout and returns only the fixed 504", async () => {
    let seenSignal: AbortSignal | undefined;
    const response = await gatewayHandler(fakeRouteService({
      invoke: async (_input, signal) => {
        seenSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error(`${PROVIDER_SECRET}:${OAUTH_SECRET}`)), { once: true });
        });
        return COMPLETION;
      },
    }), TOKEN, 5)(authenticatedPost(INPUT));

    expect(seenSignal?.aborted).toBe(true);
    expect(response.status).toBe(504);
    const serialized = await bodyText(response);
    expect(JSON.parse(serialized)).toEqual({
      error: { code: "MODEL_TIMEOUT", message: "The model request timed out" },
    });
    assertNoSecrets(serialized);
  });

  test("sanitizes arbitrary provider failures without OAuth, prompt, reasoning, or provider-body leakage", async () => {
    const response = await gatewayHandler(fakeRouteService({
      invoke: async () => {
        throw new Error(`${PROVIDER_SECRET} ${OAUTH_SECRET} ${SYSTEM_PROMPT} ${TRANSCRIPT} ${REASONING_SECRET}`);
      },
    }))(authenticatedPost(INPUT));

    expect(response.status).toBe(502);
    const serialized = await bodyText(response);
    expect(JSON.parse(serialized)).toEqual({
      error: { code: "MODEL_PROVIDER_FAILED", message: "The model request failed" },
    });
    assertNoSecrets(serialized);
  });
});
