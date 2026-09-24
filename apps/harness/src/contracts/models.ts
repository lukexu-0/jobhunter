import { z } from "zod";

function parseAbsoluteHttpUrl(value: string, fieldName: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${fieldName} is not a valid URL`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new Error(`${fieldName} must be an absolute HTTP(S) URL`);
  }
  if (url.hostname.includes("*")) {
    throw new Error(`${fieldName} must not contain a wildcard`);
  }
  return url;
}

function isUnicodeScalarText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function codePointLength(value: string): number { return [...value].length; }

export function hasCodePointLength(value: string, minimum: number, maximum: number): boolean {
  const length = codePointLength(value);
  return length >= minimum && length <= maximum;
}

function isPythonWhitespaceCodeUnit(codeUnit: number): boolean {
  return (
    (codeUnit >= 0x0009 && codeUnit <= 0x000d)
    || (codeUnit >= 0x001c && codeUnit <= 0x0020)
    || codeUnit === 0x0085
    || codeUnit === 0x00a0
    || codeUnit === 0x1680
    || (codeUnit >= 0x2000 && codeUnit <= 0x200a)
    || codeUnit === 0x2028
    || codeUnit === 0x2029
    || codeUnit === 0x202f
    || codeUnit === 0x205f
    || codeUnit === 0x3000
  );
}

export function stripPythonWhitespace(value: string): string { let start = 0;
while (start < value.length && isPythonWhitespaceCodeUnit(value.charCodeAt(start))) start += 1;
let end = value.length;
while (end > start && isPythonWhitespaceCodeUnit(value.charCodeAt(end - 1))) end -= 1;
return start === 0 && end === value.length ? value : value.slice(start, end); }

function pythonSplitLineCount(value: string): number {
  if (value.length === 0) return 0;
  const separators = value.match(/\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/g)?.length ?? 0;
  const endsWithSeparator = /(?:\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029])$/.test(value);
  return separators + (endsWithSeparator ? 0 : 1);
}

function codePointBoundedString(minimum: number, maximum: number, trim = false) {
  return z.string().transform((value, context) => {
    const normalized = trim ? stripPythonWhitespace(value) : value;
    const length = codePointLength(normalized);
    if (length < minimum || length > maximum || !isUnicodeScalarText(normalized)) {
      context.addIssue({ code: "custom", message: "text is outside its bounds" });
      return z.NEVER;
    }
    return normalized;
  });
}

export function sanitizePublicUrl(value: string): string {
  const url = parseAbsoluteHttpUrl(value, "URL");
  const rawPath = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(value)?.[1] ?? "";
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return `${url.protocol}//${url.host}${rawPath === "" ? "" : url.pathname}`;
}

export function normalizeSteerMessage(value: unknown): string {
  if (typeof value !== "string") throw new Error("message is invalid");
  const trimmed = stripPythonWhitespace(value);
  if (
    codePointLength(trimmed) < 1 ||
    codePointLength(trimmed) > 8_000 ||
    trimmed.includes("\0") ||
    !isUnicodeScalarText(trimmed)
  ) {
    throw new Error("message is invalid");
  }
  return trimmed;
}

const emptyStrictObject = <T extends string>(type: T) => z.strictObject({ type: z.literal(type) });

const UsernameSchema = z.string().transform((value, context) => {
  const trimmed = stripPythonWhitespace(value);
  if (
    codePointLength(trimmed) < 1 ||
    codePointLength(trimmed) > 320 ||
    trimmed.includes("\0") ||
    !isUnicodeScalarText(trimmed)
  ) {
    context.addIssue({ code: "custom", message: "username is invalid" });
    return z.NEVER;
  }
  return trimmed;
});

const PasswordSchema = z.string().superRefine((value, context) => {
  if (
    codePointLength(value) < 1 ||
    codePointLength(value) > 4_096 ||
    value.includes("\0") ||
    !isUnicodeScalarText(value)
  ) {
    context.addIssue({ code: "custom", message: "password is invalid" });
  }
});

export const SignInCommandSchema = z.strictObject({
  type: z.literal("sign_in"),
  username: UsernameSchema,
  password: PasswordSchema,
});
export type SignInCommand = z.infer<typeof SignInCommandSchema>;

export const SaveCredentialsCommandSchema = z.strictObject({
  type: z.literal("save_credentials"),
  username: UsernameSchema,
  password: PasswordSchema,
});
export type SaveCredentialsCommand = z.infer<typeof SaveCredentialsCommandSchema>;

export const ContinueCommandSchema = emptyStrictObject("continue");
export const ContinueWithoutAdditionalInfoCommandSchema = emptyStrictObject(
  "continue_without_additional_info",
);
export const ReviseCommandSchema = z.strictObject({
  type: z.literal("revise"),
  context: codePointBoundedString(1, 20_000, true),
});
export const SteerCommandSchema = z.strictObject({
  type: z.literal("steer"),
  message: z.unknown().transform((value, context) => {
    try {
      return normalizeSteerMessage(value);
    } catch {
      context.addIssue({ code: "custom", message: "message is invalid" });
      return z.NEVER;
    }
  }),
});
export const SubmitCommandSchema = emptyStrictObject("submit");
export const CancelCommandSchema = emptyStrictObject("cancel");

export const AdditionalInfoQuestionIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const AdditionalInfoTextValueSchema = codePointBoundedString(1, 2_000, true);
export const AdditionalInfoDeclinedCommandAnswerSchema = z.strictObject({
  id: AdditionalInfoQuestionIdSchema,
  status: z.literal("declined"),
});
export const AdditionalInfoTextCommandAnswerSchema = z.strictObject({
  id: AdditionalInfoQuestionIdSchema,
  status: z.literal("answered"),
  raw_value: AdditionalInfoTextValueSchema,
  value: AdditionalInfoTextValueSchema,
});
export const AdditionalInfoBooleanCommandAnswerSchema = z.strictObject({
  id: AdditionalInfoQuestionIdSchema,
  status: z.literal("answered"),
  value: z.boolean(),
});
export const AdditionalInfoSingleSelectCommandAnswerSchema = z.strictObject({
  id: AdditionalInfoQuestionIdSchema,
  status: z.literal("answered"),
  option_id: AdditionalInfoQuestionIdSchema,
});
export const AdditionalInfoMultiSelectCommandAnswerSchema = z.strictObject({
  id: AdditionalInfoQuestionIdSchema,
  status: z.literal("answered"),
  option_ids: z.array(AdditionalInfoQuestionIdSchema).min(1).max(100).refine(
    (values) => new Set(values).size === values.length,
    "option_ids must be unique",
  ),
});
export const AdditionalInfoCommandAnswerSchema = z.union([
  AdditionalInfoDeclinedCommandAnswerSchema,
  AdditionalInfoTextCommandAnswerSchema,
  AdditionalInfoBooleanCommandAnswerSchema,
  AdditionalInfoSingleSelectCommandAnswerSchema,
  AdditionalInfoMultiSelectCommandAnswerSchema,
]);
export const ProvideAdditionalInfoCommandSchema = z.strictObject({
  type: z.literal("provide_additional_info"),
  answers: z.array(AdditionalInfoCommandAnswerSchema).min(1).max(20).refine(
    (answers) => new Set(answers.map((answer) => answer.id)).size === answers.length,
    "answer ids must be unique",
  ),
});

