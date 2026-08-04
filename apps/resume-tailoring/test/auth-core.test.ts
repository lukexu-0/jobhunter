import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type {
  AuthCredentialEntry,
  OAuthAccess,
  OAuthCredential,
  StoredAuthCredential,
  StoredOAuthRefreshOptions,
  StoredOAuthRefreshResult,
} from "@oh-my-pi/pi-ai";
import type { AuthProvider } from "../src/contracts";
import { createOAuthOnlyApiKeyResolver, OAuthRequiredError, resolveOAuthOnlyWithStorage } from "../src/auth/oauth-only-resolver";
import { AuthService, scrubProviderEnvironment } from "../src/auth/service";
import {
  assertOAuthOnlyStorage,
  AuthConfigurationError,
  closeAuthStorage,
  getAuthStorage,
  purgeUnsupportedCredentials,
  type AuthStorageLike,
} from "../src/auth/storage";

interface LoginCallbacks {
  onAuth(info: { url: string; launchUrl?: string; instructions?: string }): void;
  onProgress?(message: string): void;
  onPrompt(prompt: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
  onManualCodeInput?(): Promise<string>;
  signal?: AbortSignal;
}

function oauthRow(provider: AuthProvider, overrides: Record<string, unknown> = {}): StoredAuthCredential {
  return {
    id: 1,
    provider,
    credential: {
      type: "oauth",
      access: "stored-access-secret",
      refresh: "stored-refresh-secret",
      expires: 2_000_000_000_000,
      accountId: "acct-secret-1234",
      ...overrides,
    },
    disabledCause: null,
  } as StoredAuthCredential;
}

class FakeStorage implements AuthStorageLike {
  rows: StoredAuthCredential[] = [];
  access: OAuthAccess | undefined;
  callbacks: LoginCallbacks | undefined;
  readonly loginProviders: string[] = [];
  readonly loginGate = Promise.withResolvers<void>();
  readonly loginValidated = Promise.withResolvers<void>();
  loginReleased = false;
  readonly accessOptions: Array<{ modelId?: string; signal?: AbortSignal; forceRefresh?: boolean }> = [];
  closed = false;
  writesAfterClose = 0;

