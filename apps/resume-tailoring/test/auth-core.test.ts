import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { OAuthAccess, StoredAuthCredential } from "@oh-my-pi/pi-ai";
import { createOAuthOnlyApiKeyResolver, OAuthRequiredError, resolveOAuthOnlyWithStorage } from "../src/auth/oauth-only-resolver";
import { AuthService, scrubProviderEnvironment } from "../src/auth/service";
import {
  assertOAuthOnlyStorage,
  AuthConfigurationError,
  purgeUnsupportedCredentials,
  type AuthProvider,
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
      ...(provider === "openai-codex"
        ? { accountId: "acct-secret-1234" }
        : provider === "google-antigravity"
          ? { projectId: "project-secret-5678" }
          : {}),
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

  async reload(): Promise<void> {}
  close(): void { this.closed = true; }
  listStoredCredentials(provider?: string): StoredAuthCredential[] {
    if (this.loginReleased) this.loginValidated.resolve();
    return provider ? this.rows.filter((row) => row.provider === provider) : [...this.rows];
  }
  getOAuthAccountIdentity(provider: string): { accountId?: string; email?: string; projectId?: string } | undefined {
    const row = this.rows.find((candidate) => candidate.provider === provider);
    if (!row || row.credential.type !== "oauth") return undefined;
    return {
      ...(row.credential.accountId ? { accountId: row.credential.accountId } : {}),
      ...(row.credential.email ? { email: row.credential.email } : {}),
      ...(row.credential.projectId ? { projectId: row.credential.projectId } : {}),
    };
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

describe("app-owned OAuth storage and sessions", () => {
  test("rejects static and duplicate stored credentials", () => {
    const staticStorage = new FakeStorage();
    staticStorage.rows = [{
      id: 1,
      provider: "openai-codex",
      credential: { type: "api_key", key: "must-never-be-used" },
      disabledCause: null,
    } as StoredAuthCredential];
    expect(() => assertOAuthOnlyStorage(staticStorage)).toThrow(AuthConfigurationError);
    const staticGoogle = new FakeStorage();
    staticGoogle.rows = [{
      id: 1,
      provider: "google-antigravity",
      credential: { type: "api_key", key: "must-never-be-used" },
      disabledCause: null,
    } as StoredAuthCredential];
    expect(() => assertOAuthOnlyStorage(staticGoogle)).toThrow(AuthConfigurationError);

    const duplicateStorage = new FakeStorage();
    duplicateStorage.rows = [oauthRow("openai-codex"), { ...oauthRow("openai-codex"), id: 2 }];
    expect(() => assertOAuthOnlyStorage(duplicateStorage)).toThrow("Multiple active OAuth credentials");
    const duplicateGoogle = new FakeStorage();
    duplicateGoogle.rows = [oauthRow("google-antigravity"), { ...oauthRow("google-antigravity"), id: 2 }];
    expect(() => assertOAuthOnlyStorage(duplicateGoogle)).toThrow("Multiple active OAuth credentials");
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
    await expiring.startSession("google-antigravity");
    expect(expiringStorage.loginProviders).toEqual(["google-antigravity"]);
    now += 10 * 60_000;
    expect(expiring.getSession(ids.second)?.state).toBe("expired");
    expect(expiringStorage.callbacks!.signal?.aborted).toBe(true);
    now += 60_000;
    expect(expiring.getSession(ids.second)).toBeUndefined();
  });

  test("routes both supported providers through storage login and verifies persisted OAuth", async () => {
    for (const provider of ["openai-codex", "google-antigravity"] as const) {
      const storage = new FakeStorage();
      const service = new AuthService(storage, {
        randomId: () => ids.first,
        schedule: () => undefined,
      });

      const started = await service.startSession(provider);
      expect(started).toMatchObject({ provider, state: "pending" });
      expect(storage.loginProviders).toEqual([provider]);
      storage.rows = [oauthRow(provider)];
      storage.loginGate.resolve();
      await storage.loginValidated.promise;

      expect(service.getSession(ids.first)?.state).toBe("succeeded");
      expect(service.getAuthStatus().providers.find((status) => status.provider === provider)?.state).toBe("connected");
    }
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
    expect(status.providers.map(({ provider }) => provider)).toEqual(["openai-codex", "google-antigravity"]);
    expect(encoded).not.toContain("stored-access-secret");
    expect(encoded).not.toContain("stored-refresh-secret");
    expect(encoded).not.toContain("person@example.com");
    expect(encoded).not.toContain("acct-secret");
    const service = new AuthService(storage);
    await service.logout("openai-codex");
    expect(service.getAuthStatus().providers[0]).toEqual({ provider: "openai-codex", state: "disconnected" });
  });
});

describe("OAuth-only resolver", () => {
  test("allows both exact Codex models and rejects every unsupported provider-model pair before storage access", async () => {
    const codex = new FakeStorage();
    codex.rows = [oauthRow("openai-codex")];
    codex.access = { accessToken: "codex-bearer", accountId: "acct" };
    expect(await resolveOAuthOnlyWithStorage(codex, "openai-codex", "attempt-sol", "gpt-5.6-sol")).toBe("codex-bearer");
    expect(await resolveOAuthOnlyWithStorage(codex, "openai-codex", "attempt-luna", "gpt-5.6-luna")).toBe("codex-bearer");

    const google = new FakeStorage();
    google.rows = [oauthRow("google-antigravity")];
    google.access = {
      accessToken: "google-bearer",
      projectId: "cloud-project",
      email: "person@example.com",
    };
    const key = await resolveOAuthOnlyWithStorage(google, "google-antigravity", "attempt", "gemini-3.5-flash");
    expect(JSON.parse(key)).toEqual({
      token: "google-bearer",
      projectId: "cloud-project",
      email: "p***@example.com",
    });
    expect(key).not.toContain("refresh");

    const wrongPairs: Array<[AuthProvider, string]> = [
      ["openai-codex", "gpt-5-6-luna"],
      ["openai-codex", "gemini-3.5-flash"],
      ["openai-codex", "unknown-model"],
      ["google-antigravity", "gpt-5.6-sol"],
      ["google-antigravity", "gpt-5.6-luna"],
      ["google-antigravity", "unknown-model"],
    ];
    for (const [provider, model] of wrongPairs) {
      await expect(resolveOAuthOnlyWithStorage(codex, provider, "attempt", model))
        .rejects.toThrow(`Unsupported OAuth model ${provider}/${model}`);
    }
    expect(codex.accessOptions).toHaveLength(2);
    expect(google.accessOptions).toHaveLength(1);
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

test("hard-purges active and disabled unsupported credentials, children, and token bytes without touching Codex", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jobhunter-auth-purge-"));
  const dbPath = join(directory, "auth.sqlite");
  const missingPath = join(directory, "missing.sqlite");
  const unsupportedAccess = "unsupported-access-sentinel-7f3e0901";
  const unsupportedRefresh = "unsupported-refresh-sentinel-a18f26c4";
  const disabledAccess = "disabled-unsupported-access-sentinel-61bb0052";
  const disabledRefresh = "disabled-unsupported-refresh-sentinel-f5a3d87d";
  const codexData = JSON.stringify({
    access: "allowed-codex-access",
    refresh: "allowed-codex-refresh",
    expires: 2_000_000_000_000,
    accountId: "acct-allowed",
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
    `);
    const insertCredential = db.query(
      "INSERT INTO auth_credentials(id, provider, credential_type, data, disabled_cause, created_at, updated_at) VALUES (?, ?, 'oauth', ?, ?, 1, 1)",
    );
    insertCredential.run(1, "retired-provider", JSON.stringify({
      access: unsupportedAccess,
      refresh: unsupportedRefresh,
      expires: 2_000_000_000_000,
    }), null);
    insertCredential.run(2, "retired-provider", JSON.stringify({
      access: disabledAccess,
      refresh: disabledRefresh,
      expires: 2_000_000_000_000,
    }), "retired");
    insertCredential.run(3, "openai-codex", codexData, null);
    const insertBlock = db.query(
      "INSERT INTO auth_credential_blocks(credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, '', 999999, 1)",
    );
    insertBlock.run(1, "retired-provider:oauth");
    insertBlock.run(2, "retired-provider:oauth");
    insertBlock.run(3, "openai-codex:oauth");
    const insertLease = db.query(
      "INSERT INTO auth_credential_refresh_leases(credential_id, owner, expires_at_ms, updated_at) VALUES (?, ?, 999999, 1)",
    );
    insertLease.run(1, "unsupported-active");
    insertLease.run(2, "unsupported-disabled");
    insertLease.run(3, "codex");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();

    expect(readFileSync(dbPath).includes(Buffer.from(unsupportedAccess))).toBe(true);
    await purgeUnsupportedCredentials(dbPath);

    const verified = new Database(dbPath, { readonly: true });
    try {
      expect(verified.query("SELECT id FROM auth_credentials WHERE provider = 'retired-provider'").all()).toEqual([]);
      expect(verified.query("SELECT credential_id FROM auth_credential_blocks WHERE credential_id IN (1, 2)").all()).toEqual([]);
      expect(verified.query("SELECT credential_id FROM auth_credential_refresh_leases WHERE credential_id IN (1, 2)").all()).toEqual([]);
      expect(verified.query("SELECT id, provider, data, disabled_cause FROM auth_credentials WHERE id = 3").get()).toEqual({
        id: 3,
        provider: "openai-codex",
        data: codexData,
        disabled_cause: null,
      });
      expect(verified.query("SELECT credential_id FROM auth_credential_blocks WHERE credential_id = 3").get()).toEqual({
        credential_id: 3,
      });
      expect(verified.query("SELECT credential_id FROM auth_credential_refresh_leases WHERE credential_id = 3").get()).toEqual({
        credential_id: 3,
      });
    } finally {
      verified.close();
    }

    for (const path of [dbPath, `${dbPath}-wal`]) {
      if (!existsSync(path)) continue;
      const bytes = readFileSync(path);
      for (const sentinel of [unsupportedAccess, unsupportedRefresh, disabledAccess, disabledRefresh]) {
        expect(bytes.includes(Buffer.from(sentinel))).toBe(false);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider environment scrubbing retains only allowed Google project hints", () => {
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
    GOOGLE_CLOUD_PROJECT: "allowed-project",
    GOOGLE_CLOUD_PROJECT_ID: "allowed-project-id",
  };
  scrubProviderEnvironment(environment);
  expect(environment).toEqual({
    GOOGLE_CLOUD_PROJECT: "allowed-project",
    GOOGLE_CLOUD_PROJECT_ID: "allowed-project-id",
  });
});
