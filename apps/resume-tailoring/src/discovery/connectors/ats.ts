import type {
  DiscoveredJobInput,
  DiscoveryConnector,
  DiscoverySourceKind,
  DiscoverySyncResult,
} from "../types";
import { SafePublicHttpClient } from "./http";
import {
  canonicalizeJobUrl,
  htmlToText,
  nonemptyString,
  normalizeSpace,
  parsePostedAt,
  recordAt,
  sanitizeDescription,
  stableSourceItemId,
  stringAt,
} from "./normalize";

interface AtsBaseConfig {
  readonly company: string;
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly maxJobs?: number | undefined;
}

export type AtsConnectorConfig =
  | (AtsBaseConfig & { readonly kind: "greenhouse"; readonly boardToken: string })
  | (AtsBaseConfig & { readonly kind: "lever"; readonly site: string })
  | (AtsBaseConfig & { readonly kind: "ashby"; readonly boardName: string })
  | (AtsBaseConfig & { readonly kind: "smartrecruiters"; readonly companyIdentifier: string })
  | (AtsBaseConfig & { readonly kind: "workable"; readonly account: string })
  | (AtsBaseConfig & { readonly kind: "recruitee"; readonly subdomain: string })
  | (AtsBaseConfig & {
    readonly kind: "personio";
    readonly account: string;
    readonly domain?: "de" | "com" | undefined;
    readonly language?: string | undefined;
  });

const CONNECTOR_ERROR_MESSAGE = "The ATS job source is unavailable";
const CONFIG_ERROR_MESSAGE = "Invalid ATS connector configuration";
const DEFAULT_MAX_JOBS = 100;
const MAX_JOBS = 1_000;
const MAX_PERSONIO_CHILD_BLOCKS = 100;
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const JSON_MEDIA_TYPES = ["application/json"] as const;
const XML_MEDIA_TYPES = ["application/xml", "text/xml"] as const;
const GREENHOUSE_JOB_HOSTS = [
  "boards.greenhouse.io",
  "boards.eu.greenhouse.io",
  "job-boards.greenhouse.io",
  "job-boards.eu.greenhouse.io",
] as const;
const LEVER_JOB_HOSTS = ["jobs.lever.co", "jobs.eu.lever.co"] as const;
const ASHBY_JOB_HOSTS = ["jobs.ashbyhq.com"] as const;
const SMARTRECRUITERS_JOB_HOSTS = ["jobs.smartrecruiters.com"] as const;
const WORKABLE_JOB_HOSTS = ["apply.workable.com"] as const;

type JsonRecord = Readonly<Record<string, unknown>>;

interface NormalizedJobFields {
  readonly upstreamId: string;
  readonly sourceUrl: string;
  readonly canonicalUrl?: string | undefined;
  readonly applyUrl?: string | undefined;
  readonly allowedJobHosts: readonly string[];
  readonly title: string;
  readonly company: string;
  readonly location?: string | undefined;
  readonly description: string;
  readonly postedAt?: unknown;
  readonly requisitionId?: string | undefined;
}

class AtsConnectorError extends Error {
  constructor() {
    super(CONNECTOR_ERROR_MESSAGE);
    this.name = "AtsConnectorError";
  }
}

function configError(): never {
  throw new Error(CONFIG_ERROR_MESSAGE);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function primitiveString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return nonemptyString(value);
}

function requiredIdentifier(value: string): string {
  const normalized = normalizeSpace(value);
  if (!IDENTIFIER.test(normalized)) configError();
  return normalized;
}

function maxJobsOf(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_JOBS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_JOBS) configError();
  return value;
}

function identifierOf(config: AtsConnectorConfig): string {
  switch (config.kind) {
    case "greenhouse": return requiredIdentifier(config.boardToken);
    case "lever": return requiredIdentifier(config.site);
    case "ashby": return requiredIdentifier(config.boardName);
    case "smartrecruiters": return requiredIdentifier(config.companyIdentifier);
    case "workable": return requiredIdentifier(config.account);
    case "recruitee": return requiredIdentifier(config.subdomain);
    case "personio": return requiredIdentifier(config.account);
  }
}

