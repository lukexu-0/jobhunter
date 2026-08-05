import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  ApplicationAnswerSuggestionsResponseSchema,
  ApplicationProfessionalizeResponseSchema,
  ApplicationSessionEventDtoSchema,
  ApplicationSessionSnapshotDtoSchema,
  ApplicationSessionViewSchema,
  type ApplicationAdditionalInfoQuestion,
  type ApplicationAnswerSuggestionsResponse,
  type ApplicationProfessionalizeRequest,
  type ApplicationProfessionalizeResponse,
  type ApplicationSessionEventDto,
  type ApplicationSessionCommand,
  type ApplicationSessionSnapshotDto,
  type ApplicationSessionView,
  type OpportunityKind,
} from "../contracts/index.ts";
import { REPOSITORY_ROOT } from "../context/manifest.ts";
import { OAuthRequiredError } from "../auth/oauth-only-resolver.ts";
import {
  APPLICATION_SUBMISSION_UNCERTAIN_WARNING,
  ApplicationSubmissionFinalError,
  PipelineRepository,
  RepositoryConflictError,
  RunArtifactsPrunedError,
  type ApplicationSessionBridgeState,
  type PublicApplicationSession,
  type PublicArtifact,
} from "../db/repository.ts";
import type { ArtifactStore } from "../system/artifacts.ts";
import {
  ApplicationHarnessError,
  type ApplicationHarnessClient,
  type ApplicationHarnessEvent,
  type ApplicationHarnessSnapshot,
} from "./application-harness-client.ts";
import {
  ApplicationAnswerProfessionalizationError,
  type ProfessionalizeApplicationAnswer,
} from "../models/application-answer-professionalizer.ts";
import {
  MAX_COMPILED_PDF_BYTES,
  readVerifiedArtifactBytes,
  RunServiceError,
} from "./run-service.ts";
import { canonicalizePublicHttpUrl } from "./job-source.ts";

const MAX_PROFILE_BYTES = 1024 * 1024;
const PROFILE_RELATIVE_PATH = "apps/user-info/current-context/personal/applicant-profile.md";
const LOST_WARNING = "Verify whether the application was submitted before retrying.";
const SLOT_RELEASE_RETRY_DELAY_MS = 250;

const LIVE_APPLICATION_STATES: Readonly<Record<string, true>> = Object.freeze({
  reserved: true,
  starting: true,
  running: true,
  awaiting_human_navigation: true,
  awaiting_origin_approval: true,
  awaiting_additional_info: true,
  awaiting_human_review: true,
  submitting: true,
  submitted: true,
  submission_uncertain: true,
});

function waitForSlotReleaseRetry(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, SLOT_RELEASE_RETRY_DELAY_MS).unref();
  return promise;
}

const TERMINAL_APPLICATION_STATES: Readonly<Record<string, true>> = Object.freeze({
  cancelled: true,
  failed: true,
  closed: true,
  lost: true,
});

export type ApplicationSessionServiceErrorCode =
  | "APPLICATION_HARNESS_UNAVAILABLE"
  | "APPLICATION_SOURCE_UNAVAILABLE"
  | "APPLICATION_SESSION_BUSY"
  | "APPLICATION_COMMAND_CONFLICT"
  | "APPLICATION_SUBMISSION_FINAL"
  | "APPLICATION_QUESTION_STALE"
  | "OAUTH_REQUIRED"
  | "MODEL_TIMEOUT"
  | "INVALID_MODEL_OUTPUT"
  | "MODEL_PROVIDER_FAILED";

const SERVICE_ERRORS: Readonly<
  Record<
    ApplicationSessionServiceErrorCode,
    { readonly message: string; readonly status: 409 | 502 | 503 | 504 }
  >
> = Object.freeze({
  APPLICATION_HARNESS_UNAVAILABLE: {
    message: "The local application service is unavailable",
    status: 503,
  },
  APPLICATION_SOURCE_UNAVAILABLE: {
    message: "Application source files are unavailable",
    status: 409,
  },
  APPLICATION_SESSION_BUSY: {
    message: "Another application session is active",
    status: 409,
  },
  APPLICATION_COMMAND_CONFLICT: {
    message: "The application state changed; review the latest session state",
    status: 409,
  },
  APPLICATION_SUBMISSION_FINAL: {
    message: "The application submission cannot be retried",
    status: 409,
  },
  APPLICATION_QUESTION_STALE: {
    message: "The application question changed; review the latest session state",
    status: 409,
  },
  OAUTH_REQUIRED: {
    message: "Connect OpenAI Codex in Provider access",
    status: 409,
  },
  MODEL_TIMEOUT: {
    message: "The model request timed out",
    status: 504,
  },
  INVALID_MODEL_OUTPUT: {
    message: "The model returned invalid output",
    status: 502,
  },
  MODEL_PROVIDER_FAILED: {
    message: "The model request failed",
    status: 502,
  },
});

export class ApplicationSessionServiceError extends Error {
  readonly status: 409 | 502 | 503 | 504;

  constructor(readonly code: ApplicationSessionServiceErrorCode) {
    const definition = SERVICE_ERRORS[code];
    super(definition.message);
    this.name = "ApplicationSessionServiceError";
    this.status = definition.status;
  }
}

export type ApplicantProfileReader = () => string | Promise<string>;

export interface ApplicationSessionServiceDependencies {
  readonly repository: PipelineRepository;
  readonly artifacts: Pick<ArtifactStore, "read">;
  readonly harness?: ApplicationHarnessClient;
  readonly uuidFactory?: () => string;
  readonly now?: () => number;
  readonly profileReader?: ApplicantProfileReader;
  readonly onApplicationSessionReleased?: () => void;
  readonly professionalizeAnswer?: ProfessionalizeApplicationAnswer;
}

export interface ApplicationSessionEventCursor {
  readonly generation: number;
  readonly upstreamEventId: number;
}

export interface ApplicationSessionStreamItem {
  readonly id: string;
  readonly event: ApplicationSessionEventDto;
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function validateProfileText(value: unknown): string {
  if (typeof value !== "string") throw new Error("applicant profile is not text");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > MAX_PROFILE_BYTES) throw new Error("applicant profile size is invalid");
  return value;
}

