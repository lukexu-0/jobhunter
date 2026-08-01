import { z } from "zod";
import {
  AdditionalInfoQuestionSchema,
  ApplicationAdditionalInfoQuestionSchema,
  ApplicationBrowserUseDiagnosticSchema,
  ApplicationFieldResultSchema,
  ApplicationPendingActionSchema,
  ApplicationSessionCommandSchema,
  ApplicationSessionErrorSchema,
  FieldResultSchema,
  HarnessSessionStateSchema,
  type ApplicationAdditionalInfoQuestion,
  type ApplicationBrowserUseDiagnostic,
  type ApplicationFieldResult,
  type ApplicationPendingAction,
  type ApplicationSessionCommand,
  type ApplicationSessionError,
  type HarnessSessionState,
} from "../contracts";

const DEFAULT_HARNESS_ORIGIN = "http://127.0.0.1:8765";
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_SSE_FRAME_BYTES = 8 * 1024 * 1024;
const UUIDSchema = z.string().uuid();
const TimestampSchema = z.string().datetime({ offset: true });

export type ApplicationHarnessErrorCode =
  | "session_not_found"
  | "session_active_same_id"
  | "session_active_different_id"
  | "session_terminal"
  | "command_conflict"
  | "invalid_request"
  | "unauthorized"
  | "unavailable"
  | "invalid_response";

const ERROR_MESSAGES: Readonly<Record<ApplicationHarnessErrorCode, string>> = {
  session_not_found: "The application session was not found",
  session_active_same_id: "The requested application session is already active",
  session_active_different_id: "Another application session is active",
  session_terminal: "The application session has already ended",
  command_conflict: "The application session state changed",
  invalid_request: "The browser harness rejected the request",
  unauthorized: "The browser harness rejected authentication",
  unavailable: "The local application service is unavailable",
  invalid_response: "The local application service returned an invalid response",
};

export class ApplicationHarnessError extends Error {
  readonly code: ApplicationHarnessErrorCode;

  constructor(code: ApplicationHarnessErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ApplicationHarnessError";
    this.code = code;
  }
}

export type ApplicationHarnessFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ApplicationHarnessClientOptions {
  readonly origin?: string;
  readonly token: string;
  readonly fetchImpl?: ApplicationHarnessFetch;
}

export interface ApplicationHarnessCreateInput {
  readonly sessionId: string;
  readonly jobUrl: string;
  readonly autoSubmit: boolean;
  readonly personalInformationMarkdown: string;
  readonly resumePdf: Uint8Array;
}

export interface ApplicationHarnessSnapshot {
  readonly state: HarnessSessionState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly company: string | null;
  readonly role: string | null;
  readonly browserUseDiagnostics: ApplicationBrowserUseDiagnostic[];
  readonly fieldsFilled: ApplicationFieldResult[];
  readonly fieldsNeedingHuman: ApplicationFieldResult[];
  readonly filesAttached: string[];
  readonly warnings: string[];
  readonly revisionCount: number;
  readonly pendingAction: ApplicationPendingAction | null;
  readonly error: ApplicationSessionError | null;
}

const RawPendingActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("human_navigation"),
    instruction: z.string().refine((value) => codePointLength(value, 1, 2_000)),
  }).strict(),
  z.object({
    type: z.literal("origin_approval"),
    origin: z.string().refine(isCanonicalHttpOrigin),
  }).strict(),
  z.object({
    type: z.literal("additional_info"),
    questions: z.array(AdditionalInfoQuestionSchema).min(1).max(20),
  }).strict().superRefine((value, context) => {
    if (new Set(value.questions.map((question) => question.id)).size !== value.questions.length) {
      context.addIssue({ code: "custom", message: "question ids must be unique" });
    }
  }),
  z.object({ type: z.literal("human_review") }).strict(),
]);
const PENDING_TYPE_BY_STATE: Partial<
  Record<HarnessSessionState, ApplicationPendingAction["type"]>
