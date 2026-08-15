import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveLaunchConfiguration } from "./launch-config.ts";
import {
  completeLaunchStoragePreparation,
  prepareLaunchStorageForLaunch,
} from "./launch-storage.ts";
import { backupUserContextForLaunch } from "./user-context-backup.ts";

const modeArgument = process.argv[2];
if (modeArgument !== "dev" && modeArgument !== "start") {
  throw new Error("Expected launch mode: dev or start");
}
const mode: "dev" | "start" = modeArgument;

const appsRoot = resolve(import.meta.dir, "..");
const configuration = resolveLaunchConfiguration(mode, appsRoot);
const storagePreparation = await prepareLaunchStorageForLaunch(configuration);
function assertLaunchConfigurationUnchanged(): void {
  const currentConfiguration = resolveLaunchConfiguration(mode, appsRoot);
  if (!isDeepStrictEqual(currentConfiguration, configuration)) {
    throw new Error("Launch checkout or storage configuration changed during preparation");
  }
}
assertLaunchConfigurationUnchanged();
await backupUserContextForLaunch(mode, appsRoot);
assertLaunchConfigurationUnchanged();
const {
  JOBHUNTER_ARTIFACT_MIGRATION_RECEIPT: _ignoredArtifactMigrationReceipt,
  JOBHUNTER_PRIOR_ARTIFACT_ROOT: _ignoredPriorArtifactRoot,
  ...inheritedEnvironment
} = process.env;
const childEnvironment = {
  ...inheritedEnvironment,
  PORT: String(configuration.webPort),
  JOBHUNTER_PIPELINE_PORT: String(configuration.pipelinePort),
  JOBHUNTER_PIPELINE_ORIGIN: configuration.pipelineOrigin,
  JOBHUNTER_WEB_ORIGIN: configuration.webOrigin,
  JOBHUNTER_HARNESS_URL: configuration.harnessOrigin,
  JOBHUNTER_PIPELINE_DATABASE: configuration.pipelineDatabase,
  JOBHUNTER_CONTEXT_DATABASE: configuration.contextDatabase,
  JOBHUNTER_AUTH_DATABASE: configuration.authDatabase,
  JOBHUNTER_ARTIFACT_ROOT: configuration.artifactRoot,
  ...(storagePreparation.artifactMigration === undefined
    ? {}
    : {
      JOBHUNTER_PRIOR_ARTIFACT_ROOT: storagePreparation.artifactMigration.priorRoot,
      JOBHUNTER_ARTIFACT_MIGRATION_RECEIPT:
        storagePreparation.artifactMigration.receiptPath,
    }),
};
const pipeline = Bun.spawn(["bun", "run", "--cwd", "resume-tailoring", mode], {
  cwd: appsRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: childEnvironment,
});

let web: Bun.Subprocess | undefined;
let stopping = false;
let storageReady = false;
let storageCompleted = false;

function completeStoragePreparation(): void {
  if (storageCompleted) return;
  completeLaunchStoragePreparation(storagePreparation);
  storageCompleted = true;
}

async function terminate(signal: NodeJS.Signals, exitCode: number): Promise<never> {
  let finalExitCode = exitCode;
  if (!stopping) {
    stopping = true;
    pipeline.kill(signal);
    web?.kill(signal);
    await Promise.allSettled([pipeline.exited, web?.exited]);
    if (mode === "dev" && storageReady) {
      try {
        completeStoragePreparation();
      } catch (error) {
        console.error("Failed to complete runtime storage preparation", error);
        finalExitCode = 1;
      }
    }
  }
  process.exit(finalExitCode);
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

storageReady = true;
if (mode === "start") {
  try {
    completeStoragePreparation();
  } catch (error) {
    pipeline.kill("SIGTERM");
    await pipeline.exited;
    throw error;
  }
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
