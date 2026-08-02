import { describe, expect, test } from "bun:test";
import type { ApplicationSessionEventDto } from "@jobhunter/pipeline/contracts";
import {
  APPLICATION_SESSION_EVENT_NAMES,
  isStreamableApplicationSnapshot,
  parseApplicationSessionStreamEvent,
  shouldAcceptApplicationView,
} from "../app/lib/application-session-stream";

const event: ApplicationSessionEventDto = {
  generation: 2,
  event: "snapshot",
  session: {
    generation: 2,
    bridgeState: "running",
    harnessState: "running",
    submissionPhase: "not_attempted",
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
    playwrightCliDiagnostics: [],
    pendingAction: null,
    error: null,
  },
  detail: {},
};

describe("application session SSE projection", () => {
  test("accepts only strict generation-qualified projected frames", () => {
    expect(APPLICATION_SESSION_EVENT_NAMES).toContain("snapshot");
    expect(APPLICATION_SESSION_EVENT_NAMES).toContain("additional_info_required");
    expect(APPLICATION_SESSION_EVENT_NAMES).toContain("submission_started");
    expect(APPLICATION_SESSION_EVENT_NAMES).toContain("application_submitted");
    expect(APPLICATION_SESSION_EVENT_NAMES).toContain("submission_uncertain");
    expect(APPLICATION_SESSION_EVENT_NAMES).not.toContain("ready_for_human_submit");
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

  test("accepts each submission transition with its strict projected state", () => {
    const transitions = [
      {
        name: "submission_started",
        state: "submitting",
        phase: "attempting",
      },
      {
        name: "application_submitted",
        state: "submitted",
        phase: "submitted",
      },
      {
        name: "submission_uncertain",
        state: "submission_uncertain",
        phase: "uncertain",
      },
    ] as const;

    for (const [index, transition] of transitions.entries()) {
      const nextEvent: ApplicationSessionEventDto = {
        ...event,
        event: transition.name,
        session: {
          ...event.session,
          bridgeState: transition.state,
          harnessState: transition.state,
          submissionPhase: transition.phase,
          updatedAt: event.session.updatedAt + index + 1,
        },
      };
      expect(parseApplicationSessionStreamEvent(
        JSON.stringify(nextEvent),
        `2:${index + 8}`,
        2,
        transition.name,
      )).toEqual({ status: "accepted", event: nextEvent });
      expect(isStreamableApplicationSnapshot(nextEvent.session)).toBeTrue();
    }
  });

  test("streams only harness-backed live states and rejects stale reconciliations", () => {
    expect(isStreamableApplicationSnapshot(event.session)).toBeTrue();
    expect(isStreamableApplicationSnapshot({
      ...event.session,
      bridgeState: "reserved",
      harnessState: null,
      expiresAt: null,
    })).toBeFalse();
    expect(isStreamableApplicationSnapshot({
      ...event.session,
      bridgeState: "lost",
      harnessState: null,
      terminalAt: 3,
      expiresAt: null,
    })).toBeFalse();

    expect(shouldAcceptApplicationView(
      { ...event.session, generation: 3 },
      event.session,
    )).toBeFalse();
    expect(shouldAcceptApplicationView(
      { ...event.session, updatedAt: 3 },
      event.session,
    )).toBeFalse();
    expect(shouldAcceptApplicationView(
      { ...event.session, bridgeState: "running" },
      { ...event.session, bridgeState: "starting" },
    )).toBeFalse();
    expect(shouldAcceptApplicationView(
      event.session,
      { ...event.session, updatedAt: 3 },
    )).toBeTrue();
  });
});
