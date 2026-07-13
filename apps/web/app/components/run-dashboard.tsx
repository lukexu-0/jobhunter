"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ArtifactDto, RunDto, RunStatus } from "@jobhunter/pipeline/contracts";
import { PipelineClientError, createRun, listRuns, readJsonArtifact } from "../lib/pipeline-client";
import { OAuthDashboard } from "./oauth-dashboard";

const PAGE_SIZE = 8;
const POLL_INTERVAL_MS = 3_000;
const MIN_JOB_DESCRIPTION_LENGTH = 40;
const MAX_JOB_DESCRIPTION_LENGTH = 50_000;
const MAX_PUBLIC_MESSAGE_LENGTH = 240;

const RUN_STATUSES = [
  "queued",
  "analyzing",
  "tailoring",
  "editing",
  "compiling",
  "repairing",
  "deterministic_qa",
  "visual_qa",
  "review",
  "approved",
  "failed",
] as const satisfies readonly RunStatus[];

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  analyzing: "Analyzing",
  tailoring: "Tailoring",
  editing: "Editing",
  compiling: "Compiling",
  repairing: "Repairing",
  deterministic_qa: "Deterministic QA",
  visual_qa: "Visual QA",
  review: "In review",
  approved: "Approved",
  failed: "Failed",
};

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
const CAN_HAVE_JOB_METADATA: Record<RunStatus, boolean> = {
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
  failed: false,
};
const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

interface JobIdentity {
  title: string;
  organization?: string;
}

type SortDirection = "newest" | "oldest";

function publicMessage(error: unknown, fallback: string): string {
  if (!(error instanceof PipelineClientError)) return fallback;
  const message = error.message.trim();
  if (!message) return fallback;
  return message.slice(0, MAX_PUBLIC_MESSAGE_LENGTH);
}

