import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  JOB_DESCRIPTION_MAX_CHARS,
  JOB_DESCRIPTION_MIN_CHARS,
  JobDescriptionSchema,
  type OpportunityKind,
} from "../contracts";
import { LUNA_MAX_SOURCE_BYTES, LUNA_MAX_SOURCE_LINES } from "../models/luna-job-extractor";
import { renderJobSourceWithChrome } from "./rendered-job-source";

export type ResolvedAddress = { readonly address: string; readonly family: 4 | 6 };
export type ResolveHost = (hostname: string) => Promise<readonly ResolvedAddress[]>;
export type JobSourceFetch = (input: string | URL, init: BunFetchRequestInit) => Promise<Response>;
export type RenderJobSourceHtml = (url: string, signal: AbortSignal) => Promise<string | undefined>;
export type LoadedJobSource = Readonly<
  | { kind: "description"; opportunityKind: OpportunityKind; jobDescription: string }
  | { kind: "model-fallback"; lines: readonly string[] }
>;
export type LoadJobSource = (
  jobUrl: string,
  signal?: AbortSignal,
  opportunityKindHint?: OpportunityKind,
) => Promise<LoadedJobSource>;
export interface LoadedPublicWebSource {
  readonly url: string;
  readonly mediaType: "html" | "plain";
  readonly body: string;
}

export interface JobSourceLoadOptions {
  readonly fetchImpl?: JobSourceFetch;
  readonly resolveHost?: ResolveHost;
  readonly renderHtml?: RenderJobSourceHtml;
  readonly deadlineMs?: number;
}

export interface PinnedPublicHttpRequest {
  readonly fetchImpl?: JobSourceFetch;
  readonly resolveHost?: ResolveHost;
  readonly signal: AbortSignal;
  readonly beforeFetchAttempt?: () => void;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export type JobSourceErrorCode =
  | "JOB_URL_BLOCKED"
  | "JOB_SOURCE_UNAVAILABLE"
  | "JOB_SOURCE_UNSUPPORTED"
  | "JOB_SOURCE_TOO_LARGE"
  | "JOB_DESCRIPTION_UNAVAILABLE"
  | "JOB_HUMAN_VERIFICATION_REQUIRED";

const ERROR_DETAILS = {
  JOB_URL_BLOCKED: [400, "Opportunity URL must resolve to a public HTTP(S) address"],
  JOB_SOURCE_UNAVAILABLE: [422, "The opportunity page could not be loaded"],
  JOB_SOURCE_UNSUPPORTED: [422, "The opportunity page response is not HTML or plain text"],
  JOB_SOURCE_TOO_LARGE: [413, "The opportunity page is too large to import"],
  JOB_DESCRIPTION_UNAVAILABLE: [422, "The page does not contain a usable opportunity description"],
  JOB_HUMAN_VERIFICATION_REQUIRED: [
    409,
    "Complete this site's human verification in the local browser",
  ],
} as const satisfies Record<JobSourceErrorCode, readonly [400 | 409 | 413 | 422, string]>;

export class JobSourceError extends Error {
  readonly code: JobSourceErrorCode;
  readonly status: 400 | 409 | 413 | 422;

