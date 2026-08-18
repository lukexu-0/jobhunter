import type { AgentInputItem } from "@openai/agents-core";
import { parseCodexBridge, type CodexBridge } from "../models/agents-mapping.ts";

export const MAX_APPLICATION_AGENT_TRANSCRIPT_BYTES = 10_485_760;
export const APPLICATION_HISTORY_PRUNED_NOTICE: AgentInputItem = Object.freeze({
  role: "user",
  content: [{
    type: "input_text" as const,
    text: "Earlier playwright_cli calls and results were omitted to keep the application history within limits.",
  }],
});

export class ApplicationHistoryProjectionError extends Error {
  readonly code = "MODEL_PROVIDER_FAILED";

  constructor() {
    super("Application history exceeds the model transcript limit");
    this.name = "ApplicationHistoryProjectionError";
  }
}

function isPlaywrightCliCall(
  item: AgentInputItem,
): item is Extract<AgentInputItem, { type: "function_call" }> {
  return item.type === "function_call" && item.name === "playwright_cli";
}

function isCompletedPlaywrightCliResult(
  item: AgentInputItem,
): item is Extract<AgentInputItem, { type: "function_call_result" }> {
  return item.type === "function_call_result"
    && item.name === "playwright_cli"
    && item.status === "completed";
}

function isNativeAssistantItem(item: AgentInputItem): boolean {
  return item.type === "function_call"
    || item.type === "reasoning"
    || item.type === "compaction"
    || ((item.type === "message" || item.type === undefined) && item.role === "assistant");
}

interface NativeHistoryGroup {
  readonly memberIndexes: number[];
  readonly playwrightCliCallIndexes: number[];
}

type CompletePlaywrightCliPair = readonly [callIndex: number, resultIndex: number];

