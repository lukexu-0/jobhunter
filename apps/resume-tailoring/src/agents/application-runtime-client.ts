import { z } from "zod";
import {
  AdditionalInfoQuestionSchema,
  AdditionalInfoQuestionIdSchema,
  FieldResultSchema,
  UserInfoKeySchema,
} from "../contracts";

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


const FilledFieldResultSchema = FieldResultSchema.extend({
  value_present: z.literal(true),
});
const UnresolvedFieldResultSchema = FieldResultSchema.extend({
  value_present: z.literal(false),
});

export const ApplicationResultBaseSchema = z.object({
  company: z.string().refine((value) => hasCodePointLength(value, 0, 500)).nullable().default(null),
  role: z.string().refine((value) => hasCodePointLength(value, 0, 500)).nullable().default(null),
  job_url: z.string().refine(isAbsoluteHttpUrl),
  final_url: z.string().refine(isAbsoluteHttpUrl),
  fields_filled: z.array(FilledFieldResultSchema).max(500).default([]),
  fields_needing_human: z.array(UnresolvedFieldResultSchema).max(500).default([]),
  files_attached: z.array(z.string().refine(isSanitizedBasename)).max(20).default([]),
  warnings: z.array(z.string().refine((value) => hasCodePointLength(value, 1, 1_000))).max(100).default([]),
  revision_count: z.number().int().min(0).max(100).default(0),
});

export const ReviewApplicationResultSchema = ApplicationResultBaseSchema.extend({
  status: z.literal("ready_for_submission"),
  submit_attempted: z.literal(false).default(false),
}).strict();
export type ReviewApplicationResult = z.infer<typeof ReviewApplicationResultSchema>;

const SubmissionConfirmationSchema = z.object({
  type: z.literal("post_submit_confirmation"),
  text: z.string().refine(
    (value) => value === value.trim() && hasCodePointLength(value, 1, 1_000),
  ),
}).strict();

export const SubmittedApplicationResultSchema = ApplicationResultBaseSchema.extend({
  status: z.literal("submitted"),
  submit_attempted: z.literal(true),
  submission_confirmation: SubmissionConfirmationSchema,
}).strict();
export type SubmittedApplicationResult = z.infer<typeof SubmittedApplicationResultSchema>;

export const SubmissionUncertainApplicationResultSchema = ApplicationResultBaseSchema.extend({
  status: z.literal("submission_uncertain"),
  submit_attempted: z.literal(true),
  submission_confirmation: z.null(),
}).strict();
export type SubmissionUncertainApplicationResult = z.infer<
  typeof SubmissionUncertainApplicationResultSchema
>;

export const CancelledApplicationResultSchema = ApplicationResultBaseSchema.extend({
  status: z.literal("cancelled"),
  submit_attempted: z.literal(false).default(false),
  submission_confirmation: z.null(),
}).strict();
export type CancelledApplicationResult = z.infer<typeof CancelledApplicationResultSchema>;

export const ApplicationRunResultSchema = z.discriminatedUnion("status", [
  SubmittedApplicationResultSchema,
  SubmissionUncertainApplicationResultSchema,
  CancelledApplicationResultSchema,
]);
export type ApplicationRunResult = z.infer<typeof ApplicationRunResultSchema>;

export const PLAYWRIGHT_CLI_COMMANDS = Object.freeze([
  "goto",
  "snapshot",
  "click",
  "dblclick",
  "type",
  "press",
  "fill",
  "drag",
  "drop",
  "hover",
  "select",
  "upload",
  "check",
  "uncheck",
  "dialog-accept",
  "dialog-dismiss",
  "resize",
  "go-back",
  "go-forward",
  "reload",
  "keydown",
  "keyup",
  "mousemove",
  "mousedown",
  "mouseup",
  "mousewheel",
  "screenshot",
  "pdf",
  "tab-list",
  "tab-new",
  "tab-close",
  "tab-select",
  "generate-locator",
  "highlight",
  "eval",
  "video-chapter",
  "video-show-actions",
  "video-hide-actions",
] as const);

