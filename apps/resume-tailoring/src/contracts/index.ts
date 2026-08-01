import { z } from "zod";

function hasCodePointLength(
  value: string,
  minimum: number,
  maximum: number,
): boolean {
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > maximum) return false;
  }
  return length >= minimum;
}

function parsedHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function isApplicationOrigin(value: string): boolean {
  const url = parsedHttpUrl(value);
  if (
    url === undefined
    || url.hostname.includes("*")
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    return false;
  }
  return url.protocol === "https:" || isLoopbackHostname(normalizedHostname(url));
}

function isSanitizedBasename(value: string): boolean {
  return hasCodePointLength(value, 1, 255)
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !/[\u0000-\u001f]/.test(value);
}

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const OAuthProviderSchema = z.literal("openai-codex");
export type OAuthProvider = z.infer<typeof OAuthProviderSchema>;

export const AuthIdentitySchema = z
  .object({
    email: z.string().min(1).optional(),
    accountId: z.string().min(1).optional(),
  })
  .strict();
export type AuthIdentity = z.infer<typeof AuthIdentitySchema>;

export const AuthProviderStatusSchema = z
  .object({
    provider: OAuthProviderSchema,
    state: z.enum(["connected", "disconnected"]),
    identity: AuthIdentitySchema.optional(),
  })
  .strict();
export type AuthProviderStatus = z.infer<typeof AuthProviderStatusSchema>;

export const AuthStatusResponseSchema = z
  .object({
    providers: z.array(AuthProviderStatusSchema).length(1),
  })
  .strict();
export type AuthStatusResponse = z.infer<typeof AuthStatusResponseSchema>;

export const AuthPromptSchema = z
  .object({
    message: z.string(),
    placeholder: z.string().optional(),
    kind: z.enum(["prompt", "manual-code"]),
  })
  .strict();
export type AuthPrompt = z.infer<typeof AuthPromptSchema>;

export const AuthSessionSchema = z
  .object({
    id: z.string().min(1),
    provider: OAuthProviderSchema,
    state: z.enum(["pending", "succeeded", "failed", "cancelled", "expired"]),
    launchUrl: z.string().url().optional(),
    url: z.string().url().optional(),
    instructions: z.string().optional(),
    progress: z.array(z.string()),
    prompt: AuthPromptSchema.optional(),
    error: z.string().optional(),
    expiresAt: z.number().int(),
  })
  .strict();
export type AuthSession = z.infer<typeof AuthSessionSchema>;

export const StartAuthSessionRequestSchema = z.object({}).strict();
export const AuthPromptAnswerSchema = z.object({ value: z.string().min(1).max(8_192) }).strict();

