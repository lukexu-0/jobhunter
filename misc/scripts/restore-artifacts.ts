import { resolve } from "node:path";
import { PipelineRepository } from "../../apps/backend/src/db/repository.ts";
import { openPipelineDatabase } from "../../apps/backend/src/db/database.ts";
import {
  restorePrunedRunArtifacts,
  type RunArtifactRestoreSummary,
} from "../../apps/backend/src/system/run-artifact-restore.ts";
import { resolveLaunchConfiguration } from "./launch-config.ts";
import {
  prepareLaunchStorageForArtifactRecovery,
  withStoppedPipeline,
} from "./launch-storage.ts";

const MAX_FATAL_MESSAGE_LENGTH = 512;

interface ArtifactRestoreCommandSummary extends RunArtifactRestoreSummary {
  readonly fatal?: string;
}

function fatalSummary(error: unknown): ArtifactRestoreCommandSummary {
  const message = error instanceof Error ? error.message : String(error);
  return {
    markers: 0,
    restored: 0,
    published: 0,
    reused: 0,
    unrecovered: 0,
    failures: [],
    omittedFailures: 0,
    fatal: message.slice(0, MAX_FATAL_MESSAGE_LENGTH),
  };
}

export async function runArtifactRestoreCommand(
  args: readonly string[],
  writeSummary: (summary: string) => void = (summary) => console.log(summary),
): Promise<number> {
  let summary: ArtifactRestoreCommandSummary;
  if (args.length !== 0) {
    summary = fatalSummary(new Error("artifacts:restore does not accept arguments"));
  } else {
    try {
      const appsRoot = resolve(import.meta.dir, "../../apps");
      const configuration = resolveLaunchConfiguration("start", appsRoot);
      summary = await withStoppedPipeline(configuration, () => {
        prepareLaunchStorageForArtifactRecovery(configuration);
        const database = openPipelineDatabase(configuration.pipelineDatabase, {
          createParent: false,
        });
        try {
          const repository = new PipelineRepository(database);
          return restorePrunedRunArtifacts(repository, {
            artifactRoot: configuration.artifactRoot,
            priorArtifactRoot: configuration.artifactRoot,
          });
        } finally {
          database.close();
        }
      });
    } catch (error) {
      summary = fatalSummary(error);
    }
  }

  writeSummary(JSON.stringify(summary));
  return summary.fatal === undefined && summary.unrecovered === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await runArtifactRestoreCommand(process.argv.slice(2));
}