export const PlaywrightCliCommandSchema = z.enum(PLAYWRIGHT_CLI_COMMANDS);
export type PlaywrightCliCommand = z.infer<typeof PlaywrightCliCommandSchema>;
export const PLAYWRIGHT_CLI_READ_ONLY_COMMANDS: readonly PlaywrightCliCommand[] =
  Object.freeze([
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

export function isPlaywrightCliReadOnlyCommand(command: PlaywrightCliCommand): boolean {
  return PLAYWRIGHT_CLI_READ_ONLY_COMMANDS.includes(command);
}

function hasOnlyPairedUtf16Surrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      index += 1;
      if (index >= value.length) return false;
      const trailingCodeUnit = value.charCodeAt(index);
      if (trailingCodeUnit < 0xDC00 || trailingCodeUnit > 0xDFFF) return false;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

const PlaywrightCliArgsSchema = z.array(
  z.string().refine((value) =>
    !value.includes("\u0000")
    && hasOnlyPairedUtf16Surrogates(value)
    && Buffer.byteLength(value, "utf8") <= 8_192
  ),
).max(64).default([]);
const PLAYWRIGHT_CLI_RESERVED_ARGS: Readonly<Record<string, true>> = Object.freeze({
  "-s": true,
  "--s": true,
  "-h": true,
  "--help": true,
  "-v": true,
  "--version": true,
  "--session": true,
  "--json": true,
  "--raw": true,
  "--config": true,
  "--profile": true,
  "--persistent": true,
  "--headed": true,
  "--browser": true,
  "--cdp": true,
  "--endpoint": true,
  "--extension": true,
});
const PLAYWRIGHT_CLI_RESERVED_ARG_PREFIXES = Object.freeze([
  "-s=",
  "--s=",
  "-h=",
  "--help=",
  "-v=",
  "--version=",
  "--session=",
  "--json=",
  "--raw=",
  "--config=",
  "--profile=",
  "--persistent=",
  "--headed=",
  "--browser=",
  "--cdp=",
  "--endpoint=",
  "--extension=",
] as const);

function validatePlaywrightCliInvocation(
  value: { readonly command: string; readonly args: readonly string[] },
  context: z.RefinementCtx,
): void {
  if (value.args.some((argument) =>
    PLAYWRIGHT_CLI_RESERVED_ARGS[argument] === true
    || (
      argument.length > 2
      && argument.startsWith("-s")
      && !argument.startsWith("--")
    )
    || PLAYWRIGHT_CLI_RESERVED_ARG_PREFIXES.some(
      (prefix) => argument.startsWith(prefix),
    )
  )) {
    context.addIssue({
      code: "custom",
      path: ["args"],
      message: "lifecycle, session, output, help, and version arguments are reserved",
    });
  }
  if (value.args.some((argument) => !hasOnlyPairedUtf16Surrogates(argument))) {
    return;
  }
  const invocationBytes = Buffer.byteLength(value.command, "utf8")
    + value.args.reduce((total, argument) => total + Buffer.byteLength(argument, "utf8"), 0);
  if (invocationBytes > 65_536) {
    context.addIssue({
      code: "custom",
      message: "combined invocation must not exceed 65536 UTF-8 bytes",
    });
  }
}

export const PlaywrightCliToolParametersSchema = z.object({
  command: PlaywrightCliCommandSchema,
  args: PlaywrightCliArgsSchema,
}).strict().superRefine(validatePlaywrightCliInvocation);

export const PlaywrightCliRuntimeActionSchema = z.object({
  type: z.literal("playwright_cli"),
  command: PlaywrightCliCommandSchema,
  args: PlaywrightCliArgsSchema,
}).strict().superRefine(validatePlaywrightCliInvocation);
export type PlaywrightCliRuntimeAction = z.infer<typeof PlaywrightCliRuntimeActionSchema>;

export const PlaywrightSnapshotElementRefSchema = z.string().regex(
  /^(?:f[1-9][0-9]{0,8})?e[1-9][0-9]{0,8}$/,
);

export const RequestSignInRuntimeActionSchema = z.object({
  type: z.literal("request_sign_in"),
  username_ref: PlaywrightSnapshotElementRefSchema,
  password_ref: PlaywrightSnapshotElementRefSchema,
  submit_ref: PlaywrightSnapshotElementRefSchema,
}).strict();
export type RequestSignInRuntimeAction = z.infer<
  typeof RequestSignInRuntimeActionSchema
>;

export const RequestHumanNavigationRuntimeActionSchema = z.object({
  type: z.literal("request_human_navigation"),
  instruction: z.string().trim().refine((value) => hasCodePointLength(value, 1, 2_000)),
}).strict();
export type RequestHumanNavigationRuntimeAction = z.infer<
  typeof RequestHumanNavigationRuntimeActionSchema
>;

function validateAdditionalInfoQuestionBatch(
  questions: readonly z.infer<typeof AdditionalInfoQuestionSchema>[],
  context: z.RefinementCtx,
): void {
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    context.addIssue({ code: "custom", message: "question ids must be unique" });
  }
  const scopedKeys = questions.map((question) => `${question.scope}\0${question.key}`);
  if (new Set(scopedKeys).size !== scopedKeys.length) {
    context.addIssue({ code: "custom", message: "question scope and key pairs must be unique" });
  }
}

export const RequestAdditionalInfoRuntimeActionSchema = z.object({
  type: z.literal("request_additional_info"),
  questions: z.array(AdditionalInfoQuestionSchema).min(1).max(20),
}).strict().superRefine((value, context) => {
  validateAdditionalInfoQuestionBatch(value.questions, context);
});
export type RequestAdditionalInfoRuntimeAction = z.infer<
  typeof RequestAdditionalInfoRuntimeActionSchema
>;

export const RequestHumanReviewRuntimeActionSchema = z.object({
  type: z.literal("request_human_review"),
  result: ReviewApplicationResultSchema,
}).strict();
export type RequestHumanReviewRuntimeAction = z.infer<
  typeof RequestHumanReviewRuntimeActionSchema
>;

export const ReportApplicationMismatchRuntimeActionSchema = z.object({
  type: z.literal("report_application_mismatch"),
}).strict();
export type ReportApplicationMismatchRuntimeAction = z.infer<
  typeof ReportApplicationMismatchRuntimeActionSchema
>;

export const RuntimeActionRequestSchema = z.discriminatedUnion("type", [
  PlaywrightCliRuntimeActionSchema,
  RequestSignInRuntimeActionSchema,
  RequestHumanNavigationRuntimeActionSchema,
  RequestAdditionalInfoRuntimeActionSchema,
  RequestHumanReviewRuntimeActionSchema,
  ReportApplicationMismatchRuntimeActionSchema,
]);
export type RuntimeActionRequest = z.infer<typeof RuntimeActionRequestSchema>;

export const BrowserTabSchema = z.object({
  url: z.string().refine((value) => hasCodePointLength(value, 0, 4_096)),
  title: z.string().refine((value) => hasCodePointLength(value, 0, 4_096)),
  tab_id: z.string().refine((value) => hasCodePointLength(value, 0, 512)),
  parent_tab_id: z.string().refine((value) => hasCodePointLength(value, 0, 512)).nullable().default(null),
}).strict();
export type BrowserTab = z.infer<typeof BrowserTabSchema>;

export const BrowserScreenshotSchema = z.object({
  media_type: z.literal("image/png").default("image/png"),
  data: z.string().refine((value) => hasCodePointLength(value, 0, 11_184_812)),
}).strict();
export type BrowserScreenshot = z.infer<typeof BrowserScreenshotSchema>;

export const BrowserObservationSchema = z.object({
  url: z.string().refine((value) => hasCodePointLength(value, 0, 4_096)),
  title: z.string().refine((value) => hasCodePointLength(value, 0, 4_096)),
  tabs: z.array(BrowserTabSchema).max(100),
  dom: z.string().refine((value) => hasCodePointLength(value, 0, 40_000)),
  page_info: z.record(z.string(), z.unknown()).nullable(),
  screenshot: BrowserScreenshotSchema.nullable(),
}).strict();
export type BrowserObservation = z.infer<typeof BrowserObservationSchema>;

export const PlaywrightCliExecutionResultSchema = z.object({
  exit_code: z.number().int(),
  timed_out: z.boolean(),
  stdout: z.string().refine((value) => hasCodePointLength(value, 0, 20_000)),
  stderr: z.string().refine((value) => hasCodePointLength(value, 0, 20_000)),
  stdout_truncated: z.boolean(),
  stderr_truncated: z.boolean(),
  observation: BrowserObservationSchema,
}).strict();
export type PlaywrightCliExecutionResult = z.infer<
  typeof PlaywrightCliExecutionResultSchema
>;

export const PlaywrightCliResultRuntimeActionResponseSchema = PlaywrightCliExecutionResultSchema.extend({
  type: z.literal("playwright_cli_result"),
}).strict();
export type PlaywrightCliResultRuntimeActionResponse = z.infer<
  typeof PlaywrightCliResultRuntimeActionResponseSchema
>;

export const SignInRuntimeActionResponseSchema = z.object({
  type: z.literal("sign_in"),
  status: z.enum(["attempted", "saved"]),
}).strict();
export type SignInRuntimeActionResponse = z.infer<
  typeof SignInRuntimeActionResponseSchema
>;

export const ContinueRuntimeActionResponseSchema = z.object({
  type: z.literal("continue"),
}).strict();
export type ContinueRuntimeActionResponse = z.infer<
  typeof ContinueRuntimeActionResponseSchema
>;

export const InterruptedRuntimeActionResponseSchema = z.object({
  type: z.literal("interrupted"),
}).strict();
export type InterruptedRuntimeActionResponse = z.infer<
  typeof InterruptedRuntimeActionResponseSchema
>;
export const ContinueWithoutAdditionalInfoRuntimeActionResponseSchema = z.object({
  type: z.literal("continue_without_additional_info"),
}).strict();
export type ContinueWithoutAdditionalInfoRuntimeActionResponse = z.infer<
  typeof ContinueWithoutAdditionalInfoRuntimeActionResponseSchema
>;


export const ReviseRuntimeActionResponseSchema = z.object({
  type: z.literal("revise"),
  context: z.string().trim().refine((value) => hasCodePointLength(value, 1, 20_000)),
  revision_count: z.number().int().min(1).max(100),
}).strict();
export type ReviseRuntimeActionResponse = z.infer<
  typeof ReviseRuntimeActionResponseSchema
>;

export const SubmitRuntimeActionResponseSchema = z.object({
  type: z.literal("submit"),
  instruction: z.literal("You're good to submit."),
  result: ReviewApplicationResultSchema,
}).strict();
export type SubmitRuntimeActionResponse = z.infer<
  typeof SubmitRuntimeActionResponseSchema
>;

export const CancelRuntimeActionResponseSchema = z.object({
  type: z.literal("cancel"),
  result: CancelledApplicationResultSchema,
}).strict();
export type CancelRuntimeActionResponse = z.infer<
  typeof CancelRuntimeActionResponseSchema
>;
const AcceptedAdditionalInfoAnswerBaseShape = {
  id: AdditionalInfoQuestionIdSchema,
  key: UserInfoKeySchema,
  scope: z.enum(["global", "application"]),
};
const AcceptedAdditionalInfoAnswerTypeSchema = z.enum([
  "text",
  "boolean",
  "single_select",
  "multi_select",
]);
const acceptedStringValue = (maximum: number) => z.string().refine(
  (value) => value === value.trim() && hasCodePointLength(value, 1, maximum),
);

export const AcceptedAdditionalInfoAnswerSchema = z.union([
  z.object({
    ...AcceptedAdditionalInfoAnswerBaseShape,
    answer_type: AcceptedAdditionalInfoAnswerTypeSchema,
    status: z.literal("declined"),
  }).strict(),
  z.object({
    ...AcceptedAdditionalInfoAnswerBaseShape,
    answer_type: z.literal("text"),
    status: z.literal("answered"),
    value: acceptedStringValue(2_000),
  }).strict(),
  z.object({
    ...AcceptedAdditionalInfoAnswerBaseShape,
    answer_type: z.literal("boolean"),
    status: z.literal("answered"),
    value: z.boolean(),
  }).strict(),
  z.object({
    ...AcceptedAdditionalInfoAnswerBaseShape,
    answer_type: z.literal("single_select"),
    status: z.literal("answered"),
    value: acceptedStringValue(200),
  }).strict(),
  z.object({
    ...AcceptedAdditionalInfoAnswerBaseShape,
    answer_type: z.literal("multi_select"),
    status: z.literal("answered"),
    value: z.array(acceptedStringValue(200)).min(1).max(20),
  }).strict(),
]);
export type AcceptedAdditionalInfoAnswer = z.infer<typeof AcceptedAdditionalInfoAnswerSchema>;

export const AdditionalInfoRuntimeActionResponseSchema = z.object({
  type: z.literal("additional_info"),
  answers: z.array(AcceptedAdditionalInfoAnswerSchema).min(1).max(20),
}).strict();
export type AdditionalInfoRuntimeActionResponse = z.infer<
  typeof AdditionalInfoRuntimeActionResponseSchema
>;


export const ApplicationMismatchRuntimeActionResponseSchema = z.object({
  type: z.literal("application_mismatch"),
}).strict();
export type ApplicationMismatchRuntimeActionResponse = z.infer<
  typeof ApplicationMismatchRuntimeActionResponseSchema
>;

export const RuntimeActionResponseSchema = z.discriminatedUnion("type", [
  PlaywrightCliResultRuntimeActionResponseSchema,
  SignInRuntimeActionResponseSchema,
  ContinueRuntimeActionResponseSchema,
  InterruptedRuntimeActionResponseSchema,
  ContinueWithoutAdditionalInfoRuntimeActionResponseSchema,
  ReviseRuntimeActionResponseSchema,
  SubmitRuntimeActionResponseSchema,
  AdditionalInfoRuntimeActionResponseSchema,
  CancelRuntimeActionResponseSchema,
  ApplicationMismatchRuntimeActionResponseSchema,
]).superRefine((value, context) => {
  if (value.type === "submit" && value.result.status !== "ready_for_submission") {
    context.addIssue({ code: "custom", message: "review result required" });
  } else if (value.type === "cancel" && value.result.status !== "cancelled") {
    context.addIssue({ code: "custom", message: "cancelled result required" });
  }
});
export type RuntimeActionResponse = z.infer<typeof RuntimeActionResponseSchema>;

export type ApplicationRuntimeErrorCode = "step_limit" | "browser_failed" | "model_timeout" | "model_failed";

function parsedHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}


