import { randomUUID } from "node:crypto";
import {
  CreateSourceHandoffRequestSchema,
  SourceHandoffDtoSchema,
  SourceHandoffIdSchema,
  type CreateSourceHandoffRequest,
  type RunDto,
  type SourceHandoffDto,
} from "../contracts";
import {
  SourceCaptureHarnessError,
  type SourceCaptureCompleteResult,
  type SourceCaptureHarnessClient,
} from "./application-harness-client.ts";

const CAPTURE_CLEANUP_TIMEOUT_MS = 10_000;

export type SourceHandoffErrorCode =
  | "SOURCE_HANDOFF_INVALID_URL"
  | "SOURCE_HANDOFF_NOT_FOUND"
  | "SOURCE_HANDOFF_CONFLICT"
  | "SOURCE_HANDOFF_UNAVAILABLE";

const ERROR_DETAILS = {
  SOURCE_HANDOFF_INVALID_URL: [400, "Source handoff URL must use HTTPS with a canonical host"],
  SOURCE_HANDOFF_NOT_FOUND: [404, "Source handoff not found"],
  SOURCE_HANDOFF_CONFLICT: [409, "A source handoff is already active"],
  SOURCE_HANDOFF_UNAVAILABLE: [503, "Source handoff is unavailable"],
} as const satisfies Record<
  SourceHandoffErrorCode,
  readonly [400 | 404 | 409 | 503, string]
>;

export class SourceHandoffError extends Error {
  readonly status: 400 | 404 | 409 | 503;

  constructor(readonly code: SourceHandoffErrorCode) {
    const [status, message] = ERROR_DETAILS[code];
    super(message);
    this.name = "SourceHandoffError";
    this.status = status;
  }
}

export function isEligibleSourceHandoffJobUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.hostname.endsWith(".");
  } catch {
    return false;
  }
}

export interface SourceHandoffRunService {
  validateSourceHandoffRequest(
    request: CreateSourceHandoffRequest,
    signal?: AbortSignal,
  ): Promise<CreateSourceHandoffRequest>;
  createRunFromCapturedSource(
    request: CreateSourceHandoffRequest,
    source: string,
    signal?: AbortSignal,
  ): Promise<RunDto>;
  kick(): void;
}

export interface SourceHandoffServiceDependencies {
  readonly runs: SourceHandoffRunService;
  readonly harness?: SourceCaptureHarnessClient;
  readonly idFactory?: () => string;
}

type ActiveSourceHandoffPhase =
  | "opening"
  | "awaiting"
  | "completing"
  | "cancelling"
  | "closing";

interface ActiveSourceHandoff {
  readonly id: string;
  readonly request: CreateSourceHandoffRequest;
  readonly approvedOrigins: readonly [string];
  phase: ActiveSourceHandoffPhase;
  readonly controller: AbortController;
  captureClosed: boolean;
  captureCleanup?: Promise<void>;
  creation?: Promise<SourceHandoffDto>;
  completion?: Promise<RunDto>;
}

interface CompletedSourceHandoff {
  readonly id: string;
  readonly run: RunDto;
}

