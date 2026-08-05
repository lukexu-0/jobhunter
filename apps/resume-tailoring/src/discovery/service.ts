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
import {
  classifyDiscoveryRolesWithLuna,
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
  description: JobDescriptionSchema,
  postedAt: z.number().int().nonnegative().max(MAX_DISCOVERY_TIMESTAMP).nullable().optional(),
  requisitionId: z.string().trim().min(1).max(500).optional(),
}).strict();

const ConnectorEnvelopeSchema = z.object({
  items: z.array(z.unknown()).max(100_000),
  completeSnapshot: z.boolean(),
  provenance: z.string().trim().min(1).max(1_000).optional(),
  omittedRecent: z.number().int().nonnegative().max(100_000).default(0),
}).strict();

const ConnectorResultSchema = z.object({
  items: z.array(ConnectorItemSchema).max(100_000)
    .refine(
      (items) => new Set(items.map((item) => item.sourceItemId)).size === items.length,
      "source item ids must be unique",
    ),
  completeSnapshot: z.boolean(),
  provenance: z.string().trim().min(1).max(1_000).optional(),
  omittedRecent: z.number().int().nonnegative().max(100_000),
}).strict();

const DISCOVERY_RECENT_WINDOW_MS = 30 * 86_400_000;

const MAX_SYNC_CONCURRENCY = 4;
const MAX_SYNC_DURATION_MS = 120_000;
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
    omittedRecent: envelope.omittedRecent + omitted,
    ...(provenance === undefined ? {} : { provenance }),
  });
}


const ABORTED = Symbol("discovery operation aborted");

async function abortable<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  activeOperations: Set<Promise<unknown>>,
): Promise<T> {
  signal.throwIfAborted();
  const operationPromise = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return operation();
  });
  activeOperations.add(operationPromise);
  void operationPromise.then(
    () => activeOperations.delete(operationPromise),
    () => activeOperations.delete(operationPromise),
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
  readonly #shutdown = new AbortController();
  readonly #activeConnectorOperations = new Set<Promise<unknown>>();
  #syncing = false;
  #closed = false;
  #activeSync: Promise<DiscoverySyncResponse> | undefined;
  #closePromise: Promise<void> | undefined;
  constructor(private readonly dependencies: DiscoveryServiceDependencies) {
    this.#now = dependencies.now ?? Date.now;
    this.#classifyRoles = dependencies.classifyRoles ?? classifyDiscoveryRolesWithLuna;
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
    signal: AbortSignal,
  ): Promise<readonly ClassifiedDiscoveredJobInput[]> {
    if (items.length === 0) return [];
    const classifications = await this.#classifyRoles(items.map((item) => ({
      id: item.sourceItemId,
      title: item.title,
      company: item.company,
      location: item.location ?? null,
      description: item.description,
    })), signal);
    const rolesById = new Map(classifications.map(({ id, roles }) => [id, roles]));
    if (
      rolesById.size !== items.length
      || items.some((item) => !rolesById.has(item.sourceItemId))
    ) {
      throw new Error("Discovery role classifier must return every source item exactly once");
    }
    return items.map((item) => ({
      ...item,
      roles: rolesById.get(item.sourceItemId)!,
    }));
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
      const connectorSignal = AbortSignal.any([
        signal,
        this.#shutdown.signal,
        AbortSignal.timeout(MAX_SYNC_DURATION_MS),
      ]);
      const budget = new DiscoveryHttpBudget({
        maxRequests: MAX_SYNC_REQUESTS,
        maxBytes: MAX_SYNC_BYTES,
      });
      const recentCutoff = Math.max(0, this.#now() - DISCOVERY_RECENT_WINDOW_MS);
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
            connectorSignal,
            {
              recentCutoff,
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
          this.dependencies.repository.recordSourceFailure(descriptor, outcome.error);
          sources.push({
            sourceId: outcome.connector.id,
            sourceName: outcome.connector.name,
            status: "failed",
            completeSnapshot: false,
            received: 0,
            created: 0,
            updated: 0,
            closed: 0,
            omittedRecent: 0,
            error: publicSourceError(outcome.error),
          });
          continue;
        }
        try {
          const items = await this.#classifyItems(outcome.result.items, cancellationSignal);
          cancellationSignal.throwIfAborted();
          const counts = this.dependencies.repository.reconcileSource({
            ...descriptor,
            items,
            completeSnapshot: outcome.result.completeSnapshot,
            ...(outcome.result.provenance === undefined
              ? {}
              : { provenance: outcome.result.provenance }),
          });
          sources.push({
            sourceId: outcome.connector.id,
            sourceName: outcome.connector.name,
            status: "succeeded",
            completeSnapshot: outcome.result.completeSnapshot,
            omittedRecent: outcome.result.omittedRecent,
            ...counts,
            ...(outcome.result.provenance === undefined
              ? {}
              : { provenance: outcome.result.provenance }),
          });
        } catch (error) {
          cancellationSignal.throwIfAborted();
          this.dependencies.repository.recordSourceFailure(descriptor, error);
          sources.push({
            sourceId: outcome.connector.id,
            sourceName: outcome.connector.name,
            status: "failed",
            completeSnapshot: false,
            received: 0,
            created: 0,
            updated: 0,
            closed: 0,
            omittedRecent: outcome.result.omittedRecent,
            error: publicSourceError(error),
          });
        }
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
          omittedRecent: sources.reduce((total, source) => total + source.omittedRecent, 0),
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
