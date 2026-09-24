import { PlaywrightCliToolParametersSchema, isPlaywrightCliReadOnlyCommand, ApplicationRuntimeError, type RuntimeActionResponse } from "../../../application/application-runtime-client.ts";
import { boundedJson } from "../../../application/agent-runtime/runner.ts";
import { ApplicationAgentFailure, ApplicationToolRejection } from "../../../application/agent-runtime/contracts/application.ts";
import { MODAL_RECOVERY_INSTRUCTION, MODAL_DIALOG_DISMISS_INSTRUCTION, MODAL_HUMAN_RECOVERY_INSTRUCTION } from "../../instructions/application.ts";
import { claimSubmissionActionIfApproved, type ApplicationSessionState } from "../../../application/agent-runtime/session/application.ts";
import { runtimeTool, runtimeAction, rejectInvalidRuntimeResponse } from "../shared.ts";
import { PLAYWRIGHT_CLI_DESCRIPTION } from "./reference.ts";

const MAX_BROWSER_TOOL_OUTPUT_BYTES = 512 * 1024;

export function createBrowserTool(state: ApplicationSessionState) {
  const playwrightCli = runtimeTool({
    name: "playwright_cli",
    description: PLAYWRIGHT_CLI_DESCRIPTION,
    parameters: PlaywrightCliToolParametersSchema,
    allowAfterApproval: true,
    execute: async ({ command, args }, runtimeContext, actionSignal) => {
      const recoveringModal = runtimeContext.modalRecoveryPending
        && (command === "upload" || command === "dialog-dismiss");
      if (
        runtimeContext.browserSnapshotRequired
        && command !== "snapshot"
        && !runtimeContext.modalRecoveryPending
      ) {
        throw new ApplicationToolRejection(
          "inspection_required",
          "Run snapshot successfully after the failed browser command before taking another browser action. Do not replay an action whose effect is unknown.",
        );
      }
      runtimeContext.playwrightCliCompleted = false;
      delete runtimeContext.latestSubmissionExecution;
      const isSubmissionAction = !isPlaywrightCliReadOnlyCommand(command)
        && await claimSubmissionActionIfApproved(state, runtimeContext, actionSignal);
      if (isSubmissionAction) runtimeContext.submissionOutcomePending = true;

      let response: RuntimeActionResponse;
      try {
        response = await runtimeAction(
          runtimeContext,
          { type: "playwright_cli", command, args },
          actionSignal,
        );
      } catch (error) {
        actionSignal.throwIfAborted();
        if (
          !(error instanceof ApplicationAgentFailure)
          || error.code !== "BROWSER_FAILED"
          || !(error.cause instanceof ApplicationRuntimeError)
          || error.cause.code !== "browser_failed"
        ) {
          throw error;
        }
        delete runtimeContext.latestScreenshotDataUrl;
        runtimeContext.browserSnapshotRequired = true;
        throw new ApplicationToolRejection(
          "browser_failed",
          "Browser control or inspection failed; its effect is unknown. The session remains active. Run snapshot successfully before another browser action. If snapshot fails, retry snapshot. Do not replay an action whose effect is unknown. After submission approval, a timeout is not evidence of No; inspect the page before reporting an outcome.",
        );
      }
      if (response.type !== "playwright_cli_result") {
        rejectInvalidRuntimeResponse(runtimeContext, "playwright_cli");
      }
      if (response.cli_error_category === "modal_blocked") {
        delete runtimeContext.latestScreenshotDataUrl;
        runtimeContext.modalRecoveryPending = true;
        runtimeContext.browserSnapshotRequired = true;
        throw new ApplicationToolRejection(
          "modal_recovery_required",
          MODAL_RECOVERY_INSTRUCTION,
        );
      }
      if (
        response.cli_error_category === "modal_handler_mismatch"
        && runtimeContext.modalRecoveryPending
      ) {
        delete runtimeContext.latestScreenshotDataUrl;
        runtimeContext.browserSnapshotRequired = true;
        const uploadHandlerMismatch = command === "upload";
        throw new ApplicationToolRejection(
          uploadHandlerMismatch
            ? "modal_recovery_required"
            : "human_navigation_required",
          uploadHandlerMismatch
            ? MODAL_DIALOG_DISMISS_INSTRUCTION
            : MODAL_HUMAN_RECOVERY_INSTRUCTION,
        );
      }
      if (runtimeContext.submissionApproved && response.exit_code === 0) {
        runtimeContext.latestSubmissionExecution = response;
      }
      const { screenshot, ...observation } = response.observation;
      if (response.exit_code !== 0 || screenshot === null) {
        delete runtimeContext.latestScreenshotDataUrl;
      } else {
        runtimeContext.latestScreenshotDataUrl = `data:image/png;base64,${screenshot.data}`;
      }
      try {
        const output = boundedJson(
          { ...response, observation },
          "Playwright CLI result",
          MAX_BROWSER_TOOL_OUTPUT_BYTES,
        );
        if (response.exit_code === 0) {
          runtimeContext.playwrightCliCompleted = true;
          runtimeContext.postNavigationInspectionRequired = false;
          if (recoveringModal) {
            runtimeContext.modalRecoveryPending = false;
          }
          if (command === "snapshot") {
            runtimeContext.browserSnapshotRequired = false;
          }
        } else {
          runtimeContext.browserSnapshotRequired = true;
        }
        return output;
      } catch {
        delete runtimeContext.latestScreenshotDataUrl;
        runtimeContext.playwrightCliCompleted = false;
        runtimeContext.browserSnapshotRequired = true;
        throw new ApplicationToolRejection(
          "invalid_response",
          "The browser result was too large or invalid and was discarded. Continue by taking a fresh snapshot; do not replay an action whose effect is unknown.",
        );
      }
    },
  });
  return playwrightCli;
}
