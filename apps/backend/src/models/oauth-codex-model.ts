import { protocol, type Model as AgentsModel, type ModelRequest, type ModelResponse, type ResponseStreamEvent } from "@openai/agents-core";
import {
  streamSimple,
  type ApiKeyResolver,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model as OmpModel,
  type ModelSpec,
  type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { isContextOverflow } from "@oh-my-pi/pi-ai/error";
import type { Effort } from "@oh-my-pi/pi-catalog";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createOAuthOnlyApiKeyResolver } from "../auth/oauth-only-resolver";
import { mapAgentsRequest, mapPiAssistantMessage, mapPiAssistantUsage } from "./agents-mapping";
import { CodexContextEstimator } from "./codex-context.ts";

export const MODEL_NAME = "gpt-5.6-sol" as const;
// pi-catalog publishes Effort as an ambient const enum; these are its exact wire values.
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as Effort[];

const CODEX_MODEL_SPEC: ModelSpec<"openai-codex-responses"> = {
  id: MODEL_NAME,
  name: "GPT-5.6 Sol",
  api: "openai-codex-responses" as const,
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text", "image"],
  supportsTools: true,
  cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  remoteCompaction: { enabled: true, api: "openai-codex-responses" as const, v2StreamingEnabled: true },
  contextWindow: 372_000,
  maxTokens: 128_000,
  preferWebsockets: false,
  useResponsesLite: true,
  priority: 1,
  applyPatchToolType: "freeform" as const,
  thinking: { mode: "effort", efforts: CODEX_EFFORTS },
};

export const OMP_CODEX_MODEL: OmpModel<"openai-codex-responses"> = Object.freeze(buildModel(CODEX_MODEL_SPEC));

