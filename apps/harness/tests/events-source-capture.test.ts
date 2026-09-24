import { describe, expect, test } from "bun:test";

import { SessionEventStream } from "../src/host/events.ts";

describe("SessionEventStream", () => {
  test("assigns monotonic IDs while retaining only the newest 256 events", () => {
    const stream = new SessionEventStream(() => ({ state: "running" }));

    for (let step = 1; step <= 300; step += 1) {
      stream.publish("agent_step", { state: "running" }, { step_number: step });
    }

    expect(stream.retainedEvents).toHaveLength(256);
    expect(stream.retainedEvents[0]?.id).toBe(45);
    expect(stream.retainedEvents[255]?.id).toBe(300);
    expect(stream.publish("closed", { state: "closed" }).id).toBe(301);
  });

  test("delivers live events after replay and releases cancelled subscribers", async () => {
    const stream = new SessionEventStream(() => ({ state: "running" }));
    const reader = stream.subscribe().getReader();

    stream.publish("session_started", { state: "running" });
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: { id: 1, event: "session_started", session: { state: "running" } },
    });
    stream.close();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(stream.subscriberCount).toBe(0);
  });

  test("replays after Last-Event-ID and substitutes a current snapshot outside the retained range", () => {
    let state = "running";
    const stream = new SessionEventStream(() => ({ state }));
    for (let id = 1; id <= 260; id += 1) stream.publish("agent_step", { state }, { step_number: id });

    expect(stream.replayAfter(258).map((event) => event.id)).toEqual([259, 260]);
    state = "closed";
    expect(stream.replayAfter(0)).toEqual([{
      id: 260,
      event: "snapshot",
      session: { state: "closed" },
      detail: {},
    }]);
    expect(stream.replayAfter(999)[0]?.event).toBe("snapshot");
  });
});
