import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  ApplicationSessionEventDtoSchema,
  ApplicationSessionSnapshotDtoSchema,
  ApplicationSessionViewSchema,
  type ApplicationSessionEventDto,
  type ApplicationSessionCommand,
  type ApplicationSessionSnapshotDto,
  type ApplicationSessionView,
} from "../contracts/index.ts";
import { REPOSITORY_ROOT } from "../context/manifest.ts";
import {
  PipelineRepository,
  RepositoryConflictError,
  RunArtifactsPrunedError,
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
  MAX_COMPILED_PDF_BYTES,
  readVerifiedArtifactBytes,
  RunServiceError,
} from "./run-service.ts";

const MAX_PROFILE_BYTES = 1024 * 1024;
const PROFILE_RELATIVE_PATH = "apps/user-info/current-context/personal/applicant-profile.md";
const LOST_WARNING = "Verify whether the application was submitted before retrying.";

const LIVE_APPLICATION_STATES: Readonly<Record<string, true>> = Object.freeze({
  reserved: true,
  starting: true,
  running: true,
  awaiting_human_navigation: true,
  awaiting_origin_approval: true,
  awaiting_additional_info: true,
  awaiting_human_review: true,
  ready_for_human_submit: true,
});

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
  | "APPLICATION_COMMAND_CONFLICT";

const SERVICE_ERRORS: Readonly<
  Record<ApplicationSessionServiceErrorCode, { readonly message: string; readonly status: 409 | 503 }>
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
});

export class ApplicationSessionServiceError extends Error {
  readonly status: 409 | 503;

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
    return (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname)))
      && url.username === ""
      && url.password === ""
      && url.hash === "";
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

interface PreparedStart {
  readonly jobUrl: string;
  readonly profile: string;
  readonly pdf: PublicArtifact;
}

export class ApplicationSessionService {
  readonly #uuidFactory: () => string;
  readonly #now: () => number;
  readonly #profileReader: ApplicantProfileReader;