function vendorName(kind: AtsConnectorConfig["kind"]): string {
  switch (kind) {
    case "greenhouse": return "Greenhouse";
    case "lever": return "Lever";
    case "ashby": return "Ashby";
    case "smartrecruiters": return "SmartRecruiters";
    case "workable": return "Workable";
    case "recruitee": return "Recruitee";
    case "personio": return "Personio";
  }
}

function recordsAt(payload: unknown, key?: string): readonly unknown[] {
  const value = key === undefined ? payload : asRecord(payload)?.[key];
  if (!Array.isArray(value)) throw new AtsConnectorError();
  return value;
}

function joinedLocation(...values: readonly unknown[]): string | undefined {
  const parts = values.map(nonemptyString).filter((value): value is string => value !== undefined);
  return parts.length > 0 ? [...new Set(parts)].join(", ") : undefined;
}


function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function sanitizedVendorHtml(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  // Greenhouse entity-encodes its HTML, while the other public feeds return HTML.
  const decoded = await htmlToText(value);
  const text = /<\/?(?:article|div|h[1-6]|li|ol|p|section|table|ul)\b/i.test(decoded)
    ? await htmlToText(decoded)
    : decoded;
  return sanitizeDescription(text, "text");
}

async function sanitizedHtmlParts(parts: readonly string[]): Promise<string | undefined> {
  const joined = parts.filter((part) => nonemptyString(part) !== undefined).join("\n");
  return sanitizedVendorHtml(joined || undefined);
}

function canonicalVendorJobUrl(
  value: string,
  allowedHosts: readonly string[],
): string | undefined {
  const canonical = canonicalizeJobUrl(value);
  if (!canonical) return undefined;
  const url = new URL(canonical);
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || !allowedHosts.includes(url.hostname.toLowerCase())
  ) {
    return undefined;
  }
  return canonical;
}

function makeJob(
  kind: DiscoverySourceKind,
  sourceIdentifier: string,
  fields: NormalizedJobFields,
): DiscoveredJobInput | undefined {
  const upstreamId = nonemptyString(fields.upstreamId);
  const title = nonemptyString(fields.title);
  const company = nonemptyString(fields.company);
  const sourceUrl = canonicalVendorJobUrl(fields.sourceUrl, fields.allowedJobHosts);
  const canonicalUrl = canonicalVendorJobUrl(
    fields.canonicalUrl ?? fields.sourceUrl,
    fields.allowedJobHosts,
  );
  const applyUrl = canonicalVendorJobUrl(
    fields.applyUrl ?? fields.canonicalUrl ?? fields.sourceUrl,
    fields.allowedJobHosts,
  );
  if (!upstreamId || !title || !company || !sourceUrl || !canonicalUrl || !applyUrl) return undefined;
  const location = nonemptyString(fields.location);
  const requisitionId = nonemptyString(fields.requisitionId);
  return {
    sourceItemId: stableSourceItemId(kind, sourceIdentifier, upstreamId),
    sourceUrl,
    canonicalUrl,
    applyUrl,
    title,
    company,
    location: location ?? null,
    description: fields.description,
    postedAt: parsePostedAt(fields.postedAt),
    ...(requisitionId ? { requisitionId } : {}),
  };
}

function syncResult(
  items: readonly DiscoveredJobInput[],
  completeSnapshot: boolean,
  omitted: number,
): DiscoverySyncResult {
  return {
    items,
    completeSnapshot,
    provenance: `omitted=${Math.min(MAX_JOBS, Math.max(0, Math.trunc(omitted)))}`,
  };
}

async function jsonGet(
  client: SafePublicHttpClient,
  url: string,
  host: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await client.get(url, {
    signal,
    acceptedMediaTypes: JSON_MEDIA_TYPES,
    allowedHosts: [host],
  });
  if (response.status < 200 || response.status >= 300) throw new AtsConnectorError();
  return response.json();
}

