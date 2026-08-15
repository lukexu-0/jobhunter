import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { CLAIM_TTL_MS, createClaimToken, isProcessIdentityAlive, type ClaimTokenFactory, type RunClaim } from "../worker/claims.ts";
import {
  ACTIVE_APPLICATION_SESSION_BRIDGE_STATES,
  OpportunityKindSchema,
  RunIdentityTextSchema,
  type OpportunityKind,
} from "../contracts/index.ts";

export const RUN_STATUSES = ["queued", "analyzing", "tailoring", "editing", "compiling", "repairing", "deterministic_qa", "visual_qa", "review", "approved", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const APPLICATION_STATUSES = [
  "pending",
  "did_not_apply",
  "applied",
  "oa_received",
  "oa_completed",
  "rejected",
  "interview",
  "accepted",
  "failed",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export type ActiveStage = Exclude<RunStatus, "queued" | "review" | "approved" | "failed">;
export type RevisionOrigin = "initial" | "retry" | "machine_regenerate" | "human_edit";
export type AttemptOrigin = RevisionOrigin | "repair_loop";
export const HARNESS_SESSION_STATES = [
  "starting",
  "running",
  "awaiting_human_navigation",
  "awaiting_origin_approval",
  "awaiting_additional_info",
  "awaiting_human_review",
  "submitting",
  "submitted",
  "submission_uncertain",
  "cancelled",
  "failed",
  "closed",
] as const;
export type HarnessSessionState = (typeof HARNESS_SESSION_STATES)[number];
export type ApplicationSessionBridgeState = "reserved" | HarnessSessionState | "lost";
export type ApplicationSubmissionPhase =
  | "not_attempted"
  | "attempting"
  | "submitted"
  | "uncertain";
const TERMINAL_APPLICATION_SESSION_STATES: Readonly<Partial<Record<ApplicationSessionBridgeState, true>>> = {
  cancelled: true,
  failed: true,
  closed: true,
  lost: true,
};

export const APPLICATION_SUBMISSION_UNCERTAIN_WARNING =
  "The application submission could not be verified. Check the headed browser if it is still available, then close this session.";

export class RepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryConflictError";
  }
}

export type DiscoveryJobQueueConflictReason = "already_queued" | "not_found" | "closed";

export class DiscoveryJobQueueConflictError extends RepositoryConflictError {
  constructor(readonly reason: DiscoveryJobQueueConflictReason) {
    super(`discovery job cannot be queued: ${reason}`);
    this.name = "DiscoveryJobQueueConflictError";
  }
}

export class ClaimRejectedError extends RepositoryConflictError {
  constructor(message = "claim is stale, expired, or not the current owner") {
    super(message);
    this.name = "ClaimRejectedError";
  }
}

export class SourceDriftError extends RepositoryConflictError {
  readonly code = "SOURCE_DRIFT";

  constructor(message = "authoritative resume sources changed; create a new run") {
    super(message);
    this.name = "SourceDriftError";
  }
}

export class RunArtifactsPrunedError extends RepositoryConflictError {
  constructor(message = "run artifacts were removed") {
    super(message);
    this.name = "RunArtifactsPrunedError";
  }
}

export class ApplicationSubmissionFinalError extends RepositoryConflictError {
  constructor(message = "application submission cannot be retried") {
    super(message);
    this.name = "ApplicationSubmissionFinalError";
  }
}

interface RunRow {
  id: string;
  job_description: string;
  job_url: string | null;
  opportunity_kind: OpportunityKind;
  status: RunStatus;
  application_status: ApplicationStatus;
  generate_keyword_map: number;
  skip_review: number;
  auto_submit: number;
  title_override: string | null;
  organization_override: string | null;
  deleted_at: number | null;
  current_revision: number;
  failed_stage: ActiveStage | null;
  visual_ack_required: number;
  approved_pdf_sha256: string | null;
  queue_sequence: number;
  created_at: number;
  updated_at: number;
}
interface ClaimRow { run_id: string | null; claim_token: string | null; expires_at: number | null }
interface ClaimSlotRow extends ClaimRow { id: number }
interface AttemptRow {
  id: string; run_id: string; revision: number; stage: ActiveStage; attempt_no: number; origin: AttemptOrigin;
  claim_token: string; attempt_session_id: string; status: "running" | "cancel_requested" | "cancelled" | "succeeded" | "failed";
  process_pid: number | null; process_start_token: string | null; tool_count: number; compile_count: number;
  started_at: number; finished_at: number | null; cancellation_ack_at: number | null;
}
interface ArtifactRow {
  id: string; run_id: string; revision: number; attempt_id: string; stage: string; kind: string; sha256: string;
  path: string; byte_size: number; source_artifact_id: string | null; created_at: number;
}
interface PrunedRunArtifactManifestRow {
  run_id: string;
  queue_sequence: number;
  artifact_id: string | null;
  artifact_path: string | null;
  artifact_sha256: string | null;
  artifact_byte_size: number | null;
}
interface RevisionRow { run_id: string; revision: number; origin: RevisionOrigin; source_revision: number | null; retry_stage: ActiveStage | null; status: RunStatus; created_at: number }
interface EventRow { sequence: number; run_id: string; revision: number | null; kind: string; payload_json: string; created_at: number }
interface EditRequestRow { id: string; run_id: string; source_revision: number; target_revision: number; origin: "machine_regenerate" | "human_edit"; comments: string; expected_pdf_sha256: string; created_at: number }
interface ApplicationSessionRow {
  run_id: string;
  generation: number;
  session_id: string;
  resume_revision: number;
  pdf_sha256: string;
  bridge_state: ApplicationSessionBridgeState;
  submission_phase: ApplicationSubmissionPhase;
  automatic_review_ready: 0 | 1;
  slot_released: 0 | 1;
  submission_attempted_at: number | null;
  submission_confirmed_at: number | null;
  public_snapshot_json: string | null;
  last_upstream_event_id: number | null;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

export interface PublicRun {
  readonly id: string;
  readonly jobDescription: string;
  readonly jobUrl?: string;
  readonly opportunityKind: OpportunityKind;
  readonly status: RunStatus;
  readonly applicationStatus: ApplicationStatus;
  readonly titleOverride?: string;
  readonly organizationOverride?: string;
  readonly generateKeywordMap: boolean;
  readonly skipReview: boolean;
  readonly autoSubmit: boolean;
  readonly queueSequence: number;
  readonly currentRevision: number;
  readonly failedStage: ActiveStage | null;
  readonly visualAcknowledgementRequired: boolean;
  readonly approvedPdfSha256: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface PublicAttempt {
  readonly id: string; readonly attemptSessionId: string; readonly revision: number; readonly stage: ActiveStage; readonly attemptNo: number;
  readonly origin: AttemptOrigin; readonly status: AttemptRow["status"]; readonly processPid: number | null;
  readonly toolCount: number; readonly compileCount: number; readonly startedAt: number; readonly finishedAt: number | null;
  readonly cancellationAcknowledgedAt: number | null;
}
export interface PublicEvent { readonly sequence: number; readonly revision: number | null; readonly kind: string; readonly payload: unknown; readonly createdAt: number }
export interface PublicTimeline { readonly events: readonly PublicEvent[]; readonly attempts: readonly PublicAttempt[] }
export interface PublicArtifact { readonly id: string; readonly revision: number; readonly attemptId: string | null; readonly stage: string; readonly kind: string; readonly sha256: string; readonly path: string; readonly byteSize: number; readonly createdAt: number }
export interface PrunedRunArtifact {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly byteSize: number;
}

export interface PrunedRunArtifactManifest {
  readonly runId: string;
  readonly queueSequence: number;
  readonly artifacts: readonly PrunedRunArtifact[];
}
export interface PublicReviewableRevision {
  readonly revision: number;
  readonly status: "review" | "approved";
  readonly createdAt: number;
  readonly pdfSha256: string;
}
export interface RunSourceSnapshotInput {
  readonly manifestSha256: string;
  readonly baselineSha256: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
}
export interface PublicRunSourceSnapshot extends RunSourceSnapshotInput {
  readonly createdAt: number;
}
export interface QueuedInputArtifact {
  readonly id?: string;
  readonly sha256: string;
  readonly path: string;
  readonly byteSize: number;
}
export interface PublicEditRequest {
  readonly id: string;
  readonly sourceRevision: number;
  readonly targetRevision: number;
  readonly origin: "machine_regenerate" | "human_edit";
  readonly comments: string;
  readonly expectedPdfSha256: string;
  readonly createdAt: number;
}
export interface PublicApplicationSession {
  readonly runId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly resumeRevision: number;
  readonly pdfSha256: string;
  readonly bridgeState: ApplicationSessionBridgeState;
  readonly submissionPhase: ApplicationSubmissionPhase;
  readonly slotReleased: boolean;
  readonly publicSnapshot: unknown | null;
  readonly lastUpstreamEventId: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalAt: number | null;
}

interface ApplicationSnapshotRecordInput {
  readonly generation: number;
  readonly sessionId: string;
  readonly bridgeState: HarnessSessionState;
  readonly publicSnapshot: unknown;
  readonly slotReleased: boolean;
  readonly lastUpstreamEventId?: number;
}

export interface ApplicationSessionSlotTransitionResult {
  readonly session: PublicApplicationSession;
  readonly slotReleasedTransitioned: boolean;
}

export interface RepositoryOptions {
  readonly now?: () => number;
  readonly tokenFactory?: ClaimTokenFactory;
  readonly idFactory?: () => string;
  readonly attemptSessionIdFactory?: () => string;
  readonly isProcessAlive?: (pid: number, startToken: string) => boolean;
}

const transitionTargets: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["analyzing"], analyzing: ["tailoring", "failed"], tailoring: ["compiling", "failed"],
  editing: ["compiling", "failed"], compiling: ["repairing", "deterministic_qa", "failed"],
  repairing: ["compiling", "failed"], deterministic_qa: ["tailoring", "visual_qa", "failed"],
  visual_qa: ["review", "failed"], review: ["approved", "editing"], approved: [], failed: [],
};
const runnableStatuses = new Set<RunStatus>(["queued", "analyzing", "tailoring", "editing", "compiling", "repairing", "deterministic_qa", "visual_qa"]);
const stageRank: Readonly<Record<ActiveStage, number>> = { analyzing: 1, tailoring: 2, editing: 2, compiling: 3, repairing: 3, deterministic_qa: 4, visual_qa: 5 };
function artifactStageRank(stage: string): number | undefined {
  switch (stage) {
    case "input": return 0;
    case "analyzing": return 1;
    case "tailoring":
    case "editing": return 2;
    case "compiling":
    case "repairing": return 3;
    case "deterministic_qa": return 4;
    case "visual_qa":
    case "review": return 5;
    default: return undefined;
  }
}

function defaultIsProcessAlive(pid: number, startToken: string): boolean {
  return isProcessIdentityAlive(pid, startToken);
}
function assertSafePayload(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) assertSafePayload(item); return; }
  for (const [key, nested] of Object.entries(value)) {
    if (key.toLowerCase().includes("token") || key.toLowerCase().includes("claim")) throw new Error("event payload may not contain claim data");
    assertSafePayload(nested);
  }
}
function publicRun(row: RunRow): PublicRun {
  return {
    id: row.id,
    jobDescription: row.job_description,
    ...(row.job_url !== null ? { jobUrl: row.job_url } : {}),
    opportunityKind: row.opportunity_kind,
    status: row.status,
    applicationStatus: row.application_status,
    ...(row.title_override !== null ? { titleOverride: row.title_override } : {}),
    ...(row.organization_override !== null ? { organizationOverride: row.organization_override } : {}),
    generateKeywordMap: row.generate_keyword_map === 1,
    skipReview: row.skip_review === 1,
    autoSubmit: row.auto_submit === 1,
    queueSequence: row.queue_sequence,
    currentRevision: row.current_revision,
    failedStage: row.failed_stage,
    visualAcknowledgementRequired: row.visual_ack_required === 1,
    approvedPdfSha256: row.approved_pdf_sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function publicAttempt(row: AttemptRow): PublicAttempt {
  return { id: row.id, attemptSessionId: row.attempt_session_id, revision: row.revision, stage: row.stage, attemptNo: row.attempt_no, origin: row.origin,
    status: row.status, processPid: row.process_pid, toolCount: row.tool_count, compileCount: row.compile_count,
    startedAt: row.started_at, finishedAt: row.finished_at, cancellationAcknowledgedAt: row.cancellation_ack_at };
}
function publicApplicationSession(row: ApplicationSessionRow): PublicApplicationSession {
  return {
    runId: row.run_id,
    generation: row.generation,
    sessionId: row.session_id,
    resumeRevision: row.resume_revision,
    pdfSha256: row.pdf_sha256,
    bridgeState: row.bridge_state,
    submissionPhase: row.submission_phase,
    slotReleased: row.slot_released === 1,
    publicSnapshot: row.public_snapshot_json === null ? null : JSON.parse(row.public_snapshot_json) as unknown,
    lastUpstreamEventId: row.last_upstream_event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  };
}
function serializePublicApplicationSnapshot(snapshot: unknown): string {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("application snapshot must be an object");
  }
  const serialized = JSON.stringify(snapshot);
  if (typeof serialized !== "string") throw new Error("application snapshot is not serializable");
  return serialized;
}

function publicApplicationSnapshotUpdatedAt(snapshot: unknown): number | null {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const updatedAt = Reflect.get(snapshot, "updatedAt");
  return Number.isSafeInteger(updatedAt) && (updatedAt as number) >= 0
    ? updatedAt as number
    : null;
}

function submissionUncertainSnapshot(
  row: ApplicationSessionRow,
  updatedAt: number,
): string {
  let existing: Record<string, unknown>;
  if (row.public_snapshot_json === null) {
    existing = {
      generation: row.generation,
      createdAt: row.created_at,
      expiresAt: null,
      company: null,
      role: null,
      fieldsFilled: [],
      fieldsNeedingHuman: [],
      filesAttached: [],
      warnings: [],
      revisionCount: 0,
    };
  } else {
    const parsed = JSON.parse(row.public_snapshot_json) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("application session snapshot is not an object");
    }
    existing = parsed as Record<string, unknown>;
  }
  const warnings = Array.isArray(existing.warnings)
    ? existing.warnings.filter(
      (warning): warning is string => typeof warning === "string"
        && warning !== APPLICATION_SUBMISSION_UNCERTAIN_WARNING,
    ).slice(0, 99)
    : [];
  const closed = row.bridge_state === "closed";
  return JSON.stringify({
    ...existing,
    generation: row.generation,
    bridgeState: closed ? "closed" : "submission_uncertain",
    harnessState: closed
      ? (existing.harnessState === "closed" ? "closed" : null)
      : "submission_uncertain",
    submissionPhase: "uncertain",
    updatedAt,
    terminalAt: closed ? row.terminal_at : null,
    pendingAction: null,
    error: null,
    warnings: [...warnings, APPLICATION_SUBMISSION_UNCERTAIN_WARNING],
  });
}

