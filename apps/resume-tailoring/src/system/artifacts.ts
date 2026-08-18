import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const ARTIFACT_LIMITS = Object.freeze({
  tex: 524_288,
  stdout: 524_288,
  stderr: 524_288,
  log: 2_097_152,
  pdf: 20_971_520,
  png: 52_428_800,
});

export interface ArtifactMetadata {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ArtifactAddress {
  readonly run: number;
  readonly revision: string;
  readonly stage: string;
  readonly attempt: number;
}

export interface RunInputAddress {
  readonly run: number;
}

export interface ReservedRunInput {
  readonly run: number;
  readonly path: string;
}

export class RunOutputExistsError extends Error {
  constructor(readonly run: number) {
    super(`run output ${run} already exists`);
    this.name = "RunOutputExistsError";
  }
}

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function component(value: string, label: string): string {
  if (!SAFE_COMPONENT.test(value) || value === "." || value === "..") throw new Error(`invalid ${label}`);
  return value;
}

function runComponent(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid run sequence");
  return String(value);
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function rejectSymlinks(root: string, candidate: string): Promise<void> {
  if (!contained(root, candidate)) throw new Error("artifact path escapes its root");
  const rel = relative(root, candidate);
  let cursor = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`symlink is not allowed in artifact path: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function createContainedDirectory(root: string, target: string, existingMessage: string): Promise<string> {
  if (!contained(root, target)) throw new Error("artifact path escapes its root");
  const parts = relative(root, target).split(sep).filter(Boolean);
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`artifact directory must not be a symlink: ${cursor}`);
      if (index === parts.length - 1) throw new Error(existingMessage);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(cursor, { mode: 0o700 });
    }
    await chmod(cursor, 0o700);
  }
  return target;
}

export const DEFAULT_ARTIFACT_ROOT = resolve(import.meta.dir, "../../../../output/runs");
export const LEGACY_ARTIFACT_ROOT = resolve(import.meta.dir, "../../data/runs");

export class ArtifactStore {
  readonly root: string;

  constructor(root = process.env.JOBHUNTER_ARTIFACT_ROOT ?? DEFAULT_ARTIFACT_ROOT) {
    this.root = resolve(root);
  }

  async initialize(): Promise<void> {
    try {
      const stat = await lstat(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("artifact root must be a real directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(this.root, { recursive: true, mode: 0o700 });
    }
    await chmod(this.root, 0o700);
  }

  runRoot(run: number): string {
    const result = resolve(this.root, runComponent(run));
    if (!contained(this.root, result)) throw new Error("run path escapes artifact root");
    return result;
  }

  attemptRoot(address: ArtifactAddress): string {
    const revision = component(address.revision, "revision id");
    const stage = component(address.stage, "stage");
    if (!Number.isSafeInteger(address.attempt) || address.attempt < 0) throw new Error("invalid attempt number");
    const result = resolve(this.runRoot(address.run), "revisions", revision, "attempts", `${stage}-${address.attempt}`);
    if (!contained(this.root, result)) throw new Error("attempt path escapes artifact root");
    return result;
  }

  inputRoot(address: RunInputAddress): string {
    const result = resolve(this.runRoot(address.run), "input");
    if (!contained(this.root, result)) throw new Error("input path escapes artifact root");
    return result;
  }

  async createRunInput(address: RunInputAddress): Promise<string> {
    await this.initialize();
    const runRoot = this.runRoot(address.run);
    try {
      await mkdir(runRoot, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await lstat(runRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`run output must not be a symlink: ${runRoot}`);
      }
      throw new RunOutputExistsError(address.run);
    }
    try {
      await chmod(runRoot, 0o700);
      const inputRoot = this.inputRoot(address);
      await mkdir(inputRoot, { mode: 0o700 });
      await chmod(inputRoot, 0o700);
      return inputRoot;
    } catch (error) {
      await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async reserveRunInput(minimumRun: number): Promise<ReservedRunInput> {
    for (let run = minimumRun; Number.isSafeInteger(run); run++) {
      try {
        return { run, path: await this.createRunInput({ run }) };
      } catch (error) {
        if (error instanceof RunOutputExistsError) continue;
        throw error;
      }
    }
    throw new Error("no run output sequence is available");
  }

  async createAttempt(address: ArtifactAddress): Promise<string> {
    await this.initialize();
    return await createContainedDirectory(this.root, this.attemptRoot(address), "artifact attempt already exists");
  }

  async removeRun(run: number): Promise<boolean> {
    await this.initialize();
    const target = this.runRoot(run);
    let stat;
    try {
      stat = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`run artifact root must be a real directory: ${target}`);

    const claim = join(this.root, `.${runComponent(run)}.${process.pid}.${randomBytes(12).toString("hex")}.removing`);
    if (!contained(this.root, claim)) throw new Error("run removal claim escapes artifact root");
    try {
      await rename(target, claim);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }

    let deleted = false;
    try {
      const claimedStat = await lstat(claim);
      if (!claimedStat.isDirectory() || claimedStat.isSymbolicLink()) {
        throw new Error(`run artifact root must be a real directory: ${target}`);
      }
      await rm(claim, { recursive: true });
      deleted = true;
      await fsyncDirectory(this.root);
      return true;
    } catch (error) {
      if (!deleted) {
        try {
          await rm(claim, { recursive: true, force: true });
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], `run artifact removal cleanup failed: ${target}`);
        }
      }
      throw error;
    }
  }

  async write(path: string, value: string | Uint8Array, maxBytes: number): Promise<ArtifactMetadata> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid artifact byte limit");
    const target = resolve(path);
    if (!contained(this.root, target)) throw new Error("artifact path escapes its root");
    await rejectSymlinks(this.root, target);
    const parent = dirname(target);
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("artifact parent must be a real directory");
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
    if (bytes.byteLength > maxBytes) throw new Error(`artifact exceeds ${maxBytes} byte limit`);
    const temp = join(parent, `.${basename(target)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
    let reserved = false;
    try {
      const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const reservation = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await reservation.close();
      reserved = true;
      await rename(temp, target);
      await fsyncDirectory(parent);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      if (reserved) await rm(target, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`artifact already exists: ${basename(target)}`);
      throw error;
    }
    return { path: target, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  async read(path: string, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid artifact byte limit");
    const target = resolve(path);
    if (!contained(this.root, target)) throw new Error("artifact path escapes its root");
    await rejectSymlinks(this.root, target);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("artifact must be a regular file");
    if (stat.size > maxBytes) throw new Error(`artifact exceeds ${maxBytes} byte limit`);
    const data = await readFile(target);
    if (data.byteLength > maxBytes) throw new Error(`artifact exceeds ${maxBytes} byte limit`);
    return data;
  }
}

export async function artifactExists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}
