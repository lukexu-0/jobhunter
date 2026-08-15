"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { APPLICATION_STATUSES, CreateRunRequestSchema, type ApplicationStatus, type ArtifactDto, type OpportunityKind, type RunDto, type RunStatus } from "@jobhunter/pipeline/contracts";
import { PipelineClientError, createPastedRun, createRun, deleteRun, listRuns, readJsonArtifact, updateApplicationStatus, updateRunIdentity } from "../lib/pipeline-client";
import { APPLICATION_STATUS_LABELS } from "../lib/application-status";
import { opportunityPresentation } from "../lib/opportunity-presentation";
import { useDashboardData, type JobIdentity } from "../providers/dashboard-data-provider";

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
const POLL_INTERVAL_MS = 3_000;
const MAX_PUBLIC_MESSAGE_LENGTH = 240;
const MAX_CONCURRENT_RUN_CREATIONS = 5;
const MAX_RUNS_PER_SUBMISSION = 100;
const EMPTY_RUNS: RunDto[] = [];
const ROW_INTERACTIVE_SELECTOR = "a, button, input, select, textarea, summary, [contenteditable='true']";
const FOCUSABLE_INTERACTIVE_SELECTOR = "a[href], area[href], button:not(:disabled), input:not(:disabled):not([type='hidden']), select:not(:disabled), textarea:not(:disabled), summary, iframe, audio[controls], video[controls], [contenteditable]:not([contenteditable='false']), [tabindex]";
const SELECTABLE_APPLICATION_STATUSES = APPLICATION_STATUSES.filter((status) => status !== "failed");
const DASHBOARD_STATUS_FILTERS = [
  "pending",
  "applying",
  "did_not_apply",
  "applied",
  "oa_received",
  "oa_completed",
  "rejected",
  "interview",
  "accepted",
] as const;


const IS_TERMINAL_STATUS: Record<RunStatus, boolean> = {
  queued: false,
  analyzing: false,
  tailoring: false,
  editing: false,
  compiling: false,
  repairing: false,
  deterministic_qa: false,
  visual_qa: false,
  review: true,
  approved: true,
  failed: true,
};
const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});


type SortDirection = "newest" | "oldest";
type StatusFilter = ApplicationStatus | "all" | "applying";
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
    readonly kind: "delete";
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

function mergeRuns(current: readonly RunDto[] | undefined, incoming: readonly RunDto[]): RunDto[] {
  const merged: RunDto[] = [];
  const seenIds = new Set<string>();
  for (const run of incoming) {
    if (seenIds.has(run.id)) continue;
    seenIds.add(run.id);
    merged.push(run);
  }
  for (const run of current ?? EMPTY_RUNS) {
    if (seenIds.has(run.id)) continue;
    seenIds.add(run.id);
    merged.push(run);
  }
  return merged;
}

function batchFailureMessage(successCount: number, totalCount: number, error: unknown): string {
  const failure = publicMessage(error, "An opportunity could not be initialized. Try again.");
  return `${successCount} of ${totalCount} applications initialized. ${failure}`.slice(
    0,
    MAX_PUBLIC_MESSAGE_LENGTH,
  );
}

function parseJobIdentity(value: unknown): JobIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const analysis = value as Record<string, unknown>;
  if (analysis.schemaVersion !== 2) return null;

  const target = analysis.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const targetRecord = target as Record<string, unknown>;
  const title = typeof targetRecord.title === "string" ? targetRecord.title.trim() : "";
  if (!title) return null;

  const organization = typeof targetRecord.organization === "string"
    ? targetRecord.organization.trim()
    : "";
  return organization ? { title, organization } : { title };
}

