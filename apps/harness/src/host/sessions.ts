import { randomUUID } from "node:crypto";

import { HarnessServiceError, type UploadLike } from "./artifacts.ts";
import { SessionEventStream, type SessionEvent } from "./events.ts";
import {
  ApplicationRunResultSchema,
  SessionCommandSchema,
  SessionCreateResponseSchema,
  SessionSnapshotSchema,
  SESSION_ERROR_MESSAGES,
  sessionError,
  validateJobUrl,
  type ApplicationRunResult,
  type ErrorCode,
  type OpportunityKind,
  type SessionCommand,
  type SessionCreateResponse,
  type SessionSnapshot,
} from "../contracts/models.ts";
import { ApplicationAgentError } from "../application/application-agent.ts";

const CAPACITY = 8;
const CAPACITY_MESSAGE = "Eight application sessions are already active";
const NOT_FOUND_MESSAGE = "Session not found";

export interface SessionCreateInput {
  sessionId?: string;
  jobUrl: string;
  opportunityKind: OpportunityKind;
  autoSubmit: boolean;
  autoEnd: boolean;
  personalInformation: UploadLike;
  resume: UploadLike;
  resumeSource: UploadLike;
  context: readonly UploadLike[];
  anecdotes: readonly UploadLike[];
  transcript?: UploadLike;
}

export type SessionWorkerRequest =
  | { type: "open_browser" }
  | { type: "command"; command: SessionCommand }
  | { type: "runtime_action"; action: unknown; modelAction: boolean }
  | { type: "suggestions"; questionId: string };

export interface SessionWorker {
  readonly modelMetadata: {
    model_provider: "openai-codex" | "google-antigravity";
    model: "gpt-5.6-sol" | "gemini-3.8-flash";
    reasoning: "medium" | "high";
  };
  run(recoveryGuidance?: readonly string[]): Promise<ApplicationRunResult>;
  invoke(request: SessionWorkerRequest): Promise<unknown>;
  close(): Promise<void>;
}

export interface SessionWorkerContext {
  readonly sessionId: string;
  readonly slot: number;
  readonly input: SessionCreateInput;
  transition(
    state: SessionSnapshot["state"],
    event: string | null,
    detail?: Readonly<Record<string, unknown>>,
    patch?: Partial<SessionSnapshot>,
  ): void;
  markSubmissionStarted(): void;
}

export interface ApplicationSessionManagerOptions {
  origin: string;
  workerFactory(context: SessionWorkerContext): Promise<SessionWorker>;
  startup?: () => Promise<void>;
  exclusiveOwner?: () => string | null;
  now?: () => Date;
}

interface RecoveryState {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly guidance: string[];
  resumed: boolean;
}

interface SessionRecord {
  readonly sessionId: string;
  readonly input: SessionCreateInput;
  readonly slot: number;
  snapshot: SessionSnapshot;
  readonly events: SessionEventStream<SessionSnapshot>;
  worker?: SessionWorker;
  workerRun?: Promise<void>;
  finalizer?: Promise<void>;
  submissionStarted: boolean;
  recovery?: RecoveryState;
}

export class ApplicationSessionManager {
  readonly #origin: string;
  readonly #workerFactory: (context: SessionWorkerContext) => Promise<SessionWorker>;
  readonly #now: () => Date;
  readonly #startupCallback: (() => Promise<void>) | undefined;
  readonly #exclusiveOwner: () => string | null;
  #startupPromise: Promise<void> | undefined;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #tombstones = new Map<string, SessionSnapshot>();
  #shuttingDown = false;

