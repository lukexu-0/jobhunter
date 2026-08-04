import type { DiscoveredJobInput, DiscoveryConnector, DiscoverySyncResult } from "../types";
import { PublicHttpError, type PublicHttpResponse, SafePublicHttpClient } from "./http";
import {
  absolutePublicUrl,
  canonicalizeJobUrl,
  nonemptyString,
  normalizeSpace,
  parsePostedAt,
  sanitizeDescription,
  stableSourceItemId,
} from "./normalize";

interface HtmlBoardValueSelector {
  readonly selector: string;
  readonly attribute?: string | undefined;
}

interface HtmlBoardUrlSelector {
  readonly selector: string;
  readonly attribute: string;
}

interface HtmlBoardListSelectors {
  readonly rowSelector: string;
  readonly title: HtmlBoardValueSelector;
  readonly company: HtmlBoardValueSelector;
  readonly detailUrl: HtmlBoardUrlSelector;
  readonly applyUrl: HtmlBoardUrlSelector;
  readonly location?: HtmlBoardValueSelector | undefined;
  readonly date?: HtmlBoardValueSelector | undefined;
  readonly id?: HtmlBoardValueSelector | undefined;
  readonly nextPage?: HtmlBoardUrlSelector | undefined;
}

interface HtmlBoardDetailSelectors {
  readonly descriptionSelector: string;
  readonly location?: HtmlBoardValueSelector | undefined;
  readonly date?: HtmlBoardValueSelector | undefined;
}

export interface HtmlBoardConnectorConfig {
  readonly id: string;
  readonly name: string;
  readonly listUrl: string;
  readonly allowedHosts?: readonly string[] | undefined;
  readonly maxPages: number;
  readonly maxJobs: number;
  readonly list: HtmlBoardListSelectors;
  readonly detail: HtmlBoardDetailSelectors;
}

interface ValidatedHtmlBoardConfig extends HtmlBoardConnectorConfig {
  readonly allowedHosts: readonly string[];
}

interface ParsedListRow {
  readonly title: string | undefined;
  readonly company: string | undefined;
  readonly detailUrl: string | undefined;
  readonly applyUrl: string | undefined;
  readonly location: string | undefined;
  readonly date: string | undefined;
  readonly id: string | undefined;
}

interface ParsedListPage {
  readonly rows: readonly ParsedListRow[];
  readonly truncated: boolean;
  readonly nextPage?: string;
}

type ListFieldName = "title" | "company" | "detailUrl" | "applyUrl" | "location" | "date" | "id";

const CONFIG_ERROR = "Invalid HTML board connector configuration";
const UPSTREAM_ERROR = "HTML board discovery source could not be loaded";
const HOST_ERROR = "HTML board discovery URL host is not allowed";
const MAX_SELECTOR_LENGTH = 256;
const MAX_ATTRIBUTE_LENGTH = 64;
const MAX_PAGES = 100;
const MAX_JOBS = 1_000;
const MAX_REPORTED_OMISSIONS = 999;
const HTML_MEDIA_TYPES = ["text/html", "application/xhtml+xml"] as const;
const RESPONSE_MEDIA_TYPES = [
  ...HTML_MEDIA_TYPES,
  "text/plain",
  "application/json",
  "application/ld+json",
  "application/vnd.api+json",
] as const;
const REMOVED_ELEMENTS_SELECTOR = "script,style,noscript,template,svg,canvas,iframe,object,embed,[hidden],[aria-hidden='true']";
const FORBIDDEN_SELECTOR_TAGS: Readonly<Record<string, true>> = {
  script: true,
  style: true,
  noscript: true,
  template: true,
  svg: true,
  canvas: true,
  iframe: true,
  object: true,
  embed: true,
};
const CONFIG_KEYS = ["id", "name", "listUrl", "allowedHosts", "maxPages", "maxJobs", "list", "detail"] as const;
const LIST_KEYS = ["rowSelector", "title", "company", "detailUrl", "applyUrl", "location", "date", "id", "nextPage"] as const;
const DETAIL_KEYS = ["descriptionSelector", "location", "date"] as const;
const VALUE_KEYS = ["selector", "attribute"] as const;
const URL_KEYS = ["selector", "attribute"] as const;
const COMPOUND_SELECTOR = /^(?:[A-Za-z][A-Za-z0-9-]*)?(?:(?:[.#][A-Za-z_][A-Za-z0-9_-]*)|(?:\[[A-Za-z_][A-Za-z0-9_-]*(?:=(?:"[A-Za-z0-9_.\/:=-]+"|'[A-Za-z0-9_.\/:=-]+'|[A-Za-z0-9_.\/:=-]+))?\]))*$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ATTRIBUTE = /^[a-z][a-z0-9-]*$/;
const SAFE_VALUE_ATTRIBUTES: Readonly<Record<string, true>> = {
  "aria-label": true,
  content: true,
  datetime: true,
  id: true,
  title: true,
  value: true,
};

function failConfig(): never {
  throw new TypeError(CONFIG_ERROR);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) failConfig();
}

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") failConfig();
  const normalized = normalizeSpace(value);
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) failConfig();
  return normalized;
}

