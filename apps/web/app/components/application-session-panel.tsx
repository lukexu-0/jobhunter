"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { RefreshCw } from "lucide-react";
import {
  ApplicationSessionCommandSchema,
  type ApplicationAnswerSuggestionsResponse,
  type ApplicationProfessionalizeRequest,
  type ApplicationProfessionalizeResponse,
  type ApplicationPendingAction,
  type ApplicationSessionBridgeState,
  type ApplicationSessionCommand,
  type ApplicationSessionSnapshotDto,
} from "@jobhunter/pipeline/contracts";
import { ApplicationAdditionalInfoForm } from "./application-additional-info-form";
import { ApplicationCredentialsForm } from "./application-credentials-form";
import { ApplicationReviewGate } from "./application-review-gate";
import styles from "../run-detail.module.css";

export type ApplicationLifecycleAction = "cancel" | "close" | "resume" | "retry";
export type ApplicationGateCommandType = Exclude<
  ApplicationSessionCommand["type"],
  "steer"
>;
export type ApplicationPanelAction =
  | ApplicationLifecycleAction
  | ApplicationGateCommandType;
export type ApplicationSteerCommand = Extract<
  ApplicationSessionCommand,
  { readonly type: "steer" }
>;
export type ApplicationSteeringState = "idle" | "sending" | "ambiguous";
export type ApplicationSteeringSubmissionResult =
  | { readonly status: "accepted"; readonly current: boolean }
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "ambiguous" };

type SimpleApplicationPendingAction = Extract<
  ApplicationPendingAction,
  { readonly type: "human_navigation" }
>;

export interface ApplicationSessionPanelProps {
  readonly snapshot: ApplicationSessionSnapshotDto;
  readonly actionBusy: ApplicationPanelAction | null;
  readonly steeringState: ApplicationSteeringState;
  readonly onCancel: () => Promise<void>;
  readonly onClose: () => Promise<void>;
  readonly onRetry: () => Promise<void>;
  readonly onLoadSuggestions: (
    questionId: string,
    signal: AbortSignal,
  ) => Promise<ApplicationAnswerSuggestionsResponse>;
  readonly onProfessionalize: (
    questionId: string,
    request: ApplicationProfessionalizeRequest,
    signal: AbortSignal,
  ) => Promise<ApplicationProfessionalizeResponse>;
  readonly onResume: () => Promise<void>;
  readonly onCommand: (command: ApplicationSessionCommand) => Promise<void>;
  readonly onSteer: (
    command: ApplicationSteerCommand,
  ) => Promise<ApplicationSteeringSubmissionResult>;
}

const STATE_LABELS: Readonly<Record<ApplicationSessionBridgeState, string>> = {
  reserved: "Preparing browser",
  starting: "Starting browser",
  running: "Applying",
  awaiting_human_navigation: "Waiting for navigation",
  awaiting_origin_approval: "Waiting for origin approval",
  awaiting_additional_info: "Waiting for additional information",
  awaiting_human_review: "Waiting for application review",
  submitting: "Submitting application",
  submitted: "Application submitted",
  submission_uncertain: "Submission could not be verified",
  cancelled: "Cancelled",
  failed: "Failed",
  closed: "Closed",
  lost: "Connection lost",
};

const ACTION_STATUS_LABELS: Readonly<Record<ApplicationPanelAction, string>> = {
  resume: "Starting application",
  retry: "Retrying application",
  cancel: "Cancelling application",
  close: "Closing browser",
  continue: "Continuing application",
  continue_without_additional_info: "Continuing without answers",
  sign_in: "Signing in with credentials",
  save_credentials: "Saving credentials",
  approve_origin: "Approving origin",
  provide_additional_info: "Answering questions",
  revise: "Requesting application revision",
  submit: "Approving submission",
};

const TERMINAL_STATES = new Set<ApplicationSessionBridgeState>([
  "cancelled",
  "failed",
  "closed",
  "lost",
]);
const STEERABLE_APPLICATION_STATES = new Set<ApplicationSessionBridgeState>([
  "running",
  "awaiting_human_navigation",
  "awaiting_additional_info",
  "awaiting_human_review",
]);

export function canGuideApplicationAgent(
  snapshot: ApplicationSessionSnapshotDto,
): boolean {
  return STEERABLE_APPLICATION_STATES.has(snapshot.bridgeState)
    && snapshot.submissionPhase === "not_attempted"
    && snapshot.terminalAt === null;
}