  constructor(code: JobSourceErrorCode, options?: ErrorOptions) {
    const [status, message] = ERROR_DETAILS[code];
    super(message, options);
    this.name = "JobSourceError";
    this.code = code;
    this.status = status;
  }
}

const NETWORK_DEADLINE_MS = 10_000;
const MAX_REDIRECT_HOPS = 5;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const NEVER_ABORTED_SIGNAL = new AbortController().signal;
const REDIRECT_STATUSES: Readonly<Record<number, true>> = {
  301: true,
  302: true,
  303: true,
  307: true,
  308: true,
};
const ACCEPTED_HTML_TYPES: Readonly<Record<string, true>> = {
  "text/html": true,
  "application/xhtml+xml": true,
};
const ACCEPTED_ORACLE_JSON_TYPES: Readonly<Record<string, true>> = {
  "application/json": true,
  "application/vnd.oracle.adf.resourcecollection+json": true,
};
const ORACLE_CANDIDATE_PATH = /^\/hcmUI\/CandidateExperience\/[A-Za-z0-9_-]{1,32}\/sites\/([A-Za-z0-9_-]{1,64})\/job\/([0-9]{1,32})\/?$/;
const JSON_LD_OPPORTUNITY_TYPES: Readonly<Record<string, OpportunityKind>> = {
  JobPosting: "job",
  "http://schema.org/JobPosting": "job",
  "https://schema.org/JobPosting": "job",
  Hackathon: "hackathon",
  "http://schema.org/Hackathon": "hackathon",
  "https://schema.org/Hackathon": "hackathon",
  Competition: "competition",
  "http://schema.org/Competition": "competition",
  "https://schema.org/Competition": "competition",
  Event: "event",
  "http://schema.org/Event": "event",
  "https://schema.org/Event": "event",
};
const BOUNDARY_ELEMENTS = [
  "br", "p", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "section", "div", "article", "main", "tr",
] as const;
const REMOVED_CONTENT_SELECTOR = [
  "script", "style", "noscript", "template", "iframe", "object", "embed", "svg", "canvas",
  "nav", "body > header", "body > footer", "form", "input", "button", "[hidden]", '[aria-hidden="true"]',
].join(", ");

class DeadlineExpired extends Error {}

type ParsedAddress = {
  readonly address: string;
  readonly family: 4 | 6;
  readonly value: bigint;
  readonly bits: 32 | 128;
};

type SpecialPrefix = {
  readonly address: string;
  readonly prefix: number;
  readonly globallyReachable: boolean;
};

// Static snapshot retrieved 2026-07-12 from
// https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv
// A row is allowed only when Globally Reachable is the literal value True;
// blank, False, N/A, and footnoted values are blocked.
const IANA_IPV4_SPECIAL_PREFIXES: readonly SpecialPrefix[] = [
  { address: "0.0.0.0", prefix: 8, globallyReachable: false },
  { address: "0.0.0.0", prefix: 32, globallyReachable: false },
  { address: "10.0.0.0", prefix: 8, globallyReachable: false },
  { address: "100.64.0.0", prefix: 10, globallyReachable: false },
  { address: "127.0.0.0", prefix: 8, globallyReachable: false },
  { address: "169.254.0.0", prefix: 16, globallyReachable: false },
  { address: "172.16.0.0", prefix: 12, globallyReachable: false },
  { address: "192.0.0.0", prefix: 24, globallyReachable: false },
  { address: "192.0.0.0", prefix: 29, globallyReachable: false },
  { address: "192.0.0.8", prefix: 32, globallyReachable: false },
  { address: "192.0.0.9", prefix: 32, globallyReachable: true },
  { address: "192.0.0.10", prefix: 32, globallyReachable: true },
  { address: "192.0.0.170", prefix: 32, globallyReachable: false },
  { address: "192.0.0.171", prefix: 32, globallyReachable: false },
  { address: "192.0.2.0", prefix: 24, globallyReachable: false },
  { address: "192.31.196.0", prefix: 24, globallyReachable: true },
  { address: "192.52.193.0", prefix: 24, globallyReachable: true },
  { address: "192.88.99.0", prefix: 24, globallyReachable: false },
  { address: "192.88.99.2", prefix: 32, globallyReachable: false },
  { address: "192.168.0.0", prefix: 16, globallyReachable: false },
  { address: "192.175.48.0", prefix: 24, globallyReachable: true },
  { address: "198.18.0.0", prefix: 15, globallyReachable: false },
  { address: "198.51.100.0", prefix: 24, globallyReachable: false },
  { address: "203.0.113.0", prefix: 24, globallyReachable: false },
  { address: "240.0.0.0", prefix: 4, globallyReachable: false },
  { address: "255.255.255.255", prefix: 32, globallyReachable: false },
  // Multicast is always blocked independently of the IANA table rows.
  { address: "224.0.0.0", prefix: 4, globallyReachable: false },
];

// Static snapshot retrieved 2026-07-12 from
// https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv
// It uses the same literal-True policy as the IPv4 table.
const IANA_IPV6_SPECIAL_PREFIXES: readonly SpecialPrefix[] = [
  { address: "::1", prefix: 128, globallyReachable: false },
  { address: "::", prefix: 128, globallyReachable: false },
  { address: "::ffff:0:0", prefix: 96, globallyReachable: false },
  { address: "64:ff9b::", prefix: 96, globallyReachable: true },
  { address: "64:ff9b:1::", prefix: 48, globallyReachable: false },
  { address: "100::", prefix: 64, globallyReachable: false },
  { address: "100:0:0:1::", prefix: 64, globallyReachable: false },
  { address: "2001::", prefix: 23, globallyReachable: false },
  { address: "2001::", prefix: 32, globallyReachable: false },
  { address: "2001:1::1", prefix: 128, globallyReachable: true },
  { address: "2001:1::2", prefix: 128, globallyReachable: true },
  { address: "2001:1::3", prefix: 128, globallyReachable: true },
  { address: "2001:2::", prefix: 48, globallyReachable: false },
  { address: "2001:3::", prefix: 32, globallyReachable: true },
  { address: "2001:4:112::", prefix: 48, globallyReachable: true },
  { address: "2001:10::", prefix: 28, globallyReachable: false },
  { address: "2001:20::", prefix: 28, globallyReachable: true },
  { address: "2001:30::", prefix: 28, globallyReachable: true },
  { address: "2001:db8::", prefix: 32, globallyReachable: false },
  { address: "2002::", prefix: 16, globallyReachable: false },
  { address: "2620:4f:8000::", prefix: 48, globallyReachable: true },
  { address: "3fff::", prefix: 20, globallyReachable: false },
  { address: "5f00::", prefix: 16, globallyReachable: false },
  { address: "fc00::", prefix: 7, globallyReachable: false },
  { address: "fe80::", prefix: 10, globallyReachable: false },
  // Multicast is always blocked independently of the IANA table rows.
  { address: "ff00::", prefix: 8, globallyReachable: false },
];

// Deprecated site-local unicast can still route inside legacy networks despite its removal from the IANA registry.
const ADDITIONAL_BLOCKED_IPV6_PREFIXES: readonly SpecialPrefix[] = [
  { address: "fec0::", prefix: 10, globallyReachable: false },
];

// IPv6 fails closed outside allocated global unicast and explicit globally reachable special-purpose ranges.
const ALLOCATED_IPV6_PREFIXES: readonly SpecialPrefix[] = [
  { address: "2000::", prefix: 3, globallyReachable: true },
];

function parseIPv4(input: string): ParsedAddress | undefined {
  if (!input || input.trim() !== input || input.includes(":")) return undefined;
  try {
    const parsed = new URL(`http://${input}/`);
    if (parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return undefined;
    }
    const address = parsed.hostname;
    if (isIP(address) !== 4) return undefined;
    const octets = address.split(".").map(Number);
    const value = octets.reduce((result, octet) => (result << 8n) | BigInt(octet), 0n);
    return { address, family: 4, value, bits: 32 };
  } catch {
    return undefined;
  }
}

function parseIPv6Value(input: string): { value: bigint; hextets: readonly number[] } | undefined {
  if (!input || input.trim() !== input || input.includes("%") || isIP(input) !== 6) return undefined;
  let source = input.toLowerCase();
  const lastColon = source.lastIndexOf(":");
  if (source.includes(".")) {
    const parsedV4 = parseIPv4(source.slice(lastColon + 1));
    if (!parsedV4) return undefined;
    const value = Number(parsedV4.value);
    const high = (value >>> 16) & 0xffff;
    const low = value & 0xffff;
    source = `${source.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }
  const pieces = source.split("::");
  if (pieces.length > 2) return undefined;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) || right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return undefined;
  }
  const omitted = 8 - left.length - right.length;
  if ((pieces.length === 1 && omitted !== 0) || (pieces.length === 2 && omitted < 1)) return undefined;
  const hextets = [...left.map((part) => Number.parseInt(part, 16)), ...Array(omitted).fill(0), ...right.map((part) => Number.parseInt(part, 16))];
  if (hextets.length !== 8) return undefined;
  const value = hextets.reduce((result, hextet) => (result << 16n) | BigInt(hextet), 0n);
  return { value, hextets };
}

function formatIPv6(hextets: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < hextets.length;) {
    if (hextets[index] !== 0) { index += 1; continue; }
    let end = index;
    while (end < hextets.length && hextets[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart === -1) return hextets.map((value) => value.toString(16)).join(":");
  const left = hextets.slice(0, bestStart).map((value) => value.toString(16)).join(":");
  const right = hextets.slice(bestStart + bestLength).map((value) => value.toString(16)).join(":");
  return `${left}::${right}`;
}

function parseIPv6(input: string, unwrapMapped = true): ParsedAddress | undefined {
  const parsed = parseIPv6Value(input);
  if (!parsed) return undefined;
  const mappedPrefix = 0xffffn;
  if (unwrapMapped && (parsed.value >> 32n) === mappedPrefix) {
    const value = parsed.value & 0xffff_ffffn;
    const address = [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join(".");
    return { address, family: 4, value, bits: 32 };
  }
  return { address: formatIPv6(parsed.hextets), family: 6, value: parsed.value, bits: 128 };
}

function parseAddress(input: string, unwrapMapped = true): ParsedAddress | undefined {
  return parseIPv4(input) ?? parseIPv6(input, unwrapMapped);
}

const COMPILED_SPECIAL_PREFIXES = [
  ...IANA_IPV4_SPECIAL_PREFIXES.map((row) => ({ ...row, parsed: parseIPv4(row.address)! })),
  ...IANA_IPV6_SPECIAL_PREFIXES.map((row) => ({ ...row, parsed: parseIPv6(row.address, false)! })),
  ...ADDITIONAL_BLOCKED_IPV6_PREFIXES.map((row) => ({ ...row, parsed: parseIPv6(row.address, false)! })),
  ...ALLOCATED_IPV6_PREFIXES.map((row) => ({ ...row, parsed: parseIPv6(row.address, false)! })),
];

function isPublicAddress(address: ParsedAddress): boolean {
  let candidate = address;
  if (address.family === 6) {
    const unwrapped = parseIPv6(address.address, true);
    if (unwrapped) candidate = unwrapped;
  }
  let best: (typeof COMPILED_SPECIAL_PREFIXES)[number] | undefined;
  for (const row of COMPILED_SPECIAL_PREFIXES) {
    if (row.parsed.family !== candidate.family) continue;
    const shift = BigInt(candidate.bits - row.prefix);
    if ((candidate.value >> shift) !== (row.parsed.value >> shift)) continue;
    if (!best || row.prefix > best.prefix) best = row;
  }
  return best?.globallyReachable ?? candidate.family === 4;
}

function rawHostname(url: URL): string {
  const hostname = url.hostname;
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function assignHostname(url: URL, hostname: string, family?: 4 | 6): void {
  url.hostname = family === 6 || hostname.includes(":") ? `[${hostname}]` : hostname;
}

function canonicalizeLogicalUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new JobSourceError("JOB_URL_BLOCKED");
  if (url.username || url.password) throw new JobSourceError("JOB_URL_BLOCKED");
  url.hash = "";

  let hostname = rawHostname(url).toLowerCase();
  hostname = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new JobSourceError("JOB_URL_BLOCKED");
  }
  const ip = parseAddress(hostname, false);
  if (isIP(hostname) !== 0 && !ip) throw new JobSourceError("JOB_URL_BLOCKED");
  assignHostname(url, ip?.address ?? hostname, ip?.family);
  return url;
}

export function canonicalizePublicHttpUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new JobSourceError("JOB_URL_BLOCKED");
  if (url.username || url.password) throw new JobSourceError("JOB_URL_BLOCKED");
  url.hash = "";

  let hostname = rawHostname(url).toLowerCase();
  hostname = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new JobSourceError("JOB_URL_BLOCKED");
  }
  const ip = parseAddress(hostname, false);
  if (ip && !isPublicAddress(ip)) throw new JobSourceError("JOB_URL_BLOCKED");
  if (isIP(hostname) !== 0 && !ip) throw new JobSourceError("JOB_URL_BLOCKED");
  assignHostname(url, ip?.address ?? hostname, ip?.family);
  return url;
}

async function defaultResolveHost(hostname: string): Promise<readonly ResolvedAddress[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
}

function cancellationReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function hardRace<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const promise = Promise.resolve(work);
  void promise.catch(() => {});
  if (signal.aborted) throw cancellationReason(signal);
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(cancellationReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function cancelPublicHttpBody(response: Response): void {
  if (!response.body) return;
  try {
    const cancellation = response.body.cancel();
    void cancellation.catch(() => {});
  } catch {
    // A locked/already-consumed body has its reader cancelled by readBoundedPublicHttpBody.
  }
}

export async function readBoundedPublicHttpBody(
  response: Response,
  signal: AbortSignal,
  maxBodyBytes = MAX_BODY_BYTES,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await hardRace(reader.read(), signal);
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maxBodyBytes) throw new JobSourceError("JOB_SOURCE_TOO_LARGE");
      chunks.push(item.value);
    }
  } finally {
    try {
      const cancellation = reader.cancel();
      void cancellation.catch(() => {});
    } catch {
      // Cancellation is best-effort cleanup and never changes the public result.
    }
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const HTML_NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  bull: "•",
  cent: "¢",
  copy: "©",
  deg: "°",
  divide: "÷",
  euro: "€",
  gt: ">",
  hellip: "…",
  laquo: "«",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  middot: "·",
  nbsp: "\u00a0",
  ndash: "–",
  plusmn: "±",
  pound: "£",
  quot: "\"",
  raquo: "»",
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  times: "×",
  trade: "™",
  yen: "¥",
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (match, reference: string) => {
    if (!reference.startsWith("#")) return HTML_NAMED_ENTITIES[reference.toLowerCase()] ?? match;
    const hexadecimal = reference[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(reference.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (
      !Number.isInteger(codePoint)
      || codePoint <= 0
      || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return "\uFFFD";
    }
    return String.fromCodePoint(codePoint);
  });
}

export function normalizeJobSourceText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlDocument(fragment: string): string {
  return `<!doctype html><job-source-root>${fragment}</job-source-root>`;
}

async function sanitizeHtml(html: string): Promise<string> {
  const rewriter = new HTMLRewriter().on(REMOVED_CONTENT_SELECTOR, {
    element(element) { element.remove(); },
  });
  for (const tag of BOUNDARY_ELEMENTS) {
    rewriter.on(tag, {
      element(element) {
        if (!element.removed) element.after("\n", { html: false });
      },
    });
  }
  return rewriter.transform(new Response(htmlDocument(html), {
    headers: { "content-type": "text/html; charset=utf-8" },
  })).text();
}

async function captureElements(html: string, selector: string): Promise<string[]> {
  const output: string[] = [];
  let current: string[] | undefined;
  await new HTMLRewriter().on(selector, {
    element(element) {
      current = [];
      element.onEndTag(() => {
        if (current) output.push(current.join(""));
        current = undefined;
      });
    },
    text(text) { current?.push(text.text); },
  }).transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })).text();
  return output.map((value) => normalizeJobSourceText(decodeHtmlEntities(value)));
}

async function captureDocument(html: string): Promise<string> {
  const chunks: string[] = [];
  await new HTMLRewriter().onDocument({
    text(text) { chunks.push(text.text); },
  }).transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })).text();
  return normalizeJobSourceText(decodeHtmlEntities(chunks.join("")));
}

async function normalizeHtmlFragment(fragment: string): Promise<string> {
  const sanitized = await sanitizeHtml(fragment);
  return captureDocument(sanitized);
}

async function isTalHumanVerificationPage(html: string): Promise<boolean> {
  const visibleText = await normalizeHtmlFragment(html);
  return visibleText.includes("Quick Check Needed")
    && visibleText.includes("We just need to confirm you're a real person.");
}

function jsonLdOpportunityKind(value: unknown): OpportunityKind | undefined {
  const values = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  const kinds = new Set(values.map((item) => JSON_LD_OPPORTUNITY_TYPES[item]).filter(
    (item): item is OpportunityKind => item !== undefined,
  ));
  return kinds.size === 1 ? kinds.values().next().value : undefined;
}

interface JsonLdOpportunity {
  readonly opportunityKind: OpportunityKind;
  readonly value: Record<string, unknown>;
}

function visitJson(value: unknown, opportunities: JsonLdOpportunity[]): void {
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, opportunities);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  const opportunityKind = jsonLdOpportunityKind(object["@type"]);
  if (opportunityKind) opportunities.push({ opportunityKind, value: object });
  for (const child of Object.values(object)) visitJson(child, opportunities);
}

async function collectJsonLdScripts(html: string): Promise<string[]> {
  const scripts: string[] = [];
  let current: string[] | undefined;
  await new HTMLRewriter().on("script", {
    element(element) {
      const rawType = element.getAttribute("type") ?? "";
      const type = rawType.split(";", 1)[0]!.trim().toLowerCase();
      if (type !== "application/ld+json") return;
      current = [];
      element.onEndTag(() => {
        if (current) scripts.push(current.join(""));
        current = undefined;
      });
    },
    text(text) { current?.push(text.text); },
  }).transform(new Response(htmlDocument(html), { headers: { "content-type": "text/html; charset=utf-8" } })).text();
  return scripts;
}

async function deterministicHtmlDescription(
  html: string,
  opportunityKindHint?: OpportunityKind,
): Promise<LoadedJobSource | "too-large" | undefined> {
  const opportunities: JsonLdOpportunity[] = [];
  for (const script of await collectJsonLdScripts(html)) {
    try { visitJson(JSON.parse(script), opportunities); } catch { /* Ignore each malformed block independently. */ }
  }
  const candidates = new Map<string, string>();
  for (const { opportunityKind, value } of opportunities) {
    if (typeof value.description !== "string") continue;
    const description = JobDescriptionSchema.safeParse(
      await normalizeHtmlFragment(value.description),
    );
    if (!description.success) continue;

    const organization = value.hiringOrganization ?? value.organizer ?? value.sponsor;
    const values = [
      typeof value.title === "string"
        ? value.title
        : typeof value.name === "string"
          ? value.name
          : undefined,
      typeof organization === "string"
        ? organization
        : organization && typeof organization === "object"
          && typeof (organization as Record<string, unknown>).name === "string"
          ? (organization as Record<string, unknown>).name as string
          : undefined,
    ];
    const normalized: string[] = [];
    for (const source of values) {
      if (source === undefined) continue;
      const text = await normalizeHtmlFragment(source);
      if (text) normalized.push(text);
    }
    normalized.push(description.data);
    const candidate = JobDescriptionSchema.safeParse(normalized.join("\n\n"));
    if (candidate.success) {
      const deduplicationKind = opportunityKindHint ?? opportunityKind;
      candidates.set(`${deduplicationKind}\0${candidate.data}`, candidate.data);
    }
  }
  if (candidates.size !== 1) return undefined;
  const jobDescription = candidates.values().next().value!;
  if (opportunityKindHint === undefined) return buildFallbackCandidate(jobDescription);
  return { kind: "description", opportunityKind: opportunityKindHint, jobDescription };
}

function buildFallbackCandidate(candidate: string): LoadedJobSource | "too-large" | undefined {
  if (candidate.length < JOB_DESCRIPTION_MIN_CHARS) return undefined;
  if (Buffer.byteLength(candidate, "utf8") > LUNA_MAX_SOURCE_BYTES) return "too-large";
  let lineCount = 1;
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate.charCodeAt(index) === 10 && ++lineCount > LUNA_MAX_SOURCE_LINES) return "too-large";
  }
  return { kind: "model-fallback", lines: candidate.split("\n") };
}

async function htmlFallback(html: string): Promise<LoadedJobSource> {
  const sanitized = await sanitizeHtml(html);
  const bodyCandidates = await captureElements(sanitized, "body");
  const completeCandidate = bodyCandidates.length > 0
    ? bodyCandidates[0]!
    : await captureDocument(sanitized);
  const completeResult = buildFallbackCandidate(completeCandidate);
  if (completeResult && completeResult !== "too-large") return completeResult;

  let sawOversized = completeResult === "too-large";
  let longestCandidate: LoadedJobSource | undefined;
  let longestLength = -1;
  for (const candidates of [
    await captureElements(sanitized, "main"),
    await captureElements(sanitized, "article"),
  ]) {
    for (const candidate of candidates) {
      const result = buildFallbackCandidate(candidate);
      if (result === "too-large") {
        sawOversized = true;
      } else if (result && candidate.length > longestLength) {
        longestCandidate = result;
        longestLength = candidate.length;
      }
    }
  }
  if (longestCandidate) return longestCandidate;
  throw new JobSourceError(sawOversized ? "JOB_SOURCE_TOO_LARGE" : "JOB_DESCRIPTION_UNAVAILABLE");
}

interface OracleCandidateSource {
  readonly sourceUrl: URL;
  readonly siteNumber: string;
  readonly requisitionId: string;
}

function oracleCandidateSource(sourceUrl: string): OracleCandidateSource | undefined {
  const url = new URL(sourceUrl);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.port !== ""
    || (hostname !== "fa.oraclecloud.com" && !hostname.endsWith(".fa.oraclecloud.com"))
  ) {
    return undefined;
  }
  const match = ORACLE_CANDIDATE_PATH.exec(url.pathname);
  if (!match) return undefined;
  return { sourceUrl: url, siteNumber: match[1]!, requisitionId: match[2]! };
}

async function loadOracleCandidateExperienceFallback(
  sourceUrl: string,
  signal: AbortSignal,
  fetchImpl: JobSourceFetch,
  resolveHost: ResolveHost,
): Promise<LoadedJobSource | undefined> {
  const source = oracleCandidateSource(sourceUrl);
  if (!source) return undefined;

  const apiUrl = new URL("/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails", source.sourceUrl);
  apiUrl.search = `?expand=all&onlyData=true&finder=ById;Id=%22${source.requisitionId}%22,siteNumber=${source.siteNumber}`;
  const { response } = await fetchPinnedPublicHttp(apiUrl, {
    signal,
    fetchImpl,
    resolveHost,
    headers: { accept: "application/json" },
  });
  if (response.status < 200 || response.status > 299) {
    cancelPublicHttpBody(response);
    throw new JobSourceError("JOB_SOURCE_UNAVAILABLE");
  }

  try {
    const contentEncoding = response.headers.get("content-encoding");
    if (contentEncoding && contentEncoding.trim().toLowerCase() !== "identity") {
      throw new JobSourceError("JOB_SOURCE_UNAVAILABLE");
    }
    const rawType = response.headers.get("content-type");
    const type = rawType?.split(";", 1)[0]!.trim().toLowerCase();
    if (!type || !Object.hasOwn(ACCEPTED_ORACLE_JSON_TYPES, type)) {
      throw new JobSourceError("JOB_SOURCE_UNSUPPORTED");
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength && /^\d+$/.test(declaredLength.trim()) && Number(declaredLength) > MAX_BODY_BYTES) {
      throw new JobSourceError("JOB_SOURCE_TOO_LARGE");
    }
  } catch (error) {
    cancelPublicHttpBody(response);
    throw error;
  }

  const bytes = await readBoundedPublicHttpBody(response, signal);
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new JobSourceError("JOB_SOURCE_UNAVAILABLE", { cause: error });
  }
  if (!document || typeof document !== "object") {
    throw new JobSourceError("JOB_DESCRIPTION_UNAVAILABLE");
  }
  const items = (document as Record<string, unknown>).items;
  if (!Array.isArray(items) || items.length !== 1) {
    throw new JobSourceError("JOB_DESCRIPTION_UNAVAILABLE");
  }
  const item = items[0];
  if (!item || typeof item !== "object") {
    throw new JobSourceError("JOB_DESCRIPTION_UNAVAILABLE");
  }
  const record = item as Record<string, unknown>;
  const id = record.Id;
  if (
    (typeof id !== "string" && (typeof id !== "number" || !Number.isSafeInteger(id)))
    || String(id) !== source.requisitionId
    || typeof record.Title !== "string"
    || typeof record.ExternalDescriptionStr !== "string"
  ) {
    throw new JobSourceError("JOB_DESCRIPTION_UNAVAILABLE");
  }
  const title = await normalizeHtmlFragment(record.Title);
  const description = await normalizeHtmlFragment(record.ExternalDescriptionStr);
  const candidate = buildFallbackCandidate(`${title}\n${description}`);
  if (candidate === "too-large") throw new JobSourceError("JOB_SOURCE_TOO_LARGE");
  if (!candidate) throw new JobSourceError("JOB_DESCRIPTION_UNAVAILABLE");
  return candidate;
}

function normalizedResolvedAddresses(answers: readonly ResolvedAddress[]): ParsedAddress[] {
  const output: ParsedAddress[] = [];
  const seen = new Set<string>();
  for (const answer of answers) {
    if (answer.family !== 4 && answer.family !== 6) throw new JobSourceError("JOB_SOURCE_UNAVAILABLE");
    const parsed = parseAddress(answer.address, true);
    if (!parsed || (answer.family === 4 && parsed.family !== 4) || (answer.family === 6 && isIP(answer.address) !== 6)) {
      throw new JobSourceError("JOB_SOURCE_UNAVAILABLE");
    }
    const key = `${parsed.family}:${parsed.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push(parsed);
    }
  }
  return output;
}

function validatedResolvedAddresses(answers: readonly ResolvedAddress[]): ParsedAddress[] {
  const normalized = normalizedResolvedAddresses(answers);
  if (normalized.length === 0) throw new JobSourceError("JOB_SOURCE_UNAVAILABLE");
  if (normalized.some((address) => !isPublicAddress(address))) throw new JobSourceError("JOB_URL_BLOCKED");
  return normalized;
}

async function resolveValidatedHostnameAddresses(
  hostname: string,
  resolveHost: ResolveHost,
  signal: AbortSignal,
): Promise<ParsedAddress[]> {
  return validatedResolvedAddresses(await hardRace(resolveHost(hostname), signal));
}

async function resolveValidatedAddresses(
  logicalUrl: URL,
  resolveHost: ResolveHost,
  signal: AbortSignal,
): Promise<ParsedAddress[]> {
  const hostname = rawHostname(logicalUrl);
  const literal = parseAddress(hostname, false);
  return literal
    ? validatedResolvedAddresses([
      { address: literal.address, family: literal.family } satisfies ResolvedAddress,
    ])
    : resolveValidatedHostnameAddresses(hostname, resolveHost, signal);
}

export async function validatePublicHttpDestination(
  value: string | URL,
  signal: AbortSignal = NEVER_ABORTED_SIGNAL,
  resolveHost: ResolveHost = defaultResolveHost,
): Promise<URL> {
  signal.throwIfAborted();
  const logicalUrl = canonicalizePublicHttpUrl(value);
  await resolveValidatedAddresses(logicalUrl, resolveHost, signal);
  signal.throwIfAborted();
  return logicalUrl;
}

function fetchInit(
  logicalUrl: URL,
  hostname: string,
  request?: Pick<PinnedPublicHttpRequest, "body" | "headers" | "method">,
): BunFetchRequestInit {
  const literalHost = parseAddress(hostname, false);
  const headers = new Headers(request?.headers);
  if (!headers.has("accept")) headers.set("accept", "text/html, application/xhtml+xml, text/plain");
  if (!headers.has("user-agent")) headers.set("user-agent", "jobhunter/0.1");
  headers.set("accept-encoding", "identity");
  headers.set("host", logicalUrl.host);
  const init: BunFetchRequestInit = {
    method: request?.method ?? "GET",
    redirect: "manual",
    headers,
    decompress: false,
  };
  if (request?.body !== undefined) init.body = request.body;
  if (logicalUrl.protocol === "https:") {
    init.tls = literalHost
      ? { rejectUnauthorized: true }
      : { rejectUnauthorized: true, serverName: hostname };
  }
  return init;
}

async function fetchPinned(
  logicalUrl: URL,
  addresses: readonly ParsedAddress[],
  fetchImpl: JobSourceFetch,
  signal: AbortSignal,
  request?: Pick<PinnedPublicHttpRequest, "beforeFetchAttempt" | "body" | "headers" | "method">,
): Promise<Response> {
  const hostname = rawHostname(logicalUrl);
  let lastFailure: unknown;
  for (const address of addresses) {
    if (signal.aborted) throw cancellationReason(signal);
    const transportUrl = new URL(logicalUrl.href);
    assignHostname(transportUrl, address.address, address.family);
    request?.beforeFetchAttempt?.();
    try {
      return await hardRace(fetchImpl(transportUrl, { ...fetchInit(logicalUrl, hostname, request), signal }), signal);
    } catch (error) {
      if (signal.aborted) throw cancellationReason(signal);
      if (error instanceof JobSourceError) throw error;
      lastFailure = error;
    }
  }
  throw new JobSourceError("JOB_SOURCE_UNAVAILABLE", { cause: lastFailure });
}

export async function fetchPinnedPublicHttp(
  input: string | URL,
  request: PinnedPublicHttpRequest,
): Promise<{ readonly logicalUrl: URL; readonly response: Response }> {
  request.signal.throwIfAborted();
  const logicalUrl = canonicalizePublicHttpUrl(input);
  const addresses = await resolveValidatedAddresses(
    logicalUrl,
    request.resolveHost ?? defaultResolveHost,
    request.signal,
  );
  const response = await fetchPinned(
    logicalUrl,
    addresses,
    request.fetchImpl ?? fetch,
    request.signal,
    request,
  );
  return { logicalUrl, response };
}

function terminalMediaType(response: Response): "html" | "plain" {
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.trim().toLowerCase() !== "identity") {
    throw new JobSourceError("JOB_SOURCE_UNAVAILABLE");
  }
  const rawType = response.headers.get("content-type");
  const type = rawType?.split(";", 1)[0]!.trim().toLowerCase();
  if (type === "text/plain") return "plain";
  if (type && Object.hasOwn(ACCEPTED_HTML_TYPES, type)) return "html";
  throw new JobSourceError("JOB_SOURCE_UNSUPPORTED");
}