export const RunStatusSchema = z.enum([
  "queued",
  "analyzing",
  "tailoring",
  "editing",
  "compiling",
  "repairing",
  "deterministic_qa",
  "visual_qa",
  "review",
  "approved",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const APPLICATION_STATUSES = ["pending", "applied", "rejected", "interview", "accepted", "failed"] as const;
export const ApplicationStatusSchema = z.enum(APPLICATION_STATUSES);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;
export const UpdateApplicationStatusRequestSchema =
  z.object({ applicationStatus: ApplicationStatusSchema }).strict();

export const RunIdentityTextSchema = z.string().trim().min(1).max(200);
export const UpdateRunIdentityRequestSchema = z
  .object({
    title: RunIdentityTextSchema.optional(),
    organization: RunIdentityTextSchema.optional(),
  })
  .strict()
  .refine(
    ({ title, organization }) => title !== undefined || organization !== undefined,
    { message: "Title or organization is required" },
  );

export const RevisionOriginSchema = z.enum(["initial", "machine-regeneration", "human-comments"]);
export type RevisionOrigin = z.infer<typeof RevisionOriginSchema>;

export const FieldTypeSchema = z.enum([
  "text",
  "textarea",
  "select",
  "radio",
  "checkbox",
  "number",
  "file",
  "unknown",
]);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const FieldResultSchema = z.object({
  label: z.string().refine((value) => hasCodePointLength(value, 1, 500)),
  field_type: FieldTypeSchema,
  value_present: z.boolean(),
  note: z.string().refine((value) => hasCodePointLength(value, 0, 1_000)).default(""),
}).strict();
export type FieldResult = z.infer<typeof FieldResultSchema>;

export const AdditionalInfoQuestionIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const UserInfoKeySchema = z.string()
  .refine((value) => hasCodePointLength(value, 1, 100))
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/);
const AdditionalInfoQuestionTextSchema = z.string().trim()
  .refine((value) => hasCodePointLength(value, 1, 500));
const AdditionalInfoOptionLabelSchema = z.string().trim()
  .refine((value) => hasCodePointLength(value, 1, 200));
const AdditionalInfoOptionSchema = z.object({
  id: AdditionalInfoQuestionIdSchema,
  label: AdditionalInfoOptionLabelSchema,
}).strict();
const AdditionalInfoQuestionBaseShape = {
  id: AdditionalInfoQuestionIdSchema,
  key: UserInfoKeySchema,
  scope: z.enum(["global", "application"]),
  question: AdditionalInfoQuestionTextSchema,
};
const AdditionalInfoOptionsSchema = z.array(AdditionalInfoOptionSchema).min(2).max(20)
  .superRefine((options, context) => {
    if (new Set(options.map((option) => option.id)).size !== options.length) {
      context.addIssue({ code: "custom", message: "option ids must be unique" });
    }
  });

export const AdditionalInfoQuestionSchema = z.discriminatedUnion("answer_type", [
  z.object({
    ...AdditionalInfoQuestionBaseShape,
    answer_type: z.literal("text"),
  }).strict(),
  z.object({
    ...AdditionalInfoQuestionBaseShape,
    answer_type: z.literal("boolean"),
  }).strict(),
  z.object({
    ...AdditionalInfoQuestionBaseShape,
    answer_type: z.literal("single_select"),
    options: AdditionalInfoOptionsSchema,
  }).strict(),
  z.object({
    ...AdditionalInfoQuestionBaseShape,
    answer_type: z.literal("multi_select"),
    options: AdditionalInfoOptionsSchema,
  }).strict(),
]);
export type AdditionalInfoQuestion = z.infer<typeof AdditionalInfoQuestionSchema>;

const ResumeDiffIdSchema = z.string().trim().min(1).max(200);
const ResumeDiffTextSchema = z.string().trim().min(1).max(2_000);

export const ResumeDiffChangeSchema = z.enum(["unchanged", "edited", "deleted", "added"]);
export type ResumeDiffChange = z.infer<typeof ResumeDiffChangeSchema>;

export const ResumeDiffRowSchema = z.object({
  id: ResumeDiffIdSchema,
  kind: z.enum(["bullet", "skill"]),
  change: ResumeDiffChangeSchema,
  before: ResumeDiffTextSchema.nullable(),
  after: ResumeDiffTextSchema.nullable(),
}).strict().superRefine((row, ctx) => {
  if (row.change === "unchanged" && (row.before === null || row.after === null || row.before !== row.after)) {
    ctx.addIssue({ code: "custom", message: "unchanged rows require matching before and after text" });
  }
  if (row.change === "edited" && (row.before === null || row.after === null || row.before === row.after)) {
    ctx.addIssue({ code: "custom", message: "edited rows require different before and after text" });
  }
  if (row.change === "deleted" && (row.before === null || row.after !== null)) {
    ctx.addIssue({ code: "custom", message: "deleted rows require only before text" });
  }
  if (row.change === "added" && (row.before !== null || row.after === null)) {
    ctx.addIssue({ code: "custom", message: "added rows require only after text" });
  }
});
export type ResumeDiffRow = z.infer<typeof ResumeDiffRowSchema>;

export const ResumeDiffSchema = z.object({
  schemaVersion: z.literal(1),
  baselineSha256: z.string().regex(/^[a-f0-9]{64}$/),
  planId: ResumeDiffIdSchema,
  sections: z.array(z.object({
    id: z.enum(["experience", "projects", "competitions-other", "technical-skills"]),
    label: ResumeDiffTextSchema,
    groups: z.array(z.object({
      id: ResumeDiffIdSchema,
      label: ResumeDiffTextSchema,
      rows: z.array(ResumeDiffRowSchema).min(1).max(500).readonly(),
    }).strict()).max(200).readonly(),
  }).strict()).min(1).max(4).readonly(),
}).strict().superRefine((diff, ctx) => {
  const sectionIds = diff.sections.map((section) => section.id);
  if (new Set(sectionIds).size !== sectionIds.length) {
    ctx.addIssue({ code: "custom", path: ["sections"], message: "resume diff sections must be unique" });
  }
  const rowIds = diff.sections.flatMap((section) => section.groups.flatMap((group) => group.rows.map((row) => row.id)));
  if (new Set(rowIds).size !== rowIds.length) {
    ctx.addIssue({ code: "custom", path: ["sections"], message: "resume diff row IDs must be unique" });
  }
});
export type ResumeDiff = z.infer<typeof ResumeDiffSchema>;

export const ArtifactKindSchema = z.enum([
  "job-analysis",
  "ats-keyword-extraction",
  "tailoring-plan",
  "evidence-ledger",
  "change-summary",
  "resume-diff",
  "tailored-tex",
  "latex-log",
  "compiled-pdf",
  "keyword-map-pdf",
  "page-image",
  "deterministic-qa",
  "visual-qa",
  "edit-request",
  "edit-report",
  "repair-report",
  "agent-transcript",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const AttemptStageSchema = z.enum(["analysis", "tailoring", "edit", "compile", "repair", "deterministic-qa", "visual-qa"]);
export type AttemptStage = z.infer<typeof AttemptStageSchema>;

export const ArtifactDtoSchema = z
  .object({
    id: z.string(),
    kind: ArtifactKindSchema,
    revision: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    mediaType: z.string(),
    href: z.string(),
    public: z.boolean(),
    createdAt: z.number().int(),
  })
  .strict();
export type ArtifactDto = z.infer<typeof ArtifactDtoSchema>;

export const ResumeIterationDtoSchema = z
  .object({
    revision: z.number().int().positive(),
    origin: RevisionOriginSchema,
    status: z.enum(["review", "approved"]),
    createdAt: z.number().int(),
    pdfSha256: z.string().regex(/^[a-f0-9]{64}$/),
    artifacts: z.array(ArtifactDtoSchema),
  })
  .strict();
export type ResumeIterationDto = z.infer<typeof ResumeIterationDtoSchema>;

export const ResumeIterationListResponseSchema = z
  .object({
    artifactState: z.enum(["retained", "pruned"]),
    iterations: z.array(ResumeIterationDtoSchema),
  })
  .strict();
export type ResumeIterationListResponse = z.infer<typeof ResumeIterationListResponseSchema>;

export const AttemptDtoSchema = z
  .object({
    id: z.string(),
    stage: AttemptStageSchema,
    revision: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    state: z.enum(["running", "succeeded", "failed", "cancelled"]),
    attemptSessionId: z.string().optional(),
    toolCalls: z.number().int().nonnegative(),
    compileCalls: z.number().int().nonnegative(),
    startedAt: z.number().int(),
    finishedAt: z.number().int().optional(),
    outcome: z.string().optional(),
  })
  .strict();
export type AttemptDto = z.infer<typeof AttemptDtoSchema>;

export const TimelineEventSchema = z
  .object({
    id: z.number().int().positive(),
    type: z.string(),
    status: RunStatusSchema,
    revision: z.number().int().nonnegative(),
    at: z.number().int(),
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const JOB_URL_MAX_CHARS = 2_048;
export const JobUrlSchema = z.string().trim().transform((value, ctx) => {
  try {
    if (value.length > JOB_URL_MAX_CHARS) throw new Error("Job URL exceeds the input limit");

    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Job URL uses an unsupported protocol");
    }
    if (url.username || url.password) throw new Error("Job URL contains credentials");

    url.hash = "";
    const canonicalUrl = url.href;
    if (canonicalUrl.length > JOB_URL_MAX_CHARS) {
      throw new Error("Canonical job URL exceeds the input limit");
    }
    return canonicalUrl;
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "Job URL must be a valid HTTP(S) URL",
    });
    return z.NEVER;
  }
});


export const RunDtoSchema = z
  .object({
    id: z.string(),
    jobUrl: JobUrlSchema.optional(),
    status: RunStatusSchema,
    applicationStatus: ApplicationStatusSchema,
    titleOverride: RunIdentityTextSchema.optional(),
    organizationOverride: RunIdentityTextSchema.optional(),
    generateKeywordMap: z.boolean(),
    skipReview: z.boolean(),
    autoSubmit: z.boolean(),
    queueSequence: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    origin: RevisionOriginSchema,
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    currentPdfSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    failureCode: z.string().optional(),
    visualAcknowledgementRequired: z.boolean(),
    attempts: z.array(AttemptDtoSchema),
    artifacts: z.array(ArtifactDtoSchema),
    timeline: z.array(TimelineEventSchema),
  })
  .strict();
export type RunDto = z.infer<typeof RunDtoSchema>;

export const HarnessSessionStateSchema = z.enum([
  "starting",
  "running",
  "awaiting_human_navigation",
  "awaiting_origin_approval",
  "awaiting_additional_info",
  "awaiting_human_review",
  "submitting",
  "submitted",
  "submission_uncertain",
  "cancelled",
  "failed",
  "closed",
]);
export type HarnessSessionState = z.infer<typeof HarnessSessionStateSchema>;

export const ApplicationSessionBridgeStateSchema = z.enum([
  "reserved",
  ...HarnessSessionStateSchema.options,
  "lost",
]);
export type ApplicationSessionBridgeState = z.infer<
  typeof ApplicationSessionBridgeStateSchema
>;

export const ApplicationSubmissionPhaseSchema = z.enum([
  "not_attempted",
  "attempting",
  "submitted",
  "uncertain",
]);
export type ApplicationSubmissionPhase = z.infer<
  typeof ApplicationSubmissionPhaseSchema
>;

export const ApplicationFieldResultSchema = z.object({
  label: z.string().refine((value) => hasCodePointLength(value, 1, 500)),
  fieldType: FieldTypeSchema,
  valuePresent: z.boolean(),
  note: z.string().refine((value) => hasCodePointLength(value, 0, 1_000)),
}).strict();
export type ApplicationFieldResult = z.infer<typeof ApplicationFieldResultSchema>;

const ApplicationAdditionalInfoQuestionBaseShape = {
  id: AdditionalInfoQuestionIdSchema,
  scope: z.enum(["global", "application"]),
  question: AdditionalInfoQuestionTextSchema,
};

export const ApplicationAdditionalInfoQuestionSchema = z.discriminatedUnion(
  "answerType",
  [
    z.object({
      ...ApplicationAdditionalInfoQuestionBaseShape,
      answerType: z.literal("text"),
    }).strict(),
    z.object({
      ...ApplicationAdditionalInfoQuestionBaseShape,
      answerType: z.literal("boolean"),
    }).strict(),
    z.object({
      ...ApplicationAdditionalInfoQuestionBaseShape,
      answerType: z.literal("single_select"),
      options: AdditionalInfoOptionsSchema,
    }).strict(),
    z.object({
      ...ApplicationAdditionalInfoQuestionBaseShape,
      answerType: z.literal("multi_select"),
      options: AdditionalInfoOptionsSchema,
    }).strict(),
  ],
);
export type ApplicationAdditionalInfoQuestion = z.infer<
  typeof ApplicationAdditionalInfoQuestionSchema
>;

export const ApplicationPendingActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("human_navigation"),
    instruction: z.string().trim()
      .refine((value) => hasCodePointLength(value, 1, 2_000)),
  }).strict(),
  z.object({
    type: z.literal("origin_approval"),
    origin: z.string().refine(isApplicationOrigin),
  }).strict(),
  z.object({
    type: z.literal("additional_info"),
    questions: z.array(ApplicationAdditionalInfoQuestionSchema).min(1).max(20),
  }).strict().superRefine((value, context) => {
    if (new Set(value.questions.map((question) => question.id)).size !== value.questions.length) {
      context.addIssue({ code: "custom", message: "question ids must be unique" });
    }
  }),
  z.object({
    type: z.literal("human_review"),
  }).strict(),
]);
export type ApplicationPendingAction = z.infer<typeof ApplicationPendingActionSchema>;

