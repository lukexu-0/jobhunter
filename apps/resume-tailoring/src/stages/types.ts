import type { ContextSnapshot } from "../context/types.ts";
import type {
  ActiveStage,
  AttemptOrigin,
  PublicArtifact,
  PublicAttempt,
  PublicEditRequest,
  PublicRun,
  RunSourceSnapshotInput,
  RunStatus,
} from "../db/repository.ts";
import type { RunClaim } from "../worker/claims.ts";

export type ClaimIdentity = Pick<RunClaim, "runId" | "token">;

/** The claim-fenced persistence boundary used by the stage processor. */
export interface StageRepository {
  getRun(runId: string): PublicRun | null;
  getArtifact(runId: string, kind: string, revision?: number): PublicArtifact | null;
  getArtifactById(runId: string, artifactId: string): PublicArtifact | null;
  listResolvedArtifacts(runId: string): PublicArtifact[];
  getEditRequest(runId: string, targetRevision?: number): PublicEditRequest | null;
  assertSourceSnapshot(runId: string, current: RunSourceSnapshotInput): void;
  transition(
    claim: ClaimIdentity,
    target: RunStatus,
    options?: { failedStage?: ActiveStage; visualAcknowledgementRequired?: boolean },
  ): PublicRun;
  completeVisualQa(
    claim: ClaimIdentity,
    expectedPdfSha256: string,
    visualAcknowledgementRequired: boolean,
  ): PublicRun;
  startAttempt(
    claim: ClaimIdentity,
    stage: ActiveStage,
    options?: { origin?: AttemptOrigin; processPid?: number; processStartToken?: string },
  ): PublicAttempt;
  finishAttempt(
    claim: ClaimIdentity,
    attemptId: string,
    outcome: "succeeded" | "failed",
    audit?: { toolCount?: number; compileCount?: number },
  ): PublicAttempt;
  acknowledgeCancellation(attemptId: string, token: string): boolean;
  finalizeArtifact(
    claim: ClaimIdentity,
    input: {
      id?: string;
      attemptId: string;
      stage: string;
      kind: string;
      sha256: string;
      path: string;
      byteSize: number;
      sourceArtifactId?: string;
    },
  ): PublicArtifact;
}

export interface StageSourceContext {
  readonly snapshot: ContextSnapshot;
  readonly baseline: string;
}
