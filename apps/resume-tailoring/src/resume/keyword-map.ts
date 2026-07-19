import { dirname, join } from "node:path";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFEmbeddedPage,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { ARTIFACT_LIMITS, type ArtifactMetadata, type ArtifactStore } from "../system/artifacts.ts";
import { runTrustedProcess, type ProcessBoundary } from "../system/process.ts";
import type { JobAnalysis } from "./types.ts";

const PAGE_WIDTH = 792;
const PAGE_HEIGHT = 612;
const PAGE_MARGIN = 18;
const COLUMN_GAP = 18;
const TEXT_SIZE = 8.25;
const LINE_HEIGHT = 10.5;
const TEXT_TOP = PAGE_HEIGHT - 24;
const TEXT_BOTTOM = 24;
const BBOX_OUTPUT_LIMIT = 4 * 1024 * 1024;
const BBOX_TIMEOUT_MS = 30_000;
const RED = rgb(0.85, 0.05, 0.05);
const LIGHT_GRAY = rgb(0.82, 0.82, 0.82);
const STOP_WORDS: Readonly<Record<string, true>> = Object.freeze({
  about: true, after: true, also: true, and: true, been: true, being: true, build: true, built: true, from: true,
  have: true, into: true, more: true, not: true, our: true, that: true, the: true, their: true, this: true,
  through: true, using: true, with: true, your: true,
});
const ASCII_REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
  "\u00a0": " ",
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2015": "-",
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u201c": "\"",
  "\u201d": "\"",
  "\u201e": "\"",
  "\u2022": "*",
  "\u2026": "...",
  "\u2212": "-",
});

export interface KeywordMapRequest {
  readonly artifacts: ArtifactStore;
  readonly compiledPdf: ArtifactMetadata;
  readonly jobDescription: string;
  readonly analysis: JobAnalysis;
  readonly signal?: AbortSignal;
  readonly processBoundary?: ProcessBoundary;
}

export interface BboxWord {
  readonly text: string;
  readonly xMin: number;
  readonly yMin: number;
  readonly xMax: number;
  readonly yMax: number;
}

export interface ParsedBboxPage {
  readonly width: number;
  readonly height: number;
  readonly words: readonly BboxWord[];
}

interface WordBox {
  readonly text: string;
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface BoxRange {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface KeywordMatch {
  readonly resume: BoxRange;
  readonly job: BoxRange;
}

interface ResumeLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly boxes: readonly WordBox[];
}

function decodeXml(value: string): string {
  const decoded = value.replace(/&(?:#(\d+)|#x([\da-fA-F]+)|amp|lt|gt|quot|apos);/g, (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
    if (decimal !== undefined) {
      const codePoint = Number.parseInt(decimal, 10);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        throw new Error("pdftotext bbox contains an invalid numeric XML entity");
      }
      return String.fromCodePoint(codePoint);
    }
    if (hexadecimal !== undefined) {
      const codePoint = Number.parseInt(hexadecimal, 16);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        throw new Error("pdftotext bbox contains an invalid numeric XML entity");
      }
      return String.fromCodePoint(codePoint);
    }
    if (entity === "&amp;") return "&";
    if (entity === "&lt;") return "<";
    if (entity === "&gt;") return ">";
    if (entity === "&quot;") return "\"";
    return "'";
  });
  if (/&[^;\s]{1,32};/.test(decoded)) throw new Error("pdftotext bbox contains an unsupported XML entity");
  return decoded;
}

function attributes(value: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const attributePattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of value.matchAll(attributePattern)) result[match[1]!] = decodeXml(match[2] ?? match[3] ?? "");
  return result;
}

function coordinate(value: string | undefined, label: string): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`pdftotext bbox has an invalid ${label}`);
  return parsed;
}