const APPLICATION_SESSION_ERROR_MESSAGES = {
  oauth_required: "Connect OpenAI Codex in Provider access",
  pipeline_unavailable: "The local pipeline model service is unavailable",
  model_timeout: "The model request timed out",
  invalid_model_output: "The model returned invalid output",
  model_failed: "The model request failed",
  browser_failed: "The browser session failed",
  application_mismatch: "The open page does not match the requested job",
  step_limit: "The application step limit was reached",
  session_timeout: "The application session expired",
} as const;

export const ApplicationSessionErrorSchema = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("oauth_required"),
    message: z.literal(APPLICATION_SESSION_ERROR_MESSAGES.oauth_required),
  }).strict(),
  z.object({
    code: z.literal("pipeline_unavailable"),
    message: z.literal(APPLICATION_SESSION_ERROR_MESSAGES.pipeline_unavailable),
  }).strict(),
  z.object({
    code: z.literal("model_timeout"),
    message: z.literal(APPLICATION_SESSION_ERROR_MESSAGES.model_timeout),
  }).strict(),
  z.object({
    code: z.literal("invalid_model_output"),
    message: z.literal(APPLICATION_SESSION_ERROR_MESSAGES.invalid_model_output),
  }).strict(),
  z.object({
    code: z.literal("model_failed"),
    message: z.literal(APPLICATION_SESSION_ERROR_MESSAGES.model_failed),
  }).strict(),
  z.object({
    code: z.literal("browser_failed"),
    message: z.literal(APPLICATION_SESSION_ERROR_MESSAGES.browser_failed),
  }).strict(),
  z.object({
    code: z.literal("application_mismatch"),
    message: z.literal(APPLICATION_SESSION_ERROR_MESSAGES.application_mismatch),
  }).strict(),
  z.object({
    code: z.literal("step_limit"),
    message: z.literal(APPLICATION_SESSION_ERROR_MESSAGES.step_limit),
  }).strict(),
  z.object({
    code: z.literal("session_timeout"),
    message: z.literal(APPLICATION_SESSION_ERROR_MESSAGES.session_timeout),
  }).strict(),
]);
export type ApplicationSessionError = z.infer<typeof ApplicationSessionErrorSchema>;

