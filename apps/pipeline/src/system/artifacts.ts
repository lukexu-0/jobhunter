import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const ARTIFACT_LIMITS = Object.freeze({ tex: 256 * 1024, stdout: 256 * 1024, stderr: 256 * 1024, log: 1024 * 1024, pdf: 10 * 1024 * 1024, png: 25 * 1024 * 1024 });

export interface ArtifactMetadata {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ArtifactAddress {
  readonly run: string;
  readonly revision: string;
  readonly stage: string;
  readonly attempt: number;
}

export interface RunInputAddress {
  readonly run: string;
}

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function component(value: string, label: string): string {
  if (!SAFE_COMPONENT.test(value) || value === "." || value === "..") throw new Error(`invalid ${label}`);
  return value;
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

export class ArtifactStore {
  readonly root: string;

  constructor(root = resolve(import.meta.dir, "../../data/runs")) {
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

  attemptRoot(address: ArtifactAddress): string {
    const run = component(address.run, "run id");
    const revision = component(address.revision, "revision id");
    const stage = component(address.stage, "stage");
    if (!Number.isSafeInteger(address.attempt) || address.attempt < 0) throw new Error("invalid attempt number");
    const result = resolve(this.root, run, "revisions", revision, "attempts", `${stage}-${address.attempt}`);
    if (!contained(this.root, result)) throw new Error("attempt path escapes artifact root");
    return result;
  }

  inputRoot(address: RunInputAddress): string {
    const run = component(address.run, "run id");
    const result = resolve(this.root, run, "input");
    if (!contained(this.root, result)) throw new Error("input path escapes artifact root");
    return result;
  }

  async createRunInput(address: RunInputAddress): Promise<string> {
    await this.initialize();
    return await createContainedDirectory(this.root, this.inputRoot(address), "run input already exists");
  }

  async createAttempt(address: ArtifactAddress): Promise<string> {
    await this.initialize();
    return await createContainedDirectory(this.root, this.attemptRoot(address), "artifact attempt already exists");
  }

  async removeRun(runId: string): Promise<boolean> {
    await this.initialize();
    const target = resolve(this.root, component(runId, "run id"));
    if (!contained(this.root, target)) throw new Error("run path escapes artifact root");
    let stat;
    try {
      stat = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`run artifact root must be a real directory: ${target}`);
    try {
      await rm(target, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    await fsyncDirectory(this.root);
    return true;
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
