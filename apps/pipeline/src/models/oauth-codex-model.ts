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

export class OAuthCodexModel implements AgentsModel {
  readonly #attemptSessionId: string;
  readonly #transport: CodexTransport;
  readonly #resolverFactory: OAuthResolverFactory;
  #requestSequence = 0;

  constructor(attemptSessionId: string, options: OAuthCodexModelOptions = {}) {
    if (!attemptSessionId.trim()) throw new Error("attemptSessionId is required");
    this.#attemptSessionId = attemptSessionId;
    this.#transport = options.transport ?? ((model, context, streamOptions) => streamSimple(model, context, streamOptions));
    this.#resolverFactory = options.resolverFactory ?? createOAuthOnlyApiKeyResolver;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const { context, options } = mapAgentsRequest(request);
    const apiKey = this.#resolverFactory("openai-codex", this.#attemptSessionId, MODEL_NAME, request.signal);
    const transportOptions: SimpleStreamOptions = { ...options, apiKey, sessionId: this.#attemptSessionId, preferWebsockets: false, ...(request.signal ? { signal: request.signal } : {}) };
    const stream = this.#transport(OMP_CODEX_MODEL, context, transportOptions);
    let completed: AssistantMessage | undefined;
    for await (const event of stream) {
      if (event.type === "done") completed = event.message;
      if (event.type === "error") throw new Error(event.error.errorMessage ?? `Codex request ${event.reason}`);
    }
    if (!completed) throw new Error("Codex transport ended without a completed response");
    return mapPiAssistantMessage(completed);
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<ResponseStreamEvent> {
    const { context, options } = mapAgentsRequest(request);
    const apiKey = this.#resolverFactory("openai-codex", this.#attemptSessionId, MODEL_NAME, request.signal);
    const transportOptions: SimpleStreamOptions = { ...options, apiKey, sessionId: this.#attemptSessionId, preferWebsockets: false, ...(request.signal ? { signal: request.signal } : {}) };
    const stream = this.#transport(OMP_CODEX_MODEL, context, transportOptions);
    const localResponseId = `${this.#attemptSessionId}:${++this.#requestSequence}`;
    yield { type: "response_started" };
    for await (const event of stream) {
      if (event.type === "text_delta") yield { type: "output_text_delta", delta: event.delta };
      if (event.type === "error") throw new Error(event.error.errorMessage ?? `Codex request ${event.reason}`);
      if (event.type === "done") {
        const response = mapPiAssistantMessage(event.message);
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
