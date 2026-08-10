import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  DiscoveryRolesSchema,
  JobDescriptionSchema,
  type DiscoveryJob,
  type DiscoveryListRequest,
} from "../contracts/index.ts";
import {
  discoveryDedupeKeys,
  normalizeDiscoveryUrl,
  normalizeRequisitionId,
} from "./normalize.ts";
import type {
  ClassifiedDiscoveredJobInput,
  DiscoveryKnownItem,
  DiscoveryKnownItemKey,
  DiscoveryRole,
  DiscoverySourceKind,
} from "./types.ts";

interface DiscoveryJobRow {
  id: string;
  title: string;
  company: string;
  location: string | null;
  roles: string;
  canonical_url: string;
  apply_url: string;
  description: string | null;
  posted_at: number | null;
  first_seen_at: number;
  last_seen_at: number;
  closed: 0 | 1;
  run_id: string | null;
  source_names: string;
}

interface CandidateRow {
  id: string;
  catalog_source_id: string;
  catalog_source_item_id: string;
  first_seen_at: number;
  run_id: string | null;
}

interface ActiveSourceItemDescriptionRow extends DiscoveryKnownItemKey {
  readonly description: string | null;
}

export interface DiscoverySourceDescriptor {
  readonly id: string;
  readonly name: string;
  readonly kind: DiscoverySourceKind;
}

export interface DiscoverySourceReconcileInput extends DiscoverySourceDescriptor {
  readonly items: readonly ClassifiedDiscoveredJobInput[];
  readonly completeSnapshot: boolean;
  readonly provenance?: string;
}

export interface DiscoverySourceReconcileSummary {
  readonly received: number;
  readonly created: number;
  readonly updated: number;
  readonly closed: number;
}

export interface DiscoveryListResult {
  readonly jobs: readonly DiscoveryJob[];
  readonly total: number;
  readonly lastSyncAt: number | null;
}

export interface DiscoveryQueueCandidate {
  readonly id: string;
  readonly canonicalUrl: string;
  readonly description: string | null;
  readonly closed: boolean;
  readonly queuedRunId?: string;
}

export interface DiscoveryRepositoryOptions {
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

const DAY_MS = 86_400_000;
const MAX_ACTIVE_SOURCE_ITEM_CANDIDATES = 10_000;
const ACTIVE_SOURCE_ITEM_QUERY_BATCH_SIZE = 400;

function descriptionPreview(description: string | null): string | null {
  if (description === null) return null;
  const compact = description.replace(/\s+/g, " ").trim();
  if (compact.length <= 500) return compact;
  let end = 499;
  const previous = compact.charCodeAt(end - 1);
  const next = compact.charCodeAt(end);
  if (
    previous >= 0xD800
    && previous <= 0xDBFF
    && next >= 0xDC00
    && next <= 0xDFFF
  ) end -= 1;
  return `${compact.slice(0, end).trimEnd()}…`;
}

function publicJob(row: DiscoveryJobRow): DiscoveryJob {
  const sourceNames = JSON.parse(row.source_names) as unknown;
  if (!Array.isArray(sourceNames) || sourceNames.some((name) => typeof name !== "string")) {
    throw new Error("discovery source names are corrupt");
  }
  const roles = DiscoveryRolesSchema.parse(JSON.parse(row.roles));
  const status = row.run_id !== null ? "queued" : row.closed === 1 ? "closed" : "open";
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    location: row.location,
    roles,
    canonicalUrl: row.canonical_url,
    applyUrl: row.apply_url,
    descriptionPreview: descriptionPreview(row.description),
    queueable: status === "open" && row.description !== null,
    postedAt: row.posted_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    status,
    sourceNames,
    ...(row.run_id === null ? {} : { queuedRunId: row.run_id }),
  };
}