> = {
  awaiting_human_navigation: "human_navigation",
  awaiting_origin_approval: "origin_approval",
  awaiting_additional_info: "additional_info",
  awaiting_human_review: "human_review",
};


const RawBrowserUseDiagnosticSchema = z.object({
  step: z.number().int().min(1).max(500),
  status: z.enum(["succeeded", "failed", "timed_out"]),
  exit_code: z.number().int(),
  timed_out: z.boolean(),
  error_category: z.enum([
    "process_exit",
    "execution_timeout",
    "browser_runtime",
    "session_timeout",
  ]).nullable(),
  stderr_excerpt: z.union([
    z.literal("[redacted]"),
    z.literal("Browser Use execution timed out after 120 seconds."),
    z.literal("Browser runtime failed."),
    z.literal("Application session expired."),
  ]).nullable(),
  stderr_truncated: z.boolean(),
}).strict();

const RawSnapshotSchema = z.object({
  session_id: UUIDSchema,
  state: HarnessSessionStateSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  expires_at: TimestampSchema,
  job_url: z.string().max(4_096).refine(isSanitizedHttpUrl),
  company: z.string().refine((value) => codePointLength(value, 0, 500)).nullable(),
  role: z.string().refine((value) => codePointLength(value, 0, 500)).nullable(),
  model_provider: z.literal("openai-codex"),
  model: z.literal("gpt-5.6-sol"),
  reasoning: z.literal("high"),
  fields_filled: z.array(FieldResultSchema).max(500),
  fields_needing_human: z.array(FieldResultSchema).max(500),
  files_attached: z.array(z.string().refine(isSanitizedBasename)).max(20),
  warnings: z.array(
    z.string().refine((value) => codePointLength(value, 1, 1_000)),
  ).max(100),
  revision_count: z.number().int().min(0).max(100),
  browser_use_diagnostics: z.array(RawBrowserUseDiagnosticSchema).max(100).default([]),
  pending_action: RawPendingActionSchema.nullable(),
  approved_origins: z.array(z.string().refine(isCanonicalHttpOrigin)).max(20)
    .refine((origins) => new Set(origins).size === origins.length),
  error: ApplicationSessionErrorSchema.nullable(),
}).strict().superRefine((snapshot, context) => {
  const createdAt = Date.parse(snapshot.created_at);
  const updatedAt = Date.parse(snapshot.updated_at);
  const expiresAt = Date.parse(snapshot.expires_at);
  if (updatedAt < createdAt) {
    context.addIssue({ code: "custom", path: ["updated_at"], message: "updated_at precedes created_at" });
  }
  if (expiresAt < createdAt) {
    context.addIssue({ code: "custom", path: ["expires_at"], message: "expires_at precedes created_at" });
  }
  if ((snapshot.state === "failed") !== (snapshot.error !== null)) {
    context.addIssue({ code: "custom", path: ["error"], message: "error does not match state" });
  }
  const expectedPending = PENDING_TYPE_BY_STATE[snapshot.state];
  if (
    (expectedPending === undefined && snapshot.pending_action !== null)
    || (expectedPending !== undefined && snapshot.pending_action?.type !== expectedPending)
  ) {
    context.addIssue({
      code: "custom",
      path: ["pending_action"],
      message: "pending action does not match state",
    });
  }
});