const TERMINAL_APPLICATION_BRIDGE_STATES = new Set<ApplicationSessionBridgeState>([
  "cancelled",
  "failed",
  "closed",
  "lost",
]);
const PENDING_ACTION_BY_STATE: Readonly<
  Partial<Record<ApplicationSessionBridgeState, ApplicationPendingAction["type"]>>
> = {
  awaiting_human_navigation: "human_navigation",
  awaiting_origin_approval: "origin_approval",
  awaiting_additional_info: "additional_info",
  awaiting_human_review: "human_review",
};
export const ApplicationBrowserUseDiagnosticSchema = z.object({
  step: z.number().int().min(1).max(500),
  status: z.enum(["succeeded", "failed", "timed_out"]),
  exitCode: z.number().int(),
  timedOut: z.boolean(),
  errorCategory: z.enum([
    "process_exit",
    "execution_timeout",
    "browser_runtime",
    "session_timeout",
  ]).nullable(),
  stderrExcerpt: z.union([
    z.literal("[redacted]"),
    z.literal("Browser Use execution timed out after 120 seconds."),
    z.literal("Browser runtime failed."),
    z.literal("Application session expired."),
  ]).nullable(),
  stderrTruncated: z.boolean(),
}).strict().superRefine((diagnostic, context) => {
  const expectedStatus = diagnostic.timedOut
    ? "timed_out"
    : diagnostic.exitCode === 0
      ? "succeeded"
      : "failed";
  if (diagnostic.status !== expectedStatus) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "status must match exitCode and timedOut",
    });
  }
  let expectedExcerpt: typeof diagnostic.stderrExcerpt = null;
  let validCategory = false;
  if (diagnostic.errorCategory === "execution_timeout") {
    expectedExcerpt = "Browser Use execution timed out after 120 seconds.";
    validCategory = diagnostic.timedOut;
  } else if (diagnostic.errorCategory === "session_timeout") {
    expectedExcerpt = "Application session expired.";
    validCategory = diagnostic.timedOut && diagnostic.exitCode === -1;
  } else if (diagnostic.errorCategory === "browser_runtime") {
    expectedExcerpt = "Browser runtime failed.";
    validCategory = !diagnostic.timedOut && diagnostic.exitCode === -1;
  } else if (diagnostic.errorCategory === "process_exit") {
    validCategory = !diagnostic.timedOut && diagnostic.exitCode !== 0;
  } else {
    validCategory = !diagnostic.timedOut && diagnostic.exitCode === 0;
  }
  if (!validCategory) {
    context.addIssue({
      code: "custom",
      path: ["errorCategory"],
      message: "errorCategory must match the browser result",
    });
  }
  if (
    expectedExcerpt !== null
    && diagnostic.stderrExcerpt !== expectedExcerpt
  ) {
    context.addIssue({
      code: "custom",
      path: ["stderrExcerpt"],
      message: "stderrExcerpt must match the fixed error catalog",
    });
  }
  if (
    expectedExcerpt === null
    && diagnostic.stderrExcerpt !== null
    && diagnostic.stderrExcerpt !== "[redacted]"
  ) {
    context.addIssue({
      code: "custom",
      path: ["stderrExcerpt"],
      message: "stderrExcerpt must be absent or redacted",
    });
  }
});
export type ApplicationBrowserUseDiagnostic = z.infer<
  typeof ApplicationBrowserUseDiagnosticSchema