export const SessionCommandSchema = z.discriminatedUnion("type", [
  ContinueCommandSchema,
  ContinueWithoutAdditionalInfoCommandSchema,
  ReviseCommandSchema,
  SteerCommandSchema,
  SubmitCommandSchema,
  CancelCommandSchema,
  ProvideAdditionalInfoCommandSchema,
  SignInCommandSchema,
  SaveCredentialsCommandSchema,
]);
export type SessionCommand = z.infer<typeof SessionCommandSchema>;

// Session and event contracts follow the command boundary above.

export const MODEL_PROVIDER = "openai-codex" as const;
export const MODEL_NAME = "gpt-5.6-sol" as const;
export const MODEL_REASONING = "medium" as const;
export const SOURCE_CAPTURE_MAX_BYTES = 512 * 1024;
export const SOURCE_CAPTURE_MAX_LINES = 20_000;
export const APPLICATION_PROFILE_MAX_BYTES = 5_242_880;
export const APPLICATION_RESUME_MAX_BYTES = 52_428_800;
export const APPLICATION_TRANSCRIPT_MAX_BYTES = 52_428_800;
export const APPLICATION_RESUME_SOURCE_MAX_BYTES = 1_310_720;
export const APPLICATION_CONTEXT_MAX_COUNT = 50;
export const APPLICATION_CONTEXT_MAX_BYTES = 5_242_880;
export const APPLICATION_CONTEXT_TOTAL_MAX_BYTES = 26_214_400;
export const APPLICATION_ANECDOTE_MAX_COUNT = 100;
export const APPLICATION_ANECDOTE_MAX_BYTES = 1_310_720;
export const APPLICATION_ANECDOTE_TOTAL_MAX_BYTES = 10_485_760;
export const BROWSER_URL_MAX_CHARACTERS = 4_096;
export const BROWSER_TITLE_MAX_CHARACTERS = 4_096;
export const BROWSER_DOM_MAX_CHARACTERS = 40_000;
export const PLAYWRIGHT_OUTPUT_MAX_CHARACTERS = 20_000;
export const MAX_ADDITIONAL_INFO_OPTIONS = 100;
export const MAX_ADDITIONAL_INFO_SELECTED_OPTIONS = 100;
export const READ_EMAIL_OUTPUT_MAX_BYTES = 50 * 1024;
export const APPLICATION_RUNTIME_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

export const OpportunityKindSchema = z.enum([
  "job",
  "hackathon",
  "competition",
  "event",
  "networking_event",
]);
export type OpportunityKind = z.infer<typeof OpportunityKindSchema>;

export const SessionStateSchema = z.enum([
  "starting",
  "running",
  "awaiting_human_navigation",
  "awaiting_additional_info",
  "awaiting_human_review",
  "submitting",
  "submitted",
  "submission_uncertain",
  "cancelled",
  "failed",
  "closed",
]);
export type SessionState = z.infer<typeof SessionStateSchema>;
export const TerminalSessionStateSchema = z.enum(["cancelled", "failed", "closed"]);

export const StrictTextSchema = z.string();
export const CredentialValueSchema = codePointBoundedString(1, 4_096);
export const SourceCaptureUrlSchema = codePointBoundedString(1, 4_096);
export const ShortLabelSchema = codePointBoundedString(1, 500);
export const OptionalShortTextSchema = codePointBoundedString(0, 1_000);
export const WarningTextSchema = codePointBoundedString(1, 1_000);
export const ElementRefSchema = z.string().regex(/^(?:f[1-9][0-9]{0,8})?e[1-9][0-9]{0,8}$/);

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

