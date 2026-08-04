import { OAuthRequiredError } from "../auth/oauth-only-resolver.ts";
import { JobSourceError } from "../api/job-source.ts";
import {
  RecruitingEventScrapeConflictError,
  type RecruitingEventRouteService,
  type RecruitingEventScrapeTrigger,
} from "../api/recruiting-event-routes.ts";
import type {
  RecruitingEventDashboardResponse,
  RecruitingEventPreferences,
  RecruitingEventScrapeRun,
  UpdateRecruitingEventPreferencesRequest,
} from "../contracts";
import {
  LunaEventExtractionError,
  extractRecruitingEventsWithLuna,
} from "../models/luna-event-extractor.ts";
import {
  parseRecruitingEventSource,
  type ExtractRecruitingEventsWithModel,
  type LoadedRecruitingEventSource,
  type RecruitingEventParseOptions,
  type RecruitingEventParseResult,
} from "./parser.ts";
import {
  RECRUITING_EVENT_CADENCE_MS,
  RecruitingEventRepository,
  RecruitingEventRunConflictError,
  type RecruitingEventSource,
} from "./repository.ts";
import { loadRecruitingEventSourceFromUrl } from "./source.ts";
import { RECRUITING_EVENT_SOURCES } from "./sources.ts";

const SCHEDULE_CHECK_MS = 60 * 60 * 1_000;
const SOURCE_CONCURRENCY = 4;

export type LoadRecruitingEventSource = (
  url: string,
  signal?: AbortSignal,
) => Promise<LoadedRecruitingEventSource>;

export type ParseRecruitingEventSource = (
  source: LoadedRecruitingEventSource,
  options: RecruitingEventParseOptions,
) => Promise<RecruitingEventParseResult>;

export interface RecruitingEventServiceOptions {
  readonly repository: RecruitingEventRepository;
  readonly sources?: readonly RecruitingEventSource[];
  readonly loadSource?: LoadRecruitingEventSource;
  readonly parseSource?: ParseRecruitingEventSource;
  readonly extractWithModel?: ExtractRecruitingEventsWithModel;
  readonly now?: () => number;
  readonly scheduleCheckMs?: number;
}

function publicIssue(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof JobSourceError) {
    switch (error.code) {
      case "JOB_URL_BLOCKED":
        return { code: "SOURCE_BLOCKED", message: "The event source is not a public HTTP(S) address" };
      case "JOB_SOURCE_UNSUPPORTED":
        return { code: "SOURCE_UNSUPPORTED", message: "The event source is not HTML or plain text" };
      case "JOB_SOURCE_TOO_LARGE":
        return { code: "SOURCE_TOO_LARGE", message: "The event source is too large to parse" };
      case "JOB_DESCRIPTION_UNAVAILABLE":
        return { code: "SOURCE_EMPTY", message: "The event source has no usable visible text" };
      case "JOB_SOURCE_UNAVAILABLE":
        return { code: "SOURCE_UNAVAILABLE", message: "The event source could not be loaded" };
    }
  }
  if (error instanceof OAuthRequiredError) {
    return {
      code: "LLM_AUTH_REQUIRED",
      message: "OpenAI Codex must be connected to parse this event source",
    };
  }
  if (error instanceof LunaEventExtractionError) {
    return error.kind === "timeout"
      ? { code: "LLM_TIMEOUT", message: "The event parser timed out" }
      : { code: "LLM_UNAVAILABLE", message: "The event parser could not read this source" };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "SCRAPE_CANCELLED", message: "The event scrape was cancelled" };
  }
  return { code: "SOURCE_PARSE_FAILED", message: "The event source could not be parsed" };
}

