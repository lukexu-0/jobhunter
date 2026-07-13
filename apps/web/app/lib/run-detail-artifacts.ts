import type { ArtifactDto, ArtifactKind } from "@jobhunter/pipeline/contracts";

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

export function selectCurrentRevisionArtifact(
  artifacts: readonly ArtifactDto[],
  revision: number,
  kind: ArtifactKind,
): ArtifactDto | undefined {
  return selectLatestPublic(artifacts, kind, revision);
}

export function selectReusableJobAnalysis(artifacts: readonly ArtifactDto[]): ArtifactDto | undefined {
  return selectLatestPublic(artifacts, "job-analysis");
}

export function publicArtifacts(artifacts: readonly ArtifactDto[]): ArtifactDto[] {
  return artifacts.filter((artifact) => artifact.public);
}
