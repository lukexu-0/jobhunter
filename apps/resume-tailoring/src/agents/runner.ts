import {
  Runner,
  setTracingDisabled,
  type Agent,
  type CallModelInputFilter,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ModelRetryAdvice,
  type ModelRetryAdviceRequest,
  type ModelProvider,
  type StreamEvent,
} from "@openai/agents-core";
import { OAuthCodexModelProvider } from "../models/oauth-codex-provider.ts";

export const ATS_KEYWORD_EXTRACTION_DEADLINE_MS = 10 * 60 * 1_000;
export const ANALYSIS_DEADLINE_MS = 100 * 60 * 1_000;
export const REPAIR_DEADLINE_MS = 50 * 60 * 1_000;
export const TAILORING_DEADLINE_MS = 75 * 60 * 1_000;
export const EDIT_DEADLINE_MS = 75 * 60 * 1_000;
export const MAX_AGENT_INPUT_BYTES = 1024 * 1024;
export const MAX_AGENT_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

let tracingBootstrapped = false;

export function bootstrapAgentRuntime(): void {
  if (tracingBootstrapped) return;
  setTracingDisabled(true);
  tracingBootstrapped = true;
}

export interface AgentRunOptions<TContext> {
  maxTurns: number | null;
  signal: AbortSignal;
  context?: TContext;
  callModelInputFilter?: CallModelInputFilter<TContext>;
  assertTranscript?: (result: unknown) => void;
}

export interface AgentRunner {
  run<TContext>(
    agent: Agent<TContext, "text">,
    input: string,
    options: AgentRunOptions<TContext>,
  ): Promise<unknown>;
}

export type ModelProviderFactory = (attemptSessionId: string) => ModelProvider;
export type AgentRunnerFactory = (config: {
  modelProvider: ModelProvider;
  tracingDisabled: true;
  toolExecution: { maxFunctionToolConcurrency: 1 };
}) => AgentRunner;

export interface ModelTraceError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string | number;
  readonly cause?: ModelTraceError;
}

export type ModelTraceEvent =
  | {
      readonly type: "model_request";
      readonly model?: string;
      readonly request: Omit<ModelRequest, "signal">;
    }
  | {
      readonly type: "model_response";
      readonly model?: string;
      readonly response: ModelResponse;
    }
  | {
      readonly type: "model_stream_event";
      readonly model?: string;
      readonly event: StreamEvent;
    }
  | {
      readonly type: "model_error";
      readonly model?: string;
      readonly error: ModelTraceError;
    };

export interface ModelTraceSink {
  record(event: ModelTraceEvent): void | PromiseLike<void>;
}

const MAX_MODEL_TRACE_ERROR_DEPTH = 4;
const MAX_MODEL_TRACE_ERROR_TEXT_CHARS = 8_192;

function boundedModelTraceErrorText(value: string): string {
  return value.length <= MAX_MODEL_TRACE_ERROR_TEXT_CHARS
    ? value
    : `${value.slice(0, MAX_MODEL_TRACE_ERROR_TEXT_CHARS)}[truncated]`;
}


function modelTraceError(
  value: unknown,
  seen = new Set<unknown>(),
  depth = 0,
): ModelTraceError {
  try {
    if (depth >= MAX_MODEL_TRACE_ERROR_DEPTH) {
      return { name: "ErrorCauseLimit", message: "Additional error causes omitted" };
    }
    if (!(value instanceof Error)) {
      return {
        name: "NonError",
        message: boundedModelTraceErrorText(String(value)),
      };
    }
    const name = boundedModelTraceErrorText(value.name || "Error");
    if (seen.has(value)) {
      return { name, message: "[circular error cause]" };
    }
    seen.add(value);
    let code: string | number | undefined;
    try {
      const candidate = "code" in value ? value.code : undefined;
      if (typeof candidate === "string") {
        code = boundedModelTraceErrorText(candidate);
      } else if (typeof candidate === "number") {
        code = candidate;
      }
    } catch {
      code = undefined;
    }
    let cause: unknown;
    try {
      cause = value.cause;
    } catch {
      cause = undefined;
    }
    const stack = value.stack;
    return {
      name,
      message: boundedModelTraceErrorText(value.message),
      ...(stack === undefined
        ? {}
        : { stack: boundedModelTraceErrorText(stack) }),
      ...(code === undefined ? {} : { code }),
      ...(cause === undefined
        ? {}
        : { cause: modelTraceError(cause, seen, depth + 1) }),
    };
  } catch {
    return {
      name: "UninspectableError",
      message: "Model error details could not be inspected",
    };
  }
}

