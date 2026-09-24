import { describe, expect, test } from "bun:test";
import { protocol, type ModelRequest, type ResponseStreamEvent } from "@openai/agents-core";
import { streamSimple, type AssistantMessage } from "@oh-my-pi/pi-ai";
import { OAuthAntigravityModel, type AntigravityTransport } from "../src/models/oauth-antigravity-model.ts";
import { OAuthAntigravityModelProvider } from "../src/models/oauth-antigravity-provider.ts";
import { mapAgentsRequest, mapPiAssistantMessage } from "../src/models/agents-mapping.ts";

const identity = { api: "google-gemini-cli", provider: "google-antigravity", model: "gemini-3.8-flash" } as const;
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    systemInstructions: "Inspect before acting",
    input: "Inspect the form",
    modelSettings: { reasoning: { effort: "high" }, toolChoice: "required", parallelToolCalls: false, store: false, retry: { maxRetries: 0 } },
    tools: [{ type: "function", name: "inspect", description: "Inspect a page", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, strict: true }],
    outputType: "text", handoffs: [], tracing: false, ...overrides,
  };
}
function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return { role: "assistant", ...identity, content, usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 0, totalTokens: 21, reasoningTokens: 2, cost: zeroCost }, stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop", timestamp: 1 };
}

describe("OAuth Antigravity Agents model bridge", () => {
  test("round-trips signed thinking and tool calls with screenshot tool results through Google SSE", async () => {
    const payloads: Record<string, unknown>[] = [];
    const signedParts = [
      { thought: true, text: "Inspect first", thoughtSignature: "dGhpbmtpbmc=" },
      { text: "Checking the page", thoughtSignature: "dGV4dA==" },
      { functionCall: { id: "call-1", name: "inspect", args: {} }, thoughtSignature: "dG9vbA==" },
    ];
    const transport: AntigravityTransport = (model, context, options) => streamSimple(model, context, {
      ...options,
      fetch: async (_url, init) => {
        payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const parts = payloads.length === 1 ? signedParts : [{ text: "Form inspected" }];
        return new Response('data: ' + JSON.stringify({ response: { responseId: "wire-" + payloads.length, candidates: [{ content: { parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 5, cachedContentTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 21 } } }) + '\n\n', { headers: { "content-type": "text/event-stream" } });
      },
    });
    const model = new OAuthAntigravityModel("attempt-replay", { transport, resolverFactory: () => async () => JSON.stringify({ token: "synthetic-token", projectId: "synthetic-project" }) });
    const user = { role: "user" as const, content: [{ type: "input_text" as const, text: "Inspect the form" }, { type: "input_image" as const, image: "data:image/png;base64,aW1hZ2U=" }] };
    const first = await model.getResponse(request({ input: [user] }));
    expect(first.output).toMatchObject([
      { type: "reasoning", id: "dGhpbmtpbmc=", rawContent: [{ type: "reasoning_text", text: "Inspect first" }] },
      { type: "message", content: [{ type: "output_text", text: "Checking the page", providerData: { textSignature: "dGV4dA==" } }] },
      { type: "function_call", callId: "call-1", name: "inspect", arguments: "{}", providerData: { thoughtSignature: "dG9vbA==" } },
    ]);
    const events: ResponseStreamEvent[] = [];
    for await (const event of model.getStreamedResponse(request({ input: [user, ...first.output.map((item) => protocol.OutputModelItem.parse(item)), { type: "function_call_result", callId: "call-1", name: "inspect", status: "completed", output: [{ type: "input_text", text: "Form found" }, { type: "input_image", image: "data:image/jpeg;base64,c2NyZWVu" }] }] }))) events.push(event);
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toMatchObject({ request: { contents: [
      { role: "user", parts: [{ text: "Inspect the form" }, { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }] },
      { role: "model", parts: [signedParts[0], signedParts[1], { functionCall: { name: "inspect", args: {} }, thoughtSignature: "dG9vbA==" }] },
      { role: "user", parts: [{ functionResponse: { name: "inspect", response: { output: "Form found" }, parts: [{ inlineData: { mimeType: "image/jpeg", data: "c2NyZWVu" } }] } }] },
    ] } });
    expect(events).toContainEqual({ type: "output_text_delta", delta: "Form inspected" });
    expect(events.at(-1)).toMatchObject({ type: "response_done", response: { usage: { requests: 1, inputTokens: 14, outputTokens: 7, totalTokens: 21 }, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Form inspected" }] }] } });
  });
  test("rejects Codex-only settings and native history at the Google boundary", () => {
    const base = request();
    expect(() => mapAgentsRequest(request({ modelSettings: { ...base.modelSettings, contextManagement: [{ type: "compaction", compactThreshold: 1000 }] } }), identity)).toThrow();
    expect(() => mapAgentsRequest(request({ input: [{ type: "compaction", encrypted_content: "codex-private-history" }] }), identity)).toThrow();
    const native = { type: "openaiResponsesHistory", provider: "openai-codex", dt: true, items: [{ type: "compaction", encrypted_content: "codex-private-history" }] } as const;
    expect(() => mapAgentsRequest(request({ input: [{ type: "reasoning", content: [], providerData: { jobhuntCodex: { version: 1, kind: "history", payload: native } } }] }), identity)).toThrow();
    expect(() => mapPiAssistantMessage({ ...assistant([]), providerPayload: { ...native, items: [...native.items] } }, identity)).toThrow();
    expect(() => mapAgentsRequest(request({ modelSettings: { ...base.modelSettings, reasoning: { effort: "high", summary: "detailed" } } }), identity)).toThrow();
    expect(() => mapAgentsRequest(request({ modelSettings: { ...base.modelSettings, text: { verbosity: "high" } } }), identity)).toThrow();
  });
  test.each(["minimal", "low", "medium", "high"] as const)("routes %s reasoning with a client version that exposes Gemini 3.8", async (effort) => {
    const payloads: Record<string, unknown>[] = [];
    const transport: AntigravityTransport = (model, context, options) => streamSimple(model, context, {
      ...options,
      fetch: async (_url, init) => {
        payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        // The service hides 3.8 effort routes from the pinned 2.1 client.
        const version = /^antigravity\/hub\/(\d+)\.(\d+)/.exec(new Headers(init?.headers).get("user-agent") ?? "");
        const major = Number(version?.[1] ?? 0);
        const minor = Number(version?.[2] ?? 0);
        if (major < 2 || (major === 2 && minor < 8)) return new Response("Model not found", { status: 404 });
        return new Response('data: ' + JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "Ready" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 5, cachedContentTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 21 } } }) + '\n\n', { headers: { "content-type": "text/event-stream" } });
      },
    });
    const provider = new OAuthAntigravityModelProvider("attempt-wire", { transport, resolverFactory: () => async () => JSON.stringify({ token: "synthetic-token", projectId: "synthetic-project" }) });
    const response = await provider.getModel().getResponse(request({ modelSettings: { ...request().modelSettings, reasoning: { effort } } }));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ model: effort === "minimal" ? "gemini-3.8-flash-low" : "gemini-3.8-flash-" + effort, project: "synthetic-project", request: { generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: effort === "minimal" ? "MINIMAL" : effort.toUpperCase() } }, toolConfig: { functionCallingConfig: { mode: "ANY" } } } });
    expect(JSON.stringify(payloads[0])).not.toMatch(/codex|compaction|context_management|encrypted_content|preferWebsockets/);
    expect(response.output).toContainEqual({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Ready" }] });
    expect(response.usage).toMatchObject({ requests: 1, inputTokens: 14, outputTokens: 7, totalTokens: 21, inputTokensDetails: [{ cached_tokens: 3 }], outputTokensDetails: [{ reasoning_tokens: 2 }] });
    expect(() => provider.getModel("gemini-3-flash")).toThrow();
  });
  test("provider failures after streamed tool calls never become successful responses", async () => {
    const transport: AntigravityTransport = (model, context, options) => streamSimple(model, context, {
      ...options,
      fetch: async () => new Response('data: ' + JSON.stringify({ response: { candidates: [{ content: { parts: [{ functionCall: { name: "inspect", args: {} }, thoughtSignature: "dG9vbA==" }] }, finishReason: "SAFETY" }] } }) + '\n\n', { headers: { "content-type": "text/event-stream" } }),
    });
    const model = new OAuthAntigravityModel("attempt-failed", { transport, resolverFactory: () => async () => JSON.stringify({ token: "synthetic-token", projectId: "synthetic-project" }) });
    await expect(model.getResponse(request())).rejects.toThrow();
    const events: ResponseStreamEvent[] = [];
    await expect((async () => { for await (const event of model.getStreamedResponse(request())) events.push(event); })()).rejects.toThrow();
    expect(events.some((event) => event.type === "response_done")).toBe(false);
  });

  test("cancellation wins over a late successful provider response", async () => {
    for (const streamed of [false, true]) {
      const controller = new AbortController();
      const message = assistant([{ type: "text", text: "Late result" }]);
      const model = new OAuthAntigravityModel("attempt-aborted", {
        resolverFactory: () => async () => "unused",
        transport: async function* () {
          yield { type: "text_delta", contentIndex: 0, delta: "Late", partial: message };
          controller.abort(new Error("Cancelled by user"));
          yield { type: "done", reason: "stop", message };
        },
      });
      const input = request({ signal: controller.signal });
      if (streamed) {
        const events: ResponseStreamEvent[] = [];
        await expect((async () => { for await (const event of model.getStreamedResponse(input)) events.push(event); })()).rejects.toThrow("Cancelled by user");
        expect(events.some((event) => event.type === "response_done")).toBe(false);
      } else {
        await expect(model.getResponse(input)).rejects.toThrow("Cancelled by user");
      }
    }
  });

  test("incomplete streams and failed terminal messages are not successful responses", async () => {
    const partial = assistant([{ type: "text", text: "Incomplete" }]);
    const incomplete = new OAuthAntigravityModel("attempt-incomplete", {
      resolverFactory: () => async () => "unused",
      transport: async function* () { yield { type: "text_delta", contentIndex: 0, delta: "Incomplete", partial }; },
    });
    await expect(incomplete.getResponse(request())).rejects.toThrow();
    const events: ResponseStreamEvent[] = [];
    await expect((async () => { for await (const event of incomplete.getStreamedResponse(request())) events.push(event); })()).rejects.toThrow();
    expect(events.some((event) => event.type === "response_done")).toBe(false);
    for (const stopReason of ["error", "aborted"] as const) {
      const failed = new OAuthAntigravityModel("attempt-terminal", {
        resolverFactory: () => async () => "unused",
        transport: async function* () { yield { type: "done", reason: "stop", message: { ...partial, stopReason } }; },
      });
      await expect(failed.getResponse(request())).rejects.toThrow();
    }
  });
});
