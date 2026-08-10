import type {
  DiscoveredJobInput,
  DiscoveryConnector,
  DiscoveryKnownItem,
  DiscoveryKnownItemKey,
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
  readonly descriptionUrl?: string;
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
const CONFIG_PART = /^[A-Za-z0-9._-]{1,100}$/;
const CONFIG_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\/-]{1,500}$/;
const MAX_SCANNED_RECORDS = 10_000;
const MAX_PARSED_RECORDS = MAX_SCANNED_RECORDS + 1;
const MAX_HTML_TABLES = 100;
const MAX_HTML_CELLS_PER_ROW = 100;
const DESCRIPTION_SELECTORS = [
  "[data-automation-id='jobPostingDescription']",
  "[data-testid='job-description']",
  "#job-description",
  "#job-detail-body",
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

function applicationUrl(value: string): string | undefined {
  const mirror = simplifyMirrorUrl(value);
  for (const match of value.matchAll(/\bhttps?:\/\/[^\s<>)"']+/gi)) {
    const candidate = match[0]!.replace(/&amp;/gi, "&").replace(/\\([()])/g, "$1");
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    const applyToJob = /^[a-z0-9-]{1,63}\.applytojob\.com$/i.test(parsed.hostname)
      && /^\/apply\/[A-Za-z0-9_-]{1,100}\//.test(parsed.pathname);
    const blockCareers = parsed.hostname === "block.xyz"
      && /^\/careers\/jobs\/[0-9]{1,20}\/?$/.test(parsed.pathname);
    if (parsed.protocol === "http:" && (applyToJob || blockCareers)) {
      parsed.protocol = "https:";
      if (parsed.port === "80") parsed.port = "";
    }
    const safe = absolutePublicUrl(parsed.href);
    if (!safe || (mirror && canonicalizeJobUrl(safe) === mirror)) continue;
    return safe;
  }
  return undefined;
}

function simplifyMirrorUrl(value: string): string | undefined {
  const candidate = /\bhttps:\/\/simplify\.jobs\/p\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?:\?[^"'<>\s)]*)?/i.exec(value)?.[0]
    ?.replace(/&amp;/gi, "&");
  if (!candidate) return undefined;
  const canonical = canonicalizeJobUrl(candidate);
  if (!canonical) return undefined;
  const url = new URL(canonical);
  return url.hostname === "simplify.jobs" && /^\/p\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(url.pathname)
    ? canonical
    : undefined;
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
    if (/\bnon[-\s]+internships?\b/i.test(match[2]!) || /\bfellowships?\b/i.test(match[2]!)) {
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
  inheritedCompany?: string,
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
  if (zapplyShape && !internshipSection) return { kind: "non-internship" };
  const applyMarkup = cells[applyIndex]?.markup ?? "";
  const applyUrl = applicationUrl(applyMarkup);
  const descriptionUrl = simplifyMirrorUrl(applyMarkup);
  const rawCompany = cells[companyIndex]?.text ?? "";
  const normalizedRawCompany = normalizeSpace(rawCompany);
  const company = zapplyShape
    ? companyFromProgramName(title)
    : normalizedRawCompany === "↳"
      ? inheritedCompany ?? ""
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
      ...(descriptionUrl && descriptionUrl !== applyUrl ? { descriptionUrl } : {}),
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
    let previousCompany: string | undefined;
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
        previousCompany = undefined;
        continue;
      }
      const cells = rawCells.map((markup) => ({ text: markdownText(markup), markup }));
      const outcome = parsedTableRow(headers, cells, raw, rowLine + 1, internshipSection, previousCompany);
      previousCompany = outcome.kind === "row" ? outcome.row.company : undefined;
      collectOutcome(outcome, rows, counts);
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
    let previousCompany: string | undefined;
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
      if (rawCells.length === 0) {
        previousCompany = undefined;
        continue;
      }
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
        previousCompany = undefined;
        counts.unusable += 1;
        continue;
      }
      const outcome = parsedTableRow(
        headers,
        cells,
        rowMatch[0],
        rowLine,
        internshipSection,
        previousCompany,
      );
      previousCompany = outcome.kind === "row" ? outcome.row.company : undefined;
      collectOutcome(outcome, rows, counts);
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
interface GreenhouseSource {
  readonly endpoint: URL;
  readonly jobId: string;
}

function greenhouseSource(value: URL): GreenhouseSource | undefined {
  let board: string | undefined;
  let jobId: string | undefined;
  if (value.hostname === "www.jumptrading.com") {
    const candidateJobId = value.pathname === "/hr/job" ? value.searchParams.get("gh_jid") : undefined;
    if (!candidateJobId || !/^[0-9]{1,20}$/.test(candidateJobId)) return undefined;
    board = "jumptrading";
    jobId = candidateJobId;
  } else if (value.hostname === "www.hudsonrivertrading.com") {
    const candidateJobId = value.pathname === "/careers/job/"
      ? value.searchParams.get("gh_jid")
      : undefined;
    if (!candidateJobId || !/^[0-9]{1,20}$/.test(candidateJobId)) return undefined;
    board = "wehrtyou";
    jobId = candidateJobId;
  } else if (value.hostname === "www.janestreet.com") {
    const match = /^\/join-jane-street\/position\/([0-9]{1,20})\/?$/.exec(value.pathname);
    if (!match) return undefined;
    board = "janestreet";
    jobId = match[1];
  } else if (value.hostname === "www.tower-research.com") {
    const candidateJobId = value.pathname === "/open-positions/"
      ? value.searchParams.get("gh_jid")
      : undefined;
    if (!candidateJobId || !/^[0-9]{1,20}$/.test(candidateJobId)) return undefined;
    board = "towerresearchcapital";
    jobId = candidateJobId;
  } else if (value.hostname === "tifin.com") {
    const candidateJobId = value.pathname === "/careers/apply/"
      ? value.searchParams.get("gh_jid")
      : undefined;
    if (!candidateJobId || !/^[0-9]{1,20}$/.test(candidateJobId)) return undefined;
    board = "tifin";
    jobId = candidateJobId;
  } else if (value.hostname === "www.oldmissioncapital.com") {
    const candidateJobId = value.pathname === "/careers/"
      ? value.searchParams.get("gh_jid")
      : undefined;
    if (!candidateJobId || !/^[0-9]{1,20}$/.test(candidateJobId)) return undefined;
    board = "oldmissioncapital";
    jobId = candidateJobId;
  } else if (value.hostname === "www.samsara.com") {
    const match = /^\/company\/careers\/roles\/([0-9]{1,20})\/?$/.exec(value.pathname);
    const candidateJobId = value.searchParams.get("gh_jid");
    if (!match || candidateJobId !== match[1]) return undefined;
    board = "samsara";
    jobId = match[1];
  } else if (value.hostname !== "job-boards.greenhouse.io" && value.hostname !== "boards.greenhouse.io") {
    return undefined;
  }
  const standard = /^\/([A-Za-z0-9_-]{1,100})\/jobs\/([0-9]{1,20})\/?$/.exec(value.pathname);
  if (standard) {
    board = standard[1];
    jobId = standard[2];
  } else if (value.hostname === "boards.greenhouse.io" && value.pathname === "/embed/job_app") {
    const candidateBoard = value.searchParams.get("for");
    const candidateJobId = value.searchParams.get("gh_jid");
    if (
      candidateBoard
      && /^[A-Za-z0-9_-]{1,100}$/.test(candidateBoard)
      && candidateJobId
      && /^[0-9]{1,20}$/.test(candidateJobId)
    ) {
      board = candidateBoard;
      jobId = candidateJobId;
    }
  }
  if (!board || !jobId) return undefined;
  return {
    endpoint: new URL(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}`),
    jobId,
  };
}

async function loadGreenhouseDescription(
  client: SafePublicHttpClient,
  source: GreenhouseSource,
  signal: AbortSignal,
): Promise<string | undefined> {
  const response = await client.get(source.endpoint, {
    signal,
    allowedHosts: ["boards-api.greenhouse.io"],
    acceptedMediaTypes: ["application/json"],
    maxBodyBytes: 1024 * 1024,
    maxRedirects: 0,
  });
  if (response.status < 200 || response.status > 299) return undefined;
  const document = response.json<unknown>();
  if (typeof document !== "object" || document === null || Array.isArray(document)) return undefined;
  const record = document as Readonly<Record<string, unknown>>;
  const id = record.id;
  if (
    (typeof id !== "string" && (typeof id !== "number" || !Number.isSafeInteger(id)))
    || String(id) !== source.jobId
  ) {
    return undefined;
  }
  const content = nonemptyString(record.content);
  return content ? sanitizeDescription(content, "html") : undefined;
}

interface SmartRecruitersSource {
  readonly endpoint: URL;
  readonly postingId: string;
}

function smartRecruitersSource(value: URL): SmartRecruitersSource | undefined {
  if (value.hostname !== "jobs.smartrecruiters.com") return undefined;
  const match = /^\/([A-Za-z0-9_-]{1,100})\/([0-9]{1,20})(?:-[^/]*)?\/?$/.exec(value.pathname);
  if (!match) return undefined;
  const endpoint = new URL(
    `https://api.smartrecruiters.com/v1/companies/${match[1]}/postings/${match[2]}`,
  );
  return { endpoint, postingId: match[2]! };
}

async function loadSmartRecruitersDescription(
  client: SafePublicHttpClient,
  source: SmartRecruitersSource,
  signal: AbortSignal,
): Promise<string | undefined> {
  const response = await client.get(source.endpoint, {
    signal,
    allowedHosts: ["api.smartrecruiters.com"],
    acceptedMediaTypes: ["application/json"],
    maxBodyBytes: 1024 * 1024,
    maxRedirects: 0,
  });
  if (response.status < 200 || response.status > 299) return undefined;
  const document = response.json<unknown>();
  if (typeof document !== "object" || document === null || Array.isArray(document)) return undefined;
  const record = document as Readonly<Record<string, unknown>>;
  if (nonemptyString(record.id) !== source.postingId) return undefined;
  const jobAd = record.jobAd;
  if (typeof jobAd !== "object" || jobAd === null || Array.isArray(jobAd)) return undefined;
  const sections = (jobAd as Readonly<Record<string, unknown>>).sections;
  if (typeof sections !== "object" || sections === null || Array.isArray(sections)) return undefined;
  const sectionRecord = sections as Readonly<Record<string, unknown>>;
  const fragments = ["jobDescription", "qualifications", "additionalInformation"]
    .map((name) => sectionRecord[name])
    .map((section) => (
      typeof section === "object" && section !== null && !Array.isArray(section)
        ? nonemptyString((section as Readonly<Record<string, unknown>>).text)
        : undefined
    ))
    .filter((fragment): fragment is string => Boolean(fragment));
  if (fragments.length === 0) return undefined;
  return sanitizeDescription(fragments.join("\n"), "html");
}

interface WorkableSource {
  readonly endpoint: URL;
  readonly shortcode: string;
}

function workableSource(value: URL): WorkableSource | undefined {
  if (value.hostname !== "apply.workable.com") return undefined;
  const match = /^\/([A-Za-z0-9_-]{1,100})\/j\/([A-Za-z0-9_-]{1,32})\/?$/.exec(value.pathname);
  if (!match) return undefined;
  return {
    endpoint: new URL(`https://apply.workable.com/api/v2/accounts/${match[1]}/jobs/${match[2]}`),
    shortcode: match[2]!,
  };
}

async function loadWorkableDescription(
  client: SafePublicHttpClient,
  source: WorkableSource,
  signal: AbortSignal,
): Promise<string | undefined> {
  const response = await client.get(source.endpoint, {
    signal,
    allowedHosts: ["apply.workable.com"],
    acceptedMediaTypes: ["application/json"],
    maxBodyBytes: 1024 * 1024,
    maxRedirects: 0,
  });
  if (response.status < 200 || response.status > 299) return undefined;
  const document = response.json<unknown>();
  if (typeof document !== "object" || document === null || Array.isArray(document)) return undefined;
  const record = document as Readonly<Record<string, unknown>>;
  if (record.state !== "published" || nonemptyString(record.shortcode) !== source.shortcode) return undefined;
  const fragments = ["description", "requirements", "benefits"]
    .map((name) => nonemptyString(record[name]))
    .filter((fragment): fragment is string => Boolean(fragment));
  if (fragments.length === 0) return undefined;
  return sanitizeDescription(fragments.join("\n"), "html");
}

interface LeverSource {
  readonly endpoint: URL;
  readonly postingId: string;
}

function leverSource(value: URL): LeverSource | undefined {
  if (value.hostname !== "jobs.lever.co" && value.hostname !== "jobs.eu.lever.co") return undefined;
  const match = /^\/([A-Za-z0-9_-]{1,100})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/apply)?\/?$/i
    .exec(value.pathname);
  if (!match) return undefined;
  const apiHost = value.hostname === "jobs.eu.lever.co" ? "api.eu.lever.co" : "api.lever.co";
  const endpoint = new URL(`https://${apiHost}/v0/postings/${match[1]}/${match[2]}`);
  endpoint.searchParams.set("mode", "json");
  return { endpoint, postingId: match[2]! };
}

interface LeverLoadResult {
  readonly description?: string;
  readonly pageFallback: boolean;
}

async function loadLeverDescription(
  client: SafePublicHttpClient,
  source: LeverSource,
  signal: AbortSignal,
): Promise<LeverLoadResult> {
  const response = await client.get(source.endpoint, {
    signal,
    allowedHosts: [source.endpoint.hostname],
    acceptedMediaTypes: ["application/json"],
    maxBodyBytes: 1024 * 1024,
    maxRedirects: 0,
  });
  if (response.status === 404) return { pageFallback: true };
  if (response.status < 200 || response.status > 299) return { pageFallback: false };
  const document = response.json<unknown>();
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { pageFallback: false };
  }
  const record = document as Readonly<Record<string, unknown>>;
  if (nonemptyString(record.id)?.toLowerCase() !== source.postingId.toLowerCase()) {
    return { pageFallback: false };
  }
  const description = nonemptyString(record.descriptionPlain);
  const fragments = (description
    ? [description]
    : [nonemptyString(record.openingPlain), nonemptyString(record.descriptionBodyPlain)])
    .filter((fragment): fragment is string => Boolean(fragment));
  if (Array.isArray(record.lists)) {
    for (const list of record.lists) {
      if (typeof list !== "object" || list === null || Array.isArray(list)) continue;
      const content = nonemptyString((list as Readonly<Record<string, unknown>>).content);
      if (content) fragments.push(content);
    }
  }
  const additional = nonemptyString(record.additionalPlain);
  if (additional) fragments.push(additional);
  if (fragments.length === 0) return { pageFallback: false };
  const sanitized = await sanitizeDescription(fragments.join("\n"), "html");
  return sanitized ? { description: sanitized, pageFallback: false } : { pageFallback: false };
}

async function loadLeverPageDescription(
  client: SafePublicHttpClient,
  sourceUrl: URL,
  company: string,
  title: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const response = await client.get(sourceUrl, {
    signal,
    allowedHosts: [sourceUrl.hostname],
    acceptedMediaTypes: ["text/html", "application/xhtml+xml"],
    maxBodyBytes: 1024 * 1024,
    maxRedirects: 0,
  });
  if (response.status < 200 || response.status > 299) return undefined;
  const expectedCompany = normalizedJobIdentity(company);
  const expectedTitle = normalizedLeverTitle(title);
  for (const value of await captureJsonLd(response.text())) {
    const postings: Readonly<Record<string, unknown>>[] = [];
    visitJsonObjects(value, (record) => {
      const type = record["@type"];
      if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) {
        postings.push(record);
      }
    });
    for (const posting of postings) {
      const organization = posting.hiringOrganization;
      const candidateCompany = typeof organization === "object" && organization !== null && !Array.isArray(organization)
        ? nonemptyString((organization as Readonly<Record<string, unknown>>).name)
        : undefined;
      const candidateTitle = nonemptyString(posting.title);
      if (
        !candidateCompany
        || !candidateTitle
        || normalizedJobIdentity(candidateCompany) !== expectedCompany
      ) {
        continue;
      }
      const normalizedTitle = normalizedLeverTitle(candidateTitle);
      if (normalizedTitle !== expectedTitle) continue;
      const description = nonemptyString(posting.description);
      if (!description) continue;
      const sanitized = await sanitizeDescription(description, "html");
      if (sanitized) return sanitized;
    }
  }
  return undefined;
}

