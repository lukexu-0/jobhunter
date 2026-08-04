import type {
  DiscoveredJobInput,
  DiscoveryConnector,
  DiscoverySyncResult,
} from "../types";
import { SafePublicHttpClient, type PublicHttpResponse } from "./http";
import {
  canonicalizeJobUrl,
  captureHtmlElementsBounded,
  captureJsonLd,
  nonemptyString,
  normalizeSpace,
  parsePostedAt,
  recordAt,
  sanitizeDescription,
  stableSourceItemId,
  stringAt,
  visitJsonObjects,
} from "./normalize";

export interface LinkedInConnectorConfig {
  readonly searchUrls: readonly string[];
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly maxPages?: number | undefined;
  readonly maxJobs?: number | undefined;
}

interface LinkedInCard {
  entityUrn?: string | undefined;
  href?: string | undefined;
  title?: string | undefined;
  company?: string | undefined;
  location?: string | undefined;
  posted?: string | undefined;
}

interface ParsedLinkedInCards {
  readonly cards: readonly LinkedInCard[];
  readonly truncated: boolean;
}

interface LinkedInJobMetadata {
  title?: string | undefined;
  company?: string | undefined;
  location?: string | undefined;
  description?: string | undefined;
  postedAt?: number | null | undefined;
  url?: string | undefined;
  identifier?: string | undefined;
}

interface CapturedLinkedInValue {
  readonly value?: string;
  readonly truncated: boolean;
}

interface ParsedLinkedInDetail {
  readonly metadata: LinkedInJobMetadata;
  readonly truncated: boolean;
}

const LINKEDIN_HOSTS = ["www.linkedin.com", "linkedin.com"] as const;
const DEFAULT_MAX_PAGES = 1;
const DEFAULT_MAX_JOBS = 25;
const MAX_SEARCH_URLS = 10;
const MAX_PAGES = 10;
const MAX_JOBS = 100;
const RESULTS_PER_PAGE = 25;
const SEARCH_BODY_LIMIT = 2 * 1024 * 1024;
const DETAIL_BODY_LIMIT = 1024 * 1024;
const MAX_ACTIVE_CARD_DEPTH = 32;
const MAX_CARD_FIELD_TEXT_LENGTH = 2_048;
const MAX_CARD_FIELD_TEXT_CHUNKS = 128;
const REQUEST_FAILED_MESSAGE = "LinkedIn public discovery request failed";
const BLOCKED_MESSAGE = "LinkedIn public discovery is blocked";
const ACCEPTED_MEDIA_TYPES = ["text/html", "application/xhtml+xml", "text/plain", "application/json", "application/problem+json"] as const;
const BLOCKED_STATUSES: Readonly<Record<number, true>> = { 401: true, 403: true, 429: true, 999: true };
const BLOCKED_MARKUP = /(?:authwall|captcha|checkpoint\/challenge|challenge-page|security verification|id=["'](?:login|captcha)|class=["'][^"']*(?:login(?:__|-)?form|captcha)|<title[^>]*>\s*(?:sign in|linkedin login))/i;

function boundedInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new TypeError(`${name} must be an integer from 1 through ${maximum}`);
  }
  return resolved;
}

function configuredSearchUrls(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_SEARCH_URLS) {
    throw new TypeError(`searchUrls must contain from 1 through ${MAX_SEARCH_URLS} URLs`);
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError("searchUrls must contain public LinkedIn search URLs");
    }
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.port !== ""
      || !LINKEDIN_HOSTS.includes(url.hostname.toLowerCase() as (typeof LINKEDIN_HOSTS)[number])
      || !/^\/jobs\/search\/?$/.test(url.pathname)
    ) {
      throw new TypeError("searchUrls must contain public LinkedIn search URLs");
    }
    url.hash = "";
    const href = url.href;
    if (!seen.has(href)) {
      seen.add(href);
      output.push(href);
    }
  }
  return output;
}

