import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { ARTIFACT_LIMITS } from "../system/artifacts.ts";
import { runTrustedProcess, type ProcessBoundary, type TrustedProgram, type TrustedProcessResult } from "../system/process.ts";

export type DeterministicQaCheckId =
  | "pdfinfo-output"
  | "unencrypted"
  | "one-page"
  | "letter-size"
  | "text-output"
  | "required-headings"
  | "selected-evidence"
  | "font-output"
  | "embedded-fonts"
  | "word-bounds";

export interface DeterministicQaCheck {
  readonly id: DeterministicQaCheckId;
  readonly status: "pass" | "fail";
  readonly detail: string;
}

export interface DeterministicQaReport {
  readonly pass: boolean;
  readonly checks: readonly DeterministicQaCheck[];
  readonly warnings: readonly string[];
}

export interface DeterministicQaOptions {
  readonly pdfPath: string;
  readonly cwd: string;
  readonly requiredHeadings: readonly string[];
  readonly selectedEvidenceText: readonly string[];
  readonly latexLog?: string | Uint8Array;
  readonly signal?: AbortSignal;
  readonly boundary?: ProcessBoundary;
}

interface ToolOutput {
  readonly ok: boolean;
  readonly text: string;
  readonly reason: string;
}

interface PdfInfo {
  readonly pages: number;
  readonly encrypted: string;
  readonly width: number;
  readonly height: number;
  readonly mediaWidth: number;
  readonly mediaHeight: number;
  readonly cropWidth: number;
  readonly cropHeight: number;
}

interface TextOutput {
  readonly text: string;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly words: readonly WordBox[];
}

interface WordBox {
  readonly xMin: number;
  readonly yMin: number;
  readonly xMax: number;
  readonly yMax: number;
}

const TOOL_TIMEOUT_MS = 60_000;
const DETAIL_LIMIT = 240;
const WARNING_LIMIT = 100;
const WARNING_LENGTH_LIMIT = 500;
const WARNING_BYTES_LIMIT = 32 * 1024;
const LETTER_WIDTH = 612;
const LETTER_HEIGHT = 792;
const POINT_TOLERANCE = 0.5;

function detail(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length <= DETAIL_LIMIT ? normalized : `${normalized.slice(0, DETAIL_LIMIT - 1)}…`;
}

function check(id: DeterministicQaCheckId, pass: boolean, success: string, failure: string): DeterministicQaCheck {
  return Object.freeze({ id, status: pass ? "pass" : "fail", detail: detail(pass ? success : failure) });
}

async function validatePdfInput(path: string): Promise<string> {
  const absolute = resolve(path);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("PDF input must be a regular non-symlink file");
  if (stat.size > ARTIFACT_LIMITS.pdf) throw new Error(`PDF input exceeds ${ARTIFACT_LIMITS.pdf} byte limit`);
  if (await realpath(absolute) !== absolute) throw new Error("PDF input path must not traverse symlinks");
  return absolute;
}

async function runTextTool(command: TrustedProgram, args: readonly string[], options: DeterministicQaOptions): Promise<ToolOutput> {
  let result: TrustedProcessResult;
  try {
    result = await runTrustedProcess({
      command,
      args,
      cwd: resolve(options.cwd),
      timeoutMs: TOOL_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      stdoutLimit: ARTIFACT_LIMITS.stdout,
      stderrLimit: ARTIFACT_LIMITS.stderr,
    }, options.boundary);
  } catch {
    return { ok: false, text: "", reason: `${command} could not be started` };
  }
  if (result.timedOut) return { ok: false, text: "", reason: `${command} timed out` };
  if (result.aborted) return { ok: false, text: "", reason: `${command} was aborted` };
  if (result.code !== 0 || result.signal !== null) return { ok: false, text: "", reason: `${command} exited unsuccessfully` };
  if (result.stdout.truncated || result.stderr.truncated) return { ok: false, text: "", reason: `${command} output exceeded ${ARTIFACT_LIMITS.stdout} bytes` };
  const text = Buffer.from(result.stdout.data).toString("utf8");
  if (text.includes("\uFFFD")) return { ok: false, text: "", reason: `${command} output was not valid UTF-8` };
  return { ok: true, text, reason: "" };
}