interface AshbySource {
  readonly boardUrl: URL;
  readonly jobId: string;
}

interface AshbyDescription {
  readonly value: string;
  readonly format: "html" | "text";
}

type AshbyBoardCache = Map<string, Promise<ReadonlyMap<string, AshbyDescription> | undefined>>;

function ashbySource(value: URL): AshbySource | undefined {
  if (value.hostname !== "jobs.ashbyhq.com") return undefined;
  const match = /^\/([A-Za-z0-9_-]{1,100})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/application)?\/?$/i
    .exec(value.pathname);
  if (!match) return undefined;
  return {
    boardUrl: new URL(`https://api.ashbyhq.com/posting-api/job-board/${match[1]}`),
    jobId: match[2]!,
  };
}

async function loadAshbyBoard(
  client: SafePublicHttpClient,
  source: AshbySource,
  cache: AshbyBoardCache,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, AshbyDescription> | undefined> {
  let pending = cache.get(source.boardUrl.href);
  if (!pending) {
    pending = (async () => {
      const response = await client.get(source.boardUrl, {
        signal,
        allowedHosts: ["api.ashbyhq.com"],
        acceptedMediaTypes: ["application/json"],
        maxBodyBytes: 8 * 1024 * 1024,
        maxRedirects: 0,
      });
      if (response.status < 200 || response.status > 299) return undefined;
      const document = response.json<unknown>();
      if (typeof document !== "object" || document === null || Array.isArray(document)) return undefined;
      const jobs = (document as Readonly<Record<string, unknown>>).jobs;
      if (!Array.isArray(jobs)) return undefined;
      const descriptions = new Map<string, AshbyDescription>();
      for (const job of jobs) {
        if (typeof job !== "object" || job === null || Array.isArray(job)) continue;
        const record = job as Readonly<Record<string, unknown>>;
        const id = nonemptyString(record.id);
        if (!id || !/^[0-9a-f-]{36}$/i.test(id)) continue;
        const html = nonemptyString(record.descriptionHtml);

        const text = nonemptyString(record.descriptionPlain);
        if (html) descriptions.set(id.toLowerCase(), { value: html, format: "html" });
        else if (text) descriptions.set(id.toLowerCase(), { value: text, format: "text" });
      }
      return descriptions;
    })();
    cache.set(source.boardUrl.href, pending);
  }
  return pending;
}

async function loadAshbyDescription(
  client: SafePublicHttpClient,
  source: AshbySource,
  cache: AshbyBoardCache,
  signal: AbortSignal,
): Promise<string | undefined> {
  const board = await loadAshbyBoard(client, source, cache, signal);
  const description = board?.get(source.jobId.toLowerCase());
  return description ? sanitizeDescription(description.value, description.format) : undefined;
}
interface AppleJobSource {
  readonly endpoint: URL;
  readonly baseId: string;
  readonly jobNumber: string;
}

function appleJobSource(value: URL): AppleJobSource | undefined {
  if (value.hostname !== "jobs.apple.com") return undefined;
  const match = /^\/([A-Za-z]{2}-[A-Za-z]{2})\/details\/((?:[0-9]{1,20}(?:-[0-9]{1,10})?|PIPE-[0-9]{1,20}))\/[A-Za-z0-9-]{1,200}\/?$/
    .exec(value.pathname);
  if (!match) return undefined;
  const apiId = match[2]!;
  const jobNumber = apiId.startsWith("PIPE-") ? apiId.slice(5) : apiId;
  const baseId = jobNumber.split("-", 1)[0]!;
  const endpoint = new URL(`https://jobs.apple.com/api/v1/jobDetails/${apiId}`);
  endpoint.searchParams.set("locale", match[1]!.toLowerCase());
  return { endpoint, baseId, jobNumber };
}

async function loadAppleJobDescription(
  client: SafePublicHttpClient,
  source: AppleJobSource,
  signal: AbortSignal,
): Promise<string | undefined> {
  const response = await client.get(source.endpoint, {
    signal,
    allowedHosts: ["jobs.apple.com"],
    acceptedMediaTypes: ["application/json"],
    maxBodyBytes: 1024 * 1024,
    maxRedirects: 0,
  });
  if (response.status < 200 || response.status > 299) return undefined;
  const document = response.json<unknown>();
  if (typeof document !== "object" || document === null || Array.isArray(document)) return undefined;
  const value = (document as Readonly<Record<string, unknown>>).res;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    nonemptyString(record.jobNumber) !== source.jobNumber
    || nonemptyString(record.positionId) !== source.baseId
    || nonemptyString(record.id) !== `PIPE-${source.baseId}`
    || nonemptyString(record.reqId) !== `PIPE-${source.baseId}`
    || !nonemptyString(record.postingTitle)
  ) {
    return undefined;
  }
  const fragments = ["jobSummary", "description", "minimumQualifications", "preferredQualifications"]
    .map((name) => nonemptyString(record[name]))
    .filter((fragment): fragment is string => Boolean(fragment));
  if (fragments.length === 0) return undefined;
  return sanitizeDescription(fragments.join("\n"), "html");
}

