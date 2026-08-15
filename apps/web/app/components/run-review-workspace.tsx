"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  ApplicationProfessionalizeRequest,
  ApplicationSessionView,
  ApplicationSessionCommand,
  ApplicationSessionSnapshotDto,
  ResumeIterationDto,
  RunDto,
} from "@jobhunter/pipeline/contracts";
import {
  ApplicationSessionPanel,
  canGuideApplicationAgent,
  type ApplicationGateCommandType,
  type ApplicationLifecycleAction,
  type ApplicationSteerCommand,
  type ApplicationSteeringState,
  type ApplicationSteeringSubmissionResult,
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
  getApplicationAnswerSuggestions,
  getApplicationSession,
  retryApplicationSession,
  professionalizeApplicationAnswer,
  sendApplicationCommand,
  startApplicationSession,
} from "../lib/pipeline-client";
import styles from "../run-detail.module.css";

const MAX_PUBLIC_MESSAGE_LENGTH = 240;

type ReviewBusyAction = "retry" | "edit" | "approve" | null;
type ApplicationStreamState = "idle" | "connecting" | "connected" | "reconnecting" | "invalid";
type ApplicationGateCommand = Exclude<
  ApplicationSessionCommand,
  { readonly type: "steer" }
>;
export interface ApplicationActionLatch {
  requestPending: boolean;
  projectionAccepted: boolean;
  readonly acceptsProjection: (view: ApplicationSessionView) => boolean;
}
interface ApplicationSteeringLatch {
  state: Exclude<ApplicationSteeringState, "idle">;
  readonly generation: number;
  readonly bridgeState: ApplicationSessionSnapshotDto["bridgeState"];
  readonly pendingActionKey: string;
}

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

function additionalInfoContinueProjectionMatcher(
  baseline: ApplicationSessionSnapshotDto,
): (view: ApplicationSessionView) => boolean {
  if (baseline.pendingAction?.type !== "additional_info") return () => false;
  const baselineQuestions = JSON.stringify(baseline.pendingAction.questions);
  return (view) => {
    const next = applicationSnapshot(view);
    if (!next) return false;
    if (next.generation < baseline.generation) return false;
    return next.pendingAction?.type !== "additional_info"
      || JSON.stringify(next.pendingAction.questions) !== baselineQuestions;
  };
}

function commandProjectionMatcher(
  command: ApplicationGateCommand,
  baseline: ApplicationSessionSnapshotDto,
): (view: ApplicationSessionView) => boolean {
  if (command.type === "continue_without_additional_info") {
    return additionalInfoContinueProjectionMatcher(baseline);
  }
  const navigationInstruction = baseline.pendingAction?.type === "human_navigation"
    ? baseline.pendingAction.instruction
    : null;
  const additionalInfoQuestions = baseline.pendingAction?.type === "additional_info"
    ? JSON.stringify(baseline.pendingAction.questions)
    : null;
  return (view) => {
    const next = applicationSnapshot(view);
    if (!next) return false;
    if (command.type === "submit") {
      return baseline.bridgeState === "awaiting_human_review"
        && baseline.pendingAction?.type === "human_review"
        && next.generation === baseline.generation
        && next.updatedAt > baseline.updatedAt
        && (
          next.bridgeState === "submitting"
          || next.bridgeState === "submitted"
          || next.bridgeState === "submission_uncertain"
        );
    }
    if (next.generation !== baseline.generation) {
      const credentialCommand = command.type === "sign_in"
        || command.type === "save_credentials";
      return next.generation > baseline.generation
        && (!credentialCommand || baseline.pendingAction?.type === "credentials");
    }
    switch (command.type) {
      case "continue":
        return next.pendingAction?.type !== "human_navigation"
          || next.pendingAction.instruction !== navigationInstruction;
      case "sign_in":
      case "save_credentials":
        return baseline.pendingAction?.type === "credentials"
          && next.updatedAt > baseline.updatedAt
          && next.pendingAction?.type !== "credentials";
      case "approve_origin":
        return next.pendingAction?.type !== "origin_approval"
          || next.pendingAction.origin !== command.origin;
      case "provide_additional_info":
        return next.pendingAction?.type !== "additional_info"
          || JSON.stringify(next.pendingAction.questions) !== additionalInfoQuestions;
      case "revise":
        return next.pendingAction?.type !== "human_review"
          || next.revisionCount > baseline.revisionCount;
      case "cancel":
        return isTerminalApplicationSnapshot(next);
    }
  };
}