function validateSelector(value: unknown): string {
  const selector = requiredString(value, MAX_SELECTOR_LENGTH);
  if (selector.includes(",") || selector.includes("\\") || selector.includes(":")) failConfig();
  const compounds = selector.split(/\s*>\s*|\s+/);
  if (compounds.length === 0 || compounds.some((compound) => !compound || !COMPOUND_SELECTOR.test(compound))) {
    failConfig();
  }
  for (const compound of compounds) {
    const tag = /^[A-Za-z][A-Za-z0-9-]*/.exec(compound)?.[0]?.toLowerCase();
    if (tag && FORBIDDEN_SELECTOR_TAGS[tag]) failConfig();
    for (const match of compound.matchAll(/\[([A-Za-z_][A-Za-z0-9_-]*)/g)) {
      const attribute = match[1]!.toLowerCase();
      if (/^on/.test(attribute) || /^(?:action|background|formaction|poster|src|srcdoc|style)$/.test(attribute)) {
        failConfig();
      }
    }
  }
  return selector;
}

function validateAttribute(value: unknown, url: boolean): string {
  const attribute = requiredString(value, MAX_ATTRIBUTE_LENGTH).toLowerCase();
  if (!ATTRIBUTE.test(attribute)) failConfig();
  const safeDataAttribute = /^data-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(attribute);
  if (url) {
    if (attribute !== "href" && !(safeDataAttribute && /(?:href|url)$/.test(attribute))) failConfig();
  } else if (!SAFE_VALUE_ATTRIBUTES[attribute] && !safeDataAttribute) {
    failConfig();
  }
  return attribute;
}

function validateValueSelector(value: unknown): HtmlBoardValueSelector {
  if (!isPlainRecord(value)) failConfig();
  assertExactKeys(value, VALUE_KEYS);
  if (!("selector" in value)) failConfig();
  const selector = validateSelector(value.selector);
  return value.attribute === undefined
    ? { selector }
    : { selector, attribute: validateAttribute(value.attribute, false) };
}

function validateUrlSelector(value: unknown): HtmlBoardUrlSelector {
  if (!isPlainRecord(value)) failConfig();
  assertExactKeys(value, URL_KEYS);
  if (!("selector" in value) || !("attribute" in value)) failConfig();
  return {
    selector: validateSelector(value.selector),
    attribute: validateAttribute(value.attribute, true),
  };
}

function validateHostname(value: unknown): string {
  const hostname = requiredString(value, 253).toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME.test(hostname) || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    failConfig();
  }
  return hostname;
}

