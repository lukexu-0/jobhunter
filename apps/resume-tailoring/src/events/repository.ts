import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  RecruitingEventPreferencesSchema,
  UpdateRecruitingEventPreferencesRequestSchema,
  type RecruitingEventDashboardResponse,
  type RecruitingEventPreferences,
  type RecruitingEventScrapeRun,
  type UpdateRecruitingEventPreferencesRequest,
} from "../contracts";

export const RECRUITING_EVENT_CADENCE_MS = 24 * 60 * 60 * 1_000;

export interface RecruitingEventSource {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly category: "employer" | "professional_organization" | "university" | "event_platform";
}

export interface RecruitingEventCandidate {
  readonly title: string;
  readonly organizer: string;
  readonly startAt: number;
  readonly endAt?: number;
  readonly timezone?: string;
  readonly location?: string;
  readonly attendance: "virtual" | "in_person" | "hybrid" | "unknown";
  readonly registrationUrl: string;
  readonly description?: string;
  readonly eligibilitySummary?: string;
  readonly matchedForApplicant: boolean;
}

interface ScrapeRunRow {
  id: string;
  trigger: "startup" | "scheduled" | "manual";
  state: "running" | "completed" | "partial" | "failed";
  started_at: number;
  completed_at: number | null;
  preferences_json: string;
  source_count: number;
  succeeded_source_count: number;
  failed_source_count: number;
  event_count: number;
}

interface RecruitingEventRow {
  id: string;
  title: string;
  organizer: string;
  start_at: number;
  end_at: number | null;
  timezone: string | null;
  location: string | null;
  attendance: "virtual" | "in_person" | "hybrid" | "unknown";
  registration_url: string;
  description: string | null;
  eligibility_summary: string | null;
  matched_for_applicant: number;
  first_seen_at: number;
  last_seen_at: number;
}

interface IssueRow {
  source_id: string;
  source_name: string;
  source_url: string;
  issue_code: string;
  issue_message: string;
  completed_at: number;
}

export interface RecruitingEventRepositoryOptions {
  readonly idFactory?: () => string;
}

export class RecruitingEventRunConflictError extends Error {
  constructor() {
    super("A recruiting event scrape is already running");
    this.name = "RecruitingEventRunConflictError";
  }
}

function compact(value: string, maximum: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}