function isAbsoluteHttpUrl(value: string): boolean {
  const url = parsedHttpUrl(value);
  return url !== undefined && url.hostname !== "" && !url.hostname.includes("*");
}


function isSanitizedBasename(value: string): boolean {
  return hasCodePointLength(value, 1, 255)
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !/[\u0000-\u001f]/.test(value);
}

const ERROR_MESSAGES: Readonly<Record<ApplicationRuntimeErrorCode, string>> = {
  step_limit: "The application step limit was reached",
  browser_failed: "The browser session failed",
  model_timeout: "The model request timed out",
  model_failed: "The model request failed",
};

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_TIMEOUT_MS = 86_400_000;
const RuntimeErrorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
}).strict();

export class ApplicationRuntimeError extends Error {
  readonly code: ApplicationRuntimeErrorCode;

  constructor(code: ApplicationRuntimeErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ApplicationRuntimeError";
    this.code = code;
  }
}

export interface ApplicationRuntimeClient {
  action(input: RuntimeActionRequest, signal: AbortSignal, timeoutMs: number): Promise<RuntimeActionResponse>;
}

export type ApplicationRuntimeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type ApplicationRuntimeAttemptFailureCategory =
  | "transport_error"
  | "redirect_response"
  | "response_read_error"
  | "http_error"
  | "invalid_response";