type RawSnapshot = z.infer<typeof RawSnapshotSchema>;
const RawAdditionalInfoDetailSchema = z.object({
  questions: z.array(AdditionalInfoQuestionSchema).min(1).max(20),
}).strict().superRefine((value, context) => {
  if (new Set(value.questions.map((question) => question.id)).size !== value.questions.length) {
    context.addIssue({ code: "custom", message: "question ids must be unique" });
  }
});
const EmptyEventDetailSchema = z.object({}).strict();
const RawEventBaseShape = {
  id: z.number().int().nonnegative().safe(),
  session: RawSnapshotSchema,
};
const RawEventSchema = z.discriminatedUnion("event", [
  z.object({
    ...RawEventBaseShape,
    event: z.literal("session_started"),
    detail: EmptyEventDetailSchema,
  }).strict(),
  z.object({
    ...RawEventBaseShape,
    event: z.literal("agent_step"),
    detail: z.object({
      step_number: z.number().int().min(1).max(500),
      current_url: z.string().max(4_096).refine(isSanitizedHttpUrl),
    }).strict(),
  }).strict(),
  z.object({
    ...RawEventBaseShape,
    event: z.literal("snapshot"),
    detail: EmptyEventDetailSchema,
  }).strict(),
  z.object({
    ...RawEventBaseShape,
    event: z.literal("human_navigation_required"),
    detail: z.object({
      instruction: z.string().refine((value) => codePointLength(value, 1, 2_000)),
    }).strict(),
  }).strict(),
  z.object({
    ...RawEventBaseShape,
    event: z.literal("origin_approval_required"),
    detail: z.object({ origin: z.string().refine(isCanonicalHttpOrigin) }).strict(),
  }).strict(),
  z.object({
    ...RawEventBaseShape,
    event: z.literal("additional_info_required"),
    detail: RawAdditionalInfoDetailSchema,
  }).strict(),
  z.object({
    ...RawEventBaseShape,
    event: z.literal("additional_info_saved"),
    detail: z.object({ count: z.number().int().min(1).max(20) }).strict(),
  }).strict(),
  z.object({
    ...RawEventBaseShape,
    event: z.literal("review_required"),
    detail: EmptyEventDetailSchema,
  }).strict(),
  z.object({
    ...RawEventBaseShape,
    event: z.literal("revision_applied"),
    detail: z.object({
      revision_count: z.number().int().min(1).max(100),
    }).strict(),
  }).strict(),
  z.object({
    ...RawEventBaseShape,
    event: z.literal("submission_started"),
    detail: EmptyEventDetailSchema,
  }).strict(),
  z.object({
    ...RawEventBaseShape,
    event: z.literal("application_submitted"),
    detail: EmptyEventDetailSchema,
  }).strict(),
  z.object({
    ...RawEventBaseShape,
    event: z.literal("submission_uncertain"),
    detail: EmptyEventDetailSchema,
  }).strict(),
  z.object({
    ...RawEventBaseShape,
    event: z.literal("cancelled"),
    detail: EmptyEventDetailSchema,
  }).strict(),
  z.object({
    ...RawEventBaseShape,
    event: z.literal("failed"),
    detail: EmptyEventDetailSchema,
  }).strict(),
  z.object({
    ...RawEventBaseShape,
    event: z.literal("closed"),
    detail: EmptyEventDetailSchema,
  }).strict(),
]);
type RawEvent = z.infer<typeof RawEventSchema>;

export type ApplicationHarnessEvent =
  | {
    readonly id: number;
    readonly event:
      | "session_started"
      | "snapshot"
      | "review_required"
      | "submission_started"
      | "application_submitted"
      | "submission_uncertain"
      | "cancelled"
      | "failed"
      | "closed";
    readonly session: ApplicationHarnessSnapshot;
    readonly detail: Record<string, never>;
  }
  | {
    readonly id: number;
    readonly event: "agent_step";
    readonly session: ApplicationHarnessSnapshot;
    readonly detail: { readonly stepNumber: number };
  }
  | {
    readonly id: number;
    readonly event: "human_navigation_required";
    readonly session: ApplicationHarnessSnapshot;
    readonly detail: { readonly instruction: string };
  }
  | {
    readonly id: number;
    readonly event: "origin_approval_required";
    readonly session: ApplicationHarnessSnapshot;
    readonly detail: { readonly origin: string };
  }
  | {
    readonly id: number;
    readonly event: "additional_info_required";
    readonly session: ApplicationHarnessSnapshot;
    readonly detail: { readonly questions: ApplicationAdditionalInfoQuestion[] };
  }
  | {
    readonly id: number;
    readonly event: "additional_info_saved";
    readonly session: ApplicationHarnessSnapshot;
    readonly detail: { readonly count: number };
  }
  | {
    readonly id: number;
    readonly event: "revision_applied";
    readonly session: ApplicationHarnessSnapshot;
    readonly detail: { readonly revisionCount: number };
  };

