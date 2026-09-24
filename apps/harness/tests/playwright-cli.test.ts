import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  BrowserConfigurationError,
  PlaywrightCliBrowser,
  PlaywrightCliRuntime,
  recoverStalePlaywrightCliSessions,
  type ProcessRunner,
  resolveBrowserLaunch,
} from "../src/host/playwright-cli.ts";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const path = join(process.cwd(), `.playwright-cli-test-${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true, mode: 0o700 });
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Playwright CLI browser launch", () => {
  test("accepts only a loopback CDP HTTP origin with an explicit port", async () => {
    await expect(resolveBrowserLaunch({ cdpUrl: "http://LOCALHOST:9222/" })).resolves.toEqual({
      cdpUrl: "http://localhost:9222",
      executablePath: null,
      userDataDir: null,
      isCdp: true,
    });

    for (const cdpUrl of [
      "https://127.0.0.1:9222",
      "http://example.com:9222",
      "http://127.0.0.1",
      "http://127.0.0.1:9222/json",
    ]) {
      await expect(resolveBrowserLaunch({ cdpUrl })).rejects.toBeInstanceOf(BrowserConfigurationError);
    }
  });
  test("uses an executable with a private dedicated non-symlink profile", async () => {
    const root = await temporaryRoot();
    const chrome = join(root, "chrome");
    const profile = join(root, "profile");
    await writeFile(chrome, "#!/bin/sh\n", { mode: 0o700 });

    await expect(resolveBrowserLaunch({ chromeExecutable: chrome, chromeUserDataDir: profile })).resolves.toEqual({
      cdpUrl: null,
      executablePath: chrome,
      userDataDir: profile,
      isCdp: false,
    });

    const linkedProfile = join(root, "linked-profile");
    await symlink(profile, linkedProfile);
    await expect(resolveBrowserLaunch({ chromeExecutable: chrome, chromeUserDataDir: linkedProfile })).rejects.toBeInstanceOf(BrowserConfigurationError);
  });

  test("launches headed native Chrome and journals exact process identity", async () => {
    const root = await temporaryRoot();
    const chrome = join(root, "chrome");
    const profile = join(root, "profile");
    await writeFile(chrome, "#!/bin/sh\n", { mode: 0o700 });
    let terminated = false;
    let spawnedArgs: readonly string[] = [];
    let spawnedHome: string | undefined;
    const runner: ProcessRunner = {
      async run() { return { exitCode: 0, stdout: "", stderr: "" }; },
      async spawn(argv, options) {
        spawnedArgs = argv;
        spawnedHome = options.env.HOME;
        await writeFile(join(profile, "DevToolsActivePort"), "9333\n/devtools/browser/owned\n", { mode: 0o600 });
        return { pid: 4812, createTime: 123.5, executable: argv[0]!, async terminate() { terminated = true; } };
      },
    };
    const browser = new PlaywrightCliBrowser({
      artifactsRoot: root,
      launch: await resolveBrowserLaunch({ chromeExecutable: chrome, chromeUserDataDir: profile }),
      processRunner: runner,
      fetcher: async () => new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/owned" })),
    });

    await browser.start();

    expect(spawnedArgs.some((argument) => argument === "--headless" || argument.startsWith("--headless="))).toBeFalse();
    expect(spawnedHome).toBe(process.env.HOME);
    expect(browser.cdpUrl).toBe("http://127.0.0.1:9333");
    expect(JSON.parse(await readFile(join(root, ".browser", "ownership.json"), "utf8"))).toMatchObject({ version: 1, native_browser_pid: 4812, native_browser_create_time: 123.5 });
    await browser.close();
    expect(terminated).toBeTrue();
    await expect(readFile(join(root, ".browser", "ownership.json"))).rejects.toThrow();
  });

  test("cleans native ownership when endpoint verification fails", async () => {
    const root = await temporaryRoot();
    const chrome = join(root, "chrome");
    const profile = join(root, "profile");
    await writeFile(chrome, "#!/bin/sh\n", { mode: 0o700 });
    let terminated = false;
    const runner: ProcessRunner = {
      async run() { return { exitCode: 0, stdout: "", stderr: "" }; },
      async spawn() {
        await writeFile(join(profile, "DevToolsActivePort"), "9333\n/devtools/browser/owned\n", { mode: 0o600 });
        return { pid: 4812, createTime: 123.5, executable: chrome, async terminate() { terminated = true; } };
      },
    };
    const browser = new PlaywrightCliBrowser({
      artifactsRoot: root,
      launch: await resolveBrowserLaunch({ chromeExecutable: chrome, chromeUserDataDir: profile }),
      processRunner: runner,
      fetcher: async () => new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/wrong" })),
    });

    await expect(browser.start()).rejects.toBeInstanceOf(Error);
    expect(terminated).toBeTrue();
    await expect(readFile(join(root, ".browser", "ownership.json"))).rejects.toThrow();
  });

  test("restores a minimized Chrome window before activating its target", async () => {
    const root = await temporaryRoot();
    const targetId = "abcdef1234567890";
    const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const activations: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname === "/json/version") {
          return Response.json({
            webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/browser/test`,
          });
        }
        if (url.pathname === "/devtools/browser/test" && server.upgrade(request)) return;
        if (url.pathname === `/json/activate/${targetId}`) {
          activations.push(url.pathname);
          return new Response("Target activated");
        }
        return new Response(null, { status: 404 });
      },
      websocket: {
        message(socket, message) {
          const command = JSON.parse(String(message)) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          commands.push({
            method: command.method,
            ...(command.params === undefined ? {} : { params: command.params }),
          });
          if (command.method === "Browser.getWindowForTarget") {
            socket.send(JSON.stringify({
              id: command.id,
              result: { windowId: 17, bounds: { windowState: "minimized" } },
            }));
            return;
          }
          socket.send(JSON.stringify({ id: command.id, result: {} }));
        },
      },
    });

    try {
      const browser = new PlaywrightCliBrowser({
        artifactsRoot: root,
        launch: await resolveBrowserLaunch({ cdpUrl: `http://127.0.0.1:${server.port}` }),
      });
      await browser.start();
      await browser.activateTarget(targetId);

      expect(commands).toEqual([
        { method: "Browser.getWindowForTarget", params: { targetId } },
        {
          method: "Browser.setWindowBounds",
          params: { windowId: 17, bounds: { windowState: "normal" } },
        },
      ]);
      expect(activations).toEqual([`/json/activate/${targetId}`]);
    } finally {
      server.stop(true);
    }
  });
});