export interface ApplicationRuntimeAttemptFailureDiagnostic {
  readonly event: "application_runtime_attempt_failure";
  readonly sessionId: string;
  readonly actionId: string;
  readonly actionType: RuntimeActionRequest["type"];
  readonly attempt: number;
  readonly maxAttempts: 4;
  readonly retrying: boolean;
  readonly failureCategory: ApplicationRuntimeAttemptFailureCategory;
  readonly statusCode?: number;
}

export type ApplicationRuntimeAttemptDiagnosticSink = (
  diagnostic: ApplicationRuntimeAttemptFailureDiagnostic,
) => void | PromiseLike<void>;

export type ApplicationRuntimeRetryWait = (
  delayMs: number,
  signal: AbortSignal,
) => void | PromiseLike<void>;

export interface HttpApplicationRuntimeClientOptions {
  readonly diagnosticSink?: ApplicationRuntimeAttemptDiagnosticSink;
  readonly wait?: ApplicationRuntimeRetryWait;
}

function normalizeRuntimeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApplicationRuntimeError("model_failed");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (
    url.protocol !== "http:"
    || !loopback
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new ApplicationRuntimeError("model_failed");
  }
  return url.origin;
}

async function abortable<T>(work: PromiseLike<T> | T, signal: AbortSignal): Promise<T> {
  const promise = Promise.resolve(work);
  void promise.catch(() => {});
  signal.throwIfAborted();
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function defaultApplicationRuntimeAttemptDiagnosticSink(
  diagnostic: ApplicationRuntimeAttemptFailureDiagnostic,
): void {
  console.error(JSON.stringify(diagnostic));
}

function reportApplicationRuntimeAttemptFailure(
  sink: ApplicationRuntimeAttemptDiagnosticSink,
  diagnostic: ApplicationRuntimeAttemptFailureDiagnostic,
): void {
  try {
    const result = sink(diagnostic);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Diagnostics must never alter the fixed application runtime failure.
  }
}

function waitForApplicationRuntimeRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
    reject(signal.reason);
  };
  const timeout = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, delayMs);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}