function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

export function simpleApplicationGateCommand(
  _action: SimpleApplicationPendingAction,
): ApplicationSessionCommand {
  return { type: "continue" };
}

const INVALID_STEERING_MESSAGE =
  "Enter guidance between 1 and 8,000 Unicode characters without null characters.";
export const AMBIGUOUS_STEERING_MESSAGE =
  "Guidance delivery could not be confirmed. Do not send it again until the application state changes.";
export const STEERING_SUCCESS_MESSAGE =
  "Guidance queued for the next agent step.";
export const STEERING_STATE_CHANGED_MESSAGE =
  "Guidance was queued, but the application state changed. Use the current action to continue.";
export const RETRY_CURRENT_GUIDANCE = "Retry the current action.";
export const RETRY_CURRENT_SUCCESS_MESSAGE =
  "Retry guidance queued for the next agent step.";

export type ApplicationSteerCommandResult =
  | { readonly success: true; readonly command: ApplicationSteerCommand }
  | { readonly success: false; readonly message: string };

export function buildApplicationSteerCommand(
  message: string,
): ApplicationSteerCommandResult {
  const parsed = ApplicationSessionCommandSchema.safeParse({
    type: "steer",
    message,
  });
  if (parsed.success && parsed.data.type === "steer") {
    return { success: true, command: parsed.data };
  }
  return { success: false, message: INVALID_STEERING_MESSAGE };
}

function ApplicationSteeringForm({
  deliveryError,
  deliveryStatus,
  disabled,
  draft,
  onChange,
  onSubmit,
  onRetry,
  steeringState,
  validationError,
}: {
  readonly deliveryError: string | null;
  readonly deliveryStatus: string | null;
  readonly disabled: boolean;
  readonly draft: string;
  readonly onChange: (value: string) => void;
  readonly onRetry: () => Promise<void>;
  readonly onSubmit: () => Promise<void>;
  readonly steeringState: ApplicationSteeringState;
  readonly validationError: string | null;
}) {
  const error = validationError
    ?? deliveryError
    ?? (steeringState === "ambiguous" ? AMBIGUOUS_STEERING_MESSAGE : null);
  const errorId = "application-steering-error";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit();
  };

  return (
    <form
      aria-label="Steer the agent"
      className={styles.applicationSteeringForm}
      noValidate
      onSubmit={submit}
    >
      <label className={styles.workspaceField} htmlFor="application-steering-message">
        <span>Steer the agent</span>
        <textarea
          aria-describedby={error ? errorId : undefined}
          aria-label="Steer the agent"
          aria-invalid={error ? true : undefined}
          disabled={disabled}
          id="application-steering-message"
          name="message"
          onChange={(event) => onChange(event.currentTarget.value)}
          required
          value={draft}
        />
      </label>
      {error ? (
        <p className={styles.panelError} id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.applicationSteeringActions}>
        <button className={styles.secondaryButton} disabled={disabled} type="submit">
          {steeringState === "sending" ? "Sending guidance…" : "Send guidance"}
        </button>
        <button
          aria-label="Retry current action"
          className={`square-control ${styles.applicationSteeringRetry}`}
          disabled={disabled}
          onClick={() => void onRetry()}
          title="Retry current action"
          type="button"
        >
          <RefreshCw aria-hidden="true" size={18} />
        </button>
      </div>
      <p
        aria-atomic="true"
        aria-live="polite"
        className={styles.applicationSteeringStatus}
        role="status"
      >
        {deliveryStatus}
      </p>
    </form>
  );
}

