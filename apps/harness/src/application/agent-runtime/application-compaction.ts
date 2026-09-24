import { isDeepStrictEqual } from "node:util";
import type { AgentInputItem } from "@openai/agents-core";
import {
  completeSimple,
  type ApiKey,
  type FetchImpl,
} from "@oh-my-pi/pi-ai";
import {
  compact,
  prepareCompaction,
  renderCompactionSummaryContext,
  shouldCompact,
  type CompactionDetails,
  type CompactionEntry,
  type CompactionSettings,
  type SessionEntry,
  type SummaryOptions,
} from "@oh-my-pi/pi-agent-core/compaction";
import { countTokens } from "@oh-my-pi/pi-agent-core/tokenizer";
import { ANTIGRAVITY_SYSTEM_INSTRUCTION } from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import { createOAuthOnlyApiKeyResolver } from "../../auth/oauth-only-resolver.ts";
import {
  ANTIGRAVITY_HEADERS,
  ANTIGRAVITY_MODEL_NAME,
  OMP_ANTIGRAVITY_MODEL,
} from "../../models/oauth-antigravity-model.ts";
import {
  mapAgentsInputEntries,
  type AgentsMappingOptions,
} from "../../models/agents-mapping.ts";

export const GEMINI_LOCAL_COMPACTION_THRESHOLD_TOKENS = 252_000;
const GEMINI_LOCAL_COMPACTION_KEEP_RECENT_TOKENS = 20_000;
const ANTIGRAVITY_MAPPING: AgentsMappingOptions = Object.freeze({
  api: "google-gemini-cli",
  provider: "google-antigravity",
  model: ANTIGRAVITY_MODEL_NAME,
});
const COMPACTION_SETTINGS: CompactionSettings = Object.freeze({
  enabled: true,
  strategy: "context-full",
  thresholdTokens: GEMINI_LOCAL_COMPACTION_THRESHOLD_TOKENS,
  midTurnEnabled: true,
  keepRecentTokens: GEMINI_LOCAL_COMPACTION_KEEP_RECENT_TOKENS,
  autoContinue: true,
  remoteEnabled: false,
  remoteStreamingV2Enabled: false,
});
const completeAntigravityCompaction: NonNullable<SummaryOptions["completeImpl"]> = (
  model,
  context,
  options,
) => completeSimple(model, context, {
  ...options,
  headers: { ...options.headers, ...ANTIGRAVITY_HEADERS },
});

interface GeminiCompactionState {
  readonly id: string;
  readonly timestamp: string;
  readonly summary: string;
  readonly summaryInput: AgentInputItem;
  readonly shortSummary?: string;
  readonly firstKeptEntryId: string;
  readonly sourceInput: AgentInputItem[];
  readonly firstKeptInputIndex: number;
  readonly tokensBefore: number;
  readonly details?: CompactionDetails;
  readonly preserveData?: Record<string, unknown>;
}

interface GeminiInputProjection {
  readonly input: AgentInputItem[];
  readonly sourceIndexes: number[];
}

export interface GeminiHistoryCompactorOptions {
  readonly apiKey?: ApiKey;
  readonly completeImpl?: SummaryOptions["completeImpl"];
  readonly fetch?: FetchImpl;
}

function estimateTokens(value: unknown, ancestors = new Set<object>()): number {
  if (value === null || value === undefined) return 1;
  if (typeof value === "string") return countTokens(value) + 1;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return countTokens(String(value));
  }
  if (typeof value !== "object") return 0;
  if (ancestors.has(value)) return 0;
  ancestors.add(value);
  let tokens = 1;
  if (Array.isArray(value)) {
    for (const item of value) tokens += estimateTokens(item, ancestors) + 1;
  } else {
    for (const [key, item] of Object.entries(value)) {
      tokens += countTokens(key) + estimateTokens(item, ancestors) + 1;
    }
  }
  ancestors.delete(value);
  return tokens;
}

export function estimateGeminiApplicationRequestTokens(
  input: AgentInputItem[],
  instructions: string | undefined,
  tools: readonly unknown[],
): number {
  const messages = mapAgentsInputEntries(input, Date.now(), ANTIGRAVITY_MAPPING)
    .map((entry) => entry.message);
  return estimateTokens({
    systemPrompt: [
      ANTIGRAVITY_SYSTEM_INSTRUCTION,
      ...(instructions === undefined || instructions.length === 0 ? [] : [instructions]),
    ],
    messages,
    ...(tools.length === 0 ? {} : { tools }),
  });
}

export class GeminiHistoryCompactor {
  readonly #sessionId: string;
  readonly #configuredApiKey: ApiKey | undefined;
  readonly #completeImpl: NonNullable<SummaryOptions["completeImpl"]>;
  readonly #fetch: FetchImpl | undefined;
  #state: GeminiCompactionState | undefined;
  #compactionSequence = 0;

  constructor(sessionId: string, options: GeminiHistoryCompactorOptions = {}) {
    if (!sessionId.trim()) throw new Error("sessionId is required");
    this.#sessionId = sessionId;
    this.#configuredApiKey = options.apiKey;
    this.#completeImpl = options.completeImpl ?? completeAntigravityCompaction;
    this.#fetch = options.fetch;
  }