interface OracleCandidateSource {
  readonly endpoint: URL;
  readonly requisitionId: string;
}

function oracleCandidateSource(value: URL): OracleCandidateSource | undefined {
  if (
    !/^(?:[a-z0-9-]{1,63}\.)?fa(?:\.[a-z0-9-]{1,63})?\.oraclecloud\.com$/i.test(value.hostname)
  ) {
    return undefined;
  }
  const match = /^\/hcmUI\/CandidateExperience\/[A-Za-z0-9_-]{1,32}\/sites\/([A-Za-z0-9_-]{1,64})\/job\/([0-9]{1,32})\/?$/
    .exec(value.pathname);
  if (!match) return undefined;
  const endpoint = new URL("/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails", value);
  endpoint.search = `?expand=all&onlyData=true&finder=ById;Id=%22${match[2]}%22,siteNumber=${match[1]}`;
  return { endpoint, requisitionId: match[2]! };
}

async function loadOracleCandidateDescription(
  client: SafePublicHttpClient,
  source: OracleCandidateSource,
  signal: AbortSignal,
): Promise<string | undefined> {
  const response = await client.get(source.endpoint, {
    signal,
    allowedHosts: [source.endpoint.hostname],
    acceptedMediaTypes: ["application/json", "application/vnd.oracle.adf.resourcecollection+json"],
    maxBodyBytes: 1024 * 1024,
    maxRedirects: 0,
  });
  if (response.status < 200 || response.status > 299) return undefined;
  const document = response.json<unknown>();
  if (typeof document !== "object" || document === null || Array.isArray(document)) return undefined;
  const items = (document as Readonly<Record<string, unknown>>).items;
  if (!Array.isArray(items) || items.length !== 1) return undefined;
  const item = items[0];
  if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
  const record = item as Readonly<Record<string, unknown>>;
  const id = record.Id;
  if (
    (typeof id !== "string" && (typeof id !== "number" || !Number.isSafeInteger(id)))
    || String(id) !== source.requisitionId
  ) {
    return undefined;
  }
  const description = nonemptyString(record.ExternalDescriptionStr);
  return description ? sanitizeDescription(description, "html") : undefined;
}