async function xmlGet(
  client: SafePublicHttpClient,
  url: string,
  host: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await client.get(url, {
    signal,
    acceptedMediaTypes: XML_MEDIA_TYPES,
    allowedHosts: [host],
  });
  if (response.status < 200 || response.status >= 300) throw new AtsConnectorError();
  return response.text();
}

async function parseFeed(
  values: readonly unknown[],
  maxJobs: number,
  parse: (value: JsonRecord) => Promise<DiscoveredJobInput | undefined>,
): Promise<DiscoverySyncResult> {
  const items: DiscoveredJobInput[] = [];
  const sourceItemIds = new Set<string>();
  let omitted = 0;
  for (const value of values.slice(0, maxJobs)) {
    const record = asRecord(value);
    const item = record ? await parse(record) : undefined;
    if (item && !sourceItemIds.has(item.sourceItemId)) {
      sourceItemIds.add(item.sourceItemId);
      items.push(item);
    } else {
      omitted += 1;
    }
  }
  return syncResult(items, omitted === 0 && values.length < maxJobs, omitted);
}

async function syncGreenhouse(
  config: Extract<AtsConnectorConfig, { kind: "greenhouse" }>,
  identifier: string,
  maxJobs: number,
  client: SafePublicHttpClient,
  signal: AbortSignal,
): Promise<DiscoverySyncResult> {
  const host = "boards-api.greenhouse.io";
  const boardPath = `/v1/boards/${encodeURIComponent(identifier)}`;
  const payload = await jsonGet(client, `https://${host}${boardPath}/jobs`, host, signal);
  return parseFeed(recordsAt(payload, "jobs"), maxJobs, async (summary) => {
    const upstreamId = primitiveString(summary.id);
    if (!upstreamId) return undefined;
    const job = asRecord(await jsonGet(
      client,
      `https://${host}${boardPath}/jobs/${encodeURIComponent(upstreamId)}`,
      host,
      signal,
    ));
    if (!job) return undefined;
    const description = await sanitizedVendorHtml(stringAt(job, "content"));
    const sourceUrl = stringAt(job, "absolute_url") ?? stringAt(summary, "absolute_url");
    const title = stringAt(job, "title") ?? stringAt(summary, "title");
    if (!description || !sourceUrl || !title) return undefined;
    const location = recordAt(job, "location") ?? recordAt(summary, "location");
    return makeJob(config.kind, identifier, {
      upstreamId,
      sourceUrl,
      allowedJobHosts: GREENHOUSE_JOB_HOSTS,
      title,
      company: stringAt(job, "company_name")
        ?? stringAt(summary, "company_name")
        ?? config.company,
      location: location ? stringAt(location, "name") : undefined,
      description,
      postedAt: job.first_published
        ?? job.updated_at
        ?? summary.first_published
        ?? summary.updated_at,
      requisitionId: primitiveString(
        job.requisition_id
        ?? job.internal_job_id
        ?? summary.requisition_id
        ?? summary.internal_job_id,
      ),
    });
  });
}

async function leverDescription(job: JsonRecord): Promise<string | undefined> {
  const parts: string[] = [];
  const description = stringAt(job, "description", "descriptionBody", "opening");
  if (description) parts.push(description);
  const lists = job.lists;
  if (Array.isArray(lists)) {
    for (const value of lists) {
      const list = asRecord(value);
      if (!list) continue;
      const heading = stringAt(list, "text");
      const content = stringAt(list, "content");
      if (heading) parts.push(`<h2>${escapeHtml(heading)}</h2>`);
      if (content) parts.push(`<ul>${content}</ul>`);
    }
  }
  const additional = stringAt(job, "additional");
  if (additional) parts.push(additional);
  if (parts.length > 0) return sanitizedHtmlParts(parts);
  return sanitizeDescription(stringAt(job, "descriptionPlain", "descriptionBodyPlain", "openingPlain") ?? "", "text");
}

