"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  RecruitingEvent,
  RecruitingEventDashboardResponse,
  RecruitingEventScrapeRun,
} from "@jobhunter/pipeline/contracts";
import {
  getRecruitingEventDashboard,
  requestRecruitingEventScrape,
  updateRecruitingEventPreferences,
} from "../lib/pipeline-client";

const SCRAPE_POLL_INTERVAL_MS = 3_000;
const SCHOOL_MAX_LENGTH = 200;
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

const ATTENDANCE_LABELS: Readonly<Record<RecruitingEvent["attendance"], string>> = {
  virtual: "Virtual",
  in_person: "In person",
  hybrid: "Hybrid",
  unknown: "To be confirmed",
};

const RUN_STATE_LABELS: Readonly<Record<RecruitingEventScrapeRun["state"], string>> = {
  running: "Running",
  completed: "Completed",
  partial: "Partial",
  failed: "Failed",
};

const RUN_TRIGGER_LABELS: Readonly<Record<RecruitingEventScrapeRun["trigger"], string>> = {
  startup: "Startup",
  scheduled: "Scheduled",
  manual: "Manual",
};

interface DisplayTime {
  readonly dateTime: string;
  readonly label: string;
}

function displayTime(timestamp: number): DisplayTime | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return {
      dateTime: date.toISOString(),
      label: DATE_TIME_FORMATTER.format(date),
    };
  } catch {
    return null;
  }
}

function TimeValue({ timestamp }: { readonly timestamp: number }): ReactNode {
  const value = displayTime(timestamp);
  return value ? <time dateTime={value.dateTime}>{value.label}</time> : <span>Unavailable</span>;
}

function publicError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function EventDate({ event }: { readonly event: RecruitingEvent }): ReactNode {
  return (
    <span className="event-date">
      <TimeValue timestamp={event.startAt} />
      {event.endAt === undefined ? null : (
        <span className="event-date__end">Ends <TimeValue timestamp={event.endAt} /></span>
      )}
      {event.timezone ? <span className="event-date__timezone">{event.timezone}</span> : null}
    </span>
  );
}

