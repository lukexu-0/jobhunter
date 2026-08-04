import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth";
import type { AuthIdentity, AuthProvider, AuthSession, AuthStatusResponse } from "../contracts";
import {
  createIndeedCallbackUri,
  IndeedOAuthFlow,
  type IndeedCallbackInput,
} from "./indeed-oauth.ts";
import {
  AuthSessionError,
  AuthSessionManager,
  type AuthProviderLogin,
  type AuthSessionDependencies,
  type PublicAuthSession,
} from "./sessions";
import {
  AUTH_PROVIDERS,
  assertOAuthOnlyStorage,
  closeAuthStorage,
  getAuthStorage,
  type AuthStorageLike,
} from "./storage";

const PROVIDER_ENVIRONMENT_KEYS = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_CODEX_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_API_KEY",
  "GOOGLE_CLOUD_ACCESS_TOKEN",
  "CLOUDSDK_AUTH_ACCESS_TOKEN",
  "GCP_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_VERTEX_LOCATION",
  "GOOGLE_CLOUD_LOCATION",
  "VERTEX_LOCATION",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_VERTEX_AI",
  "VERTEX_AI_API_KEY",
  "VERTEX_API_KEY",
] as const;

export class AuthServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = "AuthServiceError";
  }
}

export function scrubProviderEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  for (const key of PROVIDER_ENVIRONMENT_KEYS) delete environment[key];
}

scrubProviderEnvironment();

function redact(value: string): string {
  if (value.includes("@")) {
    const separator = value.lastIndexOf("@");
    return separator > 0 ? `${value[0]}***${value.slice(separator)}` : "***";
  }
  return value.length <= 4 ? "***" : `***${value.slice(-4)}`;
}

function redactedIdentity(identity: { email?: string; accountId?: string } | undefined): AuthIdentity | undefined {
  if (!identity) return undefined;
  const redacted: AuthIdentity = {
    ...(identity.email ? { email: redact(identity.email) } : {}),
    ...(identity.accountId ? { accountId: redact(identity.accountId) } : {}),
  };
  return Object.keys(redacted).length > 0 ? redacted : undefined;
}

function contractSession(session: PublicAuthSession): AuthSession {
  const state: AuthSession["state"] =
    session.state === "authenticating" || session.state === "prompt" ? "pending" : session.state;
  return {
    id: session.id,
    provider: session.provider,
    state,
    ...(session.launchUrl ? { launchUrl: session.launchUrl } : {}),
    ...(session.url ? { url: session.url } : {}),
    ...(session.instructions ? { instructions: session.instructions } : {}),
    progress: [...session.progress],
    ...(session.pendingPrompt ? { prompt: { ...session.pendingPrompt } } : {}),
    ...(session.error ? { error: session.error } : {}),
    expiresAt: session.expiresAt,
  };
}

export interface IndeedOAuthLike {
  login(callbacks: OAuthLoginCallbacks): Promise<void>;
  completeCallback(input: IndeedCallbackInput): Promise<void>;
}

export interface AuthServiceDependencies extends Omit<AuthSessionDependencies, "providerLogin"> {
  readonly callbackOrigin?: string;
  readonly indeedOAuth?: IndeedOAuthLike;
  readonly providerLogin?: AuthProviderLogin;
}

export class AuthService {
  readonly #sessions: AuthSessionManager;
  readonly #indeedOAuth: IndeedOAuthLike;

