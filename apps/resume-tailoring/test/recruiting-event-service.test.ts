import { describe, expect, test } from "bun:test";
import { openPipelineDatabase } from "../src/db/database";
import { RecruitingEventRepository, type RecruitingEventSource } from "../src/events/repository";
import { RecruitingEventService } from "../src/events/service";

const sources: readonly RecruitingEventSource[] = [
  {
    id: "working-source",
    name: "Working source",
    url: "https://events.example.com/working",
    category: "employer",
  },
  {
    id: "broken-source",
    name: "Broken source",
    url: "https://events.example.com/broken",
    category: "event_platform",
  },
];

describe("recruiting event service", () => {
  test("runs in the background, keeps source issues, and runs again only when daily due", async () => {
    const db = openPipelineDatabase(":memory:");
    const repository = new RecruitingEventRepository(db);
    let now = Date.UTC(2026, 7, 3, 12);
    let loads = 0;
    const service = new RecruitingEventService({
      repository,
      sources,
      now: () => now,
      loadSource: async (url) => {
        loads += 1;
        if (url.endsWith("/broken")) throw new Error("private upstream detail");
        return { url, lines: ["Career fair"], jsonLd: [] };
      },
      parseSource: async (_source, options) => ({
        parser: "llm",
        candidates: [{
          title: "Student Career Fair",
          organizer: "Example Employer",
          startAt: Date.UTC(2026, 8, 18, 14),
          attendance: "virtual",
          registrationUrl: "https://events.example.com/register",
          eligibilitySummary: `${options.preferences.school} students`,
          matchedForApplicant: true,
        }],
      }),
    });

    expect(service.setPreferences({ school: "Example University" })).toEqual({
      school: "Example University",
    });
    expect(service.requestScrape("manual")).toMatchObject({ state: "running", sourceCount: 2 });
    await service.whenIdle();

    const dashboard = service.getDashboard();
    expect(dashboard.latestRun).toMatchObject({
      state: "partial",
      succeededSourceCount: 1,
      failedSourceCount: 1,
      eventCount: 1,
    });
    expect(dashboard.events[0]?.eligibilitySummary).toBe("Example University students");
    expect(dashboard.issues).toEqual([{
      sourceId: "broken-source",
      sourceName: "Broken source",
      sourceUrl: "https://events.example.com/broken",
      code: "SOURCE_PARSE_FAILED",
      message: "The event source could not be parsed",
      occurredAt: now,
    }]);

    now += 23 * 60 * 60 * 1_000;
    expect(service.runIfDue("scheduled")).toBeNull();
    expect(loads).toBe(2);

    now += 60 * 60 * 1_000;
    expect(service.runIfDue("scheduled")).toMatchObject({ state: "running" });
    await service.whenIdle();
    expect(loads).toBe(4);

    await service.close();
    db.close();
  });

  test("recovers an interrupted run before deciding whether startup is due", async () => {
    const db = openPipelineDatabase(":memory:");
    const repository = new RecruitingEventRepository(db);
    repository.startRun({ trigger: "scheduled", sourceCount: 1, startedAt: 100 });
    const service = new RecruitingEventService({
      repository,
      sources: sources.slice(0, 1),
      now: () => 200,
      loadSource: async (url) => ({ url, lines: ["No events"], jsonLd: [] }),
      parseSource: async () => ({ parser: "llm", candidates: [] }),
    });

    service.recoverInterruptedRun();
    expect(repository.latestRun()).toMatchObject({ state: "failed", completedAt: 200 });
    expect(service.runIfDue("startup")).toBeNull();

    await service.close();
    db.close();
  });
});
