import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { findChromeExecutable } from "../system/chrome.ts";
import { sanitizedEnvironment } from "../system/process.ts";
import type { RenderedJobSource } from "./rendered-job-source.ts";

export interface NativeChromeRequest {
  readonly url: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly virtualTimeBudgetMs: number;
  readonly stdoutLimit: number;
  readonly stderrLimit: number;
}

interface PendingReply {
  readonly id: number;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}
interface ChromeMessage {
  readonly id?: number;
  readonly method?: string;
  readonly sessionId?: string;
  readonly result?: unknown;
  readonly error?: unknown;
}
interface FrameResult {
  readonly frameTree: { readonly frame: { readonly id: string; readonly loaderId: string; readonly url: string; readonly urlFragment?: string } };
}
interface EvaluationResult {
  readonly result: { readonly type: string; readonly value?: unknown };
  readonly exceptionDetails?: unknown;
}

export async function captureNativeChrome(request: NativeChromeRequest): Promise<RenderedJobSource> {
  request.signal.throwIfAborted();
  const executable = findChromeExecutable();
  const directory = lstatSync(request.cwd);
  if (process.platform !== "darwin" || executable === undefined || !isAbsolute(request.cwd)
    || !directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700
    || directory.uid !== process.getuid!()) throw new Error("Native Chrome requires a private macOS profile");

  // Use Bun-owned standard pipes, rather than extra numeric descriptors whose
  // ownership races cancellation. This fixed exec-only shim maps them to CDP's
  // fd 3/4. The executable and flags stay separate argv, never shell source.
  const child = Bun.spawn([
    "/bin/sh", "-c", 'exec 3<&0 4>&1; exec "$@" </dev/null >/dev/null', "jobhunt-native-chrome",
    executable, ...request.args, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "about:blank",
  ], {
    cwd: request.cwd,
    env: { ...sanitizedEnvironment(), HOME: request.cwd, TMPDIR: request.cwd },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const failure = Promise.withResolvers<never>();
  const virtualTimeExpired = Promise.withResolvers<void>();
  void failure.promise.catch(() => undefined);
  void virtualTimeExpired.promise.catch(() => undefined);
  let pending: PendingReply | undefined;
  let sequence = 0;
  let sessionId: string | undefined;
  let closing = false;
  let failed = false;
  let stderrBytes = 0;
  const fail = (reason: unknown): void => {
    if (closing || failed) return;
    failed = true;
    pending?.reject(reason);
    pending = undefined;
    virtualTimeExpired.reject(reason);
    failure.reject(reason);
  };
  void child.exited.then(() => fail(new Error("Native Chrome exited before capture")), fail);
  const stderrDone = (async () => {
    try {
      for await (const chunk of child.stderr) {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > request.stderrLimit) fail(new Error("Native Chrome diagnostics exceeded their limit"));
      }
    } catch (error) { fail(error); }
  })();

  // CDP uses NUL-delimited JSON over inherited pipes, never a listening debug port.
  // JSON escaping can expand each bounded DOM byte to six wire bytes.
  const messageLimit = request.stdoutLimit * 6 + 64 * 1024;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: Uint8Array[] = [];
  let messageBytes = 0;
  const receive = (chunk: Buffer): void => {
    if (failed || closing) return;
    try {
      let start = 0;
      while (start < chunk.length) {
        const terminator = chunk.indexOf(0, start);
        const end = terminator < 0 ? chunk.length : terminator;
        const segment = chunk.subarray(start, end);
        messageBytes += segment.length;
        if (messageBytes > messageLimit) throw new Error("Native Chrome protocol exceeded its limit");
        chunks.push(segment);
        if (terminator < 0) break;
        const frame = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, messageBytes);
        const message = JSON.parse(decoder.decode(frame)) as ChromeMessage;
        chunks.length = 0;
        messageBytes = 0;
        if (message === null || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid Chrome reply");
        if (message.id === pending?.id && pending !== undefined) {
          const reply = pending;
          pending = undefined;
          message.error === undefined ? reply.resolve(message.result) : reply.reject(new Error("Native Chrome command failed"));
        } else if (message.method === "Emulation.virtualTimeBudgetExpired" && message.sessionId === sessionId) {
          virtualTimeExpired.resolve();
        }
        start = terminator + 1;
      }
    } catch (error) { fail(error); }
  };
  const outputDone = (async () => {
    try {
      for await (const chunk of child.stdout) receive(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      fail(new Error("Native Chrome protocol closed before capture"));
    } catch (error) { fail(error); }
  })();
  const send = async <T>(method: string, params: object = {}, targetSession?: string): Promise<T> => {
    if (failed) throw new Error("Native Chrome protocol failed");
    if (pending !== undefined) throw new Error("Concurrent native Chrome command");
    const response = Promise.withResolvers<unknown>();
    // A cancellation can reject the response before the write has flushed.
    void response.promise.catch(() => undefined);
    const id = ++sequence;
    pending = { id, resolve: response.resolve, reject: response.reject };
    child.stdin.write(JSON.stringify({ id, method, params, ...(targetSession === undefined ? {} : { sessionId: targetSession }) }) + "\0");
    await child.stdin.flush();
    return await response.promise as T;
  };
  const abort = () => fail(request.signal.reason ?? new DOMException("Aborted", "AbortError"));
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(() => fail(new Error("Native Chrome rendering deadline expired")), request.timeoutMs);

  try {
    const capture = async (): Promise<RenderedJobSource> => {
      await send("Browser.setDownloadBehavior", { behavior: "deny" });
      const target = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      const attached = await send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      sessionId = attached.sessionId;
      await send("Page.enable", {}, sessionId);
      const navigation = await send<{ frameId: string; errorText?: string }>("Page.navigate", { url: request.url }, sessionId);
      if (navigation.errorText !== undefined) throw new Error("Native Chrome navigation failed");
      const initialWorld = await send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: navigation.frameId, worldName: "jobhunt-source" }, sessionId);
      const loaded = await send<EvaluationResult>("Runtime.evaluate", {
        expression: 'document.readyState === "complete" ? true : new Promise(resolve => addEventListener("load", () => resolve(true), { once: true }))',
        contextId: initialWorld.executionContextId, awaitPromise: true, returnByValue: true,
      }, sessionId);
      if (loaded.exceptionDetails !== undefined || loaded.result.value !== true) throw new Error("Native Chrome document did not load");
      await send("Emulation.setVirtualTimePolicy", { policy: "pauseIfNetworkFetchesPending", budget: request.virtualTimeBudgetMs }, sessionId);
      await virtualTimeExpired.promise;
      const before = (await send<FrameResult>("Page.getFrameTree", {}, sessionId)).frameTree.frame;
      const world = await send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: before.id, worldName: "jobhunt-source" }, sessionId);
      const snapshot = await send<EvaluationResult>("Runtime.evaluate", {
        expression: `(() => {
          const root = document.documentElement.cloneNode(true);
          for (const script of root.querySelectorAll("script")) {
            if (script.getAttribute("type")?.trim().toLowerCase() !== "application/ld+json") script.remove();
          }
          for (const element of root.querySelectorAll("style, noscript, template, object, embed, svg, canvas")) {
            element.remove();
          }
          const html = root.outerHTML;
          return new TextEncoder().encode(html).byteLength <= ${request.stdoutLimit} ? html : undefined;
        })()`,
        contextId: world.executionContextId, returnByValue: true,
      }, sessionId);
      if (snapshot.exceptionDetails !== undefined) throw new Error("Native Chrome snapshot failed");
      if (typeof snapshot.result.value !== "string" || Buffer.byteLength(snapshot.result.value, "utf8") > request.stdoutLimit) {
        throw new RangeError("Native Chrome document exceeded its byte limit");
      }
      const after = (await send<FrameResult>("Page.getFrameTree", {}, sessionId)).frameTree.frame;
      if (before.id !== after.id || before.loaderId !== after.loaderId || before.url !== after.url || before.urlFragment !== after.urlFragment) {
        throw new Error("Native Chrome navigated during capture");
      }
      return { html: snapshot.result.value, finalUrl: after.url + (after.urlFragment ?? "") };
    };
    return await Promise.race([capture(), failure.promise]);
  } finally {
    closing = true;
    let cleanupTimer: NodeJS.Timeout | undefined;
    try {
      // Chrome can acknowledge Browser.close yet keep running. Success is the
      // explicit snapshot above, not timeout output; terminate its private group.
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      await Promise.race([
        (async () => {
          await child.exited;
          await child.stdin.end();
          await Promise.all([outputDone, stderrDone]);
        })(),
        new Promise<never>((_resolve, reject) => { cleanupTimer = setTimeout(() => reject(new Error("Native Chrome cleanup failed")), 1000); }),
      ]);
      request.signal.throwIfAborted();
    } finally {
      clearTimeout(cleanupTimer);
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
    }
  }
}