  #inputProjection(
    input: AgentInputItem[],
    state: GeminiCompactionState | undefined,
  ): GeminiInputProjection {
    if (state === undefined) {
      return { input, sourceIndexes: input.map((_item, index) => index) };
    }
    const projectedInput: AgentInputItem[] = [];
    const sourceIndexes: number[] = [];
    let previousSourceIndex = 0;
    for (const [inputIndex, item] of input.entries()) {
      let coveredSourceIndex = -1;
      let matchedSourceIndex = -1;
      for (let sourceIndex = previousSourceIndex; sourceIndex < state.sourceInput.length; sourceIndex += 1) {
        const sourceItem = state.sourceInput[sourceIndex];
        if (sourceItem !== item && !isDeepStrictEqual(sourceItem, item)) continue;
        if (sourceIndex >= state.firstKeptInputIndex) {
          matchedSourceIndex = sourceIndex;
          break;
        }
        if (coveredSourceIndex < 0) coveredSourceIndex = sourceIndex;
      }
      if (matchedSourceIndex < 0) matchedSourceIndex = coveredSourceIndex;
      if (matchedSourceIndex >= 0) previousSourceIndex = matchedSourceIndex + 1;
      if (matchedSourceIndex >= 0 && matchedSourceIndex < state.firstKeptInputIndex) continue;
      projectedInput.push(item);
      sourceIndexes.push(inputIndex);
    }
    return { input: projectedInput, sourceIndexes };
  }

  #project(
    projection: GeminiInputProjection,
    state: GeminiCompactionState | undefined,
  ): AgentInputItem[] {
    if (state === undefined) return projection.input;
    return [state.summaryInput, ...projection.input];
  }

  #sessionEntries(
    projection: GeminiInputProjection,
    state: GeminiCompactionState | undefined,
  ): { readonly entries: SessionEntry[]; readonly inputIndexes: ReadonlyMap<string, number> } {
    const timestamp = new Date().toISOString();
    const entries: SessionEntry[] = [];
    const inputIndexes = new Map<string, number>();
    let parentId: string | null = null;
    if (state !== undefined) {
      const compactionEntry: CompactionEntry<CompactionDetails> = {
        type: "compaction",
        id: state.id,
        parentId,
        timestamp: state.timestamp,
        summary: state.summary,
        ...(state.shortSummary === undefined ? {} : { shortSummary: state.shortSummary }),
        firstKeptEntryId: state.firstKeptEntryId,
        tokensBefore: state.tokensBefore,
        ...(state.details === undefined ? {} : { details: state.details }),
        ...(state.preserveData === undefined ? {} : { preserveData: state.preserveData }),
      };
      entries.push(compactionEntry);
      parentId = compactionEntry.id;
    }
    const mappedInput = mapAgentsInputEntries(
      projection.input,
      Date.now(),
      ANTIGRAVITY_MAPPING,
    );
    for (const mapped of mappedInput) {
      const inputIndex = projection.sourceIndexes[mapped.inputIndex];
      if (inputIndex === undefined) throw new Error("Gemini compaction lost a history source index");
      const id = "input:" + inputIndex;
      entries.push({
        type: "message",
        id,
        parentId,
        timestamp,
        message: mapped.message,
      });
      inputIndexes.set(id, inputIndex);
      parentId = id;
    }
    return { entries, inputIndexes };
  }

  async project(
    input: AgentInputItem[],
    contextTokens?: number,
    signal?: AbortSignal,
  ): Promise<AgentInputItem[]> {
    const state = this.#state;
    const projection = this.#inputProjection(input, state);
    const projected = this.#project(projection, state);
    if (
      contextTokens === undefined
      || !shouldCompact(
        contextTokens,
        OMP_ANTIGRAVITY_MODEL.contextWindow ?? 0,
        COMPACTION_SETTINGS,
      )
    ) {
      return projected;
    }

    const { entries, inputIndexes } = this.#sessionEntries(projection, state);
    const preparation = prepareCompaction(entries, COMPACTION_SETTINGS, [OMP_ANTIGRAVITY_MODEL]);
    if (preparation === undefined) return projected;

    const apiKey = this.#configuredApiKey ?? createOAuthOnlyApiKeyResolver(
      "google-antigravity",
      this.#sessionId,
      ANTIGRAVITY_MODEL_NAME,
      signal,
    );
    const result = await compact(
      preparation,
      OMP_ANTIGRAVITY_MODEL,
      apiKey,
      undefined,
      signal,
      {
        sessionId: this.#sessionId,
        completeImpl: this.#completeImpl,
        ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
      },
    );
    const firstKeptInputIndex = inputIndexes.get(result.firstKeptEntryId);
    if (firstKeptInputIndex === undefined || input[firstKeptInputIndex] === undefined) {
      throw new Error("Gemini compaction returned an unknown history boundary");
    }
    const compactedSummaryInput: AgentInputItem = {
      role: "user",
      content: [{
        type: "input_text",
        text: renderCompactionSummaryContext(result.summary),
      }],
    };
    this.#state = {
      id: `compaction:${++this.#compactionSequence}`,
      timestamp: new Date().toISOString(),
      summary: result.summary,
      summaryInput: compactedSummaryInput,
      ...(result.shortSummary === undefined ? {} : { shortSummary: result.shortSummary }),
      firstKeptEntryId: result.firstKeptEntryId,
      sourceInput: input,
      firstKeptInputIndex,
      tokensBefore: contextTokens,
      ...(result.details === undefined ? {} : { details: result.details as CompactionDetails }),
      ...(result.preserveData === undefined ? {} : { preserveData: result.preserveData }),
    };
    const compactedProjection = this.#inputProjection(input, this.#state);
    return this.#project(compactedProjection, this.#state);
  }
}
