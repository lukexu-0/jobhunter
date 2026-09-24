import { resolveApplicationModel } from "../../../models/application-model.ts";
import { GeminiHistoryCompactor } from "../application-compaction.ts";
import {
  ApplicationAgentRunInputSchema,
  ApplicationAgentFailure,
  type ApplicationAgentRunInput,
  type ApplicationAgentDependencies,
  type BrowserApplicationContext,
} from "../contracts/application.ts";
import type { ApplicationAgentProfile } from "../../../agent/instructions/application.ts";
import type { ApplicationRunResult } from "../../application-runtime-client.ts";

export interface ApplicationSessionState {
  submissionClaimPromise?: Promise<void>;
  submissionCleanupStarted: boolean;
  terminalResultPending?: ApplicationRunResult;
  terminalFinalizePromise?: Promise<void>;
  terminalFinalizationCommitted: boolean;
  mismatchReported: boolean;
}

export function prepareApplicationSession(
  unparsedInput: ApplicationAgentRunInput,
  signal: AbortSignal,
  profile: ApplicationAgentProfile,
  dependencies?: ApplicationAgentDependencies,
) {
  const input = ApplicationAgentRunInputSchema.parse(unparsedInput);
  if (
    (profile.kind === "job" && input.opportunityKind !== "job")
    || (profile.kind === "non-job" && input.opportunityKind === "job")
  ) {
    throw new ApplicationAgentFailure("INVALID_REQUEST");
  }
  if (
    !dependencies?.runtimeClient
    || typeof dependencies.runtimeClient.action !== "function"
    || !dependencies.submissionGuard
    || typeof dependencies.submissionGuard.markReviewReady !== "function"
    || typeof dependencies.submissionGuard.claim !== "function"
    || typeof dependencies.submissionGuard.finalize !== "function"
  ) {
    throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
  }
  signal.throwIfAborted();
  const applicationModel = dependencies.applicationModel ?? resolveApplicationModel();
  const historyCompactor = applicationModel.modelProvider === "google-antigravity"
    ? dependencies.historyCompactorFactory?.(input.sessionId)
      ?? new GeminiHistoryCompactor(input.sessionId)
    : undefined;
  const context: BrowserApplicationContext = {
    runtimeClient: dependencies.runtimeClient,
    submissionGuard: dependencies.submissionGuard,
    signal,
    ...(dependencies.steeringInbox === undefined
      ? {}
      : { steeringInbox: dependencies.steeringInbox }),
    submissionApproved: false,
    submissionActionStarted: false,
    submissionClaimed: false,
    submissionFinalized: false,
    submissionOutcomePending: false,
    playwrightCliCompleted: false,
    postNavigationInspectionRequired: false,
    browserSnapshotRequired: false,
    modalRecoveryPending: false,
    recoverableFailureObserved: false,
  };
  const state: ApplicationSessionState = {
    submissionCleanupStarted: false,
    terminalFinalizationCommitted: false,
    mismatchReported: false,
  };
  return { input, applicationModel, historyCompactor, context, state, dependencies };
}

export const claimSubmissionActionIfApproved = async (
  state: ApplicationSessionState,
  runtimeContext: BrowserApplicationContext,
  actionSignal: AbortSignal,
): Promise<boolean> => {
  actionSignal.throwIfAborted();
  if (!runtimeContext.submissionApproved) return false;
  if (!runtimeContext.submissionActionStarted) {
    runtimeContext.submissionActionStarted = true;
    runtimeContext.steeringInbox?.close();
    try {
      state.submissionClaimPromise = runtimeContext.submissionGuard.claim();
      await state.submissionClaimPromise;
    } catch {
      throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
    }
    runtimeContext.submissionClaimed = true;
    actionSignal.throwIfAborted();
    if (state.submissionCleanupStarted) {
      throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
    }
  } else if (!runtimeContext.submissionClaimed || state.submissionCleanupStarted) {
    throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
  }
  return true;
};
