import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { createServer } from "node:net";
import type {
  LaunchConfiguration,
  ProductionCheckoutIdentity,
} from "./launch-config.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const ARTIFACT_MIGRATION_RECEIPT = ".artifact-import.pending";
const PRODUCTION_CHECKOUT_RECEIPT = ".production-checkout";
const RECEIPT_SIZE_LIMIT = 4_096;
const SQLITE_COMPANION_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const MAX_SQLITE_IMPORT_BYTES = 1024 * 1024 * 1024;

interface DatabaseMigration {
  readonly label: string;
  readonly source: string;
  readonly target: string;
}

interface SourceFileIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface LaunchArtifactMigration {
  readonly priorRoot: string;
  readonly receiptPath: string;
  readonly receiptContents: string;
}

export interface LaunchStoragePreparation {
  readonly artifactMigration?: LaunchArtifactMigration;
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

function isAlreadyPresent(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "EEXIST",
  );
}

function ensurePrivateDirectory(path: string, label: string): void {
  const absolutePath = resolve(path);
  const filesystemRoot = parse(absolutePath).root;
  if (absolutePath === filesystemRoot) {
    throw new Error(`${label} must not be the filesystem root`);
  }

  let cursor = filesystemRoot;
  const components = relative(filesystemRoot, absolutePath).split(sep).filter(Boolean);
  for (const component of components) {
    cursor = resolve(cursor, component);
    let status: Stats;
    try {
      status = lstatSync(cursor);
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        mkdirSync(cursor, { mode: PRIVATE_DIRECTORY_MODE });
      } catch (mkdirError) {
        if (!isAlreadyPresent(mkdirError)) throw mkdirError;
      }
      status = lstatSync(cursor);
    }
    if (status.isSymbolicLink()) {
      throw new Error(`${label} must not traverse a symbolic link: ${cursor}`);
    }
    if (!status.isDirectory()) {
      throw new Error(`${label} must contain only real directories: ${cursor}`);
    }
  }
  chmodSync(absolutePath, PRIVATE_DIRECTORY_MODE);
}

