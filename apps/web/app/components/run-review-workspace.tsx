"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  ApplicationProfessionalizeRequest,
  ApplicationSessionView,
  ResumeIterationDto,
  RunDto,
} from "../lib/pipeline-contracts";
import { ApplicationSessionPanel } from "./application-session-panel";
import { useApplicationSession } from "../lib/use-application-session";
import {
  PipelineClientError,
  getApplicationAnswerSuggestions,
  professionalizeApplicationAnswer,
} from "../lib/pipeline-client";
import styles from "../run-detail.module.css";
const MAX_PUBLIC_MESSAGE_LENGTH = 240;
type ReviewBusyAction = "retry" | "edit" | "approve" | null;

export interface RunReviewWorkspaceProps {
  readonly run: RunDto;
  readonly artifactState: "retained" | "pruned";
  readonly iterations: readonly ResumeIterationDto[];
  readonly selectedIteration: ResumeIterationDto | undefined;
  readonly isLoadingIterations: boolean;
  readonly iterationError: string | null;
  readonly isFresh: boolean;
  readonly busyAction: ReviewBusyAction;
  readonly onSelectIteration: (revision: number) => void;
  readonly onEdit: (comments: string) => Promise<RunDto>;
  readonly onApprove: (acknowledgeVisualIssues: boolean) => Promise<RunDto>;
  readonly onApplicationView: (view: ApplicationSessionView | null) => void;
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
    return "Automatic application is unavailable because historical resume files are unavailable.";
  }
  if (reason === "harness_unconfigured") {
    return "The local browser application service is not configured.";
  }
  if (reason === "profile_unavailable") {
    return "The applicant profile is unavailable or invalid.";
  }
  return null;
}

