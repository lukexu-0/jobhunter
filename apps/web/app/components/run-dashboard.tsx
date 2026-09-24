"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  APPLICATION_STATUSES,
  CreateRunRequestSchema,
  type ApplicationStatus,
  type OpportunityKind,
  type RunDto,
  type SourceHandoffDto,
} from "../lib/pipeline-contracts";
import {
  PipelineClientError,
  approveRun,
  closeApplicationSession,
  completeSourceHandoff,
  createPastedRun,
  createRun,
  createSourceHandoff,
  deleteRun,
  deleteSourceHandoff,
  getContext,
  getApplicationSession,
  retryApplicationSession,
  retryRun,
  startApplicationSession,
  updateApplicationStatus,
  updateRunIdentity,
} from "../lib/pipeline-client";
import { APPLICATION_STATUS_LABELS } from "../lib/application-status";
import { isApplicationSessionOpen } from "../lib/application-session-state";
import { opportunityPresentation } from "../lib/opportunity-presentation";
import { AlertControls } from "./alert-controls";
import { useDashboardData } from "../credentials/dashboard-data-provider";
import type { JobIdentity } from "../lib/run-collection";

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
const MAX_PUBLIC_MESSAGE_LENGTH = 240;
const MAX_CONCURRENT_RUN_CREATIONS = 5;
const MAX_CONCURRENT_SESSION_ENDS = 3;
const MAX_RUNS_PER_SUBMISSION = 100;
const EMPTY_RUNS: RunDto[] = [];
const ROW_INTERACTIVE_SELECTOR = "a, button, input, select, textarea, summary, [contenteditable='true']";
const FOCUSABLE_INTERACTIVE_SELECTOR = "a[href], area[href], button:not(:disabled), input:not(:disabled):not([type='hidden']), select:not(:disabled), textarea:not(:disabled), summary, iframe, audio[controls], video[controls], [contenteditable]:not([contenteditable='false']), [tabindex]";
const SELECTABLE_APPLICATION_STATUSES = APPLICATION_STATUSES.filter((status) => status !== "failed");
const UNAPPLIED_APPLICATION_STATUSES: Partial<Record<ApplicationStatus, true>> = {
  pending: true,
  did_not_apply: true,
  failed: true,
};
const SUBMITTED_APPLICATION_STATUSES: Partial<Record<ApplicationStatus, true>> = {
  applied: true,
  oa_received: true,
  oa_completed: true,
  rejected: true,
  interview: true,
  accepted: true,
};

function isUnappliedRun(run: Pick<RunDto, "applicationStatus">): boolean {
  return UNAPPLIED_APPLICATION_STATUSES[run.applicationStatus] === true;
}

function isSubmittedRun(run: Pick<RunDto, "applicationStatus">): boolean {
  return SUBMITTED_APPLICATION_STATUSES[run.applicationStatus] === true;
}

function isApplyableRun(run: RunDto): boolean {
  return isUnappliedRun(run)
    && (run.status === "approved" || run.status === "review")
    && Boolean(run.jobUrl && run.currentPdfSha256)
    && !isApplicationSessionOpen(run);
}

function isReapplyableRun(run: RunDto): boolean {
  return run.applicationStatus === "applied"
    && (run.status === "approved" || run.status === "review")
    && Boolean(run.jobUrl && run.currentPdfSha256)
    && !isApplicationSessionOpen(run);
}
const PIPELINE_STATUSES = ["tailoring", "awaiting_review", "in_progress", "completed", "failed"] as const;


type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

const PIPELINE_STATUS_LABELS: Readonly<Record<PipelineStatus, string>> = {
  tailoring: "Tailoring",
  awaiting_review: "Awaiting review",
  in_progress: "In-progress",
  completed: "Completed",
  failed: "Failed",
};

function pipelineStatusFor(
  run: Pick<RunDto, "status" | "applicationStatus" | "applicationFailureGeneration">,
): PipelineStatus {
  if (run.status === "failed" || run.applicationFailureGeneration !== undefined) return "failed";
  if (run.status === "review") return "awaiting_review";
  if (run.status !== "approved") return "tailoring";
  return run.applicationStatus === "pending" ? "in_progress" : "completed";
}

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});


type SortDirection = "newest" | "oldest";
type PipelineStatusFilter = PipelineStatus | "all";
type ApplicationStatusFilter = ApplicationStatus | "all";
type IdentityField = "title" | "organization";
type OpportunityKindSelection = OpportunityKind | "auto";
type InitializerSource = "url" | "pasted";

interface EffectiveIdentity {
  readonly title?: string;
  readonly organization?: string;
}



interface ActionMenuState {
  readonly runId: string;
  readonly style: CSSProperties;
}

type RunDialog =
  | {
    readonly kind: "identity";
    readonly runId: string;
    readonly field: IdentityField;
    readonly runName: string;
  }
  | {
    readonly kind: "delete" | "reapply";
    readonly runId: string;
    readonly runName: string;
  };

interface ValidatedCreateRunRequest {
  readonly jobUrl: string;
  readonly opportunityKind?: OpportunityKind;
  readonly generateKeywordMap: boolean;
  readonly skipReview: boolean;
  readonly autoSubmit: boolean;
}

interface ValidatedPastedRunRequest {
  readonly jobTitle: string;
  readonly jobDescription: string;
  readonly generateKeywordMap: boolean;
}

type SourceVerificationFlow =
  | {
      readonly phase: "required";
      readonly request: ValidatedCreateRunRequest;
      readonly sessionEnded: boolean;
    }
  | {
      readonly phase: "awaiting";
      readonly request: ValidatedCreateRunRequest;
      readonly handoff: SourceHandoffDto;
    };

type CreateRunResult =
  | {
    readonly success: true;
    readonly run: RunDto;
  }
  | {
    readonly success: false;
    readonly request: ValidatedCreateRunRequest;
    readonly error: unknown;
  };

function publicMessage(error: unknown, fallback: string): string {
  if (!(error instanceof PipelineClientError)) return fallback;
  const message = error.message.trim();
  if (!message) return fallback;
  return message.slice(0, MAX_PUBLIC_MESSAGE_LENGTH);
}

function sourceVerificationMessage(error: unknown, fallback: string): string {
  if (
    error instanceof PipelineClientError
    && error.code === "SOURCE_HANDOFF_NOT_FOUND"
  ) {
    return "This browser session is no longer available. Cancel, then open a new browser session.";
  }
  return publicMessage(error, fallback);
}


function parseCreateRunRequests(
  value: string,
  opportunityKind: OpportunityKindSelection,
  skipReview: boolean,
  autoSubmit: boolean,
): ValidatedCreateRunRequest[] | null {
  const tokens = value.trim().split(/[,\s]+/u).filter(Boolean);
  if (tokens.length === 0 || tokens.length > MAX_RUNS_PER_SUBMISSION) return null;

  const requests: ValidatedCreateRunRequest[] = [];
  for (const token of tokens) {
    const parsed = CreateRunRequestSchema.safeParse({
      jobUrl: token,
      ...(opportunityKind === "auto" ? {} : { opportunityKind }),
      generateKeywordMap: true,
      skipReview,
      autoSubmit,
    });
    if (!parsed.success || !("jobUrl" in parsed.data)) return null;
    requests.push(parsed.data);
  }
  return requests;
}

function parsePastedRunRequest(
  jobTitle: string,
  jobDescription: string,
  generateKeywordMap: boolean,
): ValidatedPastedRunRequest | null {
  const parsed = CreateRunRequestSchema.safeParse({
    jobTitle,
    jobDescription,
    generateKeywordMap,
  });
  if (!parsed.success || !("jobTitle" in parsed.data)) return null;
  return parsed.data;
}

async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  concurrency: number,
  worker: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!);
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function batchFailureMessage(successCount: number, totalCount: number, error: unknown): string {
  const failure = publicMessage(error, "An opportunity could not be initialized. Try again.");
  return `${successCount} of ${totalCount} applications initialized. ${failure}`.slice(
    0,
    MAX_PUBLIC_MESSAGE_LENGTH,
  );
}

function effectiveRunIdentity(run: RunDto, artifactIdentity: JobIdentity | undefined): EffectiveIdentity {
  return {
    title: run.titleOverride ?? artifactIdentity?.title,
    organization: run.organizationOverride ?? artifactIdentity?.organization,
  };
}
export function RunIdentityLink({
  identity,
  run,
}: {
  readonly identity: EffectiveIdentity;
  readonly run: Pick<RunDto, "id" | "opportunityKind">;
}) {
  const presentation = opportunityPresentation(run.opportunityKind);
  const KindIcon = presentation.icon;
  const title = identity.title ?? presentation.dashboardTitleFallback;
  const accessibleName = title
    ? `${presentation.openNamedPrefix} ${title} ${shortRunId(run.id)}`
    : `${presentation.openFallbackLabel} ${shortRunId(run.id)}`;

  return (
    <Link className="application-link" href={`/runs/${encodeURIComponent(run.id)}`} aria-label={accessibleName}>
      <KindIcon className="application-kind-icon" aria-hidden="true" />
      {title ? (
        <span className="application-link__label">
          {title}
        </span>
      ) : (
        <span className="table-placeholder-line" aria-hidden="true" />
      )}
    </Link>
  );
}


