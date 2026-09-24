import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { isAbsolute } from "node:path";
import { readProcessStartToken } from "../worker/claims.ts";
import { ARTIFACT_LIMITS } from "./artifacts.ts";

export const TRUSTED_PROGRAMS = Object.freeze(["latexmk", "pdfinfo", "pdftotext", "pdffonts", "pdftoppm", "google-chrome"] as const);
export type TrustedProgram = typeof TRUSTED_PROGRAMS[number];

export const BROWSER_RESOURCE_PROFILE = Object.freeze({
  name: "browser-renderer",
  privateProfileDirectory: "/tmp/jobhunt-rendered-job-profile",
  unitProperties: Object.freeze([
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
  ] as const),
} as const);
export type BrowserResourceProfile = typeof BROWSER_RESOURCE_PROFILE;
export type BrowserResourceProfileName = BrowserResourceProfile["name"];

export interface SpawnContract {
  readonly command: TrustedProgram;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly attemptRootFd?: number;
  readonly resourceProfile?: BrowserResourceProfile;
}

export interface RunningProcess {
  readonly pid: number;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  wait(): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  kill(signal: NodeJS.Signals, target: "process-group" | "browser-cgroup"): Promise<void>;
}

export type ProcessBoundary = (contract: SpawnContract) => RunningProcess;

export interface TrustedProcessRequest {
  readonly command: TrustedProgram;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly stdoutLimit?: number;
  readonly stderrLimit?: number;
  readonly texmfConfigDirectory?: ".";
  readonly resourceProfile?: BrowserResourceProfileName;
}

export interface CapturedOutput {
  readonly data: Uint8Array;
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface TrustedProcessResult {
  readonly command: TrustedProgram;
  readonly args: readonly string[];
  readonly pid: number;
  readonly processStartToken: string | null;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly killAcknowledged: boolean;
  readonly stdout: CapturedOutput;
  readonly stderr: CapturedOutput;
}

const DEFAULT_PATH = process.platform === "darwin"
  ? "/Library/TeX/texbin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  : "/usr/local/bin:/usr/bin:/bin";

export function sanitizedEnvironment(texmfConfigDirectory?: ".", attemptRootFd?: number): Readonly<Record<string, string>> {
  const env: Record<string, string> = {
    PATH: DEFAULT_PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    SOURCE_DATE_EPOCH: "0",
  };
  if (texmfConfigDirectory === ".") {
    let cacheRoot: string;
    if (process.platform === "linux") {
      if (!Number.isSafeInteger(attemptRootFd) || attemptRootFd! < 0) {
        throw new Error("attempt-local TeX cache requires an open root descriptor");
      }
      // TeX descendants resolve this parent-held descriptor through procfs even after closing inherited fds.
      cacheRoot = `/proc/${process.pid}/fd/${attemptRootFd}/.tex-cache`;
    } else if (process.platform === "darwin") {
      if (attemptRootFd !== undefined) throw new Error("macOS TeX cache does not accept a root descriptor");
      // The locked compiler keeps descendants in the validated owner-only attempt directory.
      cacheRoot = ".tex-cache";
    } else {
      throw new Error("attempt-local TeX cache requires Linux or macOS");
    }
    Object.assign(env, {
      TMPDIR: `${cacheRoot}/tmp`,
      TEXMFHOME: ".tex-cache/texmf-home",
      TEXMFVAR: ".tex-cache/texmf-var",
      VARTEXFONTS: `${cacheRoot}/fonts`,
      MT_FEATURES: "appendonlydir:varfonts",
      MT_VARTEXFONTS: `${cacheRoot}/fonts`,
      TEXMFCNF: ".:",
    });
  }
  return Object.freeze(env);
}

function openAttemptRootFd(cwd: string): number {
  if (process.platform !== "linux") {
    throw new Error("attempt-local TeX cache requires Linux /proc/self/fd");
  }
  let fd = openSync(cwd, constants.O_RDONLY | constants.O_DIRECTORY);
  if (fd === 3) {
    // Force spawn to dup the handle onto fd 3. A same-fd dup would retain Node's parent-side CLOEXEC.
    const original = fd;
    let replacement: number;
    try {
      replacement = openSync(cwd, constants.O_RDONLY | constants.O_DIRECTORY);
    } catch (error) {
      closeSync(original);
      throw error;
    }
    try {
      closeSync(original);
    } catch (error) {
      closeSync(replacement);
      throw error;
    }
    fd = replacement;
  }
  try {
    const procFd = openSync(`/proc/self/fd/${fd}`, constants.O_RDONLY | constants.O_DIRECTORY);
    closeSync(procFd);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw new Error("attempt-local TeX cache requires an accessible /proc/self/fd", { cause: error });
  }
}

const SYSTEMD_RUN = "systemd-run";
const SYSTEMCTL = "systemctl";
const ENV_EXECUTABLE = "/usr/bin/env";
const SYSTEMD_CONTROL_TIMEOUT_MS = 2_000;
const SYSTEMD_WRAPPER_WAIT_MS = 2_000;

interface SystemdClientContext {
  readonly environment: Readonly<Record<string, string>>;
  readonly runtimeDirectory: string;
  readonly uid: number;
}

function systemdClientContext(): SystemdClientContext {
  if (process.platform !== "linux" || process.getuid === undefined) {
    throw new Error("browser resource containment requires a Linux user runtime");
  }
  const uid = process.getuid();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("browser resource containment requires a valid user id");
  }
  const runtimeDirectory = `/run/user/${uid}`;
  const runtime = lstatSync(runtimeDirectory);
  if (
    !runtime.isDirectory()
    || runtime.isSymbolicLink()
    || runtime.uid !== uid
    || (runtime.mode & 0o7777) !== 0o700
  ) {
    throw new Error("browser resource containment requires an owned private user runtime");
  }
  return {
    environment: Object.freeze({
      ...sanitizedEnvironment(),
      XDG_RUNTIME_DIR: runtimeDirectory,
    }),
    uid,
    runtimeDirectory,
  };
}

