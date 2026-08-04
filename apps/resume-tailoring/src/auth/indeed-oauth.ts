import { createHash, randomBytes } from "node:crypto";
import type {
  OAuthCredential,
  OAuthCredentials,
} from "@oh-my-pi/pi-ai";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth";
import type { AuthStorageLike } from "./storage.ts";

export const INDEED_ISSUER = "https://secure.indeed.com";
export const INDEED_RESOURCE = "https://mcp.indeed.com/claude/mcp";
export const INDEED_SCOPE = "job_seeker.jobs.search offline_access";
export const INDEED_AUTHORIZATION_ENDPOINT = "https://secure.indeed.com/oauth/v2/authorize";
export const INDEED_REGISTRATION_ENDPOINT = "https://secure.indeed.com/oauth/v2/register";
export const INDEED_TOKEN_ENDPOINT = "https://apis.indeed.com/oauth/v2/tokens";
export const INDEED_CALLBACK_PATH = "/api/pipeline/auth/indeed/callback";

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_STATES = 4;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_CLIENT_ID_LENGTH = 2_048;
const MAX_OAUTH_ERROR_LENGTH = 256;
const MAX_OAUTH_ERROR_DESCRIPTION_LENGTH = 1_024;
const MAX_OAUTH_ERROR_URI_LENGTH = 2_048;
const REFRESH_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const INDEED_BETA_NOTICE =
  "Indeed documents the official MCP beta for Claude Connector only. Direct integrations require Indeed approval under its Developer Agreement. Jobhunter identifies itself truthfully and may be rejected.";

export interface IndeedOAuthCredential extends OAuthCredential {
  readonly clientId: string;
}

export interface IndeedCallbackInput {
  readonly code?: string;
  readonly state: string;
  readonly issuer?: string;
  readonly error?: string;
  readonly errorDescription?: string;
  readonly errorUri?: string;
}

export class IndeedOAuthError extends Error {
  constructor(
    readonly code: "AUTH_CALLBACK_INVALID" | "AUTH_CALLBACK_EXPIRED" | "AUTH_PROVIDER_UNAVAILABLE" | "INDEED_AUTH_REQUIRED",
    message: string,
    readonly status: 400 | 409 | 502,
    readonly definitive = false,
  ) {
    super(message);
    this.name = "IndeedOAuthError";
  }
}

export interface IndeedOAuthDependencies {
  readonly redirectUri: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly randomToken?: () => string;
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
}

export interface IndeedAccessTokenDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface PendingState {
  readonly clientId: string;
  readonly verifier: string;
  readonly expiresAt: number;
  readonly signal?: AbortSignal;
  readonly deferred: Deferred<void>;
}

function safeError(
  code: IndeedOAuthError["code"],
  message: string,
  status: IndeedOAuthError["status"],
  definitive = false,
): IndeedOAuthError {
  return new IndeedOAuthError(code, message, status, definitive);
}

function unavailable(): IndeedOAuthError {
  return safeError("AUTH_PROVIDER_UNAVAILABLE", "Indeed authentication is unavailable", 502);
}

function invalidCallback(): IndeedOAuthError {
  return safeError("AUTH_CALLBACK_INVALID", "Indeed authentication callback is invalid", 400);
}

function rejectedCallback(definitive = false): IndeedOAuthError {
  return safeError(
    "AUTH_CALLBACK_INVALID",
    "Indeed authentication callback was rejected",
    400,
    definitive,
  );
}

function randomPkceToken(): string {
  return randomBytes(32).toString("base64url");
}
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

export function createIndeedCallbackUri(webOrigin: string): string {
  let url: URL;
  try {
    url = new URL(webOrigin);
  } catch {
    throw new Error("JOBHUNTER_WEB_ORIGIN must be an exact HTTPS or loopback HTTP origin");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    url.origin !== webOrigin
    || url.hostname.includes("*")
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(hostname)))
  ) {
    throw new Error("JOBHUNTER_WEB_ORIGIN must be an exact HTTPS or loopback HTTP origin");
  }
  return `${url.origin}${INDEED_CALLBACK_PATH}`;
}
function assertIndeedRedirectUri(redirectUri: string): void {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new Error("Indeed redirect URI is invalid");
  }
  if (
    createIndeedCallbackUri(url.origin) !== redirectUri
    || url.pathname !== INDEED_CALLBACK_PATH
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("Indeed redirect URI is invalid");
  }
}



