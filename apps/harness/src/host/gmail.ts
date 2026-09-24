import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { basename, dirname, join } from "node:path";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_API_ROOT = "https://gmail.googleapis.com";
const SESSION_LIFETIME_MS = 10 * 60 * 1000;
const MAX_CLIENT_BYTES = 65_536;
const MAX_TOKEN_BYTES = 65_536;
const MAX_RETAINED_SESSIONS = 128;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;

export class GmailVerificationError extends Error {}
export class GmailNotConfigured extends GmailVerificationError {}
export class GmailAuthorizationError extends GmailVerificationError {}
export class GmailVerificationTimeout extends GmailVerificationError {}
export class GmailUnavailable extends GmailVerificationError {}

export class GmailOAuthServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

export interface GmailAuthIdentity { email: string }
export interface GmailAuthStatus {
  state: "connected" | "disconnected";
  identity?: GmailAuthIdentity;
}
export interface GmailAuthSession {
  id: string;
  state: "pending" | "succeeded" | "failed" | "expired";
  authorizationUrl?: string;
  expiresAt: Date;
}

type Fetch = (request: Request) => Promise<Response>;
export interface GmailOAuthOptions {
  clientJson: string;
  tokenJson: string;
  redirectUri: string;
  fetch?: Fetch;
  now?: () => Date;
}
interface ClientConfig {
  client_id: string;
  client_secret: string;
  auth_uri: string;
  token_uri: string;
  redirect_uris: string[];
  project_id?: string;
  auth_provider_x509_cert_url?: string;
}
interface OAuthSessionRecord extends GmailAuthSession {
  stateDigest: Buffer;
  verifier?: string;
  client?: ClientConfig;
  generation: number;
}

class Mutex {
  private tail = Promise.resolve();
  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
function digestState(value: string): Buffer {
  return createHash("sha256").update(value, "ascii").digest();
}
function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
function safeString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum &&
    !value.includes("\0") && ![...value].some((character) => character.codePointAt(0)! < 32);
}
function exactMode(mode: number, expected: number): boolean {
  return (mode & 0o777) === expected;
}

async function readPrivateJson(path: string, maximumBytes: number, missingNotConfigured = false): Promise<unknown> {
  try {
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || !exactMode(parent.mode, 0o700)) throw new Error("private directory is invalid");
    const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const details = await handle.stat();
      if (!details.isFile() || !exactMode(details.mode, 0o600) || details.size > maximumBytes) throw new Error("private file is invalid");
      const data = Buffer.alloc(details.size);
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      if (bytesRead > maximumBytes) throw new Error("private file is too large");
      return JSON.parse(data.subarray(0, bytesRead).toString("utf8"));
    } finally { await handle.close(); }
  } catch (error) {
    if (missingNotConfigured && error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GmailNotConfigured("Gmail verification is not configured");
    }
    throw error;
  }
}

function validateDesktopRedirect(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.username === "" && url.password === "" && url.search === "" && url.hash === "" && ["", "/"].includes(url.pathname);
  } catch { return false; }
}