async function syncLever(
  config: Extract<AtsConnectorConfig, { kind: "lever" }>,
  identifier: string,
  maxJobs: number,
  client: SafePublicHttpClient,
  signal: AbortSignal,
): Promise<DiscoverySyncResult> {
  const host = "api.lever.co";
  const payload = await jsonGet(client, `https://${host}/v0/postings/${identifier}?mode=json&limit=${maxJobs}`, host, signal);
  return parseFeed(recordsAt(payload), maxJobs, async (job) => {
    const upstreamId = primitiveString(job.id);
    const description = await leverDescription(job);
    const sourceUrl = stringAt(job, "hostedUrl");
    const title = stringAt(job, "text");
    if (!upstreamId || !description || !sourceUrl || !title) return undefined;
    const categories = recordAt(job, "categories");
    return makeJob(config.kind, identifier, {
      upstreamId,
      sourceUrl,
      applyUrl: stringAt(job, "applyUrl"),
      allowedJobHosts: LEVER_JOB_HOSTS,
      title,
      company: config.company,
      location: categories ? stringAt(categories, "location") : undefined,
      description,
      postedAt: job.createdAt,
      requisitionId: primitiveString(job.requisitionId ?? job.requisition_id),
    });
  });
}

async function syncAshby(
  config: Extract<AtsConnectorConfig, { kind: "ashby" }>,
  identifier: string,
  maxJobs: number,
  client: SafePublicHttpClient,
  signal: AbortSignal,
): Promise<DiscoverySyncResult> {
  const host = "api.ashbyhq.com";
  const payload = await jsonGet(client, `https://${host}/posting-api/job-board/${identifier}?includeCompensation=true`, host, signal);
  return parseFeed(recordsAt(payload, "jobs"), maxJobs, async (job) => {
    const upstreamId = primitiveString(job.id);
    const descriptionHtml = stringAt(job, "descriptionHtml");
    const description = descriptionHtml
      ? await sanitizedVendorHtml(descriptionHtml)
      : await sanitizeDescription(stringAt(job, "descriptionPlain") ?? "", "text");
    const sourceUrl = stringAt(job, "jobUrl");
    const title = stringAt(job, "title");
    if (!upstreamId || !description || !sourceUrl || !title) return undefined;
    return makeJob(config.kind, identifier, {
      upstreamId,
      sourceUrl,
      applyUrl: stringAt(job, "applyUrl"),
      allowedJobHosts: ASHBY_JOB_HOSTS,
      title,
      company: config.company,
      location: stringAt(job, "location"),
      description,
      postedAt: job.publishedAt,
      requisitionId: primitiveString(job.requisitionId ?? job.jobPostingId),
    });
  });
}

function smartRecruitersDescription(detail: JsonRecord): Promise<string | undefined> {
  const sections = recordAt(recordAt(detail, "jobAd") ?? {}, "sections");
  if (!sections) return Promise.resolve(undefined);
  const parts: string[] = [];
  for (const key of ["companyDescription", "jobDescription", "qualifications", "additionalInformation"] as const) {
    const section = recordAt(sections, key);
    const text = section ? stringAt(section, "text") : undefined;
    if (text) parts.push(text);
  }
  return sanitizedHtmlParts(parts);
}

