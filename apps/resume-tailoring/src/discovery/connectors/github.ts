import type {
  DiscoveredJobInput,
  DiscoveryConnector,
  DiscoverySourceKind,
  DiscoverySyncResult,
} from "../types";
import { SafePublicHttpClient } from "./http";
import {
  absolutePublicUrl,
  canonicalizeJobUrl,
  captureHtmlElements,
  captureJsonLd,
  htmlToText,
  nonemptyString,
  normalizeSpace,
  parsePostedAt,
  sanitizeDescription,
  stableSourceItemId,
  visitJsonObjects,
} from "./normalize";

export interface GitHubTableConnectorConfig {
  readonly id: string;
  readonly name: string;
  readonly kind: Extract<DiscoverySourceKind, "simplify" | "zapply" | "speedyapply">;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly path: string;
  readonly maxRows?: number;
  readonly detailConcurrency?: number;
  readonly githubToken?: string;
}

export interface ParsedGitHubTableRow {
  readonly line: number;
  readonly company: string;
  readonly title: string;
  readonly location: string | null;
  readonly applyUrl: string;
  readonly postedAt: number | null;
}

export interface ParsedGitHubTable {
  readonly rows: readonly ParsedGitHubTableRow[];
  readonly closedCount: number;
  readonly unusableCount: number;
  readonly nonInternshipCount: number;
  readonly tableCount: number;
  readonly truncated: boolean;
}

const COLUMN_NAMES = {
  company: ["company", "company name", "employer", "organization"],
  title: ["role", "position", "title", "job title"],
  name: ["name"],
  location: ["location", "locations"],
  apply: ["application", "apply", "application link", "link", "posting"],
  date: ["date posted", "posted", "posted date", "date", "age", "status/open date"],
  note: ["note", "notes"],
  year: ["year", "eligible year", "class year"],
} as const;
const CLOSED_ROW = /(?:🔒|\bclosed\b|\bexpired\b|~~)/i;
const INTERNSHIP_TITLE = /\b(?:intern(?:ship)?|co[- ]?op)\b/i;
const CONFIG_PART = /^[A-Za-z0-9._-]{1,100}$/;
const CONFIG_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\/-]{1,500}$/;
const MAX_PARSED_RECORDS = 1_001;
const MAX_HTML_TABLES = 100;
const MAX_HTML_CELLS_PER_ROW = 100;
const DESCRIPTION_SELECTORS = [
  "[data-automation-id='jobPostingDescription']",
  "[data-testid='job-description']",
  "#job-description",
  ".job-description",
  ".jobDescription",
  "article",
  "main",
] as const;

function splitGfmRow(line: string): string[] {
  let input = line.trim();
  if (input.startsWith("|")) input = input.slice(1);
  if (input.endsWith("|") && !input.endsWith("\\|")) input = input.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of input) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

