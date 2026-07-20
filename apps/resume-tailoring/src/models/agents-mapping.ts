import { Usage, type AgentInputItem, type AgentOutputItem, type ModelRequest, type ModelResponse } from "@openai/agents-core";
import type {
  AssistantMessage,
  Context,
  Message,
  OpenAICodexResponsesOptions,
  Tool,
  ToolChoice,
} from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog";

const REQUEST_KEYS: Readonly<Record<string, true>> = {
  systemInstructions: true, input: true, previousResponseId: true, conversationId: true,
  modelSettings: true, tools: true, toolsExplicitlyProvided: true, outputType: true,
  handoffs: true, tracing: true, signal: true, prompt: true, overridePromptModel: true, _internal: true,
};
const SETTINGS_KEYS: Readonly<Record<string, true>> = {
  temperature: true, topP: true, frequencyPenalty: true, presencePenalty: true,
  toolChoice: true, parallelToolCalls: true, truncation: true, maxTokens: true,
  store: true, promptCacheRetention: true, promptCacheOptions: true, contextManagement: true,
  reasoning: true, text: true, providerData: true, retry: true,
};
const REASONING_KEYS: Readonly<Record<string, true>> = { context: true, effort: true, mode: true, summary: true };
const TEXT_KEYS: Readonly<Record<string, true>> = { verbosity: true };
const RETRY_KEYS: Readonly<Record<string, true>> = { maxRetries: true, backoff: true, policy: true };
const OUTPUT_SCHEMA_KEYS: Readonly<Record<string, true>> = { type: true, name: true, strict: true, schema: true };
const INTERNAL_REQUEST_KEYS: Readonly<Record<string, true>> = { reasoningEffortImplicit: true, runnerManagedRetry: true };
const ASSISTANT_PROVIDER_DATA_KEYS: Readonly<Record<string, true>> = { textSignature: true };
const FUNCTION_TOOL_KEYS: Readonly<Record<string, true>> = {
  type: true, name: true, description: true, parameters: true, strict: true,
  deferLoading: true, namespace: true, namespaceDescription: true,
};
const ZERO_PI_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
// pi-catalog publishes Effort as an ambient const enum; these are its exact wire values.
const OMP_EFFORTS: Readonly<Record<"minimal" | "low" | "medium" | "high" | "xhigh" | "max", Effort>> = {
  minimal: "minimal" as Effort,
  low: "low" as Effort,
  medium: "medium" as Effort,
  high: "high" as Effort,
  xhigh: "xhigh" as Effort,
  max: "max" as Effort,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: object, allowed: Readonly<Record<string, true>>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed[key]) throw new Error(`Unsupported ${label} field: ${key}`);
  }
}

function rejectPresent(value: unknown, label: string): void {
  if (value !== undefined && value !== null) throw new Error(`${label} is not supported by the stateless OAuth model`);
}

