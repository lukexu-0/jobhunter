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

async function hasEmptyJsonBody(request: Request): Promise<boolean> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object"
      && body !== null
      && !Array.isArray(body)
      && Object.keys(body).length === 0;
  } catch {
    return false;
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
        body = await request.json();
      } catch {
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
      if (!(await hasEmptyJsonBody(request))) {
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
