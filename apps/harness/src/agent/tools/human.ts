import { ReviewApplicationResultSchema } from "../../application/application-runtime-client.ts";
import {
  ApplicationAgentCancelled, ApplicationAgentFailure, ApplicationToolRejection,
  type ApplicationAgentRunInput,
} from "../../application/agent-runtime/contracts/application.ts";
import {
  REQUEST_HUMAN_NAVIGATION_DESCRIPTION, INTERRUPTED_ACTION_RESULT,
  CONTINUE_WITHOUT_ADDITIONAL_INFO_RESULT, HUMAN_REVIEW_DESCRIPTION,
  AUTO_SUBMIT_REVIEW_DESCRIPTION,
} from "../instructions/application.ts";
import { claimSubmissionActionIfApproved, type ApplicationSessionState } from "../../application/agent-runtime/session/application.ts";
import {
  runtimeTool, runtimeAction, rejectInvalidRuntimeResponse,
  rejectMissingBrowserInspection, rejectMissingPostNavigationInspection,
  acceptedAnswersMatchQuestions, HumanNavigationToolParameters,
  AdditionalInfoToolParameters, HumanReviewToolParameters,
} from "./shared.ts";

export function createHumanTools(input: ApplicationAgentRunInput, state: ApplicationSessionState) {
  const requestHumanNavigation = runtimeTool({
    name: "request_human_navigation",
    description: REQUEST_HUMAN_NAVIGATION_DESCRIPTION,
    parameters: HumanNavigationToolParameters,
    allowAfterApproval: true,
    execute: async ({ instruction }, runtimeContext, actionSignal) => {
      if (!runtimeContext.modalRecoveryPending) {
        rejectMissingBrowserInspection(runtimeContext);
      }
      const isSubmissionAction = await claimSubmissionActionIfApproved(state, runtimeContext, actionSignal);
      const response = await runtimeAction(
        runtimeContext,
        { type: "request_human_navigation", instruction },
        actionSignal,
      );
      if (response.type === "cancel") throw new ApplicationAgentCancelled(response.result);
      if (response.type === "interrupted") return INTERRUPTED_ACTION_RESULT;
      if (response.type !== "continue") {
        rejectInvalidRuntimeResponse(runtimeContext, "request_human_navigation");
      }
      if (isSubmissionAction) runtimeContext.submissionOutcomePending = true;
      runtimeContext.modalRecoveryPending = false;
      runtimeContext.browserSnapshotRequired = true;
      runtimeContext.playwrightCliCompleted = false;
      runtimeContext.postNavigationInspectionRequired = true;
      delete runtimeContext.latestScreenshotDataUrl;
      return JSON.stringify(response);
    },
  });

  const requestAdditionalInfo = runtimeTool({
    name: "request_additional_info",
    description: "After a successful browser inspection, fill every visible field supported by current facts except the job narrative fields defined below, and upload the supplied resume when visible. Then ask one bounded batch for remaining visible fields whose facts are unavailable. Supply a stable key and the correct scope for every question; the runtime automatically saves each accepted answer in private user context under that key and scope, so do not separately persist, log, or copy it. For job applications, every application-specific open-ended narrative/free-text prompt—including any short answer, textarea, or why/how/describe prompt—must be included with answer_type \"text\" and scope \"application\" before any fill or type, even when profile context or a saved answer seems usable. Skills fields covered by the job completion policy are deterministic exceptions; batch all currently visible prompts that lack accepted current-session answers. After an accepted current-session answer for the exact question, enter it exactly and do not ask again. A continue or decline without an answer never permits manufactured text. Scope reusable availability globally and job-source or referral facts per application. Use lowercase snake_case question and option IDs, and lowercase dot-separated snake_case keys. Do not use this for browser interaction. Treat a deterministic question as already answered by current facts unless the page conflicts; treat a job narrative question as answered only after its accepted current-session response.",
    parameters: AdditionalInfoToolParameters,
    execute: async ({ questions }, runtimeContext, actionSignal) => {
      rejectMissingBrowserInspection(runtimeContext);
      const response = await runtimeAction(
        runtimeContext,
        { type: "request_additional_info", questions },
        actionSignal,
      );
      if (response.type === "cancel") throw new ApplicationAgentCancelled(response.result);
      if (response.type === "interrupted") return INTERRUPTED_ACTION_RESULT;
      if (response.type === "continue_without_additional_info") {
        return CONTINUE_WITHOUT_ADDITIONAL_INFO_RESULT;
      }
      if (response.type !== "additional_info") {
        rejectInvalidRuntimeResponse(runtimeContext, "request_additional_info");
      }
      if (!acceptedAnswersMatchQuestions(response.answers, questions)) {
        rejectInvalidRuntimeResponse(runtimeContext, "request_additional_info");
      }
      return JSON.stringify(response);
    },
  });

  const requestHumanReview = runtimeTool({
    name: "request_human_review",
    description: input.autoSubmit ? AUTO_SUBMIT_REVIEW_DESCRIPTION : HUMAN_REVIEW_DESCRIPTION,
    parameters: HumanReviewToolParameters,
    execute: async ({ result }, runtimeContext, actionSignal) => {
      rejectMissingBrowserInspection(runtimeContext);
      rejectMissingPostNavigationInspection(runtimeContext);
      const parsedResult = ReviewApplicationResultSchema.safeParse(result);
      if (!parsedResult.success) throw new ApplicationAgentFailure("INVALID_REQUEST");
      const reviewResult = parsedResult.data;
      if (input.autoSubmit && reviewResult.fields_needing_human.length !== 0) {
        throw new ApplicationToolRejection(
          "additional_info_required",
          "Resolve the remaining fields through request_additional_info or human navigation, then request review again. Do not invent answers.",
        );
      }
      const response = await runtimeAction(
        runtimeContext,
        { type: "request_human_review", result: reviewResult },
        actionSignal,
      );
      if (response.type === "interrupted") return INTERRUPTED_ACTION_RESULT;
      if (response.type === "revise" && !input.autoSubmit) {
        return JSON.stringify(response);
      }
      if (response.type === "submit") {
        if (input.autoSubmit) {
          try {
            await runtimeContext.submissionGuard.markReviewReady();
          } catch {
            throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
          }
          actionSignal.throwIfAborted();
        }
        runtimeContext.submissionApproved = true;
        runtimeContext.lastReviewResult = response.result;
        return JSON.stringify({
          ...response,
          next_step: "Hit Submit, then report whether it submitted.",
        });
      }
      if (response.type === "cancel") {
        throw new ApplicationAgentCancelled(response.result);
      }
      if (response.type === "application_mismatch") {
        throw new ApplicationAgentFailure("APPLICATION_MISMATCH");
      }
      rejectInvalidRuntimeResponse(runtimeContext, "request_human_review");
    },
  });
  return { requestHumanNavigation, requestAdditionalInfo, requestHumanReview };
}