export function createApplicationCommandLatch(
  command: ApplicationGateCommand,
  baseline: ApplicationSessionSnapshotDto,
): ApplicationActionLatch {
  return {
    requestPending: true,
    projectionAccepted: false,
    acceptsProjection: commandProjectionMatcher(command, baseline),
  };
}

export function acceptApplicationActionProjection(
  latch: ApplicationActionLatch,
  view: ApplicationSessionView,
): boolean {
  if (latch.acceptsProjection(view)) latch.projectionAccepted = true;
  return !latch.requestPending && latch.projectionAccepted;
}

export function settleApplicationActionRequest(
  latch: ApplicationActionLatch,
): boolean {
  latch.requestPending = false;
  return latch.projectionAccepted;
}

export function isApplicationActionLatchBusy(
  latch: ApplicationActionLatch,
): boolean {
  return latch.requestPending || !latch.projectionAccepted;
}

function isDefiniteApplicationRequestRejection(error: unknown): boolean {
  return error instanceof PipelineClientError
    && error.status !== undefined
    && error.status >= 400
    && error.status < 500;
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
    useState<ApplicationGateCommandType | null>(null);
  const [applicationSteeringState, setApplicationSteeringState] =
    useState<ApplicationSteeringState>("idle");
  const [applicationStreamState, setApplicationStreamState] =
    useState<ApplicationStreamState>("idle");
  const [applicationStreamRecovery, setApplicationStreamRecovery] = useState(0);
  const applicationRequestVersion = useRef(0);
  const applicationActionEpochRef = useRef(0);
  const applicationViewEpochRef = useRef(0);
  const applicationViewRef = useRef<ApplicationSessionView | null>(null);
  const applicationContextKey = `${run.id}:${run.revision}`;
  const activeRunContextRef = useRef<string | null>(applicationContextKey);
  const applicationLifecycleLatchRef = useRef<ApplicationActionLatch | null>(null);
  const applicationCommandLatchRef = useRef<ApplicationActionLatch | null>(null);
  const applicationSteeringLatchRef = useRef<ApplicationSteeringLatch | null>(null);
  activeRunContextRef.current = applicationContextKey;
  const installApplicationView = useCallback((next: ApplicationSessionView): boolean => {
    if (activeRunContextRef.current !== applicationContextKey) return false;
    if (!shouldAcceptApplicationView(applicationViewRef.current, next)) return false;
    applicationViewEpochRef.current += 1;
    applicationViewRef.current = next;
    setApplicationLoadError(null);
    setApplicationStreamError(null);
    const lifecycleLatch = applicationLifecycleLatchRef.current;
    if (lifecycleLatch && acceptApplicationActionProjection(lifecycleLatch, next)) {
      applicationLifecycleLatchRef.current = null;
      setApplicationLifecycleAction(null);
    }
    const commandLatch = applicationCommandLatchRef.current;
    if (commandLatch && acceptApplicationActionProjection(commandLatch, next)) {
      applicationCommandLatchRef.current = null;
      setApplicationCommandAction(null);
    }
    const steeringLatch = applicationSteeringLatchRef.current;
    const nextSteeringSnapshot = applicationSnapshot(next);
    if (
      steeringLatch
      && (
        !nextSteeringSnapshot
        || !canGuideApplicationAgent(nextSteeringSnapshot)
        || nextSteeringSnapshot.generation !== steeringLatch.generation
        || nextSteeringSnapshot.bridgeState !== steeringLatch.bridgeState
        || JSON.stringify(nextSteeringSnapshot.pendingAction)
          !== steeringLatch.pendingActionKey
      )
    ) {
      applicationSteeringLatchRef.current = null;
      setApplicationSteeringState("idle");
    }
    onApplicationView(next);
    setApplicationView(next);
    return true;
  }, [applicationContextKey, onApplicationView]);
  const refreshApplicationView = useCallback(async (): Promise<boolean> => {
    return installApplicationView(await getApplicationSession(run.id));
  }, [installApplicationView, run.id]);
  const refreshAfterApplicationFailure = useCallback(async (
    error: unknown,
    fallback: string,
  ): Promise<void> => {
    const requestContext = applicationContextKey;
    if (activeRunContextRef.current !== requestContext) return;
    const message = publicMessage(error, fallback);
    setApplicationError(message);
    try {
      await refreshApplicationView();
    } catch {
      // Retain the latest confirmed projection and the fixed public failure.
    }
    if (activeRunContextRef.current === requestContext) setApplicationError(message);
  }, [applicationContextKey, refreshApplicationView]);
  const loadApplicationAnswerSuggestions = useCallback((
    questionId: string,
    signal: AbortSignal,
  ) => getApplicationAnswerSuggestions(run.id, questionId, signal), [run.id]);
  const professionalizeApplicationAnswerForQuestion = useCallback((
    questionId: string,
    request: ApplicationProfessionalizeRequest,
    signal: AbortSignal,
  ) => professionalizeApplicationAnswer(
    run.id,
    questionId,
    request,
    signal,
  ), [run.id]);

  const snapshot = applicationSnapshot(applicationView);
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
    || (hasApplicationUrl && (isLoadingApplication || !canStartAfterApproval || isStartingApplication))
    || (run.visualAcknowledgementRequired && !acknowledgeVisualIssues);
  const liveGeneration = snapshot && isStreamableApplicationSnapshot(snapshot)
    ? snapshot.generation
    : null;

  useEffect(() => {
    applicationViewRef.current = null;
    onApplicationView(null);
    setApplicationView(null);
    setApplicationStreamError(null);
    setApplicationLoadError(null);
    applicationLifecycleLatchRef.current = null;
    applicationCommandLatchRef.current = null;
    applicationSteeringLatchRef.current = null;
    setApplicationLifecycleAction(null);
    setApplicationCommandAction(null);
    setApplicationSteeringState("idle");
    setIsStartingApplication(false);
    setApplicationError(null);
  }, [onApplicationView, run.id, run.revision]);

  useEffect(() => {
    activeRunContextRef.current = applicationContextKey;
    return () => {
      if (activeRunContextRef.current === applicationContextKey) {
        activeRunContextRef.current = null;
      }
    };
  }, [applicationContextKey]);

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
      disposed = true;
      source.close();
      setApplicationStreamState("reconnecting");
      void refreshApplicationView().catch(() => {
        // Retain the latest confirmed projection while the fresh source is scheduled.
      }).finally(() => {
        if (!mounted) return;
        const current = applicationSnapshot(applicationViewRef.current);
        if (
          !current
          || current.generation !== liveGeneration
          || !isStreamableApplicationSnapshot(current)
        ) {
          setApplicationStreamState("idle");
          return;
        }
        recoveryTimer = window.setTimeout(() => {
          if (!mounted) return;
          const latest = applicationSnapshot(applicationViewRef.current);
          if (
            !latest
            || latest.generation !== liveGeneration
            || !isStreamableApplicationSnapshot(latest)
          ) {
            setApplicationStreamState("idle");
            return;
          }
          setApplicationStreamRecovery((recovery) => recovery + 1);
        }, 1_000);
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

  const startApplication = async (pdfSha256: string) => {
    const requestContext = applicationContextKey;
    if (activeRunContextRef.current !== requestContext) return;
    applicationActionEpochRef.current += 1;
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
      if (activeRunContextRef.current === requestContext) setIsStartingApplication(false);
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
    if (activeRunContextRef.current !== applicationContextKey) return;
    if (
      applicationLifecycleLatchRef.current === latch
      && settleApplicationActionRequest(latch)
    ) {
      applicationLifecycleLatchRef.current = null;
      setApplicationLifecycleAction(null);
    }
  };

  const settleApplicationCommandRequest = (latch: ApplicationActionLatch) => {
    if (activeRunContextRef.current !== applicationContextKey) return;
    if (
      applicationCommandLatchRef.current === latch
      && settleApplicationActionRequest(latch)
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
    applicationActionEpochRef.current += 1;
    setApplicationLifecycleAction("retry");
    setApplicationError(null);
    try {
      installApplicationView(await retryApplicationSession(run.id, run.currentPdfSha256));
      settleApplicationLifecycleRequest(latch);
    } catch (error) {
      const definiteRejection = isDefiniteApplicationRequestRejection(error);
      if (!definiteRejection) settleApplicationLifecycleRequest(latch);
      await refreshAfterApplicationFailure(
        error,
        "The application assistant could not be retried.",
      );
      if (
        definiteRejection
        && activeRunContextRef.current === applicationContextKey
        && applicationLifecycleLatchRef.current === latch
      ) {
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
    applicationActionEpochRef.current += 1;
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
      const definiteRejection = isDefiniteApplicationRequestRejection(error);
      if (!definiteRejection) settleApplicationLifecycleRequest(latch);
      await refreshAfterApplicationFailure(
        error,
        "The application assistant could not be cancelled.",
      );
      if (
        definiteRejection
        && activeRunContextRef.current === applicationContextKey
        && applicationLifecycleLatchRef.current === latch
      ) {
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
    applicationActionEpochRef.current += 1;
    setApplicationLifecycleAction("close");
    setApplicationError(null);
    try {
      await closeApplicationSession(run.id);
      await refreshApplicationView();
      settleApplicationLifecycleRequest(latch);
    } catch (error) {
      const definiteRejection = isDefiniteApplicationRequestRejection(error);
      if (!definiteRejection) settleApplicationLifecycleRequest(latch);
      await refreshAfterApplicationFailure(error, "The browser could not be closed.");
      if (
        definiteRejection
        && activeRunContextRef.current === applicationContextKey
        && applicationLifecycleLatchRef.current === latch
      ) {
        applicationLifecycleLatchRef.current = null;
        setApplicationLifecycleAction(null);
      }
    }
  };

  const submitApplicationSteering = async (
    command: ApplicationSteerCommand,
  ): Promise<ApplicationSteeringSubmissionResult> => {
    const current = applicationSnapshot(applicationViewRef.current);
    if (
      !current
      || !canGuideApplicationAgent(current)
      || activeRunContextRef.current !== applicationContextKey
      || applicationSteeringLatchRef.current
      || applicationLifecycleLatchRef.current
      || applicationCommandLatchRef.current
    ) {
      return {
        status: "rejected",
        message: "The application state changed; review the latest session state.",
      };
    }

    const requestRunId = run.id;
    const requestContext = applicationContextKey;
    const requestVersion = applicationRequestVersion.current;
    const viewEpoch = applicationViewEpochRef.current;
    const latch: ApplicationSteeringLatch = {
      state: "sending",
      generation: current.generation,
      bridgeState: current.bridgeState,
      pendingActionKey: JSON.stringify(current.pendingAction),
    };
    const actionEpoch = applicationActionEpochRef.current;
    applicationSteeringLatchRef.current = latch;
    setApplicationSteeringState("sending");
    try {
      await sendApplicationCommand(requestRunId, command);
      const ownsLatch = applicationSteeringLatchRef.current === latch;
      const isCurrent = applicationRequestVersion.current === requestVersion
        && applicationActionEpochRef.current === actionEpoch
        && applicationViewEpochRef.current === viewEpoch
        && activeRunContextRef.current === requestContext
        && ownsLatch;
      if (ownsLatch) {
        applicationSteeringLatchRef.current = null;
        if (activeRunContextRef.current === requestContext) {
          setApplicationSteeringState("idle");
        }
      }
      return {
        status: "accepted",
        current: isCurrent,
      };
    } catch (error) {
      const ownsLatch = applicationSteeringLatchRef.current === latch;
      if (
        applicationRequestVersion.current !== requestVersion
        || activeRunContextRef.current !== requestContext
        || !ownsLatch
      ) {
        if (ownsLatch) {
          applicationSteeringLatchRef.current = null;
          if (activeRunContextRef.current === requestContext) {
            setApplicationSteeringState("idle");
          }
        }
        return { status: "ambiguous" };
      }
      if (isDefiniteApplicationRequestRejection(error)) {
        applicationSteeringLatchRef.current = null;
        setApplicationSteeringState("idle");
        return {
          status: "rejected",
          message: publicMessage(error, "The guidance could not be queued."),
        };
      }
      latch.state = "ambiguous";
      setApplicationSteeringState("ambiguous");
      return { status: "ambiguous" };
    }
  };

  const submitApplicationCommand = async (
    command: ApplicationSessionCommand,
  ) => {
    if (command.type === "steer") return;
    const current = applicationSnapshot(applicationViewRef.current);
    if (
      !current
      || activeRunContextRef.current !== applicationContextKey
      || applicationCommandLatchRef.current
      || applicationLifecycleLatchRef.current
      || applicationSteeringLatchRef.current?.state === "sending"
    ) return;
    const latch = createApplicationCommandLatch(command, current);
    applicationCommandLatchRef.current = latch;
    applicationActionEpochRef.current += 1;
    setApplicationCommandAction(command.type);
    setApplicationError(null);
    try {
      await sendApplicationCommand(run.id, command);
      settleApplicationCommandRequest(latch);
    } catch (error) {
      const definiteRejection = isDefiniteApplicationRequestRejection(error);
      if (!definiteRejection) settleApplicationCommandRequest(latch);
      await refreshAfterApplicationFailure(
        error,
        "The application command could not be accepted.",
      );
      if (
        definiteRejection
        && activeRunContextRef.current === applicationContextKey
        && applicationCommandLatchRef.current === latch
      ) {
        applicationCommandLatchRef.current = null;
        setApplicationCommandAction(null);
      }
    }
  };

  const submitApproval = async () => {
    const approvalContext = applicationContextKey;
    if (!canReview || approvalDisabled) return;
    setActionError(null);
    try {
      const approved = await onApprove(acknowledgeVisualIssues);
      if (activeRunContextRef.current !== approvalContext) return;
      if (!hasApplicationUrl) return;
      if (!approved.currentPdfSha256) {
        setActionError("The resume was approved, but its PDF is unavailable to apply.");
        return;
      }
      await startApplication(approved.currentPdfSha256);
    } catch (error) {
      if (activeRunContextRef.current === approvalContext) {
        setActionError(publicMessage(error, "The resume could not be approved."));
      }
    }
  };

  return (
    <div className={styles.reviewWorkspace}>
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
            {run.visualAcknowledgementRequired ? (
              <label className={styles.workspaceCheck}>
                <input
                  checked={acknowledgeVisualIssues}
                  disabled={editDisabled || isStartingApplication}
                  onChange={(event) => setAcknowledgeVisualIssues(event.currentTarget.checked)}
                  type="checkbox"
                />
                <span>I reviewed the reported visual QA issues and accept them.</span>
              </label>
            ) : null}
            <button
              className={styles.primaryButton}
              disabled={approvalDisabled}
              onClick={() => void submitApproval()}
              type="button"
            >
              {busyAction === "approve" ? "Approving…" : hasApplicationUrl ? "Approve and apply" : "Approve"}
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
                onClick={() => void startApplication(run.currentPdfSha256!)}
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

      {snapshot ? (
        <ApplicationSessionPanel
          actionBusy={
            isStartingApplication
              ? "resume"
              : applicationLifecycleAction ?? applicationCommandAction
          }
          steeringState={applicationSteeringState}
          onCancel={cancelApplication}
          onClose={closeApplication}
          onLoadSuggestions={loadApplicationAnswerSuggestions}
          onProfessionalize={professionalizeApplicationAnswerForQuestion}
          onCommand={submitApplicationCommand}
          onSteer={submitApplicationSteering}
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

    </div>
  );
}
