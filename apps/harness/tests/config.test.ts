import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ConfigParseError, parseHarnessConfig } from "../src/host/config.ts";

const roots: string[] = [];
const TOKEN = "test-token-0123456789abcdef-0123456789";

async function fixture(): Promise<{ root: string; node: string; script: string; env: Record<string, string> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-config-")));
  roots.push(root);
  const node = join(root, "node");
  const script = join(root, "playwright-cli.js");
  await writeFile(node, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(script, "export {};\n", { mode: 0o600 });
  return { root, node, script, env: { HOME: root, PATH: "", JOBHUNT_HARNESS_TOKEN: TOKEN } };
}

function runtimeArgs(node: string, script: string): string[] {
  return ["--node-executable", node, "--playwright-cli-script", script];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("harness configuration", () => {
  test("parses an explicit loopback CDP configuration with production defaults", async () => {
    const { root, node, script, env } = await fixture();
    const parsed = await parseHarnessConfig(
      [...runtimeArgs(node, script), "--cdp-url", "http://LOCALHOST:9222/"],
      env,
    );

    expect(parsed.config).toEqual({
      bearerToken: TOKEN,
      pipelineUrl: "http://127.0.0.1:3457",
      port: 8765,
      nodeExecutable: node,
      playwrightCliScript: script,
      userInfoJson: resolve(import.meta.dir, "../../..", ".jobhunt-data/user-info/current-context/personal/user-info.json"),
      modelAuthDatabase: join(root, ".jobhunt/browser-harness/model-auth.sqlite"),
      gmailOauthClientJson: join(root, ".jobhunt/browser-harness/gmail-oauth-client.json"),
      gmailTokenJson: join(root, ".jobhunt/browser-harness/gmail-token.json"),
      gmailVerificationTimeout: 180,
      browser: { cdpUrl: "http://localhost:9222" },
    });
    expect(parsed.browserLaunch).toEqual({
      cdpUrl: "http://localhost:9222",
      executablePath: null,
      userDataDir: null,
      isCdp: true,
    });
  });
  test("applies explicit scalar and storage path overrides", async () => {
    const { root, node, script, env } = await fixture();
    const userInfo = join(root, "user", "info.json");
    const credentials = join(root, "credential-link.json");
    const gmailClient = join(root, "gmail", "client.json");
    const gmailToken = join(root, "gmail", "token.json");
    await writeFile(join(root, "credential-target.json"), "{}", { mode: 0o600 });
    await symlink(join(root, "credential-target.json"), credentials);

    const parsed = await parseHarnessConfig([
      ...runtimeArgs(node, script),
      "--cdp-url", "http://127.0.0.1:9333",
      "--port", "9876",
      "--pipeline-url", "http://localhost:4567/",
      "--user-info-json", userInfo,
      "--model-auth-database", credentials,
      "--gmail-oauth-client-json", gmailClient,
      "--gmail-token-json", gmailToken,
      "--gmail-verification-timeout", "240",
    ], env);

    expect(parsed.config).toMatchObject({
      port: 9876,
      pipelineUrl: "http://localhost:4567",
      userInfoJson: userInfo,
      modelAuthDatabase: credentials,
      gmailOauthClientJson: gmailClient,
      gmailTokenJson: gmailToken,
      gmailVerificationTimeout: 240,
    });
  });
  test("requires an explicit token even when HOME contains a private token file", async () => {
    const { root, node, script, env } = await fixture();
    delete env.JOBHUNT_HARNESS_TOKEN;
    const directory = join(root, ".jobhunt/browser-harness");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "token"), TOKEN, { mode: 0o600 });

    const parsed = parseHarnessConfig(
      [...runtimeArgs(node, script), "--cdp-url", "http://127.0.0.1:9222"],
      env,
    );

    await expect(parsed).rejects.toBeInstanceOf(ConfigParseError);
    await expect(parsed).rejects.toThrow("JOBHUNT_HARNESS_TOKEN must be configured with at least 32 characters");
  });
  test("rejects unknown options and long-option abbreviations without exposing values", async () => {
    const { node, script, env } = await fixture();
    for (const option of ["--host", "--token", "--pipe", "--chrome-exe"]) {
      const secret = "private-option-value";
      const promise = parseHarnessConfig([
        ...runtimeArgs(node, script), "--cdp-url", "http://127.0.0.1:9222", option, secret,
      ], env);
      await expect(promise).rejects.toBeInstanceOf(ConfigParseError);
      await expect(promise).rejects.not.toThrow(secret);
    }
  });
  test("resolves an explicit native browser and creates its dedicated private profile", async () => {
    const { root, node, script, env } = await fixture();
    const chrome = join(root, "chrome");
    const profile = join(root, "dedicated-profile");
    await writeFile(chrome, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    const parsed = await parseHarnessConfig([
      ...runtimeArgs(node, script),
      "--chrome-executable", chrome,
      "--chrome-user-data-dir", profile,
    ], env);

    expect(parsed.config.browser).toEqual({ chromeExecutable: chrome, chromeUserDataDir: profile });
    expect(parsed.browserLaunch).toEqual({
      cdpUrl: null,
      executablePath: chrome,
      userDataDir: profile,
      isCdp: false,
    });
  });
  test("detects Node from PATH and uses the harness-local Playwright CLI script", async () => {
    const { root, env } = await fixture();
    const bin = join(root, "bin");
    const node = join(bin, "node");
    await mkdir(bin, { mode: 0o700 });
    await writeFile(node, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    env.PATH = bin;

    const parsed = await parseHarnessConfig(["--cdp-url", "http://127.0.0.1:9222"], env);

    expect(parsed.config.nodeExecutable).toBe(node);
    expect(parsed.config.playwrightCliScript).toBe(
      join(process.cwd(), "node_modules/@playwright/cli/playwright-cli.js"),
    );
  });

  test("rejects non-loopback endpoints, out-of-range integers, and mixed browser modes", async () => {
    const { node, script, env } = await fixture();
    const prefix = runtimeArgs(node, script);
    const invalidArguments = [
      [...prefix, "--cdp-url", "http://127.0.0.1"],
      [...prefix, "--cdp-url", "http://example.test:9222"],
      [...prefix, "--cdp-url", "http://127.0.0.1:9222/path"],
      [...prefix, "--cdp-url", "http://127.0.0.1:9222", "--pipeline-url", "https://127.0.0.1:3457"],
      [...prefix, "--cdp-url", "http://127.0.0.1:9222", "--port", "0"],
      [...prefix, "--cdp-url", "http://127.0.0.1:9222", "--gmail-verification-timeout", "901"],
      [...prefix, "--cdp-url", "http://127.0.0.1:9222", "--chrome-user-data-dir", join(process.cwd(), "profile")],
    ];
    for (const argv of invalidArguments) {
      await expect(parseHarnessConfig(argv, env)).rejects.toBeInstanceOf(ConfigParseError);
    }
  });
  test("expands home-relative paths while preserving lexical store targets", async () => {
    const { root, env } = await fixture();
    const parsed = await parseHarnessConfig([
      "--node-executable", "~/node",
      "--playwright-cli-script", "~/playwright-cli.js",
      "--cdp-url", "http://127.0.0.1:9222",
      "--model-auth-database", "~/private/credentials.json",
    ], env);

    expect(parsed.config.nodeExecutable).toBe(join(root, "node"));
    expect(parsed.config.playwrightCliScript).toBe(join(root, "playwright-cli.js"));
    expect(parsed.config.modelAuthDatabase).toBe(join(root, "private/credentials.json"));
  });
  test("detects a native Chromium executable from PATH", async () => {
    const { root, node, script, env } = await fixture();
    const bin = join(root, "bin");
    const chrome = join(bin, "chromium");
    await mkdir(bin, { mode: 0o700 });
    await writeFile(chrome, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    env.PATH = bin;

    const parsed = await parseHarnessConfig(runtimeArgs(node, script), env);

    expect(parsed.browserLaunch.executablePath).toBe(chrome);
    expect(parsed.browserLaunch.userDataDir).toBe(join(root, ".jobhunt/browser-harness/chrome"));
  });
  test("accepts exact long options with equals-separated values", async () => {
    const { node, script, env } = await fixture();
    const parsed = await parseHarnessConfig([
      ...runtimeArgs(node, script),
      "--cdp-url=http://127.0.0.1:9222",
      "--port=9877",
    ], env);

    expect(parsed.config.port).toBe(9877);
    expect(parsed.config.browser).toEqual({ cdpUrl: "http://127.0.0.1:9222" });
  });
  test("does not fall back when the explicit token is invalid", async () => {
    const { root, node, script, env } = await fixture();
    const directory = join(root, ".jobhunt/browser-harness");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "token"), TOKEN, { mode: 0o600 });
    const invalidToken = "😀".repeat(16);
    env.JOBHUNT_HARNESS_TOKEN = invalidToken;
    const parsed = parseHarnessConfig([
      ...runtimeArgs(node, script), "--cdp-url", "http://127.0.0.1:9222",
    ], env);

    await expect(parsed).rejects.toThrow("JOBHUNT_HARNESS_TOKEN must be configured with at least 32 characters");
    await expect(parsed).rejects.not.toThrow(invalidToken);
  });
});
