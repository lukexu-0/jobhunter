"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import type {
  ApplicationSessionView,
  ApplicationSessionCommand,
  ApplicationSessionSnapshotDto,
  ResumeIterationDto,
  RunDto,
} from "@jobhunter/pipeline/contracts";
import {
  ApplicationSessionPanel,
  type ApplicationLifecycleAction,
} from "./application-session-panel";
import {
  APPLICATION_SESSION_EVENT_NAMES,
  parseApplicationSessionStreamEvent,
} from "../lib/application-session-stream";
import {
  PipelineClientError,
  applicationEventsHref,
  closeApplicationSession,
  getApplicationSession,
  retryApplicationSession,
  sendApplicationCommand,
  startApplicationSession,
} from "../lib/pipeline-client";
import type { ResumeIterationSelection } from "../lib/run-detail-artifacts";
import styles from "../run-detail.module.css";

const MAX_PUBLIC_MESSAGE_LENGTH = 240;

type ReviewDialog = "edit" | "regenerate" | null;
type ReviewBusyAction = "retry" | "edit" | "regenerate" | "approve" | null;
type ApplicationStreamState = "idle" | "connecting" | "connected" | "reconnecting" | "invalid";

export interface RunReviewWorkspaceProps {
  readonly run: RunDto;
  readonly artifactState: "retained" | "pruned";
  readonly iterations: readonly ResumeIterationDto[];
  readonly selectedIteration: ResumeIterationDto | undefined;
  readonly selection: ResumeIterationSelection;
  readonly isLoadingIterations: boolean;
  readonly iterationError: string | null;
  readonly isFresh: boolean;
  readonly busyAction: ReviewBusyAction;
  readonly onSelectIteration: (revision: number) => void;
  readonly onViewLatest: () => void;
  readonly onEdit: (comments: string) => Promise<RunDto>;
  readonly onRegenerate: () => Promise<RunDto>;
  readonly onApprove: (acknowledgeVisualIssues: boolean) => Promise<RunDto>;
}

export function resumeIterationLabel(iteration: ResumeIterationDto): string {
  const origin = iteration.origin === "initial"
    ? "Initial"
    : iteration.origin === "machine-regeneration"
      ? "Regenerated"
      : "Requested edit";
  return `Iteration ${iteration.revision} — ${origin}`;
}

function publicMessage(error: unknown, fallback: string): string {
  if (!(error instanceof PipelineClientError)) return fallback;
  return error.message.trim().slice(0, MAX_PUBLIC_MESSAGE_LENGTH) || fallback;
}

function blockedReasonMessage(reason: string | undefined): string | null {
  if (reason === "legacy_job_url_unavailable") {
    return "This older run does not have a saved job URL, so automatic application is unavailable.";
  }
  if (reason === "job_url_requires_https") {
    return "Automatic application requires an HTTPS job URL.";
  }
  if (reason === "resume_not_approved") {
    return "Approve the resume before starting the application assistant.";
  }
  if (reason === "artifacts_pruned") {
    return "Automatic application is unavailable because the resume files were removed by retention.";
  }
  if (reason === "harness_unconfigured") {
    return "The local browser application service is not configured.";
  }
  if (reason === "profile_unavailable") {
    return "The applicant profile is unavailable or invalid.";
  }
  return null;
}

function applicationSnapshot(
  view: ApplicationSessionView | null,
): ApplicationSessionSnapshotDto | null {
  return view && !("state" in view) ? view : null;
}

function isLiveApplicationSnapshot(snapshot: ApplicationSessionSnapshotDto): boolean {
  return snapshot.bridgeState !== "cancelled"
    && snapshot.bridgeState !== "failed"
    && snapshot.bridgeState !== "closed"
    && snapshot.bridgeState !== "lost";
}

