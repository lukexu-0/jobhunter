"use client";

import Link from "next/link";
import { CalendarDays, MapPin, RefreshCw, Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  DISCOVERY_LIST_MAX_OFFSET,
  type DiscoveryJob,
  type DiscoveryListResponse,
  type DiscoveryQueueResponse,
  type DiscoveryQueueSkipReason,
  type DiscoveryRole,
  type DiscoverySort,
  type DiscoverySyncResponse,
} from "@jobhunter/pipeline/contracts";
import {
  PipelineClientError,
  listDiscoveryJobs,
  queueDiscoveryJobs,
  syncDiscoveryJobs,
} from "../lib/pipeline-client";

const MAX_DISCOVERY_RESULTS = 1_000;
const MAX_PUBLIC_MESSAGE_LENGTH = 240;
const EMPTY_JOBS: readonly DiscoveryJob[] = [];

const ROLE_OPTIONS = [
  ["software_engineering", "Software engineering"],
  ["machine_learning", "Machine learning"],
  ["data", "Data"],
  ["security", "Security"],
  ["product", "Product"],
  ["hardware", "Hardware"],
  ["other", "Other"],
] as const satisfies ReadonlyArray<readonly [DiscoveryRole, string]>;

const ROLE_LABELS: Record<DiscoveryRole, string> = {
  software_engineering: "Software engineering",
  machine_learning: "Machine learning",
  data: "Data",
  security: "Security",
  product: "Product",
  hardware: "Hardware",
  other: "Other",
};

const SEASON_LABELS: Record<DiscoveryJob["season"], string> = {
  spring: "Spring",
  summer: "Summer",
  fall: "Fall",
  winter: "Winter",
  off_season: "Off-season",
  unspecified: "Season not stated",
};

export function discoveryRoleLabel(roles: readonly DiscoveryRole[]): string {
  return roles.map((role) => ROLE_LABELS[role]).join(" · ");
}

const QUEUE_SKIP_LABELS: Record<DiscoveryQueueSkipReason, string> = {
  already_queued: "Already queued",
  description_unavailable: "Description unavailable",
  not_found: "No longer available",
  closed: "Closed",
  queue_failed: "Could not be queued",
};

const RECENT_OPTIONS = [
  ["1", "1 day"],
  ["3", "3 days"],
  ["7", "7 days"],
  ["14", "14 days"],
  ["30", "30 days"],
  ["all", "All time"],
] as const;

type RecentFilter = (typeof RECENT_OPTIONS)[number][0];
type RoleFilter = DiscoveryRole | "all";
type StatusFilter = DiscoveryJob["status"] | "all";
type Mutation = "queue" | "sync" | null;

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const MILLISECONDS_PER_DAY = 86_400_000;

function publicMessage(error: unknown, fallback: string): string {
  if (!(error instanceof PipelineClientError)) return fallback;
  const message = error.message.trim();
  return (message || fallback).slice(0, MAX_PUBLIC_MESSAGE_LENGTH);
}

function formattedDate(timestamp: number): { readonly dateTime: string; readonly label: string } | null {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;

  return { dateTime: date.toISOString(), label: DATE_FORMATTER.format(date) };
}

function relativeUtcCalendarDay(timestamp: number, now: number): string | null {
  const date = new Date(timestamp);
  const today = new Date(now);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(today.getTime())) return null;

  const observedUtcDay = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  const currentUtcDay = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  const daysAgo = Math.max(
    0,
    Math.floor((currentUtcDay - observedUtcDay) / MILLISECONDS_PER_DAY),
  );

  if (daysAgo === 0) return "today";
  if (daysAgo === 1) return "1 day ago";
  return `${daysAgo} days ago`;
}

export function boundedDiscoveryListOffset(offset: number): number {
  return Math.min(DISCOVERY_LIST_MAX_OFFSET, Math.max(0, Math.trunc(offset)));
}

