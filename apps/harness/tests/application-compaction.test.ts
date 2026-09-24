import { describe, expect, test } from "bun:test";
import type { AgentInputItem } from "@openai/agents-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
  GEMINI_LOCAL_COMPACTION_THRESHOLD_TOKENS,
  GeminiHistoryCompactor,
} from "../src/application/agent-runtime/application-compaction.ts";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string): AgentInputItem {
  return { role: "user", content: [{ type: "input_text", text }] };
}

function assistantMessage(text: string): AgentInputItem {
  return {
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
}

function completion(text: string): AssistantMessage {
  return {
    role: "assistant",
    api: "google-gemini-cli",
    provider: "google-antigravity",
    model: "gemini-3.8-flash",
    content: [{ type: "text", text }],
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("Gemini local history compaction", () => {
  test("keeps history unchanged through the 252k-token threshold", async () => {
    let completionCalls = 0;
    const compactor = new GeminiHistoryCompactor("session-under-threshold", {
      apiKey: "test-key",
      completeImpl: async () => {
        completionCalls += 1;
        return completion("unexpected summary");
      },
    });
    const input = [userMessage("unchanged")];

    const projected = await compactor.project(
      input,
      GEMINI_LOCAL_COMPACTION_THRESHOLD_TOKENS,
    );

    expect(projected).toBe(input);
    expect(completionCalls).toBe(0);
  });

  test("replaces an oversized prefix once and preserves subsequent history", async () => {
    const completionTexts = ["Preserved application state", "Application state"];
    const summaryContexts: string[] = [];
    let completionCalls = 0;
    const compactor = new GeminiHistoryCompactor("session-over-threshold", {
      apiKey: "test-key",
      completeImpl: async (_model, context) => {
        summaryContexts.push(JSON.stringify(context.messages));
        return completion(completionTexts[completionCalls++] ?? "unexpected summary");
      },
    });
    const large = "x".repeat(300_000);
    const input = [
      userMessage(`old question ${large}`),
      assistantMessage(`old answer ${large}`),
      userMessage(`recent question ${large}`),
      assistantMessage(`BOUNDARY recent answer ${large}`),
    ];

    const compacted = await compactor.project(
      input,
      GEMINI_LOCAL_COMPACTION_THRESHOLD_TOKENS + 1,
    );

    expect(completionCalls).toBeGreaterThan(0);
    const callsAfterCompaction = completionCalls;
    expect(compacted.length).toBeLessThan(input.length);
    expect(compacted[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(compacted[0])).toContain("Preserved application state");
    expect(compacted.at(-1)).toEqual(input.at(-1));

    const continuedInput = [...input, userMessage("continue from the preserved state")];
    const continued = await compactor.project(continuedInput, 150_000);

    expect(completionCalls).toBe(callsAfterCompaction);
    expect(continued[0]).toEqual(compacted[0]);
    expect(continued.at(-1)).toEqual(continuedInput.at(-1));
    const shiftedProjectedInput = [
      userMessage("new projected question"),
      assistantMessage("new projected answer"),
    ];
    const shiftedProjection = await compactor.project(shiftedProjectedInput, 150_000);
    expect(completionCalls).toBe(callsAfterCompaction);
    expect(shiftedProjection[0]).toEqual(compacted[0]);
    expect(shiftedProjection.slice(1)).toEqual(shiftedProjectedInput);
    const clonedBoundaryInput = [
      userMessage("new retained marker"),
      structuredClone(input.at(-1)!),
    ];
    const clonedBoundaryProjection = await compactor.project(clonedBoundaryInput, 150_000);
    expect(clonedBoundaryProjection.slice(1)).toEqual(clonedBoundaryInput);

    const twiceOversizedInput = [
      assistantMessage("narrative made adjacent by browser-history pruning"),
      input.at(-1)!,
      userMessage("latest question " + large),
      assistantMessage("latest answer " + large),
    ];
    const callsBeforeSecondCompaction = completionCalls;
    const reCompacted = await compactor.project(
      twiceOversizedInput,
      GEMINI_LOCAL_COMPACTION_THRESHOLD_TOKENS + 1,
    );

    expect(completionCalls).toBeGreaterThan(callsBeforeSecondCompaction);
    expect(summaryContexts.slice(callsBeforeSecondCompaction).some(
      (context) => context.includes("BOUNDARY recent answer"),
    )).toBe(true);
    expect(reCompacted.length).toBeLessThan(twiceOversizedInput.length);
    expect(reCompacted.at(-1)).toEqual(twiceOversizedInput.at(-1));
  });

  test("uses the required Antigravity client identity for local summaries", async () => {
    const requests: Array<{ readonly url: string; readonly userAgent: string; readonly body: unknown }> = [];
    const compactor = new GeminiHistoryCompactor("session-wire", {
      apiKey: JSON.stringify({ token: "synthetic-token", projectId: "synthetic-project" }),
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          userAgent: new Headers(init?.headers).get("user-agent") ?? "",
          body: JSON.parse(String(init?.body)),
        });
        return new Response(
          "data: " + JSON.stringify({
            response: {
              candidates: [{ content: { parts: [{ text: "wire summary" }] }, finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 5, totalTokenCount: 19 },
            },
          }) + "\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const large = "x".repeat(300_000);
    const input = [
      userMessage("old question " + large),
      assistantMessage("old answer " + large),
      userMessage("recent question " + large),
      assistantMessage("recent answer " + large),
    ];

    await compactor.project(input, GEMINI_LOCAL_COMPACTION_THRESHOLD_TOKENS + 1);

    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.url.endsWith("/v1internal:streamGenerateContent?alt=sse"))).toBe(true);
    expect(requests.every((request) => request.userAgent.startsWith("antigravity/hub/2.8.0 "))).toBe(true);
    expect(requests.every((request) => JSON.stringify(request.body).includes("gemini-3.8-flash-high"))).toBe(true);
    expect(JSON.stringify(requests)).not.toMatch(/v1\/responses\/compact|encrypted_content|context_management/);
  });
});
