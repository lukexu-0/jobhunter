import { ApplicationAgentFailure, type ApplicationSubmissionGuard } from "./agent-runtime/contracts/application.ts";
import { runApplicationAgent } from "./agent-runtime/run.ts";
import { ApplicationAgentSteeringInbox } from "./agent-runtime/application-agent-steering.ts";
import {
  resolveApplicationModel,
  type ApplicationModel,
} from "../models/application-model.ts";
import { ApplicationRunResultSchema, HttpApplicationRuntimeClient, type ApplicationRunResult } from "./application-runtime-client.ts";
import type { AgentRuntimeDependencies } from "./agent-runtime/runner.ts";
import {
  assertProviderOAuthConnected,
  getAuthStorage,
} from "../auth/storage.ts";
import {
  normalizeSteerMessage,
  type OpportunityKind,
} from "../contracts/models.ts";

export type ApplicationModelMetadata = ApplicationModel;

export interface ApplicationRunOptions {
  readonly runtimeUrl: string;
  readonly opportunityKind: OpportunityKind;
  readonly autoSubmit: boolean;
  readonly task: string;
  readonly deadlineMs: number | null;
}

export type ApplicationAgentErrorCode =
  | "application_mismatch"
  | "browser_failed"
  | "command_conflict"
  | "invalid_model_output"
  | "invalid_request"
  | "model_failed"
  | "oauth_required"
  | "usage_exhausted";

const ERROR_MESSAGES: Readonly<Record<ApplicationAgentErrorCode, string>> = {
  application_mismatch: "The open page does not match the requested job",
  browser_failed: "The browser session failed",
  command_conflict: "The application session state changed",
  invalid_model_output: "The model returned invalid output",
  invalid_request: "Request is invalid",
  model_failed: "The model request failed",
  oauth_required: "Connect the configured application model provider in Credentials",
  usage_exhausted: "The model provider's usage quota is exhausted",
};

const FAILURE_CODES: Readonly<Record<string, ApplicationAgentErrorCode>> = {
  APPLICATION_MISMATCH: "application_mismatch",
  BROWSER_FAILED: "browser_failed",
  INVALID_MODEL_OUTPUT: "invalid_model_output",
  INVALID_REQUEST: "invalid_request",
  MODEL_PROVIDER_FAILED: "model_failed",
  OAUTH_REQUIRED: "oauth_required",
  USAGE_EXHAUSTED: "usage_exhausted",
};

export class ApplicationAgentError extends Error {
  readonly publicMessage: string;

  constructor(readonly code: ApplicationAgentErrorCode, options?: ErrorOptions) {
    super(ERROR_MESSAGES[code], options);
    this.name = "ApplicationAgentError";
    this.publicMessage = ERROR_MESSAGES[code];
  }
}

export interface LocalApplicationAgentOptions {
  readonly sessionId: string;
  readonly bearerToken: string;
  readonly submissionGuard: ApplicationSubmissionGuard;
  readonly modelReader?: () => ApplicationModel | Promise<ApplicationModel>;
  readonly agentRuntime?: AgentRuntimeDependencies;
}

function rethrowCancellation(error: unknown): void {
  if (error instanceof DOMException && error.name === "AbortError") throw error;
}

function mappedFailure(error: unknown): ApplicationAgentError {
  if (error instanceof ApplicationAgentError) return error;
  if (error instanceof ApplicationAgentFailure) {
    return new ApplicationAgentError(FAILURE_CODES[error.code] ?? "model_failed", { cause: error });
  }
  return new ApplicationAgentError("model_failed", { cause: error });
}

export class LocalApplicationAgent {
  readonly #sessionId: string;
  readonly #bearerToken: string;
  readonly #submissionGuard: ApplicationSubmissionGuard;
  readonly #modelReader: () => ApplicationModel | Promise<ApplicationModel>;
  readonly #agentRuntime: AgentRuntimeDependencies;
  #metadata: ApplicationModel | undefined;
  #activeController: AbortController | undefined;
  #steeringInbox: ApplicationAgentSteeringInbox | undefined;
  #closed = false;

  constructor(options: LocalApplicationAgentOptions) {
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(options.sessionId)) {
      throw new TypeError("session_id must be a UUID");
    }
    if ([...options.bearerToken].length < 32 || options.bearerToken.includes("\0")) {
      throw new TypeError("bearer_token must contain at least 32 characters");
    }
    this.#sessionId = options.sessionId;
    this.#bearerToken = options.bearerToken;
    this.#submissionGuard = options.submissionGuard;
    this.#modelReader = options.modelReader ?? (() => resolveApplicationModel(process.env.JOBHUNT_APPLICATION_MODEL));
    this.#agentRuntime = options.agentRuntime ?? {};
  }

  get modelMetadata(): ApplicationModelMetadata {
    if (this.#metadata === undefined) throw new ApplicationAgentError("model_failed");
    return this.#metadata;
  }

  async checkReady(): Promise<void> {
    this.#assertOpen();
    try {
      const model = await this.#modelReader();
      const storage = await getAuthStorage();
      assertProviderOAuthConnected(storage, model.modelProvider);
      this.#metadata = model;
    } catch (error) {
      rethrowCancellation(error);
      throw new ApplicationAgentError("oauth_required", { cause: error });
    }
  }

  async run(options: ApplicationRunOptions): Promise<ApplicationRunResult> {
    this.#assertOpen();
    if (this.#activeController !== undefined) throw new ApplicationAgentError("command_conflict");
    await this.checkReady();
    const model = this.#metadata!;
    const controller = new AbortController();
    const inbox = new ApplicationAgentSteeringInbox();
    this.#activeController = controller;
    this.#steeringInbox = inbox;
    try {
      const result = await runApplicationAgent({
        sessionId: this.#sessionId,
        ...options,
      }, controller.signal, {
        ...this.#agentRuntime,
        applicationModel: model,
        runtimeClient: new HttpApplicationRuntimeClient(
          options.runtimeUrl,
          this.#sessionId,
          this.#bearerToken,
        ),
        submissionGuard: this.#submissionGuard,
        steeringInbox: inbox,
      });
      return ApplicationRunResultSchema.parse(result);
    } catch (error) {
      rethrowCancellation(error);
      throw mappedFailure(error);
    } finally {
      inbox.close();
      this.#steeringInbox = undefined;
      this.#activeController = undefined;
    }
  }

  async steer(message: string): Promise<void> {
    this.#assertOpen();
    const normalized = normalizeSteerMessage(message);
    if (!this.#steeringInbox?.enqueue(normalized)) {
      throw new ApplicationAgentError("command_conflict");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#steeringInbox?.close();
    this.#activeController?.abort(new DOMException("Application agent closed", "AbortError"));
  }

  #assertOpen(): void {
    if (this.#closed) throw new ApplicationAgentError("model_failed");
  }
}
