import { expect, test } from "bun:test";

import {
  SourceCaptureManager,
  type SourceCaptureRuntime,
} from "../src/host/source-capture.ts";

class Runtime implements SourceCaptureRuntime {
  startedAt: string | null = null;
  opened = false;
  closed = false;
  captureCount = 0;
  closeCount = 0;

  async start(jobUrl: string): Promise<void> {
    this.startedAt = jobUrl;
  }

  async openBrowser(): Promise<void> {
    this.opened = true;
  }

  async captureSourceSnapshot(): Promise<readonly [string, string]> {
    this.captureCount += 1;
    return ["https://jobs.example.test/application", "Application form source"];
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.closed = true;
  }
}

test("creates, completes, and releases an exclusive source capture", async () => {
  const runtime = new Runtime();
  const manager = new SourceCaptureManager({
    applicationActive: () => false,
    runtimeFactory: () => runtime,
  });

  await expect(manager.create({
    capture_id: "00000000-0000-4000-8000-000000000001",
    job_url: "https://jobs.example.test/posting/42",
  })).resolves.toEqual({
    capture_id: "00000000-0000-4000-8000-000000000001",
    state: "awaiting_human_verification",
  });
  expect(runtime.startedAt).toBe("https://jobs.example.test/posting/42");
  expect(runtime.opened).toBe(true);

  await expect(manager.complete("00000000-0000-4000-8000-000000000001")).resolves.toEqual({
    capture_id: "00000000-0000-4000-8000-000000000001",
    final_url: "https://jobs.example.test/application",
    source: "Application form source",
  });
  expect(runtime.closed).toBe(true);
  expect(manager.activeCaptureId).toBeNull();
});

test("shares one authoritative completion and replays its result", async () => {
  const runtime = new Runtime();
  const manager = new SourceCaptureManager({
    applicationActive: () => false,
    runtimeFactory: () => runtime,
  });
  const captureId = "00000000-0000-4000-8000-000000000002";
  await manager.create({
    capture_id: captureId,
    job_url: "https://jobs.example.test/posting/42",
  });

  const [first, concurrent] = await Promise.all([
    manager.complete(captureId),
    manager.complete(captureId),
  ]);
  const replayed = await manager.complete(captureId);

  expect(concurrent).toEqual(first);
  expect(replayed).toEqual(first);
  expect(runtime.captureCount).toBe(1);
  expect(runtime.closeCount).toBe(1);
});


test("reserves source capture ownership before asynchronous runtime setup", async () => {
  let releaseFactory!: () => void;
  const factoryReady = new Promise<void>((resolve) => { releaseFactory = resolve; });
  const runtime = new Runtime();
  let factoryCalls = 0;
  const manager = new SourceCaptureManager({
    applicationActive: () => false,
    runtimeFactory: async () => { factoryCalls += 1; await factoryReady; return runtime; },
  });
  const firstId = "00000000-0000-4000-8000-000000000003";
  const creation = manager.create({ capture_id: firstId, job_url: "https://jobs.example.test/posting/42" });
  await Promise.resolve();
  expect(manager.activeCaptureId).toBe(firstId);
  await expect(manager.create({
    capture_id: "00000000-0000-4000-8000-000000000004",
    job_url: "https://jobs.example.test/posting/43",
  })).rejects.toMatchObject({ statusCode: 409, code: "source_capture_active" });
  releaseFactory();
  await creation;
  expect(factoryCalls).toBe(1);
  await manager.delete(firstId);
});

test("retains ownership when source cleanup fails so deletion can retry", async () => {
  const captureId = "00000000-0000-4000-8000-000000000005";
  class FlakyCloseRuntime extends Runtime {
    override async close(): Promise<void> {
      this.closeCount += 1;
      if (this.closeCount === 1) throw new Error("cleanup failed");
      this.closed = true;
    }
  }
  const runtime = new FlakyCloseRuntime();
  const manager = new SourceCaptureManager({ applicationActive: () => false, runtimeFactory: () => runtime });
  await manager.create({ capture_id: captureId, job_url: "https://jobs.example.test/posting/42" });
  await expect(manager.delete(captureId)).rejects.toThrow("cleanup failed");
  expect(manager.activeCaptureId).toBe(captureId);
  await expect(manager.delete(captureId)).resolves.toBeUndefined();
  expect(runtime.closeCount).toBe(2);
  expect(manager.activeCaptureId).toBeNull();
});
