import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileResume, type CompileRequest, type CompileResult } from "../src/resume/compiler.ts";
import {
  rasterizePdfPage,
  runDeterministicPdfQa,
  type DeterministicQaOptions,
  type DeterministicQaReport,
  type RasterizePdfOptions,
  type RasterizedPage,
} from "../src/resume/index.ts";
import { ArtifactStore } from "../src/system/artifacts.ts";

const JSON_BYTE_LIMIT = 8 * 1024;
const CANONICAL_SOURCE_PATH = resolve(import.meta.dir, "../../user-info/resume-main/Alex_Example_Resume.tex");
const ADDRESS = Object.freeze({ run: 1, revision: "canonical", stage: "compile", attempt: 1 });

export const RENDER_SMOKE_REQUIRED_HEADINGS = Object.freeze([
  "Education",
  "Experience",
  "Projects",
  "Competitions & Other",
  "Technical Skills",
] as const);

export type RenderSmokeErrorCode =
  | "source_invalid"
  | "source_changed"
  | "compile_failed"
  | "artifact_integrity_failed"
  | "cleanup_failed";

export class RenderSmokeError extends Error {
  readonly code: RenderSmokeErrorCode;

  constructor(code: RenderSmokeErrorCode) {
    super(code);
    this.name = "RenderSmokeError";
    this.code = code;
  }
}

export interface RenderSmokeDependencies {
  readonly createTemporaryRoot?: () => Promise<string>;
  readonly removeTemporaryRoot?: (root: string) => Promise<void>;
  readonly readCanonicalSource?: () => Promise<Uint8Array>;
  readonly compile?: (request: CompileRequest) => Promise<CompileResult>;
  readonly deterministicQa?: (options: DeterministicQaOptions) => Promise<DeterministicQaReport>;
  readonly rasterize?: (options: RasterizePdfOptions) => Promise<RasterizedPage>;
  readonly readArtifact?: (path: string) => Promise<Uint8Array>;
}

export interface RenderSmokeReport {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly source: {
    readonly sha256: string;
    readonly unchanged: true;
  };
  readonly compile: {
    readonly mode: "full";
    readonly texSha256: string;
    readonly pdfSha256: string;
    readonly pdfBytes: number;
  };
  readonly qa: {
    readonly pass: boolean;
    readonly checks: readonly {
      readonly id: DeterministicQaReport["checks"][number]["id"];
      readonly status: "pass" | "fail";
    }[];
    readonly warningCount: number;
  };
  readonly raster: {
    readonly page: 1;
    readonly dpi: 200;
    readonly pngSha256: string;
    readonly pngBytes: number;
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactUtf8(bytes: Uint8Array): string {
  const source = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(source, "utf8").equals(Buffer.from(bytes))) throw new RenderSmokeError("source_invalid");
  return source;
}

function integrity(condition: boolean): void {
  if (!condition) throw new RenderSmokeError("artifact_integrity_failed");
}

function errorCode(error: unknown): RenderSmokeErrorCode | "smoke_failed" {
  return error instanceof RenderSmokeError ? error.code : "smoke_failed";
}

export function renderRenderSmokeJson(report: RenderSmokeReport): string {
  const json = JSON.stringify(report);
  if (Buffer.byteLength(json, "utf8") > JSON_BYTE_LIMIT) throw new RenderSmokeError("artifact_integrity_failed");
  return json;
}

export async function runRenderSmoke(dependencies: RenderSmokeDependencies = {}): Promise<RenderSmokeReport> {
  const createTemporaryRoot = dependencies.createTemporaryRoot
    ?? (async () => await mkdtemp(join(tmpdir(), "jobhunter-render-smoke-")));
  const removeTemporaryRoot = dependencies.removeTemporaryRoot
    ?? (async (root: string) => await rm(root, { recursive: true, force: true }));
  const readCanonicalSource = dependencies.readCanonicalSource
    ?? (async () => await readFile(CANONICAL_SOURCE_PATH));
  const compile = dependencies.compile ?? compileResume;
  const deterministicQa = dependencies.deterministicQa ?? runDeterministicPdfQa;
  const rasterize = dependencies.rasterize ?? rasterizePdfPage;
  const readArtifact = dependencies.readArtifact ?? (async (path: string) => await readFile(path));

  const temporaryRoot = await createTemporaryRoot();
  let report: RenderSmokeReport | undefined;
  let failure: unknown;
  try {
    const sourceBytes = await readCanonicalSource();
    const sourceHash = sha256(sourceBytes);
    const source = exactUtf8(sourceBytes);
    const stagingRoot = join(temporaryRoot, "staging");
    const artifacts = new ArtifactStore(stagingRoot);
    const compiled = await compile({ artifacts, address: ADDRESS, tex: source, mode: "full" });
    if (!compiled.ok) throw new RenderSmokeError("compile_failed");
    integrity(compiled.tex.sha256 === sourceHash && compiled.tex.bytes === sourceBytes.byteLength);

    const [pdfBytes, latexLog] = await Promise.all([
      readArtifact(compiled.pdf.path),
      readArtifact(compiled.log.path),
    ]);
    const pdfHash = sha256(pdfBytes);
    integrity(compiled.pdf.bytes === pdfBytes.byteLength && compiled.pdf.sha256 === pdfHash);

    const qa = await deterministicQa({
      pdfPath: compiled.pdf.path,
      cwd: compiled.attemptRoot,
      requiredHeadings: RENDER_SMOKE_REQUIRED_HEADINGS,
      latexLog,
    });
    const raster = await rasterize({
      pdfPath: compiled.pdf.path,
      outputPath: join(compiled.attemptRoot, "resume-page-1.png"),
      cwd: compiled.attemptRoot,
    });
    integrity(raster.page === 1 && raster.dpi === 200 && raster.mediaType === "image/png");
    const pngBytes = await readArtifact(raster.path);
    integrity(raster.byteSize === pngBytes.byteLength);

    const finalSourceHash = sha256(await readCanonicalSource());
    if (finalSourceHash !== sourceHash) throw new RenderSmokeError("source_changed");

    report = Object.freeze({
      schemaVersion: 1,
      ok: qa.pass,
      source: Object.freeze({ sha256: sourceHash, unchanged: true }),
      compile: Object.freeze({
        mode: "full",
        texSha256: compiled.tex.sha256,
        pdfSha256: pdfHash,
        pdfBytes: pdfBytes.byteLength,
      }),
      qa: Object.freeze({
        pass: qa.pass,
        checks: Object.freeze(qa.checks.map(({ id, status }) => Object.freeze({ id, status }))),
        warningCount: qa.warnings.length,
      }),
      raster: Object.freeze({
        page: 1,
        dpi: 200,
        pngSha256: sha256(pngBytes),
        pngBytes: pngBytes.byteLength,
      }),
    });
    renderRenderSmokeJson(report);
  } catch (error) {
    failure = error;
  }

  try {
    await removeTemporaryRoot(temporaryRoot);
  } catch {
    if (failure === undefined) failure = new RenderSmokeError("cleanup_failed");
  }
  if (failure !== undefined) throw failure;
  return report!;
}

if (import.meta.main) {
  try {
    const report = await runRenderSmoke();
    console.log(renderRenderSmokeJson(report));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: errorCode(error) }));
    process.exitCode = 1;
  }
}
