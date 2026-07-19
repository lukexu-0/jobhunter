import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_LIMITS, ArtifactStore, type ArtifactAddress, type ArtifactMetadata } from "../system/artifacts.ts";
import { runTrustedProcess, type ProcessBoundary, type TrustedProcessResult } from "../system/process.ts";

export const COMPILE_TIMEOUTS = Object.freeze({ full: 120_000, candidate: 60_000 });

export type CompileMode = "full" | "candidate";
export type CompileFailureClass = "repairable" | "terminal";

export interface CompileRequest {
  readonly artifacts: ArtifactStore;
  readonly address: ArtifactAddress;
  readonly tex: string;
  readonly mode: CompileMode;
  readonly signal?: AbortSignal;
  readonly processBoundary?: ProcessBoundary;
}

export interface CompileSuccess {
  readonly ok: true;
  readonly attemptRoot: string;
  readonly tex: ArtifactMetadata;
  readonly log: ArtifactMetadata;
  readonly pdf: ArtifactMetadata;
  readonly process: TrustedProcessResult;
}

export interface CompileFailure {
  readonly ok: false;
  readonly attemptRoot: string;
  readonly tex?: ArtifactMetadata;
  readonly log: ArtifactMetadata;
  readonly classification: CompileFailureClass;
  readonly reason: string;
  readonly process?: TrustedProcessResult;
}

export type CompileResult = CompileSuccess | CompileFailure;

const TEXMF_CONFIG = "openin_any = p\nopenout_any = p\nshell_escape = f\n";
// TeX's writable caches are private to the immutable attempt root.
const TEX_CACHE_DIRECTORIES = Object.freeze([
  ".tex-cache/tmp",
  ".tex-cache/texmf-home",
  ".tex-cache/texmf-var",
  ".tex-cache/fonts",
] as const);
const TRUSTED_COMPILE_ENTRY = "\\RequirePackage{lmodern}\n\\input{main.tex}\n";
const FORBIDDEN_TEX = /\\(?:afterassignment|aftergroup|catcode|chardef|closein|closeout|countdef|csname|def|directlua|dimendef|edef|endcsname|everycr|everydisplay|everyjob|everymath|everypar|expandafter|futurelet|gdef|ifeof|immediate|include|input|let|loop|mathchardef|muskipdef|newcommand|newenvironment|newread|newwrite|noexpand|openin|openout|pdf[A-Za-z@]*|providecommand|read|readline|renewcommand|renewenvironment|repeat|scantokens|shipout|skipdef|special|toksdef|write|write18|xdef)(?![A-Za-z@])/ig;
const TRUSTED_BASELINE_PRIMITIVES: Record<string, true> = {
  "\\newcommand": true,
  "\\renewcommand": true,
  "\\pdfgentounicode": true,
};
const SHELL_ESCAPE = /(?:--shell-escape|--enable-write18|\\(?:pdf)?shellescape\b)/i;
const PARENT_OR_ABSOLUTE_FILE = /(?:\\(?:input|include|includegraphics|bibliography|addbibresource|usepackage|documentclass)\s*(?:\[[^\]]*\]\s*)?\{\s*(?:\.\.(?:[\\/]|\})|[\\/]|[A-Za-z]:[\\/]))/i;
const REPAIRABLE_LOG = /(?:undefined control sequence|missing\s+[{}$]|extra\s+[{}$]|runaway argument|file ended while scanning use of|paragraph ended before \\[^\s]+ was complete|argument of \\[^\s]+ has an extra|misplaced alignment tab character|macro parameter character|illegal parameter number|use of \\[^\s]+ doesn't match its definition|too many \}'s|unbalanced|double subscript|double superscript)/i;
const TRUSTED_GLYPH_INPUT_PREFIX = "\\usepackage{tabularx}\n";
const TRUSTED_GLYPH_INPUT = "\\input{glyphtounicode}";
const TRUSTED_GLYPH_INPUT_SUFFIX = "\n\n\n%----------FONT OPTIONS----------";
const TRUSTED_BASELINE_END = "%%%%%%  RESUME STARTS HERE  %%%%%%%%%%%%%%%%%%%%%%%%%%%%";
const TRUSTED_BASELINE_SHA256 = "ef2669d6aa7cf0fc0fe2ccfd49c815c9a22aa736176f4206e5ec888f56fc1f4a";