function parseNumber(value: string): number | null {
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseBox(value: string): readonly [number, number, number, number] | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 4) return null;
  const numbers = parts.map(parseNumber);
  if (numbers.some((number) => number === null)) return null;
  const [x1, y1, x2, y2] = numbers as [number, number, number, number];
  if (x2 <= x1 || y2 <= y1) return null;
  return [x1, y1, x2, y2];
}

function parsePdfInfo(value: string): PdfInfo | null {
  const fields = new Map<string, string>();
  for (const rawLine of value.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const match = /^([^:]+):\s*(.*?)\s*$/.exec(rawLine);
    if (!match) return null;
    const rawKey = match[1]!.trim();
    const pageKey = /^Page\s+1\s+(size|MediaBox|CropBox)$/.exec(rawKey);
    const key = pageKey ? (pageKey[1] === "size" ? "Page size" : pageKey[1]!) : rawKey;
    if (fields.has(key)) return null;
    fields.set(key, match[2]!);
  }
  const pagesText = fields.get("Pages");
  const encrypted = fields.get("Encrypted");
  const sizeText = fields.get("Page size");
  const media = fields.get("MediaBox");
  const crop = fields.get("CropBox");
  if (!pagesText || !encrypted || !sizeText || !media || !crop || !/^\d+$/.test(pagesText)) return null;
  const size = /^([0-9]+(?:\.[0-9]+)?)\s+x\s+([0-9]+(?:\.[0-9]+)?)\s+pts(?:\s+\([^)]*\))?$/i.exec(sizeText);
  const mediaBox = parseBox(media);
  const pages = Number(pagesText);
  if (!Number.isSafeInteger(pages)) return null;
  const cropBox = parseBox(crop);
  if (!size || !mediaBox || !cropBox) return null;
  return {
    pages,
    encrypted: encrypted.trim().toLowerCase(),
    width: Number(size[1]),
    height: Number(size[2]),
    mediaWidth: mediaBox[2] - mediaBox[0],
    mediaHeight: mediaBox[3] - mediaBox[1],
    cropWidth: cropBox[2] - cropBox[0],
    cropHeight: cropBox[3] - cropBox[1],
  };
}

function attribute(tag: string, name: string): number | null {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]+)"`).exec(tag);
  return match ? parseNumber(match[1]!) : null;
}

