import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ARTIFACT_LIMITS } from "../system/artifacts.ts";
import { runTrustedProcess, type ProcessBoundary } from "../system/process.ts";

export interface RasterizedPage {
  readonly mediaType: "image/png";
  readonly page: 1;
  readonly dpi: 200;
  readonly byteSize: number;
  readonly path: string;
}

export interface RasterizePdfOptions {
  readonly pdfPath: string;
  readonly outputPath: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly boundary?: ProcessBoundary;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RASTER_TIMEOUT_MS = 60_000;

async function regularInput(path: string): Promise<string> {
  const absolute = resolve(path);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("PDF input must be a regular non-symlink file");
  if (stat.size > ARTIFACT_LIMITS.pdf) throw new Error(`PDF input exceeds ${ARTIFACT_LIMITS.pdf} byte limit`);
  if (await realpath(absolute) !== absolute) throw new Error("PDF input path must not traverse symlinks");
  return absolute;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function generatedNames(parent: string, prefixName: string): Promise<readonly string[]> {
  return (await readdir(parent)).filter((name) => name.startsWith(prefixName));
}

export async function rasterizePdfPage(options: RasterizePdfOptions): Promise<RasterizedPage> {
  const pdfPath = await regularInput(options.pdfPath);
  const cwd = resolve(options.cwd);
  const outputPath = resolve(options.outputPath);
  if (!contained(cwd, outputPath)) throw new Error("PNG output must remain within the working directory");
  if (extname(outputPath).toLowerCase() !== ".png") throw new Error("PNG output path must use the .png extension");
  const parent = dirname(outputPath);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await realpath(parent) !== parent) throw new Error("PNG output parent must be a real non-symlink directory");
  const temporaryPrefix = join(parent, `.${basename(outputPath)}.${randomBytes(12).toString("hex")}.pdftoppm`);
  const temporaryName = basename(temporaryPrefix);
  const expectedTemporaryPath = `${temporaryPrefix}.png`;
  let reserved = false;
  try {
    const reservation = await open(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await reservation.close();
    reserved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("PNG output is immutable and must not already exist");
    throw error;
  }

  try {
    const result = await runTrustedProcess({
      command: "pdftoppm",
      args: ["-f", "1", "-l", "1", "-singlefile", "-r", "200", "-png", pdfPath, temporaryPrefix],
      cwd,
      timeoutMs: RASTER_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      stdoutLimit: ARTIFACT_LIMITS.stdout,
      stderrLimit: ARTIFACT_LIMITS.stderr,
    }, options.boundary);
    if (result.timedOut) throw new Error("pdftoppm timed out");
    if (result.aborted) throw new Error("pdftoppm was aborted");
    if (result.code !== 0 || result.signal !== null) throw new Error("pdftoppm exited unsuccessfully");
    if (result.stdout.truncated || result.stderr.truncated) throw new Error("pdftoppm diagnostic output exceeded its byte limit");

    const generated = await generatedNames(parent, temporaryName);
    if (generated.length !== 1 || generated[0] !== basename(expectedTemporaryPath)) throw new Error("pdftoppm did not produce exactly one PNG artifact");
    const stat = await lstat(expectedTemporaryPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("raster output must be a regular non-symlink file");
    if (stat.size > ARTIFACT_LIMITS.png) throw new Error(`PNG output exceeds ${ARTIFACT_LIMITS.png} byte limit`);
    const png = await readFile(expectedTemporaryPath);
    if (png.byteLength > ARTIFACT_LIMITS.png) throw new Error(`PNG output exceeds ${ARTIFACT_LIMITS.png} byte limit`);
    if (png.byteLength < PNG_SIGNATURE.byteLength || !png.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) throw new Error("raster output is not a PNG");
    await chmod(expectedTemporaryPath, 0o600);

    await rename(expectedTemporaryPath, outputPath);
    return Object.freeze({ mediaType: "image/png", page: 1, dpi: 200, byteSize: png.byteLength, path: outputPath });
  } catch (error) {
    if (reserved) await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    const leftovers = await generatedNames(parent, temporaryName).catch(() => []);
    for (const name of leftovers) await rm(join(parent, name), { recursive: true, force: true }).catch(() => undefined);
  }
}
