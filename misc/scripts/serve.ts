import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveLaunchConfiguration } from "./launch-config.ts";
import { prepareLaunchStorageForLaunch } from "./launch-storage.ts";
import { backupUserContextForLaunch } from "./user-context-backup.ts";

const modeArgument = process.argv[2];
if (modeArgument !== "dev" && modeArgument !== "start") {
  throw new Error("Expected launch mode: dev or start");
}
const mode: "dev" | "start" = modeArgument;

const appsRoot = resolve(import.meta.dir, "../../apps");
const configuration = resolveLaunchConfiguration(mode, appsRoot);
await prepareLaunchStorageForLaunch(configuration);
function assertLaunchConfigurationUnchanged(): void {
  const currentConfiguration = resolveLaunchConfiguration(mode, appsRoot);
  if (!isDeepStrictEqual(currentConfiguration, configuration)) {
    throw new Error("Launch checkout or storage configuration changed during preparation");
  }
}
assertLaunchConfigurationUnchanged();
await backupUserContextForLaunch(mode, appsRoot);
assertLaunchConfigurationUnchanged();
const childEnvironment = {
  ...process.env,
  PORT: String(configuration.webPort),
  JOBHUNT_PIPELINE_PORT: String(configuration.pipelinePort),
  JOBHUNT_PIPELINE_ORIGIN: configuration.pipelineOrigin,
  JOBHUNT_WEB_ORIGIN: configuration.webOrigin,
  JOBHUNT_HARNESS_URL: configuration.harnessOrigin,
  JOBHUNT_PIPELINE_DATABASE: configuration.pipelineDatabase,
  JOBHUNT_CONTEXT_DATABASE: configuration.contextDatabase,
  JOBHUNT_AUTH_DATABASE: configuration.authDatabase,
  JOBHUNT_ARTIFACT_ROOT: configuration.artifactRoot,
  ...(configuration.transcriptPdf === undefined
    ? {}
    : { JOBHUNT_TRANSCRIPT_PDF: configuration.transcriptPdf }),
};
const pipeline = Bun.spawn(["bun", "run", "--cwd", "backend", mode], {
  cwd: appsRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: childEnvironment,
});

let web: Bun.Subprocess | undefined;
let stopping = false;

async function terminate(signal: NodeJS.Signals, exitCode: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    pipeline.kill(signal);
    web?.kill(signal);
    await Promise.allSettled([pipeline.exited, web?.exited]);
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => void terminate("SIGINT", 0));
process.on("SIGTERM", () => void terminate("SIGTERM", 0));

const healthDeadline = Date.now() + 30_000;
while (true) {
  if (pipeline.exitCode !== null) {
    throw new Error(`Pipeline exited before it became healthy (${pipeline.exitCode})`);
  }
  try {
    const response = await fetch(`${configuration.pipelineOrigin}/v1/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok) break;
  } catch {
    // The service is still starting.
  }
  if (Date.now() >= healthDeadline) {
    await terminate("SIGTERM", 1);
  }
  await Bun.sleep(200);
}

try {
  assertLaunchConfigurationUnchanged();
} catch (error) {
  pipeline.kill("SIGTERM");
  await pipeline.exited;
  throw error;
}

web = Bun.spawn(["bun", "run", "--cwd", "web", mode], {
  cwd: appsRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: childEnvironment,
});

const [name, exitCode] = await Promise.race([
  pipeline.exited.then((code) => ["pipeline", code] as const),
  web.exited.then((code) => ["web", code] as const),
]);
console.error(`${name} exited with code ${exitCode}; stopping workspace`);
await terminate("SIGTERM", exitCode);