function validateTex(tex: string): void {
  const bytes = Buffer.byteLength(tex, "utf8");
  if (bytes === 0) throw new Error("TeX source is empty");
  if (bytes > ARTIFACT_LIMITS.tex) throw new Error("TeX source exceeds 256 KiB");
  if (tex.includes("\0")) throw new Error("TeX source contains NUL");
  if (SHELL_ESCAPE.test(tex)) throw new Error("TeX shell escape is forbidden");
  if (tex.includes("^^")) throw new Error("forbidden TeX character translation");

  const baselineMarkerIndex = tex.indexOf(TRUSTED_BASELINE_END);
  const baselineEnd = baselineMarkerIndex < 0 ? -1 : baselineMarkerIndex + TRUSTED_BASELINE_END.length;
  const trustedBaselineEnd = baselineEnd > 0
    && tex.indexOf(TRUSTED_BASELINE_END, baselineEnd) < 0
    && createHash("sha256").update(tex.slice(0, baselineEnd), "utf8").digest("hex") === TRUSTED_BASELINE_SHA256
    ? baselineEnd
    : -1;
  const trustedAnchor = `${TRUSTED_GLYPH_INPUT_PREFIX}${TRUSTED_GLYPH_INPUT}${TRUSTED_GLYPH_INPUT_SUFFIX}`;
  const anchorIndex = trustedBaselineEnd < 0 ? -1 : tex.indexOf(trustedAnchor);
  const trustedInputIndex = anchorIndex < 0 || anchorIndex >= trustedBaselineEnd
    ? -1
    : anchorIndex + TRUSTED_GLYPH_INPUT_PREFIX.length;
  for (const match of tex.matchAll(FORBIDDEN_TEX)) {
    if (match[0].toLowerCase() === "\\input" && match.index === trustedInputIndex) continue;
    if (match.index < trustedBaselineEnd && TRUSTED_BASELINE_PRIMITIVES[match[0].toLowerCase()]) continue;
    throw new Error(`forbidden TeX primitive ${match[0]}`);
  }
  if (PARENT_OR_ABSOLUTE_FILE.test(tex)) throw new Error("parent or absolute TeX file access is forbidden");
}

async function processLog(artifacts: ArtifactStore, attemptRoot: string, result: TrustedProcessResult): Promise<Uint8Array> {
  let latexLog: Uint8Array | undefined;
  const rawLogPath = join(attemptRoot, "compile.log");
  try { latexLog = await artifacts.read(rawLogPath, ARTIFACT_LIMITS.log); } catch { /* stdout/stderr remain the bounded diagnostic source */ }
  await rm(rawLogPath, { force: true }).catch(() => undefined);
  const marker = Buffer.from("\n--- process output ---\n", "utf8");
  const stderrMarker = Buffer.from("\n--- stderr ---\n", "utf8");
  const parts = latexLog
    ? [Buffer.from(latexLog), marker, Buffer.from(result.stdout.data), stderrMarker, Buffer.from(result.stderr.data)]
    : [Buffer.from(result.stdout.data), stderrMarker, Buffer.from(result.stderr.data)];
  const total = Math.min(ARTIFACT_LIMITS.log, parts.reduce((bytes, part) => bytes + part.byteLength, 0));
  const output = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const part of parts) {
    if (offset >= total) break;
    const count = Math.min(part.byteLength, total - offset);
    part.copy(output, offset, 0, count);
    offset += count;
  }
  return output;
}

function classifyFailure(result: TrustedProcessResult, log: Uint8Array): { classification: CompileFailureClass; reason: string } {
  if (result.timedOut) return { classification: "terminal", reason: "compile timed out" };
  if (result.aborted) return { classification: "terminal", reason: "compile aborted" };
  const text = Buffer.from(log).toString("utf8");
  if (REPAIRABLE_LOG.test(text)) return { classification: "repairable", reason: "repairable TeX syntax, brace, escaping, or macro-call error" };
  return { classification: "terminal", reason: `latexmk exited with ${result.code ?? result.signal ?? "unknown status"}` };
}