interface PublicSupplierSource {
  readonly endpoint: URL;
  readonly postingId: string;
  readonly headers: Readonly<Record<string, string>>;
}

function publicSupplierSource(value: URL): PublicSupplierSource | undefined {
  let postingId: string | undefined;
  let endpointOrigin: string | undefined;
  let origin: string | undefined;
  let websitePath: string | undefined;
  if (value.hostname === "lifeattiktok.com") {
    postingId = /^\/(?:[A-Za-z]{2}(?:-[A-Za-z]{2})?\/)?search\/([0-9]{1,32})\/?$/.exec(value.pathname)?.[1];
    endpointOrigin = "https://api.lifeattiktok.com";
    origin = "https://lifeattiktok.com";
    websitePath = "tiktok";
  } else if (value.hostname === "joinbytedance.com") {
    postingId = /^\/(?:[A-Za-z]{2}(?:-[A-Za-z]{2})?\/)?search\/([0-9]{1,32})\/?$/.exec(value.pathname)?.[1];
    endpointOrigin = "https://jobs.bytedance.com";
    origin = "https://joinbytedance.com";
    websitePath = "en";
  } else if (value.hostname === "jobs.bytedance.com") {
    postingId = /^\/[A-Za-z]{2}(?:-[A-Za-z]{2})?\/position\/([0-9]{1,32})\/detail\/?$/
      .exec(value.pathname)?.[1];
    endpointOrigin = "https://jobs.bytedance.com";
    origin = "https://joinbytedance.com";
    websitePath = "en";
  }
  if (!postingId || !endpointOrigin || !origin || !websitePath) return undefined;
  return {
    endpoint: new URL(`/api/v1/public/supplier/job/posts/${postingId}`, endpointOrigin),
    postingId,
    headers: {
      "accept-language": "en-US",
      "content-type": "application/json",
      origin,
      "website-path": websitePath,
    },
  };
}

