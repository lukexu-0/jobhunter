import { z } from "zod";

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

export const OAuthProviderSchema = z.enum(["openai-codex", "google-antigravity"]);
export type OAuthProvider = z.infer<typeof OAuthProviderSchema>;

export const AuthIdentitySchema = z
  .object({
    email: z.string().min(1).optional(),
    accountId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
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
    providers: z.array(AuthProviderStatusSchema).length(2),
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


export const RunDtoSchema = z
  .object({
    id: z.string(),
    status: RunStatusSchema,
    applicationStatus: ApplicationStatusSchema,
    titleOverride: RunIdentityTextSchema.optional(),
    organizationOverride: RunIdentityTextSchema.optional(),
    generateKeywordMap: z.boolean(),
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

export const JOB_URL_MAX_CHARS = 2_048;
export const JOB_DESCRIPTION_MIN_CHARS = 40;
export const JOB_DESCRIPTION_MAX_CHARS = 50_000;

export const JobDescriptionSchema = z
  .string()
  .trim()
  .min(JOB_DESCRIPTION_MIN_CHARS)
  .max(JOB_DESCRIPTION_MAX_CHARS);

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

export const RunListResponseSchema = z.object({ runs: z.array(RunDtoSchema) }).strict();
export const CreateRunRequestSchema = z.object({
  jobUrl: JobUrlSchema,
  generateKeywordMap: z.boolean().default(true),
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