function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
function isSafeOpaque(value: unknown, maximum: number): value is string {
  return isBoundedString(value, maximum)
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}


function isExactScope(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const requested = INDEED_SCOPE.split(" ").sort();
  const received = value.split(/\s+/).filter(Boolean).sort();
  return received.length === requested.length && received.every((scope, index) => scope === requested[index]);
}

function isExactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

async function boundedJson(response: Response): Promise<Record<string, unknown> | undefined> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    await response.body?.cancel();
    return undefined;
  }
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    byteLength += chunk.value.byteLength;
    if (byteLength > MAX_JSON_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  callerSignal: AbortSignal | undefined = signal,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason ?? error;
    throw unavailable();
  }
}

function parseRegistration(
  value: Record<string, unknown> | undefined,
  redirectUri: string,
): string | undefined {
  if (
    !value
    || !isSafeOpaque(value.client_id, MAX_CLIENT_ID_LENGTH)
    || !isExactStringArray(value.redirect_uris, [redirectUri])
    || !isExactStringArray(value.grant_types, ["authorization_code", "refresh_token"])
    || !isExactStringArray(value.response_types, ["code"])
    || value.token_endpoint_auth_method !== "none"
    || !isExactScope(value.scope)
  ) {
    return undefined;
  }
  return value.client_id;
}

interface ParsedToken {
  readonly access: string;
  readonly refresh?: string;
  readonly expires: number;
}

type TokenExchangeContext = "authorization" | "refresh";

function parseToken(
  value: Record<string, unknown> | undefined,
  now: number,
  requireRefreshToken: boolean,
): ParsedToken | undefined {
  const refresh = value?.refresh_token;
  if (
    !value
    || !isSafeOpaque(value.access_token, MAX_TOKEN_LENGTH)
    || (requireRefreshToken
      ? !isSafeOpaque(refresh, MAX_TOKEN_LENGTH)
      : refresh !== undefined && !isSafeOpaque(refresh, MAX_TOKEN_LENGTH))
    || typeof value.token_type !== "string"
    || value.token_type.toLowerCase() !== "bearer"
    || typeof value.expires_in !== "number"
    || !Number.isInteger(value.expires_in)
    || value.expires_in < 1
    || value.expires_in > 86_400
    || (value.scope !== undefined && !isExactScope(value.scope))
  ) {
    return undefined;
  }
  return {
    access: value.access_token,
    ...(typeof refresh === "string" ? { refresh } : {}),
    expires: now + value.expires_in * 1_000,
  };
}

async function registerClient(
  fetchImpl: typeof fetch,
  redirectUri: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await request(fetchImpl, INDEED_REGISTRATION_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_name: "Jobhunter",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: INDEED_SCOPE,
    }),
  }, signal);
  if (response.status !== 201) {
    await response.body?.cancel();
    throw unavailable();
  }
  const clientId = parseRegistration(await boundedJson(response), redirectUri);
  if (!clientId) throw unavailable();
  return clientId;
}

async function exchangeToken(
  fetchImpl: typeof fetch,
  form: URLSearchParams,
  now: () => number,
  context: TokenExchangeContext,
  signal?: AbortSignal,
  callerSignal: AbortSignal | undefined = signal,
): Promise<ParsedToken> {
  const response = await request(fetchImpl, INDEED_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  }, signal, callerSignal);
  const body = await boundedJson(response);
  if (response.status >= 500 || response.status === 429) throw unavailable();
  if (!response.ok) {
    const definitive = context === "refresh"
      && (response.status === 400 || response.status === 401)
      && (body?.error === "invalid_grant"
        || body?.error === "invalid_client"
        || body?.error === "unauthorized_client");
    throw rejectedCallback(definitive);
  }
  const token = parseToken(body, now(), context === "authorization");
  if (!token) throw rejectedCallback();
  return token;
}