  constructor(options: ApplicationSessionManagerOptions) {
    const origin = new URL(options.origin);
    if (
      origin.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "::1"].includes(origin.hostname) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      throw new TypeError("origin must be a loopback HTTP origin");
    }
    this.#origin = origin.origin;
    this.#workerFactory = options.workerFactory;
    this.#startupCallback = options.startup;
    this.#exclusiveOwner = options.exclusiveOwner ?? (() => null);
    this.#now = options.now ?? (() => new Date());
  }

  get activeSessionCount(): number {
    return this.#sessions.size;
  }

  hasActiveSessions(): boolean {
    return this.#sessions.size > 0;
  }

  async startup(): Promise<void> {
    this.#startupPromise ??= this.#startupCallback?.() ?? Promise.resolve();
    await this.#startupPromise;
  }

  async create(input: SessionCreateInput): Promise<SessionCreateResponse> {
    await this.startup();
    if (this.#shuttingDown) {
      throw new HarnessServiceError(
        503,
        "service_unavailable",
        "The browser harness is shutting down",
      );
    }

    let jobUrl: string;
    try {
      jobUrl = validateJobUrl(input.jobUrl);
      if (typeof input.autoSubmit !== "boolean" || typeof input.autoEnd !== "boolean") {
        throw new TypeError("application flags are invalid");
      }
    } catch {
      throw new HarnessServiceError(422, "invalid_request", "Request is invalid");
    }

    const exclusiveOwner = this.#exclusiveOwner();
    if (exclusiveOwner !== null) {
      throw new HarnessServiceError(409, "session_active", "A browser session is already active", exclusiveOwner);
    }

    const requestedId = input.sessionId;
    const sessionId = requestedId ?? randomUUID();
    if (requestedId && this.#tombstones.has(requestedId)) {
      throw new HarnessServiceError(
        409,
        "session_terminal",
        "The application session has already ended",
      );
    }
    const existing = this.#sessions.get(sessionId);
    if (existing) return this.#createResponse(existing.sessionId);
    if (this.#sessions.size >= CAPACITY) {
      throw new HarnessServiceError(409, "session_capacity", CAPACITY_MESSAGE);
    }

    const usedSlots = new Set([...this.#sessions.values()].map((record) => record.slot));
    let slot = 0;
    while (usedSlots.has(slot)) slot += 1;
    const now = this.#now().toISOString();
    const initialUrl = new URL(jobUrl);
    initialUrl.pathname = "/";
    initialUrl.search = "";
    initialUrl.hash = "";
    let record!: SessionRecord;
    const snapshot = SessionSnapshotSchema.parse({
      session_id: sessionId,
      state: "starting",
      created_at: now,
      updated_at: now,
      expires_at: null,
      job_url: initialUrl.toString(),
    });
    record = {
      sessionId,
      input: { ...input, jobUrl },
      slot,
      snapshot,
      events: new SessionEventStream(() => structuredClone(record.snapshot)),
      submissionStarted: false,
    };
    this.#sessions.set(sessionId, record);

    try {
      const worker = await this.#workerFactory({
        sessionId,
        slot,
        input: record.input,
        transition: (state, event, detail = {}, patch = {}) => {
          this.#transition(record, state, event, detail, patch);
        },
        markSubmissionStarted: () => {
          if (record.submissionStarted) return;
          record.submissionStarted = true;
          this.#transition(record, "submitting", "submission_started");
        },
      });
      record.worker = worker;
      this.#transition(record, "running", "session_started", {}, worker.modelMetadata);
      record.workerRun = this.#runWorker(record, worker);
    } catch (error) {
      if (error instanceof HarnessServiceError) {
        await this.#finalize(record, "failed", "browser_failed");
        throw error;
      }
      if (error instanceof ApplicationAgentError) {
        const code = this.#agentFailureCode(error);
        await this.#finalize(record, "failed", code);
        const statuses: Readonly<Record<ErrorCode, number>> = {
          oauth_required: 409, pipeline_unavailable: 503, model_timeout: 504,
          invalid_model_output: 502, usage_exhausted: 429, model_failed: 502,
          browser_failed: 502, application_mismatch: 409, session_timeout: 504,
        };
        throw new HarnessServiceError(statuses[code], code, SESSION_ERROR_MESSAGES[code]);
      }
      await this.#finalize(record, "failed", "browser_failed");
      throw new HarnessServiceError(503, "browser_failed", "The browser session failed");
    }

    return this.#createResponse(sessionId);
  }

  getSnapshot(sessionId: string): SessionSnapshot {
    const record = this.#sessions.get(sessionId);
    const snapshot = record?.snapshot ?? this.#tombstones.get(sessionId);
    if (!snapshot) throw new HarnessServiceError(404, "session_not_found", NOT_FOUND_MESSAGE);
    return structuredClone(snapshot);
  }

  eventsAfter(sessionId: string, lastEventId?: number | null): readonly SessionEvent<SessionSnapshot>[] {
    const record = this.#sessions.get(sessionId);
    if (!record) {
      if (this.#tombstones.has(sessionId)) return [];
      throw new HarnessServiceError(404, "session_not_found", NOT_FOUND_MESSAGE);
    }
    return record.events.replayAfter(lastEventId);
  }

  subscribeEvents(sessionId: string, lastEventId?: number | null): ReadableStream<SessionEvent<SessionSnapshot>> {
    const record = this.#sessions.get(sessionId);
    if (record) return record.events.subscribe(lastEventId);
    const tombstone = this.#tombstones.get(sessionId);
    if (!tombstone) throw new HarnessServiceError(404, "session_not_found", NOT_FOUND_MESSAGE);
    return new ReadableStream({
      start(controller) {
        controller.enqueue({ id: 0, event: "snapshot", session: structuredClone(tombstone), detail: {} });
        controller.close();
      },
    });
  }

  async openBrowser(sessionId: string): Promise<void> {
    const record = this.#requireActive(sessionId);
    await this.#requireWorker(record).invoke({ type: "open_browser" });
  }

  async suggestions(sessionId: string, questionId: string): Promise<unknown> {
    const record = this.#requireActive(sessionId);
    if (record.snapshot.state === "submitted" || record.snapshot.state === "submission_uncertain") {
      throw new HarnessServiceError(409, "command_conflict", "Only closing the browser is allowed after a submission outcome");
    }
    if (record.recovery !== undefined) {
      throw new HarnessServiceError(409, "command_conflict", "The application agent is paused; choose Continue first");
    }
    return this.#requireWorker(record).invoke({ type: "suggestions", questionId });
  }

  async command(sessionId: string, command: SessionCommand): Promise<void> {
    const parsed = SessionCommandSchema.safeParse(command);
    if (!parsed.success) {
      throw new HarnessServiceError(422, "invalid_request", "Request is invalid");
    }
    const record = this.#requireActive(sessionId);
    if (record.snapshot.state === "submitted" || record.snapshot.state === "submission_uncertain") {
      throw new HarnessServiceError(409, "command_conflict", "Only closing the browser is allowed after a submission outcome");
    }
    const recovery = record.recovery;
    if (recovery !== undefined) {
      if (parsed.data.type === "cancel") {
        await this.#finalize(record, "cancelled");
        return;
      }
      if (parsed.data.type === "continue") {
        if (recovery.resumed) throw new HarnessServiceError(409, "command_conflict", "The application state changed; review the latest session state");
        recovery.resumed = true;
        recovery.resolve();
        return;
      }
      if (parsed.data.type === "steer") {
        if (recovery.guidance.length >= 8) throw new HarnessServiceError(409, "command_conflict", "The application state changed; review the latest session state");
        recovery.guidance.push(parsed.data.message);
        return;
      }
      throw new HarnessServiceError(409, "command_conflict", "The application state changed; review the latest session state");
    }
    if (parsed.data.type === "cancel") {
      if (record.submissionStarted) {
        this.#transition(record, "submission_uncertain", "submission_uncertain", {}, {
          warnings: [
            ...record.snapshot.warnings,
            "Submission may have completed before cancellation. Inspect the application before retrying.",
          ],
        });
        return;
      }
      await this.#requireWorker(record).invoke({ type: "command", command: parsed.data });
      await this.#finalize(record, "cancelled");
      return;
    }
    await this.#requireWorker(record).invoke({ type: "command", command: parsed.data });
  }

  async runtimeAction(sessionId: string, action: unknown): Promise<unknown> {
    const record = this.#requireActive(sessionId);
    if (record.snapshot.state === "submitted" || record.snapshot.state === "submission_uncertain") {
      throw new HarnessServiceError(409, "command_conflict", "Only closing the browser is allowed after a submission outcome");
    }
    if (record.recovery !== undefined) {
      throw new HarnessServiceError(409, "command_conflict", "The application agent is paused; choose Continue first");
    }
    return this.#requireWorker(record).invoke({
      type: "runtime_action",
      action,
      modelAction: false,
    });
  }

  async runtimeModelAction(sessionId: string, action: unknown): Promise<unknown> {
    const record = this.#requireActive(sessionId);
    if (record.snapshot.state === "submitted" || record.snapshot.state === "submission_uncertain") {
      throw new HarnessServiceError(409, "command_conflict", "Only closing the browser is allowed after a submission outcome");
    }
    if (record.recovery !== undefined) {
      throw new HarnessServiceError(409, "command_conflict", "The application agent is paused; choose Continue first");
    }
    return this.#requireWorker(record).invoke({
      type: "runtime_action",
      action,
      modelAction: true,
    });
  }

  async delete(sessionId: string): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (record) {
      await this.#finalize(record, "closed");
      return;
    }
    const tombstone = this.#tombstones.get(sessionId);
    if (!tombstone) throw new HarnessServiceError(404, "session_not_found", NOT_FOUND_MESSAGE);
    if (tombstone.state !== "closed") {
      const closed = SessionSnapshotSchema.parse({
        ...tombstone,
        state: "closed",
        updated_at: this.#now().toISOString(),
        slot_released: true,
        pending_action: null,
        error: null,
      });
      this.#remember(closed);
    }
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    await Promise.all([...this.#sessions.values()].map((record) => this.#finalize(record, "closed")));
  }

  #createResponse(sessionId: string): SessionCreateResponse {
    return SessionCreateResponseSchema.parse({
      session_id: sessionId,
      state: "starting",
      events_url: `${this.#origin}/v1/sessions/${sessionId}/events`,
      commands_url: `${this.#origin}/v1/sessions/${sessionId}/commands`,
    });
  }

  #requireActive(sessionId: string): SessionRecord {
    const record = this.#sessions.get(sessionId);
    if (record) return record;
    if (this.#tombstones.has(sessionId)) {
      throw new HarnessServiceError(
        409,
        "session_terminal",
        "The application session has already ended",
      );
    }
    throw new HarnessServiceError(404, "session_not_found", NOT_FOUND_MESSAGE);
  }

  #requireWorker(record: SessionRecord): SessionWorker {
    if (!record.worker) {
      throw new HarnessServiceError(
        409,
        "command_conflict",
        "The application state changed; review the latest session state",
      );
    }
    return record.worker;
  }

  #transition(
    record: SessionRecord,
    state: SessionSnapshot["state"],
    event: string | null,
    detail: Readonly<Record<string, unknown>> = {},
    patch: Partial<SessionSnapshot> = {},
  ): void {
    if (this.#sessions.get(record.sessionId) !== record) return;
    record.snapshot = SessionSnapshotSchema.parse({
      ...record.snapshot,
      ...patch,
      session_id: record.sessionId,
      state,
      updated_at: this.#now().toISOString(),
      slot_released: false,
      pending_action: patch.pending_action ?? null,
      error: state === "failed" ? patch.error : null,
    });
    if (event) record.events.publish(event, structuredClone(record.snapshot), detail);
  }

  async #runWorker(record: SessionRecord, worker: SessionWorker): Promise<void> {
    let recoveryGuidance: readonly string[] | undefined;
    while (this.#sessions.get(record.sessionId) === record) {
      let result: ApplicationRunResult;
      try {
        result = ApplicationRunResultSchema.parse(await worker.run(recoveryGuidance));
      } catch (error) {
        if (this.#sessions.get(record.sessionId) !== record) return;
        if (record.submissionStarted) {
          this.#transition(record, "submission_uncertain", "submission_uncertain", {}, {
            warnings: [
              ...record.snapshot.warnings.filter((warning) => warning !== "Submission may have completed because the final action outcome is unknown.").slice(0, 99),
              "Submission may have completed because the final action outcome is unknown.",
            ],
          });
          return;
        }
        recoveryGuidance = await this.#pauseForRecovery(record, this.#agentFailureCode(error));
        if (recoveryGuidance === undefined) return;
        continue;
      }
      if (this.#sessions.get(record.sessionId) !== record) return;
      if (result.job_url !== record.input.jobUrl) {
        await this.#finalize(record, "failed", "application_mismatch");
        return;
      }
      if ((result.status === "submitted" || result.status === "submission_uncertain") && !record.submissionStarted) {
        await this.#finalize(record, "failed", "invalid_model_output");
        return;
      }
      if (result.status === "cancelled") {
        await this.#finalize(record, "failed", "invalid_model_output");
        return;
      }
      const patch = {
        job_url: result.job_url, company: result.company, role: result.role,
        fields_filled: result.fields_filled, fields_needing_human: result.fields_needing_human,
        files_attached: result.files_attached, warnings: result.warnings,
        revision_count: result.revision_count,
      } satisfies Partial<SessionSnapshot>;
      if (result.status === "submitted") {
        this.#transition(record, "submitted", "application_submitted", {}, patch);
        if (record.input.autoEnd) await this.#finalize(record, "closed");
      } else {
        this.#transition(record, "submission_uncertain", "submission_uncertain", {}, patch);
      }
      return;
    }
  }

  #agentFailureCode(error: unknown): ErrorCode {
    if (!(error instanceof ApplicationAgentError)) return "browser_failed";
    if (error.code === "invalid_request") return "invalid_model_output";
    if (error.code in SESSION_ERROR_MESSAGES) return error.code as ErrorCode;
    return "browser_failed";
  }

  async #pauseForRecovery(record: SessionRecord, errorCode: ErrorCode): Promise<readonly string[] | undefined> {
    let resolve!: () => void;
    const promise = new Promise<void>((ready) => { resolve = ready; });
    const recovery: RecoveryState = { promise, resolve, guidance: [], resumed: false };
    record.recovery = recovery;
    const instruction = SESSION_ERROR_MESSAGES[errorCode]
      + ". The application is paused; this session remains open. Resolve the problem, add any guidance, then choose Continue. "
      + "The agent will inspect the current page instead of repeating its last action.";
    this.#transition(record, "awaiting_human_navigation", "human_navigation_required", { instruction }, {
      pending_action: { type: "human_navigation", instruction },
    });
    await recovery.promise;
    if (this.#sessions.get(record.sessionId) !== record) return undefined;
    delete record.recovery;
    this.#transition(record, "running", "snapshot");
    return [...recovery.guidance];
  }

  async #finalize(
    record: SessionRecord,
    state: "cancelled" | "failed" | "closed",
    errorCode?: SessionSnapshot["error"] extends { code: infer Code } | null ? Code : never,
  ): Promise<void> {
    record.finalizer ??= (async () => {
      record.recovery?.resolve();
      const error = state === "failed"
        ? sessionError(errorCode ?? "browser_failed")
        : null;
      record.snapshot = SessionSnapshotSchema.parse({
        ...record.snapshot,
        state,
        updated_at: this.#now().toISOString(),
        expires_at: this.#now().toISOString(),
        slot_released: true,
        pending_action: null,
        error,
      });
      record.events.publish(state, structuredClone(record.snapshot));
      record.events.close();
      this.#sessions.delete(record.sessionId);
      this.#remember(record.snapshot);
      await record.worker?.close();
    })();
    await record.finalizer;
  }

  #remember(snapshot: SessionSnapshot): void {
    this.#tombstones.delete(snapshot.session_id);
    this.#tombstones.set(snapshot.session_id, structuredClone(snapshot));
    while (this.#tombstones.size > 32) {
      const oldest = this.#tombstones.keys().next().value;
      if (oldest === undefined) return;
      this.#tombstones.delete(oldest);
    }
  }
}
