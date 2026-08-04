import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  AuthStorage,
  type AuthCredentialEntry,
  type OAuthAccess,
  type OAuthCredential,
  type StoredAuthCredential,
  type StoredOAuthRefreshOptions,
  type StoredOAuthRefreshResult,
} from "@oh-my-pi/pi-ai";
import type { AuthProvider } from "../contracts";

export const AUTH_PROVIDERS = ["openai-codex"] as const satisfies readonly AuthProvider[];

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
  set(provider: string, credential: AuthCredentialEntry): Promise<void>;
  listStoredCredentials(provider?: string): StoredAuthCredential[];
  getOAuthAccountIdentity(provider: string, sessionId?: string):
    | { accountId?: string; email?: string }
    | undefined;
  getOAuthCredential(provider: string): OAuthCredential | undefined;
  refreshStoredOAuthCredential<T extends OAuthCredential = OAuthCredential>(
    provider: string,
    options: StoredOAuthRefreshOptions<T>,
  ): Promise<StoredOAuthRefreshResult<T>>;
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

type StorageFactory = (dbPath: string, needsInitialization?: boolean) => Promise<AuthStorageLike>;

const AUTH_TABLE = "auth_credentials";
const CHILD_AUTH_TABLES = [
  "auth_credential_blocks",
  "auth_credential_refresh_leases",
] as const;
const AUTH_PROVIDER_PLACEHOLDERS = AUTH_PROVIDERS.map(() => "?").join(", ");
const AUTH_PROVIDER_CACHE_PREDICATE = AUTH_PROVIDERS.map(() => "key NOT LIKE ?").join(" AND ");

const STORAGE_DIRECTORY_ERROR = "OAuth storage directory must be a private regular directory";
const STORAGE_DATABASE_ERROR = "OAuth storage database must be a regular file";
const SQLITE_COMPANION_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

function directoryComponents(directory: string): string[] {
  const components: string[] = [];
  for (let current = directory; dirname(current) !== current; current = dirname(current)) {
    components.push(current);
  }
  return components.reverse();
}

async function validateDirectoryTree(directory: string, create: boolean): Promise<boolean> {
  if (dirname(directory) === directory) {
    throw new AuthConfigurationError(STORAGE_DIRECTORY_ERROR);
  }
  for (const component of directoryComponents(directory)) {
    let stats;
    try {
      stats = await lstat(component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AuthConfigurationError(STORAGE_DIRECTORY_ERROR);
      }
      if (!create) return false;
      try {
        await mkdir(component, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new AuthConfigurationError(STORAGE_DIRECTORY_ERROR);
        }
      }
      try {
        stats = await lstat(component);
      } catch {
        throw new AuthConfigurationError(STORAGE_DIRECTORY_ERROR);
      }
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new AuthConfigurationError(STORAGE_DIRECTORY_ERROR);
    }
  }
  return true;
}

async function securePrivateDirectory(directory: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(directory);
  } catch {
    throw new AuthConfigurationError(STORAGE_DIRECTORY_ERROR);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AuthConfigurationError(STORAGE_DIRECTORY_ERROR);
  }

  let handle;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new AuthConfigurationError(STORAGE_DIRECTORY_ERROR);
  }
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isDirectory()) {
      throw new AuthConfigurationError(STORAGE_DIRECTORY_ERROR);
    }
    await handle.chmod(0o700);
  } catch (error) {
    if (error instanceof AuthConfigurationError) throw error;
    throw new AuthConfigurationError(STORAGE_DIRECTORY_ERROR);
  } finally {
    await handle.close();
  }
}

async function validateDatabaseEntry(databasePath: string): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new AuthConfigurationError(STORAGE_DATABASE_ERROR);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new AuthConfigurationError(STORAGE_DATABASE_ERROR);
  }

  let handle;
  try {
    handle = await open(
      databasePath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch {
    throw new AuthConfigurationError(STORAGE_DATABASE_ERROR);
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw new AuthConfigurationError(STORAGE_DATABASE_ERROR);
    }
  } finally {
    await handle.close();
  }
  return true;
}

async function validateSqliteCompanionEntries(databasePath: string): Promise<void> {
  for (const suffix of SQLITE_COMPANION_SUFFIXES) {
    await validateDatabaseEntry(`${databasePath}${suffix}`);
  }
}

async function secureExistingDatabaseEntry(databasePath: string): Promise<void> {
  if (!await validateDatabaseEntry(databasePath)) return;
  let handle;
  try {
    handle = await open(
      databasePath,
      constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch {
    throw new AuthConfigurationError(STORAGE_DATABASE_ERROR);
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw new AuthConfigurationError(STORAGE_DATABASE_ERROR);
    }
    await handle.chmod(0o600);
  } catch (error) {
    if (error instanceof AuthConfigurationError) throw error;
    throw new AuthConfigurationError(STORAGE_DATABASE_ERROR);
  } finally {
    await handle.close();
  }
  await validateDatabaseEntry(databasePath);
}

async function secureSqliteCompanionEntries(databasePath: string): Promise<void> {
  for (const suffix of SQLITE_COMPANION_SUFFIXES) {
    await secureExistingDatabaseEntry(`${databasePath}${suffix}`);
  }
}

async function secureDatabaseEntry(databasePath: string): Promise<boolean> {
  const existed = await validateDatabaseEntry(databasePath);
  let handle;
  try {
    handle = await open(
      databasePath,
      constants.O_RDWR
        | constants.O_NONBLOCK
        | constants.O_NOFOLLOW
        | (existed ? 0 : constants.O_CREAT | constants.O_EXCL),
      0o600,
    );
  } catch {
    throw new AuthConfigurationError(STORAGE_DATABASE_ERROR);
  }
  let needsInitialization = !existed;
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) {
      throw new AuthConfigurationError(STORAGE_DATABASE_ERROR);
    }
    needsInitialization ||= openedStats.size === 0;
    await handle.chmod(0o600);
  } catch (error) {
    if (error instanceof AuthConfigurationError) throw error;
    throw new AuthConfigurationError(STORAGE_DATABASE_ERROR);
  } finally {
    await handle.close();
  }
  await validateDatabaseEntry(databasePath);
  return needsInitialization;
}