export function parseIndeedOAuthCredential(credential: OAuthCredential): IndeedOAuthCredential | undefined {
  const clientId = (credential as OAuthCredential & { clientId?: unknown }).clientId;
  if (
    credential.type !== "oauth"
    || !isSafeOpaque(credential.access, MAX_TOKEN_LENGTH)
    || !isSafeOpaque(credential.refresh, MAX_TOKEN_LENGTH)
    || typeof credential.expires !== "number"
    || !Number.isFinite(credential.expires)
    || !isSafeOpaque(clientId, MAX_CLIENT_ID_LENGTH)
  ) {
    return undefined;
  }
  return { ...credential, clientId };
}

export class IndeedOAuthFlow {
  readonly #storage: AuthStorageLike;
  readonly #redirectUri: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #randomToken: () => string;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #pending = new Map<string, PendingState>();

  constructor(storage: AuthStorageLike, dependencies: IndeedOAuthDependencies) {
    assertIndeedRedirectUri(dependencies.redirectUri);
    this.#storage = storage;
    this.#redirectUri = dependencies.redirectUri;
    this.#fetch = dependencies.fetch ?? fetch;
    this.#now = dependencies.now ?? Date.now;
    this.#randomToken = dependencies.randomToken ?? randomPkceToken;
    this.#schedule = dependencies.schedule ?? ((callback, delay) => setTimeout(callback, delay).unref());
  }