function parseJobIdentity(value: unknown): JobIdentity | null {
  if (!value || typeof value !== "object" || !("target" in value)) return null;
  const target = value.target;
  if (!target || typeof target !== "object" || !("title" in target)) return null;
  const title = typeof target.title === "string" ? target.title.trim() : "";
  if (!title) return null;
  const organization =
    "organization" in target && typeof target.organization === "string"
      ? target.organization.trim()
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
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [jobIdentities, setJobIdentities] = useState<Record<string, JobIdentity>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<RunStatus | "all">("all");
  const [sortDirection, setSortDirection] = useState<SortDirection>("newest");
  const [currentPage, setCurrentPage] = useState(1);
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [jobDescription, setJobDescription] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const requestedArtifacts = useRef(new Set<string>());

  const load = useCallback(async (initial = false) => {
    if (initial) setIsLoading(true);
    try {
      const nextRuns = await listRuns();
      setRuns(nextRuns);
      setLoadError(null);
    } catch (error) {
      setLoadError(publicMessage(error, "Applications are unavailable. Try again."));
    } finally {
      if (initial) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const hasActiveRuns = runs.some((run) => !IS_TERMINAL_STATUS[run.status]);

  useEffect(() => {
    if (!hasActiveRuns) return;
    const interval = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [hasActiveRuns, load]);

  useEffect(() => {
    let current = true;
    const pending = runs.flatMap((run) => {
      if (!CAN_HAVE_JOB_METADATA[run.status]) return [];
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
          if (!identity || !current) return;
          setJobIdentities((existing) => ({ ...existing, [runId]: identity }));
        } catch {
          // Job metadata is optional. The honest run label remains available.
        }
      }),
    );

    return () => {
      current = false;
    };
  }, [runs]);

  const filteredRuns = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return runs
      .filter((run) => statusFilter === "all" || run.status === statusFilter)
      .filter((run) => {
        if (!normalizedQuery) return true;
        const identity = jobIdentities[run.id];
        return [run.id, STATUS_LABELS[run.status], identity?.title, identity?.organization]
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

  const updateStatus = (value: RunStatus | "all") => {
    setStatusFilter(value);
    setCurrentPage(1);
  };

  const submitRun = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const description = jobDescription.trim();
    if (description.length < MIN_JOB_DESCRIPTION_LENGTH || description.length > MAX_JOB_DESCRIPTION_LENGTH) {
      setCreateError(`Enter between ${MIN_JOB_DESCRIPTION_LENGTH} and ${MAX_JOB_DESCRIPTION_LENGTH.toLocaleString()} characters.`);
      return;
    }

    setIsCreating(true);
    setCreateError(null);
    try {
      const run = await createRun(description);
      router.push(`/runs/${encodeURIComponent(run.id)}`);
    } catch (error) {
      setCreateError(publicMessage(error, "The tailoring run could not be created. Try again."));
      setIsCreating(false);
    }
  };

  const toggleComposer = () => {
    setIsComposerOpen((open) => !open);
    setCreateError(null);
  };

  const showFilteredEmpty = !isLoading && runs.length > 0 && filteredRuns.length === 0;
  const showInitialEmpty = !isLoading && !loadError && runs.length === 0;

  return (
    <main className="workspace">
      <div className="workspace__frame">
        <header className="applications-header">
          <div>
            <p className="applications-header__eyebrow">Resume tailoring</p>
            <h1>Applications</h1>
          </div>
          <button
            className="square-control square-control--primary"
            type="button"
            aria-expanded={isComposerOpen}
            aria-controls="new-application-form"
            onClick={toggleComposer}
          >
            <span aria-hidden="true">{isComposerOpen ? "−" : "+"}</span>
            {isComposerOpen ? "Close" : "New"}
          </button>
        </header>

        {isComposerOpen ? (
          <section className="run-composer" id="new-application-form" aria-labelledby="new-application-heading">
            <div className="run-composer__heading">
              <div>
                <p className="applications-label">New application</p>
                <h2 id="new-application-heading">Paste the job description</h2>
              </div>
              <p>Only the job description is submitted to the local pipeline.</p>
            </div>
            <form onSubmit={(event) => void submitRun(event)}>
              <label htmlFor="job-description">Job description</label>
              <textarea
                id="job-description"
                value={jobDescription}
                minLength={MIN_JOB_DESCRIPTION_LENGTH}
                maxLength={MAX_JOB_DESCRIPTION_LENGTH}
                rows={10}
                required
                disabled={isCreating}
                aria-describedby="job-description-help job-description-count"
                aria-invalid={Boolean(createError)}
                onChange={(event) => {
                  setJobDescription(event.target.value);
                  setCreateError(null);
                }}
              />
              <div className="run-composer__meta">
                <p id="job-description-help">{MIN_JOB_DESCRIPTION_LENGTH.toLocaleString()}–{MAX_JOB_DESCRIPTION_LENGTH.toLocaleString()} characters</p>
                <p id="job-description-count">{jobDescription.length.toLocaleString()} / {MAX_JOB_DESCRIPTION_LENGTH.toLocaleString()}</p>
              </div>
              {createError ? <p className="dashboard-alert" role="alert">{createError}</p> : null}
              <div className="run-composer__actions">
                <button className="square-control" type="button" onClick={toggleComposer} disabled={isCreating}>Cancel</button>
                <button className="square-control square-control--primary" type="submit" disabled={isCreating || jobDescription.trim().length < MIN_JOB_DESCRIPTION_LENGTH}>
                  {isCreating ? "Creating…" : "Create run"}
                </button>
              </div>
            </form>
          </section>
        ) : null}

        <section className="applications-summary" aria-label="Application count">
          <p className="applications-label">Total applications</p>
          <p className="applications-total">{isLoading || (loadError && runs.length === 0) ? "—" : runs.length.toLocaleString()}</p>
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
                <select value={statusFilter} onChange={(event) => updateStatus(event.target.value as RunStatus | "all")}>
                  <option value="all">All states</option>
                  {RUN_STATUSES.map((status) => <option value={status} key={status}>{STATUS_LABELS[status]}</option>)}
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

            <div className="applications-table-scroll">
              <table className="applications-table" aria-busy={isLoading}>
                <thead>
                  <tr>
                    <th scope="col">Target role</th>
                    <th scope="col">Organization</th>
                    <th scope="col">Updated</th>
                    <th scope="col">Status</th>
                    <th scope="col">Revision</th>
                    <th scope="col"><span className="visually-hidden">Open application</span></th>
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
                          <p>No applications yet. Create a run from a real job description to begin.</p>
                          <button className="inline-control" type="button" onClick={() => setIsComposerOpen(true)}>Create first application</button>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {showFilteredEmpty ? (
                    <tr>
                      <td colSpan={6}>
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
                      <tr key={run.id}>
                        <td>
                          <Link className="application-link" href={href} aria-label={`Open ${identity?.title ?? "tailoring run"} ${shortRunId(run.id)}`}>
                            <span>{identity?.title ?? "Tailoring run"}</span>
                            <span className="application-link__id">{shortRunId(run.id)}</span>
                          </Link>
                        </td>
                        <td>{identity?.organization ?? <span className="table-muted">Not available</span>}</td>
                        <td><time dateTime={new Date(run.updatedAt).toISOString()}>{DATE_FORMATTER.format(new Date(run.updatedAt))}</time></td>
                        <td><span className={`run-status run-status--${run.status}`}>{STATUS_LABELS[run.status]}</span></td>
                        <td><span className="revision-value">R{run.revision.toString().padStart(2, "0")}</span></td>
                        <td><Link className="row-arrow" href={href} aria-label={`Open run ${shortRunId(run.id)}`}>→</Link></td>
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

        <details className="provider-access">
          <summary>
            <span>Provider access</span>
            <span className="provider-access__hint">OAuth connection controls</span>
          </summary>
          <OAuthDashboard />
        </details>
      </div>
    </main>
  );
}
