import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_ARTIFACT_ROOT, LEGACY_ARTIFACT_ROOT } from "./artifacts.ts";

const HISTORICAL_ARTIFACT_ROOT = resolve(import.meta.dir, "../../../pipeline/data/runs");
const ARTIFACT_UPDATE_TRIGGER = `
CREATE TRIGGER artifacts_no_update BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT, 'artifacts are immutable'); END;
`;
const HARD_MIGRATION_LIMITS = {
  maxDepth: 64,
  maxEntries: 100_000,
  maxBytes: 1024 * 1024 * 1024,
  maxRuns: 10_000,
  maxArtifacts: 100_000,
} as const;

interface RunRow {
  readonly id: string;
  readonly queue_sequence: number;
}

interface ArtifactRow {
  readonly id: string;
  readonly run_id: string;
  readonly path: string;
}

interface RunOutputPlan {
  readonly run: RunRow;
  readonly destination: string;
  readonly source: string | undefined;
  readonly sourceIdentity: NodeIdentity | undefined;
  readonly sourceRootIdentity: NodeIdentity | undefined;
  readonly sourceRetired: boolean;
}

interface RunOutputTraversalLimits {
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export interface RunOutputMigrationLimits extends RunOutputTraversalLimits {
  readonly maxRuns: number;
  readonly maxArtifacts: number;
}

export interface RunOutputMigrationOptions {
  readonly outputRoot?: string;
  readonly legacyRoots?: readonly string[];
  readonly priorOutputRoots?: readonly string[];
  readonly limits?: Partial<RunOutputMigrationLimits>;
}

export interface RunOutputMigrationResult {
  readonly movedRuns: number;
  readonly rewrittenArtifacts: number;
}

export interface RunOutputBackupPublicationOptions {
  readonly source: string;
  readonly outputRoot: string;
  readonly runId: string;
  readonly queueSequence: number;
  readonly relativeFiles: readonly string[];
  readonly limits?: Partial<RunOutputMigrationLimits>;
  readonly verifyTree: (candidateRunRoot: string, destinationRunRoot: string) => void;
}

export interface RunOutputBackupPublicationResult {
  readonly destination: string;
  readonly moved: boolean;
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function directChild(root: string, component: string, label: string): string {
  const candidate = resolve(root, component);
  if (relative(root, candidate) !== component || !contained(root, candidate) || candidate === root) {
    throw new Error(`${label} is not a safe output directory`);
  }
  return candidate;
}

interface NodeIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface TraversalBudget {
  readonly limits: RunOutputTraversalLimits;
  entries: number;
  bytes: number;
}

interface TreeSnapshot {
  readonly identity: NodeIdentity;
  readonly entries: number;
  readonly bytes: number;
}

function resolveMigrationLimits(overrides: Partial<RunOutputMigrationLimits> | undefined): RunOutputMigrationLimits {
  const bounded = (value: number | undefined, hardLimit: number, label: string): number => {
    const selected = value ?? hardLimit;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > hardLimit) {
      throw new Error(`${label} must be a positive safe integer no greater than ${hardLimit}`);
    }
    return selected;
  };
  return {
    maxDepth: bounded(overrides?.maxDepth, HARD_MIGRATION_LIMITS.maxDepth, "run output migration depth limit"),
    maxEntries: bounded(
      overrides?.maxEntries,
      HARD_MIGRATION_LIMITS.maxEntries,
      "run output migration entry limit",
    ),
    maxBytes: bounded(overrides?.maxBytes, HARD_MIGRATION_LIMITS.maxBytes, "run output migration byte limit"),
    maxRuns: bounded(overrides?.maxRuns, HARD_MIGRATION_LIMITS.maxRuns, "run output migration run row limit"),
    maxArtifacts: bounded(
      overrides?.maxArtifacts,
      HARD_MIGRATION_LIMITS.maxArtifacts,
      "run output migration artifact row limit",
    ),
  };
}

function consumeTreeSnapshot(
  budget: TraversalBudget,
  snapshot: TreeSnapshot,
  label: string,
): void {
  if (snapshot.entries > budget.limits.maxEntries - budget.entries) {
    throw new Error(`${label} exceeds the run output migration entry limit of ${budget.limits.maxEntries}`);
  }
  if (snapshot.bytes > budget.limits.maxBytes - budget.bytes) {
    throw new Error(`${label} exceeds the run output migration byte limit of ${budget.limits.maxBytes}`);
  }
  budget.entries += snapshot.entries;
  budget.bytes += snapshot.bytes;
}

function newBudget(limits: RunOutputTraversalLimits): TraversalBudget {
  return { limits, entries: 0, bytes: 0 };
}

function identityOf(stat: Stats): NodeIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: NodeIdentity, right: NodeIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireDistinctIdentity(
  left: NodeIdentity,
  right: NodeIdentity,
  leftLabel: string,
  rightLabel: string,
): void {
  if (sameIdentity(left, right)) {
    throw new Error(`${leftLabel} and ${rightLabel} refer to the same filesystem object`);
  }
}

function requireDistinctCanonicalPaths(
  left: string,
  right: string,
  leftLabel: string,
  rightLabel: string,
): void {
  const leftCanonical = realpathSync(left);
  const rightCanonical = realpathSync(right);
  if (leftCanonical !== left) {
    throw new Error(`${leftLabel} canonical path differs from its absolute path: ${left} -> ${leftCanonical}`);
  }
  if (rightCanonical !== right) {
    throw new Error(`${rightLabel} canonical path differs from its absolute path: ${right} -> ${rightCanonical}`);
  }
  if (leftCanonical === rightCanonical) {
    throw new Error(`${leftLabel} and ${rightLabel} resolve to the same canonical path`);
  }
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function requireDirectory(path: string, label: string): Stats {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must be a real directory, not a symbolic link: ${path}`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`);
  return stat;
}

function requireOwnedDirectory(path: string, label: string): Stats {
  const stat = requireDirectory(path, label);
  if (typeof process.geteuid !== "function") {
    throw new Error(`${label} ownership cannot be verified on this platform: ${path}`);
  }
  if (stat.uid !== process.geteuid()) {
    throw new Error(`${label} must be owned by the current effective user: ${path}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group or world writable: ${path}`);
  }
  return stat;
}

function requireCanonicalDirectory(path: string, label: string, ownerControlled: boolean): Stats {
  const stat = ownerControlled ? requireOwnedDirectory(path, label) : requireDirectory(path, label);
  const canonical = realpathSync(path);
  if (canonical !== path) {
    throw new Error(`${label} canonical path differs from its absolute path: ${path} -> ${canonical}`);
  }
  return stat;
}

function assertDirectoryIdentity(
  path: string,
  expected: NodeIdentity,
  label: string,
  ownerControlled: boolean,
): Stats {
  const stat = ownerControlled ? requireOwnedDirectory(path, label) : requireDirectory(path, label);
  if (!sameIdentity(identityOf(stat), expected)) {
    throw new Error(`${label} identity changed during run output migration: ${path}`);
  }
  return stat;
}

function requireRegularFile(path: string, label: string): Stats {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
  return stat;
}

function fsyncDirectory(path: string, expected?: NodeIdentity): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isDirectory()) throw new Error(`directory changed before synchronization: ${path}`);
    if (expected !== undefined && !sameIdentity(identityOf(stat), expected)) {
      throw new Error(`directory identity changed before synchronization: ${path}`);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function countEntry(budget: TraversalBudget, label: string): void {
  if (budget.entries >= budget.limits.maxEntries) {
    throw new Error(`${label} exceeds the run output migration entry limit of ${budget.limits.maxEntries}`);
  }
  budget.entries++;
}

function countBytes(budget: TraversalBudget, bytes: number, label: string): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`${label} has an invalid file size`);
  }
  if (bytes > budget.limits.maxBytes - budget.bytes) {
    throw new Error(`${label} exceeds the run output migration byte limit of ${budget.limits.maxBytes}`);
  }
  budget.bytes += bytes;
}