function latestJobAnalysis(run: RunDto): ArtifactDto | undefined {
  return run.artifacts
    .filter((artifact) => artifact.kind === "job-analysis" && artifact.public)
    .sort((left, right) => right.createdAt - left.createdAt)[0];
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
  const { runs: runSnapshot, setRuns, jobIdentities, setJobIdentities } = useDashboardData();
  const runs = runSnapshot ?? EMPTY_RUNS;
  const showInitialLoading = useRef(runSnapshot === undefined);
  const [isLoading, setIsLoading] = useState(showInitialLoading.current);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
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
  const [busyRunIds, setBusyRunIds] = useState<Set<string>>(() => new Set());
  const [statusUpdateError, setStatusUpdateError] = useState<string | null>(null);
  const [actionMenu, setActionMenu] = useState<ActionMenuState | null>(null);
  const [activeDialog, setActiveDialog] = useState<RunDialog | null>(null);
  const [editValue, setEditValue] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const duplicateDialogRef = useRef<HTMLDialogElement>(null);
  const duplicateDialogOpenerRef = useRef<HTMLButtonElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const actionTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const scheduleFocusRestoration = useCallback((runId?: string) => {
    window.requestAnimationFrame(() => {
      const focusedElement = document.activeElement;
      if (
        focusedElement
        && focusedElement !== document.body
        && focusedElement.isConnected
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
  const requestedArtifacts = useRef(new Set<string>());
  const latestListRequest = useRef(0);
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
  const clearCreateStatus = () => {
    setCreateError(null);
    setCreateSuccess(null);
  };

  const load = useCallback(async (showLoading = false) => {
    const requestId = ++latestListRequest.current;
    if (showLoading) setIsLoading(true);
    try {
      const nextRuns = await listRuns();
      if (requestId !== latestListRequest.current) return;
      setRuns(nextRuns);
      setLoadError(null);
    } catch (error) {
      if (requestId !== latestListRequest.current) return;
      setLoadError(publicMessage(error, "Applications are unavailable. Try again."));
    } finally {
      if (requestId === latestListRequest.current) setIsLoading(false);
    }
  }, [setRuns]);

  useEffect(() => {
    void load(showInitialLoading.current);
    return () => {
      latestListRequest.current += 1;
    };
  }, [load]);

  const hasActiveRuns = runs.some((run) => run.isApplying === true || !IS_TERMINAL_STATUS[run.status]);

  useEffect(() => {
    if (!hasActiveRuns) return;
    let cancelled = false;
    let timeout = 0;
    const poll = async () => {
      await load();
      if (!cancelled) timeout = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    timeout = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [hasActiveRuns, load]);

  useEffect(() => {
    const pending = runs.flatMap((run) => {
      const artifact = latestJobAnalysis(run);
      if (!artifact || requestedArtifacts.current.has(artifact.id)) return [];
      requestedArtifacts.current.add(artifact.id);
      return [{ artifact, runId: run.id }];
    });

    if (pending.length === 0) return;

    void Promise.all(
      pending.map(async ({ artifact, runId }) => {
        try {
          const identity = parseJobIdentity(await readJsonArtifact(artifact));
          if (!identity) return;
          setJobIdentities((existing) => ({ ...existing, [runId]: identity }));
        } catch {
          requestedArtifacts.current.delete(artifact.id);
          // Job metadata is optional. The role remains empty without a valid identity.
        }
      }),
    );
  }, [runs, setJobIdentities]);

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
    const { field, runId } = activeDialog;
    setRunBusy(runId, true);
    setDialogError(null);
    try {
      const updated = await updateRunIdentity(
        runId,
        field === "title" ? { title: value } : { organization: value },
      );
      latestListRequest.current += 1;
      setRuns((current) => current?.map((run) => run.id === updated.id ? updated : run) ?? current);
      setActiveDialog(null);
      restoreActionTriggerFocus(runId);
    } catch (error) {
      setDialogError(publicMessage(error, `${field === "title" ? "Title" : "Organization"} could not be updated. Try again.`));
    } finally {
      setRunBusy(runId, false);
    }
  };

  const submitDelete = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (activeDialog?.kind !== "delete" || busyRunIds.has(activeDialog.runId)) return;
    const { runId } = activeDialog;
    setRunBusy(runId, true);
    setDialogError(null);
    try {
      await deleteRun(runId);
      latestListRequest.current += 1;
      setRuns((current) => current?.filter((run) => run.id !== runId) ?? current);
      setJobIdentities((current) => {
        const next = { ...current };
        delete next[runId];
        return next;
      });
      setActiveDialog(null);
      focusSearchApplications();
    } catch (error) {
      setDialogError(publicMessage(error, "The application could not be deleted. Try again."));
    } finally {
      setRunBusy(runId, false);
    }
  };

  const filteredRuns = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return runs
      .filter((run) => {
        if (statusFilter === "all") return true;
        if (statusFilter === "applying") return run.isApplying === true;
        return run.isApplying !== true && run.applicationStatus === statusFilter;
      })
      .filter((run) => {
        if (!normalizedQuery) return true;
        const identity = effectiveRunIdentity(run, jobIdentities[run.id]);
        return [run.id, APPLICATION_STATUS_LABELS[run.applicationStatus], identity.title, identity.organization]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
      })
      .sort((left, right) => {
        const leftBucket = left.isApplying ? 0 : left.applicationStatus === "rejected" ? 2 : 1;
        const rightBucket = right.isApplying ? 0 : right.applicationStatus === "rejected" ? 2 : 1;
        if (leftBucket !== rightBucket) return leftBucket - rightBucket;
        return sortDirection === "newest"
          ? right.updatedAt - left.updatedAt
          : left.updatedAt - right.updatedAt;
      });
  }, [jobIdentities, query, runs, sortDirection, statusFilter]);

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

  const updateStatus = (value: StatusFilter) => {
    setStatusFilter(value);
    setCurrentPage(1);
  };

  const changeApplicationStatus = async (runId: string, applicationStatus: ApplicationStatus) => {
    setRunBusy(runId, true);
    setStatusUpdateError(null);
    try {
      const updated = await updateApplicationStatus(runId, applicationStatus);
      latestListRequest.current += 1;
      setRuns((current) => current?.map((run) => run.id === updated.id ? updated : run) ?? current);
      setStatusUpdateError(null);
    } catch {
      setStatusUpdateError("Application state could not be updated. Try again.");
    } finally {
      setRunBusy(runId, false);
    }
  };

  const initializeRuns = async (requests: readonly ValidatedCreateRunRequest[]) => {
    if (isCreating) return;
    setIsCreating(true);
    setCreateError(null);
    setCreateSuccess(null);

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
    const successfulRuns: RunDto[] = [];
    const failures: Extract<CreateRunResult, { success: false }>[] = [];
    for (const result of results) {
      if (result.success) successfulRuns.push(result.run);
      else failures.push(result);
    }

    if (successfulRuns.length > 0) {
      latestListRequest.current += 1;
      setIsLoading(false);
      setRuns((current) => mergeRuns(current, successfulRuns));
      void load();
    }

    if (failures.length === 0) {
      setJobUrl("");
      setOpportunityKind("auto");
      setSkipReview(false);
      setAutoSubmit(false);
      const applicationLabel = successfulRuns.length === 1 ? "application" : "applications";
      setCreateSuccess(`${successfulRuns.length} ${applicationLabel} initialized.`);
    } else {
      if (requests.length > 1) {
        setJobUrl(failures.map(({ request }) => request.jobUrl).join(", "));
      }
      setCreateError(
        requests.length === 1
          ? publicMessage(failures[0]!.error, "The opportunity could not be initialized. Try again.")
          : batchFailureMessage(successfulRuns.length, results.length, failures[0]!.error),
      );
    }
    setIsCreating(false);
  };

  const initializePastedRun = async (request: ValidatedPastedRunRequest) => {
    if (isCreating) return;
    setIsCreating(true);
    clearCreateStatus();
    try {
      const run = await createPastedRun(
        request.jobTitle,
        request.jobDescription,
        request.generateKeywordMap,
      );
      latestListRequest.current += 1;
      setIsLoading(false);
      setRuns((current) => mergeRuns(current, [run]));
      void load();
      setJobTitle("");
      setJobDescription("");
      setGenerateKeywordMap(true);
      setCreateSuccess("1 application initialized.");
    } catch (error) {
      setCreateError(publicMessage(error, "The pasted job could not be initialized. Try again."));
    } finally {
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
    if (isCreating) return;
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
    if (isCreating || !duplicateCreateRequests) return;
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
      </header>

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
            disabled={isCreating}
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
                id="job-url"
                type="text"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="https://example.com/opportunities/ship-it, https://example.com/events/demo-day"
                value={jobUrl}
                disabled={isCreating}
                aria-invalid={createError ? true : undefined}
                aria-describedby={createError ? "job-url-error" : createSuccess ? "job-url-success" : undefined}
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
                disabled={isCreating}
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
                    disabled={isCreating}
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
                    disabled={isCreating}
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
                  disabled={isCreating}
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
                  disabled={isCreating}
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
                    disabled={isCreating}
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
          disabled={isCreating || !isCreateRequestValid}
        >
          {isCreating ? "Initializing…" : "Initialize"}
        </button>
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

        <section className="applications-summary" aria-label="Application count">
          <p className="applications-total">{isLoading || (loadError && runs.length === 0) ? "—" : runs.length.toLocaleString()}</p>
          <p className="applications-label">Total applications</p>
        </section>

        <section className="applications-list" aria-labelledby="applications-list-heading">
          <h2 className="visually-hidden" id="applications-list-heading">Application runs</h2>
          <div className="applications-toolbar">
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
            <div className="applications-toolbar__actions">
              <label className="select-control">
                <span>State</span>
                <select
                  aria-label="Filter applications by state"
                  value={statusFilter}
                  onChange={(event) => updateStatus(event.target.value as StatusFilter)}
                >
                  <option value="all">All states</option>
                  {DASHBOARD_STATUS_FILTERS.map((status) => (
                    <option value={status} key={status}>
                      {status === "applying" ? "Applying" : APPLICATION_STATUS_LABELS[status]}
                    </option>
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
              <button
                className="square-control sort-control"
                type="button"
                onClick={() => {
                  setSortDirection((direction) => direction === "newest" ? "oldest" : "newest");
                  setCurrentPage(1);
                }}
                aria-label={`Sort by updated date, currently ${sortDirection}`}
              >
                <span>Updated: {sortDirection}</span>
                <span aria-hidden="true">{sortDirection === "newest" ? "↓" : "↑"}</span>
              </button>
            </div>
          </div>

          {loadError && runs.length > 0 ? (
            <div className="dashboard-alert dashboard-alert--toolbar" role="alert">
              <span>{loadError}</span>
              <button className="inline-control" type="button" onClick={() => void load()}>Retry</button>
            </div>
          ) : null}

          {statusUpdateError ? (
            <div className="dashboard-alert dashboard-alert--toolbar" role="alert" aria-label="Application state update error">
              <span>{statusUpdateError}</span>
            </div>
          ) : null}

            <div className="applications-table-scroll">
              <table className="applications-table" aria-busy={isLoading}>
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    <th scope="col">Organization</th>
                    <th scope="col">Updated</th>
                    <th scope="col">Status</th>
                    <th scope="col"><span className="visually-hidden">Application actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {loadError && runs.length === 0 ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="applications-state applications-state--table" role="alert">
                          <p>{loadError}</p>
                          <button className="square-control" type="button" onClick={() => void load(true)}>Try again</button>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {isLoading && !(loadError && runs.length === 0) ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="applications-state applications-state--table" role="status">Loading applications…</div>
                      </td>
                    </tr>
                  ) : null}
                  {showInitialEmpty ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="applications-state applications-state--table">
                          <p>No applications yet. Enter an opportunity URL above to initialize one.</p>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {showFilteredEmpty ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="applications-state applications-state--table">
                          <p>No applications match the current search and state.</p>
                          <button className="inline-control" type="button" onClick={() => { updateQuery(""); updateStatus("all"); }}>Clear filters</button>
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
                    return (
                      <tr
                        key={run.id}
                        onClick={(event) => {
                          const target = event.target;
                          if (target instanceof Element && target.closest(ROW_INTERACTIVE_SELECTOR)) return;
                          router.push(href);
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
                        <td><time dateTime={new Date(run.updatedAt).toISOString()}>{DATE_FORMATTER.format(new Date(run.updatedAt))}</time></td>
                        <td>
                          {run.isApplying ? (
                            <span
                              aria-label={`Application state for ${shortRunId(run.id)}: Applying`}
                              className="application-status-control application-status-control--applying"
                            >
                              Applying
                            </span>
                          ) : (
                            <select
                              aria-label={`Application state for ${shortRunId(run.id)}`}
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
                          )}
                        </td>
                        <td>
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
          aria-describedby={activeDialog.kind === "delete" ? "run-action-dialog-description" : undefined}
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