async function syncSmartRecruiters(
  config: Extract<AtsConnectorConfig, { kind: "smartrecruiters" }>,
  identifier: string,
  maxJobs: number,
  client: SafePublicHttpClient,
  signal: AbortSignal,
): Promise<DiscoverySyncResult> {
  const host = "api.smartrecruiters.com";
  const baseUrl = `https://${host}/v1/companies/${identifier}/postings`;
  const payload = await jsonGet(client, `${baseUrl}?limit=${maxJobs}&offset=0`, host, signal);
  const root = asRecord(payload);
  const values = recordsAt(payload, "content");
  const totalFound = typeof root?.totalFound === "number" && Number.isFinite(root.totalFound) && root.totalFound >= 0
    ? Math.trunc(root.totalFound)
    : undefined;
  if (totalFound === undefined) throw new AtsConnectorError();
  const items: DiscoveredJobInput[] = [];
  const sourceItemIds = new Set<string>();
  let omitted = 0;
  for (const value of values.slice(0, maxJobs)) {
    const summary = asRecord(value);
    const upstreamId = summary ? primitiveString(summary.id) : undefined;
    if (!summary || !upstreamId) {
      omitted += 1;
      continue;
    }
    const detailValue = await jsonGet(client, `${baseUrl}/${encodeURIComponent(upstreamId)}`, host, signal);
    const detail = asRecord(detailValue);
    const description = detail ? await smartRecruitersDescription(detail) : undefined;
    const sourceUrl = detail ? stringAt(detail, "postingUrl") : undefined;
    const title = detail ? stringAt(detail, "name") : undefined;
    if (!detail || !description || !sourceUrl || !title) {
      omitted += 1;
      continue;
    }
    const location = recordAt(detail, "location");
    const company = recordAt(detail, "company");
    const item = makeJob(config.kind, identifier, {
      upstreamId,
      sourceUrl,
      applyUrl: stringAt(detail, "applyUrl"),
      allowedJobHosts: SMARTRECRUITERS_JOB_HOSTS,
      title,
      company: (company ? stringAt(company, "name") : undefined) ?? config.company,
      location: location
        ? stringAt(location, "fullLocation") ?? joinedLocation(location.city, location.region, location.country)
        : undefined,
      description,
      postedAt: detail.releasedDate ?? summary.releasedDate,
      requisitionId: primitiveString(detail.refNumber ?? summary.refNumber),
    });
    if (item && !sourceItemIds.has(item.sourceItemId)) {
      sourceItemIds.add(item.sourceItemId);
      items.push(item);
    } else {
      omitted += 1;
    }
  }
  const complete = omitted === 0 && totalFound <= maxJobs && values.length <= maxJobs && values.length >= totalFound;
  return syncResult(items, complete, omitted);
}

async function syncWorkable(
  config: Extract<AtsConnectorConfig, { kind: "workable" }>,
  identifier: string,
  maxJobs: number,
  client: SafePublicHttpClient,
  signal: AbortSignal,
): Promise<DiscoverySyncResult> {
  const host = "apply.workable.com";
  const payload = await jsonGet(client, `https://${host}/api/v1/widget/accounts/${identifier}?details=true`, host, signal);
  const root = asRecord(payload);
  const company = root ? stringAt(root, "name") ?? config.company : config.company;
  const result = await parseFeed(recordsAt(payload, "jobs"), maxJobs, async (job) => {
    const upstreamId = primitiveString(job.shortcode ?? job.id);
    const description = await sanitizedVendorHtml(stringAt(job, "description", "full_description"));
    const sourceUrl = stringAt(job, "url", "shortlink");
    const title = stringAt(job, "title", "full_title");
    if (!upstreamId || !description || !sourceUrl || !title) return undefined;
    const location = joinedLocation(job.city, job.state, job.country)
      ?? (job.telecommuting === true ? "Remote" : undefined);
    return makeJob(config.kind, identifier, {
      upstreamId,
      sourceUrl,
      applyUrl: stringAt(job, "application_url"),
      allowedJobHosts: WORKABLE_JOB_HOSTS,
      title,
      company,
      location,
      description,
      postedAt: job.published_on ?? job.created_at,
      requisitionId: primitiveString(job.code),
    });
  });
  // The public widget feed exposes neither paging metadata nor an exhaustiveness signal.
  return { ...result, completeSnapshot: false };
}