function shortRunId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}


function visiblePageNumbers(currentPage: number, totalPages: number): Array<number | "ellipsis-start" | "ellipsis-end"> {
  if (totalPages <= 5) return Array.from({ length: totalPages }, (_, index) => index + 1);

  const pages: Array<number | "ellipsis-start" | "ellipsis-end"> = [1];
  const rangeStart = Math.max(2, currentPage - 1);
  const rangeEnd = Math.min(totalPages - 1, currentPage + 1);
  if (rangeStart > 2) pages.push("ellipsis-start");
  for (let page = rangeStart; page <= rangeEnd; page += 1) pages.push(page);
  if (rangeEnd < totalPages - 1) pages.push("ellipsis-end");
  pages.push(totalPages);
  return pages;
}

export function RunDashboard() {
  const router = useRouter();
  const {
    runs: runSnapshot, acceptRun, collectCreatedRuns, acceptRemoval, acceptApplicationStarted, jobIdentities,
    isLoadingRuns: isLoading, runsError: loadError, refreshRuns: load, applicationAttention, watchJobIdentities,
  } = useDashboardData();
  const [baselineMissing, setBaselineMissing] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void getContext(controller.signal).then(
      (context) => setBaselineMissing(context.missingSources.includes("resume-baseline")),
      () => {},
    );
    return () => controller.abort();
  }, []);
  useEffect(() => watchJobIdentities(), [watchJobIdentities]);
  const runs = runSnapshot ?? EMPTY_RUNS;
  const applicationCount = useMemo(
    () => runs.reduce((count, run) => count + (isSubmittedRun(run) ? 1 : 0), 0),
    [runs],
  );
  const openSessionRuns = useMemo(() => runs.filter(isApplicationSessionOpen), [runs]);
  const applyableRuns = useMemo(() => runs.filter(isApplyableRun), [runs]);
  const retryableRuns = useMemo(() => runs.filter((run) => run.status === "failed"), [runs]);
  const [query, setQuery] = useState("");
  const [applicationAutoSubmit, setApplicationAutoSubmit] = useState(false);
  const [applicationAutoEnd, setApplicationAutoEnd] = useState(false);
  const [pipelineStatusFilter, setPipelineStatusFilter] = useState<PipelineStatusFilter>("all");
  const [applicationStatusFilter, setApplicationStatusFilter] = useState<ApplicationStatusFilter>("all");
  const [sortDirection, setSortDirection] = useState<SortDirection>("newest");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[0]);
  const [initializerSource, setInitializerSource] = useState<InitializerSource>("url");
  const [jobUrl, setJobUrl] = useState("");
  const [opportunityKind, setOpportunityKind] = useState<OpportunityKindSelection>("auto");
  const [skipReview, setSkipReview] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(false);
  const [jobTitle, setJobTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [generateKeywordMap, setGenerateKeywordMap] = useState(true);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [duplicateCreateRequests, setDuplicateCreateRequests] =
    useState<readonly ValidatedCreateRunRequest[] | null>(null);
  const [sourceVerification, setSourceVerification] =
    useState<SourceVerificationFlow | null>(null);
  const [sourceVerificationAction, setSourceVerificationAction] =
    useState<"open" | "complete" | "cancel" | null>(null);
  const [sourceVerificationError, setSourceVerificationError] =
    useState<string | null>(null);
  const [busyRunIds, setBusyRunIds] = useState<Set<string>>(() => new Set());
  const [runActionError, setRunActionError] = useState<string | null>(null);
  const [isApplyingAll, setIsApplyingAll] = useState(false);
  const [isEndingAllSessions, setIsEndingAllSessions] = useState(false);
  const [isRetryingAll, setIsRetryingAll] = useState(false);
  const [actionMenu, setActionMenu] = useState<ActionMenuState | null>(null);
  const [activeDialog, setActiveDialogState] = useState<RunDialog | null>(null);
  const activeDialogRef = useRef<RunDialog | null>(null);
  const setActiveDialog = useCallback((dialog: RunDialog | null) => {
    activeDialogRef.current = dialog;
    setActiveDialogState(dialog);
  }, []);
  const [editValue, setEditValue] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const duplicateDialogRef = useRef<HTMLDialogElement>(null);
  const duplicateDialogOpenerRef = useRef<HTMLButtonElement>(null);
  const sourceVerificationOpenRef = useRef<HTMLButtonElement>(null);
  const jobUrlInputRef = useRef<HTMLInputElement>(null);
  const sourceVerificationCompleteRef = useRef<HTMLButtonElement>(null);
  const restoreInitializerFocusRef = useRef(false);
  const initializerPendingRef = useRef(false);
  const sourceVerificationActionRef = useRef<"open" | "complete" | "cancel" | null>(null);
  const bulkApplyPendingRef = useRef(false);
  const bulkEndPendingRef = useRef(false);
  const bulkRetryPendingRef = useRef(false);
  const sourceVerificationRef = useRef<SourceVerificationFlow | null>(null);
  const awaitingSourceHandoffIdRef = useRef<string | null>(null);
  const releasedSourceHandoffIdRef = useRef<string | null>(null);
  const sourceHandoffReleaseRequestedRef = useRef(false);
  const sourceHandoffCleanupMountedRef = useRef(false);
  awaitingSourceHandoffIdRef.current = sourceVerification?.phase === "awaiting"
    ? sourceVerification.handoff.id
    : null;
  sourceVerificationRef.current = sourceVerification;
  const commitSourceVerification = useCallback(
    (next: SourceVerificationFlow | null) => {
      sourceVerificationRef.current = next;
      awaitingSourceHandoffIdRef.current = next?.phase === "awaiting"
        ? next.handoff.id
        : null;
      setSourceVerification(next);
    },
    [],
  );
  const editInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const actionTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const scheduleFocusRestoration = useCallback((runId?: string) => {
    const dialog = dialogRef.current;
    let nativeRestorationTarget: Element | null = null;
    if (dialog?.open && dialog.contains(document.activeElement)) {
      // Release modal focus before restoring it; native close may focus its previous opener.
      dialog.close();
      nativeRestorationTarget = document.activeElement;
    }
    window.requestAnimationFrame(() => {
      const focusedElement = document.activeElement;
      if (
        focusedElement
        && focusedElement !== document.body
        && focusedElement.isConnected
        && focusedElement !== nativeRestorationTarget
        && !actionMenuRef.current?.contains(focusedElement)
        && !dialogRef.current?.contains(focusedElement)
      ) return;
      const target = runId
        ? actionTriggerRefs.current.get(runId) ?? searchInputRef.current
        : searchInputRef.current;
      target?.focus();
    });
  }, []);
  const focusSearchApplications = useCallback(() => {
    scheduleFocusRestoration();
  }, [scheduleFocusRestoration]);
  const restoreActionTriggerFocus = useCallback((runId: string) => {
    scheduleFocusRestoration(runId);
  }, [scheduleFocusRestoration]);
  const releaseAwaitingSourceHandoff = useCallback(() => {
    sourceHandoffReleaseRequestedRef.current = true;
    const handoffId = awaitingSourceHandoffIdRef.current;
    if (!handoffId || releasedSourceHandoffIdRef.current === handoffId) return;
    releasedSourceHandoffIdRef.current = handoffId;
    void deleteSourceHandoff(handoffId, true).catch(() => undefined);
  }, []);
  const markReleasedSourceHandoffEnded = useCallback(() => {
    if (sourceVerificationActionRef.current === "cancel") return;
    const verification = sourceVerificationRef.current;
    if (verification?.phase !== "awaiting") return;
    const ended: SourceVerificationFlow = {
      phase: "required",
      request: verification.request,
      sessionEnded: true,
    };
    commitSourceVerification(ended);
    setSourceVerificationError(
      "Browser session ended. Open a new browser session.",
    );
  }, [commitSourceVerification]);
  const handleSourceHandoffPageHide = useCallback(() => {
    releaseAwaitingSourceHandoff();
    markReleasedSourceHandoffEnded();
  }, [markReleasedSourceHandoffEnded, releaseAwaitingSourceHandoff]);
  const handleSourceHandoffPageShow = useCallback((event: PageTransitionEvent) => {
    if (event.persisted && sourceHandoffReleaseRequestedRef.current) {
      markReleasedSourceHandoffEnded();
    }
  }, [markReleasedSourceHandoffEnded]);
  const createRunRequests = useMemo(
    () => parseCreateRunRequests(jobUrl, opportunityKind, skipReview, autoSubmit),
    [autoSubmit, jobUrl, opportunityKind, skipReview],
  );
  const pastedRunRequest = useMemo(
    () => parsePastedRunRequest(jobTitle, jobDescription, generateKeywordMap),
    [generateKeywordMap, jobDescription, jobTitle],
  );
  const isCreateRequestValid = initializerSource === "url"
    ? createRunRequests !== null
    : pastedRunRequest !== null;
  const isInitializerBusy = isCreating || sourceVerification !== null;
  const clearCreateStatus = () => {
    setCreateError(null);
    setCreateSuccess(null);
    setSourceVerificationError(null);
  };
  useEffect(() => {
    sourceHandoffCleanupMountedRef.current = true;
    window.addEventListener("pagehide", handleSourceHandoffPageHide);
    window.addEventListener("pageshow", handleSourceHandoffPageShow);
    return () => {
      window.removeEventListener("pagehide", handleSourceHandoffPageHide);
      window.removeEventListener("pageshow", handleSourceHandoffPageShow);
      sourceHandoffCleanupMountedRef.current = false;
      queueMicrotask(() => {
        if (!sourceHandoffCleanupMountedRef.current) releaseAwaitingSourceHandoff();
      });
    };
  }, [
    handleSourceHandoffPageHide,
    handleSourceHandoffPageShow,
    releaseAwaitingSourceHandoff,
  ]);

  useEffect(() => {
    const verification = sourceVerification;
    if (!verification || sourceVerificationAction !== null) return;
    const focusFrame = window.requestAnimationFrame(() => {
      if (verification.phase === "required") {
        sourceVerificationOpenRef.current?.focus();
      } else {
        sourceVerificationCompleteRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [sourceVerification, sourceVerificationAction]);

  useEffect(() => {
    if (sourceVerification !== null || !restoreInitializerFocusRef.current) return;
    restoreInitializerFocusRef.current = false;
    const focusFrame = window.requestAnimationFrame(() => {
      const initializeButton = duplicateDialogOpenerRef.current;
      if (initializeButton && !initializeButton.disabled) {
        initializeButton.focus();
      } else {
        jobUrlInputRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [sourceVerification]);

  const toggleActionMenu = (runId: string, trigger: HTMLButtonElement) => {
    if (actionMenu?.runId === runId) {
      setActionMenu(null);
      return;
    }
    const bounds = trigger.getBoundingClientRect();
    const right = Math.max(0, window.innerWidth - bounds.right);
    const opensUpward = window.innerHeight - bounds.bottom < bounds.top;
    setActionMenu({
      runId,
      style: opensUpward
        ? { right, bottom: window.innerHeight - bounds.top }
        : { right, top: bounds.bottom },
    });
  };

  const handleActionMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowUp"
          ? (currentIndex - 1 + items.length) % items.length
          : (currentIndex + 1) % items.length;
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  useEffect(() => {
    if (!actionMenu) return;
    const runId = actionMenu.runId;
    const focusFrame = window.requestAnimationFrame(() => {
      actionMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    const dismiss = (restoreFocus = false) => {
      setActionMenu(null);
      if (restoreFocus) restoreActionTriggerFocus(runId);
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (actionMenuRef.current?.contains(target) || actionTriggerRefs.current.get(runId)?.contains(target)) return;
      const targetElement = target instanceof Element ? target : target.parentElement;
      dismiss(!targetElement?.closest(FOCUSABLE_INTERACTIVE_SELECTOR));
    };
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (actionMenuRef.current?.contains(target) || actionTriggerRefs.current.get(runId)?.contains(target)) return;
      dismiss();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss(true);
    };
    const dismissForViewportChange = () => dismiss(true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", dismissForViewportChange);
    window.addEventListener("scroll", dismissForViewportChange, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", dismissForViewportChange);
      window.removeEventListener("scroll", dismissForViewportChange, true);
    };
  }, [actionMenu, restoreActionTriggerFocus]);

  useEffect(() => {
    if (!activeDialog) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const focusFrame = window.requestAnimationFrame(() => {
      if (activeDialog.kind === "identity") {
        editInputRef.current?.focus();
        editInputRef.current?.select();
      } else {
        dialog.querySelector<HTMLButtonElement>("[data-dialog-cancel]")?.focus();
      }
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (dialog.open) dialog.close();
    };
  }, [activeDialog]);

  const openIdentityDialog = (
    run: RunDto,
    identity: EffectiveIdentity,
    field: IdentityField,
  ) => {
    setActionMenu(null);
    setDialogError(null);
    setEditValue(identity[field] ?? "");
    setActiveDialog({
      kind: "identity",
      runId: run.id,
      field,
      runName: identity.title ?? shortRunId(run.id),
    });
  };

  const openDeleteDialog = (run: RunDto, identity: EffectiveIdentity) => {
    setActionMenu(null);
    setDialogError(null);
    setActiveDialog({
      kind: "delete",
      runId: run.id,
      runName: identity.title ?? shortRunId(run.id),
    });
  };

  const openReapplyDialog = (run: RunDto, identity: EffectiveIdentity) => {
    setActionMenu(null);
    setDialogError(null);
    setActiveDialog({
      kind: "reapply",
      runId: run.id,
      runName: identity.title ?? shortRunId(run.id),
    });
  };

  const closeDialog = () => {
    if (activeDialog && busyRunIds.has(activeDialog.runId)) return;
    const runId = activeDialog?.runId;
    setActiveDialog(null);
    setDialogError(null);
    if (runId) restoreActionTriggerFocus(runId);
  };

  const setRunBusy = (runId: string, busy: boolean) => {
    setBusyRunIds((current) => {
      const next = new Set(current);
      if (busy) next.add(runId);
      else next.delete(runId);
      return next;
    });
  };

  const submitIdentityUpdate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (activeDialog?.kind !== "identity" || busyRunIds.has(activeDialog.runId)) return;
    const value = editValue.trim();
    if (value.length < 1 || value.length > 200) {
      setDialogError("Enter 1 to 200 characters.");
      return;
    }
    const submittedDialog = activeDialog;
    const { field, runId } = submittedDialog;
    setRunBusy(runId, true);
    setDialogError(null);
    try {
      const updated = await updateRunIdentity(
        runId,
        field === "title" ? { title: value } : { organization: value },
      );
      acceptRun(updated);
      if (activeDialogRef.current !== submittedDialog) return;
      setActiveDialog(null);
      restoreActionTriggerFocus(runId);
    } catch (error) {
      if (activeDialogRef.current !== submittedDialog) return;
      setDialogError(publicMessage(error, `${field === "title" ? "Title" : "Organization"} could not be updated. Try again.`));
    } finally {
      setRunBusy(runId, false);
    }
  };

  const submitDelete = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (activeDialog?.kind !== "delete" || busyRunIds.has(activeDialog.runId)) return;
    const submittedDialog = activeDialog;
    const { runId } = submittedDialog;
    setRunBusy(runId, true);
    setDialogError(null);
    try {
      await deleteRun(runId);
      acceptRemoval(runId);
      if (activeDialogRef.current !== submittedDialog) return;
      setActiveDialog(null);
      focusSearchApplications();
    } catch (error) {
      if (activeDialogRef.current !== submittedDialog) return;
      setDialogError(publicMessage(error, "The application could not be deleted. Try again."));
    } finally {
      setRunBusy(runId, false);
    }
  };

  const filteredRuns = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return runs
      .filter((run) => (
        pipelineStatusFilter === "all" || pipelineStatusFor(run) === pipelineStatusFilter
      ))
      .filter((run) => (
        applicationStatusFilter === "all" || run.applicationStatus === applicationStatusFilter
      ))
      .filter((run) => {
        if (!normalizedQuery) return true;
        const identity = effectiveRunIdentity(run, jobIdentities[run.id]);
        return [run.id, PIPELINE_STATUS_LABELS[pipelineStatusFor(run)], APPLICATION_STATUS_LABELS[run.applicationStatus], identity.title, identity.organization]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
      })
      .sort((left, right) => {
        const leftBucket = isApplicationSessionOpen(left) ? 0 : left.applicationStatus === "rejected" ? 2 : 1;
        const rightBucket = isApplicationSessionOpen(right) ? 0 : right.applicationStatus === "rejected" ? 2 : 1;
        if (leftBucket !== rightBucket) return leftBucket - rightBucket;
        return sortDirection === "newest"
          ? right.createdAt - left.createdAt
          : left.createdAt - right.createdAt;
      });
  }, [applicationStatusFilter, jobIdentities, pipelineStatusFilter, query, runs, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(filteredRuns.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const visibleRuns = filteredRuns.slice((safePage - 1) * pageSize, safePage * pageSize);
  const firstVisible = filteredRuns.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const lastVisible = Math.min(safePage * pageSize, filteredRuns.length);

  useEffect(() => {
    if (currentPage !== safePage) setCurrentPage(safePage);
  }, [currentPage, safePage]);

  const updateQuery = (value: string) => {
    setQuery(value);
    setCurrentPage(1);
  };

  const updatePipelineStatusFilter = (value: PipelineStatusFilter) => {
    setPipelineStatusFilter(value);
    setCurrentPage(1);
  };

  const updateApplicationStatusFilter = (value: ApplicationStatusFilter) => {
    setApplicationStatusFilter(value);
    setCurrentPage(1);
  };

  const changeApplicationStatus = async (runId: string, applicationStatus: ApplicationStatus) => {
    setRunBusy(runId, true);
    setRunActionError(null);
    try {
      const updated = await updateApplicationStatus(runId, applicationStatus);
      acceptRun(updated);
      setRunActionError(null);
    } catch {
      setRunActionError("Application status could not be updated. Try again.");
    } finally {
      setRunBusy(runId, false);
    }
  };

  const startApplyingToRun = async (run: RunDto, reapply = false): Promise<string | null> => {
    if (!run.currentPdfSha256) return "The resume PDF is unavailable to apply.";
    let applicationPdfSha256 = run.currentPdfSha256;
    if (run.status === "review") {
      const availability = await getApplicationSession(run.id);
      if (!("state" in availability) || !availability.canStartAfterApproval) {
        return "Automatic application is not available for this run yet. Open the run to review what is required.";
      }
      const approved = await approveRun(
        run.id,
        run.currentPdfSha256,
        run.visualAcknowledgementRequired,
      );
      acceptRun(approved);
      if (!approved.currentPdfSha256) {
        return "The resume was approved, but its PDF is unavailable to apply.";
      }
      applicationPdfSha256 = approved.currentPdfSha256;
    }
    const session = await startApplicationSession(run.id, applicationPdfSha256, {
      autoSubmit: applicationAutoSubmit,
      autoEnd: applicationAutoEnd,
      ...(reapply ? { reapply: true } : {}),
    });
    if (
      session.bridgeState === "cancelled"
      || session.bridgeState === "failed"
      || session.bridgeState === "closed"
      || session.bridgeState === "lost"
    ) {
      await retryApplicationSession(run.id, applicationPdfSha256, {
        autoSubmit: applicationAutoSubmit,
        autoEnd: applicationAutoEnd,
      });
    }
    acceptApplicationStarted(run.id);
    return null;
  };

  const applyToRun = async (run: RunDto) => {
    if (!isApplyableRun(run) || busyRunIds.has(run.id)) return;
    setRunBusy(run.id, true);
    setRunActionError(null);
    try {
      const failureMessage = await startApplyingToRun(run);
      if (failureMessage) {
        setRunActionError(failureMessage);
        return;
      }
      await load();
    } catch (error) {
      if (run.status === "review") await load();
      setRunActionError(publicMessage(error, "The application could not be started. Try again."));
    } finally {
      setRunBusy(run.id, false);
    }
  };

  const submitReapply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (activeDialog?.kind !== "reapply" || busyRunIds.has(activeDialog.runId)) return;
    const run = runs.find(({ id }) => id === activeDialog.runId);
    if (!run || !isReapplyableRun(run)) {
      setDialogError("This application is no longer available to reapply.");
      return;
    }
    const submittedDialog = activeDialog;
    const { runId } = submittedDialog;
    setRunBusy(runId, true);
    setDialogError(null);
    try {
      const failureMessage = await startApplyingToRun(run, true);
      if (failureMessage) {
        if (activeDialogRef.current === submittedDialog) setDialogError(failureMessage);
        return;
      }
      await load();
      if (activeDialogRef.current !== submittedDialog) return;
      setActiveDialog(null);
      restoreActionTriggerFocus(runId);
    } catch (error) {
      if (run.status === "review") await load();
      if (activeDialogRef.current !== submittedDialog) return;
      setDialogError(publicMessage(error, "The application could not be restarted. Try again."));
    } finally {
      setRunBusy(runId, false);
    }
  };

  const applyToAllRuns = async () => {
    if (bulkApplyPendingRef.current) return;
    const candidates = applyableRuns
      .filter((run) => !busyRunIds.has(run.id))
      .sort((left, right) => right.createdAt - left.createdAt);
    if (candidates.length === 0) return;
    bulkApplyPendingRef.current = true;
    setIsApplyingAll(true);
    setRunActionError(null);
    setBusyRunIds((current) => {
      const next = new Set(current);
      for (const run of candidates) next.add(run.id);
      return next;
    });
    let failureCount = 0;
    try {
      for (const run of candidates) {
        try {
          if (await startApplyingToRun(run) !== null) failureCount += 1;
        } catch {
          failureCount += 1;
        }
      }
      await load();
      if (failureCount > 0) {
        const successCount = candidates.length - failureCount;
        setRunActionError(
          successCount > 0
            ? successCount + " of " + candidates.length + " applications started; " + failureCount + " could not be started."
            : "No applications could be started. Try each application individually for details.",
        );
      }
    } finally {
      setBusyRunIds((current) => {
        const next = new Set(current);
        for (const run of candidates) next.delete(run.id);
        return next;
      });
      bulkApplyPendingRef.current = false;
      setIsApplyingAll(false);
    }
  };

  const endAllApplicationSessions = async () => {
    if (bulkEndPendingRef.current || openSessionRuns.length === 0) return;
    const candidates = openSessionRuns;
    bulkEndPendingRef.current = true;
    setIsEndingAllSessions(true);
    setRunActionError(null);
    setBusyRunIds((current) => {
      const next = new Set(current);
      for (const run of candidates) next.add(run.id);
      return next;
    });
    try {
      const results = await mapWithConcurrency(
        candidates,
        MAX_CONCURRENT_SESSION_ENDS,
        async (run) => {
          try {
            await closeApplicationSession(run.id);
            return true;
          } catch {
            return false;
          }
        },
      );
      await load();
      const failureCount = results.filter((ended) => !ended).length;
      if (failureCount > 0) {
        const successCount = candidates.length - failureCount;
        setRunActionError(
          successCount > 0
            ? successCount + " of " + candidates.length + " sessions ended; " + failureCount + " could not be ended."
            : "No application sessions could be ended. Try ending each session individually.",
        );
      }
    } finally {
      setBusyRunIds((current) => {
        const next = new Set(current);
        for (const run of candidates) next.delete(run.id);
        return next;
      });
      bulkEndPendingRef.current = false;
      setIsEndingAllSessions(false);
    }
  };

  const retryFailedRun = async (runId: string) => {
    if (busyRunIds.has(runId)) return;
    setRunBusy(runId, true);
    setRunActionError(null);
    try {
      const updated = await retryRun(runId);
      acceptRun(updated);
    } catch (error) {
      setRunActionError(publicMessage(error, "The tailoring run could not be retried. Try again."));
    } finally {
      setRunBusy(runId, false);
    }
  };

  const retryAllFailedRuns = async () => {
    if (bulkRetryPendingRef.current) return;
    const candidates = retryableRuns.filter((run) => !busyRunIds.has(run.id));
    if (candidates.length === 0) return;
    bulkRetryPendingRef.current = true;
    setIsRetryingAll(true);
    setRunActionError(null);
    setBusyRunIds((current) => {
      const next = new Set(current);
      for (const run of candidates) next.add(run.id);
      return next;
    });
    try {
      const results = await Promise.allSettled(candidates.map(async (run) => {
        const updated = await retryRun(run.id);
        acceptRun(updated);
        return updated;
      }));
      const retriedRuns = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const failureCount = candidates.length - retriedRuns.length;
      if (failureCount > 0) {
        setRunActionError(
          retriedRuns.length > 0
            ? retriedRuns.length + " of " + candidates.length + " tailoring runs retried; " + failureCount + " could not be retried."
            : "No tailoring runs could be retried. Try each run individually for details.",
        );
      }
    } finally {
      setBusyRunIds((current) => {
        const next = new Set(current);
        for (const run of candidates) next.delete(run.id);
        return next;
      });
      bulkRetryPendingRef.current = false;
      setIsRetryingAll(false);
    }
  };

  const initializeRuns = async (requests: readonly ValidatedCreateRunRequest[]) => {
    if (isInitializerBusy || initializerPendingRef.current) return;
    initializerPendingRef.current = true;
    setIsCreating(true);
    setCreateError(null);
    setCreateSuccess(null);
    setSourceVerificationError(null);
    try {
      const failures: Extract<CreateRunResult, { success: false }>[] = [];
      const successfulRuns = await collectCreatedRuns(async () => {
        const results = await mapWithConcurrency(
          requests,
          MAX_CONCURRENT_RUN_CREATIONS,
          async (request): Promise<CreateRunResult> => {
            try {
              return {
                success: true,
                run: await createRun(
                  request.jobUrl,
                  request.generateKeywordMap,
                  request.skipReview,
                  request.autoSubmit,
                  request.opportunityKind,
                ),
              };
            } catch (error) {
              return { success: false, request, error };
            }
          },
        );
        const created: RunDto[] = [];
        for (const result of results) {
          if (result.success) created.push(result.run);
          else failures.push(result);
        }
        return created;
      });
      if (successfulRuns.length > 0) void load();

      if (failures.length === 0) {
        setJobUrl("");
        setOpportunityKind("auto");
        setSkipReview(false);
        setAutoSubmit(false);
        const applicationLabel = successfulRuns.length === 1 ? "application" : "applications";
        setCreateSuccess(`${successfulRuns.length} ${applicationLabel} initialized.`);
        return;
      }

      if (requests.length > 1) {
        setJobUrl(failures.map(({ request }) => request.jobUrl).join(", "));
      }
      const verificationFailure = requests.length === 1
        && failures.length === 1
        && failures[0]!.error instanceof PipelineClientError
        && failures[0]!.error.code === "JOB_HUMAN_VERIFICATION_REQUIRED"
        ? failures[0]!
        : null;
      if (verificationFailure) {
        commitSourceVerification({
          phase: "required",
          sessionEnded: false,
          request: verificationFailure.request,
        });
        return;
      }

      setCreateError(
        requests.length === 1
          ? publicMessage(failures[0]!.error, "The opportunity could not be initialized. Try again.")
          : batchFailureMessage(successfulRuns.length, requests.length, failures[0]!.error),
      );
    } finally {
      initializerPendingRef.current = false;
      setIsCreating(false);
    }
  };

  const openSourceVerification = async () => {
    const verification = sourceVerificationRef.current;
    if (
      verification?.phase !== "required"
      || sourceVerificationActionRef.current !== null
    ) return;

    sourceHandoffReleaseRequestedRef.current = false;
    releasedSourceHandoffIdRef.current = null;
    sourceVerificationActionRef.current = "open";
    setSourceVerificationAction("open");
    setSourceVerificationError(null);
    try {
      const handoff = await createSourceHandoff(verification.request);
      if (sourceHandoffReleaseRequestedRef.current) {
        awaitingSourceHandoffIdRef.current = handoff.id;
        releaseAwaitingSourceHandoff();
        return;
      }
      commitSourceVerification({
        phase: "awaiting",
        request: verification.request,
        handoff,
      });
    } catch (error) {
      if (sourceHandoffReleaseRequestedRef.current) return;
      setSourceVerificationError(
        sourceVerificationMessage(error, "The local browser could not be opened. Try again."),
      );
    } finally {
      sourceVerificationActionRef.current = null;
      setSourceVerificationAction(null);
    }
  };

  const completeSourceVerification = async () => {
    const verification = sourceVerification;
    if (
      verification?.phase !== "awaiting"
      || sourceVerificationActionRef.current !== null
    ) return;

    sourceVerificationActionRef.current = "complete";
    setSourceVerificationAction("complete");
    setSourceVerificationError(null);
    try {
      const created = await collectCreatedRuns(async () => {
        const run = await completeSourceHandoff(verification.handoff.id);
        const currentVerification = sourceVerificationRef.current;
        if (
          currentVerification?.phase !== "awaiting"
          || currentVerification.handoff.id !== verification.handoff.id
        ) return [];
        return [run];
      });
      void load();
      if (created.length === 0) return;
      setJobUrl("");
      setOpportunityKind("auto");
      setSkipReview(false);
      setAutoSubmit(false);
      restoreInitializerFocusRef.current = true;
      commitSourceVerification(null);
      setCreateSuccess("1 application initialized.");
    } catch (error) {
      if (sourceHandoffReleaseRequestedRef.current) return;
      if (
        error instanceof PipelineClientError
        && error.code === "SOURCE_HANDOFF_NOT_FOUND"
      ) {
        releasedSourceHandoffIdRef.current = verification.handoff.id;
        commitSourceVerification({
          phase: "required",
          request: verification.request,
          sessionEnded: true,
        });
        setSourceVerificationError(
          "Browser session ended. Open a new browser session.",
        );
      } else {
        setSourceVerificationError(
          sourceVerificationMessage(error, "The description could not be captured. Try again."),
        );
      }
    } finally {
      sourceVerificationActionRef.current = null;
      setSourceVerificationAction(null);
    }
  };

  const cancelSourceVerification = async () => {
    const verification = sourceVerification;
    if (!verification || sourceVerificationActionRef.current !== null) return;

    if (verification.phase === "required") {
      restoreInitializerFocusRef.current = true;
      commitSourceVerification(null);
      setSourceVerificationError(null);
      setCreateSuccess("Browser capture cancelled. The URL and options were kept.");
      return;
    }

    sourceVerificationActionRef.current = "cancel";
    setSourceVerificationAction("cancel");
    setSourceVerificationError(null);
    releasedSourceHandoffIdRef.current = verification.handoff.id;
    try {
      await deleteSourceHandoff(verification.handoff.id);
      restoreInitializerFocusRef.current = true;
      commitSourceVerification(null);
      setCreateSuccess("Browser capture cancelled. The URL and options were kept.");
    } catch (error) {
      if (
        error instanceof PipelineClientError
        && error.code === "SOURCE_HANDOFF_NOT_FOUND"
      ) {
        restoreInitializerFocusRef.current = true;
        commitSourceVerification(null);
        setSourceVerificationError(null);
        setCreateSuccess("Browser session ended. The URL and options were kept.");
      } else if (sourceHandoffReleaseRequestedRef.current) {
        commitSourceVerification({
          phase: "required",
          request: verification.request,
          sessionEnded: true,
        });
        setSourceVerificationError(
          "Browser session ended. Open a new browser session.",
        );
      } else {
        setSourceVerificationError(
          sourceVerificationMessage(error, "Browser capture could not be cancelled. Try again."),
        );
        if (releasedSourceHandoffIdRef.current === verification.handoff.id) {
          releasedSourceHandoffIdRef.current = null;
        }
      }
    } finally {
      sourceVerificationActionRef.current = null;
      setSourceVerificationAction(null);
    }
  };

  const initializePastedRun = async (request: ValidatedPastedRunRequest) => {
    if (isInitializerBusy || initializerPendingRef.current) return;
    initializerPendingRef.current = true;
    setIsCreating(true);
    clearCreateStatus();
    try {
      await collectCreatedRuns(async () => [await createPastedRun(
        request.jobTitle,
        request.jobDescription,
        request.generateKeywordMap,
      )]);
      void load();
      setJobTitle("");
      setJobDescription("");
      setGenerateKeywordMap(true);
      setCreateSuccess("1 application initialized.");
    } catch (error) {
      setCreateError(publicMessage(error, "The pasted job could not be initialized. Try again."));
    } finally {
      initializerPendingRef.current = false;
      setIsCreating(false);
    }
  };

  const dismissDuplicateDialog = () => {
    if (duplicateDialogRef.current?.open) duplicateDialogRef.current.close();
    setDuplicateCreateRequests(null);
    duplicateDialogOpenerRef.current?.focus();
  };

  const submitRun = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isInitializerBusy || initializerPendingRef.current) return;
    if (initializerSource === "pasted") {
      if (pastedRunRequest) void initializePastedRun(pastedRunRequest);
      return;
    }
    if (!createRunRequests) return;
    const knownJobUrls = new Set(
      runs.flatMap((run) => run.jobUrl === undefined ? [] : [run.jobUrl]),
    );
    const hasDuplicate = createRunRequests.some((request) => {
      if (knownJobUrls.has(request.jobUrl)) return true;
      knownJobUrls.add(request.jobUrl);
      return false;
    });
    if (hasDuplicate) {
      setDuplicateCreateRequests(createRunRequests);
      if (!duplicateDialogRef.current?.open) duplicateDialogRef.current?.showModal();
      return;
    }
    void initializeRuns(createRunRequests);
  };

  const confirmDuplicateRun = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isInitializerBusy || initializerPendingRef.current || !duplicateCreateRequests) return;
    const requests = duplicateCreateRequests;
    if (duplicateDialogRef.current?.open) duplicateDialogRef.current.close();
    setDuplicateCreateRequests(null);
    void initializeRuns(requests);
  };

  const showFilteredEmpty = !isLoading && runs.length > 0 && filteredRuns.length === 0;
  const showInitialEmpty = !isLoading && !loadError && runs.length === 0;
  const actionMenuRun = actionMenu ? visibleRuns.find((run) => run.id === actionMenu.runId) : undefined;
  const actionMenuIdentity = actionMenuRun
    ? effectiveRunIdentity(actionMenuRun, jobIdentities[actionMenuRun.id])
    : undefined;

  useEffect(() => {
    if (!actionMenu || actionMenuRun) return;
    const { runId } = actionMenu;
    setActionMenu(null);
    restoreActionTriggerFocus(runId);
  }, [actionMenu, actionMenuRun, restoreActionTriggerFocus]);
  useEffect(() => {
    if (!activeDialog || runs.some((run) => run.id === activeDialog.runId)) return;
    setActiveDialog(null);
    setDialogError(null);
    focusSearchApplications();
  }, [activeDialog, focusSearchApplications, runs]);
  const normalizedEditValue = editValue.trim();
  const isEditValueValid = normalizedEditValue.length >= 1 && normalizedEditValue.length <= 200;
  const isDialogBusy = Boolean(activeDialog && busyRunIds.has(activeDialog.runId));

  return (
    <main className="workspace">
      <header className="applications-header">
        <h1>Applications</h1>
        <AlertControls className="applications-header__alert-controls" />
      </header>

      {baselineMissing ? (
        <p className="dashboard-notice" role="status">
          Place your own generic resume.tex at <code>.jobhunt-data/user-info/resume-main/resume.tex</code>.
          This baseline is required before creating an application. Reload this page after adding it.
        </p>
      ) : null}

      <form
        className={`run-initializer run-initializer--${initializerSource}`}
        aria-label="Initialize applications"
        noValidate
        onSubmit={(event) => void submitRun(event)}
      >
        <label className="select-control run-initializer__source">
          <span>Initialize from</span>
          <select
            aria-label="Initialize from"
            value={initializerSource}
            disabled={isInitializerBusy}
            onChange={(event) => {
              setInitializerSource(event.currentTarget.value as InitializerSource);
              setDuplicateCreateRequests(null);
              clearCreateStatus();
            }}
          >
            <option value="url">Opportunity URL(s)</option>
            <option value="pasted">Paste job details</option>
          </select>
        </label>

        {initializerSource === "url" ? (
          <>
            <div className="run-initializer__field">
              <label className="run-initializer__label" htmlFor="job-url">Opportunity URLs</label>
              <input
                ref={jobUrlInputRef}
                id="job-url"
                type="text"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="https://example.com/opportunities/ship-it, https://example.com/events/demo-day"
                value={jobUrl}
                disabled={isInitializerBusy}
                aria-invalid={createError ? true : undefined}
                aria-describedby={
                  createError
                    ? "job-url-error"
                    : sourceVerification
                      ? "source-verification-description"
                      : createSuccess
                        ? "job-url-success"
                        : undefined
                }
                aria-errormessage={createError ? "job-url-error" : undefined}
                onChange={(event) => {
                  setJobUrl(event.target.value);
                  clearCreateStatus();
                }}
              />
            </div>

            <label className="select-control run-initializer__kind">
              <span>Opportunity type</span>
              <select
                aria-label="Opportunity type"
                value={opportunityKind}
                disabled={isInitializerBusy}
                onChange={(event) => {
                  setOpportunityKind(event.currentTarget.value as OpportunityKindSelection);
                  clearCreateStatus();
                }}
              >
                <option value="auto">Auto-detect</option>
                <option value="job">Job</option>
                <option value="hackathon">Hackathon</option>
                <option value="competition">Competition</option>
                <option value="event">Event</option>
                <option value="networking_event">Networking event</option>
              </select>
            </label>

            <fieldset className="run-initializer__options">
              <legend className="run-initializer__label">Run options</legend>
              <div className="run-initializer__option-list">
                <label className="run-initializer__mode">
                  <input
                    type="checkbox"
                    aria-describedby="skip-review-description"
                    aria-labelledby="skip-review-label"
                    checked={skipReview}
                    disabled={isInitializerBusy}
                    onChange={(event) => {
                      setSkipReview(event.currentTarget.checked);
                      clearCreateStatus();
                    }}
                  />
                  <span className="run-initializer__mode-copy">
                    <span className="run-initializer__mode-title" id="skip-review-label">Skip résumé review</span>
                    <span className="run-initializer__mode-description" id="skip-review-description">
                      Automatically approves only when automated résumé checks pass, then starts the application.
                    </span>
                  </span>
                </label>
                <label className="run-initializer__mode">
                  <input
                    type="checkbox"
                    aria-describedby="auto-submit-description"
                    aria-labelledby="auto-submit-label"
                    checked={autoSubmit}
                    disabled={isInitializerBusy}
                    onChange={(event) => {
                      setAutoSubmit(event.currentTarget.checked);
                      clearCreateStatus();
                    }}
                  />
                  <span className="run-initializer__mode-copy">
                    <span className="run-initializer__mode-title" id="auto-submit-label">Auto-submit application</span>
                    <span className="run-initializer__mode-description" id="auto-submit-description">
                      Submits only when the application has no blockers.
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>
          </>
        ) : (
          <>
            <div className="run-initializer__pasted-fields">
              <div className="run-initializer__paste-field">
                <label className="run-initializer__label" htmlFor="job-title">Job title</label>
                <input
                  id="job-title"
                  type="text"
                  required
                  maxLength={200}
                  value={jobTitle}
                  disabled={isInitializerBusy}
                  aria-invalid={createError ? true : undefined}
                  aria-describedby={createError ? "pasted-job-error" : createSuccess ? "pasted-job-success" : undefined}
                  aria-errormessage={createError ? "pasted-job-error" : undefined}
                  onChange={(event) => {
                    setJobTitle(event.currentTarget.value);
                    clearCreateStatus();
                  }}
                />
              </div>
              <div className="run-initializer__paste-field">
                <label className="run-initializer__label" htmlFor="job-description">Job description</label>
                <textarea
                  id="job-description"
                  required
                  minLength={40}
                  maxLength={50_000}
                  value={jobDescription}
                  disabled={isInitializerBusy}
                  aria-invalid={createError ? true : undefined}
                  aria-describedby={createError ? "pasted-job-error" : createSuccess ? "pasted-job-success" : undefined}
                  aria-errormessage={createError ? "pasted-job-error" : undefined}
                  onChange={(event) => {
                    setJobDescription(event.currentTarget.value);
                    clearCreateStatus();
                  }}
                />
              </div>
            </div>

            <fieldset className="run-initializer__options run-initializer__options--pasted">
              <legend className="run-initializer__label">Run options</legend>
              <div className="run-initializer__option-list">
                <label className="run-initializer__mode">
                  <input
                    type="checkbox"
                    aria-describedby="generate-keyword-map-description"
                    aria-labelledby="generate-keyword-map-label"
                    checked={generateKeywordMap}
                    disabled={isInitializerBusy}
                    onChange={(event) => {
                      setGenerateKeywordMap(event.currentTarget.checked);
                      clearCreateStatus();
                    }}
                  />
                  <span className="run-initializer__mode-copy">
                    <span className="run-initializer__mode-title" id="generate-keyword-map-label">
                      Generate keyword map
                    </span>
                    <span className="run-initializer__mode-description" id="generate-keyword-map-description">
                      Build a resume-to-job-description keyword map before tailoring.
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>
          </>
        )}

        <button
          ref={duplicateDialogOpenerRef}
          className="square-control square-control--primary"
          type="submit"
          disabled={isInitializerBusy || !isCreateRequestValid}
        >
          {isCreating ? "Initializing…" : sourceVerification ? "Verification required" : "Initialize"}
        </button>
        {sourceVerification ? (
          <section
            aria-labelledby="source-verification-heading"
            className="run-initializer__verification"
          >
            <h2 id="source-verification-heading">Human verification required</h2>
            {sourceVerification.phase === "required" ? (
              <>
                <p id="source-verification-description" role="status">
                  This site requires a verification step that Jobhunt will not attempt. Open the trusted local browser and complete the verification manually.
                </p>
                <div className="run-initializer__verification-actions">
                  <button
                    ref={sourceVerificationOpenRef}
                    className="square-control square-control--primary"
                    disabled={sourceVerificationAction !== null}
                    onClick={() => void openSourceVerification()}
                    type="button"
                  >
                    {sourceVerificationAction === "open" ? "Opening verification browser…" : "Open verification browser"}
                  </button>
                  {sourceVerification.sessionEnded ? null : (
                    <button
                      className="square-control"
                      disabled={sourceVerificationAction !== null}
                      onClick={() => void cancelSourceVerification()}
                      type="button"
                    >
                      Cancel verification
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <h3>Complete verification in the local browser</h3>
                <p id="source-verification-description" role="status">
                  A trusted local browser window is open. Complete the site's verification there, then return here and confirm below.
                </p>
                <div className="run-initializer__verification-actions">
                  <button
                    ref={sourceVerificationCompleteRef}
                    className="square-control square-control--primary"
                    disabled={sourceVerificationAction !== null}
                    onClick={() => void completeSourceVerification()}
                    type="button"
                  >
                    {sourceVerificationAction === "complete" ? "Completing verification…" : "I've completed verification"}
                  </button>
                  <button
                    className="square-control"
                    disabled={sourceVerificationAction !== null}
                    onClick={() => void cancelSourceVerification()}
                    type="button"
                  >
                    {sourceVerificationAction === "cancel" ? "Cancelling verification…" : "Cancel verification"}
                  </button>
                </div>
              </>
            )}
            {sourceVerificationError ? (
              <p className="dashboard-alert" role="alert">
                {sourceVerificationError}
              </p>
            ) : null}
          </section>
        ) : null}
        {createError ? (
          <p
            className="dashboard-alert"
            id={initializerSource === "url" ? "job-url-error" : "pasted-job-error"}
            role="alert"
          >
            {createError}
          </p>
        ) : null}
        {createSuccess ? (
          <p
            className="dashboard-notice dashboard-notice--success"
            id={initializerSource === "url" ? "job-url-success" : "pasted-job-success"}
            role="status"
          >
            {createSuccess}
          </p>
        ) : null}
      </form>

      {openSessionRuns.length > 0 ? (
        <section className="active-applications" aria-labelledby="active-applications-heading">
          <header className="active-applications__header">
            <h2 id="active-applications-heading">Open application sessions</h2>
            <span className="active-applications__count">{openSessionRuns.length} open</span>
            <button
              className="square-control bulk-action-control active-applications__end-all"
              type="button"
              aria-label="End all"
              disabled={isEndingAllSessions || isApplyingAll}
              onClick={() => { void endAllApplicationSessions(); }}
            >
              {isEndingAllSessions ? "Ending…" : "End all"}
            </button>
          </header>
          <ul className="active-applications__list">
            {openSessionRuns.map((run) => {
              const identity = effectiveRunIdentity(run, jobIdentities[run.id]);
              const presentation = opportunityPresentation(run.opportunityKind);
              const KindIcon = presentation.icon;
              const title = identity.title ?? presentation.titleFallback;
              const organization = identity.organization ?? presentation.organizationFallback;
              const needsAttention = applicationAttention.has(run.id);
              return (
                <li key={run.id}>
                  <Link
                    className="active-application"
                    data-needs-attention={needsAttention || undefined}
                    href={`/runs/${encodeURIComponent(run.id)}`}
                    aria-label={`${needsAttention ? "Needs attention. " : ""}View application: ${title}, ${organization} (${shortRunId(run.id)})`}
                  >
                    <KindIcon className="application-kind-icon" aria-hidden="true" />
                    <span className="active-application__identity">
                      <span className="active-application__title">{title}</span>
                      <span className="active-application__organization">{organization}</span>
                      {needsAttention ? <span className="active-application__attention">Needs attention</span> : null}
                    </span>
                    <span className="active-application__action">
                      View application <span aria-hidden="true">→</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

        <section className="applications-summary" aria-label="Resume and application counts">
          <div className="applications-summary__metric" role="group" aria-labelledby="total-resumes-label">
            <p className="applications-total">{isLoading || (loadError && runs.length === 0) ? "—" : runs.length.toLocaleString()}</p>
            <p className="applications-label" id="total-resumes-label">Total resumes</p>
          </div>
          <div className="applications-summary__metric" role="group" aria-labelledby="applications-count-label">
            <p className="applications-total">{isLoading || (loadError && runs.length === 0) ? "—" : applicationCount.toLocaleString()}</p>
            <p className="applications-label" id="applications-count-label">Applications</p>
          </div>
        </section>

        <section className="applications-list" aria-labelledby="applications-list-heading">
          <h2 className="visually-hidden" id="applications-list-heading">Application runs</h2>
          <div className="applications-toolbar">
            <div className="applications-toolbar__primary">
              <label className="search-control">
                <span className="visually-hidden">Search applications</span>
                <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18">
                  <circle cx="11" cy="11" r="6.5" />
                  <path d="m16 16 4 4" />
                </svg>
                <input
                  ref={searchInputRef}
                  type="search"
                  value={query}
                  placeholder="Search applications"
                  onChange={(event) => updateQuery(event.target.value)}
                />
              </label>
              <div className="application-defaults" aria-label="Application defaults">
                <label className="application-default-toggle">
                  <input
                    type="checkbox"
                    aria-label="Auto-submit applications"
                    checked={applicationAutoSubmit}
                    onChange={(event) => setApplicationAutoSubmit(event.currentTarget.checked)}
                  />
                  <span>Auto-submit</span>
                </label>
                <label className="application-default-toggle">
                  <input
                    type="checkbox"
                    aria-label="Auto-end successful sessions"
                    checked={applicationAutoEnd}
                    onChange={(event) => setApplicationAutoEnd(event.currentTarget.checked)}
                  />
                  <span>Auto-end</span>
                </label>
              </div>
            </div>
            <div className="applications-toolbar__actions">
              <button
                className="square-control bulk-action-control"
                type="button"
                aria-label="Retry all"
                disabled={isRetryingAll || !retryableRuns.some((run) => !busyRunIds.has(run.id))}
                onClick={() => { void retryAllFailedRuns(); }}
              >
                Retry all
              </button>
              <button
                className="square-control square-control--primary bulk-action-control"
                type="button"
                aria-label="Apply all"
                disabled={isApplyingAll || !applyableRuns.some((run) => !busyRunIds.has(run.id))}
                onClick={() => { void applyToAllRuns(); }}
              >
                Apply all
              </button>
              <label className="select-control">
                <span>Pipeline status</span>
                <select
                  aria-label="Filter applications by pipeline status"
                  value={pipelineStatusFilter}
                  onChange={(event) => updatePipelineStatusFilter(event.target.value as PipelineStatusFilter)}
                >
                  <option value="all">All pipeline statuses</option>
                  {PIPELINE_STATUSES.map((status) => (
                    <option value={status} key={status}>{PIPELINE_STATUS_LABELS[status]}</option>
                  ))}
                </select>
              </label>
              <label className="select-control">
                <span>Application status</span>
                <select
                  aria-label="Filter applications by application status"
                  value={applicationStatusFilter}
                  onChange={(event) => updateApplicationStatusFilter(event.target.value as ApplicationStatusFilter)}
                >
                  <option value="all">All application statuses</option>
                  {SELECTABLE_APPLICATION_STATUSES.map((status) => (
                    <option value={status} key={status}>{APPLICATION_STATUS_LABELS[status]}</option>
                  ))}
                </select>
              </label>
              <label className="select-control">
                <span>Per page</span>
                <select
                  aria-label="Applications per page"
                  value={pageSize}
                  onChange={(event) => {
                    setPageSize(Number(event.target.value));
                    setCurrentPage(1);
                  }}
                >
                  {PAGE_SIZE_OPTIONS.map((option) => (
                    <option value={option} key={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label className="select-control">
                <span>Sort</span>
                <select
                  aria-label="Sort applications"
                  value={sortDirection}
                  onChange={(event) => {
                    setSortDirection(event.target.value === "oldest" ? "oldest" : "newest");
                    setCurrentPage(1);
                  }}
                >
                  <option value="newest">Date added: newest</option>
                  <option value="oldest">Date added: oldest</option>
                </select>
              </label>
            </div>
          </div>

          {loadError && runs.length > 0 ? (
            <div className="dashboard-alert dashboard-alert--toolbar" role="alert">
              <span>{loadError}</span>
              <button className="inline-control" type="button" onClick={() => void load()}>Retry</button>
            </div>
          ) : null}

          {runActionError ? (
            <div className="dashboard-alert dashboard-alert--toolbar" role="alert" aria-label="Run action error">
              <span>{runActionError}</span>
            </div>
          ) : null}

            <div className="applications-table-scroll">
              <table className="applications-table" aria-busy={isLoading}>
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    <th scope="col">Organization</th>
                    <th scope="col">Added</th>
                    <th scope="col">Pipeline status</th>
                    <th scope="col">Application status</th>
                    <th scope="col"><span className="visually-hidden">Application actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {loadError && runs.length === 0 ? (
                    <tr>
                      <td colSpan={6}>
                        <div className="applications-state applications-state--table" role="alert">
                          <p>{loadError}</p>
                          <button className="square-control" type="button" onClick={() => void load(true)}>Try again</button>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {isLoading && !(loadError && runs.length === 0) ? (
                    <tr>
                      <td colSpan={6}>
                        <div className="applications-state applications-state--table" role="status">Loading applications…</div>
                      </td>
                    </tr>
                  ) : null}
                  {showInitialEmpty ? (
                    <tr>
                      <td colSpan={6}>
                        <div className="applications-state applications-state--table">
                          <p>No applications yet. Enter an opportunity URL above to initialize one.</p>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {showFilteredEmpty ? (
                    <tr>
                      <td colSpan={6}>
                        <div className="applications-state applications-state--table">
                          <p>No applications match the current search and statuses.</p>
                          <button className="inline-control" type="button" onClick={() => {
                            updateQuery("");
                            updatePipelineStatusFilter("all");
                            updateApplicationStatusFilter("all");
                          }}>Clear filters</button>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {!isLoading ? visibleRuns.map((run) => {
                    const identity = effectiveRunIdentity(run, jobIdentities[run.id]);
                    const presentation = opportunityPresentation(run.opportunityKind);
                    const href = `/runs/${encodeURIComponent(run.id)}`;
                    const organization =
                      identity.organization ?? presentation.dashboardOrganizationFallback;
                    const pipelineStatus = pipelineStatusFor(run);
                    return (
                      <tr
                        key={run.id}
                        onClick={(event) => {
                          const target = event.target;
                          if (target instanceof Element && target.closest(ROW_INTERACTIVE_SELECTOR)) return;
                          if (event.metaKey || event.ctrlKey) {
                            window.open(href, "_blank", "noopener,noreferrer");
                          } else {
                            router.push(href);
                          }
                        }}
                      >
                        <td>
                          <RunIdentityLink identity={identity} run={run} />
                        </td>
                        <td>{
                          organization
                            ? <span className="application-organization-name">{organization}</span>
                            : <span className="table-placeholder-line table-placeholder-line--organization" role="img" aria-label="Unknown organization" />
                        }</td>
                        <td><time dateTime={new Date(run.createdAt).toISOString()}>{DATE_FORMATTER.format(new Date(run.createdAt))}</time></td>
                        <td>
                          <span
                            aria-label={`Pipeline status for ${shortRunId(run.id)}: ${PIPELINE_STATUS_LABELS[pipelineStatus]}`}
                            className={`pipeline-status-badge pipeline-status-badge--${pipelineStatus}`}
                          >
                            {PIPELINE_STATUS_LABELS[pipelineStatus]}
                          </span>
                        </td>
                        <td>
                          <select
                            aria-label={`Application status for ${shortRunId(run.id)}`}
                            className={`application-status-control application-status-control--${run.applicationStatus}`}
                            value={run.applicationStatus}
                            disabled={busyRunIds.has(run.id)}
                            onChange={(event) => {
                              void changeApplicationStatus(run.id, event.target.value as ApplicationStatus);
                            }}
                          >
                            {run.applicationStatus === "failed" ? <option value="failed" disabled>{APPLICATION_STATUS_LABELS.failed}</option> : null}
                            {SELECTABLE_APPLICATION_STATUSES.map((status) => (
                              <option value={status} key={status}>{APPLICATION_STATUS_LABELS[status]}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <div className="run-row-actions">
                            {isApplyableRun(run) ? (
                              <button
                                className="run-action-trigger run-apply-button"
                                type="button"
                                aria-label={`Apply for ${identity.title ?? presentation.dashboardTitleFallback ?? shortRunId(run.id)}`}
                                disabled={busyRunIds.has(run.id)}
                                onClick={() => { void applyToRun(run); }}
                              >
                                Apply
                              </button>
                            ) : null}
                            {isReapplyableRun(run) ? (
                              <button
                                className="run-action-trigger run-apply-button"
                                type="button"
                                aria-label={`Reapply for ${identity.title ?? presentation.dashboardTitleFallback ?? shortRunId(run.id)}`}
                                disabled={busyRunIds.has(run.id)}
                                onClick={() => { openReapplyDialog(run, identity); }}
                              >
                                Reapply
                              </button>
                            ) : null}
                            {run.status === "failed" ? (
                              <button
                                className="run-action-trigger run-retry-button"
                                type="button"
                                aria-label={`Retry tailoring for ${shortRunId(run.id)}`}
                                disabled={busyRunIds.has(run.id)}
                                onClick={() => { void retryFailedRun(run.id); }}
                              >
                                Retry
                              </button>
                            ) : null}
                            <button
                              ref={(element) => {
                                if (element) actionTriggerRefs.current.set(run.id, element);
                                else actionTriggerRefs.current.delete(run.id);
                              }}
                              className="run-action-trigger"
                              type="button"
                              aria-label={`Actions for ${identity.title ?? presentation.dashboardTitleFallback ?? shortRunId(run.id)}`}
                              aria-haspopup="menu"
                              aria-expanded={actionMenu?.runId === run.id}
                              aria-controls={`run-actions-${encodeURIComponent(run.id)}`}
                              disabled={busyRunIds.has(run.id)}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleActionMenu(run.id, event.currentTarget);
                              }}
                            >
                              <svg aria-hidden="true" viewBox="0 0 24 24">
                                <circle cx="5" cy="12" r="1.5" />
                                <circle cx="12" cy="12" r="1.5" />
                                <circle cx="19" cy="12" r="1.5" />
                              </svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  }) : null}
                </tbody>
              </table>
            </div>

          {!isLoading && filteredRuns.length > 0 ? (
            <nav className="applications-pagination" aria-label="Applications pagination">
              <p>Showing {firstVisible} to {lastVisible} of {filteredRuns.length.toLocaleString()} applications</p>
              <div className="pagination-controls">
                <button type="button" aria-label="Previous page" disabled={safePage === 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}>←</button>
                {visiblePageNumbers(safePage, totalPages).map((page) => typeof page === "number" ? (
                  <button
                    type="button"
                    key={page}
                    aria-label={`Page ${page}`}
                    aria-current={page === safePage ? "page" : undefined}
                    onClick={() => setCurrentPage(page)}
                  >
                    {page}
                  </button>
                ) : <span aria-hidden="true" key={page}>…</span>)}
                <button type="button" aria-label="Next page" disabled={safePage === totalPages} onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}>→</button>
              </div>
            </nav>
          ) : null}
        </section>

      {actionMenu && actionMenuRun && actionMenuIdentity && typeof document !== "undefined"
        ? createPortal(
          <div
            ref={actionMenuRef}
            className="run-action-menu"
            id={`run-actions-${encodeURIComponent(actionMenuRun.id)}`}
            role="menu"
            aria-label={`Actions for ${actionMenuIdentity.title ?? shortRunId(actionMenuRun.id)}`}
            style={actionMenu.style}
            onKeyDown={handleActionMenuKeyDown}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => openIdentityDialog(actionMenuRun, actionMenuIdentity, "title")}
            >
              Edit title
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => openIdentityDialog(actionMenuRun, actionMenuIdentity, "organization")}
            >
              Edit organization
            </button>
            <button
              className="run-action-menu__danger"
              type="button"
              role="menuitem"
              onClick={() => openDeleteDialog(actionMenuRun, actionMenuIdentity)}
            >
              Delete
            </button>
          </div>,
          document.body,
        )
        : null}

      <dialog
        ref={duplicateDialogRef}
        className="run-action-dialog"
        aria-labelledby="duplicate-application-dialog-title"
        aria-describedby="duplicate-application-dialog-description"
        onCancel={(event) => {
          event.preventDefault();
          dismissDuplicateDialog();
        }}
      >
        <form className="run-action-dialog__form" onSubmit={confirmDuplicateRun}>
          <header className="run-action-dialog__header">
            <h2 id="duplicate-application-dialog-title">
              {duplicateCreateRequests && duplicateCreateRequests.length > 1
                ? "Initialize duplicate applications?"
                : "Initialize duplicate application?"}
            </h2>
          </header>
          <div className="run-action-dialog__body">
            <p id="duplicate-application-dialog-description">
              {duplicateCreateRequests && duplicateCreateRequests.length > 1
                ? "One or more opportunity URLs have already been used. Initialize these applications anyway?"
                : "This opportunity URL has already been used. Initialize another application anyway?"}
            </p>
          </div>
          <footer className="run-action-dialog__actions">
            <button className="square-control" type="button" onClick={dismissDuplicateDialog}>
              Cancel
            </button>
            <button
              className="square-control square-control--primary"
              type="submit"
              disabled={isCreating || !duplicateCreateRequests}
            >
              Initialize anyway
            </button>
          </footer>
        </form>
      </dialog>

      {activeDialog ? (
        <dialog
          ref={dialogRef}
          className="run-action-dialog"
          aria-labelledby="run-action-dialog-title"
          aria-describedby={activeDialog.kind === "identity" ? undefined : "run-action-dialog-description"}
          onCancel={(event) => {
            event.preventDefault();
            closeDialog();
          }}
        >
          {activeDialog.kind === "identity" ? (
            <form className="run-action-dialog__form" noValidate onSubmit={(event) => void submitIdentityUpdate(event)}>
              <header className="run-action-dialog__header">
                <p className="applications-label">Application identity</p>
                <h2 id="run-action-dialog-title">Edit application {activeDialog.field}</h2>
              </header>
              <div className="run-action-dialog__body">
                <label htmlFor="run-identity-value">
                  {activeDialog.field === "title" ? "Title" : "Organization"}
                </label>
                <input
                  ref={editInputRef}
                  id="run-identity-value"
                  type="text"
                  value={editValue}
                  minLength={1}
                  maxLength={200}
                  required
                  autoComplete="off"
                  disabled={isDialogBusy}
                  aria-invalid={dialogError ? true : undefined}
                  aria-describedby={dialogError ? "run-identity-hint run-action-dialog-error" : "run-identity-hint"}
                  onChange={(event) => {
                    setEditValue(event.target.value);
                    setDialogError(null);
                  }}
                />
                <p className="run-action-dialog__hint" id="run-identity-hint">
                  1–200 characters. Leading and trailing spaces are removed.
                </p>
                {dialogError ? <p className="run-action-dialog__error" id="run-action-dialog-error" role="alert">{dialogError}</p> : null}
              </div>
              <footer className="run-action-dialog__actions">
                <button className="square-control" data-dialog-cancel type="button" disabled={isDialogBusy} onClick={closeDialog}>Cancel</button>
                <button className="square-control square-control--primary" type="submit" disabled={isDialogBusy || !isEditValueValid}>
                  {isDialogBusy ? "Saving…" : "Save"}
                </button>
              </footer>
            </form>
          ) : activeDialog.kind === "reapply" ? (
            <form className="run-action-dialog__form" onSubmit={(event) => void submitReapply(event)}>
              <header className="run-action-dialog__header">
                <p className="applications-label">Repeat application</p>
                <h2 id="run-action-dialog-title">Reapply to {activeDialog.runName}?</h2>
              </header>
              <div className="run-action-dialog__body">
                <p id="run-action-dialog-description">
                  This starts another application even though this run is already marked applied. Continue only if you intend to submit again.
                </p>
                {dialogError ? <p className="run-action-dialog__error" id="run-action-dialog-error" role="alert">{dialogError}</p> : null}
              </div>
              <footer className="run-action-dialog__actions">
                <button className="square-control" data-dialog-cancel type="button" disabled={isDialogBusy} onClick={closeDialog}>Cancel</button>
                <button className="square-control square-control--primary" type="submit" disabled={isDialogBusy}>
                  {isDialogBusy ? "Reapplying…" : "Reapply"}
                </button>
              </footer>
            </form>
          ) : (
            <form className="run-action-dialog__form" onSubmit={(event) => void submitDelete(event)}>
              <header className="run-action-dialog__header">
                <p className="applications-label">Permanent dashboard action</p>
                <h2 id="run-action-dialog-title">Delete application?</h2>
              </header>
              <div className="run-action-dialog__body">
                <p id="run-action-dialog-description">
                  Delete <strong>{activeDialog.runName}</strong> from the dashboard? Its immutable run history and artifacts are retained by the pipeline.
                </p>
                {dialogError ? <p className="run-action-dialog__error" id="run-action-dialog-error" role="alert">{dialogError}</p> : null}
              </div>
              <footer className="run-action-dialog__actions">
                <button className="square-control" data-dialog-cancel type="button" disabled={isDialogBusy} onClick={closeDialog}>Cancel</button>
                <button className="square-control square-control--danger" type="submit" disabled={isDialogBusy}>
                  {isDialogBusy ? "Deleting…" : "Delete application"}
                </button>
              </footer>
            </form>
          )}
        </dialog>
      ) : null}

    </main>
  );
}
