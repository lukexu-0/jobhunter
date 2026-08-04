import type {
  DiscoveredJobInput,
  DiscoveryConnector,
  DiscoverySyncResult,
} from "../types";
import { SafePublicHttpClient } from "./http";
import {
  canonicalizeJobUrl,
  nonemptyString,
  normalizeSpace,
  parsePostedAt,
  sanitizeDescription,
  stableSourceItemId,
  stringAt,
} from "./normalize";

export interface WorkdayConnectorConfig {
  readonly host: string;
  readonly tenant: string;
  readonly site: string;
  readonly searchText: string;
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly maxJobs?: number | undefined;
}

interface ValidatedWorkdayConfig {
  readonly host: string;
  readonly tenant: string;
  readonly site: string;
  readonly searchText: string;
  readonly id: string;
  readonly name: string;
  readonly maxJobs: number;
}

const INVALID_CONFIG = "Invalid Workday discovery source configuration";
const SOURCE_UNAVAILABLE = "Workday public job source is unavailable";
const DEFAULT_MAX_JOBS = 100;
const MAX_JOBS = 1_000;
const SEARCH_PAGE_SIZE = 20;
const SEARCH_BODY_LIMIT = 512 * 1024;
const DETAIL_BODY_LIMIT = 1024 * 1024;