describe("Playwright CLI runtime", () => {
  test("uses the pinned CLI session and returns a bounded observation", async () => {
    const root = await temporaryRoot();
    const invocations: string[][] = [];
    const environments: Array<Record<string, string>> = [];
    const activations: string[] = [];
    const browserCommands: string[] = [];
    const browserServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname === "/json/version") {
          return Response.json({
            webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/browser/runtime`,
          });
        }
        if (url.pathname === "/devtools/browser/runtime" && server.upgrade(request)) return;
        if (url.pathname.startsWith("/json/activate/")) {
          activations.push(url.pathname);
          return new Response("Target activated");
        }
        return new Response(null, { status: 404 });
      },
      websocket: {
        message(socket, message) {
          const command = JSON.parse(String(message)) as { id: number; method: string };
          browserCommands.push(command.method);
          socket.send(JSON.stringify({
            id: command.id,
            result: { windowId: 18, bounds: { windowState: "normal" } },
          }));
        },
      },
    });
    const runner: ProcessRunner = {
      async run(argv, options) {
        invocations.push([...argv]);
        environments.push(options.env);
        const command = argv[3];
        if (command === "--jobhunt-page-lease-version") return { exitCode: 0, stdout: "1\n", stderr: "" };
        if (command === "open") return { exitCode: 0, stdout: '{"pid":4242}', stderr: "" };
        if (command === "run-code") return {
          exitCode: 0,
          stdout: JSON.stringify({ result: JSON.stringify({ url: "https://jobs.example/apply", title: "Engineer", currentIndex: 0, ...(argv[4]?.includes("__jobhuntTargetId") ? { targetId: "abcdef1234567890" } : {}), tabs: [{ url: "https://jobs.example/apply", title: "Engineer" }], screenshot: false }) }),
          stderr: "",
        };
        if (command === "click") return { exitCode: 0, stdout: JSON.stringify({ snapshot: encodeURIComponent(root) + "x".repeat(50_000) }), stderr: "" };
        if (command === "close") return { exitCode: 0, stdout: JSON.stringify({ session: "jobhunt-00000000000000000000000000000001", status: "closed" }), stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const browser = new PlaywrightCliBrowser({
      artifactsRoot: root,
      launch: await resolveBrowserLaunch({ cdpUrl: `http://127.0.0.1:${browserServer.port}` }),
      processRunner: runner,
    });
    await browser.start();
    const runtime = new PlaywrightCliRuntime({ sessionId: "00000000-0000-0000-0000-000000000001", browser, sessionDirectory: root, nodeExecutable: "/usr/bin/node", cliScript: "/pinned/playwright-cli.js", processRunner: runner });
    await runtime.start("https://jobs.example/apply");

    const result = await runtime.execute("click", ["e3"]);

    expect(result.exitCode).toBe(0);
    expect(result.observation).toMatchObject({ url: "https://jobs.example/apply", title: "Engineer" });
    expect(result.observation.dom).toHaveLength(40_000);
    expect(result.observation.dom).not.toContain(encodeURIComponent(root));
    expect(result.stdout.length).toBeLessThanOrEqual(20_000);
    expect(result.stdoutTruncated).toBeTrue();
    await runtime.openBrowser();
    expect(activations).toEqual(["/json/activate/abcdef1234567890"]);
    expect(browserCommands).toEqual(["Browser.getWindowForTarget"]);
    expect(invocations.some((argv) => argv.slice(0, 5).join(" ") === "/usr/bin/node /pinned/playwright-cli.js --session=jobhunt-00000000000000000000000000000001 click e3")).toBeTrue();
    expect(environments.every((environment) => environment.PWTEST_SOCKETS_DIR?.startsWith("/tmp/") && environment.PWTEST_SOCKETS_DIR.length < 80)).toBeTrue();
    await runtime.close();
    await browser.close();
    browserServer.stop(true);
  });
  test("reconnects the owned page when the CLI session disappears", async () => {
    const root = await temporaryRoot();
    const sessionName = "jobhunt-00000000000000000000000000000007";
    const targetId = "abcdef1234567890";
    let attached = false;
    const runner: ProcessRunner = {
      async run(argv, options) {
        const command = argv[3];
        if (command === "--jobhunt-page-lease-version") return { exitCode: 0, stdout: "1\n", stderr: "" };
        if (command === "open") return { exitCode: 0, stdout: '{"pid":4242}', stderr: "" };
        if (command === "run-code") return { exitCode: 0, stdout: JSON.stringify({ result: { url: "https://jobs.example/apply", title: "Apply", currentIndex: 0, targetId, tabs: [] } }), stderr: "" };
        if (command === "snapshot" && !attached) return { exitCode: 0, stdout: JSON.stringify({ isError: true, error: "The browser '" + sessionName + "' is not open, please run open first" }), stderr: "" };
        if (command === "attach") {
          if (options.env.JOBHUNT_PLAYWRIGHT_RECONNECT_TARGET_ID !== targetId) {
            return { exitCode: 1, stdout: "", stderr: "target journal already exists" };
          }
          attached = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "snapshot") return { exitCode: 0, stdout: JSON.stringify({ snapshot: "fresh" }), stderr: "" };
        if (command === "close") return { exitCode: 0, stdout: JSON.stringify({ session: sessionName, status: "closed" }), stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const browser = new PlaywrightCliBrowser({ artifactsRoot: root, launch: await resolveBrowserLaunch({ cdpUrl: "http://127.0.0.1:9222" }), processRunner: runner });
    await browser.start();
    const runtime = new PlaywrightCliRuntime({ sessionId: "00000000-0000-0000-0000-000000000007", browser, sessionDirectory: root, nodeExecutable: "/usr/bin/node", cliScript: "/pinned/playwright-cli.js", processRunner: runner });
    await runtime.start("https://jobs.example/apply");

    const result = await runtime.execute("snapshot");

    expect(result).toMatchObject({ exitCode: 0, observation: { dom: "fresh" } });
    await runtime.close();
    await browser.close();
  });
  test("rejects uploads outside the session and nonexistent inputs without invoking them", async () => {
    const root = await temporaryRoot();
    const commands: string[] = [];
    const runner: ProcessRunner = {
      async run(argv) {
        const command = argv[3]!;
        commands.push(command);
        if (command === "--jobhunt-page-lease-version") return { exitCode: 0, stdout: "1\n", stderr: "" };
        if (command === "open") return { exitCode: 0, stdout: '{"pid":4242}', stderr: "" };
        if (command === "run-code") return { exitCode: 0, stdout: JSON.stringify({ result: { url: "https://jobs.example/apply", title: "Apply", currentIndex: 0, targetId: "abcdef1234567890", tabs: [{ url: "https://jobs.example/apply", title: "Apply" }] } }), stderr: "" };
        if (command === "close") return { exitCode: 0, stdout: JSON.stringify({ session: "jobhunt-00000000000000000000000000000002", status: "closed" }), stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const browser = new PlaywrightCliBrowser({ artifactsRoot: root, launch: await resolveBrowserLaunch({ cdpUrl: "http://127.0.0.1:9222" }), processRunner: runner });
    await browser.start();
    const runtime = new PlaywrightCliRuntime({ sessionId: "00000000-0000-0000-0000-000000000002", browser, sessionDirectory: root, nodeExecutable: "/usr/bin/node", cliScript: "/pinned/playwright-cli.js", processRunner: runner });
    await runtime.start("https://jobs.example/apply");
    commands.length = 0;

    const result = await runtime.execute("upload", [join(root, "missing.pdf")]);

    expect(result.exitCode).toBe(1);
    expect(commands).not.toContain("upload");
    await runtime.close();
    await browser.close();
  });

  test("retains ownership after cleanup failure and clears it after an idempotent retry", async () => {
    const root = await temporaryRoot();
    let failClose = true;
    const sessionName = "jobhunt-00000000000000000000000000000004";
    const runner: ProcessRunner = {
      async run(argv) {
        const command = argv[3];
        if (command === "--jobhunt-page-lease-version") return { exitCode: 0, stdout: "1\n", stderr: "" };
        if (command === "open") return { exitCode: 0, stdout: '{"pid":4242}', stderr: "" };
        if (command === "run-code") return { exitCode: 0, stdout: JSON.stringify({ result: { url: "https://jobs.example/apply", title: "Apply", currentIndex: 0, targetId: "abcdef1234567890", tabs: [] } }), stderr: "" };
        if (command === "close" && failClose) return { exitCode: 1, stdout: "", stderr: "busy" };
        if (command === "close") return { exitCode: 0, stdout: JSON.stringify({ session: sessionName, status: "closed" }), stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const browser = new PlaywrightCliBrowser({ artifactsRoot: root, launch: await resolveBrowserLaunch({ cdpUrl: "http://127.0.0.1:9222" }), processRunner: runner });
    await browser.start();
    const runtime = new PlaywrightCliRuntime({ sessionId: "00000000-0000-0000-0000-000000000004", browser, sessionDirectory: root, nodeExecutable: "/usr/bin/node", cliScript: "/pinned/playwright-cli.js", processRunner: runner });
    await runtime.start("https://jobs.example/apply");
    const ownership = join(root, "playwright-cli", "ownership.json");
    expect(JSON.parse(await readFile(ownership, "utf8"))).toMatchObject({ session_name: sessionName, daemon_pid: 4242 });

    await expect(runtime.close()).rejects.toThrow();
    expect(await readFile(ownership, "utf8")).toContain(sessionName);
    failClose = false;
    await runtime.close();
    await runtime.close();
    await expect(readFile(ownership)).rejects.toThrow();
    await browser.close();
  });

  test("allows only modal recovery until a fresh snapshot and never replays the failed action", async () => {
    const root = await temporaryRoot();
    const commands: string[] = [];
    let firstClick = true;
    const sessionName = "jobhunt-00000000000000000000000000000005";
    const runner: ProcessRunner = {
      async run(argv) {
        const command = argv[3]!;
        commands.push(command);
        if (command === "--jobhunt-page-lease-version") return { exitCode: 0, stdout: "1\n", stderr: "" };
        if (command === "open") return { exitCode: 0, stdout: '{"pid":4242}', stderr: "" };
        if (command === "run-code") return { exitCode: 0, stdout: JSON.stringify({ result: { url: "https://jobs.example/apply", title: "Apply", currentIndex: 0, targetId: "abcdef1234567890", tabs: [] } }), stderr: "" };
        if (command === "click" && firstClick) { firstClick = false; return { exitCode: 0, stdout: JSON.stringify({ isError: true, error: "click does not handle the modal state" }), stderr: "" }; }
        if (command === "snapshot") return { exitCode: 0, stdout: JSON.stringify({ snapshot: "fresh" }), stderr: "" };
        if (command === "close") return { exitCode: 0, stdout: JSON.stringify({ session: sessionName, status: "closed" }), stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const browser = new PlaywrightCliBrowser({ artifactsRoot: root, launch: await resolveBrowserLaunch({ cdpUrl: "http://127.0.0.1:9222" }), processRunner: runner });
    await browser.start();
    const runtime = new PlaywrightCliRuntime({ sessionId: "00000000-0000-0000-0000-000000000005", browser, sessionDirectory: root, nodeExecutable: "/usr/bin/node", cliScript: "/pinned/playwright-cli.js", processRunner: runner });
    await runtime.start("https://jobs.example/apply");
    commands.length = 0;

    expect((await runtime.execute("click", ["e3"])).exitCode).toBe(1);
    await expect(runtime.execute("fill", ["e3", "unsafe"])).rejects.toMatchObject({ requiresFreshInspection: true });
    expect(commands.filter((command) => command === "click")).toHaveLength(1);
    await runtime.execute("dialog-dismiss");
    await expect(runtime.execute("click", ["e3"])).rejects.toMatchObject({ requiresFreshInspection: true });
    expect((await runtime.execute("snapshot")).observation.dom).toBe("fresh");
    expect((await runtime.execute("click", ["e3"])).exitCode).toBe(0);
    await runtime.close();
    await browser.close();
  });

  test("stops startup on a CLI error envelope", async () => {
    const root = await temporaryRoot();
    const commands: string[] = [];
    const runner: ProcessRunner = {
      async run(argv) {
        const command = argv[3]!;
        commands.push(command);
        if (command === "--jobhunt-page-lease-version") return { exitCode: 0, stdout: "1\n", stderr: "" };
        if (command === "open") return { exitCode: 0, stdout: '{"pid":4242}', stderr: "" };
        if (command === "video-start") return { exitCode: 0, stdout: JSON.stringify({ isError: true, error: "ffmpeg unavailable" }), stderr: "" };
        if (command === "run-code") return { exitCode: 0, stdout: JSON.stringify({ result: { url: "https://jobs.example/apply", title: "Apply", currentIndex: 0, targetId: "abcdef1234567890", tabs: [] } }), stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const browser = new PlaywrightCliBrowser({ artifactsRoot: root, launch: await resolveBrowserLaunch({ cdpUrl: "http://127.0.0.1:9222" }), processRunner: runner });
    await browser.start();
    const runtime = new PlaywrightCliRuntime({ sessionId: "00000000-0000-0000-0000-000000000006", browser, sessionDirectory: root, nodeExecutable: "/usr/bin/node", cliScript: "/pinned/playwright-cli.js", processRunner: runner });

    await expect(runtime.start("https://jobs.example/apply")).rejects.toBeInstanceOf(Error);
    expect(commands).not.toContain("goto");
  });

  test("finishes a CLI command after its direct process exits when a daemon inherits output pipes", async () => {
    const root = await temporaryRoot();
    const fakeCli = join(root, "fake-cli.sh");
    const release = join(root, "release-daemon-output");
    await writeFile(fakeCli, `#!/bin/sh
command=
session=
for argument in "$@"; do
  case "$argument" in
    --session=*) session=$(printf '%s' "$argument" | cut -c 11-) ;;
    --jobhunt-page-lease-version|open|tab-list|video-start|goto|run-code|video-stop|close) command="$argument" ;;
  esac
done
case "$command" in
  --jobhunt-page-lease-version) printf '1\n' ;;
  open)
    printf 'abcdef1234567890\n' > "$JOBHUNT_PLAYWRIGHT_TARGET_PATH"
    (while [ ! -e "${release}" ]; do sleep 0.01; done) &
    printf '{"pid":%s}\n' "$!"
    ;;
  run-code) printf '%s\n' '{"result":{"url":"https://jobs.example/apply","title":"Apply","currentIndex":0,"targetId":"abcdef1234567890","tabs":[{"url":"https://jobs.example/apply","title":"Apply"}]}}' ;;
  close) printf '{"session":"%s","status":"closed"}\n' "$session" ;;
  *) printf '{}\n' ;;

esac
`);
    const browser = new PlaywrightCliBrowser({ artifactsRoot: root, launch: await resolveBrowserLaunch({ cdpUrl: "http://127.0.0.1:9222" }) });
    await browser.start();
    const runtime = new PlaywrightCliRuntime({ sessionId: "00000000-0000-0000-0000-000000000008", browser, sessionDirectory: root, nodeExecutable: "/bin/sh", cliScript: fakeCli });

    const starting = runtime.start("https://jobs.example/apply");
    const finishedBeforeDaemon = await Promise.race([starting.then(() => true), Bun.sleep(500).then(() => false)]);
    await writeFile(release, "release");
    await starting;
    await runtime.close();

    expect(finishedBeforeDaemon).toBeTrue();
  });
});

describe("Playwright CLI stale recovery", () => {
  test("closes a journaled daemon, returns owned targets, and clears ownership only after success", async () => {
    const root = await temporaryRoot();
    const sessionId = "00000000-0000-0000-0000-000000000003";
    const scope = join(root, sessionId, "playwright-cli");
    await mkdir(join(scope, "internal"), { recursive: true, mode: 0o700 });
    await writeFile(join(scope, "ownership.json"), JSON.stringify({ session_name: "jobhunt-00000000000000000000000000000003", daemon_pid: 7001 }), { mode: 0o600 });
    await writeFile(join(scope, "internal", "target-id"), "abcdef1234567890\n", { mode: 0o600 });
    const invocations: string[][] = [];
    const runner: ProcessRunner = {
      async run(argv) {
        invocations.push([...argv]);
        return { exitCode: 0, stdout: JSON.stringify({ session: "jobhunt-00000000000000000000000000000003", status: "closed" }), stderr: "" };
      },
    };

    const targets = await recoverStalePlaywrightCliSessions({ artifactsRoot: root, nodeExecutable: "/usr/bin/node", cliScript: "/pinned/playwright-cli.js", processRunner: runner });

    expect(targets).toEqual(["abcdef1234567890"]);
    expect(invocations[0]?.slice(0, 5)).toEqual(["/usr/bin/node", "/pinned/playwright-cli.js", "--session=jobhunt-00000000000000000000000000000003", "close", "--json"]);
    await expect(readFile(join(scope, "ownership.json"))).rejects.toThrow();
  });
});
