import { describe, expect, test } from "bun:test";
import {
  AdditionalInfoQuestionSchema,
  ApplicationSessionCommandSchema,
  ApplicationSessionEventDtoSchema,
  ApplicationSessionSnapshotDtoSchema,
  ApplicationSessionViewSchema,
  type AdditionalInfoQuestion,
} from "../src/contracts";
import {
  AcceptedAdditionalInfoAnswerSchema,
  AdditionalInfoRuntimeActionResponseSchema,
  ApplicationRunResultSchema,
  CancelledApplicationResultSchema,
  ReviewApplicationResultSchema,
  SubmittedApplicationResultSchema,
  SubmissionUncertainApplicationResultSchema,
  ApplicationRuntimeError,
  HttpApplicationRuntimeClient,
  InterruptedRuntimeActionResponseSchema,
  RequestAdditionalInfoRuntimeActionSchema,
  ReadEmailRuntimeActionSchema,
  ReadEmailRuntimeActionResponseSchema,
  ReadInboxRuntimeActionSchema,
  ReadInboxRuntimeActionResponseSchema,
  RequestSignInRuntimeActionSchema,
  PLAYWRIGHT_CLI_READ_ONLY_COMMANDS,
  PlaywrightCliToolParametersSchema,
  RuntimeActionRequestSchema,
  RuntimeActionResponseSchema,
  SignInRuntimeActionResponseSchema,
  SubmitRuntimeActionResponseSchema,
  type RuntimeActionRequest,
  type RuntimeActionResponse,
  type PlaywrightCliExecutionResult,
} from "../src/agents/application-runtime-client";

const RUNTIME_URL = "http://127.0.0.1:8765";
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const TOKEN = "test-token-0123456789abcdef-0123456789";
const READY_RESULT = {
  status: "ready_for_submission" as const,
  company: "Example Corp",
  role: "Engineer",
  job_url: "https://jobs.example.test/roles/123",
  final_url: "https://ats.example.test/applications/456",
  fields_filled: [
    {
      label: "Full name",
      field_type: "text" as const,
      value_present: true as const,
      note: "",
    },
  ],
  fields_needing_human: [],
  files_attached: ["resume.pdf"],
  warnings: ["Review the application before submitting."],
  revision_count: 0,
  submit_attempted: false as const,
};

const SUBMIT_EXECUTION_RESULT: PlaywrightCliExecutionResult = {
  exit_code: 0,
  stdout: "",
  stderr: "",
  stdout_truncated: false,
  stderr_truncated: false,
  observation: {
    url: "https://ats.example.test/applications/456/confirmation",
    title: "Application received",
    tabs: [],
    dom: "Application received",
    page_info: null,
    screenshot: null,
  },
};
const SUBMISSION_PERMISSION_RESPONSE = {
  type: "submit" as const,
  instruction: "You're good to submit." as const,
  result: READY_RESULT,
};


test("separates review data from terminal submission outcomes", () => {
  expect(ReviewApplicationResultSchema.parse(READY_RESULT)).toEqual(READY_RESULT);
  expect(ApplicationRunResultSchema.safeParse(READY_RESULT).success).toBe(false);

  const submitted = {
    ...READY_RESULT,
    status: "submitted" as const,
    final_url: SUBMIT_EXECUTION_RESULT.observation.url,
    submit_attempted: true as const,
    submission_confirmation: {
      type: "post_submit_confirmation" as const,
      text: "Application received",
    },
  };
  const uncertain = {
    ...READY_RESULT,
    status: "submission_uncertain" as const,
    submit_attempted: true as const,
    submission_confirmation: null,
  };
  const cancelled = {
    ...READY_RESULT,
    status: "cancelled" as const,
    submission_confirmation: null,
  };
  expect(SubmittedApplicationResultSchema.parse(submitted)).toEqual(submitted);
  expect(SubmissionUncertainApplicationResultSchema.parse(uncertain)).toEqual(uncertain);
  expect(CancelledApplicationResultSchema.parse(cancelled)).toEqual(cancelled);
  expect(ApplicationRunResultSchema.parse(submitted)).toEqual(submitted);
  expect(ApplicationRunResultSchema.parse(uncertain)).toEqual(uncertain);
  expect(ApplicationRunResultSchema.parse(cancelled)).toEqual(cancelled);
  expect(SubmittedApplicationResultSchema.safeParse({
    ...submitted,
    submission_confirmation: {
      type: "post_submit_confirmation",
      text: "😀".repeat(1_001),
    },
  }).success).toBe(false);
  expect(ReviewApplicationResultSchema.safeParse({
    ...READY_RESULT,
    fields_filled: [{
      ...READY_RESULT.fields_filled[0],
      value_present: false,
    }],
  }).success).toBe(false);
  expect(ReviewApplicationResultSchema.safeParse({
    ...READY_RESULT,
    fields_needing_human: [{
      ...READY_RESULT.fields_filled[0],
      value_present: true,
    }],
  }).success).toBe(false);
});


function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, init);
}


const ADDITIONAL_INFO_QUESTIONS: AdditionalInfoQuestion[] = [
  {
    id: "summer_availability",
    key: "availability.summer_2027",
    scope: "global" as const,
    question: "What dates are you available in Summer 2027?",
    answer_type: "text" as const,
  },
  {
    id: "work_setting",
    key: "preferences.work_setting",
    scope: "application" as const,
    question: "Which work settings can you accept?",
    answer_type: "multi_select" as const,
    options: [
      { id: "remote", label: "Remote" },
      { id: "onsite", label: "On-site" },
    ],
  },
  {
    id: "sponsorship",
    key: "eligibility.sponsorship",
    scope: "global" as const,
    question: "Will you now or later require sponsorship?",
    answer_type: "boolean" as const,
  },
  {
    id: "referral",
    key: "referral.source",
    scope: "application" as const,
    question: "How did you hear about this position?",
    answer_type: "single_select" as const,
    options: [
      { id: "company_site", label: "Company website" },
      { id: "other", label: "Other" },
    ],
  },
];