function validateConfig(config: HtmlBoardConnectorConfig): ValidatedHtmlBoardConfig {
  if (!isPlainRecord(config)) failConfig();
  assertExactKeys(config, CONFIG_KEYS);
  const id = requiredString(config.id, 100);
  const name = requiredString(config.name, 200);
  const listUrl = absolutePublicUrl(requiredString(config.listUrl, 2_048));
  if (!listUrl) failConfig();
  const listUrlObject = new URL(listUrl);
  if (listUrlObject.hash) failConfig();
  if (listUrlObject.port !== "") failConfig();
  if (!Number.isInteger(config.maxPages) || config.maxPages < 1 || config.maxPages > MAX_PAGES) failConfig();
  if (!Number.isInteger(config.maxJobs) || config.maxJobs < 1 || config.maxJobs > MAX_JOBS) failConfig();
  if (!isPlainRecord(config.list)) failConfig();
  assertExactKeys(config.list, LIST_KEYS);
  if (!isPlainRecord(config.detail)) failConfig();
  assertExactKeys(config.detail, DETAIL_KEYS);
  if (!("rowSelector" in config.list) || !("title" in config.list) || !("company" in config.list)
    || !("detailUrl" in config.list) || !("applyUrl" in config.list) || !("descriptionSelector" in config.detail)) {
    failConfig();
  }
  if (config.allowedHosts !== undefined && !Array.isArray(config.allowedHosts)) failConfig();
  const allowedHosts = new Set<string>([listUrlObject.hostname.toLowerCase().replace(/\.$/, "")]);
  for (const host of config.allowedHosts ?? []) allowedHosts.add(validateHostname(host));
  return {
    id,
    name,
    listUrl,
    allowedHosts: [...allowedHosts],
    maxPages: config.maxPages,
    maxJobs: config.maxJobs,
    list: {
      rowSelector: validateSelector(config.list.rowSelector),
      title: validateValueSelector(config.list.title),
      company: validateValueSelector(config.list.company),
      detailUrl: validateUrlSelector(config.list.detailUrl),
      applyUrl: validateUrlSelector(config.list.applyUrl),
      ...(config.list.location === undefined ? {} : { location: validateValueSelector(config.list.location) }),
      ...(config.list.date === undefined ? {} : { date: validateValueSelector(config.list.date) }),
      ...(config.list.id === undefined ? {} : { id: validateValueSelector(config.list.id) }),
      ...(config.list.nextPage === undefined ? {} : { nextPage: validateUrlSelector(config.list.nextPage) }),
    },
    detail: {
      descriptionSelector: validateSelector(config.detail.descriptionSelector),
      ...(config.detail.location === undefined ? {} : { location: validateValueSelector(config.detail.location) }),
      ...(config.detail.date === undefined ? {} : { date: validateValueSelector(config.detail.date) }),
    },
  };
}

async function removeUnsafeElements(html: string): Promise<string> {
  return new HTMLRewriter().on(REMOVED_ELEMENTS_SELECTOR, {
    element(element) {
      element.remove();
    },
  }).transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })).text();
}

function selectorValue(captures: readonly { readonly text: string; readonly attributes: Readonly<Record<string, string>> }[], attribute?: string): string | undefined {
  if (captures.length !== 1) return undefined;
  return nonemptyString(attribute === undefined ? captures[0]!.text : captures[0]!.attributes[attribute]);
}
async function captureHtmlElementsAtMost(
  html: string,
  selector: string,
  attributeNames: readonly string[],
  limit: number,
  maxTextChars: number,
): Promise<readonly { readonly text: string; readonly attributes: Readonly<Record<string, string>> }[]> {
  interface ActiveCapture {
    readonly text: string[];
    readonly attributes: Record<string, string>;
    length: number;
    overflow: boolean;
  }
  const output: Array<{ readonly text: string; readonly attributes: Readonly<Record<string, string>> }> = [];
  const active: ActiveCapture[] = [];
  try {
    await new HTMLRewriter().on(selector, {
      element(element) {
        if (output.length + active.length >= limit) return;
        const attributes: Record<string, string> = {};
        for (const name of attributeNames) {
          const value = element.getAttribute(name);
          if (value !== null) attributes[name] = value;
        }
        const capture: ActiveCapture = { text: [], attributes, length: 0, overflow: false };
        active.push(capture);
        element.onEndTag(() => {
          const index = active.lastIndexOf(capture);
          if (index >= 0) active.splice(index, 1);
          output.push({
            text: capture.overflow ? "" : normalizeSpace(capture.text.join("")),
            attributes,
          });
        });
      },
      text(text) {
        for (const capture of active) {
          if (capture.overflow) continue;
          capture.length += text.text.length;
          if (capture.length > maxTextChars) {
            capture.text.length = 0;
            capture.overflow = true;
          } else {
            capture.text.push(text.text);
          }
        }
      },
    }).transform(new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    })).text();
  } catch (error) {
    throw new Error("Invalid configured HTML selector", { cause: error });
  }
  return output;
}


