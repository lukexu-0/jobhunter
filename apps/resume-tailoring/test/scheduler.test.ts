import { describe, expect, test, vi } from "bun:test";
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

  test("close aborts and joins the active processor", async () => {
    vi.useFakeTimers();
    try {
      const only = claim("run-1", 3);
      let acquired = false;
      let signalProcessorStarted!: () => void;
      const processorStarted = new Promise<void>((resolve) => { signalProcessorStarted = resolve; });
      let signalAbortObserved!: () => void;
      const abortObserved = new Promise<void>((resolve) => { signalAbortObserved = resolve; });
      let releaseProcessor!: () => void;
      const processorGate = new Promise<void>((resolve) => { releaseProcessor = resolve; });
      let expireWatchdog!: () => void;
      const watchdog = new Promise<"timeout">((resolve) => {
        expireWatchdog = () => resolve("timeout");
      });
      const watchdogTimer = setTimeout(expireWatchdog, 100);
      let processorFinished = false;
      const scheduler = new WorkerScheduler({
        acquire: () => acquired ? null : ((acquired = true), only),
        heartbeat: (value) => ({ ...value, expiresAt: 60_000 }),
        release: () => undefined,
      }, async (_value, signal) => {
        signalProcessorStarted();
        const outcome = await Promise.race([
          new Promise<"aborted">((resolve) => {
            signal.addEventListener("abort", () => {
              signalAbortObserved();
              resolve("aborted");
            }, { once: true });
          }),
          watchdog,
        ]);
        if (outcome === "aborted") await processorGate;
        processorFinished = true;
      });

      scheduler.kick();
      await processorStarted;
      let closeSettled = false;
      const closing = scheduler.close().then(() => { closeSettled = true; });
      const closeAbortOutcomePromise = Promise.race([
        abortObserved.then(() => "aborted" as const),
        watchdog,
      ]);
      await Promise.resolve();
      vi.advanceTimersByTime(100);
      const closeAbortOutcome = await closeAbortOutcomePromise;
      await Promise.resolve();
      const settledBeforeProcessorFinished = closeSettled;
      releaseProcessor();
      await closing;
      clearTimeout(watchdogTimer);

      expect(closeAbortOutcome).toBe("aborted");
      expect(settledBeforeProcessorFinished).toBeFalse();
      expect(processorFinished).toBeTrue();
      expect(closeSettled).toBeTrue();
    } finally {
      vi.useRealTimers();
    }
  });

  test("defers after-drain maintenance until recovery after heartbeat loss", async () => {
    const only = claim("run-1", 3);
    let acquired = false;
    let released = false;
    let aborted = false;
    let afterDrainCalls = 0;
    let heartbeat!: () => void;
    let recovery!: () => void;
    let signalProcessorStarted!: () => void;
    const processorStarted = new Promise<void>((resolve) => { signalProcessorStarted = resolve; });
    const repository: SchedulerRepository = {
      acquire: () => acquired ? null : ((acquired = true), only),
      heartbeat: () => { throw new Error("stale claim"); },
      release: () => { released = true; },
    };
    const scheduler = new WorkerScheduler(repository, async (_value, signal) => {
      signalProcessorStarted();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
      });
    }, {
      setInterval: ((callback: () => void) => {
        heartbeat = callback;
        return { unref() {} };
      }) as unknown as typeof globalThis.setInterval,
      clearInterval: (() => undefined) as unknown as typeof globalThis.clearInterval,
      setTimeout: ((callback: () => void) => {
        recovery = callback;
        return { unref() {} };
      }) as unknown as typeof globalThis.setTimeout,
      afterDrain: () => { afterDrainCalls++; },
    });

    scheduler.kick();
    await processorStarted;
    scheduler.kick();
    heartbeat();
    await scheduler.waitForIdle();
    expect(aborted).toBe(true);
    expect(released).toBe(false);
    expect(afterDrainCalls).toBe(0);

    recovery();
    await scheduler.waitForIdle();
    expect(afterDrainCalls).toBe(1);
    await scheduler.close();
  });

  test("awaits one after-drain hook after the queue is exhausted", async () => {
    const repository: SchedulerRepository = {
      acquire: () => null,
      heartbeat: (value) => ({ ...value, expiresAt: 60_000 }),
      release: () => undefined,
    };
    let releaseHook!: () => void;
    const hookGate = new Promise<void>((resolve) => { releaseHook = resolve; });
    let signalHookStarted!: () => void;
    const hookStartedSignal = new Promise<void>((resolve) => { signalHookStarted = resolve; });
    let hookStarted = 0;
    let hookFinished = false;
    const scheduler = new WorkerScheduler(repository, async () => undefined, {
      afterDrain: async () => {
        hookStarted++;
        signalHookStarted();
        await hookGate;
        hookFinished = true;
      },
    });

    scheduler.kick();
    const idle = scheduler.waitForIdle();
    await hookStartedSignal;
    expect(hookStarted).toBe(1);
    expect(hookFinished).toBeFalse();
    releaseHook();
    await idle;
    expect(hookFinished).toBeTrue();
    expect(hookStarted).toBe(1);
  });

  test("drains a claim kicked while after-drain maintenance is running", async () => {
    const queue: RunClaim[] = [];
    const processed: string[] = [];
    let afterDrainCalls = 0;
    let releaseFirstDrain!: () => void;
    const firstDrainGate = new Promise<void>((resolve) => { releaseFirstDrain = resolve; });
    let signalFirstDrain!: () => void;
    const firstDrainStarted = new Promise<void>((resolve) => { signalFirstDrain = resolve; });
    const scheduler = new WorkerScheduler({
      acquire: () => queue.shift() ?? null,
      heartbeat: (value) => ({ ...value, expiresAt: 60_000 }),
      release: () => undefined,
    }, async (value) => {
      processed.push(value.runId);
    }, {
      afterDrain: async () => {
        afterDrainCalls++;
        if (afterDrainCalls === 1) {
          signalFirstDrain();
          await firstDrainGate;
        }
      },
    });

    scheduler.kick();
    await firstDrainStarted;
    queue.push(claim("run-late", 4));
    scheduler.kick();
    releaseFirstDrain();
    await scheduler.waitForIdle();

    expect(processed).toEqual(["run-late"]);
    expect(afterDrainCalls).toBe(2);
  });

  test("reports after-drain failures without replaying completed claims", async () => {
    const queue = [claim("run-1", 4)];
    const processed: string[] = [];
    const reported: unknown[] = [];
    const scheduler = new WorkerScheduler({
      acquire: () => queue.shift() ?? null,
      heartbeat: (value) => ({ ...value, expiresAt: 60_000 }),
      release: () => undefined,
    }, async (value) => {
      processed.push(value.runId);
    }, {
      afterDrain: () => { throw new Error("maintenance failed"); },
      onError: (error) => { reported.push(error); },
    });

    scheduler.kick();
    await scheduler.waitForIdle();
    expect(processed).toEqual(["run-1"]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeInstanceOf(Error);
    expect((reported[0] as Error).message).toBe("maintenance failed");
  });
});
