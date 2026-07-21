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


export const ApplicationRunResultSchema = z.object({
  status: z.enum(["ready_for_human_submit", "cancelled"]),
  company: z.string().refine((value) => hasCodePointLength(value, 0, 500)).nullable().default(null),
  role: z.string().refine((value) => hasCodePointLength(value, 0, 500)).nullable().default(null),
  job_url: z.string().refine(isAbsoluteHttpUrl),
  final_url: z.string().refine(isAbsoluteHttpUrl),
  fields_filled: z.array(FieldResultSchema).max(500).default([]),
  fields_needing_human: z.array(FieldResultSchema).max(500).default([]),
  files_attached: z.array(z.string().refine(isSanitizedBasename)).max(20).default([]),
  warnings: z.array(z.string().refine((value) => hasCodePointLength(value, 1, 1_000))).max(100).default([]),
  revision_count: z.number().int().min(0).max(100).default(0),
  submit_attempted: z.literal(false).default(false),
}).strict();
export type ApplicationRunResult = z.infer<typeof ApplicationRunResultSchema>;

export const BrowserUseRuntimeActionSchema = z.object({
  type: z.literal("browser_use"),
  code: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 65_536),
}).strict();
export type BrowserUseRuntimeAction = z.infer<typeof BrowserUseRuntimeActionSchema>;

export const RequestHumanNavigationRuntimeActionSchema = z.object({
  type: z.literal("request_human_navigation"),
  instruction: z.string().trim().refine((value) => hasCodePointLength(value, 1, 2_000)),
}).strict();
export type RequestHumanNavigationRuntimeAction = z.infer<
  typeof RequestHumanNavigationRuntimeActionSchema
>;

export const RequestOriginApprovalRuntimeActionSchema = z.object({
  type: z.literal("request_origin_approval"),
  origin: z.string().refine(isApprovedOrigin),
}).strict();
export type RequestOriginApprovalRuntimeAction = z.infer<
  typeof RequestOriginApprovalRuntimeActionSchema
>;


export const RequestAdditionalInfoRuntimeActionSchema = z.object({
  type: z.literal("request_additional_info"),
  questions: z.array(AdditionalInfoQuestionSchema).min(1).max(20),
}).strict().superRefine((value, context) => {
  if (new Set(value.questions.map((question) => question.id)).size !== value.questions.length) {
    context.addIssue({ code: "custom", message: "question ids must be unique" });
  }
  const scopedKeys = value.questions.map((question) => `${question.scope}\0${question.key}`);
  if (new Set(scopedKeys).size !== scopedKeys.length) {
    context.addIssue({ code: "custom", message: "question scope and key pairs must be unique" });
  }
});
export type RequestAdditionalInfoRuntimeAction = z.infer<
  typeof RequestAdditionalInfoRuntimeActionSchema
>;