export interface ApplicationHarnessClient {
  create(input: ApplicationHarnessCreateInput, signal: AbortSignal): Promise<void>;
  get(sessionId: string, signal: AbortSignal): Promise<ApplicationHarnessSnapshot>;
  stream(
    sessionId: string,
    lastEventId: number | undefined,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ApplicationHarnessEvent>>;
  command(
    sessionId: string,
    command: ApplicationSessionCommand,
    signal: AbortSignal,
  ): Promise<void>;
  delete(sessionId: string, signal: AbortSignal): Promise<void>;
}

const ErrorEnvelopeSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().max(2_000),
}).strict();
const ActiveErrorEnvelopeSchema = z.object({
  code: z.literal("session_active"),
  session_id: UUIDSchema,
}).strict();
const CreateResponseSchema = z.object({
  session_id: UUIDSchema,
  state: z.literal("starting"),
  events_url: z.string().url().max(4_096),
  commands_url: z.string().url().max(4_096),
}).strict();

function codePointLength(value: string, minimum: number, maximum: number): boolean {
  const length = [...value].length;
  return length >= minimum && length <= maximum;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return normalized === "localhost"
    || normalized === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isCanonicalHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname)))
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === ""
      && url.origin === value;
  } catch {
    return false;
  }
}

function isSanitizedHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function isHarnessJobUrl(value: string): boolean {
  if (!codePointLength(value, 1, 4_096)) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const loopback = hostname === "localhost"
      || hostname === "::1"
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    return (url.protocol === "https:" || (url.protocol === "http:" && loopback))
      && url.username === ""
      && url.password === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function isSanitizedBasename(value: string): boolean {
  return codePointLength(value, 1, 255)
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !/[\u0000-\u001f]/.test(value);
}

function normalizeHarnessOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApplicationHarnessError("invalid_response");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
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
    throw new ApplicationHarnessError("invalid_response");
  }
  return url.origin;
}

function isExpectedCreateRoute(
  value: string,
  configuredOrigin: string,
  sessionId: string,
  operation: "events" | "commands",
): boolean {
  try {
    const candidate = new URL(value);
    const configured = new URL(configuredOrigin);
    return candidate.protocol === "http:"
      && isLoopbackHostname(candidate.hostname)
      && candidate.port === configured.port
      && candidate.username === ""
      && candidate.password === ""
      && candidate.pathname === `/v1/sessions/${sessionId}/${operation}`
      && candidate.search === ""
      && candidate.hash === "";
  } catch {
    return false;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function abortable<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const promise = Promise.resolve(work);
  void promise.catch(() => {});
  if (signal.aborted) throw abortReason(signal);
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = (): void => reject(abortReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup for an already consumed or locked body.
  }
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<unknown> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    await cancelResponse(response);
    throw new ApplicationHarnessError("invalid_response");
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null
    && /^\d+$/.test(declaredLength.trim())
    && Number(declaredLength) > maximumBytes
  ) {
    await cancelResponse(response);
    throw new ApplicationHarnessError("invalid_response");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new ApplicationHarnessError("invalid_response");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let json = "";
  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      bytesRead += item.value.byteLength;
      if (bytesRead > maximumBytes) throw new ApplicationHarnessError("invalid_response");
      json += decoder.decode(item.value, { stream: true });
    }
    json += decoder.decode();
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    if (error instanceof ApplicationHarnessError) throw error;
    throw new ApplicationHarnessError("invalid_response");
  } finally {
    try {
      void reader.cancel().catch(() => {});
    } catch {
      // Best-effort cleanup for an already closed reader.
    }
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new ApplicationHarnessError("invalid_response");
  }
}

function projectQuestion(question: z.infer<typeof AdditionalInfoQuestionSchema>): ApplicationAdditionalInfoQuestion {
  const base = {
    id: question.id,
    scope: question.scope,
    question: question.question,
    answerType: question.answer_type,
  };
  const projected = question.answer_type === "single_select" || question.answer_type === "multi_select"
    ? { ...base, options: question.options }
    : base;
  return ApplicationAdditionalInfoQuestionSchema.parse(projected);
}

