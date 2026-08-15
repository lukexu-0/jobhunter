import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, fstatSync, lstatSync, realpathSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_RESOURCE_PROFILE,
  TRUSTED_PROGRAMS,
  runTrustedProcess,
  sanitizedEnvironment,
  type ProcessBoundary,
  type SpawnContract,
  type TrustedProcessRequest,
} from "../src/system/process.ts";

test("trusts only the fixed document toolchain and headless Chrome", () => {
  expect(TRUSTED_PROGRAMS).toEqual([
    "latexmk",
    "pdfinfo",
    "pdftotext",
    "pdffonts",
    "pdftoppm",
    "google-chrome",
  ]);
});

test("requires the fixed hardened browser profile only for trusted Chrome requests", async () => {
  let launches = 0;
  let seen: SpawnContract | undefined;
  const boundary: ProcessBoundary = (contract) => {
    launches++;
    seen = contract;
    return {
      pid: 4099,
      stdout: (async function* () {})(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0, signal: null }),
      kill: async () => undefined,
    };
  };
  const common = { args: [], cwd: process.cwd(), timeoutMs: 1_000 } as const;

  await expect(runTrustedProcess({
    command: "google-chrome",
    ...common,
  } as unknown as TrustedProcessRequest, boundary)).rejects.toThrow(/resource profile/i);
  await expect(runTrustedProcess({
    command: "pdfinfo",
    resourceProfile: "browser-renderer",
    ...common,
  } as unknown as TrustedProcessRequest, boundary)).rejects.toThrow(/resource profile/i);
  expect(launches).toBe(0);

  await runTrustedProcess({
    command: "google-chrome",
    resourceProfile: "browser-renderer",
    ...common,
  }, boundary);
  expect(launches).toBe(1);
  expect(seen?.env).toEqual(sanitizedEnvironment());
  expect(seen?.env).not.toHaveProperty("XDG_RUNTIME_DIR");
  expect(seen?.resourceProfile).toEqual({
    name: "browser-renderer",
    privateProfileDirectory: "/tmp/jobhunter-rendered-job-profile",
    unitProperties: [
      "MemoryMax=512M",
      "MemorySwapMax=0",
      "TasksMax=256",
      "CPUQuota=200%",
      "RuntimeMaxSec=10s",
      "TimeoutStopSec=1s",
      "KillMode=control-group",
      "OOMPolicy=stop",
      "LimitCORE=0",
      "TemporaryFileSystem=/tmp:rw,size=128M,mode=0700",
      "PrivateUsers=yes",
      "ProtectHome=yes",
      "ProtectSystem=strict",
      "ProtectControlGroups=yes",
      "ProtectKernelTunables=yes",
      "ProtectKernelModules=yes",
      "ProtectKernelLogs=yes",
      "PrivateDevices=yes",
      "PrivateIPC=yes",
      "NoNewPrivileges=yes",
      "CapabilityBoundingSet=",
      "RestrictSUIDSGID=yes",
      "LockPersonality=yes",
      "ProtectProc=invisible",
      "ProcSubset=pid",
      "IPAddressDeny=any",
      "IPAddressAllow=localhost",
    ],
  });
});

const chromeExecutableExists = [
  "/usr/local/bin/google-chrome",
  "/usr/bin/google-chrome",
  "/bin/google-chrome",
].some(existsSync);
let userManagerAvailable = false;
if (
  process.platform === "linux"
  && process.getuid !== undefined
  && existsSync("/usr/bin/systemd-run")
  && existsSync("/usr/bin/systemctl")
) {
  const uid = process.getuid();
  const runtimeDirectory = `/run/user/${uid}`;
  try {
    const runtime = lstatSync(runtimeDirectory);
    userManagerAvailable = runtime.isDirectory()
      && !runtime.isSymbolicLink()
      && runtime.uid === uid
      && (runtime.mode & 0o7777) === 0o700
      && spawnSync("systemctl", ["--user", "show-environment"], {
        env: {
          ...sanitizedEnvironment(),
          XDG_RUNTIME_DIR: runtimeDirectory,
        },
        shell: false,
        stdio: "ignore",
        timeout: 1_000,
      }).status === 0;
  } catch {
    userManagerAvailable = false;
  }
}