function requirePrivateDirectoryIfPresent(path: string, label: string): boolean {
  const absolutePath = resolve(path);
  const filesystemRoot = parse(absolutePath).root;
  if (absolutePath === filesystemRoot) {
    throw new Error(`${label} must not be the filesystem root`);
  }

  let cursor = filesystemRoot;
  let finalStatus: Stats | undefined;
  const components = relative(filesystemRoot, absolutePath).split(sep).filter(Boolean);
  for (const component of components) {
    cursor = resolve(cursor, component);
    try {
      finalStatus = lstatSync(cursor);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (finalStatus.isSymbolicLink()) {
      throw new Error(`${label} must not traverse a symbolic link: ${cursor}`);
    }
    if (!finalStatus.isDirectory()) {
      throw new Error(`${label} must contain only real directories: ${cursor}`);
    }
  }

  if (finalStatus === undefined) return false;
  if ((finalStatus.mode & 0o077) !== 0) {
    throw new Error(`${label} must be private`);
  }
  if (typeof process.geteuid === "function" && finalStatus.uid !== process.geteuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  return true;
}

function requireRegularFileIfPresent(path: string, label: string): boolean {
  const lexicalPath = resolve(path);
  let status: Stats;
  try {
    status = lstatSync(lexicalPath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (status.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!status.isFile()) throw new Error(`${label} must be a regular file`);
  if (realpathSync(lexicalPath) !== lexicalPath) {
    throw new Error(`${label} must not traverse a symbolic link`);
  }
  return true;
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function validateSource(source: string, label: string): boolean {
  if (!requireRegularFileIfPresent(source, label)) return false;
  let bytes = lstatSync(source).size;
  for (const suffix of SQLITE_COMPANION_SUFFIXES) {
    const companion = `${source}${suffix}`;
    if (requireRegularFileIfPresent(companion, `${label}${suffix}`)) {
      const companionBytes = lstatSync(companion).size;
      if (
        !Number.isSafeInteger(companionBytes)
        || companionBytes < 0
        || companionBytes > MAX_SQLITE_IMPORT_BYTES - bytes
      ) {
        throw new Error(`${label} exceeds the SQLite import byte limit of ${MAX_SQLITE_IMPORT_BYTES}`);
      }
      bytes += companionBytes;
    }
  }
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_SQLITE_IMPORT_BYTES) {
    throw new Error(`${label} exceeds the SQLite import byte limit of ${MAX_SQLITE_IMPORT_BYTES}`);
  }
  return true;
}

function captureSourceFileIdentities(
  source: string,
  label: string,
): readonly SourceFileIdentity[] | undefined {
  if (!validateSource(source, label)) return undefined;
  const paths = [
    source,
    ...SQLITE_COMPANION_SUFFIXES
      .filter((suffix) => suffix !== "-shm")
      .map((suffix) => `${source}${suffix}`)
      .filter((path) => requireRegularFileIfPresent(path, `${label} committed companion`)),
  ];
  return paths.map((path) => {
    const status = lstatSync(path);
    return {
      path,
      dev: status.dev,
      ino: status.ino,
      size: status.size,
      mtimeMs: status.mtimeMs,
      ctimeMs: status.ctimeMs,
    };
  });
}

function assertSourceFileIdentities(
  identities: readonly SourceFileIdentity[],
  label: string,
): void {
  for (const expected of identities) {
    if (!requireRegularFileIfPresent(expected.path, label)) {
      throw new Error(`${label} disappeared during import`);
    }
    const status = lstatSync(expected.path);
    if (
      status.dev !== expected.dev
      || status.ino !== expected.ino
      || status.size !== expected.size
      || status.mtimeMs !== expected.mtimeMs
      || status.ctimeMs !== expected.ctimeMs
    ) {
      throw new Error(`${label} changed during import: ${expected.path}`);
    }
  }
}
function validateTarget(migration: DatabaseMigration): boolean {
  const targetPresent = requireRegularFileIfPresent(
    migration.target,
    `${migration.label} target`,
  );
  let companionPresent = false;
  for (const suffix of SQLITE_COMPANION_SUFFIXES) {
    const companion = `${migration.target}${suffix}`;
    if (requireRegularFileIfPresent(companion, `${migration.label} target${suffix}`)) {
      companionPresent = true;
      chmodSync(companion, PRIVATE_FILE_MODE);
    }
  }
  if (!targetPresent && companionPresent) {
    throw new Error(`${migration.label} target has a companion without its database`);
  }
  if (targetPresent) chmodSync(migration.target, PRIVATE_FILE_MODE);
  return targetPresent;
}

function removeStaleDatabaseSnapshots(
  migration: DatabaseMigration,
  namespaceRoot: string,
): void {
  const prefix = `.${migration.label}.`;
  const suffixes = [".building", ".ready"] as const;
  const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const directory = opendirSync(namespaceRoot);
  const stalePaths: string[] = [];
  try {
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      const suffix = suffixes.find((candidate) => entry.name.endsWith(candidate));
      if (suffix === undefined || !entry.name.startsWith(prefix)) continue;
      const token = entry.name.slice(prefix.length, -suffix.length);
      if (!tokenPattern.test(token)) continue;
      stalePaths.push(resolve(namespaceRoot, entry.name));
    }
  } finally {
    directory.closeSync();
  }

  stalePaths.sort((left, right) => left.localeCompare(right));
  for (const path of stalePaths) {
    if (!requireRegularFileIfPresent(path, `${migration.label} stale snapshot`)) {
      continue;
    }
    unlinkSync(path);
  }
  if (stalePaths.length > 0) fsyncDirectory(namespaceRoot);
}


function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function snapshotDatabase(migration: DatabaseMigration, namespaceRoot: string): void {
  removeStaleDatabaseSnapshots(migration, namespaceRoot);
  if (validateTarget(migration)) return;
  const sourceIdentities = captureSourceFileIdentities(
    migration.source,
    `${migration.label} legacy source`,
  );
  if (sourceIdentities === undefined) return;

  const token = randomUUID();
  const buildingPath = resolve(namespaceRoot, `.${migration.label}.${token}.building`);
  const readyPath = resolve(namespaceRoot, `.${migration.label}.${token}.ready`);
  try {
    const sourceDatabase = new Database(migration.source, { readonly: true });
    try {
      assertSourceFileIdentities(sourceIdentities, `${migration.label} legacy source`);
      sourceDatabase.exec(`VACUUM INTO ${sqliteString(buildingPath)}`);
      assertSourceFileIdentities(sourceIdentities, `${migration.label} legacy source`);
    } finally {
      sourceDatabase.close();
    }

    if (!requireRegularFileIfPresent(buildingPath, `${migration.label} temporary snapshot`)) {
      throw new Error(`${migration.label} snapshot did not create a database`);
    }
    chmodSync(buildingPath, PRIVATE_FILE_MODE);
    fsyncFile(buildingPath);
    renameSync(buildingPath, readyPath);
    fsyncDirectory(namespaceRoot);

    try {
      linkSync(readyPath, migration.target);
    } catch (error) {
      if (!isAlreadyPresent(error)) throw error;
      if (!validateTarget(migration)) {
        throw new Error(`${migration.label} target disappeared during import`);
      }
      return;
    }
    fsyncDirectory(namespaceRoot);
    unlinkSync(readyPath);
    fsyncDirectory(namespaceRoot);
  } finally {
    unlinkIfPresent(buildingPath);
    unlinkIfPresent(readyPath);
  }
}
function receiptContents(
  path: string,
  label = "Artifact migration receipt",
): string {
  if (!requireRegularFileIfPresent(path, label)) return "";
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.size < 1 || status.size > RECEIPT_SIZE_LIMIT) {
      throw new Error(`${label} is invalid`);
    }
    const contents = Buffer.alloc(status.size);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = readSync(
        descriptor,
        contents,
        offset,
        contents.length - offset,
        offset,
      );
      if (bytesRead === 0) throw new Error(`${label} is incomplete`);
      offset += bytesRead;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } finally {
    closeSync(descriptor);
  }
}

function requireCanonicalDirectoryIdentity(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute canonical path`);
  }
  let status: Stats;
  try {
    status = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${path}`, { cause: error });
  }
  if (status.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!status.isDirectory()) throw new Error(`${label} must be a real directory`);
  if (realpathSync(path) !== path) {
    throw new Error(`${label} must not traverse a symbolic link`);
  }
  return path;
}