export function discoveryPageWindow(
  offset: number,
  limit: number,
  total: number,
): {
  readonly first: number;
  readonly last: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
} {
  const safeLimit = Math.max(1, Math.trunc(limit));
  const safeTotal = Math.max(0, Math.trunc(total));
  const requestedOffset = boundedDiscoveryListOffset(offset);
  const lastReachableOffset = safeTotal === 0
    ? 0
    : Math.min(
      DISCOVERY_LIST_MAX_OFFSET,
      Math.floor((safeTotal - 1) / safeLimit) * safeLimit,
    );
  const pageOffset = Math.min(requestedOffset, lastReachableOffset);
  return {
    first: safeTotal === 0 ? 0 : pageOffset + 1,
    last: Math.min(pageOffset + safeLimit, safeTotal),
    hasPrevious: pageOffset > 0,
    hasNext: pageOffset < lastReachableOffset,
  };
}



type DiscoveryViewTransition =
  | "refresh"
  | "page"
  | "role"
  | "recency"
  | "status"
  | "search"
  | "sort"
  | "visibility";

export function discoverySelectionAfterTransition(
  selected: ReadonlySet<string>,
  transition: DiscoveryViewTransition,
): Set<string> {
  return transition === "refresh" ? new Set(selected) : new Set();
}

export function discoveryQueueSkipLabel(reason: DiscoveryQueueSkipReason): string {
  return QUEUE_SKIP_LABELS[reason];
}

export function pruneDiscoverySelection(
  selected: ReadonlySet<string>,
  jobs: readonly DiscoveryJob[],
): Set<string> {
  const next = new Set<string>();
  for (const job of jobs) {
    if (job.queueable && selected.has(job.id)) next.add(job.id);
  }
  return next;
}

export function toggleAllDiscoverySelection(
  selected: ReadonlySet<string>,
  jobs: readonly DiscoveryJob[],
): Set<string> {
  const next = new Set<string>();
  let queueableCount = 0;
  for (const job of jobs) {
    if (!job.queueable) continue;
    queueableCount += 1;
    if (selected.has(job.id)) next.add(job.id);
  }

  const allSelected = queueableCount > 0 && next.size === queueableCount;
  for (const job of jobs) {
    if (!job.queueable) continue;
    if (allSelected) next.delete(job.id);
    else next.add(job.id);
  }
  return next;
}

export function orderedSelectedDiscoveryJobIds(
  jobs: readonly DiscoveryJob[],
  selected: ReadonlySet<string>,
): string[] {
  const ordered: string[] = [];
  for (const job of jobs) {
    if (job.queueable && selected.has(job.id)) ordered.push(job.id);
  }
  return ordered;
}

export function DiscoverySyncNotice({ result }: { readonly result: DiscoverySyncResponse }) {
  const { totals } = result;
  const failedSources = result.sources
    .filter((source) => source.status === "failed")
    .map((source) => source.sourceName);
  const unavailableSources = result.sources
    .filter((source) => source.descriptionUnavailable > 0)
    .map((source) => `${source.sourceName} (${source.descriptionUnavailable.toLocaleString()})`);
  const summary = [
    `${totals.succeeded} of ${totals.sources} sources synced`,
    `${totals.received.toLocaleString()} received`,
    `${totals.created.toLocaleString()} new`,
    `${totals.updated.toLocaleString()} updated`,
    `${totals.closed.toLocaleString()} closed`,
    `${totals.descriptionUnavailable.toLocaleString()} descriptions unavailable`,
  ].join(" · ");

  return (
    <div
      className={`dashboard-notice ${totals.failed > 0 ? "dashboard-notice--info" : "dashboard-notice--success"}`}
      role="status"
    >
      <p>{summary}.</p>
      {failedSources.length > 0 ? <p>Failed sources: {failedSources.join(", ")}.</p> : null}
      {unavailableSources.length > 0
        ? <p>Descriptions unavailable: {unavailableSources.join(", ")}.</p>
        : null}
    </div>
  );
}

