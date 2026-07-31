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
import type { Effort } from "@oh-my-pi/pi-catalog";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createOAuthOnlyApiKeyResolver } from "../auth/oauth-only-resolver";
import { mapAgentsRequest, mapPiAssistantMessage } from "./agents-mapping";

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
  readonly compaction?: {
    readonly output: ModelResponse["output"][number];
    readonly usage: ModelResponse["usage"];
  };
}

function estimateInputTokens(context: Context): number {
  const serialized = JSON.stringify(context);
  if (serialized === undefined) throw new Error("Codex context cannot be serialized for compaction");
  return Math.max(1, Math.ceil(new TextEncoder().encode(serialized).byteLength / 4));
}


export class OAuthCodexModel implements AgentsModel {
  readonly #attemptSessionId: string;
  readonly #transport: CodexTransport;
  readonly #resolverFactory: OAuthResolverFactory;
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
    for await (const event of this.#transport(OMP_CODEX_MODEL, context, options)) {
      if (event.type === "done") completed = event.message;
      if (event.type === "error") throw new Error(event.error.errorMessage ?? `Codex request ${event.reason}`);
    }
    if (!completed) throw new Error("Codex transport ended without a completed response");
    return completed;
  }

  async #prepareCall(request: ModelRequest): Promise<PreparedCodexCall> {
    const { context, options, compactThreshold } = mapAgentsRequest(request);
    const apiKey = this.#resolverFactory("openai-codex", this.#attemptSessionId, MODEL_NAME, request.signal);
    const transportOptions: SimpleStreamOptions = {
      ...options,
      apiKey,
      sessionId: this.#attemptSessionId,
      preferWebsockets: false,
      ...(request.signal ? { signal: request.signal } : {}),
    };
    if (compactThreshold === undefined || estimateInputTokens(context) < compactThreshold) {
      return { context, transportOptions };
    }

    const operationId = `${this.#attemptSessionId}:pre-turn:${++this.#compactionSequence}`;
    const compacted = await this.#completedResponse(context, {
      ...transportOptions,
      codexCompaction: {
        operationId,
        trigger: "auto",
        reason: "context_limit",
        implementation: "responses_compaction_v2",
        phase: "pre_turn",
        strategy: "prefix_compaction",
      },
    });
    const rawCompactionResponse = mapPiAssistantMessage(compacted);
    const rawCompactionOutput = rawCompactionResponse.output.filter((item) => item.type === "compaction");
    if (
      compacted.providerPayload === undefined
      || compacted.providerPayload.dt !== true
      || rawCompactionOutput.length !== 1
    ) {
      throw new Error("Codex pre-turn compaction returned no unique native compaction item");
    }
    const replacementMessage: AssistantMessage = {
      ...compacted,
      providerPayload: { ...compacted.providerPayload, dt: false },
    };
    const replacementResponse = mapPiAssistantMessage(replacementMessage);
    const replacementOutput = replacementResponse.output.filter((item) => item.type === "compaction");
    if (replacementOutput.length !== 1 || replacementOutput[0] === undefined) {
      throw new Error("Codex pre-turn compaction could not construct replacement history");
    }
    return {
      context: { ...context, messages: [...context.messages, replacementMessage] },
      transportOptions,
      compaction: { output: replacementOutput[0], usage: replacementResponse.usage },
    };
  }

  #prependCompaction(response: ModelResponse, prepared: PreparedCodexCall): ModelResponse {
    if (prepared.compaction === undefined) return response;
    prepared.compaction.usage.add(response.usage);
    return {
      ...response,
      usage: prepared.compaction.usage,
      output: [prepared.compaction.output, ...response.output],
    };
  }


  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const prepared = await this.#prepareCall(request);
    const completed = await this.#completedResponse(prepared.context, prepared.transportOptions);
    return this.#prependCompaction(mapPiAssistantMessage(completed), prepared);
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<ResponseStreamEvent> {
    const prepared = await this.#prepareCall(request);
    const stream = this.#transport(OMP_CODEX_MODEL, prepared.context, prepared.transportOptions);
    const localResponseId = `${this.#attemptSessionId}:${++this.#requestSequence}`;
    yield { type: "response_started" };
    for await (const event of stream) {
      if (event.type === "text_delta") yield { type: "output_text_delta", delta: event.delta };
      if (event.type === "error") throw new Error(event.error.errorMessage ?? `Codex request ${event.reason}`);
      if (event.type === "done") {
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
