import { describe, expect, test } from "bun:test";
import {
  ApplicationAgentSteeringInbox,
  MAX_APPLICATION_AGENT_STEERING_BYTES,
  MAX_APPLICATION_AGENT_STEERING_MESSAGES,
} from "../src/agents/application-agent-steering.ts";

describe("application agent steering inbox", () => {
  test("commits a FIFO snapshot once while retaining messages appended after the snapshot", () => {
    const inbox = new ApplicationAgentSteeringInbox();
    expect(inbox.enqueue("first")).toBeTrue();
    expect(inbox.enqueue("second")).toBeTrue();

    const firstBatch = inbox.snapshot();
    expect(firstBatch?.messages).toEqual(["first", "second"]);
    expect(inbox.enqueue("third")).toBeTrue();
    expect(firstBatch && inbox.commit(firstBatch)).toBeTrue();
    expect(firstBatch && inbox.commit(firstBatch)).toBeFalse();
    expect(inbox.snapshot()?.messages).toEqual(["third"]);
    const secondBatch = inbox.snapshot();
    expect(secondBatch && inbox.commit(secondBatch)).toBeTrue();
    expect(inbox.enqueue("repeat")).toBeTrue();
    expect(inbox.enqueue("repeat")).toBeTrue();
    expect(inbox.snapshot()?.messages).toEqual(["repeat", "repeat"]);
  });

  test("enforces the 16-message and 65,536-byte aggregate bounds without changing the queue", () => {
    const countBounded = new ApplicationAgentSteeringInbox();
    for (let index = 0; index < MAX_APPLICATION_AGENT_STEERING_MESSAGES; index += 1) {
      expect(countBounded.enqueue(`message-${index}`)).toBeTrue();
    }
    expect(countBounded.enqueue("overflow")).toBeFalse();
    expect(countBounded.snapshot()?.messages).toHaveLength(
      MAX_APPLICATION_AGENT_STEERING_MESSAGES,
    );

    const byteBounded = new ApplicationAgentSteeringInbox();
    const astralChunk = "😀".repeat(8_000);
    expect(Buffer.byteLength(astralChunk, "utf8")).toBe(32_000);
    expect(byteBounded.enqueue(astralChunk)).toBeTrue();
    expect(byteBounded.enqueue(astralChunk)).toBeTrue();
    expect(byteBounded.enqueue("x".repeat(1_536))).toBeTrue();
    expect(byteBounded.enqueue("x")).toBeFalse();
    expect(Buffer.byteLength(byteBounded.snapshot()!.messages.join(""), "utf8"))
      .toBe(MAX_APPLICATION_AGENT_STEERING_BYTES);
    expect(byteBounded.snapshot()?.messages).toEqual([
      astralChunk,
      astralChunk,
      "x".repeat(1_536),
    ]);
  });

  test("drops pending text and rejects enqueue or stale commit after closure", () => {
    const inbox = new ApplicationAgentSteeringInbox();
    expect(inbox.enqueue("private pending guidance")).toBeTrue();
    const batch = inbox.snapshot();
    expect(batch).toBeDefined();

    inbox.close();

    expect(inbox.snapshot()).toBeUndefined();
    expect(inbox.enqueue("late guidance")).toBeFalse();
    expect(batch && inbox.commit(batch)).toBeFalse();
  });
});
