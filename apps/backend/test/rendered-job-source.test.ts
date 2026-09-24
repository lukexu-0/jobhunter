import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:net";
import { renderJobSourceWithChrome } from "../src/api/rendered-job-source.ts";
import { type ProcessBoundary, type RunningProcess, type SpawnContract } from "../src/system/process.ts";

const VALID_DOM = "<!DOCTYPE html>\n<html><head></head><body><main>Rendered role</main></body></html>";

function output(...chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

function exited(
  stdout: readonly Uint8Array[],
  code = 0,
  stderr: readonly Uint8Array[] = [],
): RunningProcess {
  return {
    pid: -1,
    stdout: output(...stdout),
    stderr: output(...stderr),
    wait: async () => ({ code, signal: null }),
    kill: async () => undefined,
  };
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function assertLoopbackPortCanBeRebound(port: number): Promise<void> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  }
}

const resolveAddresses = async () => [{ address: "93.184.216.34", family: 4 as const }];

describe("rendered job source", () => {
  test("releases its private profile and proxy after successful rendering", async () => {
    let seen: SpawnContract | undefined;
    let profileMode: number | undefined;
    const boundary: ProcessBoundary = (contract) => {
      seen = contract;
      profileMode = statSync(contract.cwd).mode & 0o777;
      return exited(
        [Buffer.from(VALID_DOM)],
        0,
        [Buffer.alloc(64 * 1024, 0x65)],
      );
    };

    const rendered = await renderJobSourceWithChrome(
      "https://jobs.example.test/openings/42?source=careers",
      new AbortController().signal,
      { resolveAddresses, processBoundary: boundary },
    );

    expect(rendered).toEqual({ html: VALID_DOM, finalUrl: null });
    expect(profileMode).toBe(0o700);
    const proxyArgument = seen?.args.find((argument) => argument.startsWith("--proxy-server="));
    expect(proxyArgument).toMatch(/^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/);
    const proxyPort = Number(new URL(proxyArgument!.slice("--proxy-server=".length)).port);
    expect(await pathExists(seen!.cwd)).toBeFalse();
    await assertLoopbackPortCanBeRebound(proxyPort);
  });

  test("reports a safe rendering failure and releases resources when containment cannot start", async () => {
    let profile = "";
    let proxyPort = 0;
    const rendering = renderJobSourceWithChrome(
      "https://jobs.example.test/openings/42",
      new AbortController().signal,
      {
        resolveAddresses,
        processBoundary: (contract) => {
          profile = contract.cwd;
          const proxyArgument = contract.args.find((argument) => argument.startsWith("--proxy-server="))!;
          proxyPort = Number(new URL(proxyArgument.slice("--proxy-server=".length)).port);
          throw new Error("private containment failure with credentials");
        },
      },
    );

    await expect(rendering).rejects.toMatchObject({ name: "RenderJobSourceError" });
    await expect(rendering).rejects.not.toHaveProperty("cause");
    await expect(rendering).rejects.not.toThrow("private containment failure with credentials");
    expect(await pathExists(profile)).toBeFalse();
    await assertLoopbackPortCanBeRebound(proxyPort);
  });

  test("reports rendering failure and releases resources when service collection fails", async () => {
    let profile = "";
    let proxyPort = 0;
    const rendering = renderJobSourceWithChrome(
      "https://jobs.example.test/openings/42",
      new AbortController().signal,
      {
        resolveAddresses,
        processBoundary: (contract) => {
          profile = contract.cwd;
          const proxyArgument = contract.args.find((argument) => argument.startsWith("--proxy-server="))!;
          proxyPort = Number(new URL(proxyArgument.slice("--proxy-server=".length)).port);
          return {
            pid: 4104,
            stdout: output(Buffer.from(VALID_DOM)),
            stderr: output(),
            wait: async () => {
              throw new Error("transient service collection failed");
            },
            kill: async () => undefined,
          };
        },
      },
    );

    await expect(rendering).rejects.toMatchObject({ name: "RenderJobSourceError" });
    expect(await pathExists(profile)).toBeFalse();
    await assertLoopbackPortCanBeRebound(proxyPort);
  });

  test.each([
    ["nonzero exit", [Buffer.from(VALID_DOM)], 1, []],
    ["invalid UTF-8", [Uint8Array.of(0xc3, 0x28)], 0, []],
    ["invalid DOM", [Buffer.from("not an HTML document")], 0, []],
    ["truncated DOM", [Buffer.from(VALID_DOM), Buffer.alloc(1024 * 1024, 0x20)], 0, []],
    ["truncated diagnostics", [Buffer.from(VALID_DOM)], 0, [Buffer.alloc(64 * 1024 + 1, 0x65)]],
  ] as const)("reports rendering failure for %s", async (_name, stdout, code, stderr) => {
    const rendering = renderJobSourceWithChrome(
      "https://jobs.example.test/openings/42",
      new AbortController().signal,
      { resolveAddresses, processBoundary: () => exited(stdout, code, stderr) },
    );

    await expect(rendering).rejects.toMatchObject({ name: "RenderJobSourceError" });
  });

  test("rejects a hostile adjacent-comment preamble without pathological backtracking", async () => {
    const hostileDom = `${"<!---->".repeat(32_768)}<?invalid?><html><body></body></html>`;
    const rendering = renderJobSourceWithChrome(
      "https://jobs.example.test/openings/42",
      new AbortController().signal,
      { resolveAddresses, processBoundary: () => exited([Buffer.from(hostileDom)]) },
    );

    await expect(rendering).rejects.toMatchObject({ name: "RenderJobSourceError" });
  });

  test("rejects Chromium network error documents", async () => {
    const networkErrorDom = [
      "<!DOCTYPE html>",
      '<html><head><title>jobs.example.test</title></head>',
      '<body class="neterror"><div id="main-frame-error">No internet</div></body></html>',
    ].join("");
    const rendering = renderJobSourceWithChrome(
      "https://jobs.example.test/openings/42",
      new AbortController().signal,
      { resolveAddresses, processBoundary: () => exited([Buffer.from(networkErrorDom)]) },
    );

    await expect(rendering).rejects.toMatchObject({ name: "RenderJobSourceError" });
  });

  test("propagates the caller abort reason after killing Chrome and cleaning owned resources", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped rendering");
    const started = Promise.withResolvers<void>();
    const exit = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    let profile = "";
    let proxyPort = 0;

    const pending = renderJobSourceWithChrome(
      "https://jobs.example.test/openings/42",
      controller.signal,
      {
        resolveAddresses,
        processBoundary: (contract) => {
          profile = contract.cwd;
          const proxyArgument = contract.args.find((argument) => argument.startsWith("--proxy-server="))!;
          proxyPort = Number(new URL(proxyArgument.slice("--proxy-server=".length)).port);
          started.resolve();
          return {
            pid: -1,
            stdout: output(),
            stderr: output(),
            wait: () => exit.promise,
            kill: async (signal) => {
              exit.resolve({ code: null, signal });
            },
          };
        },
      },
    );
    await started.promise;
    controller.abort(reason);

    let thrown: unknown;
    try {
      await pending;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(reason);
    await exit.promise;
    expect(await pathExists(profile)).toBeFalse();
    await assertLoopbackPortCanBeRebound(proxyPort);
  });

  test("does not start Chrome for a non-HTTPS URL", async () => {
    let launches = 0;
    const rendered = await renderJobSourceWithChrome(
      "http://jobs.example.test/openings/42",
      new AbortController().signal,
      {
        resolveAddresses,
        processBoundary: () => {
          launches++;
          return exited([Buffer.from(VALID_DOM)]);
        },
      },
    );

    expect(rendered).toBeUndefined();
    expect(launches).toBe(0);
  });
});
