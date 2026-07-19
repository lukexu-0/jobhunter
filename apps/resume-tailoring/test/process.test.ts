import { describe, expect, test } from "bun:test";
import { fstatSync, realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTrustedProcess, sanitizedEnvironment, type ProcessBoundary, type SpawnContract } from "../src/system/process.ts";

describe("trusted process environment", () => {
  test("uses only fixed sanitized values and an opaque parent-held TeX root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pipeline-process-"));
    let seen: SpawnContract | undefined;
    const boundary: ProcessBoundary = (contract) => {
      seen = contract;
      return {
        pid: 4100,
        stdout: (async function* () {})(),
        stderr: (async function* () {})(),
        wait: async () => ({ code: 0, signal: null }),
        kill: async () => undefined,
      };
    };

    await runTrustedProcess({
      command: "latexmk",
      args: ["main.tex"],
      cwd,
      timeoutMs: 1_000,
      texmfConfigDirectory: ".",
    }, boundary);
    expect(seen?.env).toMatchObject({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      SOURCE_DATE_EPOCH: "0",
      TEXMFHOME: ".tex-cache/texmf-home",
      TEXMFVAR: ".tex-cache/texmf-var",
      MT_FEATURES: "appendonlydir:varfonts",
      TEXMFCNF: ".:",
    });
    const parentRoot = `/proc/${process.pid}/fd/${seen?.attemptRootFd}`;
    expect(seen?.env.TMPDIR).toBe(`${parentRoot}/.tex-cache/tmp`);
    expect(seen?.env.VARTEXFONTS).toBe(`${parentRoot}/.tex-cache/fonts`);
    expect(seen?.env.MT_VARTEXFONTS).toBe(`${parentRoot}/.tex-cache/fonts`);
    expect(JSON.stringify(seen?.env)).not.toContain(cwd);
    expect(sanitizedEnvironment(undefined)).not.toHaveProperty("TMPDIR");
  });

  test("keeps the opaque parent fd open for descendants until process settlement", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pipeline-process-fd-"));
    let successfulFd = -1;
    await runTrustedProcess({
      command: "latexmk",
      args: ["main.tex"],
      cwd,
      timeoutMs: 1_000,
      texmfConfigDirectory: ".",
    }, (contract) => {
      successfulFd = contract.attemptRootFd!;
      expect(successfulFd).not.toBe(3);
      expect(fstatSync(successfulFd).isDirectory()).toBeTrue();
      expect(realpathSync(`/proc/${process.pid}/fd/${successfulFd}`)).toBe(realpathSync(cwd));
      expect(contract.env.TMPDIR).toBe(`/proc/${process.pid}/fd/${successfulFd}/.tex-cache/tmp`);
      return {
        get pid() {
          expect(fstatSync(successfulFd).isDirectory()).toBeTrue();
          return 4102;
        },
        stdout: (async function* () {})(),
        stderr: (async function* () {})(),
        wait: async () => {
          expect(fstatSync(successfulFd).isDirectory()).toBeTrue();
          return { code: 0, signal: null };
        },
        kill: async () => undefined,
      };
    });
    expect(() => fstatSync(successfulFd)).toThrow();

    let failedFd = -1;
    await expect(runTrustedProcess({
      command: "latexmk",
      args: ["main.tex"],
      cwd,
      timeoutMs: 1_000,
      texmfConfigDirectory: ".",
    }, (contract) => {
      failedFd = contract.attemptRootFd!;
      expect(fstatSync(failedFd).isDirectory()).toBeTrue();
      throw new Error("spawn failed");
    })).rejects.toThrow("spawn failed");
    expect(() => fstatSync(failedFd)).toThrow();
  });
});

describe("trusted process lifecycle", () => {
  test("timeout and abort await process-group death and captured-pipe closure", async () => {
    for (const interrupt of ["timeout", "abort"] as const) {
      const exit = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
      const groupKilled = Promise.withResolvers<void>();
      const pipesClosed = Promise.withResolvers<void>();
      const killStarted = Promise.withResolvers<void>();
      const groupKillSettled = Promise.withResolvers<void>();
      let parentAlive = true;
      let descendantAlive = true;
      let killSignal: NodeJS.Signals | undefined;
      let killTarget: "process-group" | undefined;
      let openReaders = 2;

      const output = (text: string): AsyncIterable<Uint8Array> => (async function* () {
        try {
          yield Buffer.from(text);
          await pipesClosed.promise;
        } finally {
          openReaders--;
        }
      })();

      const boundary: ProcessBoundary = () => ({
        pid: 4101,
        stdout: output("stdout-over-limit"),
        stderr: output("stderr-over-limit"),
        wait: () => exit.promise,
        kill: async (signal, target) => {
          killSignal = signal;
          killTarget = target;
          killStarted.resolve();
          parentAlive = false;
          exit.resolve({ code: null, signal });
          await groupKilled.promise;
          descendantAlive = false;
          groupKillSettled.resolve();
        },
      });
      const controller = new AbortController();
      const pending = runTrustedProcess({
        command: "pdfinfo",
        args: [],
        cwd: process.cwd(),
        timeoutMs: interrupt === "timeout" ? 1 : 60_000,
        signal: controller.signal,
        stdoutLimit: 4,
        stderrLimit: 3,
      }, boundary);
      if (interrupt === "abort") controller.abort();

      await killStarted.promise;
      expect(killSignal).toBe("SIGKILL");
      expect(killTarget).toBe("process-group");
      expect(descendantAlive).toBeTrue();

      groupKilled.resolve();
      await groupKillSettled.promise;
      expect(descendantAlive).toBeFalse();
      expect(openReaders).toBe(2);
      pipesClosed.resolve();
      const result = await pending;

      expect(parentAlive).toBeFalse();
      expect(descendantAlive).toBeFalse();
      expect(openReaders).toBe(0);
      expect(result).toMatchObject({
        code: null,
        signal: "SIGKILL",
        timedOut: interrupt === "timeout",
        aborted: interrupt === "abort",
        killAcknowledged: true,
        stdout: { bytes: 17, truncated: true },
        stderr: { bytes: 17, truncated: true },
      });
      expect(Buffer.from(result.stdout.data).toString()).toBe("stdo");
      expect(Buffer.from(result.stderr.data).toString()).toBe("std");
    }
  });
});
