import {
  canonicalizePublicHttpUrl,
  decodeHtmlEntities,
} from "../../api/job-source";
import { createHash } from "node:crypto";

const REMOVED_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "[hidden]",
  "[aria-hidden='true']",
].join(",");
const BLOCK_ELEMENTS = [
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul",
] as const;
const TRACKING_QUERY_NAMES = /^(?:utm_[a-z0-9_]+|gclid|fbclid|li_fat_id|trk|trackingId|ref(?:errer)?|source)$/i;
const MAX_CAPTURED_ELEMENTS = 1_000;
const MAX_ACTIVE_CAPTURES = 32;
const MAX_CAPTURE_TEXT_LENGTH = 50_001;
const MAX_CAPTURE_TEXT_CHUNKS = 1_000;

export interface CapturedHtmlElement {
  readonly text: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface BoundedHtmlCaptures {
  readonly captures: readonly CapturedHtmlElement[];
  readonly truncated: boolean;
}

export function normalizeSpace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t\f\v]+/g, " ").trim();
}

export function normalizeMultilineText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n")
    .map(normalizeSpace)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function htmlToText(html: string): Promise<string> {
  const rewriter = new HTMLRewriter().on(REMOVED_SELECTOR, {
    element(element) {
      element.remove();
    },
  });
  for (const tag of BLOCK_ELEMENTS) {
    rewriter.on(tag, {
      element(element) {
        if (!element.removed) element.after("\n", { html: false });
      },
    });
  }
  const sanitized = await rewriter.transform(new Response(`<!doctype html><body>${decodeHtmlEntities(html)}</body>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })).text();
  const chunks: string[] = [];
  await new HTMLRewriter().onDocument({
    text(text) {
      chunks.push(text.text);
    },
  }).transform(new Response(sanitized, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })).text();
  return normalizeMultilineText(chunks.join(""));
}

export async function sanitizeDescription(value: string, format: "html" | "text" = "html"): Promise<string | undefined> {
  const normalized = format === "html" ? await htmlToText(value) : normalizeMultilineText(value);
  if (normalized.length < 40 || normalized.length > 50_000) return undefined;
  return normalized;
}

export async function captureHtmlElementsBounded(
  html: string,
  selector: string,
  attributeNames: readonly string[] = [],
): Promise<BoundedHtmlCaptures> {
  const output: CapturedHtmlElement[] = [];
  const active: Array<{
    text: string[];
    textLength: number;
    attributes: Record<string, string>;
  }> = [];
  let capturesStarted = 0;
  let truncated = false;
  try {
    await new HTMLRewriter().on(selector, {
      element(element) {
        if (capturesStarted >= MAX_CAPTURED_ELEMENTS || active.length >= MAX_ACTIVE_CAPTURES) {
          truncated = true;
          return;
        }
        capturesStarted += 1;
        const attributes: Record<string, string> = {};
        for (const name of attributeNames) {
          const value = element.getAttribute(name);
          if (value !== null) attributes[name] = value;
        }
        const capture = { text: [] as string[], textLength: 0, attributes };
        active.push(capture);
        element.onEndTag(() => {
          const index = active.lastIndexOf(capture);
          if (index >= 0) active.splice(index, 1);
          output.push({ text: normalizeMultilineText(capture.text.join("")), attributes });
        });
      },
      text(text) {
        for (const capture of active) {
          const remaining = MAX_CAPTURE_TEXT_LENGTH - capture.textLength;
          if (remaining <= 0 || capture.text.length >= MAX_CAPTURE_TEXT_CHUNKS) {
            truncated = true;
            continue;
          }
          const chunk = text.text.length <= remaining ? text.text : text.text.slice(0, remaining);
          if (chunk.length === 0) continue;
          capture.text.push(chunk);
          capture.textLength += chunk.length;
          if (chunk.length < text.text.length) truncated = true;
        }
      },
    }).transform(new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    })).text();
  } catch (error) {
    throw new Error("Invalid configured HTML selector", { cause: error });
  }
  return { captures: output, truncated };
}

export async function captureHtmlElements(
  html: string,
  selector: string,
  attributeNames: readonly string[] = [],
): Promise<readonly CapturedHtmlElement[]> {
  return (await captureHtmlElementsBounded(html, selector, attributeNames)).captures;
}

export async function captureJsonLd(html: string): Promise<readonly unknown[]> {
  const scripts = await captureHtmlElements(html, "script[type='application/ld+json']");
  const output: unknown[] = [];
  for (const script of scripts) {
    try {
      output.push(JSON.parse(script.text));
    } catch {
      // Malformed optional metadata is ignored; connector-specific markup may still be complete.
    }
  }
  return output;
}

export function visitJsonObjects(value: unknown, visitor: (value: Readonly<Record<string, unknown>>) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) visitJsonObjects(child, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Readonly<Record<string, unknown>>;
  visitor(record);
  for (const child of Object.values(record)) visitJsonObjects(child, visitor);
}

export function absolutePublicUrl(value: string, base?: string | URL): string | undefined {
  try {
    const resolved = base === undefined ? new URL(value) : new URL(value, base);
    const url = canonicalizePublicHttpUrl(resolved);
    if (url.protocol !== "https:" || url.href.length > 2_048) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function canonicalizeJobUrl(value: string, base?: string | URL): string | undefined {
  const absolute = absolutePublicUrl(value, base);
  if (!absolute) return undefined;
  const url = new URL(absolute);
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING_QUERY_NAMES.test(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  return url.href;
}

export function parsePostedAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 100_000_000_000 ? value * 1_000 : value;
    return milliseconds > 0 && milliseconds <= 8_640_000_000_000_000 ? Math.trunc(milliseconds) : null;
  }
  if (typeof value !== "string") return null;
  const normalized = normalizeSpace(value);
  if (!normalized) return null;
  const relative = /^(\d+)\s+(minute|hour|day|week|month)s?\s+ago$/i.exec(normalized);
  if (relative) {
    const count = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const millisecondsByUnit: Readonly<Record<string, number>> = {
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
      week: 604_800_000,
      month: 2_592_000_000,
    };
    const parsed = Date.now() - count * millisecondsByUnit[unit]!;
    return parsed >= 0 ? parsed : null;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function stableSourceItemId(...parts: readonly string[]): string {
  const normalized = parts.map((part) => normalizeSpace(part).toLowerCase()).join("\u001f");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export function nonemptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeSpace(value);
  return normalized || undefined;
}

export function stringAt(record: Readonly<Record<string, unknown>>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = nonemptyString(record[key]);
    if (value) return value;
  }
  return undefined;
}

export function recordAt(record: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> | undefined {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}