function decodeXmlText(value: string): string | null {
  if (/[<>]/.test(value)) return null;
  if (/&(?!(?:#(?:x[0-9a-fA-F]+|\d+)|amp|lt|gt|quot|apos);)/.test(value)) return null;
  let malformed = false;
  const decoded = value.replace(/&(#(?:x[0-9a-fA-F]+|\d+)|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const codePoint = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      malformed = true;
      return "";
    }
    return String.fromCodePoint(codePoint);
  });
  if (malformed) return null;
  return decoded;
}

function normalizeVisibleText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function parseTextOutput(value: string): TextOutput | null {
  const pages = [...value.matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page>/g)];
  if (pages.length !== 1 || (value.match(/<page\b/g) ?? []).length !== 1) return null;
  const pageWidth = attribute(pages[0]![1]!, "width");
  const pageHeight = attribute(pages[0]![1]!, "height");
  if (pageWidth === null || pageHeight === null || pageWidth <= 0 || pageHeight <= 0) return null;
  const body = pages[0]![2]!;
  const matches = [...body.matchAll(/<word\b([^>]*)>([\s\S]*?)<\/word>/g)];
  if (matches.length === 0 || matches.length !== (body.match(/<word\b/g) ?? []).length) return null;
  const words: WordBox[] = [];
  const text: string[] = [];
  for (const match of matches) {
    const xMin = attribute(match[1]!, "xMin");
    const yMin = attribute(match[1]!, "yMin");
    const xMax = attribute(match[1]!, "xMax");
    const yMax = attribute(match[1]!, "yMax");
    const decoded = decodeXmlText(match[2]!);
    if ([xMin, yMin, xMax, yMax].some((number) => number === null) || decoded === null) return null;
    words.push({ xMin: xMin!, yMin: yMin!, xMax: xMax!, yMax: yMax! });
    text.push(decoded);
  }
  return { text: normalizeVisibleText(text.join(" ")), pageWidth, pageHeight, words };
}

function parseEmbeddedFonts(value: string): { readonly valid: boolean; readonly embedded: boolean } {
  const lines = value.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 3 || !/\bemb\b/.test(lines[0]!) || !/^-{3,}/.test(lines[1]!.trim())) return { valid: false, embedded: false };
  let rows = 0;
  let allEmbedded = true;
  for (const line of lines.slice(2)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 8) return { valid: false, embedded: false };
    const embedded = columns.at(-5)?.toLowerCase();
    const fontType = columns.slice(1, -6).join(" ").toLowerCase();
    if (embedded !== "yes" && embedded !== "no") return { valid: false, embedded: false };
    rows++;
    if (embedded !== "yes" || fontType === "type 3") allEmbedded = false;
  }
  return { valid: rows > 0, embedded: rows > 0 && allEmbedded };
}

function approximately(value: number, expected: number): boolean {
  return Math.abs(value - expected) <= POINT_TOLERANCE;
}

function isLetter(info: PdfInfo): boolean {
  const portrait = approximately(info.width, LETTER_WIDTH) && approximately(info.height, LETTER_HEIGHT)
    && approximately(info.mediaWidth, LETTER_WIDTH) && approximately(info.mediaHeight, LETTER_HEIGHT)
    && approximately(info.cropWidth, LETTER_WIDTH) && approximately(info.cropHeight, LETTER_HEIGHT);
  const landscape = approximately(info.width, LETTER_HEIGHT) && approximately(info.height, LETTER_WIDTH)
    && approximately(info.mediaWidth, LETTER_HEIGHT) && approximately(info.mediaHeight, LETTER_WIDTH)
    && approximately(info.cropWidth, LETTER_HEIGHT) && approximately(info.cropHeight, LETTER_WIDTH);
  return portrait || landscape;
}

function boxesAreBounded(text: TextOutput, info: PdfInfo): boolean {
  const width = Math.min(text.pageWidth, info.mediaWidth, info.cropWidth);
  const height = Math.min(text.pageHeight, info.mediaHeight, info.cropHeight);
  if (!approximately(text.pageWidth, info.cropWidth) || !approximately(text.pageHeight, info.cropHeight)) return false;
  return text.words.every(({ xMin, yMin, xMax, yMax }) =>
    xMin >= 0 && yMin >= 0 && xMax >= xMin && yMax >= yMin && xMax <= width + POINT_TOLERANCE && yMax <= height + POINT_TOLERANCE);
}

function boundedWarnings(log: string | Uint8Array | undefined): readonly string[] {
  if (log === undefined) return Object.freeze([]);
  const bytes = typeof log === "string" ? Buffer.from(log, "utf8") : Buffer.from(log);
  const capped = bytes.subarray(0, ARTIFACT_LIMITS.log);
  const warnings: string[] = [];
  let totalBytes = 0;
  for (const line of capped.toString("utf8").split(/\r?\n/)) {
    if (!/(?:warning|overfull|underfull)/i.test(line)) continue;
    const warning = detail(line).slice(0, WARNING_LENGTH_LIMIT);
    const warningBytes = Buffer.byteLength(warning);
    if (!warning || warnings.length >= WARNING_LIMIT || totalBytes + warningBytes > WARNING_BYTES_LIMIT) break;
    warnings.push(warning);
    totalBytes += warningBytes;
  }
  if (bytes.byteLength > ARTIFACT_LIMITS.log && warnings.length < WARNING_LIMIT) warnings.push(`LaTeX log exceeded ${ARTIFACT_LIMITS.log} byte inspection limit`);
  return Object.freeze(warnings);
}

