import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProcessBoundary, SpawnContract } from "../src/system/process.ts";
import { compileResume, rasterizePdfPage, runDeterministicPdfQa } from "../src/resume/index.ts";
import { ARTIFACT_LIMITS, ArtifactStore } from "../src/system/artifacts.ts";
import { textTsv, textPage } from "./pdf-text.fixture.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; pdf: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pipeline-pdf-qa-")));
  roots.push(root);
  const pdf = join(root, "resume.pdf");
  await writeFile(pdf, "%PDF-1.7\nfixture");
  return { root, pdf };
}

function output(chunks: readonly (string | Uint8Array)[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) yield typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  })();
}

interface FakeResult {
  readonly stdout?: readonly (string | Uint8Array)[];
  readonly stderr?: readonly (string | Uint8Array)[];
  readonly code?: number;
  readonly signal?: NodeJS.Signals | null;
  readonly onSpawn?: (contract: SpawnContract) => void | Promise<void>;
}

function fakeBoundary(results: readonly FakeResult[], contracts: SpawnContract[] = []): ProcessBoundary {
  let index = 0;
  return (contract) => {
    contracts.push(contract);
    const result = results[index++];
    if (!result) throw new Error(`unexpected command ${contract.command}`);
    const spawned = Promise.resolve(result.onSpawn?.(contract));
    return {
      pid: -1,
      stdout: (async function* () { await spawned; yield* output(result.stdout ?? []); })(),
      stderr: (async function* () { await spawned; yield* output(result.stderr ?? []); })(),
      wait: async () => { await spawned; return { code: result.code ?? 0, signal: result.signal ?? null }; },
      kill: async () => undefined,
    };
  };
}

const PDFINFO = `Pages:           1
Encrypted:       no
Page size:       612 x 792 pts (letter)
MediaBox:        0.00 0.00 612.00 792.00
CropBox:         0.00 0.00 612.00 792.00
`;
const TEXT = textTsv([textPage("Experience", "Built reliable pipelines", "K–9", "Education")]);
const FONTS = `name                                 type              encoding         emb sub uni object ID
------------------------------------ ----------------- ---------------- --- --- --- ---------
ABCDEE+Inter                         TrueType          WinAnsi          yes yes yes      8  0
`;

