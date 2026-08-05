"use client";

import { useRef, useState, type FormEvent } from "react";
import {
  ApplicationSessionCommandSchema,
  type ApplicationAnswerSuggestionsResponse,
  type ApplicationProfessionalizeRequest,
  type ApplicationProfessionalizeResponse,
  type ApplicationFieldResult,
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
  | { readonly status: "accepted" }
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
  actionBusy,
  steeringState,
  onSteer,
}: {
  readonly actionBusy: boolean;
  readonly steeringState: ApplicationSteeringState;
  readonly onSteer: (
    command: ApplicationSteerCommand,
  ) => Promise<ApplicationSteeringSubmissionResult>;
}) {
  const [draft, setDraft] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [deliveryStatus, setDeliveryStatus] = useState<string | null>(null);
  const submissionPendingRef = useRef(false);
  const disabled = actionBusy || steeringState !== "idle";
  const error = validationError
    ?? deliveryError
    ?? (steeringState === "ambiguous" ? AMBIGUOUS_STEERING_MESSAGE : null);
  const descriptionId = "application-steering-guidance";
  const errorId = "application-steering-error";
  const describedBy = error ? `${descriptionId} ${errorId}` : descriptionId;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || submissionPendingRef.current) return;
    const result = buildApplicationSteerCommand(draft);
    if (!result.success) {
      setValidationError(result.message);
      setDeliveryError(null);
      setDeliveryStatus(null);
      return;
    }

    setValidationError(null);
    setDeliveryError(null);
    setDeliveryStatus(null);
    submissionPendingRef.current = true;
    try {
      const submission = await onSteer(result.command);
      if (submission.status === "accepted") {
        setDraft("");
        setDeliveryStatus(STEERING_SUCCESS_MESSAGE);
      } else if (submission.status === "rejected") {
        setDeliveryError(submission.message);
      } else {
        setDeliveryError(AMBIGUOUS_STEERING_MESSAGE);
      }
    } finally {
      submissionPendingRef.current = false;
    }
  };

  return (
    <form
      aria-labelledby="application-steering-heading"
      className={styles.applicationSteeringForm}
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <div className={styles.applicationSteeringIntro}>
        <h3 id="application-steering-heading">Guide the application agent</h3>
        <p id={descriptionId}>
          Delivered once before the next agent step. Guidance is not saved to
          your profile or application facts.
        </p>
      </div>
      <label className={styles.workspaceField} htmlFor="application-steering-message">
        <span>Operator guidance</span>
        <textarea
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          disabled={disabled}
          id="application-steering-message"
          name="message"
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setValidationError(null);
            setDeliveryError(null);
            setDeliveryStatus(null);
          }}
          required
          value={draft}
        />
      </label>
      {error ? (
        <p className={styles.panelError} id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      <button className={styles.secondaryButton} disabled={disabled} type="submit">
        {steeringState === "sending" ? "Sending guidance…" : "Send guidance"}
      </button>
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

function FieldList({ fields }: { readonly fields: readonly ApplicationFieldResult[] }) {
  if (fields.length === 0) return <p>None reported.</p>;
  return (
    <ul className={styles.applicationList}>
      {fields.map((field, index) => (
        <li key={`${field.label}-${index}`}>
          <span>{field.label}</span>
          {field.note ? <span className={styles.applicationListNote}> — {field.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function TextList({ values }: { readonly values: readonly string[] }) {
  if (values.length === 0) return <p>None reported.</p>;
  return (
    <ul className={styles.applicationList}>
      {values.map((value, index) => <li key={`${value}-${index}`}>{value}</li>)}
    </ul>
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
      <p
        aria-atomic="true"
        aria-live="polite"
        className={styles.applicationSessionState}
        role="status"
      >
        {stateLabel}
      </p>

      <dl className={styles.metadataGrid}>
        <div>
          <dt>Company</dt>
          <dd>{snapshot.company || "Not identified"}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{snapshot.role || "Not identified"}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd><time dateTime={new Date(snapshot.createdAt).toISOString()}>{formatTimestamp(snapshot.createdAt)}</time></dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd><time dateTime={new Date(snapshot.updatedAt).toISOString()}>{formatTimestamp(snapshot.updatedAt)}</time></dd>
        </div>
        {snapshot.expiresAt !== null ? (
          <div>
            <dt>Browser expires</dt>
            <dd><time dateTime={new Date(snapshot.expiresAt).toISOString()}>{formatTimestamp(snapshot.expiresAt)}</time></dd>
          </div>
        ) : null}
        <div>
          <dt>Application revisions</dt>
          <dd>{snapshot.revisionCount}</dd>
        </div>
      </dl>

      <div className={styles.applicationSummary}>
        <div>
          <h3>Fields filled</h3>
          <FieldList fields={snapshot.fieldsFilled} />
        </div>
        <div>
          <h3>Fields needing you</h3>
          <FieldList fields={snapshot.fieldsNeedingHuman} />
        </div>
        <div>
          <h3>Files attached</h3>
          <TextList values={snapshot.filesAttached} />
        </div>
        <div>
          <h3>Warnings</h3>
          <TextList values={snapshot.warnings} />
        </div>
      </div>

      {snapshot.bridgeState === "running" ? (
        <ApplicationSteeringForm
          actionBusy={busy}
          onSteer={onSteer}
          steeringState={steeringState}
        />
      ) : null}

      {pendingAction?.type === "credentials" ? (
        <ApplicationCredentialsForm
          key={`${snapshot.generation}:credentials`}
          busy={busy}
          busyAction={commandBusy}
          onSubmit={onCommand}
        />
      ) : pendingAction?.type === "human_navigation" ? (
        <div className={styles.applicationGate}>
          <h3>Navigation needed</h3>
          <p>{pendingAction.instruction}</p>
          <button
            className={styles.primaryButton}
            disabled={busy}
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
          busy={busy}
          onLoadSuggestions={onLoadSuggestions}
          onProfessionalize={onProfessionalize}
          onSubmit={onCommand}
          questions={pendingAction.questions}
          submitting={actionBusy === "provide_additional_info"}
        />
      ) : pendingAction?.type === "human_review" ? (
        <ApplicationReviewGate
          busy={busy}
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