async function parseListPage(
  html: string,
  selectors: HtmlBoardListSelectors,
  maxRows: number,
  listPageUrl: URL,
): Promise<ParsedListPage> {
  const safeHtml = await removeUnsafeElements(html);
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const fieldMarkers = new Map<ListFieldName, string>();
  const fieldCaptureCounts = new Map<ListFieldName, number[]>();
  const activeRows: Array<{ readonly index: number }> = [];
  let ignoredRowDepth = 0;
  let rowMatchCount = 0;
  const fields: ReadonlyArray<readonly [ListFieldName, HtmlBoardValueSelector | HtmlBoardUrlSelector | undefined]> = [
    ["title", selectors.title],
    ["company", selectors.company],
    ["detailUrl", selectors.detailUrl],
    ["applyUrl", selectors.applyUrl],
    ["location", selectors.location],
    ["date", selectors.date],
    ["id", selectors.id],
  ];
  const rewriter = new HTMLRewriter().on(selectors.rowSelector, {
    element(element) {
      if (rowMatchCount >= maxRows) {
        rowMatchCount = maxRows + 1;
        ignoredRowDepth += 1;
        element.onEndTag(() => {
          ignoredRowDepth -= 1;
        });
        return;
      }
      const context = { index: rowMatchCount };
      rowMatchCount += 1;
      activeRows.push(context);
      element.onEndTag(() => {
        const activeIndex = activeRows.lastIndexOf(context);
        if (activeIndex >= 0) activeRows.splice(activeIndex, 1);
      });
    },
  });
  for (const [fieldName, field] of fields) {
    if (!field) continue;
    const marker = `data-jobhunter-${fieldName.toLowerCase()}-${nonce}`;
    fieldMarkers.set(fieldName, marker);
    fieldCaptureCounts.set(fieldName, Array.from({ length: maxRows }, () => 0));
    rewriter.on(`${selectors.rowSelector} ${field.selector}`, {
      element(element) {
        if (ignoredRowDepth > 0) return;
        const rowIndex = activeRows.at(-1)?.index;
        if (rowIndex === undefined) return;
        const counts = fieldCaptureCounts.get(fieldName)!;
        if (counts[rowIndex]! >= 2) return;
        counts[rowIndex] = counts[rowIndex]! + 1;
        element.setAttribute(marker, String(rowIndex));
      },
    });
  }
  const markedHtml = await rewriter.transform(new Response(safeHtml, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })).text();
  const rowCount = Math.min(rowMatchCount, maxRows);
  const rows: Array<Record<ListFieldName, string | undefined>> = Array.from({ length: rowCount }, () => ({
    title: undefined,
    company: undefined,
    detailUrl: undefined,
    applyUrl: undefined,
    location: undefined,
    date: undefined,
    id: undefined,
  }));
  for (const [fieldName, field] of fields) {
    if (!field) continue;
    const marker = fieldMarkers.get(fieldName)!;
    const attributes = field.attribute === undefined ? [marker] : [marker, field.attribute];
    const captures = await captureHtmlElementsAtMost(markedHtml, `[${marker}]`, attributes, rowCount * 2, 2_048);
    const byRow = new Map<number, Array<(typeof captures)[number]>>();
    for (const capture of captures) {
      const rowIndex = Number(capture.attributes[marker]);
      if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= rows.length) continue;
      const existing = byRow.get(rowIndex) ?? [];
      existing.push(capture);
      byRow.set(rowIndex, existing);
    }
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      rows[rowIndex]![fieldName] = selectorValue(byRow.get(rowIndex) ?? [], field.attribute);
    }
  }
  let nextPage: string | undefined;
  let paginationIncomplete = false;
  if (selectors.nextPage) {
    let paginationMarkupPresent = false;
    await new HTMLRewriter().on(selectors.nextPage.selector, {
      element(element) {
        paginationMarkupPresent = true;
        const value = nonemptyString(element.getAttribute(selectors.nextPage!.attribute));
        const resolved = value === undefined ? undefined : absolutePublicUrl(value, listPageUrl);
        if (resolved === undefined) {
          paginationIncomplete = true;
        } else if (nextPage === undefined) {
          nextPage = resolved;
        } else if (nextPage !== resolved) {
          paginationIncomplete = true;
        }
      },
    }).transform(new Response(safeHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    })).text();
    if (paginationMarkupPresent && (nextPage === undefined || paginationIncomplete)) {
      paginationIncomplete = true;
      nextPage = undefined;
    }
  }
  return {
    rows,
    truncated: rowMatchCount > maxRows || paginationIncomplete,
    ...(nextPage === undefined ? {} : { nextPage }),
  };
}