export function parsePdftotextBbox(xml: string): ParsedBboxPage {
  if (!xml.trim() || !/<doc\b/i.test(xml) || !/<\/doc\s*>/i.test(xml)) {
    throw new Error("pdftotext returned malformed bbox XML");
  }
  const pageOpenings = [...xml.matchAll(/<page\b([^>]*)>/gi)];
  const pageClosings = [...xml.matchAll(/<\/page\s*>/gi)];
  if (pageOpenings.length !== 1 || pageClosings.length !== 1) {
    throw new Error("compiled resume bbox must contain exactly one page");
  }
  const pageAttributes = attributes(pageOpenings[0]![1] ?? "");
  const width = coordinate(pageAttributes.width, "page width");
  const height = coordinate(pageAttributes.height, "page height");
  if (width <= 0 || height <= 0) throw new Error("pdftotext bbox page dimensions must be positive");

  const wordOpenings = [...xml.matchAll(/<word\b/gi)].length;
  const wordClosings = [...xml.matchAll(/<\/word\s*>/gi)].length;
  const words: BboxWord[] = [];
  const wordPattern = /<word\b([^>]*)>([\s\S]*?)<\/word\s*>/gi;
  for (const match of xml.matchAll(wordPattern)) {
    const wordAttributes = attributes(match[1] ?? "");
    const xMin = coordinate(wordAttributes.xMin, "word xMin");
    const yMin = coordinate(wordAttributes.yMin, "word yMin");
    const xMax = coordinate(wordAttributes.xMax, "word xMax");
    const yMax = coordinate(wordAttributes.yMax, "word yMax");
    if (xMin < 0 || yMin < 0 || xMax <= xMin || yMax <= yMin || xMax > width + 1 || yMax > height + 1) {
      throw new Error("pdftotext bbox contains an out-of-bounds word box");
    }
    const text = decodeXml(match[2] ?? "").trim();
    if (!text || /<[^>]+>/.test(text)) throw new Error("pdftotext bbox contains malformed word text");
    words.push({ text, xMin, yMin, xMax, yMax });
  }
  if (wordOpenings === 0 || words.length !== wordOpenings || wordClosings !== wordOpenings) {
    throw new Error("pdftotext bbox contains malformed word elements");
  }
  return { width, height, words };
}

function canEncode(font: PDFFont, value: string): boolean {
  try {
    font.encodeText(value);
    return true;
  } catch {
    return false;
  }
}

function pdfSafeText(value: string, font: PDFFont): string {
  let result = "";
  for (const scalar of value) {
    const replacement = ASCII_REPLACEMENTS[scalar];
    if (replacement !== undefined) {
      result += replacement;
      continue;
    }
    if (scalar === "\t") {
      result += "    ";
      continue;
    }
    if (scalar === "\n" || scalar === "\r") {
      result += scalar;
      continue;
    }
    if (canEncode(font, scalar)) {
      result += scalar;
      continue;
    }
    const decomposed = scalar.normalize("NFKD").replace(/\p{Mark}/gu, "");
    if (decomposed && canEncode(font, decomposed)) {
      result += decomposed;
      continue;
    }
    result += `<U+${scalar.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`;
  }
  return result;
}

export function normalizeJobDescription(value: string): string {
  const readable = value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/(?:li|p|div|ul|ol|h[1-6])\s*>/gi, "\n")
    .replace(/<\/?[A-Za-z][^>\n]*>/g, "")
    .replace(
      /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
      (entity, decimal: string | undefined, hexadecimal: string | undefined, name: string | undefined) => {
        if (decimal !== undefined || hexadecimal !== undefined) {
          const codePoint = Number.parseInt(decimal ?? hexadecimal!, decimal === undefined ? 16 : 10);
          if (Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff)) {
            return String.fromCodePoint(codePoint);
          }
          return entity;
        }
        switch (name?.toLowerCase()) {
          case "amp": return "&";
          case "apos": return "'";
          case "gt": return ">";
          case "lt": return "<";
          case "nbsp": return " ";
          case "quot": return "\"";
          default: return entity;
        }
      },
    );
  return readable
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLongWord(word: string, font: PDFFont, width: number): readonly string[] {
  if (font.widthOfTextAtSize(word, TEXT_SIZE) <= width) return [word];
  const parts: string[] = [];
  let part = "";
  for (const scalar of word) {
    const candidate = part + scalar;
    if (part && font.widthOfTextAtSize(candidate, TEXT_SIZE) > width) {
      parts.push(part);
      part = scalar;
    } else part = candidate;
  }
  if (part) parts.push(part);
  return parts;
}

