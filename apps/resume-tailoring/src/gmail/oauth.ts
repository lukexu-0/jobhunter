import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AuthCredentialEntry,
  OAuthCredential,
  StoredOAuthRefreshOptions,
  StoredOAuthRefreshResult,
} from "@oh-my-pi/pi-ai";
import type { OAuthController } from "@oh-my-pi/pi-ai/oauth";
import { z } from "zod";
import type { GmailFetch } from "./client.ts";

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1_024;

const GoogleTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.literal("Bearer"),
}).passthrough();
const GoogleRefreshResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.literal("Bearer"),
}).passthrough();
const GmailProfileSchema = z.object({
  emailAddress: z.string().email(),
}).passthrough();

export class GmailOAuthError extends Error {
  constructor(readonly code: "NOT_CONFIGURED" | "NOT_CONNECTED" | "AUTHORIZATION_FAILED" | "PROVIDER_FAILED") {
    super(
      code === "NOT_CONFIGURED"
        ? "Gmail OAuth is not configured"
        : code === "NOT_CONNECTED"
          ? "Connect Gmail in Provider access"
          : code === "AUTHORIZATION_FAILED"
            ? "Gmail authorization did not complete"
            : "Google could not complete Gmail authorization",
    );
    this.name = "GmailOAuthError";
  }
}

interface GmailOAuthStorage {
  set(provider: string, credential: AuthCredentialEntry): Promise<void>;
}

interface GmailTokenStorage {
  getOAuthCredential(provider: string): OAuthCredential | undefined;
  refreshStoredOAuthCredential<T extends OAuthCredential = OAuthCredential>(
    provider: string,
    options: StoredOAuthRefreshOptions<T>,
  ): Promise<StoredOAuthRefreshResult<T>>;
}

export interface GmailOAuthDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: GmailFetch;
  readonly now?: () => number;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null
    && /^\d+$/.test(declaredLength.trim())
    && Number(declaredLength) > MAX_OAUTH_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new GmailOAuthError("PROVIDER_FAILED");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GmailOAuthError("PROVIDER_FAILED");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytesRead += item.value.byteLength;
      if (bytesRead > MAX_OAUTH_RESPONSE_BYTES) throw new GmailOAuthError("PROVIDER_FAILED");
      chunks.push(decoder.decode(item.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(""));
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof GmailOAuthError) throw error;
    throw new GmailOAuthError("PROVIDER_FAILED");
  }
}

async function requestJson(
  fetchImplementation: GmailFetch,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      ...init,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    signal?.throwIfAborted();
    throw new GmailOAuthError("PROVIDER_FAILED");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GmailOAuthError("PROVIDER_FAILED");
  }
  return readBoundedJson(response);
}

function listen(server: Server): Promise<void> {
  const listening = Promise.withResolvers<void>();
  const onError = (error: Error) => listening.reject(error);
  server.once("error", onError);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", onError);
    listening.resolve();
  });
  return listening.promise;
}