const PUBLIC_APPLICATION_SNAPSHOT = {
  generation: 2,
  bridgeState: "awaiting_additional_info" as const,
  harnessState: "awaiting_additional_info" as const,
  submissionPhase: "not_attempted" as const,
  createdAt: 1_720_000_000_000,
  updatedAt: 1_720_000_001_000,
  terminalAt: null,
  expiresAt: 1_720_003_600_000,
  company: "Example Corp",
  role: "Software Engineer",
  fieldsFilled: [
    {
      label: "Full name",
      fieldType: "text" as const,
      valuePresent: true,
      note: "",
    },
  ],
  fieldsNeedingHuman: [],
  filesAttached: ["Alex_Example_Resume.pdf"],
  playwrightCliDiagnostics: [],
  warnings: ["Review the application before submitting."],
  revisionCount: 1,
  pendingAction: {
    type: "additional_info" as const,
    questions: [
      {
        id: "work_setting",
        scope: "application" as const,
        question: "Which work settings can you accept?",
        answerType: "multi_select" as const,
        options: [
          { id: "remote", label: "Remote" },
          { id: "onsite", label: "On-site" },
        ],
      },
    ],
  },
  error: null,
};

test("strictly validates projected application snapshots and events", () => {
  expect(ApplicationSessionSnapshotDtoSchema.parse(PUBLIC_APPLICATION_SNAPSHOT))
    .toEqual(PUBLIC_APPLICATION_SNAPSHOT);
  const required = {
    generation: 2,
    event: "additional_info_required" as const,
    session: PUBLIC_APPLICATION_SNAPSHOT,
    detail: {
      questions: PUBLIC_APPLICATION_SNAPSHOT.pendingAction.questions,
    },
  };
  expect(ApplicationSessionEventDtoSchema.parse(required)).toEqual(required);
  expect(ApplicationSessionEventDtoSchema.safeParse({
    ...required,
    detail: { ...required.detail, currentUrl: "https://private.example/job" },
  }).success).toBe(false);
  expect(ApplicationSessionSnapshotDtoSchema.safeParse({
    ...PUBLIC_APPLICATION_SNAPSHOT,
    sessionId: SESSION_ID,
  }).success).toBe(false);
  expect(ApplicationSessionSnapshotDtoSchema.safeParse({
    ...PUBLIC_APPLICATION_SNAPSHOT,
    bridgeState: "running",
  }).success).toBe(false);
  expect(ApplicationSessionSnapshotDtoSchema.safeParse({
    ...PUBLIC_APPLICATION_SNAPSHOT,
    bridgeState: "failed",
    harnessState: "failed",
    terminalAt: PUBLIC_APPLICATION_SNAPSHOT.updatedAt,
    pendingAction: null,
    error: { code: "browser_failed", message: "raw browser exception" },
  }).success).toBe(false);
  const submitting = {
    ...PUBLIC_APPLICATION_SNAPSHOT,
    bridgeState: "submitting" as const,
    harnessState: "submitting" as const,
    submissionPhase: "attempting" as const,
    pendingAction: null,
  };
  expect(ApplicationSessionSnapshotDtoSchema.parse(submitting)).toEqual(submitting);
  expect(ApplicationSessionEventDtoSchema.parse({
    generation: submitting.generation,
    event: "submission_started",
    session: submitting,
    detail: {},
  }).event).toBe("submission_started");
  const submitted = {
    ...submitting,
    bridgeState: "submitted" as const,
    harnessState: "submitted" as const,
    submissionPhase: "submitted" as const,
  };
  expect(ApplicationSessionEventDtoSchema.parse({
    generation: submitted.generation,
    event: "application_submitted",
    session: submitted,
    detail: {},
  }).event).toBe("application_submitted");
  const uncertain = {
    ...submitting,
    bridgeState: "submission_uncertain" as const,
    harnessState: "submission_uncertain" as const,
    submissionPhase: "uncertain" as const,
    warnings: [
      "The application submission could not be verified. Check the headed browser if it is still available, then close this session.",
    ],
  };
  expect(ApplicationSessionEventDtoSchema.parse({
    generation: uncertain.generation,
    event: "submission_uncertain",
    session: uncertain,
    detail: {},
  }).event).toBe("submission_uncertain");
  expect(ApplicationSessionSnapshotDtoSchema.safeParse({
    ...submitted,
    submissionPhase: "uncertain",
  }).success).toBe(false);
  expect(ApplicationSessionSnapshotDtoSchema.parse({
    ...submitted,
    bridgeState: "closed",
    harnessState: "closed",
    terminalAt: submitted.updatedAt,
  }).submissionPhase).toBe("submitted");
});

test("strictly validates application commands and not-started views", () => {
  const command = {
    type: "provide_additional_info" as const,
    answers: [
      {
        id: "summer_availability",
        status: "answered" as const,
        raw_value: "June through August 2027",
        value: "I am available from June through August 2027.",
      },
      {
        id: "work_setting",
        status: "answered" as const,
        option_ids: ["remote", "onsite"],
      },
      {
        id: "referral",
        status: "declined" as const,
      },
    ],
  };
  expect(ApplicationSessionCommandSchema.parse(command)).toEqual(command);
  expect(ApplicationSessionCommandSchema.parse({ type: "submit" })).toEqual({ type: "submit" });
  expect(ApplicationSessionCommandSchema.safeParse({ type: "ready" }).success).toBe(false);
  expect(ApplicationSessionCommandSchema.safeParse({
    ...command,
    answers: [
      {
        id: "work_setting",
        status: "answered",
        option_ids: ["remote", "remote"],
      },
    ],
  }).success).toBe(false);
  const notStarted = {
    state: "not_started" as const,
    canStart: false,
    canStartAfterApproval: true,
  };
  expect(ApplicationSessionViewSchema.parse(notStarted)).toEqual(notStarted);
  expect(ApplicationSessionViewSchema.safeParse({
    ...notStarted,
    blockedReason: "harness_unconfigured",
  }).success).toBe(false);
});

test("mirrors strict additional-information question and request constraints", () => {
  for (const question of ADDITIONAL_INFO_QUESTIONS) {
    expect(AdditionalInfoQuestionSchema.parse(question)).toEqual(question);
  }
  const request = {
    type: "request_additional_info" as const,
    questions: ADDITIONAL_INFO_QUESTIONS,
  };
  expect(RequestAdditionalInfoRuntimeActionSchema.parse(request)).toEqual(request);
  expect(RuntimeActionRequestSchema.parse(request)).toEqual(request);
});

