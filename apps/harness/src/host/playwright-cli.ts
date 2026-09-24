import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { SourceCaptureResultSchema } from "../contracts/models.ts";

const CapturedSourceSchema = SourceCaptureResultSchema.pick({ final_url: true, source: true });
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };

function playwrightSocketDirectory(): string | undefined {
  if (platform() === "win32") return undefined;
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join("/tmp", `jobhunt-pw-${uid}`);
}

async function preparePlaywrightSocketDirectory(): Promise<string | undefined> {
  const path = playwrightSocketDirectory();
  if (path === undefined) return undefined;
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (details.isSymbolicLink() || !details.isDirectory() || (uid !== undefined && details.uid !== uid)) {
    throw new BrowserConfigurationError("The Playwright socket directory is unavailable");
  }
  await chmod(path, 0o700);
  return path;
}

function withPlaywrightSocketDirectory(environment: Record<string, string>, path = playwrightSocketDirectory()): Record<string, string> {
  return path === undefined ? environment : { ...environment, PWTEST_SOCKETS_DIR: path };
}

export class BrowserConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserConfigurationError";
  }
}

export class PlaywrightCliRuntimeError extends Error {
  readonly code = "browser_failed" as const;
  requiresFreshInspection: boolean;

  constructor(options: { requiresFreshInspection?: boolean } = {}) {
    super("Browser runtime failed.");
    this.name = "PlaywrightCliRuntimeError";
    this.requiresFreshInspection = options.requiresFreshInspection ?? false;
  }
}

export interface BrowserLaunchConfig {
  cdpUrl?: string | null;
  chromeExecutable?: string | null;
  chromeUserDataDir?: string;
}

export interface ResolvedBrowserLaunch {
  cdpUrl: string | null;
  executablePath: string | null;
  userDataDir: string | null;
  isCdp: boolean;
}

function canonicalCdpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserConfigurationError("The CDP URL must be a loopback HTTP origin with an explicit port");
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS[url.hostname.toLowerCase()] ||
    !url.port ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new BrowserConfigurationError("The CDP URL must be a loopback HTTP origin with an explicit port");
  }
  return `http://${url.host.toLowerCase()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null
    && (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBytes)) {
    throw new PlaywrightCliRuntimeError();
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maximumBytes) throw new PlaywrightCliRuntimeError();
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new PlaywrightCliRuntimeError();
  } finally {
    reader.releaseLock();
  }
}

function browserWebSocketUrl(value: unknown, cdpUrl: string): string {
  if (!isRecord(value) || typeof value.webSocketDebuggerUrl !== "string") {
    throw new PlaywrightCliRuntimeError();
  }
  let websocket: URL;
  const cdp = new URL(cdpUrl);
  try {
    websocket = new URL(value.webSocketDebuggerUrl);
  } catch {
    throw new PlaywrightCliRuntimeError();
  }
  if (
    websocket.protocol !== "ws:"
    || !LOOPBACK_HOSTS[websocket.hostname.toLowerCase()]
    || websocket.port !== cdp.port
    || websocket.username
    || websocket.password
    || websocket.search
    || websocket.hash
    || !/^\/devtools\/browser\/[A-Za-z0-9_-]{1,256}$/.test(websocket.pathname)
  ) {
    throw new PlaywrightCliRuntimeError();
  }
  return websocket.href;
}

async function isSymlinkComponent(path: string): Promise<boolean> {
  let cursor = resolve(path);
  while (true) {
    try {
      if ((await lstat(cursor)).isSymbolicLink()) return true;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function defaultProfileRoots(): string[] {
  if (platform() === "darwin") {
    const base = join(homedir(), "Library", "Application Support");
    return [join(base, "Google", "Chrome"), join(base, "Chromium"), join(base, "Google", "Chrome Canary")];
  }
  if (platform() === "linux") return [join(homedir(), ".config", "google-chrome"), join(homedir(), ".config", "chromium")];
  if (platform() === "win32" && process.env.LOCALAPPDATA) {
    return [join(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data"), join(process.env.LOCALAPPDATA, "Chromium", "User Data")];
  }
  return [];
}

function isWithin(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function assertConfinedPath(path: string, root: string, requireExisting: boolean): Promise<string> {
  const absolute = resolve(path);
  if (!isWithin(absolute, root)) throw new PlaywrightCliRuntimeError();
  const parts = relative(root, absolute).split("/").filter(Boolean);
  let cursor = root;
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]!);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new PlaywrightCliRuntimeError();
    } catch (error) {
      if (error instanceof PlaywrightCliRuntimeError) throw error;
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT" || requireExisting) throw new PlaywrightCliRuntimeError();
      break;
    }
  }
  return absolute;
}
export async function resolveBrowserLaunch(config: BrowserLaunchConfig): Promise<ResolvedBrowserLaunch> {
  if (config.cdpUrl != null) {
    if (config.chromeExecutable != null) throw new BrowserConfigurationError("CDP and Chrome executable are mutually exclusive");
    return { cdpUrl: canonicalCdpUrl(config.cdpUrl), executablePath: null, userDataDir: null, isCdp: true };
  }
  if (!config.chromeExecutable) throw new BrowserConfigurationError("Chrome was not found; provide a Chrome executable or loopback CDP URL");
  let executablePath: string;
  try {
    executablePath = await realpath(config.chromeExecutable);
    const details = await stat(executablePath);
    await access(executablePath, fsConstants.X_OK);
    if (!details.isFile()) throw new Error();
  } catch {
    throw new BrowserConfigurationError("The Chrome executable is unavailable");
  }
  const profileInput = config.chromeUserDataDir ?? join(homedir(), ".jobhunt", "browser-harness", "chrome");
  try {
    if (await isSymlinkComponent(profileInput)) throw new BrowserConfigurationError("The Chrome user-data directory must not be a symbolic link");
    const userDataDir = resolve(profileInput);
    if (defaultProfileRoots().some((root) => isWithin(userDataDir, resolve(root)))) throw new BrowserConfigurationError("The Chrome user-data directory must be separate from the operating-system default profile");
    await mkdir(userDataDir, { recursive: true, mode: 0o700 });
    await chmod(userDataDir, 0o700);
    if (!(await stat(userDataDir)).isDirectory()) throw new Error();
    return { cdpUrl: null, executablePath, userDataDir, isCdp: false };
  } catch (error) {
    if (error instanceof BrowserConfigurationError) throw error;
    throw new BrowserConfigurationError("The Chrome user-data directory is unavailable");
  }
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface ProcessRunOptions {
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ManagedProcess {
  pid: number;
  createTime: number;
  executable: string;
  terminate(): Promise<void>;
}

export interface ProcessRunner {
  run(argv: readonly string[], options: ProcessRunOptions): Promise<ProcessResult>;
  spawn?(argv: readonly string[], options: ProcessRunOptions): Promise<ManagedProcess>;
}

export type BrowserFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const MAXIMUM_PROCESS_OUTPUT_BYTES = 65_536;
const PROCESS_OUTPUT_DRAIN_GRACE_MS = 25;

function captureProcessOutput(stream: ReadableStream<Uint8Array>): { finish(): Promise<string> } {
  const reader = stream.getReader();
  const tail = Buffer.allocUnsafe(MAXIMUM_PROCESS_OUTPUT_BYTES);
  let byteLength = 0;
  let cancelRequested = false;
  const read = (async () => {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = Buffer.from(result.value.buffer, result.value.byteOffset, result.value.byteLength);
        if (chunk.byteLength >= MAXIMUM_PROCESS_OUTPUT_BYTES) {
          chunk.copy(tail, 0, chunk.byteLength - MAXIMUM_PROCESS_OUTPUT_BYTES);
          byteLength = MAXIMUM_PROCESS_OUTPUT_BYTES;
          continue;
        }
        const overflow = Math.max(0, byteLength + chunk.byteLength - MAXIMUM_PROCESS_OUTPUT_BYTES);
        if (overflow > 0) {
          tail.copyWithin(0, overflow, byteLength);
          byteLength -= overflow;
        }
        chunk.copy(tail, byteLength);
        byteLength += chunk.byteLength;
      }
    } catch (error) {
      if (!cancelRequested) throw error;
    } finally {
      reader.releaseLock();
    }
    return tail.subarray(0, byteLength).toString("utf8");
  })();

  return {
    async finish() {
      const settled = await Promise.race([
        read.then((output) => ({ output })),
        Bun.sleep(PROCESS_OUTPUT_DRAIN_GRACE_MS).then(() => undefined),
      ]);
      if (settled !== undefined) return settled.output;
      cancelRequested = true;
      await reader.cancel().catch(() => undefined);
      return read;
    },
  };
}

const defaultProcessRunner: ProcessRunner = {
  async run(argv, options) {
    const child = Bun.spawn([...argv], { cwd: options.cwd, env: options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const abort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.timeoutMs !== undefined) timer = setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs);
    try {
      const stdoutCapture = captureProcessOutput(child.stdout);
      const stderrCapture = captureProcessOutput(child.stderr);
      const exitCode = await child.exited;
      const [stdout, stderr] = await Promise.all([stdoutCapture.finish(), stderrCapture.finish()]);
      return { exitCode, stdout, stderr, timedOut };

    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  },
  async spawn(argv, options) {
    const child = Bun.spawn([...argv], { cwd: options.cwd, env: options.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return {
      pid: child.pid,
      createTime: Date.now() / 1000,
      executable: argv[0]!,
      async terminate() {
        child.kill("SIGTERM");
        const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
        if (!stopped) child.kill("SIGKILL");
        await child.exited;
      },
    };
  },
};

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

const APPROVED_COMMANDS: Record<string, true> = Object.fromEntries([
  "goto", "snapshot", "click", "dblclick", "type", "press", "fill", "drag", "drop", "hover", "select", "upload", "check", "uncheck", "eval", "dialog-accept", "dialog-dismiss", "resize", "go-back", "go-forward", "reload", "keydown", "keyup", "mousemove", "mousedown", "mouseup", "mousewheel", "screenshot", "pdf", "tab-list", "tab-new", "tab-close", "tab-select", "generate-locator", "highlight", "video-chapter", "video-show-actions", "video-hide-actions",
].map((command) => [command, true]));

const RESERVED_ARGUMENTS: Record<string, true> = Object.fromEntries([
  "-s", "--s", "-h", "--help", "-v", "--version", "--session", "--json", "--raw", "--config", "--profile", "--persistent", "--headed", "--browser", "--cdp", "--endpoint", "--extension",
].map((argument) => [argument, true]));
const RESERVED_PREFIXES = ["-s", "--s=", "-h=", "--help=", "-v=", "--version=", "--session=", "--json=", "--raw=", "--config=", "--profile=", "--persistent=", "--headed=", "--browser=", "--cdp=", "--endpoint=", "--extension="];

export interface BrowserTab {
  url: string;
  title: string;
  tabId: string;
  parentTabId: null;
}

export interface BrowserObservation {
  url: string;
  title: string;
  tabs: BrowserTab[];
  dom: string;
  pageInfo: { currentTab: number } | null;
  screenshot: { mediaType: "image/png"; data: string } | null;
}

export type CliErrorCategory = "target_closed" | "no_open_pages" | "page_crashed" | "timeout" | "modal_blocked" | "modal_handler_mismatch" | "stale_reference" | "wrong_control_type" | "invalid_value" | "protocol_error" | "unknown";

export interface PlaywrightCliExecutionResult extends ProcessResult {
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  cliErrorCategory: CliErrorCategory | null;
  observation: BrowserObservation;
}

interface PageMetadata {
  url: string;
  title: string;
  currentIndex: number;
  targetId: string | null;
  tabs: Array<{ url: string; title: string }>;
  screenshot?: boolean;
}

async function readTargetReferences(path: string): Promise<string[]> {
  let details;
  try { details = await lstat(path); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new BrowserConfigurationError("A stale Playwright CLI session could not be reclaimed");
  }
  if (details.isSymbolicLink() || !details.isFile() || details.size > 1_048_576) throw new BrowserConfigurationError("A stale Playwright CLI session could not be reclaimed");
  const encoded = await readFile(path);
  if (encoded.length > 1_048_576) throw new BrowserConfigurationError("A stale Playwright CLI session could not be reclaimed");
  const text = encoded.toString("ascii");
  if (!Buffer.from(text, "ascii").equals(encoded)) throw new BrowserConfigurationError("A stale Playwright CLI session could not be reclaimed");
  const references = text.split(/\r?\n/).filter(Boolean);
  if (references.length === 0 || new Set(references).size !== references.length) throw new BrowserConfigurationError("A stale Playwright CLI session could not be reclaimed");
  for (const reference of references) {
    const window = /^window:([1-9][0-9]{0,15}):([A-Fa-f0-9]{8,128})$/.exec(reference);
    if (/^[A-Fa-f0-9]{8,128}$/.test(reference) || /^marker:[a-f0-9]{64}$/.test(reference) || (window !== null && Number(window[1]) <= Number.MAX_SAFE_INTEGER)) continue;
    throw new BrowserConfigurationError("A stale Playwright CLI session could not be reclaimed");
  }
  return references;
}

export async function recoverStalePlaywrightCliSessions(options: { artifactsRoot: string; nodeExecutable: string; cliScript: string; processRunner?: ProcessRunner }): Promise<string[]> {
  const root = resolve(options.artifactsRoot);
  let candidates;
  try { candidates = await readdir(root); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new BrowserConfigurationError("The application artifact directory is unavailable");
  }
  const runner = options.processRunner ?? defaultProcessRunner;
  const socketDirectory = await preparePlaywrightSocketDirectory();
  const recovered: string[] = [];
  for (const name of candidates.sort()) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)) continue;
    const sessionDirectory = join(root, name);
    const scope = join(sessionDirectory, "playwright-cli");
    const ownershipPath = join(scope, "ownership.json");
    let ownershipDetails;
    try { ownershipDetails = await lstat(ownershipPath); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw new BrowserConfigurationError("A stale Playwright CLI session could not be reclaimed");
    }
    if (ownershipDetails.isSymbolicLink() || !ownershipDetails.isFile() || ownershipDetails.size > 4096) throw new BrowserConfigurationError("A stale Playwright CLI session could not be reclaimed");
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(await readFile(ownershipPath, "utf8")) as Record<string, unknown>; } catch { throw new BrowserConfigurationError("A stale Playwright CLI session could not be reclaimed"); }
    const sessionName = "jobhunt-" + name.replaceAll("-", "");
    if (payload.session_name !== sessionName || (payload.daemon_pid !== undefined && (!Number.isInteger(payload.daemon_pid) || Number(payload.daemon_pid) <= 1))) throw new BrowserConfigurationError("A stale Playwright CLI session could not be reclaimed");
    const targets = await readTargetReferences(join(scope, "internal", "target-id"));
    const result = await runner.run([options.nodeExecutable, options.cliScript, "--session=" + sessionName, "close", "--json"], { cwd: sessionDirectory, env: withPlaywrightSocketDirectory({ PATH: process.env.PATH ?? "", HOME: join(scope, "home"), CI: "1", NO_UPDATE_NOTIFIER: "1" }, socketDirectory), timeoutMs: 10_000 });
    let closed: Record<string, unknown>;
    try { closed = JSON.parse(result.stdout) as Record<string, unknown>; } catch { throw new BrowserConfigurationError("A stale Playwright CLI session could not be reclaimed"); }
    if (result.exitCode !== 0 || result.stderr || closed.session !== sessionName || !["closed", "not-open"].includes(String(closed.status))) throw new BrowserConfigurationError("A stale Playwright CLI session could not be reclaimed");
    await unlink(ownershipPath);
    recovered.push(...targets.filter((target) => /^[A-Fa-f0-9]{8,128}$/.test(target)));
  }
  return recovered;
}

interface BrowserWindowResult {
  windowId: number;
  bounds: { windowState?: string };
}

async function sendBrowserCommand(
  websocketUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const socket = new WebSocket(websocketUrl);
  let receivedBytes = 0;
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  const fail = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.close();
    reject(new PlaywrightCliRuntimeError());
  };
  timer = setTimeout(fail, 2_000);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ id: 1, method, params }));
  });
  socket.addEventListener("message", (event) => {
    try {
      if (typeof event.data !== "string") {
        fail();
        return;
      }
      receivedBytes += Buffer.byteLength(event.data);
      if (receivedBytes > 65_536) {
        fail();
        return;
      }
      const message = JSON.parse(event.data) as unknown;
      if (!isRecord(message)) {
        fail();
        return;
      }
      if (message.id !== 1) return;
      if ("error" in message || !("result" in message)) {
        fail();
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(message.result);
    } catch {
      fail();
    }
  });
  socket.addEventListener("error", fail);
  socket.addEventListener("close", () => {
    if (!settled) fail();
  });
  return await promise;
}

function browserWindowResult(value: unknown): BrowserWindowResult {
  if (
    !isRecord(value)
    || !Number.isInteger(value.windowId)
    || Number(value.windowId) < 1
    || Number(value.windowId) > Number.MAX_SAFE_INTEGER
    || !isRecord(value.bounds)
    || (value.bounds.windowState !== undefined && typeof value.bounds.windowState !== "string")
  ) {
    throw new PlaywrightCliRuntimeError();
  }
  return {
    windowId: Number(value.windowId),
    bounds: value.bounds as { windowState?: string },
  };
}

async function restoreMinimizedBrowserWindow(
  cdpUrl: string,
  targetId: string,
  fetcher: BrowserFetch,
): Promise<void> {
  let websocketUrl: string;
  try {
    const response = await fetcher(cdpUrl + "/json/version", {
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new PlaywrightCliRuntimeError();
    websocketUrl = browserWebSocketUrl(
      JSON.parse(await readBoundedText(response, 65_536)) as unknown,
      cdpUrl,
    );
  } catch (error) {
    if (error instanceof PlaywrightCliRuntimeError) throw error;
    throw new PlaywrightCliRuntimeError();
  }
  const window = browserWindowResult(await sendBrowserCommand(
    websocketUrl,
    "Browser.getWindowForTarget",
    { targetId },
  ));
  if (window.bounds.windowState !== "minimized") return;
  await sendBrowserCommand(websocketUrl, "Browser.setWindowBounds", {
    windowId: window.windowId,
    bounds: { windowState: "normal" },
  });
}

export class PlaywrightCliBrowser {
  readonly #artifactsRoot: string;
  readonly #launch: ResolvedBrowserLaunch;
  readonly #processRunner: ProcessRunner;
  readonly #fetcher: BrowserFetch;
  #managedCdpUrl: string | null = null;
  #managedProcess: ManagedProcess | null = null;
  #started = false;
  #closed = false;

  constructor(options: { artifactsRoot: string; launch: ResolvedBrowserLaunch; processRunner?: ProcessRunner; fetcher?: BrowserFetch }) {
    this.#artifactsRoot = resolve(options.artifactsRoot);
    this.#launch = options.launch;
    this.#processRunner = options.processRunner ?? defaultProcessRunner;
    this.#fetcher = options.fetcher ?? fetch;
  }

  get cdpUrl(): string {
    const endpoint = this.#launch.cdpUrl ?? this.#managedCdpUrl;
    if (!this.#started || endpoint === null) throw new PlaywrightCliRuntimeError();
    return endpoint;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closed) throw new PlaywrightCliRuntimeError();
    const scope = join(this.#artifactsRoot, ".browser");
    const ownershipPath = join(scope, "ownership.json");
    await mkdir(scope, { recursive: true, mode: 0o700 });
    await chmod(scope, 0o700);
    if (this.#launch.isCdp) {
      this.#started = true;
      return;
    }
    if (this.#launch.executablePath === null || this.#launch.userDataDir === null || this.#processRunner.spawn === undefined) throw new PlaywrightCliRuntimeError();
    try {
      await lstat(ownershipPath);
      throw new PlaywrightCliRuntimeError();
    } catch (error) {
      if (error instanceof PlaywrightCliRuntimeError) throw error;
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw new PlaywrightCliRuntimeError();
    }
    const devtoolsPath = join(this.#launch.userDataDir, "DevToolsActivePort");
    await unlink(devtoolsPath).catch((error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw new PlaywrightCliRuntimeError();
    });
    const ownerToken = "jobhunt-browser-" + randomUUID().replaceAll("-", "");
    const baseOwnership = { version: 1, session_name: ownerToken, native_launcher: this.#launch.executablePath, native_user_data_dir: this.#launch.userDataDir, native_owner_token: ownerToken };
    await writePrivateJson(ownershipPath, baseOwnership);
    try {
      const managedProcess = await this.#processRunner.spawn([
        this.#launch.executablePath, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--user-data-dir=" + this.#launch.userDataDir, "--no-first-run", "--no-default-browser-check", "--jobhunt-owner-token=" + ownerToken,
      ], { cwd: this.#artifactsRoot, env: { ...process.env, HOME: homedir() } });
      this.#managedProcess = managedProcess;
      await writePrivateJson(ownershipPath, { ...baseOwnership, native_executable: managedProcess.executable, native_browser_pid: managedProcess.pid, native_browser_create_time: managedProcess.createTime });
      const deadline = Date.now() + 10_000;
      let endpoint: string | null = null;
      let websocket: string | null = null;
      while (Date.now() < deadline) {
        try {
          const details = await lstat(devtoolsPath);
          if (details.isSymbolicLink() || !details.isFile() || details.size > 4096) throw new PlaywrightCliRuntimeError();
          const [port, path] = (await readFile(devtoolsPath, "utf8")).trimEnd().split("\n");
          if (!port || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65_535 || !path?.startsWith("/devtools/browser/")) throw new PlaywrightCliRuntimeError();
          endpoint = "http://127.0.0.1:" + port;
          websocket = "ws://127.0.0.1:" + port + path;
          break;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
          await Bun.sleep(50);
        }
      }
      if (endpoint === null || websocket === null) throw new PlaywrightCliRuntimeError();
      const response = await this.#fetcher(endpoint + "/json/version", { redirect: "error", signal: AbortSignal.timeout(2_000) });
      if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 65_536) throw new PlaywrightCliRuntimeError();
      const body = await response.text();
      if (Buffer.byteLength(body) > 65_536 || (JSON.parse(body) as Record<string, unknown>).webSocketDebuggerUrl !== websocket) throw new PlaywrightCliRuntimeError();
      this.#managedCdpUrl = endpoint;
      this.#started = true;
    } catch {
      let processStopped = this.#managedProcess === null;
      if (this.#managedProcess !== null) {
        try {
          await this.#managedProcess.terminate();
          processStopped = true;
        } catch {
          processStopped = false;
        }
      }
      if (processStopped) {
        await unlink(ownershipPath).catch((error: unknown) => {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw new PlaywrightCliRuntimeError();
        });
        this.#managedProcess = null;
      }
      this.#managedCdpUrl = null;
      throw new PlaywrightCliRuntimeError();
    }
  }

  async claimTargets(targetPath: string): Promise<string[]> {
    return readTargetReferences(targetPath);
  }

  async activateTarget(targetId: string): Promise<void> {
    if (!/^[A-Fa-f0-9]{8,128}$/.test(targetId)) throw new PlaywrightCliRuntimeError();
    const cdpUrl = this.cdpUrl;
    await restoreMinimizedBrowserWindow(cdpUrl, targetId, this.#fetcher);
    const response = await this.#fetcher(cdpUrl + "/json/activate/" + targetId, {
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new PlaywrightCliRuntimeError();
  }

  async closeTarget(targetId: string): Promise<void> {
    if (!/^[A-Fa-f0-9]{8,128}$/.test(targetId)) throw new PlaywrightCliRuntimeError();
    const response = await this.#fetcher(this.cdpUrl + "/json/close/" + targetId, { redirect: "error" });
    if (!response.ok && !((await response.text()).includes("No such target"))) throw new PlaywrightCliRuntimeError();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#managedProcess !== null) {
      await this.#managedProcess.terminate();
      await unlink(join(this.#artifactsRoot, ".browser", "ownership.json"));
      this.#managedProcess = null;
      this.#managedCdpUrl = null;
    }
    this.#started = false;
    this.#closed = true;
  }
}

function validatedBrowserUrl(value: string, allowAboutBlank = false): string {
  if (allowAboutBlank && value === "about:blank") return value;
  let url: URL;
  try { url = new URL(value); } catch { throw new PlaywrightCliRuntimeError(); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const loopback = LOOPBACK_HOSTS[hostname] === true || /^127(?:\.[0-9]{1,3}){3}$/.test(hostname);
  if (!["http:", "https:"].includes(url.protocol) || (url.protocol === "http:" && !loopback) || url.username || url.password || !hostname || hostname.includes("*")) throw new PlaywrightCliRuntimeError();
  return value;
}

function cliReportedError(result: ProcessResult): boolean {
  if (result.exitCode !== 0) return true;
  try { return (JSON.parse(result.stdout) as Record<string, unknown>).isError === true; } catch { return false; }
}

function classifyCliError(stdout: string): CliErrorCategory {
  const categories: Array<[string, CliErrorCategory]> = [
    ["Target page, context or browser has been closed", "target_closed"], ["No open pages available", "no_open_pages"], ["Target crashed", "page_crashed"], ["Page crashed", "page_crashed"], ["Timeout", "timeout"], ["does not handle the modal state", "modal_blocked"], ["can only be used when there is related modal state present", "modal_handler_mismatch"], ["not found in the current page snapshot", "stale_reference"], ["Element is not a <select> element", "wrong_control_type"], ["Malformed value", "invalid_value"], ["Protocol error", "protocol_error"],
  ];
  for (const [fragment, category] of categories) if (stdout.includes(fragment)) return category;
  return "unknown";
}

export class PlaywrightCliRuntime {
  readonly #sessionName: string;
  readonly #browser: PlaywrightCliBrowser;
  readonly #sessionDirectory: string;
  readonly #nodeExecutable: string;
  readonly #cliScript: string;
  readonly #runner: ProcessRunner;
  readonly #scopeDirectory: string;
  readonly #outputDirectory: string;
  readonly #videoPath: string;
  readonly #ownershipPath: string;
  readonly #privateValues = new Set<string>();
  #opened = false;
  #started = false;
  #closed = false;
  #requiresSnapshot = false;
  #modalRecoveryPending = false;
  #metadata: PageMetadata | null = null;
  #selectedTargetId: string | null = null;
  #screenshotsSuppressed = false;
  #videoStarted = false;

  constructor(options: { sessionId: string; browser: PlaywrightCliBrowser; sessionDirectory: string; nodeExecutable: string; cliScript: string; processRunner?: ProcessRunner }) {
    const compact = options.sessionId.replaceAll("-", "");
    if (!/^[a-f0-9]{32}$/i.test(compact)) throw new BrowserConfigurationError("The Playwright CLI session is invalid");
    this.#sessionName = "jobhunt-" + compact.toLowerCase();
    this.#browser = options.browser;
    this.#sessionDirectory = resolve(options.sessionDirectory);
    this.#nodeExecutable = options.nodeExecutable;
    this.#cliScript = options.cliScript;
    this.#runner = options.processRunner ?? defaultProcessRunner;
    this.#scopeDirectory = join(this.#sessionDirectory, "playwright-cli");
    this.#outputDirectory = join(this.#scopeDirectory, "output");
    this.#videoPath = join(this.#scopeDirectory, "video", "session.webm");
    this.#ownershipPath = join(this.#scopeDirectory, "ownership.json");
    for (const value of [this.#sessionDirectory, this.#scopeDirectory, this.#outputDirectory, this.#nodeExecutable, this.#cliScript, this.#sessionName]) this.#privateValues.add(value);
  }

  get sessionName(): string { return this.#sessionName; }

  async #invoke(command: string, args: readonly string[] = [], timeoutMs?: number, reconnectTargetId?: string): Promise<ProcessResult> {
    const result = await this.#runner.run([this.#nodeExecutable, this.#cliScript, "--session=" + this.#sessionName, command, ...args, "--json"], {
      cwd: this.#sessionDirectory,
      env: withPlaywrightSocketDirectory({ HOME: join(this.#scopeDirectory, "home"), TMPDIR: join(this.#scopeDirectory, "temporary"), XDG_CONFIG_HOME: join(this.#scopeDirectory, "home", ".config"), JOBHUNT_PLAYWRIGHT_PAGE_TOKEN: this.#sessionName, JOBHUNT_PLAYWRIGHT_TARGET_PATH: join(this.#scopeDirectory, "internal", "target-id"), ...(reconnectTargetId === undefined ? {} : { JOBHUNT_PLAYWRIGHT_RECONNECT_TARGET_ID: reconnectTargetId }), PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright"), NO_UPDATE_NOTIFIER: "1", CI: "1", PATH: process.env.PATH ?? "" }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return result;
  }

  async start(jobUrl: string): Promise<void> {
    if (this.#started) return;
    if (this.#closed) throw new PlaywrightCliRuntimeError();
    validatedBrowserUrl(jobUrl);
    await Promise.all([preparePlaywrightSocketDirectory(), ...["output", "internal", "video", "home", "temporary"].map((name) => mkdir(join(this.#scopeDirectory, name), { recursive: true, mode: 0o700 }))]);
    await writePrivateJson(join(this.#scopeDirectory, "cli.config.json"), {
      browser: {
        browserName: "chromium",
        contextOptions: { acceptDownloads: false },
        cdpEndpoint: this.#browser.cdpUrl,
        isolated: false,
      },
      outputDir: this.#outputDirectory,
      outputMode: "stdout",
      allowUnrestrictedFileAccess: false,
      codegen: "none",
      snapshot: { mode: "none" },
      console: { level: "none" },
    });
    const lease = await this.#invoke("--jobhunt-page-lease-version");
    if (lease.exitCode !== 0 || lease.stdout !== "1\n" || lease.stderr) throw new PlaywrightCliRuntimeError();
    const opened = await this.#invoke("open", ["about:blank", "--config=" + join(this.#scopeDirectory, "cli.config.json")]);
    if (cliReportedError(opened)) throw new PlaywrightCliRuntimeError();
    let daemonPid: number | undefined;
    try {
      const value = JSON.parse(opened.stdout) as Record<string, unknown>;
      if (Number.isInteger(value.pid) && Number(value.pid) > 1) daemonPid = Number(value.pid);
    } catch { /* the CLI may omit a daemon PID */ }
    const targetPath = join(this.#scopeDirectory, "internal", "target-id");
    const targetReferences = await this.#browser.claimTargets(targetPath);
    await writePrivateJson(this.#ownershipPath, {
      session_name: this.#sessionName,
      ...(daemonPid === undefined ? {} : { daemon_pid: daemonPid }),
      target_references: targetReferences,
    });
    this.#opened = true;
    for (const [command, args] of [["tab-list", []], ["video-start", [this.#videoPath]], ["goto", [jobUrl]]] as const) {
      const result = await this.#invoke(command, args);
      if (cliReportedError(result)) throw new PlaywrightCliRuntimeError();
      if (command === "video-start") this.#videoStarted = true;
    }
    this.#metadata = await this.#readMetadata();
    this.#started = true;
  }

  async #readMetadata(): Promise<PageMetadata> {
    const owner = JSON.stringify(this.#sessionName);
    const script = `async (page) => {const clip=(value,limit)=>Array.from(value.slice(0,limit*2)).slice(0,limit).join('');const owner=${owner};const pages=page.context().pages().filter(p=>p.__jobhuntPageOwner===owner);return {url:clip(page.url(),4096),title:clip(await page.title().catch(()=>''),4096),targetId:page.__jobhuntTargetId,currentIndex:pages.indexOf(page),tabs:await Promise.all(pages.slice(0,100).map(async p=>({url:clip(p.url(),4096),title:clip(await p.title().catch(()=>''),4096)})))};}`;
    const result = await this.#invoke("run-code", [script]);
    if (cliReportedError(result)) throw new PlaywrightCliRuntimeError({ requiresFreshInspection: true });
    try {
      const outer = JSON.parse(result.stdout) as { result: unknown };
      let value = outer.result;
      for (let count = 0; count < 2 && typeof value === "string"; count++) value = JSON.parse(value);
      if (typeof value !== "object" || value === null) throw new Error();
      const raw = value as Record<string, unknown>;
      if (typeof raw.url !== "string" || typeof raw.title !== "string" || !Number.isInteger(raw.currentIndex) || !Array.isArray(raw.tabs)) throw new Error();
      validatedBrowserUrl(raw.url, true);
      const tabs = raw.tabs.slice(0, 100).map((item) => {
        if (typeof item !== "object" || item === null || typeof (item as Record<string, unknown>).url !== "string" || typeof (item as Record<string, unknown>).title !== "string") throw new Error();
        return { url: String((item as Record<string, unknown>).url), title: String((item as Record<string, unknown>).title).slice(0, 4096) };
      });
      const targetId = typeof raw.targetId === "string" && /^[A-Fa-f0-9]{8,128}$/.test(raw.targetId) ? raw.targetId : null;
      this.#selectedTargetId = targetId;
      return { url: raw.url, title: raw.title.slice(0, 4096), currentIndex: raw.currentIndex as number, targetId, tabs, screenshot: raw.screenshot === true };
    } catch {
      throw new PlaywrightCliRuntimeError({ requiresFreshInspection: true });
    }
  }

  #redact(value: string): string {
    let redacted = value;
    for (const secret of [...this.#privateValues].sort((left, right) => right.length - left.length)) {
      const jsonEscaped = JSON.stringify(secret).slice(1, -1);
      const yamlSingleQuoted = secret.replaceAll("'", "''");
      const variants = [secret, encodeURIComponent(secret), encodeURI(secret), jsonEscaped, yamlSingleQuoted];
      for (const variant of variants.sort((left, right) => right.length - left.length)) {
        if (variant) redacted = redacted.replaceAll(variant, "[redacted]");
      }
    }
    return redacted;
  }

  #observation(metadata: PageMetadata, dom: string): BrowserObservation {
    return {
      url: metadata.url.slice(0, 4096), title: this.#redact(metadata.title).slice(0, 4096),
      tabs: metadata.tabs.map((tab, index) => ({ url: tab.url.slice(0, 4096), title: this.#redact(tab.title).slice(0, 4096), tabId: String(index), parentTabId: null })),
      dom: this.#redact(dom).slice(0, 40_000), pageInfo: { currentTab: metadata.currentIndex }, screenshot: null,
    };
  }

  async #validateInvocation(command: string, args: readonly string[]): Promise<string[]> {
    if (!APPROVED_COMMANDS[command] || args.length > 64) throw new PlaywrightCliRuntimeError();
    let bytes = Buffer.byteLength(command);
    const values = [...args];
    for (const value of values) {
      const size = Buffer.byteLength(value);
      if (value.includes("\0") || size > 8192 || RESERVED_ARGUMENTS[value] || RESERVED_PREFIXES.some((prefix) => value.startsWith(prefix))) throw new PlaywrightCliRuntimeError();
      bytes += size;
    }
    if (bytes > 65_536) throw new PlaywrightCliRuntimeError();
    if (command === "goto") { if (values.length !== 1) throw new PlaywrightCliRuntimeError(); validatedBrowserUrl(values[0]!); }
    if (command === "tab-new" && values.length > 0) { if (values.length !== 1) throw new PlaywrightCliRuntimeError(); validatedBrowserUrl(values[0]!); }
    if (command === "upload") { if (values.length !== 1) throw new PlaywrightCliRuntimeError(); values[0] = await this.#confinedInput(values[0]!); }
    for (let index = 0; index < values.length; index++) {
      const value = values[index]!;
      if (["snapshot", "screenshot", "pdf", "eval"].includes(command) && value.startsWith("--filename=")) values[index] = "--filename=" + await this.#confinedOutput(value.slice(11));
      if (command === "drop" && value.startsWith("--path=")) values[index] = "--path=" + await this.#confinedInput(value.slice(7));
    }
    return values;
  }

  async #confinedInput(value: string): Promise<string> {
    const path = resolve(this.#sessionDirectory, value);
    if (isWithin(path, this.#scopeDirectory)) throw new PlaywrightCliRuntimeError();
    return assertConfinedPath(path, this.#sessionDirectory, true);
  }

  async #confinedOutput(value: string): Promise<string> {
    const path = resolve(this.#outputDirectory, value);
    return assertConfinedPath(path, this.#outputDirectory, false);
  }

  async execute(command: string, args: readonly string[] = []): Promise<PlaywrightCliExecutionResult> {
    if (!this.#started || this.#closed) throw new PlaywrightCliRuntimeError();
    const modalRecoveryCommand = command === "dialog-accept" || command === "dialog-dismiss";
    if (this.#requiresSnapshot && command !== "snapshot" && !(this.#modalRecoveryPending && modalRecoveryCommand)) throw new PlaywrightCliRuntimeError({ requiresFreshInspection: true });
    let normalized: string[];
    try { normalized = await this.#validateInvocation(command, args); } catch {
      const metadata = this.#metadata ?? await this.#readMetadata();
      return { exitCode: 1, stdout: "", stderr: "Command rejected: check the command, arguments, URL, and session-local paths.", stdoutTruncated: false, stderrTruncated: false, cliErrorCategory: null, observation: this.#observation(metadata, "") };
    }
    if (["tab-select", "tab-new", "tab-close"].includes(command)) this.#selectedTargetId = null;
    let action: ProcessResult;
    try { action = await this.#invoke(command, normalized); } catch {
      this.#metadata = null; this.#requiresSnapshot = true;
      throw new PlaywrightCliRuntimeError({ requiresFreshInspection: true });
    }
    const missing = action.stdout.includes("The browser '" + this.#sessionName + "' is not open") || (action.stderr.includes("Error: Session closed") && action.stderr.includes("SocketConnectionClient._rejectCallbacks"));
    if (missing) {
      this.#metadata = null; this.#requiresSnapshot = true;
      if (command === "snapshot" && this.#selectedTargetId !== null) {
        const attached = await this.#invoke("attach", ["--cdp=" + this.#browser.cdpUrl, "--config=" + join(this.#scopeDirectory, "cli.config.json")], undefined, this.#selectedTargetId);
        if (attached.exitCode === 0) return this.execute(command, args);
      }
      throw new PlaywrightCliRuntimeError({ requiresFreshInspection: true });
    }
    let metadata: PageMetadata;
    try { metadata = await this.#readMetadata(); } catch {
      this.#metadata = null; this.#requiresSnapshot = true;
      return { exitCode: 1, stdout: "", stderr: "Browser observation failed. Take a new snapshot before continuing.", stdoutTruncated: false, stderrTruncated: false, cliErrorCategory: null, observation: { url: "[redacted]", title: "[redacted]", tabs: [], dom: "", pageInfo: null, screenshot: null } };
    }
    this.#metadata = metadata;
    let reportedError = false;
    try { reportedError = (JSON.parse(action.stdout) as Record<string, unknown>).isError === true; } catch { /* not an error envelope */ }
    const cliErrorCategory = reportedError ? classifyCliError(action.stdout) : null;
    const exitCode = reportedError && action.exitCode === 0 ? 1 : action.exitCode;
    if (exitCode !== 0) {
      this.#requiresSnapshot = true;
      this.#modalRecoveryPending = cliErrorCategory === "modal_blocked" || cliErrorCategory === "modal_handler_mismatch";
    } else if (command === "snapshot") {
      this.#requiresSnapshot = false;
      this.#modalRecoveryPending = false;
    } else if (modalRecoveryCommand) {
      this.#modalRecoveryPending = false;
    }
    let dom = "";
    try { const payload = JSON.parse(action.stdout) as Record<string, unknown>; if (typeof payload.snapshot === "string") dom = payload.snapshot; } catch { /* ordinary text output */ }
    const stdout = this.#redact(action.stdout); const stderr = this.#redact(action.stderr);
    return { exitCode, stdout: stdout.slice(-20_000), stderr: stderr.slice(-20_000), ...(action.timedOut === undefined ? {} : { timedOut: action.timedOut }), stdoutTruncated: stdout.length > 20_000, stderrTruncated: stderr.length > 20_000, cliErrorCategory, observation: this.#observation(metadata, dom) };
  }

  async getCurrentPageUrl(): Promise<string> { this.#metadata = await this.#readMetadata(); return this.#metadata.url; }

  async captureSourceSnapshot(): Promise<readonly [string, string] | null> {
    if (!this.#started || this.#closed) throw new PlaywrightCliRuntimeError();
    const result = await this.#invoke("run-code", [
      "async (page) => ({url:page.url(),source:await page.evaluate(()=>document.body?.innerText||document.documentElement?.innerText||'')})",
    ]);
    if (result.exitCode !== 0) throw new PlaywrightCliRuntimeError({ requiresFreshInspection: true });
    try {
      const outer = JSON.parse(result.stdout) as { result: unknown };
      let value = outer.result;
      for (let count = 0; count < 2 && typeof value === "string"; count += 1) value = JSON.parse(value);
      if (!value || typeof value !== "object") return null;
      const captured = value as { url?: unknown; source?: unknown };
      const parsed = CapturedSourceSchema.safeParse({ final_url: captured.url, source: captured.source });
      return parsed.success ? [parsed.data.final_url, parsed.data.source] : null;
    } catch {
      return null;
    }
  }

  async activatePrivateValues(values: readonly string[]): Promise<void> {
    if (!this.#opened || this.#closed) throw new PlaywrightCliRuntimeError();
    this.#screenshotsSuppressed = true;
    for (const value of values) if (typeof value === "string" && value.length > 0) this.#privateValues.add(value);
    this.#metadata = await this.#readMetadata();
    this.#screenshotsSuppressed = false;
  }

  async suppressPrivateCapture(): Promise<void> {
    if (!this.#started || this.#closed) throw new PlaywrightCliRuntimeError();
    this.#screenshotsSuppressed = true;
    if (this.#videoStarted) {
      const stopped = await this.#invoke("video-stop");
      if (stopped.exitCode !== 0) throw new PlaywrightCliRuntimeError();
      this.#videoStarted = false;
    }
  }

  async #invokePrivateScript(script: string): Promise<ProcessResult> {
    const internalDirectory = join(this.#scopeDirectory, "internal");
    const fifoPath = join(internalDirectory, ".private-" + randomUUID() + ".js");
    const created = Bun.spawn(["mkfifo", "-m", "600", fifoPath], { cwd: internalDirectory, stdout: "ignore", stderr: "pipe" });
    if (await created.exited !== 0) throw new PlaywrightCliRuntimeError();
    try {
      const details = await lstat(fifoPath);
      if (!details.isFIFO() || (details.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && details.uid !== process.getuid())) throw new PlaywrightCliRuntimeError();
      const writer = writeFile(fifoPath, script, { encoding: "utf8" });
      let result: ProcessResult;
      try {
        result = await this.#invoke("run-code", ["--filename=" + fifoPath]);
      } finally {
        await writer;
      }
      return result;
    } finally {
      await unlink(fifoPath).catch(() => undefined);
    }
  }

  async signIn(input: Record<string, string | undefined>): Promise<void> {
    await this.suppressPrivateCapture();
    const { usernameRef, passwordRef, passwordConfirmationRef, submitRef, username, password } = input;
    const refs = [usernameRef, passwordRef, submitRef, ...(passwordConfirmationRef === undefined ? [] : [passwordConfirmationRef])];
    if (refs.some((value) => typeof value !== "string" || !/^e[0-9]+$/.test(value)) ||
        typeof username !== "string" || username !== username.trim() || username.length < 1 || username.length > 320 || username.includes("\0") ||
        typeof password !== "string" || password.length < 1 || password.length > 4_096 || password.includes("\0")) {
      throw new PlaywrightCliRuntimeError();
    }
    this.#privateValues.add(username);
    this.#privateValues.add(password);
    const confirmationElement = passwordConfirmationRef === undefined
      ? "const passwordConfirmationElement=null;"
      : "const passwordConfirmationElement=await page.locator('aria-ref=" + passwordConfirmationRef + "').elementHandle();";
    const elements = passwordConfirmationRef === undefined
      ? "[usernameElement,passwordElement,submitElement]"
      : "[usernameElement,passwordElement,passwordConfirmationElement,submitElement]";
    const confirmationFill = passwordConfirmationRef === undefined ? "" : "await passwordConfirmationElement.fill(password);";
    const script = "async (page) => {" +
      "const username=" + JSON.stringify(username) + ";" +
      "const password=" + JSON.stringify(password) + ";" +
      "const usernameElement=await page.locator('aria-ref=" + usernameRef + "').elementHandle();" +
      "const passwordElement=await page.locator('aria-ref=" + passwordRef + "').elementHandle();" +
      confirmationElement +
      "const submitElement=await page.locator('aria-ref=" + submitRef + "').elementHandle();" +
      "const elements=" + elements + ";" +
      "if(elements.some((element)=>!element))throw new Error('Sign-in elements unavailable');" +
      "if(await usernameElement.isEditable())await usernameElement.fill(username);" +
      "await passwordElement.fill(password);" + confirmationFill + "await submitElement.click();}";
    const result = await this.#invokePrivateScript(script);
    if (result.exitCode !== 0) throw new PlaywrightCliRuntimeError({ requiresFreshInspection: true });
    this.#metadata = await this.#readMetadata();
    this.#screenshotsSuppressed = false;
  }

  async openBrowser(): Promise<void> {
    if (!this.#started || this.#selectedTargetId === null) throw new PlaywrightCliRuntimeError();
    await this.#browser.activateTarget(this.#selectedTargetId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#opened) {
      const stopped = await this.#invoke("video-stop", [], 10_000);
      if (stopped.exitCode !== 0) throw new PlaywrightCliRuntimeError();
      const closed = await this.#invoke("close", [], 10_000);
      try {
        const value = JSON.parse(closed.stdout) as Record<string, unknown>;
        if (closed.exitCode !== 0 || value.session !== this.#sessionName || !["closed", "not-open"].includes(String(value.status))) throw new Error();
      } catch { throw new PlaywrightCliRuntimeError(); }
      await unlink(this.#ownershipPath);
    }
    this.#started = false;
    this.#opened = false;
    this.#closed = true;
  }
}