  async reload(): Promise<void> {}
  close(): void { this.closed = true; }
  async set(provider: string, credential: AuthCredentialEntry): Promise<void> {
    if (this.closed) this.writesAfterClose += 1;
    const selected = Array.isArray(credential) ? credential[0] : credential;
    this.rows = this.rows.filter((row) => row.provider !== provider);
    if (selected) {
      this.rows.push({
        id: 1,
        provider,
        credential: selected,
        disabledCause: null,
      });
    }
  }
  listStoredCredentials(provider?: string): StoredAuthCredential[] {
    if (this.loginReleased) this.loginValidated.resolve();
    return provider ? this.rows.filter((row) => row.provider === provider) : [...this.rows];
  }
  getOAuthAccountIdentity(provider: string): { accountId?: string; email?: string } | undefined {
    const row = this.rows.find((candidate) => candidate.provider === provider);
    if (!row || row.credential.type !== "oauth") return undefined;
    return {
      ...(row.credential.accountId ? { accountId: row.credential.accountId } : {}),
      ...(row.credential.email ? { email: row.credential.email } : {}),
    };
  }
  getOAuthCredential(provider: string): OAuthCredential | undefined {
    const row = this.rows.find((candidate) => candidate.provider === provider);
    return row?.credential.type === "oauth" ? row.credential : undefined;
  }
  async refreshStoredOAuthCredential<T extends OAuthCredential = OAuthCredential>(
    _provider: string,
    _options: StoredOAuthRefreshOptions<T>,
  ): Promise<StoredOAuthRefreshResult<T>> {
    throw new Error("unexpected durable refresh");
  }
  async getOAuthAccess(
    _provider: string,
    _sessionId?: string,
    options: { modelId?: string; signal?: AbortSignal; forceRefresh?: boolean } = {},
  ): Promise<OAuthAccess | undefined> {
    this.accessOptions.push(options);
    return this.access;
  }
  async login(provider: string, callbacks: LoginCallbacks): Promise<void> {
    this.loginProviders.push(provider);
    this.callbacks = callbacks;
    callbacks.onAuth({
      url: "https://provider.example/authorize?state=opaque",
      launchUrl: "http://127.0.0.1:1455/start/opaque",
      instructions: "Continue in your browser",
    });
    await this.loginGate.promise;
    this.loginReleased = true;
  }
  async logout(provider: string): Promise<void> {
    this.rows = this.rows.filter((row) => row.provider !== provider);
  }
}

const ids = {
  first: "AAAAAAAAAAAAAAAAAAAAAA",
  second: "BBBBBBBBBBBBBBBBBBBBBB",
};

function createPurgeableTarget(databasePath: string, provider: string): Buffer {
  const db = new Database(databasePath);
  try {
    db.exec("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL)");
    db.query("INSERT INTO auth_credentials(id, provider) VALUES (1, ?)").run(provider);
  } finally {
    db.close();
  }
  chmodSync(databasePath, 0o640);
  return readFileSync(databasePath);
}

describe("app-owned OAuth storage and sessions", () => {
  test("rejects static, unsupported, and duplicate stored credentials", () => {
    const staticStorage = new FakeStorage();
    staticStorage.rows = [{
      id: 1,
      provider: "openai-codex",
      credential: { type: "api_key", key: "must-never-be-used" },
      disabledCause: null,
    } as StoredAuthCredential];
    expect(() => assertOAuthOnlyStorage(staticStorage)).toThrow(AuthConfigurationError);

    const retiredGoogle = new FakeStorage();
    retiredGoogle.rows = [{
      id: 1,
      provider: "google-antigravity",
      credential: {
        type: "oauth",
        access: "legacy-access",
        refresh: "legacy-refresh",
        expires: 2_000_000_000_000,
        projectId: "legacy-project",
      },
      disabledCause: null,
    } as StoredAuthCredential];
    expect(() => assertOAuthOnlyStorage(retiredGoogle)).toThrow("Unsupported credential provider: google-antigravity");

    const duplicateStorage = new FakeStorage();
    duplicateStorage.rows = [oauthRow("openai-codex"), { ...oauthRow("openai-codex"), id: 2 }];
    expect(() => assertOAuthOnlyStorage(duplicateStorage)).toThrow("Multiple active OAuth credentials");
    const indeedStorage = new FakeStorage();
    indeedStorage.rows = [oauthRow("indeed", { accountId: undefined, clientId: "indeed-client" })];
    expect(() => assertOAuthOnlyStorage(indeedStorage)).not.toThrow();
    indeedStorage.rows = [oauthRow("indeed", { accountId: undefined })];
    expect(() => assertOAuthOnlyStorage(indeedStorage)).toThrow("Indeed OAuth credential has no registered client identity");
    for (const clientId of [" indeed-client", "indeed-client ", "indeed\u0000client", "indeed\nclient"]) {
      indeedStorage.rows = [oauthRow("indeed", { accountId: undefined, clientId })];
      expect(() => assertOAuthOnlyStorage(indeedStorage)).toThrow(
        "Indeed OAuth credential has no registered client identity",
      );
    }
  });

  test("rejects connect when connected and rejects a concurrent provider session", async () => {
    const connected = new FakeStorage();
    connected.rows = [oauthRow("openai-codex")];
    const connectedService = new AuthService(connected);
    await expect(connectedService.startSession("openai-codex")).rejects.toMatchObject({
      code: "AUTH_ALREADY_CONNECTED",
      status: 409,
    });

    const pending = new FakeStorage();
    const pendingService = new AuthService(pending, { randomId: () => ids.first, schedule: () => undefined });
    await pendingService.startSession("openai-codex");
    expect(pending.loginProviders).toEqual(["openai-codex"]);
    await expect(pendingService.startSession("openai-codex")).rejects.toMatchObject({
      code: "AUTH_CONFLICT",
      status: 409,
    });
    pendingService.cancelSession(ids.first);
  });

  test("logout waits for a late provider callback and retires its credential before releasing the lock", async () => {
    const storage = new FakeStorage();
    const releaseCallback = Promise.withResolvers<void>();
    const credentialPersisted = Promise.withResolvers<void>();
    const service = new AuthService(storage, {
      randomId: () => ids.first,
      schedule: () => undefined,
      providerLogin: async (provider, controller) => {
        controller.onAuth({ url: "https://provider.example/authorize?state=opaque" });
        await releaseCallback.promise;
        await storage.set(provider, {
          type: "oauth",
          access: "late-access",
          refresh: "late-refresh",
          expires: 2_000_000_000_000,
          clientId: "late-indeed-client",
        } as OAuthCredential);
        credentialPersisted.resolve();
      },
    });
    const started = await service.startSession("indeed");

    let logoutSettled = false;
    const logout = service.logout("indeed").then(() => { logoutSettled = true; });
    await Promise.resolve();
    expect(logoutSettled).toBe(false);
    await expect(service.startSession("indeed")).rejects.toMatchObject({
      code: "AUTH_CONFLICT",
      status: 409,
    });

    releaseCallback.resolve();
    await credentialPersisted.promise;
    await logout;
    expect(logoutSettled).toBe(true);
    expect(service.getSession(started.id)?.state).toBe("cancelled");
    expect(service.getAuthStatus().providers[1]).toEqual({
      provider: "indeed",
      state: "disconnected",
    });
    expect(storage.rows).toEqual([]);
  });

  test("close waits for pending provider settlement and cleanup before storage closes", async () => {
    const storage = new FakeStorage();
    const releaseCallback = Promise.withResolvers<void>();
    const credentialPersisted = Promise.withResolvers<void>();
    const service = new AuthService(storage, {
      randomId: () => ids.first,
      schedule: () => undefined,
      providerLogin: async (provider, controller) => {
        controller.onAuth({ url: "https://provider.example/authorize?state=opaque" });
        await releaseCallback.promise;
        await storage.set(provider, {
          type: "oauth",
          access: "late-access",
          refresh: "late-refresh",
          expires: 2_000_000_000_000,
          clientId: "late-indeed-client",
        } as OAuthCredential);
        credentialPersisted.resolve();
      },
    });
    await service.startSession("indeed");

    let closeSettled = false;
    const close = service.close().then(() => {
      storage.close();
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(storage.closed).toBe(false);

    releaseCallback.resolve();
    await credentialPersisted.promise;
    await close;
    expect(storage.closed).toBe(true);
    expect(storage.writesAfterClose).toBe(0);
    expect(storage.rows).toEqual([]);
  });

  test("exposes one prompt, accepts its answer, and never exposes provider secrets", async () => {
    const storage = new FakeStorage();
    const service = new AuthService(storage, { randomId: () => ids.first, schedule: () => undefined });
    const started = await service.startSession("openai-codex");
    expect(started).toMatchObject({
      id: ids.first,
      state: "pending",
      url: "https://provider.example/authorize?state=opaque",
      launchUrl: "http://127.0.0.1:1455/start/opaque",
    });

    const answer = storage.callbacks!.onPrompt({ message: "Paste code", placeholder: "code" });
    expect(service.getSession(ids.first)).toMatchObject({
      state: "pending",
      prompt: { message: "Paste code", placeholder: "code", kind: "prompt" },
    });
    await expect(storage.callbacks!.onPrompt({ message: "overlap" })).rejects.toThrow("overlapping prompts");
    service.answerPrompt(ids.first, "user-code");
    expect(await answer).toBe("user-code");
    expect(JSON.stringify(service.getSession(ids.first))).not.toContain("user-code");
    service.cancelSession(ids.first);
  });

  test("cancels pending input and expires sessions deterministically", async () => {
    let now = 1_000;
    const cancelledStorage = new FakeStorage();
    const cancelled = new AuthService(cancelledStorage, { now: () => now, randomId: () => ids.first, schedule: () => undefined });
    await cancelled.startSession("openai-codex");
    const pendingAnswer = cancelledStorage.callbacks!.onManualCodeInput!();
    expect(cancelled.cancelSession(ids.first)?.state).toBe("cancelled");
    await expect(pendingAnswer).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelledStorage.callbacks!.signal?.aborted).toBe(true);

    const expiringStorage = new FakeStorage();
    const expiring = new AuthService(expiringStorage, { now: () => now, randomId: () => ids.second, schedule: () => undefined });
    await expiring.startSession("openai-codex");
    expect(expiringStorage.loginProviders).toEqual(["openai-codex"]);
    now += 10 * 60_000;
    expect(expiring.getSession(ids.second)?.state).toBe("expired");
    expect(expiringStorage.callbacks!.signal?.aborted).toBe(true);
    expiringStorage.loginGate.resolve();
    await expiringStorage.loginValidated.promise;
    await expiring.close();
    now += 60_000;
    expect(expiring.getSession(ids.second)).toBeUndefined();
  });

  test("routes OpenAI Codex through storage login and verifies persisted OAuth", async () => {
    const storage = new FakeStorage();
    const service = new AuthService(storage, {
      randomId: () => ids.first,
      schedule: () => undefined,
    });

    const started = await service.startSession("openai-codex");
    expect(started).toMatchObject({ provider: "openai-codex", state: "pending" });
    expect(storage.loginProviders).toEqual(["openai-codex"]);
    storage.rows = [oauthRow("openai-codex")];
    storage.loginGate.resolve();
    await storage.loginValidated.promise;

    expect(service.getSession(ids.first)?.state).toBe("succeeded");
    expect(service.getAuthStatus().providers).toEqual([
      expect.objectContaining({
        provider: "openai-codex",
        state: "connected",
      }),
      { provider: "indeed", state: "disconnected" },
    ]);
  });

  test("returns only redacted account identity and explicitly logs out", async () => {
    const storage = new FakeStorage();
    storage.rows = [oauthRow("openai-codex", { email: "person@example.com" })];
    const status = new AuthService(storage).getAuthStatus();
    const encoded = JSON.stringify(status);
    expect(status.providers[0]).toMatchObject({
      state: "connected",
      identity: { email: "p***@example.com", accountId: "***1234" },
    });
    expect(status.providers.map(({ provider }) => provider)).toEqual(["openai-codex", "indeed"]);
    expect(encoded).not.toContain("stored-access-secret");
    expect(encoded).not.toContain("stored-refresh-secret");
    expect(encoded).not.toContain("person@example.com");
    expect(encoded).not.toContain("acct-secret");
    const service = new AuthService(storage);
    await service.logout("openai-codex");
    expect(service.getAuthStatus().providers).toEqual([
      { provider: "openai-codex", state: "disconnected" },
      { provider: "indeed", state: "disconnected" },
    ]);
  });
});

describe("OAuth-only resolver", () => {
  test("allows both exact Codex models and rejects unsupported models before storage access", async () => {
    const codex = new FakeStorage();
    codex.rows = [oauthRow("openai-codex")];
    codex.access = { accessToken: "codex-bearer", accountId: "acct" };
    expect(await resolveOAuthOnlyWithStorage(codex, "openai-codex", "attempt-sol", "gpt-5.6-sol")).toBe("codex-bearer");
    expect(await resolveOAuthOnlyWithStorage(codex, "openai-codex", "attempt-luna", "gpt-5.6-luna")).toBe("codex-bearer");

    for (const model of ["gpt-5-6-luna", "gemini-3.5-flash", "unknown-model"]) {
      await expect(resolveOAuthOnlyWithStorage(codex, "openai-codex", "attempt", model))
        .rejects.toThrow(`Unsupported OAuth model openai-codex/${model}`);
    }
    expect(codex.accessOptions).toHaveLength(2);
  });
  test("fails OAUTH_REQUIRED without OAuth and permits only one forced refresh", async () => {
    const missing = new FakeStorage();
    await expect(resolveOAuthOnlyWithStorage(missing, "openai-codex", "attempt", "gpt-5.6-sol")).rejects.toBeInstanceOf(OAuthRequiredError);
    await expect(resolveOAuthOnlyWithStorage(missing, "openai-codex", "attempt", "gpt-5.6-sol")).rejects.toMatchObject({ code: "OAUTH_REQUIRED" });

    const storage = new FakeStorage();
    storage.rows = [oauthRow("openai-codex")];
    storage.access = { accessToken: "fresh", accountId: "acct" };
    const resolver = createOAuthOnlyApiKeyResolver(
      "openai-codex",
      "attempt",
      "gpt-5.6-sol",
      undefined,
      Promise.resolve(storage),
    );
    expect(await resolver({ error: undefined, lastChance: false })).toBe("fresh");
    expect(await resolver({ error: new Error("401"), lastChance: false })).toBe("fresh");
    expect(await resolver({ error: new Error("401 again"), lastChance: false })).toBeUndefined();
    expect(await resolver({ error: new Error("401"), lastChance: true })).toBeUndefined();
    expect(storage.accessOptions.map((options) => options.forceRefresh)).toEqual([false, true]);
  });
});

test("rejects a final auth database symlink without mutating its target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jobhunter-auth-final-link-"));
  const oauthDirectory = join(directory, "oauth");
  const targetPath = join(directory, "target.sqlite");
  const databasePath = join(oauthDirectory, "auth.sqlite");
  const priorDatabasePath = process.env.JOBHUNTER_AUTH_DATABASE;
  mkdirSync(oauthDirectory, { mode: 0o750 });
  chmodSync(oauthDirectory, 0o750);
  const targetBytes = createPurgeableTarget(targetPath, "unsupported-final-link-target");
  symlinkSync(targetPath, databasePath);
  const oauthDirectoryMode = statSync(oauthDirectory).mode & 0o777;
  const targetMode = statSync(targetPath).mode & 0o777;