test("strictly validates credential-free sign-in runtime wire contracts", () => {
  const request = {
    type: "request_sign_in" as const,
    account_action: "create_account" as const,
    username_ref: "f2e248",
    password_ref: "f2e255",
    password_confirmation_ref: "f2e256",
    submit_ref: "f2e261",
  };
  expect(RequestSignInRuntimeActionSchema.parse(request)).toEqual(request);
  expect(RuntimeActionRequestSchema.parse(request)).toEqual(request);
  for (const invalidRequest of [
    { ...request, username_ref: "e0" },
    { ...request, username_ref: "e01" },
    { ...request, username_ref: "e1000000000" },
    { ...request, password_ref: " e2" },
    { ...request, password_confirmation_ref: "password-confirmation" },
    { ...request, account_action: "register" },
    { ...request, submit_ref: "button" },
    { ...request, submit_ref: "e3\n" },
    { ...request, username_ref: "f0e1" },
    { ...request, username_ref: "f1e0" },
    { type: "request_sign_in", username_ref: "e1", password_ref: "e2" },
    { ...request, username: "candidate@example.test" },
  ]) {
    expect(RequestSignInRuntimeActionSchema.safeParse(invalidRequest).success).toBe(false);
    expect(RuntimeActionRequestSchema.safeParse(invalidRequest).success).toBe(false);
  }

  for (const status of ["attempted", "saved"] as const) {
    const response = { type: "sign_in" as const, status };
    expect(SignInRuntimeActionResponseSchema.parse(response)).toEqual(response);
    expect(RuntimeActionResponseSchema.parse(response)).toEqual(response);
  }
  for (const invalidResponse of [
    { type: "sign_in" },
    { type: "sign_in", status: "failed" },
    { type: "sign_in", status: "attempted", origin: "https://apply.example.test" },
    { type: "sign_in", status: "saved", username: "candidate@example.test" },
  ]) {
    expect(SignInRuntimeActionResponseSchema.safeParse(invalidResponse).success).toBe(false);
    expect(RuntimeActionResponseSchema.safeParse(invalidResponse).success).toBe(false);
  }
});
test("rejects model-facing email-verification runtime contracts", () => {
  expect(RuntimeActionRequestSchema.safeParse({
    type: "request_email_verification",
    code_ref: "e41",
    submit_ref: "e42",
  }).success).toBe(false);
  expect(RuntimeActionResponseSchema.safeParse({
    type: "email_verification",
    status: "completed",
  }).success).toBe(false);
});

test("strictly validates the interrupted runtime response", () => {
  const response = { type: "interrupted" as const };
  expect(InterruptedRuntimeActionResponseSchema.parse(response)).toEqual(response);
  expect(RuntimeActionResponseSchema.parse(response)).toEqual(response);
  for (const invalidResponse of [
    { type: "interrupted", extra: true },
    { type: "interrupted", message: "private guidance" },
  ]) {
    expect(InterruptedRuntimeActionResponseSchema.safeParse(invalidResponse).success)
      .toBe(false);
    expect(RuntimeActionResponseSchema.safeParse(invalidResponse).success).toBe(false);
  }
});

test("rejects the removed deterministic candidate-question response", () => {
  expect(RuntimeActionResponseSchema.safeParse({
    type: "candidate_questions_required",
    questions: [{
      id: "candidate_deadbeef",
      key: "form.candidate_deadbeef",
      scope: "application",
      question: "Review emphasis",
      answer_type: "text",
    }],
  }).success).toBe(false);
});

test("mirrors strict accepted-answer and additional-information response constraints", () => {
  const answers = [
    {
      id: "summer_availability",
      key: "availability.summer_2027",
      scope: "global" as const,
      answer_type: "text" as const,
      status: "answered" as const,
      value: "June through August 2027",
    },
    {
      id: "sponsorship",
      key: "eligibility.sponsorship",
      scope: "global" as const,
      answer_type: "boolean" as const,
      status: "answered" as const,
      value: false,
    },
    {
      id: "referral",
      key: "referral.source",
      scope: "application" as const,
      answer_type: "single_select" as const,
      status: "answered" as const,
      value: "Company website",
    },
    {
      id: "work_setting",
      key: "preferences.work_setting",
      scope: "application" as const,
      answer_type: "multi_select" as const,
      status: "answered" as const,
      value: ["Remote", "On-site"],
    },
    {
      id: "salary",
      key: "compensation.salary",
      scope: "application" as const,
      answer_type: "text" as const,
      status: "declined" as const,
    },
  ];
  for (const answer of answers) {
    expect(AcceptedAdditionalInfoAnswerSchema.parse(answer)).toEqual(answer);
  }
  const response = { type: "additional_info" as const, answers };
  expect(AdditionalInfoRuntimeActionResponseSchema.parse(response)).toEqual(response);
  expect(RuntimeActionResponseSchema.parse(response)).toEqual(response);
});

