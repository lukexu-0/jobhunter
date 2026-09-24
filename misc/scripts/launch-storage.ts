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
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { LaunchConfiguration, ProductionCheckoutIdentity } from "./launch-config.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PRODUCTION_CHECKOUT_RECEIPT = ".production-checkout";
const RECEIPT_SIZE_LIMIT = 4_096;
const SQLITE_COMPANION_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

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

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
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

function receiptContents(path: string, label: string): string {
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

export function prepareLaunchStorage(configuration: LaunchConfiguration): void {
  const namespaceRoot = dirname(configuration.pipelineDatabase);
  if (
    configuration.pipelineDatabase !== resolve(namespaceRoot, "pipeline.sqlite")
    || configuration.contextDatabase !== resolve(namespaceRoot, "context.sqlite")
    || configuration.authDatabase !== resolve(namespaceRoot, "auth.sqlite")
    || configuration.artifactRoot !== resolve(namespaceRoot, "runs")
  ) {
    throw new Error("Launch storage paths must share one managed namespace");
  }

  if (configuration.productionCheckout !== undefined) {
    bindProductionCheckout(namespaceRoot, configuration.productionCheckout);
  }
  ensurePrivateDirectory(namespaceRoot, "Runtime storage namespace");
  for (const [label, path] of [
    ["pipeline", configuration.pipelineDatabase],
    ["context", configuration.contextDatabase],
    ["auth", configuration.authDatabase],
  ] as const) {
    const present = requireRegularFileIfPresent(path, `${label} database`);
    let companionPresent = false;
    for (const suffix of SQLITE_COMPANION_SUFFIXES) {
      const companion = `${path}${suffix}`;
      if (requireRegularFileIfPresent(companion, `${label} database${suffix}`)) {
        companionPresent = true;
        chmodSync(companion, PRIVATE_FILE_MODE);
      }
    }
    if (!present && companionPresent) {
      throw new Error(`${label} database has a companion without its database`);
    }
    if (present) chmodSync(path, PRIVATE_FILE_MODE);
  }
  ensurePrivateDirectory(configuration.artifactRoot, "Runtime artifact root");
  fsyncDirectory(namespaceRoot);
}

export function prepareLaunchStorageForArtifactRecovery(
  configuration: LaunchConfiguration,
): void {
  prepareLaunchStorage(configuration);
  if (!requireRegularFileIfPresent(configuration.pipelineDatabase, "Managed pipeline database")) {
    throw new Error("Managed pipeline database does not exist");
  }
  if (!requirePrivateDirectoryIfPresent(configuration.artifactRoot, "Runtime artifact root")) {
    throw new Error("Managed runtime artifact root does not exist");
  }
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
      "The matching pipeline must be stopped before runtime storage preparation",
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
): Promise<void> {
  await withStoppedPipeline(configuration, () => prepareLaunchStorage(configuration));
}