async function loadPublicWebSourceWithSignal(
  sourceUrl: string,
  signal: AbortSignal,
  fetchImpl: JobSourceFetch,
  resolveHost: ResolveHost,
): Promise<LoadedPublicWebSource> {
  let logicalUrl = canonicalizeLogicalUrl(sourceUrl);
  const visited = new Set([logicalUrl.href]);
  let redirectHops = 0;

  while (true) {
    if (signal.aborted) throw cancellationReason(signal);
    const addresses = await resolveValidatedAddresses(logicalUrl, resolveHost, signal);
    const response = await fetchPinned(logicalUrl, addresses, fetchImpl, signal);

    if (REDIRECT_STATUSES[response.status]) {
      cancelPublicHttpBody(response);
      if (redirectHops >= MAX_REDIRECT_HOPS) throw new JobSourceError("JOB_SOURCE_UNAVAILABLE");
      const location = response.headers.get("location");
      if (!location) throw new JobSourceError("JOB_SOURCE_UNAVAILABLE");
      let resolved: URL;
      try {
        resolved = new URL(location, logicalUrl);
      } catch (error) {
        throw new JobSourceError("JOB_SOURCE_UNAVAILABLE", { cause: error });
      }
      let target: URL;
      try {
        target = canonicalizePublicHttpUrl(resolved);
      } catch (error) {
        if (error instanceof JobSourceError) throw error;
        throw new JobSourceError("JOB_URL_BLOCKED", { cause: error });
      }
      if (visited.has(target.href)) throw new JobSourceError("JOB_SOURCE_UNAVAILABLE");
      visited.add(target.href);
      logicalUrl = target;
      redirectHops += 1;
      continue;
    }

    if (response.status < 200 || response.status > 299) {
      cancelPublicHttpBody(response);
      throw new JobSourceError("JOB_SOURCE_UNAVAILABLE");
    }

    let mediaType: "html" | "plain";
    try {
      mediaType = terminalMediaType(response);
      const declaredLength = response.headers.get("content-length");
      if (declaredLength && /^\d+$/.test(declaredLength.trim()) && Number(declaredLength) > MAX_BODY_BYTES) {
        throw new JobSourceError("JOB_SOURCE_TOO_LARGE");
      }
    } catch (error) {
      cancelPublicHttpBody(response);
      throw error;
    }

    const bytes = await readBoundedPublicHttpBody(response, signal);
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new JobSourceError("JOB_SOURCE_UNAVAILABLE", { cause: error });
    }
    return { url: logicalUrl.href, mediaType, body };
  }
}