function projectPendingAction(action: RawSnapshot["pending_action"]): ApplicationPendingAction | null {
  if (action === null) return null;
  const projected = action.type === "additional_info"
    ? { type: action.type, questions: action.questions.map(projectQuestion) }
    : action;
  return ApplicationPendingActionSchema.parse(projected);
}

function projectField(field: z.infer<typeof FieldResultSchema>): ApplicationFieldResult {
  return ApplicationFieldResultSchema.parse({
    label: field.label,
    fieldType: field.field_type,
    valuePresent: field.value_present,
    note: field.note,
  });
}

function projectBrowserUseDiagnostic(
  diagnostic: z.infer<typeof RawBrowserUseDiagnosticSchema>,
): ApplicationBrowserUseDiagnostic {
  return ApplicationBrowserUseDiagnosticSchema.parse({
    step: diagnostic.step,
    status: diagnostic.status,
    exitCode: diagnostic.exit_code,
    timedOut: diagnostic.timed_out,
    errorCategory: diagnostic.error_category,
    stderrExcerpt: diagnostic.stderr_excerpt,
    stderrTruncated: diagnostic.stderr_truncated,
  });
}

function projectSnapshot(snapshot: RawSnapshot): ApplicationHarnessSnapshot {
  return {
    state: snapshot.state,
    createdAt: Date.parse(snapshot.created_at),
    updatedAt: Date.parse(snapshot.updated_at),
    expiresAt: Date.parse(snapshot.expires_at),
    company: snapshot.company,
    role: snapshot.role,
    fieldsFilled: snapshot.fields_filled.map(projectField),
    fieldsNeedingHuman: snapshot.fields_needing_human.map(projectField),
    filesAttached: snapshot.files_attached,
    warnings: snapshot.warnings,
    browserUseDiagnostics: snapshot.browser_use_diagnostics.map(projectBrowserUseDiagnostic),
    revisionCount: snapshot.revision_count,
    pendingAction: projectPendingAction(snapshot.pending_action),
    error: snapshot.error,
  };
}

function projectEvent(event: RawEvent): ApplicationHarnessEvent {
  const base = {
    id: event.id,
    session: projectSnapshot(event.session),
  };
  switch (event.event) {
    case "agent_step":
      return { ...base, event: event.event, detail: { stepNumber: event.detail.step_number } };
    case "human_navigation_required":
      return { ...base, event: event.event, detail: { instruction: event.detail.instruction } };
    case "origin_approval_required":
      return { ...base, event: event.event, detail: { origin: event.detail.origin } };
    case "additional_info_required":
      return {
        ...base,
        event: event.event,
        detail: { questions: event.detail.questions.map(projectQuestion) },
      };
    case "additional_info_saved":
      return { ...base, event: event.event, detail: { count: event.detail.count } };
    case "revision_applied":
      return {
        ...base,
        event: event.event,
        detail: { revisionCount: event.detail.revision_count },
      };
    default:
      return { ...base, event: event.event, detail: {} };
  }
}

interface SseFrameAccumulator {
  id?: string;
  event?: string;
  data?: string;
  touched: boolean;
}

