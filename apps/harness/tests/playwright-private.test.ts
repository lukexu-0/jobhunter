import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PlaywrightCliBrowser,
  PlaywrightCliRuntime,
  resolveBrowserLaunch,
  type ProcessRunner,
} from "../src/host/playwright-cli.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), "jobhunt-private-runtime-"));
  roots.push(root);
  await chmod(root, 0o700);
  const invocations: string[][] = [];
  const privateScripts: string[] = [];
  const runner: ProcessRunner = {
    async run(argv, options) {
      invocations.push([...argv]);
      const command = argv[3];
      if (command === "--jobhunt-page-lease-version") return { exitCode: 0, stdout: "1\n", stderr: "" };
      if (command === "open") {
        await writeFile(options.env.JOBHUNT_PLAYWRIGHT_TARGET_PATH!, "abcdef1234567890\n", "ascii");
        return { exitCode: 0, stdout: '{"pid":4242}', stderr: "" };
      }
      if (command === "run-code" && argv[4]?.startsWith("--filename=")) {
        privateScripts.push(await readFile(argv[4].slice(11), "utf8"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "run-code" && argv[4]?.includes("document.documentElement")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ result: JSON.stringify({
            url: "https://jobs.example.test/application",
            source: "Rendered application text",
          }) }),
          stderr: "",
        };
      }
      if (command === "run-code") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ result: JSON.stringify({
            url: "https://jobs.example.test/application",
            title: "Application",
            currentIndex: 0,
            targetId: "abcdef1234567890",
            tabs: [{ url: "https://jobs.example.test/application", title: "Application" }],
            screenshot: false,
          }) }),
          stderr: "",
        };
      }
      if (command === "close") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            session: "jobhunt-00000000000000000000000000000020",
            status: "closed",
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const browser = new PlaywrightCliBrowser({
    artifactsRoot: root,
    launch: await resolveBrowserLaunch({ cdpUrl: "http://127.0.0.1:9222" }),
    processRunner: runner,
  });
  await browser.start();
  const runtime = new PlaywrightCliRuntime({
    sessionId: "00000000-0000-0000-0000-000000000020",
    browser,
    sessionDirectory: root,
    nodeExecutable: "/usr/bin/node",
    cliScript: "/pinned/playwright-cli.js",
    processRunner: runner,
  });
  await runtime.start("https://jobs.example.test/posting/42");
  return { browser, invocations, privateScripts, root, runtime };
}

test("captures bounded rendered source and its final URL without page mutation", async () => {
  const { browser, invocations, runtime } = await runtimeFixture();

  await expect(runtime.captureSourceSnapshot()).resolves.toEqual([
    "https://jobs.example.test/application",
    "Rendered application text",
  ]);
  expect(invocations.at(-1)?.[3]).toBe("run-code");

  await runtime.close();
  await browser.close();
});


test("enters credentials through a private FIFO and never process arguments", async () => {
  const { browser, invocations, privateScripts, runtime } = await runtimeFixture();

  await runtime.signIn({
    usernameRef: "e4",
    passwordRef: "e5",
    passwordConfirmationRef: "e6",
    submitRef: "e7",
    username: "person@example.test",
    password: "secret-value",
  });

  expect(invocations.some((argv) => argv.some((value) => value.includes("secret-value")))).toBeFalse();
  expect(privateScripts).toHaveLength(1);
  expect(privateScripts[0]).toContain("secret-value");
  expect(invocations.some((argv) => argv[3] === "video-stop")).toBeTrue();

  await runtime.close();
  await browser.close();
});


test("writes a private CLI config bound to the shared CDP browser", async () => {
  const { browser, root, runtime } = await runtimeFixture();
  const path = join(root, "playwright-cli", "cli.config.json");

  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    browser: {
      browserName: "chromium",
      contextOptions: { acceptDownloads: false },
      cdpEndpoint: "http://127.0.0.1:9222",
      isolated: false,
    },
    outputDir: join(root, "playwright-cli", "output"),
    outputMode: "stdout",
    allowUnrestrictedFileAccess: false,
    codegen: "none",
    snapshot: { mode: "none" },
    console: { level: "none" },
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);

  await runtime.close();
  await browser.close();
});