async function parseDetail(html: string, selectors: HtmlBoardDetailSelectors): Promise<{
  readonly description?: string;
  readonly location?: string;
  readonly date?: string;
}> {
  const safeHtml = await removeUnsafeElements(html);
  const descriptionCaptures = await captureHtmlElementsAtMost(safeHtml, selectors.descriptionSelector, [], 2, 50_001);
  const descriptionSource = selectorValue(descriptionCaptures);
  const description = descriptionSource === undefined ? undefined : await sanitizeDescription(descriptionSource, "text");
  let location: string | undefined;
  if (selectors.location) {
    const captures = await captureHtmlElementsAtMost(
      safeHtml,
      selectors.location.selector,
      selectors.location.attribute ? [selectors.location.attribute] : [],
      2,
      2_048,
    );
    location = selectorValue(captures, selectors.location.attribute);
  }
  let date: string | undefined;
  if (selectors.date) {
    const captures = await captureHtmlElementsAtMost(
      safeHtml,
      selectors.date.selector,
      selectors.date.attribute ? [selectors.date.attribute] : [],
      2,
      2_048,
    );
    date = selectorValue(captures, selectors.date.attribute);
  }
  return {
    ...(description === undefined ? {} : { description }),
    ...(location === undefined ? {} : { location }),
    ...(date === undefined ? {} : { date }),
  };
}

function ensureAllowedUrl(value: string, base: string | URL, allowedHosts: readonly string[]): string {
  const absolute = absolutePublicUrl(value, base);
  if (!absolute) throw new Error(HOST_ERROR);
  const url = new URL(absolute);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.port !== "" || !allowedHosts.includes(hostname)) throw new Error(HOST_ERROR);
  return absolute;
}
function isTrustedApplyUrl(
  value: string,
  listPageUrl: URL,
  detailUrl: URL,
  allowedHosts: readonly string[],
): boolean {
  const candidate = new URL(value);
  const hostname = candidate.hostname.toLowerCase().replace(/\.$/, "");
  return candidate.protocol === "https:"
    && (
      candidate.origin === listPageUrl.origin
      || candidate.origin === detailUrl.origin
      || (candidate.port === "" && allowedHosts.includes(hostname))
    );
}


function omissionProvenance(count: number): string | undefined {
  if (count === 0) return undefined;
  const bounded = Math.min(count, MAX_REPORTED_OMISSIONS);
  return `html-board omitted unusable records: ${bounded}${count > MAX_REPORTED_OMISSIONS ? "+" : ""}`;
}