async function recordModelTrace(
  sink: ModelTraceSink,
  event: ModelTraceEvent,
): Promise<void> {
  try {
    await sink.record(event);
  } catch {
    // Local diagnostics must not change the model call or its public failure.
  }
}

class ModelTraceModel implements Model {
  readonly #modelName: string | undefined;
  readonly #model: Model;
  readonly #sink: ModelTraceSink;

  constructor(modelName: string | undefined, model: Model, sink: ModelTraceSink) {
    this.#modelName = modelName;
    this.#model = model;
    this.#sink = sink;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const { signal: _signal, ...persistedRequest } = request;
    await recordModelTrace(this.#sink, {
      type: "model_request",
      ...(this.#modelName === undefined ? {} : { model: this.#modelName }),
      request: persistedRequest,
    });
    try {
      const response = await this.#model.getResponse(request);
      await recordModelTrace(this.#sink, {
        type: "model_response",
        ...(this.#modelName === undefined ? {} : { model: this.#modelName }),
        response,
      });
      return response;
    } catch (error) {
      await recordModelTrace(this.#sink, {
        type: "model_error",
        ...(this.#modelName === undefined ? {} : { model: this.#modelName }),
        error: modelTraceError(error),
      });
      throw error;
    }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const { signal: _signal, ...persistedRequest } = request;
    await recordModelTrace(this.#sink, {
      type: "model_request",
      ...(this.#modelName === undefined ? {} : { model: this.#modelName }),
      request: persistedRequest,
    });
    try {
      for await (const event of this.#model.getStreamedResponse(request)) {
        await recordModelTrace(this.#sink, {
          type: "model_stream_event",
          ...(this.#modelName === undefined ? {} : { model: this.#modelName }),
          event,
        });
        yield event;
      }
    } catch (error) {
      await recordModelTrace(this.#sink, {
        type: "model_error",
        ...(this.#modelName === undefined ? {} : { model: this.#modelName }),
        error: modelTraceError(error),
      });
      throw error;
    }
  }

  getRetryAdvice(
    request: ModelRetryAdviceRequest,
  ): Promise<ModelRetryAdvice | undefined> | ModelRetryAdvice | undefined {
    return this.#model.getRetryAdvice?.(request);
  }
}

class ModelTraceProvider implements ModelProvider {
  readonly #provider: ModelProvider;
  readonly #sink: ModelTraceSink;

  constructor(provider: ModelProvider, sink: ModelTraceSink) {
    this.#provider = provider;
    this.#sink = sink;
  }

