import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { captureNativeChrome, type NativeChromeRequest } from "../src/api/native-chrome-source.ts";
import { findChromeExecutable } from "../src/system/chrome.ts";

const nativeTest = test.skipIf(process.platform !== "darwin" || findChromeExecutable() === undefined);
const DEFAULT_FIXTURE = "<html><body><script>setTimeout(()=>{document.body.textContent='Rendered engineering opportunity';location.hash='rendered'},2000)</script></body></html>";

async function withNativeChrome(
  assertCapture: (request: NativeChromeRequest) => Promise<void>,
  html = DEFAULT_FIXTURE,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jobhunt-native-test-")));
  // Chrome virtual time drives this page timer; the test does not sleep.
  const fixture = join(root, "role.html");
  await writeFile(fixture, html, { mode: 0o600 });
  const url = pathToFileURL(fixture).href;
  try {
    await assertCapture({
      url, cwd: root,
      args: ["--headless=new", `--user-data-dir=${root}`, "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--disable-quic", "--disable-background-networking", "--disable-sync", "--disable-extensions", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
      signal: new AbortController().signal,
      timeoutMs: 9000, virtualTimeBudgetMs: 3000, stdoutLimit: 1024, stderrLimit: 64 * 1024,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

nativeTest("captures delayed JavaScript content through a private native Chrome session", async () => {
  await withNativeChrome(async (request) => {
    const result = await captureNativeChrome(request);
    expect(result.html).toContain(">Rendered engineering opportunity<");
    expect(result.finalUrl).toBe(`${request.url}#rendered`);
  });
}, 15000);

nativeTest("startup cancellation preserves its reason and leaves the next native import usable", async () => {
  await withNativeChrome(async (request) => {
    const controller = new AbortController();
    const reason = new Error("opportunity import cancelled");
    const pending = captureNativeChrome({ ...request, signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
  await withNativeChrome(async (request) => {
    const next = await captureNativeChrome(request);
    expect(next.html).toContain(">Rendered engineering opportunity<");
  });
}, 15000);

nativeTest("projects rendered content before enforcing the native capture byte limit", async () => {
  const heavyweight = "x".repeat(2048);
  await withNativeChrome(async (request) => {
    const result = await captureNativeChrome(request);
    expect(Buffer.byteLength(result.html, "utf8")).toBeLessThanOrEqual(request.stdoutLimit);
    expect(result.html).toContain("<form>");
    expect(result.html).toContain("Software Engineer Internship");
    expect(result.html).toContain('type="application/ld+json"');
    expect(result.html).toContain('src="https://forms.example.test/apply"');
    expect(result.html).not.toContain(heavyweight);
  }, `<html><head>
    <script type="application/json">${heavyweight}</script>
    <style>${heavyweight}</style>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Software Engineer Internship"}</script>
    </head><body><form><h1>Software Engineer Internship</h1>
    <p>Build reliable software with the product engineering team.</p>
    <iframe src="https://forms.example.test/apply"></iframe><input name="email"></form></body></html>`);
}, 15000);

nativeTest("rejects a rendered document that exceeds the native capture byte limit", async () => {
  await withNativeChrome(async (request) => {
    await expect(captureNativeChrome({ ...request, stdoutLimit: 32 })).rejects.toBeInstanceOf(RangeError);
  });
}, 15000);