class RetryableApplicationRuntimeFailure extends Error {
  readonly category: ApplicationRuntimeAttemptFailureCategory;
  readonly statusCode: number | undefined;

  constructor(
    category: ApplicationRuntimeAttemptFailureCategory,
    statusCode?: number,
  ) {
    super(category);
    this.name = "RetryableApplicationRuntimeFailure";
    this.category = category;
    this.statusCode = statusCode;
  }
}

async function cancelResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  try {
    await abortable(response.body?.cancel(), signal);
  } catch {
    if (signal.aborted) throw signal.reason;
    // The body may already be closed or locked; cancellation is only best-effort cleanup.
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await cancelResponseBody(response, signal);
    throw new ApplicationRuntimeError("model_failed");
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null
    && /^\d+$/.test(declaredLength.trim())
    && Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    await cancelResponseBody(response, signal);
    throw new ApplicationRuntimeError("model_failed");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ApplicationRuntimeError("model_failed");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let jsonText = "";
  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      bytesRead += item.value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        throw new ApplicationRuntimeError("model_failed");
      }
      jsonText += decoder.decode(item.value, { stream: true });
    }
    jsonText += decoder.decode();
  } finally {
    try {
      void reader.cancel().catch(() => {});
    } catch {
      // The body may already be closed; cancellation is only best-effort cleanup.
    }
  }
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new ApplicationRuntimeError("model_failed");
  }
}