export function RunReviewWorkspace({
  run,
  artifactState,
  iterations,
  selectedIteration,
  isLoadingIterations,
  iterationError,
  isFresh,
  busyAction,
  onApplicationView,
  onSelectIteration,
  onEdit,
  onApprove,
}: RunReviewWorkspaceProps) {
  const [editComments, setEditComments] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { state: application, dispatch } = useApplicationSession(run, onApplicationView);
  const applicationView = application.view;
  const isStartingApplication = application.actionBusy === "resume";
  const applicationContextKey = `${run.id}:${run.revision}`;
  const activeRunContextRef = useRef<string | null>(applicationContextKey);
  activeRunContextRef.current = applicationContextKey;
  useEffect(() => {
    activeRunContextRef.current = applicationContextKey;
    return () => {
      if (activeRunContextRef.current === applicationContextKey) activeRunContextRef.current = null;
    };
  }, [applicationContextKey]);
  const loadApplicationAnswerSuggestions = useCallback((questionId: string, signal: AbortSignal) =>
    getApplicationAnswerSuggestions(run.id, questionId, signal), [run.id]);
  const professionalizeApplicationAnswerForQuestion = useCallback((
    questionId: string,
    request: ApplicationProfessionalizeRequest,
    signal: AbortSignal,
  ) => professionalizeApplicationAnswer(run.id, questionId, request, signal), [run.id]);
  const snapshot = applicationView && !("state" in applicationView) ? applicationView : null;
  const selectionReady = selectedIteration?.revision === run.revision
    && selectedIteration.pdfSha256 === run.currentPdfSha256
    && artifactState === "retained";
  const canReview = run.status === "review" && selectionReady;
  const canEditCancelledApplication = run.status === "approved"
    && snapshot?.bridgeState === "cancelled"
    && selectionReady;
  const canEdit = canReview || canEditCancelledApplication;
  const notStarted = applicationView && "state" in applicationView
    ? applicationView
    : null;
  const canStartAfterApproval = notStarted?.canStartAfterApproval === true;
  const blockedReason = blockedReasonMessage(notStarted?.blockedReason);
  const editDisabled = !isFresh || busyAction !== null;
  const hasApplicationUrl = run.jobUrl !== undefined;
  const approvalDisabled = editDisabled
    || (hasApplicationUrl && !application.approvalAllowed);

  useEffect(() => { setActionError(null); }, [run.id, run.revision]);

  const submitEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canEdit || editDisabled) return;
    const comments = editComments.trim();
    if (comments.length < 1 || comments.length > 8_000) {
      setEditError("Enter edit instructions between 1 and 8,000 characters.");
      return;
    }
    setEditError(null);
    try {
      await onEdit(comments);
      setEditComments("");
    } catch (error) {
      setEditError(publicMessage(error, "The edit request could not be saved."));
    }
  };

  const submitApproval = async () => {
    const approvalContext = applicationContextKey;
    if (!canReview || approvalDisabled) return;
    setActionError(null);
    try {
      const approved = await onApprove(run.visualAcknowledgementRequired);
      if (activeRunContextRef.current !== approvalContext) return;
      if (!hasApplicationUrl || !canStartAfterApproval) return;
      if (!approved.currentPdfSha256) {
        setActionError("The resume was approved, but its PDF is unavailable to apply.");
        return;
      }
      await dispatch({ type: "start", approvedPdfSha256: approved.currentPdfSha256 });
    } catch (error) {
      if (activeRunContextRef.current === approvalContext) {
        setActionError(publicMessage(error, "The resume could not be approved."));
      }
    }
  };

  return (
    <div className={styles.reviewWorkspace}>
      {snapshot ? (
        <ApplicationSessionPanel
          actionBusy={application.actionBusy}
          browserOpenBusy={application.browserOpenBusy}
          steeringState={application.steeringState}
          onCancel={async () => { await dispatch({ type: "cancel" }); }}
          onClose={async () => { await dispatch({ type: "close" }); }}
          onOpenBrowser={async () => { await dispatch({ type: "open_browser" }); }}
          onLoadSuggestions={loadApplicationAnswerSuggestions}
          onProfessionalize={professionalizeApplicationAnswerForQuestion}
          onCommand={async (command) => { await dispatch(command); }}
          onSteer={dispatch}
          onResume={async () => { await dispatch({ type: "resume" }); }}
          onRetry={async () => { await dispatch({ type: "retry" }); }}
          snapshot={snapshot}
        />
      ) : null}
      <section className={styles.workspaceSection}>
        <h2 id="displayed-resume-heading">Displayed resume</h2>
        {iterations.length > 0 ? (
          <div className={styles.workspaceField}>
            <select
              aria-labelledby="displayed-resume-heading"
              onChange={(event) => onSelectIteration(Number(event.currentTarget.value))}
              value={selectedIteration?.revision ?? ""}
            >
              {iterations.map((iteration, index) => (
                <option key={iteration.revision} value={iteration.revision}>
                  {resumeIterationLabel(index + 1, index === iterations.length - 1)}
                </option>
              ))}
            </select>
          </div>
        ) : isLoadingIterations ? (
          <p role="status">Loading resume history…</p>
        ) : (
          <p>No reviewed resume iteration is available yet.</p>
        )}
        {artifactState === "pruned" && iterations.length > 0 ? (
          <p className={styles.workspaceNotice} role="status">
            Historical document files are unavailable; iteration labels and PDF hashes remain available.
          </p>
        ) : null}
        {iterationError ? <p className={styles.panelError} role="alert">{iterationError}</p> : null}

        {canEdit ? (
          <form
            className={styles.workspaceActions}
            noValidate
            onSubmit={(event) => void submitEdit(event)}
          >
            <label className={styles.workspaceField}>
              <span>Edit instructions</span>
              <textarea
                aria-describedby={editError ? "resume-edit-error" : undefined}
                aria-invalid={editError ? true : undefined}
                disabled={editDisabled}
                maxLength={8_000}
                onChange={(event) => setEditComments(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Enter"
                    || !event.ctrlKey
                    || event.repeat
                    || event.nativeEvent.isComposing
                  ) return;
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }}
                required
                value={editComments}
              />
            </label>
            {editError ? (
              <p className={styles.panelError} id="resume-edit-error" role="alert">
                {editError}
              </p>
            ) : null}
            <button className={styles.secondaryButton} disabled={editDisabled} type="submit">
              {busyAction === "edit" ? "Requesting…" : "Request edits"}
            </button>
          </form>
        ) : null}
        {canReview ? (
          <>
            <button
              className={styles.primaryButton}
              disabled={approvalDisabled}
              onClick={() => void submitApproval()}
              type="button"
            >
              {busyAction === "approve" ? "Approving…" : hasApplicationUrl && applicationView !== null ? "Approve and apply" : "Approve"}
            </button>
            {hasApplicationUrl && !canStartAfterApproval && blockedReason ? (
              <p className={styles.workspaceNotice}>{blockedReason}</p>
            ) : null}
          </>
        ) : null}
        {run.status === "approved" ? (
          !hasApplicationUrl ? (
            <p className={styles.workspaceNotice}>
              Automatic application is unavailable for this opportunity.
            </p>
          ) : notStarted ? (
            notStarted.canStart && run.currentPdfSha256 ? (
              <button
                className={styles.primaryButton}
                disabled={isStartingApplication}
                onClick={() => void dispatch({ type: "start", approvedPdfSha256: run.currentPdfSha256! })}
                type="button"
              >
                {isStartingApplication ? "Starting…" : "Apply"}
              </button>
            ) : (
              <p className={styles.workspaceNotice}>
                {blockedReason ?? "Automatic application is not available for this approved run."}
              </p>
            )
          ) : null
        ) : null}
        {actionError ? <p className={styles.panelError} role="alert">{actionError}</p> : null}
      </section>

      {application.error ? (
        <p className={`${styles.panelError} ${styles.workspaceStandaloneError}`} role="alert">
          {application.error}
        </p>
      ) : null}

    </div>
  );
}
