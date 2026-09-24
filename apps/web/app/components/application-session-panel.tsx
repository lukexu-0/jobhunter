"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { RefreshCw } from "lucide-react";
import {
  ApplicationSessionCommandSchema,
  type ApplicationAnswerSuggestionsResponse,
  type ApplicationProfessionalizeRequest,
  type ApplicationProfessionalizeResponse,
  type ApplicationSessionBridgeState,
  type ApplicationSessionCommand,
  type ApplicationSessionSnapshotDto,
} from "../lib/pipeline-contracts";
import { ApplicationAdditionalInfoForm } from "./application-additional-info-form";
import { ApplicationCredentialsForm } from "./application-credentials-form";
import { ApplicationReviewGate } from "./application-review-gate";
import styles from "../run-detail.module.css";

import {
  canGuideApplicationAgent,
  type ApplicationPanelAction,
  type ApplicationSteerCommand,
  type ApplicationSteeringState,
  type ApplicationDispatchResult,
} from "../lib/application-session";

export interface ApplicationSessionPanelProps {
  readonly snapshot: ApplicationSessionSnapshotDto;
  readonly actionBusy: ApplicationPanelAction | null;
  readonly browserOpenBusy: boolean;
  readonly steeringState: ApplicationSteeringState;
  readonly onCancel: () => Promise<void>;
  readonly onClose: () => Promise<void>;
  readonly onOpenBrowser: () => Promise<void>;
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
  ) => Promise<ApplicationDispatchResult>;
}

const STATE_LABELS: Readonly<Record<ApplicationSessionBridgeState, string>> = {
  reserved: "Preparing browser",
  starting: "Starting browser",
  running: "Applying",
  awaiting_human_navigation: "Waiting for navigation",
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
  close: "Ending session",
  continue: "Continuing application",
  continue_without_additional_info: "Continuing without answers",
  sign_in: "Signing in with credentials",
  save_credentials: "Saving credentials",
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

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().replace("T", " ").replace(".000Z", " UTC");
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
  browserOpenBusy,
  steeringState,
  onCancel,
  onClose,
  onOpenBrowser,
  onRetry,
  onLoadSuggestions,
  onProfessionalize,
  onResume,
  onCommand,
  onSteer,
}: ApplicationSessionPanelProps) {
  const terminal = TERMINAL_STATES.has(snapshot.bridgeState);
  const parked = snapshot.bridgeState === "submitted"
    || snapshot.bridgeState === "submission_uncertain";
  const submissionInProgress = snapshot.submissionPhase === "attempting" || actionBusy === "submit";
  const retryableTerminal = terminal;
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
    snapshot.revisionCount,
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
    && actionBusy !== "save_credentials"
    && actionBusy !== "submit";
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

  const steeringForm = canGuideApplicationAgent(snapshot) ? (
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
  ) : null;

  return (
    <section className={styles.workspaceSection} aria-label="Application">
      <p className={styles.eyebrow}>Application</p>
      {pendingAction ? null : steeringForm}
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
            onClick={() => void onCommand({ type: "continue" })}
            type="button"
          >
            {actionBusy === "continue" ? "Continuing…" : "Continue application"}
          </button>
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
          key={`${snapshot.generation}:${snapshot.revisionCount}`}
          busy={busy || steeringState === "sending"}
          busyAction={commandBusy}
          onCommand={onCommand}
        />
      ) : null}
      {pendingAction ? steeringForm : null}
      {snapshot.error ? <p className={styles.panelError} role="alert">{snapshot.error.message}</p> : null}
      {snapshot.bridgeState === "lost" ? (
        <p className={styles.workspaceNotice} role="status">
          The browser connection was lost. Before retrying, verify whether the application was submitted.
        </p>
      ) : null}
      {snapshot.bridgeState === "submission_uncertain" ? (
        <p className={styles.workspaceNotice}>
          Headed Chrome stays open until {snapshot.expiresAt === null
            ? "you close it"
            : formatTimestamp(snapshot.expiresAt)} so you can inspect the final application state.
        </p>
      ) : null}
      {submissionInProgress ? (
        <p className={styles.workspaceNotice}>
          Cancelling stops the assistant. It cannot undo an application already submitted.
        </p>
      ) : null}

      <div className={styles.workspaceActions}>
        {!terminal ? (
          <button
            className={styles.secondaryButton}
            disabled={
              browserOpenBusy
              || snapshot.bridgeState === "reserved"
              || snapshot.bridgeState === "starting"
            }
            onClick={() => void onOpenBrowser()}
            type="button"
          >
            {browserOpenBusy ? "Opening browser…" : "Open application browser"}
          </button>
        ) : null}
        {snapshot.bridgeState !== "closed" ? (
          <button
            className={styles.secondaryButton}
            disabled={actionBusy === "close" || actionBusy === "retry"}
            onClick={() => void onClose()}
            type="button"
          >
            {actionBusy === "close" ? "Ending…" : "End session"}
          </button>
        ) : null}
        {retryableTerminal ? (
          <button
            className={styles.primaryButton}
            disabled={busy}
            onClick={() => void onRetry()}
            type="button"
          >
            {actionBusy === "retry" ? "Retrying…" : "Retry applying"}
          </button>
        ) : !terminal && !parked ? (
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
              {actionBusy === "cancel" ? "Cancelling…" : submissionInProgress ? "Cancel assistant" : "Cancel application"}
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}
