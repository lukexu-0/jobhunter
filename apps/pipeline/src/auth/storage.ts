import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { AuthStorage, type OAuthAccess, type StoredAuthCredential } from "@oh-my-pi/pi-ai";

export const AUTH_PROVIDERS = ["openai-codex", "google-antigravity"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export class AuthConfigurationError extends Error {
  readonly code = "INVALID_AUTH_STORAGE";

  constructor(message: string) {
    super(message);
    this.name = "AuthConfigurationError";
  }
}

export interface AuthStorageLike {
  reload(): Promise<void>;
  close(): void;
  listStoredCredentials(provider?: string): StoredAuthCredential[];
  getOAuthAccountIdentity(provider: string, sessionId?: string):
    | { accountId?: string; email?: string; projectId?: string }
    | undefined;
  getOAuthAccess(
    provider: string,
    sessionId?: string,
    options?: { modelId?: string; signal?: AbortSignal; forceRefresh?: boolean },
  ): Promise<OAuthAccess | undefined>;
  login(provider: string, callbacks: {
    onAuth(info: { url: string; launchUrl?: string; instructions?: string }): void;
    onProgress?(message: string): void;
    onPrompt(prompt: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
    onManualCodeInput?(): Promise<string>;
    signal?: AbortSignal;
  }): Promise<void>;
  logout(provider: string): Promise<void>;
}

type StorageFactory = (dbPath: string) => Promise<AuthStorageLike>;

const oauthDirectory = resolve(import.meta.dir, "../../data/oauth");
export const authDatabasePath = resolve(oauthDirectory, "auth.sqlite");
let factory: StorageFactory = (path) => AuthStorage.create(path);
let storagePromise: Promise<AuthStorageLike> | undefined;

function isProvider(value: string): value is AuthProvider {
  return (AUTH_PROVIDERS as readonly string[]).includes(value);
}

function validateOAuthRow(row: StoredAuthCredential): void {
  if (!isProvider(row.provider)) {
    throw new AuthConfigurationError(`Unsupported credential provider: ${row.provider}`);
  }
  const credential = row.credential;
  if (credential.type !== "oauth") {
    throw new AuthConfigurationError(`Static credentials are forbidden for ${row.provider}`);
  }
  if (
    typeof credential.access !== "string" || credential.access.length === 0 ||
    typeof credential.refresh !== "string" || credential.refresh.length === 0 ||
    typeof credential.expires !== "number" || !Number.isFinite(credential.expires)
  ) {
    throw new AuthConfigurationError(`Malformed OAuth credential for ${row.provider}`);
  }
  if (row.provider === "openai-codex" && !credential.accountId) {
    throw new AuthConfigurationError("OpenAI Codex OAuth credential has no account identity");
  }
  if (row.provider === "google-antigravity" && !credential.projectId) {
    throw new AuthConfigurationError("Google Antigravity OAuth credential has no project ID");
  }
}

export function assertOAuthOnlyStorage(storage: AuthStorageLike): void {
  const rows = storage.listStoredCredentials();
  const counts = new Map<AuthProvider, number>();
  for (const row of rows) {
    validateOAuthRow(row);
    const provider = row.provider as AuthProvider;
    const count = (counts.get(provider) ?? 0) + 1;
    if (count > 1) {
      throw new AuthConfigurationError(`Multiple active OAuth credentials for ${provider}`);
    }
    counts.set(provider, count);
  }
}
export function assertProviderOAuthConnected(storage: AuthStorageLike, provider: AuthProvider): void {
  assertOAuthOnlyStorage(storage);
  if (storage.listStoredCredentials(provider).length !== 1) {
    throw new AuthConfigurationError(`OAuth credential was not persisted for ${provider}`);
  }
}

async function createStorage(): Promise<AuthStorageLike> {
  await mkdir(oauthDirectory, { recursive: true, mode: 0o700 });
  await chmod(oauthDirectory, 0o700);
  const storage = await factory(authDatabasePath);
  try {
    await storage.reload();
    assertOAuthOnlyStorage(storage);
    await chmod(authDatabasePath, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return storage;
  } catch (error) {
    storage.close();
    throw error;
  }
}

export function getAuthStorage(): Promise<AuthStorageLike> {
  storagePromise ??= createStorage().catch((error) => {
    storagePromise = undefined;
    throw error;
  });
  return storagePromise;
}

export async function closeAuthStorage(): Promise<void> {
  const current = storagePromise;
  storagePromise = undefined;
  if (current) (await current).close();
}

export function setAuthStorageFactoryForTests(next: StorageFactory): void {
  if (storagePromise) throw new Error("Cannot replace auth storage after initialization");
  factory = next;
}

export function resetAuthStorageFactoryForTests(): void {
  if (storagePromise) throw new Error("Cannot reset auth storage after initialization");
  factory = (path) => AuthStorage.create(path);
}