async function readDesktopClient(path: string): Promise<ClientConfig> {
  const raw = await readPrivateJson(path, MAX_CLIENT_BYTES);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1 || !("installed" in raw)) throw new Error("OAuth client must be a Desktop client");
  const installed = (raw as { installed: unknown }).installed;
  if (!installed || typeof installed !== "object" || Array.isArray(installed)) throw new Error("OAuth client is invalid");
  const value = installed as Record<string, unknown>;
  const allowed = new Set(["auth_provider_x509_cert_url", "auth_uri", "client_id", "client_secret", "project_id", "redirect_uris", "token_uri"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("OAuth client is invalid");
  if (value.auth_uri !== "https://accounts.google.com/o/oauth2/auth" || value.token_uri !== "https://oauth2.googleapis.com/token") throw new Error("OAuth endpoint is invalid");
  if (!safeString(value.client_id, 16, 512) || !value.client_id.endsWith(".apps.googleusercontent.com") || !safeString(value.client_secret, 8, 2_048)) throw new Error("OAuth credentials are invalid");
  if (!Array.isArray(value.redirect_uris) || value.redirect_uris.length < 1 || value.redirect_uris.length > 10 || !value.redirect_uris.every(validateDesktopRedirect)) throw new Error("OAuth redirect URIs are invalid");
  for (const key of ["project_id", "auth_provider_x509_cert_url"] as const) if (value[key] !== undefined && !safeString(value[key], 1, 2_048)) throw new Error("OAuth client is invalid");
  return value as unknown as ClientConfig;
}

async function atomicWritePrivate(path: string, data: Uint8Array): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentDetails = await lstat(parent);
  if (!parentDetails.isDirectory() || !exactMode(parentDetails.mode, 0o700)) throw new Error("token directory is not private");
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || !exactMode(existing.mode, 0o600)) throw new Error("token path is not private");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  }
  const temporary = join(parent, `.${basename(path)}.${base64url(randomBytes(12))}.tmp`);
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    try {
      const existing = await lstat(path);
      if (!existing.isFile() || !exactMode(existing.mode, 0o600)) throw new Error("token path is not private");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }
    await rename(temporary, path);
    const directory = await open(parent, fsConstants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function publicSession(session: OAuthSessionRecord, includeUrl = false): GmailAuthSession {
  return {
    id: session.id,
    state: session.state,
    ...(includeUrl && session.authorizationUrl ? { authorizationUrl: session.authorizationUrl } : {}),
    expiresAt: new Date(session.expiresAt),
  };
}

export class GmailOAuthManager {
  private readonly mutex = new Mutex();
  private readonly sessions = new Map<string, OAuthSessionRecord>();
  private readonly states = new Map<string, string>();
  private identity: string | undefined;
  private generation = 0;
  private readonly fetcher: Fetch;
  private readonly clock: () => Date;

  constructor(private readonly options: GmailOAuthOptions) {
    const redirect = new URL(options.redirectUri);
    if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || redirect.port === "" || redirect.pathname !== "/oauth/gmail/callback" || redirect.search || redirect.hash || redirect.username || redirect.password) {
      throw new TypeError("redirectUri must be the fixed loopback Gmail callback");
    }
    this.fetcher = options.fetch ?? ((request) => fetch(request));
    this.clock = options.now ?? (() => new Date());
  }

  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("OAuth clock must return a valid Date");
    return new Date(value);
  }
  private expire(now: Date): void {
    for (const session of this.sessions.values()) if (session.state === "pending" && now >= session.expiresAt) {
      this.states.delete(session.stateDigest.toString("hex")); session.stateDigest = Buffer.alloc(0); session.state = "expired"; delete session.authorizationUrl; delete session.verifier; delete session.client;
    }
  }
  private cancelPending(): void {
    for (const session of this.sessions.values()) if (session.state === "pending") {
      this.states.delete(session.stateDigest.toString("hex")); session.stateDigest = Buffer.alloc(0); session.state = "failed"; delete session.authorizationUrl; delete session.verifier; delete session.client;
    }
  }

  async start(): Promise<GmailAuthSession> {
    return this.mutex.run(async () => {
      const now = this.now(); this.expire(now); this.cancelPending();
      while (this.sessions.size >= MAX_RETAINED_SESSIONS) {
        const terminal = [...this.sessions].find(([, value]) => value.state !== "pending");
        if (!terminal) break; this.sessions.delete(terminal[0]);
      }
      try {
        const client = await readDesktopClient(this.options.clientJson);
        const id = base64url(randomBytes(32));
        const state = base64url(randomBytes(32));
        const verifier = base64url(randomBytes(64));
        if (!OPAQUE.test(id) || !OPAQUE.test(state)) throw new Error("invalid random value");
        const challenge = base64url(createHash("sha256").update(verifier, "ascii").digest());
        const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authorization.search = new URLSearchParams({
          client_id: client.client_id, redirect_uri: this.options.redirectUri, response_type: "code", scope: GMAIL_READONLY_SCOPE,
          state, access_type: "offline", include_granted_scopes: "false", prompt: "consent", code_challenge: challenge, code_challenge_method: "S256",
        }).toString();
        const record: OAuthSessionRecord = { id, state: "pending", stateDigest: digestState(state), expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS), authorizationUrl: authorization.toString(), verifier, client, generation: this.generation };
        this.sessions.set(id, record); this.states.set(record.stateDigest.toString("hex"), id);
        return publicSession(record, true);
      } catch {
        throw new GmailOAuthServiceError(503, "gmail_oauth_unavailable", "Gmail connection is unavailable");
      }
    });
  }

  async getSession(id: string): Promise<GmailAuthSession> {
    return this.mutex.run(() => {
      this.expire(this.now()); const session = this.sessions.get(id);
      if (!session) throw new GmailOAuthServiceError(404, "gmail_auth_session_not_found", "Gmail authorization session not found");
      return publicSession(session);
    });
  }

  async completeCallback(input: { state: string | null; code: string | null; error: string | null }): Promise<boolean> {
    if (!input.state || !OPAQUE.test(input.state) || (input.code !== null && (input.code.length < 1 || input.code.length > 4_096 || input.code.includes("\0"))) || (input.error !== null && (input.error.length < 1 || input.error.length > 256 || input.error.includes("\0")))) return false;
    const digest = digestState(input.state);
    const claimed = await this.mutex.run(() => {
      this.expire(this.now());
      const id = this.states.get(digest.toString("hex")); this.states.delete(digest.toString("hex"));
      const session = id ? this.sessions.get(id) : undefined;
      if (!session || session.state !== "pending" || !safeEqual(session.stateDigest, digest)) return undefined;
      session.stateDigest = Buffer.alloc(0); delete session.authorizationUrl;
      const client = session.client; const verifier = session.verifier; delete session.client; delete session.verifier;
      if (input.error !== null || input.code === null || !client || !verifier) { session.state = "failed"; return undefined; }
      return { id: session.id, generation: session.generation, expiresAt: session.expiresAt, client, verifier };
    });
    if (!claimed) return false;
    let encoded: Buffer; let identity: string | undefined;
    try {
      const response = await this.fetcher(new Request(claimed.client.token_uri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: input.code!, client_id: claimed.client.client_id, client_secret: claimed.client.client_secret, redirect_uri: this.options.redirectUri, grant_type: "authorization_code", code_verifier: claimed.verifier }) }));
      if (!response.ok) throw new Error("token exchange failed");
      const token = await response.json() as Record<string, unknown>;
      const scopes = typeof token.scope === "string" ? token.scope.split(/\s+/).filter(Boolean) : token.scopes;
      if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== GMAIL_READONLY_SCOPE || !safeString(token.refresh_token, 1, 8_192)) throw new Error("invalid OAuth grant");
      const stored = { ...token, refresh_token: token.refresh_token, token_uri: claimed.client.token_uri, client_id: claimed.client.client_id, client_secret: claimed.client.client_secret, type: "authorized_user", scopes: [GMAIL_READONLY_SCOPE] };
      encoded = Buffer.from(JSON.stringify(stored)); if (encoded.length > MAX_TOKEN_BYTES) throw new Error("token too large");
      if (safeString(token.access_token, 1, 8_192)) {
        try {
          const profile = await this.fetcher(new Request(`${GMAIL_API_ROOT}/gmail/v1/users/me/profile?fields=emailAddress`, { headers: { authorization: `Bearer ${token.access_token}` } }));
          const profileJson = profile.ok ? await profile.json() as Record<string, unknown> : undefined;
          if (profileJson && typeof profileJson.emailAddress === "string" && /^[^\s@]+@[^\s@]+$/.test(profileJson.emailAddress) && profileJson.emailAddress.length <= 320) identity = profileJson.emailAddress;
        } catch { identity = undefined; }
      }
    } catch {
      await this.mutex.run(() => { const current = this.sessions.get(claimed.id); if (current?.state === "pending") current.state = "failed"; });
      return false;
    }
    return this.mutex.run(async () => {
      const current = this.sessions.get(claimed.id);
      if (!current || current.state !== "pending" || claimed.generation !== this.generation) return false;
      if (this.now() >= current.expiresAt) { current.state = "expired"; return false; }
      try { await atomicWritePrivate(this.options.tokenJson, encoded); } catch { current.state = "failed"; return false; }
      current.state = "succeeded"; this.identity = identity; return true;
    });
  }

  async status(): Promise<GmailAuthStatus> {
    return this.mutex.run(async () => {
      try { await readAuthorizedUserInfo(this.options.tokenJson); }
      catch (error) { if (error instanceof GmailVerificationError) { this.identity = undefined; return { state: "disconnected" }; } throw error; }
      return { state: "connected", ...(this.identity ? { identity: { email: this.identity } } : {}) };
    });
  }

  async disconnect(): Promise<void> {
    await this.mutex.run(async () => {
      this.generation++; this.cancelPending(); this.identity = undefined;
      try {
        const parent = await lstat(dirname(this.options.tokenJson));
        if (!parent.isDirectory() || !exactMode(parent.mode, 0o700)) throw new Error("token directory is not private");
        const target = await lstat(this.options.tokenJson);
        if (!target.isFile() && !target.isSymbolicLink()) throw new Error("token path is invalid");
        await unlink(this.options.tokenJson);
        const directory = await open(dirname(this.options.tokenJson), fsConstants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new GmailOAuthServiceError(500, "internal_error", "Request failed");
      }
    });
  }
  async shutdown(): Promise<void> { await this.mutex.run(() => { this.generation++; this.cancelPending(); }); }
}