>;


export const ApplicationSessionSnapshotDtoSchema = z.object({
  generation: z.number().int().positive(),
  bridgeState: ApplicationSessionBridgeStateSchema,
  harnessState: HarnessSessionStateSchema.nullable(),
  submissionPhase: ApplicationSubmissionPhaseSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  terminalAt: z.number().int().nonnegative().nullable(),
  expiresAt: z.number().int().nonnegative().nullable(),
  company: z.string().refine((value) => hasCodePointLength(value, 0, 500)).nullable(),
  role: z.string().refine((value) => hasCodePointLength(value, 0, 500)).nullable(),
  fieldsFilled: z.array(ApplicationFieldResultSchema).max(500),
  fieldsNeedingHuman: z.array(ApplicationFieldResultSchema).max(500),
  filesAttached: z.array(z.string().refine(isSanitizedBasename)).max(20),
  warnings: z.array(
    z.string().refine((value) => hasCodePointLength(value, 1, 1_000)),
  ).max(100),
  revisionCount: z.number().int().min(0).max(100),
  browserUseDiagnostics: z.array(ApplicationBrowserUseDiagnosticSchema).max(100).default([]),
  pendingAction: ApplicationPendingActionSchema.nullable(),
  error: ApplicationSessionErrorSchema.nullable(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.updatedAt < snapshot.createdAt) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt precedes createdAt" });
  }
  const terminal = TERMINAL_APPLICATION_BRIDGE_STATES.has(snapshot.bridgeState);
  if (terminal !== (snapshot.terminalAt !== null)) {
    context.addIssue({
      code: "custom",
      path: ["terminalAt"],
      message: "terminalAt must match terminal bridge state",
    });
  }
  if (snapshot.bridgeState === "reserved") {
    if (snapshot.harnessState !== null || snapshot.expiresAt !== null) {
      context.addIssue({
        code: "custom",
        path: ["harnessState"],
        message: "reserved sessions have no harness state or expiry",
      });
    }
  } else if (
    snapshot.bridgeState !== "lost"
    && !(snapshot.bridgeState === "closed" && snapshot.harnessState === null)
    && snapshot.harnessState !== snapshot.bridgeState
  ) {
    context.addIssue({
      code: "custom",
      path: ["harnessState"],
      message: "harness state does not match bridge state",
    });
  }
  if (
    (snapshot.bridgeState === "submitting" && snapshot.submissionPhase !== "attempting")
    || (snapshot.bridgeState === "submitted" && snapshot.submissionPhase !== "submitted")
    || (
      snapshot.bridgeState === "submission_uncertain"
      && snapshot.submissionPhase !== "uncertain"
    )
    || (
      snapshot.submissionPhase === "submitted"
      && snapshot.bridgeState !== "submitted"
      && snapshot.bridgeState !== "closed"
    )
    || (
      snapshot.submissionPhase === "uncertain"
      && snapshot.bridgeState !== "submission_uncertain"
      && snapshot.bridgeState !== "closed"
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["submissionPhase"],
      message: "submission phase does not match bridge state",
    });
  }
  const expectedPendingAction = PENDING_ACTION_BY_STATE[snapshot.bridgeState];
  if (
    (expectedPendingAction === undefined && snapshot.pendingAction !== null)
    || (
      expectedPendingAction !== undefined
      && snapshot.pendingAction?.type !== expectedPendingAction
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["pendingAction"],
      message: "pending action does not match bridge state",
    });
  }
  if ((snapshot.bridgeState === "failed") !== (snapshot.error !== null)) {
    context.addIssue({
      code: "custom",
      path: ["error"],
      message: "error must match failed bridge state",
    });
  }
});
export type ApplicationSessionSnapshotDto = z.infer<
  typeof ApplicationSessionSnapshotDtoSchema
