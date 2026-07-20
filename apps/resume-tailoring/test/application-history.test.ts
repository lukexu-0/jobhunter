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

function isBrowserCall(item: AgentInputItem): item is FunctionCallItem {
  return item.type === "function_call" && item.name === "browser_use";
}

function isBrowserResult(item: AgentInputItem): item is FunctionCallResultItem {
  return item.type === "function_call_result" && item.name === "browser_use";
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

function browserCall(callId: string, payload = ""): AgentInputItem {
  return {
    type: "function_call",
    name: "browser_use",
    callId,
    arguments: JSON.stringify({ code: payload }),
    status: "completed",
  };
}

function browserResult(
  callId: string,
  output = "ok",
  status: "completed" | "in_progress" | "incomplete" = "completed",
): AgentInputItem {
  return { type: "function_call_result", name: "browser_use", callId, output, status };
}

describe("projectApplicationHistory", () => {
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

  test("keeps only unambiguous completed browser call/result pairs", () => {
    const before = user("before");
    const validCall = browserCall("valid");
    const between = user("between");
    const validResult = browserResult("valid");
    const after = user("after");
    const history = [
      browserResult("before-call"),
      before,
      browserCall("orphan-call"),
      browserResult("orphan-result"),
      browserCall("incomplete"),
      browserResult("incomplete", "not done", "incomplete"),
      browserCall("duplicate-call"),
      browserCall("duplicate-call"),
      browserResult("duplicate-call"),
      browserCall("duplicate-result"),
      browserResult("duplicate-result", "first"),
      browserResult("duplicate-result", "second"),
      browserCall("before-call"),
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

  test("retains the newest sixteen complete browser pairs", () => {
    const marker = user("preserved");
    const history: AgentInputItem[] = [marker];
    for (let index = 0; index < 18; index += 1) {
      history.push(browserCall(`call-${index}`), browserResult(`call-${index}`));
    }

    const projected = projectApplicationHistory(history);
    const retainedCallIds = projected
      .filter(isBrowserCall)
      .map((item) => item.callId);
    const retainedResultIds = projected
      .filter(isBrowserResult)
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

  test("prunes oldest browser pairs atomically to the byte limit with one notice", () => {
    const largeOutput = "ø".repeat(275_000);
    const oldestCall = browserCall("oldest", largeOutput);
    const oldestResult = browserResult("oldest", largeOutput);
    const newestCall = browserCall("newest", largeOutput);
    const newestResult = browserResult("newest", largeOutput);
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
