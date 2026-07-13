import { describe, expect, test } from "bun:test";
import type { AgentInputItem, ModelRequest } from "@openai/agents-core";
import type {
  ApiKeyResolver,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model as OmpModel,
  SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { inspectResumePng } from "../src/models/gemini-inspector";
import { mapAgentsRequest } from "../src/models/agents-mapping";
import { MODEL_NAME, OAuthCodexModel, type CodexTransport } from "../src/models/oauth-codex-model";
import { OAuthCodexModelProvider } from "../src/models/oauth-codex-provider";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function modelRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    systemInstructions: "System contract",
    input: "hello",
    modelSettings: { reasoning: { effort: "medium" }, toolChoice: "submit", parallelToolCalls: false, store: false, retry: { maxRetries: 0 } },
    tools: [{ type: "function", name: "submit", description: "Submit", parameters: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }, strict: true }],
    outputType: "text",
    handoffs: [],
    tracing: false,
    ...overrides,
  };
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: MODEL_NAME,
    content, responseId: "response-1",
    usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 0, totalTokens: 21, reasoningTokens: 2, cost: ZERO_COST },
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop", timestamp: 1,
  };
}

function completedTransport(message: AssistantMessage, capture?: (context: Context, options: SimpleStreamOptions) => void): CodexTransport {
  return async function* (_model, context, options): AsyncIterable<AssistantMessageEvent> {
    capture?.(context, options);
    yield { type: "start", partial: message };
    for (const [contentIndex, part] of message.content.entries()) {
      if (part.type === "text") yield { type: "text_delta", contentIndex, delta: part.text, partial: message };
    }
    yield { type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message };
  };
}

function inertResolver(): ApiKeyResolver {
  return async () => "oauth-bearer";
}

