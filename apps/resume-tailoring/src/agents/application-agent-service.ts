import {
  ApplicationAgentSteerRequestSchema,
  type ApplicationAgentSteerRequest,
  type AuthStatusResponse,
} from "../contracts";
import { getAuthStatus } from "../auth/service";
import {
  ApplicationAgentFailure,
  ApplicationAgentRunInputSchema,
  ApplicationRunResultSchema,
  runApplicationAgent,
  runNonJobApplicationAgent,
  type ApplicationAgentDependencies,
  type ApplicationAgentRunInput,
  type ApplicationRunResult,
  type ApplicationSubmissionGuard,
} from "./application-agent";
import type {
  ApplicationAgentTrace,
  ApplicationAgentTraceOutcome,
  ApplicationAgentTraceStore,
} from "./application-agent-traces.ts";
import {
  HttpApplicationRuntimeClient,
  type ApplicationRuntimeClient,
} from "./application-runtime-client";
import type { AgentRuntimeDependencies } from "./runner";
import {
  ApplicationAgentSteeringConflict,
  ApplicationAgentSteeringInbox,
} from "./application-agent-steering.ts";

export const APPLICATION_AGENT_MODEL_PROVIDER = "openai-codex" as const;
export const APPLICATION_AGENT_MODEL = "gpt-5.6-sol" as const;
export const APPLICATION_AGENT_REASONING = "high" as const;

export type ApplicationAgentDiagnosticCategory =
  | "aborted"
  | "connection_closed"
  | "context_overflow"
  | "invalid_response"
  | "network"
  | "provider_authentication"
  | "provider_error"
  | "rate_limited"
  | "stream_first_event_timeout"
  | "stream_idle_timeout"
  | "timeout"
  | "unknown";

export interface ApplicationAgentDiagnosticError {
  readonly name: string;
  readonly category: ApplicationAgentDiagnosticCategory;
  readonly code?: string;
}

export interface ApplicationAgentFailureDiagnostic {
  readonly event: "application_agent_failure";
  readonly sessionId: string;
  readonly phase: "agent_run";
  readonly errorChain: readonly ApplicationAgentDiagnosticError[];
}

export type ApplicationAgentDiagnosticSink = (
  diagnostic: ApplicationAgentFailureDiagnostic,
) => void | PromiseLike<void>;

const MAX_DIAGNOSTIC_CAUSE_DEPTH = 4;
const MAX_DIAGNOSTIC_CLASSIFICATION_CHARS = 2_048;
const SAFE_DIAGNOSTIC_CODES: Readonly<Record<string, true>> = Object.freeze({
  MODEL_PROVIDER_FAILED: true,
  ABORT_ERR: true,
  ECONNABORTED: true,
  ECONNREFUSED: true,
  ECONNRESET: true,
  EHOSTUNREACH: true,
  ENETUNREACH: true,
  EPIPE: true,
  ETIMEDOUT: true,
  UND_ERR_BODY_TIMEOUT: true,
  UND_ERR_CONNECT_TIMEOUT: true,
  UND_ERR_HEADERS_TIMEOUT: true,
  UND_ERR_SOCKET: true,
  context_length_exceeded: true,
  internal_error: true,
  model_error: true,
  model_failed: true,
  rate_limit_exceeded: true,
  server_error: true,
});
const SAFE_ERROR_NAMES: Readonly<Record<string, true>> = Object.freeze({
  AbortError: true,
  ApplicationAgentFailure: true,
  ApplicationRuntimeError: true,
  AggregateError: true,
  ApplicationHistoryProjectionError: true,
  CodexResponseError: true,
  DOMException: true,
  Error: true,
  FetchError: true,
  MaxTurnsExceededError: true,
  ModelBehaviorError: true,
  RangeError: true,
  RunError: true,
  SyntaxError: true,
  TimeoutError: true,
  ToolCallError: true,
  TypeError: true,
  ZodError: true,
});


