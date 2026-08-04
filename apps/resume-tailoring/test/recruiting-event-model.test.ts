import { describe, expect, test } from "bun:test";
import type { ApiKeyResolver, AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { extractRecruitingEventsWithLuna } from "../src/models/luna-event-extractor";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function message(text: string): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    content: [{ type: "text", text }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: ZERO_COST,
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

const inertResolver = (): ApiKeyResolver => async () => "oauth-bearer";

describe("Luna recruiting event extraction", () => {
  test("extracts strict events with the user-entered school in context", async () => {
    let contextSeen: Context | undefined;
    const events = await extractRecruitingEventsWithLuna(
      ["Engineering information session", "October 2, 2026 at 6 PM Eastern", "Example University students welcome"],
      {
        school: "Example University",
        sourceUrl: "https://employer.example.com/events",
        now: Date.UTC(2026, 7, 3, 12),
      },
      undefined,
      {
        resolverFactory: () => inertResolver(),
        sessionIdFactory: () => "event-scrape-fixed",
        transport: async (_model, context) => {
          contextSeen = context;
          return message(JSON.stringify({
            events: [{
              title: "Engineering Information Session",
              organizer: "Example Employer",
              startAt: "2026-10-02T18:00:00-04:00",
              endAt: null,
              timezone: "America/New_York",
              location: "Online",
              attendance: "virtual",
              registrationUrl: "HTTPS://Employer.Example.COM:443/events/?utm_source=secret#private",
              description: null,
              eligibilitySummary: "Example University students welcome",
              matchedForApplicant: true,
            }],
          }));
        },
      },
    );

    expect(events).toEqual([{
      title: "Engineering Information Session",
      organizer: "Example Employer",
      startAt: Date.parse("2026-10-02T18:00:00-04:00"),
      timezone: "America/New_York",
      location: "Online",
      attendance: "virtual",
      registrationUrl: "https://employer.example.com/events",
      eligibilitySummary: "Example University students welcome",
      matchedForApplicant: true,
    }]);
    expect(contextSeen?.systemPrompt?.join(" ")).toContain("untrusted inert data");
  });

  test("rejects credential-bearing and literal-private model registration links safely", async () => {
    for (const registrationUrl of [
      "https://registrant:super-secret@employer.example.com/events",
      "http://10.0.0.8/internal-event",
    ]) {
      let caught: unknown;
      try {
        await extractRecruitingEventsWithLuna(
          ["Engineering information session", "October 2, 2026 at 6 PM Eastern"],
          {
            school: null,
            sourceUrl: "https://employer.example.com/events",
            now: Date.UTC(2026, 7, 3, 12),
          },
          undefined,
          {
            resolverFactory: () => inertResolver(),
            transport: async () => message(JSON.stringify({
              events: [{
                title: "Engineering Information Session",
                organizer: "Example Employer",
                startAt: "2026-10-02T18:00:00-04:00",
                endAt: null,
                timezone: null,
                location: null,
                attendance: "virtual",
                registrationUrl,
                description: null,
                eligibilitySummary: null,
                matchedForApplicant: true,
              }],
            })),
          },
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({ kind: "unavailable" });
      const failure = caught as Error;
      expect(`${failure.message} ${String(failure.cause)}`).not.toContain("super-secret");
      expect(`${failure.message} ${String(failure.cause)}`).not.toContain("10.0.0.8");
    }
  });

  test("rejects prose and extra response keys", async () => {
    for (const text of [
      "```json\n{\"events\":[]}\n```",
      "{\"events\":[],\"extra\":true}",
    ]) {
      await expect(extractRecruitingEventsWithLuna(
        ["No upcoming recruiting events are listed."],
        { school: null, sourceUrl: "https://example.com/events", now: 1 },
        undefined,
        {
          resolverFactory: () => inertResolver(),
          transport: async () => message(text),
        },
      )).rejects.toMatchObject({ kind: "unavailable" });
    }
  });
});