  async login(callbacks: OAuthLoginCallbacks): Promise<void> {
    if (this.#pending.size >= MAX_PENDING_STATES) throw unavailable();
    callbacks.signal?.throwIfAborted();
    callbacks.onProgress?.(INDEED_BETA_NOTICE);
    const clientId = await registerClient(this.#fetch, this.#redirectUri, callbacks.signal);
    callbacks.signal?.throwIfAborted();
    const state = this.#randomToken();
    const verifier = this.#randomToken();
    if (!TOKEN_PATTERN.test(state) || !TOKEN_PATTERN.test(verifier) || this.#pending.has(state)) {
      throw unavailable();
    }
    const deferred = Promise.withResolvers<void>();
    const pending: PendingState = {
      clientId,
      verifier,
      expiresAt: this.#now() + STATE_TTL_MS,
      ...(callbacks.signal ? { signal: callbacks.signal } : {}),
      deferred,
    };
    this.#pending.set(state, pending);

    const abort = () => {
      if (this.#pending.get(state) !== pending) return;
      this.#pending.delete(state);
      deferred.reject(invalidCallback());
    };
    callbacks.signal?.addEventListener("abort", abort, { once: true });
    this.#schedule(() => {
      if (this.#pending.get(state) !== pending || this.#now() < pending.expiresAt) return;
      this.#pending.delete(state);
      deferred.reject(safeError(
        "AUTH_CALLBACK_EXPIRED",
        "Indeed authentication callback has expired",
        400,
      ));
    }, STATE_TTL_MS);

    const authorization = new URL(INDEED_AUTHORIZATION_ENDPOINT);
    authorization.searchParams.set("client_id", clientId);
    authorization.searchParams.set("redirect_uri", this.#redirectUri);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", INDEED_SCOPE);
    authorization.searchParams.set("state", state);
    authorization.searchParams.set(
      "code_challenge",
      createHash("sha256").update(verifier).digest("base64url"),
    );
    authorization.searchParams.set("code_challenge_method", "S256");
    authorization.searchParams.set("resource", INDEED_RESOURCE);
    callbacks.onAuth({
      url: authorization.toString(),
      instructions: INDEED_BETA_NOTICE,
    });

    try {
      await deferred.promise;
    } finally {
      callbacks.signal?.removeEventListener("abort", abort);
      if (this.#pending.get(state) === pending) this.#pending.delete(state);
    }
  }

  async completeCallback(input: IndeedCallbackInput): Promise<void> {
    const pending = this.#pending.get(input.state);
    if (!pending) throw invalidCallback();
    this.#pending.delete(input.state);

    let failure: IndeedOAuthError | undefined;
    if (this.#now() >= pending.expiresAt) {
      failure = safeError(
        "AUTH_CALLBACK_EXPIRED",
        "Indeed authentication callback has expired",
        400,
      );
    } else if (input.issuer !== INDEED_ISSUER) {
      failure = invalidCallback();
    } else if (input.error !== undefined) {
      if (
        input.code !== undefined
        || !isBoundedString(input.error, MAX_OAUTH_ERROR_LENGTH)
        || (input.errorDescription !== undefined
          && !isBoundedString(input.errorDescription, MAX_OAUTH_ERROR_DESCRIPTION_LENGTH))
        || (input.errorUri !== undefined
          && !isBoundedString(input.errorUri, MAX_OAUTH_ERROR_URI_LENGTH))
      ) {
        failure = invalidCallback();
      } else {
        failure = rejectedCallback();
      }
    } else if (
      input.errorDescription !== undefined
      || input.errorUri !== undefined
      || !isBoundedString(input.code, 8_192)
    ) {
      failure = invalidCallback();
    }
    if (failure) {
      pending.deferred.reject(failure);
      throw failure;
    }
    const code = input.code!;

    try {
      const token = await exchangeToken(this.#fetch, new URLSearchParams({
        grant_type: "authorization_code",
        client_id: pending.clientId,
        code,
        redirect_uri: this.#redirectUri,
        code_verifier: pending.verifier,
        resource: INDEED_RESOURCE,
      }), this.#now, "authorization", pending.signal);
      if (!token.refresh || pending.signal?.aborted) throw invalidCallback();
      const credential: IndeedOAuthCredential = {
        type: "oauth",
        access: token.access,
        refresh: token.refresh,
        expires: token.expires,
        clientId: pending.clientId,
      };
      await this.#storage.set("indeed", credential);
      if (pending.signal?.aborted) throw invalidCallback();
      pending.deferred.resolve(undefined);
      await Promise.resolve();
    } catch (error) {
      const safe = error instanceof IndeedOAuthError ? error : unavailable();
      pending.deferred.reject(safe);
      throw safe;
    }
  }
}

async function refreshIndeedCredential(
  credential: IndeedOAuthCredential,
  dependencies: Required<IndeedAccessTokenDependencies>,
  signal?: AbortSignal,
  callerSignal?: AbortSignal,
): Promise<OAuthCredentials> {
  const token = await exchangeToken(dependencies.fetch, new URLSearchParams({
    grant_type: "refresh_token",
    client_id: credential.clientId,
    refresh_token: credential.refresh,
    resource: INDEED_RESOURCE,
  }), dependencies.now, "refresh", signal, callerSignal);
  return {
    access: token.access,
    refresh: token.refresh ?? credential.refresh,
    expires: token.expires,
    ...(credential.accountId ? { accountId: credential.accountId } : {}),
  };
}

export async function resolveIndeedAccessToken(
  storage: AuthStorageLike,
  signal?: AbortSignal,
  dependencies: IndeedAccessTokenDependencies = {},
): Promise<string> {
  signal?.throwIfAborted();
  const observed = storage.getOAuthCredential("indeed");
  const credential = observed ? parseIndeedOAuthCredential(observed) : undefined;
  if (!credential) {
    throw safeError("INDEED_AUTH_REQUIRED", "Connect Indeed before searching jobs", 409);
  }
  const resolvedDependencies = {
    fetch: dependencies.fetch ?? fetch,
    now: dependencies.now ?? Date.now,
  };
  const result = await storage.refreshStoredOAuthCredential<IndeedOAuthCredential>("indeed", {
    observedCredential: credential,
    credentialFromRow: parseIndeedOAuthCredential,
    refreshSkewMs: REFRESH_SKEW_MS,
    ...(signal ? { signal } : {}),
    refreshTimeoutMs: REQUEST_TIMEOUT_MS,
    refresh: (current, refreshSignal) => {
      const combinedSignal = signal && refreshSignal
        ? AbortSignal.any([signal, refreshSignal])
        : signal ?? refreshSignal;
      return refreshIndeedCredential(current, resolvedDependencies, combinedSignal, signal);
    },
    mergeRefreshedCredential: (current, refreshed) => ({
      ...current,
      ...refreshed,
      type: "oauth",
      clientId: current.clientId,
    }),
    isDefinitiveFailure: (error) => error instanceof IndeedOAuthError && error.definitive,
    disabledCause: () => "Indeed OAuth refresh was rejected",
  });
  signal?.throwIfAborted();
  const current = result.credential;
  if (!current || !isSafeOpaque(current.access, MAX_TOKEN_LENGTH)) {
    throw safeError("INDEED_AUTH_REQUIRED", "Connect Indeed before searching jobs", 409);
  }
  return current.access;
}