describe("deterministic PDF QA", () => {
  test.skipIf(!Bun.which("latexmk") || !Bun.which("pdftotext"))("checks a compiled PDF with empty metadata without crashing text extraction", async () => {
    const { root } = await fixture();
    const compiled = await compileResume({
      artifacts: new ArtifactStore(root),
      address: { run: 1, revision: "1", stage: "compiling", attempt: 1 },
      mode: "full",
      tex: String.raw`
        \documentclass[letterpaper]{article}
        \usepackage[T1]{fontenc}
        \usepackage{hyperref}
        \hypersetup{pdftitle={},pdfauthor={},pdfsubject={}}
        \begin{document}
        \section*{Experience} Built reliable systems.
        \section*{Education} Computer Science.
        \end{document}
      `,
    });
    if (!compiled.ok) throw new Error(compiled.reason);
    const report = await runDeterministicPdfQa({
      pdfPath: compiled.pdf.path,
      cwd: compiled.attemptRoot,
      requiredHeadings: ["Experience", "Education"],
    });
    expect(report.checks.filter(({ status }) => status === "fail")).toEqual([]);
    expect(report.pass).toBe(true);
  });

  test("reports every deterministic check for a valid one-page Letter resume", async () => {
    const { root, pdf } = await fixture();
    const report = await runDeterministicPdfQa({
      pdfPath: pdf, cwd: root, requiredHeadings: ["Experience", "Education"],
      boundary: fakeBoundary([{ stdout: [PDFINFO] }, { stdout: [TEXT] }, { stdout: [FONTS] }]),
    });
    expect(report.pass).toBe(true);
    expect(report.pageCount).toBe(1);
    expect(report.pagesOverLimit).toBe(0);
    expect(report.overflowLineCount).toBe(0);
    expect(report.checks.filter(({ status }) => status === "fail")).toEqual([]);
  });

  test("counts visible lines across every overflow page without counting words or empty lines", async () => {
    const { root, pdf } = await fixture();
    const report = await runDeterministicPdfQa({
      pdfPath: pdf, cwd: root, requiredHeadings: ["Experience", "Education"],
      boundary: fakeBoundary([
        { stdout: [PDFINFO.replace("Pages:           1", "Pages:           3")] },
        { stdout: [textTsv([
          textPage("Experience"),
          { blocks: [[[], [["Education", 72, 72, 70, 12]], [["Computer", 72, 96, 70, 12], ["Science", 148, 96, 70, 12]]]] },
          textPage("Projects", "Built systems", "Delivered software", "Technical Skills"),
        ])] },
        { stdout: [FONTS] },
      ]),
    });
    expect(report.checks.filter(({ status }) => status === "fail").map(({ id }) => id)).toEqual(["one-page"]);
    expect(report.pageCount).toBe(3);
    expect(report.pagesOverLimit).toBe(2);
    expect(report.overflowLineCount).toBe(6);
  });

  test("fails closed when pdfinfo and extracted-text page counts disagree", async () => {
    const { root, pdf } = await fixture();
    for (const pages of [1, 3]) {
      const report = await runDeterministicPdfQa({
        pdfPath: pdf, cwd: root, requiredHeadings: ["Experience"],
        boundary: fakeBoundary([
          { stdout: [PDFINFO.replace("Pages:           1", "Pages:           " + pages)] },
          { stdout: [textTsv([textPage("Experience"), textPage("Overflow")])] },
          { stdout: [FONTS] },
        ]),
      });
      expect(report.checks.find(({ id }) => id === "page-count-consistency")?.status).toBe("fail");
    }
  });

  test("does not match a required heading across a page boundary", async () => {
    const { root, pdf } = await fixture();
    const report = await runDeterministicPdfQa({
      pdfPath: pdf, cwd: root, requiredHeadings: ["Technical Skills"],
      boundary: fakeBoundary([
        { stdout: [PDFINFO.replace("Pages:           1", "Pages:           2")] },
        { stdout: [textTsv([textPage("Technical"), textPage("Skills")])] },
        { stdout: [FONTS] },
      ]),
    });
    expect(report.checks.filter(({ status }) => status === "fail").map(({ id }) => id)).toEqual(["one-page", "required-headings"]);
    expect(report.overflowLineCount).toBe(1);
  });

  test("keeps encryption, page count, and page size checks independent", async () => {
    const { root, pdf } = await fixture();
    const cases = [
      { id: "unencrypted", info: PDFINFO.replace("Encrypted:       no", "Encrypted:       yes (print:yes copy:no)") },
      { id: "one-page", info: PDFINFO.replace("Pages:           1", "Pages:           2") },
      { id: "letter-size", info: PDFINFO.replace("612 x 792", "595 x 842") },
    ];
    for (const item of cases) {
      const report = await runDeterministicPdfQa({
        pdfPath: pdf, cwd: root, requiredHeadings: ["Experience"],
        boundary: fakeBoundary([{ stdout: [item.info] }, { stdout: [TEXT] }, { stdout: [FONTS] }]),
      });
      expect(report.checks.find(({ id }) => id === "pdfinfo-output")?.status).toBe("pass");
      expect(report.checks.find(({ id }) => id === item.id)?.status).toBe("fail");
    }
  });

  test("reports missing headings", async () => {
    const { root, pdf } = await fixture();
    const report = await runDeterministicPdfQa({
      pdfPath: pdf, cwd: root, requiredHeadings: ["Projects"],
      boundary: fakeBoundary([{ stdout: [PDFINFO] }, { stdout: [TEXT] }, { stdout: [FONTS] }]),
    });
    expect(report.checks.find(({ id }) => id === "required-headings")?.status).toBe("fail");
  });

  test("rejects malformed and capped command output without hiding other results", async () => {
    const { root, pdf } = await fixture();
    const report = await runDeterministicPdfQa({
      pdfPath: pdf, cwd: root, requiredHeadings: ["Experience"],
      boundary: fakeBoundary([
        { stdout: ["Pages definitely one"] },
        { stdout: [Buffer.alloc(ARTIFACT_LIMITS.stdout + 1, 0x78)] },
        { stdout: ["not a font table"] },
      ]),
    });
    expect(report.pass).toBe(false);
    expect(report.pageCount).toBeNull();
    expect(report.pagesOverLimit).toBeNull();
    for (const id of ["pdfinfo-output", "text-output", "font-output"]) {
      expect(report.checks.find((check) => check.id === id)?.status).toBe("fail");
    }
    expect(report.checks.every(({ detail }) => !detail.includes(root) && detail.length <= 240)).toBe(true);
  });

  test("rejects malformed text hierarchy rather than accepting partial geometry", async () => {
    const { root, pdf } = await fixture();
    const malformed = TEXT.split("\n").filter((row) => !row.startsWith("4\t")).join("\n");
    const report = await runDeterministicPdfQa({
      pdfPath: pdf, cwd: root, requiredHeadings: ["Experience"],
      boundary: fakeBoundary([{ stdout: [PDFINFO] }, { stdout: [malformed] }, { stdout: [FONTS] }]),
    });
    expect(report.checks.find(({ id }) => id === "text-output")?.status).toBe("fail");
  });

  test("rejects out-of-bounds and zero-area words while retaining parsed text", async () => {
    const { root, pdf } = await fixture();
    for (const [left, top, width, height] of [[72, 72, 541, 12], [-1, 72, 70, 12], [72, 72, 0, 12], [72, 72, 70, 0]]) {
      const report = await runDeterministicPdfQa({
        pdfPath: pdf, cwd: root, requiredHeadings: ["Experience"],
        boundary: fakeBoundary([
          { stdout: [PDFINFO] },
          { stdout: [textTsv([{ blocks: [[[["Experience", left!, top!, width!, height!]]]] }])] },
          { stdout: [FONTS] },
        ]),
      });
      expect(report.checks.find(({ id }) => id === "text-output")?.status).toBe("pass");
      expect(report.checks.find(({ id }) => id === "required-headings")?.status).toBe("pass");
      expect(report.checks.find(({ id }) => id === "word-bounds")?.status).toBe("fail");
    }
  });

  test("rejects unembedded and Type 3 fonts while preserving parsed font status", async () => {
    const { root, pdf } = await fixture();
    for (const fonts of [FONTS.replace("yes yes yes", "no  no  yes"), FONTS.replace("TrueType", "Type 3  ")]) {
      const report = await runDeterministicPdfQa({
        pdfPath: pdf, cwd: root, requiredHeadings: ["Experience"],
        boundary: fakeBoundary([{ stdout: [PDFINFO] }, { stdout: [TEXT] }, { stdout: [fonts] }]),
      });
      expect(report.checks.find(({ id }) => id === "font-output")?.status).toBe("pass");
      expect(report.checks.find(({ id }) => id === "embedded-fonts")?.status).toBe("fail");
    }
  });

  test("bounds warning count, length, and inspected LaTeX log bytes", async () => {
    const { root, pdf } = await fixture();
    const report = await runDeterministicPdfQa({
      pdfPath: pdf, cwd: root, requiredHeadings: ["Experience"],
      latexLog: ("LaTeX Warning: " + "x".repeat(900) + "\n").repeat(120) + "z".repeat(ARTIFACT_LIMITS.log),
      boundary: fakeBoundary([{ stdout: [PDFINFO] }, { stdout: [TEXT] }, { stdout: [FONTS] }]),
    });
    expect(report.warnings).toHaveLength(100);
    expect(report.warnings.every((value) => value.length <= 500)).toBe(true);
    expect(Buffer.byteLength(report.warnings.join(""))).toBeLessThanOrEqual(32 * 1024);
  });

  test("rejects a symlink PDF before invoking Poppler", async () => {
    const { root, pdf } = await fixture();
    const link = join(root, "linked.pdf");
    await symlink(pdf, link);
    let invoked = false;
    await expect(runDeterministicPdfQa({
      pdfPath: link, cwd: root, requiredHeadings: ["Experience"],
      boundary: () => { invoked = true; throw new Error("must not run"); },
    })).rejects.toThrow("non-symlink");
    expect(invoked).toBe(false);
  });
});

