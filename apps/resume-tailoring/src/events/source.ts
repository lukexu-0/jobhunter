import {
  JobSourceError,
  loadPublicWebSourceFromUrl,
  type JobSourceLoadOptions,
} from "../api/job-source.ts";
import {
  LUNA_MAX_SOURCE_BYTES,
  LUNA_MAX_SOURCE_LINES,
} from "../models/luna-job-extractor.ts";
import type { LoadedRecruitingEventSource } from "./parser.ts";

const REMOVED_CONTENT = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "[hidden]",
  "[aria-hidden='true']",
].join(", ");
const BOUNDARIES = [
  "address", "article", "aside", "blockquote", "br", "div", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "li", "main", "nav", "p", "section", "table",
  "td", "th", "tr",
] as const;

function normalizeLines(value: string): string[] {
  const lines = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new JobSourceError("JOB_DESCRIPTION_UNAVAILABLE");
  }
  if (
    lines.length > LUNA_MAX_SOURCE_LINES
    || Buffer.byteLength(lines.join("\n"), "utf8") > LUNA_MAX_SOURCE_BYTES
  ) {
    throw new JobSourceError("JOB_SOURCE_TOO_LARGE");
  }
  return lines;
}

async function collectJsonLd(html: string): Promise<unknown[]> {
  const blocks: string[] = [];
  let current: string[] | undefined;
  await new HTMLRewriter().on("script", {
    element(element) {
      const type = (element.getAttribute("type") ?? "")
        .split(";", 1)[0]!
        .trim()
        .toLowerCase();
      if (type !== "application/ld+json") return;
      current = [];
      element.onEndTag(() => {
        if (current) blocks.push(current.join(""));
        current = undefined;
      });
    },
    text(text) {
      current?.push(text.text);
    },
  }).transform(new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })).text();

  const values: unknown[] = [];
  for (const block of blocks) {
    try {
      values.push(JSON.parse(block));
    } catch {
      // Each malformed metadata block is independent; visible text can still use the model fallback.
    }
  }
  return values;
}

async function visibleLines(html: string): Promise<string[]> {
  const rewriter = new HTMLRewriter().on(REMOVED_CONTENT, {
    element(element) {
      element.remove();
    },
  });
  for (const tag of BOUNDARIES) {
    rewriter.on(tag, {
      element(element) {
        if (!element.removed) element.after("\n", { html: false });
      },
    });
  }
  const sanitized = await rewriter.transform(new Response(html, {
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
  return normalizeLines(chunks.join(""));
}

export async function loadRecruitingEventSourceFromUrl(
  sourceUrl: string,
  signal?: AbortSignal,
  options: JobSourceLoadOptions = {},
): Promise<LoadedRecruitingEventSource> {
  const loaded = await loadPublicWebSourceFromUrl(sourceUrl, signal, options);
  if (loaded.mediaType === "plain") {
    return { url: loaded.url, lines: normalizeLines(loaded.body), jsonLd: [] };
  }
  const [jsonLd, lines] = await Promise.all([
    collectJsonLd(loaded.body),
    visibleLines(loaded.body),
  ]);
  return { url: loaded.url, lines, jsonLd };
}