function directBoundary(contract: SpawnContract): RunningProcess {
  const detached = process.platform !== "win32";
  const stdio: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
  const child = spawn(contract.command, [...contract.args], {
    cwd: contract.cwd,
    env: { ...contract.env },
    shell: false,
    stdio,
    detached,
  });
  const signalChild = (signal: NodeJS.Signals): void => {
    const pid = child.pid;
    if (detached && pid !== undefined && pid > 0) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // The process may have exited before its group was signalled.
      }
    }
    child.kill(signal);
  };
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || stderr === null) {
    // This contradicts the stdio contract. Prevent a late child error from becoming unhandled
    // while it is terminated, and close whichever parent-side pipe was created before failing.
    child.once("error", () => undefined);
    try {
      signalChild("SIGKILL");
    } finally {
      stdout?.destroy();
      stderr?.destroy();
    }
    throw new Error("spawned process did not expose piped stdout and stderr");
  }
  const { promise: waitPromise, resolve: resolveWait, reject: rejectWait } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.once("error", rejectWait);
  child.once("close", (code, signal) => resolveWait({ code, signal }));
  return {
    pid: child.pid ?? -1,
    stdout,
    stderr,
    wait: () => waitPromise,
    kill: async (signal, _target) => {
      signalChild(signal);
    },
  };
}