function boundedEntryNames(
  path: string,
  label: string,
  depth: number,
  budget: TraversalBudget,
  expected: NodeIdentity,
  ownerControlled: boolean,
): string[] {
  if (depth > budget.limits.maxDepth) {
    throw new Error(`${label} exceeds the run output migration depth limit of ${budget.limits.maxDepth}`);
  }
  assertDirectoryIdentity(path, expected, label, ownerControlled);
  const directory = opendirSync(path);
  const names: string[] = [];
  try {
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      countEntry(budget, label);
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  assertDirectoryIdentity(path, expected, label, ownerControlled);
  names.sort((left, right) => left.localeCompare(right));
  return names;
}

function validateTreeDirectory(
  path: string,
  label: string,
  depth: number,
  budget: TraversalBudget,
  expected: NodeIdentity,
  ownerControlled: boolean,
): void {
  const names = boundedEntryNames(path, label, depth, budget, expected, ownerControlled);
  for (const name of names) {
    const child = join(path, name);
    const stat = lstatSync(child);
    if (stat.dev !== expected.dev) {
      throw new Error(`${label} crosses a filesystem boundary: ${child}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link: ${child}`);
    if (stat.isDirectory()) {
      if (ownerControlled) requireOwnedDirectory(child, label);
      validateTreeDirectory(child, label, depth + 1, budget, identityOf(stat), ownerControlled);
    } else if (stat.isFile()) {
      countBytes(budget, stat.size, label);
    } else {
      throw new Error(`${label} contains a non-regular file: ${child}`);
    }
  }
  assertDirectoryIdentity(path, expected, label, ownerControlled);
}

function validateTree(
  path: string,
  label: string,
  limits: RunOutputMigrationLimits,
  expected?: NodeIdentity,
  ownerControlled = true,
): TreeSnapshot {
  const stat = ownerControlled ? requireOwnedDirectory(path, label) : requireDirectory(path, label);
  const identity = identityOf(stat);
  if (expected !== undefined && !sameIdentity(identity, expected)) {
    throw new Error(`${label} identity changed during run output migration: ${path}`);
  }
  const budget = newBudget(limits);
  validateTreeDirectory(path, label, 0, budget, identity, ownerControlled);
  return { identity, entries: budget.entries, bytes: budget.bytes };
}

function sameFileVersion(left: Stats, right: Stats): boolean {
  return sameIdentity(identityOf(left), identityOf(right))
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function copyRegularFile(
  source: string,
  destination: string,
  expected: Stats,
  buffer: Buffer,
  budget: TraversalBudget,
): void {
  const sourceDescriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationDescriptor: number | undefined;
  try {
    const opened = fstatSync(sourceDescriptor);
    if (!opened.isFile()) throw new Error(`run output source must be a regular file: ${source}`);
    if (!sameFileVersion(opened, expected)) {
      throw new Error(`run output source file identity changed during migration: ${source}`);
    }
    destinationDescriptor = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let fileBytes = 0;
    while (true) {
      const bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      if (bytesRead > expected.size - fileBytes) {
        throw new Error(`run output source file grew during migration: ${source}`);
      }
      countBytes(budget, bytesRead, "run output source");
      fileBytes += bytesRead;
      let written = 0;
      while (written < bytesRead) {
        const bytesWritten = writeSync(destinationDescriptor, buffer, written, bytesRead - written, null);
        if (bytesWritten === 0) throw new Error(`failed to copy run output file: ${source}`);
        written += bytesWritten;
      }
    }
    const completed = fstatSync(sourceDescriptor);
    if (fileBytes !== expected.size || !sameFileVersion(completed, opened)) {
      throw new Error(`run output source file changed during migration: ${source}`);
    }
    fsyncSync(destinationDescriptor);
    chmodSync(destination, 0o600);
  } finally {
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    closeSync(sourceDescriptor);
  }
}

function copyTreeDirectory(
  source: string,
  destination: string,
  depth: number,
  budget: TraversalBudget,
  expectedSource: NodeIdentity,
  expectedDestination: NodeIdentity,
  buffer: Buffer,
): void {
  const names = boundedEntryNames(
    source,
    "run output source",
    depth,
    budget,
    expectedSource,
    true,
  );
  for (const name of names) {
    const sourceChild = join(source, name);
    const destinationChild = join(destination, name);
    const stat = lstatSync(sourceChild);
    if (stat.isSymbolicLink()) throw new Error(`run output source contains a symbolic link: ${sourceChild}`);
    if (stat.isDirectory()) {
      requireOwnedDirectory(sourceChild, "run output source");
      mkdirSync(destinationChild, { mode: 0o700 });
      const destinationStat = requireOwnedDirectory(destinationChild, "run output staging directory");
      copyTreeDirectory(
        sourceChild,
        destinationChild,
        depth + 1,
        budget,
        identityOf(stat),
        identityOf(destinationStat),
        buffer,
      );
    } else if (stat.isFile()) {
      copyRegularFile(sourceChild, destinationChild, stat, buffer, budget);
    } else {
      throw new Error(`run output source contains a non-regular file: ${sourceChild}`);
    }
  }
  assertDirectoryIdentity(source, expectedSource, "run output source", true);
  assertDirectoryIdentity(destination, expectedDestination, "run output staging directory", true);
  chmodSync(destination, 0o700);
  fsyncDirectory(destination, expectedDestination);
}

function copyTree(
  source: string,
  destination: string,
  snapshot: TreeSnapshot,
  limits: RunOutputMigrationLimits,
): void {
  const destinationStat = requireOwnedDirectory(destination, "run output staging directory");
  const copyLimits = {
    maxDepth: limits.maxDepth,
    maxEntries: Math.max(snapshot.entries, 1),
    maxBytes: Math.max(snapshot.bytes, 1),
  };
  const budget = newBudget(copyLimits);
  copyTreeDirectory(
    source,
    destination,
    0,
    budget,
    snapshot.identity,
    identityOf(destinationStat),
    Buffer.allocUnsafe(64 * 1024),
  );
  if (budget.entries !== snapshot.entries || budget.bytes !== snapshot.bytes) {
    throw new Error("run output source changed after its resource budget was validated");
  }
}

function normalizeSelectedRelativeFiles(
  source: string,
  relativeFiles: readonly string[],
  limits: RunOutputMigrationLimits,
): string[] {
  if (relativeFiles.length < 1) {
    throw new Error("run output recovery requires at least one persisted artifact file");
  }
  if (relativeFiles.length > limits.maxArtifacts) {
    throw new Error(`run output recovery exceeds the artifact limit of ${limits.maxArtifacts}`);
  }
  const normalized = relativeFiles.map((relativeFile) => {
    const candidate = resolve(source, relativeFile);
    if (
      relativeFile.length < 1
      || isAbsolute(relativeFile)
      || relative(source, candidate) !== relativeFile
      || !contained(source, candidate)
      || candidate === source
    ) {
      throw new Error(`persisted artifact path is not a canonical relative file: ${relativeFile}`);
    }
    return relativeFile;
  }).sort((left, right) => left.localeCompare(right));
  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index] === normalized[index - 1]) {
      throw new Error(`persisted artifact path occurs more than once: ${normalized[index]}`);
    }
  }
  return normalized;
}