function markdownText(value: string): string {
  return normalizeSpace(value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[*_~`]/g, ""));
}

function firstUrl(value: string): string | undefined {
  const markdown = /\[[^\]]*\]\(\s*(https?:\/\/[^\s)]+)(?:\s+[^)]*)?\)/i.exec(value)?.[1];
  const html = /\bhref\s*=\s*["'](https?:\/\/[^"']+)["']/i.exec(value)?.[1];
  const autolink = /<\s*(https?:\/\/[^>\s]+)\s*>/i.exec(value)?.[1];
  const bare = /\bhttps?:\/\/[^\s<>)"']+/i.exec(value)?.[0];
  const found = markdown ?? html ?? autolink ?? bare;
  return found?.replace(/&amp;/gi, "&").replace(/\\([()])/g, "$1");
}

function columnIndex(headers: readonly string[], names: readonly string[]): number {
  return headers.findIndex((header) => names.includes(header));
}

function tableDate(value: string): number | null {
  const normalized = markdownText(value);
  if (!normalized) return null;
  const age = /^(\d{1,4})\s*(h|d|w|mo)$/i.exec(normalized);
  if (age) {
    const unitMilliseconds: Readonly<Record<string, number>> = {
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
      mo: 2_592_000_000,
    };
    return Date.now() - Number(age[1]) * unitMilliseconds[age[2]!.toLowerCase()]!;
  }
  if (!/(?:Z|[+-]\d\d:?\d\d|\bUTC\b|\bGMT\b)$/i.test(normalized)) {
    const utc = Date.parse(`${normalized} UTC`);
    if (Number.isFinite(utc)) return utc;
  }
  return parsePostedAt(normalized);
}

interface SourceTableCell {
  readonly text: string;
  readonly markup: string;
}

type ParsedRowOutcome =
  | { readonly kind: "row"; readonly row: ParsedGitHubTableRow }
  | { readonly kind: "closed" }
  | { readonly kind: "non-internship" }
  | { readonly kind: "unusable" };

function internshipSectionState(lines: readonly string[]): readonly boolean[] {
  const stateBeforeLine = new Array<boolean>(lines.length);
  let internshipSection = false;
  for (let index = 0; index < lines.length; index += 1) {
    stateBeforeLine[index] = internshipSection;
    const match = /^(#{1,6})\s+(.+)$/.exec(lines[index]!.trim());
    if (!match) continue;
    if (/\bfellowships?\b/i.test(match[2]!)) {
      internshipSection = false;
    } else if (/\binternships?\b/i.test(match[2]!)) {
      internshipSection = true;
    } else if (match[1]!.length <= 2) {
      internshipSection = false;
    }
  }
  return stateBeforeLine;
}

function companyFromProgramName(title: string): string {
  const candidate = title.split(/\s+(?=(?:SWE|software|engineering|explore|intern(?:ship)?|co[- ]?op|\())/i)[0] ?? title;
  return normalizeSpace(candidate.replace(/^[^\p{L}\p{N}]+/u, ""));
}

function parsedTableRow(
  headers: readonly string[],
  cells: readonly SourceTableCell[],
  raw: string,
  line: number,
  internshipSection: boolean,
): ParsedRowOutcome {
  if (CLOSED_ROW.test(raw)) return { kind: "closed" };
  const standardCompanyIndex = columnIndex(headers, COLUMN_NAMES.company);
  const standardTitleIndex = columnIndex(headers, COLUMN_NAMES.title);
  const standardApplyIndex = columnIndex(headers, COLUMN_NAMES.apply);
  const nameIndex = columnIndex(headers, COLUMN_NAMES.name);
  const zapplyShape = standardCompanyIndex < 0
    && standardTitleIndex < 0
    && standardApplyIndex < 0
    && nameIndex >= 0
    && (columnIndex(headers, COLUMN_NAMES.note) >= 0 || columnIndex(headers, COLUMN_NAMES.year) >= 0);
  const companyIndex = zapplyShape ? nameIndex : standardCompanyIndex;
  const titleIndex = zapplyShape ? nameIndex : standardTitleIndex;
  const applyIndex = zapplyShape ? nameIndex : standardApplyIndex;
  if (companyIndex < 0 || titleIndex < 0 || applyIndex < 0) return { kind: "unusable" };
  const title = cells[titleIndex]?.text ?? "";
  if (!(zapplyShape && internshipSection) && !INTERNSHIP_TITLE.test(title)) {
    return { kind: "non-internship" };
  }
  const applyUrl = firstUrl(cells[applyIndex]?.markup ?? "");
  const rawCompany = cells[companyIndex]?.text ?? "";
  const company = zapplyShape
    ? companyFromProgramName(title)
    : normalizeSpace(rawCompany.replace(/^[^\p{L}\p{N}]+/u, ""));
  if (!company || !title || !applyUrl || !absolutePublicUrl(applyUrl)) return { kind: "unusable" };
  const locationIndex = columnIndex(headers, COLUMN_NAMES.location);
  const dateIndex = columnIndex(headers, COLUMN_NAMES.date);
  const location = locationIndex < 0 ? null : cells[locationIndex]?.text || null;
  return {
    kind: "row",
    row: {
      line,
      company,
      title,
      location,
      applyUrl,
      postedAt: dateIndex < 0 ? null : tableDate(cells[dateIndex]?.text ?? ""),
    },
  };
}

function collectOutcome(
  outcome: ParsedRowOutcome,
  rows: ParsedGitHubTableRow[],
  counts: { closed: number; nonInternship: number; unusable: number },
): void {
  if (outcome.kind === "row") rows.push(outcome.row);
  else if (outcome.kind === "closed") counts.closed += 1;
  else if (outcome.kind === "non-internship") counts.nonInternship += 1;
  else counts.unusable += 1;
}

function recordLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PARSED_RECORDS) {
    throw new Error("Invalid GitHub discovery parser record limit");
  }
  return value;
}

function countLineBreaks(value: string, start: number, end: number): number {
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

export function parseGitHubInternshipTable(
  markdown: string,
  maxRecords = MAX_PARSED_RECORDS,
): ParsedGitHubTable {
  const limit = recordLimit(maxRecords);
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const sectionState = internshipSectionState(lines);
  const rows: ParsedGitHubTableRow[] = [];
  const counts = { closed: 0, nonInternship: 0, unusable: 0 };
  let tableCount = 0;
  let recordsSeen = 0;
  let truncated = false;
  tables: for (let headerLine = 0; headerLine + 1 < lines.length; headerLine += 1) {
    const rawHeaders = splitGfmRow(lines[headerLine]!);
    const headers = rawHeaders.map((cell) => markdownText(cell).toLowerCase());
    const separator = splitGfmRow(lines[headerLine + 1]!);
    const standardShape = columnIndex(headers, COLUMN_NAMES.company) >= 0
      && columnIndex(headers, COLUMN_NAMES.title) >= 0
      && columnIndex(headers, COLUMN_NAMES.apply) >= 0;
    const zapplyShape = columnIndex(headers, COLUMN_NAMES.name) >= 0
      && (columnIndex(headers, COLUMN_NAMES.note) >= 0 || columnIndex(headers, COLUMN_NAMES.year) >= 0);
    if (
      separator.length !== headers.length
      || !separator.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
      || (!standardShape && !zapplyShape)
    ) {
      continue;
    }
    if (tableCount >= MAX_HTML_TABLES) {
      truncated = true;
      break;
    }
    tableCount += 1;
    const internshipSection = sectionState[headerLine] ?? false;
    let rowLine = headerLine + 2;
    for (; rowLine < lines.length; rowLine += 1) {
      const raw = lines[rowLine]!;
      if (!raw.trim() || !raw.includes("|")) break;
      if (recordsSeen >= limit) {
        truncated = true;
        break tables;
      }
      recordsSeen += 1;
      const rawCells = splitGfmRow(raw);
      if (rawCells.length !== headers.length) {
        counts.unusable += 1;
        continue;
      }
      const cells = rawCells.map((markup) => ({ text: markdownText(markup), markup }));
      collectOutcome(parsedTableRow(headers, cells, raw, rowLine + 1, internshipSection), rows, counts);
    }
    headerLine = rowLine - 1;
  }
  return {
    rows,
    closedCount: counts.closed,
    nonInternshipCount: counts.nonInternship,
    unusableCount: counts.unusable,
    tableCount,
    truncated,
  };
}

export async function parseGitHubRepositoryTables(
  markdown: string,
  maxRecords = MAX_PARSED_RECORDS,
): Promise<ParsedGitHubTable> {
  const limit = recordLimit(maxRecords);
  const normalizedMarkdown = markdown.replace(/\r\n?/g, "\n");
  const gfm = parseGitHubInternshipTable(normalizedMarkdown, limit);
  const rows = [...gfm.rows];
  const counts = {
    closed: gfm.closedCount,
    nonInternship: gfm.nonInternshipCount,
    unusable: gfm.unusableCount,
  };
  let recordsSeen = rows.length + counts.closed + counts.nonInternship + counts.unusable;
  let truncated = gfm.truncated;
  let htmlTableCount = 0;
  let tablesSeen = gfm.tableCount;
  let previousTableIndex = 0;
  let tableLine = 1;
  const lines = normalizedMarkdown.split("\n");
  const sectionState = internshipSectionState(lines);
  const tables = normalizedMarkdown.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi);
  htmlTables: for (const tableMatch of tables) {
    if (truncated || tablesSeen >= MAX_HTML_TABLES) {
      truncated = true;
      break;
    }
    tablesSeen += 1;
    const tableIndex = tableMatch.index;
    tableLine += countLineBreaks(normalizedMarkdown, previousTableIndex, tableIndex);
    previousTableIndex = tableIndex;
    const table = tableMatch[0];
    const internshipSection = sectionState[tableLine - 1] ?? false;
    let previousRowIndex = 0;
    let rowLine = tableLine;
    let headers: string[] | undefined;
    for (const rowMatch of table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
      if (recordsSeen >= limit) {
        truncated = true;
        break htmlTables;
      }
      recordsSeen += 1;
      const rowIndex = rowMatch.index;
      rowLine += countLineBreaks(table, previousRowIndex, rowIndex);
      previousRowIndex = rowIndex;
      const rawCells: RegExpMatchArray[] = [];
      for (const cell of rowMatch[0].matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t\1>/gi)) {
        if (rawCells.length >= MAX_HTML_CELLS_PER_ROW) {
          truncated = true;
          break htmlTables;
        }
        rawCells.push(cell);
      }
      if (rawCells.length === 0) continue;
      const cells = await Promise.all(rawCells.map(async (cell) => ({
        text: normalizeSpace(await htmlToText(cell[2] ?? "")),
        markup: cell[2] ?? "",
      })));
      if (!headers && rawCells.every((cell) => cell[1]?.toLowerCase() === "h")) {
        const candidate = cells.map((cell) => cell.text.toLowerCase());
        const standardShape = columnIndex(candidate, COLUMN_NAMES.company) >= 0
          && columnIndex(candidate, COLUMN_NAMES.title) >= 0
          && columnIndex(candidate, COLUMN_NAMES.apply) >= 0;
        const zapplyShape = columnIndex(candidate, COLUMN_NAMES.name) >= 0
          && (columnIndex(candidate, COLUMN_NAMES.note) >= 0 || columnIndex(candidate, COLUMN_NAMES.year) >= 0);
        if (!standardShape && !zapplyShape) break;
        headers = candidate;
        htmlTableCount += 1;
        continue;
      }
      if (!headers) continue;
      if (cells.length !== headers.length) {
        counts.unusable += 1;
        continue;
      }
      collectOutcome(
        parsedTableRow(
          headers,
          cells,
          rowMatch[0],
          rowLine,
          internshipSection,
        ),
        rows,
        counts,
      );
    }
  }
  const seen = new Set<string>();
  const deduplicated = rows
    .sort((left, right) => left.line - right.line)
    .filter((row) => {
      const key = `${row.applyUrl}\u001f${row.company}\u001f${row.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    rows: deduplicated,
    closedCount: counts.closed,
    nonInternshipCount: counts.nonInternship,
    unusableCount: counts.unusable,
    tableCount: gfm.tableCount + htmlTableCount,
    truncated,
  };
}

function configured(config: GitHubTableConnectorConfig): Required<Omit<GitHubTableConnectorConfig, "githubToken">> & {
  readonly githubToken?: string;
} {
  const maxRows = config.maxRows ?? 1_000;
  const detailConcurrency = config.detailConcurrency ?? 4;
  if (
    !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(config.id)
    || !normalizeSpace(config.name)
    || !CONFIG_PART.test(config.owner)
    || !CONFIG_PART.test(config.repo)
    || !CONFIG_PART.test(config.branch)
    || !CONFIG_PATH.test(config.path)
    || !Number.isInteger(maxRows)
    || maxRows < 1
    || maxRows > 1_000
    || !Number.isInteger(detailConcurrency)
    || detailConcurrency < 1
    || detailConcurrency > 10
  ) {
    throw new Error("Invalid GitHub discovery source configuration");
  }
  const githubToken = nonemptyString(config.githubToken ?? "");
  return {
    ...config,
    name: normalizeSpace(config.name),
    maxRows,
    detailConcurrency,
    ...(githubToken ? { githubToken } : {}),
  };
}

async function sanitizedJsonDescription(
  value: unknown,
  jobPostingsOnly: boolean,
): Promise<string | undefined> {
  const descriptions: string[] = [];
  visitJsonObjects(value, (record) => {
    if (jobPostingsOnly) {
      const type = record["@type"];
      const isPosting = type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
      if (!isPosting) return;
    }
    const description = nonemptyString(record.description);
    if (description) descriptions.push(description);
  });
  for (const description of descriptions) {
    const sanitized = await sanitizeDescription(description, "html");
    if (sanitized) return sanitized;
  }
  return undefined;
}

async function descriptionFromHtml(html: string): Promise<string | undefined> {
  for (const value of await captureJsonLd(html)) {
    const description = await sanitizedJsonDescription(value, true);
    if (description) return description;
  }
  for (const selector of DESCRIPTION_SELECTORS) {
    const candidate = (await captureHtmlElements(html, selector))[0]?.text;
    if (!candidate) continue;
    const sanitized = await sanitizeDescription(candidate, "text");
    if (sanitized) return sanitized;
  }
  return undefined;
}

async function loadDescription(client: SafePublicHttpClient, url: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const response = await client.get(url, {
      signal,
      acceptedMediaTypes: ["text/html", "application/xhtml+xml", "text/plain", "application/ld+json", "application/json"],
      maxBodyBytes: 1024 * 1024,
    });
    if (response.status < 200 || response.status > 299) return undefined;
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType === "text/plain") return sanitizeDescription(response.text(), "text");
    if (mediaType === "application/json" || mediaType === "application/ld+json") {
      return sanitizedJsonDescription(response.json<unknown>(), false);
    }
    return descriptionFromHtml(response.text());
  } catch (error) {
    signal.throwIfAborted();
    return undefined;
  }
}

