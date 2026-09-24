import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { PLAYWRIGHT_CLI_COMMANDS } from "../../../application/application-runtime-client.ts";

// Bun preserves import.meta.dir in bundles; source and dist need different paths to the repository root.
const REPOSITORY_ROOT = resolve(import.meta.dir, import.meta.dir.endsWith(`${sep}dist`) ? "../../.." : "../../../../../..");

const PLAYWRIGHT_CLI_AGENT_REFERENCE_RELATIVE_PATH =
  "apps/harness/playwright-cli-agent.md";

function loadPlaywrightCliAgentReference(): string {
  const repositoryRoot = realpathSync(REPOSITORY_ROOT);
  const referencePath = resolve(repositoryRoot, PLAYWRIGHT_CLI_AGENT_REFERENCE_RELATIVE_PATH);
  const lexicalRelativePath = relative(repositoryRoot, referencePath);
  if (
    lexicalRelativePath === ".."
    || lexicalRelativePath.startsWith(`..${sep}`)
    || isAbsolute(lexicalRelativePath)
  ) {
    throw new Error("Playwright CLI agent reference escapes the repository root");
  }
  const referenceStats = lstatSync(referencePath);
  if (referenceStats.isSymbolicLink() || !referenceStats.isFile()) {
    throw new Error("Playwright CLI agent reference must be a regular, non-symlink file");
  }
  const canonicalReferencePath = realpathSync(referencePath);
  const canonicalRelativePath = relative(repositoryRoot, canonicalReferencePath);
  if (
    canonicalRelativePath === ".."
    || canonicalRelativePath.startsWith(`..${sep}`)
    || isAbsolute(canonicalRelativePath)
  ) {
    throw new Error("Playwright CLI agent reference resolves outside the repository root");
  }
  return readFileSync(canonicalReferencePath, "utf8");
}

const PLAYWRIGHT_CLI_AGENT_REFERENCE = loadPlaywrightCliAgentReference();
const PLAYWRIGHT_CLI_MAPPING_PRELUDE =
  "Map tool parameters to runtime JSON as `{\"command\":\"<approved command>\",\"args\":[\"<argument>\"]}`; omit `args` only when empty because it defaults to `[]`.";
const PLAYWRIGHT_CLI_RESTRICTION_SUFFIX = `Application-harness restrictions:
- Use only these commands: ${PLAYWRIGHT_CLI_COMMANDS.map((command) => `\`${command}\``).join(", ")}.
- Follow application links, redirects, and new tabs across websites directly. Domain changes do not require approval or human navigation. Use \`request_human_navigation\` only when a person must interact with the page, such as a CAPTCHA.
- The application harness owns \`open\`, \`close\`, \`video-start\`, \`video-stop\`, route installation, session selection, timeouts, the output directory, and profile/CDP configuration. Never request lifecycle or session control.
- Never use storage, network, console, \`run-code\`, tracing, recording start/stop, install, or dashboard commands. Never pass harness-owned session, output-format, config, profile, persistent, headed, browser, CDP, endpoint, or extension flags in \`args\`.
- Upload and drop input paths must be inside the current stored session directory. Screenshots, PDFs, and video must stay in that private session directory.`;
export const PLAYWRIGHT_CLI_DESCRIPTION =
  `${PLAYWRIGHT_CLI_MAPPING_PRELUDE}\n\n${PLAYWRIGHT_CLI_AGENT_REFERENCE}\n\n${PLAYWRIGHT_CLI_RESTRICTION_SUFFIX}`;