async function waitBounded<T>(promise: Promise<T>, timeoutMs: number, failure: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(failure)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runSystemctl(
  args: readonly string[],
  clientEnvironment: Readonly<Record<string, string>>,
): Promise<void> {
  const child = spawn(SYSTEMCTL, [...args], {
    env: { ...clientEnvironment },
    shell: false,
    stdio: "ignore",
  });
  const { promise, resolve, reject } = Promise.withResolvers<number | null>();
  child.once("error", reject);
  child.once("close", resolve);
  let code: number | null;
  try {
    code = await waitBounded(promise, SYSTEMD_CONTROL_TIMEOUT_MS, "systemd user-service control timed out");
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  if (code !== 0) throw new Error("systemd user-service control failed");
}

async function stopBrowserUnit(
  unit: string,
  clientEnvironment: Readonly<Record<string, string>>,
): Promise<void> {
  try {
    await runSystemctl(["--user", "stop", unit], clientEnvironment);
  } catch (stopError) {
    try {
      await runSystemctl(
        ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit],
        clientEnvironment,
      );
      await runSystemctl(["--user", "stop", unit], clientEnvironment);
    } catch (killError) {
      throw new AggregateError([stopError, killError], "browser cgroup cleanup failed");
    }
  }
}

function browserServiceBoundary(contract: SpawnContract): RunningProcess {
  const client = systemdClientContext();
  const hostProfile = lstatSync(contract.cwd);
  if (
    !hostProfile.isDirectory()
    || hostProfile.isSymbolicLink()
    || hostProfile.uid !== client.uid
    || (hostProfile.mode & 0o7777) !== 0o700
  ) {
    throw new Error("browser resource containment requires an owned 0700 profile directory");
  }
  const expectedProfileArgument = `--user-data-dir=${contract.cwd}`;
  const profileArguments = contract.args.filter((argument) => argument.startsWith("--user-data-dir="));
  if (profileArguments.length !== 1 || profileArguments[0] !== expectedProfileArgument) {
    throw new Error("browser resource containment requires the fixed private profile argument");
  }
  const chromeArgs = contract.args.map((argument) => (
    argument === expectedProfileArgument
      ? `--user-data-dir=${BROWSER_RESOURCE_PROFILE.privateProfileDirectory}`
      : argument
  ));
  const unit = `jobhunt-rendered-job-${randomUUID()}.service`;
  const args = [
    "--user",
    "--wait",
    "--pipe",
    "--collect",
    "--quiet",
    `--unit=${unit}`,
    "--service-type=exec",
    "--working-directory=/tmp",
    ...BROWSER_RESOURCE_PROFILE.unitProperties.map((property) => `--property=${property}`),
    `--property=InaccessiblePaths=${client.runtimeDirectory}`,
    "--",
    ENV_EXECUTABLE,
    "-i",
    ...Object.entries(contract.env).map(([name, value]) => `${name}=${value}`),
    contract.command,
    ...chromeArgs,
  ];
  const detached = true;
  const stdio: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
  const child = spawn(SYSTEMD_RUN, args, {
    cwd: contract.cwd,
    env: { ...client.environment },
    shell: false,
    stdio,
    detached,
  });
  const signalWrapper = (): void => {
    const pid = child.pid;
    if (pid !== undefined && pid > 0) {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        // The wrapper may already have exited after collecting the service.
      }
    }
    child.kill("SIGKILL");
  };
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || stderr === null) {
    child.once("error", () => undefined);
    try {
      signalWrapper();
    } finally {
      stdout?.destroy();
      stderr?.destroy();
    }
    throw new Error("systemd browser service did not expose piped stdout and stderr");
  }
  const { promise: waitPromise, resolve: resolveWait, reject: rejectWait } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.once("error", rejectWait);
  child.once("close", (code, signal) => resolveWait({ code, signal }));
  let cleanup: Promise<void> | undefined;
  return {
    pid: child.pid ?? -1,
    stdout,
    stderr,
    wait: () => waitPromise,
    kill: async (_signal, _target) => {
      cleanup ??= (async () => {
        let cleanupError: unknown;
        try {
          await stopBrowserUnit(unit, client.environment);
        } catch (error) {
          cleanupError = error;
        }
        signalWrapper();
        stdout.destroy();
        stderr.destroy();
        try {
          await waitBounded(waitPromise, SYSTEMD_WRAPPER_WAIT_MS, "systemd-run wrapper did not settle");
        } catch (error) {
          cleanupError = cleanupError === undefined
            ? error
            : new AggregateError([cleanupError, error], "browser containment cleanup failed");
        }
        if (cleanupError !== undefined) throw cleanupError;
      })();
      await cleanup;
    },
  };
}

function defaultBoundary(contract: SpawnContract): RunningProcess {
  return contract.resourceProfile === BROWSER_RESOURCE_PROFILE
    ? browserServiceBoundary(contract)
    : directBoundary(contract);
}

