import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveLaunchConfiguration } from "./launch-config.ts";

interface RestartOptions {
  readonly clean?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly log?: (message: string) => void;
  readonly signal?: AbortSignal;
}

function runCommand(
  args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal,
  capture = false,
): Promise<string> {
  signal.throwIfAborted();
  const { promise, resolve: resolveCommand, reject } = Promise.withResolvers<string>();
  const child = spawn(args[0]!, args.slice(1), {
    cwd, env, detached: true,
    stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let failure: Error | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const killGroup = (name: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, name); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(name);
    }
  };
  const stop = (message: string) => {
    if (failure) return;
    failure = new Error(message);
    killGroup("SIGTERM");
    killTimer = setTimeout(() => killGroup("SIGKILL"), 5_000);
  };
  const abort = () => stop("Restart interrupted; production may be stopped.");
  const timer = setTimeout(() => stop(`${args[0]} timed out.`), 600_000);
  signal.addEventListener("abort", abort, { once: true });
  // info includes private env/arguments: bound it, parse in memory, never print it.
  child.stdout?.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1_048_576) stop("Process-manager response exceeded its size limit.");
    else chunks.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1_048_576) stop("Process-manager response exceeded its size limit.");
  });
  child.once("error", () => { failure = new Error(`Could not launch ${args[0]}.`); });
  child.once("close", async (code) => {
    clearTimeout(timer);
    clearTimeout(killTimer);
    if (failure && child.pid) {
      // The direct build process can exit while descendants still write output.
      // Kill the remaining group before artifact restoration can begin.
      killGroup("SIGKILL");
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try { process.kill(-child.pid, 0); } catch { break; }
        await delay(10);
      }
    }
    signal.removeEventListener("abort", abort);
    if (failure || code !== 0) reject(failure ?? new Error(`${args[0]} ${args[1]} failed (exit ${code}).`));
    else resolveCommand(Buffer.concat(chunks).toString("utf8"));
  });
  if (signal.aborted) abort();
  return promise;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function restartProduction(appsRoot: string, options: RestartOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const log = options.log ?? console.log;
  const signal = options.signal ?? new AbortController().signal;
  const configuration = resolveLaunchConfiguration("start", appsRoot, env);
  const checkoutRoot = dirname(appsRoot);
  const assertCheckout = () => {
    signal.throwIfAborted();
    const current = resolveLaunchConfiguration("start", appsRoot, env);
    if (JSON.stringify(current) !== JSON.stringify(configuration)) throw new Error("Checkout changed during restart.");
  };
  for (const command of ["omp", "bun"]) {
    if (!Bun.which(command, env.PATH === undefined ? {} : { PATH: env.PATH })) throw new Error(`Required command not found: ${command}`);
  }
  const lockPath = join(checkoutRoot, ".git", "jobhunt-prod-restart.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Another production restart holds .git/jobhunt-prod-restart.lock. Remove it only after confirming that restart has exited.");
    throw error;
  });
  try {
    const names = ["jobhunt-prod", "jobhunt-harness-prod-bun"] as const;
    const manager = async (action: "info" | "stop" | "restart", name: string) => {
      const args = ["omp", "ps", action, name, "--dir", checkoutRoot, "--json"];
      // Explicit stop avoids restart's short implicit shutdown deadline.
      if (action === "stop") args.push("--timeout", "120");
      const raw = await runCommand(args, checkoutRoot, env, signal, true);
      let result;
      try { result = JSON.parse(raw); } catch { throw new Error(`Invalid process-manager response for ${name}.`); }
      if (result?.name !== name) throw new Error(`Unexpected process-manager identity for ${name}.`);
      if (action === "stop" && !["exited", "failed"].includes(result.state)) throw new Error(`${name} did not stop.`);
      if (action === "restart" && !["starting", "running", "ready"].includes(result.state)) throw new Error(`${name} did not start.`);
      return result;
    };
    for (const name of names) {
      const { spec } = await manager("info", name);
      const valid = name === "jobhunt-prod"
        ? spec?.cwd === appsRoot && basename(spec.application ?? "") === "bun"
          && JSON.stringify(spec.args) === JSON.stringify(["run", "start"])
        : spec?.cwd === join(appsRoot, "harness")
          && basename(spec.application ?? "") === "bun"
          && JSON.stringify(spec.args) === JSON.stringify([
            "run", "start", "--",
            "--port", new URL(configuration.harnessOrigin).port,
            "--pipeline-url", configuration.pipelineOrigin,
          ]);
      if (!valid) throw new Error(`${name} is not registered for this production checkout. No services were stopped.`);
    }
    const builds = ["web/.next", "backend/dist", "harness/dist"].map((relativePath) => {
      const path = join(appsRoot, relativePath);
      return { path, backup: `${path}.prod-restart-backup`, moved: false };
    });
    for (const build of builds) {
      if (await realpath(dirname(build.path)) !== dirname(build.path)) throw new Error("Build directories must not traverse symlinks.");
      if (await exists(build.backup)) throw new Error(`Previous build backup requires recovery: ${build.backup}`);
      if (await exists(build.path)) {
        const status = await lstat(build.path);
        if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("Build output must be a real directory.");
      }
    }
    const cache = join(appsRoot, "web/.next/cache");
    const previousCache = join(appsRoot, "web/.next.prod-restart-backup/cache");
    if (!options.clean && await exists(cache)) {
      const status = await lstat(cache);
      if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("Build cache must be a real directory.");
    }
    assertCheckout();
    log("Stopping production. Active application sessions will end.");
    // Wait for both stop requests, including failure, before moving build output.
    const stopped = await Promise.allSettled(names.map((name) => manager("stop", name)));
    const failedStop = stopped.find((result) => result.status === "rejected");
    if (failedStop?.status === "rejected") throw failedStop.reason;
    assertCheckout();
    let buildId: string;
    try {
      for (const build of builds) {
        if (await exists(build.path)) {
          await rename(build.path, build.backup);
          build.moved = true;
        }
      }
      if (!options.clean && await exists(previousCache)) {
        // Next preserves this directory itself; move it without copying cached bytes.
        await mkdir(dirname(cache));
        await rename(previousCache, cache);
      }
      log(options.clean
        ? "Refreshing pinned dependencies and building without cached output."
        : "Refreshing pinned dependencies and rebuilding with the existing cache.");
      await rm(join(appsRoot, "node_modules"), { recursive: true, force: true });
      await runCommand(["bun", "install", "--frozen-lockfile"], join(appsRoot, "backend"), env, signal);
      await runCommand(["bun", "install", "--frozen-lockfile"], join(appsRoot, "web"), env, signal);
      await runCommand(["bun", "install", "--frozen-lockfile"], join(appsRoot, "harness"), env, signal);
      await runCommand(["bun", "run", "build"], join(appsRoot, "backend"), env, signal);
      await runCommand(["bun", "run", "build"], join(appsRoot, "harness"), env, signal);
      await runCommand(["bun", "run", "build"], join(appsRoot, "web"), env, signal);
      assertCheckout();
      const harnessEntry = await readFile(join(appsRoot, "harness/dist/index.js"));
      if (harnessEntry.length === 0) throw new Error("Production build did not produce the browser harness entrypoint.");
      buildId = (await readFile(join(appsRoot, "web/.next/BUILD_ID"), "utf8")).trim();
      if (!buildId) throw new Error("Production build did not produce a build ID.");
    } catch (error) {
      for (const build of builds) {
        await rm(build.path, { recursive: true, force: true });
        if (build.moved) await rename(build.backup, build.path);
      }
      log("Build failed. Previous build output restored; production remains stopped. Fix the error and rerun make production-restart.");
      throw error;
    }
    for (const build of builds) if (build.moved) await rm(build.backup, { recursive: true });
    log("Starting production with the registered commands and environment.");
    await manager("restart", "jobhunt-harness-prod-bun");
    await manager("restart", "jobhunt-prod");
    const endpoints = [
      `${configuration.pipelineOrigin}/v1/health`,
      `${configuration.harnessOrigin}/healthz`,
      `${configuration.webOrigin}/api/pipeline/health`,
      `${configuration.webOrigin}/`,
    ];
    const deadline = Date.now() + 60_000;
    while (true) {
      signal.throwIfAborted();
      const healthy = await Promise.all(endpoints.map(async (url) => {
        try {
          const response = await request(url, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]) });
          if (!response.ok) { await response.body?.cancel(); return false; }
          return url === endpoints[3]
            ? (await response.text()).includes(buildId)
            : (await response.json()).status === "ok";
        } catch { return false; }
      }));
      if (healthy.every(Boolean)) break;
      if (Date.now() >= deadline) throw new Error("Production health or current-build check failed. Inspect omp ps logs for jobhunt-prod and jobhunt-harness-prod-bun.");
      await delay(250, undefined, { signal });
    }
    log(`Production ready: ${configuration.webOrigin} (build ${buildId}).`);
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--clean")) {
      throw new Error("Usage: bun misc/scripts/restart-production.ts [--clean]");
    }
    await restartProduction(resolve(import.meta.dir, "../../apps"), { signal: controller.signal, clean: args[0] === "--clean" });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Production restart failed.");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