export const SESSION_ERROR_MESSAGES = {
  oauth_required: "Connect the configured application model provider in Credentials",
  pipeline_unavailable: "The local pipeline model service is unavailable",
  model_timeout: "The model request timed out",
  invalid_model_output: "The model returned invalid output",
  usage_exhausted: "The model provider's usage quota is exhausted",
  model_failed: "The model request failed",
  browser_failed: "The browser session failed",
  application_mismatch: "The open page does not match the requested job",
  session_timeout: "The application session expired",
} as const;
export const ErrorCodeSchema = z.enum(Object.keys(SESSION_ERROR_MESSAGES) as [
  keyof typeof SESSION_ERROR_MESSAGES,
  ...(keyof typeof SESSION_ERROR_MESSAGES)[],
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApplicationModelProviderSchema = z.enum(["openai-codex", "google-antigravity"]);
export const ApplicationModelNameSchema = z.enum(["gpt-5.6-sol", "gemini-3.8-flash"]);
export const ApplicationModelReasoningSchema = z.enum(["medium", "high"]);

export const MirroredOAuthCredentialSchema = z.strictObject({
  type: z.literal("oauth"),
  refresh: z.string().min(1).max(262_144),
  access: z.string().min(1).max(262_144),
  expires: z.number().finite(),
  enterpriseUrl: z.string().min(1).max(4_096).optional(),
  projectId: z.string().min(1).max(4_096).optional(),
  email: z.string().min(1).max(4_096).optional(),
  accountId: z.string().min(1).max(4_096).optional(),
  apiEndpoint: z.string().min(1).max(4_096).optional(),
});

export const ApplicationModelMetadataSchema = z
  .strictObject({
    model_provider: ApplicationModelProviderSchema.default(MODEL_PROVIDER),
    model: ApplicationModelNameSchema.default(MODEL_NAME),
    reasoning: ApplicationModelReasoningSchema.default(MODEL_REASONING),
  })
  .superRefine((value, context) => {
    const valid =
      (value.model_provider === "openai-codex" &&
        value.model === "gpt-5.6-sol" &&
        value.reasoning === "medium") ||
      (value.model_provider === "google-antigravity" &&
        value.model === "gemini-3.8-flash" &&
        value.reasoning === "high");
    if (!valid) context.addIssue({ code: "custom", message: "application model configuration is inconsistent" });
  });

export const UserInfoKeySchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/);
export const AdditionalInfoQuestionTextSchema = codePointBoundedString(1, 500, true);
export const AdditionalInfoOptionLabelSchema = codePointBoundedString(1, 200, true);
export const AdditionalInfoOptionSchema = z.strictObject({
  id: AdditionalInfoQuestionIdSchema,
  label: AdditionalInfoOptionLabelSchema,
});
const AdditionalInfoQuestionBaseShape = {
  id: AdditionalInfoQuestionIdSchema,
  key: UserInfoKeySchema,
  scope: z.enum(["global", "application"]),
  question: AdditionalInfoQuestionTextSchema,
};
export const AdditionalInfoTextQuestionSchema = z.strictObject({
  ...AdditionalInfoQuestionBaseShape,
  answer_type: z.literal("text"),
});
export const AdditionalInfoBooleanQuestionSchema = z.strictObject({
  ...AdditionalInfoQuestionBaseShape,
  answer_type: z.literal("boolean"),
});
const SelectOptionsSchema = z.array(AdditionalInfoOptionSchema).min(2).max(100).refine(
  (options) => new Set(options.map((option) => option.id)).size === options.length,
  "option ids must be unique",
);
export const AdditionalInfoSingleSelectQuestionSchema = z.strictObject({
  ...AdditionalInfoQuestionBaseShape,
  answer_type: z.literal("single_select"),
  options: SelectOptionsSchema,
});
export const AdditionalInfoMultiSelectQuestionSchema = z.strictObject({
  ...AdditionalInfoQuestionBaseShape,
  answer_type: z.literal("multi_select"),
  options: SelectOptionsSchema,
});
export const AdditionalInfoQuestionSchema = z.discriminatedUnion("answer_type", [
  AdditionalInfoTextQuestionSchema,
  AdditionalInfoBooleanQuestionSchema,
  AdditionalInfoSingleSelectQuestionSchema,
  AdditionalInfoMultiSelectQuestionSchema,
]);
export type AdditionalInfoQuestion = z.infer<typeof AdditionalInfoQuestionSchema>;

export const FieldResultSchema = z.strictObject({
  label: ShortLabelSchema,
  field_type: FieldTypeSchema,
  value_present: z.boolean(),
  note: OptionalShortTextSchema.default(""),
});

export const SessionErrorSchema = z
  .strictObject({ code: ErrorCodeSchema, message: z.string() })
  .superRefine((value, context) => {
    if (value.message !== SESSION_ERROR_MESSAGES[value.code]) {
      context.addIssue({ code: "custom", message: "message does not match the fixed session error catalog" });
    }
  });

export const PlaywrightCliDiagnosticSchema = z
  .strictObject({
    step: z.number().int().min(1),
    status: z.enum(["succeeded", "failed"]),
    exit_code: z.number().int(),
    error_category: z.enum(["process_exit", "browser_runtime"]).nullable(),
    stderr_excerpt: z.enum(["[redacted]", "Browser runtime failed."]).nullable(),
    stderr_truncated: z.boolean(),
  })
  .superRefine((value, context) => {
    const expectedStatus = value.exit_code === 0 ? "succeeded" : "failed";
    if (value.status !== expectedStatus) context.addIssue({ code: "custom", message: "status does not match the browser outcome" });
    if (value.error_category === "browser_runtime") {
      if (value.exit_code !== -1 || value.stderr_excerpt !== "Browser runtime failed.") {
        context.addIssue({ code: "custom", message: "browser outcome is invalid" });
      }
    } else if (value.error_category === "process_exit") {
      if (value.exit_code === 0 || (value.stderr_excerpt !== null && value.stderr_excerpt !== "[redacted]")) {
        context.addIssue({ code: "custom", message: "process outcome is invalid" });
      }
    } else if (value.exit_code !== 0 || (value.stderr_excerpt !== null && value.stderr_excerpt !== "[redacted]")) {
      context.addIssue({ code: "custom", message: "browser outcome is invalid" });
    }
  });

export const HumanNavigationPendingActionSchema = z.strictObject({
  type: z.literal("human_navigation"),
  instruction: z.string().min(1).max(2_000),
});
export const CredentialsPendingActionSchema = emptyStrictObject("credentials");
export const AdditionalInfoPendingActionSchema = z.strictObject({
  type: z.literal("additional_info"),
  questions: z.array(AdditionalInfoQuestionSchema).min(1).max(20),
});
export const HumanReviewPendingActionSchema = emptyStrictObject("human_review");
export const PendingActionSchema = z.discriminatedUnion("type", [
  HumanNavigationPendingActionSchema,
  CredentialsPendingActionSchema,
  AdditionalInfoPendingActionSchema,
  HumanReviewPendingActionSchema,
]);

const isoDateTimeSchema = z.iso.datetime({ offset: true });
const sanitizedUrlSchema = z.string().transform((value, context) => {
  try {
    return sanitizePublicUrl(value);
  } catch {
    context.addIssue({ code: "custom", message: "URL is invalid" });
    return z.NEVER;
  }
});
const sanitizedBasenameSchema = z.string().superRefine((value, context) => {
  if (
    value.length < 1 ||
    value.length > 255 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    [...value].some((character) => character.codePointAt(0)! < 32)
  ) {
    context.addIssue({ code: "custom", message: "filename is invalid" });
  }
});

const SessionSnapshotObjectSchema = z.strictObject({
  session_id: z.uuid(),
  state: SessionStateSchema,
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  expires_at: isoDateTimeSchema.nullable(),
  slot_released: z.boolean().default(false),
  job_url: sanitizedUrlSchema,
  company: z.string().max(500).nullable().default(null),
  role: z.string().max(500).nullable().default(null),
  model_provider: ApplicationModelProviderSchema.default(MODEL_PROVIDER),
  model: ApplicationModelNameSchema.default(MODEL_NAME),
  reasoning: ApplicationModelReasoningSchema.default(MODEL_REASONING),
  fields_filled: z.array(FieldResultSchema).max(500).default([]),
  fields_needing_human: z.array(FieldResultSchema).max(500).default([]),
  files_attached: z.array(sanitizedBasenameSchema).max(20).default([]),
  warnings: z.array(z.string().min(1).max(1_000)).max(100).default([]),
  playwright_cli_diagnostics: z.array(PlaywrightCliDiagnosticSchema).max(100).default([]),
  revision_count: z.number().int().min(0).max(100).default(0),
  pending_action: PendingActionSchema.nullable().default(null),
  error: SessionErrorSchema.nullable().default(null),
});

export const SessionSnapshotSchema = SessionSnapshotObjectSchema.superRefine((value, context) => {
  const modelValid =
    (value.model_provider === "openai-codex" && value.model === "gpt-5.6-sol" && value.reasoning === "medium") ||
    (value.model_provider === "google-antigravity" && value.model === "gemini-3.8-flash" && value.reasoning === "high");
  if (!modelValid) context.addIssue({ code: "custom", message: "application model configuration is inconsistent" });
  const created = Date.parse(value.created_at);
  if (Date.parse(value.updated_at) < created) context.addIssue({ code: "custom", message: "updated_at must not precede created_at" });
  if (value.expires_at !== null && Date.parse(value.expires_at) < created) context.addIssue({ code: "custom", message: "expires_at must not precede created_at" });
  if (value.slot_released && value.state !== "cancelled" && value.state !== "failed" && value.state !== "closed") {
    context.addIssue({ code: "custom", message: "only cleaned terminal sessions may release the slot" });
  }
  if ((value.state === "failed") !== (value.error !== null)) {
    context.addIssue({ code: "custom", message: "error does not match session state" });
  }
  const pendingType = value.pending_action?.type;
  const pendingMatches =
    (value.state === "awaiting_human_navigation" && (pendingType === "human_navigation" || pendingType === "credentials")) ||
    (value.state === "awaiting_additional_info" && pendingType === "additional_info") ||
    (value.state === "awaiting_human_review" && pendingType === "human_review") ||
    (!value.state.startsWith("awaiting_") && pendingType === undefined);
  if (!pendingMatches) context.addIssue({ code: "custom", message: "pending action does not match the awaiting session state" });
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

export function validateBrowserUrl(value: string): string {
  const url = parseAbsoluteHttpUrl(value, "browser_url");
  if (url.username || url.password) throw new Error("browser_url must not contain user information");
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("browser_url must use HTTPS unless it is loopback");
  }
  return value;
}

export function validateJobUrl(value: string): string {
  const url = parseAbsoluteHttpUrl(value, "job_url");
  if (url.username || url.password) throw new Error("job_url must not contain user information");
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("job_url must use HTTPS unless it is loopback");
  }
  if (url.hash) throw new Error("job_url must not contain a fragment");
  return value;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  return match !== null && Number(match[1]) === 127 && match.slice(1).every((part) => Number(part) <= 255);
}

export function validateHttpsOrigin(value: string): string {
  const url = parseAbsoluteHttpUrl(value, "origin");
  if (url.protocol !== "https:") throw new Error("origin must use HTTPS");
  if (url.username || url.password) throw new Error("origin must not contain user information");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("origin must not contain a path, query, or fragment");
  }
  return url.origin;
}