async function loadPublicSupplierDescription(
  client: SafePublicHttpClient,
  source: PublicSupplierSource,
  signal: AbortSignal,
): Promise<string | undefined> {
  const response = await client.post(
    source.endpoint,
    JSON.stringify({ job_post_id: source.postingId }),
    {
      signal,
      headers: source.headers,
      allowedHosts: [source.endpoint.hostname],
      acceptedMediaTypes: ["application/json"],
      maxBodyBytes: 1024 * 1024,
      maxRedirects: 0,
    },
  );
  if (response.status < 200 || response.status > 299) return undefined;
  const document = response.json<unknown>();
  if (typeof document !== "object" || document === null || Array.isArray(document)) return undefined;
  const envelope = document as Readonly<Record<string, unknown>>;
  if (envelope.code !== 0) return undefined;
  const data = envelope.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const detail = (data as Readonly<Record<string, unknown>>).job_post_detail;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return undefined;
  const record = detail as Readonly<Record<string, unknown>>;
  if (record.id !== source.postingId || !nonemptyString(record.title)) return undefined;
  const description = nonemptyString(record.description);
  const requirement = nonemptyString(record.requirement);
  if (!description) return undefined;
  const combined = requirement ? `${description}\n\nQualifications\n${requirement}` : description;
  return sanitizeDescription(combined, "text");
}

function safeWorkdayPathSegment(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    if (
      !decoded
      || decoded === "."
      || decoded === ".."
      || decoded.includes("/")
      || decoded.includes("\\")
      || decoded.length > 500
    ) {
      return undefined;
    }
    return encodeURIComponent(decoded);
  } catch {
    return undefined;
  }
}

function workdayCxsUrl(value: URL, tenantOverride?: string): URL | undefined {
  const labels = value.hostname.toLowerCase().split(".");
  const rawSegments = value.pathname.split("/").filter(Boolean);
  const jobIndex = rawSegments.findIndex((segment) => segment.toLowerCase() === "job");
  if (jobIndex < 1 || jobIndex === rawSegments.length - 1) return undefined;
  let tenant: string | undefined;
  if (
    labels.length === 4
    && /^wd\d+$/.test(labels[1] ?? "")
    && labels[2] === "myworkdayjobs"
    && labels[3] === "com"
    && (jobIndex === 1 || jobIndex === 2)
  ) {
    tenant = tenantOverride ?? labels[0];
  } else if (
    labels.length === 3
    && /^wd\d+$/.test(labels[0] ?? "")
    && labels[1] === "myworkdaysite"
    && labels[2] === "com"
    && rawSegments[0]?.toLowerCase() === "recruiting"
    && jobIndex === 3
  ) {
    tenant = tenantOverride ?? safeWorkdayPathSegment(rawSegments[1] ?? "");
  }
  if (!tenant || !/^[a-z0-9_-]{1,100}$/i.test(tenant)) return undefined;
  const postingSegments = rawSegments.slice(jobIndex - 1).map(safeWorkdayPathSegment);
  if (postingSegments.some((segment) => segment === undefined)) return undefined;
  const endpoint = new URL(value.origin);
  endpoint.pathname = `/wday/cxs/${tenant}/${postingSegments.join("/")}`;
  return endpoint;
}

interface WorkdaySiteConfig {
  readonly tenant: string;
  readonly site: string;
}

type WorkdaySiteConfigCache = Map<string, Promise<WorkdaySiteConfig | undefined>>;

function workdaySiteConfigUrl(value: URL): { readonly endpoint: URL; readonly site: string } | undefined {
  const labels = value.hostname.toLowerCase().split(".");
  if (
    labels.length !== 4
    || !/^wd\d+$/.test(labels[1] ?? "")
    || labels[2] !== "myworkdayjobs"
    || labels[3] !== "com"
  ) {
    return undefined;
  }
  const rawSegments = value.pathname.split("/").filter(Boolean);
  const jobIndex = rawSegments.findIndex((segment) => segment.toLowerCase() === "job");
  if (jobIndex !== 1 && jobIndex !== 2) return undefined;
  const encodedSite = safeWorkdayPathSegment(rawSegments[jobIndex - 1] ?? "");
  if (!encodedSite) return undefined;
  const site = decodeURIComponent(encodedSite);
  const endpoint = new URL(value.origin);
  endpoint.pathname = `/${encodedSite}`;
  return { endpoint, site };
}