function diagnosticCategory(
  message: string,
  code: string | undefined,
): ApplicationAgentDiagnosticCategory {
  if (
    code === "UND_ERR_BODY_TIMEOUT"
    || /sse stream stalled|idle timeout|timed out while waiting for (?:the )?next event/.test(message)
  ) {
    return "stream_idle_timeout";
  }
  if (
    code === "UND_ERR_HEADERS_TIMEOUT"
    || /sse stream timed out while waiting for (?:the )?first event|timeout waiting for (?:the )?first/.test(message)
  ) {
    return "stream_first_event_timeout";
  }
  if (
    code === "ECONNRESET"
    || code === "EPIPE"
    || code === "UND_ERR_SOCKET"
    || /socket hang up|socket connection was closed|connection (?:was )?closed|connection reset|broken pipe/.test(message)
  ) {
    return "connection_closed";
  }
  if (
    code === "rate_limit_exceeded"
    || /rate.?limit|too many requests|\b429\b/.test(message)
  ) {
    return "rate_limited";
  }
  if (
    /unauthori[sz]ed|forbidden|authentication|\b401\b|\b403\b|token (?:has )?expired/.test(message)
  ) {
    return "provider_authentication";
  }
  if (
    code === "context_length_exceeded"
    || /context (?:length|limit|overflow|window)|maximum context/.test(message)
  ) {
    return "context_overflow";
  }
  if (code === "ABORT_ERR" || /abort|cancel/.test(message)) return "aborted";
  if (
    code === "ETIMEDOUT"
    || code === "UND_ERR_CONNECT_TIMEOUT"
    || /timeout|timed out/.test(message)
  ) {
    return "timeout";
  }
  if (/invalid (?:model )?(?:output|response)|malformed|parse error|invalid json/.test(message)) {
    return "invalid_response";
  }
  if (
    code === "ECONNABORTED"
    || code === "ECONNREFUSED"
    || code === "EHOSTUNREACH"
    || code === "ENETUNREACH"
    || /network|fetch failed|connection refused|host unreachable/.test(message)
  ) {
    return "network";
  }
  if (
    code === "MODEL_PROVIDER_FAILED"
    || code === "model_failed"
    || code === "internal_error"
    || code === "model_error"
    || code === "server_error"
    || /provider.*(?:failed|error)|model error|server error|internal error|service unavailable|overloaded/.test(message)
  ) {
    return "provider_error";
  }
  return "unknown";
}