function consumeSseLine(
  lineBytes: Uint8Array,
  frame: SseFrameAccumulator,
  expectedSessionId: string,
): ApplicationHarnessEvent | undefined {
  const content = lineBytes.at(-1) === 0x0d
    ? lineBytes.subarray(0, lineBytes.byteLength - 1)
    : lineBytes;
  let line: string;
  try {
    line = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new ApplicationHarnessError("invalid_response");
  }
  if (line === "") {
    if (!frame.touched) return undefined;
    if (frame.id === undefined || frame.event === undefined || frame.data === undefined) {
      throw new ApplicationHarnessError("invalid_response");
    }
    if (!/^(?:0|[1-9]\d*)$/.test(frame.id)) {
      throw new ApplicationHarnessError("invalid_response");
    }
    const frameId = Number(frame.id);
    if (!Number.isSafeInteger(frameId)) throw new ApplicationHarnessError("invalid_response");
    let body: unknown;
    try {
      body = JSON.parse(frame.data);
    } catch {
      throw new ApplicationHarnessError("invalid_response");
    }
    const parsed = RawEventSchema.safeParse(body);
    if (
      !parsed.success
      || parsed.data.id !== frameId
      || parsed.data.event !== frame.event
      || parsed.data.session.session_id !== expectedSessionId
    ) {
      throw new ApplicationHarnessError("invalid_response");
    }
    return projectEvent(parsed.data);
  }
  if (line.startsWith(":")) return undefined;
  const separator = line.indexOf(":");
  const field = separator === -1 ? line : line.slice(0, separator);
  const rawValue = separator === -1 ? "" : line.slice(separator + 1);
  const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
  frame.touched = true;
  if (field === "id") {
    if (frame.id !== undefined || value.includes("\u0000")) {
      throw new ApplicationHarnessError("invalid_response");
    }
    frame.id = value;
  } else if (field === "event") {
    if (frame.event !== undefined) throw new ApplicationHarnessError("invalid_response");
    frame.event = value;
  } else if (field === "data") {
    if (frame.data !== undefined) throw new ApplicationHarnessError("invalid_response");
    frame.data = value;
  } else {
    throw new ApplicationHarnessError("invalid_response");
  }
  return undefined;
}

async function* parseSseResponse(
  response: Response,
  expectedSessionId: string,
  signal: AbortSignal,
): AsyncGenerator<ApplicationHarnessEvent> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new ApplicationHarnessError("invalid_response");
  let frame: SseFrameAccumulator = { touched: false };
  let frameBytes = 0;
  let lineBytes = 0;
  const lineBuffer = new Uint8Array(MAX_SSE_FRAME_BYTES);
  const completedLine = (): Uint8Array => lineBuffer.slice(0, lineBytes);
  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      let offset = 0;
      while (offset < item.value.byteLength) {
        const newline = item.value.indexOf(0x0a, offset);
        const end = newline === -1 ? item.value.byteLength : newline;
        const part = item.value.subarray(offset, end);
        const nextLineBytes = lineBytes + part.byteLength;
        const nextFrameBytes = frameBytes
          + part.byteLength
          + (newline === -1 ? 0 : 1);
        if (
          nextFrameBytes > MAX_SSE_FRAME_BYTES
          || nextLineBytes > MAX_SSE_FRAME_BYTES
        ) {
          throw new ApplicationHarnessError("invalid_response");
        }
        lineBuffer.set(part, lineBytes);
        lineBytes = nextLineBytes;
        frameBytes = nextFrameBytes;
        if (newline === -1) break;
        const line = completedLine();
        const event = consumeSseLine(line, frame, expectedSessionId);
        lineBytes = 0;
        offset = newline + 1;
        if (line.byteLength === 0 || (line.byteLength === 1 && line[0] === 0x0d)) {
          frame = { touched: false };
          frameBytes = 0;
        }
        if (event !== undefined) yield event;
      }
    }
    if (lineBytes > 0) {
      const event = consumeSseLine(completedLine(), frame, expectedSessionId);
      if (event !== undefined) yield event;
    }
    if (frame.touched) {
      const event = consumeSseLine(new Uint8Array(), frame, expectedSessionId);
      if (event !== undefined) yield event;
    }
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    if (error instanceof ApplicationHarnessError) throw error;
    throw new ApplicationHarnessError("invalid_response");
  } finally {
    try {
      void reader.cancel().catch(() => {});
    } catch {
      // Best-effort cleanup for an already closed stream.
    }
  }
}