export class PipelineRepository {
  readonly #db: Database;
  readonly #now: () => number;
  readonly #tokenFactory: ClaimTokenFactory;
  readonly #idFactory: () => string;
  readonly #attemptSessionIdFactory: () => string;
  readonly #isProcessAlive: (pid: number, startToken: string) => boolean;

  constructor(db: Database, options: RepositoryOptions = {}) {
    this.#db = db; this.#now = options.now ?? Date.now; this.#tokenFactory = options.tokenFactory ?? createClaimToken;
    this.#idFactory = options.idFactory ?? randomUUID; this.#attemptSessionIdFactory = options.attemptSessionIdFactory ?? randomUUID;
    this.#isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  #immediate<T>(body: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = body(); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  #event(runId: string, revision: number | null, kind: string, payload: unknown, now: number): void {
    assertSafePayload(payload);
    this.#db.query("INSERT INTO events(run_id, revision, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, revision, kind, JSON.stringify(payload ?? null), now);
  }

  #run(runId: string): RunRow {
    const row = this.#db.query<RunRow, [string]>("SELECT * FROM runs WHERE id=? AND deleted_at IS NULL").get(runId);
    if (!row) throw new RepositoryConflictError("run not found");
    return row;
  }

  #currentApplicationSession(
    runId: string,
    generation: number,
    sessionId: string,
  ): ApplicationSessionRow {
    this.#run(runId);
    const current = this.#db.query<ApplicationSessionRow, [string]>(`
      SELECT *
      FROM run_application_sessions
      WHERE run_id = ?
      ORDER BY generation DESC
      LIMIT 1
    `).get(runId);
    if (
      !current
      || current.generation !== generation
      || current.session_id !== sessionId
    ) {
      throw new RepositoryConflictError("application session is not the current generation");
    }
    return current;
  }

  #hasArtifactRetentionReservation(runId: string): boolean {
    return this.#db.query<{ reserved: number }, [string]>(`
      SELECT EXISTS (
        SELECT 1
        FROM run_artifact_retention
        WHERE run_id = ?
      ) AS reserved
    `).get(runId)?.reserved === 1;
  }

  #assertRunArtifactsRetained(runId: string): void {
    if (this.#hasArtifactRetentionReservation(runId)) throw new RunArtifactsPrunedError();
  }

  #assertClaim(claim: Pick<RunClaim, "runId" | "token">, now: number): ClaimRow {
    const row = this.#db.query<ClaimRow, [string, string, number]>("SELECT run_id, claim_token, expires_at FROM run_claim WHERE run_id=? AND claim_token=? AND expires_at>?").get(claim.runId, claim.token, now);
    if (!row) throw new ClaimRejectedError();
    return row;
  }
  #validateSnapshot(snapshot: RunSourceSnapshotInput): Readonly<Record<string, string>> {
    const hashes = Object.entries(snapshot.sourceHashes).sort(([left], [right]) => left.localeCompare(right));
    if (!/^[a-f0-9]{64}$/.test(snapshot.manifestSha256) || !/^[a-f0-9]{64}$/.test(snapshot.baselineSha256)) {
      throw new Error("source snapshot hashes must be lowercase SHA-256 values");
    }
    if (hashes.length !== 4 || hashes.some(([, hash]) => !/^[a-f0-9]{64}$/.test(hash))) {
      throw new Error("source snapshot must contain exactly four authoritative SHA-256 hashes");
    }
    return Object.fromEntries(hashes);
  }

  nextQueueSequence(): number {
    const sequence = this.#db.query<{ sequence: number }, []>(
      "SELECT coalesce(max(queue_sequence), 0) + 1 AS sequence FROM runs",
    ).get()?.sequence;
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error("next run sequence is invalid");
    return sequence;
  }

  createQueuedRun(
    jobDescription: string,
    jobUrl: string | null,
    opportunityKind: OpportunityKind,
    snapshot: RunSourceSnapshotInput,
    input: QueuedInputArtifact,
    id = this.#idFactory(),
    generateKeywordMap = true,
    queueSequence?: number,
    skipReview = false,
    autoSubmit = false,
    discoveryJobId?: string,
    titleOverride?: string,
  ): PublicRun {
    if (!jobDescription.trim()) throw new Error("job description is required");
    OpportunityKindSchema.parse(opportunityKind);
    if (jobUrl !== null) {
      if (jobUrl.length < 1 || jobUrl.length > 2_048 || jobUrl.trim() !== jobUrl) {
        throw new Error("job URL is invalid");
      }
      let parsedJobUrl: URL;
      try {
        parsedJobUrl = new URL(jobUrl);
      } catch {
        throw new Error("job URL is invalid");
      }
      if (
        !["http:", "https:"].includes(parsedJobUrl.protocol)
        || parsedJobUrl.username
        || parsedJobUrl.password
        || parsedJobUrl.hash
        || parsedJobUrl.toString() !== jobUrl
      ) {
        throw new Error("job URL is invalid");
      }
    }
    const validatedTitleOverride = titleOverride === undefined
      ? null
      : RunIdentityTextSchema.parse(titleOverride);
    if (!/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.byteSize) || input.byteSize < 0 || !input.path) {
      throw new Error("queued input artifact metadata is invalid");
    }
    if (typeof generateKeywordMap !== "boolean") throw new Error("generate keyword map setting must be boolean");
    if (typeof skipReview !== "boolean") throw new Error("skip-review setting must be boolean");
    if (typeof autoSubmit !== "boolean") throw new Error("auto-submit setting must be boolean");
    if (queueSequence !== undefined && (!Number.isSafeInteger(queueSequence) || queueSequence < 1)) {
      throw new Error("queue sequence must be a positive integer");
    }
    const sourceHashes = this.#validateSnapshot(snapshot);
    if (discoveryJobId !== undefined && discoveryJobId.length === 0) {
      throw new Error("discovery job id is required");
    }
    return this.#immediate(() => {
      const now = this.#now();
      const sequence = queueSequence ?? this.nextQueueSequence();
      if (discoveryJobId !== undefined) {
        const discoveryJob = this.#db.query<{
          closed: number;
          run_id: string | null;
        }, [string]>(`
          SELECT jobs.closed, links.run_id
          FROM discovery_jobs jobs
          LEFT JOIN discovery_run_links links ON links.job_id = jobs.id
          WHERE jobs.id = ?
        `).get(discoveryJobId);
        if (!discoveryJob) throw new DiscoveryJobQueueConflictError("not_found");
        if (discoveryJob.run_id !== null) {
          throw new DiscoveryJobQueueConflictError("already_queued");
        }
        if (discoveryJob.closed === 1) throw new DiscoveryJobQueueConflictError("closed");
      }
      this.#db.query("INSERT INTO runs(id, job_description, job_url, opportunity_kind, status, generate_keyword_map, skip_review, auto_submit, title_override, current_revision, queue_sequence, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, 1, ?, ?, ?)")
        .run(id, jobDescription, jobUrl, opportunityKind, generateKeywordMap ? 1 : 0, skipReview ? 1 : 0, autoSubmit ? 1 : 0, validatedTitleOverride, sequence, now, now);
      this.#db.query("INSERT INTO revisions(run_id, revision, origin, source_revision, status, created_at) VALUES (?, 1, 'initial', NULL, 'queued', ?)").run(id, now);
      this.#db.query("INSERT INTO run_source_snapshots(run_id,manifest_sha256,baseline_sha256,source_hashes_json,created_at) VALUES (?,?,?,?,?)")
        .run(id, snapshot.manifestSha256, snapshot.baselineSha256, JSON.stringify(sourceHashes), now);
      const artifactId = input.id ?? this.#idFactory();
      this.#db.query("INSERT INTO artifacts(id,run_id,revision,attempt_id,stage,kind,sha256,path,byte_size,created_at) VALUES (?, ?, 1, '', 'input', 'job-description', ?, ?, ?, ?)")
        .run(artifactId, id, input.sha256, input.path, input.byteSize, now);
      if (discoveryJobId !== undefined) {
        this.#db.query(
          "INSERT INTO discovery_run_links(job_id, run_id, created_at) VALUES (?, ?, ?)",
        ).run(discoveryJobId, id, now);
      }
      this.#event(id, 1, "run.created", { status: "queued", origin: "initial" }, now);
      this.#event(id, 1, "run.sources_snapshotted", {
        manifestSha256: snapshot.manifestSha256,
        baselineSha256: snapshot.baselineSha256,
        sourceCount: Object.keys(sourceHashes).length,
      }, now);
      this.#event(id, 1, "artifact.finalized", { artifactId, kind: "job-description", sha256: input.sha256, byteSize: input.byteSize }, now);
      return publicRun(this.#run(id));
    });
  }

  createDiscoveryQueuedRun(
    discoveryJobId: string,
    jobDescription: string,
    jobUrl: string,
    snapshot: RunSourceSnapshotInput,
    input: QueuedInputArtifact,
    id = this.#idFactory(),
    generateKeywordMap = true,
    queueSequence?: number,
    skipReview = false,
    autoSubmit = false,
  ): PublicRun {
    return this.createQueuedRun(
      jobDescription,
      jobUrl,
      "job",
      snapshot,
      input,
      id,
      generateKeywordMap,
      queueSequence,
      skipReview,
      autoSubmit,
      discoveryJobId,
    );
  }


  createRun(
    jobDescription: string,
    id = this.#idFactory(),
    generateKeywordMap = true,
    skipReview = false,
    autoSubmit = false,
    opportunityKind: OpportunityKind = "job",
  ): PublicRun {
    if (!jobDescription.trim()) throw new Error("job description is required");
    if (typeof generateKeywordMap !== "boolean") throw new Error("generate keyword map setting must be boolean");
    if (typeof skipReview !== "boolean") throw new Error("skip-review setting must be boolean");
    if (typeof autoSubmit !== "boolean") throw new Error("auto-submit setting must be boolean");
    OpportunityKindSchema.parse(opportunityKind);
    return this.#immediate(() => {
      const now = this.#now();
      this.#db.query("INSERT INTO runs(id, job_description, opportunity_kind, status, generate_keyword_map, skip_review, auto_submit, current_revision, queue_sequence, created_at, updated_at) SELECT ?, ?, ?, 'queued', ?, ?, ?, 1, coalesce(max(queue_sequence), 0) + 1, ?, ? FROM runs")
        .run(id, jobDescription, opportunityKind, generateKeywordMap ? 1 : 0, skipReview ? 1 : 0, autoSubmit ? 1 : 0, now, now);
      this.#db.query("INSERT INTO revisions(run_id, revision, origin, source_revision, status, created_at) VALUES (?, 1, 'initial', NULL, 'queued', ?)").run(id, now);
      this.#event(id, 1, "run.created", { status: "queued", origin: "initial" }, now);
      return publicRun(this.#run(id));
    });
  }

  getRunJobUrl(runId: string): string | null {
    return this.#run(runId).job_url;
  }

  getLatestApplicationSession(runId: string): PublicApplicationSession | null {
    this.#run(runId);
    const row = this.#db.query<ApplicationSessionRow, [string]>(`
      SELECT *
      FROM run_application_sessions
      WHERE run_id = ?
      ORDER BY generation DESC
      LIMIT 1
    `).get(runId);
    return row ? publicApplicationSession(row) : null;
  }

  isRunApplying(runId: string): boolean {
    const latest = this.getLatestApplicationSession(runId);
    return latest !== null
      && ACTIVE_APPLICATION_SESSION_BRIDGE_STATES[latest.bridgeState] === true;
  }

  listApplyingRunIds(runIds: readonly string[]): ReadonlySet<string> {
    if (runIds.length === 0) return new Set();
    const placeholders = runIds.map(() => "?").join(",");
    const latest = this.#db.query<{
      run_id: string;
      bridge_state: ApplicationSessionBridgeState;
    }, string[]>(`
      SELECT sessions.run_id, sessions.bridge_state
      FROM run_application_sessions AS sessions
      INNER JOIN (
        SELECT run_id, max(generation) AS generation
        FROM run_application_sessions
        WHERE run_id IN (${placeholders})
        GROUP BY run_id
      ) AS latest
        ON latest.run_id = sessions.run_id
       AND latest.generation = sessions.generation
    `).all(...runIds);
    const applyingRunIds = new Set<string>();
    for (const row of latest) {
      if (ACTIVE_APPLICATION_SESSION_BRIDGE_STATES[row.bridge_state] === true) {
        applyingRunIds.add(row.run_id);
      }
    }
    return applyingRunIds;
  }

  getNextAutomaticApplicationStart(): {
    readonly runId: string;
    readonly approvedPdfSha256: string;
  } | null {
    const rows = this.#db.query<{
      run_id: string;
      approved_pdf_sha256: string;
      current_revision: number;
    }, []>(`
      SELECT runs.id AS run_id, runs.approved_pdf_sha256, runs.current_revision
      FROM runs
      WHERE runs.deleted_at IS NULL
        AND runs.status = 'approved'
        AND runs.skip_review = 1
        AND runs.approved_pdf_sha256 IS NOT NULL
        AND (
          NOT EXISTS (
            SELECT 1
            FROM run_application_sessions
            WHERE run_application_sessions.run_id = runs.id
          )
          OR EXISTS (
            SELECT 1
            FROM run_application_sessions AS latest_session
            WHERE latest_session.run_id = runs.id
              AND latest_session.generation = (
                SELECT max(generation)
                FROM run_application_sessions
                WHERE run_id = runs.id
              )
              AND latest_session.resume_revision < runs.current_revision
              AND latest_session.slot_released = 1
              AND latest_session.bridge_state IN ('cancelled', 'failed', 'closed', 'lost')
              AND latest_session.submission_phase = 'not_attempted'
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM run_application_sessions
          WHERE slot_released = 0
        )
      ORDER BY runs.queue_sequence
    `).all();
    for (const row of rows) {
      const source = this.getArtifact(
        row.run_id,
        "tailored-tex",
        row.current_revision,
      );
      if (
        !source
        || source.revision !== row.current_revision
        || source.byteSize < 1
      ) continue;
      return {
        runId: row.run_id,
        approvedPdfSha256: row.approved_pdf_sha256,
      };
    }
    return null;
  }

  reserveApplicationSession(
    runId: string,
    expectedSessionId: string | null,
    sessionId: string,
    expectedApprovedPdfSha256: string,
  ): PublicApplicationSession {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId)) {
      throw new Error("application session ID must be a UUID");
    }
    if (!/^[a-f0-9]{64}$/.test(expectedApprovedPdfSha256)) {
      throw new Error("approved PDF hash must be a lowercase SHA-256 value");
    }
    return this.#immediate(() => {
      const run = this.#run(runId);
      this.#assertRunArtifactsRetained(runId);
      if (run.status !== "approved" || run.approved_pdf_sha256 !== expectedApprovedPdfSha256) {
        throw new RepositoryConflictError("approved PDF changed");
      }
      const revision = this.getRevision(runId, run.current_revision);
      const pdf = this.getArtifact(runId, "compiled-pdf", run.current_revision);
      if (revision?.status !== "approved" || pdf?.sha256 !== expectedApprovedPdfSha256) {
        throw new RepositoryConflictError("approved PDF changed");
      }
      const latest = this.#db.query<ApplicationSessionRow, [string]>(`
        SELECT *
        FROM run_application_sessions
        WHERE run_id = ?
        ORDER BY generation DESC
        LIMIT 1
      `).get(runId);
      if ((latest?.session_id ?? null) !== expectedSessionId) {
        throw new RepositoryConflictError("application session changed");
      }
      if (
        latest?.submission_phase === "attempting"
        || latest?.submission_phase === "submitted"
        || latest?.submission_phase === "uncertain"
      ) {
        throw new ApplicationSubmissionFinalError();
      }
      if (latest && TERMINAL_APPLICATION_SESSION_STATES[latest.bridge_state] !== true) {
        throw new RepositoryConflictError("application session is active");
      }
      const occupyingSession = this.#db.query<{ session_id: string }, []>(`
        SELECT session_id
        FROM run_application_sessions
        WHERE slot_released = 0
      `).get();
      if (occupyingSession) {
        throw new RepositoryConflictError("application browser slot is active");
      }
      const generation = (latest?.generation ?? 0) + 1;
      const now = this.#now();
      this.#db.query(`
        INSERT INTO run_application_sessions(
          run_id, generation, session_id, resume_revision, pdf_sha256, bridge_state,
          slot_released, public_snapshot_json, last_upstream_event_id,
          created_at, updated_at, terminal_at
        ) VALUES (?, ?, ?, ?, ?, 'reserved', 0, NULL, NULL, ?, ?, NULL)
      `).run(
        runId,
        generation,
        sessionId,
        run.current_revision,
        expectedApprovedPdfSha256,
        now,
        now,
      );
      const reserved = this.#db.query<ApplicationSessionRow, [string, number]>(
        "SELECT * FROM run_application_sessions WHERE run_id = ? AND generation = ?",
      ).get(runId, generation);
      if (!reserved) throw new Error("application session reservation failed");
      return publicApplicationSession(reserved);
    });
  }

  markAutomaticApplicationReviewReady(sessionId: string): void {
    this.#immediate(() => {
      const session = this.#db.query<ApplicationSessionRow, [string]>(
        "SELECT * FROM run_application_sessions WHERE session_id = ?",
      ).get(sessionId);
      if (!session) throw new RepositoryConflictError("application session not found");
      const current = this.#currentApplicationSession(
        session.run_id,
        session.generation,
        sessionId,
      );
      if (current.submission_phase !== "not_attempted") {
        throw new RepositoryConflictError("application submission was already claimed");
      }
      if (TERMINAL_APPLICATION_SESSION_STATES[current.bridge_state] === true) {
        throw new RepositoryConflictError("application session is terminal");
      }
      if (current.automatic_review_ready === 1) return;
      const updatedAt = Math.max(current.updated_at + 1, this.#now());
      const result = this.#db.query(`
        UPDATE run_application_sessions
        SET automatic_review_ready = 1,
            updated_at = ?
        WHERE run_id = ? AND generation = ? AND session_id = ?
          AND submission_phase = 'not_attempted'
          AND automatic_review_ready = 0
          AND generation = (
            SELECT max(generation)
            FROM run_application_sessions
            WHERE run_id = ?
          )
      `).run(
        updatedAt,
        current.run_id,
        current.generation,
        sessionId,
        current.run_id,
      );
      if (result.changes !== 1) {
        throw new RepositoryConflictError("application submission review changed");
      }
    });
  }

  claimApplicationSubmission(sessionId: string): void {
    this.#immediate(() => {
      const session = this.#db.query<ApplicationSessionRow, [string]>(
        "SELECT * FROM run_application_sessions WHERE session_id = ?",
      ).get(sessionId);
      if (!session) throw new RepositoryConflictError("application session not found");
      const current = this.#currentApplicationSession(
        session.run_id,
        session.generation,
        sessionId,
      );
      if (current.submission_phase !== "not_attempted") {
        throw new RepositoryConflictError("application submission was already claimed");
      }
      if (TERMINAL_APPLICATION_SESSION_STATES[current.bridge_state] === true) {
        throw new RepositoryConflictError("application session is terminal");
      }
      if (
        current.bridge_state !== "awaiting_human_review"
        && current.automatic_review_ready !== 1
      ) {
        throw new RepositoryConflictError(
          "application submission is not review-ready",
        );
      }
      const attemptedAt = this.#now();
      const updatedAt = Math.max(current.updated_at + 1, attemptedAt);
      const result = this.#db.query(`
        UPDATE run_application_sessions
        SET submission_phase = 'attempting',
            submission_attempted_at = ?,
            updated_at = ?
        WHERE run_id = ? AND generation = ? AND session_id = ?
          AND submission_phase = 'not_attempted'
          AND (bridge_state = 'awaiting_human_review' OR automatic_review_ready = 1)
          AND bridge_state NOT IN ('cancelled','failed','closed','lost')
          AND generation = (
            SELECT max(generation)
            FROM run_application_sessions
            WHERE run_id = ?
          )
      `).run(attemptedAt, updatedAt, current.run_id, current.generation, sessionId, current.run_id);
      if (result.changes !== 1) {
        throw new RepositoryConflictError("application submission was already claimed");
      }
    });
  }

  finalizeApplicationSubmission(
    sessionId: string,
    outcome: "submitted" | "uncertain",
  ): void {
    this.#immediate(() => {
      const session = this.#db.query<ApplicationSessionRow, [string]>(
        "SELECT * FROM run_application_sessions WHERE session_id = ?",
      ).get(sessionId);
      if (!session) throw new RepositoryConflictError("application session not found");
      const current = this.#currentApplicationSession(
        session.run_id,
        session.generation,
        sessionId,
      );
      const targetPhase = outcome === "submitted" ? "submitted" : "uncertain";
      if (current.submission_phase === targetPhase) return;
      if (
        current.submission_phase === "submitted"
        || current.submission_phase === "uncertain"
      ) {
        throw new RepositoryConflictError("conflicting submission outcome");
      }
      if (current.submission_phase !== "attempting") {
        throw new RepositoryConflictError("application submission was not claimed");
      }
      const finalizedAt = this.#now();
      const updatedAt = Math.max(current.updated_at + 1, finalizedAt);
      const result = this.#db.query(`
        UPDATE run_application_sessions
        SET submission_phase = ?,
            submission_confirmed_at = ?,
            updated_at = ?
        WHERE run_id = ? AND generation = ? AND session_id = ?
          AND submission_phase = 'attempting'
          AND generation = (
            SELECT max(generation)
            FROM run_application_sessions
            WHERE run_id = ?
          )
      `).run(
        targetPhase,
        outcome === "submitted" ? finalizedAt : null,
        updatedAt,
        current.run_id,
        current.generation,
        sessionId,
        current.run_id,
      );
      if (result.changes !== 1) {
        throw new RepositoryConflictError("application submission finalization conflicted");
      }
      if (outcome === "submitted") {
        this.#db.query(`
          UPDATE runs
          SET application_status = 'applied',
              updated_at = CASE
                WHEN application_status = 'applied' THEN updated_at
                ELSE ?
              END
          WHERE id = ?
            AND application_status IN (
              'pending','did_not_apply','failed','applied'
            )
        `).run(finalizedAt, current.run_id);
      }
    });
  }


  reconcileAttemptingApplicationSubmissions(): number {
    return this.#immediate(() => {
      const attempting = this.#db.query<ApplicationSessionRow, []>(`
        SELECT *
        FROM run_application_sessions
        WHERE submission_phase = 'attempting'
        ORDER BY run_id, generation
      `).all();
      let reconciled = 0;
      for (const row of attempting) {
        const snapshotUpdatedAt = row.public_snapshot_json === null
          ? null
          : publicApplicationSnapshotUpdatedAt(
            JSON.parse(row.public_snapshot_json) as unknown,
          );
        const updatedAt = Math.max(
          row.updated_at + 1,
          snapshotUpdatedAt === null ? 0 : snapshotUpdatedAt + 1,
          this.#now(),
        );
        const result = this.#db.query(`
          UPDATE run_application_sessions
          SET bridge_state = CASE
                WHEN bridge_state = 'closed' THEN 'closed'
                ELSE 'submission_uncertain'
              END,
              submission_phase = 'uncertain',
              submission_confirmed_at = NULL,
              public_snapshot_json = ?,
              updated_at = ?,
              terminal_at = CASE
                WHEN bridge_state = 'closed' THEN terminal_at
                ELSE NULL
              END
          WHERE run_id = ? AND generation = ? AND session_id = ?
            AND submission_phase = 'attempting'
        `).run(
          submissionUncertainSnapshot(row, updatedAt),
          updatedAt,
          row.run_id,
          row.generation,
          row.session_id,
        );
        reconciled += result.changes;
      }
      return reconciled;
    });
  }
  recordApplicationSnapshot(
    runId: string,
    input: ApplicationSnapshotRecordInput,
  ): PublicApplicationSession {
    return this.recordApplicationSnapshotWithSlotTransition(runId, input).session;
  }

  recordApplicationSnapshotWithSlotTransition(
    runId: string,
    input: ApplicationSnapshotRecordInput,
  ): ApplicationSessionSlotTransitionResult {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new Error("application session generation must be positive");
    }
    if (typeof input.slotReleased !== "boolean") {
      throw new Error("application slot release must be boolean");
    }
    if (
      input.lastUpstreamEventId !== undefined
      && (!Number.isSafeInteger(input.lastUpstreamEventId) || input.lastUpstreamEventId < 0)
    ) {
      throw new Error("application event cursor must be nonnegative");
    }
    const publicSnapshotJson = serializePublicApplicationSnapshot(input.publicSnapshot);
    const snapshotUpdatedAt = publicApplicationSnapshotUpdatedAt(input.publicSnapshot);
    let slotWasReleased = true;
    const session = this.#immediate(() => {
      const current = this.#currentApplicationSession(runId, input.generation, input.sessionId);
      slotWasReleased = current.slot_released === 1;
      const currentSnapshot = current.public_snapshot_json === null
        ? null
        : JSON.parse(current.public_snapshot_json) as unknown;
      const currentSnapshotUpdatedAt = publicApplicationSnapshotUpdatedAt(currentSnapshot);
      const retainSnapshotAndAdvanceMetadata = (): PublicApplicationSession => {
        const cursor = input.lastUpstreamEventId === undefined
          || (
            current.last_upstream_event_id !== null
            && input.lastUpstreamEventId <= current.last_upstream_event_id
          )
          ? current.last_upstream_event_id
          : input.lastUpstreamEventId;
        const slotReleased = current.slot_released === 1 || input.slotReleased ? 1 : 0;
        if (
          current.last_upstream_event_id === cursor
          && current.slot_released === slotReleased
        ) {
          return publicApplicationSession(current);
        }
        const metadataResult = this.#db.query(`
          UPDATE run_application_sessions
          SET last_upstream_event_id = ?, slot_released = ?
          WHERE run_id = ? AND generation = ? AND session_id = ?
            AND generation = (
              SELECT max(generation)
              FROM run_application_sessions
              WHERE run_id = ?
            )
        `).run(
          cursor,
          slotReleased,
          runId,
          input.generation,
          input.sessionId,
          runId,
        );
        if (metadataResult.changes !== 1) {
          throw new RepositoryConflictError("application session is not the current generation");
        }
        const advanced = this.#db.query<ApplicationSessionRow, [string, number]>(
          "SELECT * FROM run_application_sessions WHERE run_id = ? AND generation = ?",
        ).get(runId, input.generation);
        if (!advanced) throw new Error("application session metadata update failed");
        return publicApplicationSession(advanced);
      };
      if (
        current.last_upstream_event_id !== null
        && input.lastUpstreamEventId !== undefined
        && input.lastUpstreamEventId <= current.last_upstream_event_id
      ) {
        return retainSnapshotAndAdvanceMetadata();
      }
      if (
        snapshotUpdatedAt !== null
        && currentSnapshotUpdatedAt !== null
        && (
          snapshotUpdatedAt < currentSnapshotUpdatedAt
          || (
            snapshotUpdatedAt === currentSnapshotUpdatedAt
            && publicSnapshotJson !== current.public_snapshot_json
          )
        )
      ) {
        return retainSnapshotAndAdvanceMetadata();
      }
      const bridgeMatchesSubmissionPhase =
        (
          current.submission_phase === "not_attempted"
          && input.bridgeState !== "submitting"
          && input.bridgeState !== "submitted"
          && input.bridgeState !== "submission_uncertain"
        )
        || (
          current.submission_phase === "attempting"
          && input.bridgeState === "submitting"
        )
        || (
          current.submission_phase === "submitted"
          && (input.bridgeState === "submitted" || input.bridgeState === "closed")
        )
        || (
          current.submission_phase === "uncertain"
          && (
            input.bridgeState === "submission_uncertain"
            || input.bridgeState === "closed"
          )
        );
      if (!bridgeMatchesSubmissionPhase) {
        throw new RepositoryConflictError(
          "application submission phase does not allow this bridge transition",
        );
      }
      if (
        TERMINAL_APPLICATION_SESSION_STATES[current.bridge_state] === true
        && current.bridge_state !== input.bridgeState
        && !(
          input.bridgeState === "closed"
          && (current.bridge_state === "cancelled" || current.bridge_state === "failed")
        )
      ) {
        throw new RepositoryConflictError("application session is terminal");
      }
      const cursor = input.lastUpstreamEventId ?? current.last_upstream_event_id;
      if (
        current.bridge_state === input.bridgeState
        && current.public_snapshot_json === publicSnapshotJson
      ) {
        return retainSnapshotAndAdvanceMetadata();
      }
      const updatedAt = Math.max(current.updated_at + 1, this.#now());
      const terminalAt = TERMINAL_APPLICATION_SESSION_STATES[input.bridgeState] === true
        ? (current.terminal_at ?? updatedAt)
        : null;
      const result = this.#db.query(`
        UPDATE run_application_sessions
        SET bridge_state = ?, public_snapshot_json = ?, last_upstream_event_id = ?,
            slot_released = ?, updated_at = ?, terminal_at = ?
        WHERE run_id = ? AND generation = ? AND session_id = ?
          AND generation = (
            SELECT max(generation)
            FROM run_application_sessions
            WHERE run_id = ?
          )
      `).run(
        input.bridgeState,
        publicSnapshotJson,
        cursor,
        current.slot_released === 1 || input.slotReleased ? 1 : 0,
        updatedAt,
        terminalAt,
        runId,
        input.generation,
        input.sessionId,
        runId,
      );
      if (result.changes !== 1) {
        throw new RepositoryConflictError("application session is not the current generation");
      }
      const recorded = this.#db.query<ApplicationSessionRow, [string, number]>(
        "SELECT * FROM run_application_sessions WHERE run_id = ? AND generation = ?",
      ).get(runId, input.generation);
      if (!recorded) throw new Error("application session snapshot update failed");
      return publicApplicationSession(recorded);
    });
    return {
      session,
      slotReleasedTransitioned: !slotWasReleased && session.slotReleased,
    };
  }

  getUnreleasedApplicationSession(): PublicApplicationSession | null {
    const row = this.#db.query<ApplicationSessionRow, []>(`
      SELECT *
      FROM run_application_sessions
      WHERE slot_released = 0
      ORDER BY created_at, run_id, generation
      LIMIT 1
    `).get();
    return row ? publicApplicationSession(row) : null;
  }

  releaseApplicationSessionSlot(
    runId: string,
    generation: number,
    sessionId: string,
  ): PublicApplicationSession {
    return this.releaseApplicationSessionSlotWithTransition(runId, generation, sessionId).session;
  }

  releaseApplicationSessionSlotWithTransition(
    runId: string,
    generation: number,
    sessionId: string,
  ): ApplicationSessionSlotTransitionResult {
    let slotReleasedTransitioned = false;
    const session = this.#immediate(() => {
      const current = this.#currentApplicationSession(runId, generation, sessionId);
      if (current.slot_released === 1) return publicApplicationSession(current);
      const result = this.#db.query(`
        UPDATE run_application_sessions
        SET slot_released = 1
        WHERE run_id = ? AND generation = ? AND session_id = ?
          AND slot_released = 0
      `).run(runId, generation, sessionId);
      if (result.changes !== 1) {
        throw new RepositoryConflictError("application slot release conflicted");
      }
      slotReleasedTransitioned = true;
      const released = this.#db.query<ApplicationSessionRow, [string, number]>(
        "SELECT * FROM run_application_sessions WHERE run_id = ? AND generation = ?",
      ).get(runId, generation);
      if (!released) throw new Error("application slot release failed");
      return publicApplicationSession(released);
    });
    return { session, slotReleasedTransitioned };
  }

  markApplicationSessionLost(
    runId: string,
    input: {
      readonly generation: number;
      readonly sessionId: string;
      readonly publicSnapshot: unknown;
    },
  ): PublicApplicationSession {
    return this.markApplicationSessionLostWithTransition(runId, input).session;
  }

  markApplicationSessionLostWithTransition(
    runId: string,
    input: {
      readonly generation: number;
      readonly sessionId: string;
      readonly publicSnapshot: unknown;
    },
  ): ApplicationSessionSlotTransitionResult {
    const publicSnapshotJson = serializePublicApplicationSnapshot(input.publicSnapshot);
    let slotWasReleased = true;
    const session = this.#immediate(() => {
      const current = this.#currentApplicationSession(runId, input.generation, input.sessionId);
      slotWasReleased = current.slot_released === 1;
      if (current.submission_phase !== "not_attempted") {
        throw new RepositoryConflictError("application submission is already final or attempting");
      }
      if (
        current.public_snapshot_json === null
        || TERMINAL_APPLICATION_SESSION_STATES[current.bridge_state] === true
      ) {
        throw new RepositoryConflictError("application session was not observed live");
      }
      const updatedAt = Math.max(current.updated_at + 1, this.#now());
      const result = this.#db.query(`
        UPDATE run_application_sessions
        SET bridge_state = 'lost', slot_released = 1,
            public_snapshot_json = ?, updated_at = ?, terminal_at = ?
        WHERE run_id = ? AND generation = ? AND session_id = ?
      `).run(publicSnapshotJson, updatedAt, updatedAt, runId, input.generation, input.sessionId);
      if (result.changes !== 1) {
        throw new RepositoryConflictError("application session lost transition conflicted");
      }
      const lost = this.#db.query<ApplicationSessionRow, [string, number]>(
        "SELECT * FROM run_application_sessions WHERE run_id = ? AND generation = ?",
      ).get(runId, input.generation);
      if (!lost) throw new Error("application session lost transition failed");
      return publicApplicationSession(lost);
    });
    return {
      session,
      slotReleasedTransitioned: !slotWasReleased && session.slotReleased,
    };
  }

  closeLostApplicationSession(
    runId: string,
    input: {
      readonly generation: number;
      readonly sessionId: string;
      readonly publicSnapshot: unknown;
    },
  ): PublicApplicationSession {
    const publicSnapshotJson = serializePublicApplicationSnapshot(input.publicSnapshot);
    return this.#immediate(() => {
      const current = this.#currentApplicationSession(runId, input.generation, input.sessionId);
      if (current.bridge_state !== "lost") {
        throw new RepositoryConflictError("application session is not lost");
      }
      const updatedAt = Math.max(current.updated_at + 1, this.#now());
      this.#db.query(`
        UPDATE run_application_sessions
        SET bridge_state = 'closed', public_snapshot_json = ?, updated_at = ?
        WHERE run_id = ? AND generation = ? AND session_id = ?
      `).run(publicSnapshotJson, updatedAt, runId, input.generation, input.sessionId);
      const closed = this.#db.query<ApplicationSessionRow, [string, number]>(
        "SELECT * FROM run_application_sessions WHERE run_id = ? AND generation = ?",
      ).get(runId, input.generation);
      if (!closed) throw new Error("application session close transition failed");
      return publicApplicationSession(closed);
    });
  }

  attachSourceSnapshot(runId: string, snapshot: RunSourceSnapshotInput): PublicRunSourceSnapshot {
    const sourceHashes = this.#validateSnapshot(snapshot);
    return this.#immediate(() => {
      const now = this.#now();
      const run = this.#assertCommandable(runId, now);
      if (run.status !== "queued") throw new RepositoryConflictError("source snapshot must be attached before processing");
      const sourceHashesJson = JSON.stringify(sourceHashes);
      this.#db.query("INSERT INTO run_source_snapshots(run_id,manifest_sha256,baseline_sha256,source_hashes_json,created_at) VALUES (?,?,?,?,?)")
        .run(runId, snapshot.manifestSha256, snapshot.baselineSha256, sourceHashesJson, now);
      this.#event(runId, run.current_revision, "run.sources_snapshotted", {
        manifestSha256: snapshot.manifestSha256,
        baselineSha256: snapshot.baselineSha256,
        sourceCount: Object.keys(sourceHashes).length,
      }, now);
      return { ...snapshot, sourceHashes, createdAt: now };
    });
  }

  getSourceSnapshot(runId: string): PublicRunSourceSnapshot | null {
    const row = this.#db.query<{
      manifest_sha256: string;
      baseline_sha256: string;
      source_hashes_json: string;
      created_at: number;
    }, [string]>("SELECT manifest_sha256,baseline_sha256,source_hashes_json,created_at FROM run_source_snapshots WHERE run_id=?").get(runId);
    return row ? {
      manifestSha256: row.manifest_sha256,
      baselineSha256: row.baseline_sha256,
      sourceHashes: JSON.parse(row.source_hashes_json) as Record<string, string>,
      createdAt: row.created_at,
    } : null;
  }

  #assertSourceSnapshot(runId: string, current: RunSourceSnapshotInput): void {
    const expected = this.getSourceSnapshot(runId);
    const currentHashes = JSON.stringify(this.#validateSnapshot(current));
    const expectedHashes = expected ? JSON.stringify(expected.sourceHashes) : undefined;
    if (
      !expected ||
      expected.manifestSha256 !== current.manifestSha256 ||
      expected.baselineSha256 !== current.baselineSha256 ||
      expectedHashes !== currentHashes
    ) {
      throw new SourceDriftError();
    }
  }

  assertSourceSnapshot(runId: string, current: RunSourceSnapshotInput): void {
    this.#assertSourceSnapshot(runId, current);
  }

  getRun(runId: string): PublicRun | null {
    const row = this.#db.query<RunRow, [string]>("SELECT * FROM runs WHERE id=? AND deleted_at IS NULL").get(runId);
    return row ? publicRun(row) : null;
  }

  listRuns(limit = 100): PublicRun[] {
    return this.#db.query<RunRow, [number]>(`
      SELECT *
      FROM (
        SELECT *
        FROM runs
        WHERE deleted_at IS NULL
        ORDER BY queue_sequence DESC
        LIMIT ?
      ) AS recent_runs
      ORDER BY queue_sequence
    `).all(limit).map(publicRun);
  }

  listPrunedRunArtifactManifests(): PrunedRunArtifactManifest[] {
    const rows = this.#db.query<PrunedRunArtifactManifestRow, []>(`
      SELECT
        run_artifact_retention.run_id,
        runs.queue_sequence,
        artifacts.id AS artifact_id,
        artifacts.path AS artifact_path,
        artifacts.sha256 AS artifact_sha256,
        artifacts.byte_size AS artifact_byte_size
      FROM run_artifact_retention
      JOIN runs ON runs.id = run_artifact_retention.run_id
      LEFT JOIN artifacts ON artifacts.run_id = run_artifact_retention.run_id
      WHERE run_artifact_retention.state = 'pruned'
      ORDER BY runs.queue_sequence, artifacts.created_at, artifacts.id
    `).all();
    const manifests: Array<{
      runId: string;
      queueSequence: number;
      artifacts: PrunedRunArtifact[];
    }> = [];
    for (const row of rows) {
      let manifest = manifests.at(-1);
      if (manifest?.runId !== row.run_id) {
        manifest = {
          runId: row.run_id,
          queueSequence: row.queue_sequence,
          artifacts: [],
        };
        manifests.push(manifest);
      }
      if (
        row.artifact_id !== null
        && row.artifact_path !== null
        && row.artifact_sha256 !== null
        && row.artifact_byte_size !== null
      ) {
        manifest.artifacts.push({
          id: row.artifact_id,
          path: row.artifact_path,
          sha256: row.artifact_sha256,
          byteSize: row.artifact_byte_size,
        });
      }
    }
    return manifests;
  }

  clearPrunedRunArtifactMarker(runId: string, queueSequence: number): void {
    if (!Number.isSafeInteger(queueSequence) || queueSequence < 1) {
      throw new Error("run queue sequence must be a positive safe integer");
    }
    this.#immediate(() => {
      const result = this.#db.query(`
        DELETE FROM run_artifact_retention
        WHERE run_id = ?
          AND state = 'pruned'
          AND EXISTS (
            SELECT 1
            FROM runs
            WHERE runs.id = ?
              AND runs.queue_sequence = ?
          )
      `).run(runId, runId, queueSequence);
      if (result.changes !== 1) {
        throw new RepositoryConflictError("pruned run artifact marker changed");
      }
    });
  }

  areRunArtifactsRetained(runId: string): boolean {
    this.#run(runId);
    return !this.#hasArtifactRetentionReservation(runId);
  }

  setApplicationStatus(runId: string, applicationStatus: ApplicationStatus): PublicRun {
    return this.#immediate(() => {
      const run = this.#run(runId);
      if (run.application_status === applicationStatus) return publicRun(run);
      this.#db.query("UPDATE runs SET application_status=?, updated_at=? WHERE id=?").run(applicationStatus, this.#now(), runId);
      return publicRun(this.#run(runId));
    });
  }

  setIdentity(
    runId: string,
    identity: { readonly title?: string | undefined; readonly organization?: string | undefined },
  ): PublicRun {
    if (
      (identity.title !== undefined
        && (identity.title.trim() !== identity.title || identity.title.length < 1 || identity.title.length > 200))
      || (identity.organization !== undefined
        && (
          identity.organization.trim() !== identity.organization
          || identity.organization.length < 1
          || identity.organization.length > 200
        ))
    ) {
      throw new Error("run identity values must be trimmed and between 1 and 200 characters");
    }
    if (identity.title === undefined && identity.organization === undefined) {
      throw new Error("title or organization is required");
    }
    return this.#immediate(() => {
      const run = this.#run(runId);
      const title = identity.title ?? run.title_override;
      const organization = identity.organization ?? run.organization_override;
      if (run.title_override === title && run.organization_override === organization) return publicRun(run);
      this.#db.query(
        "UPDATE runs SET title_override=?, organization_override=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
      ).run(title, organization, this.#now(), runId);
      return publicRun(this.#run(runId));
    });
  }

  deleteRun(runId: string): void {
    this.#immediate(() => {
      const now = this.#now();
      this.#assertCommandable(runId, now);
      const activeAttempt = this.#db.query<{ active: number }, [string]>(`
        SELECT EXISTS (
          SELECT 1
          FROM attempts
          WHERE run_id = ? AND status IN ('running','cancel_requested')
        ) AS active
      `).get(runId)?.active === 1;
      if (activeAttempt) throw new RepositoryConflictError("run has an active attempt");
      const activeApplicationSession = this.#db.query<{ active: number }, [string]>(`
        SELECT EXISTS (
          SELECT 1
          FROM run_application_sessions
          WHERE run_id = ?
            AND (
              slot_released = 0
              OR bridge_state IN (
                'reserved',
                'starting',
                'running',
                'awaiting_human_navigation',
                'awaiting_origin_approval',
                'awaiting_additional_info',
                'awaiting_human_review',
                'submitting',
                'submitted',
                'submission_uncertain'
              )
            )
        ) AS active
      `).get(runId)?.active === 1;
      if (activeApplicationSession) {
        throw new RepositoryConflictError("close the browser session first");
      }
      const pruning = this.#db.query<{ pruning: number }, [string]>(`
        SELECT EXISTS (
          SELECT 1
          FROM run_artifact_retention
          WHERE run_id = ? AND state = 'pruning'
        ) AS pruning
      `).get(runId)?.pruning === 1;
      if (pruning) throw new RepositoryConflictError("run artifacts are being pruned");
      this.#db.query("DELETE FROM discovery_run_links WHERE run_id = ?").run(runId);
      this.#db.query("UPDATE runs SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL")
        .run(now, now, runId);
    });
  }

  getRevision(runId: string, revision?: number): RevisionRow | null {
    const selected = revision ?? this.#run(runId).current_revision;
    return this.#db.query<RevisionRow, [string, number]>("SELECT * FROM revisions WHERE run_id=? AND revision=?").get(runId, selected) ?? null;
  }
  resolveRevisionOrigin(
    runId: string,
    selectedRevision: number,
  ): Exclude<RevisionOrigin, "retry"> {
    this.#run(runId);
    let revision = this.getRevision(runId, selectedRevision);
    const seen = new Set<number>();
    while (revision?.origin === "retry") {
      if (seen.has(revision.revision) || revision.source_revision === null) {
        throw new Error("retry revision ancestry is corrupt");
      }
      seen.add(revision.revision);
      revision = this.getRevision(runId, revision.source_revision);
    }
    if (!revision) throw new RepositoryConflictError("revision not found");
    return revision.origin;
  }

  listReviewableRevisions(runId: string): PublicReviewableRevision[] {
    this.#run(runId);
    const revisions = this.#db.query<
      { revision: number; status: "review" | "approved"; created_at: number },
      [string]
    >(`
      SELECT revision, status, created_at
      FROM revisions
      WHERE run_id=? AND status IN ('review','approved')
      ORDER BY revision
    `).all(runId);
    const reviewable: PublicReviewableRevision[] = [];
    for (const revision of revisions) {
      const pdf = this.getArtifact(runId, "compiled-pdf", revision.revision);
      if (!pdf) continue;
      reviewable.push({
        revision: revision.revision,
        status: revision.status,
        createdAt: revision.created_at,
        pdfSha256: pdf.sha256,
      });
    }
    return reviewable;
  }
  getRevisionStatus(runId: string, revision: number): RunStatus | null {
    return this.getRevision(runId, revision)?.status ?? null;
  }

  acquire(): RunClaim | null {
    return this.#immediate(() => {
      const now = this.#now();
      const expiredSlots = this.#db.query<ClaimSlotRow, [number]>(`
        SELECT id, run_id, claim_token, expires_at
        FROM run_claim
        WHERE run_id IS NOT NULL AND expires_at <= ?
        ORDER BY id
      `).all(now);

      for (const slot of expiredSlots) {
        const interrupted = this.#db.query<RunRow, [string]>(
          "SELECT * FROM runs WHERE id=? AND deleted_at IS NULL",
        ).get(slot.run_id!);
        if (
          interrupted
          && runnableStatuses.has(interrupted.status)
          && !this.#hasArtifactRetentionReservation(interrupted.id)
        ) {
          const active = this.#db.query<AttemptRow, [string]>(
            "SELECT * FROM attempts WHERE run_id=? AND status IN ('running','cancel_requested') ORDER BY started_at DESC LIMIT 1",
          ).get(interrupted.id);
          if (active) {
            const knownDead =
              active.process_pid !== null
              && active.process_start_token !== null
              && !this.#isProcessAlive(active.process_pid, active.process_start_token);
            if (!knownDead) {
              if (active.status === "running") {
                this.#db.query(
                  "UPDATE attempts SET status='cancel_requested' WHERE id=? AND claim_token=? AND status='running'",
                ).run(active.id, active.claim_token);
              }
              continue;
            }
            this.#db.query(
              "UPDATE attempts SET status='cancelled', finished_at=?, cancellation_ack_at=? WHERE id=? AND status IN ('running','cancel_requested')",
            ).run(now, now, active.id);
            this.#event(
              active.run_id,
              active.revision,
              "attempt.process_dead",
              { attemptId: active.id },
              now,
            );
          }
          return this.#claimSlot(slot, interrupted, now);
        }

        this.#db.query(
          "UPDATE run_claim SET run_id=NULL, claim_token=NULL, expires_at=NULL WHERE id=?",
        ).run(slot.id);
      }

      const availableSlot = this.#db.query<ClaimSlotRow, []>(`
        SELECT id, run_id, claim_token, expires_at
        FROM run_claim
        WHERE run_id IS NULL
        ORDER BY id
        LIMIT 1
      `).get();
      if (!availableSlot) return null;

      const candidate = this.#db.query<RunRow, []>(`
        SELECT *
        FROM runs
        WHERE status IN ('queued','analyzing','tailoring','editing','compiling','repairing','deterministic_qa','visual_qa')
          AND deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM run_artifact_retention
            WHERE run_artifact_retention.run_id = runs.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM run_claim
            WHERE run_claim.run_id = runs.id
          )
        ORDER BY queue_sequence
        LIMIT 1
      `).get();
      if (!candidate) return null;
      return this.#claimSlot(availableSlot, candidate, now);
    });
  }

  #claimSlot(slot: ClaimSlotRow, candidate: RunRow, now: number): RunClaim {
    let token = this.#tokenFactory();
    let tokenClaimed = this.#db.query<{ claimed: number }, [string]>(`
      SELECT EXISTS (
        SELECT 1
        FROM run_claim
        WHERE claim_token = ?
      ) AS claimed
    `).get(token)?.claimed === 1;
    for (let retries = 0; tokenClaimed && retries < 4; retries++) {
      token = this.#tokenFactory();
      tokenClaimed = this.#db.query<{ claimed: number }, [string]>(`
        SELECT EXISTS (
          SELECT 1
          FROM run_claim
          WHERE claim_token = ?
        ) AS claimed
      `).get(token)?.claimed === 1;
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new Error("token factory must return a 256-bit base64url token");
    }
    if (tokenClaimed) throw new Error("token factory did not provide a fresh claim token");

    const expiresAt = now + CLAIM_TTL_MS;
    this.#db.query(
      "UPDATE run_claim SET run_id=?, claim_token=?, expires_at=? WHERE id=?",
    ).run(candidate.id, token, expiresAt, slot.id);
    this.#event(candidate.id, candidate.current_revision, "run.claimed", { expiresAt }, now);
    return { runId: candidate.id, token, expiresAt };
  }

  heartbeat(claim: Pick<RunClaim, "runId" | "token">): RunClaim {
    return this.#immediate(() => {
      const now = this.#now(); const expiresAt = now + CLAIM_TTL_MS;
      const result = this.#db.query("UPDATE run_claim SET expires_at=? WHERE run_id=? AND claim_token=? AND expires_at>?").run(expiresAt, claim.runId, claim.token, now);
      if (result.changes !== 1) throw new ClaimRejectedError();
      return { runId: claim.runId, token: claim.token, expiresAt };
    });
  }

  release(claim: Pick<RunClaim, "runId" | "token">): void {
    this.#immediate(() => {
      const now = this.#now();
      const result = this.#db.query("UPDATE run_claim SET run_id=NULL, claim_token=NULL, expires_at=NULL WHERE run_id=? AND claim_token=? AND expires_at>?").run(claim.runId, claim.token, now);
      if (result.changes !== 1) throw new ClaimRejectedError();
    });
  }

  transition(claim: Pick<RunClaim, "runId" | "token">, target: RunStatus, options: { failedStage?: ActiveStage; visualAcknowledgementRequired?: boolean } = {}): PublicRun {
    return this.#immediate(() => {
      const now = this.#now(); this.#assertClaim(claim, now); const run = this.#run(claim.runId);
      if (!transitionTargets[run.status].includes(target)) throw new RepositoryConflictError(`invalid transition ${run.status} -> ${target}`);
      const failedStage = target === "failed" ? (options.failedStage ?? (runnableStatuses.has(run.status) && run.status !== "queued" ? run.status : null)) : null;
      if (target === "failed" && !failedStage) throw new RepositoryConflictError("failed transition requires a failed stage");
      this.#db.query("UPDATE runs SET status=?, failed_stage=?, visual_ack_required=?, updated_at=? WHERE id=?")
        .run(target, failedStage, options.visualAcknowledgementRequired ? 1 : 0, now, run.id);
      this.#db.query("UPDATE revisions SET status=? WHERE run_id=? AND revision=?").run(target, run.id, run.current_revision);
      this.#event(run.id, run.current_revision, "run.transitioned", { from: run.status, to: target, failedStage }, now);
      return publicRun(this.#run(run.id));
    });
  }

  completeVisualQa(
    claim: Pick<RunClaim, "runId" | "token">,
    expectedPdfSha256: string,
    visualAcknowledgementRequired: boolean,
  ): PublicRun {
    if (!/^[a-f0-9]{64}$/.test(expectedPdfSha256)) {
      throw new Error("review PDF hash must be a lowercase SHA-256 value");
    }
    if (typeof visualAcknowledgementRequired !== "boolean") {
      throw new Error("visual acknowledgement setting must be boolean");
    }
    return this.#immediate(() => {
      const now = this.#now();
      this.#assertClaim(claim, now);
      const run = this.#run(claim.runId);
      if (run.status !== "visual_qa") {
        throw new RepositoryConflictError(`run is ${run.status}, not visual_qa`);
      }
      const pdf = this.getArtifact(run.id, "compiled-pdf", run.current_revision);
      if (!pdf || pdf.sha256 !== expectedPdfSha256) {
        throw new RepositoryConflictError("review PDF hash is stale");
      }
      if (run.skip_review === 1 && !visualAcknowledgementRequired) {
        this.#db.query(`
          UPDATE runs
          SET status = 'approved', failed_stage = NULL, visual_ack_required = 0,
              approved_pdf_sha256 = ?, updated_at = ?
          WHERE id = ?
        `).run(expectedPdfSha256, now, run.id);
        this.#db.query(
          "UPDATE revisions SET status='approved' WHERE run_id=? AND revision=?",
        ).run(run.id, run.current_revision);
        this.#event(run.id, run.current_revision, "run.approved", {
          pdfSha256: expectedPdfSha256,
          visualAcknowledged: false,
          automatic: true,
        }, now);
      } else {
        this.#db.query(`
          UPDATE runs
          SET status = 'review', failed_stage = NULL, visual_ack_required = ?,
              approved_pdf_sha256 = NULL, updated_at = ?
          WHERE id = ?
        `).run(visualAcknowledgementRequired ? 1 : 0, now, run.id);
        this.#db.query(
          "UPDATE revisions SET status='review' WHERE run_id=? AND revision=?",
        ).run(run.id, run.current_revision);
        this.#event(run.id, run.current_revision, "run.transitioned", {
          from: "visual_qa",
          to: "review",
          failedStage: null,
        }, now);
      }
      return publicRun(this.#run(run.id));
    });
  }

  startAttempt(claim: Pick<RunClaim, "runId" | "token">, stage: ActiveStage, options: { origin?: AttemptOrigin; processPid?: number; processStartToken?: string } = {}): PublicAttempt {
    return this.#immediate(() => {
      const now = this.#now(); this.#assertClaim(claim, now); const run = this.#run(claim.runId);
      if (run.status !== stage) throw new RepositoryConflictError(`run is ${run.status}, not ${stage}`);
      const running = this.#db.query<{ count: number }, [string]>("SELECT count(*) AS count FROM attempts WHERE run_id=? AND status IN ('running','cancel_requested')").get(run.id);
      if ((running?.count ?? 0) !== 0) throw new RepositoryConflictError("an attempt is already active");
      const count = this.#db.query<{ count: number }, [string, number, ActiveStage]>("SELECT count(*) AS count FROM attempts WHERE run_id=? AND revision=? AND stage=?").get(run.id, run.current_revision, stage)?.count ?? 0;
      const revision = this.getRevision(run.id, run.current_revision);
      if (!revision) throw new Error("current revision missing");
      const id = this.#idFactory();
      const attemptSessionId = this.#attemptSessionIdFactory();
      this.#db.query("INSERT INTO attempts(id,run_id,revision,stage,attempt_no,origin,claim_token,attempt_session_id,status,process_pid,process_start_token,started_at) VALUES (?,?,?,?,?,?,?,?,'running',?,?,?)")
        .run(id, run.id, run.current_revision, stage, count + 1, options.origin ?? revision.origin, claim.token, attemptSessionId, options.processPid ?? null, options.processStartToken ?? null, now);
      this.#event(run.id, run.current_revision, "attempt.started", { attemptId: id, stage, attemptNo: count + 1 }, now);
      const row = this.#db.query<AttemptRow, [string]>("SELECT * FROM attempts WHERE id=?").get(id);
      if (!row) throw new Error("attempt insert failed");
      return publicAttempt(row);
    });
  }

  finishAttempt(claim: Pick<RunClaim, "runId" | "token">, attemptId: string, outcome: "succeeded" | "failed", audit: { toolCount?: number; compileCount?: number } = {}): PublicAttempt {
    return this.#immediate(() => {
      const now = this.#now(); this.#assertClaim(claim, now);
      const result = this.#db.query("UPDATE attempts SET status=?, tool_count=?, compile_count=?, finished_at=? WHERE id=? AND run_id=? AND claim_token=? AND status='running'")
        .run(outcome, audit.toolCount ?? 0, audit.compileCount ?? 0, now, attemptId, claim.runId, claim.token);
      if (result.changes !== 1) throw new ClaimRejectedError("attempt is not owned by this live claim");
      const row = this.#db.query<AttemptRow, [string]>("SELECT * FROM attempts WHERE id=?").get(attemptId);
      if (!row) throw new Error("attempt missing");
      this.#event(row.run_id, row.revision, "attempt.finished", { attemptId, outcome, toolCount: row.tool_count, compileCount: row.compile_count }, now);
      return publicAttempt(row);
    });
  }

  acknowledgeCancellation(attemptId: string, token: string): boolean {
    return this.#immediate(() => {
      const now = this.#now();
      const result = this.#db.query("UPDATE attempts SET status='cancelled', finished_at=?, cancellation_ack_at=? WHERE id=? AND claim_token=? AND status IN ('running','cancel_requested')").run(now, now, attemptId, token);
      if (result.changes !== 1) return false;
      const row = this.#db.query<AttemptRow, [string]>("SELECT * FROM attempts WHERE id=?").get(attemptId);
      if (row) this.#event(row.run_id, row.revision, "attempt.cancelled", { attemptId }, now);
      return true;
    });
  }

  finalizeArtifact(claim: Pick<RunClaim, "runId" | "token">, input: { id?: string; attemptId: string; stage: string; kind: string; sha256: string; path: string; byteSize: number; sourceArtifactId?: string }): PublicArtifact {
    return this.#immediate(() => {
      const now = this.#now(); this.#assertClaim(claim, now); const run = this.#run(claim.runId);
      const attempt = this.#db.query<AttemptRow, [string, string, string]>("SELECT * FROM attempts WHERE id=? AND run_id=? AND claim_token=? AND status='running'").get(input.attemptId, run.id, claim.token);
      if (!attempt) throw new ClaimRejectedError("artifact attempt is not owned by this live claim");
      const id = input.id ?? this.#idFactory();
      this.#db.query("INSERT INTO artifacts(id,run_id,revision,attempt_id,stage,kind,sha256,path,byte_size,source_artifact_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, run.id, run.current_revision, input.attemptId, input.stage, input.kind, input.sha256, input.path, input.byteSize, input.sourceArtifactId ?? null, now);
      this.#event(run.id, run.current_revision, "artifact.finalized", { artifactId: id, attemptId: input.attemptId, kind: input.kind, sha256: input.sha256, byteSize: input.byteSize }, now);
      return this.#publicArtifact(this.#artifact(id));
    });
  }

  #artifact(id: string): ArtifactRow {
    const row = this.#db.query<ArtifactRow, [string]>("SELECT * FROM artifacts WHERE id=?").get(id);
    if (!row) throw new RepositoryConflictError("artifact not found"); return row;
  }
  #publicArtifact(row: ArtifactRow): PublicArtifact {
    return { id: row.id, revision: row.revision, attemptId: row.attempt_id || null, stage: row.stage, kind: row.kind,
      sha256: row.sha256, path: row.path, byteSize: row.byte_size, createdAt: row.created_at };
  }
  getArtifactById(runId: string, artifactId: string): PublicArtifact | null {
    const row = this.#db.query<ArtifactRow, [string, string]>(`
      SELECT artifacts.*
      FROM artifacts
      JOIN runs ON runs.id = artifacts.run_id
      WHERE artifacts.run_id=? AND artifacts.id=? AND runs.deleted_at IS NULL
    `).get(runId, artifactId);
    return row ? this.#publicArtifact(row) : null;
  }

  getArtifact(runId: string, kind: string, revision?: number): PublicArtifact | null {
    const run = this.#run(runId);
    let current = revision ?? run.current_revision;
    const firstRevision = this.#db.query<RevisionRow, [string, number]>("SELECT * FROM revisions WHERE run_id=? AND revision=?").get(runId, current);
    const retryCutoff = firstRevision?.origin === "retry" && firstRevision.retry_stage ? stageRank[firstRevision.retry_stage] : null;
    const seen = new Set<number>();
    while (!seen.has(current)) {
      seen.add(current);
      const row = this.#db.query<ArtifactRow, [string, number, string]>(`
        SELECT *
        FROM artifacts
        WHERE run_id=? AND revision=? AND kind=?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `).get(runId, current, kind);
      if (row) {
        if (current === firstRevision?.revision || retryCutoff === null) return this.#publicArtifact(row);
        const artifactRank = artifactStageRank(row.stage);
        return artifactRank !== undefined && artifactRank < retryCutoff ? this.#publicArtifact(row) : null;
      }
      const rev = this.getRevision(runId, current); if (rev?.source_revision == null) break; current = rev.source_revision;
    }
    return null;
  }


  listArtifacts(runId: string, revision?: number): PublicArtifact[] {
    const run = this.#run(runId);
    const selected = revision ?? run.current_revision;
    return this.#db.query<ArtifactRow, [string, number]>("SELECT * FROM artifacts WHERE run_id=? AND revision=? ORDER BY created_at,id").all(runId, selected).map((row) => this.#publicArtifact(row));
  }
  listResolvedArtifacts(runId: string, revision?: number): PublicArtifact[] {
    const run = this.#run(runId);
    const selected = revision ?? run.current_revision;
    const kinds = this.#db.query<{ kind: string }, [string]>(
      "SELECT DISTINCT kind FROM artifacts WHERE run_id=? ORDER BY kind",
    ).all(runId);
    return kinds
      .map(({ kind }) => this.getArtifact(runId, kind, selected))
      .filter((artifact): artifact is PublicArtifact => artifact !== null);
  }

  getEditRequest(runId: string, targetRevision?: number): PublicEditRequest | null {
    let selected = targetRevision ?? this.#run(runId).current_revision;
    const seen = new Set<number>();
    while (!seen.has(selected)) {
      seen.add(selected);
      const row = this.#db.query<EditRequestRow, [string, number]>("SELECT * FROM edit_requests WHERE run_id=? AND target_revision=?").get(runId, selected);
      if (row) {
        return {
          id: row.id,
          sourceRevision: row.source_revision,
          targetRevision: row.target_revision,
          origin: row.origin,
          comments: row.comments,
          expectedPdfSha256: row.expected_pdf_sha256,
          createdAt: row.created_at,
        };
      }
      const revision = this.getRevision(runId, selected);
      if (revision?.origin !== "retry" || revision.source_revision === null) break;
      selected = revision.source_revision;
    }
    return null;
  }

  timeline(runId: string): PublicTimeline {
    const events = this.#db.query<EventRow, [string]>("SELECT * FROM events WHERE run_id=? ORDER BY sequence").all(runId).map((row) => ({ sequence: row.sequence, revision: row.revision, kind: row.kind, payload: JSON.parse(row.payload_json) as unknown, createdAt: row.created_at }));
    const attempts = this.#db.query<AttemptRow, [string]>("SELECT * FROM attempts WHERE run_id=? ORDER BY started_at,id").all(runId).map(publicAttempt);
    return { events, attempts };
  }

  #assertCommandable(runId: string, now: number): RunRow {
    const run = this.#run(runId);
    const claimed = this.#db.query<{ claimed: number }, [string, number]>(`
      SELECT EXISTS (
        SELECT 1
        FROM run_claim
        WHERE run_id = ? AND expires_at > ?
      ) AS claimed
    `).get(runId, now)?.claimed === 1;
    if (claimed) throw new RepositoryConflictError("run has a live claim");
    return run;
  }

  retry(runId: string, currentSources?: RunSourceSnapshotInput): PublicRun {
    return this.#immediate(() => {
      const now = this.#now(); const run = this.#assertCommandable(runId, now);
      this.#assertRunArtifactsRetained(run.id);
      if (currentSources) this.#assertSourceSnapshot(runId, currentSources);
      if (run.status !== "failed" || !run.failed_stage) throw new RepositoryConflictError("only a failed stage can be retried");
      const revision = run.current_revision + 1;
      this.#db.query("INSERT INTO revisions(run_id,revision,origin,source_revision,retry_stage,status,created_at) VALUES (?,?, 'retry',?,?,?,?)").run(run.id, revision, run.current_revision, run.failed_stage, run.failed_stage, now);
      this.#db.query("UPDATE runs SET current_revision=?,status=?,failed_stage=NULL,visual_ack_required=0,updated_at=? WHERE id=?").run(revision, run.failed_stage, now, run.id);
      this.#event(run.id, revision, "run.retried", { failedStage: run.failed_stage, sourceRevision: run.current_revision }, now);
      return publicRun(this.#run(run.id));
    });
  }

  regenerate(runId: string, expectedPdfSha256: string, currentSources?: RunSourceSnapshotInput): PublicRun {
    return this.#createEditRevision(runId, "machine_regenerate", "", expectedPdfSha256, currentSources);
  }

  editRun(runId: string, comments: string, expectedPdfSha256: string, currentSources?: RunSourceSnapshotInput): PublicRun {
    if (!comments.trim()) throw new Error("edit comments are required");
    return this.#createEditRevision(runId, "human_edit", comments, expectedPdfSha256, currentSources);
  }

  #createEditRevision(runId: string, origin: "machine_regenerate" | "human_edit", comments: string, expectedPdfSha256: string, currentSources?: RunSourceSnapshotInput): PublicRun {
    return this.#immediate(() => {
      const now = this.#now(); const run = this.#assertCommandable(runId, now);
      this.#assertRunArtifactsRetained(run.id);
      if (currentSources) this.#assertSourceSnapshot(runId, currentSources);
      const editsApprovedApplication = run.status === "approved" && origin === "human_edit";
      if (run.status !== "review" && !editsApprovedApplication) throw new RepositoryConflictError("run is not in review");
      const pdf = this.getArtifact(run.id, "compiled-pdf", run.current_revision);
      if (!pdf || pdf.sha256 !== expectedPdfSha256) throw new RepositoryConflictError("review PDF hash is stale");
      if (editsApprovedApplication) {
        const latestApplication = this.#db.query<ApplicationSessionRow, [string]>(`
          SELECT *
          FROM run_application_sessions
          WHERE run_id = ?
          ORDER BY generation DESC
          LIMIT 1
        `).get(run.id);
        if (
          latestApplication?.bridge_state !== "cancelled"
          || latestApplication.resume_revision !== run.current_revision
          || latestApplication.pdf_sha256 !== pdf.sha256
          || run.approved_pdf_sha256 !== pdf.sha256
        ) {
          throw new RepositoryConflictError("approved run does not have a matching cancelled application session");
        }
      }
      const target = run.current_revision + 1;
      this.#db.query("INSERT INTO revisions(run_id,revision,origin,source_revision,status,created_at) VALUES (?,?,?,?, 'editing',?)").run(run.id, target, origin, run.current_revision, now);
      this.#db.query("INSERT INTO edit_requests(id,run_id,source_revision,target_revision,origin,comments,expected_pdf_sha256,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(this.#idFactory(), run.id, run.current_revision, target, origin, comments, expectedPdfSha256, now);
      this.#db.query("UPDATE runs SET current_revision=?,status='editing',failed_stage=NULL,approved_pdf_sha256=NULL,visual_ack_required=0,updated_at=? WHERE id=?").run(target, now, run.id);
      this.#event(run.id, target, "run.edit_requested", { origin, sourceRevision: run.current_revision, expectedPdfSha256 }, now);
      return publicRun(this.#run(run.id));
    });
  }

  approve(runId: string, expectedPdfSha256: string, visualAcknowledged = false, currentSources?: RunSourceSnapshotInput): PublicRun {
    return this.#immediate(() => {
      const now = this.#now(); const run = this.#assertCommandable(runId, now);
      this.#assertRunArtifactsRetained(run.id);
      if (currentSources) this.#assertSourceSnapshot(runId, currentSources);
      if (run.status !== "review") throw new RepositoryConflictError("run is not in review");
      const pdf = this.getArtifact(run.id, "compiled-pdf", run.current_revision);
      if (!pdf || pdf.sha256 !== expectedPdfSha256) throw new RepositoryConflictError("review PDF hash is stale");
      if (run.visual_ack_required === 1 && !visualAcknowledged) throw new RepositoryConflictError("visual acknowledgement is required");
      this.#db.query("UPDATE runs SET status='approved',approved_pdf_sha256=?,visual_ack_required=0,updated_at=? WHERE id=?").run(expectedPdfSha256, now, run.id);
      this.#db.query("UPDATE revisions SET status='approved' WHERE run_id=? AND revision=?").run(run.id, run.current_revision);
      this.#event(run.id, run.current_revision, "run.approved", { pdfSha256: expectedPdfSha256, visualAcknowledged }, now);
      return publicRun(this.#run(run.id));
    });
  }
}

export const WorkflowRepository = PipelineRepository;
