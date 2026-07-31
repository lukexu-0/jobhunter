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
  RequestAdditionalInfoRuntimeActionSchema,
  SubmitApplicationRuntimeActionSchema,
  SubmitApplicationResultRuntimeActionResponseSchema,
  RuntimeActionRequestSchema,
  RuntimeActionResponseSchema,
  type RuntimeActionRequest,
  type RuntimeActionResponse,
  type BrowserUseExecutionResult,
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

const SUBMIT_EXECUTION_RESULT: BrowserUseExecutionResult = {
  exit_code: 0,
  timed_out: false,
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

  const request = { type: "submit_application" as const, selector: "button[type='submit']" };
  expect(SubmitApplicationRuntimeActionSchema.parse(request)).toEqual(request);
  expect(RuntimeActionRequestSchema.parse(request)).toEqual(request);
  expect(SubmitApplicationRuntimeActionSchema.safeParse({
    type: "submit_application",
    selector: " ",
  }).success).toBe(false);
  expect(SubmitApplicationRuntimeActionSchema.safeParse({
    type: "submit_application",
    selector: "x".repeat(2_001),
  }).success).toBe(false);
  expect(SubmitApplicationRuntimeActionSchema.safeParse({
    type: "submit_application",
    selector: "😀".repeat(2_000),
  }).success).toBe(true);
  expect(SubmitApplicationRuntimeActionSchema.safeParse({
    type: "submit_application",
    code: "click_at_xy(10, 10)",
  }).success).toBe(false);
  const response = {
    type: "submit_application_result" as const,
    pre_click_dom: "button Final submit",
    ...SUBMIT_EXECUTION_RESULT,
  };
  expect(SubmitApplicationResultRuntimeActionResponseSchema.parse(response)).toEqual(response);
  expect(RuntimeActionResponseSchema.parse(response)).toEqual(response);
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
  browserUseDiagnostics: [],
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
        value: "June through August 2027",
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

describe("HttpApplicationRuntimeClient", () => {
  test("posts an authenticated action to the exact session runtime endpoint", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new HttpApplicationRuntimeClient(
      RUNTIME_URL,
      SESSION_ID,
      TOKEN,
      async (input, init) => {
        requests.push({ url: String(input), init: init ?? {} });
        return jsonResponse({ type: "continue" });
      },
    );
    const action: RuntimeActionRequest = {
      type: "request_human_navigation",
      instruction: "Complete the CAPTCHA",
    };

    await expect(client.action(action, new AbortController().signal, 1_000)).resolves.toEqual({
      type: "continue",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "http://127.0.0.1:8765/v1/sessions/123e4567-e89b-42d3-a456-426614174000/runtime/actions",
    );
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(action),
    });
    expect((requests[0]?.init as RequestInit & { timeout?: boolean }).timeout).toBe(false);
    expect(requests[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });
  test("validates and serializes every runtime action variant", async () => {
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
      { type: "browser_use", code: "print(page_info())" },
      { type: "request_human_navigation", instruction: "Complete the CAPTCHA" },
      { type: "request_origin_approval", origin: "https://ats.example.test" },
      { type: "request_additional_info", questions: [...ADDITIONAL_INFO_QUESTIONS] },
      { type: "request_human_review", result: READY_RESULT },
      { type: "report_application_mismatch" },
    ];

    for (const action of actions) {
      await client.action(action, new AbortController().signal, 1_000);
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
        type: "browser_use_result",
        exit_code: 0,
        timed_out: false,
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
      {
        type: "submit_application_result",
        pre_click_dom: "button Submit",
        ...SUBMIT_EXECUTION_RESULT,
      },
      { type: "continue" },
      {
        type: "approve",
        origin: "https://ats.example.test",
        approved_origins: ["https://jobs.example.test", "https://ats.example.test"],
      },
      { type: "revise", context: "Use the revised answer.", revision_count: 1 },
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
      { type: "submit", result: READY_RESULT },
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
        client.action(
          { type: "report_application_mismatch" },
          new AbortController().signal,
          1_000,
        ),
      ).resolves.toEqual(expected);
    }
  });
  test("matches Python character bounds by Unicode code point", () => {
    const character = "😀";
    const browserResponse = {
      type: "browser_use_result",
      exit_code: 0,
      timed_out: false,
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
    expect(RuntimeActionResponseSchema.safeParse({
      type: "submit",
      result: unicodeReady,
    }).success).toBe(true);
    expect(RuntimeActionResponseSchema.safeParse({
      type: "submit",
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
      { type: "browser_use", code: "x".repeat(65_537) },
      { type: "request_human_navigation", instruction: "   " },
      {
        type: "request_origin_approval",
        origin: "http://not-loopback.example.test",
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
        client.action(
          input as RuntimeActionRequest,
          new AbortController().signal,
          1_000,
        ),
      ).rejects.toEqual(new ApplicationRuntimeError("model_failed"));
    }
    expect(fetchCalls).toBe(0);
  });

  test("maps only flat step and browser errors without leaking response content", async () => {
    const cases = [
      {
        response: jsonResponse(
          { code: "step_limit", message: "private server detail" },
          { status: 409 },
        ),
        expected: new ApplicationRuntimeError("step_limit"),
      },
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
          { error: { code: "step_limit", message: "nested secret" } },
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
        await client.action(
          { type: "report_application_mismatch" },
          new AbortController().signal,
          1_000,
        );
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
      await networkClient.action(
        { type: "report_application_mismatch" },
        new AbortController().signal,
        1_000,
      );
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
      await client.action(
        { type: "report_application_mismatch" },
        new AbortController().signal,
        1_000,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ApplicationRuntimeError);
    expect((failure as ApplicationRuntimeError).code).toBe("model_timeout");
    expect((failure as Error).message).toBe("The model request timed out");
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
      await client.action(
        { type: "report_application_mismatch" },
        new AbortController().signal,
        1_000,
      );
    }
    expect(requestedUrls).toEqual([
      `http://localhost:8765/v1/sessions/${SESSION_ID}/runtime/actions`,
      `http://127.42.0.7:8765/v1/sessions/${SESSION_ID}/runtime/actions`,
      `http://[::1]:8765/v1/sessions/${SESSION_ID}/runtime/actions`,
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
    for (const arguments_ of invalidArguments) {
      expect(
        () => new HttpApplicationRuntimeClient(...arguments_),
      ).toThrow(new ApplicationRuntimeError("model_failed"));
    }
  });

  test("rejects an out-of-range loopback IPv4 origin before fetching", async () => {
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

    let failure: unknown;
    try {
      await client.action(
        {
          type: "request_origin_approval",
          origin: "http://127.999.1.1",
        },
        new AbortController().signal,
        1_000,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ApplicationRuntimeError);
    expect((failure as ApplicationRuntimeError).code).toBe("model_failed");
    expect((failure as Error).message).toBe("The model request failed");
    expect(fetchCalls).toBe(0);
  });

  test("rejects invalid timeout values before fetching", async () => {
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
    for (const timeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY, 4_294_967_296]) {
      await expect(
        client.action(
          { type: "report_application_mismatch" },
          new AbortController().signal,
          timeoutMs,
        ),
      ).rejects.toEqual(new ApplicationRuntimeError("model_failed"));
    }
    expect(fetchCalls).toBe(0);
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
        approved_origins: ["https://ats.example.test", "https://ats.example.test"],
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
        type: "browser_use_result",
        exit_code: 0,
        timed_out: false,
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
        client.action(
          { type: "report_application_mismatch" },
          new AbortController().signal,
          1_000,
        ),
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
      declaredClient.action(
        { type: "report_application_mismatch" },
        new AbortController().signal,
        1_000,
      ),
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
      streamedClient.action(
        { type: "report_application_mismatch" },
        new AbortController().signal,
        1_000,
      ),
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
      preAbortedClient.action(
        { type: "report_application_mismatch" },
        preAborted.signal,
        1_000,
      ),
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
    const pending = activeClient.action(
      { type: "report_application_mismatch" },
      controller.signal,
      1_000,
    );
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toBe(abortReason);
  });

  test("composes a timeout signal without aborting the caller signal", async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const client = new HttpApplicationRuntimeClient(
      RUNTIME_URL,
      SESSION_ID,
      TOKEN,
      async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => {});
      },
    );

    let failure: unknown;
    try {
      await client.action(
        { type: "report_application_mismatch" },
        caller.signal,
        5,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DOMException);
    expect((failure as DOMException).name).toBe("TimeoutError");
    expect(requestSignal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
  });
});
