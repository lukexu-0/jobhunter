import { describe, expect, test } from "bun:test";
import type { AgentInputItem } from "@openai/agents-core";
import {
  APPLICATION_HISTORY_PRUNED_NOTICE,
  ApplicationHistoryProjectionError,
  projectApplicationHistory,
} from "../src/agents/application-history.ts";
import { MAX_AGENT_TRANSCRIPT_BYTES } from "../src/agents/runner.ts";
type FunctionCallItem = Extract<AgentInputItem, { type: "function_call" }>;
type FunctionCallResultItem = Extract<AgentInputItem, { type: "function_call_result" }>;

function isPlaywrightCliCall(item: AgentInputItem): item is FunctionCallItem {
  return item.type === "function_call" && item.name === "playwright_cli";
}

function isPlaywrightCliResult(item: AgentInputItem): item is FunctionCallResultItem {
  return item.type === "function_call_result" && item.name === "playwright_cli";
}


function user(text: string): AgentInputItem {
  return { role: "user", content: [{ type: "input_text", text }] };
}

function otherCall(callId: string): AgentInputItem {
  return { type: "function_call", name: "other_tool", callId, arguments: "{}", status: "completed" };
}

function otherResult(callId: string): AgentInputItem {
  return { type: "function_call_result", name: "other_tool", callId, output: "ok", status: "completed" };
}

function playwrightCliCall(callId: string, payload = ""): FunctionCallItem {
  return {
    type: "function_call",
    name: "playwright_cli",
    callId,
    arguments: JSON.stringify({
      command: "snapshot",
      args: payload === "" ? [] : [payload],
    }),
    status: "completed",
  };
}

function playwrightCliResult(
  callId: string,
  output = "ok",
  status: "completed" | "in_progress" | "incomplete" = "completed",
): FunctionCallResultItem {
  return { type: "function_call_result", name: "playwright_cli", callId, output, status };
}

function nativePlaywrightCliGroup(callId: string, dt = true): readonly [
  anchor: AgentInputItem,
  coveredCall: AgentInputItem,
  result: AgentInputItem,
] {
  const visibleCall = playwrightCliCall(callId);
  return [
    {
      type: "reasoning",
      id: "reason-native",
      content: [{ type: "input_text", text: "Inspected the application form." }],
      rawContent: [{ type: "reasoning_text", text: "Inspected the application form." }],
      providerData: {
        jobhunterCodex: {
          version: 1,
          kind: "history",
          payload: {
            type: "openaiResponsesHistory",
            provider: "openai-codex",
            dt,
            items: [
              { type: "reasoning", encrypted_content: "encrypted-reasoning", summary: [] },
              {
                type: "function_call",
                call_id: callId,
                name: "playwright_cli",
                arguments: visibleCall.arguments,
              },
            ],
          },
        },
      },
    },
    {
      ...visibleCall,
      providerData: { jobhunterCodex: { version: 1, kind: "covered" } },
    },
    playwrightCliResult(callId),
  ];
}