function requisitionFromUrl(url: string): string | undefined {
  const parsed = new URL(url);
  const queryId = parsed.searchParams.get("gh_jid") ?? parsed.searchParams.get("jobId") ?? parsed.searchParams.get("job_id");
  const pathId = /(?:jobs?|positions?|requisitions?)[\/_-]([A-Za-z0-9._-]{3,100})(?:\/|$)/i.exec(parsed.pathname)?.[1];
  return nonemptyString(queryId ?? pathId ?? "");
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<U>,
): Promise<readonly U[]> {
  const output = new Array<U>(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await operation(values[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

export function createGitHubTableConnector(
  input: GitHubTableConnectorConfig,
  client = new SafePublicHttpClient(),
): DiscoveryConnector {
  const config = configured(input);
  let etag: string | undefined;
  let cached: DiscoverySyncResult | undefined;
  let cachedMarkdown: string | undefined;
  let cachedRevision: string | undefined;
  return {
    id: config.id,
    name: config.name,
    kind: config.kind,
    async sync(signal, budget) {
      const syncClient = budget ? client.withBudget(budget) : client;
      const contentsUrl = new URL(`https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${config.path.split("/").map(encodeURIComponent).join("/")}`);
      contentsUrl.searchParams.set("ref", config.branch);
      const headers: Record<string, string> = {
        accept: "application/vnd.github.raw+json",
        "user-agent": "jobhunter-discovery",
      };
      if (etag) headers["if-none-match"] = etag;
      if (config.githubToken) headers.authorization = `Bearer ${config.githubToken}`;
      let response;
      try {
        response = await syncClient.get(contentsUrl, {
          signal,
          headers,
          authorizationOrigin: "https://api.github.com",
          allowedHosts: ["api.github.com"],
          acceptedMediaTypes: ["text/plain", "application/json", "application/vnd.github.raw", "application/vnd.github.raw+json"],
          maxBodyBytes: 2 * 1024 * 1024,
        });
      } catch (error) {
        signal.throwIfAborted();
        throw new Error("GitHub discovery source is unavailable", { cause: error });
      }
      let markdown: string;
      let revision: string;
      if (response.status === 304) {
        if (cached) return cached;
        if (cachedMarkdown === undefined) throw new Error("GitHub discovery source is unavailable");
        markdown = cachedMarkdown;
        revision = cachedRevision ?? config.branch;
      } else {
        if (response.status < 200 || response.status > 299) throw new Error("GitHub discovery source is unavailable");
        revision = config.branch;
        const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (mediaType === "application/json") {
          const body = response.json<Readonly<Record<string, unknown>>>();
          const encoded = nonemptyString(body.content);
          if (!encoded || body.encoding !== "base64") throw new Error("GitHub discovery source is unavailable");
          try {
            markdown = Buffer.from(encoded.replace(/\s/g, ""), "base64").toString("utf8");
          } catch (error) {
            throw new Error("GitHub discovery source is unavailable", { cause: error });
          }
          revision = nonemptyString(body.sha) ?? revision;
        } else {
          markdown = response.text();
        }
      }
      const parsed = await parseGitHubRepositoryTables(markdown, config.maxRows + 1);
      const truncated = parsed.truncated || parsed.rows.length > config.maxRows;
      const selectedRows = parsed.rows.slice(0, config.maxRows);
      let omittedDescriptions = parsed.unusableCount;
      const loaded = await mapConcurrent(selectedRows, config.detailConcurrency, async (row): Promise<DiscoveredJobInput | undefined> => {
        const canonicalUrl = canonicalizeJobUrl(row.applyUrl);
        if (!canonicalUrl) {
          omittedDescriptions += 1;
          return undefined;
        }
        const description = await loadDescription(syncClient, canonicalUrl, signal);
        if (!description) {
          omittedDescriptions += 1;
          return undefined;
        }
        const requisitionId = requisitionFromUrl(canonicalUrl);
        return {
          sourceItemId: requisitionId
            ? `${config.id}:${requisitionId}:${stableSourceItemId(canonicalUrl)}`
            : `${config.id}:${stableSourceItemId(row.company, row.title, row.location ?? "", canonicalUrl)}`,
          sourceUrl: `https://github.com/${config.owner}/${config.repo}/blob/${encodeURIComponent(config.branch)}/${config.path}#L${row.line}`,
          canonicalUrl,
          applyUrl: canonicalUrl,
          title: row.title,
          company: row.company,
          location: row.location,
          description,
          postedAt: row.postedAt,
          ...(requisitionId ? { requisitionId } : {}),
        };
      });
      const result: DiscoverySyncResult = {
        items: loaded.filter((item): item is DiscoveredJobInput => item !== undefined),
        completeSnapshot: parsed.tableCount > 0
          && parsed.rows.length + parsed.closedCount + parsed.nonInternshipCount + parsed.unusableCount > 0
          && !truncated
          && omittedDescriptions === 0,
        provenance: `${config.owner}/${config.repo}@${revision}:${config.path}; tables: ${parsed.tableCount}; rows: ${parsed.rows.length}; closed: ${parsed.closedCount}; non-internships: ${parsed.nonInternshipCount}; omitted descriptions: ${omittedDescriptions}`.slice(0, 500),
      };
      if (response.status !== 304) {
        etag = response.headers.get("etag") ?? undefined;
        cachedMarkdown = markdown;
        cachedRevision = revision;
      }
      cached = result.completeSnapshot ? result : undefined;
      return result;
    },
  };
}