describe("OAuth Codex Agents model bridge", () => {
  test("provider accepts only the exact model and creates attempt-isolated resolver identities", async () => {
    const sessions: string[] = [];
    const resolverFactory = (_provider: "openai-codex", sessionId: string): ApiKeyResolver => {
      sessions.push(sessionId);
      return inertResolver();
    };
    const options = { transport: completedTransport(assistantMessage([{ type: "text", text: "ok" }])), resolverFactory };
    const first = new OAuthCodexModelProvider("attempt-a", options);
    const second = new OAuthCodexModelProvider("attempt-b", options);
    expect(first.getModel(MODEL_NAME)).not.toBe(second.getModel(MODEL_NAME));
    expect(() => first.getModel("gpt-5.6-terra")).toThrow("Unsupported model");
    expect(() => first.getModel()).toThrow("Unsupported model");
    await first.getModel(MODEL_NAME).getResponse(modelRequest());
    await second.getModel(MODEL_NAME).getResponse(modelRequest());
    expect(sessions).toEqual(["attempt-a", "attempt-b"]);
  });

  test("maps instructions, protocol history, strict tools, forced choice, schema, settings, and signal without provider state", async () => {
    const signal = new AbortController().signal;
    let seenContext: Context | undefined;
    let seenOptions: SimpleStreamOptions | undefined;
    let resolverSignal: AbortSignal | undefined;
    const resolverFactory = (_provider: "openai-codex", sessionId: string, modelId: typeof MODEL_NAME, passedSignal?: AbortSignal): ApiKeyResolver => {
      expect(sessionId).toBe("attempt-map");
      expect(modelId).toBe(MODEL_NAME);
      resolverSignal = passedSignal;
      return inertResolver();
    };
    const request = modelRequest({
      input: [
        { role: "user", content: [{ type: "input_text", text: "question" }] },
        { type: "function_call", callId: "call-prior", name: "submit", arguments: "{\"answer\":\"prior\"}", status: "completed" },
        { type: "function_call_result", callId: "call-prior", name: "submit", output: "accepted", status: "completed" },
      ],
      outputType: { type: "json_schema", name: "answer", strict: true, schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } },
      modelSettings: {
        reasoning: { effort: "medium", context: "current_turn", summary: "concise" }, text: { verbosity: "low" },
        temperature: 0.2, topP: 0.8, frequencyPenalty: 0.1, presencePenalty: 0.2, maxTokens: 123,
        toolChoice: "submit", parallelToolCalls: false, store: false, retry: { maxRetries: 0 },
      },
      signal,
    });
    const model = new OAuthCodexModel("attempt-map", {
      resolverFactory,
      transport: completedTransport(assistantMessage([{ type: "text", text: "{}" }]), (context, options) => { seenContext = context; seenOptions = options; }),
    });
    await model.getResponse(request);
    expect(resolverSignal).toBe(signal);
    expect(seenContext?.systemPrompt?.[0]).toBe("System contract");
    expect(seenContext?.systemPrompt?.[1]).toContain("strict schema (answer)");
    expect(seenContext?.tools).toEqual([{ name: "submit", description: "Submit", parameters: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }, strict: true }]);
    expect(seenContext?.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(seenOptions).toMatchObject({
      temperature: 0.2, topP: 0.8, frequencyPenalty: 0.1, presencePenalty: 0.2, maxTokens: 123,
      reasoning: "medium", reasoningContext: "current_turn", reasoningSummary: "concise", textVerbosity: "low",
      toolChoice: { type: "function", name: "submit" }, sessionId: "attempt-map", preferWebsockets: false, signal,
    });
    expect(seenOptions).toHaveProperty("sessionId", "attempt-map");
    expect(seenOptions).not.toHaveProperty("providerSessionState");
    expect(seenOptions).not.toHaveProperty("previousInteractionId");
    expect(seenOptions).not.toHaveProperty("storeInteraction");
  });

  test("preserves function calls, JSON arguments, reasoning, response ID, and usage", async () => {
    const message = assistantMessage([
      { type: "thinking", thinking: "checked constraints", thinkingSignature: "reason-1" },
      { type: "text", text: "calling" },
      { type: "toolCall", id: "call-7", name: "submit", arguments: { answer: "yes", count: 2 } },
    ]);
    const response = await new OAuthCodexModel("attempt-response", { transport: completedTransport(message), resolverFactory: inertResolver }).getResponse(modelRequest());
    expect(response.responseId).toBe("response-1");
    expect(response.output).toContainEqual({ type: "function_call", callId: "call-7", name: "submit", arguments: "{\"answer\":\"yes\",\"count\":2}", status: "completed" });
    expect(response.output).toContainEqual({ type: "reasoning", id: "reason-1", content: [{ type: "input_text", text: "checked constraints" }], rawContent: [{ type: "reasoning_text", text: "checked constraints" }] });
    expect(response.usage).toMatchObject({ requests: 1, inputTokens: 14, outputTokens: 7, totalTokens: 21 });
    expect(response.usage.inputTokensDetails).toEqual([{ cached_tokens: 3 }]);
    expect(response.usage.outputTokensDetails).toEqual([{ reasoning_tokens: 2 }]);
  });

  test("emits a valid response_done stream carrying final output and usage", async () => {
    const message = assistantMessage([{ type: "text", text: "hello" }, { type: "toolCall", id: "call-s", name: "submit", arguments: { answer: "stream" } }]);
    const events = [];
    for await (const event of new OAuthCodexModel("attempt-stream", { transport: completedTransport(message), resolverFactory: inertResolver }).getStreamedResponse(modelRequest())) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["response_started", "output_text_delta", "response_done"]);
    const done = events[2];
    expect(done?.type).toBe("response_done");
    if (done?.type !== "response_done") throw new Error("response_done missing");
    expect(done.response.id).toBe("response-1");
    expect(done.response.output).toContainEqual({ type: "function_call", callId: "call-s", name: "submit", arguments: "{\"answer\":\"stream\"}", status: "completed" });
    expect(done.response.usage).toMatchObject({ inputTokens: 14, outputTokens: 7, totalTokens: 21 });
  });

  test("rejects unknown request, item, tool, handoff, storage, conversation, and setting shapes", () => {
    const unknownRequest = modelRequest();
    Reflect.set(unknownRequest, "futureField", true);
    expect(() => mapAgentsRequest(unknownRequest)).toThrow("Unsupported model request field");
    expect(() => mapAgentsRequest(modelRequest({ previousResponseId: "previous" }))).toThrow("previousResponseId");
    expect(() => mapAgentsRequest(modelRequest({ conversationId: "conversation" }))).toThrow("conversationId");
    expect(() => mapAgentsRequest(modelRequest({ handoffs: [{ toolName: "transfer", toolDescription: "x", inputJsonSchema: { type: "object", properties: {}, required: [], additionalProperties: false }, strictJsonSchema: true }] }))).toThrow("Handoffs");
    expect(() => mapAgentsRequest(modelRequest({ modelSettings: { store: true } }))).toThrow("store=false");
    expect(() => mapAgentsRequest(modelRequest({ modelSettings: { store: false, parallelToolCalls: true } }))).toThrow("Parallel");
    const unknownSettings = modelRequest({ modelSettings: { store: false } });
    Reflect.set(unknownSettings.modelSettings, "futureSetting", true);
    expect(() => mapAgentsRequest(unknownSettings)).toThrow("Unsupported model setting field");
    expect(() => mapAgentsRequest(modelRequest({ tools: [{ type: "hosted_tool", name: "web", providerData: {} }] }))).toThrow("Unsupported tool type");
    const unknownItem: AgentInputItem = { role: "user", content: "x" };
    Reflect.set(unknownItem, "providerData", { unsafe: true });
    expect(() => mapAgentsRequest(modelRequest({ input: [unknownItem] }))).toThrow("Provider data");
  });

  test("uses only the injected OAuth resolver and never reads API-key environment fallbacks", async () => {
    const prior = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "hostile-environment-key";
    let passedKey: unknown;
    const resolver = inertResolver();
    try {
      const model = new OAuthCodexModel("attempt-oauth-only", {
        resolverFactory: () => resolver,
        transport: completedTransport(assistantMessage([{ type: "text", text: "ok" }]), (_context, options) => { passedKey = options.apiKey; }),
      });
      await model.getResponse(modelRequest());
      expect(passedKey).toBe(resolver);
      expect(passedKey).not.toBe("hostile-environment-key");
    } finally {
      if (prior === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prior;
    }
  });
});