  async getModel(modelName?: string): Promise<Model> {
    const model = await this.#provider.getModel(modelName);
    return new ModelTraceModel(modelName, model, this.#sink);
  }
}


export interface AgentRuntimeDependencies {
  readonly providerFactory?: ModelProviderFactory;
  readonly runnerFactory?: AgentRunnerFactory;
  readonly modelTraceSink?: ModelTraceSink;
}

function defaultProviderFactory(attemptSessionId: string): ModelProvider {
  return new OAuthCodexModelProvider(attemptSessionId);
}

function defaultRunnerFactory(config: {
  modelProvider: ModelProvider;
  tracingDisabled: true;
  toolExecution: { maxFunctionToolConcurrency: 1 };
}): AgentRunner {
  return new Runner(config);
}

export function createAttemptRunner(
  attemptSessionId: string,
  dependencies: AgentRuntimeDependencies = {},
): AgentRunner {
  bootstrapAgentRuntime();
  const sourceProvider = (dependencies.providerFactory ?? defaultProviderFactory)(attemptSessionId);
  const modelProvider = dependencies.modelTraceSink === undefined
    ? sourceProvider
    : new ModelTraceProvider(sourceProvider, dependencies.modelTraceSink);
  return (dependencies.runnerFactory ?? defaultRunnerFactory)({
    modelProvider,
    tracingDisabled: true,
    toolExecution: { maxFunctionToolConcurrency: 1 },
  });
}

export function boundedJson(value: unknown, label: string, maxBytes = MAX_AGENT_INPUT_BYTES): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} must be JSON serializable`, { cause: error });
  }
  if (serialized === undefined) throw new Error(`${label} must be JSON serializable`);
  if (Buffer.byteLength(serialized) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return serialized;
}

export function assertBoundedTranscript(
  result: unknown,
  maxBytes = MAX_AGENT_TRANSCRIPT_BYTES,
): void {
  if (result !== null && typeof result === "object") {
    const transcript = {
      rawResponses: "rawResponses" in result ? result.rawResponses : undefined,
      newItems: "newItems" in result ? result.newItems : undefined,
      finalOutput: "finalOutput" in result ? result.finalOutput : undefined,
    };
    boundedJson(transcript, "agent transcript", maxBytes);
    return;
  }
  boundedJson(result, "agent transcript", maxBytes);
}

export class AgentDeadlineError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`agent attempt exceeded ${deadlineMs}ms deadline`);
    this.name = "AgentDeadlineError";
  }
}

export async function runWithDeadline<TContext>(
  runner: AgentRunner,
  agent: Agent<TContext, "text">,
  input: string,
  maxTurns: number | null,
  outerSignal: AbortSignal,
  deadlineMs: number,
  additionalOptions: Pick<
    AgentRunOptions<TContext>,
    "context" | "callModelInputFilter" | "assertTranscript"
  > = {},
): Promise<unknown> {
  if (outerSignal.aborted) throw outerSignal.reason ?? new DOMException("Aborted", "AbortError");
  const controller = new AbortController();
  const deadlineError = new AgentDeadlineError(deadlineMs);
  const gate = Promise.withResolvers<never>();
  const abortFromOuter = (): void => {
    const reason = outerSignal.reason ?? new DOMException("Aborted", "AbortError");
    controller.abort(reason);
    gate.reject(reason);
  };
  outerSignal.addEventListener("abort", abortFromOuter, { once: true });
  const timeout = globalThis.setTimeout(() => {
    controller.abort(deadlineError);
    gate.reject(deadlineError);
  }, deadlineMs);
  const runOptions: AgentRunOptions<TContext> = { maxTurns, signal: controller.signal };
  if (additionalOptions.context !== undefined) runOptions.context = additionalOptions.context;
  if (additionalOptions.callModelInputFilter !== undefined) {
    runOptions.callModelInputFilter = additionalOptions.callModelInputFilter;
  }
  if (additionalOptions.assertTranscript !== undefined) {
    runOptions.assertTranscript = additionalOptions.assertTranscript;
  }
  const runPromise = runner.run(agent, input, runOptions);
  try {
    const result = await Promise.race([runPromise, gate.promise]);
    (runOptions.assertTranscript ?? assertBoundedTranscript)(result);
    return result;
  } catch (error) {
    if (controller.signal.aborted) void runPromise.then(() => undefined, () => undefined);
    if (controller.signal.reason === deadlineError) throw deadlineError;
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    outerSignal.removeEventListener("abort", abortFromOuter);
  }
}
