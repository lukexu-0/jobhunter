import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { CLAIM_TTL_MS, createClaimToken, isProcessIdentityAlive, type ClaimTokenFactory, type RunClaim } from "../worker/claims.ts";

export const RUN_STATUSES = ["queued", "analyzing", "tailoring", "editing", "compiling", "repairing", "deterministic_qa", "visual_qa", "review", "approved", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const APPLICATION_STATUSES = ["pending", "applied", "rejected", "interview", "accepted", "failed"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export type ActiveStage = Exclude<RunStatus, "queued" | "review" | "approved" | "failed">;
export type RevisionOrigin = "initial" | "retry" | "machine_regenerate" | "human_edit";
export type AttemptOrigin = RevisionOrigin | "repair_loop";

export class RepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryConflictError";
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

interface RunRow {
  id: string;
  job_description: string;
  status: RunStatus;
  application_status: ApplicationStatus;
  generate_keyword_map: number;
  current_revision: number;
  failed_stage: ActiveStage | null;
  visual_ack_required: number;
  approved_pdf_sha256: string | null;
  queue_sequence: number;
  created_at: number;
  updated_at: number;
}
interface ClaimRow { run_id: string | null; claim_token: string | null; expires_at: number | null }
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
interface RevisionRow { run_id: string; revision: number; origin: RevisionOrigin; source_revision: number | null; retry_stage: ActiveStage | null; status: RunStatus; created_at: number }
interface EventRow { sequence: number; run_id: string; revision: number | null; kind: string; payload_json: string; created_at: number }
interface EditRequestRow { id: string; run_id: string; source_revision: number; target_revision: number; origin: "machine_regenerate" | "human_edit"; comments: string; expected_pdf_sha256: string; created_at: number }

export interface PublicRun {
  readonly id: string;
  readonly jobDescription: string;
  readonly status: RunStatus;
  readonly applicationStatus: ApplicationStatus;
  readonly generateKeywordMap: boolean;
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
  return { id: row.id, jobDescription: row.job_description, status: row.status,
    applicationStatus: row.application_status, generateKeywordMap: row.generate_keyword_map === 1,
    queueSequence: row.queue_sequence, currentRevision: row.current_revision, failedStage: row.failed_stage,
    visualAcknowledgementRequired: row.visual_ack_required === 1, approvedPdfSha256: row.approved_pdf_sha256,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function publicAttempt(row: AttemptRow): PublicAttempt {
  return { id: row.id, attemptSessionId: row.attempt_session_id, revision: row.revision, stage: row.stage, attemptNo: row.attempt_no, origin: row.origin,
    status: row.status, processPid: row.process_pid, toolCount: row.tool_count, compileCount: row.compile_count,
    startedAt: row.started_at, finishedAt: row.finished_at, cancellationAcknowledgedAt: row.cancellation_ack_at };
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
    const row = this.#db.query<RunRow, [string]>("SELECT * FROM runs WHERE id=?").get(runId);
    if (!row) throw new RepositoryConflictError("run not found");
    return row;
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
    const row = this.#db.query<ClaimRow, [string, string, number]>("SELECT run_id, claim_token, expires_at FROM run_claim WHERE id=1 AND run_id=? AND claim_token=? AND expires_at>?").get(claim.runId, claim.token, now);
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
    snapshot: RunSourceSnapshotInput,
    input: QueuedInputArtifact,
    id = this.#idFactory(),
    generateKeywordMap = true,
    queueSequence?: number,
  ): PublicRun {
    if (!jobDescription.trim()) throw new Error("job description is required");
    if (!/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.byteSize) || input.byteSize < 0 || !input.path) {
      throw new Error("queued input artifact metadata is invalid");
    }
    if (typeof generateKeywordMap !== "boolean") throw new Error("generate keyword map setting must be boolean");
    if (queueSequence !== undefined && (!Number.isSafeInteger(queueSequence) || queueSequence < 1)) {
      throw new Error("queue sequence must be a positive integer");
    }
    const sourceHashes = this.#validateSnapshot(snapshot);
    return this.#immediate(() => {
      const now = this.#now();
      const sequence = queueSequence ?? this.nextQueueSequence();
      this.#db.query("INSERT INTO runs(id, job_description, status, generate_keyword_map, current_revision, queue_sequence, created_at, updated_at) VALUES (?, ?, 'queued', ?, 1, ?, ?, ?)")
        .run(id, jobDescription, generateKeywordMap ? 1 : 0, sequence, now, now);
      this.#db.query("INSERT INTO revisions(run_id, revision, origin, source_revision, status, created_at) VALUES (?, 1, 'initial', NULL, 'queued', ?)").run(id, now);
      this.#db.query("INSERT INTO run_source_snapshots(run_id,manifest_sha256,baseline_sha256,source_hashes_json,created_at) VALUES (?,?,?,?,?)")
        .run(id, snapshot.manifestSha256, snapshot.baselineSha256, JSON.stringify(sourceHashes), now);
      const artifactId = input.id ?? this.#idFactory();
      this.#db.query("INSERT INTO artifacts(id,run_id,revision,attempt_id,stage,kind,sha256,path,byte_size,created_at) VALUES (?, ?, 1, '', 'input', 'job-description', ?, ?, ?, ?)")
        .run(artifactId, id, input.sha256, input.path, input.byteSize, now);
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


  createRun(jobDescription: string, id = this.#idFactory(), generateKeywordMap = true): PublicRun {
    if (!jobDescription.trim()) throw new Error("job description is required");
    if (typeof generateKeywordMap !== "boolean") throw new Error("generate keyword map setting must be boolean");
    return this.#immediate(() => {
      const now = this.#now();
      this.#db.query("INSERT INTO runs(id, job_description, status, generate_keyword_map, current_revision, queue_sequence, created_at, updated_at) SELECT ?, ?, 'queued', ?, 1, coalesce(max(queue_sequence), 0) + 1, ?, ? FROM runs").run(id, jobDescription, generateKeywordMap ? 1 : 0, now, now);
      this.#db.query("INSERT INTO revisions(run_id, revision, origin, source_revision, status, created_at) VALUES (?, 1, 'initial', NULL, 'queued', ?)").run(id, now);
      this.#event(id, 1, "run.created", { status: "queued", origin: "initial" }, now);
      return publicRun(this.#run(id));
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
    const row = this.#db.query<RunRow, [string]>("SELECT * FROM runs WHERE id=?").get(runId);
    return row ? publicRun(row) : null;
  }

  listRuns(limit = 100): PublicRun[] {
    return this.#db.query<RunRow, [number]>("SELECT * FROM runs ORDER BY queue_sequence LIMIT ?").all(limit).map(publicRun);
  }

  reserveArtifactPruneCandidates(retainCount: number): string[] {
    if (!Number.isSafeInteger(retainCount) || retainCount < 1) throw new Error("artifact retention count must be a positive integer");
    return this.#immediate(() => {
      this.#db.query(`
        INSERT INTO run_artifact_retention(run_id, state, selected_at)
        SELECT runs.id, 'pruning', ?
        FROM runs
        WHERE runs.id NOT IN (SELECT id FROM runs ORDER BY queue_sequence DESC LIMIT ?)
          AND runs.status IN ('review','approved','failed')
          AND NOT EXISTS (
            SELECT 1
            FROM run_claim
            WHERE run_claim.id = 1
              AND run_claim.run_id = runs.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM attempts
            WHERE attempts.run_id = runs.id
              AND attempts.status IN ('running','cancel_requested')
          )
        ON CONFLICT(run_id) DO NOTHING
      `).run(this.#now(), retainCount);
      return this.#db.query<{ run_id: string }, []>(`
        SELECT run_artifact_retention.run_id
        FROM run_artifact_retention
        JOIN runs ON runs.id = run_artifact_retention.run_id
        WHERE run_artifact_retention.state = 'pruning'
        ORDER BY runs.queue_sequence
      `).all().map((row) => row.run_id);
    });
  }

  markRunArtifactsPruned(runId: string): void {
    this.#immediate(() => {
      this.#db.query(`
        UPDATE run_artifact_retention
        SET state = 'pruned', pruned_at = ?
        WHERE run_id = ? AND state = 'pruning'
      `).run(this.#now(), runId);
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

  getRevision(runId: string, revision?: number): RevisionRow | null {
    const selected = revision ?? this.#run(runId).current_revision;
    return this.#db.query<RevisionRow, [string, number]>("SELECT * FROM revisions WHERE run_id=? AND revision=?").get(runId, selected) ?? null;
  }
  resolveCurrentRevisionOrigin(runId: string): Exclude<RevisionOrigin, "retry"> {
    let revision = this.getRevision(runId);
    const seen = new Set<number>();
    while (revision?.origin === "retry") {
      if (seen.has(revision.revision) || revision.source_revision === null) throw new Error("retry revision ancestry is corrupt");
      seen.add(revision.revision);
      revision = this.getRevision(runId, revision.source_revision);
    }
    if (!revision) throw new RepositoryConflictError("revision not found");
    return revision.origin;
  }
  getRevisionStatus(runId: string, revision: number): RunStatus | null {
    return this.getRevision(runId, revision)?.status ?? null;
  }

  acquire(): RunClaim | null {
    return this.#immediate(() => {
      const now = this.#now();
      const singleton = this.#db.query<ClaimRow, []>("SELECT run_id, claim_token, expires_at FROM run_claim WHERE id=1").get();
      if (!singleton) throw new Error("missing singleton run claim");
      if (singleton.run_id && singleton.expires_at !== null && singleton.expires_at > now) return null;

      let candidate: RunRow | null = null;
      if (singleton.run_id) {
        const interrupted = this.#run(singleton.run_id);
        if (runnableStatuses.has(interrupted.status) && !this.#hasArtifactRetentionReservation(interrupted.id)) {
          const active = this.#db.query<AttemptRow, [string]>("SELECT * FROM attempts WHERE run_id=? AND status IN ('running','cancel_requested') ORDER BY started_at DESC LIMIT 1").get(interrupted.id);
          if (active) {
            const knownDead = active.process_pid !== null && active.process_start_token !== null && !this.#isProcessAlive(active.process_pid, active.process_start_token);
            if (!knownDead) {
              if (active.status === "running") this.#db.query("UPDATE attempts SET status='cancel_requested' WHERE id=? AND claim_token=? AND status='running'").run(active.id, active.claim_token);
              return null;
            }
            this.#db.query("UPDATE attempts SET status='cancelled', finished_at=?, cancellation_ack_at=? WHERE id=? AND status IN ('running','cancel_requested')").run(now, now, active.id);
            this.#event(active.run_id, active.revision, "attempt.process_dead", { attemptId: active.id }, now);
          }
          candidate = interrupted;
        }
      }
      if (!candidate) {
        candidate = this.#db.query<RunRow, []>(`
          SELECT *
          FROM runs
          WHERE status IN ('queued','analyzing','tailoring','editing','compiling','repairing','deterministic_qa','visual_qa')
            AND NOT EXISTS (
              SELECT 1
              FROM run_artifact_retention
              WHERE run_artifact_retention.run_id = runs.id
            )
          ORDER BY queue_sequence
          LIMIT 1
        `).get() ?? null;
      }
      if (!candidate) {
        this.#db.query("UPDATE run_claim SET run_id=NULL, claim_token=NULL, expires_at=NULL WHERE id=1").run();
        return null;
      }
      let token = this.#tokenFactory();
      for (let retries = 0; token === singleton.claim_token && retries < 4; retries++) token = this.#tokenFactory();
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("token factory must return a 256-bit base64url token");
      if (token === singleton.claim_token) throw new Error("token factory did not provide a fresh claim token");
      const expiresAt = now + CLAIM_TTL_MS;
      this.#db.query("UPDATE run_claim SET run_id=?, claim_token=?, expires_at=? WHERE id=1").run(candidate.id, token, expiresAt);
      this.#event(candidate.id, candidate.current_revision, "run.claimed", { expiresAt }, now);
      return { runId: candidate.id, token, expiresAt };
    });
  }

  heartbeat(claim: Pick<RunClaim, "runId" | "token">): RunClaim {
    return this.#immediate(() => {
      const now = this.#now(); const expiresAt = now + CLAIM_TTL_MS;
      const result = this.#db.query("UPDATE run_claim SET expires_at=? WHERE id=1 AND run_id=? AND claim_token=? AND expires_at>?").run(expiresAt, claim.runId, claim.token, now);
      if (result.changes !== 1) throw new ClaimRejectedError();
      return { runId: claim.runId, token: claim.token, expiresAt };
    });
  }

  release(claim: Pick<RunClaim, "runId" | "token">): void {
    this.#immediate(() => {
      const now = this.#now();
      const result = this.#db.query("UPDATE run_claim SET run_id=NULL, claim_token=NULL, expires_at=NULL WHERE id=1 AND run_id=? AND claim_token=? AND expires_at>?").run(claim.runId, claim.token, now);
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
    const row = this.#db.query<ArtifactRow, [string, string]>("SELECT * FROM artifacts WHERE run_id=? AND id=?").get(runId, artifactId);
    return row ? this.#publicArtifact(row) : null;
  }

  getArtifact(runId: string, kind: string, revision?: number): PublicArtifact | null {
    let current = revision ?? this.#run(runId).current_revision;
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
    const selected = revision ?? this.#run(runId).current_revision;
    return this.#db.query<ArtifactRow, [string, number]>("SELECT * FROM artifacts WHERE run_id=? AND revision=? ORDER BY created_at,id").all(runId, selected).map((row) => this.#publicArtifact(row));
  }
  listResolvedArtifacts(runId: string): PublicArtifact[] {
    const run = this.#run(runId);
    const kinds = this.#db.query<{ kind: string }, [string]>("SELECT DISTINCT kind FROM artifacts WHERE run_id=? ORDER BY kind").all(runId);
    return kinds.map(({ kind }) => this.getArtifact(runId, kind, run.current_revision)).filter((artifact): artifact is PublicArtifact => artifact !== null);
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
    const claim = this.#db.query<ClaimRow, []>("SELECT run_id,claim_token,expires_at FROM run_claim WHERE id=1").get();
    if (claim?.run_id === runId && claim.expires_at !== null && claim.expires_at > now) throw new RepositoryConflictError("run has a live claim");
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
      if (run.status !== "review") throw new RepositoryConflictError("run is not in review");
      const pdf = this.getArtifact(run.id, "compiled-pdf", run.current_revision);
      if (!pdf || pdf.sha256 !== expectedPdfSha256) throw new RepositoryConflictError("review PDF hash is stale");
      const target = run.current_revision + 1;
      this.#db.query("INSERT INTO revisions(run_id,revision,origin,source_revision,status,created_at) VALUES (?,?,?,?, 'editing',?)").run(run.id, target, origin, run.current_revision, now);
      this.#db.query("INSERT INTO edit_requests(id,run_id,source_revision,target_revision,origin,comments,expected_pdf_sha256,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(this.#idFactory(), run.id, run.current_revision, target, origin, comments, expectedPdfSha256, now);
      this.#db.query("UPDATE runs SET current_revision=?,status='editing',failed_stage=NULL,visual_ack_required=0,updated_at=? WHERE id=?").run(target, now, run.id);
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