async function loadJobSourceWithSignal(
  jobUrl: string,
  signal: AbortSignal,
  fetchImpl: JobSourceFetch,
  resolveHost: ResolveHost,
  renderHtml: RenderJobSourceHtml,
  opportunityKindHint?: OpportunityKind,
): Promise<LoadedJobSource> {
  const submittedInputUrl = new URL(jobUrl);
  const loaded = await loadPublicWebSourceWithSignal(
    jobUrl,
    signal,
    fetchImpl,
    resolveHost,
  );
  const submittedUrl = canonicalizeLogicalUrl(jobUrl);
  const humanVerificationEligible = submittedInputUrl.protocol === "https:"
    && !submittedInputUrl.hostname.endsWith(".")
    && new URL(loaded.url).origin === submittedUrl.origin;
  if (loaded.mediaType === "plain") {
    const jobDescription = normalizeJobSourceText(loaded.body);
    if (opportunityKindHint !== undefined) {
      const parsed = JobDescriptionSchema.safeParse(jobDescription);
      if (parsed.success) {
        return {
          kind: "description",
          opportunityKind: opportunityKindHint,
          jobDescription: parsed.data,
        };
      }
      throw new JobSourceError(
        jobDescription.length > JOB_DESCRIPTION_MAX_CHARS
          ? "JOB_SOURCE_TOO_LARGE"
          : "JOB_DESCRIPTION_UNAVAILABLE",
      );
    }
    const fallback = buildFallbackCandidate(jobDescription);
    if (fallback === "too-large") throw new JobSourceError("JOB_SOURCE_TOO_LARGE");
    if (fallback !== undefined) return fallback;
    throw new JobSourceError("JOB_DESCRIPTION_UNAVAILABLE");
  }

  const deterministic = await deterministicHtmlDescription(loaded.body, opportunityKindHint);
  if (deterministic === "too-large") throw new JobSourceError("JOB_SOURCE_TOO_LARGE");
  if (deterministic !== undefined) return deterministic;
  const oracleCandidate = await loadOracleCandidateExperienceFallback(
    loaded.url,
    signal,
    fetchImpl,
    resolveHost,
  );
  if (oracleCandidate !== undefined) return oracleCandidate;
  if (
    humanVerificationEligible
    && await isTalHumanVerificationPage(loaded.body)
  ) {
    throw new JobSourceError("JOB_HUMAN_VERIFICATION_REQUIRED");
  }
  let originalError: JobSourceError;
  try {
    return await htmlFallback(loaded.body);
  } catch (error) {
    if (
      !(error instanceof JobSourceError)
      || error.code !== "JOB_DESCRIPTION_UNAVAILABLE"
      || new URL(loaded.url).protocol !== "https:"
    ) {
      throw error;
    }
    originalError = error;
  }

  try {
    const renderedHtml = await hardRace(renderHtml(loaded.url, signal), signal);
    if (renderedHtml === undefined) throw originalError;
    return await hardRace(htmlFallback(renderedHtml), signal);
  } catch (error) {
    if (signal.aborted && !(signal.reason instanceof DeadlineExpired)) throw cancellationReason(signal);
    if (
      error instanceof JobSourceError
      && error.code === "JOB_HUMAN_VERIFICATION_REQUIRED"
    ) {
      throw error;
    }
    throw originalError;
  }
}