function identityText(value: string, organizer = false): string {
  let normalized = compact(value, 300)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (organizer) {
    normalized = normalized
      .replace(/\b(?:incorporated|inc|corporation|corp|company|co|llc|ltd)\b$/u, "")
      .trim();
  }
  return normalized;
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

function fingerprint(candidate: RecruitingEventCandidate): string {
  const identity = [
    identityText(candidate.title),
    identityText(candidate.organizer, true),
    String(candidate.startAt),
  ].join("\u001f");
  return createHash("sha256").update(identity).digest("hex");
}

function publicRun(row: ScrapeRunRow): RecruitingEventScrapeRun {
  return {
    id: row.id,
    trigger: row.trigger,
    state: row.state,
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    sourceCount: row.source_count,
    succeededSourceCount: row.succeeded_source_count,
    failedSourceCount: row.failed_source_count,
    eventCount: row.event_count,
  };
}

export class RecruitingEventRepository {
  readonly #db: Database;
  readonly #idFactory: () => string;

  constructor(db: Database, options: RecruitingEventRepositoryOptions = {}) {
    this.#db = db;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  #immediate<T>(body: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #run(id: string): ScrapeRunRow {
    const row = this.#db.query<ScrapeRunRow, [string]>(
      "SELECT * FROM recruiting_event_scrape_runs WHERE id = ?",
    ).get(id);
    if (!row) throw new Error("Recruiting event scrape run was not found");
    return row;
  }

  getPreferences(): RecruitingEventPreferences {
    const row = this.#db.query<{ school: string | null }, []>(
      "SELECT school FROM recruiting_event_preferences WHERE id = 1",
    ).get();
    return RecruitingEventPreferencesSchema.parse({ school: row?.school ?? null });
  }

  setPreferences(
    input: UpdateRecruitingEventPreferencesRequest,
    updatedAt: number,
  ): RecruitingEventPreferences {
    const preferences = UpdateRecruitingEventPreferencesRequestSchema.parse(input);
    this.#db.query(`
      UPDATE recruiting_event_preferences
      SET school = ?, updated_at = ?
      WHERE id = 1
    `).run(preferences.school, updatedAt);
    return { school: preferences.school };
  }

  startRun(input: {
    readonly trigger: "startup" | "scheduled" | "manual";
    readonly sourceCount: number;
    readonly startedAt: number;
  }): RecruitingEventScrapeRun {
    if (!Number.isSafeInteger(input.sourceCount) || input.sourceCount < 0) {
      throw new Error("Recruiting event source count is invalid");
    }
    if (!Number.isSafeInteger(input.startedAt) || input.startedAt < 0) {
      throw new Error("Recruiting event scrape start time is invalid");
    }

    return this.#immediate(() => {
      const active = this.#db.query<{ id: string }, []>(
        "SELECT id FROM recruiting_event_scrape_runs WHERE state = 'running' LIMIT 1",
      ).get();
      if (active) throw new RecruitingEventRunConflictError();
      const id = this.#idFactory();
      const preferences = this.getPreferences();
      this.#db.query(`
        INSERT INTO recruiting_event_scrape_runs(
          id, trigger, state, started_at, preferences_json, source_count
        ) VALUES (?, ?, 'running', ?, ?, ?)
      `).run(id, input.trigger, input.startedAt, JSON.stringify(preferences), input.sourceCount);
      return publicRun(this.#run(id));
    });
  }

  completeSource(
    runId: string,
    source: RecruitingEventSource,
    parser: "deterministic" | "llm",
    candidates: readonly RecruitingEventCandidate[],
    completedAt: number,
  ): void {
    this.#immediate(() => {
      const run = this.#run(runId);
      if (run.state !== "running") throw new Error("Recruiting event scrape is not running");
      const uniqueEventIds = new Set<string>();
      for (const candidate of candidates) {
        const eventFingerprint = fingerprint(candidate);
        const existing = this.#db.query<{ id: string }, [string]>(
          "SELECT id FROM recruiting_events WHERE fingerprint = ?",
        ).get(eventFingerprint);
        const eventId = existing?.id ?? this.#idFactory();
        if (!existing) {
          this.#db.query(`
            INSERT INTO recruiting_events(
              id, fingerprint, title, organizer, start_at, end_at, timezone, location,
              attendance, registration_url, description, eligibility_summary,
              matched_for_applicant, first_seen_at, last_seen_at, last_scrape_run_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            eventId,
            eventFingerprint,
            compact(candidate.title, 300),
            compact(candidate.organizer, 200),
            candidate.startAt,
            candidate.endAt ?? null,
            candidate.timezone ? compact(candidate.timezone, 100) : null,
            candidate.location ? compact(candidate.location, 300) : null,
            candidate.attendance,
            canonicalUrl(candidate.registrationUrl),
            candidate.description ? compact(candidate.description, 4_000) : null,
            candidate.eligibilitySummary ? compact(candidate.eligibilitySummary, 1_000) : null,
            candidate.matchedForApplicant ? 1 : 0,
            completedAt,
            completedAt,
            runId,
          );
        } else {
          this.#db.query(`
            UPDATE recruiting_events
            SET end_at = coalesce(?, end_at),
                timezone = coalesce(?, timezone),
                location = coalesce(?, location),
                attendance = CASE WHEN ? = 'unknown' THEN attendance ELSE ? END,
                registration_url = ?,
                description = coalesce(?, description),
                eligibility_summary = coalesce(?, eligibility_summary),
                matched_for_applicant = max(matched_for_applicant, ?),
                last_seen_at = ?,
                last_scrape_run_id = ?
            WHERE id = ?
          `).run(
            candidate.endAt ?? null,
            candidate.timezone ? compact(candidate.timezone, 100) : null,
            candidate.location ? compact(candidate.location, 300) : null,
            candidate.attendance,
            candidate.attendance,
            canonicalUrl(candidate.registrationUrl),
            candidate.description ? compact(candidate.description, 4_000) : null,
            candidate.eligibilitySummary ? compact(candidate.eligibilitySummary, 1_000) : null,
            candidate.matchedForApplicant ? 1 : 0,
            completedAt,
            runId,
            eventId,
          );
        }
        this.#db.query(`
          INSERT INTO recruiting_event_sources(
            event_id, source_id, source_url, first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(event_id, source_id) DO UPDATE SET
            source_url = excluded.source_url,
            last_seen_at = excluded.last_seen_at
        `).run(eventId, source.id, canonicalUrl(source.url), completedAt, completedAt);
        uniqueEventIds.add(eventId);
      }
      this.#db.query(`
        INSERT INTO recruiting_event_source_attempts(
          run_id, source_id, source_name, source_url, state, parser,
          event_count, completed_at
        ) VALUES (?, ?, ?, ?, 'succeeded', ?, ?, ?)
      `).run(
        runId,
        compact(source.id, 100),
        compact(source.name, 200),
        canonicalUrl(source.url),
        parser,
        uniqueEventIds.size,
        completedAt,
      );
    });
  }

  failSource(
    runId: string,
    source: RecruitingEventSource,
    code: string,
    message: string,
    completedAt: number,
  ): void {
    this.#immediate(() => {
      const run = this.#run(runId);
      if (run.state !== "running") throw new Error("Recruiting event scrape is not running");
      this.#db.query(`
        INSERT INTO recruiting_event_source_attempts(
          run_id, source_id, source_name, source_url, state, parser,
          event_count, issue_code, issue_message, completed_at
        ) VALUES (?, ?, ?, ?, 'failed', 'none', 0, ?, ?, ?)
      `).run(
        runId,
        compact(source.id, 100),
        compact(source.name, 200),
        canonicalUrl(source.url),
        compact(code, 64),
        compact(message, 240),
        completedAt,
      );
    });
  }

  finishRun(runId: string, completedAt: number): RecruitingEventScrapeRun {
    return this.#immediate(() => {
      const run = this.#run(runId);
      if (run.state !== "running") return publicRun(run);
      const counts = this.#db.query<{
        succeeded: number | null;
        failed: number | null;
        event_count: number;
      }, [string, string]>(`
        SELECT
          sum(CASE WHEN state = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
          sum(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
          (SELECT count(DISTINCT event_id)
             FROM recruiting_event_sources
             JOIN recruiting_events ON recruiting_events.id = recruiting_event_sources.event_id
            WHERE recruiting_events.last_scrape_run_id = ?) AS event_count
        FROM recruiting_event_source_attempts
        WHERE run_id = ?
      `).get(runId, runId) ?? { succeeded: 0, failed: 0, event_count: 0 };
      const succeeded = Number(counts.succeeded ?? 0);
      const failed = Number(counts.failed ?? 0);
      const state = failed === 0 ? "completed" : succeeded === 0 ? "failed" : "partial";
      this.#db.query(`
        UPDATE recruiting_event_scrape_runs
        SET state = ?, completed_at = ?, succeeded_source_count = ?,
            failed_source_count = ?, event_count = ?
        WHERE id = ? AND state = 'running'
      `).run(state, completedAt, succeeded, failed, counts.event_count, runId);
      return publicRun(this.#run(runId));
    });
  }

  recoverInterruptedRun(completedAt: number): RecruitingEventScrapeRun | null {
    return this.#immediate(() => {
      const row = this.#db.query<ScrapeRunRow, []>(
        "SELECT * FROM recruiting_event_scrape_runs WHERE state = 'running' LIMIT 1",
      ).get();
      if (!row) return null;
      const succeeded = Number(this.#db.query<{ count: number }, [string]>(`
        SELECT count(*) AS count
        FROM recruiting_event_source_attempts
        WHERE run_id = ? AND state = 'succeeded'
      `).get(row.id)?.count ?? 0);
      const failed = Math.max(0, row.source_count - succeeded);
      const eventCount = Number(this.#db.query<{ count: number }, [string]>(`
        SELECT count(DISTINCT event_id) AS count
        FROM recruiting_event_sources
        JOIN recruiting_events ON recruiting_events.id = recruiting_event_sources.event_id
        WHERE recruiting_events.last_scrape_run_id = ?
      `).get(row.id)?.count ?? 0);
      this.#db.query(`
        UPDATE recruiting_event_scrape_runs
        SET state = 'failed', completed_at = ?, succeeded_source_count = ?,
            failed_source_count = ?, event_count = ?
        WHERE id = ? AND state = 'running'
      `).run(completedAt, succeeded, failed, eventCount, row.id);
      return publicRun(this.#run(row.id));
    });
  }

  latestRun(): RecruitingEventScrapeRun | null {
    const row = this.#db.query<ScrapeRunRow, []>(`
      SELECT * FROM recruiting_event_scrape_runs
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1
    `).get();
    return row ? publicRun(row) : null;
  }

  getDashboard(input: {
    readonly sourceCount: number;
    readonly now: number;
  }): RecruitingEventDashboardResponse {
    const latestRow = this.#db.query<ScrapeRunRow, []>(`
      SELECT * FROM recruiting_event_scrape_runs
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1
    `).get();
    const eventRows = this.#db.query<RecruitingEventRow, [number]>(`
      SELECT id, title, organizer, start_at, end_at, timezone, location, attendance,
             registration_url, description, eligibility_summary, matched_for_applicant,
             first_seen_at, last_seen_at
      FROM recruiting_events
      WHERE coalesce(end_at, start_at) >= ?
      ORDER BY start_at ASC, title COLLATE NOCASE ASC
      LIMIT 1000
    `).all(input.now);
    const events = eventRows.map((row) => {
      const sources = this.#db.query<{ source_url: string }, [string]>(`
        SELECT source_url FROM recruiting_event_sources
        WHERE event_id = ?
        ORDER BY first_seen_at ASC, source_id ASC
      `).all(row.id);
      return {
        id: row.id,
        title: row.title,
        organizer: row.organizer,
        startAt: row.start_at,
        ...(row.end_at === null ? {} : { endAt: row.end_at }),
        ...(row.timezone === null ? {} : { timezone: row.timezone }),
        ...(row.location === null ? {} : { location: row.location }),
        attendance: row.attendance,
        registrationUrl: row.registration_url,
        sourceUrls: sources.map((source) => source.source_url),
        ...(row.description === null ? {} : { description: row.description }),
        ...(row.eligibility_summary === null
          ? {}
          : { eligibilitySummary: row.eligibility_summary }),
        matchedForApplicant: row.matched_for_applicant === 1,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      };
    });
    const issues = latestRow
      ? this.#db.query<IssueRow, [string]>(`
          SELECT source_id, source_name, source_url, issue_code, issue_message, completed_at
          FROM recruiting_event_source_attempts
          WHERE run_id = ? AND state = 'failed'
          ORDER BY completed_at ASC, source_id ASC
          LIMIT 500
        `).all(latestRow.id).map((row) => ({
          sourceId: row.source_id,
          sourceName: row.source_name,
          sourceUrl: row.source_url,
          code: row.issue_code,
          message: row.issue_message,
          occurredAt: row.completed_at,
        }))
      : [];

    return {
      preferences: this.getPreferences(),
      schedule: {
        cadenceHours: 24,
        nextRunAt: latestRow ? latestRow.started_at + RECRUITING_EVENT_CADENCE_MS : null,
        running: latestRow?.state === "running",
        sourceCount: input.sourceCount,
      },
      latestRun: latestRow ? publicRun(latestRow) : null,
      events,
      issues,
    };
  }
}
