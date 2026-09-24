import type { OAuthCredential } from "@oh-my-pi/pi-ai";
import type {
  AuthIdentity,
  ModelAuthProvider,
  AuthProvider,
  AuthProviderStatus,
  AuthSession,
  AuthStatusResponse,
} from "../contracts";
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
  assertProviderOAuthConnected,
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

function publicIdentity(identity: AuthIdentity | undefined): AuthIdentity | undefined {
  if (!identity) return undefined;
  return {
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.accountId ? { accountId: identity.accountId } : {}),
  };
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


export type AuthProviderConnection = Omit<AuthProviderStatus, "provider">;

export interface AuthProviderHooks {
  status(): Promise<AuthProviderConnection> | AuthProviderConnection;
  login(controller: Parameters<AuthProviderLogin>[1]): Promise<void>;
  assertConnected(): Promise<void> | void;
  logout(): Promise<void>;
}

export interface ModelCredentialMirror {
  setModelCredential(
    provider: ModelAuthProvider,
    credential: OAuthCredential,
    signal: AbortSignal,
  ): Promise<void>;
  deleteModelCredential(provider: ModelAuthProvider, signal: AbortSignal): Promise<void>;
}

export interface AuthServiceDependencies extends Omit<
  AuthSessionDependencies,
  "providerLogin" | "providerAssertConnected" | "providerLogout"
> {
  readonly providerHooks?: Partial<Record<AuthProvider, AuthProviderHooks>>;
  readonly modelCredentialMirror?: ModelCredentialMirror;
}

export class AuthService {
  readonly #sessions: AuthSessionManager;
  readonly #providerHooks: Record<AuthProvider, AuthProviderHooks>;
  readonly #modelCredentialMirror: ModelCredentialMirror | undefined;