export function projectApplicationHistory(history: readonly AgentInputItem[]): AgentInputItem[] {
  const bridges: (CodexBridge | undefined)[] = [];
  let nativeCoverageActive = false;
  for (const item of history) {
    let bridge: CodexBridge | undefined;
    try {
      bridge = parseCodexBridge(item.providerData, "Application history provider data");
    } catch {
      throw new ApplicationHistoryProjectionError();
    }
    if (bridge?.kind === "history") {
      if (!isNativeAssistantItem(item)) throw new ApplicationHistoryProjectionError();
      nativeCoverageActive = true;
    } else if (bridge?.kind === "covered") {
      if (!nativeCoverageActive || !isNativeAssistantItem(item)) {
        throw new ApplicationHistoryProjectionError();
      }
    } else {
      nativeCoverageActive = false;
    }
    bridges.push(bridge);
  }

  let projectionStartIndex = 0;
  for (const [index, bridge] of bridges.entries()) {
    if (bridge?.kind === "history" && bridge.payload.dt === false) {
      projectionStartIndex = index;
    }
  }

  const playwrightCliIndexes = new Set<number>();
  const callsById = new Map<string, number[]>();
  const completedResultsById = new Map<string, number[]>();
  const nativeGroups: NativeHistoryGroup[] = [];
  const nativeGroupByPlaywrightCliCallIndex = new Map<number, NativeHistoryGroup>();
  let activeNativeGroup: NativeHistoryGroup | undefined;

  for (let index = projectionStartIndex; index < history.length; index += 1) {
    const item = history[index]!;
    const bridge = bridges[index];

    if (bridge?.kind === "history") {
      if (!isNativeAssistantItem(item)) throw new ApplicationHistoryProjectionError();
      activeNativeGroup = { memberIndexes: [index], playwrightCliCallIndexes: [] };
      nativeGroups.push(activeNativeGroup);
    } else if (bridge?.kind === "covered") {
      if (activeNativeGroup === undefined || !isNativeAssistantItem(item)) {
        throw new ApplicationHistoryProjectionError();
      }
      activeNativeGroup.memberIndexes.push(index);
    } else {
      activeNativeGroup = undefined;
    }

    if (isPlaywrightCliCall(item)) {
      playwrightCliIndexes.add(index);
      const calls = callsById.get(item.callId) ?? [];
      calls.push(index);
      callsById.set(item.callId, calls);
      if (activeNativeGroup !== undefined) {
        activeNativeGroup.playwrightCliCallIndexes.push(index);
        nativeGroupByPlaywrightCliCallIndex.set(index, activeNativeGroup);
      }
    } else if (item.type === "function_call_result" && item.name === "playwright_cli") {
      playwrightCliIndexes.add(index);
      if (isCompletedPlaywrightCliResult(item)) {
        const results = completedResultsById.get(item.callId) ?? [];
        results.push(index);
        completedResultsById.set(item.callId, results);
      }
    }
  }

  const completePairs: CompletePlaywrightCliPair[] = [];
  const completePairByCallIndex = new Map<number, CompletePlaywrightCliPair>();
  for (const [callId, callIndexes] of callsById) {
    if (callIndexes.length !== 1) continue;
    const callIndex = callIndexes[0]!;
    const followingResults = (completedResultsById.get(callId) ?? [])
      .filter((resultIndex) => resultIndex > callIndex);
    if (followingResults.length !== 1) continue;
    const pair = [callIndex, followingResults[0]!] as const;
    completePairs.push(pair);
    completePairByCallIndex.set(callIndex, pair);
  }
  completePairs.sort((left, right) => left[1] - right[1]);

  const retainedPairs = completePairs.slice(-16);
  const retainedPlaywrightCliIndexes = new Set<number>();
  for (const [callIndex, resultIndex] of retainedPairs) {
    retainedPlaywrightCliIndexes.add(callIndex);
    retainedPlaywrightCliIndexes.add(resultIndex);
  }

  const includedIndexes = new Set<number>();
  const serializedBytes: number[] = [];
  let includedItemBytes = 0;
  for (let index = projectionStartIndex; index < history.length; index += 1) {
    const item = history[index]!;
    const serialized = JSON.stringify(item);
    if (serialized === undefined) throw new ApplicationHistoryProjectionError();
    const itemBytes = Buffer.byteLength(serialized);
    serializedBytes.push(itemBytes);
    if (!playwrightCliIndexes.has(index) || retainedPlaywrightCliIndexes.has(index)) {
      includedIndexes.add(index);
      includedItemBytes += itemBytes;
    }
  }

  const removeIncludedIndex = (index: number): void => {
    if (includedIndexes.delete(index)) {
      includedItemBytes -= serializedBytes[index - projectionStartIndex]!;
    }
  };
  const removeNativeGroup = (group: NativeHistoryGroup): void => {
    for (const index of group.memberIndexes) removeIncludedIndex(index);
    for (const callIndex of group.playwrightCliCallIndexes) {
      const pair = completePairByCallIndex.get(callIndex);
      if (pair !== undefined) removeIncludedIndex(pair[1]);
    }
  };

  for (const group of nativeGroups) {
    let retainGroup = true;
    for (const callIndex of group.playwrightCliCallIndexes) {
      if (!retainedPlaywrightCliIndexes.has(callIndex)) {
        retainGroup = false;
        break;
      }
    }
    if (!retainGroup) removeNativeGroup(group);
  }

  let pruned = includedIndexes.size !== history.length - projectionStartIndex;
  const serializedNotice = JSON.stringify(APPLICATION_HISTORY_PRUNED_NOTICE);
  const noticeBytes = Buffer.byteLength(serializedNotice);
  let projectedBytes = 2
    + includedItemBytes
    + Math.max(0, includedIndexes.size - 1)
    + (pruned ? noticeBytes + (includedIndexes.size === 0 ? 0 : 1) : 0);

  for (const [callIndex, resultIndex] of retainedPairs) {
    if (projectedBytes <= MAX_APPLICATION_AGENT_TRANSCRIPT_BYTES) break;
    if (!pruned) {
      pruned = true;
      projectedBytes += noticeBytes + (includedIndexes.size === 0 ? 0 : 1);
    }
    const nativeGroup = nativeGroupByPlaywrightCliCallIndex.get(callIndex);
    if (nativeGroup === undefined) {
      removeIncludedIndex(callIndex);
      removeIncludedIndex(resultIndex);
    } else {
      removeNativeGroup(nativeGroup);
    }
    projectedBytes = 2
      + includedItemBytes
      + Math.max(0, includedIndexes.size - 1)
      + noticeBytes
      + (includedIndexes.size === 0 ? 0 : 1);
  }

  if (projectedBytes > MAX_APPLICATION_AGENT_TRANSCRIPT_BYTES) {
    throw new ApplicationHistoryProjectionError();
  }

  const projected = history.filter((_item, index) => includedIndexes.has(index));
  return pruned ? [APPLICATION_HISTORY_PRUNED_NOTICE, ...projected] : projected;
}
