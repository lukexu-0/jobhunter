import { describe, expect, test } from "bun:test";
import type {
  AuthCredentialEntry,
  OAuthCredential,
  StoredOAuthRefreshOptions,
  StoredOAuthRefreshResult,
} from "@oh-my-pi/pi-ai";
import { getGmailAccessToken, loginGmailOAuth } from "../src/gmail/oauth.ts";

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input.toString());
}

describe("Gmail OAuth", () => {
  test("authorizes read-only Gmail access and persists the connected account", async () => {
    const writes: Array<{ provider: string; credential: AuthCredentialEntry }> = [];
    const tokenBodies: URLSearchParams[] = [];
    let authorizationUrl: URL | undefined;
    let callbackResponse: Response | undefined;
    const callbackFinished = Promise.withResolvers<void>();
    const storage = {
      async set(provider: string, credential: AuthCredentialEntry): Promise<void> {
        writes.push({ provider, credential });
      },
    };
    const controller = {
      signal: new AbortController().signal,
      onAuth(info: { url: string }): void {
        authorizationUrl = new URL(info.url);
        const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
        const state = authorizationUrl.searchParams.get("state");
        if (!redirectUri || !state) throw new Error("missing callback parameters");
        void fetch(`${redirectUri}?code=test-authorization-code&state=${encodeURIComponent(state)}`)
          .then((response) => {
            callbackResponse = response;
            callbackFinished.resolve();
          });
      },
      onProgress(): void {},
      async onPrompt(): Promise<string> { throw new Error("unexpected prompt"); },
    };

    await loginGmailOAuth(storage, controller, {
      environment: {
        JOBHUNTER_GOOGLE_OAUTH_CLIENT_ID: "google-client-id.apps.googleusercontent.com",
        JOBHUNTER_GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
      },
      now: () => 1_800_000_000_000,
      fetch: async (input, init) => {
        const url = requestUrl(input);
        if (url.origin === "https://oauth2.googleapis.com") {
          const body = new URLSearchParams(init?.body?.toString());
          tokenBodies.push(body);
          return Response.json({
            access_token: "gmail-access-token",
            refresh_token: "gmail-refresh-token",
            expires_in: 3_600,
            token_type: "Bearer",
          });
        }
        if (url.pathname === "/gmail/v1/users/me/profile") {
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gmail-access-token");
          return Response.json({ emailAddress: "person@example.com" });
        }
        return new Response(null, { status: 404 });
      },
    });
    await callbackFinished.promise;

    expect(authorizationUrl?.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl?.pathname).toBe("/o/oauth2/v2/auth");
    expect(authorizationUrl?.searchParams.get("client_id")).toBe("google-client-id.apps.googleusercontent.com");
    expect(authorizationUrl?.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(authorizationUrl?.searchParams.get("access_type")).toBe("offline");
    expect(authorizationUrl?.searchParams.get("prompt")).toBe("consent");
    expect(authorizationUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl?.toString()).not.toContain("google-client-secret");
    expect(callbackResponse?.status).toBe(200);
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]?.get("code")).toBe("test-authorization-code");
    expect(tokenBodies[0]?.get("client_secret")).toBe("google-client-secret");
    expect(tokenBodies[0]?.get("code_verifier")?.length).toBeGreaterThanOrEqual(43);
    expect(writes).toEqual([{
      provider: "gmail",
      credential: {
        type: "oauth",
        access: "gmail-access-token",
        refresh: "gmail-refresh-token",
        expires: 1_800_003_600_000,
        accountId: "person@example.com",
        email: "person@example.com",
      },
    }]);
  });
  test("refreshes an expired Gmail token through durable storage ownership", async () => {
    let credential: OAuthCredential = {
      type: "oauth",
      access: "expired-access-token",
      refresh: "gmail-refresh-token",
      expires: 1_799_999_000_000,
      accountId: "person@example.com",
      email: "person@example.com",
    };
    let refreshBody: URLSearchParams | undefined;
    const storage = {
      getOAuthCredential(provider: string): OAuthCredential | undefined {
        return provider === "gmail" ? credential : undefined;
      },
      async refreshStoredOAuthCredential<T extends OAuthCredential = OAuthCredential>(
        provider: string,
        options: StoredOAuthRefreshOptions<T>,
      ): Promise<StoredOAuthRefreshResult<T>> {
        expect(provider).toBe("gmail");
        const current = options.credentialFromRow(credential);
        if (!current) return { credential: undefined, refreshed: false, removed: false };
        const refreshed = await options.refresh(current);
        credential = { ...credential, ...refreshed };
        return { credential: credential as T, refreshed: true, removed: false };
      },
    };

    const accessToken = await getGmailAccessToken(storage, {
      environment: {
        JOBHUNTER_GOOGLE_OAUTH_CLIENT_ID: "google-client-id.apps.googleusercontent.com",
        JOBHUNTER_GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
      },
      now: () => 1_800_000_000_000,
      fetch: async (_input, init) => {
        refreshBody = new URLSearchParams(init?.body?.toString());
        return Response.json({
          access_token: "refreshed-access-token",
          expires_in: 3_600,
          token_type: "Bearer",
        });
      },
    });

    expect(accessToken).toBe("refreshed-access-token");
    expect(refreshBody?.get("grant_type")).toBe("refresh_token");
    expect(refreshBody?.get("refresh_token")).toBe("gmail-refresh-token");
    expect(credential).toMatchObject({
      access: "refreshed-access-token",
      refresh: "gmail-refresh-token",
      expires: 1_800_003_600_000,
      email: "person@example.com",
    });
  });
});