describe("projectApplicationHistory", () => {
  test("names the pruned Playwright CLI history in the model-visible notice", () => {
    expect(APPLICATION_HISTORY_PRUNED_NOTICE).toEqual({
      role: "user",
      content: [{
        type: "input_text",
        text: "Earlier playwright_cli calls and results were omitted to keep the application history within limits.",
      }],
    });
  });

  test("preserves non-browser items in order without mutating the input", () => {
    const first = user("first");
    const call = otherCall("other-1");
    const result = otherResult("other-1");
    const last = user("last");
    const history: readonly AgentInputItem[] = Object.freeze([first, call, result, last]);

    const projected = projectApplicationHistory(history);

    expect(projected).toEqual([first, call, result, last]);
    expect(projected).not.toBe(history);
    expect(projected[0]).toBe(first);
    expect(projected[1]).toBe(call);
    expect(projected[2]).toBe(result);
    expect(projected[3]).toBe(last);
    expect(history).toEqual([first, call, result, last]);
  });

  test("keeps only unambiguous completed Playwright CLI call/result pairs", () => {
    const before = user("before");
    const validCall = playwrightCliCall("valid");
    const between = user("between");
    const validResult = playwrightCliResult("valid");
    const after = user("after");
    const history = [
      playwrightCliResult("before-call"),
      before,
      playwrightCliCall("orphan-call"),
      playwrightCliResult("orphan-result"),
      playwrightCliCall("incomplete"),
      playwrightCliResult("incomplete", "not done", "incomplete"),
      playwrightCliCall("duplicate-call"),
      playwrightCliCall("duplicate-call"),
      playwrightCliResult("duplicate-call"),
      playwrightCliCall("duplicate-result"),
      playwrightCliResult("duplicate-result", "first"),
      playwrightCliResult("duplicate-result", "second"),
      playwrightCliCall("before-call"),
      validCall,
      between,
      validResult,
      after,
    ] satisfies readonly AgentInputItem[];

    const projected = projectApplicationHistory(history);

    expect(projected).toEqual([
      APPLICATION_HISTORY_PRUNED_NOTICE,
      before,
      validCall,
      between,
      validResult,
      after,
    ]);
    expect(projected.filter((item) => item === APPLICATION_HISTORY_PRUNED_NOTICE)).toHaveLength(1);
    expect(history).toHaveLength(17);
  });

  test("retains the newest sixteen complete Playwright CLI pairs", () => {
    const marker = user("preserved");
    const history: AgentInputItem[] = [marker];
    for (let index = 0; index < 18; index += 1) {
      history.push(playwrightCliCall(`call-${index}`), playwrightCliResult(`call-${index}`));
    }

    const projected = projectApplicationHistory(history);
    const retainedCallIds = projected
      .filter(isPlaywrightCliCall)
      .map((item) => item.callId);
    const retainedResultIds = projected
      .filter(isPlaywrightCliResult)
      .map((item) => item.callId);

    expect(retainedCallIds).toEqual([
      "call-2", "call-3", "call-4", "call-5", "call-6", "call-7", "call-8", "call-9",
      "call-10", "call-11", "call-12", "call-13", "call-14", "call-15", "call-16", "call-17",
    ]);
    expect(retainedResultIds).toEqual(retainedCallIds);
    expect(projected[0]).toBe(APPLICATION_HISTORY_PRUNED_NOTICE);
    expect(projected[1]).toBe(marker);
    expect(projected).toHaveLength(34);
  });

  test("prunes a native Codex Playwright response group atomically", () => {
    const [anchor, coveredCall, matchingResult] = nativePlaywrightCliGroup("native-oldest");
    const newerPairs: AgentInputItem[] = [];
    for (let index = 0; index < 16; index += 1) {
      newerPairs.push(
        playwrightCliCall(`newer-${index}`),
        playwrightCliResult(`newer-${index}`),
      );
    }
    const history = [
      anchor,
      coveredCall,
      matchingResult,
      ...newerPairs,
    ] satisfies readonly AgentInputItem[];

    const projected = projectApplicationHistory(history);

    expect(projected.includes(anchor)).toBe(false);
    expect(projected.includes(coveredCall)).toBe(false);
    expect(projected.includes(matchingResult)).toBe(false);
    expect(projected).toEqual([APPLICATION_HISTORY_PRUNED_NOTICE, ...newerPairs]);
    expect(projected.filter((item) => item === APPLICATION_HISTORY_PRUNED_NOTICE)).toHaveLength(1);
  });

  test("prunes oldest Playwright CLI pairs atomically to the byte limit with one notice", () => {
    const largeOutput = "ø".repeat(275_000);
    const oldestCall = playwrightCliCall("oldest", largeOutput);
    const oldestResult = playwrightCliResult("oldest", largeOutput);
    const newestCall = playwrightCliCall("newest", largeOutput);
    const newestResult = playwrightCliResult("newest", largeOutput);
    const marker = user("preserve me");
    const history = [
      oldestCall,
      marker,
      oldestResult,
      newestCall,
      newestResult,
    ] satisfies readonly AgentInputItem[];
    expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(MAX_AGENT_TRANSCRIPT_BYTES);

    const projected = projectApplicationHistory(history);

    expect(projected).toEqual([
      APPLICATION_HISTORY_PRUNED_NOTICE,
      marker,
      newestCall,
      newestResult,
    ]);
    expect(projected.includes(oldestCall)).toBe(false);
    expect(projected.includes(oldestResult)).toBe(false);
    expect(projected.filter((item) => item === APPLICATION_HISTORY_PRUNED_NOTICE)).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(MAX_AGENT_TRANSCRIPT_BYTES);
  });

  test("treats the latest non-delta native Codex history as a replacement window", () => {
    const obsoletePrefix = user("x".repeat(MAX_AGENT_TRANSCRIPT_BYTES));
    const [anchor, coveredCall, matchingResult] = nativePlaywrightCliGroup(
      "native-replacement",
      false,
    );
    const suffix = user("continue from the replacement history");
    const history = [
      obsoletePrefix,
      anchor,
      coveredCall,
      matchingResult,
      suffix,
    ] satisfies readonly AgentInputItem[];
    expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(MAX_AGENT_TRANSCRIPT_BYTES);

    const projected = projectApplicationHistory(history);

    expect(projected).toEqual([anchor, coveredCall, matchingResult, suffix]);
    expect(projected[0]).toBe(anchor);
    expect(projected[3]).toBe(suffix);
    expect(projected.includes(obsoletePrefix)).toBe(false);
    expect(projected.includes(APPLICATION_HISTORY_PRUNED_NOTICE)).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(
      MAX_AGENT_TRANSCRIPT_BYTES,
    );
  });

  test("fails with the dedicated provider error when preserved non-browser history overflows", () => {
    const oversized = user("x".repeat(MAX_AGENT_TRANSCRIPT_BYTES));

    expect(() => projectApplicationHistory([oversized])).toThrow(ApplicationHistoryProjectionError);
    try {
      projectApplicationHistory([oversized]);
      throw new Error("expected projection to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationHistoryProjectionError);
      expect((error as ApplicationHistoryProjectionError).code).toBe("MODEL_PROVIDER_FAILED");
      expect((error as Error).message).toBe("Application history exceeds the model transcript limit");
    }
  });
});