async function loadWorkdaySiteConfig(
  client: SafePublicHttpClient,
  sourceUrl: URL,
  cache: WorkdaySiteConfigCache,
  signal: AbortSignal,
): Promise<WorkdaySiteConfig | undefined> {
  const source = workdaySiteConfigUrl(sourceUrl);
  if (!source) return undefined;
  let pending = cache.get(source.endpoint.href);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await client.get(source.endpoint, {
          signal,
          allowedHosts: [sourceUrl.hostname],
          acceptedMediaTypes: ["text/html", "application/xhtml+xml"],
          maxBodyBytes: 256 * 1024,
          maxRedirects: 0,
        });
        if (response.status < 200 || response.status > 299) return undefined;
        const assignment = /window\.workday\s*=\s*window\.workday\s*\|\|\s*\{([\s\S]{0,100000}?)\};/i
          .exec(response.text())?.[1];
        if (!assignment) return undefined;
        const tenant = /\btenant\s*:\s*["']([A-Za-z0-9_-]{1,100})["']/i.exec(assignment)?.[1];
        const site = /\bsiteId\s*:\s*["']([A-Za-z0-9_-]{1,100})["']/i.exec(assignment)?.[1];
        return tenant && site === source.site ? { tenant, site } : undefined;
      } catch (error) {
        signal.throwIfAborted();
        return undefined;
      }
    })();
    cache.set(source.endpoint.href, pending);
  }
  return pending;
}

interface WorkdayPostingIdentity {
  readonly tenant: string;
  readonly shard: string;
  readonly site: string;
  readonly postingPath: string;
}

function workdayPostingIdentity(value: URL): WorkdayPostingIdentity | undefined {
  if (!workdayCxsUrl(value)) return undefined;
  const segments = value.pathname.split("/").filter(Boolean);
  const jobIndex = segments.findIndex((segment) => segment.toLowerCase() === "job");
  const encodedSite = safeWorkdayPathSegment(segments[jobIndex - 1] ?? "");
  const postingSegments = segments.slice(jobIndex + 1).map(safeWorkdayPathSegment);
  if (!encodedSite || postingSegments.length === 0 || postingSegments.some((segment) => !segment)) {
    return undefined;
  }
  const labels = value.hostname.toLowerCase().split(".");
  const myWorkdayJobs = labels[2] === "myworkdayjobs";
  const encodedTenant = myWorkdayJobs
    ? safeWorkdayPathSegment(labels[0] ?? "")
    : safeWorkdayPathSegment(segments[1] ?? "");
  const shard = myWorkdayJobs ? labels[1] : labels[0];
  if (!encodedTenant || !shard) return undefined;
  return {
    tenant: decodeURIComponent(encodedTenant).toLowerCase(),
    shard,
    site: decodeURIComponent(encodedSite).toLowerCase(),
    postingPath: postingSegments.join("/"),
  };
}

async function workdayDescriptionFromJson(
  value: unknown,
  sourceUrl: URL,
): Promise<string | undefined> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const posting = (value as Readonly<Record<string, unknown>>).jobPostingInfo;
  if (typeof posting !== "object" || posting === null || Array.isArray(posting)) return undefined;
  const record = posting as Readonly<Record<string, unknown>>;
  const externalUrl = absolutePublicUrl(nonemptyString(record.externalUrl) ?? "");
  if (!externalUrl) return undefined;
  const external = new URL(externalUrl);
  const expected = workdayPostingIdentity(sourceUrl);
  const actual = workdayPostingIdentity(external);
  if (
    !expected
    || !actual
    || actual.tenant !== expected.tenant
    || actual.shard !== expected.shard
    || actual.site !== expected.site
    || actual.postingPath !== expected.postingPath
  ) {
    return undefined;
  }
  const description = nonemptyString(record.jobDescription);
  return description ? sanitizeDescription(description, "html") : undefined;
}