export const RequestHumanReviewRuntimeActionSchema = z.object({
  type: z.literal("request_human_review"),
  result: ApplicationRunResultSchema,
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
  BrowserUseRuntimeActionSchema,
  RequestHumanNavigationRuntimeActionSchema,
  RequestOriginApprovalRuntimeActionSchema,
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

export const BrowserUseExecutionResultSchema = z.object({
  exit_code: z.number().int(),
  timed_out: z.boolean(),
  stdout: z.string().refine((value) => hasCodePointLength(value, 0, 20_000)),
  stderr: z.string().refine((value) => hasCodePointLength(value, 0, 20_000)),
  stdout_truncated: z.boolean(),
  stderr_truncated: z.boolean(),
  observation: BrowserObservationSchema,
}).strict();
export type BrowserUseExecutionResult = z.infer<
  typeof BrowserUseExecutionResultSchema
>;

export const BrowserUseResultRuntimeActionResponseSchema = BrowserUseExecutionResultSchema.extend({
  type: z.literal("browser_use_result"),
}).strict();
export type BrowserUseResultRuntimeActionResponse = z.infer<
  typeof BrowserUseResultRuntimeActionResponseSchema
>;

export const ContinueRuntimeActionResponseSchema = z.object({
  type: z.literal("continue"),
}).strict();
export type ContinueRuntimeActionResponse = z.infer<
  typeof ContinueRuntimeActionResponseSchema
>;

export const ApproveRuntimeActionResponseSchema = z.object({
  type: z.literal("approve"),
  origin: z.string().refine(isApprovedOrigin),
  approved_origins: z.array(z.string().refine(isApprovedOrigin)).min(1).max(20),
}).strict();
export type ApproveRuntimeActionResponse = z.infer<
  typeof ApproveRuntimeActionResponseSchema
>;

export const ReviseRuntimeActionResponseSchema = z.object({
  type: z.literal("revise"),
  context: z.string().trim().refine((value) => hasCodePointLength(value, 1, 20_000)),
  revision_count: z.number().int().min(1).max(100),
}).strict();
export type ReviseRuntimeActionResponse = z.infer<
  typeof ReviseRuntimeActionResponseSchema
>;

export const ReadyRuntimeActionResponseSchema = z.object({
  type: z.literal("ready"),
  result: ApplicationRunResultSchema,
}).strict();
export type ReadyRuntimeActionResponse = z.infer<
  typeof ReadyRuntimeActionResponseSchema
>;

export const CancelRuntimeActionResponseSchema = z.object({
  type: z.literal("cancel"),
  result: ApplicationRunResultSchema,
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
  BrowserUseResultRuntimeActionResponseSchema,
  ContinueRuntimeActionResponseSchema,
  ApproveRuntimeActionResponseSchema,
  ReviseRuntimeActionResponseSchema,
  ReadyRuntimeActionResponseSchema,
  AdditionalInfoRuntimeActionResponseSchema,
  CancelRuntimeActionResponseSchema,
  ApplicationMismatchRuntimeActionResponseSchema,
]).superRefine((value, context) => {
  if (value.type === "approve") {
    if (new Set(value.approved_origins).size !== value.approved_origins.length) {
      context.addIssue({ code: "custom", message: "approved origins must be unique" });
    }
    if (!value.approved_origins.includes(value.origin)) {
      context.addIssue({ code: "custom", message: "origin must be approved" });
    }
  } else if (value.type === "ready" && value.result.status !== "ready_for_human_submit") {
    context.addIssue({ code: "custom", message: "ready result required" });
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

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function isAbsoluteHttpUrl(value: string): boolean {
  const url = parsedHttpUrl(value);
  return url !== undefined && url.hostname !== "" && !url.hostname.includes("*");
}

function isApprovedOrigin(value: string): boolean {
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

async function abortable<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
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

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be closed or locked; cancellation is only best-effort cleanup.
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await cancelResponseBody(response);
    throw new ApplicationRuntimeError("model_failed");
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null
    && /^\d+$/.test(declaredLength.trim())
    && Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    await cancelResponseBody(response);
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

export class HttpApplicationRuntimeClient implements ApplicationRuntimeClient {
  readonly #endpoint: string;
  readonly #bearerToken: string;
  readonly #fetch: ApplicationRuntimeFetch;

  constructor(
    runtimeUrl: string,
    sessionId: string,
    bearerToken: string,
    fetchImpl: ApplicationRuntimeFetch = fetch,
  ) {
    const runtimeOrigin = normalizeRuntimeOrigin(runtimeUrl);
    if (
      !z.string().uuid().safeParse(sessionId).success
      || typeof bearerToken !== "string"
      || bearerToken.length < 32
    ) {
      throw new ApplicationRuntimeError("model_failed");
    }
    this.#endpoint = `${runtimeOrigin}/v1/sessions/${sessionId}/runtime/actions`;
    this.#bearerToken = bearerToken;
    this.#fetch = fetchImpl;
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
    let response: Response;
    try {
      response = await abortable(this.#fetch(this.#endpoint, {
        method: "POST",
        redirect: "manual",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#bearerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(parsedInput.data),
        signal,
      }), signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new ApplicationRuntimeError("model_failed");
    }
    if (response.redirected) {
      await cancelResponseBody(response);
      throw new ApplicationRuntimeError("model_failed");
    }
    let body: unknown;
    try {
      body = await readBoundedJson(response, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ApplicationRuntimeError) throw error;
      throw new ApplicationRuntimeError("model_failed");
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
      throw new ApplicationRuntimeError("model_failed");
    }
    const parsedResponse = RuntimeActionResponseSchema.safeParse(body);
    if (!parsedResponse.success) throw new ApplicationRuntimeError("model_failed");
    return parsedResponse.data;
  }
}