async function capture(stream: AsyncIterable<Uint8Array>, limit: number): Promise<CapturedOutput> {
  const chunks: Buffer[] = [];
  let retained = 0;
  let bytes = 0;
  for await (const raw of stream) {
    const chunk = Buffer.from(raw);
    bytes += chunk.byteLength;
    const remaining = limit - retained;
    if (remaining > 0) {
      const kept = chunk.subarray(0, remaining);
      chunks.push(kept);
      retained += kept.byteLength;
    }
  }
  return { data: Buffer.concat(chunks), bytes, truncated: bytes > limit };
}

function processStartToken(pid: number): string | null {
  return readProcessStartToken(pid) ?? null;
}

export async function runTrustedProcess(request: TrustedProcessRequest, boundary: ProcessBoundary = defaultBoundary): Promise<TrustedProcessResult> {
  if (!TRUSTED_PROGRAMS.includes(request.command)) throw new Error(`program is not trusted: ${request.command}`);
  if (!Array.isArray(request.args) || request.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("process arguments must be a NUL-free string array");
  const browserProfile = request.resourceProfile === BROWSER_RESOURCE_PROFILE.name;
  if (
    (request.resourceProfile !== undefined && !browserProfile)
    || (request.command === "google-chrome") !== browserProfile
  ) {
    throw new Error("the browser resource profile is required only for google-chrome");
  }
  if (
    browserProfile
    && (
      !isAbsolute(request.cwd)
      || request.cwd.includes("\0")
      || request.cwd.includes(":")
      || request.texmfConfigDirectory !== undefined
    )
  ) {
    throw new Error("the browser resource profile requires an absolute private profile directory");
  }
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw new Error("timeout must be positive");
  const stdoutLimit = request.stdoutLimit ?? ARTIFACT_LIMITS.stdout;
  const stderrLimit = request.stderrLimit ?? ARTIFACT_LIMITS.stderr;
  if (!Number.isSafeInteger(stdoutLimit) || stdoutLimit < 0 || !Number.isSafeInteger(stderrLimit) || stderrLimit < 0) throw new Error("output limits must be non-negative integers");
  if (request.signal?.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
  const attemptRootFd = request.texmfConfigDirectory === "." && process.platform === "linux"
    ? openAttemptRootFd(request.cwd)
    : undefined;
  const contract: SpawnContract = {
    command: request.command,
    args: Object.freeze([...request.args]),
    cwd: request.cwd,
    env: sanitizedEnvironment(request.texmfConfigDirectory, attemptRootFd),
    shell: false,
    ...(attemptRootFd === undefined ? {} : { attemptRootFd }),
    ...(browserProfile ? { resourceProfile: BROWSER_RESOURCE_PROFILE } : {}),
  };
  try {
    const running = boundary(contract);
    const startToken = processStartToken(running.pid);
    const stdoutPromise = capture(running.stdout, stdoutLimit);
    const stderrPromise = capture(running.stderr, stderrLimit);
    const waitPromise = running.wait();
    const { promise: interrupted, resolve: interrupt } = Promise.withResolvers<"timeout" | "abort">();
    const timer = setTimeout(() => interrupt("timeout"), request.timeoutMs);
    const abort = () => interrupt("abort");
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    let timedOut = false;
    let aborted = false;
    let killAcknowledged = false;
    try {
      const outcome = await Promise.race([
        waitPromise.then((exit) => ({ kind: "exit" as const, exit })),
        interrupted.then((reason) => ({ kind: "interrupt" as const, reason })),
      ]);
      let exit: { code: number | null; signal: NodeJS.Signals | null };
      if (outcome.kind === "interrupt") {
        timedOut = outcome.reason === "timeout";
        aborted = outcome.reason === "abort";
        await running.kill("SIGKILL", browserProfile ? "browser-cgroup" : "process-group");
        exit = await waitPromise;
        killAcknowledged = true;
      } else exit = outcome.exit;
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      return { command: request.command, args: contract.args, pid: running.pid, processStartToken: startToken, code: exit.code, signal: exit.signal, timedOut, aborted, killAcknowledged, stdout, stderr };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
    }
  } finally {
    if (attemptRootFd !== undefined) closeSync(attemptRootFd);
  }
}