function hasNonDefaultPort(value: string, base?: string | URL): boolean {
  try {
    return new URL(value, base).port !== "";
  } catch {
    return false;
  }
}

function pageUrl(searchUrl: string, page: number): string {
  if (page === 0) return searchUrl;
  const url = new URL(searchUrl);
  const configuredStart = Number(url.searchParams.get("start"));
  const initialStart = Number.isSafeInteger(configuredStart) && configuredStart >= 0 ? configuredStart : 0;
  url.searchParams.set("start", String(initialStart + page * RESULTS_PER_PAGE));
  return url.href;
}

function assertSuccessful(response: PublicHttpResponse): void {
  if (BLOCKED_STATUSES[response.status]) throw new Error(BLOCKED_MESSAGE);
  if (response.status < 200 || response.status >= 300) throw new Error(REQUEST_FAILED_MESSAGE);
}

function responseHtml(response: PublicHttpResponse): string {
  assertSuccessful(response);
  if (/^\/(?:login|authwall|checkpoint)(?:\/|$)/i.test(response.url.pathname)) {
    throw new Error(BLOCKED_MESSAGE);
  }
  const html = response.text();
  if (BLOCKED_MARKUP.test(html)) throw new Error(BLOCKED_MESSAGE);
  return html;
}

async function parseCards(html: string, limit: number): Promise<ParsedLinkedInCards> {
  const cards: LinkedInCard[] = [];
  const activeCards: LinkedInCard[] = [];
  let ignoredCardDepth = 0;
  let acceptedCount = 0;
  let truncated = false;
  const rewriter = new HTMLRewriter();
  rewriter.on(".base-search-card", {
    element(element) {
      if (
        ignoredCardDepth > 0
        || acceptedCount >= limit
        || activeCards.length >= MAX_ACTIVE_CARD_DEPTH
      ) {
        ignoredCardDepth += 1;
        truncated = true;
        element.onEndTag(() => {
          ignoredCardDepth -= 1;
        });
        return;
      }
      const card: LinkedInCard = {};
      const urn = element.getAttribute("data-entity-urn");
      if (urn) {
        if (urn.length <= MAX_CARD_FIELD_TEXT_LENGTH) card.entityUrn = normalizeSpace(urn);
        else truncated = true;
      }
      acceptedCount += 1;
      activeCards.push(card);
      element.onEndTag(() => {
        const index = activeCards.lastIndexOf(card);
        if (index >= 0) activeCards.splice(index, 1);
        cards.push(card);
      });
    },
  });

  const captureText = (
    selector: string,
    key: "title" | "company" | "location" | "posted",
    attribute?: string,
  ) => {
    const activeCaptures: Array<{
      card: LinkedInCard;
      chunks: string[];
      length: number;
    }> = [];
    let capturesStarted = 0;
    rewriter.on(selector, {
      element(element) {
        if (ignoredCardDepth > 0) return;
        const card = activeCards.at(-1);
        if (!card) return;
        if (attribute) {
          const attributeValue = element.getAttribute(attribute);
          if (attributeValue) {
            if (attributeValue.length <= MAX_CARD_FIELD_TEXT_LENGTH) {
              if (!card[key]) card[key] = normalizeSpace(attributeValue);
            } else {
              truncated = true;
            }
          }
        }
        if (
          capturesStarted >= limit
          || activeCaptures.length >= MAX_ACTIVE_CARD_DEPTH
          || activeCaptures.some((capture) => capture.card === card)
        ) {
          truncated = true;
          return;
        }
        capturesStarted += 1;
        const capture = { card, chunks: [] as string[], length: 0 };
        activeCaptures.push(capture);
        element.onEndTag(() => {
          const index = activeCaptures.lastIndexOf(capture);
          if (index >= 0) activeCaptures.splice(index, 1);
          const value = normalizeSpace(capture.chunks.join(""));
          if (value && !card[key]) card[key] = value;
        });
      },
      text(text) {
        for (const capture of activeCaptures) {
          const remaining = MAX_CARD_FIELD_TEXT_LENGTH - capture.length;
          if (remaining <= 0 || capture.chunks.length >= MAX_CARD_FIELD_TEXT_CHUNKS) {
            truncated = true;
            continue;
          }
          const chunk = text.text.length <= remaining ? text.text : text.text.slice(0, remaining);
          if (!chunk) continue;
          capture.chunks.push(chunk);
          capture.length += chunk.length;
          if (chunk.length < text.text.length) truncated = true;
        }
      },
    });
  };

  rewriter.on(".base-card__full-link", {
    element(element) {
      if (ignoredCardDepth > 0) return;
      const card = activeCards.at(-1);
      const href = element.getAttribute("href");
      if (!card || !href || card.href) return;
      if (href.length <= MAX_CARD_FIELD_TEXT_LENGTH) card.href = normalizeSpace(href);
      else truncated = true;
    },
  });
  captureText(".base-search-card__title", "title");
  captureText(".base-search-card__subtitle", "company");
  captureText(".job-search-card__location", "location");
  captureText(".job-search-card__listdate, .job-search-card__listdate--new", "posted", "datetime");

  await rewriter.transform(new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })).text();
  return { cards, truncated };
}

