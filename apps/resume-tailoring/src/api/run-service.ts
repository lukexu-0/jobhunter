import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  JobDescriptionSchema,
  type ApplicationStatus,
  type ArtifactDto,
  type ArtifactKind,
  type AttemptDto,
  type AttemptStage,
  type RevisionOrigin as PublicRevisionOrigin,
  type ResumeIterationListResponse,
  type RunDto,
  type RunStatus,
  type TimelineEvent,
} from "../contracts";
import type { ContextSnapshot } from "../context/types.ts";
import {
  PipelineRepository,
  RepositoryConflictError,
  RunArtifactsPrunedError,
  SourceDriftError,
  type ActiveStage,
  type PublicArtifact,
  type PublicEvent,
  type PublicRun,
  type RunSourceSnapshotInput,
} from "../db/repository.ts";
import { OAuthRequiredError } from "../auth/oauth-only-resolver.ts";
import {
  extractJobDescriptionWithLuna,
  LunaJobExtractionError,
  type ExtractJobDescription,
} from "../models/luna-job-extractor.ts";
import {
  JobSourceError,
  loadJobSourceFromUrl,
  type LoadedJobSource,
  type LoadJobSource,
} from "./job-source.ts";
import { ArtifactStore } from "../system/artifacts.ts";

const MAX_JOB_DESCRIPTION_BYTES = 200_000;
const MAX_PUBLIC_METADATA_BYTES = 1024 * 1024;
export const MAX_COMPILED_PDF_BYTES = 10 * 1024 * 1024;
const PUBLIC_ARTIFACT_KINDS: Readonly<Record<string, ArtifactKind>> = Object.freeze({
  "job-analysis": "job-analysis",
  "ats-keyword-extraction": "ats-keyword-extraction",
  "tailoring-plan": "tailoring-plan",
  "evidence-ledger": "evidence-ledger",
  "change-summary": "change-summary",
  "resume-diff": "resume-diff",
  "tailored-tex": "tailored-tex",
  "compiled-pdf": "compiled-pdf",
  "keyword-map-pdf": "keyword-map-pdf",
  "page-image": "page-image",
  "deterministic-qa": "deterministic-qa",
  "visual-qa": "visual-qa",
  "edit-report": "edit-report",
  "repair-report": "repair-report",
});
const STAGE_TO_PUBLIC: Readonly<Record<ActiveStage, AttemptStage>> = Object.freeze({
  analyzing: "analysis",
  tailoring: "tailoring",
  editing: "edit",
  compiling: "compile",
  repairing: "repair",
  deterministic_qa: "deterministic-qa",
  visual_qa: "visual-qa",
});

function isRunStatus(value: unknown): value is RunStatus {
  return value === "queued"
    || value === "analyzing"
    || value === "tailoring"
    || value === "editing"
    || value === "compiling"
    || value === "repairing"
    || value === "deterministic_qa"
    || value === "visual_qa"
    || value === "review"
    || value === "approved"
    || value === "failed";
}

export interface RunContextSnapshotService {
  createSnapshot(): ContextSnapshot | Promise<ContextSnapshot>;
}

export interface RunScheduler {
  kick(): void;
}

export interface RunApplicationDependencies {
  readonly repository: PipelineRepository;
  readonly context: RunContextSnapshotService;
  readonly artifacts: ArtifactStore;
  readonly scheduler: RunScheduler | (() => void);
  readonly idFactory?: () => string;
  readonly loadJobSource?: LoadJobSource;
  readonly extractJobDescription?: ExtractJobDescription;
}

export class RunServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 | 410 | 422 | 502 | 504) {
    super(message);
    this.name = "RunServiceError";
  }
}

function sourceSnapshot(snapshot: ContextSnapshot): RunSourceSnapshotInput {
  return {
    manifestSha256: snapshot.manifestSha256,
    baselineSha256: snapshot.baselineSha256,
    sourceHashes: snapshot.sourceHashes,
  };
}

function mediaType(kind: ArtifactKind): string {
  if (kind === "compiled-pdf" || kind === "keyword-map-pdf") return "application/pdf";
  if (kind === "page-image") return "image/png";
  if (kind === "tailored-tex") return "text/x-tex; charset=utf-8";
  return "application/json; charset=utf-8";
}

function extension(kind: ArtifactKind): string {
  if (kind === "compiled-pdf" || kind === "keyword-map-pdf") return "pdf";
  if (kind === "page-image") return "png";
  if (kind === "tailored-tex") return "tex";
  return "json";
}

