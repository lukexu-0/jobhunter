"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { APPLICATION_STATUSES, CreateRunRequestSchema, type ApplicationStatus, type ArtifactDto, type RunDto, type RunStatus } from "@jobhunter/pipeline/contracts";
import { PipelineClientError, createRun, listRuns, readJsonArtifact, updateApplicationStatus } from "../lib/pipeline-client";
import { APPLICATION_STATUS_LABELS } from "../lib/application-status";
import { useDashboardData, type JobIdentity } from "../providers/dashboard-data-provider";

const PAGE_SIZE = 8;
const POLL_INTERVAL_MS = 3_000;
const MAX_PUBLIC_MESSAGE_LENGTH = 240;
const EMPTY_RUNS: RunDto[] = [];
const ROW_INTERACTIVE_SELECTOR = "a, button, input, select, textarea, summary, [contenteditable='true']";
const SELECTABLE_APPLICATION_STATUSES = APPLICATION_STATUSES.filter((status) => status !== "failed");


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

function publicMessage(error: unknown, fallback: string): string {
  if (!(error instanceof PipelineClientError)) return fallback;
  const message = error.message.trim();
  if (!message) return fallback;
  return message.slice(0, MAX_PUBLIC_MESSAGE_LENGTH);
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
  const [statusFilter, setStatusFilter] = useState<ApplicationStatus | "all">("all");
  const [sortDirection, setSortDirection] = useState<SortDirection>("newest");
  const [currentPage, setCurrentPage] = useState(1);
  const [jobUrl, setJobUrl] = useState("");
  const [generateKeywordMap, setGenerateKeywordMap] = useState(true);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [busyRunIds, setBusyRunIds] = useState<Set<string>>(() => new Set());
  const [statusUpdateError, setStatusUpdateError] = useState<string | null>(null);
  const requestedArtifacts = useRef(new Set<string>());
  const createRunRequest = useMemo(
    () => CreateRunRequestSchema.safeParse({ jobUrl, generateKeywordMap }),
    [generateKeywordMap, jobUrl],
  );
  const isCreateRequestValid = createRunRequest.success;

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setIsLoading(true);
    try {
      const nextRuns = await listRuns();
      setRuns(nextRuns);
      setLoadError(null);
    } catch (error) {
      setLoadError(publicMessage(error, "Applications are unavailable. Try again."));
    } finally {
      if (showLoading) setIsLoading(false);
    }
  }, [setRuns]);

  useEffect(() => {
    void load(showInitialLoading.current);
  }, [load]);

  const hasActiveRuns = runs.some((run) => !IS_TERMINAL_STATUS[run.status]);

  useEffect(() => {
    if (!hasActiveRuns) return;
    const interval = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
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
          // Job metadata is optional. The role remains empty without a valid identity.
        }
      }),
    );
  }, [runs, setJobIdentities]);

  const filteredRuns = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return runs
      .filter((run) => statusFilter === "all" || run.applicationStatus === statusFilter)
      .filter((run) => {
        if (!normalizedQuery) return true;
        const identity = jobIdentities[run.id];
        return [run.id, APPLICATION_STATUS_LABELS[run.applicationStatus], identity?.title, identity?.organization]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
      })
      .sort((left, right) =>
        sortDirection === "newest" ? right.updatedAt - left.updatedAt : left.updatedAt - right.updatedAt,
      );
  }, [jobIdentities, query, runs, sortDirection, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredRuns.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const visibleRuns = filteredRuns.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const firstVisible = filteredRuns.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const lastVisible = Math.min(safePage * PAGE_SIZE, filteredRuns.length);

  useEffect(() => {
    if (currentPage !== safePage) setCurrentPage(safePage);
  }, [currentPage, safePage]);

  const updateQuery = (value: string) => {
    setQuery(value);
    setCurrentPage(1);
  };

  const updateStatus = (value: ApplicationStatus | "all") => {
    setStatusFilter(value);
    setCurrentPage(1);
  };

  const changeApplicationStatus = async (runId: string, applicationStatus: ApplicationStatus) => {
    setBusyRunIds((current) => {
      const next = new Set(current);
      next.add(runId);
      return next;
    });
    setStatusUpdateError(null);
    try {
      const updated = await updateApplicationStatus(runId, applicationStatus);
      setRuns((current) => current?.map((run) => run.id === updated.id ? updated : run) ?? current);
      setStatusUpdateError(null);
    } catch {
      setStatusUpdateError("Application state could not be updated. Try again.");
    } finally {
      setBusyRunIds((current) => {
        const next = new Set(current);
        next.delete(runId);
        return next;
      });
    }
  };

  const submitRun = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isCreating || !createRunRequest.success) return;

    setIsCreating(true);
    setCreateError(null);
    try {
      const run = await createRun(createRunRequest.data.jobUrl, createRunRequest.data.generateKeywordMap);
      router.push(`/runs/${encodeURIComponent(run.id)}`);
    } catch (error) {
      setCreateError(publicMessage(error, "The application could not be initialized. Try again."));
      setIsCreating(false);
    }
  };

  const showFilteredEmpty = !isLoading && runs.length > 0 && filteredRuns.length === 0;
  const showInitialEmpty = !isLoading && !loadError && runs.length === 0;

  return (
    <main className="workspace">
      <header className="applications-header">
        <h1>Applications</h1>
      </header>

      <form
        className="run-initializer"
        aria-label="Initialize application"
        noValidate
        onSubmit={(event) => void submitRun(event)}
      >
        <div className="run-initializer__field">
          <label className="run-initializer__label" htmlFor="job-url">Job posting URL</label>
          <input
            id="job-url"
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://company.com/jobs/role"
            value={jobUrl}
            disabled={isCreating}
            aria-invalid={createError ? true : undefined}
            aria-describedby={createError ? "job-url-error" : undefined}
            aria-errormessage={createError ? "job-url-error" : undefined}
            onChange={(event) => {
              setJobUrl(event.target.value);
              setCreateError(null);
            }}
          />
        </div>
        <div className="run-initializer__option">
          <input
            id="generate-keyword-map"
            type="checkbox"
            checked={generateKeywordMap}
            disabled={isCreating}
            onChange={(event) => {
              setGenerateKeywordMap(event.target.checked);
              setCreateError(null);
            }}
          />
          <label className="run-initializer__option-label" htmlFor="generate-keyword-map">
            Generate resume-to-job-description keyword map
          </label>
        </div>

        <button
          className="square-control square-control--primary"
          type="submit"
          disabled={isCreating || !isCreateRequestValid}
        >
          {isCreating ? "Initializing…" : "Initialize"}
        </button>
        {createError ? <p className="dashboard-alert" id="job-url-error" role="alert">{createError}</p> : null}
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
                type="search"
                value={query}
                placeholder="Search applications"
                onChange={(event) => updateQuery(event.target.value)}
              />
            </label>
            <div className="applications-toolbar__actions">
              <label className="select-control">
                <span>State</span>
                <select aria-label="Filter applications by state" value={statusFilter} onChange={(event) => updateStatus(event.target.value as ApplicationStatus | "all")}>
                  <option value="all">All states</option>
                  {SELECTABLE_APPLICATION_STATUSES.map((status) => <option value={status} key={status}>{APPLICATION_STATUS_LABELS[status]}</option>)}
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
                    <th scope="col"><span className="visually-hidden">Open application</span></th>
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
                          <p>No applications yet. Enter a job posting URL above to initialize one.</p>
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
                    const identity = jobIdentities[run.id];
                    const href = `/runs/${encodeURIComponent(run.id)}`;
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
                          <Link className="application-link" href={href} aria-label={identity?.title ? `Open ${identity.title} ${shortRunId(run.id)}` : `Open application ${shortRunId(run.id)}`}>
                            {identity?.title ? <span>{identity.title}</span> : <span className="table-placeholder-line" aria-hidden="true" />}
                          </Link>
                        </td>
                        <td>{identity?.organization ? <span className="application-organization-name">{identity.organization}</span> : <span className="table-placeholder-line table-placeholder-line--organization" role="img" aria-label="Unknown organization" />}</td>
                        <td><time dateTime={new Date(run.updatedAt).toISOString()}>{DATE_FORMATTER.format(new Date(run.updatedAt))}</time></td>
                        <td>
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
                        </td>
                        <td><span className="row-arrow" aria-hidden="true">→</span></td>
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

    </main>
  );
}
