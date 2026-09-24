import { Agent } from "@openai/agents-core";
import type { ApplicationModel } from "../models/application-model.ts";
import type { ApplicationAgentRunInput, BrowserApplicationContext } from "../application/agent-runtime/contracts/application.ts";
import type { ApplicationAgentProfile } from "./instructions/application.ts";
import type { ApplicationSessionState } from "../application/agent-runtime/session/application.ts";
import { createBrowserTool } from "./tools/browser/index.ts";
import { createReadTools } from "./tools/read.ts";
import { createHumanTools } from "./tools/human.ts";
import { createSubmissionTools } from "./tools/submission/index.ts";

export function createApplicationAgent(
  input: ApplicationAgentRunInput,
  profile: ApplicationAgentProfile,
  state: ApplicationSessionState,
  applicationModel: ApplicationModel,
): Agent<BrowserApplicationContext, "text"> {
  const playwrightCli = createBrowserTool(state);
  const { getCurrentTime, readUserInfo, readInbox, readEmail, getCredentials } = createReadTools();
  const { requestHumanNavigation, requestAdditionalInfo, requestHumanReview } = createHumanTools(input, state);
  const { reportApplicationMismatch, reportSubmissionOutcome } = createSubmissionTools(state);
  const agent = new Agent<BrowserApplicationContext, "text">({
    name: profile.name,
    instructions: input.autoSubmit
      ? profile.autoSubmitInstructions
      : profile.humanReviewInstructions,
    model: applicationModel.model,
    modelSettings: {
      reasoning: { effort: applicationModel.reasoning },
      ...(applicationModel.modelProvider === "openai-codex" ? {
        contextManagement: [{ type: "compaction" as const, compactThreshold: 272_000 }],
      } : {}),
      toolChoice: "required",
      parallelToolCalls: false,
      store: false,
      retry: { maxRetries: 0 },
    },
    tools: [
      playwrightCli,
      getCurrentTime,
      readUserInfo,
      readInbox,
      readEmail,
      getCredentials,
      requestHumanNavigation,
      requestAdditionalInfo,
      requestHumanReview,
      reportApplicationMismatch,
      reportSubmissionOutcome,
    ],
    toolUseBehavior: () => {
      if (state.terminalFinalizationCommitted && state.terminalResultPending !== undefined) {
        return { isFinalOutput: true, isInterrupted: undefined, finalOutput: JSON.stringify(state.terminalResultPending) };
      }
      if (state.mismatchReported) {
        return { isFinalOutput: true, isInterrupted: undefined, finalOutput: "Application mismatch." };
      }
      return { isFinalOutput: false, isInterrupted: undefined };
    },
    resetToolChoice: false,
  });
  return agent;
}