export function ApplicationSessionPanel({
  snapshot,
  actionBusy,
  steeringState,
  onCancel,
  onClose,
  onRetry,
  onLoadSuggestions,
  onProfessionalize,
  onResume,
  onCommand,
  onSteer,
}: ApplicationSessionPanelProps) {
  const terminal = TERMINAL_STATES.has(snapshot.bridgeState);
  const finalSubmission = snapshot.submissionPhase === "submitted"
    || snapshot.submissionPhase === "uncertain";
  const parked = snapshot.bridgeState === "submitted"
    || snapshot.bridgeState === "submission_uncertain";
  const submitting = snapshot.bridgeState === "submitting";
  const retryableTerminal = terminal && !finalSubmission;
  const busy = actionBusy !== null;
  const [steeringDraft, setSteeringDraft] = useState("");
  const [steeringValidationError, setSteeringValidationError] =
    useState<string | null>(null);
  const [steeringDeliveryError, setSteeringDeliveryError] =
    useState<string | null>(null);
  const [steeringDeliveryStatus, setSteeringDeliveryStatus] =
    useState<string | null>(null);
  const steeringSubmissionPendingRef = useRef<symbol | null>(null);
  const steeringSnapshotIdentity = [
    snapshot.generation,
    snapshot.bridgeState,
    JSON.stringify(snapshot.pendingAction),
    snapshot.submissionPhase,
    snapshot.terminalAt,
  ].join(":");
  const currentSteeringSnapshotIdentityRef = useRef(
    steeringSnapshotIdentity,
  );
  currentSteeringSnapshotIdentityRef.current = steeringSnapshotIdentity;
  const previousSteeringSnapshotIdentityRef = useRef(
    steeringSnapshotIdentity,
  );
  useEffect(() => {
    if (
      previousSteeringSnapshotIdentityRef.current
      === steeringSnapshotIdentity
    ) return;
    previousSteeringSnapshotIdentityRef.current = steeringSnapshotIdentity;
    setSteeringDraft("");
    setSteeringValidationError(null);
    steeringSubmissionPendingRef.current = null;
    setSteeringDeliveryError(null);
    setSteeringDeliveryStatus(null);
  }, [steeringSnapshotIdentity]);
  useEffect(() => () => {
    steeringSubmissionPendingRef.current = null;
  }, []);
  const steeringDisabled = busy || steeringState !== "idle";
  const submitSteering = async (
    message = steeringDraft,
    clearDraft = true,
  ): Promise<void> => {
    if (steeringDisabled || steeringSubmissionPendingRef.current !== null) return;
    const result = buildApplicationSteerCommand(message);
    if (!result.success) {
      setSteeringValidationError(result.message);
      setSteeringDeliveryError(null);
      setSteeringDeliveryStatus(null);
      return;
    }
    setSteeringValidationError(null);
    setSteeringDeliveryError(null);
    setSteeringDeliveryStatus(null);
    const submissionToken = Symbol();
    steeringSubmissionPendingRef.current = submissionToken;
    const submittedSnapshotIdentity = steeringSnapshotIdentity;
    try {
      const submission = await onSteer(result.command);
      if (steeringSubmissionPendingRef.current !== submissionToken) return;
      const stateIsCurrent =
        currentSteeringSnapshotIdentityRef.current === submittedSnapshotIdentity;
      if (submission.status === "accepted") {
        if (clearDraft) setSteeringDraft("");
        const acceptedCurrent = stateIsCurrent && submission.current;
        setSteeringDeliveryStatus(
          acceptedCurrent
            ? clearDraft
              ? STEERING_SUCCESS_MESSAGE
              : RETRY_CURRENT_SUCCESS_MESSAGE
            : STEERING_STATE_CHANGED_MESSAGE,
        );
      } else {
        if (!stateIsCurrent) return;
        if (submission.status === "rejected") {
          setSteeringDeliveryError(submission.message);
        } else {
          setSteeringDeliveryError(AMBIGUOUS_STEERING_MESSAGE);
        }
      }
    } finally {
      if (steeringSubmissionPendingRef.current === submissionToken) {
        steeringSubmissionPendingRef.current = null;
      }
    }
  };
  const cancelDisabled = busy
    && actionBusy !== "sign_in"
    && actionBusy !== "save_credentials";
  const pendingAction = snapshot.pendingAction;
  const commandBusy =
    actionBusy === "close" || actionBusy === "resume" || actionBusy === "retry"
      ? null
      : actionBusy;
  const baseStateLabel = pendingAction?.type === "credentials"
    ? "Waiting for credentials"
    : STATE_LABELS[snapshot.bridgeState];
  const stateLabel = actionBusy
    ? `${baseStateLabel} — ${ACTION_STATUS_LABELS[actionBusy]}`
    : baseStateLabel;

  return (
    <section className={styles.workspaceSection} aria-label="Application">
      <p className={styles.eyebrow}>Application</p>
      {canGuideApplicationAgent(snapshot) ? (
        <ApplicationSteeringForm
          deliveryError={steeringDeliveryError}
          deliveryStatus={steeringDeliveryStatus}
          disabled={steeringDisabled}
          draft={steeringDraft}
          onChange={(value) => {
            setSteeringDraft(value);
            setSteeringValidationError(null);
            setSteeringDeliveryError(null);
            setSteeringDeliveryStatus(null);
          }}
          onSubmit={() => submitSteering()}
          onRetry={() => submitSteering(
            RETRY_CURRENT_GUIDANCE,
            false,
          )}
          steeringState={steeringState}
          validationError={steeringValidationError}
        />
      ) : null}
      <p
        aria-atomic="true"
        aria-live="polite"
        className={styles.applicationSessionState}
        role="status"
      >
        {stateLabel}
      </p>

      {snapshot.warnings.length > 0 ? (
        <div
          aria-label="Application warnings"
          className={styles.applicationWarningAlert}
          role="alert"
        >
          {snapshot.warnings.length === 1 ? (
            snapshot.warnings[0]
          ) : (
            <ul className={styles.applicationWarningList}>
              {snapshot.warnings.map((warning, index) => (
                <li key={`${index}:${warning}`}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {pendingAction?.type === "credentials" ? (
        <ApplicationCredentialsForm
          key={`${snapshot.generation}:credentials`}
          busy={busy || steeringState === "sending"}
          busyAction={commandBusy}
          onSubmit={onCommand}
        />
      ) : pendingAction?.type === "human_navigation" ? (
        <div className={styles.applicationGate}>
          <h3>Navigation needed</h3>
          <p>{pendingAction.instruction}</p>
          <button
            className={styles.primaryButton}
            disabled={busy || steeringState === "sending"}
            onClick={() => void onCommand(simpleApplicationGateCommand(pendingAction))}
            type="button"
          >
            {actionBusy === "continue" ? "Continuing…" : "Continue application"}
          </button>
        </div>
      ) : pendingAction?.type === "origin_approval" ? (
        <div className={styles.applicationGate}>
          <h3>Restart required</h3>
          <p>
            This session was created by an older browser harness that required
            manual origin approval. Cancel or close it, then retry the application.
          </p>
          <code>{pendingAction.origin}</code>
        </div>
      ) : pendingAction?.type === "additional_info" ? (
        <ApplicationAdditionalInfoForm
          key={`${snapshot.generation}:${JSON.stringify(pendingAction.questions)}`}
          busy={busy || steeringState === "sending"}
          continuing={actionBusy === "continue_without_additional_info"}
          onLoadSuggestions={onLoadSuggestions}
          onProfessionalize={onProfessionalize}
          onContinue={() =>
            onCommand({ type: "continue_without_additional_info" })}
          onSubmit={onCommand}
          questions={pendingAction.questions}
          submitting={actionBusy === "provide_additional_info"}
        />
      ) : pendingAction?.type === "human_review" ? (
        <ApplicationReviewGate
          busy={busy || steeringState === "sending"}
          busyAction={commandBusy}
          onCommand={onCommand}
        />
      ) : null}
      {snapshot.error ? <p className={styles.panelError} role="alert">{snapshot.error.message}</p> : null}
      {snapshot.bridgeState === "lost" ? (
        <p className={styles.workspaceNotice} role="status">
          The browser connection was lost. Before retrying, verify whether the application was submitted.
        </p>
      ) : null}
      {parked ? (
        <p className={styles.workspaceNotice}>
          Headed Chrome stays open until {snapshot.expiresAt === null
            ? "the browser session expires"
            : formatTimestamp(snapshot.expiresAt)} so you can inspect the final application state.
        </p>
      ) : null}

      <div className={styles.workspaceActions}>
        {parked ? (
          <button
            className={styles.secondaryButton}
            disabled={busy}
            onClick={() => void onClose()}
            type="button"
          >
            {actionBusy === "close" ? "Closing…" : "Close browser"}
          </button>
        ) : retryableTerminal ? (
          <button
            className={styles.primaryButton}
            disabled={busy}
            onClick={() => void onRetry()}
            type="button"
          >
            {actionBusy === "retry" ? "Retrying…" : "Retry applying"}
          </button>
        ) : !terminal && !submitting ? (
          <>
            {snapshot.bridgeState === "reserved" ? (
              <button
                className={styles.primaryButton}
                disabled={busy}
                onClick={() => void onResume()}
                type="button"
              >
                {actionBusy === "resume" ? "Starting…" : "Start applying"}
              </button>
            ) : null}
            <button
              className={styles.secondaryButton}
              disabled={cancelDisabled}
              onClick={() => void onCancel()}
              type="button"
            >
              {actionBusy === "cancel" ? "Cancelling…" : "Cancel application"}
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}
