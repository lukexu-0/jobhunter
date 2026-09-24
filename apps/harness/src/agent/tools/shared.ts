import {
  ModelBehaviorError,
  tool,
  type FunctionTool,
  type RunContext,
  type ToolExecuteArgument,
  type ToolOptionsWithGuardrails,
} from "@openai/agents-core";
import { z } from "zod";
import { hasCodePointLength, stripPythonWhitespace, type AdditionalInfoQuestion } from "../../contracts/models.ts";
import {
  ApplicationRuntimeError,
  ReadEmailRuntimeActionSchema,
  ReadUserInfoRuntimeActionSchema,
  ReviewApplicationResultSchema,
  RuntimeActionResponseSchema,
  type ApplicationRuntimeClient,
  type RuntimeActionResponse,
} from "../../application/application-runtime-client.ts";
import {
  ApplicationAgentFailure,
  ApplicationToolRejection,
  type BrowserApplicationContext,
  FieldResultSchema,
  AdditionalInfoQuestionSchema,
} from "../../application/agent-runtime/contracts/application.ts";

export function requireRuntimeContext(
  runContext: { context: BrowserApplicationContext } | undefined,
  allowAfterApproval: boolean,
): BrowserApplicationContext {
  if (!runContext?.context) throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
  const context = runContext.context;
  context.signal.throwIfAborted();
  if (context.submissionFinalized || (context.submissionApproved && !allowAfterApproval)) {
    throw new ApplicationToolRejection(
      "submission_state",
      "This tool is not available after final submission approval. Inspect the current page and use the permitted submission actions; do not repeat an uncertain submission.",
    );
  }
  return context;
}

export function acceptedAnswersMatchQuestions(
  answers: readonly {
    readonly id: string;
    readonly key: string;
    readonly scope: string;
    readonly answer_type: string;
  }[],
  questions: readonly AdditionalInfoQuestion[],
): boolean {
  if (answers.length !== questions.length) return false;
  const answersById = new Map(answers.map((answer) => [answer.id, answer]));
  return answersById.size === questions.length
    && questions.every((question) => {
      const answer = answersById.get(question.id);
      return answer !== undefined
        && answer.key === question.key
        && answer.scope === question.scope
        && answer.answer_type === question.answer_type;
    });
}

export function rejectMissingBrowserInspection(
  context: BrowserApplicationContext,
): void {
  if (!context.playwrightCliCompleted) {
    throw new ApplicationToolRejection(
      "inspection_required",
      "Inspect the current browser page successfully, then retry this request. A failed click may have navigated; do not repeat it without inspecting.",
    );
  }
}

export function rejectMissingPostNavigationInspection(
  context: BrowserApplicationContext,
): void {
  if (context.postNavigationInspectionRequired) {
    throw new ApplicationToolRejection(
      "inspection_required",
      "Inspect the current page after sign-in or human navigation, then retry this request.",
    );
  }
}

export function rejectInvalidRuntimeResponse(
  context: BrowserApplicationContext,
  actionType: Parameters<ApplicationRuntimeClient["action"]>[0]["type"],
): never {
  const browserStateMayHaveChanged = actionType === "playwright_cli"
    || actionType === "request_human_navigation"
    || actionType === "request_human_review";
  if (browserStateMayHaveChanged) {
    delete context.latestScreenshotDataUrl;
    context.playwrightCliCompleted = false;
    context.browserSnapshotRequired = true;
  }
  if (
    actionType === "request_human_navigation"
    || actionType === "request_human_review"
  ) {
    context.postNavigationInspectionRequired = true;
  }
  if (actionType === "request_human_navigation" && context.submissionApproved) {
    context.submissionOutcomePending = true;
  }
  throw new ApplicationToolRejection(
    "invalid_response",
    browserStateMayHaveChanged
      ? "The application runtime returned an invalid response after an action that may have completed. Run snapshot successfully before continuing, and do not replay the action until the current state is known."
      : "The application runtime returned an invalid response. Retry the tool request; do not infer a result from the missing response.",
  );
}