const MAX_RUNTIME_ACTION_ATTEMPTS = 4 as const;
const RUNTIME_ACTION_RETRY_DELAYS_MS = [250, 500, 1_000] as const;

export class HttpApplicationRuntimeClient implements ApplicationRuntimeClient {
  readonly #endpoint: string;
  readonly #sessionId: string;
  readonly #bearerToken: string;
  readonly #fetch: ApplicationRuntimeFetch;
  readonly #diagnosticSink: ApplicationRuntimeAttemptDiagnosticSink;
  readonly #wait: ApplicationRuntimeRetryWait;

  constructor(
    runtimeUrl: string,
    sessionId: string,
    bearerToken: string,
    fetchImpl: ApplicationRuntimeFetch = fetch,
    options: HttpApplicationRuntimeClientOptions = {},
  ) {
    const runtimeOrigin = normalizeRuntimeOrigin(runtimeUrl);
    if (
      !z.string().uuid().safeParse(sessionId).success
      || typeof bearerToken !== "string"
      || bearerToken.length < 32
      || typeof fetchImpl !== "function"
      || (
        options.diagnosticSink !== undefined
        && typeof options.diagnosticSink !== "function"
      )
      || (options.wait !== undefined && typeof options.wait !== "function")
    ) {
      throw new ApplicationRuntimeError("model_failed");
    }
    this.#endpoint = `${runtimeOrigin}/v1/sessions/${sessionId}/runtime/actions`;
    this.#sessionId = sessionId;
    this.#bearerToken = bearerToken;
    this.#fetch = fetchImpl;
    this.#diagnosticSink = options.diagnosticSink
      ?? defaultApplicationRuntimeAttemptDiagnosticSink;
    this.#wait = options.wait ?? waitForApplicationRuntimeRetry;
  }