export function validateApprovedOrigin(value: string): string {
  const url = parseAbsoluteHttpUrl(value, "origin");
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("origin must use HTTPS unless it is loopback");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("origin must not contain a path, query, or fragment");
  }
  return url.origin;
}

export function validateLoopbackHttpUrl(value: string, fieldName = "URL"): string {
  const url = parseAbsoluteHttpUrl(value, fieldName);
  if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) {
    throw new Error(`${fieldName} must be a loopback HTTP URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${fieldName} must not contain user information, a query, or a fragment`);
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export const ApplicationAnswerSuggestionSchema = z.strictObject({
  question: AdditionalInfoQuestionTextSchema,
  answer: AdditionalInfoTextValueSchema,
});
export const ApplicationAnswerSuggestionsResponseSchema = z.strictObject({
  suggestions: z.array(ApplicationAnswerSuggestionSchema).max(5),
});

export const AcceptedAdditionalInfoAnswerSchema = z
  .strictObject({
    id: AdditionalInfoQuestionIdSchema,
    key: UserInfoKeySchema,
    scope: z.enum(["global", "application"]),
    answer_type: z.enum(["text", "boolean", "single_select", "multi_select"]),
    status: z.enum(["answered", "declined"]),
    value: z.union([z.string(), z.boolean(), z.array(z.string()), z.null()]).optional(),
  })
  .superRefine((answer, context) => {
    if (answer.status === "declined") {
      if ("value" in answer) context.addIssue({ code: "custom", message: "declined answers must omit value" });
      return;
    }
    if (!("value" in answer)) {
      context.addIssue({ code: "custom", message: "answered answers require value" });
      return;
    }
    if (answer.answer_type === "boolean") {
      if (typeof answer.value !== "boolean") context.addIssue({ code: "custom", message: "boolean answers require a boolean value" });
      return;
    }
    if (answer.answer_type === "text" || answer.answer_type === "single_select") {
      const maximum = answer.answer_type === "text" ? 2_000 : 200;
      if (typeof answer.value !== "string" || answer.value !== answer.value.trim() || answer.value.length < 1 || answer.value.length > maximum) {
        context.addIssue({ code: "custom", message: "text answers require a bounded string value" });
      }
      return;
    }
    if (!Array.isArray(answer.value) || answer.value.length < 1 || answer.value.length > 100 || answer.value.some((item) => !item || item !== item.trim() || item.length > 200)) {
      context.addIssue({ code: "custom", message: "multi-select answers require bounded string values" });
    }
  });

export const BrowserLaunchConfigSchema = z
  .strictObject({
    chrome_executable: z.string().nullable().default(null),
    chrome_user_data_dir: z.string().default("~/.jobhunt/browser-harness/chrome"),
    cdp_url: z.string().nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.cdp_url !== null) {
      try {
        const url = new URL(validateLoopbackHttpUrl(value.cdp_url, "cdp_url"));
        if (!url.port || url.pathname !== "/") throw new Error();
      } catch {
        context.addIssue({ code: "custom", message: "cdp_url must be a loopback HTTP origin with an explicit port" });
      }
    }
    if (value.cdp_url !== null && value.chrome_executable !== null) {
      context.addIssue({ code: "custom", message: "cdp_url and chrome_executable are mutually exclusive" });
    }
  });

export const HarnessConfigSchema = z.strictObject({
  bearer_token: z.string().refine((value) => codePointLength(value) >= 32),
  pipeline_url: z.string().default("http://127.0.0.1:3457").superRefine((value, context) => {
    try {
      validateLoopbackHttpUrl(value, "pipeline_url");
    } catch {
      context.addIssue({ code: "custom", message: "pipeline_url must be a loopback HTTP URL" });
    }
  }),
  port: z.number().int().min(1).max(65_535).default(8_765),
  node_executable: z.string().nullable().default(null),
  playwright_cli_script: z.string().nullable().default(null),
  user_info_json: z.string().default(".jobhunt-data/user-info/current-context/personal/user-info.json"),
  credentials_json: z.string().default("~/.jobhunt/browser-harness/credentials.json"),
  gmail_oauth_client_json: z.string().default("~/.jobhunt/browser-harness/gmail-oauth-client.json"),
  gmail_token_json: z.string().default("~/.jobhunt/browser-harness/gmail-token.json"),
  gmail_verification_timeout: z.number().int().min(1).max(900).default(180),
  browser: BrowserLaunchConfigSchema.default({
    chrome_executable: null,
    chrome_user_data_dir: "~/.jobhunt/browser-harness/chrome",
    cdp_url: null,
  }),
});