async function prepareAuthDatabasePath(dbPath: string): Promise<{
  databasePath: string;
  needsInitialization: boolean;
}> {
  const databasePath = resolve(dbPath);
  const oauthDirectory = dirname(databasePath);
  await validateDirectoryTree(oauthDirectory, true);
  await validateDatabaseEntry(databasePath);
  await validateSqliteCompanionEntries(databasePath);
  await securePrivateDirectory(oauthDirectory);
  await validateDirectoryTree(oauthDirectory, false);
  const needsInitialization = await secureDatabaseEntry(databasePath);
  await secureSqliteCompanionEntries(databasePath);
  await validateDirectoryTree(oauthDirectory, false);
  await validateDatabaseEntry(databasePath);
  await validateSqliteCompanionEntries(databasePath);
  return { databasePath, needsInitialization };
}

async function existingAuthDatabasePath(dbPath: string): Promise<string | undefined> {
  const databasePath = resolve(dbPath);
  const oauthDirectory = dirname(databasePath);
  if (!await validateDirectoryTree(oauthDirectory, false)) return undefined;
  if (!await validateDatabaseEntry(databasePath)) return undefined;
  await validateSqliteCompanionEntries(databasePath);
  await securePrivateDirectory(oauthDirectory);
  await secureExistingDatabaseEntry(databasePath);
  await secureSqliteCompanionEntries(databasePath);
  await validateDirectoryTree(oauthDirectory, false);
  await validateDatabaseEntry(databasePath);
  await validateSqliteCompanionEntries(databasePath);
  return databasePath;
}

export async function purgeUnsupportedCredentials(dbPath: string): Promise<void> {
  const databasePath = await existingAuthDatabasePath(dbPath);
  if (!databasePath) return;

  const db = new Database(databasePath, { create: false, readwrite: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;");
    const tableRows = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('auth_credentials', 'auth_credential_blocks', 'auth_credential_refresh_leases', 'cache')",
    ).all();
    const tables = new Set(tableRows.map(({ name }) => name));
    if (!tables.has(AUTH_TABLE)) {
      throw new AuthConfigurationError("Unsupported credential purge requires the auth_credentials table");
    }
    const credentialColumns = new Set(
      db.query<{ name: string }, []>("PRAGMA table_info(auth_credentials)").all().map(({ name }) => name),
    );
    if (!credentialColumns.has("id") || !credentialColumns.has("provider")) {
      throw new AuthConfigurationError("Unsupported credential purge found a malformed auth_credentials table");
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of CHILD_AUTH_TABLES) {
        if (!tables.has(table)) continue;
        const statement = db.query(
          `DELETE FROM ${table} WHERE credential_id IN (
            SELECT id FROM auth_credentials WHERE provider NOT IN (${AUTH_PROVIDER_PLACEHOLDERS})
          )`,
        );
        try {
          statement.run(...AUTH_PROVIDERS);
        } finally {
          statement.finalize();
        }
      }
      const deleteCredentials = db.query(
        `DELETE FROM auth_credentials WHERE provider NOT IN (${AUTH_PROVIDER_PLACEHOLDERS})`,
      );
      try {
        deleteCredentials.run(...AUTH_PROVIDERS);
      } finally {
        deleteCredentials.finalize();
      }
      if (tables.has("cache")) {
        const deleteStickyCache = db.query(
          `DELETE FROM cache WHERE key LIKE 'session:sticky:%' AND ${AUTH_PROVIDER_CACHE_PREDICATE}`,
        );
        try {
          deleteStickyCache.run(...AUTH_PROVIDERS.map((provider) => `session:sticky:${provider}:%`));
        } finally {
          deleteStickyCache.finalize();
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the deletion failure that made auth initialization unsafe.
      }
      throw error;
    }

    const checkpointStatement = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)");
    try {
      const checkpoint = checkpointStatement.get();
      if (!checkpoint || checkpoint.busy !== 0) {
        throw new AuthConfigurationError("Unsupported credential purge could not truncate the auth database WAL");
      }
    } finally {
      checkpointStatement.finalize();
    }
  } finally {
    db.close();
  }
}

const defaultStorageFactory: StorageFactory = async (path, needsInitialization = false) => {
  if (!needsInitialization) await purgeUnsupportedCredentials(path);
  return AuthStorage.create(path);
};

export const authDatabasePath = resolve(import.meta.dir, "../../data/oauth/auth.sqlite");
let factory: StorageFactory = defaultStorageFactory;
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
  const configuredPath = process.env.JOBHUNTER_AUTH_DATABASE ?? authDatabasePath;
  const { databasePath, needsInitialization } = await prepareAuthDatabasePath(configuredPath);
  const storage = await factory(databasePath, needsInitialization);
  try {
    await storage.reload();
    assertOAuthOnlyStorage(storage);
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
  factory = defaultStorageFactory;
}