function QueueNotice({ result }: { readonly result: DiscoveryQueueResponse }) {
  return (
    <div
      className={`discovery-queue-result dashboard-notice ${result.skipped.length === 0
        ? "dashboard-notice--success"
        : "dashboard-notice--info"}`}
      role="status"
    >
      <p>
        {result.queued.length.toLocaleString()} queued · {result.skipped.length.toLocaleString()} skipped.
      </p>
      {result.queued.length > 0 ? (
        <ul aria-label="Queued application runs" className="discovery-result-links">
          {result.queued.map(({ jobId, run }) => (
            <li key={jobId}>
              <Link href={`/runs/${encodeURIComponent(run.id)}`}>Open run for {jobId}</Link>
            </li>
          ))}
        </ul>
      ) : null}
      {result.skipped.length > 0 ? (
        <details>
          <summary>Review skipped jobs</summary>
          <ul className="discovery-skipped-list">
            {result.skipped.map(({ jobId, reason }) => (
              <li key={jobId}>
                <span>{jobId}</span>
                <span>{discoveryQueueSkipLabel(reason)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

interface RunOptionProps {
  readonly checked: boolean;
  readonly description: string;
  readonly disabled: boolean;
  readonly id: string;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}

function RunOption({ checked, description, disabled, id, label, onChange }: RunOptionProps) {
  const descriptionId = `${id}-description`;
  const labelId = `${id}-label`;
  return (
    <label className="run-initializer__mode">
      <input
        aria-describedby={descriptionId}
        aria-labelledby={labelId}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span className="run-initializer__mode-copy">
        <span className="run-initializer__mode-title" id={labelId}>{label}</span>
        <span className="run-initializer__mode-description" id={descriptionId}>{description}</span>
      </span>
    </label>
  );
}

export function DiscoveryJobRow({
  busy,
  job,
  onToggle,
  selected,
}: {
  readonly busy: boolean;
  readonly job: DiscoveryJob;
  readonly onToggle: (jobId: string, checked: boolean) => void;
  readonly selected: boolean;
}) {
  const selectionUnavailableReason = job.queueable
    ? null
    : job.status === "closed"
      ? "Closed jobs cannot be queued."
      : job.queuedRunId || job.status === "queued"
        ? "This job is already queued."
        : job.descriptionPreview === null
          ? "Job description unavailable; this role cannot be queued yet."
          : "This job is not available to queue.";
  const selectionReasonId = selectionUnavailableReason
    ? `discovery-selection-${job.id}-reason`
    : undefined;
  const observedTimestamp = job.postedAt ?? job.firstSeenAt;
  const observedDate = formattedDate(observedTimestamp);
  const observedAge = relativeUtcCalendarDay(observedTimestamp, Date.now());
  return (
    <li className="discovery-row" data-status={job.status}>
      <label className="discovery-row__selector">
        <input
          aria-describedby={selectionReasonId}
          aria-label={`Select ${job.title} at ${job.company}`}
          checked={job.queueable && selected}
          disabled={busy || !job.queueable}
          onChange={(event) => onToggle(job.id, event.currentTarget.checked)}
          type="checkbox"
        />
        {selectionUnavailableReason ? (
          <span className="visually-hidden" id={selectionReasonId}>{selectionUnavailableReason}</span>
        ) : null}
      </label>
      <article className="discovery-row__body">
        <header className="discovery-row__heading">
          <div>
            <p className="discovery-row__role">{discoveryRoleLabel(job.roles)}</p>
            <h3>
              <a
                className="discovery-row__title-link"
                href={job.canonicalUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                {job.title}
              </a>
            </h3>
            <p className="discovery-row__company">{job.company}</p>
          </div>
          <div className="discovery-row__badges" aria-label="Job status">
            <span
              className={`discovery-job-suitability discovery-job-suitability--${
                job.suitable ? "suitable" : "unsuitable"
              }`}
            >
              {job.suitable ? "Suitable" : "Unsuitable"}
            </span>
            <span className={`discovery-job-status discovery-job-status--${job.status}`}>
              {job.status}
            </span>
          </div>
        </header>
        <div className="discovery-row__highlights">
          <span className={`discovery-job-season discovery-job-season--${job.season}`}>
            {SEASON_LABELS[job.season]}
          </span>
          {observedDate && observedAge ? (
            <span
              className="discovery-job-date"
              title={`${job.postedAt === null ? "Found" : "Posted"} ${observedDate.label}`}
            >
              <CalendarDays aria-hidden="true" />
              <time dateTime={observedDate.dateTime}>
                {job.postedAt === null ? "Found" : "Posted"} {observedAge}
              </time>
              <span className="visually-hidden"> ({observedDate.label})</span>
            </span>
          ) : null}
        </div>
        <ul className="discovery-row__metadata" aria-label="Job details">
          <li>
            <MapPin aria-hidden="true" />
            <span>{job.location ?? "Location not listed"}</span>
          </li>
          <li className="discovery-row__sources">
            <span>Sources</span>
            <span>{job.sourceNames.join(" · ")}</span>
          </li>
        </ul>
        <p className="discovery-row__preview">
          {job.descriptionPreview === null
            ? "Description unavailable. Sync again later to retry job details."
            : job.descriptionPreview}
        </p>
        {job.queuedRunId ? (
          <Link className="discovery-row__run-link" href={`/runs/${encodeURIComponent(job.queuedRunId)}`}>
            Open queued run
          </Link>
        ) : null}
      </article>
    </li>
  );
}

export function DiscoveryCatalog() {
  const [role, setRole] = useState<RoleFilter>("all");
  const [recent, setRecent] = useState<RecentFilter>("7");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [sort, setSort] = useState<DiscoverySort>("recency");
  const [hideQueuedPreference, setHideQueuedPreference] = useState(true);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [catalog, setCatalog] = useState<DiscoveryListResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutation, setMutation] = useState<Mutation>(null);
  const [syncResult, setSyncResult] = useState<DiscoverySyncResponse | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [queueResult, setQueueResult] = useState<DiscoveryQueueResponse | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [generateKeywordMap, setGenerateKeywordMap] = useState(true);
  const [skipReview, setSkipReview] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(false);
  const requestSequence = useRef(0);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const effectiveHideQueued = status === "queued" ? false : hideQueuedPreference;
  const beginDiscoveryViewTransition = useCallback((
    transition: Exclude<DiscoveryViewTransition, "refresh">,
  ) => {
    requestSequence.current += 1;
    setCatalog(null);
    setSelected((current) => discoverySelectionAfterTransition(current, transition));
    setIsLoading(true);
  }, []);


  const loadCatalog = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setIsLoading(true);
    setLoadError(null);
    try {
      const response = await listDiscoveryJobs({
        ...(role === "all" ? {} : { role }),
        maxAgeDays: recent === "all" ? null : Number(recent),
        status,
        search,
        sort,
        hideQueued: effectiveHideQueued,
        limit: MAX_DISCOVERY_RESULTS,
        offset,
      });
      if (sequence !== requestSequence.current) return;
      if (response.total > 0 && response.jobs.length === 0 && offset >= response.total) {
        beginDiscoveryViewTransition("page");
        setOffset(boundedDiscoveryListOffset(
          Math.floor((response.total - 1) / MAX_DISCOVERY_RESULTS) * MAX_DISCOVERY_RESULTS,
        ));
        return;
      }
      setCatalog(response);
      setSelected((current) => pruneDiscoverySelection(current, response.jobs));
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      setLoadError(publicMessage(error, "Internships could not be loaded. Try again."));
    } finally {
      if (sequence === requestSequence.current) setIsLoading(false);
    }
  }, [
    beginDiscoveryViewTransition,
    effectiveHideQueued,
    offset,
    recent,
    role,
    search,
    sort,
    status,
  ]);

  useEffect(() => {
    void loadCatalog();
    return () => {
      requestSequence.current += 1;
    };
  }, [loadCatalog]);

  const jobs = catalog?.jobs ?? EMPTY_JOBS;
  const pageWindow = discoveryPageWindow(offset, MAX_DISCOVERY_RESULTS, catalog?.total ?? 0);
  const selectedIds = useMemo(
    () => orderedSelectedDiscoveryJobIds(jobs, selected),
    [jobs, selected],
  );
  const selectedVisibleCount = selectedIds.length;
  const queueableVisibleCount = useMemo(
    () => jobs.reduce((count, job) => count + (job.queueable ? 1 : 0), 0),
    [jobs],
  );
  const allVisibleSelected = queueableVisibleCount > 0
    && selectedVisibleCount === queueableVisibleCount;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const isMutating = mutation !== null;
  const isSelectionBusy = isMutating || isLoading;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

  const applySearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setQueueError(null);
    const nextSearch = searchDraft.trim();
    if (nextSearch === search && offset === 0) void loadCatalog();
    else {
      beginDiscoveryViewTransition("search");
      setOffset(0);
      setSearch(nextSearch);
    }
  };

  const toggleJob = (jobId: string, checked: boolean) => {
    setQueueError(null);
    setSelected((current) => {
      const next = new Set(current);
      const queueable = jobs.some((job) => job.id === jobId && job.queueable);
      if (checked && !queueable) next.delete(jobId);
      else if (checked) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  };

  const syncJobs = async () => {
    if (isMutating) return;
    setMutation("sync");
    setSyncError(null);
    setSyncResult(null);
    try {
      const result = await syncDiscoveryJobs();
      setSyncResult(result);
      if (offset === 0) await loadCatalog();
      else {
        beginDiscoveryViewTransition("page");
        setOffset(0);
      }
    } catch (error) {
      setSyncError(publicMessage(error, "Jobs could not be synced. Try again."));
    } finally {
      setMutation(null);
    }
  };

  const queueSelected = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isMutating || selectedIds.length === 0) return;
    const requestedIds = [...selectedIds];
    setMutation("queue");
    setQueueError(null);
    setQueueResult(null);
    try {
      const result = await queueDiscoveryJobs({
        jobIds: requestedIds,
        generateKeywordMap,
        skipReview,
        autoSubmit,
      });
      setQueueResult(result);
      if (result.skipped.length === 0) {
        setGenerateKeywordMap(true);
        setSkipReview(false);
        setAutoSubmit(false);
      }
      await loadCatalog();
    } catch (error) {
      setQueueError(publicMessage(error, "Selected internships could not be queued. Try again."));
    } finally {
      setMutation(null);
    }
  };
  const changePage = (nextOffset: number) => {
    setQueueError(null);
    beginDiscoveryViewTransition("page");
    setOffset(boundedDiscoveryListOffset(nextOffset));
  };


  const lastSync = catalog?.lastSyncAt === null || catalog?.lastSyncAt === undefined
    ? null
    : formattedDate(catalog.lastSyncAt);

  return (
    <div className="discovery-catalog">
      <header className="discovery-header">
        <h1 className="workspace-title">Discover</h1>
      </header>

      <div className="discovery-toolbar">
        <p className="discovery-sync-state" aria-live="polite">
          {isLoading && catalog === null
            ? "Checking catalog"
            : lastSync
              ? <>Last sync <time dateTime={lastSync.dateTime}>{lastSync.label}</time></>
              : "Not synced yet"}
        </p>
        <button
          className="control"
          disabled={isMutating}
          onClick={() => void syncJobs()}
          type="button"
        >
          <RefreshCw aria-hidden="true" />
          {mutation === "sync" ? "Syncing…" : "Sync jobs"}
        </button>
      </div>

      <section className="discovery-notices" aria-label="Discovery updates" aria-live="polite">
        {syncError ? <p className="dashboard-alert" role="alert">{syncError}</p> : null}
        {syncResult ? <DiscoverySyncNotice result={syncResult} /> : null}
        {queueError ? <p className="dashboard-alert" role="alert">{queueError}</p> : null}
        {queueResult ? <QueueNotice result={queueResult} /> : null}
      </section>

      <section className="discovery-filters" aria-labelledby="discovery-filter-heading">
        <h2 className="visually-hidden" id="discovery-filter-heading">Filter internships</h2>
        <form className="discovery-search" onSubmit={applySearch} role="search">
          <label className="search-control">
            <span className="visually-hidden">Search internships</span>
            <Search aria-hidden="true" />
            <input
              autoComplete="off"
              disabled={isMutating}
              maxLength={200}
              onChange={(event) => setSearchDraft(event.currentTarget.value)}
              placeholder="Search title, company, or location"
              type="search"
              value={searchDraft}
            />
          </label>
          <button className="control" disabled={isLoading || isMutating} type="submit">Search</button>
        </form>
        <div className="discovery-filter-controls">
          <label className="select-control">
            <span>Role</span>
            <select
              aria-label="Filter internships by role"
              disabled={isMutating}
              onChange={(event) => {
                setQueueError(null);
                beginDiscoveryViewTransition("role");
                setOffset(0);
                setRole(event.currentTarget.value as RoleFilter);
              }}
              value={role}
            >
              <option value="all">All roles</option>
              {ROLE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="select-control">
            <span>Recent</span>
            <select
              aria-label="Filter internships by recency"
              disabled={isMutating}
              onChange={(event) => {
                setQueueError(null);
                beginDiscoveryViewTransition("recency");
                setOffset(0);
                setRecent(event.currentTarget.value as RecentFilter);
              }}
              value={recent}
            >
              {RECENT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="select-control">
            <span>Status</span>
            <select
              aria-label="Filter internships by status"
              disabled={isMutating}
              onChange={(event) => {
                setQueueError(null);
                beginDiscoveryViewTransition("status");
                setOffset(0);
                setStatus(event.currentTarget.value as StatusFilter);
              }}
              value={status}
            >
              <option value="open">Open</option>
              <option value="queued">Queued</option>
              <option value="closed">Closed</option>
              <option value="all">All statuses</option>
            </select>
          </label>
          <label className="select-control">
            <span>Sort</span>
            <select
              aria-label="Sort internships"
              disabled={isMutating}
              onChange={(event) => {
                setQueueError(null);
                beginDiscoveryViewTransition("sort");
                setOffset(0);
                setSort(event.currentTarget.value as DiscoverySort);
              }}
              value={sort}
            >
              <option value="recency">Newest first</option>
              <option value="source">Source A–Z</option>
            </select>
          </label>
          <label className="discovery-visibility-control">
            <input
              checked={effectiveHideQueued}
              disabled={isMutating || status === "queued"}
              onChange={(event) => {
                setQueueError(null);
                beginDiscoveryViewTransition("visibility");
                setOffset(0);
                setHideQueuedPreference(event.currentTarget.checked);
              }}
              type="checkbox"
            />
            <span>Hide queued jobs</span>
          </label>
        </div>
      </section>

      <section className="discovery-counts" aria-label="Discovery job counts" aria-live="polite">
        <p><strong>{selectedVisibleCount.toLocaleString()}</strong><span>Selected</span></p>
        <p><strong>{jobs.length.toLocaleString()}</strong><span>Visible</span></p>
        <p><strong>{(catalog?.total ?? 0).toLocaleString()}</strong><span>Total matches</span></p>
        {isLoading && catalog !== null ? <p className="discovery-counts__refresh">Refreshing…</p> : null}
      </section>

      <form className="discovery-queue" onSubmit={(event) => void queueSelected(event)}>
        <div className="discovery-selection-bar">
          <label className="discovery-select-all">
            <input
              checked={allVisibleSelected}
              disabled={isSelectionBusy || queueableVisibleCount === 0}
              onChange={() => {
                setQueueError(null);
                setSelected((current) => toggleAllDiscoverySelection(current, jobs));
              }}
              ref={selectAllRef}
              type="checkbox"
            />
            <span>Select all {queueableVisibleCount.toLocaleString()} queueable jobs</span>
          </label>
          <button
            className="control control--quiet"
            disabled={isSelectionBusy || selectedVisibleCount === 0}
            onClick={() => {
              setQueueError(null);
              setSelected(new Set());
            }}
            type="button"
          >
            Clear selection
          </button>
        </div>

        <fieldset className="discovery-queue-options">
          <legend>Run options</legend>
          <div className="run-initializer__option-list">
            <RunOption
              checked={generateKeywordMap}
              description="Builds the keyword map used during résumé tailoring."
              disabled={isMutating}
              id="discovery-keyword-map"
              label="Generate keyword map"
              onChange={(checked) => {
                setGenerateKeywordMap(checked);
                setQueueError(null);
              }}
            />
            <RunOption
              checked={skipReview}
              description="Approves only after automated résumé checks pass, then starts the application."
              disabled={isMutating}
              id="discovery-skip-review"
              label="Skip résumé review"
              onChange={(checked) => {
                setSkipReview(checked);
                setQueueError(null);
              }}
            />
            <RunOption
              checked={autoSubmit}
              description="Submits only when the application has no blockers."
              disabled={isMutating}
              id="discovery-auto-submit"
              label="Auto-submit application"
              onChange={(checked) => {
                setAutoSubmit(checked);
                setQueueError(null);
              }}
            />
          </div>
        </fieldset>

        <button
          className="control control--primary discovery-queue__submit"
          disabled={isSelectionBusy || selectedIds.length === 0}
          type="submit"
        >
          {mutation === "queue"
            ? "Queueing…"
            : `Queue ${selectedIds.length.toLocaleString()} selected`}
        </button>
      </form>

      {loadError && catalog !== null ? (
        <div className="dashboard-alert discovery-catalog-error" role="alert">
          <span>{loadError}</span>
          <button className="control" onClick={() => void loadCatalog()} type="button">Retry</button>
        </div>
      ) : null}

      {catalog === null && isLoading ? (
        <section className="discovery-state" aria-busy="true" aria-live="polite">
          <p>Loading internships…</p>
        </section>
      ) : catalog === null && loadError ? (
        <section className="discovery-state discovery-state--error" aria-busy="false" role="alert">
          <p>{loadError}</p>
          <button className="control" onClick={() => void loadCatalog()} type="button">Retry</button>
        </section>
      ) : jobs.length === 0 ? (
        <section className="discovery-state" aria-busy={isLoading} aria-live="polite">
          <p>No internships match these filters.</p>
          <span>Try a broader search, change the recent window, or sync public sources.</span>
        </section>
      ) : (
        <section className="discovery-results" aria-labelledby="discovery-results-heading">
          <h2 className="visually-hidden" id="discovery-results-heading">Internship results</h2>
          <nav className="discovery-pagination" aria-label="Discovery result pages">
            <p>
              Showing <strong>{pageWindow.first.toLocaleString()}–{pageWindow.last.toLocaleString()}</strong>
              {" "}of {(catalog?.total ?? 0).toLocaleString()} matches. Selection applies to this page.
            </p>
            <div className="discovery-pagination__controls">
              <button
                className="control control--quiet"
                disabled={isSelectionBusy || !pageWindow.hasPrevious}
                onClick={() => changePage(offset - MAX_DISCOVERY_RESULTS)}
                type="button"
              >
                Previous
              </button>
              <button
                className="control control--quiet"
                disabled={isSelectionBusy || !pageWindow.hasNext}
                onClick={() => changePage(boundedDiscoveryListOffset(
                  offset + MAX_DISCOVERY_RESULTS,
                ))}
                type="button"
              >
                Next
              </button>
            </div>
          </nav>
          <ul aria-busy={isLoading}>
            {jobs.map((job) => (
              <DiscoveryJobRow
                busy={isSelectionBusy}
                job={job}
                key={job.id}
                onToggle={toggleJob}
                selected={job.queueable && selected.has(job.id)}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
