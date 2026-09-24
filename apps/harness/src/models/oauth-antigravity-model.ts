import { protocol, type Model as AgentsModel, type ModelRequest, type ModelResponse, type ResponseStreamEvent } from "@openai/agents-core";
import { streamSimple, type ApiKeyResolver, type AssistantMessageEvent, type Context, type Model as OmpModel, type ModelSpec, type ProviderSessionState, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createOAuthOnlyApiKeyResolver } from "../auth/oauth-only-resolver.ts";
import { mapAgentsRequest, mapPiAssistantMessage, type AgentsMappingOptions } from "./agents-mapping.ts";

export const ANTIGRAVITY_MODEL_NAME = "gemini-3.8-flash" as const;

// Upstream catalog/wire/gemini-headers.ts at the descriptor revision below.
// Gemini 3.8 effort routes require this client version; pinned pi-ai defaults
// to 2.1.4. Override only these requests, not global environment or auth state.
export const ANTIGRAVITY_HEADERS = Object.freeze({
  "User-Agent": "antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)",
});

// Exact upstream catalog descriptor at 3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec.
// The pinned catalog predates this model; its transport already supports effort routing.
const ANTIGRAVITY_MODEL_SPEC: ModelSpec<"google-gemini-cli"> = {
  id: ANTIGRAVITY_MODEL_NAME,
  name: "Gemini 3.8 Flash",
  api: "google-gemini-cli",
  provider: "google-antigravity",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1_048_576,
  maxTokens: 65_536,
  cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  requestModelId: "gemini-3.8-flash-low",
  thinking: {
    mode: "google-level",
    efforts: ["minimal", "low", "medium", "high"] as Effort[],
    requiresEffort: true,
    effortRouting: {
      minimal: "gemini-3.8-flash-low",
      low: "gemini-3.8-flash-low",
      medium: "gemini-3.8-flash-medium",
      high: "gemini-3.8-flash-high",
    },
  },
};
export const OMP_ANTIGRAVITY_MODEL: OmpModel<"google-gemini-cli"> = Object.freeze(buildModel(ANTIGRAVITY_MODEL_SPEC));
const MAPPING: AgentsMappingOptions = { api: "google-gemini-cli", provider: "google-antigravity", model: ANTIGRAVITY_MODEL_NAME };

export type AntigravityTransport = (model: OmpModel<"google-gemini-cli">, context: Context, options: SimpleStreamOptions) => AsyncIterable<AssistantMessageEvent>;
export interface OAuthAntigravityModelOptions {
  readonly transport?: AntigravityTransport;
  readonly resolverFactory?: (provider: "google-antigravity", sessionId: string, modelId: typeof ANTIGRAVITY_MODEL_NAME, signal?: AbortSignal) => ApiKeyResolver;
}

export class OAuthAntigravityModel implements AgentsModel {
  readonly #attemptSessionId: string;
  readonly #transport: AntigravityTransport;
  readonly #resolverFactory: NonNullable<OAuthAntigravityModelOptions["resolverFactory"]>;
  readonly #providerSessionState = new Map<string, ProviderSessionState>();
  #requestSequence = 0;

  constructor(attemptSessionId: string, options: OAuthAntigravityModelOptions = {}) {
    if (!attemptSessionId.trim()) throw new Error("attemptSessionId is required");
    this.#attemptSessionId = attemptSessionId;
    this.#transport = options.transport ?? ((model, context, streamOptions) => streamSimple(model, context, streamOptions));
    this.#resolverFactory = options.resolverFactory ?? createOAuthOnlyApiKeyResolver;
  }

  async *#events(request: ModelRequest): AsyncIterable<AssistantMessageEvent> {
    request.signal?.throwIfAborted();
    const { context, options } = mapAgentsRequest(request, MAPPING);
    const apiKey = this.#resolverFactory("google-antigravity", this.#attemptSessionId, ANTIGRAVITY_MODEL_NAME, request.signal);
    const streamOptions: SimpleStreamOptions = {
      ...options, apiKey, sessionId: this.#attemptSessionId, providerSessionState: this.#providerSessionState,
      headers: ANTIGRAVITY_HEADERS,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    for await (const event of this.#transport(OMP_ANTIGRAVITY_MODEL, context, streamOptions)) {
      request.signal?.throwIfAborted();
      if (event.type === "error") throw new Error(event.error.errorMessage ?? `Antigravity request ${event.reason}`);
      yield event;
      if (event.type === "done") return;
    }
    request.signal?.throwIfAborted();
    throw new Error("Antigravity transport ended without a completed response");
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    for await (const event of this.#events(request)) {
      if (event.type === "done") return mapPiAssistantMessage(event.message, MAPPING);
    }
    throw new Error("Antigravity transport ended without a completed response");
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<ResponseStreamEvent> {
    const localResponseId = `${this.#attemptSessionId}:${++this.#requestSequence}`;
    yield { type: "response_started" };
    for await (const event of this.#events(request)) {
      if (event.type === "text_delta") yield { type: "output_text_delta", delta: event.delta };
      if (event.type === "done") {
        const response = mapPiAssistantMessage(event.message, MAPPING);
        yield {
          type: "response_done",
          response: {
            id: response.responseId ?? localResponseId,
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
      }
    }
  }
}
