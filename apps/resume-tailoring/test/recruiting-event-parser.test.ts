import { describe, expect, test } from "bun:test";
import {
  parseRecruitingEventSource,
  type LoadedRecruitingEventSource,
} from "../src/events/parser";

const now = Date.UTC(2026, 7, 3, 12);

const source: LoadedRecruitingEventSource = {
  url: "https://events.example.edu/student-fair",
  lines: ["Student Fair", "September 18, 2026", "Open to Example University students"],
  jsonLd: [{
    "@context": "https://schema.org",
    "@type": "Event",
    name: "Student Technology Career Fair",
    startDate: "2026-09-18T10:00:00-04:00",
    endDate: "2026-09-18T14:00:00-04:00",
    organizer: { "@type": "Organization", name: "Example Careers" },
    location: {
      "@type": "VirtualLocation",
      url: "https://events.example.edu/register/student-fair",
    },
    audience: "Open to Example University students",
    description: "Meet technology employers.",
    eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
    url: "/register/student-fair",
  }],
};

describe("recruiting event parsing", () => {
  test("uses schema.org Event data before the model fallback", async () => {
    let fallbackCalls = 0;
    const result = await parseRecruitingEventSource(source, {
      preferences: { school: "Example University" },
      now,
      extractWithModel: async () => {
        fallbackCalls += 1;
        return [];
      },
    });

    expect(result.parser).toBe("deterministic");
    expect(fallbackCalls).toBe(0);
    expect(result.candidates).toEqual([{
      title: "Student Technology Career Fair",
      organizer: "Example Careers",
      startAt: Date.parse("2026-09-18T10:00:00-04:00"),
      endAt: Date.parse("2026-09-18T14:00:00-04:00"),
      location: "Online",
      attendance: "virtual",
      registrationUrl: "https://events.example.edu/register/student-fair",
      description: "Meet technology employers.",
      eligibilitySummary: "Open to Example University students",
      matchedForApplicant: true,
    }]);
  });

  test("falls back to the model for unstructured pages and filters past events", async () => {
    const unstructured: LoadedRecruitingEventSource = {
      url: "https://employer.example.com/events",
      lines: ["Upcoming events", "Engineering information session", "October 2 at 6 PM"],
      jsonLd: [],
    };
    const calls: unknown[] = [];
    const result = await parseRecruitingEventSource(unstructured, {
      preferences: { school: "Example University" },
      now,
      extractWithModel: async (lines, context) => {
        calls.push({ lines, context });
        return [
          {
            title: "Engineering Information Session",
            organizer: "Example Employer",
            startAt: Date.UTC(2026, 9, 2, 22),
            attendance: "virtual",
            registrationUrl: "https://employer.example.com/events",
            matchedForApplicant: true,
          },
          {
            title: "Old Session",
            organizer: "Example Employer",
            startAt: Date.UTC(2026, 6, 1, 22),
            attendance: "virtual",
            registrationUrl: "https://employer.example.com/events",
            matchedForApplicant: true,
          },
        ];
      },
    });

    expect(result.parser).toBe("llm");
    expect(result.candidates.map((candidate) => candidate.title)).toEqual([
      "Engineering Information Session",
    ]);
    expect(calls).toEqual([{
      lines: unstructured.lines,
      context: {
        school: "Example University",
        sourceUrl: unstructured.url,
        now,
      },
    }]);
  });
});
