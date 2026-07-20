import type { AgentInputItem } from "@openai/agents-core";
import { MAX_AGENT_TRANSCRIPT_BYTES } from "./runner.ts";

export const APPLICATION_HISTORY_PRUNED_NOTICE: AgentInputItem = Object.freeze({
  role: "user",
  content: [{
    type: "input_text" as const,
    text: "Earlier browser_use calls and results were omitted to keep the application history within limits.",
  }],
});

export class ApplicationHistoryProjectionError extends Error {
  readonly code = "MODEL_PROVIDER_FAILED";

  constructor() {
    super("Application history exceeds the model transcript limit");
    this.name = "ApplicationHistoryProjectionError";
  }
}

function isBrowserCall(item: AgentInputItem): item is Extract<AgentInputItem, { type: "function_call" }> {
  return item.type === "function_call" && item.name === "browser_use";
}

function isCompletedBrowserResult(
  item: AgentInputItem,
): item is Extract<AgentInputItem, { type: "function_call_result" }> {
  return item.type === "function_call_result"
    && item.name === "browser_use"
    && item.status === "completed";
}

export function projectApplicationHistory(history: readonly AgentInputItem[]): AgentInputItem[] {
  const browserIndexes = new Set<number>();
  const callsById = new Map<string, number[]>();
  const completedResultsById = new Map<string, number[]>();

  for (const [index, item] of history.entries()) {
    if (isBrowserCall(item)) {
      browserIndexes.add(index);
      const calls = callsById.get(item.callId) ?? [];
      calls.push(index);
      callsById.set(item.callId, calls);
    } else if (item.type === "function_call_result" && item.name === "browser_use") {
      browserIndexes.add(index);
      if (isCompletedBrowserResult(item)) {
        const results = completedResultsById.get(item.callId) ?? [];
        results.push(index);
        completedResultsById.set(item.callId, results);
      }
    }
  }

  const completePairs: Array<readonly [callIndex: number, resultIndex: number]> = [];
  for (const [callId, callIndexes] of callsById) {
    if (callIndexes.length !== 1) continue;
    const callIndex = callIndexes[0]!;
    const followingResults = (completedResultsById.get(callId) ?? [])
      .filter((resultIndex) => resultIndex > callIndex);
    if (followingResults.length !== 1) continue;
    completePairs.push([callIndex, followingResults[0]!]);
  }
  completePairs.sort((left, right) => left[1] - right[1]);

  const retainedPairs = completePairs.slice(-16);
  const retainedBrowserIndexes = new Set<number>();
  for (const [callIndex, resultIndex] of retainedPairs) {
    retainedBrowserIndexes.add(callIndex);
    retainedBrowserIndexes.add(resultIndex);
  }

  const includedIndexes = new Set<number>();
  const serializedBytes: number[] = [];
  let includedItemBytes = 0;
  for (const [index, item] of history.entries()) {
    const serialized = JSON.stringify(item);
    if (serialized === undefined) throw new ApplicationHistoryProjectionError();
    const itemBytes = Buffer.byteLength(serialized);
    serializedBytes.push(itemBytes);
    if (!browserIndexes.has(index) || retainedBrowserIndexes.has(index)) {
      includedIndexes.add(index);
      includedItemBytes += itemBytes;
    }
  }

  let pruned = includedIndexes.size !== history.length;
  const serializedNotice = JSON.stringify(APPLICATION_HISTORY_PRUNED_NOTICE);
  const noticeBytes = Buffer.byteLength(serializedNotice);
  let projectedBytes = 2
    + includedItemBytes
    + Math.max(0, includedIndexes.size - 1)
    + (pruned ? noticeBytes + (includedIndexes.size === 0 ? 0 : 1) : 0);

  for (const [callIndex, resultIndex] of retainedPairs) {
    if (projectedBytes <= MAX_AGENT_TRANSCRIPT_BYTES) break;
    if (!pruned) {
      pruned = true;
      projectedBytes += noticeBytes + (includedIndexes.size === 0 ? 0 : 1);
    }
    includedIndexes.delete(callIndex);
    includedIndexes.delete(resultIndex);
    includedItemBytes -= serializedBytes[callIndex]! + serializedBytes[resultIndex]!;
    projectedBytes = 2
      + includedItemBytes
      + Math.max(0, includedIndexes.size - 1)
      + noticeBytes
      + (includedIndexes.size === 0 ? 0 : 1);
  }

  if (projectedBytes > MAX_AGENT_TRANSCRIPT_BYTES) {
    throw new ApplicationHistoryProjectionError();
  }

  const projected = history.filter((_item, index) => includedIndexes.has(index));
  return pruned ? [APPLICATION_HISTORY_PRUNED_NOTICE, ...projected] : projected;
}