test("rejects malformed additional-information questions, batches, and accepted answers", () => {
  const textQuestion = ADDITIONAL_INFO_QUESTIONS[0]!;
  const selectQuestion = ADDITIONAL_INFO_QUESTIONS[1]!;
  const invalidQuestions: unknown[] = [
    { ...textQuestion, id: "Summer" },
    { ...textQuestion, key: "availability..summer" },
    { ...textQuestion, key: `a.${"b".repeat(99)}` },
    { ...textQuestion, question: "   " },
    { ...textQuestion, question: "x".repeat(501) },
    { ...textQuestion, options: [{ id: "yes", label: "Yes" }] },
    { ...selectQuestion, options: [{ id: "remote", label: "Remote" }] },
    {
      ...selectQuestion,
      options: [{ id: "remote", label: "Remote" }, { id: "remote", label: "On-site" }],
    },
    {
      ...selectQuestion,
      options: [{ id: "remote", label: " " }, { id: "onsite", label: "On-site" }],
    },
    {
      ...selectQuestion,
      options: [
        { id: "Remote", label: "Remote" },
        { id: "onsite", label: "On-site" },
      ],
    },
    {
      ...selectQuestion,
      options: [
        { id: "remote", label: "x".repeat(201) },
        { id: "onsite", label: "On-site" },
      ],
    },
    {
      ...selectQuestion,
      options: Array.from(
        { length: 21 },
        (_, index) => ({ id: `option_${index}`, label: `Option ${index}` }),
      ),
    },
    { ...selectQuestion, unexpected: true },
  ];
  for (const question of invalidQuestions) {
    expect(AdditionalInfoQuestionSchema.safeParse(question).success).toBe(false);
  }

  const duplicateId = [
    textQuestion,
    { ...selectQuestion, id: textQuestion.id },
  ];
  const duplicateScopedKey = [
    textQuestion,
    { ...selectQuestion, id: "other", key: textQuestion.key, scope: textQuestion.scope },
  ];
  for (const questions of [[], duplicateId, duplicateScopedKey]) {
    expect(RequestAdditionalInfoRuntimeActionSchema.safeParse({
      type: "request_additional_info",
      questions,
    }).success).toBe(false);
  }
  expect(RequestAdditionalInfoRuntimeActionSchema.safeParse({
    type: "request_additional_info",
    questions: Array.from({ length: 21 }, (_, index) => ({
      ...textQuestion,
      id: `question_${index}`,
      key: `question.key_${index}`,
    })),
  }).success).toBe(false);

  const acceptedText = {
    id: "summer_availability",
    key: "availability.summer_2027",
    scope: "global",
    answer_type: "text",
    status: "answered",
    value: "June through August 2027",
  };
  const invalidAnswers: unknown[] = [
    { ...acceptedText, value: " " },
    { ...acceptedText, value: ` ${acceptedText.value}` },
    { ...acceptedText, value: "x".repeat(2_001) },
    { ...acceptedText, answer_type: "boolean" },
    { ...acceptedText, status: "declined" },
    { ...acceptedText, status: "declined", value: undefined },
    { ...acceptedText, answer_type: "single_select", value: "x".repeat(201) },
    { ...acceptedText, answer_type: "multi_select", value: [] },
    { ...acceptedText, answer_type: "multi_select", value: [" Remote"] },
    {
      ...acceptedText,
      answer_type: "multi_select",
      value: Array.from({ length: 21 }, (_, index) => `Option ${index}`),
    },
    { ...acceptedText, unexpected: true },
  ];
  for (const answer of invalidAnswers) {
    expect(AcceptedAdditionalInfoAnswerSchema.safeParse(answer).success).toBe(false);
  }
  expect(AdditionalInfoRuntimeActionResponseSchema.safeParse({
    type: "additional_info",
    answers: [],
  }).success).toBe(false);
  expect(AdditionalInfoRuntimeActionResponseSchema.safeParse({
    type: "additional_info",
    answers: Array.from({ length: 21 }, () => acceptedText),
  }).success).toBe(false);
});

test("exports the exact Playwright CLI commands that are read-only for submission claiming", () => {
  expect(PLAYWRIGHT_CLI_READ_ONLY_COMMANDS).toEqual([
    "snapshot",
    "screenshot",
    "pdf",
    "tab-list",
    "generate-locator",
    "highlight",
    "video-chapter",
    "video-show-actions",
    "video-hide-actions",
  ]);
});