export async function runtimeAction(
  context: BrowserApplicationContext,
  action: Parameters<ApplicationRuntimeClient["action"]>[0],
  signal: AbortSignal,
): Promise<RuntimeActionResponse> {
  try {
    const response = await context.runtimeClient.action(action, signal);
    signal.throwIfAborted();
    const parsed = RuntimeActionResponseSchema.safeParse(response);
    if (!parsed.success) throw new ApplicationRuntimeError("invalid_response");
    return parsed.data;
  } catch (error) {
    if (context.signal.aborted) {
      throw context.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const toolAbortReason = signal.aborted ? signal.reason : undefined;
    if (signal.aborted) {
      throw toolAbortReason ?? new DOMException("Aborted", "AbortError");
    }
    if (error instanceof ApplicationAgentFailure) throw error;
    if (error instanceof ApplicationRuntimeError) {
      if (error.code === "invalid_response") {
        rejectInvalidRuntimeResponse(context, action.type);
      }
      const code = error.code === "invalid_request"
        ? "INVALID_REQUEST"
        : error.code === "browser_failed"
          ? "BROWSER_FAILED"
          : "MODEL_PROVIDER_FAILED";
      throw new ApplicationAgentFailure(code, { cause: error });
    }
    throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED", { cause: error });
  }
}

type RuntimeToolCallDetails = NonNullable<Parameters<FunctionTool["invoke"]>[2]>;

export function runtimeTool<Schema extends z.ZodObject>(
  options: {
    name: string;
    description: string;
    parameters: Schema;
    allowAfterApproval?: boolean;
    execute: (
      input: ToolExecuteArgument<Schema>,
      context: BrowserApplicationContext,
      signal: AbortSignal,
    ) => Promise<string>;
  },
): FunctionTool<BrowserApplicationContext, Schema, string> {
  const definition = {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    strict: true,
    errorFunction: (runContext, error) => {
      const context = runContext.context as BrowserApplicationContext | undefined;
      context?.signal.throwIfAborted();
      // The SDK exposes the base error, but not InvalidToolInputError itself.
      const invalidInput = error instanceof ModelBehaviorError
        && error.name === "InvalidToolInputError";
      if (invalidInput) {
        const invocation = (error as ModelBehaviorError & {
          toolInvocation?: { details?: RuntimeToolCallDetails };
        }).toolInvocation;
        invocation?.details?.signal?.throwIfAborted();
      }
      if (error instanceof ApplicationToolRejection) {
        if (context !== undefined) context.recoverableFailureObserved = true;
        return JSON.stringify({ type: "tool_error", code: error.code, message: error.message });
      }
      if (invalidInput
        || (error instanceof ApplicationAgentFailure && error.code === "INVALID_REQUEST")) {
        if (context !== undefined) context.recoverableFailureObserved = true;
        return JSON.stringify({
          type: "tool_error",
          code: "invalid_request",
          message: "Tool call rejected. Check the tool schema and current browser state before trying again.",
        });
      }
      throw error;
    },
    execute: async (
      input: ToolExecuteArgument<Schema>,
      runContext?: RunContext<BrowserApplicationContext>,
      details?: RuntimeToolCallDetails,
    ) => {
      const context = requireRuntimeContext(
        runContext,
        options.allowAfterApproval === true,
      );
      const signal = details?.signal === undefined
        ? context.signal
        : AbortSignal.any([context.signal, details.signal]);
      return options.execute(input, context, signal);
    },
  } as ToolOptionsWithGuardrails<Schema, BrowserApplicationContext>;
  return tool<Schema, BrowserApplicationContext, string>(definition);
}

export const GetCredentialsToolParameters = z.object({}).strict();
export const ReadInboxToolParameters = z.object({
  query: z.string().refine((value) => {
    const canonical = stripPythonWhitespace(value);
    return hasCodePointLength(canonical, 0, 500)
      && [...canonical].every((character) => character.codePointAt(0)! >= 32);
  }).default("code"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    if (value.startsWith("0000")) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }).optional(),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  received_within_minutes: z.number().int().min(1).max(1_440).optional(),
  received_before_minutes_ago: z.number().int().min(1).max(1_440).optional(),
}).strict();
export const ReadEmailToolParameters = ReadEmailRuntimeActionSchema.omit({ type: true });
export const ReadUserInfoToolParameters = ReadUserInfoRuntimeActionSchema.omit({ type: true });
export const CurrentTimeToolParameters = z.object({}).strict();
export const HumanNavigationToolParameters = z.object({
  instruction: z.string().refine((value) =>
    hasCodePointLength(stripPythonWhitespace(value), 1, 2_000)
  ),
}).strict();

export const AdditionalInfoToolParameters = z.object({
  questions: z.array(AdditionalInfoQuestionSchema).min(1).max(20),
}).strict();

const HumanReviewToolResultSchema = ReviewApplicationResultSchema.extend({
  fields_filled: z.array(FieldResultSchema).max(500).default([]),
  fields_needing_human: z.array(FieldResultSchema).max(500).default([]),
  submit_attempted: z.boolean().default(false),
}).strict();
export const HumanReviewToolParameters = z.object({
  result: HumanReviewToolResultSchema,
}).strict();

export const ApplicationMismatchToolParameters = z.object({}).strict();

export const SubmissionOutcomeParameters = z.object({
  submitted: z.boolean(),
}).strict();