export async function readApplicantProfileMarkdown(
  repositoryRoot = REPOSITORY_ROOT,
): Promise<string> {
  const root = await realpath(repositoryRoot);
  const target = resolve(root, PROFILE_RELATIVE_PATH);
  if (!isContained(root, target)) throw new Error("applicant profile path escapes repository root");

  let cursor = root;
  for (const component of relative(root, target).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, component);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error("applicant profile path must not contain symlinks");
  }
  const pathStat = await lstat(target);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error("applicant profile must be a regular file");
  }
  if (pathStat.size < 1 || pathStat.size > MAX_PROFILE_BYTES) {
    throw new Error("applicant profile size is invalid");
  }

  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_PROFILE_BYTES) {
      throw new Error("applicant profile must be a bounded regular file");
    }
    const buffer = new Uint8Array(MAX_PROFILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const item = await handle.read(buffer, offset, buffer.byteLength - offset, null);
      if (item.bytesRead === 0) break;
      offset += item.bytesRead;
    }
    if (offset < 1 || offset > MAX_PROFILE_BYTES) {
      throw new Error("applicant profile size is invalid");
    }
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    return decoder.decode(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return normalized === "localhost"
    || normalized === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isHarnessCompatibleJobUrl(value: string): boolean {
  try {
    if (value.length < 1 || value.length > 2_048) return false;
    const url = new URL(value);
    if (url.username !== "" || url.password !== "" || url.hash !== "") return false;
    if (url.protocol === "http:") return isLoopbackHostname(url.hostname);
    return url.protocol === "https:"
      && canonicalizePublicHttpUrl(url).protocol === "https:";
  } catch {
    return false;
  }
}

function applicationSourceUnavailable(): ApplicationSessionServiceError {
  return new ApplicationSessionServiceError("APPLICATION_SOURCE_UNAVAILABLE");
}

function applicationHarnessUnavailable(): ApplicationSessionServiceError {
  return new ApplicationSessionServiceError("APPLICATION_HARNESS_UNAVAILABLE");
}

function runArtifactsPruned(): RunServiceError {
  return new RunServiceError(
    "RUN_ARTIFACTS_PRUNED",
    "Run artifacts were removed by the ten-run retention policy",
    410,
  );
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof ApplicationSubmissionFinalError) {
    throw new ApplicationSessionServiceError("APPLICATION_SUBMISSION_FINAL");
  }
  if (error instanceof RunArtifactsPrunedError) throw runArtifactsPruned();
  if (error instanceof RepositoryConflictError) {
    const code = error.message === "run not found"
      ? "RUN_NOT_FOUND"
      : error.message.includes("stale") || error.message.includes("PDF changed")
        ? "STALE_PDF"
        : error.message.includes("live claim")
          ? "RUN_CLAIMED"
          : "RUN_CONFLICT";
    throw new RunServiceError(code, error.message, code === "RUN_NOT_FOUND" ? 404 : 409);
  }
  throw error;
}

function isLive(session: PublicApplicationSession): boolean {
  return LIVE_APPLICATION_STATES[session.bridgeState] === true;
}

function isTerminal(session: PublicApplicationSession): boolean {
  return TERMINAL_APPLICATION_STATES[session.bridgeState] === true;
}

function isSupersededApplicationSession(
  session: PublicApplicationSession,
  currentRevision: number,
): boolean {
  return isTerminal(session)
    && !submissionCannotRetry(session)
    && session.resumeRevision < currentRevision;
}

function retainedSubmissionFinal(session: PublicApplicationSession): boolean {
  return session.submissionPhase === "submitted" || session.submissionPhase === "uncertain";
}
function attemptingSubmissionEnded(
  session: PublicApplicationSession,
  harnessState: ApplicationHarnessSnapshot["state"],
): boolean {
  return session.submissionPhase === "attempting"
    && (
      harnessState === "submitted"
      || harnessState === "submission_uncertain"
      || TERMINAL_APPLICATION_STATES[harnessState] === true
    );
}


function submissionCannotRetry(session: PublicApplicationSession): boolean {
  return session.submissionPhase === "attempting" || retainedSubmissionFinal(session);
}

function durableBridgeState(
  session: PublicApplicationSession,
  harnessState?: ApplicationHarnessSnapshot["state"],
): ApplicationSessionBridgeState {
  const closed = session.bridgeState === "closed" || harnessState === "closed";
  switch (session.submissionPhase) {
    case "attempting":
      return closed ? "closed" : "submitting";
    case "submitted":
      return closed ? "closed" : "submitted";
    case "uncertain":
      return closed ? "closed" : "submission_uncertain";
    case "not_attempted":
      return harnessState ?? session.bridgeState;
  }
}

interface PreparedStart {
  readonly jobUrl: string;
  readonly opportunityKind: OpportunityKind;
  readonly autoSubmit: boolean;
  readonly profile: string;
  readonly pdf: PublicArtifact;
}

interface PendingTextQuestionIdentity {
  readonly sessionId: string;
  readonly generation: number;
  readonly question: Extract<
    ApplicationAdditionalInfoQuestion,
    { readonly answerType: "text" }
  >;
}

function samePendingTextQuestion(
  left: PendingTextQuestionIdentity,
  right: PendingTextQuestionIdentity,
): boolean {
  return left.sessionId === right.sessionId
    && left.generation === right.generation
    && left.question.id === right.question.id
    && left.question.scope === right.question.scope
    && left.question.question === right.question.question;
}

