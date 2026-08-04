import { randomUUID } from "node:crypto";
import {
  streamSimple,
  type ApiKeyResolver,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog";
import { OAuthRequiredError, createOAuthOnlyApiKeyResolver } from "../auth/oauth-only-resolver.ts";
import {
  ApplicationAnswerSuggestionSchema,
  ApplicationProfessionalizeRequestSchema,
  ApplicationProfessionalizeResponseSchema,
  type ApplicationProfessionalizeRequest,
} from "../contracts/index.ts";
import { MODEL_NAME, OMP_CODEX_MODEL } from "./oauth-codex-model.ts";

export const APPLICATION_ANSWER_PROFESSIONALIZATION_DEADLINE_MS = 120_000;
export const APPLICATION_ANSWER_MAX_RESPONSE_BYTES = 16 * 1_024;

const DEFAULT_SYSTEM_PROMPT =
  "Turn the supplied loose thoughts into a concise professional answer to the supplied question without adding facts; return only the answer.";
const REVISION_SYSTEM_PROMPT =
  "Edit the supplied professional answer to meet the user's specifications without adding facts and return only the answer.";
const HIGH_EFFORT = "high" as Effort;

export type ApplicationAnswerStreamTransport = (
  model: Model<"openai-codex-responses">,
  context: Context,
  options: SimpleStreamOptions,
) => AsyncIterable<AssistantMessageEvent>;

export type ApplicationAnswerResolverFactory = (
  provider: "openai-codex",
  sessionId: string,
  modelId: typeof MODEL_NAME,
  signal?: AbortSignal,
) => ApiKeyResolver;

export interface ApplicationAnswerProfessionalizerOptions {
  readonly transport?: ApplicationAnswerStreamTransport;
  readonly resolverFactory?: ApplicationAnswerResolverFactory;
  readonly sessionIdFactory?: () => string;
  readonly deadlineMs?: number;
}

export class ApplicationAnswerProfessionalizationError extends Error {
  constructor(
    readonly kind: "timeout" | "unavailable" | "invalid_output",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApplicationAnswerProfessionalizationError";
  }
}

export type ProfessionalizeApplicationAnswer = (
  question: string,
  request: ApplicationProfessionalizeRequest,
  signal?: AbortSignal,
) => Promise<string>;

function recoverOAuthRequiredError(error: unknown): OAuthRequiredError | undefined {
  const seen = new Set<object>();
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 32 && current instanceof Error && !seen.has(current);
    depth += 1
  ) {
    if (current instanceof OAuthRequiredError) return current;
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

function invalidOutput(): ApplicationAnswerProfessionalizationError {
  return new ApplicationAnswerProfessionalizationError(
    "invalid_output",
    "Application answer professionalization returned invalid output",
  );
}

class BoundedUtf8TextCounter {
  #byteLength = 0;
  #pendingHighSurrogate = false;
  #finished = false;

  constructor(private readonly onExceeded: (error: ApplicationAnswerProfessionalizationError) => void) {}

  get byteLength(): number {
    return this.#byteLength;
  }

  #accept(byteLength: number): void {
    if (this.#byteLength + byteLength > APPLICATION_ANSWER_MAX_RESPONSE_BYTES) {
      const error = invalidOutput();
      this.onExceeded(error);
      throw error;
    }
    this.#byteLength += byteLength;
  }

  push(text: string): void {
    if (this.#finished) throw invalidOutput();
    let index = 0;
    if (this.#pendingHighSurrogate && text.length > 0) {
      this.#pendingHighSurrogate = false;
      const first = text.charCodeAt(0);
      if (first >= 0xDC00 && first <= 0xDFFF) {
        this.#accept(4);
        index = 1;
      } else {
        this.#accept(3);
      }
    }

    while (index < text.length) {
      const codeUnit = text.charCodeAt(index);
      if (codeUnit <= 0x7F) {
        this.#accept(1);
        index += 1;
        continue;
      }
      if (codeUnit <= 0x7FF) {
        this.#accept(2);
        index += 1;
        continue;
      }
      if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
        const nextIndex = index + 1;
        if (nextIndex === text.length) {
          if (this.#byteLength + 3 > APPLICATION_ANSWER_MAX_RESPONSE_BYTES) {
            const error = invalidOutput();
            this.onExceeded(error);
            throw error;
          }
          this.#pendingHighSurrogate = true;
          return;
        }
        const next = text.charCodeAt(nextIndex);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          this.#accept(4);
          index += 2;
          continue;
        }
      }
      this.#accept(3);
      index += 1;
    }
  }

  flushTextBoundary(): void {
    if (this.#pendingHighSurrogate) {
      this.#pendingHighSurrogate = false;
      this.#accept(3);
    }
  }

  finish(): void {
    if (this.#finished) return;
    this.flushTextBoundary();
    this.#finished = true;
  }
}

async function readCompletedAnswer(
  stream: AsyncIterable<AssistantMessageEvent>,
  controller: AbortController,
): Promise<{ message: AssistantMessage; streamedByteLength: number }> {
  const byteCounter = new BoundedUtf8TextCounter((error) => controller.abort(error));
  let activeTextContentIndex: number | undefined;
  let completed: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "text_delta") {
      if (
        activeTextContentIndex !== undefined
        && activeTextContentIndex !== event.contentIndex
      ) {
        byteCounter.flushTextBoundary();
      }
      activeTextContentIndex = event.contentIndex;
      byteCounter.push(event.delta);
    }
    if (event.type === "text_end" && activeTextContentIndex === event.contentIndex) {
      byteCounter.flushTextBoundary();
      activeTextContentIndex = undefined;
    }
    if (event.type === "done") {
      if (completed !== undefined) throw invalidOutput();
      byteCounter.finish();
      completed = event.message;
    }
    if (event.type === "error") {
      throw new Error(
        event.error.errorMessage ?? `Application answer provider request ${event.reason}`,
      );
    }
  }
  byteCounter.finish();
  if (completed === undefined) throw invalidOutput();
  return { message: completed, streamedByteLength: byteCounter.byteLength };
}