async function syncRecruitee(
  config: Extract<AtsConnectorConfig, { kind: "recruitee" }>,
  identifier: string,
  maxJobs: number,
  client: SafePublicHttpClient,
  signal: AbortSignal,
): Promise<DiscoverySyncResult> {
  const host = `${identifier.toLowerCase()}.recruitee.com`;
  const payload = await jsonGet(client, `https://${host}/api/offers/`, host, signal);
  return parseFeed(recordsAt(payload, "offers"), maxJobs, async (job) => {
    const upstreamId = primitiveString(job.id);
    const parts = [stringAt(job, "description"), stringAt(job, "requirements")]
      .filter((value): value is string => value !== undefined);
    const description = await sanitizedHtmlParts(parts);
    const sourceUrl = stringAt(job, "careers_url");
    const title = stringAt(job, "title");
    if (!upstreamId || !description || !sourceUrl || !title) return undefined;
    const companyRecord = recordAt(job, "company");
    const company = (companyRecord ? stringAt(companyRecord, "name") : undefined)
      ?? stringAt(job, "company_name")
      ?? config.company;
    const location = stringAt(job, "location")
      ?? joinedLocation(job.city, job.state, job.country, job.country_code)
      ?? (job.remote === true ? "Remote" : undefined);
    return makeJob(config.kind, identifier, {
      upstreamId,
      sourceUrl,
      applyUrl: stringAt(job, "careers_apply_url"),
      allowedJobHosts: [host],
      title,
      company,
      location,
      description,
      postedAt: job.published_at ?? job.created_at,
      requisitionId: primitiveString(job.requisition_id),
    });
  });
}

function xmlBlocks(xml: string, tag: string, limit: number): readonly string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = xml.matchAll(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`, "gi"));
  const blocks: string[] = [];
  for (const match of matches) {
    blocks.push(match[1] ?? "");
    if (blocks.length >= limit) break;
  }
  return blocks;
}

function xmlTagCount(xml: string, tag: string, closing = false): number {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = closing
    ? new RegExp(`<\\/${escaped}\\s*>`, "gi")
    : new RegExp(`<${escaped}(?:\\s|>)`, "gi");
  let count = 0;
  for (const _match of xml.matchAll(expression)) count += 1;
  return count;
}

function xmlValue(xml: string, tag: string): string | undefined {
  const value = xmlBlocks(xml, tag, 1)[0]?.trim();
  if (!value) return undefined;
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(value);
  return cdata ? cdata[1] : value;
}

async function xmlText(xml: string, tag: string): Promise<string | undefined> {
  const value = xmlValue(xml, tag);
  if (!value) return undefined;
  const text = await htmlToText(value);
  return nonemptyString(text);
}

async function syncPersonio(
  config: Extract<AtsConnectorConfig, { kind: "personio" }>,
  identifier: string,
  maxJobs: number,
  client: SafePublicHttpClient,
  signal: AbortSignal,
): Promise<DiscoverySyncResult> {
  const domain = config.domain ?? "de";
  const language = config.language === undefined ? "en" : normalizeSpace(config.language);
  if (!LANGUAGE.test(language)) configError();
  const host = `${identifier.toLowerCase()}.jobs.personio.${domain}`;
  const payload = await xmlGet(client, `https://${host}/xml?language=${encodeURIComponent(language)}`, host, signal);
  if (!/<workzag-jobs(?:\s|>)/i.test(payload) || !/<\/workzag-jobs\s*>/i.test(payload)) {
    throw new AtsConnectorError();
  }
  const positionCount = xmlTagCount(payload, "position");
  if (positionCount !== xmlTagCount(payload, "position", true)) throw new AtsConnectorError();
  const values = xmlBlocks(payload, "position", maxJobs + 1);
  if (values.length !== Math.min(positionCount, maxJobs + 1)) throw new AtsConnectorError();
  const items: DiscoveredJobInput[] = [];
  const sourceItemIds = new Set<string>();
  let omitted = 0;
  for (let index = 0; index < Math.min(values.length, maxJobs); index += 1) {
    const position = values[index]!;
    const additionalOfficeBlocks = xmlBlocks(
      xmlValue(position, "additionalOffices") ?? "",
      "office",
      MAX_PERSONIO_CHILD_BLOCKS + 1,
    );
    const jobDescriptionBlocks = xmlBlocks(
      xmlValue(position, "jobDescriptions") ?? "",
      "jobDescription",
      MAX_PERSONIO_CHILD_BLOCKS + 1,
    );
    if (
      additionalOfficeBlocks.length > MAX_PERSONIO_CHILD_BLOCKS
      || jobDescriptionBlocks.length > MAX_PERSONIO_CHILD_BLOCKS
    ) {
      omitted += 1;
      continue;
    }
    const upstreamId = await xmlText(position, "id");
    const title = await xmlText(position, "name");
    const company = await xmlText(position, "subcompany") ?? config.company;
    const office = await xmlText(position, "office");
    const additionalOffices = await Promise.all(
      additionalOfficeBlocks.map(async (value) => nonemptyString(await htmlToText(value))),
    );
    const descriptionParts: string[] = [];
    for (const section of jobDescriptionBlocks) {
      const heading = await xmlText(section, "name");
      const body = xmlValue(section, "value");
      if (heading) descriptionParts.push(`<h2>${escapeHtml(heading)}</h2>`);
      if (body) descriptionParts.push(body);
    }
    const description = await sanitizedHtmlParts(descriptionParts);
    if (!upstreamId || !title || !description) {
      omitted += 1;
      continue;
    }
    const publicUrl = `https://${host}/job/${encodeURIComponent(upstreamId)}?display=${encodeURIComponent(language)}`;
    const item = makeJob(config.kind, identifier, {
      upstreamId,
      sourceUrl: publicUrl,
      allowedJobHosts: [host],
      title,
      company,
      location: joinedLocation(office, ...additionalOffices),
      description,
      postedAt: await xmlText(position, "createdAt"),
      requisitionId: upstreamId,
    });
    if (item && !sourceItemIds.has(item.sourceItemId)) {
      sourceItemIds.add(item.sourceItemId);
      items.push(item);
    } else {
      omitted += 1;
    }
  }
  return syncResult(items, omitted === 0 && values.length < maxJobs, omitted);
}