async function loadWorkdayDescription(
  client: SafePublicHttpClient,
  sourceUrl: URL,
  configCache: WorkdaySiteConfigCache,
  signal: AbortSignal,
): Promise<string | undefined> {
  const endpoint = workdayCxsUrl(sourceUrl);
  if (!endpoint) return undefined;
  const response = await client.get(endpoint, {
    signal,
    allowedHosts: [sourceUrl.hostname],
    acceptedMediaTypes: ["application/json"],
    maxBodyBytes: 1024 * 1024,
  });
  if (response.status >= 200 && response.status <= 299) {
    return workdayDescriptionFromJson(response.json<unknown>(), sourceUrl);
  }
  if (response.status !== 422) return undefined;
  const config = await loadWorkdaySiteConfig(client, sourceUrl, configCache, signal);
  if (!config) return undefined;
  const correctedEndpoint = workdayCxsUrl(sourceUrl, config.tenant);
  if (!correctedEndpoint || correctedEndpoint.href === endpoint.href) return undefined;
  const corrected = await client.get(correctedEndpoint, {
    signal,
    allowedHosts: [sourceUrl.hostname],
    acceptedMediaTypes: ["application/json"],
    maxBodyBytes: 1024 * 1024,
  });
  if (corrected.status < 200 || corrected.status > 299) return undefined;
  return workdayDescriptionFromJson(corrected.json<unknown>(), sourceUrl);
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

function normalizedJobIdentity(value: string): string {
  return normalizeSpace(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizedLeverTitle(value: string): string {
  const withoutSeasonPrefix = normalizeSpace(value).replace(
    /^(?:fall|winter|spring|summer)\s+20\d{2}\s+(?:co[- ]?op\s+)?/i,
    "",
  );
  return normalizedJobIdentity(withoutSeasonPrefix);
}

async function loadSimplifyMirrorDescription(
  client: SafePublicHttpClient,
  url: string,
  company: string,
  title: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const sourceUrl = new URL(url);
    if (sourceUrl.hostname !== "simplify.jobs" || !/^\/p\/[0-9a-f-]{36}$/i.test(sourceUrl.pathname)) {
      return undefined;
    }
    const response = await client.get(sourceUrl, {
      signal,
      allowedHosts: ["simplify.jobs"],
      acceptedMediaTypes: ["text/html", "application/xhtml+xml"],
      maxBodyBytes: 1024 * 1024,
    });
    if (response.status < 200 || response.status > 299) return undefined;
    const candidates: Readonly<Record<string, unknown>>[] = [];
    for (const value of await captureJsonLd(response.text())) {
      visitJsonObjects(value, (record) => {
        const type = record["@type"];
        if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) {
          candidates.push(record);
        }
      });
    }
    const expectedCompany = normalizedJobIdentity(company);
    const expectedTitle = normalizedJobIdentity(title);
    for (const candidate of candidates) {
      const candidateTitle = nonemptyString(candidate.title);
      const organization = candidate.hiringOrganization;
      const candidateCompany = typeof organization === "object" && organization !== null && !Array.isArray(organization)
        ? nonemptyString((organization as Readonly<Record<string, unknown>>).name)
        : undefined;
      if (
        !candidateTitle
        || !candidateCompany
        || normalizedJobIdentity(candidateTitle) !== expectedTitle
        || normalizedJobIdentity(candidateCompany) !== expectedCompany
      ) {
        continue;
      }
      const description = nonemptyString(candidate.description);
      if (!description) continue;
      const sanitized = await sanitizeDescription(description, "html");
      if (sanitized) return sanitized;
    }
    return undefined;
  } catch (error) {
    signal.throwIfAborted();
    return undefined;
  }
}

async function loadDescription(
  client: SafePublicHttpClient,
  url: string,
  company: string,
  title: string,
  workdayConfigCache: WorkdaySiteConfigCache,
  ashbyBoardCache: AshbyBoardCache,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const sourceUrl = new URL(url);
    const greenhouse = greenhouseSource(sourceUrl);
    if (greenhouse) {
      return await loadGreenhouseDescription(client, greenhouse, signal);
    }
    const smartRecruiters = smartRecruitersSource(sourceUrl);
    if (smartRecruiters) {
      return await loadSmartRecruitersDescription(client, smartRecruiters, signal);
    }
    const workable = workableSource(sourceUrl);
    if (workable) {
      return await loadWorkableDescription(client, workable, signal);
    }
    const lever = leverSource(sourceUrl);
    if (lever) {
      const result = await loadLeverDescription(client, lever, signal);
      if (result.description) return result.description;
      return result.pageFallback
        ? await loadLeverPageDescription(client, sourceUrl, company, title, signal)
        : undefined;
    }
    const ashby = ashbySource(sourceUrl);
    if (ashby) {
      return await loadAshbyDescription(client, ashby, ashbyBoardCache, signal);
    }
    const apple = appleJobSource(sourceUrl);
    if (apple) {
      return await loadAppleJobDescription(client, apple, signal);
    }
    const oracle = oracleCandidateSource(sourceUrl);
    if (oracle) {
      return await loadOracleCandidateDescription(client, oracle, signal);
    }
    const supplier = publicSupplierSource(sourceUrl);
    if (supplier) {
      return await loadPublicSupplierDescription(client, supplier, signal);
    }
    if (workdayCxsUrl(sourceUrl)) {
      return await loadWorkdayDescription(client, sourceUrl, workdayConfigCache, signal);
    }
    const response = await client.get(url, {
      signal,
      acceptedMediaTypes: ["text/html", "application/xhtml+xml", "text/plain", "application/ld+json", "application/json"],
      maxBodyBytes: 1024 * 1024,
    });
    if (response.status < 200 || response.status > 299) return undefined;
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType === "text/plain") return sanitizeDescription(response.text(), "text");
    const description = mediaType === "application/json" || mediaType === "application/ld+json"
      ? await sanitizedJsonDescription(response.json<unknown>(), false)
      : await descriptionFromHtml(response.text());
    return description ?? await loadWorkdayDescription(client, response.url, workdayConfigCache, signal);
  } catch (error) {
    signal.throwIfAborted();
    return undefined;
  }
}