describe("HttpApplicationRuntimeClient", () => {
  test("serializes only the strict action body in one authenticated request", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new HttpApplicationRuntimeClient(
      RUNTIME_URL,
      SESSION_ID,
      TOKEN,
      async (input, init) => {
        requests.push({ url: String(input), init: init ?? {} });
        return jsonResponse({
          type: "playwright_cli_result",
          ...SUBMIT_EXECUTION_RESULT,
        });
      },
    );
    const action: RuntimeActionRequest = {
      type: "playwright_cli",
      command: "snapshot",
      args: [],
    };

    await expect(client.action(action, new AbortController().signal)).resolves.toEqual({
      type: "playwright_cli_result",
      ...SUBMIT_EXECUTION_RESULT,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "http://127.0.0.1:8765/v1/sessions/123e4567-e89b-42d3-a456-426614174000/runtime/model-actions",
    );
    const request = requests[0]?.init;
    expect(request).toMatchObject({
      method: "POST",
      redirect: "manual",
      body: "{\"type\":\"playwright_cli\",\"command\":\"snapshot\",\"args\":[]}",
    });
    const requestHeaders = new Headers(request?.headers);
    expect([...requestHeaders.keys()].sort()).toEqual([
      "accept",
      "authorization",
      "content-type",
    ]);
    expect(requestHeaders.get("accept")).toBe("application/json");
    expect(requestHeaders.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(requestHeaders.get("content-type")).toBe("application/json");
    expect((request as RequestInit & { timeout?: boolean }).timeout).toBe(false);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  test("maps a harness invalid request from its single call without exposing details", async () => {
    const privateArgument = `https://private.example.test/apply?token=${TOKEN}`;
    const privateHarnessMessage = `invalid argument ${privateArgument}`;
    let fetchCalls = 0;
    const client = new HttpApplicationRuntimeClient(
      RUNTIME_URL,
      SESSION_ID,
      TOKEN,
      async () => {
        fetchCalls += 1;
        return jsonResponse(
          { code: "invalid_request", message: privateHarnessMessage },
          { status: 422 },
        );
      },
    );

    const failure = await client.action(
      {
        type: "playwright_cli",
        command: "goto",
        args: [privateArgument],
      },
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(failure).toEqual(new ApplicationRuntimeError("invalid_request"));
    expect(fetchCalls).toBe(1);
    expect(String(failure)).not.toContain(privateArgument);
    expect(String(failure)).not.toContain(privateHarnessMessage);
    expect(String(failure)).not.toContain(TOKEN);
    expect(String(failure)).not.toContain(RUNTIME_URL);
  });

  test("makes one call when the runtime transport fails", async () => {
    let fetchCalls = 0;
    const client = new HttpApplicationRuntimeClient(
      RUNTIME_URL,
      SESSION_ID,
      TOKEN,
      async () => {
        fetchCalls += 1;
        throw new Error(`private transport failure ${TOKEN}`);
      },
    );

    const failure = await client.action(
      { type: "report_application_mismatch" },
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(failure).toEqual(new ApplicationRuntimeError("model_failed"));
    expect(fetchCalls).toBe(1);
    expect(String(failure)).not.toContain(TOKEN);
  });

  test("bounds stalled response cleanup by caller cancellation", async () => {
    const caller = new AbortController();
    const abortReason = new Error("caller stopped stalled cleanup");
    const cancelStarted = Promise.withResolvers<void>();
    const cancelNever = Promise.withResolvers<void>();
    let requestSignal: AbortSignal | undefined;
    let fetchCalls = 0;
    const client = new HttpApplicationRuntimeClient(
      RUNTIME_URL,
      SESSION_ID,
      TOKEN,
      async (_input, init) => {
        fetchCalls += 1;
        requestSignal = init?.signal as AbortSignal;
        return new Response(new ReadableStream<Uint8Array>({
          cancel() {
            cancelStarted.resolve();
            return cancelNever.promise;
          },
        }), { status: 302 });
      },
    );
    const pending = client.action(
      { type: "report_application_mismatch" },
      caller.signal,
    );
    await cancelStarted.promise;
    caller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(fetchCalls).toBe(1);
    expect(requestSignal?.reason).toBe(abortReason);
  });



  test("maps fixed typed runtime failures from one call", async () => {
    const cases = [
      { code: "browser_failed", status: 502, expected: "browser_failed" },
      { code: "session_timeout", status: 504, expected: "model_failed" },
    ] as const;

    for (const { code, status, expected } of cases) {
      let fetchCalls = 0;
      const client = new HttpApplicationRuntimeClient(
        RUNTIME_URL,
        SESSION_ID,
        TOKEN,
        async () => {
          fetchCalls += 1;
          return jsonResponse({ code, message: `private ${TOKEN}` }, { status });
        },
      );

      const failure = await client.action(
        { type: "report_application_mismatch" },
        new AbortController().signal,
      ).catch((error: unknown) => error);

      expect(failure).toEqual(new ApplicationRuntimeError(expected));
      expect(fetchCalls).toBe(1);
    }
  });

  test("accepts the strict continue-without-additional-info response without answer payloads", async () => {
    const requests: unknown[] = [];
    const client = new HttpApplicationRuntimeClient(
      RUNTIME_URL,
      SESSION_ID,
      TOKEN,
      async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return jsonResponse({ type: "continue_without_additional_info" });
      },
    );
    const action: RuntimeActionRequest = {
      type: "request_additional_info",
      questions: [...ADDITIONAL_INFO_QUESTIONS],
    };

    await expect(client.action(action, new AbortController().signal)).resolves.toEqual({
      type: "continue_without_additional_info",
    });
    expect(requests).toEqual([action]);
    expect(RuntimeActionResponseSchema.safeParse({
      type: "continue_without_additional_info",
      answers: [],
    }).success).toBe(false);
    expect(RuntimeActionResponseSchema.safeParse({
      type: "continue_without_additional_info",
      unexpected: true,
    }).success).toBe(false);
  });

  test("validates bounded inbox search and MIME read runtime contracts", () => {
    expect(ReadInboxRuntimeActionSchema.parse({
      type: "read_inbox",
      query: "   ",
      date: "2026-08-30",
      time: "14:05",
      received_within_minutes: 1_440,
    })).toEqual({
      type: "read_inbox",
      query: "code",
      date: "2026-08-30",
      time: "14:05",
      received_within_minutes: 1_440,
    });
    for (const invalidRequest of [
      { type: "read_inbox", received_within_minutes: 0 },
      { type: "read_inbox", received_within_minutes: 1_441 },
      { type: "read_inbox", date: "2026-02-30" },
      { type: "read_inbox", date: "0000-01-01" },
      { type: "read_inbox", time: "24:00" },
      { type: "read_inbox", query: "code\nsubject" },
      { type: "read_inbox", unexpected: true },
    ]) {
      expect(RuntimeActionRequestSchema.safeParse(invalidRequest).success).toBe(false);
    }
    expect(ReadEmailRuntimeActionSchema.parse({
      type: "read_email",
      email_id: "message_1-abc",
    })).toEqual({ type: "read_email", email_id: "message_1-abc" });

    const inboxResponse = {
      type: "read_inbox_result" as const,
      messages: [{
        email_id: "message_1-abc",
        subject: "Your verification code",
        sent_at: "2026-08-30T14:22:03Z",
      }],
      truncated: true,
    };
    expect(ReadInboxRuntimeActionResponseSchema.parse(inboxResponse))
      .toEqual(inboxResponse);
    expect(RuntimeActionResponseSchema.parse(inboxResponse)).toEqual(inboxResponse);
    expect(ReadEmailRuntimeActionResponseSchema.parse({
      type: "read_email_result",
      content: "parsed MIME content",
    })).toEqual({ type: "read_email_result", content: "parsed MIME content" });
  });

  test("validates and serializes every runtime action variant", async () => {
    expect(RuntimeActionRequestSchema.parse({
      type: "playwright_cli",
      command: "snapshot",
    })).toEqual({
      type: "playwright_cli",
      command: "snapshot",
      args: [],
    });
    const exactInvocationLimitArgs = Array.from(
      { length: 7 },
      () => "x".repeat(8_192),
    );
    exactInvocationLimitArgs.push("x".repeat(8_184));
    expect(RuntimeActionRequestSchema.safeParse({
      type: "playwright_cli",
      command: "snapshot",
      args: exactInvocationLimitArgs,
    }).success).toBe(true);
    const bodies: unknown[] = [];
    const client = new HttpApplicationRuntimeClient(
      RUNTIME_URL,
      SESSION_ID,
      TOKEN,
      async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ type: "continue" });
      },
    );
    const actions: RuntimeActionRequest[] = [
      { type: "playwright_cli", command: "eval", args: ["document.body.innerText"] },
      {
        type: "read_inbox",
        query: "verification code",
        date: "2026-08-30",
        time: "14:00",
        received_within_minutes: 30,
      },
      { type: "read_email", email_id: "message_1-abc" },
      {
        type: "request_sign_in",
        account_action: "sign_in",
        username_ref: "e1",
        password_ref: "e2",
        submit_ref: "e3",
      },
      { type: "request_human_navigation", instruction: "Complete the CAPTCHA" },
      { type: "request_additional_info", questions: [...ADDITIONAL_INFO_QUESTIONS] },
      { type: "request_human_review", result: READY_RESULT },
      { type: "report_application_mismatch" },
    ];

    for (const action of actions) {
      await client.action(action, new AbortController().signal);
    }

    expect(bodies).toEqual(actions);
  });

  test("strictly parses every Python runtime success response variant", async () => {
    const cancelledResult = {
      ...READY_RESULT,
      status: "cancelled" as const,
      submission_confirmation: null,
    };
    const responses = [
      {
        type: "playwright_cli_result",
        exit_code: 0,
        stdout: "filled name",
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
        observation: {
          url: "https://ats.example.test/apply",
          title: "Apply",
          tabs: [
            {
              url: "https://ats.example.test/apply",
              title: "Apply",
              tab_id: "tab-1",
              parent_tab_id: null,
            },
          ],
          dom: "button Submit",
          page_info: { viewport: { width: 1280, height: 720 } },
          screenshot: { media_type: "image/png", data: "iVBORw0KGgo=" },
        },
      },
      { type: "sign_in", status: "attempted" },
      { type: "sign_in", status: "saved" },
      {
        type: "read_inbox_result",
        messages: [{
          email_id: "message_1-abc",
          subject: "Your verification code",
          sent_at: "2026-08-30T14:22:03Z",
        }],
        truncated: false,
      },
      { type: "read_email_result", content: "parsed MIME content" },
      { type: "continue" },
      {
        type: "additional_info",
        answers: [{
          id: "summer_availability",
          key: "availability.summer_2027",
          scope: "global",
          answer_type: "text",
          status: "answered",
          value: "June through August 2027",
        }],
      },
      SUBMISSION_PERMISSION_RESPONSE,
      { type: "cancel", result: cancelledResult },
      { type: "application_mismatch" },
    ] satisfies RuntimeActionResponse[];
    let responseIndex = 0;
    const client = new HttpApplicationRuntimeClient(
      RUNTIME_URL,
      SESSION_ID,
      TOKEN,
      async () => jsonResponse(responses[responseIndex++]),
    );

    for (const expected of responses) {
      await expect(
        client.action({ type: "report_application_mismatch" }, new AbortController().signal),
      ).resolves.toEqual(expected);
    }
  });
  test("matches Python character bounds by Unicode code point", () => {
    const character = "😀";
    const browserResponse = {
      type: "playwright_cli_result",
      exit_code: 0,
      stdout: character.repeat(20_000),
      stderr: character.repeat(20_000),
      stdout_truncated: false,
      stderr_truncated: false,
      observation: {
        url: "https://ats.example.test/apply",
        title: character.repeat(4_096),
        tabs: [{
          url: "https://ats.example.test/apply",
          title: character.repeat(4_096),
          tab_id: character.repeat(512),
          parent_tab_id: character.repeat(512),
        }],
        dom: character.repeat(40_000),
        page_info: null,
        screenshot: null,
      },
    } as const;
    const unicodeReady = {
      ...READY_RESULT,
      company: character.repeat(500),
      role: character.repeat(500),
      fields_filled: [{
        label: character.repeat(500),
        field_type: "text" as const,
        value_present: true,
        note: character.repeat(1_000),
      }],
      warnings: [character.repeat(1_000)],
    };

    expect(RuntimeActionResponseSchema.safeParse(browserResponse).success).toBe(true);
    expect(RuntimeActionResponseSchema.safeParse({
      ...browserResponse,
      stdout: character.repeat(20_001),
    }).success).toBe(false);
    expect(SubmitRuntimeActionResponseSchema.parse(
      SUBMISSION_PERMISSION_RESPONSE,
    )).toEqual(SUBMISSION_PERMISSION_RESPONSE);
    expect(RuntimeActionResponseSchema.safeParse({
      ...SUBMISSION_PERMISSION_RESPONSE,
      instruction: "Submit the application.",
    }).success).toBe(false);
    expect(RuntimeActionResponseSchema.safeParse({
      ...SUBMISSION_PERMISSION_RESPONSE,
      result: { ...unicodeReady, company: character.repeat(501) },
    }).success).toBe(false);
    expect(RuntimeActionResponseSchema.safeParse({
      type: "revise",
      context: character.repeat(20_000),
      revision_count: 1,
    }).success).toBe(true);
    expect(RuntimeActionResponseSchema.safeParse({
      type: "revise",
      context: character.repeat(20_001),
      revision_count: 1,
    }).success).toBe(false);
    expect(RuntimeActionRequestSchema.safeParse({
      type: "request_human_navigation",
      instruction: character.repeat(2_000),
    }).success).toBe(true);
    expect(RuntimeActionRequestSchema.safeParse({
      type: "request_human_navigation",
      instruction: character.repeat(2_001),
    }).success).toBe(false);
  });

  test("removes selector submission runtime requests and responses", () => {
    expect(RuntimeActionRequestSchema.safeParse({
      type: "submit_application",
      selector: "#final-submit",
    }).success).toBe(false);
    expect(RuntimeActionResponseSchema.safeParse({
      type: "submit_application_result",
      pre_click_dom: "button Submit",
      ...SUBMIT_EXECUTION_RESULT,
    }).success).toBe(false);
  });
  test("rejects unpaired UTF-16 surrogates in Playwright CLI arguments and accepts a valid pair", () => {
    for (const invalidArgument of ["\uD800", "\uDC00"]) {
      expect(PlaywrightCliToolParametersSchema.safeParse({
        command: "snapshot",
        args: [invalidArgument],
      }).success).toBe(false);
      expect(RuntimeActionRequestSchema.safeParse({
        type: "playwright_cli",
        command: "snapshot",
        args: [invalidArgument],
      }).success).toBe(false);
    }

    const validPair = "\uD83D\uDE00";
    expect(PlaywrightCliToolParametersSchema.safeParse({
      command: "snapshot",
      args: [validPair],
    }).success).toBe(true);
    expect(RuntimeActionRequestSchema.safeParse({
      type: "playwright_cli",
      command: "snapshot",
      args: [validPair],
    }).success).toBe(true);
  });

  test("rejects attached short session options without reserving other short options", () => {
    expect(PlaywrightCliToolParametersSchema.safeParse({
      command: "snapshot",
      args: ["-sother-session"],
    }).success).toBe(false);
    expect(RuntimeActionRequestSchema.safeParse({
      type: "playwright_cli",
      command: "snapshot",
      args: ["-sother-session"],
    }).success).toBe(false);
    expect(PlaywrightCliToolParametersSchema.safeParse({
      command: "snapshot",
      args: ["-xother-session"],
    }).success).toBe(true);
  });



  test("rejects invalid and non-strict runtime action inputs before fetching", async () => {
    let fetchCalls = 0;
    const client = new HttpApplicationRuntimeClient(
      RUNTIME_URL,
      SESSION_ID,
      TOKEN,
      async () => {
        fetchCalls += 1;
        return jsonResponse({ type: "continue" });
      },
    );
    const invalidInputs: unknown[] = [
      { type: "playwright_cli", command: "open", args: [] },
      { type: "playwright_cli", command: "snapshot", args: [], unexpected: true },
      { type: "playwright_cli", command: "snapshot", args: ["--session=other"] },
      { type: "playwright_cli", command: "snapshot", args: ["-s=other"] },
      { type: "playwright_cli", command: "snapshot", args: ["-s"] },
      { type: "playwright_cli", command: "snapshot", args: ["--s"] },
      { type: "playwright_cli", command: "snapshot", args: ["--s=other"] },
      { type: "playwright_cli", command: "snapshot", args: ["-h"] },
      { type: "playwright_cli", command: "snapshot", args: ["-h=true"] },
      { type: "playwright_cli", command: "snapshot", args: ["--help"] },
      { type: "playwright_cli", command: "snapshot", args: ["--help=true"] },
      { type: "playwright_cli", command: "snapshot", args: ["-v"] },
      { type: "playwright_cli", command: "snapshot", args: ["-v=true"] },
      { type: "playwright_cli", command: "snapshot", args: ["--version"] },
      { type: "playwright_cli", command: "snapshot", args: ["--version=true"] },
      { type: "playwright_cli", command: "snapshot", args: ["--json"] },
      { type: "playwright_cli", command: "snapshot", args: ["--raw=true"] },
      { type: "playwright_cli", command: "snapshot", args: ["--config=other.json"] },
      { type: "playwright_cli", command: "snapshot", args: ["--profile", "/tmp/profile"] },
      { type: "playwright_cli", command: "snapshot", args: ["--browser=firefox"] },
      {
        type: "playwright_cli",
        command: "snapshot",
        args: Array.from({ length: 65 }, () => "x"),
      },
      { type: "playwright_cli", command: "snapshot", args: ["é".repeat(4_097)] },
      { type: "playwright_cli", command: "snapshot", args: ["bad\u0000argument"] },
      {
        type: "playwright_cli",
        command: "snapshot",
        args: Array.from({ length: 9 }, () => "x".repeat(8_192)),
      },
      {
        type: "request_sign_in",
        account_action: "sign_in",
        username_ref: "e0",
        password_ref: "e2",
        submit_ref: "e3",
      },
      { type: "request_human_navigation", instruction: "   " },
      {
        type: "request_origin_approval",
        origin: "https://ats.example.test",
      },
      { type: "request_additional_info", questions: [] },
      {
        type: "request_human_review",
        result: { ...READY_RESULT, files_attached: ["../resume.pdf"] },
      },
      { type: "report_application_mismatch", unexpected: true },
      { type: "unknown" },
    ];

    for (const input of invalidInputs) {
      await expect(
        client.action(input as RuntimeActionRequest, new AbortController().signal),
      ).rejects.toEqual(new ApplicationRuntimeError("model_failed"));
    }
    expect(fetchCalls).toBe(0);
  });

  test("maps only flat browser errors without leaking response content", async () => {
    const cases = [
      {
        response: jsonResponse(
          { code: "browser_failed", message: "private browser detail" },
          { status: 502 },
        ),
        expected: new ApplicationRuntimeError("browser_failed"),
      },
      {
        response: jsonResponse(
          { code: "command_conflict", message: "private conflict detail" },
          { status: 409 },
        ),
        expected: new ApplicationRuntimeError("model_failed"),
      },
      {
        response: jsonResponse(
          { error: { code: "retired_error", message: "nested secret" } },
          { status: 409 },
        ),
        expected: new ApplicationRuntimeError("model_failed"),
      },
    ];

    for (const { response, expected } of cases) {
      const client = new HttpApplicationRuntimeClient(
        RUNTIME_URL,
        SESSION_ID,
        TOKEN,
        async () => response,
      );
      let failure: unknown;
      try {
        await client.action({ type: "report_application_mismatch" }, new AbortController().signal);
      } catch (error) {
        failure = error;
      }
      expect(failure).toEqual(expected);
      expect(String(failure)).not.toContain("private");
      expect(String(failure)).not.toContain("secret");
    }

    const networkClient = new HttpApplicationRuntimeClient(
      RUNTIME_URL,
      SESSION_ID,
      TOKEN,
      async () => {
        throw new Error(`upstream echoed Bearer ${TOKEN}`);
      },
    );
    let networkFailure: unknown;
    try {
      await networkClient.action({ type: "report_application_mismatch" }, new AbortController().signal);
    } catch (error) {
      networkFailure = error;
    }
    expect(networkFailure).toEqual(new ApplicationRuntimeError("model_failed"));
    expect(String(networkFailure)).not.toContain(TOKEN);
  });

  test("maps a harness session timeout to the application model-timeout error", async () => {
    let fetchCalls = 0;
    const client = new HttpApplicationRuntimeClient(
      RUNTIME_URL,
      SESSION_ID,
      TOKEN,
      async () => {
        fetchCalls += 1;
        return jsonResponse(
          { code: "session_timeout", message: "private harness timeout detail" },
          { status: 504 },
        );
      },
    );

    let failure: unknown;
    try {
      await client.action({ type: "report_application_mismatch" }, new AbortController().signal);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ApplicationRuntimeError);
    expect((failure as ApplicationRuntimeError).code).toBe("model_failed");
    expect((failure as Error).message).toBe("The model request failed");
    expect(fetchCalls).toBe(1);
  });

  test("accepts only loopback HTTP origins, valid UUIDs, and sufficiently long bearers", async () => {
    const requestedUrls: string[] = [];
    for (const runtimeUrl of [
      "http://localhost:8765/",
      "http://127.42.0.7:8765",
      "http://[::1]:8765",
    ]) {
      const client = new HttpApplicationRuntimeClient(
        runtimeUrl,
        SESSION_ID,
        TOKEN,
        async (input) => {
          requestedUrls.push(String(input));
          return jsonResponse({ type: "continue" });
        },
      );
      await client.action({ type: "report_application_mismatch" }, new AbortController().signal);
    }
    expect(requestedUrls).toEqual([
      `http://localhost:8765/v1/sessions/${SESSION_ID}/runtime/model-actions`,
      `http://127.42.0.7:8765/v1/sessions/${SESSION_ID}/runtime/model-actions`,
      `http://[::1]:8765/v1/sessions/${SESSION_ID}/runtime/model-actions`,
    ]);

    const invalidArguments: Array<[string, string, string]> = [
      ["https://127.0.0.1:8765", SESSION_ID, TOKEN],
      ["http://runtime.example.test:8765", SESSION_ID, TOKEN],
      ["http://127.0.0.1:8765/path", SESSION_ID, TOKEN],
      ["http://127.0.0.1:8765?secret=yes", SESSION_ID, TOKEN],
      ["http://user:password@127.0.0.1:8765", SESSION_ID, TOKEN],
      ["not a URL", SESSION_ID, TOKEN],
      [RUNTIME_URL, "not-a-uuid", TOKEN],
      [RUNTIME_URL, SESSION_ID, "short-token"],
    ];
    for (const [runtimeUrl, sessionId, token] of invalidArguments) {
      expect(
        () => new HttpApplicationRuntimeClient(
          runtimeUrl,
          sessionId,
          token,
          async () => jsonResponse({ type: "continue" }),
        ),
      ).toThrow(new ApplicationRuntimeError("model_failed"));
    }
  });



  test("rejects malformed, non-strict, and redirect responses", async () => {
    const followedRedirect = jsonResponse({ type: "continue" });
    Object.defineProperty(followedRedirect, "redirected", { value: true });
    const malformedResponses = [
      new Response("{", { headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ type: "continue" }), {
        headers: { "content-type": "text/plain" },
      }),
      jsonResponse({ type: "continue", unexpected: true }),
      jsonResponse({
        type: "approve",
        origin: "https://ats.example.test",
        approved_origins: ["https://ats.example.test"],
      }),
      jsonResponse({
        type: "submit",
        result: { ...READY_RESULT, status: "cancelled" },
      }),
      jsonResponse({ type: "additional_info", answers: [] }),
      jsonResponse({
        type: "additional_info",
        answers: [{
          id: "summer_availability",
          key: "availability.summer_2027",
          scope: "global",
          answer_type: "text",
          status: "declined",
          value: "must be omitted",
        }],
      }),
      jsonResponse({
        type: "playwright_cli_result",
        exit_code: 0,
        stdout: "",
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
        observation: {
          url: "https://ats.example.test",
          title: "x".repeat(4_097),
          tabs: [],
          dom: "",
          page_info: null,
          screenshot: null,
        },
      }),
      jsonResponse({ type: "continue" }, { status: 302 }),
      followedRedirect,
    ];

    for (const response of malformedResponses) {
      const client = new HttpApplicationRuntimeClient(
        RUNTIME_URL,
        SESSION_ID,
        TOKEN,
        async () => response,
      );
      await expect(
        client.action({ type: "report_application_mismatch" }, new AbortController().signal),
      ).rejects.toEqual(new ApplicationRuntimeError("model_failed"));
    }
  });

  test("rejects declared and streamed responses over 16 MiB", async () => {
    let declaredBodyCancelled = false;
    const declaredBody = new ReadableStream<Uint8Array>({
      pull() {
        // Keep the stream open; the declared size must make the client cancel it.
      },
      cancel() {
        declaredBodyCancelled = true;
      },
    });
    const declaredClient = new HttpApplicationRuntimeClient(
      RUNTIME_URL,
      SESSION_ID,
      TOKEN,
      async () => new Response(declaredBody, {
        headers: {
          "content-type": "application/json",
          "content-length": String(16 * 1024 * 1024 + 1),
        },
      }),
    );
    await expect(
      declaredClient.action({ type: "report_application_mismatch" }, new AbortController().signal),
    ).rejects.toEqual(new ApplicationRuntimeError("model_failed"));
    expect(declaredBodyCancelled).toBe(true);

    let streamedBodyCancelled = false;
    const streamedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
      },
      cancel() {
        streamedBodyCancelled = true;
      },
    });
    const streamedClient = new HttpApplicationRuntimeClient(
      RUNTIME_URL,
      SESSION_ID,
      TOKEN,
      async () => new Response(streamedBody, {
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      streamedClient.action({ type: "report_application_mismatch" }, new AbortController().signal),
    ).rejects.toEqual(new ApplicationRuntimeError("model_failed"));
    expect(streamedBodyCancelled).toBe(true);
  });

  test("propagates the caller abort reason before and during the request", async () => {
    const preAborted = new AbortController();
    const preAbortReason = new Error("caller stopped before request");
    preAborted.abort(preAbortReason);
    let fetchCalls = 0;
    const preAbortedClient = new HttpApplicationRuntimeClient(
      RUNTIME_URL,
      SESSION_ID,
      TOKEN,
      async () => {
        fetchCalls += 1;
        return jsonResponse({ type: "continue" });
      },
    );
    await expect(
      preAbortedClient.action({ type: "report_application_mismatch" }, preAborted.signal),
    ).rejects.toBe(preAbortReason);
    expect(fetchCalls).toBe(0);

    const controller = new AbortController();
    const abortReason = new Error("caller stopped active request");
    let requestSignal: AbortSignal | undefined;
    const activeClient = new HttpApplicationRuntimeClient(
      RUNTIME_URL,
      SESSION_ID,
      TOKEN,
      async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => {});
      },
    );
    const pending = activeClient.action({ type: "report_application_mismatch" }, controller.signal);
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toBe(abortReason);
  });

});
