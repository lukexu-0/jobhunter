import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PDFDocument,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  rgb,
} from "pdf-lib";
import {
  normalizeJobDescription,
  parsePdftotextBbox,
  renderKeywordMapPdf,
  type KeywordMapRequest,
} from "../src/resume/keyword-map.ts";
import { ARTIFACT_LIMITS, ArtifactStore } from "../src/system/artifacts.ts";
import { runTrustedProcess, type ProcessBoundary } from "../src/system/process.ts";
import { jobAnalysisFixture } from "./job-analysis.fixture.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function compiledResume(): Promise<Pick<KeywordMapRequest, "artifacts" | "compiledPdf">> {
  const root = await mkdtemp(join(tmpdir(), "keyword-map-"));
  roots.push(root);
  const artifacts = new ArtifactStore(root);
  const attempt = await artifacts.createAttempt({ run: "run-1", revision: "1", stage: "compiling", attempt: 1 });
  const document = await PDFDocument.create();
  document.setCreationDate(new Date(0));
  document.setModificationDate(new Date(0));
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  page.drawText("Candidate Resume", { x: 54, y: 730, size: 18, font });
  page.drawText("Built production TypeScript services and reliable APIs.", {
    x: 54,
    y: 690,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });
  const compiledPdf = await artifacts.write(
    join(attempt, "resume.pdf"),
    await document.save({ useObjectStreams: false }),
    ARTIFACT_LIMITS.pdf,
  );
  return { artifacts, compiledPdf };
}

async function extractedText(path: string): Promise<string> {
  const result = await runTrustedProcess({
    command: "pdftotext",
    args: ["-layout", path, "-"],
    cwd: join(path, ".."),
    timeoutMs: 10_000,
    stdoutLimit: 4 * 1024 * 1024,
  });
  if (result.code !== 0) throw new Error(Buffer.from(result.stderr.data).toString("utf8"));
  return Buffer.from(result.stdout.data).toString("utf8");
}

function boundary(stdout: string, code = 0, stderr = ""): ProcessBoundary {
  return () => ({
    pid: 123,
    stdout: (async function* () { yield Buffer.from(stdout); })(),
    stderr: (async function* () { yield Buffer.from(stderr); })(),
    wait: async () => ({ code, signal: null }),
    kill: async () => undefined,
  });
}

describe("keyword map renderer", () => {
  test("parses Poppler bbox entities and rejects malformed or out-of-bounds XML", () => {
    expect(parsePdftotextBbox(`<!DOCTYPE html><doc><page width="612" height="792"><word xMin="1" yMin="2" xMax="40" yMax="12">R&amp;D &#x2B; APIs</word></page></doc>`)).toEqual({
      width: 612,
      height: 792,
      words: [{ text: "R&D + APIs", xMin: 1, yMin: 2, xMax: 40, yMax: 12 }],
    });
    expect(() => parsePdftotextBbox("<doc><page width=\"612\" height=\"792\"><word>bad</page></doc>"))
      .toThrow(/malformed word/i);
    expect(() => parsePdftotextBbox("<doc><page width=\"10\" height=\"10\"><word xMin=\"1\" yMin=\"1\" xMax=\"20\" yMax=\"2\">bad</word></page></doc>"))
      .toThrow(/out-of-bounds/i);
  });

  test("renders markup-like job sources as readable text", () => {
    expect(normalizeJobDescription("<strong>Platform Engineer</strong><br><ul><li>Build &amp; own APIs</li></ul>"))
      .toBe("Platform Engineer\n- Build & own APIs");
  });

  test("renders every normalized JD line across landscape pages with repeated resume and red match operators", async () => {
    const resume = await compiledResume();
    const paragraphs = Array.from({ length: 145 }, (_, index) =>
      `Requirement ${index + 1}: Own TypeScript delivery, testing, observability, and reliable production systems.`,
    );
    const jobDescription = [
      "Senior TypeScript Engineer — Platform R&D 🚀",
      ...paragraphs,
      "FINAL COMPLETE JD MARKER",
    ].join("\n");
    const analysis = jobAnalysisFixture();
    const rendered = await renderKeywordMapPdf({
      ...resume,
      jobDescription,
      analysis,
    });

    expect(rendered.bytes).toBeLessThanOrEqual(ARTIFACT_LIMITS.pdf);
    const bytes = await resume.artifacts.read(rendered.path, ARTIFACT_LIMITS.pdf);
    const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBeGreaterThan(1);
    for (const page of document.getPages()) expect(page.getSize()).toEqual({ width: 792, height: 612 });

    const text = await extractedText(rendered.path);
    expect(text).toContain("Senior TypeScript Engineer - Platform R&D <U+1F680>");
    expect(text).toContain("Requirement 145: Own TypeScript delivery");
    expect(text).toContain("FINAL COMPLETE JD MARKER");
    expect(text.split("Candidate Resume").length - 1).toBe(document.getPageCount());

    let operators = "";
    for (const [, object] of document.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream)) continue;
      try {
        operators += Buffer.from(decodePDFRawStream(object).decode()).toString("latin1");
      } catch {
        // Font and image streams are not content streams and need not be text-decodable.
      }
    }
    expect(operators).toContain("0.85 0.05 0.05 RG");
    expect(operators).toMatch(/\bh\b/);
    expect(operators).toMatch(/\bm\b[\s\S]*\bl\b/);
  });

  test("honors cancellation and surfaces pdftotext failures and malformed bbox output", async () => {
    const resume = await compiledResume();
    const analysis = jobAnalysisFixture();
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    controller.abort(reason);
    await expect(renderKeywordMapPdf({
      ...resume,
      jobDescription: "TypeScript role",
      analysis,
      signal: controller.signal,
    })).rejects.toBe(reason);

    await expect(renderKeywordMapPdf({
      ...resume,
      jobDescription: "TypeScript role",
      analysis,
      processBoundary: boundary("", 2, "syntax failure"),
    })).rejects.toThrow(/pdftotext bbox extraction failed: syntax failure/i);

    await expect(renderKeywordMapPdf({
      ...resume,
      jobDescription: "TypeScript role",
      analysis,
      processBoundary: boundary("<doc><page width=\"612\" height=\"792\"></doc>"),
    })).rejects.toThrow(/exactly one page/i);
  });
});