const expectedDescriptor = {
  id: MODEL_NAME, name: "GPT-5.6 Sol", api: "openai-codex-responses", provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text", "image"], supportsTools: true,
  cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  remoteCompaction: { enabled: true, api: "openai-codex-responses", v2StreamingEnabled: true }, contextWindow: 372_000,
  maxTokens: 128_000, preferWebsockets: false, useResponsesLite: true, priority: 1, applyPatchToolType: "freeform",
  thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] },
};
for (const [field, expected] of Object.entries(expectedDescriptor)) {
  const actual = OMP_CODEX_MODEL[field as keyof typeof OMP_CODEX_MODEL];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Invalid app-owned Codex descriptor field: ${field}`);
}
if (!OMP_CODEX_MODEL.compat || typeof OMP_CODEX_MODEL.compat !== "object") throw new Error("Invalid app-owned Codex compatibility descriptor");

export type CodexTransport = (
  model: OmpModel<"openai-codex-responses">,
  context: Context,
  options: SimpleStreamOptions,
) => AsyncIterable<AssistantMessageEvent>;

export type OAuthResolverFactory = (
  provider: "openai-codex",
  sessionId: string,
  modelId: typeof MODEL_NAME,
  signal?: AbortSignal,
) => ApiKeyResolver;

export interface OAuthCodexModelOptions {
  readonly transport?: CodexTransport;
  readonly resolverFactory?: OAuthResolverFactory;
}
interface PreparedCodexCall {
  readonly context: Context;
  readonly transportOptions: SimpleStreamOptions;
  readonly contextTokens?: number;
  readonly compaction?: {
    readonly output: ModelResponse["output"][number];
    readonly usage: ModelResponse["usage"];
  };
  readonly recoveryUsage?: ModelResponse["usage"];
}

class CodexResponseError extends Error {
  readonly assistantMessage: AssistantMessage;
  readonly contentEmitted: boolean;
  readonly reason: "aborted" | "error";

  constructor(assistantMessage: AssistantMessage, reason: "aborted" | "error", contentEmitted: boolean) {
    super(assistantMessage.errorMessage ?? `Codex request ${reason}`);
    this.name = "CodexResponseError";
    this.assistantMessage = assistantMessage;
    this.contentEmitted = contentEmitted;
    this.reason = reason;
  }
}

export interface CodexCompactionDiagnostic {
  readonly phase: "pre_turn";
  readonly reason: "transport_failed" | "invalid_native_output";
  readonly payloadMode?: "missing" | "incremental" | "replacement";
  readonly outputItemCount?: number;
  readonly compactionItemCount?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export class CodexCompactionError extends Error {
  readonly code = "CODEX_COMPACTION_FAILED";
  readonly compaction: CodexCompactionDiagnostic;

  constructor(reason: CodexCompactionDiagnostic["reason"], response?: AssistantMessage, cause?: unknown) {
    super("Native Codex context compaction failed", cause === undefined ? undefined : { cause });
    this.name = "CodexCompactionError";
    const payload = response?.providerPayload;
    this.compaction = Object.freeze({
      phase: "pre_turn",
      reason,
      ...(response === undefined ? {} : {
        payloadMode: payload === undefined ? "missing" : payload.dt ? "incremental" : "replacement",
        outputItemCount: payload?.items.length ?? 0,
        compactionItemCount: payload?.items.filter((item) => item.type === "compaction").length ?? 0,
        inputTokens: response.usage.input + response.usage.cacheRead,
        outputTokens: response.usage.output,
      }),
    });
  }
}

export class OAuthCodexModel implements AgentsModel {
  readonly #attemptSessionId: string;
  readonly #transport: CodexTransport;
  readonly #resolverFactory: OAuthResolverFactory;
  readonly #contextEstimator = new CodexContextEstimator();
  #requestSequence = 0;
  #compactionSequence = 0;

  constructor(attemptSessionId: string, options: OAuthCodexModelOptions = {}) {
    if (!attemptSessionId.trim()) throw new Error("attemptSessionId is required");
    this.#attemptSessionId = attemptSessionId;
    this.#transport = options.transport ?? ((model, context, streamOptions) => streamSimple(model, context, streamOptions));
    this.#resolverFactory = options.resolverFactory ?? createOAuthOnlyApiKeyResolver;
  }
  async #completedResponse(context: Context, options: SimpleStreamOptions): Promise<AssistantMessage> {
    let completed: AssistantMessage | undefined;
    let contentEmitted = false;
    for await (const event of this.#transport(OMP_CODEX_MODEL, context, options)) {
      if (event.type === "error") {
        throw new CodexResponseError(event.error, event.reason, contentEmitted);
      }
      if (event.type === "done") {
        completed = event.message;
        continue;
      }
      if (event.type !== "start") contentEmitted = true;
    }
    if (!completed) throw new Error("Codex transport ended without a completed response");
    return completed;
  }

  #isRecoverableOverflow(error: unknown, signal?: AbortSignal): error is CodexResponseError {
    return error instanceof CodexResponseError
      && error.reason === "error"
      && error.assistantMessage.stopReason === "error"
      && !error.contentEmitted
      && error.assistantMessage.content.length === 0
      && signal?.aborted !== true
      && isContextOverflow(error.assistantMessage);
  }

  async #prepareCall(request: ModelRequest): Promise<PreparedCodexCall> {
    const { context, options, compactThreshold } = mapAgentsRequest(request);
    const apiKey = this.#resolverFactory("openai-codex", this.#attemptSessionId, MODEL_NAME, request.signal);
    const contextTokens = compactThreshold === undefined ? undefined : this.#contextEstimator.estimate(context);
    const prepared: PreparedCodexCall = {
      context,
      ...(contextTokens === undefined ? {} : { contextTokens }),
      transportOptions: {
        ...options,
        apiKey,
        sessionId: this.#attemptSessionId,
        preferWebsockets: false,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    };
    if (compactThreshold === undefined || contextTokens! < compactThreshold) return prepared;
    return this.#compactPrepared(prepared);
  }

  async #compactPrepared(prepared: PreparedCodexCall): Promise<PreparedCodexCall> {
    const operationId = this.#attemptSessionId + ":pre-turn:" + ++this.#compactionSequence;
    let compacted: AssistantMessage | undefined;
    try {
      compacted = await this.#completedResponse(prepared.context, {
        ...prepared.transportOptions,
        toolChoice: "auto",
        // Classification alone does not compact. Append the native V2 trigger after Lite shaping.
        onPayload(payload) {
          if (typeof payload !== "object" || payload === null || !("input" in payload) || !Array.isArray(payload.input)) {
            throw new Error("Invalid Codex compaction request payload");
          }
          payload.input.push({ type: "compaction_trigger" });
        },
        codexCompaction: {
          operationId, trigger: "auto", reason: "context_limit",
          implementation: "responses_compaction_v2", phase: "pre_turn", strategy: "prefix_compaction",
        },
      });
      prepared.transportOptions.signal?.throwIfAborted();
      const payload = compacted.providerPayload;
      if (payload === undefined || !payload.dt || payload.items.filter((item) => item.type === "compaction").length !== 1) {
        throw new Error("Expected exactly one native compaction output item");
      }
      mapPiAssistantMessage(compacted);
      const replacementMessage: AssistantMessage = {
        ...compacted,
        providerPayload: { ...payload, dt: false },
      };
      const replacementResponse = mapPiAssistantMessage(replacementMessage);
      const replacementOutput = replacementResponse.output[0];
      if (replacementOutput?.type !== "reasoning") {
        throw new Error("Could not construct native replacement history");
      }
      return {
        ...prepared,
        context: { ...prepared.context, messages: [...prepared.context.messages, replacementMessage] },
        compaction: { output: replacementOutput, usage: replacementResponse.usage },
      };
    } catch (error) {
      prepared.transportOptions.signal?.throwIfAborted();
      throw new CodexCompactionError(compacted === undefined ? "transport_failed" : "invalid_native_output", compacted, error);
    }
  }
  async #recoverPrepared(prepared: PreparedCodexCall, error: CodexResponseError): Promise<PreparedCodexCall> {
    const recoveryUsage = mapPiAssistantUsage(error.assistantMessage);
    return {
      ...await this.#compactPrepared(prepared),
      recoveryUsage,
    };
  }


  #prependCompaction(response: ModelResponse, prepared: PreparedCodexCall): ModelResponse {
    let usage = response.usage;
    if (prepared.compaction !== undefined) {
      prepared.compaction.usage.add(usage);
      usage = prepared.compaction.usage;
    }
    if (prepared.recoveryUsage !== undefined) {
      prepared.recoveryUsage.add(usage);
      usage = prepared.recoveryUsage;
    }
    if (prepared.compaction === undefined && prepared.recoveryUsage === undefined) return response;
    return {
      ...response,
      usage,
      output: prepared.compaction === undefined
        ? response.output
        : [prepared.compaction.output, ...response.output],
    };
  }


  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    let prepared = await this.#prepareCall(request);
    let completed: AssistantMessage;
    try {
      completed = await this.#completedResponse(prepared.context, prepared.transportOptions);
    } catch (error) {
      if (prepared.compaction !== undefined || !this.#isRecoverableOverflow(error, request.signal)) throw error;
      prepared = await this.#recoverPrepared(prepared, error);
      request.signal?.throwIfAborted();
      completed = await this.#completedResponse(prepared.context, prepared.transportOptions);
    }
    if (prepared.contextTokens !== undefined) this.#contextEstimator.observe(prepared.context, completed);
    return this.#prependCompaction(mapPiAssistantMessage(completed), prepared);
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<ResponseStreamEvent> {
    let prepared = await this.#prepareCall(request);
    let recovered = false;
    const localResponseId = `${this.#attemptSessionId}:${++this.#requestSequence}`;
    yield { type: "response_started" };

    streamAttempt: while (true) {
      let contentEmitted = false;
      for await (const event of this.#transport(OMP_CODEX_MODEL, prepared.context, prepared.transportOptions)) {
        if (event.type === "start") continue;
        if (event.type === "error") {
          const error = new CodexResponseError(event.error, event.reason, contentEmitted);
          if (!recovered && prepared.compaction === undefined && this.#isRecoverableOverflow(error, request.signal)) {
            prepared = await this.#recoverPrepared(prepared, error);
            request.signal?.throwIfAborted();
            recovered = true;
            continue streamAttempt;
          }
          throw error;
        }

        contentEmitted = true;
        if (event.type === "text_delta") yield { type: "output_text_delta", delta: event.delta };
        if (event.type === "done") {
          if (prepared.contextTokens !== undefined) this.#contextEstimator.observe(prepared.context, event.message);
          const response = this.#prependCompaction(mapPiAssistantMessage(event.message), prepared);
          yield {
            type: "response_done",
            response: {
              id: response.responseId ?? localResponseId,
              ...(response.requestId ? { requestId: response.requestId } : {}),
              usage: {
                requests: response.usage.requests,
                inputTokens: response.usage.inputTokens,
                outputTokens: response.usage.outputTokens,
                totalTokens: response.usage.totalTokens,
                inputTokensDetails: response.usage.inputTokensDetails,
                outputTokensDetails: response.usage.outputTokensDetails,
              },
              output: response.output.map((item) => protocol.OutputModelItem.parse(item)),
            },
          };
          return;
        }
      }
      throw new Error("Codex transport ended without a response_done event");
    }
  }
}