function copySelectedFiles(
  source: string,
  destination: string,
  relativeFiles: readonly string[],
  sourceSnapshot: TreeSnapshot,
  limits: RunOutputMigrationLimits,
): TreeSnapshot {
  const destinationIdentity = identityOf(
    requireOwnedDirectory(destination, "run output staging directory"),
  );
  const directories = new Set<string>();
  for (const relativeFile of relativeFiles) {
    let parent = dirname(relativeFile);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  const orderedDirectories = [...directories].sort((left, right) => {
    const depthDifference = left.split(sep).length - right.split(sep).length;
    return depthDifference || left.localeCompare(right);
  });
  const budget = newBudget(limits);
  for (const relativeDirectory of orderedDirectories) {
    countEntry(budget, "persisted run artifacts");
    const sourceDirectory = resolve(source, relativeDirectory);
    const sourceStat = requireOwnedDirectory(sourceDirectory, "run output source");
    if ((sourceStat.mode & 0o077) !== 0) {
      throw new Error(`persisted artifact directory must be owner-private: ${sourceDirectory}`);
    }
    if (
      sourceStat.dev !== sourceSnapshot.identity.dev
      || realpathSync(sourceDirectory) !== sourceDirectory
    ) {
      throw new Error(`run output source directory is unsafe: ${sourceDirectory}`);
    }
    const destinationDirectory = resolve(destination, relativeDirectory);
    mkdirSync(destinationDirectory, { mode: 0o700 });
    const destinationStat = requireOwnedDirectory(
      destinationDirectory,
      "run output staging directory",
    );
    if (destinationStat.dev !== destinationIdentity.dev) {
      throw new Error(`run output staging directory crosses a filesystem boundary: ${destinationDirectory}`);
    }
  }
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (const relativeFile of relativeFiles) {
    countEntry(budget, "persisted run artifacts");
    const sourceFile = resolve(source, relativeFile);
    if (realpathSync(sourceFile) !== sourceFile) {
      throw new Error(`run output source file traverses a symbolic link: ${sourceFile}`);
    }
    const sourceStat = requireRegularFile(sourceFile, "run output source");
    if (sourceStat.dev !== sourceSnapshot.identity.dev) {
      throw new Error(`run output source file crosses a filesystem boundary: ${sourceFile}`);
    }
    copyRegularFile(
      sourceFile,
      resolve(destination, relativeFile),
      sourceStat,
      buffer,
      budget,
    );
  }
  assertDirectoryIdentity(source, sourceSnapshot.identity, "run output source", true);
  const stagingSnapshot = secureAndSyncTree(destination, limits, destinationIdentity);
  if (
    budget.entries !== stagingSnapshot.entries
    || budget.bytes !== stagingSnapshot.bytes
  ) {
    throw new Error("persisted run artifact staging tree changed while it was copied");
  }
  return stagingSnapshot;
}

function regularFilesEqual(
  left: string,
  right: string,
  leftExpected: Stats,
  rightExpected: Stats,
  leftBuffer: Buffer,
  rightBuffer: Buffer,
  leftBudget: TraversalBudget,
  rightBudget: TraversalBudget,
): boolean {
  requireDistinctIdentity(identityOf(leftExpected), identityOf(rightExpected), left, right);
  const leftDescriptor = openSync(left, constants.O_RDONLY | constants.O_NOFOLLOW);
  const rightDescriptor = openSync(right, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const leftOpened = fstatSync(leftDescriptor);
    const rightOpened = fstatSync(rightDescriptor);
    if (!leftOpened.isFile() || !rightOpened.isFile()) {
      throw new Error(`run output trees must contain only regular files: ${left}`);
    }
    if (!sameFileVersion(leftOpened, leftExpected) || !sameFileVersion(rightOpened, rightExpected)) {
      throw new Error(`run output file identity changed during comparison: ${left}`);
    }
    requireDistinctIdentity(identityOf(leftOpened), identityOf(rightOpened), left, right);
    if (leftOpened.size !== rightOpened.size) return false;
    let comparedBytes = 0;
    while (true) {
      const leftBytes = readSync(leftDescriptor, leftBuffer, 0, leftBuffer.length, null);
      const rightBytes = readSync(rightDescriptor, rightBuffer, 0, rightBuffer.length, null);
      if (leftBytes !== rightBytes) return false;
      if (leftBytes === 0) break;
      countBytes(leftBudget, leftBytes, "run output source");
      countBytes(rightBudget, rightBytes, "run output destination");
      comparedBytes += leftBytes;
      if (!leftBuffer.subarray(0, leftBytes).equals(rightBuffer.subarray(0, rightBytes))) return false;
    }
    if (comparedBytes !== leftOpened.size) {
      throw new Error(`run output file changed during comparison: ${left}`);
    }
    if (
      !sameFileVersion(fstatSync(leftDescriptor), leftOpened)
      || !sameFileVersion(fstatSync(rightDescriptor), rightOpened)
    ) {
      throw new Error(`run output file changed during comparison: ${left}`);
    }
    return true;
  } finally {
    closeSync(rightDescriptor);
    closeSync(leftDescriptor);
  }
}

function compareTreeDirectories(
  left: string,
  right: string,
  depth: number,
  leftBudget: TraversalBudget,
  rightBudget: TraversalBudget,
  leftExpected: NodeIdentity,
  rightExpected: NodeIdentity,
  leftBuffer: Buffer,
  rightBuffer: Buffer,
): boolean {
  requireDistinctIdentity(leftExpected, rightExpected, left, right);
  const leftNames = boundedEntryNames(left, "run output source", depth, leftBudget, leftExpected, true);
  const rightNames = boundedEntryNames(right, "run output destination", depth, rightBudget, rightExpected, true);
  if (leftNames.length !== rightNames.length) return false;
  for (let index = 0; index < leftNames.length; index++) {
    const name = leftNames[index]!;
    if (name !== rightNames[index]) return false;
    const leftChild = join(left, name);
    const rightChild = join(right, name);
    const leftStat = lstatSync(leftChild);
    const rightStat = lstatSync(rightChild);
    if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) {
      throw new Error(`run output trees must not contain symbolic links: ${leftChild}`);
    }
    if (leftStat.isDirectory() && rightStat.isDirectory()) {
      requireOwnedDirectory(leftChild, "run output source");
      requireOwnedDirectory(rightChild, "run output destination");
      if (
        !compareTreeDirectories(
          leftChild,
          rightChild,
          depth + 1,
          leftBudget,
          rightBudget,
          identityOf(leftStat),
          identityOf(rightStat),
          leftBuffer,
          rightBuffer,
        )
      ) {
        return false;
      }
    } else if (leftStat.isFile() && rightStat.isFile()) {
      if (
        !regularFilesEqual(
          leftChild,
          rightChild,
          leftStat,
          rightStat,
          leftBuffer,
          rightBuffer,
          leftBudget,
          rightBudget,
        )
      ) {
        return false;
      }
    } else if (
      leftStat.isDirectory()
      || rightStat.isDirectory()
      || leftStat.isFile()
      || rightStat.isFile()
    ) {
      return false;
    } else {
      throw new Error(`run output trees must contain only regular files and directories: ${leftChild}`);
    }
  }
  assertDirectoryIdentity(left, leftExpected, "run output source", true);
  assertDirectoryIdentity(right, rightExpected, "run output destination", true);
  return true;
}