export const GmailAuthIdentitySchema = z.strictObject({
  email: z.string().min(3).max(320).superRefine((value, context) => {
    if (value !== value.trim() || !value.includes("@") || [...value].some((character) => character.codePointAt(0)! < 32)) {
      context.addIssue({ code: "custom", message: "email is invalid" });
    }
  }),
});
export const GmailAuthStatusSchema = z
  .strictObject({
    state: z.enum(["connected", "disconnected"]),
    identity: GmailAuthIdentitySchema.nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.state === "disconnected" && value.identity !== null) {
      context.addIssue({ code: "custom", message: "disconnected status cannot include identity" });
    }
  });
export const GmailAuthSessionCreateRequestSchema = z.strictObject({});
export const GmailAuthSessionIdSchema = z.string().length(43).regex(/^[A-Za-z0-9_-]{43}$/);
export const GmailAuthSessionSchema = z.strictObject({
  id: GmailAuthSessionIdSchema,
  state: z.enum(["pending", "succeeded", "failed", "expired"]),
  authorization_url: z.string().max(8_192).nullable().default(null).superRefine((value, context) => {
    if (value === null) return;
    try {
      const url = parseAbsoluteHttpUrl(value, "authorization_url");
      if (url.protocol !== "https:" || url.hostname !== "accounts.google.com" || url.username || url.password) throw new Error();
    } catch {
      context.addIssue({ code: "custom", message: "authorization_url must use Google HTTPS" });
    }
  }),
  expires_at: isoDateTimeSchema,
});

const SOURCE_CAPTURE_CREATE_URL_MAX_CHARACTERS = 2_048;
const SOURCE_CAPTURE_FINAL_URL_MAX_CHARACTERS = 4_096;

function isCanonicalSourceCaptureHttpsUrl(value: string, maximumLength: number): boolean {
  if (value.length < 1 || value.length > maximumLength) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname !== ""
      && !url.hostname.endsWith(".")
      && url.username === ""
      && url.password === ""
      && url.hash === ""
      && url.href === value;
  } catch {
    return false;
  }
}

export const SourceCaptureCreateRequestSchema = z.strictObject({
  capture_id: z.uuid(),
  job_url: z.string().max(SOURCE_CAPTURE_CREATE_URL_MAX_CHARACTERS).superRefine((value, context) => {
    if (!isCanonicalSourceCaptureHttpsUrl(value, SOURCE_CAPTURE_CREATE_URL_MAX_CHARACTERS)) {
      context.addIssue({ code: "custom", message: "job_url must be a canonical HTTPS URL" });
    }
  }),
});
export const SourceCaptureCreateResponseSchema = z.strictObject({
  capture_id: z.uuid(),
  state: z.literal("awaiting_human_verification"),
});
export const SourceCaptureResultSchema = z.strictObject({
  capture_id: z.uuid(),
  final_url: z.string().max(SOURCE_CAPTURE_FINAL_URL_MAX_CHARACTERS).superRefine((value, context) => {
    if (!isCanonicalSourceCaptureHttpsUrl(value, SOURCE_CAPTURE_FINAL_URL_MAX_CHARACTERS)) {
      context.addIssue({ code: "custom", message: "final_url must be a canonical HTTPS URL" });
    }
  }),
  source: z.string().min(1).superRefine((value, context) => {
    if (Buffer.byteLength(value, "utf8") > SOURCE_CAPTURE_MAX_BYTES || pythonSplitLineCount(value) > SOURCE_CAPTURE_MAX_LINES) {
      context.addIssue({ code: "custom", message: "source exceeds its limit" });
    }
  }),
});
export const SessionCreateResponseSchema = z.strictObject({
  session_id: z.uuid(),
  state: z.literal("starting").default("starting"),
  events_url: sanitizedUrlSchema,
  commands_url: sanitizedUrlSchema,
});


export const EmptyEventDetailSchema = z.strictObject({});
export const AgentStepDetailSchema = z.strictObject({
  step_number: z.number().int().min(1),
  current_url: sanitizedUrlSchema,
});
export const HumanNavigationDetailSchema = z.strictObject({
  instruction: z.string().min(1).max(2_000),
});
export const RevisionAppliedDetailSchema = z.strictObject({
  revision_count: z.number().int().min(1).max(100),
});
export const AdditionalInfoRequiredDetailSchema = z.strictObject({
  questions: z.array(AdditionalInfoQuestionSchema).min(1).max(20),
});
export const AdditionalInfoSavedDetailSchema = z.strictObject({
  count: z.number().int().min(1).max(20),
});
export const HarnessEventTypeSchema = z.enum([
  "snapshot",
  "session_started",
  "agent_step",
  "human_navigation_required",
  "review_required",
  "revision_applied",
  "additional_info_required",
  "additional_info_saved",
  "submission_started",
  "application_submitted",
  "submission_uncertain",
  "cancelled",
  "failed",
  "closed",
  "credentials_required",
]);
export const HarnessEventDetailSchema = z.union([
  EmptyEventDetailSchema,
  AgentStepDetailSchema,
  HumanNavigationDetailSchema,
  RevisionAppliedDetailSchema,
  AdditionalInfoRequiredDetailSchema,
  AdditionalInfoSavedDetailSchema,
]);
export const HarnessEventSchema = z
  .strictObject({
    id: z.number().int().min(0),
    event: HarnessEventTypeSchema,
    session: SessionSnapshotSchema,
    detail: HarnessEventDetailSchema.default({}),
  })
  .superRefine((value, context) => {
    const detail = value.detail;
    const matches =
      (value.event === "agent_step" && "step_number" in detail) ||
      (value.event === "human_navigation_required" && "instruction" in detail) ||
      (value.event === "revision_applied" && "revision_count" in detail) ||
      (value.event === "additional_info_required" && "questions" in detail) ||
      (value.event === "additional_info_saved" && "count" in detail) ||
      (!["agent_step", "human_navigation_required", "revision_applied", "additional_info_required", "additional_info_saved"].includes(value.event) && Object.keys(detail).length === 0);
    if (!matches) context.addIssue({ code: "custom", message: `detail does not match ${value.event}` });
  });