>;

const EmptyApplicationEventDetailSchema = z.object({}).strict();
const ApplicationEventBaseShape = {
  generation: z.number().int().positive(),
  session: ApplicationSessionSnapshotDtoSchema,
};

export const ApplicationSessionEventDtoSchema = z.discriminatedUnion("event", [
  z.object({
    ...ApplicationEventBaseShape,
    event: z.literal("session_started"),
    detail: EmptyApplicationEventDetailSchema,
  }).strict(),
  z.object({
    ...ApplicationEventBaseShape,
    event: z.literal("agent_step"),
    detail: z.object({ stepNumber: z.number().int().min(1).max(500) }).strict(),
  }).strict(),
  z.object({
    ...ApplicationEventBaseShape,
    event: z.literal("snapshot"),
    detail: EmptyApplicationEventDetailSchema,
  }).strict(),
  z.object({
    ...ApplicationEventBaseShape,
    event: z.literal("human_navigation_required"),
    detail: z.object({
      instruction: z.string().trim()
        .refine((value) => hasCodePointLength(value, 1, 2_000)),
    }).strict(),
  }).strict(),
  z.object({
    ...ApplicationEventBaseShape,
    event: z.literal("origin_approval_required"),
    detail: z.object({ origin: z.string().refine(isApplicationOrigin) }).strict(),
  }).strict(),
  z.object({
    ...ApplicationEventBaseShape,
    event: z.literal("additional_info_required"),
    detail: z.object({
      questions: z.array(ApplicationAdditionalInfoQuestionSchema).min(1).max(20),
    }).strict(),
  }).strict(),
  z.object({
    ...ApplicationEventBaseShape,
    event: z.literal("additional_info_saved"),
    detail: z.object({ count: z.number().int().min(1).max(20) }).strict(),
  }).strict(),
  z.object({
    ...ApplicationEventBaseShape,
    event: z.literal("review_required"),
    detail: EmptyApplicationEventDetailSchema,
  }).strict(),
  z.object({
    ...ApplicationEventBaseShape,
    event: z.literal("revision_applied"),
    detail: z.object({
      revisionCount: z.number().int().min(1).max(100),
    }).strict(),
  }).strict(),
  z.object({
    ...ApplicationEventBaseShape,
    event: z.literal("submission_started"),
    detail: EmptyApplicationEventDetailSchema,
  }).strict(),
  z.object({
    ...ApplicationEventBaseShape,
    event: z.literal("application_submitted"),
    detail: EmptyApplicationEventDetailSchema,
  }).strict(),
  z.object({
    ...ApplicationEventBaseShape,
    event: z.literal("submission_uncertain"),
    detail: EmptyApplicationEventDetailSchema,
  }).strict(),
  z.object({
    ...ApplicationEventBaseShape,
    event: z.literal("cancelled"),
    detail: EmptyApplicationEventDetailSchema,
  }).strict(),
  z.object({
    ...ApplicationEventBaseShape,
    event: z.literal("failed"),
    detail: EmptyApplicationEventDetailSchema,
  }).strict(),
  z.object({
    ...ApplicationEventBaseShape,
    event: z.literal("closed"),
    detail: EmptyApplicationEventDetailSchema,
  }).strict(),
]).superRefine((event, context) => {
  if (event.generation !== event.session.generation) {
    context.addIssue({
      code: "custom",
      path: ["generation"],
      message: "event and session generations do not match",
    });
  }
});
export type ApplicationSessionEventDto = z.infer<
  typeof ApplicationSessionEventDtoSchema