async function mapErrorResponse(
  response: Response,
  expectedSessionId: string,
  signal: AbortSignal,
): Promise<never> {
  let body: unknown;
  try {
    body = await readBoundedJson(response, signal, MAX_ERROR_BYTES);
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    throw new ApplicationHarnessError("invalid_response");
  }
  const active = ActiveErrorEnvelopeSchema.safeParse(body);
  if (response.status === 409 && active.success) {
    throw new ApplicationHarnessError(
      active.data.session_id === expectedSessionId
        ? "session_active_same_id"
        : "session_active_different_id",
    );
  }
  const envelope = ErrorEnvelopeSchema.safeParse(body);
  if (!envelope.success) throw new ApplicationHarnessError("invalid_response");
  if (response.status === 404 && envelope.data.code === "session_not_found") {
    throw new ApplicationHarnessError("session_not_found");
  }
  if (response.status === 409 && envelope.data.code === "session_terminal") {
    throw new ApplicationHarnessError("session_terminal");
  }
  if (response.status === 409 && envelope.data.code === "command_conflict") {
    throw new ApplicationHarnessError("command_conflict");
  }
  if (response.status === 422 && envelope.data.code === "invalid_request") {
    throw new ApplicationHarnessError("invalid_request");
  }
  if (response.status === 401 && envelope.data.code === "unauthorized") {
    throw new ApplicationHarnessError("unauthorized");
  }
  if (response.status === 503) throw new ApplicationHarnessError("unavailable");
  throw new ApplicationHarnessError("invalid_response");
}

export class HttpApplicationHarnessClient implements ApplicationHarnessClient {
  readonly #origin: string;
  readonly #token: string;
  readonly #fetch: ApplicationHarnessFetch;

  constructor(options: ApplicationHarnessClientOptions) {
    this.#origin = normalizeHarnessOrigin(options.origin ?? DEFAULT_HARNESS_ORIGIN);
    if (typeof options.token !== "string" || options.token.length < 32) {
      throw new ApplicationHarnessError("invalid_response");
    }
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async create(input: ApplicationHarnessCreateInput, signal: AbortSignal): Promise<void> {
    const sessionId = UUIDSchema.safeParse(input.sessionId);
    const profileBytes = typeof input.personalInformationMarkdown === "string"
      ? Buffer.byteLength(input.personalInformationMarkdown)
      : Number.POSITIVE_INFINITY;
    if (
      !sessionId.success
      || !isHarnessJobUrl(input.jobUrl)
      || typeof input.autoSubmit !== "boolean"
      || profileBytes < 1
      || profileBytes > 1024 * 1024
      || !(input.resumePdf instanceof Uint8Array)
      || input.resumePdf.byteLength < 5
      || input.resumePdf.byteLength > 10 * 1024 * 1024
      || String.fromCharCode(...input.resumePdf.subarray(0, 5)) !== "%PDF-"
    ) {
      throw new ApplicationHarnessError("invalid_request");
    }
    const form = new FormData();
    form.set("session_id", sessionId.data);
    form.set("job_url", input.jobUrl);
    form.set("auto_submit", input.autoSubmit ? "true" : "false");
    form.set(
      "personal_information",
      new File([input.personalInformationMarkdown], "applicant-profile.md", {
        type: "text/markdown",
      }),
    );
    form.set(
      "resume",
      new File([Uint8Array.from(input.resumePdf).buffer], "resume.pdf", { type: "application/pdf" }),
    );
    form.set("max_steps", "100");
    const response = await this.#request(
      "/v1/sessions",
      {
        method: "POST",
        headers: { accept: "application/json" },
        body: form,
      },
      signal,
    );
    if (!response.ok) await mapErrorResponse(response, sessionId.data, signal);
    if (response.status !== 202) {
      await cancelResponse(response);
      throw new ApplicationHarnessError("invalid_response");
    }
    const body = await readBoundedJson(response, signal, MAX_ERROR_BYTES);
    const created = CreateResponseSchema.safeParse(body);
    if (
      !created.success
      || created.data.session_id !== sessionId.data
      || !isExpectedCreateRoute(
        created.data.events_url,
        this.#origin,
        sessionId.data,
        "events",
      )
      || !isExpectedCreateRoute(
        created.data.commands_url,
        this.#origin,
        sessionId.data,
        "commands",
      )
    ) {
      throw new ApplicationHarnessError("invalid_response");
    }
  }