describe("direct Gemini visual inspector", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  test("accepts PNG only, passes exact Antigravity OAuth identity/signal, and strictly parses JSON", async () => {
    const signal = new AbortController().signal;
    let providerSeen = "";
    let sessionSeen = "";
    let modelSeen = "";
    let contextSeen: Context | undefined;
    let optionsSeen: SimpleStreamOptions | undefined;
    const result = await inspectResumePng(png, "visual-attempt", signal, {
      resolverFactory: (provider, session, model, passedSignal) => {
        providerSeen = provider; sessionSeen = session; modelSeen = model; expect(passedSignal).toBe(signal);
        return inertResolver();
      },
      transport: async (model: OmpModel<"google-gemini-cli">, context, options) => {
        expect(model.provider).toBe("google-antigravity");
        expect(model.id).toBe("gemini-3.5-flash");
        contextSeen = context; optionsSeen = options;
        return {
          role: "assistant", api: "google-gemini-cli", provider: "google-antigravity", model: "gemini-3.5-flash",
          content: [{ type: "text", text: "{\"status\":\"pass\",\"summary\":\"Layout is clean\",\"findings\":[]}" }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: ZERO_COST }, stopReason: "stop", timestamp: 1,
        };
      },
    });
    expect({ providerSeen, sessionSeen, modelSeen }).toEqual({ providerSeen: "google-antigravity", sessionSeen: "visual-attempt", modelSeen: "gemini-3.5-flash" });
    expect(result).toEqual({ status: "pass", summary: "Layout is clean", findings: [] });
    expect(contextSeen?.messages).toHaveLength(1);
    const user = contextSeen?.messages[0];
    expect(user?.role).toBe("user");
    if (user?.role !== "user" || typeof user.content === "string") throw new Error("PNG user message missing");
    expect(user.content).toEqual([{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }]);
    expect(contextSeen?.systemPrompt?.[1]).toContain("strict JSON Schema");
    expect(optionsSeen).toMatchObject({ signal, reasoning: "medium" });
  });

  test("rejects non-PNG and non-strict Gemini results", async () => {
    const neverTransport = async (): Promise<AssistantMessage> => { throw new Error("transport must not run"); };
    await expect(inspectResumePng(new Uint8Array([0xff, 0xd8, 0xff]), "visual", undefined, { transport: neverTransport })).rejects.toThrow("PNG only");
    await expect(inspectResumePng(png, "visual", undefined, {
      resolverFactory: () => inertResolver(),
      transport: async () => ({
        role: "assistant", api: "google-gemini-cli", provider: "google-antigravity", model: "gemini-3.5-flash",
        content: [{ type: "text", text: "{\"status\":\"pass\",\"summary\":\"ok\",\"findings\":[],\"extra\":true}" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: ZERO_COST }, stopReason: "stop", timestamp: 1,
      }),
    })).rejects.toThrow();
    await expect(inspectResumePng(png, "visual", undefined, {
      resolverFactory: () => inertResolver(),
      transport: async () => ({
        role: "assistant", api: "google-gemini-cli", provider: "google-antigravity", model: "gemini-3.5-flash",
        content: [{ type: "text", text: "```json\n{}\n```" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: ZERO_COST }, stopReason: "stop", timestamp: 1,
      }),
    })).rejects.toThrow("invalid JSON");
  });
});