async function readAuthorizedUserInfo(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readPrivateJson(path, MAX_TOKEN_BYTES, true);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as Record<string, unknown>).scopes) || JSON.stringify((raw as Record<string, unknown>).scopes) !== JSON.stringify([GMAIL_READONLY_SCOPE])) throw new GmailAuthorizationError("Gmail authorization is unavailable");
    return raw as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GmailVerificationError) throw error;
    throw new GmailAuthorizationError("Gmail authorization is unavailable");
  }
}

const MAX_RAW_MESSAGE_BYTES = 2_097_152;
const MAX_RESULTS = 20;
const POLL_INTERVAL_MS = 3_000;
const HTTP_TIMEOUT_MS = 10_000;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const RECIPIENT = /^[A-Za-z0-9.!#$%&'*+/=?^_\`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const VERIFICATION_TERMS = ["verify", "verification", "confirm", "confirmation", "activate", "security", "one-time", "one time", "otp", "code"];

export interface VerificationChallenge {
  messageId: string;
  receivedAt: Date;
  sender: string;
  subject: string;
  urls: string[];
  codes: string[];
}
export interface InboxMessageSummary { messageId: string; subject: string; sentAt: Date }
export interface InboxSearchResult { messages: InboxMessageSummary[]; truncated: boolean }
export interface InboxEmail { messageId: string; content: string }

export interface GmailInboxOptions {
  tokenJson?: string;
  tokenProvider?: () => Promise<string>;
  fetch?: Fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  monotonic?: () => number;
  now?: () => Date;
}
interface MimeMessage { headers: Map<string, string[]>; body: string; contentType: string }
class TransientGmailError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseHeaders(source: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  const unfolded = source.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    const values = headers.get(name) ?? [];
    values.push(value); headers.set(name, values);
  }
  return headers;
}
function parseMime(bytes: Buffer): MimeMessage {
  const source = bytes.toString("utf8");
  const match = /\r?\n\r?\n/.exec(source);
  const headerEnd = match?.index ?? source.length;
  const bodyStart = match ? headerEnd + match[0].length : source.length;
  const headers = parseHeaders(source.slice(0, headerEnd));
  return { headers, body: source.slice(bodyStart), contentType: headers.get("content-type")?.[0]?.split(";", 1)[0]?.trim().toLowerCase() ?? "text/plain" };
}
function firstHeader(message: MimeMessage, name: string): string {
  return message.headers.get(name.toLowerCase())?.[0] ?? "";
}
function decodeRaw(raw: string): MimeMessage {
  if (raw.length > Math.floor(MAX_RAW_MESSAGE_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9_-]*={0,2}$/.test(raw)) throw new GmailUnavailable("Gmail returned an invalid message");
  const decoded = Buffer.from(raw, "base64url");
  if (decoded.length > MAX_RAW_MESSAGE_BYTES) throw new GmailUnavailable("Gmail message is too large");
  return parseMime(decoded);
}
function recipientAddresses(message: MimeMessage): Set<string> {
  const addresses = new Set<string>();
  for (const header of ["to", "delivered-to", "x-original-to"])
    for (const value of message.headers.get(header) ?? [])
      for (const component of value.split(",")) {
        const angle = /<([^<>]+)>/.exec(component);
        const address = (angle?.[1] ?? component).trim().toLowerCase();
        if (RECIPIENT.test(address)) addresses.add(address);
      }
  return addresses;
}
function verificationUrls(text: string, subject: string): string[] {
  const result: string[] = []; const seen = new Set<string>();
  const expression = /https:\/\/[^\s<>"']+/gi;
  for (const match of text.matchAll(expression)) {
    const url = match[0].replace(/[.,);\]}>]+$/, "");
    let parsed: URL; try { parsed = new URL(url); } catch { continue; }
    const start = Math.max(0, (match.index ?? 0) - 100);
    const context = text.slice(start, (match.index ?? 0) + match[0].length + 20);
    const searchable = (subject + " " + context + " " + parsed.pathname + " " + parsed.search).toLowerCase();
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !VERIFICATION_TERMS.some((term) => searchable.includes(term)) || seen.has(url)) continue;
    seen.add(url); result.push(url);
  }
  return result;
}
function verificationCodes(text: string): string[] {
  const patterns = [
    /\b(?:verification|confirmation|security|one[- ]time|otp)\s+(?:code\s*)?(?:is\s*)?[:#-]?\s*([A-Z0-9]{4,10})\b/gi,
    /\bcode\s*(?:is\s*)?[:#-]\s*([A-Z0-9]{4,10})\b/gi,
  ];
  const result: string[] = []; const seen = new Set<string>();
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const code = match[1]!.toUpperCase();
    if (!/\d/.test(code) || seen.has(code)) continue;
    seen.add(code); result.push(code);
  }
  return result;
}
function gmailQuery(recipient: string, notBefore: Date): string {
  const terms = 'subject:verify subject:verification subject:confirm subject:confirmation subject:activate subject:code "verify your email" "confirm your email" "verification code" "confirmation code" "one-time code"';
  return `after:${Math.floor(notBefore.getTime() / 1000) - 1} {to:${recipient} deliveredto:${recipient}} {${terms}}`;
}

interface MimePart {
  headers: Map<string, string[]>;
  contentType: string;
  disposition: string;
  filename?: string;
  text: string;
  parts: MimePart[];
}
function headerParameter(value: string, name: string): string | undefined {
  for (const segment of value.split(";").slice(1)) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim().toLowerCase() !== name.toLowerCase()) continue;
    const parameter = segment.slice(separator + 1).trim();
    return parameter.startsWith('"') && parameter.endsWith('"') ? parameter.slice(1, -1) : parameter;
  }
  return undefined;
}
function decodeTransfer(body: string, encoding: string): string {
  if (encoding.toLowerCase() === "base64") {
    try { return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8"); } catch { return ""; }
  }
  if (encoding.toLowerCase() === "quoted-printable") {
    const joined = body.replace(/=\r?\n/g, "");
    const bytes: number[] = [];
    for (let index = 0; index < joined.length; index++) {
      if (joined[index] === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(index + 1, index + 3))) { bytes.push(Number.parseInt(joined.slice(index + 1, index + 3), 16)); index += 2; }
      else bytes.push(joined.charCodeAt(index));
    }
    return Buffer.from(bytes).toString("utf8");
  }
  return body;
}
function parseMimePart(source: string): MimePart {
  const separator = /\r?\n\r?\n/.exec(source);
  const headerEnd = separator?.index ?? source.length;
  const bodyStart = separator ? headerEnd + separator[0].length : source.length;
  const headers = parseHeaders(source.slice(0, headerEnd));
  const contentTypeHeader = headers.get("content-type")?.[0] ?? "text/plain";
  const contentType = contentTypeHeader.split(";", 1)[0]!.trim().toLowerCase();
  const dispositionHeader = headers.get("content-disposition")?.[0] ?? "";
  const disposition = dispositionHeader.split(";", 1)[0]!.trim().toLowerCase();
  const filename = headerParameter(dispositionHeader, "filename") ?? headerParameter(contentTypeHeader, "name");
  const body = source.slice(bodyStart);
  const parts: MimePart[] = [];
  const boundary = headerParameter(contentTypeHeader, "boundary");
  if (contentType.startsWith("multipart/") && boundary) {
    const marker = `--${boundary}`;
    for (const section of body.split(marker).slice(1)) {
      if (section.startsWith("--")) break;
      const cleaned = section.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      if (cleaned) parts.push(parseMimePart(cleaned));
    }
  }
  const text = parts.length ? "" : decodeTransfer(body, headers.get("content-transfer-encoding")?.[0] ?? "");
  return { headers, contentType, disposition, ...(filename ? { filename } : {}), text, parts };
}
function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? whole;
  });
}
function visibleHtml(html: string): string {
  let output = ""; let suppressedDepth = 0; let anchorHref: string | undefined; let anchorText = "";
  const tokens = html.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (!token.startsWith("<")) {
      if (!suppressedDepth) { const text = decodeEntities(token); output += text; if (anchorHref) anchorText += text; }
      continue;
    }
    const closing = /^<\s*\//.test(token); const name = /^<\s*\/?\s*([a-zA-Z0-9-]+)/.exec(token)?.[1]?.toLowerCase();
    if (!name) continue;
    if (suppressedDepth) { if (closing) suppressedDepth--; else if (!/\/\s*>$/.test(token) && !["br", "img", "input", "meta", "link", "hr"].includes(name)) suppressedDepth++; continue; }
    if (closing) {
      if (name === "a" && anchorHref) { output += `\n${anchorText.trim() || "Link"}: ${anchorHref}`; anchorHref = undefined; anchorText = ""; }
      if (["p", "div", "br", "li", "tr"].includes(name)) output += "\n";
      continue;
    }
    const hidden = ["script", "style", "template"].includes(name) || /\shidden(?:\s|=|>)/i.test(token) || /aria-hidden\s*=\s*["']?true/i.test(token) || /style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(token);
    if (hidden) { suppressedDepth = 1; continue; }
    if (name === "a") anchorHref = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(token)?.slice(1).find(Boolean);
    if (["p", "div", "br", "li", "tr"].includes(name)) output += "\n";
  }
  return output.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function walkParts(part: MimePart): MimePart[] {
  return part.parts.length ? part.parts.flatMap(walkParts) : [part];
}
function codePointSlice(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}
function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value) <= maximumBytes) return { value, truncated: false };
  let bytes = Buffer.from(value).subarray(0, maximumBytes);
  while (bytes.length && Buffer.from(bytes.toString("utf8")).compare(bytes) !== 0) bytes = bytes.subarray(0, -1);
  return { value: bytes.toString("utf8").replace(/\uFFFD$/u, ""), truncated: true };
}
function readEmailPage(messageId: string, rendered: string, offset: number): string {
  const points = Array.from(rendered);
  if (offset >= points.length) throw new GmailUnavailable("Gmail email offset is unavailable");
  const remaining = points.slice(offset).join("");
  if (Buffer.byteLength(remaining) <= 50 * 1_024) return remaining;
  const longestFooter = `[Output limited to 50 KB. Call read_email again with email_id "${messageId}" and offset ${points.length} to continue.]`;
  const budget = 50 * 1_024 - Buffer.byteLength(longestFooter) - 1;
  const page = truncateUtf8(remaining, budget).value;
  const next = offset + Array.from(page).length;
  return page + "\n" + `[Output limited to 50 KB. Call read_email again with email_id "${messageId}" and offset ${next} to continue.]`;
}