  constructor(private readonly dependencies: ApplicationSessionServiceDependencies) {
    this.#uuidFactory = dependencies.uuidFactory ?? randomUUID;
    this.#now = dependencies.now ?? Date.now;
    this.#profileReader = dependencies.profileReader ?? (() => readApplicantProfileMarkdown());
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
    if (latest) return this.#storedView(latest);

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

  async start(
    runId: string,
    expectedApprovedPdfSha256: string,
    signal: AbortSignal,
  ): Promise<ApplicationSessionSnapshotDto> {
    signal.throwIfAborted();
    let latest: PublicApplicationSession | null;
    try {
      latest = this.dependencies.repository.getLatestApplicationSession(runId);
    } catch (error) {
      mapRepositoryError(error);
    }
    if (latest) {
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
    const prepared = await this.#prepareStart(runId, expectedApprovedPdfSha256, signal);
    let previous: PublicApplicationSession | null;
    try {
      previous = this.dependencies.repository.getLatestApplicationSession(runId);
    } catch (error) {
      mapRepositoryError(error);
    }
    if (!previous || !isTerminal(previous)) {
      throw new RunServiceError("RUN_CONFLICT", "application session is not terminal", 409);
    }
    if (previous.pdfSha256 !== expectedApprovedPdfSha256) {
      throw new RunServiceError("STALE_PDF", "approved PDF hash is stale", 409);
    }

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
    const replaySnapshot = session.publicSnapshot === null
      ? null
      : ApplicationSessionSnapshotDtoSchema.safeParse(session.publicSnapshot);
    if (replaySnapshot !== null && !replaySnapshot.success) {
      throw applicationHarnessUnavailable();
    }
    const replayUpdatedAtFloor = replaySnapshot?.data.updatedAt ?? null;
    if (
      session.lastUpstreamEventId !== null
      && (
        clientUpstreamEventId === undefined
        || clientUpstreamEventId < session.lastUpstreamEventId
      )
      && session.publicSnapshot !== null
    ) {
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
          (
            session.lastUpstreamEventId !== null
            && event.id <= session.lastUpstreamEventId
          )
          || (
            replayUpdatedAtFloor !== null
            && event.session.updatedAt <= replayUpdatedAtFloor
          )
        ) {
          continue;
        }
        const snapshot = this.#recordHarnessSnapshot(
          runId,
          session,
          event.session,
          event.id,
        );
        const projected = ApplicationSessionEventDtoSchema.parse({
          generation: session.generation,
          event: event.event,
          session: snapshot,
          detail: event.detail,
        });
        const recorded = this.dependencies.repository.getLatestApplicationSession(runId);
        if (!recorded || recorded.generation !== session.generation) {
          throw new RunServiceError("RUN_CONFLICT", "application session changed", 409);
        }
        session = recorded;
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
    if (!session || !isLive(session) || session.bridgeState === "reserved") {
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
        && (
          error.code === "command_conflict"
          || error.code === "session_terminal"
          || error.code === "invalid_request"
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
    if (session.bridgeState === "reserved") {
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
      this.dependencies.repository.recordApplicationSnapshot(runId, {
        generation: session.generation,
        sessionId: session.sessionId,
        bridgeState: "closed",
        publicSnapshot: closed,
      });
    } catch (error) {
      mapRepositoryError(error);
    }
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
    return { jobUrl, profile, pdf };
  }

  async #resume(
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
  ): ApplicationSessionSnapshotDto {
    const updatedAt = snapshot.updatedAt;
    const terminalAt = TERMINAL_APPLICATION_STATES[snapshot.state] === true
      ? (session.terminalAt ?? updatedAt)
      : null;
    const projected = ApplicationSessionSnapshotDtoSchema.parse({
      generation: session.generation,
      bridgeState: snapshot.state,
      harnessState: snapshot.state,
      createdAt: session.createdAt,
      updatedAt,
      terminalAt,
      expiresAt: snapshot.expiresAt,
      company: snapshot.company,
      role: snapshot.role,
      fieldsFilled: snapshot.fieldsFilled,
      fieldsNeedingHuman: snapshot.fieldsNeedingHuman,
      filesAttached: snapshot.filesAttached,
      warnings: snapshot.warnings,
      revisionCount: snapshot.revisionCount,
      pendingAction: snapshot.pendingAction,
      error: snapshot.error,
    });
    try {
      const recorded = this.dependencies.repository.recordApplicationSnapshot(runId, {
        generation: session.generation,
        sessionId: session.sessionId,
        bridgeState: snapshot.state,
        publicSnapshot: projected,
        ...(lastUpstreamEventId !== undefined ? { lastUpstreamEventId } : {}),
      });
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
    const previous = this.#storedView(session);
    const updatedAt = this.#nextProjectionUpdatedAt(session);
    const lost = ApplicationSessionSnapshotDtoSchema.parse({
      ...previous,
      generation: session.generation,
      bridgeState: "lost",
      createdAt: session.createdAt,
      updatedAt,
      terminalAt: session.terminalAt ?? updatedAt,
      pendingAction: null,
      error: null,
      warnings: previous.warnings.includes(LOST_WARNING)
        ? previous.warnings
        : [...previous.warnings, LOST_WARNING],
    });
    try {
      const recorded = this.dependencies.repository.markApplicationSessionLost(runId, {
        generation: session.generation,
        sessionId: session.sessionId,
        publicSnapshot: lost,
      });
      return this.#storedView(recorded);
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
      this.dependencies.repository.recordApplicationSnapshot(runId, {
        generation: session.generation,
        sessionId: session.sessionId,
        bridgeState: "closed",
        publicSnapshot: closed,
      });
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  #storedView(session: PublicApplicationSession): ApplicationSessionSnapshotDto {
    if (session.publicSnapshot !== null) {
      const parsed = ApplicationSessionSnapshotDtoSchema.safeParse(session.publicSnapshot);
      if (!parsed.success) throw applicationHarnessUnavailable();
      const authoritative = ApplicationSessionSnapshotDtoSchema.safeParse({
        ...parsed.data,
        generation: session.generation,
        bridgeState: session.bridgeState,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        terminalAt: session.terminalAt,
      });
      if (!authoritative.success) throw applicationHarnessUnavailable();
      return authoritative.data;
    }
    if (session.bridgeState === "failed") throw applicationHarnessUnavailable();
    return ApplicationSessionSnapshotDtoSchema.parse({
      generation: session.generation,
      bridgeState: session.bridgeState,
      harnessState: session.bridgeState === "reserved" || session.bridgeState === "closed"
        ? null
        : session.bridgeState,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      terminalAt: session.terminalAt,
      expiresAt: null,
      company: null,
      role: null,
      fieldsFilled: [],
      fieldsNeedingHuman: [],
      filesAttached: [],
      warnings: session.bridgeState === "lost" ? [LOST_WARNING] : [],
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
