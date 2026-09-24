import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import { HarnessServiceError } from "../host/artifacts.ts";
export { HarnessServiceError } from "../host/artifacts.ts";

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_CREDENTIAL_ENTRIES = 1_000;
const EMPTY_DOCUMENT = Buffer.from('{"version":1,"credentials":[]}');
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

export class BrowserConfigurationError extends Error {
  override name = "BrowserConfigurationError";
}

export interface SavedCredential {
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  readonly savedAt: string;
}

interface StoredCredential {
  origin: string;
  username: string;
  password: string;
  saved_at: string;
}

interface CredentialDocument {
  version: 1;
  credentials: StoredCredential[];
}

export interface CredentialStoreOptions {
  clock?: () => Date;
}

class Mutex {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class CredentialStore {
  private readonly mutex = new Mutex();
  private readonly clock: () => Date;

  private constructor(private readonly path: string, options: CredentialStoreOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  static async open(path: string, options: CredentialStoreOptions = {}): Promise<CredentialStore> {
    const store = new CredentialStore(path, options);
    try {
      await preparePrivateDirectory(dirname(path), true, true);
      await rejectSymlink(path);
      try {
        await lstat(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
        await createEmptyStore(path);
      }
      await store.readDocument();
      return store;
    } catch (error) {
      throw new BrowserConfigurationError("The credential store is invalid or unavailable");
    }
  }

  async credentialsForOrigin(origin: string): Promise<readonly SavedCredential[]> {
    try {
      const canonical = canonicalOrigin(origin);
      const document = await this.readDocument();
      return document.credentials
        .filter((credential) => credential.origin === canonical)
        .sort((left, right) => Date.parse(right.saved_at) - Date.parse(left.saved_at))
        .map((credential) => Object.freeze({
          origin: credential.origin,
          username: credential.username,
          password: credential.password,
          savedAt: credential.saved_at,
        }));
    } catch (error) {
      if (error instanceof HarnessServiceError) throw error;
      throw internalError();
    }
  }

  async upsert(origin: string, username: string, password: string): Promise<void> {
    let stored: StoredCredential;
    try {
      stored = validateCredential({
        origin: canonicalOrigin(origin),
        username,
        password,
        saved_at: timestamp(this.clock()),
      }, false);
    } catch {
      throw conflictError();
    }

    await this.mutex.run(async () => {
      try {
        const current = await this.readDocument();
        const remaining = current.credentials.filter(
          (credential) => credential.origin !== stored.origin || credential.username !== stored.username,
        );
        if (remaining.length >= MAX_CREDENTIAL_ENTRIES) throw conflictError();
        const candidate: CredentialDocument = {
          version: 1,
          credentials: [stored, ...remaining].sort(
            (left, right) => Date.parse(right.saved_at) - Date.parse(left.saved_at),
          ),
        };
        const encoded = encodeDocument(candidate);
        await replacePrivateFile(this.path, encoded, true);
      } catch (error) {
        if (error instanceof HarnessServiceError) throw error;
        throw internalError();
      }
    });
  }

  private async readDocument(): Promise<CredentialDocument> {
    const handle = await openPrivateFile(this.path, true);
    let encoded: Buffer;
    try {
      const stat = await handle.stat();
      if (stat.size > MAX_DOCUMENT_BYTES) throw new Error("document too large");
      encoded = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < encoded.length) {
        const { bytesRead } = await handle.read(encoded, offset, encoded.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== encoded.length) encoded = encoded.subarray(0, offset);
    } finally {
      await handle.close();
    }
    const raw = parseStrictJson(decodeUtf8(encoded));
    return validateDocument(raw);
  }
}

function conflictError(): HarnessServiceError {
  return new HarnessServiceError(409, "command_conflict", "Credentials were not accepted");
}

function internalError(): HarnessServiceError {
  return new HarnessServiceError(500, "internal_error", "Request failed");
}

function countCharacters(value: string): number {
  return Array.from(value).length;
}

function isScalarText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalOrigin(value: string): string {
  if (typeof value !== "string") throw new TypeError("origin");
  const url = new URL(value);
  if (!url.hostname || url.hostname.includes("*") || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("invalid origin");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const loopback = hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("invalid origin");
  url.hostname = url.hostname.replace(/\.$/, "");
  return url.origin;
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("invalid clock");
  return value.toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TIMESTAMP.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const milliseconds = Number(fraction.padEnd(3, "0").slice(0, 3));
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milliseconds));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() + 1 === Number(month)
    && date.getUTCDate() === Number(day)
    && date.getUTCHours() === Number(hour)
    && date.getUTCMinutes() === Number(minute)
    && date.getUTCSeconds() === Number(second);
}

function validateCredential(raw: unknown, requireCanonical: boolean): StoredCredential {
  if (!isRecord(raw) || !hasExactKeys(raw, ["origin", "username", "password", "saved_at"])) throw new Error("invalid credential");
  if (typeof raw.origin !== "string") throw new Error("invalid origin");
  const canonical = canonicalOrigin(raw.origin);
  if (requireCanonical && canonical !== raw.origin) throw new Error("noncanonical origin");
  if (typeof raw.username !== "string" || raw.username !== raw.username.trim() || countCharacters(raw.username) < 1 || countCharacters(raw.username) > 320 || raw.username.includes("\0") || !isScalarText(raw.username)) throw new Error("invalid username");
  if (typeof raw.password !== "string" || countCharacters(raw.password) < 1 || countCharacters(raw.password) > 4096 || raw.password.includes("\0") || !isScalarText(raw.password)) throw new Error("invalid password");
  if (!validTimestamp(raw.saved_at)) throw new Error("invalid timestamp");
  return { origin: canonical, username: raw.username, password: raw.password, saved_at: raw.saved_at };
}

function validateDocument(raw: unknown): CredentialDocument {
  if (!isRecord(raw) || !hasExactKeys(raw, ["version", "credentials"]) || raw.version !== 1 || !Array.isArray(raw.credentials) || raw.credentials.length > MAX_CREDENTIAL_ENTRIES) throw new Error("invalid document");
  const credentials = raw.credentials.map((credential) => validateCredential(credential, true));
  const identities = new Set(credentials.map((credential) => `${credential.origin}\0${credential.username}`));
  if (identities.size !== credentials.length) throw new Error("duplicate credentials");
  return { version: 1, credentials };
}

function encodeDocument(document: CredentialDocument): Buffer {
  const encoded = Buffer.from(JSON.stringify(document));
  if (encoded.byteLength > MAX_DOCUMENT_BYTES) throw new Error("document too large");
  return encoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

export function decodeUtf8(encoded: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(encoded);
}

export function parseStrictJson(text: string): unknown {
  const parser = new StrictJsonParser(text);
  return parser.parse();
}

class StrictJsonParser {
  private position = 0;
  constructor(private readonly text: string) {}

  parse(): unknown {
    const value = this.value();
    this.space();
    if (this.position !== this.text.length) throw new Error("invalid JSON");
    return value;
  }

  private value(): unknown {
    this.space();
    const character = this.text[this.position];
    if (character === "{") return this.object();
    if (character === "[") return this.array();
    if (character === '"') return this.string();
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (this.text.startsWith(literal, this.position)) { this.position += literal.length; return value; }
    }
    const match = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    match.lastIndex = this.position;
    const found = match.exec(this.text);
    if (!found || /[.eE]/.test(found[0])) throw new Error("invalid JSON integer");
    this.position = match.lastIndex;
    const number = Number(found[0]);
    if (!Number.isFinite(number)) throw new Error("invalid JSON number");
    return number;
  }

  private object(): Record<string, unknown> {
    this.position += 1;
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.space();
    if (this.text[this.position] === "}") { this.position += 1; return result; }
    while (true) {
      this.space();
      if (this.text[this.position] !== '"') throw new Error("invalid JSON object");
      const key = this.string();
      if (keys.has(key)) throw new Error("duplicate JSON key");
      keys.add(key);
      this.space();
      if (this.text[this.position] !== ":") throw new Error("invalid JSON object");
      this.position += 1;
      result[key] = this.value();
      this.space();
      const separator = this.text[this.position++];
      if (separator === "}") return result;
      if (separator !== ",") throw new Error("invalid JSON object");
    }
  }

  private array(): unknown[] {
    this.position += 1;
    const result: unknown[] = [];
    this.space();
    if (this.text[this.position] === "]") { this.position += 1; return result; }
    while (true) {
      result.push(this.value());
      this.space();
      const separator = this.text[this.position++];
      if (separator === "]") return result;
      if (separator !== ",") throw new Error("invalid JSON array");
    }
  }

  private string(): string {
    const start = this.position;
    this.position += 1;
    let escaped = false;
    while (this.position < this.text.length) {
      const character = this.text[this.position++];
      if (character === undefined) break;
      if (!escaped && character === '"') {
        const value = JSON.parse(this.text.slice(start, this.position)) as string;
        if (!isScalarText(value)) throw new Error("invalid Unicode scalar");
        return value;
      }
      if (!escaped && character.charCodeAt(0) < 0x20) throw new Error("invalid JSON string");
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
    }
    throw new Error("unterminated JSON string");
  }

  private space(): void {
    while ([" ", "\t", "\n", "\r"].includes(this.text[this.position] ?? "")) this.position += 1;
  }
}

export async function preparePrivateDirectory(path: string, create: boolean, exactMode: boolean): Promise<void> {
  if (path.split(/[\\/]/).includes("..")) throw new Error("parent traversal");
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe directory");
    } catch (error) {
      if (!isMissing(error) || !create) throw error;
      await mkdir(current, { mode: 0o700 });
      await chmod(current, 0o700);
    }
  }
  const mode = (await lstat(absolute)).mode & 0o777;
  if ((exactMode && mode !== 0o700) || (!exactMode && (mode & 0o022) !== 0)) throw new Error("unsafe directory mode");
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("symbolic link");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function createEmptyStore(path: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(), 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(EMPTY_DOCUMENT);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

async function openPrivateFile(path: string, exactMode: boolean) {
  const lexical = await lstat(path);
  const lexicalMode = lexical.mode & 0o777;
  if (!lexical.isFile() || (exactMode && lexicalMode !== 0o600)) throw new Error("unsafe file");
  const handle = await open(path, constants.O_RDONLY | noFollow());
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || (exactMode && (actual.mode & 0o777) !== 0o600)) throw new Error("unsafe file");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function replacePrivateFile(path: string, encoded: Buffer, exactParentMode: boolean): Promise<void> {
  await preparePrivateDirectory(dirname(path), false, exactParentMode);
  const existing = await openPrivateFile(path, exactParentMode);
  await existing.close();
  const temporary = join(dirname(path), `.${path.split(sep).at(-1) ?? "store"}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(), 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const target = await openPrivateFile(path, exactParentMode);
    await target.close();
    await rename(temporary, path);
    renamed = true;
    await syncDirectory(dirname(path));
  } finally {
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

function noFollow(): number {
  return constants.O_NOFOLLOW ?? 0;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
