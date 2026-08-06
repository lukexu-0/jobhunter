import { describe, expect, test } from "bun:test";
import {
  ApplicationHarnessError,
  HttpApplicationHarnessClient,
  type ApplicationHarnessFetch,
  type ApplicationHarnessCreateInput,
} from "../src/api/application-harness-client";
import type { ApplicationSessionCommand } from "../src/contracts";
import { ARTIFACT_LIMITS } from "../src/system/artifacts.ts";

const ORIGIN = "http://127.0.0.1:8765";
const TOKEN = "test-token-0123456789abcdef-0123456789";
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

function rawSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION_ID,
    state: "awaiting_additional_info",
    created_at: "2026-07-21T10:00:00Z",
    updated_at: "2026-07-21T10:00:01Z",
    expires_at: "2026-07-21T11:00:00Z",
    slot_released: false,
    job_url: "https://jobs.private.example/roles/123",
    company: "Example Corp",
    role: "Software Engineer",
    model_provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoning: "high",
    fields_filled: [{
      label: "Full name",
      field_type: "text",
      value_present: true,
      note: "",
    }],
    fields_needing_human: [],
    files_attached: ["resume.pdf"],
    warnings: ["Review before submitting."],
    revision_count: 1,
    playwright_cli_diagnostics: [{
      step: 1,
      status: "failed",
      exit_code: 1,
      timed_out: false,
      error_category: "process_exit",
      stderr_excerpt: "[redacted]",
      stderr_truncated: false,
    }],
    pending_action: {
      type: "additional_info",
      questions: [{
        id: "work_setting",
        key: "preferences.work_setting",
        scope: "application",
        question: "Which work settings can you accept?",
        answer_type: "multi_select",
        options: [
          { id: "remote", label: "Remote" },
          { id: "onsite", label: "On-site" },
        ],
      }],
    },
    approved_origins: ["https://jobs.private.example", "https://ats.private.example"],
    error: null,
    ...overrides,
  };
}