export async function loadJobSourceFromUrl(
  jobUrl: string,
  signal?: AbortSignal,
  options: JobSourceLoadOptions = {},
  opportunityKindHint?: OpportunityKind,
): Promise<LoadedJobSource> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const deadlineReason = new DeadlineExpired("Job source network deadline expired");
  const deadlineMs = options.deadlineMs ?? NETWORK_DEADLINE_MS;
  const timer = setTimeout(() => controller.abort(deadlineReason), Math.max(0, deadlineMs));
  const onCallerAbort = () => controller.abort(cancellationReason(signal!));
  signal?.addEventListener("abort", onCallerAbort, { once: true });

  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const renderHtml = options.renderHtml ?? (async (url, renderSignal) => renderJobSourceWithChrome(
    url,
    renderSignal,
    {
      resolveAddresses: (hostname, resolveSignal) => resolveValidatedHostnameAddresses(
        hostname,
        resolveHost,
        resolveSignal,
      ),
    },
  ));
  try {
    return await loadJobSourceWithSignal(
      jobUrl,
      controller.signal,
      options.fetchImpl ?? fetch,
      resolveHost,
      renderHtml,
      opportunityKindHint,
    );
  } catch (error) {
    if (signal?.aborted) throw cancellationReason(signal);
    if (error instanceof JobSourceError) throw error;
    throw new JobSourceError("JOB_SOURCE_UNAVAILABLE", { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

export async function loadPublicWebSourceFromUrl(
  sourceUrl: string,
  signal?: AbortSignal,
  options: JobSourceLoadOptions = {},
): Promise<LoadedPublicWebSource> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const deadlineReason = new DeadlineExpired("Public source network deadline expired");
  const deadlineMs = options.deadlineMs ?? NETWORK_DEADLINE_MS;
  const timer = setTimeout(() => controller.abort(deadlineReason), Math.max(0, deadlineMs));
  const onCallerAbort = () => controller.abort(cancellationReason(signal!));
  signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    return await loadPublicWebSourceWithSignal(
      sourceUrl,
      controller.signal,
      options.fetchImpl ?? fetch,
      options.resolveHost ?? defaultResolveHost,
    );
  } catch (error) {
    if (signal?.aborted) throw cancellationReason(signal);
    if (error instanceof JobSourceError) throw error;
    throw new JobSourceError("JOB_SOURCE_UNAVAILABLE", { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}