function parseAnswer(
  message: AssistantMessage,
  streamedByteLength: number,
  controller: AbortController,
): string {
  if (
    message.stopReason !== "stop"
    || !Array.isArray(message.content)
    || message.content.length !== 1
    || message.content[0]?.type !== "text"
    || typeof message.content[0].text !== "string"
  ) {
    throw invalidOutput();
  }
  const text = message.content[0].text;
  const finalCounter = new BoundedUtf8TextCounter((error) => controller.abort(error));
  finalCounter.push(text);
  finalCounter.finish();
  if (finalCounter.byteLength !== streamedByteLength) throw invalidOutput();
  const response = ApplicationProfessionalizeResponseSchema.safeParse({ answer: text });
  if (!response.success) throw invalidOutput();
  return response.data.answer;
}

export async function professionalizeApplicationAnswer(
  question: string,
  request: ApplicationProfessionalizeRequest,
  signal?: AbortSignal,
  options: ApplicationAnswerProfessionalizerOptions = {},
): Promise<string> {
  signal?.throwIfAborted();
  const parsedQuestion = ApplicationAnswerSuggestionSchema.shape.question.parse(question);
  const parsedRequest = ApplicationProfessionalizeRequestSchema.parse(request);

  const combinedController = new AbortController();
  let timedOut = false;
  let rejectCallerAbort: ((reason?: unknown) => void) | undefined;
  const callerAbortPromise = signal
    ? new Promise<never>((_resolve, reject) => { rejectCallerAbort = reject; })
    : undefined;
  const onCallerAbort = (): void => {
    const reason = signal?.reason;
    combinedController.abort(reason);
    rejectCallerAbort?.(reason);
  };
  signal?.addEventListener("abort", onCallerAbort, { once: true });

  let rejectDeadline: ((reason?: unknown) => void) | undefined;
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    const error = new ApplicationAnswerProfessionalizationError(
      "timeout",
      "Application answer professionalization timed out",
    );
    combinedController.abort(error);
    rejectDeadline?.(error);
  }, options.deadlineMs ?? APPLICATION_ANSWER_PROFESSIONALIZATION_DEADLINE_MS);

  try {
    const sessionId = (options.sessionIdFactory
      ?? (() => `application-answer-${randomUUID()}`))();
    const resolverFactory = options.resolverFactory ?? createOAuthOnlyApiKeyResolver;
    const transport = options.transport
      ?? ((model, context, streamOptions) => streamSimple(model, context, streamOptions));
    const apiKey = resolverFactory(
      "openai-codex",
      sessionId,
      MODEL_NAME,
      combinedController.signal,
    );
    if (combinedController.signal.aborted) throw combinedController.signal.reason;

    const userMessage = {
      question: parsedQuestion,
      draft: parsedRequest.draft,
      ...(parsedRequest.instruction === undefined
        ? {}
        : { instruction: parsedRequest.instruction }),
    };
    const context: Context = {
      systemPrompt: [
        parsedRequest.instruction === undefined
          ? DEFAULT_SYSTEM_PROMPT
          : REVISION_SYSTEM_PROMPT,
      ],
      messages: [{
        role: "user",
        content: JSON.stringify(userMessage),
        timestamp: Date.now(),
      }],
    };
    const transportPromise = (async (): Promise<string> => {
      const completed = await readCompletedAnswer(
        transport(OMP_CODEX_MODEL, context, {
          apiKey,
          signal: combinedController.signal,
          reasoning: HIGH_EFFORT,
          sessionId,
          preferWebsockets: false,
          maxTokens: 4_096,
          loopGuard: { enabled: false },
          onPayload: (payload) => {
            if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
              throw new Error("Application answer provider payload is invalid");
            }
            return { ...payload, store: false };
          },
        }),
        combinedController,
      );
      return parseAnswer(
        completed.message,
        completed.streamedByteLength,
        combinedController,
      );
    })();
    void transportPromise.catch(() => undefined);
    const raceCandidates: Promise<string>[] = [transportPromise, deadlinePromise];
    if (callerAbortPromise) raceCandidates.push(callerAbortPromise);
    return await Promise.race(raceCandidates);
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (timedOut) {
      throw new ApplicationAnswerProfessionalizationError(
        "timeout",
        "Application answer professionalization timed out",
        { cause: error },
      );
    }
    const oauthError = recoverOAuthRequiredError(error);
    if (oauthError) throw oauthError;
    if (error instanceof ApplicationAnswerProfessionalizationError) throw error;
    throw new ApplicationAnswerProfessionalizationError(
      "unavailable",
      "Application answer professionalization failed",
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
    rejectCallerAbort = undefined;
    rejectDeadline = undefined;
  }
}