function linkedInJobId(entityUrn: string | undefined, url: string | undefined): string | undefined {
  const urnMatch = entityUrn && /(?:^|:)jobPosting:(\d+)$/i.exec(entityUrn);
  if (urnMatch) return urnMatch[1];
  if (!url) return undefined;
  const pathMatch = /\/jobs\/view\/(?:[^/?#]*-)?(\d+)(?:[/?#]|$)/i.exec(url);
  return pathMatch?.[1];
}

function canonicalLinkedInJobUrl(id: string): string {
  return `https://www.linkedin.com/jobs/view/${id}`;
}

function jobPostingType(value: unknown): boolean {
  if (typeof value === "string") return /(?:^|[/:#])jobposting$/i.test(value);
  return Array.isArray(value) && value.some(jobPostingType);
}

function addressText(value: unknown): string | undefined {
  const locations = Array.isArray(value) ? value : [value];
  for (const location of locations) {
    if (!location || typeof location !== "object" || Array.isArray(location)) continue;
    const locationRecord = location as Readonly<Record<string, unknown>>;
    const address = recordAt(locationRecord, "address") ?? locationRecord;
    const countryRecord = recordAt(address, "addressCountry");
    const country = stringAt(address, "addressCountry") ?? (countryRecord && stringAt(countryRecord, "name"));
    const parts = [
      stringAt(address, "streetAddress"),
      stringAt(address, "addressLocality"),
      stringAt(address, "addressRegion"),
      stringAt(address, "postalCode"),
      country,
    ].filter((part): part is string => Boolean(part));
    if (parts.length) return parts.join(", ");
  }
  return undefined;
}

function identifierText(value: unknown): string | undefined {
  if (typeof value === "string") return nonemptyString(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return stringAt(value as Readonly<Record<string, unknown>>, "value", "name");
}

async function jsonLdJob(html: string): Promise<LinkedInJobMetadata | undefined> {
  const values = await captureJsonLd(html);
  const postings: Readonly<Record<string, unknown>>[] = [];
  for (const value of values) {
    visitJsonObjects(value, (record) => {
      if (jobPostingType(record["@type"])) postings.push(record);
    });
  }
  for (const posting of postings) {
    const descriptionValue = stringAt(posting, "description");
    const description = descriptionValue
      ? await sanitizeDescription(descriptionValue, "html")
      : undefined;
    if (!description) continue;
    const organization = recordAt(posting, "hiringOrganization");
    return {
      title: stringAt(posting, "title", "name"),
      company: organization && stringAt(organization, "name"),
      location: addressText(posting.jobLocation),
      description,
      postedAt: parsePostedAt(posting.datePosted),
      url: stringAt(posting, "url"),
      identifier: identifierText(posting.identifier),
    };
  }
  return undefined;
}

async function firstCapturedText(html: string, selector: string): Promise<CapturedLinkedInValue> {
  const result = await captureHtmlElementsBounded(html, selector);
  const value = result.captures.map((capture) => nonemptyString(capture.text)).find(Boolean);
  return {
    ...(value === undefined ? {} : { value }),
    truncated: result.truncated,
  };
}

async function firstCapturedAttribute(
  html: string,
  selector: string,
  attribute: string,
): Promise<CapturedLinkedInValue> {
  const result = await captureHtmlElementsBounded(html, selector, [attribute]);
  const value = result.captures
    .map((capture) => nonemptyString(capture.attributes[attribute]))
    .find(Boolean);
  return {
    ...(value === undefined ? {} : { value }),
    truncated: result.truncated,
  };
}

async function parseDetail(html: string): Promise<ParsedLinkedInDetail> {
  const [jsonLd, title, company, location, posted, postedText, descriptionCapture, offsiteUrl] = await Promise.all([
    jsonLdJob(html),
    firstCapturedText(html, "h1.top-card-layout__title, h1.topcard__title"),
    firstCapturedText(html, ".topcard__org-name-link, .top-card-layout__card a[data-tracking-control-name='public_jobs_topcard-org-name']"),
    firstCapturedText(html, ".topcard__flavor--bullet"),
    firstCapturedAttribute(html, ".posted-time-ago__text[datetime], .posted-time-ago__text time, .topcard__flavor--metadata time", "datetime"),
    firstCapturedText(html, ".posted-time-ago__text"),
    firstCapturedText(html, ".show-more-less-html__markup, .description__text"),
    firstCapturedAttribute(html, "a[data-tracking-control-name='public_jobs_apply-link-offsite']", "href"),
  ]);
  const description = (
    descriptionCapture.value ? await sanitizeDescription(descriptionCapture.value, "text") : undefined
  ) ?? jsonLd?.description;
  return {
    metadata: {
      title: title.value ?? jsonLd?.title,
      company: company.value ?? jsonLd?.company,
      location: location.value ?? jsonLd?.location,
      description,
      postedAt: parsePostedAt(posted.value ?? postedText.value) ?? jsonLd?.postedAt,
      url: offsiteUrl.value ?? jsonLd?.url,
      identifier: jsonLd?.identifier,
    },
    truncated: [
      title,
      company,
      location,
      posted,
      postedText,
      descriptionCapture,
      offsiteUrl,
    ].some((capture) => capture.truncated),
  };
}

export function createLinkedInConnector(
  config: LinkedInConnectorConfig,
  client: SafePublicHttpClient = new SafePublicHttpClient(),
): DiscoveryConnector {
  const searchUrls = configuredSearchUrls(config.searchUrls);
  const maxPages = boundedInteger(config.maxPages, DEFAULT_MAX_PAGES, MAX_PAGES, "maxPages");
  const maxJobs = boundedInteger(config.maxJobs, DEFAULT_MAX_JOBS, MAX_JOBS, "maxJobs");
  const id = nonemptyString(config.id) ?? "linkedin";
  const name = nonemptyString(config.name) ?? "LinkedIn public jobs";

  return {
    id,
    name,
    kind: "linkedin",
    async sync(signal: AbortSignal, budget): Promise<DiscoverySyncResult> {
      const syncClient = budget ? client.withBudget(budget) : client;
      const candidates: LinkedInCard[] = [];
      const seen = new Set<string>();
      let omitted = 0;
      let searchTruncated = false;
      let stop = false;
      for (const searchUrl of searchUrls) {
        for (let page = 0; page < maxPages && !stop; page += 1) {
          const response = await syncClient.get(pageUrl(searchUrl, page), {
            signal,
            acceptedMediaTypes: ACCEPTED_MEDIA_TYPES,
            allowedHosts: LINKEDIN_HOSTS,
            maxBodyBytes: SEARCH_BODY_LIMIT,
          });
          const remaining = maxJobs - candidates.length;
          const parsed = await parseCards(responseHtml(response), remaining + 1);
          const cards = parsed.cards;
          searchTruncated ||= parsed.truncated;
          for (const card of cards) {
            if (card.href && hasNonDefaultPort(card.href, response.url)) {
              omitted = Math.min(maxJobs, omitted + 1);
              continue;
            }
            const rawUrl = card.href && canonicalizeJobUrl(card.href, response.url);
            if (rawUrl) card.href = rawUrl;
            const jobId = linkedInJobId(card.entityUrn, rawUrl);
            const key = jobId ?? rawUrl;
            if (!key) {
              omitted = Math.min(maxJobs, omitted + 1);
              continue;
            }
            if (seen.has(key)) continue;
            seen.add(key);
            candidates.push(card);
            if (candidates.length >= maxJobs) {
              stop = true;
              break;
            }
          }
          if (cards.length === 0) break;
        }
        if (stop) break;
      }

      const items: DiscoveredJobInput[] = [];
      for (const card of candidates) {
        signal.throwIfAborted();
        const rawCardUrl = card.href && canonicalizeJobUrl(card.href);
        const initialId = linkedInJobId(card.entityUrn, rawCardUrl);
        const detailUrl = initialId ? canonicalLinkedInJobUrl(initialId) : rawCardUrl;
        if (!detailUrl) {
          omitted += 1;
          continue;
        }
        const response = await syncClient.get(detailUrl, {
          signal,
          acceptedMediaTypes: ACCEPTED_MEDIA_TYPES,
          allowedHosts: LINKEDIN_HOSTS,
          maxBodyBytes: DETAIL_BODY_LIMIT,
        });
        const parsedDetail = await parseDetail(responseHtml(response));
        if (parsedDetail.truncated) {
          omitted += 1;
          continue;
        }
        const detail = parsedDetail.metadata;
        if (detail.url && hasNonDefaultPort(detail.url, response.url)) {
          omitted += 1;
          continue;
        }
        const sourceItemId = initialId
          ?? linkedInJobId(undefined, detail.url)
          ?? nonemptyString(detail.identifier)
          ?? stableSourceItemId(detailUrl, detail.title ?? card.title ?? "", detail.company ?? card.company ?? "");
        const stableUrl = /^\d+$/.test(sourceItemId)
          ? canonicalLinkedInJobUrl(sourceItemId)
          : canonicalizeJobUrl(detail.url ?? detailUrl, response.url);
        const title = nonemptyString(detail.title) ?? nonemptyString(card.title);
        const company = nonemptyString(detail.company) ?? nonemptyString(card.company);
        const description = detail.description;
        if (!stableUrl || !title || !company || !description) {
          omitted += 1;
          continue;
        }
        const applyUrl = canonicalizeJobUrl(detail.url ?? stableUrl, response.url) ?? stableUrl;
        items.push({
          sourceItemId,
          sourceUrl: stableUrl,
          canonicalUrl: stableUrl,
          applyUrl,
          title,
          company,
          location: nonemptyString(detail.location) ?? nonemptyString(card.location) ?? null,
          description,
          postedAt: detail.postedAt ?? parsePostedAt(card.posted),
        });
      }
      const provenance = [
        ...(omitted > 0 ? [`linkedin omitted unusable jobs: ${Math.min(omitted, maxJobs)}`] : []),
        ...(searchTruncated ? ["linkedin search page exceeded bounded card cap"] : []),
      ].join("; ");

      return {
        items,
        completeSnapshot: false,
        ...(provenance ? { provenance } : {}),
      };
    },
  };
}
