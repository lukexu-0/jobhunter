import { describe, expect, test } from "bun:test";
import { WorkerScheduler, type SchedulerRepository } from "../src/worker/scheduler";
import type { RunClaim } from "../src/worker/claims";

function claim(runId: string, byte: number): RunClaim {
  return { runId, token: Buffer.alloc(32, byte).toString("base64url"), expiresAt: 60_000 };
}

describe("concurrent worker scheduler", () => {
  test("runs exactly five processors concurrently, waits to start a sixth, and releases exact claims", async () => {
    const claims = Array.from({ length: 6 }, (_, index) => claim(`run-${index + 1}`, index + 1));
    const queue = [...claims];
    const released: Array<Pick<RunClaim, "runId" | "token">> = [];
    const repository: SchedulerRepository = {
      acquire: () => queue.shift() ?? null,
      heartbeat: (value) => ({ ...value, expiresAt: 60_000 }),
      release: ({ runId, token }) => { released.push({ runId, token }); },
    };
    const gates = new Map<string, () => void>();
    let signalFiveStarted!: () => void;
    const fiveStarted = new Promise<void>((resolve) => { signalFiveStarted = resolve; });
    let signalSixStarted!: () => void;
    const sixStarted = new Promise<void>((resolve) => { signalSixStarted = resolve; });
    const started: string[] = [];
    const scheduler = new WorkerScheduler(repository, async (value) => {
      started.push(value.runId);
      if (started.length === 5) signalFiveStarted();
      if (value.runId === "run-6") signalSixStarted();
      await new Promise<void>((resolve) => { gates.set(value.runId, resolve); });
    }, { heartbeatMs: 1_000 });

    scheduler.kick();
    await fiveStarted;
    expect(new Set(started)).toEqual(new Set(["run-1", "run-2", "run-3", "run-4", "run-5"]));
    expect(released).toEqual([]);

    gates.get("run-1")!();
    await sixStarted;
    expect(new Set(started)).toEqual(new Set(["run-1", "run-2", "run-3", "run-4", "run-5", "run-6"]));
    expect(released).toEqual([{ runId: claims[0]!.runId, token: claims[0]!.token }]);

    for (const runId of ["run-2", "run-3", "run-4", "run-5", "run-6"]) gates.get(runId)!();
    await scheduler.waitForIdle();
    expect(released).toHaveLength(6);
    expect(new Set(released.map(({ runId, token }) => `${runId}:${token}`))).toEqual(
      new Set(claims.map(({ runId, token }) => `${runId}:${token}`)),
    );
  });
  test("starts newly kicked work while an earlier processor remains active", async () => {
    const queue = [claim("run-1", 1)];
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    const scheduler = new WorkerScheduler({
      acquire: () => queue.shift() ?? null,
      heartbeat: (value) => ({ ...value, expiresAt: 60_000 }),
      release: () => undefined,
    }, async (value) => {
      started.push(value.runId);
      if (value.runId === "run-1") signalFirstStarted();
      await new Promise<void>((resolve) => { gates.set(value.runId, resolve); });
    }, { concurrency: 2 });

    scheduler.kick();
    await firstStarted;
    queue.push(claim("run-2", 2));
    scheduler.kick();
    for (let index = 0; index < 5; index++) await Promise.resolve();

    expect(started).toEqual(["run-1", "run-2"]);

    gates.get("run-1")!();
    gates.get("run-2")!();
    await scheduler.waitForIdle();
  });

  test("close aborts and joins all five active processors", async () => {
    const queue = Array.from({ length: 5 }, (_, index) => claim(`run-${index + 1}`, index + 1));
    const gates = new Map<string, () => void>();
    const aborted: string[] = [];
    const finished: string[] = [];
    let signalAllStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => { signalAllStarted = resolve; });
    let started = 0;
    const scheduler = new WorkerScheduler({
      acquire: () => queue.shift() ?? null,
      heartbeat: (value) => ({ ...value, expiresAt: 60_000 }),
      release: () => undefined,
    }, async (value, signal) => {
      started++;
      if (started === 5) signalAllStarted();
      await new Promise<void>((resolve) => {
        gates.set(value.runId, resolve);
        signal.addEventListener("abort", () => { aborted.push(value.runId); }, { once: true });
      });
      finished.push(value.runId);
    });

    scheduler.kick();
    await allStarted;
    let closeSettled = false;
    const closing = scheduler.close().then(() => { closeSettled = true; });
    await Promise.resolve();

    expect([...aborted].sort()).toEqual(["run-1", "run-2", "run-3", "run-4", "run-5"]);
    expect(closeSettled).toBeFalse();
    expect(finished).toEqual([]);

    for (const release of gates.values()) release();
    await closing;
    expect([...finished].sort()).toEqual(["run-1", "run-2", "run-3", "run-4", "run-5"]);
    expect(closeSettled).toBeTrue();
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
  test("does not acquire kicked work during heartbeat-loss recovery", async () => {
    const queue = [claim("run-1", 1)];
    const started: string[] = [];
    let heartbeat!: () => void;
    let recovery!: () => void;
    let releaseAbortCleanup!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    const scheduler = new WorkerScheduler({
      acquire: () => queue.shift() ?? null,
      heartbeat: () => { throw new Error("stale claim"); },
      release: () => undefined,
    }, async (value, signal) => {
      started.push(value.runId);
      if (value.runId !== "run-1") return;
      signalFirstStarted();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => { releaseAbortCleanup = resolve; }, { once: true });
      });
    }, {
      concurrency: 2,
      setInterval: ((callback: () => void) => {
        heartbeat = callback;
        return { unref() {} };
      }) as unknown as typeof globalThis.setInterval,
      clearInterval: (() => undefined) as unknown as typeof globalThis.clearInterval,
      setTimeout: ((callback: () => void) => {
        recovery = callback;
        return { unref() {} };
      }) as unknown as typeof globalThis.setTimeout,
    });

    scheduler.kick();
    await firstStarted;
    heartbeat();
    queue.push(claim("run-2", 2));
    scheduler.kick();
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(started).toEqual(["run-1"]);

    releaseAbortCleanup();
    await scheduler.waitForIdle();
    expect(started).toEqual(["run-1"]);

    recovery();
    await scheduler.waitForIdle();
    expect(started).toEqual(["run-1", "run-2"]);
    await scheduler.close();
  });
  test("fills a free slot after recovery while another processor remains active", async () => {
    const queue = [claim("run-1", 1), claim("run-2", 2)];
    const started: string[] = [];
    const heartbeats: Array<() => void> = [];
    let recovery!: () => void;
    let releaseSecond!: () => void;
    let signalTwoStarted!: () => void;
    const twoStarted = new Promise<void>((resolve) => { signalTwoStarted = resolve; });
    let signalRecoveryScheduled!: () => void;
    const recoveryScheduled = new Promise<void>((resolve) => { signalRecoveryScheduled = resolve; });
    const scheduler = new WorkerScheduler({
      acquire: () => queue.shift() ?? null,
      heartbeat: (value) => {
        if (value.runId === "run-1") throw new Error("stale claim");
        return { ...value, expiresAt: 60_000 };
      },
      release: () => undefined,
    }, async (value, signal) => {
      started.push(value.runId);
      if (started.length === 2) signalTwoStarted();
      if (value.runId === "run-1") {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } else if (value.runId === "run-2") {
        await new Promise<void>((resolve) => { releaseSecond = resolve; });
      }
    }, {
      concurrency: 2,
      setInterval: ((callback: () => void) => {
        heartbeats.push(callback);
        return { unref() {} };
      }) as unknown as typeof globalThis.setInterval,
      clearInterval: (() => undefined) as unknown as typeof globalThis.clearInterval,
      setTimeout: ((callback: () => void) => {
        recovery = callback;
        signalRecoveryScheduled();
        return { unref() {} };
      }) as unknown as typeof globalThis.setTimeout,
    });

    scheduler.kick();
    await twoStarted;
    queue.push(claim("run-3", 3));
    heartbeats[0]!();
    await recoveryScheduled;
    recovery();
    for (let index = 0; index < 5; index++) await Promise.resolve();

    expect(started).toEqual(["run-1", "run-2", "run-3"]);

    releaseSecond();
    await scheduler.waitForIdle();
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

  test("queues an availability kick without recursively entering after-drain work", async () => {
    const repository: SchedulerRepository = {
      acquire: () => null,
      heartbeat: (value) => ({ ...value, expiresAt: 60_000 }),
      release: () => undefined,
    };
    let afterDrainCalls = 0;
    let afterDrainDepth = 0;
    let maximumDepth = 0;
    let scheduler!: WorkerScheduler;
    scheduler = new WorkerScheduler(repository, async () => undefined, {
      afterDrain: async () => {
        afterDrainCalls++;
        afterDrainDepth++;
        maximumDepth = Math.max(maximumDepth, afterDrainDepth);
        if (afterDrainCalls === 1) scheduler.kick();
        await Promise.resolve();
        afterDrainDepth--;
      },
    });

    scheduler.kick();
    await scheduler.waitForIdle();

    expect(afterDrainCalls).toBe(2);
    expect(maximumDepth).toBe(1);
  });

  test("aborts in-flight after-drain startup when the scheduler closes", async () => {
    const reported: unknown[] = [];
    let observedSignal: AbortSignal | undefined;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const scheduler = new WorkerScheduler({
      acquire: () => null,
      heartbeat: (value) => ({ ...value, expiresAt: 60_000 }),
      release: () => undefined,
    }, async () => undefined, {
      afterDrain: async (signal) => {
        observedSignal = signal;
        signalStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      onError: (error) => { reported.push(error); },
    });

    scheduler.kick();
    await started;
    await scheduler.close();

    expect(observedSignal?.aborted).toBe(true);
    expect(reported).toEqual([]);
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