export class GmailVerificationInbox {
  private readonly fetcher: Fetch;
  private readonly tokenProvider: () => Promise<string>;
  private readonly sleeper: (milliseconds: number) => Promise<void>;
  private readonly clock: () => number;
  private readonly wallClock: () => Date;
  constructor(private readonly options: GmailInboxOptions) {
    if (!options.tokenProvider && !options.tokenJson) throw new TypeError("tokenJson is required without a token provider");
    this.fetcher = options.fetch ?? ((request) => fetch(request));
    this.tokenProvider = options.tokenProvider ?? (() => this.authorizedUserToken());
    this.sleeper = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.clock = options.monotonic ?? (() => performance.now());
    this.wallClock = options.now ?? (() => new Date());
  }
  private async authorizedUserToken(): Promise<string> {
    const info = await readAuthorizedUserInfo(this.options.tokenJson!);
    const legacyToken = typeof info.token === "string" && info.token ? info.token : null;
    const legacyExpiry = typeof info.expiry === "string" ? Date.parse(info.expiry) : Number.NaN;
    if (legacyToken !== null && (!Number.isFinite(legacyExpiry) || legacyExpiry > this.wallClock().getTime())) {
      return legacyToken;
    }
    if (!safeString(info.refresh_token, 1, 8_192) || !safeString(info.client_id, 1, 8_192) || !safeString(info.client_secret, 1, 8_192)) throw new GmailAuthorizationError("Gmail authorization is unavailable");
    try {
      const response = await this.fetcher(new Request("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ refresh_token: info.refresh_token, client_id: info.client_id, client_secret: info.client_secret, grant_type: "refresh_token" }) }));
      const value: unknown = await response.json();
      if (!response.ok || !isRecord(value) || typeof value.access_token !== "string" || !value.access_token) throw new Error("refresh failed");
      return value.access_token;
    } catch { throw new GmailAuthorizationError("Gmail authorization is unavailable"); }
  }
  private async tokenBefore(deadline: number): Promise<string> {
    const remaining = deadline - this.clock();
    if (remaining <= 0) throw new GmailVerificationTimeout("Verification email did not arrive in time");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new GmailVerificationTimeout("Verification email did not arrive in time")), Math.ceil(remaining));
      });
      const token = await Promise.race([this.tokenProvider(), timeout]);
      if (!token) throw new Error("empty token");
      return token;
    } catch (error) {
      if (error instanceof GmailVerificationError) throw error;
      throw new GmailAuthorizationError("Gmail authorization is unavailable");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  private async request(path: string, token: string, params: URLSearchParams, deadline: number): Promise<Response> {
    const remaining = deadline - this.clock();
    if (remaining <= 0) throw new GmailVerificationTimeout("Verification email did not arrive in time");
    const url = new URL(path, GMAIL_API_ROOT); url.search = params.toString();
    try {
      return await this.fetcher(new Request(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(Math.max(1, Math.min(HTTP_TIMEOUT_MS, Math.ceil(remaining)))),
      }));
    } catch { throw new TransientGmailError(); }
  }
  private checkStatus(response: Response): void {
    if (response.status === 401 || response.status === 403) throw new GmailAuthorizationError("Gmail authorization is unavailable");
    if (response.status === 429 || response.status >= 500) throw new TransientGmailError();
    if (!response.ok) throw new GmailUnavailable("Gmail is unavailable");
  }
  private async messageIds(response: Response): Promise<string[]> {
    let value: unknown; try { value = await response.json(); } catch { throw new GmailUnavailable("Gmail returned an invalid response"); }
    if (!isRecord(value)) throw new GmailUnavailable("Gmail returned an invalid response");
    const messages = value.messages ?? [];
    if (!Array.isArray(messages)) throw new GmailUnavailable("Gmail returned an invalid response");
    const ids: string[] = [];
    for (const item of messages) {
      if (!isRecord(item) || typeof item.id !== "string" || item.id.length < 1 || item.id.length > 256) throw new GmailUnavailable("Gmail returned an invalid response");
      ids.push(item.id);
    }
    return ids;
  }
  private async challenge(response: Response, recipient: string, notBefore: Date): Promise<VerificationChallenge | undefined> {
    let value: unknown; try { value = await response.json(); } catch { throw new GmailUnavailable("Gmail returned an invalid response"); }
    if (!isRecord(value) || typeof value.id !== "string" || !value.id || value.id.length > 256 || typeof value.internalDate !== "string" || !/^\d+$/.test(value.internalDate) || typeof value.raw !== "string") throw new GmailUnavailable("Gmail returned an invalid response");
    const receivedAt = new Date(Number(value.internalDate));
    if (!Number.isFinite(receivedAt.getTime())) throw new GmailUnavailable("Gmail returned an invalid response");
    if (receivedAt < notBefore) return undefined;
    decodeRaw(value.raw);
    const root = parseMimePart(Buffer.from(value.raw, "base64url").toString("utf8"));
    const envelope: MimeMessage = { headers: root.headers, body: root.text, contentType: root.contentType };
    if (!recipientAddresses(envelope).has(recipient)) return undefined;
    const subject = firstHeader(envelope, "subject").slice(0, 998);
    const sender = firstHeader(envelope, "from").slice(0, 998);
    let used = 0; const content: string[] = [];
    for (const part of walkParts(root)) {
      if (part.disposition === "attachment" || !["text/plain", "text/html"].includes(part.contentType) || used >= 102_400) continue;
      const text = part.contentType === "text/html" ? visibleHtml(part.text) : part.text;
      const selected = codePointSlice(text, 0, 102_400 - used); used += Array.from(selected).length; content.push(selected);
    }
    const body = content.join("\n");
    const urls = verificationUrls(body, subject);
    const codes = verificationCodes(subject + "\n" + body);
    if (!urls.length && !codes.length) return undefined;
    return { messageId: value.id, receivedAt, sender, subject, urls, codes };
  }
  async readEmail(emailId: string, offset = 0): Promise<InboxEmail> {
    if (typeof emailId !== "string" || !MESSAGE_ID.test(emailId)) throw new TypeError("emailId is invalid");
    if (!Number.isInteger(offset) || offset < 0 || offset >= 131_072) throw new TypeError("offset is invalid");
    const tokenDeadline = this.clock() + HTTP_TIMEOUT_MS;
    const token = await this.tokenBefore(tokenDeadline);
    const deadline = this.clock() + HTTP_TIMEOUT_MS;
    try {
      const response = await this.request(`/gmail/v1/users/me/messages/${emailId}`, token, new URLSearchParams({ format: "raw", fields: "id,internalDate,raw" }), deadline);
      if (response.status === 404) throw new GmailUnavailable("Gmail message is unavailable");
      this.checkStatus(response);
      let value: unknown; try { value = await response.json(); } catch { throw new GmailUnavailable("Gmail returned an invalid response"); }
      if (!isRecord(value) || value.id !== emailId || typeof value.internalDate !== "string" || !/^\d+$/.test(value.internalDate) || typeof value.raw !== "string") throw new GmailUnavailable("Gmail returned an invalid response");
      const received = new Date(Number(value.internalDate));
      if (!Number.isFinite(received.getTime())) throw new GmailUnavailable("Gmail returned an invalid response");
      if (value.raw.length > Math.floor(MAX_RAW_MESSAGE_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9_-]*={0,2}$/.test(value.raw)) throw new GmailUnavailable("Gmail returned an invalid message");
      const decoded = Buffer.from(value.raw, "base64url");
      if (decoded.length > MAX_RAW_MESSAGE_BYTES) throw new GmailUnavailable("Gmail message is too large");
      const root = parseMimePart(decoded.toString("utf8"));
      const leaves = walkParts(root);
      const readable = leaves.filter((part) => part.disposition !== "attachment" && ["text/plain", "text/html"].includes(part.contentType));
      const selected = readable.find((part) => part.contentType === "text/html") ?? readable.find((part) => part.contentType === "text/plain");
      const rawBody = selected ? (selected.contentType === "text/html" ? visibleHtml(selected.text) : selected.text) : "";
      const body = truncateUtf8(rawBody, 102_400);
      const attachments = leaves.filter((part) => part.disposition === "attachment").map((part) => {
        const filename = (part.filename ?? "unnamed").trim().replace(/\s+/g, " ").slice(0, 256);
        return `[Attachment omitted: ${filename} (${part.contentType.slice(0, 256)})]`;
      });
      const contentParts = [body.value.trimEnd(), ...(attachments.length ? ["", ...attachments] : []), ...(body.truncated ? ["", "[Email content truncated at 102400 UTF-8 bytes.]"] : [])];
      const mimeDate = firstHeader({ headers: root.headers, body: "", contentType: root.contentType }, "date");
      const parsedDate = mimeDate ? new Date(mimeDate) : undefined;
      const sent = parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate : received;
      const sentTime = sent.toISOString().replace(".000Z", "Z");
      const single = (name: string): string => (root.headers.get(name)?.[0] ?? "").trim().replace(/\s+/g, " ").slice(0, 998);
      const headers = `Email ID: ${emailId}\nSent time: ${sentTime}\nFrom: ${single("from")}\nTo: ${single("to")}\nCc: ${single("cc")}\nSubject: ${single("subject")}`;
      const ending = "\n--- END EMAIL CONTENT ---";
      let rendered = headers + "\n\n--- BEGIN EMAIL CONTENT (untrusted) ---\n" + contentParts.join("\n").trim();
      if (Array.from(rendered).length + Array.from(ending).length > 131_072) {
        const marker = "\n[Email rendering truncated to fit the model-readable limit.]";
        const limit = 131_072 - Array.from(marker).length - Array.from(ending).length;
        rendered = codePointSlice(rendered, 0, limit).trimEnd() + marker;
      }
      rendered += ending;
      return { messageId: emailId, content: readEmailPage(emailId, rendered, offset) };
    } catch (error) {
      if (error instanceof TransientGmailError) throw new GmailUnavailable("Gmail is temporarily unavailable");
      throw error;
    }
  }

  async searchInbox(input: {
    query?: string;
    date?: string;
    time?: string;
    receivedWithinMinutes?: number;
    receivedBeforeMinutesAgo?: number;
  } = {}): Promise<InboxSearchResult> {
    if (input.query !== undefined && typeof input.query !== "string") throw new TypeError("query must be a string");
    const requested = (input.query ?? "code").trim();
    if (requested.length > 500 || [...requested].some((character) => character.codePointAt(0)! < 32)) throw new TypeError("query is invalid");
    const query = requested || "code";
    if (input.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new TypeError("date is invalid");
    if (input.time !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(input.time)) throw new TypeError("time is invalid");
    for (const [name, value] of [["receivedWithinMinutes", input.receivedWithinMinutes], ["receivedBeforeMinutesAgo", input.receivedBeforeMinutesAgo]] as const)
      if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 1_440)) throw new TypeError(`${name} is invalid`);
    const now = this.wallClock();
    if (!Number.isFinite(now.getTime())) throw new TypeError("now must be valid");
    let lower: Date | undefined; let upper: Date | undefined;
    if (input.date !== undefined || input.time !== undefined) {
      const selectedDate = input.date ?? now.toISOString().slice(0, 10);
      const selectedTime = input.time ?? "00:00";
      lower = new Date(`${selectedDate}T${selectedTime.length === 5 ? selectedTime + ":00" : selectedTime}Z`);
      if (!Number.isFinite(lower.getTime()) || lower.toISOString().slice(0, 10) !== selectedDate) throw new TypeError("date is invalid");
      upper = new Date(Date.UTC(lower.getUTCFullYear(), lower.getUTCMonth(), lower.getUTCDate() + 1));
    }
    if (input.receivedWithinMinutes !== undefined) {
      const relative = new Date(now.getTime() - input.receivedWithinMinutes * 60_000);
      if (!lower || relative > lower) lower = relative;
    }
    if (input.receivedBeforeMinutesAgo !== undefined) {
      const relative = new Date(now.getTime() - input.receivedBeforeMinutesAgo * 60_000);
      if (!upper || relative < upper) upper = relative;
    }
    if (lower && upper && lower >= upper) return { messages: [], truncated: false };
    const tokenDeadline = this.clock() + HTTP_TIMEOUT_MS;
    const token = await this.tokenBefore(tokenDeadline);
    const deadline = this.clock() + HTTP_TIMEOUT_MS;
    const literal = query.replaceAll('"', " ").trim().split(/\s+/).filter(Boolean).join(" ") || "code";
    const queryParts = [`"${literal}"`];
    if (lower) queryParts.push(`after:${Math.floor(lower.getTime() / 1_000) - 1}`);
    if (upper) queryParts.push(`before:${Math.floor(upper.getTime() / 1_000)}`);
    try {
      const list = await this.request("/gmail/v1/users/me/messages", token, new URLSearchParams({ q: queryParts.join(" "), maxResults: "50", includeSpamTrash: "false", labelIds: "INBOX" }), deadline);
      this.checkStatus(list);
      let page: unknown; try { page = await list.json(); } catch { throw new GmailUnavailable("Gmail returned an invalid response"); }
      if (!isRecord(page)) throw new GmailUnavailable("Gmail returned an invalid response");
      const idsValue = page.messages ?? [];
      if (!Array.isArray(idsValue)) throw new GmailUnavailable("Gmail returned an invalid response");
      if (page.nextPageToken !== undefined && (typeof page.nextPageToken !== "string" || !page.nextPageToken)) throw new GmailUnavailable("Gmail returned an invalid response");
      const messages: InboxMessageSummary[] = [];
      for (const item of idsValue) {
        if (!isRecord(item) || typeof item.id !== "string" || !MESSAGE_ID.test(item.id)) throw new GmailUnavailable("Gmail returned an invalid response");
        const response = await this.request(`/gmail/v1/users/me/messages/${item.id}`, token, new URLSearchParams([["format", "metadata"], ["metadataHeaders", "Subject"], ["metadataHeaders", "Date"], ["fields", "id,internalDate,payload/headers"]]), deadline);
        if (response.status === 404) continue;
        this.checkStatus(response);
        let value: unknown; try { value = await response.json(); } catch { throw new GmailUnavailable("Gmail returned an invalid response"); }
        if (!isRecord(value) || typeof value.id !== "string" || !MESSAGE_ID.test(value.id) || typeof value.internalDate !== "string" || !/^\d+$/.test(value.internalDate) || !isRecord(value.payload) || !Array.isArray(value.payload.headers)) throw new GmailUnavailable("Gmail returned an invalid response");
        const received = new Date(Number(value.internalDate));
        if (!Number.isFinite(received.getTime())) throw new GmailUnavailable("Gmail returned an invalid response");
        if ((lower && received < lower) || (upper && received >= upper)) continue;
        const headers = new Map<string, string>();
        for (const header of value.payload.headers) if (isRecord(header) && typeof header.name === "string" && typeof header.value === "string" && !headers.has(header.name.toLowerCase())) headers.set(header.name.toLowerCase(), header.value);
        const parsedDate = headers.has("date") ? new Date(headers.get("date")!) : undefined;
        messages.push({ messageId: value.id, subject: (headers.get("subject") ?? "").slice(0, 998), sentAt: parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate : received });
      }
      messages.sort((left, right) => right.sentAt.getTime() - left.sentAt.getTime());
      return { messages, truncated: page.nextPageToken !== undefined };
    } catch (error) {
      if (error instanceof TransientGmailError) throw new GmailUnavailable("Gmail is temporarily unavailable");
      throw error;
    }
  }

  async waitForChallenge(input: { recipient: string; notBefore: Date; timeoutSeconds: number }): Promise<VerificationChallenge> {
    if (typeof input.recipient !== "string" || input.recipient.trim() !== input.recipient || input.recipient.length > 320 || !RECIPIENT.test(input.recipient)) throw new TypeError("recipient is invalid");
    if (!(input.notBefore instanceof Date) || !Number.isFinite(input.notBefore.getTime())) throw new TypeError("notBefore must be a valid Date");
    if (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1) throw new TypeError("timeoutSeconds must be positive");
    const recipient = input.recipient.toLowerCase(); const deadline = this.clock() + input.timeoutSeconds * 1_000;
    const token = await this.tokenBefore(deadline); const seen = new Set<string>(); let transient = false;
    while (true) {
      try {
        const list = await this.request("/gmail/v1/users/me/messages", token, new URLSearchParams({ q: gmailQuery(recipient, input.notBefore), maxResults: String(MAX_RESULTS), includeSpamTrash: "false" }), deadline);
        this.checkStatus(list);
        const candidates: VerificationChallenge[] = [];
        for (const id of await this.messageIds(list)) {
          if (seen.has(id)) continue;
          try {
            const response = await this.request(`/gmail/v1/users/me/messages/${id}`, token, new URLSearchParams({ format: "raw", fields: "id,internalDate,raw" }), deadline);
            if (response.status === 404) { seen.add(id); continue; }
            this.checkStatus(response);
            const candidate = await this.challenge(response, recipient, input.notBefore);
            seen.add(id); if (candidate) candidates.push(candidate);
          } catch (error) { if (error instanceof TransientGmailError) { transient = true; continue; } throw error; }
        }
        if (candidates.length) return candidates.reduce((newest, item) => item.receivedAt > newest.receivedAt ? item : newest);
      } catch (error) { if (error instanceof TransientGmailError) transient = true; else throw error; }
      const remaining = deadline - this.clock();
      if (remaining <= 0) throw transient ? new GmailUnavailable("Gmail is temporarily unavailable") : new GmailVerificationTimeout("Verification email did not arrive in time");
      await this.sleeper(Math.min(POLL_INTERVAL_MS, remaining));
      if (this.clock() >= deadline) throw transient ? new GmailUnavailable("Gmail is temporarily unavailable") : new GmailVerificationTimeout("Verification email did not arrive in time");
    }
  }
}

