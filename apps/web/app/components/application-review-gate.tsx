"use client";

import { useRef, useState, type FormEvent } from "react";
import type { ApplicationSessionCommand } from "@jobhunter/pipeline/contracts";
import { buildApplicationRevisionCommand } from "../lib/application-review-gate";
import { clipTextToCodePoints } from "../lib/application-text";
import styles from "../run-detail.module.css";

export const SUBMISSION_CONFIRMATION_TITLE = "Submit this application?";
export const SUBMISSION_CONFIRMATION_BODY =
  "This action is irreversible. The application assistant will submit the completed application in the headed browser. Continue only after you have reviewed every field and warning.";

interface MutableSubmissionSent {
  current: boolean;
}

interface SubmissionDialogControl {
  readonly open: boolean;
  close: () => void;
}

interface SubmissionFocusTarget {
  focus: () => void;
}

export function sendSubmitCommandOnce(
  sent: MutableSubmissionSent,
  onCommand: (command: ApplicationSessionCommand) => Promise<void>,
): Promise<void> | undefined {
  if (sent.current) return undefined;
  sent.current = true;
  return onCommand({ type: "submit" });
}

export function dismissSubmissionDialog(
  dialog: SubmissionDialogControl | null,
  opener: SubmissionFocusTarget | null,
): void {
  if (dialog?.open) dialog.close();
  opener?.focus();
}

export function cancelSubmissionDialog(
  event: { preventDefault: () => void },
  dialog: SubmissionDialogControl | null,
  opener: SubmissionFocusTarget | null,
): void {
  event.preventDefault();
  dismissSubmissionDialog(dialog, opener);
}

interface ApplicationReviewGateProps {
  readonly busyAction: ApplicationSessionCommand["type"] | null;
  readonly busy: boolean;
  readonly onCommand: (command: ApplicationSessionCommand) => Promise<void>;
}

export function ApplicationReviewGate({
  busy,
  busyAction,
  onCommand,
}: ApplicationReviewGateProps) {
  const [revisionContext, setRevisionContext] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const submitDialogRef = useRef<HTMLDialogElement>(null);
  const submitOpenerRef = useRef<HTMLButtonElement>(null);
  const submitSentRef = useRef(false);
  const dismissSubmitDialog = () => {
    dismissSubmissionDialog(submitDialogRef.current, submitOpenerRef.current);
  };
  const confirmSubmission = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const request = sendSubmitCommandOnce(submitSentRef, onCommand);
    dismissSubmitDialog();
    if (request) void request;
  };
  const revision = buildApplicationRevisionCommand(revisionContext);

  const submitRevision = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = buildApplicationRevisionCommand(revisionContext);
    if (!result.success) {
      setValidationError(result.message);
      return;
    }
    setValidationError(null);
    await onCommand(result.command);
  };

  return (
    <div className={styles.applicationReviewGate}>
      <div>
        <h3>Review the application</h3>
        <p>Inspect the filled form in the headed browser before deciding what happens next.</p>
      </div>
      <form noValidate onSubmit={(event) => void submitRevision(event)}>
        <label className={styles.workspaceField}>
          <span>Revision instructions</span>
          <textarea
            aria-describedby="application-revision-guidance"
            aria-invalid={validationError ? true : undefined}
            disabled={busy}
            onChange={(event) => {
              setRevisionContext(clipTextToCodePoints(event.currentTarget.value, 20_000));
              setValidationError(null);
            }}
            value={revisionContext}
          />
        </label>
        <p className={styles.workspaceNotice} id="application-revision-guidance">
          Revision guidance is sent only to this browser session and is not saved as profile facts.
        </p>
        {validationError ? <p className={styles.panelError} role="alert">{validationError}</p> : null}
        <button
          className={styles.secondaryButton}
          disabled={busy || !revision.success}
          type="submit"
        >
          {busyAction === "revise" ? "Requesting revision…" : "Request application revision"}
        </button>
      </form>
      <div className={styles.applicationReadyAction}>
        <button
          ref={submitOpenerRef}
          className={styles.primaryButton}
          disabled={busy}
          onClick={(event) => {
            submitSentRef.current = false;
            submitOpenerRef.current = event.currentTarget;
            if (!submitDialogRef.current?.open) submitDialogRef.current?.showModal();
          }}
          type="button"
        >
          {busyAction === "submit" ? "Approving submission…" : "Approve and submit"}
        </button>
      </div>
      <dialog
        ref={submitDialogRef}
        aria-describedby="application-submit-dialog-description"
        aria-labelledby="application-submit-dialog-title"
        className="run-action-dialog"
        onCancel={(event) => {
          cancelSubmissionDialog(event, submitDialogRef.current, submitOpenerRef.current);
        }}
      >
        <form className="run-action-dialog__form" onSubmit={confirmSubmission}>
          <header className="run-action-dialog__header">
            <h2 id="application-submit-dialog-title">{SUBMISSION_CONFIRMATION_TITLE}</h2>
          </header>
          <div className="run-action-dialog__body">
            <p id="application-submit-dialog-description">{SUBMISSION_CONFIRMATION_BODY}</p>
          </div>
          <footer className="run-action-dialog__actions">
            <button
              className="square-control"
              onClick={dismissSubmitDialog}
              type="button"
            >
              Cancel
            </button>
            <button
              className="square-control square-control--primary"
              disabled={busy}
              type="submit"
            >
              Approve and submit
            </button>
          </footer>
        </form>
      </dialog>
    </div>
  );
}
