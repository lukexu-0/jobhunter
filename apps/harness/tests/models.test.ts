import { describe, expect, test } from "bun:test";

import {
  ApplicationAnswerSuggestionSchema,
  RuntimeActionRequestSchema,
  RuntimeActionResponseSchema,
  SessionCommandSchema,
  SessionSnapshotSchema,
  SourceCaptureCreateRequestSchema,
  SourceCaptureResultSchema,
  sanitizePublicUrl,
  validateApprovedOrigin,
  validateJobUrl,
} from "../src/contracts/models.ts";

describe("public model contracts", () => {
  test("sanitizes public URLs without exposing credentials, query, or fragment", () => {
    expect(
      sanitizePublicUrl("HTTPS://candidate:secret@Jobs.Example:443/apply?token=private#step"),
    ).toBe("https://jobs.example/apply");
  });

  test("accepts only strict session commands and normalizes private text", () => {
    expect(
      SessionCommandSchema.parse({ type: "revise", context: "  use the corrected fact  " }),
    ).toEqual({ type: "revise", context: "use the corrected fact" });
    expect(
      SessionCommandSchema.parse({
        type: "sign_in",
        username: "  ada@example.test  ",
        password: " transient password ",
      }),
    ).toEqual({
      type: "sign_in",
      username: "ada@example.test",
      password: " transient password ",
    });
    expect(() => SessionCommandSchema.parse({ type: "submit", extra: true })).toThrow();
    expect(() => SessionCommandSchema.parse({ type: "steer", message: "private\0text" })).toThrow();
  });
  test("uses Unicode scalars and Python whitespace for session command text", () => {
    const maximumRevision = "🙂".repeat(20_000);
    expect(SessionCommandSchema.parse({ type: "revise", context: maximumRevision }))
      .toEqual({ type: "revise", context: maximumRevision });
    expect(SessionCommandSchema.parse({ type: "steer", message: "\uFEFF" }))
      .toEqual({ type: "steer", message: "\uFEFF" });
    expect(SessionCommandSchema.parse({ type: "revise", context: "\uFEFF" }))
      .toEqual({ type: "revise", context: "\uFEFF" });

    for (const command of [
      { type: "revise", context: "before\uD800after" },
      { type: "revise", context: "🙂".repeat(20_001) },
    ]) {
      expect(SessionCommandSchema.safeParse(command).success).toBeFalse();
    }
  });

  test("enforces session state, pending action, and public URL invariants", () => {
    const snapshot = SessionSnapshotSchema.parse({
      session_id: "39bb70b2-5ea4-4937-8090-32d7404ad597",
      state: "awaiting_human_review",
      created_at: "2026-07-13T12:00:00Z",
      updated_at: "2026-07-13T12:01:00Z",
      expires_at: "2026-07-13T13:00:00Z",
      job_url: "https://candidate:secret@jobs.example/apply?token=private#step",
      pending_action: { type: "human_review" },
    });
    expect(snapshot.job_url).toBe("https://jobs.example/apply");
    expect(snapshot).toMatchObject({
      slot_released: false,
      model_provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning: "medium",
      fields_filled: [],
      revision_count: 0,
    });
    expect(() =>
      SessionSnapshotSchema.parse({
        ...snapshot,
        state: "running",
        pending_action: { type: "human_review" },
      }),
    ).toThrow();
    expect(() =>
      SessionSnapshotSchema.parse({ ...snapshot, state: "failed", pending_action: null }),
    ).toThrow();
  });

  test("validates strict runtime actions and exact response permissions", () => {
    expect(
      RuntimeActionRequestSchema.parse({
        type: "read_inbox",
        query: "",
        date: "2026-08-30",
        time: "14:05",
        received_within_minutes: 1_440,
      }),
    ).toEqual({
      type: "read_inbox",
      query: "code",
      date: "2026-08-30",
      time: "14:05",
      received_within_minutes: 1_440,
      received_before_minutes_ago: null,
    });
    expect(() =>
      RuntimeActionRequestSchema.parse({
        type: "playwright_cli",
        command: "open",
        args: [],
      }),
    ).toThrow();
    expect(() =>
      RuntimeActionRequestSchema.parse({ type: "get_credentials", origin: "https://example.test" }),
    ).toThrow();
    expect(
      RuntimeActionResponseSchema.parse({
        type: "submit",
        instruction: "You're good to submit.",
        result: {
          status: "ready_for_submission",
          job_url: "https://jobs.example/42?candidate=private",
          final_url: "https://ats.example/application/42#step",
        },
      }),
    ).toMatchObject({
      type: "submit",
      result: {
        status: "ready_for_submission",
        submit_attempted: false,
        job_url: "https://jobs.example/42",
        final_url: "https://ats.example/application/42",
      },
    });
    expect(() =>
      RuntimeActionResponseSchema.parse({
        type: "submit",
        instruction: "You may submit.",
        result: {
          status: "ready_for_submission",
          job_url: "https://jobs.example/42",
          final_url: "https://ats.example/application/42",
        },
      }),
    ).toThrow();
  });

  test("rejects every backend-reserved Playwright argument form", () => {
    const reservedArguments = [
      "-s", "-selector", "--s", "--s=owned",
      "-h", "-h=1", "--help", "--help=1",
      "-v", "-v=1", "--version", "--version=1",
      "--session", "--session=owned", "--json", "--json=1",
      "--raw", "--raw=1", "--config", "--config=owned",
      "--profile", "--profile=owned", "--persistent", "--persistent=1",
      "--headed", "--headed=1", "--browser", "--browser=chromium",
      "--cdp", "--cdp=http://127.0.0.1:9222", "--endpoint", "--endpoint=owned",
      "--extension", "--extension=owned",
    ];

    for (const argument of reservedArguments) {
      expect(RuntimeActionRequestSchema.safeParse({
        type: "playwright_cli", command: "snapshot", args: [argument],
      }).success).toBe(false);
    }
    expect(RuntimeActionRequestSchema.safeParse({
      type: "playwright_cli", command: "click", args: ["e12", "--timeout=5000"],
    }).success).toBe(true);
  });

  test("keeps read-user-info success responses within the runtime transport limit", () => {
    const emptyResponse = { type: "read_user_info_result" as const, content: "" };
    const maximumBytes = 16 * 1024 * 1024;
    const maximumContentBytes = maximumBytes - Buffer.byteLength(JSON.stringify(emptyResponse));
    const exact = { ...emptyResponse, content: "x".repeat(maximumContentBytes) };

    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(maximumBytes);
    expect(RuntimeActionResponseSchema.safeParse(exact).success).toBe(true);
    expect(RuntimeActionResponseSchema.safeParse({
      ...emptyResponse,
      content: `${exact.content}x`,
    }).success).toBe(false);
    expect(RuntimeActionResponseSchema.safeParse({
      ...emptyResponse,
      content: '"'.repeat(Math.floor(maximumBytes / 2)),
    }).success).toBe(false);
  });

  test("preserves private URLs while enforcing exact safe origins", () => {
    expect(validateJobUrl("http://127.0.0.1:8080/apply?token=private")).toBe(
      "http://127.0.0.1:8080/apply?token=private",
    );
    expect(validateApprovedOrigin("HTTPS://Jobs.Example:443/")).toBe("https://jobs.example");
    expect(sanitizePublicUrl("https://jobs.example/")).toBe("https://jobs.example/");
    expect(() => validateJobUrl("http://jobs.example/apply")).toThrow();
    expect(() => validateJobUrl("https://jobs.example/apply#private")).toThrow();
    expect(() => validateApprovedOrigin("https://jobs.example.evil/path")).toThrow();
  });

  test("uses one canonical HTTPS domain for source-capture URLs", () => {
    const captureId = "f4d9a10e-e63a-4ff5-9bf7-c2d054418979";
    const prefix = "https://jobs.example/role?state=";
    const maximumCreateUrl = `${prefix}${"a".repeat(2_048 - prefix.length)}`;
    expect(SourceCaptureCreateRequestSchema.parse({
      capture_id: captureId,
      job_url: maximumCreateUrl,
    }).job_url).toBe(maximumCreateUrl);

    for (const jobUrl of [
      "http://jobs.example/role",
      "https://jobs.example./role",
      "HTTPS://Jobs.Example:443/role",
      "https:///role",
      `${maximumCreateUrl}a`,
    ]) {
      expect(() => SourceCaptureCreateRequestSchema.parse({
        capture_id: captureId,
        job_url: jobUrl,
      })).toThrow();
    }

    expect(SourceCaptureResultSchema.parse({
      capture_id: captureId,
      final_url: "https://jobs.example/application?step=review",
      source: "Senior Engineer",
    }).final_url).toBe("https://jobs.example/application?step=review");
    for (const finalUrl of [
      "http://jobs.example/application",
      "https://jobs.example./application",
      "HTTPS://Jobs.Example:443/application",
    ]) {
      expect(() => SourceCaptureResultSchema.parse({
        capture_id: captureId,
        final_url: finalUrl,
        source: "Senior Engineer",
      })).toThrow();
    }
  });

  test("bounds captured source by UTF-8 bytes and Python-compatible lines", () => {
    const exactLines = "x\n".repeat(20_000);
    expect(
      SourceCaptureResultSchema.parse({
        capture_id: "f4d9a10e-e63a-4ff5-9bf7-c2d054418979",
        final_url: "https://jobs.example/application",
        source: exactLines,
      }).source,
    ).toBe(exactLines);
    expect(() =>
      SourceCaptureResultSchema.parse({
        capture_id: "f4d9a10e-e63a-4ff5-9bf7-c2d054418979",
        final_url: "https://jobs.example/application",
        source: `${exactLines}x`,
      }),
    ).toThrow();
    expect(() =>
      SourceCaptureResultSchema.parse({
        capture_id: "f4d9a10e-e63a-4ff5-9bf7-c2d054418979",
        final_url: "https://jobs.example/application",
        source: "🙂".repeat(131_073),
      }),
    ).toThrow();
  });

  test("counts bounded model text in Unicode code points", () => {
    const twoThousandScalars = "🙂".repeat(2_000);
    expect(
      ApplicationAnswerSuggestionSchema.parse({
        question: "What should the application say?",
        answer: twoThousandScalars,
      }).answer,
    ).toBe(twoThousandScalars);
    expect(() =>
      ApplicationAnswerSuggestionSchema.parse({
        question: "What should the application say?",
        answer: `${twoThousandScalars}a`,
      }),
    ).toThrow();
  });

});