function diagnosticErrorChain(error: unknown): readonly ApplicationAgentDiagnosticError[] {
  const chain: ApplicationAgentDiagnosticError[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (
    current !== undefined
    && chain.length < MAX_DIAGNOSTIC_CAUSE_DEPTH
    && !seen.has(current)
  ) {
    seen.add(current);
    let name = "NonError";
    let message = "";
    let cause: unknown;
    let currentError: Error | undefined;
    try {
      if (current instanceof Error) currentError = current;
    } catch {
      currentError = undefined;
    }
    if (currentError !== undefined) {
      try {
        const candidateName = currentError.name;
        name = typeof candidateName === "string"
          && SAFE_ERROR_NAMES[candidateName] === true
          ? candidateName
          : "Error";
      } catch {
        name = "Error";
      }
      try {
        const candidateMessage = currentError.message;
        message = typeof candidateMessage === "string"
          ? candidateMessage.slice(0, MAX_DIAGNOSTIC_CLASSIFICATION_CHARS).toLowerCase()
          : "";
      } catch {
        message = "";
      }
      try {
        cause = currentError.cause;
      } catch {
        cause = undefined;
      }
    }
    let code: string | undefined;
    if (current !== null && typeof current === "object") {
      try {
        const candidate = "code" in current ? current.code : undefined;
        if (
          typeof candidate === "string"
          && SAFE_DIAGNOSTIC_CODES[candidate] === true
        ) {
          code = candidate;
        }
      } catch {
        code = undefined;
      }
    }
    chain.push({
      name,
      category: diagnosticCategory(message, code),
      ...(code === undefined ? {} : { code }),
    });
    current = cause;
  }
  return chain;
}

function defaultApplicationAgentDiagnosticSink(
  diagnostic: ApplicationAgentFailureDiagnostic,
): void {
  console.error(JSON.stringify(diagnostic));
}

function reportApplicationAgentFailure(
  sink: ApplicationAgentDiagnosticSink,
  sessionId: string,
  error: unknown,
): void {
  try {
    const result = sink({
      event: "application_agent_failure",
      sessionId,
      phase: "agent_run",
      errorChain: diagnosticErrorChain(error),
    });
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Diagnostics must never alter the fixed application failure response.
  }
}

export interface ApplicationAgentStatus {
  modelProvider: typeof APPLICATION_AGENT_MODEL_PROVIDER;
  model: typeof APPLICATION_AGENT_MODEL;
  reasoning: typeof APPLICATION_AGENT_REASONING;
  oauth: "connected";
}

export interface ApplicationAgentSuccess {
  modelProvider: typeof APPLICATION_AGENT_MODEL_PROVIDER;
  model: typeof APPLICATION_AGENT_MODEL;
  reasoning: typeof APPLICATION_AGENT_REASONING;
  result: ApplicationRunResult;
}

export type ApplicationAgentAuthStatusReader = () =>
  | Promise<AuthStatusResponse>
  | AuthStatusResponse;

export type ApplicationRuntimeClientFactory = (
  runtimeUrl: string,
  sessionId: string,
  bearerToken: string,
) => ApplicationRuntimeClient;

export type ApplicationSubmissionGuardFactory = (
  sessionId: string,
) => ApplicationSubmissionGuard;

export type ApplicationAgentRunner = (
  input: ApplicationAgentRunInput,
  signal: AbortSignal,
  dependencies: ApplicationAgentDependencies,
) => Promise<ApplicationRunResult>;

export interface ApplicationAgentServiceOptions {
  readonly authStatusReader?: ApplicationAgentAuthStatusReader;
  readonly runApplicationAgent?: ApplicationAgentRunner;
  readonly runNonJobApplicationAgent?: ApplicationAgentRunner;
  readonly runtimeClientFactory?: ApplicationRuntimeClientFactory;
  readonly submissionGuardFactory: ApplicationSubmissionGuardFactory;
  readonly agentRuntime?: AgentRuntimeDependencies;
  readonly diagnosticSink?: ApplicationAgentDiagnosticSink;
  readonly traceStore?: Pick<ApplicationAgentTraceStore, "start">;
}

export interface ApplicationAgentRouteService {
  status(signal?: AbortSignal): Promise<ApplicationAgentStatus> | ApplicationAgentStatus;
  invoke(
    input: ApplicationAgentRunInput,
    signal: AbortSignal,
  ): Promise<ApplicationAgentSuccess>;
  steer(
    sessionId: string,
    input: ApplicationAgentSteerRequest,
    signal: AbortSignal,
  ): void;
}

async function runAbortable<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = (): void => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = Promise.resolve().then(operation);
    return await Promise.race([result, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function reportApplicationAgentTraceFailure(
  sessionId: string,
  operation: "start" | "finish",
): void {
  try {
    console.error(JSON.stringify({
      event: "application_agent_trace_failure",
      sessionId,
      operation,
    }));
  } catch {
    // A private diagnostic failure must not change application execution.
  }
}

async function startApplicationAgentTrace(
  store: Pick<ApplicationAgentTraceStore, "start"> | undefined,
  input: ApplicationAgentRunInput,
): Promise<ApplicationAgentTrace | undefined> {
  if (store === undefined) return undefined;
  try {
    return await store.start({
      sessionId: input.sessionId,
      opportunityKind: input.opportunityKind,
      autoSubmit: input.autoSubmit,
    });
  } catch {
    reportApplicationAgentTraceFailure(input.sessionId, "start");
    return undefined;
  }
}

async function finishApplicationAgentTrace(
  trace: ApplicationAgentTrace | undefined,
  sessionId: string,
  outcome: ApplicationAgentTraceOutcome,
): Promise<void> {
  if (trace === undefined) return;
  try {
    await trace.finish(outcome);
  } catch {
    reportApplicationAgentTraceFailure(sessionId, "finish");
  }
}

export class ApplicationAgentService implements ApplicationAgentRouteService {
  readonly #harnessToken: string;
  readonly #authStatusReader: ApplicationAgentAuthStatusReader;
  readonly #runApplicationAgent: ApplicationAgentRunner;
  readonly #runNonJobApplicationAgent: ApplicationAgentRunner;
  readonly #runtimeClientFactory: ApplicationRuntimeClientFactory;
  readonly #submissionGuardFactory: ApplicationSubmissionGuardFactory;
  readonly #agentRuntime: AgentRuntimeDependencies;
  readonly #diagnosticSink: ApplicationAgentDiagnosticSink;
  readonly #traceStore: Pick<ApplicationAgentTraceStore, "start"> | undefined;
  readonly #steeringInboxes = new Map<string, ApplicationAgentSteeringInbox>();

  constructor(
    harnessToken: string,
    options: ApplicationAgentServiceOptions,
  ) {
    this.#harnessToken = harnessToken;
    this.#authStatusReader = options.authStatusReader ?? getAuthStatus;
    this.#runApplicationAgent = options.runApplicationAgent
      ?? runApplicationAgent;
    this.#runNonJobApplicationAgent = options.runNonJobApplicationAgent
      ?? runNonJobApplicationAgent;
    this.#runtimeClientFactory = options.runtimeClientFactory
      ?? ((runtimeUrl, sessionId, bearerToken) =>
        new HttpApplicationRuntimeClient(
          runtimeUrl,
          sessionId,
          bearerToken,
        ));
    this.#submissionGuardFactory = options.submissionGuardFactory;
    this.#agentRuntime = options.agentRuntime ?? {};
    this.#diagnosticSink = options.diagnosticSink
      ?? defaultApplicationAgentDiagnosticSink;
    this.#traceStore = options.traceStore;
  }

  async status(signal?: AbortSignal): Promise<ApplicationAgentStatus> {
    let status: AuthStatusResponse;
    try {
      status = signal === undefined
        ? await this.#authStatusReader()
        : await runAbortable(() => this.#authStatusReader(), signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof ApplicationAgentFailure) throw error;
      throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
    }
    signal?.throwIfAborted();
    const connected = status.providers.some(
      (provider) => provider.provider === APPLICATION_AGENT_MODEL_PROVIDER
        && provider.state === "connected",
    );
    if (!connected) throw new ApplicationAgentFailure("OAUTH_REQUIRED");
    return {
      modelProvider: APPLICATION_AGENT_MODEL_PROVIDER,
      model: APPLICATION_AGENT_MODEL,
      reasoning: APPLICATION_AGENT_REASONING,
      oauth: "connected",
    };
  }

  steer(
    sessionId: string,
    unparsedInput: ApplicationAgentSteerRequest,
    signal: AbortSignal,
  ): void {
    const parsedSessionId = ApplicationAgentRunInputSchema.shape.sessionId.safeParse(
      sessionId,
    );
    const parsedInput = ApplicationAgentSteerRequestSchema.safeParse(unparsedInput);
    if (!parsedSessionId.success || !parsedInput.success) {
      throw new ApplicationAgentFailure("INVALID_REQUEST");
    }
    signal.throwIfAborted();
    const inbox = this.#steeringInboxes.get(parsedSessionId.data);
    if (inbox === undefined || !inbox.enqueue(parsedInput.data.message)) {
      throw new ApplicationAgentSteeringConflict();
    }
    signal.throwIfAborted();
  }

  async invoke(
    unparsedInput: ApplicationAgentRunInput,
    signal: AbortSignal,
  ): Promise<ApplicationAgentSuccess> {
    const parsedInput = ApplicationAgentRunInputSchema.safeParse(unparsedInput);
    if (!parsedInput.success) {
      throw new ApplicationAgentFailure("INVALID_REQUEST");
    }
    const input = parsedInput.data;
    signal.throwIfAborted();
    if (this.#steeringInboxes.has(input.sessionId)) {
      throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
    }
    const steeringInbox = new ApplicationAgentSteeringInbox();
    this.#steeringInboxes.set(input.sessionId, steeringInbox);
    try {
      try {
        await this.status(signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw error;
      }
      signal.throwIfAborted();
      const trace = await startApplicationAgentTrace(this.#traceStore, input);
      let result: ApplicationRunResult;
      try {
        signal.throwIfAborted();
        const runtimeClient = this.#runtimeClientFactory(
          input.runtimeUrl,
          input.sessionId,
          this.#harnessToken,
        );
        const submissionGuard = this.#submissionGuardFactory(input.sessionId);
        const runner = input.opportunityKind === "job"
          ? this.#runApplicationAgent
          : this.#runNonJobApplicationAgent;
        const unparsedResult = await runner(input, signal, {
          ...this.#agentRuntime,
          runtimeClient,
          submissionGuard,
          steeringInbox,
          ...(trace === undefined ? {} : { modelTraceSink: trace }),
        });
        signal.throwIfAborted();
        const parsedResult = ApplicationRunResultSchema.safeParse(unparsedResult);
        if (!parsedResult.success) {
          throw new ApplicationAgentFailure("INVALID_MODEL_OUTPUT");
        }
        result = parsedResult.data;
        await finishApplicationAgentTrace(trace, input.sessionId, {
          status: "completed",
        });
      } catch (error) {
        await finishApplicationAgentTrace(trace, input.sessionId, {
          status: "failed",
          error,
        });
        if (signal.aborted) throw signal.reason;
        if (error instanceof ApplicationAgentFailure) {
          if (error.code === "MODEL_PROVIDER_FAILED") {
            reportApplicationAgentFailure(
              this.#diagnosticSink,
              input.sessionId,
              error,
            );
          }
          throw error;
        }
        let oauthConnected = false;
        try {
          const currentStatus = await runAbortable(
            () => this.#authStatusReader(),
            signal,
          );
          signal.throwIfAborted();
          oauthConnected = currentStatus.providers.some(
            (provider) => provider.provider === APPLICATION_AGENT_MODEL_PROVIDER
              && provider.state === "connected",
          );
        } catch {
          if (signal.aborted) throw signal.reason;
          reportApplicationAgentFailure(
            this.#diagnosticSink,
            input.sessionId,
            error,
          );
          throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
        }
        if (!oauthConnected) throw new ApplicationAgentFailure("OAUTH_REQUIRED");
        reportApplicationAgentFailure(
          this.#diagnosticSink,
          input.sessionId,
          error,
        );
        throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
      }
      return {
        modelProvider: APPLICATION_AGENT_MODEL_PROVIDER,
        model: APPLICATION_AGENT_MODEL,
        reasoning: APPLICATION_AGENT_REASONING,
        result,
      };
    } finally {
      steeringInbox.close();
      if (this.#steeringInboxes.get(input.sessionId) === steeringInbox) {
        this.#steeringInboxes.delete(input.sessionId);
      }
    }
  }
}