export function createAtsConnector(
  config: AtsConnectorConfig,
  client: SafePublicHttpClient = new SafePublicHttpClient(),
): DiscoveryConnector {
  const company = normalizeSpace(config.company);
  if (!company) configError();
  const identifier = identifierOf(config);
  const maxJobs = maxJobsOf(config.maxJobs);
  const id = nonemptyString(config.id) ?? `ats:${config.kind}:${identifier.toLowerCase()}`;
  const name = nonemptyString(config.name) ?? `${company} (${vendorName(config.kind)})`;

  return {
    id,
    name,
    kind: config.kind,
    async sync(signal, budget) {
      signal.throwIfAborted();
      const syncClient = budget ? client.withBudget(budget) : client;
      try {
        const normalizedConfig = { ...config, company } as AtsConnectorConfig;
        switch (normalizedConfig.kind) {
          case "greenhouse": return await syncGreenhouse(normalizedConfig, identifier, maxJobs, syncClient, signal);
          case "lever": return await syncLever(normalizedConfig, identifier, maxJobs, syncClient, signal);
          case "ashby": return await syncAshby(normalizedConfig, identifier, maxJobs, syncClient, signal);
          case "smartrecruiters": return await syncSmartRecruiters(normalizedConfig, identifier, maxJobs, syncClient, signal);
          case "workable": return await syncWorkable(normalizedConfig, identifier, maxJobs, syncClient, signal);
          case "recruitee": return await syncRecruitee(normalizedConfig, identifier, maxJobs, syncClient, signal);
          case "personio": return await syncPersonio(normalizedConfig, identifier, maxJobs, syncClient, signal);
        }
        throw new AtsConnectorError();
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
        if (error instanceof AtsConnectorError || error instanceof Error && error.message === CONFIG_ERROR_MESSAGE) throw error;
        throw new AtsConnectorError();
      }
    },
  };
}