export function RunReviewWorkspace({
  run,
  artifactState,
  iterations,
  selectedIteration,
  selection,
  isLoadingIterations,
  iterationError,
  isFresh,
  busyAction,
  onSelectIteration,
  onViewLatest,
  onEdit,
  onRegenerate,
  onApprove,
}: RunReviewWorkspaceProps) {
  const [reviewDialog, setReviewDialog] = useState<ReviewDialog>(null);
  const [editComments, setEditComments] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acknowledgeVisualIssues, setAcknowledgeVisualIssues] = useState(false);
  const [applicationView, setApplicationView] = useState<ApplicationSessionView | null>(null);
  const [isLoadingApplication, setIsLoadingApplication] = useState(true);
  const [isStartingApplication, setIsStartingApplication] = useState(false);
  const [applicationError, setApplicationError] = useState<string | null>(null);
  const [applicationLifecycleAction, setApplicationLifecycleAction] =
    useState<ApplicationLifecycleAction | null>(null);
  const [applicationCommandAction, setApplicationCommandAction] =
    useState<ApplicationSessionCommand["type"] | null>(null);
  const [applicationStreamState, setApplicationStreamState] =
    useState<ApplicationStreamState>("idle");
  const applicationRequestVersion = useRef(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const commentsRef = useRef<HTMLTextAreaElement>(null);
  const dialogTriggerRef = useRef<HTMLButtonElement | null>(null);

  const selectedIsCurrent = selectedIteration?.revision === run.revision;
  const canReview = run.status === "review"
    && selectedIsCurrent
    && selectedIteration?.pdfSha256 === run.currentPdfSha256
    && artifactState === "retained";
  const actionsDisabled = !canReview || !isFresh || busyAction !== null;
  const notStarted = applicationView && "state" in applicationView
    ? applicationView
    : null;
  const canStartAfterApproval = notStarted?.canStartAfterApproval === true;
  const blockedReason = blockedReasonMessage(notStarted?.blockedReason);
  const snapshot = applicationSnapshot(applicationView);
  const liveGeneration = snapshot && isLiveApplicationSnapshot(snapshot)
    ? snapshot.generation
    : null;

  useEffect(() => {
    setAcknowledgeVisualIssues(false);
    setActionError(null);
  }, [run.id, run.revision]);

  useEffect(() => {
    const request = ++applicationRequestVersion.current;
    setIsLoadingApplication(true);
    void getApplicationSession(run.id).then((view) => {
      if (request !== applicationRequestVersion.current) return;
      setApplicationView(view);
      setApplicationError(null);
    }).catch((error: unknown) => {
      if (request !== applicationRequestVersion.current) return;
      setApplicationError(publicMessage(
        error,
        "Application availability could not be loaded. The resume can still be approved.",
      ));
    }).finally(() => {
      if (request === applicationRequestVersion.current) setIsLoadingApplication(false);
    });
    return () => {
      if (request === applicationRequestVersion.current) {
        applicationRequestVersion.current += 1;
      }
    };
  }, [run.id, run.revision, run.status]);

  useEffect(() => {
    if (liveGeneration === null) {
      setApplicationStreamState("idle");
      return;
    }

    let source: EventSource;
    try {
      source = new EventSource(applicationEventsHref(run.id));
    } catch {
      setApplicationStreamState("invalid");
      setApplicationError("Live application updates could not be opened.");
      return;
    }
    setApplicationStreamState("connecting");

    const acceptEvent = (nativeEvent: Event) => {
      if (!(nativeEvent instanceof MessageEvent) || typeof nativeEvent.data !== "string") {
        source.close();
        setApplicationStreamState("invalid");
        setApplicationError("The application service returned an invalid live update.");
        return;
      }
      const projection = parseApplicationSessionStreamEvent(
        nativeEvent.data,
        nativeEvent.lastEventId,
        liveGeneration,
        nativeEvent.type,
      );
      if (projection.status === "stale") return;
      if (projection.status === "invalid") {
        source.close();
        setApplicationStreamState("invalid");
        setApplicationError("The application service returned an invalid live update.");
        return;
      }
      setApplicationView((current) => {
        const currentSnapshot = applicationSnapshot(current);
        if (
          currentSnapshot
          && (
            projection.event.generation < currentSnapshot.generation
            || (
              projection.event.generation === currentSnapshot.generation
              && projection.event.session.updatedAt < currentSnapshot.updatedAt
            )
          )
        ) {
          return current;
        }
        return projection.event.session;
      });
      setApplicationError(null);
      setApplicationStreamState("connected");
    };
    for (const eventName of APPLICATION_SESSION_EVENT_NAMES) {
      source.addEventListener(eventName, acceptEvent);
    }
    source.onopen = () => {
      setApplicationStreamState("connected");
    };
    source.onerror = () => {
      setApplicationStreamState("reconnecting");
    };
    return () => {
      source.close();
    };
  }, [liveGeneration, run.id]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || reviewDialog === null) return;
    if (!dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => {
      if (reviewDialog === "edit") {
        commentsRef.current?.focus();
      } else {
        dialog.querySelector<HTMLButtonElement>("[data-dialog-cancel]")?.focus();
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog.open) dialog.close();
    };
  }, [reviewDialog]);

  const closeDialog = () => {
    if (busyAction !== null) return;
    setReviewDialog(null);
    setDialogError(null);
    const trigger = dialogTriggerRef.current;
    dialogTriggerRef.current = null;
    window.requestAnimationFrame(() => trigger?.focus());
  };

  const openDialog = (
    dialog: Exclude<ReviewDialog, null>,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    dialogTriggerRef.current = event.currentTarget;
    setDialogError(null);
    setReviewDialog(dialog);
  };

  const submitEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editComments.trim().length < 1 || editComments.length > 8_000) {
      setDialogError("Enter edit instructions between 1 and 8,000 characters.");
      return;
    }
    setDialogError(null);
    try {
      await onEdit(editComments);
      setEditComments("");
      closeDialog();
    } catch (error) {
      setDialogError(publicMessage(error, "The edit request could not be saved."));
    }
  };

  const submitRegeneration = async () => {
    setDialogError(null);
    try {
      await onRegenerate();
      closeDialog();
    } catch (error) {
      setDialogError(publicMessage(error, "The resume could not be regenerated."));
    }
  };

  const startApplication = async (pdfSha256: string) => {
    setIsStartingApplication(true);
    setApplicationError(null);
    try {
      const snapshot = await startApplicationSession(run.id, pdfSha256);
      setApplicationView(snapshot);
    } catch (error) {
      setApplicationError(publicMessage(
        error,
        "The resume is approved, but the application assistant could not start.",
      ));
      try {
        setApplicationView(await getApplicationSession(run.id));
      } catch {
        // Keep the approved run and the fixed public start failure above.
      }
    } finally {
      setIsStartingApplication(false);
    }
  };

  const retryApplication = async () => {
    if (!run.currentPdfSha256) {
      setApplicationError("The approved resume is no longer available for retry.");
      return;
    }
    setApplicationLifecycleAction("retry");
    setApplicationError(null);
    try {
      setApplicationView(await retryApplicationSession(run.id, run.currentPdfSha256));
    } catch (error) {
      setApplicationError(publicMessage(error, "The application assistant could not be retried."));
    } finally {
      setApplicationLifecycleAction(null);
    }
  };

  const cancelApplication = async () => {
    if (!snapshot) return;
    setApplicationLifecycleAction("cancel");
    setApplicationError(null);
    try {
      if (snapshot.bridgeState === "reserved") {
        await closeApplicationSession(run.id);
        setApplicationView(await getApplicationSession(run.id));
      } else {
        await sendApplicationCommand(run.id, { type: "cancel" });
      }
    } catch (error) {
      setApplicationError(publicMessage(error, "The application assistant could not be cancelled."));
    } finally {
      setApplicationLifecycleAction(null);
    }
  };

  const closeApplication = async () => {
    setApplicationLifecycleAction("close");
    setApplicationError(null);
    try {
      await closeApplicationSession(run.id);
      setApplicationView(await getApplicationSession(run.id));
    } catch (error) {
      setApplicationError(publicMessage(error, "The browser could not be closed."));
    } finally {
      setApplicationLifecycleAction(null);
    }
  };

  const submitApplicationCommand = async (command: ApplicationSessionCommand) => {
    setApplicationCommandAction(command.type);
    setApplicationError(null);
    try {
      await sendApplicationCommand(run.id, command);
    } catch (error) {
      setApplicationError(publicMessage(error, "The application command could not be accepted."));
    } finally {
      setApplicationCommandAction(null);
    }
  };

  const submitApproval = async () => {
    if (run.visualAcknowledgementRequired && !acknowledgeVisualIssues) return;
    setActionError(null);
    try {
      const approved = await onApprove(acknowledgeVisualIssues);
      if (canStartAfterApproval && approved.currentPdfSha256) {
        await startApplication(approved.currentPdfSha256);
      }
    } catch (error) {
      setActionError(publicMessage(error, "The resume could not be approved."));
    }
  };

  return (
    <div className={styles.reviewWorkspace}>
      <section className={styles.workspaceSection} aria-labelledby="resume-iteration-heading">
        <p className={styles.eyebrow}>Review workspace</p>
        <h2 id="resume-iteration-heading">Resume iteration</h2>
        {iterations.length > 0 ? (
          <label className={styles.workspaceField}>
            <span>Displayed resume</span>
            <select
              onChange={(event) => onSelectIteration(Number(event.currentTarget.value))}
              value={selectedIteration?.revision ?? ""}
            >
              {iterations.map((iteration) => (
                <option key={iteration.revision} value={iteration.revision}>
                  {resumeIterationLabel(iteration)}
                </option>
              ))}
            </select>
          </label>
        ) : isLoadingIterations ? (
          <p role="status">Loading resume history…</p>
        ) : (
          <p>No reviewed resume iteration is available yet.</p>
        )}
        {selection.mode === "pinned" ? (
          <button className={styles.secondaryButton} type="button" onClick={onViewLatest}>
            View latest
          </button>
        ) : null}
        {selectedIteration ? (
          <p className={styles.workspaceNotice}>
            {selectedIsCurrent
              ? `Showing the current ${selectedIteration.status} revision.`
              : "Historical iterations are view-only. Current-run actions stay tied to the latest reviewed revision."}
          </p>
        ) : null}
        {artifactState === "pruned" && iterations.length > 0 ? (
          <p className={styles.workspaceNotice} role="status">
            Resume files were removed by retention; iteration labels and PDF hashes remain available.
          </p>
        ) : null}
        {iterationError ? <p className={styles.panelError} role="alert">{iterationError}</p> : null}
      </section>

      <section className={styles.workspaceSection} aria-labelledby="resume-review-actions-heading">
        <p className={styles.eyebrow}>Current run</p>
        <h2 id="resume-review-actions-heading">Resume review</h2>
        {canReview ? (
          <>
            {run.visualAcknowledgementRequired ? (
              <label className={styles.workspaceCheck}>
                <input
                  checked={acknowledgeVisualIssues}
                  onChange={(event) => setAcknowledgeVisualIssues(event.currentTarget.checked)}
                  type="checkbox"
                />
                <span>I reviewed the reported visual QA issues and accept them.</span>
              </label>
            ) : null}
            <div className={styles.workspaceActions}>
              <button
                className={styles.secondaryButton}
                disabled={actionsDisabled}
                onClick={(event) => openDialog("edit", event)}
                type="button"
              >
                Request edit
              </button>
              <button
                className={styles.secondaryButton}
                disabled={actionsDisabled}
                onClick={(event) => openDialog("regenerate", event)}
                type="button"
              >
                Regenerate
              </button>
              <button
                className={styles.primaryButton}
                disabled={
                  actionsDisabled
                  || isLoadingApplication
                  || (run.visualAcknowledgementRequired && !acknowledgeVisualIssues)
                  || isStartingApplication
                }
                onClick={() => void submitApproval()}
                type="button"
              >
                {busyAction === "approve"
                  ? "Approving…"
                  : canStartAfterApproval
                    ? "Approve & apply"
                    : "Approve resume"}
              </button>
            </div>
            {canStartAfterApproval ? (
              <p className={styles.workspaceNotice}>
                Approves this resume and starts the application assistant. You still submit the final form.
              </p>
            ) : blockedReason ? (
              <p className={styles.workspaceNotice}>{blockedReason}</p>
            ) : null}
          </>
        ) : selectedIteration && !selectedIsCurrent ? (
          <p>Choose the latest reviewed iteration to edit, regenerate, or approve it.</p>
        ) : run.status === "approved" ? (
          <p>The current resume is approved. Resume editing and regeneration are closed.</p>
        ) : (
          <p>Review actions become available when the current resume reaches review.</p>
        )}
        {actionError ? <p className={styles.panelError} role="alert">{actionError}</p> : null}
      </section>

      {run.status === "approved" && notStarted?.canStart && run.currentPdfSha256 ? (
        <section className={styles.workspaceSection} aria-labelledby="approved-application-heading">
          <p className={styles.eyebrow}>Application</p>
          <h2 id="approved-application-heading">Approved resume</h2>
          <button
            className={styles.primaryButton}
            disabled={isStartingApplication}
            onClick={() => void startApplication(run.currentPdfSha256!)}
            type="button"
          >
            {isStartingApplication ? "Starting…" : "Start applying"}
          </button>
        </section>
      ) : null}
      {snapshot ? (
        <ApplicationSessionPanel
          actionBusy={applicationCommandAction ?? applicationLifecycleAction}
          onCancel={cancelApplication}
          onClose={closeApplication}
          onCommand={submitApplicationCommand}
          onRetry={retryApplication}
          snapshot={snapshot}
        />
      ) : null}
      {snapshot && (
        applicationStreamState === "connecting"
        || applicationStreamState === "reconnecting"
      ) ? (
        <p
          className={`${styles.workspaceNotice} ${styles.workspaceStandaloneError}`}
          role="status"
        >
          {applicationStreamState === "reconnecting"
            ? "Reconnecting to live application updates. The latest confirmed state remains visible."
            : "Connecting to live application updates…"}
        </p>
      ) : null}
      {applicationError ? (
        <p className={`${styles.panelError} ${styles.workspaceStandaloneError}`} role="alert">
          {applicationError}
        </p>
      ) : null}

      <dialog
        aria-labelledby="review-action-dialog-title"
        className={styles.reviewDialog}
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
        ref={dialogRef}
      >
        {reviewDialog === "edit" ? (
          <form noValidate onSubmit={(event) => void submitEdit(event)}>
            <div className={styles.reviewDialogBody}>
              <p className={styles.eyebrow}>Request edit</p>
              <h2 id="review-action-dialog-title">Describe the resume changes</h2>
              <label className={styles.workspaceField}>
                <span>Edit instructions</span>
                <textarea
                  aria-describedby={dialogError ? "review-action-dialog-error" : undefined}
                  aria-invalid={dialogError ? true : undefined}
                  maxLength={8_000}
                  onChange={(event) => setEditComments(event.currentTarget.value)}
                  ref={commentsRef}
                  required
                  value={editComments}
                />
              </label>
              {dialogError ? (
                <p className={styles.panelError} id="review-action-dialog-error" role="alert">
                  {dialogError}
                </p>
              ) : null}
            </div>
            <div className={styles.reviewDialogActions}>
              <button
                className={styles.secondaryButton}
                data-dialog-cancel
                disabled={busyAction !== null}
                onClick={closeDialog}
                type="button"
              >
                Cancel
              </button>
              <button className={styles.primaryButton} disabled={busyAction !== null} type="submit">
                {busyAction === "edit" ? "Requesting…" : "Request edit"}
              </button>
            </div>
          </form>
        ) : reviewDialog === "regenerate" ? (
          <div>
            <div className={styles.reviewDialogBody}>
              <p className={styles.eyebrow}>Regenerate</p>
              <h2 id="review-action-dialog-title">Regenerate this resume?</h2>
              <p>The pipeline will create a new review iteration from the same approved evidence.</p>
              {dialogError ? <p className={styles.panelError} role="alert">{dialogError}</p> : null}
            </div>
            <div className={styles.reviewDialogActions}>
              <button
                className={styles.secondaryButton}
                data-dialog-cancel
                disabled={busyAction !== null}
                onClick={closeDialog}
                type="button"
              >
                Cancel
              </button>
              <button
                className={styles.primaryButton}
                disabled={busyAction !== null}
                onClick={() => void submitRegeneration()}
                type="button"
              >
                {busyAction === "regenerate" ? "Regenerating…" : "Regenerate"}
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </div>
  );
}
