import { z } from "zod";
import {
  DiscoveryListResponseSchema,
  DiscoveryQueueResponseSchema,
  DiscoverySyncResponseSchema,
  JobDescriptionSchema,
  type DiscoveryListRequest,
  type DiscoveryListResponse,
  type DiscoveryQueueRequest,
  type DiscoveryQueueResponse,
  type DiscoverySourceSyncSummary,
  type DiscoverySyncResponse,
  type RunDto,
} from "../contracts/index.ts";
import { canonicalizePublicHttpUrl } from "../api/job-source.ts";
import { DiscoveryJobQueueConflictError } from "../db/repository.ts";
import {
  DiscoveryRepository,
  type DiscoverySourceDescriptor,
} from "./repository.ts";
import { DiscoveryHttpBudget } from "./connectors/http.ts";
import { DISCOVERY_SYNC_DEADLINE_MS } from "./config.ts";
import {
  classifyDiscoveryRolesWithLuna,
  DISCOVERY_ROLE_BATCH_SIZE,
  DISCOVERY_ROLE_MAX_CONCURRENCY,
  type DiscoveryRoleClassification,
  type DiscoveryRoleClassificationJob,
} from "./role-classifier.ts";
import type {
  ClassifiedDiscoveredJobInput,
  DiscoveryConnector,
  DiscoveryConnectorSyncContext,
  DiscoverySourceKind,
} from "./types.ts";

const PublicDiscoveryUrlSchema = z.string().url().max(2_048).refine((value) => {
  try {
    return canonicalizePublicHttpUrl(value).protocol === "https:";
  } catch {
    return false;
  }
}, "Discovery URL must be a public HTTPS destination");

const MAX_DISCOVERY_TIMESTAMP = 8_640_000_000_000_000;

const ConnectorItemSchema = z.object({
  sourceItemId: z.string().trim().min(1).max(500),
  sourceUrl: PublicDiscoveryUrlSchema,
  canonicalUrl: PublicDiscoveryUrlSchema,
  applyUrl: PublicDiscoveryUrlSchema,
  title: z.string().trim().min(1).max(500),
  company: z.string().trim().min(1).max(500),
  location: z.string().trim().min(1).max(500).nullable().optional(),
  description: JobDescriptionSchema.nullable(),
  postedAt: z.number().int().nonnegative().max(MAX_DISCOVERY_TIMESTAMP).nullable().optional(),
  requisitionId: z.string().trim().min(1).max(500).optional(),
}).strict();

const ConnectorEnvelopeSchema = z.object({
  items: z.array(z.unknown()).max(100_000),
  completeSnapshot: z.boolean(),
  provenance: z.string().trim().min(1).max(1_000).optional(),
  descriptionUnavailable: z.number().int().nonnegative().max(100_000),
}).strict();

const ConnectorResultSchema = z.object({
  items: z.array(ConnectorItemSchema).max(100_000)
    .refine(
      (items) => new Set(items.map((item) => item.sourceItemId)).size === items.length,
      "source item ids must be unique",
    ),
  completeSnapshot: z.boolean(),
  provenance: z.string().trim().min(1).max(1_000).optional(),
  descriptionUnavailable: z.number().int().nonnegative().max(100_000),
}).strict();


const MAX_SYNC_CONCURRENCY = 4;
const MAX_CONFIGURED_SYNC_DEADLINE_MS = 60 * 60_000;
const SYNC_TIMEOUT_MESSAGE = "Discovery synchronization timed out";
const MAX_SYNC_REQUESTS = 2_500;
const MAX_SYNC_BYTES = 256 * 1024 * 1024;
type ConnectorResult = z.infer<typeof ConnectorResultSchema>;
const APPROVED_DISCOVERY_SOURCE_KINDS = {
  simplify: true,
  speedyapply: true,
  zapply: true,
} as const satisfies Readonly<Record<DiscoverySourceKind, true>>;
type ConnectorSyncOutcome =
  | { readonly connector: DiscoveryConnector; readonly result: ConnectorResult }
  | { readonly connector: DiscoveryConnector; readonly error: unknown };
