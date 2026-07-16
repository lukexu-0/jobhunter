import { Buffer } from "node:buffer";
import type { Model, ModelRequest, ModelResponse } from "@openai/agents-core";
import type { JsonObjectSchema } from "@openai/agents-core/types";
import type { AuthStatusResponse } from "../contracts";
import * as defaultAuthService from "../auth/service";
import { MODEL_NAME, OAuthCodexModel } from "./oauth-codex-model";

export const BROWSER_HARNESS_REASONING = "high" as const;
export const BROWSER_HARNESS_MODEL_PROVIDER = "openai-codex" as const;
const STRUCTURED_TOOL_NAME = "emit_browser_use_output";
const MAX_SYSTEM_PROMPT_LENGTH = 1024 * 1024;
const MAX_TRANSCRIPT_LENGTH = 3 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT_KEYS: Readonly<Record<string, true>> = {
  sessionId: true,
  systemPrompt: true,
  transcript: true,
  outputSchema: true,
};

export interface BrowserHarnessCodexInput {
  sessionId: string;
  systemPrompt: string;
  transcript: string;
  outputSchema?: Record<string, unknown>;
}

export interface BrowserHarnessCodexUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type BrowserHarnessCodexOutput =
  | { type: "text"; text: string }
  | { type: "structured"; value: Record<string, unknown> };

export interface BrowserHarnessCodexCompletion {
  modelProvider: typeof BROWSER_HARNESS_MODEL_PROVIDER;
  model: typeof MODEL_NAME;
  reasoning: typeof BROWSER_HARNESS_REASONING;
  output: BrowserHarnessCodexOutput;
  usage: BrowserHarnessCodexUsage;
}

export interface BrowserHarnessCodexStatus {
  modelProvider: typeof BROWSER_HARNESS_MODEL_PROVIDER;
  model: typeof MODEL_NAME;
  reasoning: typeof BROWSER_HARNESS_REASONING;
  oauth: "connected";
}

export type BrowserHarnessCodexModelFactory = (sessionId: string) => Pick<Model, "getResponse">;
export type BrowserHarnessAuthStatusReader = () => Promise<AuthStatusResponse> | AuthStatusResponse;

export interface BrowserHarnessCodexServiceOptions {
  modelFactory?: BrowserHarnessCodexModelFactory;
  authStatusReader?: BrowserHarnessAuthStatusReader;
}

export class BrowserHarnessCodexServiceError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "OAUTH_REQUIRED" | "INVALID_MODEL_OUTPUT", message: string) {
    super(message);
    this.name = "BrowserHarnessCodexServiceError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyInputKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => INPUT_KEYS[key] === true);
}

function parseOutputSchema(value: Record<string, unknown>): JsonObjectSchema<Record<string, Record<string, unknown>>> {
  if (
    value.type !== "object"
    || !isRecord(value.properties)
    || !Array.isArray(value.required)
    || !value.required.every((key) => typeof key === "string")
    || value.additionalProperties !== false
  ) {
    throw new BrowserHarnessCodexServiceError("INVALID_REQUEST", "The model request is invalid");
  }
  const schema = value as JsonObjectSchema<Record<string, Record<string, unknown>>>;
  return schema;
}