>;

const AnsweredTextOrBooleanSchema = z.union([
  z.string().trim().refine((value) => hasCodePointLength(value, 1, 2_000)),
  z.boolean(),
]);
const ApplicationSessionAnswerSchema = z.union([
  z.object({
    id: AdditionalInfoQuestionIdSchema,
    status: z.literal("declined"),
  }).strict(),
  z.object({
    id: AdditionalInfoQuestionIdSchema,
    status: z.literal("answered"),
    value: AnsweredTextOrBooleanSchema,
  }).strict(),
  z.object({
    id: AdditionalInfoQuestionIdSchema,
    status: z.literal("answered"),
    option_id: AdditionalInfoQuestionIdSchema,
  }).strict(),
  z.object({
    id: AdditionalInfoQuestionIdSchema,
    status: z.literal("answered"),
    option_ids: z.array(AdditionalInfoQuestionIdSchema).min(1).max(20)
      .refine((values) => new Set(values).size === values.length, {
        message: "option ids must be unique",
      }),
  }).strict(),
]);

export const ApplicationSessionCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("continue") }).strict(),
  z.object({
    type: z.literal("approve_origin"),
    origin: z.string().refine(isApplicationOrigin),
  }).strict(),
  z.object({
    type: z.literal("provide_additional_info"),
    answers: z.array(ApplicationSessionAnswerSchema).min(1).max(20),
  }).strict().superRefine((command, context) => {
    if (new Set(command.answers.map((answer) => answer.id)).size !== command.answers.length) {
      context.addIssue({ code: "custom", message: "answer ids must be unique" });
    }
  }),
  z.object({
    type: z.literal("revise"),
    context: z.string().trim()
      .refine((value) => hasCodePointLength(value, 1, 20_000)),
  }).strict(),
  z.object({ type: z.literal("submit") }).strict(),
  z.object({ type: z.literal("cancel") }).strict(),
]);
export type ApplicationSessionCommand = z.infer<typeof ApplicationSessionCommandSchema>;