function productionCheckoutReceiptContents(
  identity: ProductionCheckoutIdentity,
): string {
  const checkoutRoot = requireCanonicalDirectoryIdentity(
    identity.checkoutRoot,
    "Production checkout root",
  );
  const gitDirectory = requireCanonicalDirectoryIdentity(
    identity.gitDirectory,
    "Production Git directory",
  );
  if (gitDirectory !== resolve(checkoutRoot, ".git")) {
    throw new Error("Production Git directory must belong to the primary checkout");
  }
  const checkoutStatus = lstatSync(checkoutRoot);
  const gitStatus = lstatSync(gitDirectory);
  if (
    checkoutStatus.dev !== identity.checkoutDevice
    || checkoutStatus.ino !== identity.checkoutInode
    || gitStatus.dev !== identity.gitDevice
    || gitStatus.ino !== identity.gitInode
  ) {
    throw new Error("Production checkout identity changed before storage preparation");
  }
  const contents = `${JSON.stringify({
    version: 2,
    checkoutRoot,
    gitDirectory,
    checkoutDevice: identity.checkoutDevice,
    checkoutInode: identity.checkoutInode,
    gitDevice: identity.gitDevice,
    gitInode: identity.gitInode,
  })}\n`;
  if (Buffer.byteLength(contents, "utf8") > RECEIPT_SIZE_LIMIT) {
    throw new Error("Production checkout binding receipt is too large");
  }
  return contents;
}