  try {
    await expect(purgeUnsupportedCredentials(databasePath)).rejects.toThrow(
      "OAuth storage database must be a regular file",
    );
    expect(Buffer.compare(readFileSync(targetPath), targetBytes)).toBe(0);
    expect(statSync(targetPath).mode & 0o777).toBe(targetMode);
    expect(statSync(oauthDirectory).mode & 0o777).toBe(oauthDirectoryMode);

    process.env.JOBHUNTER_AUTH_DATABASE = databasePath;
    await expect(getAuthStorage()).rejects.toThrow(
      "OAuth storage database must be a regular file",
    );
    expect(Buffer.compare(readFileSync(targetPath), targetBytes)).toBe(0);
    expect(statSync(targetPath).mode & 0o777).toBe(targetMode);
    expect(statSync(oauthDirectory).mode & 0o777).toBe(oauthDirectoryMode);
  } finally {
    await closeAuthStorage();
    if (priorDatabasePath === undefined) delete process.env.JOBHUNTER_AUTH_DATABASE;
    else process.env.JOBHUNTER_AUTH_DATABASE = priorDatabasePath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a parent auth directory symlink without mutating its target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jobhunter-auth-parent-link-"));
  const targetDirectory = join(directory, "target");
  const linkedDirectory = join(directory, "oauth");
  const targetPath = join(targetDirectory, "auth.sqlite");
  const databasePath = join(linkedDirectory, "auth.sqlite");
  const priorDatabasePath = process.env.JOBHUNTER_AUTH_DATABASE;
  mkdirSync(targetDirectory, { mode: 0o750 });
  chmodSync(targetDirectory, 0o750);
  const targetBytes = createPurgeableTarget(targetPath, "unsupported-parent-link-target");
  symlinkSync(targetDirectory, linkedDirectory);
  const targetDirectoryMode = statSync(targetDirectory).mode & 0o777;
  const targetMode = statSync(targetPath).mode & 0o777;

  try {
    await expect(purgeUnsupportedCredentials(databasePath)).rejects.toThrow(
      "OAuth storage directory must be a private regular directory",
    );
    expect(Buffer.compare(readFileSync(targetPath), targetBytes)).toBe(0);
    expect(statSync(targetDirectory).mode & 0o777).toBe(targetDirectoryMode);
    expect(statSync(targetPath).mode & 0o777).toBe(targetMode);

    process.env.JOBHUNTER_AUTH_DATABASE = databasePath;
    await expect(getAuthStorage()).rejects.toThrow(
      "OAuth storage directory must be a private regular directory",
    );
    expect(Buffer.compare(readFileSync(targetPath), targetBytes)).toBe(0);
    expect(statSync(targetDirectory).mode & 0o777).toBe(targetDirectoryMode);
    expect(statSync(targetPath).mode & 0o777).toBe(targetMode);
  } finally {
    await closeAuthStorage();
    if (priorDatabasePath === undefined) delete process.env.JOBHUNTER_AUTH_DATABASE;
    else process.env.JOBHUNTER_AUTH_DATABASE = priorDatabasePath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a symbolic-link SQLite companion without mutating either target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jobhunter-auth-companion-link-"));
  const oauthDirectory = join(directory, "oauth");
  const databasePath = join(oauthDirectory, "auth.sqlite");
  const companionTarget = join(directory, "target.wal");
  const priorDatabasePath = process.env.JOBHUNTER_AUTH_DATABASE;
  mkdirSync(oauthDirectory, { mode: 0o750 });
  chmodSync(oauthDirectory, 0o750);
  const databaseBytes = createPurgeableTarget(databasePath, "unsupported-companion-link-target");
  const companionBytes = createPurgeableTarget(companionTarget, "unsupported-wal-link-target");
  symlinkSync(companionTarget, `${databasePath}-wal`);
  const directoryMode = statSync(oauthDirectory).mode & 0o777;
  const databaseMode = statSync(databasePath).mode & 0o777;
  const companionMode = statSync(companionTarget).mode & 0o777;

  try {
    await expect(purgeUnsupportedCredentials(databasePath)).rejects.toThrow(
      "OAuth storage database must be a regular file",
    );
    expect(Buffer.compare(readFileSync(databasePath), databaseBytes)).toBe(0);
    expect(Buffer.compare(readFileSync(companionTarget), companionBytes)).toBe(0);
    expect(statSync(oauthDirectory).mode & 0o777).toBe(directoryMode);
    expect(statSync(databasePath).mode & 0o777).toBe(databaseMode);
    expect(statSync(companionTarget).mode & 0o777).toBe(companionMode);

    process.env.JOBHUNTER_AUTH_DATABASE = databasePath;
    await expect(getAuthStorage()).rejects.toThrow(
      "OAuth storage database must be a regular file",
    );
    expect(Buffer.compare(readFileSync(databasePath), databaseBytes)).toBe(0);
    expect(Buffer.compare(readFileSync(companionTarget), companionBytes)).toBe(0);
    expect(statSync(oauthDirectory).mode & 0o777).toBe(directoryMode);
    expect(statSync(databasePath).mode & 0o777).toBe(databaseMode);
    expect(statSync(companionTarget).mode & 0o777).toBe(companionMode);
  } finally {
    await closeAuthStorage();
    if (priorDatabasePath === undefined) delete process.env.JOBHUNTER_AUTH_DATABASE;
    else process.env.JOBHUNTER_AUTH_DATABASE = priorDatabasePath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("creates private auth storage and safely reopens the regular database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jobhunter-auth-private-"));
  const oauthDirectory = join(directory, "nested", "oauth");
  const databasePath = join(oauthDirectory, "auth.sqlite");
  const priorDatabasePath = process.env.JOBHUNTER_AUTH_DATABASE;
  process.env.JOBHUNTER_AUTH_DATABASE = databasePath;

  try {
    const created = await getAuthStorage();
    expect(created.listStoredCredentials()).toEqual([]);
    await closeAuthStorage();
    expect(statSync(oauthDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);

    const reopened = await getAuthStorage();
    expect(reopened.listStoredCredentials()).toEqual([]);
    await closeAuthStorage();
    expect(statSync(oauthDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  } finally {
    await closeAuthStorage();
    if (priorDatabasePath === undefined) delete process.env.JOBHUNTER_AUTH_DATABASE;
    else process.env.JOBHUNTER_AUTH_DATABASE = priorDatabasePath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hard-purges unsupported credentials, children, and token bytes without touching Codex or Indeed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jobhunter-auth-purge-"));
  const dbPath = join(directory, "auth.sqlite");
  const missingPath = join(directory, "missing.sqlite");
  const unsupportedAccess = "unsupported-access-sentinel-7f3e0901";
  const unsupportedRefresh = "unsupported-refresh-sentinel-a18f26c4";
  const disabledAccess = "disabled-unsupported-access-sentinel-61bb0052";
  const disabledRefresh = "disabled-unsupported-refresh-sentinel-f5a3d87d";
  const googleStickySentinel = "google-sticky-sentinel-d12c4e81";
  const codexStickyValue = '{"type":"oauth","index":0,"credentialId":3}';
  const indeedStickyValue = '{"type":"oauth","index":0,"credentialId":4}';
  const codexData = JSON.stringify({
    access: "allowed-codex-access",
    refresh: "allowed-codex-refresh",
    expires: 2_000_000_000_000,
    accountId: "acct-allowed",
  });
  const indeedData = JSON.stringify({
    access: "allowed-indeed-access",
    refresh: "allowed-indeed-refresh",
    expires: 2_000_000_000_000,
    clientId: "indeed-client",
  });

  try {
    await purgeUnsupportedCredentials(missingPath);
    expect(existsSync(missingPath)).toBe(false);

    const db = new Database(dbPath);
    db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        data TEXT NOT NULL,
        disabled_cause TEXT DEFAULT NULL,
        identity_key TEXT DEFAULT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE auth_credential_blocks (
        credential_id INTEGER NOT NULL,
        provider_key TEXT NOT NULL,
        block_scope TEXT NOT NULL,
        blocked_until_ms INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (credential_id, provider_key, block_scope)
      );
      CREATE TABLE auth_credential_refresh_leases (
        credential_id INTEGER PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    const insertCredential = db.query(
      "INSERT INTO auth_credentials(id, provider, credential_type, data, disabled_cause, created_at, updated_at) VALUES (?, ?, 'oauth', ?, ?, 1, 1)",
    );
    insertCredential.run(1, "google-antigravity", JSON.stringify({
      access: unsupportedAccess,
      refresh: unsupportedRefresh,
      expires: 2_000_000_000_000,
      projectId: "legacy-active-project",
    }), null);
    insertCredential.run(2, "google-antigravity", JSON.stringify({
      access: disabledAccess,
      refresh: disabledRefresh,
      expires: 2_000_000_000_000,
      projectId: "legacy-disabled-project",
    }), "retired");
    insertCredential.run(3, "openai-codex", codexData, null);
    insertCredential.run(4, "indeed", indeedData, null);
    const insertBlock = db.query(
      "INSERT INTO auth_credential_blocks(credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, '', 999999, 1)",
    );
    insertBlock.run(1, "google-antigravity:oauth");
    insertBlock.run(2, "google-antigravity:oauth");
    insertBlock.run(3, "openai-codex:oauth");
    insertBlock.run(4, "indeed:oauth");
    const insertLease = db.query(
      "INSERT INTO auth_credential_refresh_leases(credential_id, owner, expires_at_ms, updated_at) VALUES (?, ?, 999999, 1)",
    );
    insertLease.run(1, "unsupported-active");
    insertLease.run(2, "unsupported-disabled");
    insertLease.run(3, "codex");
    insertLease.run(4, "indeed");
    const insertCache = db.query("INSERT INTO cache(key, value, expires_at) VALUES (?, ?, 9999999999)");
    insertCache.run("session:sticky:google-antigravity:active", googleStickySentinel);
    insertCache.run("session:sticky:google-antigravity:disabled", '{"type":"oauth","index":1,"credentialId":2}');
    insertCache.run("session:sticky:openai-codex:active", codexStickyValue);
    insertCache.run("session:sticky:indeed:active", indeedStickyValue);
    insertCache.run("usage_cache:google-antigravity:legacy", "unrelated-cache-row");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();

    expect(readFileSync(dbPath).includes(Buffer.from(unsupportedAccess))).toBe(true);
    await purgeUnsupportedCredentials(dbPath);

    const verified = new Database(dbPath, { readonly: true });
    try {
      expect(verified.query("SELECT id FROM auth_credentials WHERE provider = 'google-antigravity'").all()).toEqual([]);
      expect(verified.query("SELECT credential_id FROM auth_credential_blocks WHERE credential_id IN (1, 2)").all()).toEqual([]);
      expect(verified.query("SELECT credential_id FROM auth_credential_refresh_leases WHERE credential_id IN (1, 2)").all()).toEqual([]);
      expect(verified.query("SELECT key FROM cache WHERE key LIKE 'session:sticky:google-antigravity:%'").all()).toEqual([]);
      expect(verified.query("SELECT id, provider, data, disabled_cause FROM auth_credentials WHERE id = 3").get()).toEqual({
        id: 3,
        provider: "openai-codex",
        data: codexData,
        disabled_cause: null,
      });
      expect(verified.query("SELECT id, provider, data, disabled_cause FROM auth_credentials WHERE id = 4").get()).toEqual({
        id: 4,
        provider: "indeed",
        data: indeedData,
        disabled_cause: null,
      });
      expect(verified.query("SELECT credential_id FROM auth_credential_blocks WHERE credential_id = 3").get()).toEqual({
        credential_id: 3,
      });
      expect(verified.query("SELECT credential_id FROM auth_credential_blocks WHERE credential_id = 4").get()).toEqual({
        credential_id: 4,
      });
      expect(verified.query("SELECT credential_id FROM auth_credential_refresh_leases WHERE credential_id = 3").get()).toEqual({
        credential_id: 3,
      });
      expect(verified.query("SELECT credential_id FROM auth_credential_refresh_leases WHERE credential_id = 4").get()).toEqual({
        credential_id: 4,
      });
      expect(verified.query("SELECT value FROM cache WHERE key = 'session:sticky:openai-codex:active'").get()).toEqual({
        value: codexStickyValue,
      });
      expect(verified.query("SELECT value FROM cache WHERE key = 'session:sticky:indeed:active'").get()).toEqual({
        value: indeedStickyValue,
      });
      expect(verified.query("SELECT value FROM cache WHERE key = 'usage_cache:google-antigravity:legacy'").get()).toEqual({
        value: "unrelated-cache-row",
      });
    } finally {
      verified.close();
    }

    for (const path of [dbPath, `${dbPath}-wal`]) {
      if (!existsSync(path)) continue;
      const bytes = readFileSync(path);
      for (const sentinel of [unsupportedAccess, unsupportedRefresh, disabledAccess, disabledRefresh, googleStickySentinel]) {
        expect(bytes.includes(Buffer.from(sentinel))).toBe(false);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider environment scrubbing removes credentials and stale Google project hints", () => {
  const environment: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: "secret",
    CODEX_API_KEY: "secret",
    OPENAI_CODEX_OAUTH_TOKEN: "secret",
    GEMINI_API_KEY: "secret",
    GOOGLE_API_KEY: "secret",
    GOOGLE_APPLICATION_CREDENTIALS: "/secret/adc.json",
    GOOGLE_CLOUD_API_KEY: "secret",
    GOOGLE_CLOUD_ACCESS_TOKEN: "secret",
    CLOUDSDK_AUTH_ACCESS_TOKEN: "secret",
    GCP_PROJECT: "forbidden-project-alias",
    GCLOUD_PROJECT: "forbidden-project-alias",
    GOOGLE_VERTEX_LOCATION: "region",
    GOOGLE_CLOUD_LOCATION: "region",
    VERTEX_LOCATION: "region",
    GOOGLE_GENAI_USE_VERTEXAI: "true",
    GOOGLE_VERTEX_AI: "true",
    VERTEX_AI_API_KEY: "secret",
    VERTEX_API_KEY: "secret",
    GOOGLE_CLOUD_PROJECT: "stale-project",
    GOOGLE_CLOUD_PROJECT_ID: "stale-project-id",
  };
  scrubProviderEnvironment(environment);
  expect(environment).toEqual({});
});