export const BrowserTabSchema = z.strictObject({
  url: z.string().max(BROWSER_URL_MAX_CHARACTERS),
  title: z.string().max(BROWSER_TITLE_MAX_CHARACTERS),
  tab_id: z.string().max(512),
  parent_tab_id: z.string().max(512).nullable().default(null),
});
export const BrowserScreenshotSchema = z.strictObject({
  media_type: z.literal("image/png").default("image/png"),
  data: z.string().max(11_184_812),
});
export const BrowserObservationSchema = z.strictObject({
  url: z.string().max(BROWSER_URL_MAX_CHARACTERS),
  title: z.string().max(BROWSER_TITLE_MAX_CHARACTERS),
  tabs: z.array(BrowserTabSchema).max(100),
  dom: z.string().max(BROWSER_DOM_MAX_CHARACTERS),
  page_info: z.record(z.string(), z.unknown()).nullable(),
  screenshot: BrowserScreenshotSchema.nullable(),
});
export const PlaywrightCliErrorCategorySchema = z.enum([
  "target_closed",
  "no_open_pages",
  "page_crashed",
  "timeout",
  "modal_blocked",
  "modal_handler_mismatch",
  "stale_reference",
  "wrong_control_type",
  "invalid_value",
  "protocol_error",
  "unknown",
]);
export const PlaywrightCliExecutionResultSchema = z.strictObject({
  exit_code: z.number().int(),
  stdout: z.string().max(PLAYWRIGHT_OUTPUT_MAX_CHARACTERS),
  stderr: z.string().max(PLAYWRIGHT_OUTPUT_MAX_CHARACTERS),
  stdout_truncated: z.boolean(),
  stderr_truncated: z.boolean(),
  cli_error_category: PlaywrightCliErrorCategorySchema.nullable().default(null),
  observation: BrowserObservationSchema,
});

const ApplicationResultBaseShape = {
  company: z.string().max(500).nullable().default(null),
  role: z.string().max(500).nullable().default(null),
  job_url: sanitizedUrlSchema,
  final_url: sanitizedUrlSchema,
  fields_filled: z.array(FieldResultSchema).max(500).default([]),
  fields_needing_human: z.array(FieldResultSchema).max(500).default([]),
  files_attached: z.array(sanitizedBasenameSchema).max(20).default([]),
  warnings: z.array(z.string().min(1).max(1_000)).max(100).default([]),
  revision_count: z.number().int().min(0).max(100).default(0),
};
function applicationResultSchema<
  T extends "ready_for_submission" | "submitted" | "submission_uncertain" | "cancelled",
  A extends boolean,
>(status: T, attempted: A) {
  return z
    .strictObject({
      ...ApplicationResultBaseShape,
      status: z.literal(status),
      submit_attempted: z.literal(attempted).default(attempted),
    })
    .superRefine((value, context) => {
      if (value.fields_filled.some((field) => !field.value_present)) {
        context.addIssue({ code: "custom", message: "fields_filled entries must have value_present true" });
      }
      if (value.fields_needing_human.some((field) => field.value_present)) {
        context.addIssue({ code: "custom", message: "fields_needing_human entries must have value_present false" });
      }
    });
}
export const ReviewApplicationResultSchema = applicationResultSchema("ready_for_submission", false);
export const SubmittedApplicationResultSchema = applicationResultSchema("submitted", true);
export const SubmissionUncertainApplicationResultSchema = applicationResultSchema("submission_uncertain", true);
export const CancelledApplicationResultSchema = applicationResultSchema("cancelled", false);
export const ApplicationRunResultSchema = z.union([
  SubmittedApplicationResultSchema,
  SubmissionUncertainApplicationResultSchema,
  CancelledApplicationResultSchema,
]);

export const PlaywrightCliCommandSchema = z.enum([
  "goto",
  "snapshot",
  "eval",
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
  "video-chapter",
  "video-show-actions",
  "video-hide-actions",
]);
const PLAYWRIGHT_CLI_RESERVED_ARGUMENTS = new Set([
  "-s", "--s", "-h", "--help", "-v", "--version", "--session",
  "--json", "--raw", "--config", "--profile", "--persistent", "--headed",
  "--browser", "--cdp", "--endpoint", "--extension",
]);
const PLAYWRIGHT_CLI_RESERVED_ARGUMENT_PREFIXES = [
  "-s=", "--s=", "-h=", "--help=", "-v=", "--version=", "--session=",
  "--json=", "--raw=", "--config=", "--profile=", "--persistent=", "--headed=",
  "--browser=", "--cdp=", "--endpoint=", "--extension=",
] as const;

export const PlaywrightCliRuntimeActionSchema = z
  .strictObject({
    type: z.literal("playwright_cli"),
    command: PlaywrightCliCommandSchema,
    args: z.array(z.string().superRefine((value, context) => {
      if (!isUnicodeScalarText(value) || Buffer.byteLength(value, "utf8") > 8_192) {
        context.addIssue({ code: "custom", message: "argument is invalid" });
      }
    })).max(64).default([]),
  })
  .superRefine((value, context) => {
    if (value.args.some((argument) =>
      PLAYWRIGHT_CLI_RESERVED_ARGUMENTS.has(argument)
      || (argument.length > 2 && argument.startsWith("-s") && !argument.startsWith("--"))
      || PLAYWRIGHT_CLI_RESERVED_ARGUMENT_PREFIXES.some((prefix) => argument.startsWith(prefix))
    )) {
      context.addIssue({ code: "custom", path: ["args"], message: "argument is reserved" });
    }
    const size = Buffer.byteLength(value.command, "utf8") + value.args.reduce(
      (total, argument) => total + Buffer.byteLength(argument, "utf8"),
      0,
    );
    if (size > 65_536) {
      context.addIssue({ code: "custom", message: "invocation must be at most 65,536 UTF-8 bytes" });
    }
  });