describe("HttpApplicationHarnessClient", () => {
  test("gets and strictly reprojects a complete harness snapshot without private fields", async () => {
    const calls: Array<{
      input: string | URL | Request;
      init: RequestInit | undefined;
    }> = [];
    const fetchImpl: ApplicationHarnessFetch = async (input, init) => {
      calls.push({ input, init });
      return Response.json(rawSnapshot());
    };
    const client = new HttpApplicationHarnessClient({ origin: ORIGIN, token: TOKEN, fetchImpl });

    const snapshot = await client.get(SESSION_ID, new AbortController().signal);

    expect(snapshot).toEqual({
      state: "awaiting_additional_info",
      createdAt: Date.parse("2026-07-21T10:00:00Z"),
      updatedAt: Date.parse("2026-07-21T10:00:01Z"),
      expiresAt: Date.parse("2026-07-21T11:00:00Z"),
      slotReleased: false,
      company: "Example Corp",
      role: "Software Engineer",
      fieldsFilled: [{ label: "Full name", fieldType: "text", valuePresent: true, note: "" }],
      fieldsNeedingHuman: [],
      filesAttached: ["resume.pdf"],
      warnings: ["Review before submitting."],
      revisionCount: 1,
      playwrightCliDiagnostics: [{
        step: 1,
        status: "failed",
        exitCode: 1,
        timedOut: false,
        errorCategory: "process_exit",
        stderrExcerpt: "[redacted]",
        stderrTruncated: false,
      }],
      pendingAction: {
        type: "additional_info",
        questions: [{
          id: "work_setting",
          scope: "application",
          question: "Which work settings can you accept?",
          answerType: "multi_select",
          options: [
            { id: "remote", label: "Remote" },
            { id: "onsite", label: "On-site" },
          ],
        }],
      },
      error: null,
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe(`${ORIGIN}/v1/sessions/${SESSION_ID}`);
    expect(calls[0]!.init).toMatchObject({
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(SESSION_ID);
    expect(JSON.stringify(snapshot)).not.toContain("jobs.private.example");
    expect(JSON.stringify(snapshot)).not.toContain("ats.private.example");
    expect(JSON.stringify(snapshot)).not.toContain("model");
  });
  test("defaults omitted Playwright CLI diagnostics to an empty public list", async () => {
    const client = new HttpApplicationHarnessClient({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: async () => Response.json(rawSnapshot({
        playwright_cli_diagnostics: undefined,
      })),
    });

    await expect(client.get(SESSION_ID, new AbortController().signal))
      .resolves.toMatchObject({ playwrightCliDiagnostics: [] });
  });
  test("projects slot release only after terminal cleanup", async () => {
    const client = new HttpApplicationHarnessClient({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: async () => Response.json(rawSnapshot({
        state: "failed",
        slot_released: true,
        pending_action: null,
        error: {
          code: "session_timeout",
          message: "The application session expired",
        },
      })),
    });

    await expect(
      client.get(SESSION_ID, new AbortController().signal),
    ).resolves.toMatchObject({
      state: "failed",
      slotReleased: true,
    });
  });
  test("projects the credentials gate as a marker while preserving ordinary human navigation", async () => {
    const privateUsername = "snapshot-private-user";
    const privatePassword = "SNAPSHOT-PRIVATE-PASSWORD";
    const responses = [
      Response.json(rawSnapshot({
        state: "awaiting_human_navigation",
        job_url: `https://jobs.private.example/${privateUsername}/${privatePassword}`,
        pending_action: { type: "credentials" },
      })),
      Response.json(rawSnapshot({
        state: "awaiting_human_navigation",
        pending_action: {
          type: "human_navigation",
          instruction: "Complete the CAPTCHA.",
        },
      })),
    ];
    const client = new HttpApplicationHarnessClient({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: async () => responses.shift()!,
    });

    const credentialsGate = await client.get(SESSION_ID, new AbortController().signal);
    expect(credentialsGate).toMatchObject({
      state: "awaiting_human_navigation",
      pendingAction: { type: "credentials" },
    });
    expect(JSON.stringify(credentialsGate)).not.toContain(privateUsername);
    expect(JSON.stringify(credentialsGate)).not.toContain(privatePassword);
    await expect(client.get(SESSION_ID, new AbortController().signal))
      .resolves.toMatchObject({
        state: "awaiting_human_navigation",
        pendingAction: {
          type: "human_navigation",
          instruction: "Complete the CAPTCHA.",
        },
      });
  });
  test("accepts only a bare loopback HTTP origin", () => {
    expect(() => new HttpApplicationHarnessClient({ token: TOKEN })).not.toThrow();
    expect(() => new HttpApplicationHarnessClient({
      origin: "http://localhost:9876",
      token: TOKEN,
    })).not.toThrow();
    expect(() => new HttpApplicationHarnessClient({
      origin: "http://[::1]:9876",
      token: TOKEN,
    })).not.toThrow();

    expect(() => new HttpApplicationHarnessClient({ token: "too-short" }))
      .toThrow(new ApplicationHarnessError("invalid_response"));
    for (const origin of [
      "https://127.0.0.1:8765",
      "http://192.168.1.5:8765",
      "http://example.test:8765",
      "http://user:password@127.0.0.1:8765",
      "http://127.0.0.1:8765/v1",
      "http://127.0.0.1:8765?token=private",
      "http://127.0.0.1:8765#fragment",
    ]) {
      expect(() => new HttpApplicationHarnessClient({ origin, token: TOKEN }))
        .toThrow(new ApplicationHarnessError("invalid_response"));
    }
  });
  test("creates a caller-ID session with only the fixed multipart parts", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const client = new HttpApplicationHarnessClient({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return Response.json({
          session_id: SESSION_ID,
          state: "starting",
          events_url: `${ORIGIN}/v1/sessions/${SESSION_ID}/events`,
          commands_url: `${ORIGIN}/v1/sessions/${SESSION_ID}/commands`,
        }, { status: 202 });
      },
    });
    const resumePdf = new TextEncoder().encode("%PDF-1.7\napproved resume");
    const resumeSource = new TextEncoder().encode("\\documentclass{article}\nExact current source");
    const signal = new AbortController().signal;

    await expect(client.create({
      sessionId: SESSION_ID,
      jobUrl: "https://jobs.private.example/roles/123?source=local",
      opportunityKind: "hackathon",
      personalInformationMarkdown: "# Applicant\n\nPrivate profile",
      autoSubmit: true,
      resumePdf,
      resumeSource,
    }, signal)).resolves.toBeUndefined();

    expect(capturedUrl).toBe(`${ORIGIN}/v1/sessions`);
    expect(capturedInit).toMatchObject({
      method: "POST",
      redirect: "manual",
      signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
    });
    const form = capturedInit?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) throw new Error("Expected multipart form");
    expect([...form.keys()]).toEqual([
      "session_id",
      "job_url",
      "opportunity_kind",
      "auto_submit",
      "personal_information",
      "resume",
      "resume_source",
      "max_steps",
    ]);
    expect(form.get("session_id")).toBe(SESSION_ID);
    expect(form.get("job_url")).toBe("https://jobs.private.example/roles/123?source=local");
    expect(form.get("opportunity_kind")).toBe("hackathon");
    expect(form.get("auto_submit")).toBe("true");
    expect(form.get("max_steps")).toBe("100");
    const profile = form.get("personal_information");
    const resumeSourcePart = form.get("resume_source");
    const resume = form.get("resume");
    expect(profile).toBeInstanceOf(File);
    expect(resumeSourcePart).toBeInstanceOf(File);
    expect(resume).toBeInstanceOf(File);
    if (
      !(profile instanceof File)
      || !(resumeSourcePart instanceof File)
      || !(resume instanceof File)
    ) throw new Error("Expected file parts");
    expect({ name: profile.name, type: profile.type, text: await profile.text() }).toEqual({
      name: "applicant-profile.md",
      type: "text/markdown",
      text: "# Applicant\n\nPrivate profile",
    });
    expect({
      name: resumeSourcePart.name,
      type: resumeSourcePart.type,
      bytes: new Uint8Array(await resumeSourcePart.arrayBuffer()),
    }).toEqual({
      name: "Alex_Example_Resume.tex",
      type: "text/x-tex",
      bytes: resumeSource,
    });
    expect({
      name: resume.name,
      type: resume.type,
      bytes: new Uint8Array(await resume.arrayBuffer()),
    }).toEqual({
      name: "Alex_Example_Resume.pdf",
      type: "application/pdf",
      bytes: resumePdf,
    });
    expect(capturedUrl).not.toContain(TOKEN);
    expect([...form.values()].map((part) => String(part)).join("|")).not.toContain(TOKEN);
  });
  test("rejects invalid resume source bytes before network I/O", async () => {
    let fetchCalls = 0;
    const client = new HttpApplicationHarnessClient({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("network must not be called");
      },
    });
    const baseInput: Omit<ApplicationHarnessCreateInput, "resumeSource"> = {
      sessionId: SESSION_ID,
      jobUrl: "https://jobs.private.example/roles/123",
      opportunityKind: "job",
      autoSubmit: false,
      personalInformationMarkdown: "# Applicant",
      resumePdf: new TextEncoder().encode("%PDF-private"),
    };
    const invalidSources: unknown[] = [
      undefined,
      new Uint8Array(),
      Uint8Array.of(0xc3, 0x28),
      new Uint8Array(ARTIFACT_LIMITS.tex + 1),
    ];

    for (const resumeSource of invalidSources) {
      await expect(client.create(
        { ...baseInput, resumeSource } as ApplicationHarnessCreateInput,
        new AbortController().signal,
      )).rejects.toEqual(new ApplicationHarnessError("invalid_request"));
    }
    expect(fetchCalls).toBe(0);
  });
  test("sends manual review mode explicitly", async () => {
    let form: FormData | undefined;
    const client = new HttpApplicationHarnessClient({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: async (_input, init) => {
        if (init?.body instanceof FormData) form = init.body;
        return Response.json({
          session_id: SESSION_ID,
          state: "starting",
          events_url: `${ORIGIN}/v1/sessions/${SESSION_ID}/events`,
          commands_url: `${ORIGIN}/v1/sessions/${SESSION_ID}/commands`,
        }, { status: 202 });
      },
    });

    await client.create({
      sessionId: SESSION_ID,
      jobUrl: "https://jobs.private.example/roles/123",
      opportunityKind: "job",
      autoSubmit: false,
      personalInformationMarkdown: "# Applicant",
      resumePdf: new TextEncoder().encode("%PDF-private"),
      resumeSource: new TextEncoder().encode("\\documentclass{article}"),
    }, new AbortController().signal);

    expect(form?.get("auto_submit")).toBe("false");
  });
  test("accepts fixed create routes advertised through an equivalent loopback alias", async () => {
    const client = new HttpApplicationHarnessClient({
      origin: "http://localhost:8765",
      token: TOKEN,
      fetchImpl: async () => Response.json({
        session_id: SESSION_ID,
        state: "starting",
        events_url: `http://127.0.0.1:8765/v1/sessions/${SESSION_ID}/events`,
        commands_url: `http://127.0.0.1:8765/v1/sessions/${SESSION_ID}/commands`,
      }, { status: 202 }),
    });

    await expect(client.create({
      sessionId: SESSION_ID,
      jobUrl: "https://jobs.private.example/roles/123",
      opportunityKind: "job",
      personalInformationMarkdown: "# Applicant",
      autoSubmit: false,
      resumePdf: new TextEncoder().encode("%PDF-private"),
      resumeSource: new TextEncoder().encode("\\documentclass{article}"),
    }, new AbortController().signal)).resolves.toBeUndefined();
  });
  test("rejects mismatched caller IDs and non-strict create responses", async () => {
    const otherSessionId = "223e4567-e89b-42d3-a456-426614174000";
    const input: ApplicationHarnessCreateInput = {
      sessionId: SESSION_ID,
      jobUrl: "https://jobs.private.example/roles/123",
      opportunityKind: "job",
      personalInformationMarkdown: "# Applicant",
      autoSubmit: false,
      resumePdf: new TextEncoder().encode("%PDF-private"),
      resumeSource: new TextEncoder().encode("\\documentclass{article}"),
    };
    const invalidBodies = [
      {
        session_id: otherSessionId,
        state: "starting",
        events_url: `${ORIGIN}/v1/sessions/${otherSessionId}/events`,
        commands_url: `${ORIGIN}/v1/sessions/${otherSessionId}/commands`,
      },
      {
        session_id: SESSION_ID,
        state: "starting",
        events_url: `${ORIGIN}/v1/sessions/${SESSION_ID}/events`,
        commands_url: `${ORIGIN}/v1/sessions/${SESSION_ID}/commands`,
        job_url: "https://jobs.private.example/roles/123",
      },
    ];
    for (const body of invalidBodies) {
      const client = new HttpApplicationHarnessClient({
        origin: ORIGIN,
        token: TOKEN,
        fetchImpl: async () => Response.json(body, { status: 202 }),
      });
      await expect(client.create(input, new AbortController().signal))
        .rejects.toEqual(new ApplicationHarnessError("invalid_response"));
    }
  });
  test("rejects wrong-ID, non-strict, malformed, fatal-UTF8, oversized, and wrong-status snapshots", async () => {
    const otherSessionId = "223e4567-e89b-42d3-a456-426614174000";
    const invalidResponses = [
      Response.json(rawSnapshot({ session_id: otherSessionId })),
      Response.json(rawSnapshot({ current_url: "https://private.example/current" })),
      Response.json(rawSnapshot({ slot_released: true })),
      Response.json(rawSnapshot({
        state: "awaiting_human_navigation",
        pending_action: {
          type: "credentials",
          username: "private@example.test",
          password: "PRIVATE SNAPSHOT PASSWORD",
        },
      })),
      Response.json(rawSnapshot({
        state: "awaiting_origin_approval",
        pending_action: {
          type: "origin_approval",
          origin: "http://remote.example",
        },
        approved_origins: ["http://remote.example"],
      })),
      new Response("{", { headers: { "content-type": "application/json" } }),
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
      }),
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": String(8 * 1024 * 1024 + 1),
        },
      }),
      new Response(JSON.stringify(rawSnapshot()), {
        headers: { "content-type": "text/plain" },
      }),
      Response.json(rawSnapshot(), { status: 201 }),
    ];

    for (const response of invalidResponses) {
      const client = new HttpApplicationHarnessClient({
        origin: ORIGIN,
        token: TOKEN,
        fetchImpl: async () => response,
      });
      await expect(client.get(SESSION_ID, new AbortController().signal))
        .rejects.toEqual(new ApplicationHarnessError("invalid_response"));
    }
  });
  test("sends every strict shared command unchanged and closes only the fixed session path", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new HttpApplicationHarnessClient({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: async (input, init = {}) => {
        calls.push({ url: String(input), init });
        return new Response(null, { status: init.method === "DELETE" ? 204 : 202 });
      },
    });
    const signInPassword = "PRIVATE SIGN IN PASSWORD";
    const savedPassword = "PRIVATE SAVED PASSWORD";
    const steeringMessage = "PRIVATE OPERATOR GUIDANCE";
    const commands: ApplicationSessionCommand[] = [
      { type: "continue" },
      { type: "continue_without_additional_info" },
      { type: "steer", message: steeringMessage },
      { type: "approve_origin", origin: "https://ats.example.test" },
      {
        type: "sign_in",
        username: "applicant@example.test",
        password: signInPassword,
      },
      {
        type: "save_credentials",
        username: "saved@example.test",
        password: savedPassword,
      },
      {
        type: "provide_additional_info",
        answers: [
          {
            id: "availability",
            status: "answered",
            raw_value: "June 2027",
            value: "Available in June 2027.",
          },
          { id: "sponsorship", status: "answered", value: false },
          { id: "referral", status: "answered", option_id: "company_site" },
          { id: "work_setting", status: "answered", option_ids: ["remote", "onsite"] },
          { id: "salary", status: "declined" },
        ],
      },
      { type: "revise", context: "Correct the application summary." },
      { type: "submit" },
      { type: "cancel" },
    ];
    const signal = new AbortController().signal;

    for (const command of commands) await client.command(SESSION_ID, command, signal);
    await client.delete(SESSION_ID, signal);

    expect(calls.map(({ url }) => url)).toEqual([
      ...commands.map(() => `${ORIGIN}/v1/sessions/${SESSION_ID}/commands`),
      `${ORIGIN}/v1/sessions/${SESSION_ID}`,
    ]);
    expect(calls.slice(0, -1).map(({ init }) => JSON.parse(String(init.body))))
      .toEqual(commands);
    for (const { init } of calls) {
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBe(signal);
      expect(init.headers).toMatchObject({
        authorization: `Bearer ${TOKEN}`,
      });
    }
    expect(calls[0]!.init.headers).toMatchObject({
      accept: "application/json",
      "content-type": "application/json",
    });
    for (const secret of [signInPassword, savedPassword, steeringMessage]) {
      expect(
        calls.slice(0, -1).filter(({ init }) => String(init.body).includes(secret)),
      ).toHaveLength(1);
      expect(calls.map(({ url }) => url).join("\n")).not.toContain(secret);
      expect(JSON.stringify(calls.map(({ init }) => init.headers))).not.toContain(secret);
    }
    expect(calls.at(-1)!.init).toMatchObject({ method: "DELETE" });
  });
  test("fetches strict bounded prior-answer suggestions from the private bearer route", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const suggestions = {
      suggestions: [
        { question: "When can you start?", answer: "I can start in June 2027." },
        { question: "What is your availability?", answer: "I am available after four weeks." },
      ],
    };
    const client = new HttpApplicationHarnessClient({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: async (input, init = {}) => {
        calls.push({ url: String(input), init });
        return Response.json(suggestions);
      },
    });
    const signal = new AbortController().signal;

    await expect(client.suggestions(SESSION_ID, "availability", signal))
      .resolves.toEqual(suggestions);
    expect(calls).toEqual([{
      url: `${ORIGIN}/v1/sessions/${SESSION_ID}/additional-info/availability/suggestions`,
      init: expect.objectContaining({
        method: "GET",
        redirect: "manual",
        signal,
        headers: expect.objectContaining({
          accept: "application/json",
          authorization: `Bearer ${TOKEN}`,
        }),
      }),
    }]);

    let invalidFetches = 0;
    const invalidClient = new HttpApplicationHarnessClient({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: async () => {
        invalidFetches += 1;
        return Response.json({ suggestions: [] });
      },
    });
    await expect(invalidClient.suggestions(SESSION_ID, "../private", signal))
      .rejects.toEqual(new ApplicationHarnessError("invalid_request"));
    expect(invalidFetches).toBe(0);

    for (const response of [
      Response.json({
        suggestions: [{
          question: "Question",
          answer: "Answer",
          key: "private.answer.key",
          job_url: "https://jobs.private.example/role",
          raw_value: "private raw answer",
        }],
      }),
      Response.json({
        suggestions: Array.from(
          { length: 6 },
          () => ({ question: "Question", answer: "Answer" }),
        ),
      }),
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": String(64 * 1024 + 1),
        },
      }),
    ]) {
      const strictClient = new HttpApplicationHarnessClient({
        origin: ORIGIN,
        token: TOKEN,
        fetchImpl: async () => response,
      });
      await expect(strictClient.suggestions(SESSION_ID, "availability", signal))
        .rejects.toEqual(new ApplicationHarnessError("invalid_response"));
    }
  });

  test("rejects argv-incompatible credentials before an authenticated request", async () => {
    let requests = 0;
    const client = new HttpApplicationHarnessClient({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: async () => {
        requests += 1;
        return new Response(null, { status: 202 });
      },
    });
    const invalidCommands: ApplicationSessionCommand[] = [
      {
        type: "sign_in",
        username: "applicant\u0000@example.test",
        password: "private",
      },
      {
        type: "save_credentials",
        username: "applicant@example.test",
        password: "private\u0000password",
      },
    ];

    for (const command of invalidCommands) {
      await expect(client.command(SESSION_ID, command, new AbortController().signal))
        .rejects.toEqual(new ApplicationHarnessError("invalid_request"));
    }
    expect(requests).toBe(0);
  });
  test("incrementally validates and reprojects every SSE event without private fields", async () => {
    const questions = [
      {
        id: "availability",
        key: "availability.start",
        scope: "global",
        question: "When can you start?",
        answer_type: "text",
      },
      {
        id: "sponsorship",
        key: "eligibility.sponsorship",
        scope: "global",
        question: "Do you require sponsorship?",
        answer_type: "boolean",
      },
      {
        id: "referral",
        key: "referral.source",
        scope: "application",
        question: "How did you hear about this role?",
        answer_type: "single_select",
        options: [{ id: "site", label: "Company site" }, { id: "other", label: "Other" }],
      },
      {
        id: "work_setting",
        key: "preferences.work_setting",
        scope: "application",
        question: "Which settings work? 😀",
        answer_type: "multi_select",
        options: [{ id: "remote", label: "Remote" }, { id: "onsite", label: "On-site" }],
      },
    ];
    const baseSession = rawSnapshot({ state: "running", pending_action: null });
    const privateEventUsername = "event-private-user";
    const privateEventPassword = "EVENT-PRIVATE-PASSWORD";
    const eventInputs = [
      { event: "session_started", detail: {}, session: baseSession },
      {
        event: "agent_step",
        detail: { step_number: 2, current_url: "https://private.example/form" },
        session: baseSession,
      },
      { event: "snapshot", detail: {}, session: baseSession },
      {
        event: "human_navigation_required",
        detail: { instruction: "Complete the CAPTCHA." },
        session: rawSnapshot({
          state: "awaiting_human_navigation",
          pending_action: { type: "human_navigation", instruction: "Complete the CAPTCHA." },
        }),
      },
      {
        event: "credentials_required",
        detail: {},
        session: rawSnapshot({
          state: "awaiting_human_navigation",
          job_url:
            `https://jobs.private.example/${privateEventUsername}/${privateEventPassword}`,
          pending_action: { type: "credentials" },
        }),
      },
      {
        event: "origin_approval_required",
        detail: { origin: "https://ats.example.test" },
        session: rawSnapshot({
          state: "awaiting_origin_approval",
          pending_action: { type: "origin_approval", origin: "https://ats.example.test" },
        }),
      },
      {
        event: "additional_info_required",
        detail: { questions },
        session: rawSnapshot({
          state: "awaiting_additional_info",
          pending_action: { type: "additional_info", questions },
        }),
      },
      { event: "additional_info_saved", detail: { count: 4 }, session: baseSession },
      {
        event: "review_required",
        detail: {},
        session: rawSnapshot({
          state: "awaiting_human_review",
          pending_action: { type: "human_review" },
        }),
      },
      { event: "revision_applied", detail: { revision_count: 2 }, session: baseSession },
      {
        event: "submission_started",
        detail: {},
        session: rawSnapshot({ state: "submitting", pending_action: null }),
      },
      {
        event: "application_submitted",
        detail: {},
        session: rawSnapshot({ state: "submitted", pending_action: null }),
      },
      {
        event: "submission_uncertain",
        detail: {},
        session: rawSnapshot({ state: "submission_uncertain", pending_action: null }),
      },
      {
        event: "cancelled",
        detail: {},
        session: rawSnapshot({ state: "cancelled", pending_action: null }),
      },
      {
        event: "failed",
        detail: {},
        session: rawSnapshot({
          state: "failed",
          pending_action: null,
          error: { code: "browser_failed", message: "The browser session failed" },
        }),
      },
      {
        event: "closed",
        detail: {},
        session: rawSnapshot({ state: "closed", pending_action: null }),
      },
    ];
    const sse = eventInputs.map((input, index) => {
      const id = index + 8;
      return `id: ${id}\nevent: ${input.event}\ndata: ${
        JSON.stringify({ id, ...input })
      }\n\n`;
    }).join("");
    const encoded = new TextEncoder().encode(`: heartbeat\n\n${sse}`);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < encoded.byteLength; offset += 7) {
      chunks.push(encoded.subarray(offset, Math.min(offset + 7, encoded.byteLength)));
    }
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const client = new HttpApplicationHarnessClient({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: async (input, init) => {
        request = { url: String(input), init };
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = chunks.shift();
            if (chunk === undefined) controller.close();
            else controller.enqueue(chunk);
          },
        }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
      },
    });

    const events = [];
    for await (
      const event of await client.stream(SESSION_ID, 7, new AbortController().signal)
    ) events.push(event);

    expect(request).toMatchObject({
      url: `${ORIGIN}/v1/sessions/${SESSION_ID}/events`,
      init: {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${TOKEN}`,
          "last-event-id": "7",
        },
      },
    });
    expect(events.map(({ event, detail }) => ({ event, detail }))).toEqual([
      { event: "session_started", detail: {} },
      { event: "agent_step", detail: { stepNumber: 2 } },
      { event: "snapshot", detail: {} },
      { event: "human_navigation_required", detail: { instruction: "Complete the CAPTCHA." } },
      { event: "credentials_required", detail: {} },
      { event: "origin_approval_required", detail: { origin: "https://ats.example.test" } },
      {
        event: "additional_info_required",
        detail: {
          questions: [
            {
              id: "availability",
              scope: "global",
              question: "When can you start?",
              answerType: "text",
            },
            {
              id: "sponsorship",
              scope: "global",
              question: "Do you require sponsorship?",
              answerType: "boolean",
            },
            {
              id: "referral",
              scope: "application",
              question: "How did you hear about this role?",
              answerType: "single_select",
              options: [{ id: "site", label: "Company site" }, { id: "other", label: "Other" }],
            },
            {
              id: "work_setting",
              scope: "application",
              question: "Which settings work? 😀",
              answerType: "multi_select",
              options: [{ id: "remote", label: "Remote" }, { id: "onsite", label: "On-site" }],
            },
          ],
        },
      },
      { event: "additional_info_saved", detail: { count: 4 } },
      { event: "review_required", detail: {} },
      { event: "revision_applied", detail: { revisionCount: 2 } },
      { event: "submission_started", detail: {} },
      { event: "application_submitted", detail: {} },
      { event: "submission_uncertain", detail: {} },
      { event: "cancelled", detail: {} },
      { event: "failed", detail: {} },
      { event: "closed", detail: {} },
    ]);
    expect(events.map(({ id }) => id)).toEqual(
      Array.from({ length: eventInputs.length }, (_, index) => index + 8),
    );
    const serialized = JSON.stringify(events);
    for (const secret of [
      SESSION_ID,
      "jobs.private.example",
      "ats.private.example",
      "private.example/form",
      "model_provider",
      "approved_origins",
      "availability.start",
      privateEventUsername,
      privateEventPassword,
    ]) expect(serialized).not.toContain(secret);
  });
  test("opens and validates the upstream SSE response before exposing its iterator", async () => {
    let requests = 0;
    const client = new HttpApplicationHarnessClient({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: async () => {
        requests += 1;
        return new Response("", {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const opening = client.stream(SESSION_ID, undefined, new AbortController().signal);
    await Promise.resolve();

    expect(requests).toBe(1);
    const events = await opening;
    expect(events[Symbol.asyncIterator]).toBeFunction();
  });
  test("rejects wrong media, malformed UTF-8, mismatched, nonnumeric, and oversized SSE frames", async () => {
    const session = rawSnapshot({ state: "running", pending_action: null });
    const eventJson = JSON.stringify({
      id: 1,
      event: "snapshot",
      session,
      detail: {},
    });
    const streamResponse = (body: BodyInit, contentType = "text/event-stream") =>
      new Response(body, { headers: { "content-type": contentType } });
    const cases: Array<() => Response> = [
      () => streamResponse(`id: 1\nevent: snapshot\ndata: ${eventJson}\n\n`, "application/json"),
      () => streamResponse("id: 1\nevent: snapshot\ndata: {\n\n"),
      () => streamResponse(`id: 2\nevent: snapshot\ndata: ${eventJson}\n\n`),
      () => streamResponse(`id: nope\nevent: snapshot\ndata: ${eventJson}\n\n`),
      () => streamResponse(`id: 1\nevent: failed\ndata: ${eventJson}\n\n`),
      () => streamResponse(`id: 1\nevent: invented\ndata: ${
        JSON.stringify({ ...JSON.parse(eventJson), event: "invented" })
      }\n\n`),
      () => streamResponse(new Uint8Array([
        ...new TextEncoder().encode("id: 1\nevent: snapshot\ndata: "),
        0xff,
        0x0a,
        0x0a,
      ])),
      () => streamResponse(`id: 1\nevent: credentials_required\ndata: ${
        JSON.stringify({
          id: 1,
          event: "credentials_required",
          session: rawSnapshot({
            state: "awaiting_human_navigation",
            pending_action: { type: "credentials" },
          }),
          detail: {
            username: "private@example.test",
            password: "PRIVATE EVENT PASSWORD",
          },
        })
      }\n\n`),
      () => streamResponse(`id: 1\nevent: snapshot\ndata: ${
        "x".repeat(8 * 1024 * 1024)
      }\n\n`),
    ];

    for (const response of cases.map((createResponse) => createResponse())) {
      const client = new HttpApplicationHarnessClient({
        origin: ORIGIN,
        token: TOKEN,
        fetchImpl: async () => response,
      });
      const consume = async (): Promise<void> => {
        for await (
          const _event of await client.stream(
            SESSION_ID,
            undefined,
            new AbortController().signal,
          )
        ) {
          // Invalid streams must not emit an accepted event.
        }
      };
      await expect(consume()).rejects.toEqual(
        new ApplicationHarnessError("invalid_response"),
      );
    }
  });
  test("maps only bounded stable harness and network failures", async () => {
    const createInput: ApplicationHarnessCreateInput = {
      sessionId: SESSION_ID,
      jobUrl: "https://jobs.private.example/roles/123",
      opportunityKind: "job",
      autoSubmit: false,
      personalInformationMarkdown: "# Applicant",
      resumePdf: new TextEncoder().encode("%PDF-private"),
      resumeSource: new TextEncoder().encode("\\documentclass{article}"),
    };
    const responseCases = [
      {
        response: Response.json(
          { code: "session_active", session_id: SESSION_ID },
          { status: 409 },
        ),
        expected: "session_active_same_id" as const,
        invoke: (client: HttpApplicationHarnessClient) =>
          client.create(createInput, new AbortController().signal),
      },
      {
        response: Response.json(
          {
            code: "session_active",
            session_id: "223e4567-e89b-42d3-a456-426614174000",
          },
          { status: 409 },
        ),
        expected: "session_active_different_id" as const,
        invoke: (client: HttpApplicationHarnessClient) =>
          client.create(createInput, new AbortController().signal),
      },
      {
        response: Response.json(
          { code: "session_terminal", message: "private terminal detail" },
          { status: 409 },
        ),
        expected: "session_terminal" as const,
        invoke: (client: HttpApplicationHarnessClient) =>
          client.create(createInput, new AbortController().signal),
      },
      {
        response: Response.json(
          { code: "session_not_found", message: "private UUID detail" },
          { status: 404 },
        ),
        expected: "session_not_found" as const,
        invoke: (client: HttpApplicationHarnessClient) =>
          client.get(SESSION_ID, new AbortController().signal),
      },
      {
        response: Response.json(
          { code: "command_conflict", message: "private state detail" },
          { status: 409 },
        ),
        expected: "command_conflict" as const,
        invoke: (client: HttpApplicationHarnessClient) =>
          client.command(SESSION_ID, { type: "cancel" }, new AbortController().signal),
      },
      {
        response: Response.json(
          { code: "invalid_request", message: "private validation detail" },
          { status: 422 },
        ),
        expected: "invalid_request" as const,
        invoke: (client: HttpApplicationHarnessClient) =>
          client.create(createInput, new AbortController().signal),
      },
      {
        response: Response.json(
          { code: "unauthorized", message: "private auth detail" },
          { status: 401 },
        ),
        expected: "unauthorized" as const,
        invoke: (client: HttpApplicationHarnessClient) =>
          client.get(SESSION_ID, new AbortController().signal),
      },
      {
        response: Response.json(
          { code: "service_unavailable", message: "private shutdown detail" },
          { status: 503 },
        ),
        expected: "unavailable" as const,
        invoke: (client: HttpApplicationHarnessClient) =>
          client.get(SESSION_ID, new AbortController().signal),
      },
      {
        response: new Response("private upstream body", {
          status: 502,
          headers: { "content-type": "text/plain" },
        }),
        expected: "invalid_response" as const,
        invoke: (client: HttpApplicationHarnessClient) =>
          client.get(SESSION_ID, new AbortController().signal),
      },
      {
        response: new Response("{}", {
          status: 502,
          headers: {
            "content-type": "application/json",
            "content-length": String(64 * 1024 + 1),
          },
        }),
        expected: "invalid_response" as const,
        invoke: (client: HttpApplicationHarnessClient) =>
          client.get(SESSION_ID, new AbortController().signal),
      },
      {
        response: new Response(null, {
          status: 302,
          headers: { location: "https://remote.example/private" },
        }),
        expected: "invalid_response" as const,
        invoke: (client: HttpApplicationHarnessClient) =>
          client.get(SESSION_ID, new AbortController().signal),
      },
    ];

    for (const { response, expected, invoke } of responseCases) {
      const client = new HttpApplicationHarnessClient({
        origin: ORIGIN,
        token: TOKEN,
        fetchImpl: async () => response,
      });
      const error = await invoke(client).catch((reason: unknown) => reason);
      expect(error).toEqual(new ApplicationHarnessError(expected));
      expect(String(error)).not.toContain("private");
      expect(JSON.stringify(error)).not.toContain(SESSION_ID);
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    }

    const networkClient = new HttpApplicationHarnessClient({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: async () => {
        throw new Error(`private network failure ${SESSION_ID} ${TOKEN}`);
      },
    });
    const networkError = await networkClient.get(
      SESSION_ID,
      new AbortController().signal,
    ).catch((reason: unknown) => reason);
    expect(networkError).toEqual(new ApplicationHarnessError("unavailable"));
    expect(String(networkError)).not.toContain("private");
    expect(JSON.stringify(networkError)).not.toContain(SESSION_ID);
    expect(JSON.stringify(networkError)).not.toContain(TOKEN);
  });
  test("propagates caller abort and timeout reasons through fetch and body reads", async () => {
    const preAborted = new AbortController();
    const preAbortReason = new DOMException("caller stopped", "AbortError");
    preAborted.abort(preAbortReason);
    let fetchCalls = 0;
    const neverFetchClient = new HttpApplicationHarnessClient({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: async () => {
        fetchCalls += 1;
        return await new Promise<Response>(() => {});
      },
    });
    await expect(neverFetchClient.get(SESSION_ID, preAborted.signal))
      .rejects.toBe(preAbortReason);
    expect(fetchCalls).toBe(0);

    const duringFetch = new AbortController();
    const propagatedFetchSignals: AbortSignal[] = [];
    const pendingGet = new HttpApplicationHarnessClient({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: async (_input, init) => {
        propagatedFetchSignals.push(init?.signal as AbortSignal);
        return await new Promise<Response>(() => {});
      },
    }).get(SESSION_ID, duringFetch.signal);
    const fetchAbortReason = new DOMException("route closed", "AbortError");
    duringFetch.abort(fetchAbortReason);
    await expect(pendingGet).rejects.toBe(fetchAbortReason);
    expect(propagatedFetchSignals).toEqual([duringFetch.signal]);

    const duringBody = new AbortController();
    const pendingBody = new HttpApplicationHarnessClient({
      origin: ORIGIN,
      token: TOKEN,
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => {});
        },
      }), { headers: { "content-type": "application/json" } }),
    }).get(SESSION_ID, duringBody.signal);
    const bodyAbortReason = new DOMException("body timed out", "AbortError");
    duringBody.abort(bodyAbortReason);
    await expect(pendingBody).rejects.toBe(bodyAbortReason);

    const timeoutSignal = AbortSignal.timeout(1);
    const timeoutError = await neverFetchClient.get(SESSION_ID, timeoutSignal)
      .catch((reason: unknown) => reason);
    expect(timeoutError).toBeInstanceOf(DOMException);
    expect((timeoutError as DOMException).name).toBe("TimeoutError");
  });
});
