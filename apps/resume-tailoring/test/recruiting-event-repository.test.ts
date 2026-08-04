import { describe, expect, test } from "bun:test";
import { openPipelineDatabase } from "../src/db/database";
import { PIPELINE_SCHEMA_VERSION } from "../src/db/migrations";
import {
  RecruitingEventRepository,
  type RecruitingEventCandidate,
  type RecruitingEventSource,
} from "../src/events/repository";


const ieee: RecruitingEventSource = {
  id: "ieee-career-fair",
  name: "IEEE Global Career Fair",
  url: "https://careers.ieee.org/career-fair",
  category: "professional_organization",
};
const nyu: RecruitingEventSource = {
  id: "nyu-career-events",
  name: "Example University Career Events",
  url: "https://events.nyu.edu/",
  category: "university",
};

const event: RecruitingEventCandidate = {
  title: "Global Student Career Fair",
  organizer: "IEEE",
  startAt: Date.UTC(2026, 8, 18, 14),
  endAt: Date.UTC(2026, 8, 18, 18),
  timezone: "America/New_York",
  location: "Online",
  attendance: "virtual",
  registrationUrl: "https://careers.ieee.org/register/global-fair",
  description: "A virtual recruiting fair for students.",
  eligibilitySummary: "University students graduating in 2028 may attend.",
  matchedForApplicant: true,
};

describe("recruiting event persistence", () => {
  test("migrates event storage and deduplicates one event found by multiple sources", () => {
    const db = openPipelineDatabase(":memory:");
    const repository = new RecruitingEventRepository(db, {
      idFactory: () => "00000000-0000-4000-8000-000000000001",
    });
    const startedAt = Date.UTC(2026, 7, 3, 12);

    expect(PIPELINE_SCHEMA_VERSION).toBe(17);
    expect(repository.getPreferences()).toEqual({ school: null });
    expect(repository.setPreferences(
      { school: "Example University" },
      startedAt - 1,
    )).toEqual({ school: "Example University" });
    const run = repository.startRun({
      trigger: "manual",
      sourceCount: 3,
      startedAt,
    });
    repository.completeSource(run.id, ieee, "deterministic", [event], startedAt + 10);
    repository.completeSource(run.id, nyu, "llm", [{
      ...event,
      title: "  GLOBAL student career fair  ",
      organizer: "IEEE ",
      registrationUrl: "https://events.nyu.edu/global-student-career-fair?utm_source=calendar",
    }], startedAt + 20);
    repository.failSource(
      run.id,
      {
        id: "blocked-source",
        name: "Blocked source",
        url: "https://example.com/events",
        category: "employer",
      },
      "SOURCE_UNAVAILABLE",
      "The event source could not be loaded",
      startedAt + 30,
    );
    const finished = repository.finishRun(run.id, startedAt + 40);

    expect(finished).toMatchObject({
      state: "partial",
      sourceCount: 3,
      succeededSourceCount: 2,
      failedSourceCount: 1,
      eventCount: 1,
    });

    const dashboard = repository.getDashboard({
      sourceCount: 3,
      now: startedAt + 50,
    });
    expect(dashboard.events).toHaveLength(1);
    expect(dashboard.events[0]).toMatchObject({
      title: "Global Student Career Fair",
      organizer: "IEEE",
      matchedForApplicant: true,
      sourceUrls: [ieee.url, nyu.url],
    });
    expect(dashboard.issues).toEqual([{
      sourceId: "blocked-source",
      sourceName: "Blocked source",
      sourceUrl: "https://example.com/events",
      code: "SOURCE_UNAVAILABLE",
      message: "The event source could not be loaded",
      occurredAt: startedAt + 30,
    }]);
    expect(dashboard.preferences.school).toBe("Example University");
    expect(dashboard.schedule).toEqual({
      cadenceHours: 24,
      nextRunAt: startedAt + 24 * 60 * 60 * 1_000,
      running: false,
      sourceCount: 3,
    });

    db.close();
  });

  test("allows only one running scrape", () => {
    const db = openPipelineDatabase(":memory:");
    const repository = new RecruitingEventRepository(db);
    repository.setPreferences({ school: "Example University" }, 0);
    repository.startRun({ trigger: "startup", sourceCount: 1, startedAt: 1 });

    expect(() => repository.startRun({
      trigger: "scheduled",
      sourceCount: 1,
      startedAt: 2,
    })).toThrow("A recruiting event scrape is already running");

    db.close();
  });
});