export function createHtmlBoardConnector(
  input: HtmlBoardConnectorConfig,
  client: SafePublicHttpClient = new SafePublicHttpClient(),
): DiscoveryConnector {
  const config = validateConfig(input);

  async function getHtml(
    activeClient: SafePublicHttpClient,
    url: string,
    signal: AbortSignal,
  ): Promise<{ readonly html: string; readonly url: URL }> {
    let response: PublicHttpResponse;
    try {
      response = await activeClient.get(url, {
        signal,
        allowedHosts: config.allowedHosts,
        acceptedMediaTypes: RESPONSE_MEDIA_TYPES,
      });
    } catch (error) {
      if (error instanceof PublicHttpError && error.code === "UNSUPPORTED_MEDIA_TYPE") throw new Error(UPSTREAM_ERROR);
      throw error;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(UPSTREAM_ERROR);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!mediaType || !(HTML_MEDIA_TYPES as readonly string[]).includes(mediaType)) throw new Error(UPSTREAM_ERROR);
    return { html: response.text(), url: response.url };
  }

  return {
    id: config.id,
    name: config.name,
    kind: "job_board",
    async sync(signal: AbortSignal, budget): Promise<DiscoverySyncResult> {
      signal.throwIfAborted();
      const syncClient = budget ? client.withBudget(budget) : client;
      const items: DiscoveredJobInput[] = [];
      const sourceItemIds = new Set<string>();
      const visitedPages = new Set<string>();
      let nextPage: string | undefined = config.listUrl;
      let pagesRead = 0;
      let jobsConsidered = 0;
      let omissions = 0;
      let sawEmptyPage = false;
      let truncated = false;

      while (nextPage !== undefined && pagesRead < config.maxPages && jobsConsidered < config.maxJobs) {
        const pageUrl = ensureAllowedUrl(nextPage, config.listUrl, config.allowedHosts);
        if (visitedPages.has(pageUrl)) {
          truncated = true;
          break;
        }
        visitedPages.add(pageUrl);
        const response = await getHtml(syncClient, pageUrl, signal);
        pagesRead += 1;
        const remainingJobs = config.maxJobs - jobsConsidered;
        const parsed = await parseListPage(response.html, config.list, remainingJobs, response.url);
        if (parsed.rows.length === 0) sawEmptyPage = true;
        if (parsed.truncated) truncated = true;

        for (const row of parsed.rows) {
          signal.throwIfAborted();
          jobsConsidered += 1;
          const title = nonemptyString(row.title);
          const company = nonemptyString(row.company);
          const detailUrl = row.detailUrl === undefined ? undefined : canonicalizeJobUrl(row.detailUrl, response.url);
          const applyUrl = row.applyUrl === undefined ? undefined : canonicalizeJobUrl(row.applyUrl, response.url);
          if (!title || !company || !detailUrl || !applyUrl) {
            omissions += 1;
            continue;
          }
          const allowedDetailUrl = ensureAllowedUrl(detailUrl, response.url, config.allowedHosts);
          const detailResponse = await getHtml(syncClient, allowedDetailUrl, signal);
          if (!isTrustedApplyUrl(applyUrl, response.url, detailResponse.url, config.allowedHosts)) {
            omissions += 1;
            continue;
          }
          const detail = await parseDetail(detailResponse.html, config.detail);
          if (!detail.description) {
            omissions += 1;
            continue;
          }
          const sourceItemId = stableSourceItemId(config.id, row.id ?? detailUrl);
          if (sourceItemIds.has(sourceItemId)) {
            omissions += 1;
            continue;
          }
          sourceItemIds.add(sourceItemId);
          const location = nonemptyString(detail.location ?? row.location);
          const postedAt = parsePostedAt(detail.date ?? row.date);
          const canonicalDetailUrl = canonicalizeJobUrl(detailResponse.url.href) ?? detailUrl;
          items.push({
            sourceItemId,
            sourceUrl: canonicalDetailUrl,
            canonicalUrl: canonicalDetailUrl,
            applyUrl,
            title,
            company,
            description: detail.description,
            ...(location === undefined ? {} : { location }),
            ...(postedAt === null ? {} : { postedAt }),
          });
        }

        if (jobsConsidered >= config.maxJobs) {
          if (parsed.truncated || parsed.nextPage !== undefined) truncated = true;
          nextPage = undefined;
          break;
        }
        if (parsed.nextPage === undefined) {
          nextPage = undefined;
        } else {
          nextPage = ensureAllowedUrl(parsed.nextPage, response.url, config.allowedHosts);
        }
      }
      if (nextPage !== undefined && pagesRead >= config.maxPages) truncated = true;
      const provenance = omissionProvenance(omissions)
        ?? (sawEmptyPage ? "html-board list selector matched no job rows" : undefined);
      return {
        items,
        completeSnapshot: !sawEmptyPage && !truncated && omissions === 0,
        ...(provenance === undefined ? {} : { provenance }),
      };
    },
  };
}