function treesEqual(
  left: string,
  right: string,
  limits: RunOutputMigrationLimits,
  leftExpected?: NodeIdentity,
  rightExpected?: NodeIdentity,
): boolean {
  requireDistinctCanonicalPaths(left, right, "run output source", "run output destination");
  const leftSnapshot = validateTree(left, "run output source", limits, leftExpected);
  const rightSnapshot = validateTree(right, "run output destination", limits, rightExpected);
  requireDistinctIdentity(leftSnapshot.identity, rightSnapshot.identity, left, right);
  if (leftSnapshot.entries !== rightSnapshot.entries || leftSnapshot.bytes !== rightSnapshot.bytes) return false;
  const comparisonLimits = {
    maxDepth: limits.maxDepth,
    maxEntries: Math.max(leftSnapshot.entries, 1),
    maxBytes: Math.max(leftSnapshot.bytes, 1),
  };
  const leftBudget = newBudget(comparisonLimits);
  const rightBudget = newBudget(comparisonLimits);
  const equal = compareTreeDirectories(
    left,
    right,
    0,
    leftBudget,
    rightBudget,
    leftSnapshot.identity,
    rightSnapshot.identity,
    Buffer.allocUnsafe(64 * 1024),
    Buffer.allocUnsafe(64 * 1024),
  );
  if (
    equal
    && (
      leftBudget.entries !== leftSnapshot.entries
      || rightBudget.entries !== rightSnapshot.entries
      || leftBudget.bytes !== leftSnapshot.bytes
      || rightBudget.bytes !== rightSnapshot.bytes
    )
  ) {
    throw new Error("run output trees changed during comparison");
  }
  return equal;
}