function missingValues(haystack: string, values: readonly string[], caseInsensitive: boolean): readonly string[] {
  const normalizedHaystack = normalizeVisibleText(haystack);
  const searchable = caseInsensitive ? normalizedHaystack.toLocaleLowerCase("en-US") : normalizedHaystack;
  return values.filter((value) => {
    const needle = normalizeVisibleText(value);
    return !needle || !searchable.includes(caseInsensitive ? needle.toLocaleLowerCase("en-US") : needle);
  });
}

export async function runDeterministicPdfQa(options: DeterministicQaOptions): Promise<DeterministicQaReport> {
  const pdfPath = await validatePdfInput(options.pdfPath);
  const [infoTool, textTool, fontTool] = await Promise.all([
    runTextTool("pdfinfo", ["-f", "1", "-l", "1", "-box", pdfPath], options),
    runTextTool("pdftotext", ["-f", "1", "-l", "1", "-bbox-layout", "-enc", "UTF-8", pdfPath, "-"], options),
    runTextTool("pdffonts", ["-f", "1", "-l", "1", pdfPath], options),
  ]);
  const info = infoTool.ok ? parsePdfInfo(infoTool.text) : null;
  const text = textTool.ok ? parseTextOutput(textTool.text) : null;
  const fonts = fontTool.ok ? parseEmbeddedFonts(fontTool.text) : { valid: false, embedded: false };
  const missingHeadings = text ? missingValues(text.text, options.requiredHeadings, true) : options.requiredHeadings;
  const missingEvidence = text ? missingValues(text.text, options.selectedEvidenceText, false) : options.selectedEvidenceText;
  const checks: DeterministicQaCheck[] = [
    check("pdfinfo-output", info !== null, "pdfinfo output parsed", infoTool.ok ? "pdfinfo output was malformed" : infoTool.reason),
    check("unencrypted", info?.encrypted === "no", "PDF is unencrypted", info ? "PDF is encrypted or encryption status is unsupported" : "encryption could not be verified"),
    check("one-page", info?.pages === 1, "PDF has exactly one page", info ? "PDF does not have exactly one page" : "page count could not be verified"),
    check("letter-size", info !== null && isLetter(info), "page is US Letter", info ? "page is not US Letter" : "page size could not be verified"),
    check("text-output", text !== null, "text and word boxes parsed", textTool.ok ? "pdftotext output was malformed" : textTool.reason),
    check("required-headings", text !== null && missingHeadings.length === 0, "all required headings are visible", text ? `${missingHeadings.length} required heading(s) are missing` : "required headings could not be verified"),
    check("selected-evidence", text !== null && missingEvidence.length === 0, "all selected evidence is visible", text ? `${missingEvidence.length} selected evidence item(s) are missing` : "selected evidence could not be verified"),
    check("font-output", fonts.valid, "font output parsed", fontTool.ok ? "pdffonts output was malformed" : fontTool.reason),
    check("embedded-fonts", fonts.valid && fonts.embedded, "all fonts are embedded and non-Type 3", fonts.valid ? "an unembedded or Type 3 font is present" : "font embedding could not be verified"),
    check("word-bounds", info !== null && text !== null && boxesAreBounded(text, info), "all word boxes are within page bounds", info && text ? "a word box or text page lies outside media/crop bounds" : "word bounds could not be verified"),
  ];
  return Object.freeze({ pass: checks.every(({ status }) => status === "pass"), checks: Object.freeze(checks), warnings: boundedWarnings(options.latexLog) });
}
