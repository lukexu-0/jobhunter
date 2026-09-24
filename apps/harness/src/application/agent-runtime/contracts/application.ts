import { z } from "zod";
import { OpportunityKindSchema, hasCodePointLength } from "../../../contracts/models.ts";
import type { ApplicationModel } from "../../../models/application-model.ts";
import type { ApplicationRunResult, ApplicationRuntimeClient, PlaywrightCliExecutionResult, ReviewApplicationResult } from "../../application-runtime-client.ts";
import type { GeminiHistoryCompactor } from "../application-compaction.ts";
import type { ApplicationAgentSteeringInbox } from "../application-agent-steering.ts";
import type { AgentRuntimeDependencies } from "../runner.ts";

export const FieldResultSchema = z.object({
  label: z.string().refine((value) => hasCodePointLength(value, 1, 500)),
  field_type: z.enum(["text", "textarea", "select", "radio", "checkbox", "number", "file", "unknown"]),
  value_present: z.boolean(),
  note: z.string().refine((value) => hasCodePointLength(value, 0, 1_000)).default(""),
}).strict();
const AdditionalInfoQuestionIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const UserInfoKeySchema = z.string().refine((value) => hasCodePointLength(value, 1, 100)).regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/);
const AdditionalInfoQuestionTextSchema = z.string().trim().refine((value) => hasCodePointLength(value, 1, 500));
const AdditionalInfoOptionSchema = z.object({ id: AdditionalInfoQuestionIdSchema, label: z.string().trim().refine((value) => hasCodePointLength(value, 1, 200)) }).strict();
const AdditionalInfoQuestionBaseShape = { id: AdditionalInfoQuestionIdSchema, key: UserInfoKeySchema, scope: z.enum(["global", "application"]), question: AdditionalInfoQuestionTextSchema };
const AdditionalInfoOptionsSchema = z.array(AdditionalInfoOptionSchema).min(2).max(100).superRefine((options, context) => {
  if (new Set(options.map((option) => option.id)).size !== options.length) context.addIssue({ code: "custom", message: "option ids must be unique" });
});
export const AdditionalInfoQuestionSchema = z.discriminatedUnion("answer_type", [
  z.object({ ...AdditionalInfoQuestionBaseShape, answer_type: z.literal("text") }).strict(),
  z.object({ ...AdditionalInfoQuestionBaseShape, answer_type: z.literal("boolean") }).strict(),
  z.object({ ...AdditionalInfoQuestionBaseShape, answer_type: z.literal("single_select"), options: AdditionalInfoOptionsSchema }).strict(),
  z.object({ ...AdditionalInfoQuestionBaseShape, answer_type: z.literal("multi_select"), options: AdditionalInfoOptionsSchema }).strict(),
]);

export const MAX_APPLICATION_TASK_BYTES = 5_242_880;

function isLoopbackHttpOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" || parsed.username || parsed.password) return false;
    if (value !== parsed.origin) return false;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "[::1]") return true;
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (!match) return false;
    const octets = match.slice(1).map(Number);
    return octets.every((octet) => octet <= 255) && octets[0] === 127;
  } catch {
    return false;
  }
}

function utf8Bounded(maxBytes: number): z.ZodString {
  return z.string().refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes, {
    message: `must not exceed ${maxBytes} UTF-8 bytes`,
  });
}


export const ApplicationAgentRunInputSchema = z.object({
  opportunityKind: OpportunityKindSchema,
  sessionId: z.string().uuid(),
  runtimeUrl: z.string().refine(isLoopbackHttpOrigin, "must be a loopback HTTP origin"),
  task: utf8Bounded(MAX_APPLICATION_TASK_BYTES),
  autoSubmit: z.boolean(),
  deadlineMs: z.number().int().min(1_000).max(86_400_000).nullable(),
}).strict();

export type ApplicationAgentRunInput = z.infer<typeof ApplicationAgentRunInputSchema>;

export type ApplicationAgentFailureCode =
  | "INVALID_REQUEST"
  | "OAUTH_REQUIRED"
  | "USAGE_EXHAUSTED"
  | "INVALID_MODEL_OUTPUT"
  | "MODEL_PROVIDER_FAILED"
  | "APPLICATION_MISMATCH"
  | "BROWSER_FAILED";

const APPLICATION_AGENT_FAILURE_MESSAGES: Readonly<Record<ApplicationAgentFailureCode, string>> = {
  INVALID_REQUEST: "Request is invalid",
  OAUTH_REQUIRED: "Connect the configured application model provider in Credentials",
  USAGE_EXHAUSTED: "The model provider's usage quota is exhausted",
  INVALID_MODEL_OUTPUT: "The model returned invalid output",
  MODEL_PROVIDER_FAILED: "The model request failed",
  APPLICATION_MISMATCH: "The open page does not match the requested job",
  BROWSER_FAILED: "The browser session failed",
};

export class ApplicationAgentFailure extends Error {
  constructor(readonly code: ApplicationAgentFailureCode, options?: ErrorOptions) {
    super(APPLICATION_AGENT_FAILURE_MESSAGES[code], options);
    this.name = "ApplicationAgentFailure";
  }
}

export class ApplicationAgentCancelled extends Error {
  constructor(readonly result: ApplicationRunResult) {
    super("The application run was cancelled");
    this.name = "ApplicationAgentCancelled";
  }
}

export class ApplicationToolRejection extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ApplicationToolRejection";
  }
}

export interface ApplicationSubmissionGuard {
  readonly markReviewReady: () => Promise<void>;
  readonly claim: () => Promise<void>;
  readonly finalize: (outcome: "submitted" | "uncertain") => Promise<void>;
}

export const MAX_RECOVERABLE_AGENT_CONTINUATIONS = 3;
export interface BrowserApplicationContext {
  readonly runtimeClient: ApplicationRuntimeClient;
  readonly submissionGuard: ApplicationSubmissionGuard;
  readonly signal: AbortSignal;
  readonly steeringInbox?: ApplicationAgentSteeringInbox;
  latestScreenshotDataUrl?: string;
  submissionApproved: boolean;
  submissionActionStarted: boolean;
  submissionClaimed: boolean;
  submissionFinalized: boolean;
  playwrightCliCompleted: boolean;
  postNavigationInspectionRequired: boolean;
  browserSnapshotRequired: boolean;
  modalRecoveryPending: boolean;
  recoverableFailureObserved: boolean;
  lastReviewResult?: ReviewApplicationResult;
  latestSubmissionExecution?: PlaywrightCliExecutionResult;
  submissionOutcomePending: boolean;
}

export interface ApplicationAgentDependencies extends AgentRuntimeDependencies {
  readonly applicationModel?: ApplicationModel;
  readonly historyCompactorFactory?: (sessionId: string) => GeminiHistoryCompactor;
  readonly runtimeClient: ApplicationRuntimeClient;
  readonly submissionGuard: ApplicationSubmissionGuard;
  readonly steeringInbox?: ApplicationAgentSteeringInbox;
}
