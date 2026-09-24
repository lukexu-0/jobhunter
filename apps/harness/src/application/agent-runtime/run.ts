import type { AgentInputItem } from "@openai/agents-core";
import { ApplicationRunResultSchema, type ApplicationRunResult } from "../application-runtime-client.ts";
import { OAuthAntigravityModelProvider } from "../../models/oauth-antigravity-provider.ts";
import { createAttemptRunner } from "./runner.ts";
import {
  ApplicationAgentCancelled,
  ApplicationAgentFailure,
  MAX_RECOVERABLE_AGENT_CONTINUATIONS,
  type ApplicationAgentRunInput,
  type ApplicationAgentDependencies,
} from "./contracts/application.ts";
import { createApplicationAgent } from "../../agent/definition.ts";
import { applicationTranscriptAssertion, createApplicationHistory } from "./history/application.ts";
import { JOB_APPLICATION_AGENT_PROFILE, NON_JOB_APPLICATION_AGENT_PROFILE } from "../../agent/instructions/application.ts";
import { prepareApplicationSession } from "./session/application.ts";

export async function runApplicationAgent(
  unparsedInput: ApplicationAgentRunInput,
  signal: AbortSignal,
  dependencies?: ApplicationAgentDependencies,
): Promise<ApplicationRunResult> {
  const profile = unparsedInput.opportunityKind === "job"
    ? JOB_APPLICATION_AGENT_PROFILE
    : NON_JOB_APPLICATION_AGENT_PROFILE;
  const { input, applicationModel, historyCompactor, context, state, dependencies: requiredDependencies } =
    prepareApplicationSession(unparsedInput, signal, profile, dependencies);
  const { filter, projectPersistentHistory } = createApplicationHistory({
    input, applicationModel, historyCompactor, context, signal,
  });
  const agent = createApplicationAgent(input, profile, state, applicationModel);
  const runner = createAttemptRunner(input.sessionId, {
    ...requiredDependencies,
    ...(applicationModel.modelProvider === "google-antigravity" && requiredDependencies.providerFactory === undefined
      ? { providerFactory: (sessionId: string) => new OAuthAntigravityModelProvider(sessionId) }
      : {}),
  });
  try {
    try {
      let runInput: string | AgentInputItem[] = input.task;
      let continuationCount = 0;
      for (;;) {
        context.recoverableFailureObserved = false;
        const result = await runner.run(agent, runInput, {
          maxTurns: null,
          signal,
          context,
          callModelInputFilter: filter,
          assertTranscript: (result) => {
            if (applicationTranscriptAssertion(result, applicationModel.modelProvider)) {
              context.recoverableFailureObserved = true;
            }
          },
        });
        if (applicationTranscriptAssertion(result, applicationModel.modelProvider)) {
          context.recoverableFailureObserved = true;
        }
        if (state.mismatchReported || state.terminalFinalizationCommitted) break;
        if (
          (!context.recoverableFailureObserved && continuationCount === 0)
          || context.submissionActionStarted
          || context.submissionClaimed
          || context.submissionOutcomePending
          || continuationCount >= MAX_RECOVERABLE_AGENT_CONTINUATIONS
        ) {
          throw new ApplicationAgentFailure("INVALID_MODEL_OUTPUT");
        }
        continuationCount += 1;
        const recoveredHistory = projectPersistentHistory(
          (result as { history: AgentInputItem[] }).history,
        );
        runInput = [
          ...recoveredHistory,
          {
            role: "user",
            content: [{
              type: "input_text",
              text: "Continue the application after the recoverable failure. Use the required tools and take a fresh snapshot first when browser state is uncertain.",
            }],
          },
        ];
      }
    } catch (error) {
      let targetError = error;
      if (error !== null && typeof error === "object" && "error" in error) {
        const inner = error.error;
        if (
          inner instanceof ApplicationAgentCancelled
          || inner instanceof ApplicationAgentFailure
        ) {
          targetError = inner;
        }
      }
      if (targetError instanceof ApplicationAgentCancelled) {
        if (context.submissionClaimed) {
          throw new ApplicationAgentFailure("INVALID_MODEL_OUTPUT");
        }
        return ApplicationRunResultSchema.parse(targetError.result);
      }
      throw targetError;
    }

    if (state.mismatchReported) throw new ApplicationAgentFailure("APPLICATION_MISMATCH");
    if (!state.terminalFinalizationCommitted || state.terminalResultPending === undefined) {
      throw new ApplicationAgentFailure("INVALID_MODEL_OUTPUT");
    }
    return state.terminalResultPending;
  } finally {
    state.submissionCleanupStarted = true;
    if (
      context.submissionActionStarted
      && !context.submissionClaimed
      && state.submissionClaimPromise !== undefined
    ) {
      try {
        await state.submissionClaimPromise;
        context.submissionClaimed = true;
      } catch {
        // A rejected claim is pre-submission and remains normally retryable.
      }
    }
    if (
      context.submissionClaimed
      && !context.submissionFinalized
      && state.terminalFinalizePromise !== undefined
    ) {
      try {
        await state.terminalFinalizePromise;
        state.terminalFinalizationCommitted = true;
        context.submissionFinalized = true;
      } catch {
        // The conservative uncertain finalization below resolves a failed commit.
      }
    }
    if (context.submissionClaimed && !context.submissionFinalized) {
      try {
        await context.submissionGuard.finalize("uncertain");
        context.submissionFinalized = true;
      } catch {
        throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
      }
    }
    if (state.terminalFinalizationCommitted && state.terminalResultPending !== undefined) {
      return state.terminalResultPending;
    }
  }
}