describe.skipIf(!chromeExecutableExists || !userManagerAvailable)(
  "default browser process boundary (requires Chrome and a systemd user manager)",
  () => {
    test("runs a headless render in the private tmpfs and collects the hardened service", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pipeline-browser-boundary-"));
      try {
        const result = await runTrustedProcess({
          command: "google-chrome",
          args: [
            "--headless=new",
            "--dump-dom",
            `--user-data-dir=${cwd}`,
            "data:text/html,<html><body><main>contained-render</main></body></html>",
          ],
          cwd,
          timeoutMs: 9_000,
          resourceProfile: BROWSER_RESOURCE_PROFILE.name,
        });

        expect(result).toMatchObject({
          command: "google-chrome",
          code: 0,
          signal: null,
          timedOut: false,
          aborted: false,
        });
        expect(Buffer.from(result.stdout.data).toString()).toContain("contained-render");
        expect(await readdir(cwd)).toEqual([]);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    test("honors the forced proxy for loopback URLs without a direct-network fallback", async () => {
      let directConnections = 0;
      let proxyConnections = 0;
      const canary: Server = createServer((socket) => {
        directConnections += 1;
        socket.destroy();
      });
      const proxy: Server = createServer((socket) => {
        proxyConnections += 1;
        socket.once("data", () => {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        });
      });
      const listen = async (server: Server): Promise<number> => {
        const listening = Promise.withResolvers<void>();
        server.once("error", listening.reject);
        server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, listening.resolve);
        await listening.promise;
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("test server did not bind TCP");
        return address.port;
      };
      const close = async (server: Server): Promise<void> => {
        const closed = Promise.withResolvers<void>();
        server.close((error) => error ? closed.reject(error) : closed.resolve());
        await closed.promise;
      };
      const canaryPort = await listen(canary);
      const proxyPort = await listen(proxy);
      const cwd = await mkdtemp(join(tmpdir(), "pipeline-browser-egress-"));

      try {
        const result = await runTrustedProcess({
          command: "google-chrome",
          args: [
            "--headless=new",
            "--dump-dom",
            "--virtual-time-budget=1000",
            `--user-data-dir=${cwd}`,
            `--proxy-server=http://127.0.0.1:${proxyPort}`,
            "--proxy-bypass-list=<-loopback>",
            "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
            `http://127.0.0.1:${canaryPort}/`,
          ],
          cwd,
          timeoutMs: 9_000,
          resourceProfile: BROWSER_RESOURCE_PROFILE.name,
        });

        expect(result.timedOut).toBeFalse();
        expect(result.aborted).toBeFalse();
        expect(proxyConnections).toBeGreaterThan(0);
        expect(directConnections).toBe(0);
      } finally {
        await Promise.all([close(canary), close(proxy)]);
        await rm(cwd, { recursive: true, force: true });
      }
    }, 15_000);
  },
);

describe.skipIf(process.platform !== "linux")("trusted process TeX environment (requires Linux /proc parent-held cache descriptors)", () => {
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
      let killTarget: "process-group" | "browser-cgroup" | undefined;
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

  test("kills a process when the request is aborted during boundary registration", async () => {
    const controller = new AbortController();
    const exit = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    let killSignal: NodeJS.Signals | undefined;
    let killTarget: "process-group" | "browser-cgroup" | undefined;

    const boundary: ProcessBoundary = () => {
      const running = {
        pid: 4103,
        stdout: (async function* () {})(),
        stderr: (async function* () {})(),
        wait: () => exit.promise,
        kill: async (signal: NodeJS.Signals, target: "process-group" | "browser-cgroup") => {
          killSignal = signal;
          killTarget = target;
          exit.resolve({ code: null, signal });
        },
      };
      controller.abort();
      return running;
    };

    const result = await runTrustedProcess({
      command: "pdfinfo",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 50,
      signal: controller.signal,
    }, boundary);

    expect(controller.signal.aborted).toBeTrue();
    expect(killSignal).toBe("SIGKILL");
    expect(killTarget).toBe("process-group");
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGKILL");
    expect(result.timedOut).toBeFalse();
    expect(result.aborted).toBeTrue();
    expect(result.killAcknowledged).toBeTrue();
  });
});