function secureAndSyncTreeDirectory(
  path: string,
  depth: number,
  budget: TraversalBudget,
  expected: NodeIdentity,
): void {
  const names = boundedEntryNames(path, "run output destination", depth, budget, expected, true);
  for (const name of names) {
    const child = join(path, name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error(`run output destination contains a symbolic link: ${child}`);
    if (stat.isDirectory()) {
      requireOwnedDirectory(child, "run output destination");
      secureAndSyncTreeDirectory(child, depth + 1, budget, identityOf(stat));
    } else if (stat.isFile()) {
      countBytes(budget, stat.size, "run output destination");
      chmodSync(child, 0o600);
      const descriptor = openSync(child, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || !sameIdentity(identityOf(opened), identityOf(stat))) {
          throw new Error(`run output destination file identity changed: ${child}`);
        }
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    } else {
      throw new Error(`run output destination contains a non-regular file: ${child}`);
    }
  }
  assertDirectoryIdentity(path, expected, "run output destination", true);
  chmodSync(path, 0o700);
  fsyncDirectory(path, expected);
}

function secureAndSyncTree(
  path: string,
  limits: RunOutputMigrationLimits,
  expected?: NodeIdentity,
): TreeSnapshot {
  const snapshot = validateTree(path, "run output destination", limits, expected);
  const secureLimits = {
    maxDepth: limits.maxDepth,
    maxEntries: Math.max(snapshot.entries, 1),
    maxBytes: Math.max(snapshot.bytes, 1),
  };
  const budget = newBudget(secureLimits);
  secureAndSyncTreeDirectory(path, 0, budget, snapshot.identity);
  if (budget.entries !== snapshot.entries || budget.bytes !== snapshot.bytes) {
    throw new Error("run output destination changed while it was secured");
  }
  return snapshot;
}

interface PublicationResult {
  readonly moved: boolean;
  readonly destinationIdentity: NodeIdentity;
}

interface SourceRootIdentity {
  readonly path: string;
  readonly identity: NodeIdentity;
}

function removeTreeDirectory(
  path: string,
  depth: number,
  budget: TraversalBudget,
  expected: NodeIdentity,
  label: string,
): void {
  const names = boundedEntryNames(path, label, depth, budget, expected, true);
  for (const name of names) {
    const child = join(path, name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link: ${child}`);
    if (stat.isDirectory()) {
      requireOwnedDirectory(child, label);
      const childIdentity = identityOf(stat);
      removeTreeDirectory(child, depth + 1, budget, childIdentity, label);
      assertDirectoryIdentity(child, childIdentity, label, true);
      rmdirSync(child);
    } else if (stat.isFile()) {
      countBytes(budget, stat.size, label);
      const current = requireRegularFile(child, label);
      if (!sameIdentity(identityOf(current), identityOf(stat))) {
        throw new Error(`${label} file identity changed before removal: ${child}`);
      }
      unlinkSync(child);
    } else {
      throw new Error(`${label} contains a non-regular file: ${child}`);
    }
  }
  assertDirectoryIdentity(path, expected, label, true);
}

function removeTree(
  path: string,
  limits: RunOutputMigrationLimits,
  expected: NodeIdentity,
  label: string,
): void {
  assertDirectoryIdentity(path, expected, label, true);
  const budget = newBudget(limits);
  removeTreeDirectory(path, 0, budget, expected, label);
}

function publishSource(
  source: string,
  destination: string,
  outputRoot: string,
  run: RunRow,
  limits: RunOutputMigrationLimits,
  sourceIdentity: NodeIdentity,
  outputRootIdentity: NodeIdentity,
): PublicationResult {
  requireDistinctCanonicalPaths(source, outputRoot, `run ${run.id} output source`, "run output root");
  const sourceSnapshot = validateTree(source, `run ${run.id} output source`, limits, sourceIdentity);
  requireDistinctIdentity(sourceSnapshot.identity, outputRootIdentity, source, outputRoot);
  assertDirectoryIdentity(outputRoot, outputRootIdentity, "run output root", true);
  const existingDestination = lstatIfExists(destination);
  if (existingDestination !== undefined) {
    const destinationStat = requireOwnedDirectory(destination, `run ${run.id} output destination`);
    const destinationIdentity = identityOf(destinationStat);
    requireDistinctIdentity(sourceSnapshot.identity, destinationIdentity, source, destination);
    if (!treesEqual(source, destination, limits, sourceSnapshot.identity, destinationIdentity)) {
      throw new Error(`run ${run.id} output destination already exists and conflicts: ${destination}`);
    }
    secureAndSyncTree(destination, limits, destinationIdentity);
    assertDirectoryIdentity(outputRoot, outputRootIdentity, "run output root", true);
    fsyncDirectory(outputRoot, outputRootIdentity);
    return { moved: false, destinationIdentity };
  }

  const staging = join(outputRoot, `.jobhunter-migrate-${run.queue_sequence}-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  const stagingStat = requireOwnedDirectory(staging, "run output staging directory");
  const stagingIdentity = identityOf(stagingStat);
  let published = false;
  try {
    if (stagingIdentity.dev !== outputRootIdentity.dev) {
      throw new Error(`run output staging directory is not on the target filesystem: ${staging}`);
    }
    copyTree(source, staging, sourceSnapshot, limits);
    if (!treesEqual(source, staging, limits, sourceSnapshot.identity, stagingIdentity)) {
      throw new Error(`run ${run.id} staged output differs from its source`);
    }
    assertDirectoryIdentity(source, sourceSnapshot.identity, `run ${run.id} output source`, true);
    assertDirectoryIdentity(outputRoot, outputRootIdentity, "run output root", true);
    if (lstatIfExists(destination) !== undefined) {
      throw new Error(`run ${run.id} output destination already exists and conflicts: ${destination}`);
    }
    renameSync(staging, destination);
    published = true;
    const publishedStat = requireOwnedDirectory(destination, `run ${run.id} output destination`);
    const destinationIdentity = identityOf(publishedStat);
    if (!sameIdentity(destinationIdentity, stagingIdentity)) {
      throw new Error(`run ${run.id} output identity changed during publication: ${destination}`);
    }
    assertDirectoryIdentity(outputRoot, outputRootIdentity, "run output root", true);
    fsyncDirectory(outputRoot, outputRootIdentity);
    return { moved: true, destinationIdentity };
  } finally {
    if (!published) {
      const remaining = lstatIfExists(staging);
      if (remaining !== undefined) {
        const remainingIdentity = identityOf(requireOwnedDirectory(staging, "run output staging directory"));
        if (!sameIdentity(remainingIdentity, stagingIdentity)) {
          throw new Error(`run output staging directory identity changed before cleanup: ${staging}`);
        }
        removeTree(staging, limits, stagingIdentity, "run output staging directory");
        assertDirectoryIdentity(staging, stagingIdentity, "run output staging directory", true);
        rmdirSync(staging);
        fsyncDirectory(outputRoot, outputRootIdentity);
      }
    }
  }
}
export function publishPrivateRunOutputBackup(
  options: RunOutputBackupPublicationOptions,
): RunOutputBackupPublicationResult {
  if (
    !isAbsolute(options.source)
    || resolve(options.source) !== options.source
    || !isAbsolute(options.outputRoot)
    || resolve(options.outputRoot) !== options.outputRoot
  ) {
    throw new Error("run output backup and destination roots must be absolute canonical paths");
  }
  if (!Number.isSafeInteger(options.queueSequence) || options.queueSequence < 1) {
    throw new Error("run output queue sequence must be a positive safe integer");
  }
  const limits = resolveMigrationLimits(options.limits);
  const source = options.source;
  const outputRoot = options.outputRoot;
  const destination = directChild(
    outputRoot,
    String(options.queueSequence),
    `run ${options.runId} destination`,
  );
  const sourceSnapshot = validateTree(
    source,
    `run ${options.runId} migrated backup`,
    limits,
  );
  const sourceRootStat = requireOwnedDirectory(
    source,
    `run ${options.runId} migrated backup`,
  );
  if ((sourceRootStat.mode & 0o077) !== 0) {
    throw new Error(`migrated run output backup must be owner-private: ${source}`);
  }
  const relativeFiles = normalizeSelectedRelativeFiles(
    source,
    options.relativeFiles,
    limits,
  );
  const outputRootStat = requireCanonicalDirectory(outputRoot, "run output root", true);
  if ((outputRootStat.mode & 0o077) !== 0) {
    throw new Error(`run output root must be owner-private: ${outputRoot}`);
  }
  const outputRootIdentity = identityOf(outputRootStat);
  requireDistinctCanonicalPaths(source, outputRoot, "migrated run output backup", "run output root");
  requireDistinctIdentity(sourceSnapshot.identity, outputRootIdentity, source, outputRoot);
  options.verifyTree(source, destination);
  assertDirectoryIdentity(
    source,
    sourceSnapshot.identity,
    `run ${options.runId} migrated backup`,
    true,
  );

  const staging = join(outputRoot, `.jobhunter-restore-${options.queueSequence}-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  const stagingIdentity = identityOf(
    requireOwnedDirectory(staging, "run output staging directory"),
  );
  let published = false;
  try {
    if (stagingIdentity.dev !== outputRootIdentity.dev) {
      throw new Error(`run output staging directory is not on the target filesystem: ${staging}`);
    }
    const stagingSnapshot = copySelectedFiles(
      source,
      staging,
      relativeFiles,
      sourceSnapshot,
      limits,
    );
    options.verifyTree(staging, destination);
    const verifiedStaging = validateTree(
      staging,
      "run output staging directory",
      limits,
      stagingIdentity,
    );
    if (
      verifiedStaging.entries !== stagingSnapshot.entries
      || verifiedStaging.bytes !== stagingSnapshot.bytes
    ) {
      throw new Error(`run ${options.runId} staging tree changed during verification`);
    }
    assertDirectoryIdentity(
      source,
      sourceSnapshot.identity,
      `run ${options.runId} migrated backup`,
      true,
    );
    assertDirectoryIdentity(outputRoot, outputRootIdentity, "run output root", true);

    const existingDestination = lstatIfExists(destination);
    if (existingDestination !== undefined) {
      const destinationStat = requireOwnedDirectory(
        destination,
        `run ${options.runId} output destination`,
      );
      const destinationIdentity = identityOf(destinationStat);
      if (!treesEqual(
        staging,
        destination,
        limits,
        stagingIdentity,
        destinationIdentity,
      )) {
        throw new Error(`run ${options.runId} output destination already exists and conflicts: ${destination}`);
      }
      secureAndSyncTree(destination, limits, destinationIdentity);
      fsyncDirectory(outputRoot, outputRootIdentity);
      return { destination, moved: false };
    }

    renameSync(staging, destination);
    published = true;
    const publishedStat = requireOwnedDirectory(
      destination,
      `run ${options.runId} output destination`,
    );
    if (!sameIdentity(identityOf(publishedStat), stagingIdentity)) {
      throw new Error(`run ${options.runId} output identity changed during publication: ${destination}`);
    }
    fsyncDirectory(outputRoot, outputRootIdentity);
    return { destination, moved: true };
  } finally {
    if (!published) {
      const remaining = lstatIfExists(staging);
      if (remaining !== undefined) {
        const remainingIdentity = identityOf(
          requireOwnedDirectory(staging, "run output staging directory"),
        );
        if (!sameIdentity(remainingIdentity, stagingIdentity)) {
          throw new Error(`run output staging directory identity changed before cleanup: ${staging}`);
        }
        removeTree(staging, limits, stagingIdentity, "run output staging directory");
        assertDirectoryIdentity(staging, stagingIdentity, "run output staging directory", true);
        rmdirSync(staging);
        fsyncDirectory(outputRoot, outputRootIdentity);
      }
    }
  }
}

function retiredSourcePath(source: string): string {
  return join(dirname(source), `.${basename(source)}.jobhunter-migrated`);
}

function retireSource(
  source: string,
  destination: string,
  sourceIdentity: NodeIdentity,
  destinationIdentity: NodeIdentity,
  sourceRootIdentity: NodeIdentity,
  limits: RunOutputMigrationLimits,
  alreadyRetired: boolean,
): void {
  requireDistinctIdentity(sourceIdentity, destinationIdentity, source, destination);
  if (!treesEqual(source, destination, limits, sourceIdentity, destinationIdentity)) {
    throw new Error(`migrated run output destination changed before source retirement: ${destination}`);
  }
  const parent = dirname(source);
  assertDirectoryIdentity(parent, sourceRootIdentity, "prior run output root", true);
  assertDirectoryIdentity(source, sourceIdentity, "migrated run output source", true);
  assertDirectoryIdentity(destination, destinationIdentity, "migrated run output destination", true);
  if (alreadyRetired) {
    fsyncDirectory(parent, sourceRootIdentity);
    return;
  }

  const retired = retiredSourcePath(source);
  if (lstatIfExists(retired) !== undefined) {
    throw new Error(`migrated run output backup already exists: ${retired}`);
  }
  renameSync(source, retired);
  fsyncDirectory(parent, sourceRootIdentity);
  const retiredStat = requireOwnedDirectory(retired, "migrated run output backup");
  if (!sameIdentity(identityOf(retiredStat), sourceIdentity)) {
    throw new Error(`migrated run output source identity changed during retirement: ${source}`);
  }
  assertDirectoryIdentity(destination, destinationIdentity, "migrated run output destination", true);
  if (!treesEqual(retired, destination, limits, sourceIdentity, destinationIdentity)) {
    throw new Error(`migrated run output backup changed during retirement: ${retired}`);
  }
  fsyncDirectory(parent, sourceRootIdentity);
}

function removeEmptySourceRoots(roots: readonly SourceRootIdentity[]): void {
  for (const root of roots) {
    if (lstatIfExists(root.path) === undefined) continue;
    assertDirectoryIdentity(root.path, root.identity, "prior run output root", true);
    fsyncDirectory(root.path, root.identity);
    try {
      assertDirectoryIdentity(root.path, root.identity, "prior run output root", true);
      rmdirSync(root.path);
      fsyncDirectory(dirname(root.path));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    }
  }
}

function artifactTarget(
  row: ArtifactRow,
  run: RunRow,
  outputRoot: string,
  legacyRoots: readonly string[],
  priorOutputRoots: readonly string[],
): string {
  if (!isAbsolute(row.path)) throw new Error(`artifact ${row.id} path must be absolute`);
  const current = resolve(row.path);
  const destinationRunRoot = directChild(outputRoot, String(run.queue_sequence), `run ${run.id} destination`);
  if (contained(destinationRunRoot, current) && current !== destinationRunRoot) return current;

  const priorRunRoots = [
    ...legacyRoots.map((root) => directChild(root, run.id, `run ${run.id} legacy source`)),
    ...priorOutputRoots.map((root) =>
      directChild(root, String(run.queue_sequence), `run ${run.id} prior source`)
    ),
  ];
  for (const priorRunRoot of priorRunRoots) {
    if (!contained(priorRunRoot, current) || current === priorRunRoot) continue;
    const suffix = relative(priorRunRoot, current);
    const target = resolve(destinationRunRoot, suffix);
    if (!contained(destinationRunRoot, target) || target === destinationRunRoot) {
      throw new Error(`artifact ${row.id} path escapes its run output`);
    }
    return target;
  }
  throw new Error(`artifact ${row.id} path is outside known run output roots`);
}

export function migrateRunOutputLayout(
  database: Database,
  options: RunOutputMigrationOptions = {},
): RunOutputMigrationResult {
  const limits = resolveMigrationLimits(options.limits);
  const outputRoot = resolve(options.outputRoot ?? DEFAULT_ARTIFACT_ROOT);
  const legacyRoots = [...new Set(
    (options.legacyRoots ?? [LEGACY_ARTIFACT_ROOT, HISTORICAL_ARTIFACT_ROOT]).map((root) => resolve(root)),
  )];
  const priorOutputRoots = [...new Set((options.priorOutputRoots ?? []).map((root) => resolve(root)))];
  const sourceRoots = [...new Set([...legacyRoots, ...priorOutputRoots])];
  const runCount = database.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM runs",
  ).get()?.count ?? 0;
  if (!Number.isSafeInteger(runCount) || runCount < 0 || runCount > limits.maxRuns) {
    throw new Error(`run output migration exceeds the run row limit of ${limits.maxRuns}`);
  }
  const artifactCount = database.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM artifacts",
  ).get()?.count ?? 0;
  if (
    !Number.isSafeInteger(artifactCount)
    || artifactCount < 0
    || artifactCount > limits.maxArtifacts
  ) {
    throw new Error(`run output migration exceeds the artifact row limit of ${limits.maxArtifacts}`);
  }

  const sourceRootIdentities: SourceRootIdentity[] = [];
  for (const sourceRoot of sourceRoots) {
    if (
      sourceRoot === outputRoot
      || contained(sourceRoot, outputRoot)
      || contained(outputRoot, sourceRoot)
    ) {
      throw new Error(`run output source and destination roots must be separate: ${sourceRoot}`);
    }
    if (lstatIfExists(sourceRoot) !== undefined) {
      const stat = requireCanonicalDirectory(sourceRoot, "prior run output root", true);
      sourceRootIdentities.push({ path: sourceRoot, identity: identityOf(stat) });
    }
  }

  let outputRootIdentity: NodeIdentity | undefined;
  if (lstatIfExists(outputRoot) !== undefined) {
    outputRootIdentity = identityOf(requireCanonicalDirectory(outputRoot, "run output root", true));
    for (const sourceRoot of sourceRootIdentities) {
      requireDistinctIdentity(sourceRoot.identity, outputRootIdentity, sourceRoot.path, outputRoot);
    }
  }

  const runs = database.query<RunRow, []>("SELECT id, queue_sequence FROM runs ORDER BY queue_sequence").all();
  if (runs.length === 0) return { movedRuns: 0, rewrittenArtifacts: 0 };

  const sequences = new Set<number>();
  for (const run of runs) {
    if (!Number.isSafeInteger(run.queue_sequence) || run.queue_sequence < 1 || sequences.has(run.queue_sequence)) {
      throw new Error(`run ${run.id} has an invalid output sequence`);
    }
    sequences.add(run.queue_sequence);
  }

  if (outputRootIdentity === undefined) {
    mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    outputRootIdentity = identityOf(requireCanonicalDirectory(outputRoot, "run output root", true));
  }
  for (const sourceRoot of sourceRootIdentities) {
    requireDistinctIdentity(sourceRoot.identity, outputRootIdentity, sourceRoot.path, outputRoot);
  }
  chmodSync(outputRoot, 0o700);
  assertDirectoryIdentity(outputRoot, outputRootIdentity, "run output root", true);
  fsyncDirectory(outputRoot, outputRootIdentity);
  const sourceBudget = newBudget(limits);

  const plans = runs.map((run): RunOutputPlan => {
    const destination = directChild(outputRoot, String(run.queue_sequence), `run ${run.id} destination`);
    const candidateSources = [
      ...legacyRoots.map((root) => ({
        source: directChild(root, run.id, `run ${run.id} legacy source`),
        root,
      })),
      ...priorOutputRoots.map((root) => ({
        source: directChild(root, String(run.queue_sequence), `run ${run.id} prior source`),
        root,
      })),
    ];
    const sources = candidateSources.flatMap((candidate) => {
      const sourcePresent = lstatIfExists(candidate.source) !== undefined;
      const retired = retiredSourcePath(candidate.source);
      const retiredPresent = lstatIfExists(retired) !== undefined;
      if (sourcePresent && retiredPresent) {
        throw new Error(`run ${run.id} has both an active source and migrated backup`);
      }
      if (sourcePresent) return [{ ...candidate, retired: false }];
      if (retiredPresent) return [{ ...candidate, source: retired, retired: true }];
      return [];
    });
    if (sources.length > 1) throw new Error(`run ${run.id} exists in multiple prior or legacy output roots`);
    const candidate = sources[0];
    if (candidate !== undefined) {
      const sourceRoot = sourceRootIdentities.find(({ path }) => path === candidate.root);
      if (sourceRoot === undefined) {
        throw new Error(`run ${run.id} source root identity was not captured`);
      }
      assertDirectoryIdentity(candidate.root, sourceRoot.identity, "prior run output root", true);
      const sourceSnapshot = validateTree(candidate.source, `run ${run.id} output source`, limits);
      consumeTreeSnapshot(sourceBudget, sourceSnapshot, "run output sources");
      requireDistinctIdentity(sourceSnapshot.identity, outputRootIdentity, candidate.source, outputRoot);
      if (lstatIfExists(destination) !== undefined) {
        const destinationIdentity = identityOf(
          requireOwnedDirectory(destination, `run ${run.id} output destination`),
        );
        requireDistinctIdentity(sourceSnapshot.identity, destinationIdentity, candidate.source, destination);
        if (!treesEqual(
          candidate.source,
          destination,
          limits,
          sourceSnapshot.identity,
          destinationIdentity,
        )) {
          throw new Error(`run ${run.id} output destination already exists and conflicts: ${destination}`);
        }
      }
      return {
        run,
        destination,
        source: candidate.source,
        sourceIdentity: sourceSnapshot.identity,
        sourceRootIdentity: sourceRoot.identity,
        sourceRetired: candidate.retired,
      };
    }
    if (lstatIfExists(destination) !== undefined) {
      requireOwnedDirectory(destination, `run ${run.id} output`);
    }
    return {
      run,
      destination,
      source: undefined,
      sourceIdentity: undefined,
      sourceRootIdentity: undefined,
      sourceRetired: false,
    };
  });

  const runById = new Map(runs.map((run) => [run.id, run]));
  const rewrites = database.query<ArtifactRow, []>("SELECT id, run_id, path FROM artifacts ORDER BY created_at, id")
    .all()
    .map((artifact) => {
      const run = runById.get(artifact.run_id);
      if (!run) throw new Error(`artifact ${artifact.id} references an unknown run`);
      return {
        id: artifact.id,
        current: artifact.path,
        target: artifactTarget(artifact, run, outputRoot, legacyRoots, priorOutputRoots),
      };
    })
    .filter((rewrite) => resolve(rewrite.current) !== rewrite.target);

  const publications = new Map<string, PublicationResult>();
  let movedRuns = 0;
  for (const plan of plans) {
    if (plan.source === undefined || plan.sourceIdentity === undefined) continue;
    if (plan.sourceRootIdentity === undefined) {
      throw new Error(`run ${plan.run.id} source root identity was not captured`);
    }
    assertDirectoryIdentity(dirname(plan.source), plan.sourceRootIdentity, "prior run output root", true);
    const publication = publishSource(
      plan.source,
      plan.destination,
      outputRoot,
      plan.run,
      limits,
      plan.sourceIdentity,
      outputRootIdentity,
    );
    publications.set(plan.run.id, publication);
    if (publication.moved) movedRuns++;
  }

  if (rewrites.length > 0) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec("DROP TRIGGER artifacts_no_update");
      const update = database.query("UPDATE artifacts SET path=? WHERE id=?");
      for (const rewrite of rewrites) update.run(rewrite.target, rewrite.id);
      database.exec(ARTIFACT_UPDATE_TRIGGER);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  for (const plan of plans) {
    if (
      plan.source === undefined
      || plan.sourceIdentity === undefined
      || plan.sourceRootIdentity === undefined
    ) {
      continue;
    }
    const publication = publications.get(plan.run.id);
    if (publication === undefined) throw new Error(`run ${plan.run.id} output was not published`);
    retireSource(
      plan.source,
      plan.destination,
      plan.sourceIdentity,
      publication.destinationIdentity,
      plan.sourceRootIdentity,
      limits,
      plan.sourceRetired,
    );
  }
  removeEmptySourceRoots(sourceRootIdentities);
  assertDirectoryIdentity(outputRoot, outputRootIdentity, "run output root", true);
  fsyncDirectory(outputRoot, outputRootIdentity);
  return { movedRuns, rewrittenArtifacts: rewrites.length };
}