interface ClassifiedItemsResult {
  readonly items: readonly ClassifiedDiscoveredJobInput[];
  readonly error?: unknown;
}
function validatedConnectorResult(value: unknown): ConnectorResult {
  const envelope = ConnectorEnvelopeSchema.parse(value);
  const items: Array<z.infer<typeof ConnectorItemSchema>> = [];
  const sourceItemIds = new Set<string>();
  let omitted = 0;
  for (const candidate of envelope.items) {
    const parsed = ConnectorItemSchema.safeParse(candidate);
    if (!parsed.success || sourceItemIds.has(parsed.data.sourceItemId)) {
      omitted += 1;
      continue;
    }
    sourceItemIds.add(parsed.data.sourceItemId);
    items.push(parsed.data);
  }
  if (envelope.items.length > 0 && items.length === 0) {
    ConnectorResultSchema.parse(envelope);
  }
  const omission = omitted === 0 ? undefined : `service omitted invalid records: ${omitted}`;
  let provenance = envelope.provenance;
  if (omission !== undefined) {
    const availablePrefix = 1_000 - omission.length - 2;
    const prefix = provenance?.slice(0, availablePrefix).trimEnd();
    provenance = prefix ? `${prefix}; ${omission}` : omission;
  }
  return ConnectorResultSchema.parse({
    items,
    completeSnapshot: envelope.completeSnapshot && omitted === 0,
    descriptionUnavailable: items.filter(({ description }) => description === null).length,
    ...(provenance === undefined ? {} : { provenance }),
  });
}


const ABORTED = Symbol("discovery operation aborted");

async function abortable<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  activeOperations?: Set<Promise<unknown>>,
): Promise<T> {
  signal.throwIfAborted();
  const operationPromise = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return operation();
  });
  activeOperations?.add(operationPromise);
  void operationPromise.then(
    () => activeOperations?.delete(operationPromise),
    () => activeOperations?.delete(operationPromise),
  );
  const { promise: aborted, resolve } = Promise.withResolvers<typeof ABORTED>();
  const onAbort = (): void => resolve(ABORTED);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const outcome = await Promise.race([operationPromise, aborted]);
    if (outcome === ABORTED) throw signal.reason;
    return outcome as T;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function synchronizeConnector(
  connector: DiscoveryConnector,
  signal: AbortSignal,
  context: DiscoveryConnectorSyncContext,
  budget: DiscoveryHttpBudget,
  activeOperations: Set<Promise<unknown>>,
): Promise<ConnectorSyncOutcome> {
  try {
    const result = validatedConnectorResult(
      await abortable(() => connector.sync(signal, context, budget), signal, activeOperations),
    );
    return { connector, result };
  } catch (error) {
    return { connector, error };
  }
}

export class DiscoveryServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 409 | 500,
  ) {
    super(message);
    this.name = "DiscoveryServiceError";
  }
}

export interface DiscoveryRunService {
  createRunFromDescription(
    discoveryJobId: string,
    jobUrl: string,
    jobDescription: string,
    generateKeywordMap: boolean,
    skipReview: boolean,
    autoSubmit: boolean,
    signal?: AbortSignal,
  ): Promise<RunDto>;
  kick(): void;
}

export type ClassifyDiscoveryRoles = (
  jobs: readonly DiscoveryRoleClassificationJob[],
  signal?: AbortSignal,
) => Promise<readonly DiscoveryRoleClassification[]>;


export interface DiscoveryServiceDependencies {
  readonly repository: DiscoveryRepository;
  readonly runs: DiscoveryRunService;
  readonly connectors: readonly DiscoveryConnector[];
  readonly now?: () => number;
  readonly classifyRoles?: ClassifyDiscoveryRoles;
  readonly syncDeadlineMs?: number;
}