function wrapJobDescription(value: string, font: PDFFont, width: number): readonly string[] {
  const lines: string[] = [];
  const spaceWidth = font.widthOfTextAtSize(" ", TEXT_SIZE);
  for (const paragraph of value.split("\n")) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    let line = "";
    let lineWidth = 0;
    for (const rawWord of paragraph.trimStart().split(/\s+/)) {
      for (const word of splitLongWord(rawWord, font, width)) {
        const wordWidth = font.widthOfTextAtSize(word, TEXT_SIZE);
        if (line && lineWidth + spaceWidth + wordWidth > width) {
          lines.push(line);
          line = word;
          lineWidth = wordWidth;
        } else {
          line += line ? ` ${word}` : word;
          lineWidth += (lineWidth > 0 ? spaceWidth : 0) + wordWidth;
        }
      }
    }
    lines.push(line);
  }
  return lines.length > 0 ? lines : [""];
}

function canonicalTokens(value: string): readonly string[] {
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[’']/g, "");
  return normalized
    .split(/[^\p{Letter}\p{Number}+#.]+/u)
    .map((token) => token.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
}

function wordToken(value: string): string {
  return canonicalTokens(value).join("");
}

function range(boxes: readonly WordBox[]): BoxRange {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const top = Math.max(...boxes.map((box) => box.y + box.height));
  return { page: boxes[0]!.page, x, y, width: right - x, height: top - y };
}

function findPhrase(boxes: readonly WordBox[], phrase: string): BoxRange | undefined {
  const tokens = canonicalTokens(phrase);
  if (tokens.length === 0) return undefined;
  const boxTokens = boxes.map((box) => wordToken(box.text));
  for (let start = 0; start + tokens.length <= boxes.length; start++) {
    const page = boxes[start]!.page;
    let matches = true;
    for (let offset = 0; offset < tokens.length; offset++) {
      if (boxes[start + offset]!.page !== page || boxTokens[start + offset] !== tokens[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return range(boxes.slice(start, start + tokens.length));
  }
  return undefined;
}

function meaningfulTokens(value: string): readonly string[] {
  return canonicalTokens(value)
    .filter((token) => STOP_WORDS[token] !== true && !/^\d+$/.test(token) && (token.length >= 4 || /[+#.]/.test(token)))
    .filter((token, index, values) => values.indexOf(token) === index);
}

function keywordMatches(analysis: JobAnalysis, resumeBoxes: readonly WordBox[], jobBoxes: readonly WordBox[]): readonly KeywordMatch[] {
  const matches: KeywordMatch[] = [];
  for (const keyword of analysis.jdKeywords) {
    const resumeCandidates = [
      keyword.phrase,
      ...analysis.exactEdits
        .filter((edit) => edit.keywordIds.includes(keyword.id))
        .map((edit) => edit.after),
    ];
    const literalJob = findPhrase(jobBoxes, keyword.phrase);
    if (literalJob) {
      const literalResume = resumeCandidates.map((candidate) => findPhrase(resumeBoxes, candidate)).find(Boolean);
      if (literalResume) {
        matches.push({ resume: literalResume, job: literalJob });
        continue;
      }
    }
    const jobTokens = meaningfulTokens(keyword.phrase);
    let fallback: KeywordMatch | undefined;
    for (const candidate of resumeCandidates) {
      const common = meaningfulTokens(candidate)
        .filter((token) => jobTokens.includes(token))
        .sort((left, right) => right.length - left.length || left.localeCompare(right));
      for (const token of common) {
        const job = findPhrase(jobBoxes, token);
        const resume = findPhrase(resumeBoxes, token);
        if (job && resume) {
          fallback = { resume, job };
          break;
        }
      }
      if (fallback) break;
    }
    if (fallback) matches.push(fallback);
  }
  return matches;
}

function drawBox(page: PDFPage, box: BoxRange): void {
  page.drawRectangle({
    x: box.x - 1.5,
    y: box.y - 1.5,
    width: box.width + 3,
    height: box.height + 3,
    borderColor: RED,
    borderWidth: 0.85,
  });
}

function drawPageMatches(page: PDFPage, matches: readonly KeywordMatch[], pageIndex: number): void {
  for (const match of matches) {
    if (match.job.page !== pageIndex) continue;
    drawBox(page, match.resume);
    drawBox(page, match.job);
    page.drawLine({
      start: { x: match.resume.x + match.resume.width + 1.5, y: match.resume.y + match.resume.height / 2 },
      end: { x: match.job.x - 1.5, y: match.job.y + match.job.height / 2 },
      color: RED,
      thickness: 0.7,
    });
  }
}

function createResumeLayout(source: ParsedBboxPage): ResumeLayout {
  const availableHeight = PAGE_HEIGHT - 2 * PAGE_MARGIN;
  const availableWidth = PAGE_WIDTH * 0.58 - PAGE_MARGIN;
  const scale = Math.min(availableHeight / source.height, availableWidth / source.width);
  const width = source.width * scale;
  const height = source.height * scale;
  const x = PAGE_MARGIN;
  const y = (PAGE_HEIGHT - height) / 2;
  return {
    x,
    y,
    width,
    height,
    right: x + width,
    boxes: source.words.map((word) => ({
      text: word.text,
      page: 0,
      x: x + word.xMin * scale,
      y: y + (source.height - word.yMax) * scale,
      width: (word.xMax - word.xMin) * scale,
      height: (word.yMax - word.yMin) * scale,
    })),
  };
}

function drawResume(page: PDFPage, resume: PDFEmbeddedPage, layout: ResumeLayout): void {
  page.drawPage(resume, { x: layout.x, y: layout.y, width: layout.width, height: layout.height });
}

function drawJobLines(page: PDFPage, pageIndex: number, lines: readonly string[], font: PDFFont, x: number): readonly WordBox[] {
  const boxes: WordBox[] = [];
  page.setFont(font);
  for (const [lineIndex, line] of lines.entries()) {
    const y = TEXT_TOP - lineIndex * LINE_HEIGHT - TEXT_SIZE;
    if (!line) continue;
    page.drawText(line, { x, y, size: TEXT_SIZE, color: rgb(0.08, 0.08, 0.08) });
    for (const match of line.matchAll(/\S+/g)) {
      const text = match[0];
      const prefix = line.slice(0, match.index);
      boxes.push({
        text,
        page: pageIndex,
        x: x + font.widthOfTextAtSize(prefix, TEXT_SIZE),
        y: y - 0.8,
        width: font.widthOfTextAtSize(text, TEXT_SIZE),
        height: LINE_HEIGHT - 1,
      });
    }
  }
  return boxes;
}

async function extractBbox(request: KeywordMapRequest): Promise<ParsedBboxPage> {
  request.signal?.throwIfAborted();
  const result = await runTrustedProcess({
    command: "pdftotext",
    args: ["-bbox-layout", request.compiledPdf.path, "-"],
    cwd: dirname(request.compiledPdf.path),
    timeoutMs: BBOX_TIMEOUT_MS,
    ...(request.signal ? { signal: request.signal } : {}),
    stdoutLimit: BBOX_OUTPUT_LIMIT,
    stderrLimit: 256 * 1024,
  }, request.processBoundary);
  if (result.aborted) request.signal?.throwIfAborted();
  if (result.timedOut) throw new Error("pdftotext bbox extraction timed out");
  if (result.code !== 0 || result.signal !== null) {
    const detail = Buffer.from(result.stderr.data).toString("utf8").trim().slice(0, 500);
    throw new Error(`pdftotext bbox extraction failed${detail ? `: ${detail}` : ""}`);
  }
  if (result.stdout.truncated) throw new Error("pdftotext bbox output exceeds its limit");
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout.data);
  } catch (error) {
    throw new Error("pdftotext bbox output is not valid UTF-8", { cause: error });
  }
  return parsePdftotextBbox(xml);
}

export async function renderKeywordMapPdf(request: KeywordMapRequest): Promise<ArtifactMetadata> {
  request.signal?.throwIfAborted();
  const compiledBytes = await request.artifacts.read(request.compiledPdf.path, ARTIFACT_LIMITS.pdf);
  const [source, bbox] = await Promise.all([
    PDFDocument.load(compiledBytes),
    extractBbox(request),
  ]);
  if (source.getPageCount() !== 1) throw new Error("keyword map requires a one-page compiled resume");
  request.signal?.throwIfAborted();

  const output = await PDFDocument.create();
  output.setProducer("jobhunter keyword map");
  output.setCreator("jobhunter pipeline");
  output.setTitle("Resume keyword map");
  output.setSubject("Compiled resume and complete job description keyword alignment");
  output.setCreationDate(new Date(0));
  output.setModificationDate(new Date(0));
  const font = await output.embedFont(StandardFonts.Helvetica);
  const resume = await output.embedPage(source.getPage(0));

  const resumeLayout = createResumeLayout(bbox);
  const textX = resumeLayout.right + COLUMN_GAP;
  const textWidth = PAGE_WIDTH - PAGE_MARGIN - textX;
  if (textWidth < 180) throw new Error("keyword map job-description column is too narrow");
  const normalized = normalizeJobDescription(request.jobDescription);
  if (!normalized) throw new Error("job description is empty");
  const safeDescription = pdfSafeText(normalized, font);
  const lines = wrapJobDescription(safeDescription, font, textWidth);
  const linesPerPage = Math.floor((TEXT_TOP - TEXT_BOTTOM) / LINE_HEIGHT);
  const pageCount = Math.max(1, Math.ceil(lines.length / linesPerPage));
  const pages: PDFPage[] = [];
  const jobBoxes: WordBox[] = [];
  const resumeBoxes = resumeLayout.boxes;

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    request.signal?.throwIfAborted();
    const page = output.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    drawResume(page, resume, resumeLayout);
    page.drawLine({
      start: { x: resumeLayout.right + COLUMN_GAP / 2, y: PAGE_MARGIN },
      end: { x: resumeLayout.right + COLUMN_GAP / 2, y: PAGE_HEIGHT - PAGE_MARGIN },
      color: LIGHT_GRAY,
      thickness: 0.5,
    });
    const pageLines = lines.slice(pageIndex * linesPerPage, (pageIndex + 1) * linesPerPage);
    jobBoxes.push(...drawJobLines(page, pageIndex, pageLines, font, textX));
    pages.push(page);
  }

  const matches = keywordMatches(request.analysis, resumeBoxes, jobBoxes);
  for (const [pageIndex, page] of pages.entries()) drawPageMatches(page, matches, pageIndex);
  request.signal?.throwIfAborted();
  const bytes = await output.save({ useObjectStreams: false, addDefaultPage: false });
  request.signal?.throwIfAborted();
  return await request.artifacts.write(
    join(dirname(request.compiledPdf.path), "keyword-map.pdf"),
    bytes,
    ARTIFACT_LIMITS.pdf,
  );
}