function unavailable(): Error {
  return new Error(SOURCE_UNAVAILABLE);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  const normalized = nonemptyString(value);
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function validatedSegment(value: unknown): string | undefined {
  const normalized = boundedString(value, 128);
  return normalized && /^[A-Za-z0-9._-]+$/.test(normalized) ? normalized : undefined;
}

function validatedHost(value: unknown): string | undefined {
  const normalized = boundedString(value, 253)?.toLowerCase();
  if (!normalized || /[:/@?#\\]/.test(normalized) || !normalized.endsWith(".myworkdayjobs.com")) return undefined;
  try {
    const url = new URL(`https://${normalized}`);
    return url.hostname === normalized && url.origin === `https://${normalized}`
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

function validateConfig(config: WorkdayConnectorConfig): ValidatedWorkdayConfig {
  const host = validatedHost(config.host);
  const tenant = validatedSegment(config.tenant);
  const site = validatedSegment(config.site);
  const searchText = boundedString(config.searchText, 256);
  const maxJobs = config.maxJobs ?? DEFAULT_MAX_JOBS;
  const id = config.id === undefined ? undefined : boundedString(config.id, 256);
  const name = config.name === undefined ? undefined : boundedString(config.name, 256);
  if (
    !host
    || !tenant
    || !site
    || !searchText
    || !Number.isInteger(maxJobs)
    || maxJobs < 1
    || maxJobs > MAX_JOBS
    || (config.id !== undefined && !id)
    || (config.name !== undefined && !name)
  ) {
    throw new Error(INVALID_CONFIG);
  }
  return {
    host,
    tenant,
    site,
    searchText,
    id: id ?? `workday-${stableSourceItemId(host, tenant, site)}`,
    name: name ?? `${tenant} Workday jobs`,
    maxJobs,
  };
}

function detailEndpoint(apiRoot: URL, externalPath: unknown): URL | undefined {
  const path = boundedString(externalPath, 2_048);
  if (!path || !path.startsWith("/job/") || path.includes("?") || path.includes("#") || path.includes("\\")) {
    return undefined;
  }
  try {
    const endpoint = new URL(`${apiRoot.href}${path}`);
    const expectedPrefix = `${apiRoot.pathname}/job/`;
    if (endpoint.origin !== apiRoot.origin || !endpoint.pathname.startsWith(expectedPrefix)) return undefined;
    return endpoint;
  } catch {
    return undefined;
  }
}

function configuredWorkdayUrl(
  value: string,
  base: string,
  host: string,
): string | undefined {
  const canonical = canonicalizeJobUrl(value, base);
  if (!canonical) return undefined;
  const url = new URL(canonical);
  return url.protocol === "https:" && url.origin === `https://${host}` ? canonical : undefined;
}

function normalizedLocation(
  detail: Readonly<Record<string, unknown>>,
  listing: Readonly<Record<string, unknown>>,
): string | null {
  const location = boundedString(detail.location, 500)
    ?? boundedString(detail.locationsText, 500)
    ?? boundedString(listing.locationsText, 500);
  return location ? normalizeSpace(location) : null;
}

function normalizedRequisitionId(detail: Readonly<Record<string, unknown>>): string | undefined {
  return boundedString(detail.jobReqId ?? detail.jobRequisitionId ?? detail.requisitionId, 256);
}

async function parseDetail(
  detailPayload: unknown,
  listing: Readonly<Record<string, unknown>>,
  config: ValidatedWorkdayConfig,
  externalPath: string,
): Promise<DiscoveredJobInput | undefined> {
  if (!isRecord(detailPayload)) throw unavailable();
  const detail = isRecord(detailPayload.jobPostingInfo) ? detailPayload.jobPostingInfo : undefined;
  if (!detail) return undefined;

  const rawDescription = boundedString(detail.jobDescription ?? detail.description, 100_000);
  const description = rawDescription ? await sanitizeDescription(rawDescription, "html") : undefined;
  const title = boundedString(detail.title, 500) ?? boundedString(listing.title, 500);
  const company = boundedString(detail.company ?? detail.companyName ?? detail.organization, 256) ?? config.tenant;
  const publicDetailUrl = configuredWorkdayUrl(
    stringAt(detail, "externalUrl", "jobPostingUrl", "url") ?? "",
    `https://${config.host}`,
    config.host,
  );
  const applyUrl = configuredWorkdayUrl(
    stringAt(detail, "applyUrl", "externalApplyUrl") ?? publicDetailUrl ?? "",
    publicDetailUrl ?? `https://${config.host}`,
    config.host,
  );
  if (!description || !title || !publicDetailUrl || !applyUrl) return undefined;

  const requisitionId = normalizedRequisitionId(detail);
  const upstreamId = boundedString(detail.id, 256) ?? requisitionId ?? externalPath;
  const postedAt = parsePostedAt(detail.startDate ?? detail.postedOn ?? detail.postedAt ?? listing.postedOn);
  return {
    sourceItemId: stableSourceItemId(config.host, config.tenant, config.site, upstreamId),
    sourceUrl: publicDetailUrl,
    canonicalUrl: publicDetailUrl,
    applyUrl,
    title,
    company,
    location: normalizedLocation(detail, listing),
    description,
    postedAt,
    ...(requisitionId ? { requisitionId } : {}),
  };
}

export function createWorkdayConnector(
  input: WorkdayConnectorConfig,
  client: SafePublicHttpClient = new SafePublicHttpClient(),
): DiscoveryConnector {
  const config = validateConfig(input);
  const apiRoot = new URL(
    `https://${config.host}/wday/cxs/${encodeURIComponent(config.tenant)}/${encodeURIComponent(config.site)}`,
  );
  const searchEndpoint = new URL(`${apiRoot.href}/jobs`);

  return {
    id: config.id,
    name: config.name,
    kind: "workday",
    async sync(signal: AbortSignal, budget): Promise<DiscoverySyncResult> {
      signal.throwIfAborted();
      const syncClient = budget ? client.withBudget(budget) : client;
      try {
        const listings: Array<{
          readonly listing: Readonly<Record<string, unknown>>;
          readonly externalPath: string;
          readonly endpoint: URL;
        }> = [];
        const seenExternalPaths = new Set<string>();
        let total: number | undefined;
        let totalsConsistent = true;
        let fetchedListingCount = 0;
        let omitted = 0;

        for (let page = 0; page < config.maxJobs; page += 1) {
          signal.throwIfAborted();
          const remaining = Math.min(
            config.maxJobs - fetchedListingCount,
            total === undefined ? config.maxJobs : Math.max(0, total - fetchedListingCount),
          );
          if (remaining === 0) break;
          const limit = Math.min(SEARCH_PAGE_SIZE, remaining);
          const searchResponse = await syncClient.post(searchEndpoint, JSON.stringify({
            appliedFacets: {},
            limit,
            offset: fetchedListingCount,
            searchText: config.searchText,
          }), {
            signal,
            allowedHosts: [config.host],
            acceptedMediaTypes: ["application/json"],
            maxBodyBytes: SEARCH_BODY_LIMIT,
            headers: { "content-type": "application/json" },
          });
          if (searchResponse.status < 200 || searchResponse.status >= 300) throw unavailable();
          const searchPayload = searchResponse.json<unknown>();
          if (!isRecord(searchPayload) || !Array.isArray(searchPayload.jobPostings)) throw unavailable();
          const pageTotal = searchPayload.total;
          if (!Number.isInteger(pageTotal) || (pageTotal as number) < 0) throw unavailable();
          if (total === undefined) total = pageTotal as number;
          else if (pageTotal !== total) {
            totalsConsistent = false;
            total = Math.max(total, pageTotal as number);
          }

          const pageListings = searchPayload.jobPostings.slice(0, limit);
          if (pageListings.length === 0) break;
          fetchedListingCount += pageListings.length;
          for (const value of pageListings) {
            if (!isRecord(value)) {
              omitted += 1;
              continue;
            }
            const externalPath = boundedString(value.externalPath, 2_048);
            const endpoint = detailEndpoint(apiRoot, externalPath);
            if (!externalPath || !endpoint) {
              omitted += 1;
              continue;
            }
            if (seenExternalPaths.has(externalPath)) continue;
            seenExternalPaths.add(externalPath);
            listings.push({ listing: value, externalPath, endpoint });
          }
        }

        const items: DiscoveredJobInput[] = [];
        for (const { listing, externalPath, endpoint } of listings) {
          signal.throwIfAborted();
          const response = await syncClient.get(endpoint, {
            signal,
            allowedHosts: [config.host],
            acceptedMediaTypes: ["application/json"],
            maxBodyBytes: DETAIL_BODY_LIMIT,
          });
          if (response.status < 200 || response.status >= 300) throw unavailable();
          const item = await parseDetail(response.json<unknown>(), listing, config, externalPath);
          if (item) items.push(item);
          else omitted += 1;
        }
        return {
          items,
          completeSnapshot: totalsConsistent
            && total !== undefined
            && total <= config.maxJobs
            && fetchedListingCount >= total
            && listings.length === total
            && omitted === 0,
          provenance: `Workday ${config.tenant}/${config.site}; omitted unusable jobs: ${omitted}`,
        };
      } catch {
        if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
        throw unavailable();
      }
    },
  };
}