function validateProductionCheckoutReceipt(
  contents: string,
  identity: ProductionCheckoutIdentity,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error("Production checkout binding receipt is malformed", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Production checkout binding receipt is malformed");
  }
  const receipt = parsed as Record<string, unknown>;
  const keys = Object.keys(receipt);
  if (
    keys.length !== 7
    || keys[0] !== "version"
    || keys[1] !== "checkoutRoot"
    || keys[2] !== "gitDirectory"
    || keys[3] !== "checkoutDevice"
    || keys[4] !== "checkoutInode"
    || keys[5] !== "gitDevice"
    || keys[6] !== "gitInode"
    || receipt.version !== 2
    || typeof receipt.checkoutRoot !== "string"
    || typeof receipt.gitDirectory !== "string"
    || typeof receipt.checkoutDevice !== "number"
    || typeof receipt.checkoutInode !== "number"
    || typeof receipt.gitDevice !== "number"
    || typeof receipt.gitInode !== "number"
    || !Number.isSafeInteger(receipt.checkoutDevice)
    || !Number.isSafeInteger(receipt.checkoutInode)
    || !Number.isSafeInteger(receipt.gitDevice)
    || !Number.isSafeInteger(receipt.gitInode)
  ) {
    throw new Error("Production checkout binding receipt is malformed");
  }
  const canonicalContents = `${JSON.stringify({
    version: 2,
    checkoutRoot: receipt.checkoutRoot,
    gitDirectory: receipt.gitDirectory,
    checkoutDevice: receipt.checkoutDevice,
    checkoutInode: receipt.checkoutInode,
    gitDevice: receipt.gitDevice,
    gitInode: receipt.gitInode,
  })}\n`;
  if (contents !== canonicalContents) {
    throw new Error("Production checkout binding receipt is malformed");
  }
  if (
    receipt.checkoutRoot !== identity.checkoutRoot
    || receipt.gitDirectory !== identity.gitDirectory
    || receipt.checkoutDevice !== identity.checkoutDevice
    || receipt.checkoutInode !== identity.checkoutInode
    || receipt.gitDevice !== identity.gitDevice
    || receipt.gitInode !== identity.gitInode
  ) {
    throw new Error("Production storage is bound to a different primary checkout");
  }
}

