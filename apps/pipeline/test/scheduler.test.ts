import { describe, expect, test } from "bun:test";
import { WorkerScheduler, type SchedulerRepository } from "../src/worker/scheduler";
import type { RunClaim } from "../src/worker/claims";

function claim(runId: string, byte: number): RunClaim {
  return { runId, token: Buffer.alloc(32, byte).toString("base64url"), expiresAt: 60_000 };
}

describe("singleton worker scheduler", () => {
  test("drains FIFO claims without overlapping processors and releases exact claims", async () => {
    const queue = [claim("run-1", 1), claim("run-2", 2)];
    const released: string[] = [];
    const repository: SchedulerRepository = {
      acquire: () => queue.shift() ?? null,
      heartbeat: (value) => ({ ...value, expiresAt: 60_000 }),
      release: (value) => { released.push(value.runId); },
    };
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const scheduler = new WorkerScheduler(repository, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`start:${value.runId}`);
      await Bun.sleep(5);
      order.push(`finish:${value.runId}`);
      active -= 1;
    }, { heartbeatMs: 1_000 });

    scheduler.kick();
    scheduler.kick();
    await scheduler.waitForIdle();
    expect(maximumActive).toBe(1);
    expect(order).toEqual(["start:run-1", "finish:run-1", "start:run-2", "finish:run-2"]);
    expect(released).toEqual(["run-1", "run-2"]);
  });

  test("aborts the active processor and does not release after heartbeat loss", async () => {
    const only = claim("run-1", 3);
    let acquired = false;
    let released = false;
    let aborted = false;
    const repository: SchedulerRepository = {
      acquire: () => acquired ? null : ((acquired = true), only),
      heartbeat: () => { throw new Error("stale claim"); },
      release: () => { released = true; },
    };
    const scheduler = new WorkerScheduler(repository, async (_value, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
      });
    }, {
      heartbeatMs: 5,
      recoveryDelayMs: 60_000,
      setTimeout: (() => ({ unref() {} })) as unknown as typeof globalThis.setTimeout,
    });

    scheduler.kick();
    await scheduler.waitForIdle();
    expect(aborted).toBe(true);
    expect(released).toBe(false);
    await scheduler.close();
  });
});
