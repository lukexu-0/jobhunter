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

  test("keeps JSON-LD registration links within the canonical public URL boundary", async () => {
    const result = await parseRecruitingEventSource({
      ...source,
      jsonLd: [
        {
          "@type": "Event",
          name: "Credential Link Event",
          organizer: "Example Careers",
          startDate: "2026-09-20T10:00:00-04:00",
          url: "https://registrant:super-secret@events.example.edu/register/credential",
        },
        {
          "@type": "Event",
          name: "Private Link Event",
          organizer: "Example Careers",
          startDate: "2026-09-21T10:00:00-04:00",
          url: "http://192.168.1.9/register/private",
        },
        {
          "@type": "Event",
          name: "Canonical Link Event",
          organizer: "Example Careers",
          startDate: "2026-09-22T10:00:00-04:00",
          url: "HTTPS://Events.Example.EDU:443/register/valid/?b=2&utm_source=secret&a=1#private",
        },
      ],
    }, {
      preferences: { school: null },
      now,
      extractWithModel: async () => {
        throw new Error("model fallback must not run");
      },
    });

    expect(result.parser).toBe("deterministic");
    expect(result.candidates.map((candidate) => candidate.registrationUrl)).toEqual([
      source.url,
      source.url,
      "https://events.example.edu/register/valid?a=1&b=2",
    ]);
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(JSON.stringify(result)).not.toContain("192.168.1.9");
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
          {
            title: "Credential Link Session",
            organizer: "Example Employer",
            startAt: Date.UTC(2026, 9, 3, 22),
            attendance: "virtual",
            registrationUrl:
              "https://registrant:model-secret@employer.example.com/internal-event",
            matchedForApplicant: true,
          },
          {
            title: "Private Link Session",
            organizer: "Example Employer",
            startAt: Date.UTC(2026, 9, 4, 22),
            attendance: "virtual",
            registrationUrl: "http://169.254.1.2/internal-event",
            matchedForApplicant: true,
          },
        ];
      },
    });

    expect(result.parser).toBe("llm");
    expect(result.candidates.map((candidate) => candidate.title)).toEqual([
      "Engineering Information Session",
    ]);
    expect(JSON.stringify(result)).not.toContain("model-secret");
    expect(JSON.stringify(result)).not.toContain("169.254.1.2");
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