export const ApplicationStartBlockReasonSchema = z.enum([
  "legacy_job_url_unavailable",
  "job_url_requires_https",
  "resume_not_approved",
  "artifacts_pruned",
  "harness_unconfigured",
  "profile_unavailable",
]);
export type ApplicationStartBlockReason = z.infer<
  typeof ApplicationStartBlockReasonSchema
>;

export const ApplicationSessionNotStartedSchema = z.object({
  state: z.literal("not_started"),
  canStart: z.boolean(),
  canStartAfterApproval: z.boolean(),
  blockedReason: ApplicationStartBlockReasonSchema.optional(),
}).strict().superRefine((view, context) => {
  if (view.canStart && view.canStartAfterApproval) {
    context.addIssue({
      code: "custom",
      message: "application cannot start both before and after approval",
    });
  }
  const available = view.canStart || view.canStartAfterApproval;
  if (available === (view.blockedReason !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["blockedReason"],
      message: "blocked reason must match application availability",
    });
  }
});
export type ApplicationSessionNotStarted = z.infer<
  typeof ApplicationSessionNotStartedSchema
>;

export const ApplicationSessionViewSchema = z.union([
  ApplicationSessionSnapshotDtoSchema,
  ApplicationSessionNotStartedSchema,
]);
export type ApplicationSessionView = z.infer<typeof ApplicationSessionViewSchema>;

export const StartApplicationSessionRequestSchema = z.object({
  expectedApprovedPdfSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type StartApplicationSessionRequest = z.infer<
  typeof StartApplicationSessionRequestSchema
>;

export const JOB_DESCRIPTION_MIN_CHARS = 40;
export const JOB_DESCRIPTION_MAX_CHARS = 50_000;

export const JobDescriptionSchema = z
  .string()
  .trim()
  .min(JOB_DESCRIPTION_MIN_CHARS)
  .max(JOB_DESCRIPTION_MAX_CHARS);


export const RunListResponseSchema = z.object({ runs: z.array(RunDtoSchema) }).strict();
export const CreateRunRequestSchema = z.object({
  jobUrl: JobUrlSchema,
  generateKeywordMap: z.boolean().default(true),
  skipReview: z.boolean().default(false),
  autoSubmit: z.boolean().default(false),
}).strict();
export const EditRunRequestSchema = z
  .object({
    comments: z.string().trim().min(1).max(8_000),
    expectedPdfSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const RegenerateRunRequestSchema = z
  .object({ expectedPdfSha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const ApproveRunRequestSchema = z
  .object({
    expectedPdfSha256: z.string().regex(/^[a-f0-9]{64}$/),
    acknowledgeVisualIssues: z.boolean().default(false),
  })
  .strict();