export class RecruitingEventService implements RecruitingEventRouteService {
  readonly #repository: RecruitingEventRepository;
  readonly #sources: readonly RecruitingEventSource[];
  readonly #loadSource: LoadRecruitingEventSource;
  readonly #parseSource: ParseRecruitingEventSource;
  readonly #extractWithModel: ExtractRecruitingEventsWithModel;
  readonly #now: () => number;
  readonly #scheduleCheckMs: number;
  #active: Promise<void> | undefined;
  #controller: AbortController | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(options: RecruitingEventServiceOptions) {
    this.#repository = options.repository;
    this.#sources = options.sources ?? RECRUITING_EVENT_SOURCES;
    const sourceIds = new Set<string>();
    for (const source of this.#sources) {
      if (sourceIds.has(source.id)) {
        throw new Error(`Recruiting event source ID is duplicated: ${source.id}`);
      }
      sourceIds.add(source.id);
    }
    this.#loadSource = options.loadSource ?? loadRecruitingEventSourceFromUrl;
    this.#parseSource = options.parseSource ?? parseRecruitingEventSource;
    this.#extractWithModel = options.extractWithModel ?? extractRecruitingEventsWithLuna;
    this.#now = options.now ?? Date.now;
    this.#scheduleCheckMs = options.scheduleCheckMs ?? SCHEDULE_CHECK_MS;
  }

  getDashboard(): RecruitingEventDashboardResponse {
    return this.#repository.getDashboard({
      sourceCount: this.#sources.length,
      now: this.#now(),
    });
  }

  setPreferences(
    preferences: UpdateRecruitingEventPreferencesRequest,
  ): RecruitingEventPreferences {
    return this.#repository.setPreferences(preferences, this.#now());
  }

  #startRun(
    trigger: RecruitingEventScrapeTrigger,
    recoverInterrupted = true,
  ): RecruitingEventScrapeRun {
    if (this.#closed) throw new Error("Recruiting event service is closed");
    if (this.#active) throw new RecruitingEventScrapeConflictError();
    if (recoverInterrupted) this.#repository.recoverInterruptedRun(this.#now());
    let run: RecruitingEventScrapeRun;
    try {
      run = this.#repository.startRun({
        trigger,
        sourceCount: this.#sources.length,
        startedAt: this.#now(),
      });
    } catch (error) {
      if (error instanceof RecruitingEventRunConflictError) {
        throw new RecruitingEventScrapeConflictError();
      }
      throw error;
    }

    const preferences = this.#repository.getPreferences();
    const controller = new AbortController();
    this.#controller = controller;
    const active = this.#execute(run.id, preferences, controller.signal)
      .finally(() => {
        if (this.#active === active) this.#active = undefined;
        if (this.#controller === controller) this.#controller = undefined;
      });
    this.#active = active;
    void active.catch(() => undefined);
    return run;
  }

  requestScrape(trigger: RecruitingEventScrapeTrigger): RecruitingEventScrapeRun {
    return this.#startRun(trigger);
  }

  runIfDue(trigger: "startup" | "scheduled"): RecruitingEventScrapeRun | null {
    if (this.#closed || this.#active) return null;
    const now = this.#now();
    this.#repository.recoverInterruptedRun(now);
    const latest = this.#repository.latestRun();
    if (latest?.state === "running") return null;
    if (latest && now < latest.startedAt + RECRUITING_EVENT_CADENCE_MS) return null;
    return this.#startRun(trigger, false);
  }

  recoverInterruptedRun(): RecruitingEventScrapeRun | null {
    if (this.#active) return null;
    return this.#repository.recoverInterruptedRun(this.#now());
  }

  start(): void {
    if (this.#closed || this.#timer) return;
    this.runIfDue("startup");
    this.#timer = setInterval(() => {
      try {
        this.runIfDue("scheduled");
      } catch {
        // A failed scheduling check is retried on the next bounded interval.
      }
    }, this.#scheduleCheckMs);
    this.#timer.unref?.();
  }

  async #execute(
    runId: string,
    preferences: RecruitingEventPreferences,
    signal: AbortSignal,
  ): Promise<void> {
    let nextSource = 0;
    const processNext = async (): Promise<void> => {
      while (nextSource < this.#sources.length) {
        const source = this.#sources[nextSource++]!;
        let parsed: RecruitingEventParseResult;
        try {
          const loaded = await this.#loadSource(source.url, signal);
          parsed = await this.#parseSource(loaded, {
            preferences,
            now: this.#now(),
            extractWithModel: this.#extractWithModel,
            signal,
          });
        } catch (error) {
          const issue = publicIssue(error);
          this.#repository.failSource(
            runId,
            source,
            issue.code,
            issue.message,
            this.#now(),
          );
          continue;
        }
        this.#repository.completeSource(
          runId,
          source,
          parsed.parser,
          parsed.candidates,
          this.#now(),
        );
      }
    };
    const workers = Array.from(
      { length: Math.min(SOURCE_CONCURRENCY, this.#sources.length) },
      () => processNext(),
    );
    const results = await Promise.allSettled(workers);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    this.#repository.finishRun(runId, this.#now());
  }

  async whenIdle(): Promise<void> {
    await this.#active;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      await this.#active;
      return;
    }
    this.#closed = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#controller?.abort(new DOMException("Event scraper closed", "AbortError"));
    await this.#active;
  }
}
