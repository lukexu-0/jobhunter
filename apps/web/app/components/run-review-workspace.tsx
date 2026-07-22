"use client";

import {
  useCallback,
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
  isStreamableApplicationSnapshot,
  parseApplicationSessionStreamEvent,
  shouldAcceptApplicationView,
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
interface ApplicationActionLatch {
  requestPending: boolean;
  projectionAccepted: boolean;
  readonly acceptsProjection: (view: ApplicationSessionView) => boolean;
}

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

export function resumeIterationLabel(displayNumber: number, isLatest: boolean): string {
  return `Iteration ${displayNumber}${isLatest ? " — Latest" : ""}`;
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

function isTerminalApplicationSnapshot(snapshot: ApplicationSessionSnapshotDto): boolean {
  return snapshot.bridgeState === "cancelled"
    || snapshot.bridgeState === "failed"
    || snapshot.bridgeState === "closed"
    || snapshot.bridgeState === "lost";
}

function commandProjectionMatcher(
  command: ApplicationSessionCommand,
  baseline: ApplicationSessionSnapshotDto,
): (view: ApplicationSessionView) => boolean {
  const navigationInstruction = baseline.pendingAction?.type === "human_navigation"
    ? baseline.pendingAction.instruction
    : null;
  const additionalInfoQuestions = baseline.pendingAction?.type === "additional_info"
    ? JSON.stringify(baseline.pendingAction.questions)
    : null;
  return (view) => {
    const next = applicationSnapshot(view);
    if (!next) return false;
    if (next.generation !== baseline.generation) {
      return next.generation > baseline.generation;
    }
    switch (command.type) {
      case "continue":
        return next.pendingAction?.type !== "human_navigation"
          || next.pendingAction.instruction !== navigationInstruction;
      case "approve_origin":
        return next.pendingAction?.type !== "origin_approval"
          || next.pendingAction.origin !== command.origin;
      case "provide_additional_info":
        return next.pendingAction?.type !== "additional_info"
          || JSON.stringify(next.pendingAction.questions) !== additionalInfoQuestions;
      case "revise":
        return next.pendingAction?.type !== "human_review"
          || next.revisionCount > baseline.revisionCount;
      case "ready":
        return next.pendingAction?.type !== "human_review";
      case "cancel":
        return isTerminalApplicationSnapshot(next);
    }
  };
}

function lifecycleProjectionMatcher(
  action: "cancel" | "close" | "retry",
  baseline: ApplicationSessionSnapshotDto,
): (view: ApplicationSessionView) => boolean {
  return (view) => {
    const next = applicationSnapshot(view);
    if (!next) return false;
    if (next.generation !== baseline.generation) {
      return next.generation > baseline.generation;
    }
    if (action === "retry") return false;
    if (action === "cancel") return isTerminalApplicationSnapshot(next);
    return next.bridgeState === "closed" || next.bridgeState === "lost";
  };
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
  const [applicationLoadError, setApplicationLoadError] = useState<string | null>(null);
  const [applicationStreamError, setApplicationStreamError] = useState<string | null>(null);
  const [applicationLifecycleAction, setApplicationLifecycleAction] =
    useState<ApplicationLifecycleAction | null>(null);
  const [applicationCommandAction, setApplicationCommandAction] =
    useState<ApplicationSessionCommand["type"] | null>(null);
  const [applicationStreamState, setApplicationStreamState] =
    useState<ApplicationStreamState>("idle");
  const [applicationStreamRecovery, setApplicationStreamRecovery] = useState(0);
  const applicationRequestVersion = useRef(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const commentsRef = useRef<HTMLTextAreaElement>(null);
  const dialogTriggerRef = useRef<HTMLButtonElement | null>(null);
  const applicationViewRef = useRef<ApplicationSessionView | null>(null);
  const activeRunIdRef = useRef(run.id);
  const applicationLifecycleLatchRef = useRef<ApplicationActionLatch | null>(null);
  const applicationCommandLatchRef = useRef<ApplicationActionLatch | null>(null);
  activeRunIdRef.current = run.id;
  const installApplicationView = useCallback((next: ApplicationSessionView): boolean => {
    if (activeRunIdRef.current !== run.id) return false;
    if (!shouldAcceptApplicationView(applicationViewRef.current, next)) return false;
    applicationViewRef.current = next;
    setApplicationLoadError(null);
    setApplicationStreamError(null);
    const lifecycleLatch = applicationLifecycleLatchRef.current;
    if (lifecycleLatch && lifecycleLatch.acceptsProjection(next)) {
      lifecycleLatch.projectionAccepted = true;
      if (!lifecycleLatch.requestPending) {
        applicationLifecycleLatchRef.current = null;
        setApplicationLifecycleAction(null);
      }
    }
    const commandLatch = applicationCommandLatchRef.current;
    if (commandLatch && commandLatch.acceptsProjection(next)) {
      commandLatch.projectionAccepted = true;
      if (!commandLatch.requestPending) {
        applicationCommandLatchRef.current = null;
        setApplicationCommandAction(null);
      }
    }
    setApplicationView(next);
    return true;
  }, [run.id]);
  const refreshApplicationView = useCallback(async (): Promise<boolean> => {
    return installApplicationView(await getApplicationSession(run.id));
  }, [installApplicationView, run.id]);
  const refreshAfterApplicationFailure = useCallback(async (
    error: unknown,
    fallback: string,
  ): Promise<void> => {
    const message = publicMessage(error, fallback);
    setApplicationError(message);
    try {
      await refreshApplicationView();
    } catch {
      // Retain the latest confirmed projection and the fixed public failure.
    }
    setApplicationError(message);
  }, [refreshApplicationView]);

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
  const liveGeneration = snapshot && isStreamableApplicationSnapshot(snapshot)
    ? snapshot.generation
    : null;

  useEffect(() => {
    applicationViewRef.current = null;
    setApplicationView(null);
    setApplicationStreamError(null);
    setApplicationLoadError(null);
    applicationLifecycleLatchRef.current = null;
    applicationCommandLatchRef.current = null;
    setApplicationLifecycleAction(null);
    setApplicationCommandAction(null);
    setApplicationError(null);
  }, [run.id]);

  useEffect(() => {
    setAcknowledgeVisualIssues(false);
    setActionError(null);
  }, [run.id, run.revision]);

  useEffect(() => {
    const request = ++applicationRequestVersion.current;
    setIsLoadingApplication(true);
    void getApplicationSession(run.id).then((view) => {
      if (request !== applicationRequestVersion.current) return;
      installApplicationView(view);
      setApplicationLoadError(null);
    }).catch((error: unknown) => {
      if (request !== applicationRequestVersion.current) return;
      setApplicationLoadError(publicMessage(
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
    let disposed = false;
    let mounted = true;
    let refreshInFlight = false;
    let recoveryTimer: number | null = null;
    const scheduleRecovery = (message: string) => {
      setApplicationStreamState("invalid");
      setApplicationStreamError(message);
      void refreshApplicationView().catch(() => {
        // Retain the latest confirmed projection and the fixed public stream failure.
      }).finally(() => {
        if (!mounted) return;
        recoveryTimer = window.setTimeout(() => {
          if (mounted) setApplicationStreamRecovery((current) => current + 1);
        }, 1_000);
      });
    };
    try {
      source = new EventSource(applicationEventsHref(run.id));
    } catch {
      scheduleRecovery("Live application updates could not be opened.");
      return () => {
        mounted = false;
        if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
      };
    }
    setApplicationStreamState("connecting");

    const invalidate = () => {
      if (disposed) return;
      disposed = true;
      source.close();
      scheduleRecovery("The application service returned an invalid live update.");
    };
    const acceptEvent = (nativeEvent: Event) => {
      if (disposed) return;
      if (!(nativeEvent instanceof MessageEvent) || typeof nativeEvent.data !== "string") {
        invalidate();
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
        invalidate();
        return;
      }
      if (!installApplicationView(projection.event.session)) return;
      setApplicationStreamError(null);
      setApplicationStreamState("connected");
    };
    for (const eventName of APPLICATION_SESSION_EVENT_NAMES) {
      source.addEventListener(eventName, acceptEvent);
    }
    source.onopen = () => {
      if (disposed) return;
      const current = applicationSnapshot(applicationViewRef.current);
      if (
        !current
        || current.generation !== liveGeneration
        || !isStreamableApplicationSnapshot(current)
      ) {
        disposed = true;
        source.close();
        setApplicationStreamState("idle");
        return;
      }
      setApplicationStreamState("connected");
    };
    source.onerror = () => {
      if (disposed) return;
      setApplicationStreamState("reconnecting");
      if (refreshInFlight) return;
      refreshInFlight = true;
      void refreshApplicationView().then(() => {
        if (disposed) return;
        const current = applicationSnapshot(applicationViewRef.current);
        if (
          !current
          || current.generation !== liveGeneration
          || !isStreamableApplicationSnapshot(current)
        ) {
          disposed = true;
          source.close();
          setApplicationStreamState("idle");
        }
      }).catch(() => {
        // Native EventSource retries transient failures while confirmed content remains visible.
      }).finally(() => {
        refreshInFlight = false;
      });
    };
    return () => {
      mounted = false;
      disposed = true;
      if (recoveryTimer !== null) window.clearTimeout(recoveryTimer);
      source.close();
    };
  }, [
    applicationStreamRecovery,
    installApplicationView,
    liveGeneration,
    refreshApplicationView,
    run.id,
  ]);

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
    const comments = editComments.trim();
    if (comments.length < 1 || comments.length > 8_000) {
      setDialogError("Enter edit instructions between 1 and 8,000 characters.");
      return;
    }
    setDialogError(null);
    try {
      await onEdit(comments);
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
      installApplicationView(await startApplicationSession(run.id, pdfSha256));
    } catch (error) {
      await refreshAfterApplicationFailure(
        error,
        "The resume is approved, but the application assistant could not start.",
      );
    } finally {
      setIsStartingApplication(false);
    }
  };

  const resumeReservedApplication = async () => {
    if (!run.currentPdfSha256) {
      setApplicationError("The approved resume is no longer available to resume.");
      return;
    }
    await startApplication(run.currentPdfSha256);
  };

  const settleApplicationLifecycleRequest = (latch: ApplicationActionLatch) => {
    latch.requestPending = false;
    if (
      applicationLifecycleLatchRef.current === latch
      && latch.projectionAccepted
    ) {
      applicationLifecycleLatchRef.current = null;
      setApplicationLifecycleAction(null);
    }
  };

  const settleApplicationCommandRequest = (latch: ApplicationActionLatch) => {
    latch.requestPending = false;
    if (
      applicationCommandLatchRef.current === latch
      && latch.projectionAccepted
    ) {
      applicationCommandLatchRef.current = null;
      setApplicationCommandAction(null);
    }
  };

  const retryApplication = async () => {
    if (!run.currentPdfSha256) {
      setApplicationError("The approved resume is no longer available for retry.");
      return;
    }
    if (!snapshot || applicationLifecycleLatchRef.current) return;
    const latch: ApplicationActionLatch = {
      requestPending: true,
      projectionAccepted: false,
      acceptsProjection: lifecycleProjectionMatcher("retry", snapshot),
    };
    applicationLifecycleLatchRef.current = latch;
    setApplicationLifecycleAction("retry");
    setApplicationError(null);
    try {
      installApplicationView(await retryApplicationSession(run.id, run.currentPdfSha256));
      settleApplicationLifecycleRequest(latch);
    } catch (error) {
      await refreshAfterApplicationFailure(
        error,
        "The application assistant could not be retried.",
      );
      if (applicationLifecycleLatchRef.current === latch) {
        applicationLifecycleLatchRef.current = null;
        setApplicationLifecycleAction(null);
      }
    }
  };

  const cancelApplication = async () => {
    if (!snapshot || applicationLifecycleLatchRef.current) return;
    const latch: ApplicationActionLatch = {
      requestPending: true,
      projectionAccepted: false,
      acceptsProjection: lifecycleProjectionMatcher("cancel", snapshot),
    };
    applicationLifecycleLatchRef.current = latch;
    setApplicationLifecycleAction("cancel");
    setApplicationError(null);
    try {
      if (snapshot.bridgeState === "reserved") {
        await closeApplicationSession(run.id);
        await refreshApplicationView();
      } else {
        await sendApplicationCommand(run.id, { type: "cancel" });
      }
      settleApplicationLifecycleRequest(latch);
    } catch (error) {
      await refreshAfterApplicationFailure(
        error,
        "The application assistant could not be cancelled.",
      );
      if (applicationLifecycleLatchRef.current === latch) {
        applicationLifecycleLatchRef.current = null;
        setApplicationLifecycleAction(null);
      }
    }
  };

  const closeApplication = async () => {
    if (!snapshot || applicationLifecycleLatchRef.current) return;
    const latch: ApplicationActionLatch = {
      requestPending: true,
      projectionAccepted: false,
      acceptsProjection: lifecycleProjectionMatcher("close", snapshot),
    };
    applicationLifecycleLatchRef.current = latch;
    setApplicationLifecycleAction("close");
    setApplicationError(null);
    try {
      await closeApplicationSession(run.id);
      await refreshApplicationView();
      settleApplicationLifecycleRequest(latch);
    } catch (error) {
      await refreshAfterApplicationFailure(error, "The browser could not be closed.");
      if (applicationLifecycleLatchRef.current === latch) {
        applicationLifecycleLatchRef.current = null;
        setApplicationLifecycleAction(null);
      }
    }
  };

  const submitApplicationCommand = async (command: ApplicationSessionCommand) => {
    if (!snapshot || applicationCommandLatchRef.current) return;
    const latch: ApplicationActionLatch = {
      requestPending: true,
      projectionAccepted: false,
      acceptsProjection: commandProjectionMatcher(command, snapshot),
    };
    applicationCommandLatchRef.current = latch;
    setApplicationCommandAction(command.type);
    setApplicationError(null);
    try {
      await sendApplicationCommand(run.id, command);
      settleApplicationCommandRequest(latch);
    } catch (error) {
      await refreshAfterApplicationFailure(
        error,
        "The application command could not be accepted.",
      );
      if (applicationCommandLatchRef.current === latch) {
        applicationCommandLatchRef.current = null;
        setApplicationCommandAction(null);
      }
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
              {iterations.map((iteration, index) => (
                <option key={iteration.revision} value={iteration.revision}>
                  {resumeIterationLabel(index + 1, index === iterations.length - 1)}
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

      {run.status === "approved" && notStarted ? (
        <section className={styles.workspaceSection} aria-labelledby="approved-application-heading">
          <p className={styles.eyebrow}>Application</p>
          <h2 id="approved-application-heading">Application assistant</h2>
          {notStarted.canStart && run.currentPdfSha256 ? (
            <button
              className={styles.primaryButton}
              disabled={isStartingApplication}
              onClick={() => void startApplication(run.currentPdfSha256!)}
              type="button"
            >
              {isStartingApplication ? "Starting…" : "Start applying"}
            </button>
          ) : (
            <p className={styles.workspaceNotice}>
              {blockedReason ?? "Automatic application is not available for this approved run."}
            </p>
          )}
        </section>
      ) : null}
      {snapshot ? (
        <ApplicationSessionPanel
          actionBusy={
            isStartingApplication
              ? "resume"
              : applicationCommandAction ?? applicationLifecycleAction
          }
          onCancel={cancelApplication}
          onClose={closeApplication}
          onCommand={submitApplicationCommand}
          onResume={resumeReservedApplication}
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
      {applicationError ?? applicationLoadError ?? applicationStreamError ? (
        <p className={`${styles.panelError} ${styles.workspaceStandaloneError}`} role="alert">
          {applicationError ?? applicationLoadError ?? applicationStreamError}
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
