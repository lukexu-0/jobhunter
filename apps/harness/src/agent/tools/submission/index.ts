import { ApplicationRunResultSchema } from "../../../application/application-runtime-client.ts";
import { ApplicationAgentFailure } from "../../../application/agent-runtime/contracts/application.ts";
import type { ApplicationSessionState } from "../../../application/agent-runtime/session/application.ts";
import {
  runtimeTool, runtimeAction, rejectInvalidRuntimeResponse,
  rejectMissingBrowserInspection, ApplicationMismatchToolParameters,
  SubmissionOutcomeParameters,
} from "../shared.ts";

export function createSubmissionTools(state: ApplicationSessionState) {
  const reportApplicationMismatch = runtimeTool({
    name: "report_application_mismatch",
    description: "Report that the requested posting is unavailable or the visible application materially mismatches it.",
    parameters: ApplicationMismatchToolParameters,
    execute: async (_input, runtimeContext, actionSignal) => {
      rejectMissingBrowserInspection(runtimeContext);
      const response = await runtimeAction(
        runtimeContext,
        { type: "report_application_mismatch" },
        actionSignal,
      );
      if (response.type !== "application_mismatch") {
        rejectInvalidRuntimeResponse(runtimeContext, "report_application_mismatch");
      }
      state.mismatchReported = true;
      return JSON.stringify(response);
    },
  });

  const reportSubmissionOutcome = runtimeTool({
    name: "report_submission_outcome",
    description: "After approval and hitting Submit, inspect the resulting page and answer whether the application was submitted. Pass submitted:true for Yes to finish. Pass submitted:false for No to keep working, correct errors, and try submitting again. Do not answer No merely because the page is still loading; inspect again first. No confirmation text or result summary is required.",
    parameters: SubmissionOutcomeParameters,
    allowAfterApproval: true,
    execute: async ({ submitted }, runtimeContext) => {
      if (
        !runtimeContext.submissionApproved
        || !runtimeContext.submissionOutcomePending
        || !runtimeContext.submissionClaimed
        || runtimeContext.lastReviewResult === undefined
      ) {
        return "Wait until after approval and after you hit Submit. Then inspect the result and call report_submission_outcome.";
      }
      if (
        !runtimeContext.playwrightCliCompleted
        || runtimeContext.postNavigationInspectionRequired
        || runtimeContext.browserSnapshotRequired
        || runtimeContext.latestSubmissionExecution === undefined
      ) {
        return "Inspect the page after Submit before reporting the outcome. If it is still loading or inspection failed, inspect again; do not resubmit merely because the outcome is unclear.";
      }
      runtimeContext.submissionOutcomePending = false;
      if (!submitted) {
        return "Not submitted. Keep working in this approved session: correct the errors using supplied facts, or request human navigation for a genuine blocker. Then hit Submit again and inspect the result before reporting Yes or No. No fresh approval is needed; do not stop or wait for the user merely because you reported No.";
      }
      state.terminalResultPending = ApplicationRunResultSchema.parse({
        ...runtimeContext.lastReviewResult,
        status: "submitted",
        submit_attempted: true,
        final_url: runtimeContext.latestSubmissionExecution.observation.url,
      });
      try {
        state.terminalFinalizePromise = runtimeContext.submissionGuard.finalize("submitted");
        await state.terminalFinalizePromise;
      } catch {
        throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
      }
      state.terminalFinalizationCommitted = true;
      runtimeContext.submissionFinalized = true;
      return "Submitted.";
    },
  });
  return { reportApplicationMismatch, reportSubmissionOutcome };
}