function bindProductionCheckout(
  namespaceRoot: string,
  identity: ProductionCheckoutIdentity,
): void {
  const expectedContents = productionCheckoutReceiptContents(identity);
  const receiptPath = resolve(namespaceRoot, PRODUCTION_CHECKOUT_RECEIPT);
  const label = "Production checkout binding receipt";
  if (!requirePrivateDirectoryIfPresent(namespaceRoot, "Production storage namespace")) {
    ensurePrivateDirectory(namespaceRoot, "Production storage namespace");
  }

  const existingContents = receiptContents(receiptPath, label);
  if (existingContents !== "") {
    validateProductionCheckoutReceipt(existingContents, identity);
    chmodSync(receiptPath, PRIVATE_FILE_MODE);
    fsyncFile(receiptPath);
    return;
  }

  ensurePrivateDirectory(namespaceRoot, "Production storage namespace");
  const buildingPath = resolve(
    namespaceRoot,
    `${PRODUCTION_CHECKOUT_RECEIPT}.${randomUUID()}.building`,
  );
  const descriptor = openSync(
    buildingPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    try {
      const contents = Buffer.from(expectedContents, "utf8");
      let offset = 0;
      while (offset < contents.length) {
        const bytesWritten = writeSync(
          descriptor,
          contents,
          offset,
          contents.length - offset,
          offset,
        );
        if (bytesWritten === 0) {
          throw new Error("Production checkout binding receipt could not be written");
        }
        offset += bytesWritten;
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    try {
      linkSync(buildingPath, receiptPath);
      fsyncDirectory(namespaceRoot);
    } catch (error) {
      if (!isAlreadyPresent(error)) throw error;
    }
    const publishedContents = receiptContents(receiptPath, label);
    validateProductionCheckoutReceipt(publishedContents, identity);
    chmodSync(receiptPath, PRIVATE_FILE_MODE);
    fsyncFile(receiptPath);
  } finally {
    unlinkIfPresent(buildingPath);
    fsyncDirectory(namespaceRoot);
  }
}

function artifactMigrationReceiptContents(
  priorRoot: string,
  pipelineDatabase: string,
  artifactRoot: string,
): string {
  return `${JSON.stringify({
    version: 1,
    priorRoot,
    pipelineDatabase,
    artifactRoot,
  })}\n`;
}

function createArtifactMigrationReceipt(
  configuration: LaunchConfiguration,
): LaunchArtifactMigration {
  const namespaceRoot = dirname(configuration.pipelineDatabase);
  const priorRoot = configuration.priorArtifactRoot;
  const expectedContents = artifactMigrationReceiptContents(
    priorRoot,
    configuration.pipelineDatabase,
    configuration.artifactRoot,
  );
  const contents = Buffer.from(expectedContents, "utf8");
  if (contents.length > RECEIPT_SIZE_LIMIT) {
    throw new Error("Artifact migration receipt is too large");
  }
  const receiptPath = resolve(namespaceRoot, ARTIFACT_MIGRATION_RECEIPT);
  const buildingPath = resolve(
    namespaceRoot,
    `${ARTIFACT_MIGRATION_RECEIPT}.${randomUUID()}.building`,
  );
  const descriptor = openSync(
    buildingPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    try {
      let offset = 0;
      while (offset < contents.length) {
        const bytesWritten = writeSync(
          descriptor,
          contents,
          offset,
          contents.length - offset,
          offset,
        );
        if (bytesWritten === 0) throw new Error("Artifact migration receipt could not be written");
        offset += bytesWritten;
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    try {
      linkSync(buildingPath, receiptPath);
      fsyncDirectory(namespaceRoot);
    } catch (error) {
      if (!isAlreadyPresent(error)) throw error;
    }
    if (receiptContents(receiptPath) !== expectedContents) {
      throw new Error("Artifact migration receipt changed during publication");
    }
  } finally {
    unlinkIfPresent(buildingPath);
    fsyncDirectory(namespaceRoot);
  }
  return { priorRoot, receiptPath, receiptContents: expectedContents };
}

function pendingArtifactMigration(
  configuration: LaunchConfiguration,
): LaunchArtifactMigration | undefined {
  const namespaceRoot = dirname(configuration.pipelineDatabase);
  const priorRoot = configuration.priorArtifactRoot;
  const receiptPath = resolve(namespaceRoot, ARTIFACT_MIGRATION_RECEIPT);
  const contents = receiptContents(receiptPath);
  if (contents === "") return undefined;
  const expectedContents = artifactMigrationReceiptContents(
    priorRoot,
    configuration.pipelineDatabase,
    configuration.artifactRoot,
  );
  if (contents !== expectedContents) {
    throw new Error("Artifact migration receipt does not match the managed storage paths");
  }
  return { priorRoot, receiptPath, receiptContents: expectedContents };
}

function databaseMigrations(configuration: LaunchConfiguration): readonly DatabaseMigration[] {
  return [
    {
      label: "pipeline",
      source: configuration.priorPipelineDatabase,
      target: configuration.pipelineDatabase,
    },
    {
      label: "context",
      source: configuration.priorContextDatabase,
      target: configuration.contextDatabase,
    },
    {
      label: "auth",
      source: configuration.priorAuthDatabase,
      target: configuration.authDatabase,
    },
  ];
}
export function prepareLaunchStorage(
  configuration: LaunchConfiguration,
): LaunchStoragePreparation {
  const namespaceRoot = dirname(configuration.pipelineDatabase);
  const expectedTargets = {
    pipeline: resolve(namespaceRoot, "pipeline.sqlite"),
    context: resolve(namespaceRoot, "context.sqlite"),
    auth: resolve(namespaceRoot, "auth.sqlite"),
    artifacts: resolve(namespaceRoot, "runs"),
  };
  if (
    configuration.pipelineDatabase !== expectedTargets.pipeline
    || configuration.contextDatabase !== expectedTargets.context
    || configuration.authDatabase !== expectedTargets.auth
    || configuration.artifactRoot !== expectedTargets.artifacts
  ) {
    throw new Error("Launch storage paths must share one managed namespace");
  }

  if (configuration.productionCheckout !== undefined) {
    bindProductionCheckout(namespaceRoot, configuration.productionCheckout);
  }

  ensurePrivateDirectory(namespaceRoot, "Runtime storage namespace");
  const migrations = databaseMigrations(configuration);
  for (const migration of migrations) validateTarget(migration);
  ensurePrivateDirectory(configuration.artifactRoot, "Runtime artifact root");
  fsyncDirectory(namespaceRoot);

  const pipelineMigration = migrations[0]!;
  let artifactMigration = pendingArtifactMigration(configuration);
  if (
    artifactMigration === undefined
    && !validateTarget(pipelineMigration)
    && validateSource(pipelineMigration.source, "pipeline legacy source")
  ) {
    artifactMigration = createArtifactMigrationReceipt(configuration);
  }
  for (const migration of migrations) snapshotDatabase(migration, namespaceRoot);
  if (artifactMigration !== undefined && !validateTarget(pipelineMigration)) {
    throw new Error("Pipeline import is incomplete while artifact migration is pending");
  }
  return artifactMigration === undefined ? {} : { artifactMigration };
}

export function prepareLaunchStorageForArtifactRecovery(
  configuration: LaunchConfiguration,
): void {
  const preparation = prepareLaunchStorage(configuration);
  if (preparation.artifactMigration !== undefined) {
    throw new Error(
      "Runtime artifact migration is pending; complete one stopped stable pipeline launch before recovery",
    );
  }
  const pipelineMigration = databaseMigrations(configuration)[0]!;
  if (!validateTarget(pipelineMigration)) {
    throw new Error("Managed pipeline database does not exist");
  }
  if (!requirePrivateDirectoryIfPresent(configuration.artifactRoot, "Runtime artifact root")) {
    throw new Error("Managed runtime artifact root does not exist");
  }
}

export function completeLaunchStoragePreparation(
  preparation: LaunchStoragePreparation,
): void {
  const migration = preparation.artifactMigration;
  if (migration === undefined) return;
  if (receiptContents(migration.receiptPath) !== migration.receiptContents) {
    throw new Error("Artifact migration receipt changed before completion");
  }
  unlinkSync(migration.receiptPath);
  fsyncDirectory(dirname(migration.receiptPath));
}

export async function withStoppedPipeline<T>(
  configuration: Pick<LaunchConfiguration, "pipelinePort">,
  operation: () => T | Promise<T>,
): Promise<T> {
  const reservation = createServer();
  try {
    await new Promise<void>((resolveListening, rejectListening) => {
      reservation.once("error", rejectListening);
      reservation.listen(
        configuration.pipelinePort,
        "127.0.0.1",
        resolveListening,
      );
    });
  } catch (error) {
    throw new Error(
      "The matching pipeline must be stopped before runtime storage migration",
      { cause: error },
    );
  }

  try {
    return await operation();
  } finally {
    await new Promise<void>((resolveClosed, rejectClosed) => {
      reservation.close((error) => error ? rejectClosed(error) : resolveClosed());
    });
  }
}

export async function prepareLaunchStorageForLaunch(
  configuration: LaunchConfiguration,
): Promise<LaunchStoragePreparation> {
  return withStoppedPipeline(
    configuration,
    () => prepareLaunchStorage(configuration),
  );
}
