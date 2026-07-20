import { spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { readFile } from "node:fs/promises";

export const TRUSTED_PROGRAMS = Object.freeze(["latexmk", "pdfinfo", "pdftotext", "pdffonts", "pdftoppm"] as const);
export type TrustedProgram = typeof TRUSTED_PROGRAMS[number];

export interface SpawnContract {
  readonly command: TrustedProgram;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly attemptRootFd?: number;
}

export interface RunningProcess {
  readonly pid: number;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  wait(): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  kill(signal: NodeJS.Signals, target: "process-group"): Promise<void>;
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

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

export function sanitizedEnvironment(texmfConfigDirectory?: ".", attemptRootFd?: number): Readonly<Record<string, string>> {
  const env: Record<string, string> = {
    PATH: DEFAULT_PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    SOURCE_DATE_EPOCH: "0",
  };
  if (texmfConfigDirectory === ".") {
    if (!Number.isSafeInteger(attemptRootFd) || attemptRootFd! < 0) {
      throw new Error("attempt-local TeX cache requires an open root descriptor");
    }
    // HOME remains unset: kpathsea maps an unset home to cwd, without exposing or loading a host home.
    // TeX's Perl launcher closes inherited descriptors before spawning descendants, so those descendants
    // resolve the parent-held descriptor through procfs instead. The parent retains it until process settlement.
    const root = `/proc/${process.pid}/fd/${attemptRootFd}`;
    Object.assign(env, {
      TMPDIR: `${root}/.tex-cache/tmp`,
      TEXMFHOME: ".tex-cache/texmf-home",
      TEXMFVAR: ".tex-cache/texmf-var",
      VARTEXFONTS: `${root}/.tex-cache/fonts`,
      MT_FEATURES: "appendonlydir:varfonts",
      MT_VARTEXFONTS: `${root}/.tex-cache/fonts`,
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

function defaultBoundary(contract: SpawnContract): RunningProcess {
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

async function processStartToken(pid: number): Promise<string | null> {
  if (pid <= 0) return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const endName = stat.lastIndexOf(")");
    const fields = stat.slice(endName + 2).split(" ");
    return fields[19] ?? null;
  } catch { return null; }
}

export async function runTrustedProcess(request: TrustedProcessRequest, boundary: ProcessBoundary = defaultBoundary): Promise<TrustedProcessResult> {
  if (!TRUSTED_PROGRAMS.includes(request.command)) throw new Error(`program is not trusted: ${request.command}`);
  if (!Array.isArray(request.args) || request.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("process arguments must be a NUL-free string array");
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw new Error("timeout must be positive");
  const stdoutLimit = request.stdoutLimit ?? 256 * 1024;
  const stderrLimit = request.stderrLimit ?? 256 * 1024;
  if (!Number.isSafeInteger(stdoutLimit) || stdoutLimit < 0 || !Number.isSafeInteger(stderrLimit) || stderrLimit < 0) throw new Error("output limits must be non-negative integers");
  if (request.signal?.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
  const attemptRootFd = request.texmfConfigDirectory === "." ? openAttemptRootFd(request.cwd) : undefined;
  const contract: SpawnContract = {
    command: request.command,
    args: Object.freeze([...request.args]),
    cwd: request.cwd,
    env: sanitizedEnvironment(request.texmfConfigDirectory, attemptRootFd),
    shell: false,
    ...(attemptRootFd === undefined ? {} : { attemptRootFd }),
  };
  try {
    const running = boundary(contract);
    const startTokenPromise = processStartToken(running.pid);
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
        await running.kill("SIGKILL", "process-group");
        exit = await waitPromise;
        killAcknowledged = true;
      } else exit = outcome.exit;
      const [stdout, stderr, token] = await Promise.all([stdoutPromise, stderrPromise, startTokenPromise]);
      return { command: request.command, args: contract.args, pid: running.pid, processStartToken: token, code: exit.code, signal: exit.signal, timedOut, aborted, killAcknowledged, stdout, stderr };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
    }
  } finally {
    if (attemptRootFd !== undefined) closeSync(attemptRootFd);
  }
}