async function finalizeFailure(artifacts: ArtifactStore, attemptRoot: string, logBytes: Uint8Array, reason: string, classification: CompileFailureClass, tex?: ArtifactMetadata, process?: TrustedProcessResult): Promise<CompileFailure> {
  await rm(join(attemptRoot, "compile.pdf"), { force: true }).catch(() => undefined);
  const logPath = join(attemptRoot, "compile.log");
  await rm(logPath, { force: true }).catch(() => undefined);
  const log = await artifacts.write(logPath, logBytes.subarray(0, ARTIFACT_LIMITS.log), ARTIFACT_LIMITS.log);
  return {
    ok: false,
    attemptRoot,
    ...(tex === undefined ? {} : { tex }),
    log,
    classification,
    reason,
    ...(process === undefined ? {} : { process }),
  };
}

export async function compileResume(request: CompileRequest): Promise<CompileResult> {
  const attemptRoot = await request.artifacts.createAttempt(request.address);
  let tex: ArtifactMetadata | undefined;
  try {
    validateTex(request.tex);
    tex = await request.artifacts.write(join(attemptRoot, "main.tex"), request.tex, ARTIFACT_LIMITS.tex);
    await request.artifacts.write(join(attemptRoot, "texmf.cnf"), TEXMF_CONFIG, 1024);
    await request.artifacts.write(join(attemptRoot, "compile.tex"), TRUSTED_COMPILE_ENTRY, 1024);
    for (const directory of TEX_CACHE_DIRECTORIES) {
      await mkdir(join(attemptRoot, directory), { recursive: true, mode: 0o700 });
    }
    let process: TrustedProcessResult;
    try {
      process = await runTrustedProcess({
        command: "latexmk",
        args: [
          "-pdf",
          "-pdflatex=pdflatex -interaction=nonstopmode -halt-on-error -file-line-error -no-shell-escape %O %S",
          "-interaction=nonstopmode",
          "-halt-on-error",
          "-file-line-error",
          "-no-shell-escape",
          "compile.tex",
        ],
        cwd: attemptRoot,
        timeoutMs: COMPILE_TIMEOUTS[request.mode],
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        stdoutLimit: ARTIFACT_LIMITS.stdout,
        stderrLimit: ARTIFACT_LIMITS.stderr,
        texmfConfigDirectory: ".",
      }, request.processBoundary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return await finalizeFailure(request.artifacts, attemptRoot, Buffer.from(message, "utf8"), `latexmk could not be started: ${message}`, "terminal", tex);
    }
    const logBytes = await processLog(request.artifacts, attemptRoot, process);
    if (process.code !== 0 || process.signal !== null || process.timedOut || process.aborted) {
      const failure = classifyFailure(process, logBytes);
      return await finalizeFailure(request.artifacts, attemptRoot, logBytes, failure.reason, failure.classification, tex, process);
    }
    let generatedPdf: Uint8Array;
    try {
      generatedPdf = await request.artifacts.read(join(attemptRoot, "compile.pdf"), ARTIFACT_LIMITS.pdf);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return await finalizeFailure(request.artifacts, attemptRoot, logBytes, `successful latexmk did not produce an acceptable PDF: ${message}`, "terminal", tex, process);
    }
    await rm(join(attemptRoot, "compile.pdf"));
    const pdf = await request.artifacts.write(join(attemptRoot, "resume.pdf"), generatedPdf, ARTIFACT_LIMITS.pdf);
    const log = await request.artifacts.write(join(attemptRoot, "compile.log"), logBytes, ARTIFACT_LIMITS.log);
    return { ok: true, attemptRoot, tex, log, pdf, process };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return await finalizeFailure(request.artifacts, attemptRoot, Buffer.from(message, "utf8"), message, "terminal", tex);
  }
}