export const RequestHumanNavigationRuntimeActionSchema = z.strictObject({
  type: z.literal("request_human_navigation"),
  instruction: codePointBoundedString(1, 2_000, true),
});
export const GetCredentialsRuntimeActionSchema = emptyStrictObject("get_credentials");
export const ReadInboxRuntimeActionSchema = z.strictObject({
  type: z.literal("read_inbox"),
  query: codePointBoundedString(0, 500, true).default("code").transform((value, context) => {
    if ([...value].some((character) => character.codePointAt(0)! < 32)) {
      context.addIssue({ code: "custom", message: "query is invalid" });
      return z.NEVER;
    }
    return value || "code";
  }),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year!, month! - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
  }).nullable().default(null),
  time: z.string().regex(/^\d{2}:\d{2}$/).refine(
    (value) => Number(value.slice(0, 2)) < 24 && Number(value.slice(3)) < 60,
  ).nullable().default(null),
  received_within_minutes: z.number().int().min(1).max(1_440).nullable().default(null),
  received_before_minutes_ago: z.number().int().min(1).max(1_440).nullable().default(null),
});
export const ReadEmailRuntimeActionSchema = z.strictObject({
  type: z.literal("read_email"),
  email_id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  offset: z.number().int().min(0).max(131_071).default(0),
});
export const ReadUserInfoRuntimeActionSchema = emptyStrictObject("read_user_info");
export const RequestAdditionalInfoRuntimeActionSchema = z.strictObject({
  type: z.literal("request_additional_info"),
  questions: z.array(AdditionalInfoQuestionSchema).min(1).max(20).superRefine((questions, context) => {
    const ids = new Set(questions.map((question) => question.id));
    const scopedKeys = new Set(questions.map((question) => `${question.scope}:${question.key}`));
    if (ids.size !== questions.length || scopedKeys.size !== questions.length) {
      context.addIssue({ code: "custom", message: "questions must be unique" });
    }
  }),
});
export const RequestHumanReviewRuntimeActionSchema = z.strictObject({
  type: z.literal("request_human_review"),
  result: ReviewApplicationResultSchema,
});
export const ReportApplicationMismatchRuntimeActionSchema = emptyStrictObject("report_application_mismatch");
export const PublicRuntimeActionRequestSchema = z.union([
  PlaywrightCliRuntimeActionSchema,
  RequestHumanNavigationRuntimeActionSchema,
  RequestAdditionalInfoRuntimeActionSchema,
  RequestHumanReviewRuntimeActionSchema,
  ReportApplicationMismatchRuntimeActionSchema,
]);
export const RuntimeActionRequestSchema = z.union([
  PlaywrightCliRuntimeActionSchema,
  RequestHumanNavigationRuntimeActionSchema,
  GetCredentialsRuntimeActionSchema,
  ReadInboxRuntimeActionSchema,
  ReadEmailRuntimeActionSchema,
  ReadUserInfoRuntimeActionSchema,
  RequestAdditionalInfoRuntimeActionSchema,
  RequestHumanReviewRuntimeActionSchema,
  ReportApplicationMismatchRuntimeActionSchema,
]);
export type RuntimeActionRequest = z.infer<typeof RuntimeActionRequestSchema>;


export const PlaywrightCliResultRuntimeActionResponseSchema = z.strictObject({
  type: z.literal("playwright_cli_result"),
  ...PlaywrightCliExecutionResultSchema.shape,
});
export const CredentialsRuntimeActionResponseSchema = z.strictObject({
  type: z.literal("credentials"),
  username: z.string().min(1).max(4_096),
  password: z.string().min(1).max(4_096),
});
export const InboxMessageSummarySchema = z.strictObject({
  email_id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  subject: z.string().max(998),
  sent_at: z.string().max(35).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
});
export const ReadInboxRuntimeActionResponseSchema = z.strictObject({
  type: z.literal("read_inbox_result"),
  messages: z.array(InboxMessageSummarySchema).max(50),
  truncated: z.boolean(),
});
export const ReadEmailRuntimeActionResponseSchema = z.strictObject({
  type: z.literal("read_email_result"),
  content: z.string().min(1).max(READ_EMAIL_OUTPUT_MAX_BYTES).superRefine((value, context) => {
    if (!isUnicodeScalarText(value) || Buffer.byteLength(value, "utf8") > READ_EMAIL_OUTPUT_MAX_BYTES) {
      context.addIssue({ code: "custom", message: "content exceeds the UTF-8 byte limit" });
    }
  }),
});
const READ_USER_INFO_RESPONSE_FIXED_BYTES = Buffer.byteLength(
  '{"type":"read_user_info_result","content":""}',
  "utf8",
);

function jsonStringUtf8Bytes(value: string): number | null {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes += 2;
    } else if (codeUnit <= 0x1f) {
      bytes += codeUnit === 0x08 || codeUnit === 0x09 || codeUnit === 0x0a
        || codeUnit === 0x0c || codeUnit === 0x0d ? 2 : 6;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = value.charCodeAt(++index);
      if (trailing < 0xdc00 || trailing > 0xdfff) return null;
      bytes += 4;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return null;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export const ReadUserInfoRuntimeActionResponseSchema = z.strictObject({
  type: z.literal("read_user_info_result"),
  content: z.string().superRefine((value, context) => {
    const contentBytes = jsonStringUtf8Bytes(value);
    if (contentBytes === null
      || READ_USER_INFO_RESPONSE_FIXED_BYTES + contentBytes > APPLICATION_RUNTIME_RESPONSE_MAX_BYTES) {
      context.addIssue({ code: "custom", message: "response exceeds the runtime transport limit" });
    }
  }),
});
export const GmailUnavailableRuntimeActionResponseSchema = z.strictObject({
  type: z.literal("gmail_unavailable"),
  message: z.string().min(1).max(500),
});
export const ContinueRuntimeActionResponseSchema = emptyStrictObject("continue");
export const InterruptedRuntimeActionResponseSchema = emptyStrictObject("interrupted");
export const ContinueWithoutAdditionalInfoRuntimeActionResponseSchema = emptyStrictObject(
  "continue_without_additional_info",
);
export const ReviseRuntimeActionResponseSchema = z.strictObject({
  type: z.literal("revise"),
  context: z.string().trim().min(1).max(20_000),
  revision_count: z.number().int().min(1).max(100),
});
export const SubmitRuntimeActionResponseSchema = z.strictObject({
  type: z.literal("submit"),
  instruction: z.literal("You're good to submit."),
  result: ReviewApplicationResultSchema,
});
export const CancelRuntimeActionResponseSchema = z.strictObject({
  type: z.literal("cancel"),
  result: CancelledApplicationResultSchema,
});
export const AdditionalInfoRuntimeActionResponseSchema = z.strictObject({
  type: z.literal("additional_info"),
  answers: z.array(AcceptedAdditionalInfoAnswerSchema).min(1).max(20),
});
export const ApplicationMismatchRuntimeActionResponseSchema = emptyStrictObject("application_mismatch");
export const RuntimeActionResponseSchema = z.union([
  PlaywrightCliResultRuntimeActionResponseSchema,
  CredentialsRuntimeActionResponseSchema,
  ReadInboxRuntimeActionResponseSchema,
  ReadEmailRuntimeActionResponseSchema,
  ReadUserInfoRuntimeActionResponseSchema,
  GmailUnavailableRuntimeActionResponseSchema,
  ContinueRuntimeActionResponseSchema,
  InterruptedRuntimeActionResponseSchema,
  ContinueWithoutAdditionalInfoRuntimeActionResponseSchema,
  ReviseRuntimeActionResponseSchema,
  SubmitRuntimeActionResponseSchema,
  CancelRuntimeActionResponseSchema,
  AdditionalInfoRuntimeActionResponseSchema,
  ApplicationMismatchRuntimeActionResponseSchema,
]);
export type RuntimeActionResponse = z.infer<typeof RuntimeActionResponseSchema>;



export const DIRECT_FIELD_NAMES = [
  "full_name",
  "first_name",
  "last_name",
  "email",
  "phone",
  "street_address",
  "city",
  "region",
  "postal_code",
  "country",
  "linkedin_url",
  "portfolio_url",
  "work_authorization",
  "sponsorship_required",
  "relocation",
  "salary_expectation",
  "start_date",
] as const;

export const UploadedArtifactsSchema = z.strictObject({
  session_directory: z.string(),
  personal_information: z.string(),
  resume: z.string(),
  resume_source: z.string(),
  transcript: z.string().nullable().default(null),
  context: z.array(z.string()).max(APPLICATION_CONTEXT_MAX_COUNT).default([]),
  anecdotes: z.array(z.string()).max(APPLICATION_ANECDOTE_MAX_COUNT).default([]),
});
export const SessionCreateRequestSchema = z.strictObject({
  session_id: z.uuid(),
  job_url: z.string().superRefine((value, context) => {
    try {
      validateJobUrl(value);
    } catch {
      context.addIssue({ code: "custom", message: "job_url is invalid" });
    }
  }),
  opportunity_kind: OpportunityKindSchema,
  auto_submit: z.boolean(),
  auto_end: z.boolean(),
  artifacts: UploadedArtifactsSchema,
  direct_fields: z.array(z.tuple([z.string(), z.string()])).default([]).superRefine((fields, context) => {
    const names = fields.map(([name]) => name);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: "custom", message: "direct_fields must not contain duplicate names" });
    }
    if (names.some((name) => !DIRECT_FIELD_NAMES.includes(name as (typeof DIRECT_FIELD_NAMES)[number]))) {
      context.addIssue({ code: "custom", message: "direct_fields contains an unknown name" });
    }
    if (fields.some(([, value]) => value.trim().length === 0)) {
      context.addIssue({ code: "custom", message: "direct_fields values must be nonempty" });
    }
  }),
});

