import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";

export const APPLICATION_PROFILE_MAX_BYTES = 5_242_880;
export const APPLICATION_RESUME_MAX_BYTES = 52_428_800;
export const APPLICATION_TRANSCRIPT_MAX_BYTES = 52_428_800;
export const APPLICATION_RESUME_SOURCE_MAX_BYTES = 1_310_720;
export const APPLICATION_CONTEXT_MAX_COUNT = 50;
export const APPLICATION_CONTEXT_MAX_BYTES = 5_242_880;
export const APPLICATION_CONTEXT_TOTAL_MAX_BYTES = 26_214_400;
export const APPLICATION_ANECDOTE_MAX_COUNT = 100;
export const APPLICATION_ANECDOTE_MAX_BYTES = 1_310_720;
export const APPLICATION_ANECDOTE_TOTAL_MAX_BYTES = 10_485_760;

const INVALID_REQUEST_MESSAGE = "Request is invalid";
const PENDING_CLEANUP = new Set<string>();
const DIRECT_FIELD_NAMES: Readonly<Record<string, true>> = {
  full_name: true, first_name: true, last_name: true, email: true, phone: true, street_address: true,
  city: true, region: true, postal_code: true, country: true, linkedin_url: true, portfolio_url: true,
  work_authorization: true, sponsorship_required: true, relocation: true, salary_expectation: true,
  start_date: true,
};

export class HarnessServiceError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly publicMessage: string;
  readonly sessionId: string | null;

  constructor(statusCode: number, code: string, publicMessage: string, sessionId: string | null = null) {
    super(publicMessage);
    this.name = "HarnessServiceError";
    this.statusCode = statusCode;
    this.code = code;
    this.publicMessage = publicMessage;
    this.sessionId = sessionId;
  }
}

export interface UploadLike {
  readonly name: string;
  stream(): ReadableStream<Uint8Array>;
  close?(): void | Promise<void>;
}

export interface StoredUpload { readonly path: string; readonly displayName: string }
export interface PersonalInformation {
  readonly directFields: readonly (readonly [string, string])[];
  readonly narrative: string;
}
export interface StoredCandidateArtifacts {
  readonly sessionDirectory: string;
  readonly personalUpload: StoredUpload;
  readonly resume: StoredUpload;
  readonly resumeSource: StoredUpload;
  readonly contexts: readonly StoredUpload[];
  readonly anecdotes: readonly StoredUpload[];
  readonly personal: PersonalInformation;
  readonly transcript?: StoredUpload;
}

function invalidRequest(): HarnessServiceError {
  return new HarnessServiceError(422, "invalid_request", INVALID_REQUEST_MESSAGE);
}

function canonicalSessionId(value: string): string {
  const canonical = value.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(canonical)) {
    throw new Error("invalid session id");
  }
  return canonical;
}

async function assertSafeDirectoryChain(path: string, create: boolean): Promise<string> {
  if (path.split(/[\\/]/u).includes("..")) throw new Error("artifact paths cannot contain parent traversal");
  const absolute = resolve(path);
  const parsed = parse(absolute);
  if (absolute === parsed.root) throw new Error("a filesystem root cannot be an artifact directory");
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("artifact path is not a directory");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || !create) throw error;
      await mkdir(current, { mode: 0o700 });
      await chmod(current, 0o700);
    }
  }
  return absolute;
}

function clientBasename(upload: UploadLike): string {
  if (typeof upload.name !== "string" || upload.name.length === 0) throw new Error("an upload filename is required");
  const name = upload.name.replaceAll("\\", "/").split("/").at(-1) ?? "";
  if (name === "" || name === "." || name === "..") throw new Error("an upload filename is required");
  return name;
}

function sanitizedBasename(upload: UploadLike, allowedSuffixes: readonly string[]): string {
  const original = clientBasename(upload);
  const dot = original.lastIndexOf(".");
  const suffix = dot >= 0 ? original.slice(dot).toLowerCase() : "";
  if (!allowedSuffixes.includes(suffix)) throw new Error("the upload has an invalid extension");
  const normalized = original.normalize("NFKC");
  let stem = normalized.slice(0, -suffix.length).replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/_+/gu, "_");
  stem = stem.replace(/^[._-]+|[._-]+$/gu, "") || "upload";
  const maximumStem = 200 - suffix.length;
  if (stem.length > maximumStem) {
    const digest = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12);
    stem = `${stem.slice(0, maximumStem - digest.length - 1)}-${digest}`;
  }
  return `${stem}${suffix}`;
}

