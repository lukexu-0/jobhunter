import { describe, expect, test } from "bun:test";
import { createApiHandler } from "../src/api/handler";
import { createRecruitingEventRoutes } from "../src/api/recruiting-event-routes";
import type {
  RecruitingEventDashboardResponse,
  RecruitingEventScrapeRun,
} from "../src/contracts";

const WEB_ORIGIN = "http://127.0.0.1:3456";

const run: RecruitingEventScrapeRun = {
  id: "scrape-1",
  trigger: "manual",
  state: "running",
  startedAt: 1_786_000_000_000,
  sourceCount: 2,
  succeededSourceCount: 0,
  failedSourceCount: 0,
  eventCount: 0,
};

const dashboard: RecruitingEventDashboardResponse = {
  preferences: {
    school: "Example University",
  },
  schedule: {
    cadenceHours: 24,
    nextRunAt: 1_786_086_400_000,
    running: false,
    sourceCount: 2,
  },
  latestRun: null,
  events: [],
  issues: [],
};

describe("recruiting event routes", () => {
  test("returns the event dashboard and starts a manual scrape", async () => {
    const calls: string[] = [];
    const route = createRecruitingEventRoutes({
      getDashboard: () => dashboard,
      setPreferences: ({ school }) => {
        calls.push(`school:${school}`);
        return { school };
      },
      requestScrape: (trigger) => {
        calls.push(trigger);
        return run;
      },
    });
    const handler = createApiHandler({ webOrigin: WEB_ORIGIN, route });

    const getResponse = await handler(new Request("http://127.0.0.1:3457/v1/events"));
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get("cache-control")).toBe("no-store");
    expect(await getResponse.json()).toEqual(dashboard);

    const preferenceResponse = await handler(new Request(
      "http://127.0.0.1:3457/v1/events/preferences",
      {
        method: "PUT",
        headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ school: "Example University" }),
      },
    ));
    expect(preferenceResponse.status).toBe(200);
    expect(await preferenceResponse.json()).toEqual({ school: "Example University" });

    const scrapeResponse = await handler(new Request("http://127.0.0.1:3457/v1/events/scrape", {
      method: "POST",
      headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
      body: "{}",
    }));
    expect(scrapeResponse.status).toBe(202);
    expect(await scrapeResponse.json()).toEqual({ run });
    expect(calls).toEqual(["school:Example University", "manual"]);
  });

  test("rejects a non-empty scrape request", async () => {
    const route = createRecruitingEventRoutes({
      getDashboard: () => dashboard,
      requestScrape: () => run,
      setPreferences: ({ school }) => ({ school }),
    });
    const handler = createApiHandler({ webOrigin: WEB_ORIGIN, route });

    const response = await handler(new Request("http://127.0.0.1:3457/v1/events/scrape", {
      method: "POST",
      headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
      body: "{\"unexpected\":true}",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "Event scrape request must be an empty object",
      },
    });
  });
});