export class SourceHandoffService {
  readonly #idFactory: () => string;
  #active: ActiveSourceHandoff | undefined;
  #completed: CompletedSourceHandoff | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(private readonly dependencies: SourceHandoffServiceDependencies) {
    this.#idFactory = dependencies.idFactory ?? randomUUID;
  }

  async create(
    request: CreateSourceHandoffRequest,
    signal?: AbortSignal,
  ): Promise<SourceHandoffDto> {
    signal?.throwIfAborted();
    const parsedRequest = CreateSourceHandoffRequestSchema.parse(request);
    if (!isEligibleSourceHandoffJobUrl(parsedRequest.jobUrl)) {
      throw new SourceHandoffError("SOURCE_HANDOFF_INVALID_URL");
    }

    if (this.#closed || this.dependencies.harness === undefined) {
      throw new SourceHandoffError("SOURCE_HANDOFF_UNAVAILABLE");
    }
    if (this.#active !== undefined) {
      return await this.#recoverCreate(this.#active, parsedRequest);
    }

    const validatedRequest = CreateSourceHandoffRequestSchema.parse(
      await this.dependencies.runs.validateSourceHandoffRequest(parsedRequest, signal),
    );
    signal?.throwIfAborted();
    if (!isEligibleSourceHandoffJobUrl(validatedRequest.jobUrl)) {
      throw new SourceHandoffError("SOURCE_HANDOFF_INVALID_URL");
    }

    if (this.#closed || this.dependencies.harness === undefined) {
      throw new SourceHandoffError("SOURCE_HANDOFF_UNAVAILABLE");
    }
    if (this.#active !== undefined) {
      return await this.#recoverCreate(this.#active, validatedRequest);
    }

    const id = SourceHandoffIdSchema.parse(this.#idFactory());
    if (this.#completed?.id === id) this.#clearCompleted();
    const active: ActiveSourceHandoff = {
      id,
      request: validatedRequest,
      approvedOrigins: [new URL(validatedRequest.jobUrl).origin],
      phase: "opening",
      controller: new AbortController(),
      captureClosed: false,
    };
    this.#active = active;
    return await this.#startCreation(active);
  }

  async #recoverCreate(
    active: ActiveSourceHandoff,
    request: CreateSourceHandoffRequest,
  ): Promise<SourceHandoffDto> {
    if (active.phase === "cancelling" || active.phase === "closing") {
      throw new SourceHandoffError("SOURCE_HANDOFF_CONFLICT");
    }
    const identical = active.request.jobUrl === request.jobUrl
      && active.request.opportunityKind === request.opportunityKind
      && active.request.generateKeywordMap === request.generateKeywordMap
      && active.request.skipReview === request.skipReview
      && active.request.autoSubmit === request.autoSubmit;
    if (!identical) {
      throw new SourceHandoffError("SOURCE_HANDOFF_CONFLICT");
    }
    if (active.creation !== undefined) return await active.creation;
    if (active.phase === "opening") return await this.#startCreation(active);
    return this.#dto(active);
  }

  async #startCreation(active: ActiveSourceHandoff): Promise<SourceHandoffDto> {
    const creation = this.#open(active);
    active.creation = creation;
    try {
      return await creation;
    } finally {
      if (active.creation === creation) delete active.creation;
    }
  }

  async #open(active: ActiveSourceHandoff): Promise<SourceHandoffDto> {
    try {
      await this.dependencies.harness!.createSourceCapture({
        captureId: active.id,
        jobUrl: active.request.jobUrl,
        approvedOrigins: active.approvedOrigins,
      }, active.controller.signal);
      if (
        this.#closed
        || this.#active !== active
        || active.phase !== "opening"
      ) {
        throw new SourceCaptureHarnessError("unavailable");
      }
      active.phase = "awaiting";
      return this.#dto(active);
    } catch (error) {
      if (
        error instanceof SourceCaptureHarnessError
        && (error.code === "ambiguous_result" || error.code === "invalid_response")
        && !this.#closed
        && this.#active === active
        && active.phase === "opening"
      ) {
        throw this.#mapHarnessError(error);
      }
      let cleanupSucceeded = false;
      try {
        await this.#ensureCaptureClosed(active);
        cleanupSucceeded = true;
      } catch {
        // The public error remains fixed and carries no private cleanup detail.
      }
      if (cleanupSucceeded) this.#clear(active);
      throw this.#mapHarnessError(error);
    }
  }

  async get(id: string): Promise<SourceHandoffDto> {
    return this.#dto(this.#requireVisible(id));
  }

  async complete(id: string, signal?: AbortSignal): Promise<RunDto> {
    const completed = this.#completedResult(id);
    if (completed !== undefined) return completed;
    signal?.throwIfAborted();
    const active = this.#requireVisible(id);
    if (active.phase === "completing" && active.completion !== undefined) {
      return await this.#awaitCompletion(active.completion, signal);
    }
    if (active.phase !== "awaiting") {
      throw new SourceHandoffError("SOURCE_HANDOFF_CONFLICT");
    }

    active.phase = "completing";
    const completion = this.#completeActive(active);
    active.completion = completion;
    const clearCompletion = (): void => {
      if (active.completion === completion) delete active.completion;
    };
    void completion.then(clearCompletion, clearCompletion);
    return await this.#awaitCompletion(completion, signal);
  }

  async #awaitCompletion(
    completion: Promise<RunDto>,
    signal: AbortSignal | undefined,
  ): Promise<RunDto> {
    if (signal === undefined) return await completion;
    signal.throwIfAborted();
    const { promise: aborted, reject } = Promise.withResolvers<never>();
    const onAbort = (): void => {
      reject(signal.reason ?? new DOMException("The request was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([completion, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async #completeActive(active: ActiveSourceHandoff): Promise<RunDto> {
    const operationSignal = active.controller.signal;
    let captured: SourceCaptureCompleteResult;
    try {
      captured = await this.dependencies.harness!.completeSourceCapture(
        active.id,
        operationSignal,
      );
    } catch (error) {
      if (active.phase === "cancelling" || active.phase === "closing") {
        throw active.controller.signal.reason
          ?? new DOMException("Source handoff completion was aborted", "AbortError");
      }
      if (
        error instanceof SourceCaptureHarnessError
        && (error.code === "ambiguous_result" || error.code === "invalid_response")
      ) {
        this.#resumeAwaiting(active, "completing");
        throw this.#mapHarnessError(error);
      }
      if (
        error instanceof SourceCaptureHarnessError
        && error.code === "capture_not_found"
      ) {
        this.#clear(active);
        throw this.#mapHarnessError(error);
      }
      try {
        await this.#ensureCaptureClosed(active);
        this.#clear(active);
      } catch {
        this.#resumeAwaiting(active, "completing");
        throw this.#mapHarnessError(error);
      }
      throw new SourceHandoffError("SOURCE_HANDOFF_NOT_FOUND");
    }

    let finalOrigin: string | undefined;
    try {
      const finalUrl = new URL(captured.finalUrl);
      if (
        captured.finalUrl.length >= 1
        && captured.finalUrl.length <= 4_096
        && finalUrl.protocol === "https:"
        && finalUrl.username === ""
        && finalUrl.password === ""
        && finalUrl.hash === ""
        && finalUrl.href === captured.finalUrl
      ) {
        finalOrigin = finalUrl.origin;
      }
    } catch {
      // The authenticated client validates this first; fail closed for custom clients.
    }
    if (finalOrigin === undefined || finalOrigin !== active.approvedOrigins[0]) {
      try {
        await this.#ensureCaptureClosed(active);
        this.#clear(active);
      } catch (error) {
        this.#resumeAwaiting(active, "completing");
        throw this.#mapHarnessError(error);
      }
      throw new SourceHandoffError("SOURCE_HANDOFF_NOT_FOUND");
    }

    let run: RunDto;
    try {
      operationSignal.throwIfAborted();
      run = await this.dependencies.runs.createRunFromCapturedSource(
        active.request,
        captured.source,
        operationSignal,
      );
    } catch (error) {
      this.#resumeAwaiting(active, "completing");
      throw error;
    }

    try {
      if (!this.#closed) {
        this.#cacheCompleted(active.id, run);
        this.dependencies.runs.kick();
      }
      return run;
    } finally {
      await this.#ensureCaptureClosed(active).catch(() => undefined);
      this.#clear(active);
    }
  }

  async delete(id: string): Promise<void> {
    const active = this.#requireVisible(id);
    if (active.phase === "completing") {
      active.phase = "cancelling";
      active.controller.abort(
        new DOMException("Source handoff is being cancelled", "AbortError"),
      );
      await active.completion?.catch(() => undefined);
      try {
        await this.#ensureCaptureClosed(active);
      } catch (error) {
        this.#resumeAwaiting(active, "cancelling");
        throw this.#mapHarnessError(error);
      }
      this.#clear(active);
      return;
    }
    if (active.phase !== "awaiting") {
      throw new SourceHandoffError("SOURCE_HANDOFF_CONFLICT");
    }
    active.phase = "cancelling";
    try {
      await this.#ensureCaptureClosed(active);
    } catch (error) {
      this.#resumeAwaiting(active, "cancelling");
      throw this.#mapHarnessError(error);
    }
    this.#clear(active);
  }

  close(): void | Promise<void> {
    this.#closed = true;
    this.#clearCompleted();
    if (this.#closePromise !== undefined) return this.#closePromise;
    const active = this.#active;
    if (active === undefined) return;

    active.phase = "closing";
    active.controller.abort(
      new DOMException("Source handoff service is closing", "AbortError"),
    );
    this.#closePromise = (async () => {
      await active.creation?.catch(() => undefined);
      await active.completion?.catch(() => undefined);
      let cleanupError: unknown;
      try {
        await this.#ensureCaptureClosed(active);
      } catch (error) {
        cleanupError = error;
      }
      this.#clearCompleted();
      this.#clear(active);
      if (cleanupError !== undefined) throw cleanupError;
    })();
    return this.#closePromise;
  }

  #requireVisible(id: string): ActiveSourceHandoff {
    const active = this.#active;
    if (
      active === undefined
      || active.id !== id
      || active.phase === "opening"
      || active.phase === "cancelling"
      || active.phase === "closing"
    ) {
      throw new SourceHandoffError("SOURCE_HANDOFF_NOT_FOUND");
    }
    return active;
  }

  #dto(active: ActiveSourceHandoff): SourceHandoffDto {
    return SourceHandoffDtoSchema.parse({
      id: active.id,
      state: "awaiting_human_verification",
      jobUrl: active.request.jobUrl,
    });
  }

  #resumeAwaiting(
    active: ActiveSourceHandoff,
    from: "completing" | "cancelling",
  ): void {
    if (this.#active !== active || active.phase !== from) return;
    active.phase = "awaiting";
  }

  async #ensureCaptureClosed(active: ActiveSourceHandoff): Promise<void> {
    if (active.captureClosed) return;
    if (active.captureCleanup !== undefined) {
      return await active.captureCleanup;
    }
    const cleanup = this.#deleteCapture(active.id).then(() => {
      active.captureClosed = true;
    });
    active.captureCleanup = cleanup;
    try {
      await cleanup;
    } finally {
      if (active.captureCleanup === cleanup) delete active.captureCleanup;
    }
  }

  async #deleteCapture(id: string): Promise<void> {
    const harness = this.dependencies.harness;
    if (harness === undefined) return;
    try {
      await harness.deleteSourceCapture(
        id,
        AbortSignal.timeout(CAPTURE_CLEANUP_TIMEOUT_MS),
      );
    } catch (error) {
      if (
        error instanceof SourceCaptureHarnessError
        && error.code === "capture_not_found"
      ) {
        return;
      }
      throw error;
    }
  }

  #cacheCompleted(id: string, run: RunDto): void {
    this.#completed = { id, run };
  }

  #completedResult(id: string): RunDto | undefined {
    const completed = this.#completed;
    return completed?.id === id ? completed.run : undefined;
  }

  #clearCompleted(): void {
    this.#completed = undefined;
  }

  #clear(active: ActiveSourceHandoff): void {
    if (this.#active === active) this.#active = undefined;
  }

  #mapHarnessError(error: unknown): SourceHandoffError {
    if (error instanceof SourceCaptureHarnessError) {
      if (error.code === "capture_not_found") {
        return new SourceHandoffError("SOURCE_HANDOFF_NOT_FOUND");
      }
      if (error.code === "capture_active" || error.code === "capture_not_ready") {
        return new SourceHandoffError("SOURCE_HANDOFF_CONFLICT");
      }
    }
    return new SourceHandoffError("SOURCE_HANDOFF_UNAVAILABLE");
  }
}
