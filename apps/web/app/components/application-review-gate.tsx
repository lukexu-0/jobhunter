"use client";

import { useState, type FormEvent } from "react";
import type { ApplicationSessionCommand } from "@jobhunter/pipeline/contracts";
import { buildApplicationRevisionCommand } from "../lib/application-review-gate";
import styles from "../run-detail.module.css";

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
            maxLength={40_000}
            onChange={(event) => {
              setRevisionContext(event.currentTarget.value);
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
          className={styles.primaryButton}
          disabled={busy}
          onClick={() => void onCommand({ type: "ready" })}
          type="button"
        >
          {busyAction === "ready" ? "Marking ready…" : "Ready for human submit"}
        </button>
        <p>You remain responsible for the final submission. This action never presses submit.</p>
      </div>
    </div>
  );
}