export class ApplicationSessionService {
  readonly #uuidFactory: () => string;
  readonly #now: () => number;
  readonly #profileReader: ApplicantProfileReader;
  readonly #pendingResumes = new Map<
    string,
    Set<Promise<ApplicationSessionSnapshotDto>>
  >();
  readonly #slotReleaseObservers = new Map<string, Promise<void>>();
  readonly #slotReleaseAbortController = new AbortController();
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(private readonly dependencies: ApplicationSessionServiceDependencies) {
    this.#uuidFactory = dependencies.uuidFactory ?? randomUUID;
    this.#now = dependencies.now ?? Date.now;
    this.#profileReader = dependencies.profileReader ?? (() => readApplicantProfileMarkdown());
  }
  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#slotReleaseAbortController.abort();
    this.#disposePromise = Promise.allSettled(
      [...this.#slotReleaseObservers.values()],
    ).then(() => {
      this.#slotReleaseObservers.clear();
    });
    return this.#disposePromise;
  }


  async startNextAutomaticApplication(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    await this.#reconcileApplicationSlot(signal);
    const candidate = this.dependencies.repository.getNextAutomaticApplicationStart();
    if (!candidate) return false;
    await this.start(candidate.runId, candidate.approvedPdfSha256, signal);
    return true;
  }

  async get(runId: string): Promise<ApplicationSessionView> {
    const run = this.dependencies.repository.getRun(runId);
    if (!run) throw new RunServiceError("RUN_NOT_FOUND", "run not found", 404);
    let latest: PublicApplicationSession | null;
    try {
      latest = this.dependencies.repository.getLatestApplicationSession(runId);
    } catch (error) {
      mapRepositoryError(error);
    }
    if (latest && !isSupersededApplicationSession(latest, run.currentRevision)) {
      return this.#storedView(latest);
    }

    let jobUrl: string | null;
    try {
      jobUrl = this.dependencies.repository.getRunJobUrl(runId);
    } catch (error) {
      mapRepositoryError(error);
    }
    if (jobUrl === null) return this.#notStarted("legacy_job_url_unavailable");
    if (!isHarnessCompatibleJobUrl(jobUrl)) return this.#notStarted("job_url_requires_https");
    if (run.status !== "review" && run.status !== "approved") {
      return this.#notStarted("resume_not_approved");
    }
    try {
      if (!this.dependencies.repository.areRunArtifactsRetained(runId)) {
        return this.#notStarted("artifacts_pruned");
      }
    } catch (error) {
      mapRepositoryError(error);
    }
    const pdf = this.dependencies.repository.getArtifact(runId, "compiled-pdf", run.currentRevision);
    if (
      !pdf
      || (run.status === "approved" && pdf.sha256 !== run.approvedPdfSha256)
    ) {
      return this.#notStarted("artifacts_pruned");
    }
    if (!this.dependencies.harness) return this.#notStarted("harness_unconfigured");
    try {
      validateProfileText(await this.#profileReader());
    } catch {
      return this.#notStarted("profile_unavailable");
    }
    return ApplicationSessionViewSchema.parse({
      state: "not_started",
      canStart: run.status === "approved",
      canStartAfterApproval: run.status === "review",
    });
  }

  async suggestions(
    runId: string,
    questionId: string,
    signal: AbortSignal,
  ): Promise<ApplicationAnswerSuggestionsResponse> {
    const before = await this.#currentPendingTextQuestion(runId, questionId, signal);
    const harness = this.dependencies.harness;
    if (!harness) throw applicationHarnessUnavailable();
    let suggestions: ApplicationAnswerSuggestionsResponse;
    try {
      suggestions = await harness.suggestions(before.sessionId, questionId, signal);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (
        error instanceof ApplicationHarnessError
        && (
          error.code === "session_not_found"
          || error.code === "session_terminal"
          || error.code === "command_conflict"
          || error.code === "invalid_request"
        )
      ) {
        throw new ApplicationSessionServiceError("APPLICATION_QUESTION_STALE");
      }
      this.#throwHarnessError(error);
    }
    const after = await this.#currentPendingTextQuestion(runId, questionId, signal);
    if (!samePendingTextQuestion(before, after)) {
      throw new ApplicationSessionServiceError("APPLICATION_QUESTION_STALE");
    }
    const parsed = ApplicationAnswerSuggestionsResponseSchema.safeParse(suggestions);
    if (!parsed.success) throw applicationHarnessUnavailable();
    return parsed.data;
  }

  async professionalize(
    runId: string,
    questionId: string,
    request: ApplicationProfessionalizeRequest,
    signal: AbortSignal,
  ): Promise<ApplicationProfessionalizeResponse> {
    const before = await this.#currentPendingTextQuestion(runId, questionId, signal);
    const professionalizeAnswer = this.dependencies.professionalizeAnswer;
    if (!professionalizeAnswer) {
      throw new ApplicationSessionServiceError("MODEL_PROVIDER_FAILED");
    }
    let answer: string;
    try {
      answer = await professionalizeAnswer(before.question.question, request, signal);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof OAuthRequiredError) {
        throw new ApplicationSessionServiceError("OAUTH_REQUIRED");
      }
      if (error instanceof ApplicationAnswerProfessionalizationError) {
        if (error.kind === "timeout") {
          throw new ApplicationSessionServiceError("MODEL_TIMEOUT");
        }
        if (error.kind === "invalid_output") {
          throw new ApplicationSessionServiceError("INVALID_MODEL_OUTPUT");
        }
      }
      throw new ApplicationSessionServiceError("MODEL_PROVIDER_FAILED");
    }
    const response = ApplicationProfessionalizeResponseSchema.safeParse({ answer });
    if (!response.success) {
      throw new ApplicationSessionServiceError("INVALID_MODEL_OUTPUT");
    }
    const after = await this.#currentPendingTextQuestion(runId, questionId, signal);
    if (!samePendingTextQuestion(before, after)) {
      throw new ApplicationSessionServiceError("APPLICATION_QUESTION_STALE");
    }
    return response.data;
  }

  async start(
    runId: string,
    expectedApprovedPdfSha256: string,
    signal: AbortSignal,
  ): Promise<ApplicationSessionSnapshotDto> {
    signal.throwIfAborted();
    await this.#reconcileApplicationSlot(signal, runId);
    let latest: PublicApplicationSession | null;
    try {
      latest = this.dependencies.repository.getLatestApplicationSession(runId);
    } catch (error) {
      mapRepositoryError(error);
    }
    if (latest) {
      if (submissionCannotRetry(latest)) {
        throw new ApplicationSessionServiceError("APPLICATION_SUBMISSION_FINAL");
      }
      const run = isTerminal(latest)
        ? this.dependencies.repository.getRun(runId)
        : null;
      if (run && isSupersededApplicationSession(latest, run.currentRevision)) {
        const prepared = await this.#prepareStart(runId, expectedApprovedPdfSha256, signal);
        let reserved: PublicApplicationSession;
        try {
          reserved = this.dependencies.repository.reserveApplicationSession(
            runId,
            latest.sessionId,
            this.#uuidFactory(),
            expectedApprovedPdfSha256,
          );
        } catch (error) {
          const concurrent = this.dependencies.repository.getLatestApplicationSession(runId);
          if (concurrent && submissionCannotRetry(concurrent)) {
            throw new ApplicationSessionServiceError("APPLICATION_SUBMISSION_FINAL");
          }
          if (
            concurrent
            && concurrent.generation > latest.generation
            && concurrent.resumeRevision === prepared.pdf.revision
            && concurrent.pdfSha256 === expectedApprovedPdfSha256
            && isLive(concurrent)
          ) {
            return await this.#resume(runId, concurrent, prepared, signal);
          }
          mapRepositoryError(error);
        }
        return await this.#resume(runId, reserved, prepared, signal);
      }
      if (latest.pdfSha256 !== expectedApprovedPdfSha256) {
        throw new RunServiceError("STALE_PDF", "approved PDF hash is stale", 409);
      }
      if (isTerminal(latest)) return this.#storedView(latest);
      return await this.#resume(
        runId,
        latest,
        () => this.#prepareStart(runId, expectedApprovedPdfSha256, signal),
        signal,
      );
    }

    const prepared = await this.#prepareStart(runId, expectedApprovedPdfSha256, signal);
    const sessionId = this.#uuidFactory();
    let reserved: PublicApplicationSession;
    try {
      reserved = this.dependencies.repository.reserveApplicationSession(
        runId,
        null,
        sessionId,
        expectedApprovedPdfSha256,
      );
    } catch (error) {
      const concurrent = this.dependencies.repository.getLatestApplicationSession(runId);
      if (concurrent && submissionCannotRetry(concurrent)) {
        throw new ApplicationSessionServiceError("APPLICATION_SUBMISSION_FINAL");
      }
      if (
        concurrent
        && concurrent.pdfSha256 === expectedApprovedPdfSha256
        && isLive(concurrent)
      ) {
        return await this.#resume(runId, concurrent, prepared, signal);
      }
      mapRepositoryError(error);
    }
    return await this.#resume(runId, reserved, prepared, signal);
  }

  async retry(
    runId: string,
    expectedApprovedPdfSha256: string,
    signal: AbortSignal,
  ): Promise<ApplicationSessionSnapshotDto> {
    signal.throwIfAborted();
    await this.#reconcileApplicationSlot(signal);
    let previous: PublicApplicationSession | null;
    try {
      previous = this.dependencies.repository.getLatestApplicationSession(runId);
    } catch (error) {
      mapRepositoryError(error);
    }
    if (previous && submissionCannotRetry(previous)) {
      throw new ApplicationSessionServiceError("APPLICATION_SUBMISSION_FINAL");
    }
    if (!previous || !isTerminal(previous)) {
      throw new RunServiceError("RUN_CONFLICT", "application session is not terminal", 409);
    }
    if (previous.pdfSha256 !== expectedApprovedPdfSha256) {
      throw new RunServiceError("STALE_PDF", "approved PDF hash is stale", 409);
    }
    const prepared = await this.#prepareStart(runId, expectedApprovedPdfSha256, signal);

    let reserved: PublicApplicationSession;
    try {
      reserved = this.dependencies.repository.reserveApplicationSession(
        runId,
        previous.sessionId,
        this.#uuidFactory(),
        expectedApprovedPdfSha256,
      );
    } catch (error) {
      const concurrent = this.dependencies.repository.getLatestApplicationSession(runId);
      if (
        concurrent
        && concurrent.generation > previous.generation
        && concurrent.pdfSha256 === expectedApprovedPdfSha256
        && isLive(concurrent)
      ) {
        return await this.#resume(runId, concurrent, prepared, signal);
      }
      mapRepositoryError(error);
    }
    return await this.#resume(runId, reserved, prepared, signal);
  }

  async events(
    runId: string,
    cursor: ApplicationSessionEventCursor | undefined,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ApplicationSessionStreamItem>> {
    if (
      cursor !== undefined
      && (
        !Number.isSafeInteger(cursor.generation)
        || cursor.generation < 1
        || !Number.isSafeInteger(cursor.upstreamEventId)
        || cursor.upstreamEventId < 0
      )
    ) {
      throw new RunServiceError("INVALID_REQUEST", "Application event cursor is invalid", 400);
    }
    signal.throwIfAborted();
    let session: PublicApplicationSession | null;
    try {
      session = this.dependencies.repository.getLatestApplicationSession(runId);
    } catch (error) {
      mapRepositoryError(error);
    }
    if (!session || !isLive(session)) {
      throw new RunServiceError("RUN_CONFLICT", "application session is not live", 409);
    }
    const harness = this.dependencies.harness;
    if (!harness) throw applicationHarnessUnavailable();
    const lastUpstreamEventId = cursor?.generation === session.generation
      ? cursor.upstreamEventId
      : undefined;
    let upstreamEvents: AsyncIterable<ApplicationHarnessEvent>;
    try {
      upstreamEvents = await harness.stream(
        session.sessionId,
        lastUpstreamEventId,
        signal,
      );
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (
        error instanceof ApplicationHarnessError
        && error.code === "session_not_found"
        && session.publicSnapshot !== null
        && isLive(session)
      ) {
        this.#markLost(runId, session);
        throw new RunServiceError("RUN_CONFLICT", "application session is not live", 409);
      }
      this.#throwHarnessError(error);
    }

    return this.#streamEvents(
      runId,
      session,
      lastUpstreamEventId,
      upstreamEvents,
      signal,
    );
  }

  async *#streamEvents(
    runId: string,
    initialSession: PublicApplicationSession,
    clientUpstreamEventId: number | undefined,
    upstreamEvents: AsyncIterable<ApplicationHarnessEvent>,
    signal: AbortSignal,
  ): AsyncGenerator<ApplicationSessionStreamItem> {
    let session = initialSession;
    let lastDeliveredUpstreamEventId = clientUpstreamEventId ?? -1;
    let cleanupPending = false;
    const replaySnapshot = session.publicSnapshot === null
      ? null
      : ApplicationSessionSnapshotDtoSchema.safeParse(session.publicSnapshot);
    if (replaySnapshot !== null && !replaySnapshot.success) {
      throw applicationHarnessUnavailable();
    }
    if (
      session.lastUpstreamEventId !== null
      && (
        clientUpstreamEventId === undefined
        || clientUpstreamEventId < session.lastUpstreamEventId
      )
      && session.publicSnapshot !== null
    ) {
      lastDeliveredUpstreamEventId = session.lastUpstreamEventId;
      yield {
        id: `${session.generation}:${session.lastUpstreamEventId}`,
        event: ApplicationSessionEventDtoSchema.parse({
          generation: session.generation,
          event: "snapshot",
          session: this.#storedView(session),
          detail: {},
        }),
      };
    }
    try {
      for await (const event of upstreamEvents) {
        signal.throwIfAborted();
        if (
          TERMINAL_APPLICATION_STATES[event.session.state] === true
          && !event.session.slotReleased
        ) {
          cleanupPending = true;
        }
        const durable = this.dependencies.repository.getLatestApplicationSession(runId);
        if (!durable || durable.generation !== session.generation) {
          throw new RunServiceError("RUN_CONFLICT", "application session changed", 409);
        }
        session = durable;
        const persistedCursor = session.lastUpstreamEventId;
        if (persistedCursor !== null && event.id <= persistedCursor) {
          if (
            session.publicSnapshot !== null
            && session.bridgeState !== "reserved"
            && session.bridgeState !== "lost"
          ) {
            try {
              const recorded =
                this.dependencies.repository.recordApplicationSnapshotWithSlotTransition(
                  runId,
                  {
                    generation: session.generation,
                    sessionId: session.sessionId,
                    bridgeState: session.bridgeState,
                    publicSnapshot: session.publicSnapshot,
                    slotReleased: event.session.slotReleased,
                    lastUpstreamEventId: event.id,
                  },
                );
              session = recorded.session;
              this.#notifyApplicationSessionReleased(
                recorded.slotReleasedTransitioned,
              );
              if (session.slotReleased) cleanupPending = false;
            } catch (error) {
              mapRepositoryError(error);
            }
          }
          const replayCursor = session.lastUpstreamEventId;
          if (
            replayCursor !== null
            && replayCursor > lastDeliveredUpstreamEventId
            && session.publicSnapshot !== null
          ) {
            lastDeliveredUpstreamEventId = replayCursor;
            yield {
              id: `${session.generation}:${replayCursor}`,
              event: ApplicationSessionEventDtoSchema.parse({
                generation: session.generation,
                event: "snapshot",
                session: this.#storedView(session),
                detail: {},
              }),
            };
          }
          continue;
        }
        const durableSnapshot = session.publicSnapshot === null
          ? null
          : ApplicationSessionSnapshotDtoSchema.safeParse(session.publicSnapshot);
        if (durableSnapshot !== null && !durableSnapshot.success) {
          throw applicationHarnessUnavailable();
        }
        if (
          durableSnapshot?.success === true
          && event.session.updatedAt <= durableSnapshot.data.updatedAt
        ) {
          let retainedProjection = durableSnapshot.data;
          try {
            if (attemptingSubmissionEnded(session, event.session.state)) {
              this.dependencies.repository.finalizeApplicationSubmission(
                session.sessionId,
                "uncertain",
              );
              const finalized =
                this.dependencies.repository.getLatestApplicationSession(runId);
              if (
                !finalized
                || finalized.generation !== session.generation
                || finalized.sessionId !== session.sessionId
              ) {
                throw new RunServiceError(
                  "RUN_CONFLICT",
                  "application session changed",
                  409,
                );
              }
              session = finalized;
              retainedProjection = ApplicationSessionSnapshotDtoSchema.parse({
                ...this.#storedView(finalized),
                updatedAt: this.#nextProjectionUpdatedAt(finalized),
              });
            }
            if (
              retainedProjection.bridgeState === "reserved"
              || retainedProjection.bridgeState === "lost"
            ) {
              throw applicationHarnessUnavailable();
            }
            const recorded =
              this.dependencies.repository.recordApplicationSnapshotWithSlotTransition(
                runId,
                {
                  generation: session.generation,
                  sessionId: session.sessionId,
                  bridgeState: retainedProjection.bridgeState,
                  publicSnapshot: retainedProjection,
                  slotReleased: event.session.slotReleased,
                  lastUpstreamEventId: event.id,
                },
              );
            session = recorded.session;
            this.#notifyApplicationSessionReleased(
              recorded.slotReleasedTransitioned,
            );
            if (session.slotReleased) cleanupPending = false;
          } catch (error) {
            mapRepositoryError(error);
          }
          if (event.id > lastDeliveredUpstreamEventId) {
            lastDeliveredUpstreamEventId = event.id;
            yield {
              id: `${session.generation}:${event.id}`,
              event: ApplicationSessionEventDtoSchema.parse({
                generation: session.generation,
                event: "snapshot",
                session: this.#storedView(session),
                detail: {},
              }),
            };
          }
          continue;
        }
        this.#recordHarnessSnapshot(
          runId,
          session,
          event.session,
          event.id,
          false,
        );
        const recorded = this.dependencies.repository.getLatestApplicationSession(runId);
        if (!recorded || recorded.generation !== session.generation) {
          throw new RunServiceError("RUN_CONFLICT", "application session changed", 409);
        }
        session = recorded;
        if (session.slotReleased) cleanupPending = false;
        if (recorded.lastUpstreamEventId !== event.id) {
          if (
            recorded.lastUpstreamEventId !== null
            && recorded.lastUpstreamEventId > lastDeliveredUpstreamEventId
            && recorded.publicSnapshot !== null
          ) {
            lastDeliveredUpstreamEventId = recorded.lastUpstreamEventId;
            yield {
              id: `${recorded.generation}:${recorded.lastUpstreamEventId}`,
              event: ApplicationSessionEventDtoSchema.parse({
                generation: recorded.generation,
                event: "snapshot",
                session: this.#storedView(recorded),
                detail: {},
              }),
            };
          }
          continue;
        }
        const projected = ApplicationSessionEventDtoSchema.parse({
          generation: session.generation,
          event: event.event,
          session: this.#storedView(recorded),
          detail: event.detail,
        });
        lastDeliveredUpstreamEventId = event.id;
        yield {
          id: `${session.generation}:${event.id}`,
          event: projected,
        };
      }
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof RunServiceError || error instanceof ApplicationSessionServiceError) {
        throw error;
      }
      if (error instanceof ApplicationHarnessError && error.code === "session_not_found") {
        if (session.publicSnapshot !== null && isLive(session)) {
          this.#markLost(runId, session);
          return;
        }
      }
      this.#throwHarnessError(error);
    } finally {
      if (cleanupPending && !session.slotReleased) {
        this.#ensureSlotReleaseObserver(runId, session);
      }
    }
  }

  async command(
    runId: string,
    command: ApplicationSessionCommand,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    let session: PublicApplicationSession | null;
    try {
      session = this.dependencies.repository.getLatestApplicationSession(runId);
    } catch (error) {
      mapRepositoryError(error);
    }
    if (
      session
      && command.type !== "steer"
      && retainedSubmissionFinal(session)
    ) {
      throw new ApplicationSessionServiceError("APPLICATION_SUBMISSION_FINAL");
    }
    if (
      !session
      || !isLive(session)
      || session.bridgeState === "reserved"
      || session.submissionPhase === "attempting"
      || (
        command.type === "steer"
        && (
          session.bridgeState !== "running"
          || retainedSubmissionFinal(session)
        )
      )
      || (
        command.type === "submit"
        && session.bridgeState !== "awaiting_human_review"
      )
    ) {
      throw new ApplicationSessionServiceError("APPLICATION_COMMAND_CONFLICT");
    }
    const harness = this.dependencies.harness;
    if (!harness) throw applicationHarnessUnavailable();
    try {
      await harness.command(session.sessionId, command, signal);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (
        error instanceof ApplicationHarnessError
        && (error.code === "command_conflict" || error.code === "session_terminal")
      ) {
        try {
          const snapshot = await harness.get(session.sessionId, signal);
          this.#recordHarnessSnapshot(runId, session, snapshot);
        } catch (reconciliationError) {
          if (signal.aborted) signal.throwIfAborted();
          if (
            reconciliationError instanceof ApplicationHarnessError
            && reconciliationError.code === "session_not_found"
          ) {
            if (session.publicSnapshot !== null) this.#markLost(runId, session);
            throw new ApplicationSessionServiceError("APPLICATION_COMMAND_CONFLICT");
          }
          if (
            reconciliationError instanceof RunServiceError
            || reconciliationError instanceof ApplicationSessionServiceError
          ) {
            throw reconciliationError;
          }
          this.#throwHarnessError(reconciliationError);
        }
        throw new ApplicationSessionServiceError("APPLICATION_COMMAND_CONFLICT");
      }
      if (
        error instanceof ApplicationHarnessError
        && (
          error.code === "invalid_request"
          || error.code === "session_not_found"
        )
      ) {
        if (error.code === "session_not_found" && session.publicSnapshot !== null) {
          this.#markLost(runId, session);
        }
        throw new ApplicationSessionServiceError("APPLICATION_COMMAND_CONFLICT");
      }
      this.#throwHarnessError(error);
    }
  }

  async close(runId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let session: PublicApplicationSession | null;
    try {
      session = this.dependencies.repository.getLatestApplicationSession(runId);
    } catch (error) {
      mapRepositoryError(error);
    }
    if (!session) return;
    let waitedForResume = false;
    const pendingResumes = this.#pendingResumes.get(session.sessionId);
    if (pendingResumes) {
      waitedForResume = true;
      await Promise.allSettled([...pendingResumes]);
      signal.throwIfAborted();
      session = this.dependencies.repository.getLatestApplicationSession(runId);
      if (!session) return;
    }
    if (session.submissionPhase === "attempting") {
      try {
        this.dependencies.repository.finalizeApplicationSubmission(
          session.sessionId,
          "uncertain",
        );
        const finalized = this.dependencies.repository.getLatestApplicationSession(runId);
        if (
          !finalized
          || finalized.generation !== session.generation
          || finalized.sessionId !== session.sessionId
        ) {
          throw new RepositoryConflictError("application session changed");
        }
        session = finalized;
      } catch (error) {
        const finalized = this.dependencies.repository.getLatestApplicationSession(runId);
        if (
          finalized
          && finalized.generation === session.generation
          && finalized.sessionId === session.sessionId
          && retainedSubmissionFinal(finalized)
        ) {
          session = finalized;
        } else {
          mapRepositoryError(error);
        }
      }
    }
    if (session.bridgeState === "lost") {
      const closed = this.#closedProjection(session, null);
      try {
        this.dependencies.repository.closeLostApplicationSession(runId, {
          generation: session.generation,
          sessionId: session.sessionId,
          publicSnapshot: closed,
        });
      } catch (error) {
        mapRepositoryError(error);
      }
      return;
    }
    if (session.bridgeState === "closed") return;
    if (session.bridgeState === "reserved" && !waitedForResume) {
      this.#recordLocalClosed(runId, session);
      return;
    }

    const harness = this.dependencies.harness;
    if (!harness) throw applicationHarnessUnavailable();
    try {
      await harness.delete(session.sessionId, signal);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof ApplicationHarnessError && error.code === "session_not_found") {
        if (retainedSubmissionFinal(session)) {
          this.#recordLocalClosed(runId, session);
          return;
        }
        if (
          session.publicSnapshot === null
          || session.bridgeState === "cancelled"
          || session.bridgeState === "failed"
        ) {
          this.#recordLocalClosed(runId, session);
        } else {
          this.#markLost(runId, session);
        }
        return;
      }
      this.#throwHarnessError(error);
    }
    const closed = this.#closedProjection(session, "closed");
    try {
      const recorded =
        this.dependencies.repository.recordApplicationSnapshotWithSlotTransition(
          runId,
          {
            generation: session.generation,
            sessionId: session.sessionId,
            bridgeState: "closed",
            publicSnapshot: closed,
            slotReleased: true,
          },
        );
      this.#notifyApplicationSessionReleased(recorded.slotReleasedTransitioned);
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async #currentPendingTextQuestion(
    runId: string,
    questionId: string,
    signal: AbortSignal,
  ): Promise<PendingTextQuestionIdentity> {
    signal.throwIfAborted();
    let session: PublicApplicationSession | null;
    try {
      session = this.dependencies.repository.getLatestApplicationSession(runId);
    } catch (error) {
      mapRepositoryError(error);
    }
    const run = this.dependencies.repository.getRun(runId);
    if (
      !session
      || !run
      || !isLive(session)
      || session.bridgeState === "reserved"
      || isSupersededApplicationSession(session, run.currentRevision)
      || session.resumeRevision !== run.currentRevision
      || session.slotReleased
    ) {
      throw new ApplicationSessionServiceError("APPLICATION_QUESTION_STALE");
    }
    const harness = this.dependencies.harness;
    if (!harness) throw applicationHarnessUnavailable();

    let snapshot: ApplicationHarnessSnapshot;
    try {
      snapshot = await harness.get(session.sessionId, signal);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (
        error instanceof ApplicationHarnessError
        && (
          error.code === "session_not_found"
          || error.code === "session_terminal"
          || error.code === "command_conflict"
          || error.code === "invalid_request"
        )
      ) {
        throw new ApplicationSessionServiceError("APPLICATION_QUESTION_STALE");
      }
      this.#throwHarnessError(error);
    }
    let current: PublicApplicationSession | null;
    try {
      current = this.dependencies.repository.getLatestApplicationSession(runId);
    } catch (error) {
      mapRepositoryError(error);
    }
    const currentRun = this.dependencies.repository.getRun(runId);
    if (
      !current
      || !currentRun
      || isSupersededApplicationSession(current, currentRun.currentRevision)
      || current.resumeRevision !== currentRun.currentRevision
      || !isLive(current)
      || current.slotReleased
      || current.sessionId !== session.sessionId
      || current.generation !== session.generation
      || snapshot.state !== "awaiting_additional_info"
      || snapshot.pendingAction?.type !== "additional_info"
    ) {
      throw new ApplicationSessionServiceError("APPLICATION_QUESTION_STALE");
    }
    const question = snapshot.pendingAction.questions.find(
      (candidate) => candidate.id === questionId,
    );
    if (!question || question.answerType !== "text") {
      throw new ApplicationSessionServiceError("APPLICATION_QUESTION_STALE");
    }
    return {
      sessionId: session.sessionId,
      generation: session.generation,
      question,
    };
  }

  async #prepareStart(
    runId: string,
    expectedApprovedPdfSha256: string,
    signal: AbortSignal,
  ): Promise<PreparedStart> {
    const run = this.dependencies.repository.getRun(runId);
    if (!run) throw new RunServiceError("RUN_NOT_FOUND", "run not found", 404);
    if (run.status !== "approved") {
      throw new RunServiceError("RUN_CONFLICT", "run is not approved", 409);
    }
    if (run.approvedPdfSha256 !== expectedApprovedPdfSha256) {
      throw new RunServiceError("STALE_PDF", "approved PDF hash is stale", 409);
    }
    try {
      if (!this.dependencies.repository.areRunArtifactsRetained(runId)) throw runArtifactsPruned();
    } catch (error) {
      mapRepositoryError(error);
    }
    let jobUrl: string | null;
    try {
      jobUrl = this.dependencies.repository.getRunJobUrl(runId);
    } catch (error) {
      mapRepositoryError(error);
    }
    if (jobUrl === null || !isHarnessCompatibleJobUrl(jobUrl)) throw applicationSourceUnavailable();
    if (!this.dependencies.harness) throw applicationHarnessUnavailable();

    let profile: string;
    try {
      profile = validateProfileText(await this.#profileReader());
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      throw applicationSourceUnavailable();
    }
    signal.throwIfAborted();
    const pdf = this.dependencies.repository.getArtifact(runId, "compiled-pdf", run.currentRevision);
    if (!pdf || pdf.sha256 !== expectedApprovedPdfSha256) throw applicationSourceUnavailable();
    return {
      jobUrl,
      opportunityKind: run.opportunityKind,
      autoSubmit: run.autoSubmit,
      profile,
      pdf,
    };
  }

  #resume(
    runId: string,
    session: PublicApplicationSession,
    preparedInput: PreparedStart | (() => Promise<PreparedStart>),
    signal: AbortSignal,
  ): Promise<ApplicationSessionSnapshotDto> {
    const pending = this.#resumeOnce(runId, session, preparedInput, signal);
    const resumes = this.#pendingResumes.get(session.sessionId) ?? new Set();
    resumes.add(pending);
    this.#pendingResumes.set(session.sessionId, resumes);
    const cleanup = () => {
      resumes.delete(pending);
      if (resumes.size === 0) this.#pendingResumes.delete(session.sessionId);
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }

  async #resumeOnce(
    runId: string,
    session: PublicApplicationSession,
    preparedInput: PreparedStart | (() => Promise<PreparedStart>),
    signal: AbortSignal,
  ): Promise<ApplicationSessionSnapshotDto> {
    const harness = this.dependencies.harness;
    if (!harness) throw applicationHarnessUnavailable();
    try {
      const snapshot = await harness.get(session.sessionId, signal);
      return this.#recordHarnessSnapshot(runId, session, snapshot);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (!(error instanceof ApplicationHarnessError) || error.code !== "session_not_found") {
        this.#throwHarnessError(error);
      }
    }

    if (session.publicSnapshot !== null) return this.#markLost(runId, session);
    const prepared = typeof preparedInput === "function"
      ? await preparedInput()
      : preparedInput;

    let resumePdf: Uint8Array;
    try {
      const current = this.dependencies.repository.getArtifact(
        runId,
        "compiled-pdf",
        session.resumeRevision,
      );
      if (
        !current
        || current.id !== prepared.pdf.id
        || current.sha256 !== prepared.pdf.sha256
        || current.sha256 !== session.pdfSha256
        || current.byteSize !== prepared.pdf.byteSize
      ) {
        throw new Error("approved PDF metadata changed");
      }
      const verified = await readVerifiedArtifactBytes(
        this.dependencies.artifacts,
        current,
        MAX_COMPILED_PDF_BYTES,
      );
      signal.throwIfAborted();
      if (
        verified.bytes.byteLength < 5
        || String.fromCharCode(...verified.bytes.subarray(0, 5)) !== "%PDF-"
      ) {
        throw new Error("approved PDF is not a PDF");
      }
      resumePdf = verified.bytes;
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      this.#recordLocalClosed(runId, session);
      throw applicationSourceUnavailable();
    }

    try {
      await harness.create({
        sessionId: session.sessionId,
        jobUrl: prepared.jobUrl,
        opportunityKind: prepared.opportunityKind,
        autoSubmit: prepared.autoSubmit,
        personalInformationMarkdown: prepared.profile,
        resumePdf,
      }, signal);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof ApplicationHarnessError) {
        if (error.code === "session_active_same_id" || error.code === "session_terminal") {
          // The same caller-owned UUID exists; the subsequent GET is authoritative.
        } else if (error.code === "session_active_different_id") {
          throw new ApplicationSessionServiceError("APPLICATION_SESSION_BUSY");
        } else if (error.code === "invalid_request") {
          this.#recordLocalClosed(runId, session);
          throw applicationSourceUnavailable();
        } else {
          throw applicationHarnessUnavailable();
        }
      } else {
        throw applicationHarnessUnavailable();
      }
    }

    try {
      const snapshot = await harness.get(session.sessionId, signal);
      return this.#recordHarnessSnapshot(runId, session, snapshot);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      this.#throwHarnessError(error);
    }
  }

  #recordHarnessSnapshot(
    runId: string,
    session: PublicApplicationSession,
    snapshot: ApplicationHarnessSnapshot,
    lastUpstreamEventId?: number,
    observeSlotRelease = true,
  ): ApplicationSessionSnapshotDto {
    let current = this.dependencies.repository.getLatestApplicationSession(runId);
    if (
      !current
      || current.generation !== session.generation
      || current.sessionId !== session.sessionId
    ) {
      throw new RunServiceError("RUN_CONFLICT", "application session changed", 409);
    }
    if (attemptingSubmissionEnded(current, snapshot.state)) {
      this.dependencies.repository.finalizeApplicationSubmission(
        current.sessionId,
        "uncertain",
      );
      current = this.dependencies.repository.getLatestApplicationSession(runId);
      if (
        !current
        || current.generation !== session.generation
        || current.sessionId !== session.sessionId
      ) {
        throw new RunServiceError("RUN_CONFLICT", "application session changed", 409);
      }
    }
    const bridgeState = durableBridgeState(current, snapshot.state);
    if (bridgeState === "reserved" || bridgeState === "lost") {
      throw applicationHarnessUnavailable();
    }
    const updatedAt = Math.max(snapshot.updatedAt, current.updatedAt);
    const terminalAt = TERMINAL_APPLICATION_STATES[bridgeState] === true
      ? (current.terminalAt ?? updatedAt)
      : null;
    const uncertainWarnings = snapshot.warnings.filter(
      (warning) => warning !== APPLICATION_SUBMISSION_UNCERTAIN_WARNING,
    ).slice(0, 99);
    const projected = ApplicationSessionSnapshotDtoSchema.parse({
      generation: current.generation,
      bridgeState,
      harnessState: bridgeState,
      submissionPhase: current.submissionPhase,
      createdAt: current.createdAt,
      updatedAt,
      terminalAt,
      expiresAt: snapshot.expiresAt,
      company: snapshot.company,
      role: snapshot.role,
      fieldsFilled: snapshot.fieldsFilled,
      fieldsNeedingHuman: snapshot.fieldsNeedingHuman,
      filesAttached: snapshot.filesAttached,
      playwrightCliDiagnostics: snapshot.playwrightCliDiagnostics,
      warnings: current.submissionPhase === "uncertain"
        ? [...uncertainWarnings, APPLICATION_SUBMISSION_UNCERTAIN_WARNING]
        : snapshot.warnings,
      revisionCount: snapshot.revisionCount,
      pendingAction: bridgeState === snapshot.state ? snapshot.pendingAction : null,
      error: bridgeState === "failed" ? snapshot.error : null,
    });
    try {
      const result =
        this.dependencies.repository.recordApplicationSnapshotWithSlotTransition(
          runId,
          {
            generation: current.generation,
            sessionId: current.sessionId,
            bridgeState,
            publicSnapshot: projected,
            slotReleased: snapshot.slotReleased,
            ...(lastUpstreamEventId !== undefined ? { lastUpstreamEventId } : {}),
          },
        );
      const recorded = result.session;
      this.#notifyApplicationSessionReleased(result.slotReleasedTransitioned);
      if (
        observeSlotRelease
        && TERMINAL_APPLICATION_STATES[snapshot.state] === true
        && !recorded.slotReleased
      ) {
        this.#ensureSlotReleaseObserver(runId, recorded);
      }
      return this.#storedView(recorded);
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  #nextProjectionUpdatedAt(session: PublicApplicationSession): number {
    const parsed = ApplicationSessionSnapshotDtoSchema.safeParse(session.publicSnapshot);
    const snapshotUpdatedAt = parsed.success ? parsed.data.updatedAt : 0;
    return Math.max(session.updatedAt + 1, snapshotUpdatedAt + 1, this.#now());
  }

  #markLost(
    runId: string,
    session: PublicApplicationSession,
  ): ApplicationSessionSnapshotDto {
    const current = this.dependencies.repository.getLatestApplicationSession(runId);
    if (
      !current
      || current.generation !== session.generation
      || current.sessionId !== session.sessionId
    ) {
      throw new RunServiceError("RUN_CONFLICT", "application session changed", 409);
    }
    if (current.submissionPhase === "attempting") {
      try {
        this.dependencies.repository.finalizeApplicationSubmission(
          current.sessionId,
          "uncertain",
        );
        const finalized = this.dependencies.repository.getLatestApplicationSession(runId);
        if (!finalized || finalized.generation !== current.generation) {
          throw new RepositoryConflictError("application session changed");
        }
        const uncertain = this.#storedView(finalized);
        if (finalized.bridgeState === "closed") return uncertain;
        const result =
          this.dependencies.repository.recordApplicationSnapshotWithSlotTransition(
            runId,
            {
              generation: finalized.generation,
              sessionId: finalized.sessionId,
              bridgeState: "submission_uncertain",
              publicSnapshot: uncertain,
              slotReleased: true,
            },
          );
        const recorded = result.session;
        this.#notifyApplicationSessionReleased(result.slotReleasedTransitioned);
        return this.#storedView(recorded);
      } catch (error) {
        mapRepositoryError(error);
      }
    }
    if (retainedSubmissionFinal(current)) {
      try {
        const released =
          this.dependencies.repository.releaseApplicationSessionSlotWithTransition(
            current.runId,
            current.generation,
            current.sessionId,
          );
        this.#notifyApplicationSessionReleased(released.slotReleasedTransitioned);
        return this.#storedView(released.session);
      } catch (error) {
        mapRepositoryError(error);
      }
    }

    const previous = this.#storedView(current);
    const updatedAt = this.#nextProjectionUpdatedAt(current);
    const lost = ApplicationSessionSnapshotDtoSchema.parse({
      ...previous,
      generation: current.generation,
      bridgeState: "lost",
      createdAt: current.createdAt,
      updatedAt,
      terminalAt: current.terminalAt ?? updatedAt,
      pendingAction: null,
      error: null,
      warnings: previous.warnings.includes(LOST_WARNING)
        ? previous.warnings
        : [...previous.warnings, LOST_WARNING],
    });
    try {
      const result =
        this.dependencies.repository.markApplicationSessionLostWithTransition(runId, {
          generation: current.generation,
          sessionId: current.sessionId,
          publicSnapshot: lost,
        });
      this.#notifyApplicationSessionReleased(result.slotReleasedTransitioned);
      return this.#storedView(result.session);
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  #closedProjection(
    session: PublicApplicationSession,
    harnessState: "closed" | null,
  ): ApplicationSessionSnapshotDto {
    const previous = this.#storedView(session);
    const updatedAt = this.#nextProjectionUpdatedAt(session);
    return ApplicationSessionSnapshotDtoSchema.parse({
      ...previous,
      generation: session.generation,
      bridgeState: "closed",
      harnessState,
      createdAt: session.createdAt,
      updatedAt,
      terminalAt: session.terminalAt ?? updatedAt,
      pendingAction: null,
      error: null,
    });
  }

  #recordLocalClosed(runId: string, session: PublicApplicationSession): void {
    const closed = this.#closedProjection(session, null);
    try {
      const recorded =
        this.dependencies.repository.recordApplicationSnapshotWithSlotTransition(
          runId,
          {
            generation: session.generation,
            sessionId: session.sessionId,
            bridgeState: "closed",
            publicSnapshot: closed,
            slotReleased: true,
          },
        );
      this.#notifyApplicationSessionReleased(recorded.slotReleasedTransitioned);
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  async #reconcileApplicationSlot(
    signal: AbortSignal,
    resumableRunId?: string,
  ): Promise<void> {
    let session: PublicApplicationSession | null;
    try {
      session = this.dependencies.repository.getUnreleasedApplicationSession();
    } catch (error) {
      mapRepositoryError(error);
    }
    if (
      session
      && session.runId === resumableRunId
      && session.publicSnapshot === null
      && (session.bridgeState === "reserved" || session.bridgeState === "starting")
    ) {
      return;
    }
    if (!session) return;
    const harness = this.dependencies.harness;
    if (!harness) return;
    try {
      const snapshot = await harness.get(session.sessionId, signal);
      this.#recordHarnessSnapshot(session.runId, session, snapshot);
      const current =
        this.dependencies.repository.getLatestApplicationSession(session.runId);
      if (
        current
        && current.generation === session.generation
        && current.sessionId === session.sessionId
        && !current.slotReleased
      ) {
        this.#ensureSlotReleaseObserver(current.runId, current);
      }
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof ApplicationHarnessError && error.code === "session_not_found") {
        this.#reconcileMissingHarnessSession(session);
        return;
      }
      this.#throwHarnessError(error);
    }
  }

  #ensureSlotReleaseObserver(
    runId: string,
    session: PublicApplicationSession,
  ): void {
    if (
      this.#disposed
      ||
      session.slotReleased
      || this.#slotReleaseObservers.has(session.sessionId)
      || !this.dependencies.harness
    ) {
      return;
    }
    const observer = this.#observeSlotRelease(runId, session);
    this.#slotReleaseObservers.set(session.sessionId, observer);
    const cleanup = () => {
      if (this.#slotReleaseObservers.get(session.sessionId) === observer) {
        this.#slotReleaseObservers.delete(session.sessionId);
      }
    };
    void observer.then(cleanup, cleanup);
  }

  async #observeSlotRelease(
    runId: string,
    session: PublicApplicationSession,
  ): Promise<void> {
    const harness = this.dependencies.harness;
    if (!harness) return;
    const signal = this.#slotReleaseAbortController.signal;
    let cursor = session.lastUpstreamEventId ?? undefined;
    for (;;) {
      if (signal.aborted) return;
      let current: PublicApplicationSession | null;
      try {
        current = this.dependencies.repository.getLatestApplicationSession(runId);
      } catch {
        return;
      }
      if (
        !current
        || current.generation !== session.generation
        || current.sessionId !== session.sessionId
        || current.slotReleased
      ) {
        return;
      }
      try {
        const events = await harness.stream(session.sessionId, cursor, signal);
        for await (const event of events) {
          if (signal.aborted) return;
          current = this.dependencies.repository.getLatestApplicationSession(runId);
          if (
            !current
            || current.generation !== session.generation
            || current.sessionId !== session.sessionId
          ) {
            return;
          }
          this.#recordHarnessSnapshot(
            runId,
            current,
            event.session,
            event.id,
            false,
          );
          current = this.dependencies.repository.getLatestApplicationSession(runId);
          if (!current || current.generation !== session.generation) return;
          cursor = current.lastUpstreamEventId ?? cursor;
          if (current.slotReleased) return;
        }
        if (signal.aborted) return;
        current = this.dependencies.repository.getLatestApplicationSession(runId);
        if (
          !current
          || current.generation !== session.generation
          || current.sessionId !== session.sessionId
          || current.slotReleased
        ) {
          return;
        }
        const snapshot = await harness.get(session.sessionId, signal);
        this.#recordHarnessSnapshot(runId, current, snapshot, undefined, false);
        current = this.dependencies.repository.getLatestApplicationSession(runId);
        if (!current || current.generation !== session.generation || current.slotReleased) {
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ApplicationHarnessError && error.code === "session_not_found") {
          this.#reconcileMissingHarnessSession(session);
          return;
        }
      }
      if (signal.aborted) return;
      await waitForSlotReleaseRetry();
    }
  }

  #reconcileMissingHarnessSession(session: PublicApplicationSession): void {
    const current =
      this.dependencies.repository.getLatestApplicationSession(session.runId);
    if (
      !current
      || current.generation !== session.generation
      || current.sessionId !== session.sessionId
      || current.slotReleased
    ) {
      return;
    }
    if (current.publicSnapshot === null) {
      this.#recordLocalClosed(current.runId, current);
      return;
    }
    if (TERMINAL_APPLICATION_STATES[current.bridgeState] !== true) {
      this.#markLost(current.runId, current);
      return;
    }
    try {
      const released =
        this.dependencies.repository.releaseApplicationSessionSlotWithTransition(
          current.runId,
          current.generation,
          current.sessionId,
        );
      this.#notifyApplicationSessionReleased(released.slotReleasedTransitioned);
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  #notifyApplicationSessionReleased(slotReleasedTransitioned: boolean): void {
    if (slotReleasedTransitioned && !this.#disposed) {
      this.dependencies.onApplicationSessionReleased?.();
    }
  }

  #storedView(session: PublicApplicationSession): ApplicationSessionSnapshotDto {
    const bridgeState = durableBridgeState(session);
    if (session.publicSnapshot !== null) {
      const parsed = ApplicationSessionSnapshotDtoSchema.safeParse(session.publicSnapshot);
      if (!parsed.success) throw applicationHarnessUnavailable();
      const warnings = parsed.data.warnings.filter(
        (warning) => warning !== APPLICATION_SUBMISSION_UNCERTAIN_WARNING,
      ).slice(0, 99);
      const authoritative = ApplicationSessionSnapshotDtoSchema.safeParse({
        ...parsed.data,
        generation: session.generation,
        bridgeState,
        harnessState: bridgeState === "closed"
          ? (parsed.data.harnessState === "closed" ? "closed" : null)
          : bridgeState === "lost"
            ? parsed.data.harnessState
            : bridgeState,
        submissionPhase: session.submissionPhase,
        createdAt: session.createdAt,
        updatedAt: Math.max(session.updatedAt, parsed.data.updatedAt),
        terminalAt: session.terminalAt,
        pendingAction: bridgeState === parsed.data.bridgeState
          ? parsed.data.pendingAction
          : null,
        error: bridgeState === "failed" ? parsed.data.error : null,
        warnings: session.submissionPhase === "uncertain"
          ? [...warnings, APPLICATION_SUBMISSION_UNCERTAIN_WARNING]
          : parsed.data.warnings,
      });
      if (!authoritative.success) throw applicationHarnessUnavailable();
      return authoritative.data;
    }
    if (bridgeState === "failed") throw applicationHarnessUnavailable();
    return ApplicationSessionSnapshotDtoSchema.parse({
      generation: session.generation,
      bridgeState,
      harnessState: bridgeState === "reserved" || bridgeState === "closed"
        ? null
        : bridgeState === "lost"
          ? null
          : bridgeState,
      submissionPhase: session.submissionPhase,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      terminalAt: session.terminalAt,
      expiresAt: null,
      company: null,
      role: null,
      fieldsFilled: [],
      fieldsNeedingHuman: [],
      filesAttached: [],
      playwrightCliDiagnostics: [],
      warnings: session.submissionPhase === "uncertain"
        ? [APPLICATION_SUBMISSION_UNCERTAIN_WARNING]
        : bridgeState === "lost"
          ? [LOST_WARNING]
          : [],
      revisionCount: 0,
      pendingAction: null,
      error: null,
    });
  }

  #notStarted(blockedReason: "legacy_job_url_unavailable" | "job_url_requires_https" | "resume_not_approved" | "artifacts_pruned" | "harness_unconfigured" | "profile_unavailable"): ApplicationSessionView {
    return ApplicationSessionViewSchema.parse({
      state: "not_started",
      canStart: false,
      canStartAfterApproval: false,
      blockedReason,
    });
  }

  #throwHarnessError(error: unknown): never {
    if (error instanceof ApplicationHarnessError) {
      if (error.code === "session_active_different_id") {
        throw new ApplicationSessionServiceError("APPLICATION_SESSION_BUSY");
      }
    }
    throw applicationHarnessUnavailable();
  }
}
