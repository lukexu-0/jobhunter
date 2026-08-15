import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";
import {
  startPublicConnectProxy,
  type PublicConnectProxy,
  type ResolveProxyAddresses,
} from "./public-connect-proxy";
import {
  BROWSER_RESOURCE_PROFILE,
  runTrustedProcess,
  type CapturedOutput,
  type ProcessBoundary,
} from "../system/process";

const PROFILE_PREFIX = "jobhunter-rendered-job-";
const CHROME_TIMEOUT_MS = 9_000;
const CHROME_VIRTUAL_TIME_BUDGET_MS = 7_000;
const CHROME_STDOUT_LIMIT = 1024 * 1024;
const CHROME_STDERR_LIMIT = 64 * 1024;
const MAX_RENDER_URL_CHARS = 2_048;

export interface RenderJobSourceWithChromeOptions {
  readonly resolveAddresses: ResolveProxyAddresses;
  readonly processBoundary?: ProcessBoundary;
}

function cancellationReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function validatedRenderUrl(value: string): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_RENDER_URL_CHARS
    || value.trim() !== value
    || value.includes("\0")
  ) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || url.port !== ""
      || url.hostname === ""
      || isIP(url.hostname) !== 0
    ) {
      return undefined;
    }
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

const HTML_PREAMBLE_WHITESPACE = /\s/u;
const HTML_DOCTYPE = /^<!doctype\s+html[^>]*>$/iu;

function hasValidHtmlPreamble(preamble: string): boolean {
  let cursor = 0;
  while (cursor < preamble.length) {
    if (HTML_PREAMBLE_WHITESPACE.test(preamble[cursor]!)) {
      cursor += 1;
      continue;
    }
    if (preamble.startsWith("<!--", cursor)) {
      const end = preamble.indexOf("-->", cursor + 4);
      if (end < 0) return false;
      cursor = end + 3;
      continue;
    }
    if (preamble.slice(cursor, cursor + 9).toLowerCase() === "<!doctype") {
      const end = preamble.indexOf(">", cursor + 9);
      if (end < 0 || !HTML_DOCTYPE.test(preamble.slice(cursor, end + 1))) return false;
      cursor = end + 1;
      continue;
    }
    return false;
  }
  return true;
}

function decodeCompleteHtmlDocument(output: CapturedOutput): string | undefined {
  if (output.truncated || output.bytes !== output.data.byteLength || output.data.byteLength === 0) {
    return undefined;
  }
  let dom: string;
  try {
    dom = new TextDecoder("utf-8", { fatal: true }).decode(output.data);
  } catch {
    return undefined;
  }
  if (dom.includes("\0")) return undefined;
  if (/<body\b[^>]*\bclass=(["'])[^"']*\bneterror\b[^"']*\1/i.test(dom)) return undefined;

  const opening = /<html(?:\s|>)/i.exec(dom);
  const closing = /<\/html>\s*$/i.exec(dom);
  if (!opening || !closing || closing.index <= opening.index) return undefined;
  const preamble = dom.slice(0, opening.index);
  if (!hasValidHtmlPreamble(preamble)) return undefined;
  return dom;
}

export async function renderJobSourceWithChrome(
  url: string,
  signal: AbortSignal,
  options: RenderJobSourceWithChromeOptions,
): Promise<string | undefined> {
  signal.throwIfAborted();
  const renderUrl = validatedRenderUrl(url);
  if (renderUrl === undefined) return undefined;

  let profileDirectory: string | undefined;
  let proxy: PublicConnectProxy | undefined;
  let rendered: string | undefined;
  let cleanupFailed = false;
  try {
    profileDirectory = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
    await chmod(profileDirectory, 0o700);
    signal.throwIfAborted();

    proxy = await startPublicConnectProxy({
      resolveAddresses: options.resolveAddresses,
      signal,
    });
    signal.throwIfAborted();

    const args = [
      "--headless=new",
      "--dump-dom",
      `--virtual-time-budget=${CHROME_VIRTUAL_TIME_BUDGET_MS}`,
      `--user-data-dir=${profileDirectory}`,
      `--proxy-server=http://${proxy.host}:${proxy.port}`,
      "--proxy-bypass-list=<-loopback>",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--disable-quic",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-extensions",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      renderUrl,
    ] as const;
    const processResult = await runTrustedProcess({
      command: "google-chrome",
      args,
      cwd: profileDirectory,
      timeoutMs: CHROME_TIMEOUT_MS,
      signal,
      stdoutLimit: CHROME_STDOUT_LIMIT,
      stderrLimit: CHROME_STDERR_LIMIT,
      resourceProfile: BROWSER_RESOURCE_PROFILE.name,
    }, options.processBoundary);
    signal.throwIfAborted();

    if (
      !processResult.aborted
      && !processResult.timedOut
      && processResult.code === 0
      && processResult.signal === null
      && !processResult.stderr.truncated
    ) {
      rendered = decodeCompleteHtmlDocument(processResult.stdout);
    }
  } catch {
    rendered = undefined;
  } finally {
    if (proxy !== undefined) {
      try {
        await proxy.close();
      } catch {
        cleanupFailed = true;
      }
    }
    if (profileDirectory !== undefined) {
      try {
        await rm(profileDirectory, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    }
  }

  if (signal.aborted) throw cancellationReason(signal);
  return cleanupFailed ? undefined : rendered;
}