function requisitionFromUrl(url: string): string | undefined {
  const parsed = new URL(url);
  if (workdayCxsUrl(parsed)) {
    const postingSegment = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? "");
    const prefixed = /(?:^|_)((?:REQ|JR|R)[-_]?[A-Za-z0-9.-]+)$/i.exec(postingSegment)?.[1];
    const suffix = /_([A-Za-z0-9.-]{3,100})$/.exec(postingSegment)?.[1];
    const requisitionId = nonemptyString(prefixed ?? suffix ?? "");
    if (requisitionId) return requisitionId;
  }
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
  let cachedMarkdown: string | undefined;
  let cachedRevision: string | undefined;
  return {
    id: config.id,
    name: config.name,
    kind: config.kind,
    async sync(signal, context, budget) {
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
            const compact = encoded.replace(/\s/g, "");
            if (
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)
            ) {
              throw new Error("Invalid base64");
            }
            const decoded = Buffer.from(compact, "base64");
            if (decoded.toString("base64") !== compact) throw new Error("Invalid base64");
            markdown = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
          } catch (error) {
            throw new Error("GitHub discovery source is unavailable", { cause: error });
          }
          revision = nonemptyString(body.sha) ?? revision;
        } else {
          markdown = response.text();
        }
      }
      const parsed = await parseGitHubRepositoryTables(markdown, MAX_PARSED_RECORDS);
      type CandidateRow = {
        readonly row: ParsedGitHubTableRow;
        readonly canonicalUrl: string;
        readonly requisitionId: string | undefined;
        readonly sourceItemId: string;
      };
      const candidateRows: CandidateRow[] = [];
      let omittedRecords = parsed.unusableCount;
      const scannedRowCount = Math.min(parsed.rows.length, MAX_SCANNED_RECORDS);
      for (let index = 0; index < scannedRowCount; index += 1) {
        const row = parsed.rows[index]!;
        const canonicalUrl = canonicalizeJobUrl(row.applyUrl);
        if (!canonicalUrl) {
          omittedRecords += 1;
          continue;
        }
        const requisitionId = requisitionFromUrl(canonicalUrl);
        const sourceItemId = requisitionId
          ? `${config.id}:${requisitionId}:${stableSourceItemId(canonicalUrl)}`
          : `${config.id}:${stableSourceItemId(row.company, row.title, row.location ?? "", canonicalUrl)}`;
        candidateRows.push({
          row,
          canonicalUrl,
          requisitionId,
          sourceItemId,
        });
      }
      const knownItems = context?.findKnownItems(candidateRows.map(
        ({ sourceItemId, canonicalUrl }) => ({ sourceItemId, canonicalUrl }),
      )) ?? [];
      const knownBySourceItemId = new Map(
        knownItems.map((item) => [item.sourceItemId, item] as const),
      );
      const knownByCanonicalUrl = new Map<string, DiscoveryKnownItemKey>();
      for (const item of knownItems) {
        if (!knownByCanonicalUrl.has(item.canonicalUrl)) {
          knownByCanonicalUrl.set(item.canonicalUrl, item);
        }
      }
      type PreparedRow = CandidateRow & {
        readonly index: number;
        readonly remembered: DiscoveryKnownItemKey | undefined;
      };
      const preparedRows = candidateRows.map((candidate, index): PreparedRow => ({
        ...candidate,
        index,
        remembered: knownBySourceItemId.get(candidate.sourceItemId)
          ?? knownByCanonicalUrl.get(candidate.canonicalUrl),
      }));
      const selectedKnownKeys = new Map<string, DiscoveryKnownItemKey>();
      for (const { remembered } of preparedRows) {
        if (remembered !== undefined) {
          selectedKnownKeys.set(remembered.sourceItemId, remembered);
        }
      }
      const rememberedItems: DiscoveryKnownItem[] = [];
      const knownKeys = [...selectedKnownKeys.values()];
      for (let index = 0; index < knownKeys.length; index += config.maxRows) {
        rememberedItems.push(...(context?.loadKnownItems(
          knownKeys.slice(index, index + config.maxRows),
        ) ?? []));
      }
      const descriptionsBySourceItemId = new Map(
        rememberedItems.map((item) => [item.sourceItemId, item.description] as const),
      );
      const descriptionsByCanonicalUrl = new Map(
        rememberedItems.map((item) => [item.canonicalUrl, item.description] as const),
      );
      const descriptions = new Array<string | null>(preparedRows.length).fill(null);
      const unresolvedRows: PreparedRow[] = [];
      let reusedDescriptions = 0;
      for (const prepared of preparedRows) {
        let description: string | null | undefined;
        if (prepared.remembered !== undefined) {
          description = descriptionsBySourceItemId.get(prepared.remembered.sourceItemId);
          if (description === undefined) {
            description = descriptionsByCanonicalUrl.get(prepared.remembered.canonicalUrl);
          }
        }
        if (description !== null && description !== undefined) {
          descriptions[prepared.index] = description;
          reusedDescriptions += 1;
        } else {
          unresolvedRows.push(prepared);
        }
      }
      const selectedForDetail = unresolvedRows.slice(0, config.maxRows);
      const workdayConfigCache: WorkdaySiteConfigCache = new Map();
      const ashbyBoardCache: AshbyBoardCache = new Map();
      const enriched = await mapConcurrent(
        selectedForDetail,
        config.detailConcurrency,
        async (prepared): Promise<{ readonly index: number; readonly description: string | null }> => {
          const { canonicalUrl, row } = prepared;
          let description = await loadDescription(
            syncClient,
            canonicalUrl,
            row.company,
            row.title,
            workdayConfigCache,
            ashbyBoardCache,
            signal,
          );
          if (!description && row.descriptionUrl) {
            description = await loadSimplifyMirrorDescription(
              syncClient,
              row.descriptionUrl,
              row.company,
              row.title,
              signal,
            );
          }
          return { index: prepared.index, description: description ?? null };
        },
      );
      for (const item of enriched) descriptions[item.index] = item.description;
      let descriptionUnavailable = 0;
      const items = preparedRows.map((prepared): DiscoveredJobInput => {
        const { canonicalUrl, requisitionId, row, sourceItemId } = prepared;
        const description = descriptions[prepared.index] ?? null;
        if (description === null) descriptionUnavailable += 1;
        return {
          sourceItemId,
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
      const detailDeferred = unresolvedRows.length - selectedForDetail.length;
      const truncated = parsed.truncated || parsed.rows.length > MAX_SCANNED_RECORDS;
      const result: DiscoverySyncResult = {
        items,
        completeSnapshot: parsed.tableCount > 0
          && parsed.rows.length + parsed.closedCount + parsed.nonInternshipCount + parsed.unusableCount > 0
          && !truncated
          && omittedRecords === 0,
        descriptionUnavailable,
        provenance: `${config.owner}/${config.repo}@${revision}:${config.path}; tables: ${parsed.tableCount}; rows: ${parsed.rows.length}; candidates: ${candidateRows.length}; remembered: ${selectedKnownKeys.size}; descriptions reused: ${reusedDescriptions}; unresolved: ${unresolvedRows.length}; detail attempts: ${selectedForDetail.length}; detail deferred: ${detailDeferred}; descriptions unavailable: ${descriptionUnavailable}; closed: ${parsed.closedCount}; non-internships: ${parsed.nonInternshipCount}; omitted records: ${omittedRecords}`.slice(0, 500),
      };
      if (response.status !== 304) {
        etag = response.headers.get("etag") ?? undefined;
        cachedMarkdown = markdown;
        cachedRevision = revision;
      }
      return result;
    },
  };
}