export async function loginGmailOAuth(
  storage: GmailOAuthStorage,
  controller: Pick<OAuthController, "signal" | "onAuth" | "onProgress">,
  dependencies: GmailOAuthDependencies = {},
): Promise<void> {
  const environment = dependencies.environment ?? process.env;
  const clientId = environment.JOBHUNTER_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = environment.JOBHUNTER_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new GmailOAuthError("NOT_CONFIGURED");

  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const authorizationCode = Promise.withResolvers<string>();
  let settled = false;
  let redirectUri = "";
  const server = createServer((request, response) => {
    if (!request.url || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    const callbackUrl = new URL(request.url, redirectUri);
    if (callbackUrl.pathname !== "/oauth/callback") {
      response.writeHead(404).end();
      return;
    }
    if (callbackUrl.searchParams.get("state") !== state) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Invalid authorization state. Return to Jobhunter and try again.");
      return;
    }
    const code = callbackUrl.searchParams.get("code");
    const providerError = callbackUrl.searchParams.get("error");
    if (!code || providerError) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Gmail authorization was not completed. Return to Jobhunter and try again.");
      if (!settled) {
        settled = true;
        authorizationCode.reject(new GmailOAuthError("AUTHORIZATION_FAILED"));
      }
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("<!doctype html><title>Gmail connected</title><p>Gmail is connected. You can close this tab.</p>");
    if (!settled) {
      settled = true;
      authorizationCode.resolve(code);
    }
  });
  const abort = () => {
    if (!settled) {
      settled = true;
      authorizationCode.reject(controller.signal?.reason ?? new DOMException("Aborted", "AbortError"));
    }
    void closeServer(server);
  };
  controller.signal?.throwIfAborted();
  controller.signal?.addEventListener("abort", abort, { once: true });

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
    const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_URL);
    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", GMAIL_READONLY_SCOPE);
    authorizationUrl.searchParams.set("access_type", "offline");
    authorizationUrl.searchParams.set("prompt", "consent");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", codeChallenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    if (!controller.onAuth) throw new GmailOAuthError("AUTHORIZATION_FAILED");
    controller.onAuth({
      url: authorizationUrl.toString(),
      instructions: "Sign in with Google and grant read-only Gmail access.",
    });
    controller.onProgress?.("Waiting for Google authorization");

    const code = await authorizationCode.promise;
    await closeServer(server);
    controller.signal?.throwIfAborted();
    const fetchImplementation = dependencies.fetch ?? fetch;
    const tokenBody = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
    const token = GoogleTokenResponseSchema.parse(await requestJson(
      fetchImplementation,
      GOOGLE_TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody.toString(),
      },
      controller.signal,
    ));
    const profile = GmailProfileSchema.parse(await requestJson(
      fetchImplementation,
      GMAIL_PROFILE_URL,
      { headers: { authorization: `Bearer ${token.access_token}` } },
      controller.signal,
    ));
    const now = dependencies.now ?? Date.now;
    await storage.set("gmail", {
      type: "oauth",
      access: token.access_token,
      refresh: token.refresh_token,
      expires: now() + token.expires_in * 1_000,
      accountId: profile.emailAddress,
      email: profile.emailAddress,
    });
    controller.onProgress?.("Gmail connected");
  } finally {
    controller.signal?.removeEventListener("abort", abort);
    await closeServer(server);
  }
}

function gmailCredential(credential: OAuthCredential | undefined): OAuthCredential | undefined {
  if (
    credential?.type !== "oauth"
    || typeof credential.access !== "string"
    || credential.access.length === 0
    || typeof credential.refresh !== "string"
    || credential.refresh.length === 0
    || typeof credential.expires !== "number"
    || !Number.isFinite(credential.expires)
  ) return undefined;
  return credential;
}

export async function getGmailAccessToken(
  storage: GmailTokenStorage,
  dependencies: GmailOAuthDependencies = {},
  signal?: AbortSignal,
): Promise<string> {
  const environment = dependencies.environment ?? process.env;
  const clientId = environment.JOBHUNTER_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = environment.JOBHUNTER_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new GmailOAuthError("NOT_CONFIGURED");
  const observedCredential = gmailCredential(storage.getOAuthCredential("gmail"));
  if (!observedCredential) throw new GmailOAuthError("NOT_CONNECTED");
  const fetchImplementation = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const refreshed = await storage.refreshStoredOAuthCredential("gmail", {
    observedCredential,
    credentialFromRow: gmailCredential,
    refreshSkewMs: 60_000,
    ...(signal ? { signal } : {}),
    refresh: async (credential, refreshSignal) => {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: credential.refresh,
      });
      const token = GoogleRefreshResponseSchema.parse(await requestJson(
        fetchImplementation,
        GOOGLE_TOKEN_URL,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        },
        refreshSignal,
      ));
      return {
        access: token.access_token,
        refresh: token.refresh_token ?? credential.refresh,
        expires: now() + token.expires_in * 1_000,
      };
    },
    mergeRefreshedCredential: (credential, token) => ({ ...credential, ...token, type: "oauth" }),
  });
  const credential = gmailCredential(refreshed.credential);
  if (!credential) throw new GmailOAuthError("NOT_CONNECTED");
  return credential.access;
}
