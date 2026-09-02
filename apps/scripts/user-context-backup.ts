import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  type BigIntStats,
  type Dirent,
  type Stats,
} from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { resolveLaunchConfiguration } from "./launch-config.ts";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MANIFEST_VERSION = 1;
const MANIFEST_BYTE_LIMIT = 4 * 1024 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 1_024;
const MAX_PATH_DEPTH = 64;
const RETAINED_SNAPSHOT_COUNT = 30;
const OPERATION_LOCK_NAME = ".operation.lock";
const LEGACY_ROOT_DOSSIER_PATH = "jobhunter-resume-info.md";
const USER_INFO_PATH = "apps/user-info";
const SNAPSHOT_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type UserContextMode = "dev" | "start";
export type UserContextSnapshotReason = "manual" | "pre-restore" | "stable-start";

export interface UserContextSnapshotFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface UserContextSnapshotScope {
  readonly mode: UserContextMode;
  readonly branch: string;
  readonly checkoutRoot: string;
  readonly checkoutDevice: number;
  readonly checkoutInode: number;
  readonly storageRoot: string;
}

export interface UserContextSnapshotManifest {
  readonly version: 1;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly reason: UserContextSnapshotReason;
  readonly scope: UserContextSnapshotScope;
  readonly files: readonly UserContextSnapshotFile[];
}

export interface UserContextSnapshotResult {
  readonly snapshotId: string;
  readonly snapshotPath: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface UserContextRestoreResult {
  readonly restoredSnapshotId: string;
  readonly preRestoreSnapshotId: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface UserContextBackupLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxEntries: number;
}

interface SnapshotCreationControls {
  readonly now?: Date;
  readonly nonce?: string;
  readonly limits?: UserContextBackupLimits;
}

export interface CreateUserContextSnapshotOptions extends SnapshotCreationControls {
  readonly mode: UserContextMode;
  readonly appsRoot: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly reason?: UserContextSnapshotReason;
}

export interface RestoreUserContextSnapshotOptions extends SnapshotCreationControls {
  readonly mode: UserContextMode;
  readonly appsRoot: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly snapshotId: string;
}

interface ResolvedBackupContext {
  readonly checkoutRoot: string;
  readonly scope: UserContextSnapshotScope;
  readonly storageRoot: string;
  readonly backupRoot: string;
  readonly snapshotsRoot: string;
}

interface SourceFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly observed: BigIntStats;
}

interface CollectionResult {
  readonly files: readonly SourceFile[];
  readonly totalBytes: number;
}

interface StagedRestore {
  readonly stageRoot: string;
  readonly manifest: UserContextSnapshotManifest;
}

interface PendingReplacement {
  readonly file: UserContextSnapshotFile;
  readonly targetPath: string;
  readonly temporaryPath: string;
}
interface PublishedReplacement {
  readonly replacement: PendingReplacement;
  readonly previous?: UserContextSnapshotFile;
}


const DEFAULT_LIMITS: UserContextBackupLimits = Object.freeze({
  maxFileBytes: 512 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxEntries: 10_000,
});

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === ""
    || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} does not match the strict schema`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function validateLimits(limits: UserContextBackupLimits | undefined): UserContextBackupLimits {
  const resolved = limits ?? DEFAULT_LIMITS;
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Backup ${name} must be a positive safe integer`);
    }
  }
  if (resolved.maxFileBytes > resolved.maxTotalBytes) {
    throw new Error("Backup maxFileBytes must not exceed maxTotalBytes");
  }
  return resolved;
}

function validateSnapshotPath(path: string): void {
  if (
    path.length === 0
    || path.startsWith("/")
    || path.includes("\\")
    || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES
  ) {
    throw new Error("Snapshot manifest contains an invalid path");
  }
  const components = path.split("/");
  if (
    components.length > MAX_PATH_DEPTH
    || components.some((component) => component.length === 0 || component === "." || component === "..")
  ) {
    throw new Error("Snapshot manifest contains an unsafe path");
  }
  if (path !== LEGACY_ROOT_DOSSIER_PATH && !path.startsWith(`${USER_INFO_PATH}/`)) {
    throw new Error("Snapshot manifest path is outside private user context");
  }
}

function formatSnapshotId(createdAt: Date, nonce: string): string {
  if (Number.isNaN(createdAt.getTime())) throw new Error("Snapshot time must be valid");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce)) {
    throw new Error("Snapshot nonce must be a lowercase version-4 UUID");
  }
  return `${createdAt.toISOString().replace(/[:.]/g, "-")}-${nonce}`;
}

function branchFromConfiguration(
  mode: UserContextMode,
  storageRoot: string,
): string {
  if (mode === "start") return "main";
  const encoded = basename(storageRoot);
  let branch: string;
  try {
    branch = decodeURIComponent(encoded);
  } catch (error) {
    throw new Error("Development storage namespace has an invalid branch encoding", { cause: error });
  }
  if (encodeURIComponent(branch) !== encoded) {
    throw new Error("Development storage namespace has a non-canonical branch encoding");
  }
  return branch;
}