  constructor(private readonly storage: AuthStorageLike, dependencies: AuthServiceDependencies = {}) {
    scrubProviderEnvironment();
    assertOAuthOnlyStorage(storage);
    this.#modelCredentialMirror = dependencies.modelCredentialMirror;
    const storedProviderHooks = (provider: ModelAuthProvider): AuthProviderHooks => ({
      status: () => {
        const rows = storage.listStoredCredentials(provider);
        if (rows.length === 0) return { state: "disconnected" };
        const identity = storage.getOAuthAccountIdentity(provider);
        return { state: "connected", ...(identity ? { identity } : {}) };
      },
      login: (controller) => storage.login(provider, controller),
      assertConnected: () => assertProviderOAuthConnected(storage, provider),
      logout: () => storage.logout(provider),
    });
    const unavailableGmailHooks: AuthProviderHooks = {
      status: () => ({ state: "disconnected" }),
      login: async () => { throw new Error("Gmail OAuth is unavailable"); },
      assertConnected: () => { throw new Error("Gmail OAuth is unavailable"); },
      logout: async () => undefined,
    };
    this.#providerHooks = {
      "openai-codex": dependencies.providerHooks?.["openai-codex"] ?? storedProviderHooks("openai-codex"),
      "google-antigravity": dependencies.providerHooks?.["google-antigravity"] ?? storedProviderHooks("google-antigravity"),
      gmail: dependencies.providerHooks?.gmail ?? unavailableGmailHooks,
    };
    const modelCredentialMirror = dependencies.modelCredentialMirror;
    const modelProvider = (provider: AuthProvider): provider is ModelAuthProvider => provider !== "gmail";
    const cleanupProvider = async (provider: AuthProvider): Promise<void> => {
      if (!modelProvider(provider) || modelCredentialMirror === undefined) {
        await this.#providerHooks[provider].logout();
        return;
      }
      try {
        await modelCredentialMirror.deleteModelCredential(provider, AbortSignal.timeout(10_000));
      } finally {
        await this.#providerHooks[provider].logout();
      }
    };
    this.#sessions = new AuthSessionManager(storage, {
      ...(dependencies.now ? { now: dependencies.now } : {}),
      ...(dependencies.randomId ? { randomId: dependencies.randomId } : {}),
      ...(dependencies.schedule ? { schedule: dependencies.schedule } : {}),
      providerLogin: async (provider, controller) => {
        await this.#providerHooks[provider].login(controller);
        if (!modelProvider(provider) || modelCredentialMirror === undefined) return;
        await this.#providerHooks[provider].assertConnected();
        const credential = storage.getOAuthCredential(provider);
        if (credential === undefined) throw new Error("OAuth provider did not persist a credential");
        await modelCredentialMirror.setModelCredential(provider, credential, controller.signal);
      },
      providerAssertConnected: (provider) => this.#providerHooks[provider].assertConnected(),
      providerLogout: cleanupProvider,
    });
  }

  async synchronizeModelCredentials(): Promise<void> {
    if (this.#modelCredentialMirror === undefined) return;
    for (const provider of AUTH_PROVIDERS) {
      const credential = this.storage.getOAuthCredential(provider);
      const signal = AbortSignal.timeout(10_000);
      if (credential === undefined) {
        await this.#modelCredentialMirror.deleteModelCredential(provider, signal);
      } else {
        await this.#modelCredentialMirror.setModelCredential(provider, credential, signal);
      }
    }
  }

  async getAuthStatus(): Promise<AuthStatusResponse> {
    assertOAuthOnlyStorage(this.storage);
    const codex = await this.#providerHooks["openai-codex"].status();
    const codexIdentity = publicIdentity(codex.identity);
    const antigravity = await this.#providerHooks["google-antigravity"].status();
    const antigravityIdentity = publicIdentity(antigravity.identity);
    const gmail = await this.#providerHooks.gmail.status();
    const gmailIdentity = publicIdentity(gmail.identity);
    return {
      providers: [
        {
          provider: "openai-codex",
          state: codex.state,
          ...(codexIdentity ? { identity: codexIdentity } : {}),
        },
        {
          provider: "google-antigravity",
          state: antigravity.state,
          ...(antigravityIdentity ? { identity: antigravityIdentity } : {}),
        },
        {
          provider: "gmail",
          state: gmail.state,
          ...(gmailIdentity ? { identity: gmailIdentity } : {}),
        },
      ],
    };
  }

  async startSession(provider: AuthProvider): Promise<AuthSession> {
    assertOAuthOnlyStorage(this.storage);
    if ((await this.#providerHooks[provider].status()).state === "connected") {
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
    if (provider !== "gmail" && this.#modelCredentialMirror !== undefined) {
      await this.#modelCredentialMirror.deleteModelCredential(provider, AbortSignal.timeout(10_000));
    }
    await this.#providerHooks[provider].logout();
    assertOAuthOnlyStorage(this.storage);
  }

  async close(): Promise<void> {
    await this.#sessions.shutdown();
  }
}

export interface ManagedAuthService {
  getAuthStatus(): Promise<AuthStatusResponse>;
  startSession(provider: AuthProvider): Promise<AuthSession>;
  getSession(id: string): Promise<AuthSession | undefined>;
  answerPrompt(id: string, value: string): Promise<AuthSession>;
  cancelSession(id: string): Promise<AuthSession | undefined>;
  logout(provider: AuthProvider): Promise<void>;
  close(): Promise<void>;
}

export function createManagedAuthService(
  dependencies: AuthServiceDependencies = {},
): ManagedAuthService {
  let servicePromise: Promise<AuthService> | undefined;
  const service = (): Promise<AuthService> => {
    servicePromise ??= getAuthStorage().then(async (storage) => {
      const authService = new AuthService(storage, dependencies);
      try {
        await authService.synchronizeModelCredentials();
        return authService;
      } catch (error) {
        await authService.close();
        throw error;
      }
    }).catch((error: unknown) => {
      servicePromise = undefined;
      throw error;
    });
    return servicePromise;
  };

  return {
    getAuthStatus: async () => (await service()).getAuthStatus(),
    startSession: async (provider) => (await service()).startSession(provider),
    getSession: async (id) => (await service()).getSession(id),
    answerPrompt: async (id, value) => (await service()).answerPrompt(id, value),
    cancelSession: async (id) => (await service()).cancelSession(id),
    logout: async (provider) => (await service()).logout(provider),
    close: async () => {
      const current = servicePromise;
      servicePromise = undefined;
      try {
        const authService = current ? await current : undefined;
        await authService?.close();
      } finally {
        await closeAuthStorage();
      }
    },
  };
}

const defaultManagedAuth = createManagedAuthService();

export const getAuthStatus = defaultManagedAuth.getAuthStatus;
export const startSession = defaultManagedAuth.startSession;
export const getSession = defaultManagedAuth.getSession;
export const answerPrompt = defaultManagedAuth.answerPrompt;
export const cancelSession = defaultManagedAuth.cancelSession;
export const logout = defaultManagedAuth.logout;
export const closeAuth = defaultManagedAuth.close;
