import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  AuthStorage,
  type AuthCredentialEntry,
  type OAuthAccess,
  type OAuthCredential,
  type StoredAuthCredential,
  type StoredOAuthRefreshOptions,
  type StoredOAuthRefreshResult,
} from "@oh-my-pi/pi-ai";
import {
  INDEED_AUTHORIZATION_ENDPOINT,
  INDEED_ISSUER,
  INDEED_RESOURCE,
  INDEED_SCOPE,
  IndeedOAuthFlow,
  parseIndeedOAuthCredential,
  resolveIndeedAccessToken,
  type IndeedOAuthCredential,
} from "../src/auth/indeed-oauth.ts";
import { AuthService } from "../src/auth/service.ts";
import type { AuthStorageLike } from "../src/auth/storage.ts";

const CALLBACK_URI = "http://127.0.0.1:3456/api/pipeline/auth/indeed/callback";
const STATE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CODE = "callback-code-must-stay-private";

class FakeStorage implements AuthStorageLike {
  credential: IndeedOAuthCredential | undefined;

  async reload(): Promise<void> {}
  close(): void {}
  listStoredCredentials(provider?: string): StoredAuthCredential[] {
    if (!this.credential || (provider && provider !== "indeed")) return [];
    return [{ id: 1, provider: "indeed", credential: { ...this.credential }, disabledCause: null }];
  }
  getOAuthAccountIdentity(provider: string): { accountId?: string; email?: string } | undefined {
    if (provider !== "indeed" || !this.credential?.accountId) return undefined;
    return { accountId: this.credential.accountId };
  }
  getOAuthCredential(provider: string): OAuthCredential | undefined {
    return provider === "indeed" && this.credential ? { ...this.credential } : undefined;
  }
  async set(provider: string, credential: AuthCredentialEntry): Promise<void> {
    const selected = Array.isArray(credential) ? credential[0] : credential;
    const parsed = selected?.type === "oauth" ? parseIndeedOAuthCredential(selected) : undefined;
    if (provider !== "indeed" || !parsed) throw new Error("unexpected credential");
    this.credential = parsed;
  }
  async refreshStoredOAuthCredential<T extends OAuthCredential = OAuthCredential>(
    provider: string,
    options: StoredOAuthRefreshOptions<T>,
  ): Promise<StoredOAuthRefreshResult<T>> {
    if (provider !== "indeed" || !this.credential) {
      return { credential: undefined, refreshed: false, removed: false };
    }
    const current = options.credentialFromRow(this.credential);
    if (!current) return { credential: undefined, refreshed: false, removed: false };
    if (!options.forceRefresh && Date.now() + (options.refreshSkewMs ?? 0) < current.expires) {
      return { credential: current, refreshed: false, removed: false };
    }
    const refreshSignal = new AbortController().signal;
    let refreshed: Awaited<ReturnType<typeof options.refresh>>;
    try {
      refreshed = await options.refresh(current, refreshSignal);
    } catch (error) {
      if (options.isDefinitiveFailure?.(error)) {
        this.credential = undefined;
        return { credential: undefined, refreshed: false, removed: true };
      }
      throw error;
    }
    const merged = options.mergeRefreshedCredential
      ? options.mergeRefreshedCredential(current, refreshed)
      : { ...current, ...refreshed } as T;
    const stored = parseIndeedOAuthCredential(merged);
    if (!stored) throw new Error("unexpected refreshed credential");
    this.credential = stored;
    return { credential: merged, refreshed: true, removed: false };
  }
  async getOAuthAccess(): Promise<OAuthAccess | undefined> { return undefined; }
  async login(): Promise<void> { throw new Error("Indeed must not use model-provider login"); }
  async logout(provider: string): Promise<void> {
    if (provider === "indeed") this.credential = undefined;
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "content-type": "application/json" } });
}

type TestFetchHandler = (...args: Parameters<typeof fetch>) => Promise<Response>;