async function resolveBackupContext(
  mode: UserContextMode,
  appsRoot: string,
  environment: Readonly<Record<string, string | undefined>> | undefined,
): Promise<ResolvedBackupContext> {
  const resolvedAppsRoot = resolve(appsRoot);
  await requireRealDirectory(resolvedAppsRoot, "Apps root");
  const configuration = resolveLaunchConfiguration(mode, resolvedAppsRoot, environment);
  const storageRoot = dirname(configuration.pipelineDatabase);
  const managedPaths = [
    configuration.contextDatabase,
    configuration.authDatabase,
    configuration.artifactRoot,
  ];
  if (managedPaths.some((path) => dirname(path) !== storageRoot && path !== join(storageRoot, "runs"))) {
    throw new Error("Launch configuration uses inconsistent storage namespaces");
  }
  const checkoutRoot = await realpath(resolve(resolvedAppsRoot, ".."));
  const checkoutStatus = await lstat(checkoutRoot, { bigint: true });
  if (!checkoutStatus.isDirectory()) throw new Error("Checkout root must be a real directory");
  if (
    configuration.productionCheckout !== undefined
    && configuration.productionCheckout.checkoutRoot !== checkoutRoot
  ) {
    throw new Error("Launch configuration checkout identity is inconsistent");
  }
  const checkoutDevice = Number(checkoutStatus.dev);
  const checkoutInode = Number(checkoutStatus.ino);
  if (!Number.isSafeInteger(checkoutDevice) || !Number.isSafeInteger(checkoutInode)) {
    throw new Error("Checkout identity exceeds the safe integer range");
  }
  const scope: UserContextSnapshotScope = {
    mode,
    branch: branchFromConfiguration(mode, storageRoot),
    checkoutRoot,
    checkoutDevice,
    checkoutInode,
    storageRoot,
  };
  return {
    checkoutRoot,
    scope,
    storageRoot,
    backupRoot: join(storageRoot, "user-context-backups"),
    snapshotsRoot: join(storageRoot, "user-context-backups", "snapshots"),
  };
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function requireRealDirectory(path: string, label: string, privateMode = false): Promise<void> {
  const status = await lstat(path);
  if (status.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!status.isDirectory()) throw new Error(`${label} must be a real directory`);
  if (await realpath(path) !== resolve(path)) {
    throw new Error(`${label} must not traverse a symbolic link`);
  }
  if (privateMode && (status.mode & 0o777) !== DIRECTORY_MODE) {
    throw new Error(`${label} must use mode 0700`);
  }
}

async function ensurePrivateDirectoryTree(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    const existing = await lstatIfPresent(current);
    if (existing === undefined) {
      try {
        await mkdir(current, { mode: DIRECTORY_MODE });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    const status = await lstat(current);
    if (status.isSymbolicLink()) throw new Error(`Private directory must not be a symbolic link: ${current}`);
    if (!status.isDirectory()) throw new Error(`Private path must be a directory: ${current}`);
  }
  await chmod(absolute, DIRECTORY_MODE);
  if (await realpath(absolute) !== absolute) {
    throw new Error(`Private directory must not traverse a symbolic link: ${absolute}`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function withOperationLock<T>(
  context: ResolvedBackupContext,
  operation: () => Promise<T>,
): Promise<T> {
  await ensurePrivateDirectoryTree(context.storageRoot);
  await ensurePrivateDirectoryTree(context.backupRoot);
  await syncDirectory(context.storageRoot);
  await syncDirectory(context.backupRoot);
  const lockPath = join(context.backupRoot, OPERATION_LOCK_NAME);
  const existing = await lstatIfPresent(lockPath);
  if (existing === undefined) {
    try {
      await writePrivateFile(lockPath, "");
      await syncDirectory(context.backupRoot);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  const lockStatus = await lstat(lockPath);
  if (
    lockStatus.isSymbolicLink()
    || !lockStatus.isFile()
    || (lockStatus.mode & 0o777) !== FILE_MODE
    || lockStatus.size !== 0
    || await realpath(lockPath) !== lockPath
  ) {
    throw new Error("User-context operation lock must be an empty private regular file");
  }
  const lock = new Database(lockPath, { create: true, strict: true });
  let acquired = false;
  try {
    try {
      lock.exec("BEGIN EXCLUSIVE");
      acquired = true;
    } catch (error) {
      if (errorCode(error) === "SQLITE_BUSY") {
        throw new Error("Another user-context backup or restore operation is already in progress");
      }
      throw error;
    }
    return await operation();
  } finally {
    try {
      if (acquired) lock.exec("ROLLBACK");
    } finally {
      lock.close();
    }
  }
}


function sourcePathForManifest(checkoutRoot: string, manifestPath: string): string {
  validateSnapshotPath(manifestPath);
  const target = resolve(checkoutRoot, ...manifestPath.split("/"));
  if (!isContained(checkoutRoot, target)) {
    throw new Error("Snapshot manifest path escapes the checkout");
  }
  return target;
}

async function collectSourceFiles(
  context: ResolvedBackupContext,
  limits: UserContextBackupLimits,
  allowMissingRoots: boolean,
  includeLegacyRootDossier: boolean,
): Promise<CollectionResult> {
  const files: SourceFile[] = [];
  let totalBytes = 0;
  let entries = 0;

  const observeFile = async (absolutePath: string, relativePath: string): Promise<void> => {
    entries += 1;
    if (entries > limits.maxEntries) throw new Error("User-context backup entry limit exceeded");
    validateSnapshotPath(relativePath);
    const status = await lstat(absolutePath, { bigint: true });
    if (status.isSymbolicLink()) throw new Error(`Backup source must not be a symbolic link: ${relativePath}`);
    if (!status.isFile()) throw new Error(`Backup source must be a regular file: ${relativePath}`);
    if (status.size > BigInt(limits.maxFileBytes)) {
      throw new Error(`User-context backup file byte limit exceeded: ${relativePath}`);
    }
    totalBytes += Number(status.size);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
      throw new Error("User-context backup total byte limit exceeded");
    }
    files.push({ absolutePath, relativePath, observed: status });
  };

  const walkDirectory = async (
    absoluteDirectory: string,
    relativeDirectory: string,
    depth: number,
  ): Promise<void> => {
    if (depth > MAX_PATH_DEPTH) throw new Error("User-context backup directory depth limit exceeded");
    const before = await lstat(absoluteDirectory, { bigint: true });
    if (before.isSymbolicLink()) {
      throw new Error(`Backup source must not be a symbolic link: ${relativeDirectory}`);
    }
    if (!before.isDirectory()) {
      throw new Error(`Backup source must be a real directory: ${relativeDirectory}`);
    }
    if (await realpath(absoluteDirectory) !== resolve(absoluteDirectory)) {
      throw new Error(`Backup source must not traverse a symbolic link: ${relativeDirectory}`);
    }
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left: Dirent, right: Dirent) => compareText(left.name, right.name));
    for (const child of children) {
      entries += 1;
      if (entries > limits.maxEntries) throw new Error("User-context backup entry limit exceeded");
      const absoluteChild = join(absoluteDirectory, child.name);
      const relativeChild = `${relativeDirectory}/${child.name}`;
      if (Buffer.byteLength(relativeChild, "utf8") > MAX_PATH_BYTES) {
        throw new Error(`User-context backup path byte limit exceeded: ${relativeChild}`);
      }
      const status = await lstat(absoluteChild, { bigint: true });
      if (status.isSymbolicLink()) {
        throw new Error(`Backup source must not be a symbolic link: ${relativeChild}`);
      }
      if (status.isDirectory()) {
        await walkDirectory(absoluteChild, relativeChild, depth + 1);
      } else if (status.isFile()) {
        entries -= 1;
        await observeFile(absoluteChild, relativeChild);
      } else {
        throw new Error(`Backup source must be a regular file or directory: ${relativeChild}`);
      }
    }
    const after = await lstat(absoluteDirectory, { bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error(`Backup source directory changed while scanning: ${relativeDirectory}`);
    }
  };

  const userInfoRoot = join(context.checkoutRoot, ...USER_INFO_PATH.split("/"));
  const userInfoStatus = await lstatIfPresent(userInfoRoot);
  if (userInfoStatus === undefined) {
    if (!allowMissingRoots) throw new Error(`Required backup source is unavailable: ${USER_INFO_PATH}`);
  } else {
    await walkDirectory(userInfoRoot, USER_INFO_PATH, 1);
  }

  if (includeLegacyRootDossier) {
    const legacyDossier = join(context.checkoutRoot, LEGACY_ROOT_DOSSIER_PATH);
    if (await lstatIfPresent(legacyDossier) !== undefined) {
      await observeFile(legacyDossier, LEGACY_ROOT_DOSSIER_PATH);
    }
  }

  files.sort((left, right) => compareText(left.relativePath, right.relativePath));
  return { files, totalBytes };
}

async function ensurePrivateParentDirectories(root: string, filePath: string): Promise<readonly string[]> {
  const parent = dirname(filePath);
  if (!isContained(root, parent)) throw new Error("Private file path escapes its managed root");
  const createdOrUsed: string[] = [];
  const relation = relative(root, parent);
  let current = root;
  if (relation !== "") {
    for (const component of relation.split(sep)) {
      current = join(current, component);
      await ensurePrivateDirectoryTree(current);
      createdOrUsed.push(current);
    }
  }
  return createdOrUsed;
}

async function copyRegularFile(
  sourcePath: string,
  destinationPath: string,
  limits: UserContextBackupLimits,
  expected?: Readonly<{ size: number; sha256: string }>,
  observed?: BigIntStats,
): Promise<UserContextSnapshotFile> {
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destination: FileHandle | undefined;
  try {
    const initial = await source.stat({ bigint: true });
    if (!initial.isFile()) throw new Error(`Backup source must be a regular file: ${sourcePath}`);
    if (
      observed !== undefined
      && (
        initial.dev !== observed.dev
        || initial.ino !== observed.ino
        || initial.size !== observed.size
        || initial.mtimeNs !== observed.mtimeNs
        || initial.ctimeNs !== observed.ctimeNs
      )
    ) {
      throw new Error(`Backup source changed before copying: ${sourcePath}`);
    }
    if (initial.size > BigInt(limits.maxFileBytes)) {
      throw new Error(`User-context backup file byte limit exceeded: ${sourcePath}`);
    }
    destination = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      FILE_MODE,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let total = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limits.maxFileBytes) {
        throw new Error(`User-context backup file byte limit exceeded: ${sourcePath}`);
      }
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(bytes, written, bytesRead - written, null);
        if (result.bytesWritten === 0) throw new Error("Backup destination stopped accepting bytes");
        written += result.bytesWritten;
      }
    }
    const final = await source.stat({ bigint: true });
    if (
      initial.dev !== final.dev
      || initial.ino !== final.ino
      || initial.size !== final.size
      || initial.mtimeNs !== final.mtimeNs
      || initial.ctimeNs !== final.ctimeNs
      || BigInt(total) !== final.size
    ) {
      throw new Error(`Backup source changed while copying: ${sourcePath}`);
    }
    const sha256 = hash.digest("hex");
    if (expected !== undefined && (total !== expected.size || sha256 !== expected.sha256)) {
      throw new Error(`Snapshot SHA-256 checksum or size mismatch: ${sourcePath}`);
    }
    await destination.chmod(FILE_MODE);
    await destination.sync();
    await destination.close();
    destination = undefined;
    return { path: "", size: total, sha256 };
  } catch (error) {
    if (destination !== undefined) await destination.close().catch(() => undefined);
    await unlink(destinationPath).catch(() => undefined);
    throw error;
  } finally {
    await source.close();
  }
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  const bytes = Buffer.from(contents, "utf8");
  if (bytes.byteLength > MANIFEST_BYTE_LIMIT) throw new Error("Snapshot manifest exceeds its byte limit");
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    FILE_MODE,
  );
  try {
    let written = 0;
    while (written < bytes.byteLength) {
      const result = await handle.write(bytes, written, bytes.byteLength - written, null);
      if (result.bytesWritten === 0) throw new Error("Manifest destination stopped accepting bytes");
      written += result.bytesWritten;
    }
    await handle.chmod(FILE_MODE);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readStrictManifest(snapshotPath: string): Promise<UserContextSnapshotManifest> {
  await requireRealDirectory(snapshotPath, "Snapshot directory", true);
  const manifestPath = join(snapshotPath, "manifest.json");
  const status = await lstat(manifestPath);
  if (status.isSymbolicLink()) throw new Error("Snapshot manifest must not be a symbolic link");
  if (!status.isFile()) throw new Error("Snapshot manifest must be a regular file");
  if ((status.mode & 0o777) !== FILE_MODE) throw new Error("Snapshot manifest must use mode 0600");
  if (status.size > MANIFEST_BYTE_LIMIT) throw new Error("Snapshot manifest exceeds its byte limit");
  const handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, Math.max(status.size, 1)));
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MANIFEST_BYTE_LIMIT) throw new Error("Snapshot manifest exceeds its byte limit");
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    bytes = Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("Snapshot manifest must be valid UTF-8 JSON", { cause: error });
  }
  const root = requireRecord(parsed, "Snapshot manifest");
  exactKeys(root, ["version", "snapshotId", "createdAt", "reason", "scope", "files"], "Snapshot manifest");
  if (root.version !== MANIFEST_VERSION) throw new Error("Snapshot manifest version is unsupported");
  const snapshotId = requireString(root.snapshotId, "Snapshot ID");
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId) || snapshotId !== basename(snapshotPath)) {
    throw new Error("Snapshot manifest ID is invalid or does not match its directory");
  }
  const createdAt = requireString(root.createdAt, "Snapshot creation time");
  const createdDate = new Date(createdAt);
  if (Number.isNaN(createdDate.getTime()) || createdDate.toISOString() !== createdAt) {
    throw new Error("Snapshot creation time must be canonical RFC 3339 UTC");
  }
  if (!snapshotId.startsWith(`${createdAt.replace(/[:.]/g, "-")}-`)) {
    throw new Error("Snapshot ID does not match its creation time");
  }
  const reason = requireString(root.reason, "Snapshot reason");
  if (reason !== "manual" && reason !== "pre-restore" && reason !== "stable-start") {
    throw new Error("Snapshot manifest reason is invalid");
  }
  const scopeValue = requireRecord(root.scope, "Snapshot scope");
  exactKeys(
    scopeValue,
    ["mode", "branch", "checkoutRoot", "checkoutDevice", "checkoutInode", "storageRoot"],
    "Snapshot scope",
  );
  const mode = requireString(scopeValue.mode, "Snapshot mode");
  if (mode !== "dev" && mode !== "start") throw new Error("Snapshot mode is invalid");
  const branch = requireString(scopeValue.branch, "Snapshot branch");
  const checkoutRoot = requireString(scopeValue.checkoutRoot, "Snapshot checkout root");
  const storageRoot = requireString(scopeValue.storageRoot, "Snapshot storage root");
  if (!isAbsolute(checkoutRoot) || resolve(checkoutRoot) !== checkoutRoot) {
    throw new Error("Snapshot checkout root must be an absolute normalized path");
  }
  if (!isAbsolute(storageRoot) || resolve(storageRoot) !== storageRoot) {
    throw new Error("Snapshot storage root must be an absolute normalized path");
  }
  const filesValue = root.files;
  if (!Array.isArray(filesValue)) throw new Error("Snapshot manifest files must be an array");
  if (filesValue.length > DEFAULT_LIMITS.maxEntries) {
    throw new Error("Snapshot manifest entry limit exceeded");
  }
  const files: UserContextSnapshotFile[] = [];
  let previousPath: string | undefined;
  let totalBytes = 0;
  for (const [index, value] of filesValue.entries()) {
    const file = requireRecord(value, `Snapshot file ${index}`);
    exactKeys(file, ["path", "size", "sha256"], `Snapshot file ${index}`);
    const path = requireString(file.path, `Snapshot file ${index} path`);
    validateSnapshotPath(path);
    if (previousPath !== undefined && compareText(previousPath, path) >= 0) {
      throw new Error("Snapshot manifest file paths must be unique and sorted");
    }
    previousPath = path;
    const size = requireSafeInteger(file.size, `Snapshot file ${index} size`);
    if (size > DEFAULT_LIMITS.maxFileBytes) throw new Error("Snapshot file exceeds its byte limit");
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > DEFAULT_LIMITS.maxTotalBytes) {
      throw new Error("Snapshot manifest total byte limit exceeded");
    }
    const sha256 = requireString(file.sha256, `Snapshot file ${index} SHA-256`);
    if (!SHA256_PATTERN.test(sha256)) throw new Error("Snapshot file SHA-256 is invalid");
    files.push({ path, size, sha256 });
  }
  return {
    version: 1,
    snapshotId,
    createdAt,
    reason,
    scope: {
      mode,
      branch,
      checkoutRoot,
      checkoutDevice: requireSafeInteger(scopeValue.checkoutDevice, "Snapshot checkout device"),
      checkoutInode: requireSafeInteger(scopeValue.checkoutInode, "Snapshot checkout inode"),
      storageRoot,
    },
    files,
  };
}

