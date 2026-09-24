import { access, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, delimiter, join, resolve } from "node:path";

import {
  BrowserConfigurationError,
  resolveBrowserLaunch,
  type BrowserLaunchConfig,
  type ResolvedBrowserLaunch,
} from "./playwright-cli.ts";

const HARNESS_ROOT = resolve(import.meta.dir, basename(import.meta.dir) === "dist" ? ".." : "../..");
const REPOSITORY_ROOT = resolve(HARNESS_ROOT, "../..");

export class ConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigParseError";
  }
}

export interface HarnessConfig {
  bearerToken: string;
  pipelineUrl: string;
  port: number;
  nodeExecutable: string;
  playwrightCliScript: string;
  userInfoJson: string;
  modelAuthDatabase: string;
  gmailOauthClientJson: string;
  gmailTokenJson: string;
  gmailVerificationTimeout: number;
  browser: BrowserLaunchConfig;
}

export interface ParsedHarnessConfig {
  config: HarnessConfig;
  browserLaunch: ResolvedBrowserLaunch;
}
const SUPPORTED_OPTIONS = new Set([
  "--port",
  "--pipeline-url",
  "--node-executable",
  "--playwright-cli-script",
  "--user-info-json",
  "--model-auth-database",
  "--gmail-oauth-client-json",
  "--gmail-token-json",
  "--gmail-verification-timeout",
  "--chrome-executable",
  "--cdp-url",
  "--chrome-user-data-dir",
]);
async function regularFile(path: string, executable: boolean, description: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isFile()) throw new Error("not a file");
    if (executable) await access(canonical, fsConstants.X_OK);
    return canonical;
  } catch {
    throw new ConfigParseError(`The ${description} is unavailable`);
  }
}
async function executableOnPath(name: string, pathValue: string | undefined): Promise<string | undefined> {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function integerOption(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value == null) return fallback;
  if (!/^[+-]?\d+$/.test(value)) throw new ConfigParseError(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigParseError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function loopbackOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigParseError(`${name} must be a loopback HTTP URL`);
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(host) ||
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new ConfigParseError(`${name} must be a loopback HTTP URL`);
  }
  return `http://${url.host.toLowerCase()}`;
}

export async function parseHarnessConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ParsedHarnessConfig> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument == null) throw new ConfigParseError("Invalid command-line arguments");
    const separator = argument.indexOf("=");
    const inlineValue = separator >= 0;
    const name = inlineValue ? argument.slice(0, separator) : argument;
    const value = inlineValue ? argument.slice(separator + 1) : argv[++index];
    if (value == null || (!inlineValue && value.startsWith("--")) || !SUPPORTED_OPTIONS.has(name)) {
      throw new ConfigParseError("Invalid command-line arguments");
    }
    values.set(name, value);
  }
  const home = env.HOME;
  if (!home) throw new ConfigParseError("HOME is unavailable");
  const token = env.JOBHUNT_HARNESS_TOKEN;
  if (token == null || [...token].length < 32) {
    throw new ConfigParseError("JOBHUNT_HARNESS_TOKEN must be configured with at least 32 characters");
  }
  const configuredNode = values.get("--node-executable");
  const node = configuredNode == null
    ? await executableOnPath("node", env.PATH)
    : expandHome(configuredNode, home);
  const localCliScript = resolve(HARNESS_ROOT, "node_modules/@playwright/cli/playwright-cli.js");
  const configuredScript = values.get("--playwright-cli-script");
  let script = configuredScript == null ? undefined : expandHome(configuredScript, home);
  if (script == null) {
    try {
      if ((await stat(localCliScript)).isFile()) script = localCliScript;
    } catch {
      // Fall back to PATH below.
    }
    script ??= await executableOnPath("playwright-cli", env.PATH);
  }
  if (node == null) throw new ConfigParseError("The Node.js executable is unavailable");
  if (script == null) throw new ConfigParseError("The Playwright CLI script is unavailable");
  const cdpUrl = values.get("--cdp-url");
  const configuredChrome = values.get("--chrome-executable");
  let chromeExecutable = configuredChrome == null ? undefined : expandHome(configuredChrome, home);
  if (cdpUrl == null && chromeExecutable == null) {
    for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"]) {
      chromeExecutable = await executableOnPath(name, env.PATH);
      if (chromeExecutable != null) break;
    }
    const fixedCandidates = process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? [
            join(env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe"),
            join(env["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
            join(env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
          ]
        : [];
    for (const candidate of fixedCandidates) {
      if (chromeExecutable != null || !candidate) break;
      try {
        await access(candidate, fsConstants.X_OK);
        if ((await stat(candidate)).isFile()) chromeExecutable = candidate;
      } catch {
        // Continue checking platform-specific locations.
      }
    }
  }
  const profileOption = values.get("--chrome-user-data-dir");
  const configuredProfile = profileOption == null ? undefined : expandHome(profileOption, home);
  if (cdpUrl != null && (chromeExecutable != null || configuredProfile != null)) {
    throw new ConfigParseError("--cdp-url cannot be combined with native Chrome options");
  }
  try {
    const pipelineUrl = loopbackOrigin(values.get("--pipeline-url") ?? "http://127.0.0.1:3457", "pipeline_url");
    const port = integerOption(values.get("--port"), 8765, 1, 65_535, "port");
    const gmailVerificationTimeout = integerOption(
      values.get("--gmail-verification-timeout"), 180, 1, 900, "gmail_verification_timeout",
    );
    const browserInput: BrowserLaunchConfig = cdpUrl != null
      ? { cdpUrl }
      : {
          ...(chromeExecutable != null ? { chromeExecutable } : {}),
          chromeUserDataDir: configuredProfile ?? resolve(home, ".jobhunt/browser-harness/chrome"),
        };
    const browserLaunch = await resolveBrowserLaunch(browserInput);
    const browser: BrowserLaunchConfig = cdpUrl != null
      ? { cdpUrl: browserLaunch.cdpUrl }
      : {
          ...(chromeExecutable != null ? { chromeExecutable } : {}),
          chromeUserDataDir: configuredProfile ?? resolve(home, ".jobhunt/browser-harness/chrome"),
        };
    const config: HarnessConfig = {
      bearerToken: token,
      pipelineUrl,
      port,
      nodeExecutable: await regularFile(node, true, "Node.js executable"),
      playwrightCliScript: await regularFile(script, false, "Playwright CLI script"),
      userInfoJson: values.has("--user-info-json")
        ? resolve(expandHome(values.get("--user-info-json")!, home))
        : join(REPOSITORY_ROOT, ".jobhunt-data/user-info/current-context/personal/user-info.json"),
      modelAuthDatabase: resolve(expandHome(values.get("--model-auth-database") ?? join(home, ".jobhunt/browser-harness/model-auth.sqlite"), home)),
      gmailOauthClientJson: resolve(expandHome(values.get("--gmail-oauth-client-json") ?? join(home, ".jobhunt/browser-harness/gmail-oauth-client.json"), home)),
      gmailTokenJson: resolve(expandHome(values.get("--gmail-token-json") ?? join(home, ".jobhunt/browser-harness/gmail-token.json"), home)),
      gmailVerificationTimeout,
      browser,
    };
    return { config, browserLaunch };
  } catch (error) {
    if (error instanceof ConfigParseError) throw error;
    if (error instanceof BrowserConfigurationError) throw new ConfigParseError(error.message);
    throw new ConfigParseError("Invalid configuration");
  }
}
