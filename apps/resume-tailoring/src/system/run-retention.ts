import type { PipelineRepository } from "../db/repository.ts";
import type { ArtifactStore } from "./artifacts.ts";

export const RUN_ARTIFACT_RETENTION_COUNT = 10;

export async function enforceRunArtifactRetention(
  repository: Pick<PipelineRepository, "reserveArtifactPruneCandidates" | "markRunArtifactsPruned" | "getRun">,
  artifacts: Pick<ArtifactStore, "removeRun">,
): Promise<number> {
  const candidates = repository.reserveArtifactPruneCandidates(RUN_ARTIFACT_RETENTION_COUNT);
  const errors: unknown[] = [];
  let pruned = 0;
  for (const runId of candidates) {
    try {
      const run = repository.getRun(runId);
      if (!run) throw new Error(`retention candidate ${runId} no longer exists`);
      await artifacts.removeRun(run.queueSequence);
      repository.markRunArtifactsPruned(runId);
      pruned++;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "failed to prune one or more run artifact directories");
  return pruned;
}
