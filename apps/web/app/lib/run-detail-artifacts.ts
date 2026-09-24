import type {
  ArtifactDto,
  ArtifactKind,
  ResumeIterationDto,
} from "./pipeline-contracts";

export interface ResumeIterationSelection {
  readonly mode: "follow-latest" | "pinned";
  readonly selectedRevision: number | null;
}

export function reconcileResumeIterationSelection(
  previous: ResumeIterationSelection,
  iterations: readonly ResumeIterationDto[],
): ResumeIterationSelection {
  let latestRevision: number | null = null;
  let pinnedRevisionExists = false;
  for (const iteration of iterations) {
    if (latestRevision === null || iteration.revision > latestRevision) {
      latestRevision = iteration.revision;
    }
    if (iteration.revision === previous.selectedRevision) {
      pinnedRevisionExists = true;
    }
  }
  if (previous.mode === "pinned" && pinnedRevisionExists) return previous;
  return { mode: "follow-latest", selectedRevision: latestRevision };
}

function isNewer(left: ArtifactDto, right: ArtifactDto): boolean {
  return left.revision > right.revision
    || (left.revision === right.revision && left.attempt > right.attempt)
    || (left.revision === right.revision && left.attempt === right.attempt && left.createdAt > right.createdAt);
}

function selectLatestPublic(
  artifacts: readonly ArtifactDto[],
  kind: ArtifactKind,
  revision?: number,
): ArtifactDto | undefined {
  let selected: ArtifactDto | undefined;
  for (const artifact of artifacts) {
    if (!artifact.public || artifact.kind !== kind || (revision !== undefined && artifact.revision !== revision)) continue;
    if (!selected || isNewer(artifact, selected)) selected = artifact;
  }
  return selected;
}

export function selectResolvedArtifact(
  artifacts: readonly ArtifactDto[],
  kind: ArtifactKind,
): ArtifactDto | undefined {
  return selectLatestPublic(artifacts, kind);
}

export function selectCurrentRevisionArtifact(
  artifacts: readonly ArtifactDto[],
  revision: number,
  kind: ArtifactKind,
): ArtifactDto | undefined {
  return selectLatestPublic(artifacts, kind, revision);
}

export function selectReusableJobAnalysis(artifacts: readonly ArtifactDto[]): ArtifactDto | undefined {
  return selectResolvedArtifact(artifacts, "job-analysis");
}

export function publicArtifacts(artifacts: readonly ArtifactDto[]): ArtifactDto[] {
  return artifacts.filter((artifact) => artifact.public);
}