  async get(sessionId: string, signal: AbortSignal): Promise<ApplicationHarnessSnapshot> {
    const parsedSessionId = UUIDSchema.safeParse(sessionId);
    if (!parsedSessionId.success) throw new ApplicationHarnessError("invalid_response");
    const response = await this.#request(
      `/v1/sessions/${parsedSessionId.data}`,
      { method: "GET", headers: { accept: "application/json" } },
      signal,
    );
    if (!response.ok) await mapErrorResponse(response, parsedSessionId.data, signal);
    if (response.status !== 200) {
      await cancelResponse(response);
      throw new ApplicationHarnessError("invalid_response");
    }
    let body: unknown;
    try {
      body = await readBoundedJson(response, signal, MAX_JSON_BYTES);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (error instanceof ApplicationHarnessError) throw error;
      throw new ApplicationHarnessError("invalid_response");
    }
    const snapshot = RawSnapshotSchema.safeParse(body);
    if (!snapshot.success || snapshot.data.session_id !== parsedSessionId.data) {
      throw new ApplicationHarnessError("invalid_response");
    }
    try {
      return projectSnapshot(snapshot.data);
    } catch {
      throw new ApplicationHarnessError("invalid_response");
    }
  }

  async stream(
    sessionId: string,
    lastEventId: number | undefined,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ApplicationHarnessEvent>> {
    const parsedSessionId = UUIDSchema.safeParse(sessionId);
    if (
      !parsedSessionId.success
      || (
        lastEventId !== undefined
        && (!Number.isSafeInteger(lastEventId) || lastEventId < 0)
      )
    ) {
      throw new ApplicationHarnessError("invalid_request");
    }
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);
    const response = await this.#request(
      `/v1/sessions/${parsedSessionId.data}/events`,
      { method: "GET", headers },
      signal,
    );
    if (!response.ok) await mapErrorResponse(response, parsedSessionId.data, signal);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (response.status !== 200 || mediaType !== "text/event-stream") {
      await cancelResponse(response);
      throw new ApplicationHarnessError("invalid_response");
    }
    return parseSseResponse(response, parsedSessionId.data, signal);
  }

  async command(
    sessionId: string,
    command: ApplicationSessionCommand,
    signal: AbortSignal,
  ): Promise<void> {
    const parsedSessionId = UUIDSchema.safeParse(sessionId);
    const parsedCommand = ApplicationSessionCommandSchema.safeParse(command);
    if (!parsedSessionId.success || !parsedCommand.success) {
      throw new ApplicationHarnessError("invalid_request");
    }
    const response = await this.#request(
      `/v1/sessions/${parsedSessionId.data}/commands`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(parsedCommand.data),
      },
      signal,
    );
    if (!response.ok) await mapErrorResponse(response, parsedSessionId.data, signal);
    await cancelResponse(response);
    if (response.status !== 202) throw new ApplicationHarnessError("invalid_response");
  }

  async delete(sessionId: string, signal: AbortSignal): Promise<void> {
    const parsedSessionId = UUIDSchema.safeParse(sessionId);
    if (!parsedSessionId.success) throw new ApplicationHarnessError("invalid_request");
    const response = await this.#request(
      `/v1/sessions/${parsedSessionId.data}`,
      { method: "DELETE" },
      signal,
    );
    if (!response.ok) await mapErrorResponse(response, parsedSessionId.data, signal);
    await cancelResponse(response);
    if (response.status !== 204) throw new ApplicationHarnessError("invalid_response");
  }

  async #request(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await abortable(this.#fetch(`${this.#origin}${path}`, {
        ...init,
        redirect: "manual",
        headers: {
          ...init.headers,
          authorization: `Bearer ${this.#token}`,
        },
        signal,
      }), signal);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw new ApplicationHarnessError("unavailable");
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await cancelResponse(response);
      throw new ApplicationHarnessError("invalid_response");
    }
    return response;
  }
}

