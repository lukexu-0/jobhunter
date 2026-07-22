"use client";

import type {
  ApplicationFieldResult,
  ApplicationPendingAction,
  ApplicationSessionBridgeState,
  ApplicationSessionCommand,
  ApplicationSessionSnapshotDto,
} from "@jobhunter/pipeline/contracts";
import { ApplicationAdditionalInfoForm } from "./application-additional-info-form";
import { ApplicationReviewGate } from "./application-review-gate";
import styles from "../run-detail.module.css";

export type ApplicationLifecycleAction = "cancel" | "close" | "resume" | "retry";
export type ApplicationPanelAction =
  | ApplicationLifecycleAction
  | ApplicationSessionCommand["type"];

type SimpleApplicationPendingAction = Extract<
  ApplicationPendingAction,
  { readonly type: "human_navigation" | "origin_approval" }
>;

export interface ApplicationSessionPanelProps {
  readonly snapshot: ApplicationSessionSnapshotDto;
  readonly actionBusy: ApplicationPanelAction | null;
  readonly onCancel: () => Promise<void>;
  readonly onClose: () => Promise<void>;
  readonly onRetry: () => Promise<void>;
  readonly onResume: () => Promise<void>;
  readonly onCommand: (command: ApplicationSessionCommand) => Promise<void>;
}

const STATE_LABELS: Readonly<Record<ApplicationSessionBridgeState, string>> = {
  reserved: "Preparing browser",
  starting: "Starting browser",
  running: "Applying",
  awaiting_human_navigation: "Waiting for navigation",
  awaiting_origin_approval: "Waiting for origin approval",
  awaiting_additional_info: "Waiting for additional information",
  awaiting_human_review: "Waiting for application review",
  ready_for_human_submit: "Ready for human submission",
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
  approve_origin: "Approving origin",
  provide_additional_info: "Answering questions",
  revise: "Requesting application revision",
  ready: "Marking application ready",
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
  action: SimpleApplicationPendingAction,
): ApplicationSessionCommand {
  return action.type === "human_navigation"
    ? { type: "continue" }
    : { type: "approve_origin", origin: action.origin };
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
  onCancel,
  onClose,
  onRetry,
  onResume,
  onCommand,
}: ApplicationSessionPanelProps) {
  const terminal = TERMINAL_STATES.has(snapshot.bridgeState);
  const ready = snapshot.bridgeState === "ready_for_human_submit";
  const busy = actionBusy !== null;
  const pendingAction = snapshot.pendingAction;
  const commandBusy =
    actionBusy === "close" || actionBusy === "resume" || actionBusy === "retry"
      ? null
      : actionBusy;
  const stateLabel = actionBusy
    ? `${STATE_LABELS[snapshot.bridgeState]} — ${ACTION_STATUS_LABELS[actionBusy]}`
    : STATE_LABELS[snapshot.bridgeState];

  return (
    <section className={styles.workspaceSection} aria-labelledby="application-session-heading">
      <p className={styles.eyebrow}>Application</p>
      <h2 id="application-session-heading">Application assistant</h2>
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

      {pendingAction?.type === "human_navigation" ? (
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
          <h3>Approve a new site</h3>
          <p>The application flow needs permission to continue on this exact origin:</p>
          <code>{pendingAction.origin}</code>
          <button
            className={styles.primaryButton}
            disabled={busy}
            onClick={() => void onCommand(simpleApplicationGateCommand(pendingAction))}
            type="button"
          >
            {actionBusy === "approve_origin" ? "Approving…" : "Approve origin"}
          </button>
        </div>
      ) : pendingAction?.type === "additional_info" ? (
        <ApplicationAdditionalInfoForm
          key={`${snapshot.generation}:${JSON.stringify(pendingAction.questions)}`}
          busy={busy}
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
      {ready ? (
        <p className={styles.workspaceNotice}>
          Headed Chrome stays open until {snapshot.expiresAt === null
            ? "the browser session expires"
            : formatTimestamp(snapshot.expiresAt)} so you can inspect and submit the application yourself.
        </p>
      ) : null}

      <div className={styles.workspaceActions}>
        {!terminal && !ready ? (
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
              disabled={busy}
              onClick={() => void onCancel()}
              type="button"
            >
              {actionBusy === "cancel" ? "Cancelling…" : "Cancel application"}
            </button>
          </>
        ) : terminal ? (
          <button
            className={styles.primaryButton}
            disabled={busy}
            onClick={() => void onRetry()}
            type="button"
          >
            {actionBusy === "retry" ? "Retrying…" : "Retry applying"}
          </button>
        ) : (
          <button
            className={styles.secondaryButton}
            disabled={busy}
            onClick={() => void onClose()}
            type="button"
          >
            {actionBusy === "close" ? "Closing…" : "Close browser"}
          </button>
        )}
      </div>
    </section>
  );
}
