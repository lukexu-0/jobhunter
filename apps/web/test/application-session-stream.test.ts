import { describe, expect, test } from "bun:test";
import type { ApplicationSessionEventDto } from "@jobhunter/pipeline/contracts";
import {
  APPLICATION_SESSION_EVENT_NAMES,
  parseApplicationSessionStreamEvent,
} from "../app/lib/application-session-stream";

const event: ApplicationSessionEventDto = {
  generation: 2,
  event: "snapshot",
  session: {
    generation: 2,
    bridgeState: "running",
    harnessState: "running",
    createdAt: 1,
    updatedAt: 2,
    terminalAt: null,
    expiresAt: 60_001,
    company: "Example Corp",
    role: "Staff Engineer",
    fieldsFilled: [],
    fieldsNeedingHuman: [],
    filesAttached: ["resume.pdf"],
    warnings: [],
    revisionCount: 0,
    pendingAction: null,
    error: null,
  },
  detail: {},
};

describe("application session SSE projection", () => {
  test("accepts only strict generation-qualified projected frames", () => {
    expect(APPLICATION_SESSION_EVENT_NAMES).toContain("snapshot");
    expect(APPLICATION_SESSION_EVENT_NAMES).toContain("additional_info_required");
    expect(parseApplicationSessionStreamEvent(
      JSON.stringify(event),
      "2:7",
      2,
    )).toEqual({ status: "accepted", event });
    expect(parseApplicationSessionStreamEvent(
      JSON.stringify(event),
      "1:7",
      2,
    )).toEqual({ status: "invalid" });
    expect(parseApplicationSessionStreamEvent(
      JSON.stringify({ ...event, sessionId: "private-session" }),
      "2:7",
      2,
    )).toEqual({ status: "invalid" });
    expect(parseApplicationSessionStreamEvent(
      JSON.stringify({ ...event, generation: 1, session: { ...event.session, generation: 1 } }),
      "1:9",
      2,
    )).toEqual({ status: "stale" });
    expect(parseApplicationSessionStreamEvent("not-json", "2:8", 2))
      .toEqual({ status: "invalid" });
  });
});
