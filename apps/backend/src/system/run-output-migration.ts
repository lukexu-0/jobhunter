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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const HARD_BACKUP_LIMITS = {
  maxDepth: 64,
  maxEntries: 100_000,
  maxBytes: 1024 * 1024 * 1024,
  maxArtifacts: 100_000,
} as const;

interface RunOutputTraversalLimits {
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export interface RunOutputBackupLimits extends RunOutputTraversalLimits {
  readonly maxArtifacts: number;
}

export interface RunOutputBackupPublicationOptions {
  readonly source: string;
  readonly outputRoot: string;
  readonly runId: string;
  readonly queueSequence: number;
  readonly relativeFiles: readonly string[];
  readonly limits?: Partial<RunOutputBackupLimits>;
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

function resolveBackupLimits(overrides: Partial<RunOutputBackupLimits> | undefined): RunOutputBackupLimits {
  const bounded = (value: number | undefined, hardLimit: number, label: string): number => {
    const selected = value ?? hardLimit;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > hardLimit) {
      throw new Error(`${label} must be a positive safe integer no greater than ${hardLimit}`);
    }
    return selected;
  };
  return {
    maxDepth: bounded(overrides?.maxDepth, HARD_BACKUP_LIMITS.maxDepth, "run output backup depth limit"),
    maxEntries: bounded(
      overrides?.maxEntries,
      HARD_BACKUP_LIMITS.maxEntries,
      "run output backup entry limit",
    ),
    maxBytes: bounded(overrides?.maxBytes, HARD_BACKUP_LIMITS.maxBytes, "run output backup byte limit"),
    maxArtifacts: bounded(
      overrides?.maxArtifacts,
      HARD_BACKUP_LIMITS.maxArtifacts,
      "run output backup artifact limit",
    ),
  };
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
    throw new Error(`${label} identity changed during run output backup: ${path}`);
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
    throw new Error(`${label} exceeds the run output backup entry limit of ${budget.limits.maxEntries}`);
  }
  budget.entries++;
}

function countBytes(budget: TraversalBudget, bytes: number, label: string): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`${label} has an invalid file size`);
  }
  if (bytes > budget.limits.maxBytes - budget.bytes) {
    throw new Error(`${label} exceeds the run output backup byte limit of ${budget.limits.maxBytes}`);
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
    throw new Error(`${label} exceeds the run output backup depth limit of ${budget.limits.maxDepth}`);
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
  limits: RunOutputBackupLimits,
  expected?: NodeIdentity,
  ownerControlled = true,
): TreeSnapshot {
  const stat = ownerControlled ? requireOwnedDirectory(path, label) : requireDirectory(path, label);
  const identity = identityOf(stat);
  if (expected !== undefined && !sameIdentity(identity, expected)) {
    throw new Error(`${label} identity changed during run output backup: ${path}`);
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
      throw new Error(`run output source file identity changed during backup restoration: ${source}`);
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
        throw new Error(`run output source file grew during backup restoration: ${source}`);
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
      throw new Error(`run output source file changed during backup restoration: ${source}`);
    }
    fsyncSync(destinationDescriptor);
    chmodSync(destination, 0o600);
  } finally {
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    closeSync(sourceDescriptor);
  }
}

function normalizeSelectedRelativeFiles(
  source: string,
  relativeFiles: readonly string[],
  limits: RunOutputBackupLimits,
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
  limits: RunOutputBackupLimits,
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
  limits: RunOutputBackupLimits,
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
  limits: RunOutputBackupLimits,
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
  limits: RunOutputBackupLimits,
  expected: NodeIdentity,
  label: string,
): void {
  assertDirectoryIdentity(path, expected, label, true);
  const budget = newBudget(limits);
  removeTreeDirectory(path, 0, budget, expected, label);
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
  const limits = resolveBackupLimits(options.limits);
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

  const staging = join(outputRoot, `.jobhunt-restore-${options.queueSequence}-${randomUUID()}`);
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