  constructor(private readonly storage: AuthStorageLike, dependencies: AuthServiceDependencies = {}) {
    scrubProviderEnvironment();
    assertOAuthOnlyStorage(storage);
    this.#indeedOAuth = dependencies.indeedOAuth ?? new IndeedOAuthFlow(storage, {
      redirectUri: createIndeedCallbackUri(dependencies.callbackOrigin ?? DEFAULT_AUTH_WEB_ORIGIN),
    });
    const providerLogin: AuthProviderLogin = dependencies.providerLogin
      ?? ((provider, controller) => provider === "indeed"
        ? this.#indeedOAuth.login(controller)
        : storage.login(provider, controller));
    this.#sessions = new AuthSessionManager(storage, {
      ...(dependencies.now ? { now: dependencies.now } : {}),
      ...(dependencies.randomId ? { randomId: dependencies.randomId } : {}),
      ...(dependencies.schedule ? { schedule: dependencies.schedule } : {}),
      providerLogin,
    });
  }

  getAuthStatus(): AuthStatusResponse {
    assertOAuthOnlyStorage(this.storage);
    return {
      providers: AUTH_PROVIDERS.map((provider) => {
        const rows = this.storage.listStoredCredentials(provider);
        if (rows.length === 0) return { provider, state: "disconnected" as const };
        const identity = redactedIdentity(this.storage.getOAuthAccountIdentity(provider));
        return {
          provider,
          state: "connected" as const,
          ...(identity ? { identity } : {}),
        };
      }) as AuthStatusResponse["providers"],
    };
  }

  async startSession(provider: AuthProvider): Promise<AuthSession> {
    assertOAuthOnlyStorage(this.storage);
    if (this.storage.listStoredCredentials(provider).length !== 0) {
      throw new AuthServiceError("AUTH_ALREADY_CONNECTED", `${provider} is already connected; log out first`, 409);
    }
    return contractSession(await this.#sessions.start(provider));
  }

  getSession(id: string): AuthSession | undefined {
    try {
      return contractSession(this.#sessions.get(id));
    } catch (error) {
      if (error instanceof AuthSessionError && error.code === "SESSION_NOT_FOUND") return undefined;
      throw error;
    }
  }

  answerPrompt(id: string, value: string): AuthSession {
    return contractSession(this.#sessions.answer(id, value));
  }

  cancelSession(id: string): AuthSession | undefined {
    try {
      return contractSession(this.#sessions.cancel(id));
    } catch (error) {
      if (error instanceof AuthSessionError && error.code === "SESSION_NOT_FOUND") return undefined;
      throw error;
    }
  }

  async completeIndeedCallback(input: IndeedCallbackInput): Promise<void> {
    await this.#indeedOAuth.completeCallback(input);
  }

  async logout(provider: AuthProvider): Promise<void> {
    await this.#sessions.cancelProvider(provider);
    await this.storage.logout(provider);
    assertOAuthOnlyStorage(this.storage);
  }

  async close(): Promise<void> {
    await this.#sessions.shutdown();
  }
}

const DEFAULT_AUTH_WEB_ORIGIN = "http://127.0.0.1:3456";
let configuredAuthWebOrigin: string | undefined;

let servicePromise: Promise<AuthService> | undefined;

export function configureAuthCallbackOrigin(webOrigin: string): void {
  createIndeedCallbackUri(webOrigin);
  const lockedOrigin = servicePromise
    ? configuredAuthWebOrigin ?? DEFAULT_AUTH_WEB_ORIGIN
    : configuredAuthWebOrigin;
  if (lockedOrigin !== undefined && lockedOrigin !== webOrigin) {
    throw new Error("Authentication callback origin cannot change after authentication initialization");
  }
  configuredAuthWebOrigin = webOrigin;
}

async function defaultService(): Promise<AuthService> {
  servicePromise ??= getAuthStorage().then((storage) => new AuthService(storage, {
    callbackOrigin: configuredAuthWebOrigin ?? DEFAULT_AUTH_WEB_ORIGIN,
  }));
  return servicePromise;
}

export async function getAuthStatus(): Promise<AuthStatusResponse> {
  return (await defaultService()).getAuthStatus();
}

export async function startSession(provider: AuthProvider): Promise<AuthSession> {
  return (await defaultService()).startSession(provider);
}

export async function getSession(id: string): Promise<AuthSession | undefined> {
  return (await defaultService()).getSession(id);
}

export async function answerPrompt(id: string, value: string): Promise<AuthSession> {
  return (await defaultService()).answerPrompt(id, value);
}

export async function cancelSession(id: string): Promise<AuthSession | undefined> {
  return (await defaultService()).cancelSession(id);
}

export async function completeIndeedCallback(input: IndeedCallbackInput): Promise<void> {
  await (await defaultService()).completeIndeedCallback(input);
}

export async function logout(provider: AuthProvider): Promise<void> {
  await (await defaultService()).logout(provider);
}

export async function closeAuth(): Promise<void> {
  const current = servicePromise;
  servicePromise = undefined;
  configuredAuthWebOrigin = undefined;
  try {
    const service = current ? await current : undefined;
    await service?.close();
  } finally {
    await closeAuthStorage();
  }
}