function parseArguments(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must contain valid JSON`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`${label} must contain a JSON object`);
  return parsed;
}

function mapUserContent(content: unknown): string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string; detail?: "auto" | "low" | "high" | "original" }> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("Unsupported user message content");
  return content.map((part, index) => {
    if (!isRecord(part) || typeof part.type !== "string") throw new Error(`Unsupported user content at index ${index}`);
    if (part.providerData !== undefined || part.promptCacheBreakpoint !== undefined) {
      throw new Error(`Unsupported provider/cache data in user content at index ${index}`);
    }
    if (part.type === "input_text" && typeof part.text === "string") return { type: "text", text: part.text };
    if (part.type === "input_image" && typeof part.image === "string") {
      const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(part.image);
      if (!match) throw new Error("Only inline PNG/JPEG data URLs are supported in agent input");
      const mimeType = match[1];
      const data = match[2];
      if (mimeType === undefined || data === undefined) throw new Error("Invalid inline image data URL");
      const detail = part.detail;
      if (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high") {
        throw new Error(`Unsupported image detail: ${String(detail)}`);
      }
      return { type: "image", mimeType, data, ...(detail ? { detail } : {}) };
    }
    throw new Error(`Unsupported user content type: ${part.type}`);
  });
}

function mapToolResultOutput(output: unknown): Array<{ type: "text"; text: string }> {
  if (typeof output === "string") return [{ type: "text", text: output }];
  if (isRecord(output) && output.type === "text" && typeof output.text === "string" && output.providerData === undefined) {
    return [{ type: "text", text: output.text }];
  }
  if (Array.isArray(output)) {
    return output.map((part, index) => {
      if (!isRecord(part) || part.type !== "input_text" || typeof part.text !== "string" || part.providerData !== undefined || part.promptCacheBreakpoint !== undefined) {
        throw new Error(`Unsupported function result content at index ${index}`);
      }
      return { type: "text", text: part.text };
    });
  }
  throw new Error("Unsupported function result output");
}

function mapInputItem(item: AgentInputItem, timestamp: number): Message {
  if (!isRecord(item)) throw new Error("Agent input item must be an object");
  if (item.providerData !== undefined) throw new Error("Provider data is not supported on input items");

  if (item.type === "function_call") {
    return {
      role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol",
      content: [{ type: "toolCall", id: item.callId, name: item.name, arguments: parseArguments(item.arguments, `Arguments for ${item.name}`) }],
      usage: ZERO_PI_USAGE, stopReason: "toolUse", timestamp,
    };
  }
  if (item.type === "function_call_result") {
    if (item.status !== "completed") throw new Error(`Unsupported function result status: ${item.status}`);
    return { role: "toolResult", toolCallId: item.callId, toolName: item.name, content: mapToolResultOutput(item.output), isError: false, timestamp };
  }
  if (item.type === "reasoning") {
    const parts = item.rawContent ?? item.content;
    const text = parts.map((part, index) => {
      if (part.providerData !== undefined || (part.type !== "input_text" && part.type !== "reasoning_text")) {
        throw new Error(`Unsupported reasoning content at index ${index}`);
      }
      return part.text;
    }).join("\n");
    return {
      role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol",
      content: [{ type: "thinking", thinking: text, ...(item.id ? { thinkingSignature: item.id } : {}) }],
      usage: ZERO_PI_USAGE, stopReason: "stop", timestamp,
    };
  }
  if (item.type === "message" || item.type === undefined) {
    if (item.role === "user") return { role: "user", content: mapUserContent(item.content), timestamp };
    if (item.role === "system") {
      if (typeof item.content !== "string") throw new Error("Unsupported system content");
      return { role: "developer", content: item.content, timestamp };
    }
    if (item.role === "assistant") {
      if (item.status !== "completed") throw new Error(`Unsupported assistant status: ${item.status}`);
      const content = item.content.map((part, index) => {
        if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") {
          throw new Error(`Unsupported assistant content at index ${index}`);
        }
        const providerData = part.providerData;
        if (providerData === undefined) return { type: "text" as const, text: part.text };
        if (!isRecord(providerData)) throw new Error(`Invalid assistant provider data at index ${index}`);
        assertKnownKeys(providerData, ASSISTANT_PROVIDER_DATA_KEYS, `assistant provider data at index ${index}`);
        if (!Object.prototype.hasOwnProperty.call(providerData, "textSignature") || typeof providerData.textSignature !== "string" || providerData.textSignature.length === 0) {
          throw new Error(`Invalid assistant text signature at index ${index}`);
        }
        return { type: "text" as const, text: part.text, textSignature: providerData.textSignature };
      });
      return {
        role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol",
        content, usage: ZERO_PI_USAGE, stopReason: "stop", timestamp,
      };
    }
  }
  throw new Error(`Unsupported agent input item type: ${String(item.type)}`);
}

function mapTools(tools: ModelRequest["tools"]): Tool[] {
  return tools.map((tool, index) => {
    if (!isRecord(tool) || tool.type !== "function") throw new Error(`Unsupported tool type at index ${index}`);
    assertKnownKeys(tool, FUNCTION_TOOL_KEYS, `function tool ${tool.name}`);
    if (tool.deferLoading === true || tool.namespace !== undefined || tool.namespaceDescription !== undefined) {
      throw new Error(`Deferred or namespaced function tools are not supported: ${tool.name}`);
    }
    if (typeof tool.name !== "string" || typeof tool.description !== "string" || !isRecord(tool.parameters) || typeof tool.strict !== "boolean") {
      throw new Error(`Invalid function tool shape at index ${index}`);
    }
    return { name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.strict };
  });
}

function mapToolChoice(choice: ModelRequest["modelSettings"]["toolChoice"], tools: readonly Tool[]): ToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (choice === "auto") return "auto";
  if (choice === "none") return "none";
  if (choice === "required") return "required";
  if (tools.some((tool) => tool.name === choice)) return { type: "function", name: choice };
  throw new Error(`Unsupported or unknown tool choice: ${String(choice)}`);
}

export type CodexBridgeOptions = Omit<OpenAICodexResponsesOptions, "apiKey" | "reasoning"> & { reasoning?: Effort };

export interface MappedCodexRequest {
  readonly context: Context;
  readonly options: CodexBridgeOptions;
}

export function mapAgentsRequest(request: ModelRequest): MappedCodexRequest {
  assertKnownKeys(request, REQUEST_KEYS, "model request");
  const internal = Reflect.get(request, "_internal");
  if (internal !== undefined) {
    if (!isRecord(internal)) throw new Error("Invalid internal model request metadata");
    assertKnownKeys(internal, INTERNAL_REQUEST_KEYS, "internal model request metadata");
    for (const [key, value] of Object.entries(internal)) {
      if (typeof value !== "boolean") throw new Error(`Invalid internal model request metadata field: ${key}`);
    }
  }
  rejectPresent(request.previousResponseId, "previousResponseId");
  rejectPresent(request.conversationId, "conversationId");
  rejectPresent(request.prompt, "prompt templates");
  if (request.overridePromptModel !== undefined && typeof request.overridePromptModel !== "boolean") {
    throw new Error("Invalid prompt model override");
  }
  if (!Array.isArray(request.handoffs) || request.handoffs.length !== 0) throw new Error("Handoffs are not supported");
  if (typeof request.systemInstructions !== "string" && request.systemInstructions !== undefined) throw new Error("Invalid system instructions");
  if (request.toolsExplicitlyProvided !== undefined && typeof request.toolsExplicitlyProvided !== "boolean") throw new Error("Invalid toolsExplicitlyProvided");
  if (request.tracing !== true && request.tracing !== false && request.tracing !== "enabled_without_data") throw new Error("Invalid tracing setting");
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) throw new Error("Invalid abort signal");

  assertKnownKeys(request.modelSettings, SETTINGS_KEYS, "model setting");
  const settings = request.modelSettings;
  if (settings.store !== false) throw new Error("The OAuth Codex bridge requires modelSettings.store=false");
  if (settings.parallelToolCalls !== undefined && settings.parallelToolCalls !== false) throw new Error("Parallel tool calls are not supported");
  rejectPresent(settings.truncation, "truncation");
  rejectPresent(settings.promptCacheRetention, "prompt cache retention");
  rejectPresent(settings.promptCacheOptions, "prompt cache options");
  rejectPresent(settings.contextManagement, "context management");
  rejectPresent(settings.providerData, "providerData");
  if (settings.retry !== undefined) {
    assertKnownKeys(settings.retry, RETRY_KEYS, "retry setting");
    if (settings.retry.maxRetries !== 0 || settings.retry.backoff !== undefined || settings.retry.policy !== undefined) {
      throw new Error("Model transport retries are not supported");
    }
  }

  for (const [name, value] of Object.entries({
    temperature: settings.temperature, topP: settings.topP, frequencyPenalty: settings.frequencyPenalty,
    presencePenalty: settings.presencePenalty, maxTokens: settings.maxTokens,
  })) {
    if (value !== undefined && (!Number.isFinite(value) || (name === "maxTokens" && (!Number.isInteger(value) || value <= 0)))) {
      throw new Error(`Invalid ${name} setting`);
    }
  }
  const options: CodexBridgeOptions = { preferWebsockets: false };
  if (settings.temperature !== undefined) options.temperature = settings.temperature;
  if (settings.topP !== undefined) options.topP = settings.topP;
  if (settings.frequencyPenalty !== undefined) options.frequencyPenalty = settings.frequencyPenalty;
  if (settings.presencePenalty !== undefined) options.presencePenalty = settings.presencePenalty;
  if (settings.maxTokens !== undefined) options.maxTokens = settings.maxTokens;
  if (settings.text !== undefined) {
    assertKnownKeys(settings.text, TEXT_KEYS, "text setting");
    if (settings.text.verbosity !== undefined && settings.text.verbosity !== null) options.textVerbosity = settings.text.verbosity;
  }
  if (settings.reasoning !== undefined) {
    assertKnownKeys(settings.reasoning, REASONING_KEYS, "reasoning setting");
    if (settings.reasoning.mode !== undefined) throw new Error("Reasoning mode is not supported");
    if (settings.reasoning.effort === "none") throw new Error("Reasoning effort none is not supported");
    if (settings.reasoning.effort !== undefined && settings.reasoning.effort !== null) {
      options.reasoning = OMP_EFFORTS[settings.reasoning.effort];
    }
    if (settings.reasoning.context !== undefined && settings.reasoning.context !== null) options.reasoningContext = settings.reasoning.context;
    if (settings.reasoning.summary !== undefined) options.reasoningSummary = settings.reasoning.summary;
  }

  const mappedTools = mapTools(request.tools);
  const mappedToolChoice = mapToolChoice(settings.toolChoice, mappedTools);
  if (mappedToolChoice !== undefined) options.toolChoice = mappedToolChoice;
  const timestamp = Date.now();
  const messages = typeof request.input === "string"
    ? [{ role: "user" as const, content: request.input, timestamp }]
    : request.input.map((item) => mapInputItem(item, timestamp));
  const systemPrompt = request.systemInstructions ? [request.systemInstructions] : [];
  if (request.outputType !== "text") {
    if (!isRecord(request.outputType) || request.outputType.type !== "json_schema" || typeof request.outputType.name !== "string" || typeof request.outputType.strict !== "boolean" || !isRecord(request.outputType.schema)) {
      throw new Error("Unsupported output schema");
    }
    assertKnownKeys(request.outputType, OUTPUT_SCHEMA_KEYS, "output schema");
    systemPrompt.push(`Return only JSON matching this ${request.outputType.strict ? "strict " : ""}schema (${request.outputType.name}): ${JSON.stringify(request.outputType.schema)}`);
  }
  return { context: { ...(systemPrompt.length ? { systemPrompt } : {}), messages, ...(mappedTools.length ? { tools: mappedTools } : {}) }, options };
}

export function mapPiAssistantMessage(message: AssistantMessage): ModelResponse {
  if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? `Codex request ${message.stopReason}`);
  const output: AgentOutputItem[] = [];
  const text = message.content.filter((part) => part.type === "text");
  if (text.length) {
    output.push({
      type: "message", role: "assistant", status: "completed", id: message.responseId,
      content: text.map((part) => ({ type: "output_text", text: part.text, ...(part.textSignature ? { providerData: { textSignature: part.textSignature } } : {}) })),
    });
  }
  for (const part of message.content) {
    if (part.type === "redactedThinking") continue;
    if (part.type === "thinking") {
      output.push({ type: "reasoning", ...(part.thinkingSignature ? { id: part.thinkingSignature } : {}), content: [{ type: "input_text", text: part.thinking }], rawContent: [{ type: "reasoning_text", text: part.thinking }] });
    } else if (part.type === "toolCall") {
      output.push({ type: "function_call", callId: part.id, name: part.name, arguments: JSON.stringify(part.arguments), status: "completed" });
    } else if (part.type !== "text") {
      throw new Error(`Unsupported Codex response content type: ${part.type}`);
    }
  }
  const inputTokens = message.usage.input + message.usage.cacheRead;
  const usage = new Usage({
    requests: 1, inputTokens, outputTokens: message.usage.output, totalTokens: message.usage.totalTokens,
    inputTokensDetails: [{ cached_tokens: message.usage.cacheRead }],
    outputTokensDetails: message.usage.reasoningTokens === undefined ? [] : [{ reasoning_tokens: message.usage.reasoningTokens }],
  });
  return { usage, output, ...(message.responseId ? { responseId: message.responseId } : {}) };
}