export function EventsDashboard(): ReactNode {
  const [dashboard, setDashboard] = useState<RecruitingEventDashboardResponse>();
  const [school, setSchool] = useState("");
  const [savedSchool, setSavedSchool] = useState("");
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSavingSchool, setIsSavingSchool] = useState(false);
  const [isStartingScrape, setIsStartingScrape] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [schoolError, setSchoolError] = useState<string | null>(null);
  const [schoolNotice, setSchoolNotice] = useState<string | null>(null);
  const [scrapeError, setScrapeError] = useState<string | null>(null);
  const [scrapeNotice, setScrapeNotice] = useState<string | null>(null);
  const schoolInitializedRef = useRef(false);
  const latestLoadRequestRef = useRef(0);

  const loadDashboard = useCallback(async (initial = false) => {
    const requestId = latestLoadRequestRef.current + 1;
    latestLoadRequestRef.current = requestId;
    if (initial) setIsInitialLoading(true);
    else setIsRefreshing(true);

    try {
      const nextDashboard = await getRecruitingEventDashboard();
      if (requestId !== latestLoadRequestRef.current) return;
      setDashboard(nextDashboard);
      setLoadError(null);
      if (!schoolInitializedRef.current) {
        schoolInitializedRef.current = true;
        setSchool(nextDashboard.preferences.school ?? "");
        setSavedSchool(nextDashboard.preferences.school ?? "");
      }
    } catch (error) {
      if (requestId === latestLoadRequestRef.current) {
        setLoadError(publicError(error, "Recruiting events could not be loaded. Try again."));
      }
    } finally {
      if (requestId === latestLoadRequestRef.current) {
        if (initial) setIsInitialLoading(false);
        else setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadDashboard(true);
  }, [loadDashboard]);

  const scrapeRunning = dashboard?.schedule.running === true || dashboard?.latestRun?.state === "running";

  useEffect(() => {
    if (!scrapeRunning) return;
    const interval = window.setInterval(() => void loadDashboard(), SCRAPE_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadDashboard, scrapeRunning]);

  const normalizedSchool = school.trim();
  const schoolChanged = normalizedSchool !== savedSchool;
  const schoolValid = normalizedSchool.length > 0 && normalizedSchool.length <= SCHOOL_MAX_LENGTH;

  const saveSchool = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!schoolValid) {
      setSchoolError(`Enter a school name between 1 and ${SCHOOL_MAX_LENGTH} characters.`);
      setSchoolNotice(null);
      return;
    }

    setIsSavingSchool(true);
    setSchoolError(null);
    setSchoolNotice(null);
    try {
      const preferences = await updateRecruitingEventPreferences(normalizedSchool);
      setDashboard((current) => current ? { ...current, preferences } : current);
      setSchool(preferences.school ?? "");
      setSavedSchool(preferences.school ?? "");
      setSchoolNotice("School preference saved.");
    } catch (error) {
      setSchoolError(publicError(error, "The school preference could not be saved. Try again."));
    } finally {
      setIsSavingSchool(false);
    }
  };

  const startScrape = async () => {
    setIsStartingScrape(true);
    setScrapeError(null);
    setScrapeNotice(null);
    try {
      const { run } = await requestRecruitingEventScrape();
      setDashboard((current) => current ? {
        ...current,
        schedule: { ...current.schedule, running: run.state === "running" },
        latestRun: run,
      } : current);
      setScrapeNotice("Manual scrape started. Results will refresh automatically.");
      void loadDashboard();
    } catch (error) {
      setScrapeError(publicError(error, "The recruiting event scrape could not be started. Try again."));
    } finally {
      setIsStartingScrape(false);
    }
  };

  return (
    <main className="workspace events-workspace">
      <header className="events-header">
        <div>
          <p className="kicker">Recruiting intelligence</p>
          <h1>Events</h1>
          <p>Track upcoming recruiting events from configured sources and review source-level scrape issues.</p>
        </div>
      </header>

      <section className="events-preferences" aria-labelledby="events-school-heading">
        <div className="events-section-heading">
          <div>
            <p className="events-section-label">Matching preference</p>
            <h2 id="events-school-heading">School</h2>
          </div>
          <p>Used to identify events whose eligibility matches your school. Changes are saved only when you submit.</p>
        </div>
        <form className="events-school-form" noValidate onSubmit={(event) => void saveSchool(event)}>
          <label htmlFor="events-school">School</label>
          <div className="events-school-form__controls">
            <input
              id="events-school"
              type="text"
              autoComplete="organization"
              maxLength={SCHOOL_MAX_LENGTH}
              required
              value={school}
              placeholder="Enter your school"
              disabled={isInitialLoading || isSavingSchool}
              aria-invalid={schoolError ? true : undefined}
              aria-describedby={schoolError ? "events-school-hint events-school-error" : "events-school-hint"}
              aria-errormessage={schoolError ? "events-school-error" : undefined}
              onChange={(event) => {
                setSchool(event.currentTarget.value);
                setSchoolError(null);
                setSchoolNotice(null);
              }}
            />
            <button
              className="control control--primary"
              type="submit"
              disabled={isInitialLoading || isSavingSchool || !schoolValid || !schoolChanged}
            >
              {isSavingSchool ? "Saving…" : "Save school"}
            </button>
          </div>
          <p className="events-field-hint" id="events-school-hint">1–200 characters. Leading and trailing spaces are removed.</p>
          {schoolError ? <p className="dashboard-notice dashboard-notice--error" id="events-school-error" role="alert">{schoolError}</p> : null}
          {schoolNotice ? <p className="dashboard-notice dashboard-notice--success" role="status">{schoolNotice}</p> : null}
        </form>
      </section>

      {loadError ? (
        <div className="dashboard-alert dashboard-alert--toolbar" role="alert">
          <span>{loadError}</span>
          <button className="inline-control" type="button" onClick={() => void loadDashboard(!dashboard)}>Retry</button>
        </div>
      ) : null}

      {isInitialLoading && !dashboard ? (
        <p className="events-loading" role="status">Loading recruiting events…</p>
      ) : null}

      {dashboard ? (
        <>
          <section className="events-operations" aria-labelledby="events-operations-heading">
            <div className="events-section-heading events-section-heading--actions">
              <div>
                <p className="events-section-label">24-hour cadence</p>
                <h2 id="events-operations-heading">Schedule and latest run</h2>
              </div>
              <button
                className="control control--primary"
                type="button"
                disabled={isStartingScrape || scrapeRunning}
                onClick={() => void startScrape()}
              >
                {isStartingScrape ? "Starting…" : scrapeRunning ? "Scrape running…" : "Scrape now"}
              </button>
            </div>

            <dl className="events-schedule">
              <div>
                <dt>Schedule</dt>
                <dd>Every {dashboard.schedule.cadenceHours} hours</dd>
              </div>
              <div>
                <dt>Next run</dt>
                <dd>{dashboard.schedule.nextRunAt === null ? "After the first scrape" : <TimeValue timestamp={dashboard.schedule.nextRunAt} />}</dd>
              </div>
              <div>
                <dt>Sources</dt>
                <dd>{dashboard.schedule.sourceCount.toLocaleString()} configured</dd>
              </div>
              <div>
                <dt>Scheduler state</dt>
                <dd><span className={`status-badge status-badge--${scrapeRunning ? "running" : "available"}`}>{scrapeRunning ? "Running" : "Ready"}</span></dd>
              </div>
            </dl>

            {dashboard.latestRun ? (
              <div className="events-latest-run">
                <div className="events-latest-run__heading">
                  <h3>Latest scrape</h3>
                  <span className={`status-badge status-badge--${dashboard.latestRun.state}`}>
                    {RUN_STATE_LABELS[dashboard.latestRun.state]}
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>Trigger</dt>
                    <dd>{RUN_TRIGGER_LABELS[dashboard.latestRun.trigger]}</dd>
                  </div>
                  <div>
                    <dt>Started</dt>
                    <dd><TimeValue timestamp={dashboard.latestRun.startedAt} /></dd>
                  </div>
                  <div>
                    <dt>Completed</dt>
                    <dd>{dashboard.latestRun.completedAt === undefined ? "In progress" : <TimeValue timestamp={dashboard.latestRun.completedAt} />}</dd>
                  </div>
                  <div>
                    <dt>Source result</dt>
                    <dd>{dashboard.latestRun.succeededSourceCount.toLocaleString()} succeeded · {dashboard.latestRun.failedSourceCount.toLocaleString()} failed</dd>
                  </div>
                  <div>
                    <dt>Events found</dt>
                    <dd>{dashboard.latestRun.eventCount.toLocaleString()}</dd>
                  </div>
                </dl>
              </div>
            ) : (
              <p className="events-empty-copy">No scrape has run yet. Save a school preference, then start a manual scrape.</p>
            )}

            <div className="events-live-feedback" aria-live="polite" aria-atomic="true">
              {scrapeError ? <p className="dashboard-notice dashboard-notice--error" role="alert">{scrapeError}</p> : null}
              {scrapeNotice ? <p className="dashboard-notice dashboard-notice--info" role="status">{scrapeNotice}</p> : null}
              {isRefreshing && scrapeRunning && !loadError ? <p className="events-refreshing" role="status">Refreshing latest scrape results…</p> : null}
            </div>
          </section>

          <section className="events-list" aria-labelledby="events-list-heading">
            <div className="events-section-heading">
              <div>
                <p className="events-section-label">Deduplicated feed</p>
                <h2 id="events-list-heading">Upcoming recruiting events</h2>
              </div>
              <p>{dashboard.events.length.toLocaleString()} upcoming</p>
            </div>
            <div className="events-table-scroll">
              <table className="events-table" aria-busy={isRefreshing}>
                <caption className="visually-hidden">Upcoming recruiting events</caption>
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Starts</th>
                    <th scope="col">Format</th>
                    <th scope="col">Match</th>
                    <th scope="col">Registration</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.events.length === 0 ? (
                    <tr>
                      <td colSpan={5}>
                        <p className="events-table-empty">No upcoming events are available. Save your school and run a scrape to refresh the feed.</p>
                      </td>
                    </tr>
                  ) : dashboard.events.map((event) => (
                    <tr key={event.id}>
                      <td>
                        <p className="event-title">{event.title}</p>
                        <p className="event-organizer">{event.organizer}</p>
                        {event.description ? <p className="event-detail">{event.description}</p> : null}
                      </td>
                      <td><EventDate event={event} /></td>
                      <td>
                        <span className="event-format">{ATTENDANCE_LABELS[event.attendance]}</span>
                        {event.location ? <span className="event-location">{event.location}</span> : null}
                      </td>
                      <td>
                        <span className={`status-badge status-badge--${event.matchedForApplicant ? "matched" : "general"}`}>
                          {event.matchedForApplicant ? "Matched" : "Not matched"}
                        </span>
                        {event.eligibilitySummary ? <span className="event-eligibility">{event.eligibilitySummary}</span> : null}
                      </td>
                      <td>
                        <a
                          className="events-external-link"
                          href={event.registrationUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Register for ${event.title}`}
                        >
                          Register <span aria-hidden="true">↗</span>
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="events-issues" aria-labelledby="events-issues-heading">
            <div className="events-section-heading">
              <div>
                <p className="events-section-label">Latest scrape diagnostics</p>
                <h2 id="events-issues-heading">Latest scrape source issues</h2>
              </div>
              <p>{dashboard.issues.length.toLocaleString()} issues</p>
            </div>
            <div className="events-table-scroll">
              <table className="events-table events-issues-table">
                <caption className="visually-hidden">Every source issue from the latest recruiting event scrape</caption>
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Issue</th>
                    <th scope="col">Occurred</th>
                    <th scope="col">Source link</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.issues.length === 0 ? (
                    <tr>
                      <td colSpan={4}>
                        <p className="events-table-empty">The latest scrape reported no source issues.</p>
                      </td>
                    </tr>
                  ) : dashboard.issues.map((issue, index) => (
                    <tr key={`${issue.sourceId}-${issue.occurredAt}-${index}`}>
                      <td>
                        <p className="event-title">{issue.sourceName}</p>
                        <p className="event-organizer">{issue.sourceId}</p>
                      </td>
                      <td>
                        <code className="event-issue-code">{issue.code}</code>
                        <p className="event-issue-message">{issue.message}</p>
                      </td>
                      <td><TimeValue timestamp={issue.occurredAt} /></td>
                      <td>
                        <a
                          className="events-external-link"
                          href={issue.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open ${issue.sourceName} source`}
                        >
                          Open source <span aria-hidden="true">↗</span>
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}
