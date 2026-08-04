import {
  UpdateRecruitingEventPreferencesRequestSchema,
  type RecruitingEventDashboardResponse,
  type RecruitingEventPreferences,
  type RecruitingEventScrapeRun,
  type RecruitingEventScrapeResponse,
  type UpdateRecruitingEventPreferencesRequest,
} from "../contracts";
import { apiResponse } from "./handler.ts";

export type RecruitingEventScrapeTrigger = "startup" | "scheduled" | "manual";

export interface RecruitingEventRouteService {
  getDashboard(): RecruitingEventDashboardResponse | Promise<RecruitingEventDashboardResponse>;
  setPreferences(
    preferences: UpdateRecruitingEventPreferencesRequest,
  ): RecruitingEventPreferences | Promise<RecruitingEventPreferences>;
  requestScrape(
    trigger: RecruitingEventScrapeTrigger,
  ): RecruitingEventScrapeRun | Promise<RecruitingEventScrapeRun>;
}

export class RecruitingEventScrapeConflictError extends Error {
  constructor() {
    super("A recruiting event scrape is already running");
    this.name = "RecruitingEventScrapeConflictError";
  }
}

const MAX_RECRUITING_EVENT_REQUEST_BYTES = 256 * 1024;

class RecruitingEventRequestTooLargeError extends Error {
  constructor() {
    super("Recruiting event request is too large");
    this.name = "RecruitingEventRequestTooLargeError";
  }
}

async function parseBody(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null
    && /^\d+$/.test(contentLength.trim())
    && Number(contentLength) > MAX_RECRUITING_EVENT_REQUEST_BYTES
  ) {
    await request.body?.cancel().catch(() => undefined);
    throw new RecruitingEventRequestTooLargeError();
  }
  if (request.body === null) throw new SyntaxError("Request body is not valid JSON");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";
  const cancel = (): void => {
    void reader.cancel(request.signal.reason).catch(() => undefined);
  };
  if (request.signal.aborted) cancel();
  else request.signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      request.signal.throwIfAborted();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_RECRUITING_EVENT_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RecruitingEventRequestTooLargeError();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally {
    request.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}


export function createRecruitingEventRoutes(service: RecruitingEventRouteService) {
  return async function routeRecruitingEvents(
    request: Request,
    url: URL,
  ): Promise<Response | null> {
    if (request.method === "GET" && url.pathname === "/v1/events") {
      try {
        return apiResponse.json(await service.getDashboard());
      } catch {
        return apiResponse.error(
          "EVENTS_STATUS_FAILED",
          "Recruiting events could not be loaded",
          500,
        );
      }
    }

    if (request.method === "PUT" && url.pathname === "/v1/events/preferences") {
      let body: unknown;
      try {
        body = await parseBody(request);
      } catch (error) {
        if (error instanceof RecruitingEventRequestTooLargeError) {
          return apiResponse.error(
            "REQUEST_TOO_LARGE",
            "Recruiting event request is too large",
            413,
          );
        }
        return apiResponse.error(
          "INVALID_REQUEST",
          "Event preferences require a school",
          400,
        );
      }
      const parsed = UpdateRecruitingEventPreferencesRequestSchema.safeParse(body);
      if (!parsed.success) {
        return apiResponse.error(
          "INVALID_REQUEST",
          "Event preferences require a school",
          400,
        );
      }
      try {
        return apiResponse.json(await service.setPreferences(parsed.data));
      } catch {
        return apiResponse.error(
          "EVENT_PREFERENCES_FAILED",
          "Event preferences could not be saved",
          500,
        );
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/events/scrape") {
      let body: unknown;
      try {
        body = await parseBody(request);
      } catch (error) {
        if (error instanceof RecruitingEventRequestTooLargeError) {
          return apiResponse.error(
            "REQUEST_TOO_LARGE",
            "Recruiting event request is too large",
            413,
          );
        }
        return apiResponse.error(
          "INVALID_REQUEST",
          "Event scrape request must be an empty object",
          400,
        );
      }
      if (
        typeof body !== "object"
        || body === null
        || Array.isArray(body)
        || Object.keys(body).length !== 0
      ) {
        return apiResponse.error(
          "INVALID_REQUEST",
          "Event scrape request must be an empty object",
          400,
        );
      }
      try {
        const response: RecruitingEventScrapeResponse = {
          run: await service.requestScrape("manual"),
        };
        return apiResponse.json(response, 202);
      } catch (error) {
        if (error instanceof RecruitingEventScrapeConflictError) {
          return apiResponse.error(
            "EVENT_SCRAPE_RUNNING",
            "A recruiting event scrape is already running",
            409,
          );
        }
        return apiResponse.error(
          "EVENT_SCRAPE_FAILED",
          "Recruiting event scrape could not be started",
          500,
        );
      }
    }

    return null;
  };
}
