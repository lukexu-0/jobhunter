import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProcessBoundary, SpawnContract } from "../src/system/process.ts";
import { rasterizePdfPage, runDeterministicPdfQa } from "../src/resume/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; pdf: string }> {
  const root = await mkdtemp(join(tmpdir(), "pipeline-pdf-qa-"));
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
const BBOX = `<?xml version="1.0" encoding="UTF-8"?>
<doc><page width="612.000000" height="792.000000">
<word xMin="72.000000" yMin="72.000000" xMax="130.000000" yMax="84.000000">Experience</word>
<word xMin="72.000000" yMin="96.000000" xMax="220.000000" yMax="108.000000">Built reliable pipelines</word>
<word xMin="72.000000" yMin="132.000000" xMax="125.000000" yMax="144.000000">Education</word>
</page></doc>`;
const FONTS = `name                                 type              encoding         emb sub uni object ID
------------------------------------ ----------------- ---------------- --- --- --- ---------
ABCDEE+Inter                         TrueType          WinAnsi          yes yes yes      8  0
`;

describe("deterministic PDF QA", () => {
  test("reports every deterministic check for a valid one-page Letter resume", async () => {
    const { root, pdf } = await fixture();
    const contracts: SpawnContract[] = [];
    const report = await runDeterministicPdfQa({
      pdfPath: pdf,
      cwd: root,
      requiredHeadings: ["Experience", "Education"],
      selectedEvidenceText: ["Built reliable pipelines"],
      latexLog: "LaTeX Warning: Label changed.\nOverfull \\hbox (1.2pt too wide)",
      boundary: fakeBoundary([{ stdout: [PDFINFO] }, { stdout: [BBOX] }, { stdout: [FONTS] }], contracts),
    });

    expect(report.pass).toBe(true);
    expect(report.checks.map(({ id, status }) => [id, status])).toEqual([
      ["pdfinfo-output", "pass"],
      ["unencrypted", "pass"],
      ["one-page", "pass"],
      ["letter-size", "pass"],
      ["text-output", "pass"],
      ["required-headings", "pass"],
      ["selected-evidence", "pass"],
      ["font-output", "pass"],
      ["embedded-fonts", "pass"],
      ["word-bounds", "pass"],
    ]);
    expect(report.warnings).toEqual(["LaTeX Warning: Label changed.", "Overfull \\hbox (1.2pt too wide)"]);
    expect(contracts.map(({ command, args }) => [command, args])).toEqual([
      ["pdfinfo", ["-f", "1", "-l", "1", "-box", pdf]],
      ["pdftotext", ["-f", "1", "-l", "1", "-bbox-layout", "-enc", "UTF-8", pdf, "-"]],
      ["pdffonts", ["-f", "1", "-l", "1", pdf]],
    ]);
    for (const contract of contracts) {
      expect(contract.cwd).toBe(root);
      expect(contract.shell).toBe(false);
      expect(contract.env).toEqual({ PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC", SOURCE_DATE_EPOCH: "0" });
    }
  });

  test("keeps encrypted, page-count, and page-size failures independent", async () => {
    const { root, pdf } = await fixture();
    const cases = [
      { id: "unencrypted", info: PDFINFO.replace("Encrypted:       no", "Encrypted:       yes (print:yes copy:no)") },
      { id: "one-page", info: PDFINFO.replace("Pages:           1", "Pages:           2") },
      { id: "letter-size", info: PDFINFO.replace("612 x 792", "595 x 842") },
    ] as const;
    for (const item of cases) {
      const report = await runDeterministicPdfQa({
        pdfPath: pdf,
        cwd: root,
        requiredHeadings: ["Experience", "Education"],
        selectedEvidenceText: ["Built reliable pipelines"],
        boundary: fakeBoundary([{ stdout: [item.info] }, { stdout: [BBOX] }, { stdout: [FONTS] }]),
      });
      expect(report.pass).toBe(false);
      expect(report.checks.find(({ id }) => id === "pdfinfo-output")?.status).toBe("pass");
      expect(report.checks.find(({ id }) => id === item.id)?.status).toBe("fail");
    }
  });

  test("reports missing headings and selected ledger text as independent checks", async () => {
    const { root, pdf } = await fixture();
    for (const item of [
      { headings: ["Projects"], evidence: ["Built reliable pipelines"], failed: "required-headings", passed: "selected-evidence" },
      { headings: ["experience", "EDUCATION"], evidence: ["Reduced deployment time by 40%"], failed: "selected-evidence", passed: "required-headings" },
    ] as const) {
      const report = await runDeterministicPdfQa({
        pdfPath: pdf,
        cwd: root,
        requiredHeadings: item.headings,
        selectedEvidenceText: item.evidence,
        boundary: fakeBoundary([{ stdout: [PDFINFO] }, { stdout: [BBOX] }, { stdout: [FONTS] }]),
      });
      expect(report.checks.find(({ id }) => id === item.failed)?.status).toBe("fail");
      expect(report.checks.find(({ id }) => id === item.passed)?.status).toBe("pass");
    }
  });

  test("fails malformed and capped command output without hiding other command results", async () => {
    const { root, pdf } = await fixture();
    const oversized = Buffer.alloc(256 * 1024 + 1, 0x78);
    const report = await runDeterministicPdfQa({
      pdfPath: pdf,
      cwd: root,
      requiredHeadings: ["Experience"],
      selectedEvidenceText: ["Built reliable pipelines"],
      boundary: fakeBoundary([{ stdout: ["Pages definitely one"] }, { stdout: [oversized] }, { stdout: ["not a font table"] }]),
    });

    expect(report.pass).toBe(false);
    expect(Object.fromEntries(report.checks.map(({ id, status }) => [id, status]))).toMatchObject({
      "pdfinfo-output": "fail",
      "text-output": "fail",
      "font-output": "fail",
      "unencrypted": "fail",
      "selected-evidence": "fail",
      "embedded-fonts": "fail",
      "word-bounds": "fail",
    });
    expect(report.checks.find(({ id }) => id === "text-output")?.detail).toContain("exceeded 262144 bytes");
    expect(report.checks.every(({ detail }) => !detail.includes(root) && detail.length <= 240)).toBe(true);
  });

  test("rejects word boxes outside the page media and crop bounds", async () => {
    const { root, pdf } = await fixture();
    const report = await runDeterministicPdfQa({
      pdfPath: pdf,
      cwd: root,
      requiredHeadings: ["Experience"],
      selectedEvidenceText: ["Built reliable pipelines"],
      boundary: fakeBoundary([{ stdout: [PDFINFO] }, { stdout: [BBOX.replace('xMax=\"220.000000\"', 'xMax=\"613.000000\"')] }, { stdout: [FONTS] }]),
    });

    expect(report.checks.find(({ id }) => id === "word-bounds")?.status).toBe("fail");
    expect(report.checks.find(({ id }) => id === "selected-evidence")?.status).toBe("pass");
  });

  test("rejects unembedded and Type 3 fonts while preserving parsed font status", async () => {
    const { root, pdf } = await fixture();
    for (const fonts of [
      FONTS.replace("yes yes yes", "no  no  yes"),
      FONTS.replace("TrueType", "Type 3  "),
    ]) {
      const report = await runDeterministicPdfQa({
        pdfPath: pdf,
        cwd: root,
        requiredHeadings: ["Experience"],
        selectedEvidenceText: ["Built reliable pipelines"],
        boundary: fakeBoundary([{ stdout: [PDFINFO] }, { stdout: [BBOX] }, { stdout: [fonts] }]),
      });
      expect(report.checks.find(({ id }) => id === "font-output")?.status).toBe("pass");
      expect(report.checks.find(({ id }) => id === "embedded-fonts")?.status).toBe("fail");
    }
  });

  test("bounds warning count, length, and inspected LaTeX log bytes", async () => {
    const { root, pdf } = await fixture();
    const warning = `LaTeX Warning: ${"x".repeat(900)}`;
    const latexLog = `${Array.from({ length: 120 }, () => warning).join("\\n")}\\n${"z".repeat(1024 * 1024)}`;
    const report = await runDeterministicPdfQa({
      pdfPath: pdf,
      cwd: root,
      requiredHeadings: ["Experience"],
      selectedEvidenceText: ["Built reliable pipelines"],
      latexLog,
      boundary: fakeBoundary([{ stdout: [PDFINFO] }, { stdout: [BBOX] }, { stdout: [FONTS] }]),
    });

    expect(report.warnings.length).toBeLessThanOrEqual(100);
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings.every((value) => value.length <= 500)).toBe(true);
    expect(Buffer.byteLength(report.warnings.join(""))).toBeLessThanOrEqual(32 * 1024);
  });

  test("rejects a symlink PDF before invoking Poppler", async () => {
    const { root, pdf } = await fixture();
    const link = join(root, "linked.pdf");
    await symlink(pdf, link);
    let invoked = false;
    await expect(runDeterministicPdfQa({
      pdfPath: link,
      cwd: root,
      requiredHeadings: ["Experience"],
      selectedEvidenceText: [],
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

  test("accepts a PNG at the 25 MiB cap and rejects one byte above it", async () => {
    const atLimitFixture = await fixture();
    const atLimit = await rasterizePdfPage({
      pdfPath: atLimitFixture.pdf,
      outputPath: join(atLimitFixture.root, "page-1.png"),
      cwd: atLimitFixture.root,
      boundary: fakeBoundary([{
        onSpawn: async (contract) => {
          const png = Buffer.alloc(25 * 1024 * 1024);
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
          await writeFile(`${contract.args.at(-1)}.png`, png);
        },
      }]),
    });
    expect(atLimit.byteSize).toBe(25 * 1024 * 1024);

    const oversizedFixture = await fixture();
    await expect(rasterizePdfPage({
      pdfPath: oversizedFixture.pdf,
      outputPath: join(oversizedFixture.root, "page-1.png"),
      cwd: oversizedFixture.root,
      boundary: fakeBoundary([{
        onSpawn: async (contract) => {
          const png = Buffer.alloc(25 * 1024 * 1024 + 1);
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
          await writeFile(`${contract.args.at(-1)}.png`, png);
        },
      }]),
    })).rejects.toThrow("26214400 byte limit");
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
