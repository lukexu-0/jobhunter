import type { AuthProvider, AuthSession, AuthStatusResponse } from "../contracts";
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
import { loginGmailOAuth } from "../gmail/oauth.ts";

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


export interface AuthServiceDependencies extends Omit<AuthSessionDependencies, "providerLogin"> {
  readonly providerLogin?: AuthProviderLogin;
  readonly gmailLogin?: typeof loginGmailOAuth;
}

export class AuthService {
  readonly #sessions: AuthSessionManager;

  constructor(private readonly storage: AuthStorageLike, dependencies: AuthServiceDependencies = {}) {
    scrubProviderEnvironment();
    assertOAuthOnlyStorage(storage);
    const gmailLogin = dependencies.gmailLogin ?? loginGmailOAuth;
    const providerLogin: AuthProviderLogin = dependencies.providerLogin
      ?? ((provider, controller) => provider === "gmail"
        ? gmailLogin(storage, controller)
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
        const identity = this.storage.getOAuthAccountIdentity(provider);
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


  async logout(provider: AuthProvider): Promise<void> {
    await this.#sessions.cancelProvider(provider);
    await this.storage.logout(provider);
    assertOAuthOnlyStorage(this.storage);
  }

  async close(): Promise<void> {
    await this.#sessions.shutdown();
  }
}

let servicePromise: Promise<AuthService> | undefined;


async function defaultService(): Promise<AuthService> {
  servicePromise ??= getAuthStorage().then((storage) => new AuthService(storage));
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


export async function logout(provider: AuthProvider): Promise<void> {
  await (await defaultService()).logout(provider);
}

export async function closeAuth(): Promise<void> {
  const current = servicePromise;
  servicePromise = undefined;
  try {
    const service = current ? await current : undefined;
    await service?.close();
  } finally {
    await closeAuthStorage();
  }
}