function assertScopeMatches(
  actual: UserContextSnapshotScope,
  expected: UserContextSnapshotScope,
): void {
  if (actual.mode !== expected.mode) throw new Error("Snapshot mode scope does not match this command");
  if (actual.branch !== expected.branch) throw new Error("Snapshot branch scope does not match this command");
  if (
    actual.checkoutRoot !== expected.checkoutRoot
    || actual.checkoutDevice !== expected.checkoutDevice
    || actual.checkoutInode !== expected.checkoutInode
  ) {
    throw new Error("Snapshot checkout scope does not match this checkout");
  }
  if (actual.storageRoot !== expected.storageRoot) {
    throw new Error("Snapshot storage scope does not match this launch namespace");
  }
}

async function snapshotIsComplete(
  path: string,
  manifest: UserContextSnapshotManifest,
): Promise<boolean> {
  try {
    const filesRoot = join(path, "files");
    await requireRealDirectory(filesRoot, "Snapshot files directory", true);
    for (const file of manifest.files) {
      const source = sourcePathForManifest(filesRoot, file.path);
      const relation = relative(filesRoot, dirname(source));
      let current = filesRoot;
      if (relation !== "") {
        for (const component of relation.split(sep)) {
          current = join(current, component);
          await requireRealDirectory(current, "Snapshot content directory", true);
        }
      }
      const status = await lstat(source);
      if (
        status.isSymbolicLink()
        || !status.isFile()
        || (status.mode & 0o777) !== FILE_MODE
        || status.size !== file.size
        || await realpath(source) !== source
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function retainNewestSnapshots(context: ResolvedBackupContext): Promise<void> {
  const candidates: Array<Readonly<{ path: string; manifest: UserContextSnapshotManifest }>> = [];
  for (const entry of await readdir(context.snapshotsRoot, { withFileTypes: true })) {
    if (!SNAPSHOT_ID_PATTERN.test(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const path = join(context.snapshotsRoot, entry.name);
    try {
      const manifest = await readStrictManifest(path);
      assertScopeMatches(manifest.scope, context.scope);
      if (await snapshotIsComplete(path, manifest)) candidates.push({ path, manifest });
    } catch {
      // An invalid or interrupted directory is not a complete snapshot and is never selected for deletion.
    }
  }
  candidates.sort((left, right) => {
    const byTime = compareText(left.manifest.createdAt, right.manifest.createdAt);
    return byTime === 0
      ? compareText(left.manifest.snapshotId, right.manifest.snapshotId)
      : byTime;
  });
  const removeCount = Math.max(0, candidates.length - RETAINED_SNAPSHOT_COUNT);
  for (const candidate of candidates.slice(0, removeCount)) {
    if (!isContained(context.snapshotsRoot, candidate.path)) {
      throw new Error("Snapshot retention candidate escapes its managed root");
    }
    const status = await lstat(candidate.path);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error("Snapshot retention candidate changed before deletion");
    }
    await rm(candidate.path, { recursive: true });
  }
  if (removeCount > 0) await syncDirectory(context.snapshotsRoot);
}

async function createSnapshot(
  context: ResolvedBackupContext,
  options: Readonly<{
    reason: UserContextSnapshotReason;
    now?: Date;
    nonce?: string;
    limits?: UserContextBackupLimits;
    allowMissingRoots?: boolean;
    includeLegacyRootDossier?: boolean;
    retain?: boolean;
  }>,
): Promise<UserContextSnapshotResult> {
  const limits = validateLimits(options.limits);
  const createdAt = options.now ?? new Date();
  const nonce = options.nonce ?? randomUUID();
  const snapshotId = formatSnapshotId(createdAt, nonce);
  const finalPath = join(context.snapshotsRoot, snapshotId);
  const stagingPath = join(context.snapshotsRoot, `.staging-${snapshotId}`);
  if (!isContained(context.snapshotsRoot, finalPath) || !isContained(context.snapshotsRoot, stagingPath)) {
    throw new Error("Snapshot path escapes its managed root");
  }
  const collected = await collectSourceFiles(
    context,
    limits,
    options.allowMissingRoots ?? false,
    options.includeLegacyRootDossier ?? false,
  );
  await ensurePrivateDirectoryTree(context.storageRoot);
  await ensurePrivateDirectoryTree(context.backupRoot);
  await ensurePrivateDirectoryTree(context.snapshotsRoot);
  await syncDirectory(context.storageRoot);
  await syncDirectory(context.backupRoot);
  await syncDirectory(context.snapshotsRoot);
  if (await lstatIfPresent(finalPath) !== undefined) {
    throw new Error(`Snapshot already exists: ${snapshotId}`);
  }
  if (await lstatIfPresent(stagingPath) !== undefined) {
    throw new Error(`Snapshot staging path already exists: ${snapshotId}`);
  }
  await mkdir(stagingPath, { mode: DIRECTORY_MODE });
  await chmod(stagingPath, DIRECTORY_MODE);
  const filesRoot = join(stagingPath, "files");
  await mkdir(filesRoot, { mode: DIRECTORY_MODE });
  await chmod(filesRoot, DIRECTORY_MODE);
  const directories = new Set<string>([stagingPath, filesRoot]);
  try {
    const manifestFiles: UserContextSnapshotFile[] = [];
    let copiedTotal = 0;
    for (const source of collected.files) {
      const destination = sourcePathForManifest(filesRoot, source.relativePath);
      for (const directory of await ensurePrivateParentDirectories(filesRoot, destination)) {
        directories.add(directory);
      }
      const copied = await copyRegularFile(
        source.absolutePath,
        destination,
        limits,
        undefined,
        source.observed,
      );
      copiedTotal += copied.size;
      if (copiedTotal > limits.maxTotalBytes) {
        throw new Error("User-context backup total byte limit exceeded while copying");
      }
      manifestFiles.push({
        path: source.relativePath,
        size: copied.size,
        sha256: copied.sha256,
      });
      directories.add(dirname(destination));
    }
    if (copiedTotal !== collected.totalBytes) {
      throw new Error("User-context sources changed after collection");
    }
    const manifest: UserContextSnapshotManifest = {
      version: 1,
      snapshotId,
      createdAt: createdAt.toISOString(),
      reason: options.reason,
      scope: context.scope,
      files: manifestFiles,
    };
    await writePrivateFile(join(stagingPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      await syncDirectory(directory);
    }
    if (await lstatIfPresent(finalPath) !== undefined) {
      throw new Error(`Snapshot already exists: ${snapshotId}`);
    }
    await rename(stagingPath, finalPath);
    await syncDirectory(context.snapshotsRoot);
    if (options.retain !== false) await retainNewestSnapshots(context);
    return {
      snapshotId,
      snapshotPath: finalPath,
      fileCount: manifestFiles.length,
      totalBytes: copiedTotal,
    };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createUserContextSnapshot(
  options: CreateUserContextSnapshotOptions,
): Promise<UserContextSnapshotResult> {
  const context = await resolveBackupContext(options.mode, options.appsRoot, options.environment);
  return withOperationLock(context, () => createSnapshot(context, {
    reason: options.reason ?? "manual",
    now: options.now,
    nonce: options.nonce,
    limits: options.limits,
  }));
}

export async function backupUserContextForLaunch(
  mode: UserContextMode,
  appsRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  controls: SnapshotCreationControls = {},
): Promise<UserContextSnapshotResult | undefined> {
  if (mode === "dev") return undefined;
  return createUserContextSnapshot({
    mode,
    appsRoot,
    environment,
    reason: "stable-start",
    ...controls,
  });
}

function validateSnapshotId(snapshotId: string): void {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new Error("Restore snapshot ID is invalid");
  }
}

async function requirePrivateSnapshotFile(
  filesRoot: string,
  file: UserContextSnapshotFile,
): Promise<string> {
  const source = sourcePathForManifest(filesRoot, file.path);
  const relation = relative(filesRoot, dirname(source));
  let current = filesRoot;
  if (relation !== "") {
    for (const component of relation.split(sep)) {
      current = join(current, component);
      await requireRealDirectory(current, "Snapshot content directory", true);
    }
  }
  const status = await lstat(source);
  if (status.isSymbolicLink()) throw new Error(`Snapshot file must not be a symbolic link: ${file.path}`);
  if (!status.isFile()) throw new Error(`Snapshot file must be regular: ${file.path}`);
  if ((status.mode & 0o777) !== FILE_MODE) {
    throw new Error(`Snapshot file must use mode 0600: ${file.path}`);
  }
  if (await realpath(source) !== source) {
    throw new Error(`Snapshot file must not traverse a symbolic link: ${file.path}`);
  }
  return source;
}

async function stageVerifiedRestore(
  context: ResolvedBackupContext,
  snapshotId: string,
  nonce: string,
): Promise<StagedRestore> {
  await requireRealDirectory(context.storageRoot, "Launch storage namespace", true);
  await requireRealDirectory(context.backupRoot, "User-context backup directory", true);
  await requireRealDirectory(context.snapshotsRoot, "User-context snapshots directory", true);
  const snapshotPath = join(context.snapshotsRoot, snapshotId);
  if (!isContained(context.snapshotsRoot, snapshotPath)) {
    throw new Error("Restore snapshot path escapes its managed root");
  }
  const manifest = await readStrictManifest(snapshotPath);
  assertScopeMatches(manifest.scope, context.scope);
  const snapshotFilesRoot = join(snapshotPath, "files");
  await requireRealDirectory(snapshotFilesRoot, "Snapshot files directory", true);
  const stageRoot = join(context.backupRoot, `.restore-${nonce}`);
  if (!isContained(context.backupRoot, stageRoot)) {
    throw new Error("Restore staging path escapes its managed root");
  }
  if (await lstatIfPresent(stageRoot) !== undefined) throw new Error("Restore staging path already exists");
  await mkdir(stageRoot, { mode: DIRECTORY_MODE });
  await chmod(stageRoot, DIRECTORY_MODE);
  const filesRoot = join(stageRoot, "files");
  await mkdir(filesRoot, { mode: DIRECTORY_MODE });
  await chmod(filesRoot, DIRECTORY_MODE);
  const directories = new Set<string>([stageRoot, filesRoot]);
  try {
    for (const file of manifest.files) {
      const source = await requirePrivateSnapshotFile(snapshotFilesRoot, file);
      const destination = sourcePathForManifest(filesRoot, file.path);
      for (const directory of await ensurePrivateParentDirectories(filesRoot, destination)) {
        directories.add(directory);
      }
      await copyRegularFile(source, destination, DEFAULT_LIMITS, file);
      directories.add(dirname(destination));
    }
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      await syncDirectory(directory);
    }
    return { stageRoot, manifest };
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function validateRestoreTarget(checkoutRoot: string, file: UserContextSnapshotFile): Promise<string> {
  const target = sourcePathForManifest(checkoutRoot, file.path);
  let current = checkoutRoot;
  const parentRelation = relative(checkoutRoot, dirname(target));
  if (parentRelation !== "") {
    for (const component of parentRelation.split(sep)) {
      current = join(current, component);
      const status = await lstatIfPresent(current);
      if (status === undefined) break;
      if (status.isSymbolicLink()) {
        throw new Error(`Restore target parent must not be a symbolic link: ${file.path}`);
      }
      if (!status.isDirectory()) {
        throw new Error(`Restore target parent must be a directory: ${file.path}`);
      }
    }
  }
  const existing = await lstatIfPresent(target);
  if (existing?.isSymbolicLink()) {
    throw new Error(`Restore target must not be a symbolic link: ${file.path}`);
  }
  if (existing !== undefined && !existing.isFile()) {
    throw new Error(`Restore target must be a regular file: ${file.path}`);
  }
  return target;
}

async function ensureRestoreTargetParent(checkoutRoot: string, target: string): Promise<void> {
  const parent = dirname(target);
  if (!isContained(checkoutRoot, parent)) throw new Error("Restore target parent escapes the checkout");
  const relation = relative(checkoutRoot, parent);
  let current = checkoutRoot;
  if (relation === "") return;
  for (const component of relation.split(sep)) {
    current = join(current, component);
    const status = await lstatIfPresent(current);
    if (status === undefined) {
      await mkdir(current, { mode: DIRECTORY_MODE });
      await chmod(current, DIRECTORY_MODE);
      await syncDirectory(dirname(current));
      continue;
    }
    if (status.isSymbolicLink()) throw new Error("Restore target parent must not be a symbolic link");
    if (!status.isDirectory()) throw new Error("Restore target parent must be a directory");
  }
}

async function stageCheckoutReplacements(
  context: ResolvedBackupContext,
  staged: StagedRestore,
  nonce: string,
): Promise<PendingReplacement[]> {
  const replacements: PendingReplacement[] = [];
  try {
    for (const [index, file] of staged.manifest.files.entries()) {
      const targetPath = await validateRestoreTarget(context.checkoutRoot, file);
      await ensureRestoreTargetParent(context.checkoutRoot, targetPath);
      const temporaryPath = join(dirname(targetPath), `.user-context-restore-${nonce}-${index}`);
      if (await lstatIfPresent(temporaryPath) !== undefined) {
        throw new Error("Restore target staging path already exists");
      }
      const stagedSource = sourcePathForManifest(join(staged.stageRoot, "files"), file.path);
      await copyRegularFile(stagedSource, temporaryPath, DEFAULT_LIMITS, file);
      replacements.push({ file, targetPath, temporaryPath });
    }
    return replacements;
  } catch (error) {
    await Promise.all(replacements.map(({ temporaryPath }) => unlink(temporaryPath).catch(() => undefined)));
    throw error;
  }
}
async function rollbackPublishedReplacements(
  context: ResolvedBackupContext,
  preRestoreSnapshotPath: string,
  published: readonly PublishedReplacement[],
  nonce: string,
): Promise<void> {
  const previousFilesRoot = join(preRestoreSnapshotPath, "files");
  let firstFailure: unknown;
  for (const [index, publication] of [...published].reverse().entries()) {
    const { replacement, previous } = publication;
    try {
      const current = await lstatIfPresent(replacement.targetPath);
      if (current?.isSymbolicLink() || (current !== undefined && !current.isFile())) {
        throw new Error(`Rollback target must be a regular file: ${replacement.file.path}`);
      }
      if (previous === undefined) {
        if (current !== undefined) await unlink(replacement.targetPath);
        await syncDirectory(dirname(replacement.targetPath));
        continue;
      }
      const previousSource = await requirePrivateSnapshotFile(previousFilesRoot, previous);
      const temporaryPath = join(
        dirname(replacement.targetPath),
        `.user-context-rollback-${nonce}-${index}`,
      );
      if (await lstatIfPresent(temporaryPath) !== undefined) {
        throw new Error("Rollback target staging path already exists");
      }
      try {
        await copyRegularFile(previousSource, temporaryPath, DEFAULT_LIMITS, previous);
        await validateRestoreTarget(context.checkoutRoot, replacement.file);
        await rename(temporaryPath, replacement.targetPath);
        await chmod(replacement.targetPath, FILE_MODE);
        await syncDirectory(dirname(replacement.targetPath));
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    } catch (error) {
      if (firstFailure === undefined) firstFailure = error;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}


export async function restoreUserContextSnapshot(
  options: RestoreUserContextSnapshotOptions,
): Promise<UserContextRestoreResult> {
  validateSnapshotId(options.snapshotId);
  const context = await resolveBackupContext(options.mode, options.appsRoot, options.environment);
  return withOperationLock(context, async () => {
    const restoreNonce = randomUUID();
    const staged = await stageVerifiedRestore(context, options.snapshotId, restoreNonce);
    const includesLegacyRootDossier = staged.manifest.files
      .some((file) => file.path === LEGACY_ROOT_DOSSIER_PATH);
    let replacements: PendingReplacement[] = [];
    try {
      for (const file of staged.manifest.files) {
        await validateRestoreTarget(context.checkoutRoot, file);
      }
      const preRestore = await createSnapshot(context, {
        reason: "pre-restore",
        now: options.now,
        nonce: options.nonce,
        limits: options.limits,
        allowMissingRoots: true,
        includeLegacyRootDossier: includesLegacyRootDossier,
        retain: false,
      });
      const preRestoreManifest = await readStrictManifest(preRestore.snapshotPath);
      assertScopeMatches(preRestoreManifest.scope, context.scope);
      const previousByPath = new Map(
        preRestoreManifest.files.map((file) => [file.path, file] as const),
      );
      replacements = await stageCheckoutReplacements(context, staged, restoreNonce);
      const published: PublishedReplacement[] = [];
      try {
        for (const replacement of replacements) {
          await validateRestoreTarget(context.checkoutRoot, replacement.file);
          await rename(replacement.temporaryPath, replacement.targetPath);
          const previous = previousByPath.get(replacement.file.path);
          published.push({
            replacement,
            ...(previous === undefined ? {} : { previous }),
          });
          await chmod(replacement.targetPath, FILE_MODE);
          await syncDirectory(dirname(replacement.targetPath));
        }
      } catch (publicationError) {
        try {
          await rollbackPublishedReplacements(
            context,
            preRestore.snapshotPath,
            published,
            restoreNonce,
          );
        } catch (rollbackError) {
          throw new Error(
            "User-context restore failed and rollback could not restore the pre-restore state",
            { cause: new AggregateError([publicationError, rollbackError]) },
          );
        }
        throw new Error(
          "User-context restore publication failed; the pre-restore state was restored",
          { cause: publicationError },
        );
      }
      await retainNewestSnapshots(context);
      const totalBytes = staged.manifest.files.reduce((total, file) => total + file.size, 0);
      return {
        restoredSnapshotId: staged.manifest.snapshotId,
        preRestoreSnapshotId: preRestore.snapshotId,
        fileCount: staged.manifest.files.length,
        totalBytes,
      };
    } finally {
      await Promise.all(replacements.map(({ temporaryPath }) => unlink(temporaryPath).catch(() => undefined)));
      await rm(staged.stageRoot, { recursive: true, force: true }).catch(() => undefined);
      await syncDirectory(context.backupRoot).catch(() => undefined);
    }
  });
}