function testFetch(handler: TestFetchHandler): typeof fetch {
  return Object.assign(handler, { preconnect: () => undefined });
}

function flowFetch(storage: FakeStorage, options: { tokenResponse?: Record<string, unknown> } = {}) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = testFetch(async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === "https://secure.indeed.com/oauth/v2/register") {
      return json({
        client_id: "indeed-client-1",
        client_id_issued_at: 1_700_000_000,
        client_name: "Jobhunter",
        redirect_uris: [CALLBACK_URI],
        scope: INDEED_SCOPE,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }, 201);
    }
    if (url === "https://apis.indeed.com/oauth/v2/tokens") {
      return json(options.tokenResponse ?? {
        access_token: "indeed-access-secret",
        refresh_token: "indeed-refresh-secret",
        expires_in: 3_600,
        token_type: "bearer",
      });
    }
    throw new Error(`unexpected fetch target ${url}`);
  });
  const tokens = [STATE, VERIFIER];
  const flow = new IndeedOAuthFlow(storage, {
    redirectUri: CALLBACK_URI,
    fetch: fetchImpl,
    now: () => 1_700_000_000_000,
    randomToken: () => tokens.shift()!,
    schedule: () => undefined,
  });
  return { flow, requests };
}

describe("Indeed OAuth authorization code flow", () => {
  test("publishes the exact least-privilege flow and stores a connected status without identity", async () => {
    const storage = new FakeStorage();
    const { flow, requests } = flowFetch(storage);
    const service = new AuthService(storage, {
      indeedOAuth: flow,
      randomId: () => "AAAAAAAAAAAAAAAAAAAAAA",
      schedule: () => undefined,
      now: () => 1_700_000_000_000,
    });

    const started = await service.startSession("indeed");
    const authorization = new URL(started.url!);
    expect(`${authorization.origin}${authorization.pathname}`).toBe(INDEED_AUTHORIZATION_ENDPOINT);
    expect([...authorization.searchParams.keys()].sort()).toEqual([
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "redirect_uri",
      "resource",
      "response_type",
      "scope",
      "state",
    ]);
    expect(authorization.searchParams.get("client_id")).toBe("indeed-client-1");
    expect(authorization.searchParams.get("redirect_uri")).toBe(CALLBACK_URI);
    expect(authorization.searchParams.get("response_type")).toBe("code");
    expect(authorization.searchParams.get("scope")).toBe(INDEED_SCOPE);
    expect(authorization.searchParams.get("state")).toBe(STATE);
    expect(authorization.searchParams.get("code_challenge")).toBe(CHALLENGE);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("resource")).toBe(INDEED_RESOURCE);
    expect(started.launchUrl).toBeUndefined();
    expect(started.instructions).toContain("Claude Connector only");
    expect(started.instructions).toContain("Indeed approval");

    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      client_name: "Jobhunter",
      redirect_uris: [CALLBACK_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "job_seeker.jobs.search offline_access",
    });

    await service.completeIndeedCallback({ code: CODE, state: STATE, issuer: INDEED_ISSUER });
    await Promise.resolve();
    const completed = service.getSession(started.id);
    expect(completed?.state).toBe("succeeded");
    expect(completed?.url).toBeUndefined();
    expect(JSON.stringify(completed)).not.toContain(STATE);
    expect(JSON.stringify(completed)).not.toContain(CODE);

    const tokenForm = new URLSearchParams(String(requests[1]!.init?.body));
    expect([...tokenForm.keys()].sort()).toEqual([
      "client_id",
      "code",
      "code_verifier",
      "grant_type",
      "redirect_uri",
      "resource",
    ]);
    expect(tokenForm.get("grant_type")).toBe("authorization_code");
    expect(tokenForm.get("client_id")).toBe("indeed-client-1");
    expect(tokenForm.get("code")).toBe(CODE);
    expect(tokenForm.get("redirect_uri")).toBe(CALLBACK_URI);
    expect(tokenForm.get("code_verifier")).toBe(VERIFIER);
    expect(tokenForm.get("resource")).toBe(INDEED_RESOURCE);
    expect(requests).toHaveLength(2);
    expect(storage.credential).toMatchObject({
      type: "oauth",
      access: "indeed-access-secret",
      refresh: "indeed-refresh-secret",
      clientId: "indeed-client-1",
    });
    expect(storage.credential?.accountId).toBeUndefined();
    const status = service.getAuthStatus();
    expect(status.providers).toEqual([
      { provider: "openai-codex", state: "disconnected" },
      { provider: "indeed", state: "connected" },
    ]);
    expect(JSON.stringify(status)).not.toContain("indeed-access-secret");
    expect(JSON.stringify(status)).not.toContain("indeed-refresh-secret");
  });

  test("rejects authorization responses without a refresh token or with changed scopes", async () => {
    const invalidResponses = [
      {
        access_token: "indeed-access-secret",
        expires_in: 3_600,
        token_type: "Bearer",
      },
      {
        access_token: "indeed-access-secret",
        refresh_token: "indeed-refresh-secret",
        expires_in: 3_600,
        token_type: "Bearer",
        scope: "job_seeker.profile.read offline_access",
      },
    ];
    for (const tokenResponse of invalidResponses) {
      const storage = new FakeStorage();
      const { flow } = flowFetch(storage, { tokenResponse });
      const published = Promise.withResolvers<void>();
      const login = flow.login({
        onAuth: () => published.resolve(),
        onPrompt: async () => "",
      }).catch(() => undefined);
      await published.promise;
      await expect(flow.completeCallback({
        code: CODE,
        state: STATE,
        issuer: INDEED_ISSUER,
      })).rejects.toMatchObject({
        code: "AUTH_CALLBACK_INVALID",
        message: "Indeed authentication callback was rejected",
      });
      await login;
      expect(storage.credential).toBeUndefined();
    }
  });


  test("consumes a bounded OAuth denial without reflecting provider details", async () => {
    const storage = new FakeStorage();
    const { flow, requests } = flowFetch(storage);
    const published = Promise.withResolvers<void>();
    const login = flow.login({
      onAuth: () => published.resolve(),
      onPrompt: async () => "",
    }).catch((error) => error as Error);
    await published.promise;

    await expect(flow.completeCallback({
      state: STATE,
      issuer: INDEED_ISSUER,
      error: "access_denied",
      errorDescription: "denial-description-must-stay-private",
      errorUri: "https://secure.indeed.com/oauth/errors/access_denied",
    })).rejects.toMatchObject({
      code: "AUTH_CALLBACK_INVALID",
      message: "Indeed authentication callback was rejected",
      status: 400,
    });
    const loginError = await login;
    expect(loginError).toBeInstanceOf(Error);
    if (!(loginError instanceof Error)) throw new Error("login unexpectedly succeeded");
    expect(loginError.message).toBe("Indeed authentication callback was rejected");
    expect(loginError.message).not.toContain("denial-description-must-stay-private");
    await expect(flow.completeCallback({ code: CODE, state: STATE, issuer: INDEED_ISSUER })).rejects.toMatchObject({
      code: "AUTH_CALLBACK_INVALID",
    });
    expect(storage.credential).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  test("reports unsupported dynamic registration safely and transparently", async () => {
    const storage = new FakeStorage();
    const flow = new IndeedOAuthFlow(storage, {
      redirectUri: CALLBACK_URI,
      schedule: () => undefined,
      fetch: testFetch(async () => json({
        error: "unsupported_client_metadata",
        error_description: "registration-secret-must-not-leak",
      }, 400)),
    });
    const service = new AuthService(storage, {
      indeedOAuth: flow,
      randomId: () => "BBBBBBBBBBBBBBBBBBBBBB",
      schedule: () => undefined,
    });
    const failed = await service.startSession("indeed");
    expect(failed.state).toBe("failed");
    expect(failed.progress.join(" ")).toContain("Claude Connector only");
    expect(JSON.stringify(failed)).not.toContain("registration-secret-must-not-leak");
  });
  test("consumes invalid, replayed, expired, and cancelled state exactly once", async () => {
    const missingIssuerStorage = new FakeStorage();
    const missingIssuer = flowFetch(missingIssuerStorage).flow;
    const missingIssuerPublished = Promise.withResolvers<void>();
    const missingIssuerLogin = missingIssuer.login({
      onAuth: () => missingIssuerPublished.resolve(),
      onPrompt: async () => "",
    }).catch(() => undefined);
    await missingIssuerPublished.promise;
    await expect(missingIssuer.completeCallback({ code: CODE, state: STATE }))
      .rejects.toMatchObject({ code: "AUTH_CALLBACK_INVALID", status: 400 });
    await expect(missingIssuer.completeCallback({ code: CODE, state: STATE, issuer: INDEED_ISSUER }))
      .rejects.toMatchObject({ code: "AUTH_CALLBACK_INVALID", status: 400 });
    await missingIssuerLogin;

    const invalidIssuerStorage = new FakeStorage();
    const invalidIssuer = flowFetch(invalidIssuerStorage).flow;
    const invalidPublished = Promise.withResolvers<void>();
    const invalidLogin = invalidIssuer.login({ onAuth: () => invalidPublished.resolve(), onPrompt: async () => "" }).catch(() => undefined);
    await invalidPublished.promise;
    await expect(invalidIssuer.completeCallback({ code: CODE, state: STATE, issuer: `${INDEED_ISSUER}/` }))
      .rejects.toMatchObject({ code: "AUTH_CALLBACK_INVALID", status: 400 });
    await expect(invalidIssuer.completeCallback({ code: CODE, state: STATE, issuer: INDEED_ISSUER }))
      .rejects.toMatchObject({ code: "AUTH_CALLBACK_INVALID", status: 400 });
    await invalidLogin;

    let now = 1_700_000_000_000;
    const expiredStorage = new FakeStorage();
    const expiredTokens = [STATE, VERIFIER];
    const expired = new IndeedOAuthFlow(expiredStorage, {
      redirectUri: CALLBACK_URI,
      fetch: (async (input) => {
        if (String(input).endsWith("/register")) return json({
          client_id: "indeed-client-1",
          redirect_uris: [CALLBACK_URI],
          scope: INDEED_SCOPE,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }, 201);
        throw new Error("expired state must fail before token exchange");
      }) as typeof fetch,
      now: () => now,
      randomToken: () => expiredTokens.shift()!,
      schedule: () => undefined,
    });
    const expiredPublished = Promise.withResolvers<void>();
    const expiredLogin = expired.login({ onAuth: () => expiredPublished.resolve(), onPrompt: async () => "" }).catch(() => undefined);
    await expiredPublished.promise;
    now += 10 * 60_000 + 1;
    await expect(expired.completeCallback({ code: CODE, state: STATE, issuer: INDEED_ISSUER }))
      .rejects.toMatchObject({ code: "AUTH_CALLBACK_EXPIRED", status: 400 });
    await expiredLogin;

    const cancelledStorage = new FakeStorage();
    const cancelledFlow = flowFetch(cancelledStorage).flow;
    const cancelledService = new AuthService(cancelledStorage, {
      indeedOAuth: cancelledFlow,
      randomId: () => "CCCCCCCCCCCCCCCCCCCCCC",
      schedule: () => undefined,
    });
    const cancelledStarted = await cancelledService.startSession("indeed");
    expect(new URL(cancelledStarted.url!).searchParams.get("state")).toBe(STATE);
    const cancelledSession = cancelledService.cancelSession(cancelledStarted.id);
    expect(cancelledSession?.state).toBe("cancelled");
    expect(cancelledSession?.url).toBeUndefined();
    expect(JSON.stringify(cancelledSession)).not.toContain(STATE);
    await expect(cancelledService.completeIndeedCallback({ code: CODE, state: STATE, issuer: INDEED_ISSUER }))
      .rejects.toMatchObject({ code: "AUTH_CALLBACK_INVALID", status: 400 });
  });

  test("redacts token endpoint failures and makes their state unreplayable", async () => {
    const storage = new FakeStorage();
    const requests: string[] = [];
    const tokens = [STATE, VERIFIER];
    const flow = new IndeedOAuthFlow(storage, {
      redirectUri: CALLBACK_URI,
      randomToken: () => tokens.shift()!,
      schedule: () => undefined,
      fetch: (async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/register")) return json({
          client_id: "indeed-client-1",
          redirect_uris: [CALLBACK_URI],
          scope: INDEED_SCOPE,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }, 201);
        return json({
          error: "invalid_grant",
          error_description: `${CODE} token=upstream-secret`,
        }, 400);
      }) as typeof fetch,
    });
    const published = Promise.withResolvers<void>();
    const login = flow.login({
      onAuth: () => published.resolve(),
      onPrompt: async () => "",
    }).catch((error) => error as Error);
    await published.promise;
    await expect(flow.completeCallback({ code: CODE, state: STATE, issuer: INDEED_ISSUER })).rejects.toMatchObject({
      code: "AUTH_CALLBACK_INVALID",
      message: "Indeed authentication callback was rejected",
      definitive: false,
    });
    const loginError = await login;
    expect(loginError).toBeInstanceOf(Error);
    if (!(loginError instanceof Error)) throw new Error("expected a bounded login failure");
    expect(loginError.message).toBe("Indeed authentication callback was rejected");
    expect(loginError.message).not.toContain(CODE);
    expect(loginError.message).not.toContain("upstream-secret");
    await expect(flow.completeCallback({ code: CODE, state: STATE, issuer: INDEED_ISSUER })).rejects.toMatchObject({
      code: "AUTH_CALLBACK_INVALID",
    });
    expect(storage.credential).toBeUndefined();
    expect(requests).toHaveLength(2);
  });
});