export const ApplicationResultBaseSchema = z
  .strictObject(ApplicationResultBaseShape)
  .superRefine((value, context) => {
    if (value.fields_filled.some((field) => !field.value_present)) {
      context.addIssue({ code: "custom", message: "fields_filled entries must have value_present true" });
    }
    if (value.fields_needing_human.some((field) => field.value_present)) {
      context.addIssue({ code: "custom", message: "fields_needing_human entries must have value_present false" });
    }
  });

export const ErrorResponseSchema = z.strictObject({ code: z.string(), message: z.string() });
export const SessionActiveErrorResponseSchema = z.strictObject({
  code: z.literal("session_active"),
  session_id: z.uuid(),
});

export function sessionError(code: ErrorCode): SessionError {
  return SessionErrorSchema.parse({ code, message: SESSION_ERROR_MESSAGES[code] });
}

export type ApplicationModelMetadata = z.infer<typeof ApplicationModelMetadataSchema>;
export type ApplicationModelProvider = z.infer<typeof ApplicationModelProviderSchema>;
export type MirroredOAuthCredential = z.infer<typeof MirroredOAuthCredentialSchema>;
export type AdditionalInfoOption = z.infer<typeof AdditionalInfoOptionSchema>;
export type ApplicationAnswerSuggestion = z.infer<typeof ApplicationAnswerSuggestionSchema>;
export type ApplicationAnswerSuggestionsResponse = z.infer<typeof ApplicationAnswerSuggestionsResponseSchema>;
export type AdditionalInfoCommandAnswer = z.infer<typeof AdditionalInfoCommandAnswerSchema>;
export type AcceptedAdditionalInfoAnswer = z.infer<typeof AcceptedAdditionalInfoAnswerSchema>;
export type BrowserLaunchConfig = z.infer<typeof BrowserLaunchConfigSchema>;
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
export type GmailAuthIdentity = z.infer<typeof GmailAuthIdentitySchema>;
export type GmailAuthStatus = z.infer<typeof GmailAuthStatusSchema>;
export type GmailAuthSession = z.infer<typeof GmailAuthSessionSchema>;
export type UploadedArtifacts = z.infer<typeof UploadedArtifactsSchema>;
export type SessionCreateRequest = z.infer<typeof SessionCreateRequestSchema>;
export type SourceCaptureCreateRequest = z.infer<typeof SourceCaptureCreateRequestSchema>;
export type SourceCaptureCreateResponse = z.infer<typeof SourceCaptureCreateResponseSchema>;
export type SourceCaptureResult = z.infer<typeof SourceCaptureResultSchema>;
export type FieldResult = z.infer<typeof FieldResultSchema>;
export type SessionError = z.infer<typeof SessionErrorSchema>;
export type PlaywrightCliDiagnostic = z.infer<typeof PlaywrightCliDiagnosticSchema>;
export type PendingAction = z.infer<typeof PendingActionSchema>;
export type HarnessEvent = z.infer<typeof HarnessEventSchema>;
export type SessionCreateResponse = z.infer<typeof SessionCreateResponseSchema>;
export type BrowserTab = z.infer<typeof BrowserTabSchema>;
export type BrowserScreenshot = z.infer<typeof BrowserScreenshotSchema>;
export type BrowserObservation = z.infer<typeof BrowserObservationSchema>;
export type PlaywrightCliExecutionResult = z.infer<typeof PlaywrightCliExecutionResultSchema>;
export type ApplicationResultBase = z.infer<typeof ApplicationResultBaseSchema>;
export type ReviewApplicationResult = z.infer<typeof ReviewApplicationResultSchema>;
export type SubmittedApplicationResult = z.infer<typeof SubmittedApplicationResultSchema>;
export type SubmissionUncertainApplicationResult = z.infer<typeof SubmissionUncertainApplicationResultSchema>;
export type CancelledApplicationResult = z.infer<typeof CancelledApplicationResultSchema>;
export type ApplicationRunResult = z.infer<typeof ApplicationRunResultSchema>;
export type PlaywrightCliCommand = z.infer<typeof PlaywrightCliCommandSchema>;

