import type { AuthStatusResponse } from "../contracts";
import { getAuthStatus } from "../auth/service";
import {
  ApplicationAgentFailure,
  ApplicationAgentRunInputSchema,
  ApplicationRunResultSchema,
  runApplicationAgent,
  type ApplicationAgentDependencies,
  type ApplicationAgentRunInput,
  type ApplicationRunResult,
  type ApplicationSubmissionGuard,
} from "./application-agent";
import {
  HttpApplicationRuntimeClient,
  type ApplicationRuntimeClient,
} from "./application-runtime-client";
import type { AgentRuntimeDependencies } from "./runner";

export const APPLICATION_AGENT_MODEL_PROVIDER = "openai-codex" as const;
export const APPLICATION_AGENT_MODEL = "gpt-5.6-sol" as const;
export const APPLICATION_AGENT_REASONING = "high" as const;

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
  readonly runtimeClientFactory?: ApplicationRuntimeClientFactory;
  readonly submissionGuardFactory: ApplicationSubmissionGuardFactory;
  readonly agentRuntime?: AgentRuntimeDependencies;
}

export interface ApplicationAgentRouteService {
  status(signal?: AbortSignal): Promise<ApplicationAgentStatus> | ApplicationAgentStatus;
  invoke(
    input: ApplicationAgentRunInput,
    signal: AbortSignal,
  ): Promise<ApplicationAgentSuccess>;
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

export class ApplicationAgentService implements ApplicationAgentRouteService {
  readonly #harnessToken: string;
  readonly #authStatusReader: ApplicationAgentAuthStatusReader;
  readonly #runApplicationAgent: ApplicationAgentRunner;
  readonly #runtimeClientFactory: ApplicationRuntimeClientFactory;
  readonly #submissionGuardFactory: ApplicationSubmissionGuardFactory;
  readonly #agentRuntime: AgentRuntimeDependencies;

  constructor(
    harnessToken: string,
    options: ApplicationAgentServiceOptions,
  ) {
    this.#harnessToken = harnessToken;
    this.#authStatusReader = options.authStatusReader ?? getAuthStatus;
    this.#runApplicationAgent = options.runApplicationAgent
      ?? runApplicationAgent;
    this.#runtimeClientFactory = options.runtimeClientFactory
      ?? ((runtimeUrl, sessionId, bearerToken) =>
        new HttpApplicationRuntimeClient(runtimeUrl, sessionId, bearerToken));
    this.#submissionGuardFactory = options.submissionGuardFactory;
    this.#agentRuntime = options.agentRuntime ?? {};
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
    try {
      await this.status(signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    }
    signal.throwIfAborted();
    let result: ApplicationRunResult;
    try {
      const runtimeClient = this.#runtimeClientFactory(
        input.runtimeUrl,
        input.sessionId,
        this.#harnessToken,
      );
      const submissionGuard = this.#submissionGuardFactory(input.sessionId);
      const unparsedResult = await this.#runApplicationAgent(input, signal, {
        ...this.#agentRuntime,
        runtimeClient,
        submissionGuard,
      });
      signal.throwIfAborted();
      const parsedResult = ApplicationRunResultSchema.safeParse(unparsedResult);
      if (!parsedResult.success) {
        throw new ApplicationAgentFailure("INVALID_MODEL_OUTPUT");
      }
      result = parsedResult.data;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ApplicationAgentFailure) throw error;
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
        throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
      }
      if (!oauthConnected) throw new ApplicationAgentFailure("OAUTH_REQUIRED");
      throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
    }
    return {
      modelProvider: APPLICATION_AGENT_MODEL_PROVIDER,
      model: APPLICATION_AGENT_MODEL,
      reasoning: APPLICATION_AGENT_REASONING,
      result,
    };
  }
}