function publicSourceError(error: unknown): string {
  if (error instanceof z.ZodError) return "Source returned invalid discovery data";
  const message = error instanceof Error ? error.message : "Source synchronization failed";
  return message
    .replace(/https?:\/\/\S+/gi, "[upstream]")
    .replace(
      /\b(token|authorization|cookie|secret|api[-_ ]?key)\b\s*[:=]?\s*\S+/gi,
      "$1=[redacted]",
    )
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500) || "Source synchronization failed";
}

export class DiscoveryService {
  readonly #now: () => number;
  readonly #classifyRoles: ClassifyDiscoveryRoles;
  readonly #syncDeadlineMs: number;
  readonly #shutdown = new AbortController();
  readonly #activeConnectorOperations = new Set<Promise<unknown>>();
  #syncing = false;
  #closed = false;
  #activeSync: Promise<DiscoverySyncResponse> | undefined;
  #closePromise: Promise<void> | undefined;
  constructor(private readonly dependencies: DiscoveryServiceDependencies) {
    this.#now = dependencies.now ?? Date.now;
    this.#classifyRoles = dependencies.classifyRoles ?? classifyDiscoveryRolesWithLuna;
    this.#syncDeadlineMs = dependencies.syncDeadlineMs ?? DISCOVERY_SYNC_DEADLINE_MS;
    if (
      !Number.isSafeInteger(this.#syncDeadlineMs)
      || this.#syncDeadlineMs < 1
      || this.#syncDeadlineMs > MAX_CONFIGURED_SYNC_DEADLINE_MS
    ) {
      throw new Error("discovery synchronization deadline must be an integer from 1 to 3600000 milliseconds");
    }
    if (dependencies.connectors.length > 100) {
      throw new Error("at most 100 discovery connectors may be configured");
    }
    for (const connector of dependencies.connectors) {
      if (!Object.hasOwn(APPROVED_DISCOVERY_SOURCE_KINDS, connector.kind)) {
        throw new Error(`unsupported discovery connector kind: ${connector.kind}`);
      }
    }
    const ids = dependencies.connectors.map((connector) => connector.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error("discovery connector ids must be unique");
    }
  }

  list(options: DiscoveryListRequest): DiscoveryListResponse {
    return DiscoveryListResponseSchema.parse(this.dependencies.repository.list(options));
  }

  async #classifyItems(
    items: ConnectorResult["items"],
    workSignal: AbortSignal,
    cancellationSignal: AbortSignal,
    deadlineSignal: AbortSignal,
    deadlineError: Error,
  ): Promise<ClassifiedItemsResult> {
    if (items.length === 0) return { items: [] };
    const batches: Array<ConnectorResult["items"]> = [];
    for (let offset = 0; offset < items.length; offset += DISCOVERY_ROLE_BATCH_SIZE) {
      batches.push(items.slice(offset, offset + DISCOVERY_ROLE_BATCH_SIZE));
    }
    const classified = new Array<readonly ClassifiedDiscoveredJobInput[] | undefined>(batches.length);
    const errors = new Array<unknown>(batches.length);
    let nextBatch = 0;
    const worker = async (): Promise<void> => {
      while (nextBatch < batches.length) {
        if (workSignal.aborted) {
          cancellationSignal.throwIfAborted();
          errors[nextBatch] = deadlineError;
          nextBatch = batches.length;
          return;
        }
        const batchIndex = nextBatch;
        nextBatch += 1;
        const batch = batches[batchIndex]!;
        try {
          const classifications = await abortable(
            () => this.#classifyRoles(batch.map((item) => ({
              id: item.sourceItemId,
              title: item.title,
              company: item.company,
              location: item.location ?? null,
              description: item.description,
            })), workSignal),
            workSignal,
          );
          const rolesById = new Map(classifications.map(({ id, roles }) => [id, roles]));
          if (
            classifications.length !== batch.length
            || rolesById.size !== batch.length
            || batch.some((item) => !rolesById.has(item.sourceItemId))
          ) {
            throw new Error("Discovery role classifier must return every source item exactly once");
          }
          classified[batchIndex] = batch.map((item) => ({
            ...item,
            roles: rolesById.get(item.sourceItemId)!,
          }));
        } catch (error) {
          cancellationSignal.throwIfAborted();
          errors[batchIndex] = deadlineSignal.aborted ? deadlineError : error;
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(DISCOVERY_ROLE_MAX_CONCURRENCY, batches.length) },
      worker,
    ));
    const classifiedItems: ClassifiedDiscoveredJobInput[] = [];
    for (const batch of classified) {
      if (batch !== undefined) classifiedItems.push(...batch);
    }
    const error = errors.find((candidate) => candidate !== undefined);
    return {
      items: classifiedItems,
      ...(error === undefined ? {} : { error }),
    };
  }

  sync(signal: AbortSignal): Promise<DiscoverySyncResponse> {
    if (this.#closed) {
      return Promise.reject(this.#shutdown.signal.reason);
    }
    if (this.#syncing) {
      return Promise.reject(new DiscoveryServiceError(
        "DISCOVERY_SYNC_IN_PROGRESS",
        "A discovery synchronization is already running",
        409,
      ));
    }
    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }
    this.#syncing = true;
    const sync = this.#synchronize(signal);
    this.#activeSync = sync;
    return sync;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#shutdown.abort(new DiscoveryServiceError(
      "DISCOVERY_SERVICE_CLOSED",
      "The discovery service is closed",
      409,
    ));
    this.#closePromise = this.#settleForClose(this.#activeSync);
    return this.#closePromise;
  }

  async #settleForClose(activeSync: Promise<DiscoverySyncResponse> | undefined): Promise<void> {
    await activeSync?.then(
      () => undefined,
      () => undefined,
    );
    await Promise.allSettled([...this.#activeConnectorOperations]);
  }

  async #synchronize(signal: AbortSignal): Promise<DiscoverySyncResponse> {
    try {
      signal.throwIfAborted();
      const cancellationSignal = AbortSignal.any([signal, this.#shutdown.signal]);
      const deadlineSignal = AbortSignal.timeout(this.#syncDeadlineMs);
      const deadlineError = new Error(SYNC_TIMEOUT_MESSAGE);
      const workSignal = AbortSignal.any([cancellationSignal, deadlineSignal]);
      const budget = new DiscoveryHttpBudget({
        maxRequests: MAX_SYNC_REQUESTS,
        maxBytes: MAX_SYNC_BYTES,
      });
      const pending: Array<ConnectorSyncOutcome | undefined> =
        new Array(this.dependencies.connectors.length);
      let nextConnector = 0;
      const worker = async (): Promise<void> => {
        while (nextConnector < this.dependencies.connectors.length) {
          const index = nextConnector;
          nextConnector += 1;
          const connector = this.dependencies.connectors[index]!;
          pending[index] = await synchronizeConnector(
            connector,
            workSignal,
            {
              findKnownItems: (candidates) =>
                this.dependencies.repository.findActiveSourceItemKeys(connector.id, candidates),
              loadKnownItems: (candidates) =>
                this.dependencies.repository.loadActiveSourceItems(connector.id, candidates),
            },
            budget,
            this.#activeConnectorOperations,
          );
        }
      };
      await Promise.all(Array.from(
        {
          length: Math.min(MAX_SYNC_CONCURRENCY, this.dependencies.connectors.length),
        },
        worker,
      ));
      cancellationSignal.throwIfAborted();
      const outcomes = pending.map((outcome) => {
        if (outcome === undefined) throw new Error("discovery connector outcome is missing");
        return outcome;
      });
      const sources: DiscoverySourceSyncSummary[] = [];
      for (const outcome of outcomes) {
        const descriptor: DiscoverySourceDescriptor = {
          id: outcome.connector.id,
          name: outcome.connector.name,
          kind: outcome.connector.kind,
        };
        if ("error" in outcome) {
          const sourceError = (
            deadlineSignal.aborted
            && (outcome.error === deadlineSignal.reason || outcome.error === workSignal.reason)
          )
            ? deadlineError
            : outcome.error;
          this.dependencies.repository.recordSourceFailure(descriptor, sourceError);
          sources.push({
            sourceId: outcome.connector.id,
            sourceName: outcome.connector.name,
            status: "failed",
            completeSnapshot: false,
            received: 0,
            created: 0,
            updated: 0,
            closed: 0,
            descriptionUnavailable: 0,
            error: publicSourceError(sourceError),
          });
          continue;
        }
        const classification = await this.#classifyItems(
          outcome.result.items,
          workSignal,
          cancellationSignal,
          deadlineSignal,
          deadlineError,
        );
        cancellationSignal.throwIfAborted();
        const failed = classification.error !== undefined;
        const completeSnapshot = outcome.result.completeSnapshot && !failed;
        const counts = this.dependencies.repository.reconcileSource({
          ...descriptor,
          items: classification.items,
          completeSnapshot,
          ...(outcome.result.provenance === undefined
            ? {}
            : { provenance: outcome.result.provenance }),
          ...(failed ? { failure: classification.error } : {}),
        });
        sources.push({
          sourceId: outcome.connector.id,
          sourceName: outcome.connector.name,
          status: failed ? "failed" : "succeeded",
          completeSnapshot,
          descriptionUnavailable: classification.items.filter(
            ({ description }) => description === null,
          ).length,
          ...counts,
          ...(failed
            ? { error: publicSourceError(classification.error) }
            : outcome.result.provenance === undefined
              ? {}
              : { provenance: outcome.result.provenance }),
        });
      }
      const response: DiscoverySyncResponse = {
        sources,
        totals: {
          sources: sources.length,
          succeeded: sources.filter((source) => source.status === "succeeded").length,
          failed: sources.filter((source) => source.status === "failed").length,
          received: sources.reduce((total, source) => total + source.received, 0),
          created: sources.reduce((total, source) => total + source.created, 0),
          updated: sources.reduce((total, source) => total + source.updated, 0),
          closed: sources.reduce((total, source) => total + source.closed, 0),
          descriptionUnavailable: sources.reduce(
            (total, source) => total + source.descriptionUnavailable,
            0,
          ),
        },
        completedAt: this.#now(),
      };
      return DiscoverySyncResponseSchema.parse(response);
    } finally {
      this.#syncing = false;
      this.#activeSync = undefined;
    }
  }

  async queue(
    request: DiscoveryQueueRequest,
    signal?: AbortSignal,
  ): Promise<DiscoveryQueueResponse> {
    const queued: DiscoveryQueueResponse["queued"] = [];
    const skipped: DiscoveryQueueResponse["skipped"] = [];
    try {
      for (const jobId of request.jobIds) {
        signal?.throwIfAborted();
        const candidate = this.dependencies.repository.getQueueCandidate(jobId);
        if (!candidate) {
          skipped.push({ jobId, reason: "not_found" });
          continue;
        }
        if (candidate.queuedRunId !== undefined) {
          skipped.push({ jobId, reason: "already_queued" });
          continue;
        }
        if (candidate.closed) {
          skipped.push({ jobId, reason: "closed" });
          continue;
        }
        if (candidate.description === null) {
          skipped.push({ jobId, reason: "description_unavailable" });
          continue;
        }
        try {
          const run = await this.dependencies.runs.createRunFromDescription(
            jobId,
            candidate.canonicalUrl,
            candidate.description,
            request.generateKeywordMap,
            request.skipReview,
            request.autoSubmit,
            signal,
          );
          queued.push({ jobId, run });
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof DiscoveryJobQueueConflictError) {
            skipped.push({ jobId, reason: error.reason });
          } else {
            skipped.push({ jobId, reason: "queue_failed" });
          }
        }
      }
    } finally {
      if (queued.length > 0) this.dependencies.runs.kick();
    }
    return DiscoveryQueueResponseSchema.parse({ queued, skipped });
  }
}