describe("PDF page rasterization", () => {
  test("writes only page 1 as a validated 200 DPI PNG with exact Poppler arguments", async () => {
    const { root, pdf } = await fixture();
    const outputPath = join(root, "page-1.png");
    const contracts: SpawnContract[] = [];
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const page = await rasterizePdfPage({
      pdfPath: pdf,
      outputPath,
      cwd: root,
      boundary: fakeBoundary([{
        onSpawn: async (contract) => {
          await writeFile(`${contract.args.at(-1)}.png`, png);
        },
      }], contracts),
    });

    expect(page).toEqual({ mediaType: "image/png", page: 1, dpi: 200, byteSize: 11, path: outputPath });
    expect(await readFile(outputPath)).toEqual(png);
    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.command).toBe("pdftoppm");
    expect(contracts[0]?.args.slice(0, 9)).toEqual([
      "-f", "1", "-l", "1", "-singlefile", "-r", "200", "-png", pdf,
    ]);
    expect(contracts[0]?.args.at(-1)?.startsWith(join(root, ".page-1.png."))).toBe(true);
    expect(contracts[0]?.args.at(-1)?.endsWith(".pdftoppm")).toBe(true);
    expect(contracts[0]?.cwd).toBe(root);
    expect(contracts[0]?.shell).toBe(false);
  });

  test("rejects non-PNG output and removes the temporary artifact", async () => {
    const { root, pdf } = await fixture();
    const outputPath = join(root, "page-1.png");
    const contracts: SpawnContract[] = [];
    await expect(rasterizePdfPage({
      pdfPath: pdf,
      outputPath,
      cwd: root,
      boundary: fakeBoundary([{
        onSpawn: async (contract) => writeFile(`${contract.args.at(-1)}.png`, "not png"),
      }], contracts),
    })).rejects.toThrow("not a PNG");
    await expect(readFile(outputPath)).rejects.toThrow();
    await expect(readFile(`${contracts[0]?.args.at(-1)}.png`)).rejects.toThrow();
  });

  test("accepts a PNG at the canonical cap and rejects one byte above it", async () => {
    const atLimitFixture = await fixture();
    const atLimit = await rasterizePdfPage({
      pdfPath: atLimitFixture.pdf,
      outputPath: join(atLimitFixture.root, "page-1.png"),
      cwd: atLimitFixture.root,
      boundary: fakeBoundary([{
        onSpawn: async (contract) => {
          const png = Buffer.alloc(ARTIFACT_LIMITS.png);
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
          await writeFile(`${contract.args.at(-1)}.png`, png);
        },
      }]),
    });
    expect(atLimit.byteSize).toBe(ARTIFACT_LIMITS.png);

    const oversizedFixture = await fixture();
    await expect(rasterizePdfPage({
      pdfPath: oversizedFixture.pdf,
      outputPath: join(oversizedFixture.root, "page-1.png"),
      cwd: oversizedFixture.root,
      boundary: fakeBoundary([{
        onSpawn: async (contract) => {
          const png = Buffer.alloc(ARTIFACT_LIMITS.png + 1);
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
          await writeFile(`${contract.args.at(-1)}.png`, png);
        },
      }]),
    })).rejects.toThrow(`${ARTIFACT_LIMITS.png} byte limit`);
  });

  test("rejects extra page or side artifacts from pdftoppm", async () => {
    const { root, pdf } = await fixture();
    await expect(rasterizePdfPage({
      pdfPath: pdf,
      outputPath: join(root, "page-1.png"),
      cwd: root,
      boundary: fakeBoundary([{
        onSpawn: async (contract) => {
          const prefix = contract.args.at(-1);
          await writeFile(`${prefix}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
          await writeFile(`${prefix}-2.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        },
      }]),
    })).rejects.toThrow("exactly one PNG artifact");
  });

  test("rejects a symlink emitted as the raster artifact", async () => {
    const { root, pdf } = await fixture();
    const realPng = join(root, "real.png");
    await writeFile(realPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await expect(rasterizePdfPage({
      pdfPath: pdf,
      outputPath: join(root, "page-1.png"),
      cwd: root,
      boundary: fakeBoundary([{
        onSpawn: async (contract) => symlink(realPng, `${contract.args.at(-1)}.png`),
      }]),
    })).rejects.toThrow("non-symlink file");
  });

  test("rejects output escapes, symlink parents, and immutable overwrites before Poppler runs", async () => {
    const { root, pdf } = await fixture();
    const real = join(root, "real");
    const linked = join(root, "linked");
    await mkdir(real);
    await symlink(real, linked);
    const never: ProcessBoundary = () => { throw new Error("Poppler must not run"); };
    await expect(rasterizePdfPage({ pdfPath: pdf, outputPath: join(root, "..", "escape.png"), cwd: root, boundary: never })).rejects.toThrow("within the working directory");
    await expect(rasterizePdfPage({ pdfPath: pdf, outputPath: join(linked, "page.png"), cwd: root, boundary: never })).rejects.toThrow("non-symlink directory");
    const existing = join(root, "existing.png");
    await writeFile(existing, "immutable");
    await expect(rasterizePdfPage({ pdfPath: pdf, outputPath: existing, cwd: root, boundary: never })).rejects.toThrow("must not already exist");
  });
});