function safeSourceError(error: unknown): string {
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

export class DiscoveryRepository {
  readonly #now: () => number;
  readonly #idFactory: () => string;

  constructor(
    private readonly database: Database,
    options: DiscoveryRepositoryOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  #immediate<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  #upsertSource(source: DiscoverySourceDescriptor): void {
    this.database.query(`
      INSERT INTO discovery_sources(id, name, kind)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind
    `).run(source.id, source.name, source.kind);
  }

  #replaceJobRoles(jobId: string, rolesInput: readonly DiscoveryRole[]): void {
    const roles = DiscoveryRolesSchema.parse(rolesInput);
    this.database.query("DELETE FROM discovery_job_roles WHERE job_id = ?").run(jobId);
    const insert = this.database.query(
      "INSERT INTO discovery_job_roles(job_id, role) VALUES (?, ?)",
    );
    for (const role of roles) insert.run(jobId, role);
  }

  recordSourceFailure(source: DiscoverySourceDescriptor, error: unknown): void {
    this.#immediate(() => {
      const now = this.#now();
      this.#upsertSource(source);
      this.database.query(`
        UPDATE discovery_sources
        SET last_sync_at = ?, last_sync_status = 'failed', last_error = ?
        WHERE id = ?
      `).run(now, safeSourceError(error), source.id);
    });
  }

  findActiveSourceItemKeys(
    sourceId: string,
    candidates: readonly DiscoveryKnownItemKey[],
  ): readonly DiscoveryKnownItemKey[] {
    if (candidates.length > MAX_ACTIVE_SOURCE_ITEM_CANDIDATES) {
      throw new Error("at most 10000 source items may be resolved at once");
    }
    const found = new Map<string, DiscoveryKnownItemKey>();
    for (
      let offset = 0;
      offset < candidates.length;
      offset += ACTIVE_SOURCE_ITEM_QUERY_BATCH_SIZE
    ) {
      const batch = candidates.slice(offset, offset + ACTIVE_SOURCE_ITEM_QUERY_BATCH_SIZE);
      const sourceItemIds = [...new Set(batch.map(({ sourceItemId }) => sourceItemId))];
      const canonicalUrls = [...new Set(batch.map(({ canonicalUrl }) => canonicalUrl))];
      const sourceItemPlaceholders = sourceItemIds.map(() => "?").join(",");
      const canonicalUrlPlaceholders = canonicalUrls.map(() => "?").join(",");
      const rows = this.database.query<DiscoveryKnownItemKey, string[]>(`
        SELECT observations.source_item_id AS sourceItemId,
               observations.canonical_url AS canonicalUrl
        FROM discovery_observations observations
        WHERE observations.source_id = ? AND observations.active = 1
          AND observations.source_item_id IN (${sourceItemPlaceholders})
        UNION
        SELECT min(observations.source_item_id) AS sourceItemId,
               observations.canonical_url AS canonicalUrl
        FROM discovery_observations observations
        WHERE observations.source_id = ? AND observations.active = 1
          AND observations.canonical_url IN (${canonicalUrlPlaceholders})
        GROUP BY observations.canonical_url
        ORDER BY sourceItemId
      `).all(sourceId, ...sourceItemIds, sourceId, ...canonicalUrls);
      const bySourceItemId = new Map(rows.map((row) => [row.sourceItemId, row] as const));
      const byCanonicalUrl = new Map(rows.map((row) => [row.canonicalUrl, row] as const));
      for (const candidate of batch) {
        const matched = bySourceItemId.get(candidate.sourceItemId)
          ?? byCanonicalUrl.get(candidate.canonicalUrl);
        if (matched !== undefined) found.set(matched.sourceItemId, matched);
      }
    }
    return [...found.values()];
  }

  loadActiveSourceItems(
    sourceId: string,
    candidates: readonly DiscoveryKnownItemKey[],
  ): readonly DiscoveryKnownItem[] {
    if (candidates.length > MAX_ACTIVE_SOURCE_ITEM_CANDIDATES) {
      throw new Error("at most 10000 source items may be resolved at once");
    }
    const found = new Map<string, DiscoveryKnownItem>();
    for (
      let offset = 0;
      offset < candidates.length;
      offset += ACTIVE_SOURCE_ITEM_QUERY_BATCH_SIZE
    ) {
      const sourceItemIds = [...new Set(
        candidates
          .slice(offset, offset + ACTIVE_SOURCE_ITEM_QUERY_BATCH_SIZE)
          .map(({ sourceItemId }) => sourceItemId),
      )];
      const placeholders = sourceItemIds.map(() => "?").join(",");
      const rows = this.database.query<ActiveSourceItemDescriptionRow, string[]>(`
        SELECT observations.source_item_id AS sourceItemId,
               observations.canonical_url AS canonicalUrl,
               jobs.description
        FROM discovery_observations observations
        JOIN discovery_jobs jobs ON jobs.id = observations.job_id
        WHERE observations.source_id = ? AND observations.active = 1
          AND observations.source_item_id IN (${placeholders})
        ORDER BY observations.source_item_id
      `).all(sourceId, ...sourceItemIds);
      for (const row of rows) {
        found.set(row.sourceItemId, {
          ...row,
          description: JobDescriptionSchema.nullable().parse(row.description),
        });
      }
    }
    return [...found.values()];
  }

  #candidateRows(sourceId: string, sourceItemId: string, keys: readonly string[]): CandidateRow[] {
    const byObservation = this.database.query<CandidateRow, [string, string]>(`
      SELECT jobs.id, jobs.catalog_source_id, jobs.catalog_source_item_id,
             jobs.first_seen_at, links.run_id
      FROM discovery_observations observations
      JOIN discovery_jobs jobs ON jobs.id = observations.job_id
      LEFT JOIN discovery_run_links links ON links.job_id = jobs.id
      WHERE observations.source_id = ? AND observations.source_item_id = ?
    `).get(sourceId, sourceItemId);
    const candidates = new Map<string, CandidateRow>();
    if (byObservation) candidates.set(byObservation.id, byObservation);
    if (keys.length > 0) {
      const placeholders = keys.map(() => "?").join(",");
      const rows = this.database.query<CandidateRow, string[]>(`
        SELECT DISTINCT jobs.id, jobs.catalog_source_id, jobs.catalog_source_item_id,
                        jobs.first_seen_at, links.run_id
        FROM discovery_dedupe_keys keys
        JOIN discovery_observations observations
          ON observations.source_id = keys.source_id
         AND observations.source_item_id = keys.source_item_id
         AND observations.job_id = keys.job_id
        JOIN discovery_jobs jobs ON jobs.id = keys.job_id
        LEFT JOIN discovery_run_links links ON links.job_id = jobs.id
        WHERE observations.active = 1
          AND keys.dedupe_key IN (${placeholders})
      `).all(...keys);
      for (const row of rows) candidates.set(row.id, row);
    }
    return [...candidates.values()].sort((left, right) =>
      Number(right.id === byObservation?.id) - Number(left.id === byObservation?.id)
      || Number(right.run_id !== null) - Number(left.run_id !== null)
      || left.first_seen_at - right.first_seen_at
      || left.id.localeCompare(right.id));
  }

  #mergeJob(canonicalId: string, duplicateId: string): boolean {
    if (canonicalId === duplicateId) return true;
    const canonicalLink = this.database.query<{ run_id: string }, [string]>(
      "SELECT run_id FROM discovery_run_links WHERE job_id = ?",
    ).get(canonicalId);
    const duplicateLink = this.database.query<{ run_id: string }, [string]>(
      "SELECT run_id FROM discovery_run_links WHERE job_id = ?",
    ).get(duplicateId);
    if (canonicalLink && duplicateLink && canonicalLink.run_id !== duplicateLink.run_id) return false;
    if (!canonicalLink && duplicateLink) {
      this.database.query("UPDATE discovery_run_links SET job_id = ? WHERE job_id = ?")
        .run(canonicalId, duplicateId);
    }
    this.database.query(`
      UPDATE discovery_jobs
      SET first_seen_at = min(first_seen_at, (SELECT first_seen_at FROM discovery_jobs WHERE id = ?)),
          last_seen_at = max(last_seen_at, (SELECT last_seen_at FROM discovery_jobs WHERE id = ?)),
          description = CASE
            WHEN coalesce(length(description), -1) >= coalesce((
              SELECT length(description) FROM discovery_jobs WHERE id = ?
            ), -1) THEN description
            ELSE (SELECT description FROM discovery_jobs WHERE id = ?)
          END
      WHERE id = ?
    `).run(duplicateId, duplicateId, duplicateId, duplicateId, canonicalId);
    this.database.query("UPDATE discovery_observations SET job_id = ? WHERE job_id = ?")
      .run(canonicalId, duplicateId);
    this.database.query("UPDATE discovery_dedupe_keys SET job_id = ? WHERE job_id = ?")
      .run(canonicalId, duplicateId);
    this.database.query("DELETE FROM discovery_jobs WHERE id = ?").run(duplicateId);
    return true;
  }

  #refreshClosed(jobIds: readonly string[]): void {
    if (jobIds.length === 0) return;
    const placeholders = jobIds.map(() => "?").join(",");
    this.database.query(`
      UPDATE discovery_jobs
      SET closed = NOT EXISTS (
        SELECT 1 FROM discovery_observations observations
        WHERE observations.job_id = discovery_jobs.id AND observations.active = 1
      )
      WHERE id IN (${placeholders})
    `).run(...jobIds);
  }

  reconcileSource(input: DiscoverySourceReconcileInput): DiscoverySourceReconcileSummary {
    return this.#immediate(() => {
      const now = this.#now();
      this.#upsertSource(input);
      const previouslyOpen = new Set(
        this.database.query<{ job_id: string }, [string]>(`
          SELECT DISTINCT observations.job_id
          FROM discovery_observations observations
          JOIN discovery_jobs jobs ON jobs.id = observations.job_id
          WHERE observations.source_id = ? AND jobs.closed = 0
        `).all(input.id).map((row) => row.job_id),
      );
      const affected = new Set(previouslyOpen);
      if (input.completeSnapshot) {
        this.database.query("UPDATE discovery_observations SET active = 0 WHERE source_id = ?")
          .run(input.id);
      }
      let created = 0;
      const updated = new Set<string>();
      for (const rawItem of input.items) {
        const canonicalUrl = normalizeDiscoveryUrl(rawItem.canonicalUrl);
        const applyUrl = normalizeDiscoveryUrl(rawItem.applyUrl);
        const parsedSourceUrl = new URL(rawItem.sourceUrl);
        if (
          (parsedSourceUrl.protocol !== "http:" && parsedSourceUrl.protocol !== "https:")
          || parsedSourceUrl.username
          || parsedSourceUrl.password
        ) {
          throw new Error("discovery source URL must be HTTP(S) without credentials");
        }
        const sourceUrl = parsedSourceUrl.href;
        const description = JobDescriptionSchema.nullable().parse(rawItem.description);
        const location = rawItem.location?.trim() || null;
        const roles = DiscoveryRolesSchema.parse(rawItem.roles);
        const item = { ...rawItem, canonicalUrl, applyUrl, location };
        const keys = discoveryDedupeKeys(item);
        const candidates = this.#candidateRows(input.id, rawItem.sourceItemId, keys);
        let jobId = candidates[0]?.id;
        if (jobId === undefined) {
          jobId = this.#idFactory();
          this.database.query(`
            INSERT INTO discovery_jobs(
              id, catalog_source_id, catalog_source_item_id,
              title, company, location, canonical_url, apply_url,
              description, posted_at, first_seen_at, last_seen_at, closed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          `).run(
            jobId,
            input.id,
            rawItem.sourceItemId,
            rawItem.title.trim(),
            rawItem.company.trim(),
            location,
            canonicalUrl,
            applyUrl,
            description,
            rawItem.postedAt ?? null,
            now,
            now,
          );
          this.#replaceJobRoles(jobId, roles);
          created += 1;
        } else {
          for (const duplicate of candidates.slice(1)) {
            if (this.#mergeJob(jobId, duplicate.id)) affected.add(duplicate.id);
          }
          this.database.query(`
            UPDATE discovery_jobs
            SET last_seen_at = max(last_seen_at, ?),
                closed = 0,
                description = CASE
                  WHEN ? IS NULL THEN description
                  WHEN description IS NULL OR length(description) <= length(?) THEN ?
                  ELSE description
                END
            WHERE id = ?
          `).run(now, description, description, description, jobId);
          const catalog = candidates[0]!;
          if (
            catalog.catalog_source_id === input.id
            && catalog.catalog_source_item_id === rawItem.sourceItemId
          ) {
            this.database.query(`
              UPDATE discovery_jobs
              SET title = ?, company = ?, location = ?,
                  canonical_url = ?, apply_url = ?,
                  posted_at = CASE
                    WHEN posted_at IS NULL THEN ?
                    WHEN ? IS NULL THEN posted_at
                    ELSE min(posted_at, ?)
                  END
              WHERE id = ?
            `).run(
              rawItem.title.trim(),
              rawItem.company.trim(),
              location,
              canonicalUrl,
              applyUrl,
              rawItem.postedAt ?? null,
              rawItem.postedAt ?? null,
              rawItem.postedAt ?? null,
              jobId,
            );
            this.#replaceJobRoles(jobId, roles);
          }
          updated.add(jobId);
        }
        affected.add(jobId);
        this.database.query(`
          INSERT INTO discovery_observations(
            source_id, source_item_id, job_id, source_url, canonical_url,
            apply_url, requisition_id, active, first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(source_id, source_item_id) DO UPDATE SET
            job_id = excluded.job_id,
            source_url = excluded.source_url,
            canonical_url = excluded.canonical_url,
            apply_url = excluded.apply_url,
            requisition_id = excluded.requisition_id,
            active = 1,
            last_seen_at = excluded.last_seen_at
        `).run(
          input.id,
          rawItem.sourceItemId,
          jobId,
          sourceUrl,
          canonicalUrl,
          applyUrl,
          normalizeRequisitionId(rawItem.requisitionId) ?? null,
          now,
          now,
        );
        this.database.query(`
          DELETE FROM discovery_dedupe_keys
          WHERE source_id = ? AND source_item_id = ?
        `).run(input.id, rawItem.sourceItemId);
        for (const key of keys) {
          this.database.query(`
            INSERT INTO discovery_dedupe_keys(
              source_id, source_item_id, dedupe_key, job_id
            ) VALUES (?, ?, ?, ?)
          `).run(input.id, rawItem.sourceItemId, key, jobId);
        }
      }
      this.#refreshClosed([...affected]);
      const closed = [...previouslyOpen].filter((jobId) =>
        this.database.query<{ closed: number }, [string]>(
          "SELECT closed FROM discovery_jobs WHERE id = ?",
        ).get(jobId)?.closed === 1).length;
      this.database.query(`
        UPDATE discovery_sources
        SET last_sync_at = ?, last_success_at = ?, last_sync_status = 'succeeded',
            last_error = NULL, provenance = ?
        WHERE id = ?
      `).run(now, now, input.provenance ?? null, input.id);
      return { received: input.items.length, created, updated: updated.size, closed };
    });
  }

  list(options: DiscoveryListRequest): DiscoveryListResult {
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.role !== undefined) {
      where.push(`EXISTS (
        SELECT 1
        FROM discovery_job_roles role_filter
        WHERE role_filter.job_id = jobs.id AND role_filter.role = ?
      )`);
      parameters.push(options.role);
    }
    if (options.maxAgeDays !== null) {
      where.push("coalesce(jobs.posted_at, jobs.first_seen_at) >= ?");
      parameters.push(this.#now() - options.maxAgeDays * DAY_MS);
    }
    if (options.status !== "all") {
      if (options.status === "queued") where.push("links.run_id IS NOT NULL");
      if (options.status === "open") where.push("links.run_id IS NULL AND jobs.closed = 0");
      if (options.status === "closed") where.push("links.run_id IS NULL AND jobs.closed = 1");
    }
    if (options.search.length > 0) {
      const escaped = options.search.toLowerCase().replace(/[\\%_]/g, "\\$&");
      where.push(`(
        lower(jobs.title) LIKE ? ESCAPE '\\'
        OR lower(jobs.company) LIKE ? ESCAPE '\\'
        OR lower(coalesce(jobs.location, '')) LIKE ? ESCAPE '\\'
        OR lower(coalesce(jobs.description, '')) LIKE ? ESCAPE '\\'
      )`);
      const pattern = `%${escaped}%`;
      parameters.push(pattern, pattern, pattern, pattern);
    }
    const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const total = this.database.query<{ total: number }, Array<string | number>>(`
      SELECT count(*) AS total
      FROM discovery_jobs jobs
      LEFT JOIN discovery_run_links links ON links.job_id = jobs.id
      ${clause}
    `).get(...parameters)?.total ?? 0;
    const rows = this.database.query<DiscoveryJobRow, Array<string | number>>(`
      SELECT
        jobs.id, jobs.title, jobs.company, jobs.location,
        jobs.canonical_url, jobs.apply_url,
        substr(jobs.description, 1, 501) AS description,
        jobs.posted_at, jobs.first_seen_at, jobs.last_seen_at, jobs.closed,
        links.run_id,
        coalesce((
          SELECT json_group_array(role)
          FROM (
            SELECT job_roles.role
            FROM discovery_job_roles job_roles
            WHERE job_roles.job_id = jobs.id
            ORDER BY CASE job_roles.role
              WHEN 'software_engineering' THEN 0
              WHEN 'machine_learning' THEN 1
              WHEN 'data' THEN 2
              WHEN 'security' THEN 3
              WHEN 'product' THEN 4
              WHEN 'hardware' THEN 5
              WHEN 'other' THEN 6
            END
          )
        ), '[]') AS roles,
        coalesce((
          SELECT json_group_array(source_name)
          FROM (
            SELECT DISTINCT sources.name AS source_name
            FROM discovery_observations observations
            JOIN discovery_sources sources ON sources.id = observations.source_id
            WHERE observations.job_id = jobs.id
            ORDER BY sources.name COLLATE NOCASE, sources.id
            LIMIT 100
          )
        ), '[]') AS source_names
      FROM discovery_jobs jobs
      LEFT JOIN discovery_run_links links ON links.job_id = jobs.id
      ${clause}
      ORDER BY coalesce(jobs.posted_at, jobs.first_seen_at) DESC, jobs.id
      LIMIT ? OFFSET ?
    `).all(...parameters, options.limit, options.offset);
    const lastSyncAt = this.database.query<{ value: number | null }, []>(
      "SELECT max(last_sync_at) AS value FROM discovery_sources",
    ).get()?.value ?? null;
    return { jobs: rows.map(publicJob), total, lastSyncAt };
  }

  getQueueCandidate(jobId: string): DiscoveryQueueCandidate | undefined {
    const row = this.database.query<{
      id: string;
      canonical_url: string;
      description: string | null;
      closed: number;
      run_id: string | null;
    }, [string]>(`
      SELECT jobs.id, jobs.canonical_url, jobs.description, jobs.closed, links.run_id
      FROM discovery_jobs jobs
      LEFT JOIN discovery_run_links links ON links.job_id = jobs.id
      WHERE jobs.id = ?
    `).get(jobId);
    if (!row) return undefined;
    return {
      id: row.id,
      canonicalUrl: row.canonical_url,
      description: row.description,
      closed: row.closed === 1,
      ...(row.run_id === null ? {} : { queuedRunId: row.run_id }),
    };
  }
}
