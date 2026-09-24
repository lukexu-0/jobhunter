import { expect, test } from "bun:test";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { CodexContextEstimator } from "../src/models/codex-context.ts";

const INITIAL: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

function nativeReply(id: string, input: number, output: number): AssistantMessage {
  return {
    role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol",
    content: [{ type: "thinking", thinking: "visible summary of the same native output" }],
    providerPayload: {
      type: "openaiResponsesHistory", provider: "openai-codex", dt: true,
      items: [{ type: "reasoning", id, encrypted_content: "opaque-" + id }],
    },
    usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 1,
  };
}

test("counts multilingual text and literal special-token spellings with the model-family tokenizer", () => {
  const estimator = new CodexContextEstimator();
  const empty = estimator.estimate({ messages: [{ role: "user", content: "", timestamp: 1 }] });
  expect(estimator.estimate({ messages: [{ role: "user", content: "你好世界", timestamp: 2 }] }) - empty).toBe(2);
  expect(estimator.estimate({ messages: [{ role: "user", content: "<|endoftext|>", timestamp: 3 }] }) - empty).toBe(7);
});

test("subtracts pruned native output using its measured usage without double-counting the visible summary", () => {
  const estimator = new CodexContextEstimator();
  const first = nativeReply("first", 1_000, 50_000);
  estimator.observe(INITIAL, first);
  const withFirst = { messages: [...INITIAL.messages, first] };
  expect(estimator.estimate(withFirst)).toBe(51_000);
  const second = nativeReply("second", 51_000, 30);
  estimator.observe(withFirst, second);
  expect(estimator.estimate({ messages: [...INITIAL.messages, second] })).toBe(1_030);
});

test("resets old occupancy at native replacement boundaries and recalibrates the compacted context", () => {
  const estimator = new CodexContextEstimator();
  const oldReply = nativeReply("old", 270_000, 1_000);
  estimator.observe(INITIAL, oldReply);
  const replacement = nativeReply("compact", 270_000, 10);
  replacement.providerPayload = {
    type: "openaiResponsesHistory", provider: "openai-codex", dt: false,
    items: [{ type: "compaction", encrypted_content: "private-native-summary" }],
  };
  const compacted = { messages: [replacement] };
  const withDiscardedPrefix = { messages: [...INITIAL.messages, oldReply, replacement] };
  expect(estimator.estimate(withDiscardedPrefix)).toBe(new CodexContextEstimator().estimate(compacted));
  const next = nativeReply("after-compact", 2_000, 20);
  estimator.observe(compacted, next);
  expect(estimator.estimate({ messages: [replacement, next] })).toBe(2_020);
  // Removing an unmeasured encrypted anchor must not retain its old occupancy correction.
  expect(estimator.estimate(INITIAL)).toBe(new CodexContextEstimator().estimate(INITIAL));
});