async function uniqueStoredPath(directory: string, requestedName: string): Promise<{ handle: FileHandle; upload: StoredUpload }> {
  const dot = requestedName.lastIndexOf(".");
  const stem = dot >= 0 ? requestedName.slice(0, dot) : requestedName;
  const suffix = dot >= 0 ? requestedName.slice(dot) : "";
  for (let attempt = 1; ; attempt += 1) {
    const displayName = attempt === 1 ? requestedName : `${stem}-${attempt}${suffix}`;
    const path = join(directory, displayName);
    try {
      const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      return { handle, upload: Object.freeze({ path, displayName }) };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
}

async function storeUpload(
  directory: string,
  upload: UploadLike,
  allowedSuffixes: readonly string[],
  maximumBytes: number,
  decodeUtf8: boolean,
  retainText = false,
  requirePdfMagic = false,
): Promise<{ stored: StoredUpload; size: number; text?: string }> {
  const requestedName = sanitizedBasename(upload, allowedSuffixes);
  const opened = await uniqueStoredPath(directory, requestedName);
  const decoder = decodeUtf8 ? new TextDecoder("utf-8", { fatal: true }) : undefined;
  const textChunks: string[] | undefined = retainText ? [] : undefined;
  const prefix: number[] = [];
  let size = 0;
  try {
    const reader = upload.stream().getReader();
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw new Error("upload streams must yield bytes");
      size += result.value.byteLength;
      if (size > maximumBytes) throw new Error("upload exceeds its byte limit");
      if (requirePdfMagic && prefix.length < 5) prefix.push(...result.value.slice(0, 5 - prefix.length));
      if (decoder !== undefined) {
        const decoded = decoder.decode(result.value, { stream: true });
        if (textChunks !== undefined) textChunks.push(decoded);
      }
      await opened.handle.write(result.value);
    }
    if (decoder !== undefined) {
      const decoded = decoder.decode();
      if (textChunks !== undefined) textChunks.push(decoded);
    }
    if (requirePdfMagic && (size === 0 || new TextDecoder().decode(Uint8Array.from(prefix)) !== "%PDF-")) {
      throw new Error("resume is not a PDF");
    }
    await opened.handle.sync();
    await opened.handle.chmod(0o600);
  } catch (error) {
    await opened.handle.close().catch(() => undefined);
    await unlink(opened.upload.path).catch(() => undefined);
    throw error;
  }
  await opened.handle.close();
  return { stored: opened.upload, size, ...(textChunks === undefined ? {} : { text: textChunks.join("") }) };
}

function unquoteYamlScalar(source: string): string {
  const value = source.trim();
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replaceAll("''", "'");
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "string") throw new Error("front matter values must be strings");
    return parsed;
  }
  if (value === "" || /^(?:null|~|true|false|yes|no|on|off|[-+]?(?:\d[\d_]*)(?:\.\d+)?)$/iu.test(value)) {
    throw new Error("front matter values must be nonempty strings");
  }
  if (/^[!&*[{]/u.test(value)) throw new Error("unsupported YAML value");
  return value.replace(/\s+#.*$/u, "");
}

function parsePersonalInformation(markdownInput: string): PersonalInformation {
  const markdown = markdownInput.startsWith("\uFEFF") ? markdownInput.slice(1) : markdownInput;
  const lines = markdown.match(/.*(?:\r\n|\n|\r|$)/gu)?.filter((line) => line.length > 0) ?? [];
  const withoutEnding = (line: string): string => line.replace(/(?:\r\n|\n|\r)$/u, "");
  if (lines.length === 0 || withoutEnding(lines[0] ?? "") !== "---") {
    return Object.freeze({ directFields: Object.freeze([]), narrative: markdown });
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && withoutEnding(line) === "---");
  if (closingIndex < 0) throw new Error("front matter is not closed");
  const fields: Array<readonly [string, string]> = [];
  const seen = new Set<string>();
  for (const rawLine of lines.slice(1, closingIndex)) {
    const line = withoutEnding(rawLine);
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (line.trimStart().startsWith("?") || line.trimStart().startsWith("<<:")) throw new Error("invalid YAML mapping key");
    const match = /^([^:#][^:]*):(?:\s*(.*))$/u.exec(line);
    if (match === null) throw new Error("front matter must be a mapping");
    const name = (match[1] ?? "").trim();
    if (seen.has(name)) throw new Error("duplicate mapping key");
    if (DIRECT_FIELD_NAMES[name] !== true) throw new Error("front matter contains an unknown field");
    const value = unquoteYamlScalar(match[2] ?? "");
    if (value.trim() === "") throw new Error("front matter values must be nonempty strings");
    seen.add(name);
    fields.push(Object.freeze([name, value] as const));
  }
  const values = Object.fromEntries(fields);
  if (values.first_name === undefined && values.last_name === undefined && values.full_name !== undefined) {
    const parts = values.full_name.trim().split(/\s+/u, 2);
    const first = parts[0];
    if (first !== undefined) fields.push(Object.freeze(["first_name", first] as const));
    const trimmed = values.full_name.trim();
    const firstMatch = /^\S+\s+(.+)$/u.exec(trimmed);
    if (firstMatch?.[1] !== undefined) fields.push(Object.freeze(["last_name", firstMatch[1]] as const));
  }
  return Object.freeze({ directFields: Object.freeze(fields), narrative: lines.slice(closingIndex + 1).join("") });
}

export async function createSessionArtifactDirectory(root: string, sessionId: string): Promise<string> {
  await retryPendingCleanup();
  const absoluteRoot = await assertSafeDirectoryChain(root, true);
  await chmod(absoluteRoot, 0o700);
  const directory = join(absoluteRoot, canonicalSessionId(sessionId));
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
    await chmod(directory, 0o700);
    return directory;
  } catch (error) {
    if (created) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeSessionArtifacts(path: string): Promise<void> {
  if (path.replaceAll("\\", "/").split("/").includes("..")) throw new Error("artifact paths cannot contain parent traversal");
  const absolute = resolve(path);
  if (absolute === parse(absolute).root) throw new Error("refusing to remove a filesystem root");
  try {
    await assertSafeDirectoryChain(dirname(absolute), false);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  try {
    const metadata = await lstat(absolute);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("artifact path is not a directory");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  await rm(absolute, { recursive: true });
}

export async function cleanupSessionArtifacts(path: string): Promise<boolean> {
  try {
    await removeSessionArtifacts(path);
    PENDING_CLEANUP.delete(path);
    return true;
  } catch {
    PENDING_CLEANUP.add(path);
    return false;
  }
}

export async function retryPendingCleanup(): Promise<boolean> {
  for (const path of [...PENDING_CLEANUP]) await cleanupSessionArtifacts(path);
  return PENDING_CLEANUP.size === 0;
}

export async function cleanupOrphanedSessionArtifacts(root: string): Promise<boolean> {
  await retryPendingCleanup();
  let absolute: string;
  try { absolute = await assertSafeDirectoryChain(root, false); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return PENDING_CLEANUP.size === 0;
    throw error;
  }
  for (const entry of await readdir(absolute)) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry)) continue;
    const candidate = join(absolute, entry);
    try {
      const metadata = await lstat(candidate);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) await cleanupSessionArtifacts(candidate);
      else await unlink(candidate);
    } catch { PENDING_CLEANUP.add(candidate); }
  }
  return PENDING_CLEANUP.size === 0;
}

export async function storeUploads(
  root: string,
  sessionId: string,
  personalInformation: UploadLike,
  resume: UploadLike,
  resumeSource: UploadLike,
  contexts: readonly UploadLike[],
  anecdotes: readonly UploadLike[],
  transcript?: UploadLike,
): Promise<StoredCandidateArtifacts> {
  await retryPendingCleanup();
  const allUploads = [personalInformation, resume, resumeSource, ...contexts, ...anecdotes, ...(transcript === undefined ? [] : [transcript])];
  let sessionDirectory: string | undefined;
  try {
    if (contexts.length > APPLICATION_CONTEXT_MAX_COUNT || anecdotes.length > APPLICATION_ANECDOTE_MAX_COUNT) throw new Error("too many uploads");
    sessionDirectory = await createSessionArtifactDirectory(root, sessionId);
    const personalResult = await storeUpload(sessionDirectory, personalInformation, [".md"], APPLICATION_PROFILE_MAX_BYTES, true, true);
    const personal = parsePersonalInformation(personalResult.text ?? "");
    const storedResume = await storeUpload(sessionDirectory, resume, [".pdf"], APPLICATION_RESUME_MAX_BYTES, false, false, true);
    const storedResumeSource = await storeUpload(sessionDirectory, resumeSource, [".tex"], APPLICATION_RESUME_SOURCE_MAX_BYTES, true);
    if (storedResumeSource.size === 0) throw new Error("resume source is empty");
    const storedTranscript = transcript === undefined ? undefined : await storeUpload(sessionDirectory, transcript, [".pdf"], APPLICATION_TRANSCRIPT_MAX_BYTES, false, false, true);
    const storedContexts: StoredUpload[] = [];
    let contextTotal = 0;
    for (const value of contexts) {
      const stored = await storeUpload(sessionDirectory, value, [".md", ".txt"], Math.min(APPLICATION_CONTEXT_MAX_BYTES, APPLICATION_CONTEXT_TOTAL_MAX_BYTES - contextTotal), true);
      contextTotal += stored.size;
      storedContexts.push(stored.stored);
    }
    const storedAnecdotes: StoredUpload[] = [];
    let anecdoteTotal = 0;
    for (const value of anecdotes) {
      const stored = await storeUpload(sessionDirectory, value, [".md", ".txt"], Math.min(APPLICATION_ANECDOTE_MAX_BYTES, APPLICATION_ANECDOTE_TOTAL_MAX_BYTES - anecdoteTotal), true);
      anecdoteTotal += stored.size;
      storedAnecdotes.push(stored.stored);
    }
    return Object.freeze({
      sessionDirectory,
      personalUpload: personalResult.stored,
      resume: storedResume.stored,
      resumeSource: storedResumeSource.stored,
      contexts: Object.freeze(storedContexts),
      anecdotes: Object.freeze(storedAnecdotes),
      personal,
      ...(storedTranscript === undefined ? {} : { transcript: storedTranscript.stored }),
    });
  } catch (error) {
    if (sessionDirectory !== undefined) await cleanupSessionArtifacts(sessionDirectory);
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw invalidRequest();
  } finally {
    const seen = new Set<UploadLike>();
    for (const upload of allUploads) {
      if (seen.has(upload)) continue;
      seen.add(upload);
      await upload.close?.();
    }
  }
}
