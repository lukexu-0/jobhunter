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