  async action(
    input: RuntimeActionRequest,
    callerSignal: AbortSignal,
    timeoutMs: number,
  ): Promise<RuntimeActionResponse> {
    const parsedInput = RuntimeActionRequestSchema.safeParse(input);
    if (
      !parsedInput.success
      || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1
      || timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new ApplicationRuntimeError("model_failed");
    }
    callerSignal.throwIfAborted();
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]);
    const actionId = crypto.randomUUID();
    const requestBody = JSON.stringify(parsedInput.data);

    for (let attempt = 1; attempt <= MAX_RUNTIME_ACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.#performAttempt(requestBody, signal, actionId);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (!(error instanceof RetryableApplicationRuntimeFailure)) throw error;

        const retrying = attempt < MAX_RUNTIME_ACTION_ATTEMPTS;
        const baseDiagnostic = {
          event: "application_runtime_attempt_failure",
          sessionId: this.#sessionId,
          actionId,
          actionType: parsedInput.data.type,
          attempt,
          maxAttempts: MAX_RUNTIME_ACTION_ATTEMPTS,
          retrying,
          failureCategory: error.category,
        } as const;
        reportApplicationRuntimeAttemptFailure(
          this.#diagnosticSink,
          error.statusCode === undefined
            ? baseDiagnostic
            : { ...baseDiagnostic, statusCode: error.statusCode },
        );
        if (!retrying) {
          throw new ApplicationRuntimeError("model_failed");
        }
        await abortable(
          this.#wait(RUNTIME_ACTION_RETRY_DELAYS_MS[attempt - 1]!, signal),
          signal,
        );
      }
    }
    throw new ApplicationRuntimeError("model_failed");
  }

  async #performAttempt(
    requestBody: string,
    signal: AbortSignal,
    actionId: string,
  ): Promise<RuntimeActionResponse> {
    let response: Response;
    try {
      response = await abortable(this.#fetch(this.#endpoint, {
        method: "POST",
        redirect: "manual",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#bearerToken}`,
          "content-type": "application/json",
          "Idempotency-Key": actionId,
        },
        body: requestBody,
        signal,
        // Bun otherwise closes human-gated requests after 300 seconds of inactivity.
        timeout: false,
      } as RequestInit & { timeout: false }), signal);
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new RetryableApplicationRuntimeFailure("transport_error");
    }
    if (!(response instanceof Response)) {
      throw new RetryableApplicationRuntimeFailure("invalid_response");
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await cancelResponseBody(response, signal);
      throw new RetryableApplicationRuntimeFailure(
        "redirect_response",
        response.status,
      );
    }
    let body: unknown;
    try {
      body = await readBoundedJson(response, signal);
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new RetryableApplicationRuntimeFailure(
        "response_read_error",
        response.status,
      );
    }
    if (!response.ok) {
      const parsedError = RuntimeErrorEnvelopeSchema.safeParse(body);
      if (parsedError.success && parsedError.data.code === "step_limit") {
        throw new ApplicationRuntimeError("step_limit");
      }
      if (parsedError.success && parsedError.data.code === "browser_failed") {
        throw new ApplicationRuntimeError("browser_failed");
      }
      if (parsedError.success && parsedError.data.code === "session_timeout") {
        throw new ApplicationRuntimeError("model_timeout");
      }
      throw new RetryableApplicationRuntimeFailure("http_error", response.status);
    }
    const parsedResponse = RuntimeActionResponseSchema.safeParse(body);
    if (!parsedResponse.success) {
      throw new RetryableApplicationRuntimeFailure(
        "invalid_response",
        response.status,
      );
    }
    return parsedResponse.data;
  }
}
