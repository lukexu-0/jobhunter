import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFString,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  rgb,
} from "pdf-lib";
import { ResumeKeywordCoverageSchema } from "../src/contracts/index.ts";
import {
  normalizeJobDescription,
  renderKeywordMapArtifacts,
  renderKeywordMapPdf,
  type KeywordMapRequest,
} from "../src/resume/keyword-map.ts";
import { ARTIFACT_LIMITS, ArtifactStore } from "../src/system/artifacts.ts";
import { runTrustedProcess, type ProcessBoundary } from "../src/system/process.ts";
import {
  atsKeywordExtractionFixture,
  jobAnalysisFixture,
  KEYWORD_MAP_JOB_DESCRIPTION,
} from "./job-analysis.fixture.ts";
import { textTsv } from "./pdf-text.fixture.ts";

const roots: string[] = [];

const testWithPdftotext = test.skipIf(Bun.which("pdftotext") === null);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function compiledResume(
  resumeText = "Built production TypeScript services with Next.js and reliable APIs.",
): Promise<Pick<KeywordMapRequest, "artifacts" | "compiledPdf">> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "keyword-map-")));
  roots.push(root);
  const artifacts = new ArtifactStore(root);
  const attempt = await artifacts.createAttempt({ run: 1, revision: "1", stage: "compiling", attempt: 1 });
  const document = await PDFDocument.create();
  document.setCreationDate(new Date(0));
  document.setModificationDate(new Date(0));
  document.context.lookup(document.context.trailerInfo.Info, PDFDict).set(PDFName.of("Title"), PDFString.of(""));
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  page.drawText("Candidate Resume", { x: 54, y: 730, size: 18, font });
  page.drawText(resumeText, {
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

  test("renders markup-like job sources as readable text", () => {
    expect(normalizeJobDescription("<strong>Platform Engineer</strong><br><ul><li>Build &amp; own APIs</li></ul>"))
      .toBe("Platform Engineer\n- Build & own APIs");
  });

  testWithPdftotext("renders every normalized JD line across landscape pages with repeated resume and red match operators", async () => {
    const resume = await compiledResume();
    const paragraphs = Array.from({ length: 145 }, (_, index) =>
      `Requirement ${index + 1}: Own TypeScript delivery, testing, observability, and reliable production systems.`,
    );
    const jobDescription = [
      "Senior TypeScript Engineer — Platform R&D 🚀",
      ...paragraphs,
      "FINAL COMPLETE JD MARKER",
    ].join("\n");
    const atsKeywordExtraction = atsKeywordExtractionFixture({ rawJobDescription: jobDescription });
    const analysis = jobAnalysisFixture({
      jobDescriptionSha256: atsKeywordExtraction.jobDescriptionSha256,
      jdQuote: jobDescription,
    });
    const keyword = analysis.jdKeywords[0]!;
    const linkedSkillEdit = analysis.exactEdits.find((edit) => edit.kind === "skill" && edit.keywordIds.includes(keyword.id));
    expect(keyword.phrase).toBe("TypeScript");
    expect(linkedSkillEdit?.after).toBe("TypeScript services");
    const rendered = await renderKeywordMapPdf({
      ...resume,
      jobDescription,
      analysis,
      atsKeywordExtraction,
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

  testWithPdftotext("red-boxes matched extracted phrases and yellow-highlights only the absent JD phrase", async () => {
    const resume = await compiledResume();
    const atsKeywordExtraction = atsKeywordExtractionFixture();
    const analysis = jobAnalysisFixture({
      jobDescriptionSha256: atsKeywordExtraction.jobDescriptionSha256,
      jdQuote: KEYWORD_MAP_JOB_DESCRIPTION,
    });
    expect(analysis.jdKeywords.map((keyword) => keyword.phrase)).toEqual(["TypeScript"]);
    expect(atsKeywordExtraction.keywords.map((keyword) => keyword.phrase)).toEqual([
      "TypeScript",
      "Next.js",
      "Kubernetes",
    ]);

    const rendered = await renderKeywordMapPdf({
      ...resume,
      jobDescription: KEYWORD_MAP_JOB_DESCRIPTION,
      atsKeywordExtraction,
      analysis,
    });
    const document = await PDFDocument.load(
      await resume.artifacts.read(rendered.path, ARTIFACT_LIMITS.pdf),
    );
    let operators = "";
    for (const [, object] of document.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream)) continue;
      try {
        operators += Buffer.from(decodePDFRawStream(object).decode()).toString("latin1");
      } catch {
        // Font and image streams are not content streams and need not be text-decodable.
      }
    }
    expect(operators.match(/0\.85 0\.05 0\.05 RG/g)).toHaveLength(6);
    expect(operators.match(/1 0\.85 0 rg/g)).toHaveLength(1);
  });

  testWithPdftotext("writes complete rendered-resume coverage for every extracted keyword", async () => {
    const resume = await compiledResume();
    const atsKeywordExtraction = atsKeywordExtractionFixture();
    const analysis = jobAnalysisFixture({
      jobDescriptionSha256: atsKeywordExtraction.jobDescriptionSha256,
      jdQuote: KEYWORD_MAP_JOB_DESCRIPTION,
    });

    const rendered = await renderKeywordMapArtifacts({
      ...resume,
      jobDescription: KEYWORD_MAP_JOB_DESCRIPTION,
      atsKeywordExtraction,
      analysis,
    });
    const coverage = ResumeKeywordCoverageSchema.parse(JSON.parse(
      await Bun.file(rendered.coverage.path).text(),
    ));

    expect(coverage).toEqual({
      schemaVersion: 1,
      pdfSha256: resume.compiledPdf.sha256,
      keywords: [
        { id: "keyword-typescript", phrase: "TypeScript", found: true },
        { id: "keyword-nextjs", phrase: "Next.js", found: true },
        { id: "keyword-kubernetes", phrase: "Kubernetes", found: false },
      ],
    });
    expect(rendered.pdf.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("counts an extracted phrase that wraps across lines in one Poppler text block", async () => {
    const jobDescription = "TypeScript role requires Distributed tracing.";
    const baseExtraction = atsKeywordExtractionFixture({ rawJobDescription: jobDescription });
    const atsKeywordExtraction = {
      ...baseExtraction,
      keywords: [{
        id: "keyword-distributed-tracing",
        phrase: "Distributed tracing",
        jdQuote: jobDescription,
      }],
    };
    const baseAnalysis = jobAnalysisFixture({
      jobDescriptionSha256: atsKeywordExtraction.jobDescriptionSha256,
      jdQuote: jobDescription,
    });
    const analysis = { ...baseAnalysis, jdKeywords: [], exactEdits: [] };
    const resume = await compiledResume("Built production Distributed\ntracing systems.");
    const geometry = textTsv([{ blocks: [[
      [["Built", 54, 100, 22, 11], ["Distributed", 80, 100, 60, 11]],
      [["tracing", 54, 113, 37, 11], ["systems", 95, 113, 42, 11]],
    ]] }]);

    const rendered = await renderKeywordMapArtifacts({
      ...resume,
      jobDescription,
      atsKeywordExtraction,
      analysis,
      processBoundary: boundary(geometry),
    });
    const coverage = ResumeKeywordCoverageSchema.parse(JSON.parse(
      await Bun.file(rendered.coverage.path).text(),
    ));

    expect(coverage.keywords).toEqual([{
      id: "keyword-distributed-tracing",
      phrase: "Distributed tracing",
      found: true,
    }]);
  });

  testWithPdftotext("counts a keyword when its linked rendered edit is the map match", async () => {
    const jobDescription = "TypeScript role requires Java.";
    const baseExtraction = atsKeywordExtractionFixture({ rawJobDescription: jobDescription });
    const keyword = {
      id: "keyword-java",
      phrase: "Java",
      jdQuote: jobDescription,
    };
    const atsKeywordExtraction = { ...baseExtraction, keywords: [keyword] };
    const baseAnalysis = jobAnalysisFixture({
      jobDescriptionSha256: atsKeywordExtraction.jobDescriptionSha256,
      jdQuote: jobDescription,
    });
    const analysis = {
      ...baseAnalysis,
      jdKeywords: [keyword],
      exactEdits: [{
        ...baseAnalysis.exactEdits[0]!,
        after: "JavaScript services",
        keywordIds: [keyword.id],
      }],
    };
    const resume = await compiledResume("Built JavaScript services.");

    const rendered = await renderKeywordMapArtifacts({
      ...resume,
      jobDescription,
      atsKeywordExtraction,
      analysis,
    });
    const coverage = ResumeKeywordCoverageSchema.parse(JSON.parse(
      await Bun.file(rendered.coverage.path).text(),
    ));

    expect(coverage.keywords).toEqual([{
      id: "keyword-java",
      phrase: "Java",
      found: true,
    }]);
  });

  testWithPdftotext("does not count an unlinked keyword found only as a substring", async () => {
    const jobDescription = "TypeScript role requires Java.";
    const baseExtraction = atsKeywordExtractionFixture({ rawJobDescription: jobDescription });
    const keyword = {
      id: "keyword-java",
      phrase: "Java",
      jdQuote: jobDescription,
    };
    const atsKeywordExtraction = { ...baseExtraction, keywords: [keyword] };
    const baseAnalysis = jobAnalysisFixture({
      jobDescriptionSha256: atsKeywordExtraction.jobDescriptionSha256,
      jdQuote: jobDescription,
    });
    const analysis = { ...baseAnalysis, jdKeywords: [], exactEdits: [] };
    const resume = await compiledResume("Built JavaScript services.");

    const rendered = await renderKeywordMapArtifacts({
      ...resume,
      jobDescription,
      atsKeywordExtraction,
      analysis,
    });
    const coverage = ResumeKeywordCoverageSchema.parse(JSON.parse(
      await Bun.file(rendered.coverage.path).text(),
    ));

    expect(coverage.keywords).toEqual([{
      id: "keyword-java",
      phrase: "Java",
      found: false,
    }]);
  });

  testWithPdftotext("highlights complete keywords within punctuation-delimited PDF word boxes", async () => {
    const jobDescription = "TypeScript role requiring Node, Next.js, C++, and C#";
    const baseExtraction = atsKeywordExtractionFixture({ rawJobDescription: jobDescription });
    const atsKeywordExtraction = {
      ...baseExtraction,
      keywords: [
        { id: "keyword-typescript", phrase: "TypeScript", jdQuote: jobDescription },
        { id: "keyword-node", phrase: "Node", jdQuote: jobDescription },
        { id: "keyword-nextjs", phrase: "Next.js", jdQuote: jobDescription },
        { id: "keyword-cpp", phrase: "C++", jdQuote: jobDescription },
        { id: "keyword-csharp", phrase: "C#", jdQuote: jobDescription },
      ],
    };
    const analysis = jobAnalysisFixture({
      jobDescriptionSha256: atsKeywordExtraction.jobDescriptionSha256,
      jdQuote: jobDescription,
    });

    for (const runtime of ["Node/Express", "Node.js"]) {
      const resume = await compiledResume(
        `Built production TypeScript services with ${runtime}, Next.js, C++, and C#.`,
      );
      const rendered = await renderKeywordMapPdf({
        ...resume,
        jobDescription,
        atsKeywordExtraction,
        analysis,
      });
      const document = await PDFDocument.load(
        await resume.artifacts.read(rendered.path, ARTIFACT_LIMITS.pdf),
      );
      let operators = "";
      for (const [, object] of document.context.enumerateIndirectObjects()) {
        if (!(object instanceof PDFRawStream)) continue;
        try {
          operators += Buffer.from(decodePDFRawStream(object).decode()).toString("latin1");
        } catch {
          // Font and image streams are not content streams and need not be text-decodable.
        }
      }
      expect(operators.match(/0\.85 0\.05 0\.05 RG/g)).toHaveLength(15);
    }
  });

  testWithPdftotext("does not highlight an unrelated resume phrase sharing only one meaningful token", async () => {
    const jobDescription = "Seeking TypeScript engineers with a genuinely high engineering bar.";
    const baseExtraction = atsKeywordExtractionFixture({ rawJobDescription: jobDescription });
    const atsKeywordExtraction = {
      ...baseExtraction,
      keywords: [
        { id: "keyword-typescript", phrase: "TypeScript", jdQuote: jobDescription },
        {
          id: "keyword-engineering-bar",
          phrase: "genuinely high engineering bar",
          jdQuote: jobDescription,
        },
      ],
    };
    const analysis = jobAnalysisFixture({
      jobDescriptionSha256: atsKeywordExtraction.jobDescriptionSha256,
      jdQuote: jobDescription,
    });
    const resume = await compiledResume("Built production TypeScript services. High School diploma.");
    const rendered = await renderKeywordMapPdf({
      ...resume,
      jobDescription,
      atsKeywordExtraction,
      analysis,
    });
    const document = await PDFDocument.load(
      await resume.artifacts.read(rendered.path, ARTIFACT_LIMITS.pdf),
    );
    let operators = "";
    for (const [, object] of document.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream)) continue;
      try {
        operators += Buffer.from(decodePDFRawStream(object).decode()).toString("latin1");
      } catch {
        // Font and image streams are not content streams and need not be text-decodable.
      }
    }
    expect(operators.match(/0\.85 0\.05 0\.05 RG/g)).toHaveLength(3);
  });

  test("keeps a phrase split across adjacent independent Poppler blocks unmatched", async () => {
    const jobDescription = "TypeScript services experience required.";
    const baseExtraction = atsKeywordExtractionFixture({ rawJobDescription: jobDescription });
    const atsKeywordExtraction = {
      ...baseExtraction,
      keywords: [{
        id: "keyword-typescript-services",
        phrase: "TypeScript services",
        jdQuote: jobDescription,
      }],
    };
    const analysis = jobAnalysisFixture({
      jobDescriptionSha256: atsKeywordExtraction.jobDescriptionSha256,
      jdQuote: jobDescription,
    });
    const resume = await compiledResume("TypeScript\nservices");
    const geometry = textTsv([{ blocks: [
      [[["TypeScript", 54, 100, 56, 11]]],
      [[["services", 54, 113, 42, 11]]],
    ] }]);

    const rendered = await renderKeywordMapArtifacts({
      ...resume,
      jobDescription,
      atsKeywordExtraction,
      analysis,
      processBoundary: boundary(geometry),
    });
    const document = await PDFDocument.load(
      await resume.artifacts.read(rendered.pdf.path, ARTIFACT_LIMITS.pdf),
    );
    let operators = "";
    for (const [, object] of document.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream)) continue;
      try {
        operators += Buffer.from(decodePDFRawStream(object).decode()).toString("latin1");
      } catch {
        // Font and image streams are not content streams and need not be text-decodable.
      }
    }

    expect(operators.match(/1 0\.85 0 rg/g)).toHaveLength(1);
    expect(operators).not.toContain("0.85 0.05 0.05 RG");
    const coverage = ResumeKeywordCoverageSchema.parse(
      await Bun.file(rendered.coverage.path).json(),
    );
    expect(coverage.keywords).toEqual([{
      id: "keyword-typescript-services",
      phrase: "TypeScript services",
      found: false,
    }]);
  });

  test("KEYWORD-LINE-001 keeps a phrase split across separate resume bullets unmatched", async () => {
    const jobDescription = "TypeScript services experience required.";
    const baseExtraction = atsKeywordExtractionFixture({ rawJobDescription: jobDescription });
    const atsKeywordExtraction = {
      ...baseExtraction,
      keywords: [{
        id: "keyword-typescript-services",
        phrase: "TypeScript services",
        jdQuote: jobDescription,
      }],
    };
    const analysis = jobAnalysisFixture({
      jobDescriptionSha256: atsKeywordExtraction.jobDescriptionSha256,
      jdQuote: jobDescription,
    });
    const resume = await compiledResume("- TypeScript\n\n\n\n\n\n\n\n- services");
    const geometry = textTsv([{ blocks: [
      [[["-", 54, 91, 4, 11], ["TypeScript", 62, 91, 56, 11]]],
      [[["-", 54, 104, 4, 11], ["services", 62, 104, 42, 11]]],
    ] }]);

    const rendered = await renderKeywordMapArtifacts({
      ...resume,
      jobDescription,
      atsKeywordExtraction,
      analysis,
      processBoundary: boundary(geometry),
    });
    const document = await PDFDocument.load(
      await resume.artifacts.read(rendered.pdf.path, ARTIFACT_LIMITS.pdf),
    );
    let operators = "";
    for (const [, object] of document.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream)) continue;
      try {
        operators += Buffer.from(decodePDFRawStream(object).decode()).toString("latin1");
      } catch {
        // Font and image streams are not content streams and need not be text-decodable.
      }
    }

    expect(operators.match(/1 0\.85 0 rg/g)).toHaveLength(1);
    expect(operators).not.toContain("0.85 0.05 0.05 RG");
    const coverage = ResumeKeywordCoverageSchema.parse(
      await Bun.file(rendered.coverage.path).json(),
    );
    expect(coverage.keywords).toEqual([{
      id: "keyword-typescript-services",
      phrase: "TypeScript services",
      found: false,
    }]);
  });

  test("honors cancellation and surfaces pdftotext failures and malformed bbox output", async () => {
    const resume = await compiledResume();
    const analysis = jobAnalysisFixture();
    const atsKeywordExtraction = atsKeywordExtractionFixture({ rawJobDescription: "TypeScript role" });
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    controller.abort(reason);
    await expect(renderKeywordMapPdf({
      ...resume,
      jobDescription: "TypeScript role",
      analysis,
      atsKeywordExtraction,
      signal: controller.signal,
    })).rejects.toBe(reason);

    await expect(renderKeywordMapPdf({
      ...resume,
      jobDescription: "TypeScript role",
      analysis,
      atsKeywordExtraction,
      processBoundary: boundary("", 2, "syntax failure"),
    })).rejects.toThrow(/pdftotext bbox extraction failed: syntax failure/i);

    await expect(renderKeywordMapPdf({
      ...resume,
      jobDescription: "TypeScript role",
      analysis,
      atsKeywordExtraction,
      processBoundary: boundary("<doc><page width=\"612\" height=\"792\"></doc>"),
    })).rejects.toThrow(/exactly one page/i);
  });
});