function publicFilename(kind: ArtifactKind): string {
  if (kind === "compiled-pdf") return "Alex_Example_Resume.pdf";
  if (kind === "tailored-tex") return "Alex_Example_Resume.tex";
  return `${kind}.${extension(kind)}`;
}

function publicArtifactLimit(kind: ArtifactKind): number {
  if (kind === "compiled-pdf" || kind === "keyword-map-pdf") return MAX_COMPILED_PDF_BYTES;
  if (kind === "page-image") return 25 * 1024 * 1024;
  if (kind === "tailored-tex") return 256 * 1024;
  return MAX_PUBLIC_METADATA_BYTES;
}


function publicOrigin(origin: "initial" | "machine_regenerate" | "human_edit"): PublicRevisionOrigin {
  if (origin === "machine_regenerate") return "machine-regeneration";
  if (origin === "human_edit") return "human-comments";
  return "initial";
}

function safeDetail(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (normalized.includes("token") || normalized.includes("claim") || normalized.includes("path") || normalized.includes("pid") || normalized.includes("log") || normalized.includes("session")) continue;
    if (nested === null || typeof nested === "string" || typeof nested === "number" || typeof nested === "boolean") result[key] = nested;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function timeline(events: readonly PublicEvent[], fallback: RunStatus): TimelineEvent[] {
  let status: RunStatus = "queued";
  return events.map((event) => {
    const detail = safeDetail(event.payload);
    const candidate = detail?.to ?? detail?.status;
    if (isRunStatus(candidate)) {
      status = candidate;
    } else if (event.kind === "run.retried" && isRunStatus(detail?.failedStage)) {
      status = detail.failedStage;
    } else if (event.kind === "run.edit_requested") status = "editing";
    else if (event.kind === "run.approved") status = "approved";
    return {
      id: event.sequence,
      type: event.kind,
      status: events.length === 1 && event.kind !== "run.created" ? fallback : status,
      revision: event.revision ?? 0,
      at: event.createdAt,
      ...(detail ? { detail } : {}),
    };
  });
}

function artifactDto(
  runId: string,
  artifact: PublicArtifact,
  attemptById: ReadonlyMap<string, number>,
  selectedRevision?: number,
): ArtifactDto | null {
  const kind = PUBLIC_ARTIFACT_KINDS[artifact.kind];
  if (!kind || !artifact.attemptId) return null;
  const attempt = attemptById.get(artifact.attemptId);
  if (!attempt) return null;
  return {
    id: artifact.id,
    kind,
    revision: artifact.revision,
    attempt,
    sha256: artifact.sha256,
    bytes: artifact.byteSize,
    mediaType: mediaType(kind),
    href: selectedRevision === undefined
      ? `/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}`
      : `/v1/runs/${encodeURIComponent(runId)}/iterations/${selectedRevision}/artifacts/${encodeURIComponent(artifact.id)}`,
    public: true,
    createdAt: artifact.createdAt,
  };
}

export interface VerifiedArtifactBytes {
  readonly bytes: Uint8Array;
  readonly digestBase64: string;
}

export async function readVerifiedArtifactBytes(
  artifacts: Pick<ArtifactStore, "read">,
  artifact: Pick<PublicArtifact, "path" | "byteSize" | "sha256">,
  maxBytes: number,
): Promise<VerifiedArtifactBytes> {
  if (artifact.byteSize > maxBytes) {
    throw new RunServiceError("ARTIFACT_CORRUPT", "Artifact exceeds its public size limit", 409);
  }
  const bytes = await artifacts.read(artifact.path, maxBytes);
  if (bytes.byteLength !== artifact.byteSize) {
    throw new RunServiceError(
      "ARTIFACT_CORRUPT",
      "Artifact metadata does not match stored content",
      409,
    );
  }
  const digest = createHash("sha256").update(bytes).digest();
  if (digest.toString("hex") !== artifact.sha256) {
    throw new RunServiceError("ARTIFACT_CORRUPT", "Artifact hash verification failed", 409);
  }
  return { bytes, digestBase64: digest.toString("base64") };
}

export class RunApplicationService {
  readonly #idFactory: () => string;
  readonly #loadJobSource: LoadJobSource;
  readonly #extractJobDescription: ExtractJobDescription;

  constructor(private readonly dependencies: RunApplicationDependencies) {
    this.#idFactory = dependencies.idFactory ?? randomUUID;
    this.#loadJobSource = dependencies.loadJobSource ?? loadJobSourceFromUrl;
    this.#extractJobDescription = dependencies.extractJobDescription ?? extractJobDescriptionWithLuna;
  }

  kick(): void {
    if (typeof this.dependencies.scheduler === "function") this.dependencies.scheduler();
    else this.dependencies.scheduler.kick();
  }

  async listRuns(): Promise<RunDto[]> {
    return await Promise.all(this.dependencies.repository.listRuns().map((run) => this.#toDto(run)));
  }

  async getRun(id: string): Promise<RunDto | undefined> {
    const run = this.dependencies.repository.getRun(id);
    return run ? await this.#toDto(run) : undefined;
  }

  async createRun(jobUrl: string, generateKeywordMapOrSignal: boolean | AbortSignal = true, requestSignal?: AbortSignal): Promise<RunDto> {
    const generateKeywordMap = typeof generateKeywordMapOrSignal === "boolean" ? generateKeywordMapOrSignal : true;
    const signal = typeof generateKeywordMapOrSignal === "boolean" ? requestSignal : generateKeywordMapOrSignal;
    signal?.throwIfAborted();
    let source: LoadedJobSource;
    try {
      source = await this.#loadJobSource(jobUrl, signal);
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      throw error;
    }
    signal?.throwIfAborted();

    let jobDescription: string | null;
    if (source.kind === "description") {
      jobDescription = source.jobDescription;
    } else {
      try {
        jobDescription = await this.#extractJobDescription(source.lines, signal);
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        if (error instanceof OAuthRequiredError) {
          throw new RunServiceError(
            "JOB_EXTRACTION_AUTH_REQUIRED",
            "Connect OpenAI Codex OAuth before importing this job page",
            409,
          );
        }
        if (error instanceof LunaJobExtractionError) {
          if (error.kind === "timeout") {
            throw new RunServiceError(
              "JOB_EXTRACTION_TIMEOUT",
              "Job description extraction timed out",
              504,
            );
          }
          throw new RunServiceError(
            "JOB_EXTRACTION_UNAVAILABLE",
            "Job description extraction failed",
            502,
          );
        }
        throw error;
      }
      signal?.throwIfAborted();
    }
    if (jobDescription === null) throw new JobSourceError("JOB_DESCRIPTION_UNAVAILABLE");
    const validated = JobDescriptionSchema.parse(jobDescription);

    signal?.throwIfAborted();
    let freshSnapshot: ContextSnapshot;
    try {
      freshSnapshot = await this.#freshSnapshot();
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      throw error;
    }
    signal?.throwIfAborted();
    const snapshot = sourceSnapshot(freshSnapshot);

    const runId = this.#idFactory();
    const reservation = await this.dependencies.artifacts.reserveRunInput(
      this.dependencies.repository.nextQueueSequence(),
    );
    let run: PublicRun;
    try {
      const input = await this.dependencies.artifacts.write(
        join(reservation.path, "job-description.txt"),
        validated,
        MAX_JOB_DESCRIPTION_BYTES,
      );
      run = this.dependencies.repository.createQueuedRun(validated, jobUrl, snapshot, {
        sha256: input.sha256,
        path: input.path,
        byteSize: input.bytes,
      }, runId, generateKeywordMap, reservation.run);
    } catch (error) {
      try {
        await this.dependencies.artifacts.removeRun(reservation.run);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "run creation and output cleanup failed");
      }
      throw error;
    }
    return await this.#toDto(run);
  }

  async updateApplicationStatus(id: string, applicationStatus: ApplicationStatus): Promise<RunDto> {
    return await this.#command(() => this.dependencies.repository.setApplicationStatus(id, applicationStatus));
  }

  async updateRunIdentity(
    id: string,
    identity: { readonly title?: string | undefined; readonly organization?: string | undefined },
  ): Promise<RunDto> {
    return await this.#command(() => this.dependencies.repository.setIdentity(id, identity));
  }

  async deleteRun(id: string): Promise<void> {
    await this.#mutation(() => this.dependencies.repository.deleteRun(id));
  }

  async retryRun(id: string): Promise<RunDto> {
    return await this.#command(async () => {
      this.#assertArtifactsRetained(id);
      const current = sourceSnapshot(await this.#freshSnapshot());
      return this.dependencies.repository.retry(id, current);
    });
  }

  async regenerateRun(id: string, expectedPdfSha256: string): Promise<RunDto> {
    return await this.#command(async () => {
      this.#assertArtifactsRetained(id);
      const current = sourceSnapshot(await this.#freshSnapshot());
      return this.dependencies.repository.regenerate(id, expectedPdfSha256, current);
    });
  }

  async editRun(id: string, comments: string, expectedPdfSha256: string): Promise<RunDto> {
    return await this.#command(async () => {
      this.#assertArtifactsRetained(id);
      const current = sourceSnapshot(await this.#freshSnapshot());
      return this.dependencies.repository.editRun(id, comments, expectedPdfSha256, current);
    });
  }

  async approveRun(id: string, expectedPdfSha256: string, acknowledgeVisualIssues: boolean): Promise<RunDto> {
    return await this.#command(async () => {
      this.#assertArtifactsRetained(id);
      const current = sourceSnapshot(await this.#freshSnapshot());
      return this.dependencies.repository.approve(id, expectedPdfSha256, acknowledgeVisualIssues, current);
    });
  }

  async listResumeIterations(runId: string): Promise<ResumeIterationListResponse> {
    const repository = this.dependencies.repository;
    const run = repository.getRun(runId);
    if (!run) throw new RunServiceError("RUN_NOT_FOUND", "Run not found", 404);
    const reviewable = repository.listReviewableRevisions(runId);
    const retained = repository.areRunArtifactsRetained(runId);
    const attemptById = retained
      ? new Map(
          repository.timeline(runId).attempts.map((attempt) => [attempt.id, attempt.attemptNo]),
        )
      : new Map<string, number>();

    return {
      artifactState: retained ? "retained" : "pruned",
      iterations: reviewable.map((revision) => ({
        revision: revision.revision,
        origin: publicOrigin(repository.resolveRevisionOrigin(runId, revision.revision)),
        status: revision.status,
        createdAt: revision.createdAt,
        pdfSha256: revision.pdfSha256,
        artifacts: retained
          ? repository
              .listResolvedArtifacts(runId, revision.revision)
              .map((artifact) =>
                artifactDto(runId, artifact, attemptById, revision.revision)
              )
              .filter((artifact): artifact is ArtifactDto => artifact !== null)
          : [],
      })),
    };
  }

  async getResumeIterationArtifact(
    runId: string,
    revision: number,
    artifactId: string,
  ): Promise<Response | undefined> {
    const repository = this.dependencies.repository;
    const run = repository.getRun(runId);
    if (!run || !Number.isSafeInteger(revision) || revision < 1) return undefined;
    if (!repository.areRunArtifactsRetained(runId)) {
      throw new RunServiceError(
        "RUN_ARTIFACTS_PRUNED",
        "Run artifacts were removed by the ten-run retention policy",
        410,
      );
    }
    const revisionStatus = repository.getRevisionStatus(runId, revision);
    if (revisionStatus !== "review" && revisionStatus !== "approved") return undefined;
    const artifact = repository.getArtifactById(runId, artifactId);
    if (!artifact) return undefined;
    const kind = PUBLIC_ARTIFACT_KINDS[artifact.kind];
    if (!kind) return undefined;
    const isResolved = repository
      .listResolvedArtifacts(runId, revision)
      .some((candidate) => candidate.id === artifact.id);
    if (!isResolved) return undefined;
    return await this.#verifiedArtifactResponse(runId, artifact, kind);
  }

  async getArtifact(runId: string, artifactId: string): Promise<Response | undefined> {
    const run = this.dependencies.repository.getRun(runId);
    if (!run) return undefined;
    if (!this.dependencies.repository.areRunArtifactsRetained(runId)) {
      throw new RunServiceError(
        "RUN_ARTIFACTS_PRUNED",
        "Run artifacts were removed by the ten-run retention policy",
        410,
      );
    }
    const artifact = this.dependencies.repository.getArtifactById(runId, artifactId);
    if (!artifact) return undefined;
    const kind = PUBLIC_ARTIFACT_KINDS[artifact.kind];
    if (!kind) return undefined;
    const isCurrentReviewArtifact = (run.status === "review" || run.status === "approved")
      && this.dependencies.repository.listResolvedArtifacts(runId).some((candidate) => candidate.id === artifact.id);
    const isApprovedRevision = this.dependencies.repository.getRevisionStatus(runId, artifact.revision) === "approved";
    if (!isCurrentReviewArtifact && !isApprovedRevision) return undefined;

    return await this.#verifiedArtifactResponse(runId, artifact, kind);
  }

  async #verifiedArtifactResponse(
    runId: string,
    artifact: PublicArtifact,
    kind: ArtifactKind,
  ): Promise<Response> {
    let verified: VerifiedArtifactBytes;
    try {
      verified = await readVerifiedArtifactBytes(
        this.dependencies.artifacts,
        artifact,
        publicArtifactLimit(kind),
      );
    } catch (error) {
      if (!this.dependencies.repository.areRunArtifactsRetained(runId)) {
        throw new RunServiceError(
          "RUN_ARTIFACTS_PRUNED",
          "Run artifacts were removed by the ten-run retention policy",
          410,
        );
      }
      throw error;
    }
    const { bytes, digestBase64 } = verified;
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    return new Response(body, {
      headers: {
        "cache-control": "no-store",
        "content-type": mediaType(kind),
        "content-length": String(bytes.byteLength),
        "content-disposition": `${kind === "compiled-pdf" || kind === "keyword-map-pdf" ? "inline" : "attachment"}; filename="${publicFilename(kind)}"`,
        "etag": `"sha256-${artifact.sha256}"`,
        "digest": `sha-256=${digestBase64}`,
        "x-content-sha256": artifact.sha256,
        "x-content-type-options": "nosniff",
      },
    });
  }

  #assertArtifactsRetained(runId: string): void {
    if (!this.dependencies.repository.areRunArtifactsRetained(runId)) throw new RunArtifactsPrunedError();
  }

  async #freshSnapshot(): Promise<ContextSnapshot> {
    try {
      return await this.dependencies.context.createSnapshot();
    } catch {
      throw new RunServiceError("CONTEXT_STALE", "Context index is stale; synchronize it before continuing", 409);
    }
  }

  async #command(command: () => PublicRun | Promise<PublicRun>): Promise<RunDto> {
    return await this.#toDto(await this.#mutation(command));
  }

  async #mutation<T>(command: () => T | Promise<T>): Promise<T> {
    try {
      return await command();
    } catch (error) {
      if (error instanceof RunArtifactsPrunedError) {
        throw new RunServiceError(
          "RUN_ARTIFACTS_PRUNED",
          "Run artifacts were removed by the ten-run retention policy",
          410,
        );
      }
      if (error instanceof SourceDriftError) throw new RunServiceError("SOURCE_DRIFT", error.message, 409);
      if (error instanceof RepositoryConflictError) {
        const message = error.message;
        const code = message === "run not found" ? "RUN_NOT_FOUND"
          : message.includes("stale") ? "STALE_PDF"
          : message.includes("visual acknowledgement") ? "VISUAL_ACKNOWLEDGEMENT_REQUIRED"
          : message.includes("live claim") ? "RUN_CLAIMED"
          : "RUN_CONFLICT";
        throw new RunServiceError(code, message, code === "RUN_NOT_FOUND" ? 404 : 409);
      }
      throw error;
    }
  }

  async #toDto(run: PublicRun): Promise<RunDto> {
    const repository = this.dependencies.repository;
    const history = repository.timeline(run.id);
    const attempts: AttemptDto[] = history.attempts.map((attempt) => ({
      id: attempt.id,
      stage: STAGE_TO_PUBLIC[attempt.stage],
      revision: attempt.revision,
      attempt: attempt.attemptNo,
      state: attempt.status === "cancel_requested" ? "running" : attempt.status,
      toolCalls: attempt.toolCount,
      compileCalls: attempt.compileCount,
      startedAt: attempt.startedAt,
      ...(attempt.finishedAt !== null ? { finishedAt: attempt.finishedAt } : {}),
      ...(attempt.status === "succeeded" || attempt.status === "failed" || attempt.status === "cancelled" ? { outcome: attempt.status } : {}),
    }));
    const attemptById = new Map(history.attempts.map((attempt) => [attempt.id, attempt.attemptNo]));
    const artifactsRetained = repository.areRunArtifactsRetained(run.id);
    const visibleArtifacts = artifactsRetained && (run.status === "review" || run.status === "approved")
      ? repository.listResolvedArtifacts(run.id).map((artifact) => artifactDto(run.id, artifact, attemptById)).filter((artifact): artifact is ArtifactDto => artifact !== null)
      : [];
    const pdf = artifactsRetained ? repository.getArtifact(run.id, "compiled-pdf") : null;
    return {
      id: run.id,
      status: run.status,
      applicationStatus: run.applicationStatus,
      ...(run.titleOverride !== undefined ? { titleOverride: run.titleOverride } : {}),
      ...(run.organizationOverride !== undefined ? { organizationOverride: run.organizationOverride } : {}),
      generateKeywordMap: run.generateKeywordMap,
      queueSequence: run.queueSequence,
      revision: run.currentRevision,
      origin: publicOrigin(repository.resolveRevisionOrigin(run.id, run.currentRevision)),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(pdf && (run.status === "review" || run.status === "approved") ? { currentPdfSha256: pdf.sha256 } : {}),
      ...(run.failedStage ? { failureCode: run.failedStage } : {}),
      visualAcknowledgementRequired: run.visualAcknowledgementRequired,
      attempts,
      artifacts: visibleArtifacts,
      timeline: timeline(history.events, run.status),
    };
  }
}