describe("Indeed access token refresh", () => {
  test("durably stores a rotating refresh token and returns only the fresh access token", async () => {
    const storage = new FakeStorage();
    storage.credential = {
      type: "oauth",
      access: "expired-access",
      refresh: "old-refresh",
      expires: 1,
      clientId: "indeed-client-1",
    };
    let refreshForm: Record<string, string> | undefined;
    const access = await resolveIndeedAccessToken(storage, undefined, {
      fetch: (async (input, init) => {
        expect(String(input)).toBe("https://apis.indeed.com/oauth/v2/tokens");
        refreshForm = Object.fromEntries(new URLSearchParams(String(init?.body)));
        return json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3_600,
          token_type: "Bearer",
          scope: INDEED_SCOPE,
        });
      }) as typeof fetch,
      now: () => 2_000_000_000_000,
    });
    expect(access).toBe("rotated-access");
    expect(refreshForm).toEqual({
      grant_type: "refresh_token",
      client_id: "indeed-client-1",
      refresh_token: "old-refresh",
      resource: INDEED_RESOURCE,
    });
    expect(storage.credential).toMatchObject({
      access: "rotated-access",
      refresh: "rotated-refresh",
      clientId: "indeed-client-1",
    });
  });

  test("preserves the current refresh token when a tolerant refresh response omits scope and rotation", async () => {
    const storage = new FakeStorage();
    storage.credential = {
      type: "oauth",
      access: "expired-access",
      refresh: "current-refresh",
      expires: 1,
      clientId: "indeed-client-1",
    };
    const access = await resolveIndeedAccessToken(storage, undefined, {
      fetch: testFetch(async () => json({
        access_token: "fresh-access",
        expires_in: 3_600,
        token_type: "bEaReR",
      })),
      now: () => 2_000_000_000_000,
    });
    expect(access).toBe("fresh-access");
    expect(storage.credential).toMatchObject({
      access: "fresh-access",
      refresh: "current-refresh",
      clientId: "indeed-client-1",
    });
  });

  test("retires fake stored credentials only for definitive refresh OAuth failures", async () => {
    const definitiveFailures = [
      { status: 400, error: "invalid_grant" },
      { status: 401, error: "invalid_client" },
      { status: 400, error: "unauthorized_client" },
    ];
    for (const failure of definitiveFailures) {
      const storage = new FakeStorage();
      storage.credential = {
        type: "oauth",
        access: "expired-access",
        refresh: "current-refresh",
        expires: 1,
        clientId: "indeed-client-1",
      };
      await expect(resolveIndeedAccessToken(storage, undefined, {
        fetch: testFetch(async () => json({
          error: failure.error,
          error_description: "refresh-provider-secret",
        }, failure.status)),
      })).rejects.toMatchObject({
        code: "INDEED_AUTH_REQUIRED",
        message: "Connect Indeed before searching jobs",
      });
      expect(storage.credential).toBeUndefined();
    }

    const retryable = new FakeStorage();
    retryable.credential = {
      type: "oauth",
      access: "expired-access",
      refresh: "current-refresh",
      expires: 1,
      clientId: "indeed-client-1",
    };
    await expect(resolveIndeedAccessToken(retryable, undefined, {
      fetch: testFetch(async () => json({ error: "invalid_grant" }, 403)),
    })).rejects.toMatchObject({
      code: "AUTH_CALLBACK_INVALID",
      definitive: false,
    });
    expect(retryable.credential?.refresh).toBe("current-refresh");
  });

  test("preserves caller cancellation while a durable refresh request is in flight", async () => {
    const storage = new FakeStorage();
    storage.credential = {
      type: "oauth",
      access: "expired-access",
      refresh: "current-refresh",
      expires: 1,
      clientId: "indeed-client-1",
    };
    const caller = new AbortController();
    const fetchStarted = Promise.withResolvers<void>();
    const resolving = resolveIndeedAccessToken(storage, caller.signal, {
      fetch: testFetch(async (_input, init) => {
        fetchStarted.resolve();
        const requestSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
        });
      }),
    });
    await fetchStarted.promise;
    caller.abort(new DOMException("discovery cancelled", "AbortError"));
    await expect(resolving).rejects.toMatchObject({
      name: "AbortError",
      message: "discovery cancelled",
    });
    expect(storage.credential?.refresh).toBe("current-refresh");
  });

  test("durably retires a real stored credential after a definitive refresh rejection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jobhunter-indeed-refresh-"));
    const path = join(directory, "auth.sqlite");
    try {
      const first = await AuthStorage.create(path);
      await first.reload();
      await first.set("indeed", {
        type: "oauth",
        access: "expired-access",
        refresh: "current-refresh",
        expires: 1,
        clientId: "registered-public-client",
      } as IndeedOAuthCredential);
      await expect(resolveIndeedAccessToken(first, undefined, {
        fetch: testFetch(async () => json({
          error: "invalid_client",
          error_description: "refresh-provider-secret",
        }, 401)),
      })).rejects.toMatchObject({
        code: "INDEED_AUTH_REQUIRED",
      });
      expect(first.getOAuthCredential("indeed")).toBeUndefined();
      first.close();

      const reopened = await AuthStorage.create(path);
      await reopened.reload();
      expect(reopened.getOAuthCredential("indeed")).toBeUndefined();
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("round-trips the public client registration in the protected OAuth credential row", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jobhunter-indeed-auth-"));
    const path = join(directory, "auth.sqlite");
    try {
      const first = await AuthStorage.create(path);
      await first.reload();
      await first.set("indeed", {
        type: "oauth",
        access: "stored-access",
        refresh: "stored-refresh",
        expires: 2_000_000_000_000,
        clientId: "registered-public-client",
      } as IndeedOAuthCredential);
      first.close();

      const reopened = await AuthStorage.create(path);
      await reopened.reload();
      expect(reopened.getOAuthCredential("indeed")).toMatchObject({
        type: "oauth",
        clientId: "registered-public-client",
      });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

});
