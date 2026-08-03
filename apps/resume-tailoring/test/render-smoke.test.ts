import { describe, expect, test } from "bun:test";
import type { CompileResult } from "../src/resume/compiler.ts";
import {
  RENDER_SMOKE_REQUIRED_HEADINGS,
  RenderSmokeError,
  renderRenderSmokeJson,
  runRenderSmoke,
  type RenderSmokeDependencies,
} from "../scripts/render-smoke.ts";

const SOURCE_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const PDF_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const PNG_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const workspace = "/private/render-smoke-TOKEN-secret";
const pdfPath = `${workspace}/staging/resume.pdf`;
const logPath = `${workspace}/staging/compile.log`;
const pngPath = `${workspace}/staging/page-1.png`;

function compileSuccess(): CompileResult {
  const empty = { data: new Uint8Array(), bytes: 0, truncated: false } as const;
  return {
    ok: true,
    attemptRoot: `${workspace}/staging/attempt`,
    tex: { path: `${workspace}/staging/main.tex`, bytes: 3, sha256: SOURCE_SHA256 },
    log: { path: logPath, bytes: 0, sha256: PDF_SHA256 },
    pdf: { path: pdfPath, bytes: 0, sha256: PDF_SHA256 },
    process: {
      command: "latexmk",
      args: [],
      pid: 1,
      processStartToken: null,
      code: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      killAcknowledged: false,
      stdout: empty,
      stderr: empty,
    },
  };
}

function healthyDependencies(overrides: Partial<RenderSmokeDependencies> = {}): RenderSmokeDependencies {
  return {
    createTemporaryRoot: async () => workspace,
    removeTemporaryRoot: async () => {},
    readCanonicalSource: async () => Buffer.from("abc"),
    compile: async () => compileSuccess(),
    deterministicQa: async () => ({
      pass: true,
      checks: [
        { id: "one-page", status: "pass", detail: "PDF has exactly one page" },
        { id: "required-headings", status: "pass", detail: "all required headings are visible" },
      ],
      warnings: [],
      overflowLineCount: 0,
    }),
    rasterize: async () => ({ mediaType: "image/png", page: 1, dpi: 200, byteSize: 5, path: pngPath }),
    readArtifact: async (path) => path === pngPath ? Buffer.from("hello") : new Uint8Array(),
    ...overrides,
  };
}

describe("render smoke public boundary", () => {
  test("orchestrates exact canonical bytes through full compile, QA, and 200 DPI rasterization, then emits bounded path-free JSON", async () => {
    const calls: string[] = [];
    let compiledTex = "";
    let headings: readonly string[] = [];
    const dependencies = healthyDependencies({
      compile: async (request) => {
        calls.push("compile");
        expect(request.mode).toBe("full");
        expect(request.artifacts.root).toBe(`${workspace}/staging`);
        compiledTex = request.tex;
        return compileSuccess();
      },
      deterministicQa: async (request) => {
        calls.push("qa");
        expect(request.pdfPath).toBe(pdfPath);
        expect(request.cwd).toBe(`${workspace}/staging/attempt`);
        headings = request.requiredHeadings;
        return {
          pass: true,
          checks: [{ id: "required-headings", status: "pass", detail: "all required headings are visible" }],
          warnings: ["bounded warning"],
          overflowLineCount: 0,
        };
      },
      rasterize: async (request) => {
        calls.push("rasterize");
        expect(request.pdfPath).toBe(pdfPath);
        expect(request.cwd).toBe(`${workspace}/staging/attempt`);
        return { mediaType: "image/png", page: 1, dpi: 200, byteSize: 5, path: pngPath };
      },
      removeTemporaryRoot: async (root) => {
        calls.push("cleanup");
        expect(root).toBe(workspace);
      },
    });

    const report = await runRenderSmoke(dependencies);
    const json = renderRenderSmokeJson(report);

    expect(calls).toEqual(["compile", "qa", "rasterize", "cleanup"]);
    expect(compiledTex).toBe("abc");
    expect(headings).toEqual(RENDER_SMOKE_REQUIRED_HEADINGS);
    expect(report).toEqual({
      schemaVersion: 1,
      ok: true,
      source: { sha256: SOURCE_SHA256, unchanged: true },
      compile: { mode: "full", texSha256: SOURCE_SHA256, pdfSha256: PDF_SHA256, pdfBytes: 0 },
      qa: { pass: true, checks: [{ id: "required-headings", status: "pass" }], warningCount: 1 },
      raster: { page: 1, dpi: 200, pngSha256: PNG_SHA256, pngBytes: 5 },
    });
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(8 * 1024);
    expect(json).not.toContain(workspace);
    expect(json).not.toContain("TOKEN");
    expect(json).not.toContain(".tex");
    expect(json).not.toContain(".pdf");
    expect(json).not.toContain(".png");
  });

  test("refuses a result when the canonical source hash changes and still removes staging files", async () => {
    let reads = 0;
    let cleaned = false;
    const dependencies = healthyDependencies({
      readCanonicalSource: async () => Buffer.from(++reads === 1 ? "abc" : "changed"),
      removeTemporaryRoot: async () => { cleaned = true; },
    });

    try {
      await runRenderSmoke(dependencies);
      throw new Error("expected source hash mismatch refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(RenderSmokeError);
      expect((error as RenderSmokeError).code).toBe("source_changed");
    }
    expect(cleaned).toBeTrue();
  });

  test("cleans staging when compilation fails without exposing compiler diagnostics", async () => {
    let cleaned = false;
    const dependencies = healthyDependencies({
      compile: async () => ({
        ok: false,
        attemptRoot: `${workspace}/staging/attempt`,
        log: { path: logPath, bytes: 0, sha256: PDF_SHA256 },
        classification: "terminal",
        reason: `latexmk leaked ${workspace}`,
      }),
      removeTemporaryRoot: async () => { cleaned = true; },
    });

    await expect(runRenderSmoke(dependencies)).rejects.toMatchObject({ code: "compile_failed" });
    expect(cleaned).toBeTrue();
  });
});