export function parseBrowserHarnessCodexInput(value: unknown): BrowserHarnessCodexInput {
  if (!isRecord(value) || !hasOnlyInputKeys(value)) {
    throw new BrowserHarnessCodexServiceError("INVALID_REQUEST", "The model request is invalid");
  }
  const { sessionId, systemPrompt, transcript, outputSchema } = value;
  if (
    typeof sessionId !== "string"
    || !UUID_PATTERN.test(sessionId)
    || typeof systemPrompt !== "string"
    || Buffer.byteLength(systemPrompt, "utf8") > MAX_SYSTEM_PROMPT_LENGTH
    || typeof transcript !== "string"
    || Buffer.byteLength(transcript, "utf8") > MAX_TRANSCRIPT_LENGTH
  ) {
    throw new BrowserHarnessCodexServiceError("INVALID_REQUEST", "The model request is invalid");
  }
  if (outputSchema !== undefined) {
    if (!isRecord(outputSchema)) {
      throw new BrowserHarnessCodexServiceError("INVALID_REQUEST", "The model request is invalid");
    }
    parseOutputSchema(outputSchema);
  }
  return {
    sessionId,
    systemPrompt,
    transcript,
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
}


function parseStructuredOutput(response: ModelResponse): Record<string, unknown> {
  const calls = response.output.filter((item) => item.type === "function_call");
  if (
    calls.length !== 1
    || calls[0]?.name !== STRUCTURED_TOOL_NAME
    || calls[0].status !== "completed"
  ) {
    throw new BrowserHarnessCodexServiceError("INVALID_MODEL_OUTPUT", "The model returned invalid output");
  }
  try {
    const parsed: unknown = JSON.parse(calls[0].arguments);
    if (!isRecord(parsed)) throw new Error("structured value must be an object");
    return parsed;
  } catch {
    throw new BrowserHarnessCodexServiceError("INVALID_MODEL_OUTPUT", "The model returned invalid output");
  }
}

function parseTextOutput(response: ModelResponse): string {
  if (response.output.some((item) => item.type === "function_call")) {
    throw new BrowserHarnessCodexServiceError("INVALID_MODEL_OUTPUT", "The model returned invalid output");
  }
  const text: string[] = [];
  for (const item of response.output) {
    if (item.type !== "message" || item.role !== "assistant") continue;
    for (const part of item.content) {
      if (part.type === "output_text") text.push(part.text);
    }
  }
  if (text.length === 0) {
    throw new BrowserHarnessCodexServiceError("INVALID_MODEL_OUTPUT", "The model returned invalid output");
  }
  return text.join("");
}

function modelRequest(input: BrowserHarnessCodexInput, signal?: AbortSignal): ModelRequest {
  const outputSchema = input.outputSchema === undefined ? undefined : parseOutputSchema(input.outputSchema);
  const structured = outputSchema !== undefined;
  return {
    systemInstructions: input.systemPrompt,
    input: input.transcript,
    modelSettings: {
      store: false,
      reasoning: { effort: BROWSER_HARNESS_REASONING },
      text: { verbosity: "low" },
      maxTokens: 16_384,
      parallelToolCalls: false,
      toolChoice: structured ? STRUCTURED_TOOL_NAME : "none",
      retry: { maxRetries: 0 },
    },
    tools: structured
      ? [{
          type: "function",
          name: STRUCTURED_TOOL_NAME,
          description: "Return the Browser Use response matching the required schema.",
          parameters: outputSchema!,
          strict: true,
        }]
      : [],
    outputType: "text",
    handoffs: [],
    tracing: false,
    ...(signal ? { signal } : {}),
  };
}

export class BrowserHarnessCodexService {
  readonly #modelFactory: BrowserHarnessCodexModelFactory;
  readonly #authStatusReader: BrowserHarnessAuthStatusReader;

  constructor(options: BrowserHarnessCodexServiceOptions = {}) {
    this.#modelFactory = options.modelFactory ?? ((sessionId) => new OAuthCodexModel(sessionId));
    this.#authStatusReader = options.authStatusReader ?? defaultAuthService.getAuthStatus;
  }

  async status(): Promise<BrowserHarnessCodexStatus> {
    const status = await this.#authStatusReader();
    if (!status.providers.some((provider) => provider.provider === BROWSER_HARNESS_MODEL_PROVIDER && provider.state === "connected")) {
      throw new BrowserHarnessCodexServiceError("OAUTH_REQUIRED", "Connect OpenAI Codex in Provider access");
    }
    return {
      modelProvider: BROWSER_HARNESS_MODEL_PROVIDER,
      model: MODEL_NAME,
      reasoning: BROWSER_HARNESS_REASONING,
      oauth: "connected",
    };
  }

  async invoke(rawInput: BrowserHarnessCodexInput, signal?: AbortSignal): Promise<BrowserHarnessCodexCompletion> {
    const input = parseBrowserHarnessCodexInput(rawInput);
    await this.status();
    let response: ModelResponse;
    try {
      response = await this.#modelFactory(input.sessionId).getResponse(modelRequest(input, signal));
    } catch (error) {
      let currentStatus: AuthStatusResponse;
      try {
        currentStatus = await this.#authStatusReader();
      } catch {
        throw error;
      }
      if (!currentStatus.providers.some((provider) => provider.provider === BROWSER_HARNESS_MODEL_PROVIDER && provider.state === "connected")) {
        throw new BrowserHarnessCodexServiceError("OAUTH_REQUIRED", "Connect OpenAI Codex in Provider access");
      }
      throw error;
    }
    const output: BrowserHarnessCodexOutput = input.outputSchema
      ? { type: "structured", value: parseStructuredOutput(response) }
      : { type: "text", text: parseTextOutput(response) };
    return {
      modelProvider: BROWSER_HARNESS_MODEL_PROVIDER,
      model: MODEL_NAME,
      reasoning: BROWSER_HARNESS_REASONING,
      output,
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        totalTokens: response.usage.totalTokens,
      },
    };
  }
}
