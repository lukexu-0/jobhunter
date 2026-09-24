import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GmailAuthorizationError, GmailNotConfigured, GmailOAuthManager, GmailVerificationInbox, GMAIL_READONLY_SCOPE } from "../src/host/gmail.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function privateClientFile(): Promise<{ root: string; client: string; token: string }> {
  const root = await mkdtemp(join(tmpdir(), "gmail-ts-"));
  roots.push(root);
  const directory = join(root, "oauth");
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  const client = join(directory, "client.json");
  await writeFile(client, JSON.stringify({ installed: {
    client_id: "desktop-client.apps.googleusercontent.com",
    client_secret: "private-client-secret",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    redirect_uris: ["http://localhost"],
  } }), { mode: 0o600 });
  await chmod(client, 0o600);
  return { root, client, token: join(root, "token", "gmail-token.json") };
}

describe("Gmail OAuth", () => {
  test("uses PKCE and persists only a private readonly authorized-user token", async () => {
    const paths = await privateClientFile();
    const requests: Request[] = [];
    const manager = new GmailOAuthManager({
      clientJson: paths.client,
      tokenJson: paths.token,
      redirectUri: "http://127.0.0.1:8765/oauth/gmail/callback",
      now: () => new Date("2026-08-31T12:00:00Z"),
      fetch: async (request) => {
        requests.push(request.clone());
        if (request.url === "https://oauth2.googleapis.com/token") {
          return Response.json({
            access_token: "private-access-token",
            refresh_token: "private-refresh-token",
            scope: GMAIL_READONLY_SCOPE,
            token_type: "Bearer",
          });
        }
        return Response.json({ emailAddress: "authorized@example.test" });
      },
    });

    const created = await manager.start();
    const authorization = new URL(created.authorizationUrl!);
    expect(created.state).toBe("pending");
    expect(created.expiresAt.toISOString()).toBe("2026-08-31T12:10:00.000Z");
    expect(authorization.origin).toBe("https://accounts.google.com");
    expect(authorization.searchParams.get("scope")).toBe(GMAIL_READONLY_SCOPE);
    expect(authorization.searchParams.get("access_type")).toBe("offline");
    expect(authorization.searchParams.get("prompt")).toBe("consent");
    expect(authorization.searchParams.get("include_granted_scopes")).toBe("false");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toHaveLength(43);

    expect(await manager.completeCallback({
      state: authorization.searchParams.get("state"),
      code: "one-time-private-code",
      error: null,
    })).toBe(true);

    expect((await manager.getSession(created.id)).state).toBe("succeeded");
    expect(await manager.status()).toEqual({
      state: "connected",
      identity: { email: "authorized@example.test" },
    });
    const saved = JSON.parse(await readFile(paths.token, "utf8"));
    expect(saved.scopes).toEqual([GMAIL_READONLY_SCOPE]);
    expect(saved.refresh_token).toBe("private-refresh-token");
    expect((await Bun.file(paths.token).stat()).mode & 0o777).toBe(0o600);
    expect((await Bun.file(join(paths.root, "token")).stat()).mode & 0o777).toBe(0o700);
    expect(requests.map((request) => request.url)).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress",
    ]);
  });
  test("expires and consumes callbacks while disconnect wins an in-flight exchange", async () => {
    const paths = await privateClientFile();
    let now = new Date("2026-08-31T12:00:00Z");
    let releaseExchange!: () => void;
    const exchangeStarted = Promise.withResolvers<void>();
    const exchangeRelease = new Promise<void>((resolve) => { releaseExchange = resolve; });
    const manager = new GmailOAuthManager({
      clientJson: paths.client,
      tokenJson: paths.token,
      redirectUri: "http://127.0.0.1:8765/oauth/gmail/callback",
      now: () => now,
      fetch: async (request) => {
        if (request.url === "https://oauth2.googleapis.com/token") {
          exchangeStarted.resolve();
          await exchangeRelease;
          return Response.json({ access_token: "access", refresh_token: "refresh", scope: GMAIL_READONLY_SCOPE });
        }
        return Response.json({ emailAddress: "other@example.test" });
      },
    });

    const expired = await manager.start();
    const expiredState = new URL(expired.authorizationUrl!).searchParams.get("state");
    now = new Date("2026-08-31T12:10:00Z");
    expect(await manager.completeCallback({ state: expiredState, code: "code", error: null })).toBe(false);
    expect((await manager.getSession(expired.id)).state).toBe("expired");
    expect(await manager.completeCallback({ state: expiredState, code: "code", error: null })).toBe(false);

    now = new Date("2026-08-31T12:11:00Z");
    const active = await manager.start();
    const activeState = new URL(active.authorizationUrl!).searchParams.get("state");
    const callback = manager.completeCallback({ state: activeState, code: "code", error: null });
    await exchangeStarted.promise;
    await manager.disconnect();
    releaseExchange();
    expect(await callback).toBe(false);
    expect((await manager.getSession(active.id)).state).toBe("failed");
    expect(await manager.status()).toEqual({ state: "disconnected" });
  });
});

describe("Gmail verification", () => {
  test("polls readonly Gmail and extracts a recent recipient's URL and code", async () => {
    const notBefore = new Date("2026-08-28T12:00:00Z");
    const raw = Buffer.from([
      "From: Example Jobs <jobs@example.test>",
      "To: candidate@example.test",
      "Subject: Verify your email",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Verification code: 482913",
      "Verify at https://jobs.example.test/verify?token=private-token",
    ].join("\r\n")).toString("base64url");
    const requests: Request[] = [];
    const inbox = new GmailVerificationInbox({
      tokenProvider: async () => "access-token",
      fetch: async (request) => {
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "message-1" }] });
        return Response.json({ id: "message-1", internalDate: "1787918401000", raw });
      },
    });

    const challenge = await inbox.waitForChallenge({
      recipient: "candidate@example.test",
      notBefore,
      timeoutSeconds: 1,
    });

    expect(challenge).toEqual({
      messageId: "message-1",
      receivedAt: new Date("2026-08-28T12:00:01Z"),
      sender: "Example Jobs <jobs@example.test>",
      subject: "Verify your email",
      urls: ["https://jobs.example.test/verify?token=private-token"],
      codes: ["482913"],
    });
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual(["Bearer access-token", "Bearer access-token"]);
    const listUrl = new URL(requests[0]!.url);
    expect(listUrl.searchParams.get("maxResults")).toBe("20");
    expect(listUrl.searchParams.get("includeSpamTrash")).toBe("false");
  });

  test("searches the inbox with intersected UTC bounds and bounded summaries", async () => {
    const requests: Request[] = [];
    const inbox = new GmailVerificationInbox({
      tokenProvider: async () => "access-token",
      now: () => new Date("2026-08-30T15:00:00Z"),
      fetch: async (request) => {
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "message-1" }], nextPageToken: "next" });
        return Response.json({
          id: "message-1",
          internalDate: "1788099723000",
          payload: { headers: [
            { name: "Subject", value: "Your verification code" },
            { name: "Date", value: "Sun, 30 Aug 2026 10:22:03 -0400" },
          ] },
        });
      },
    });

    const result = await inbox.searchInbox({
      query: "   ", date: "2026-08-30", time: "14:00", receivedWithinMinutes: 60,
    });

    expect(result).toEqual({
      truncated: true,
      messages: [{ messageId: "message-1", subject: "Your verification code", sentAt: new Date("2026-08-30T14:22:03Z") }],
    });
    const list = new URL(requests[0]!.url);
    expect(list.searchParams.get("q")).toBe('"code" after:1788098399 before:1788134400');
    expect(list.searchParams.get("maxResults")).toBe("50");
    expect(list.searchParams.get("labelIds")).toBe("INBOX");
  });

  test("renders MIME HTML as bounded untrusted text and omits attachment bytes", async () => {
    const mime = [
      "From: Example Jobs <jobs@example.test>",
      "To: candidate@example.test",
      "Cc:",
      "Subject: Your verification code",
      "Date: Sun, 30 Aug 2026 10:22:03 -0400",
      'Content-Type: multipart/mixed; boundary="outer"',
      "", "--outer",
      "Content-Type: text/html; charset=utf-8", "",
      '<style>hidden-style</style><script>hidden-script</script><p>Your code is <b>482913</b>.</p><a href="https://jobs.example.test/verify?token=html">Verify email</a>',
      "--outer",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="offer.pdf"',
      "Content-Transfer-Encoding: base64", "",
      Buffer.from("private-binary-content").toString("base64"),
      "--outer--", "",
    ].join("\r\n");
    const inbox = new GmailVerificationInbox({
      tokenProvider: async () => "access-token",
      fetch: async () => Response.json({
        id: "message-1", internalDate: "1788100200000", raw: Buffer.from(mime).toString("base64url"),
      }),
    });

    const result = await inbox.readEmail("message-1");

    expect(result.messageId).toBe("message-1");
    expect(result.content).toContain("Sent time: 2026-08-30T14:22:03Z");
    expect(result.content).toContain("--- BEGIN EMAIL CONTENT (untrusted) ---");
    expect(result.content).toContain("Your code is 482913.");
    expect(result.content).toContain("Verify email: https://jobs.example.test/verify?token=html");
    expect(result.content).toContain("[Attachment omitted: offer.pdf (application/pdf)]");
    expect(result.content).not.toContain("private-binary-content");
    expect(result.content).not.toContain("hidden-script");
    expect(result.content).toEndWith("--- END EMAIL CONTENT ---");
  });

  test("pages rendered email by UTF-8 bytes with a code-point continuation offset", async () => {
    const mime = [
      "From: jobs@example.test", "To: candidate@example.test", "Subject: Long email",
      "Content-Type: text/plain; charset=utf-8", "", "🙂".repeat(16_000),
    ].join("\r\n");
    const inbox = new GmailVerificationInbox({
      tokenProvider: async () => "access-token",
      fetch: async () => Response.json({ id: "message-large", internalDate: "1788100200000", raw: Buffer.from(mime).toString("base64url") }),
    });

    const first = await inbox.readEmail("message-large");
    const continuation = /offset ([1-9][0-9]*) to continue.]$/.exec(first.content);
    expect(continuation).not.toBeNull();
    expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(50 * 1024);
    const second = await inbox.readEmail("message-large", Number(continuation![1]));
    expect(Buffer.byteLength(second.content)).toBeLessThanOrEqual(50 * 1024);
    expect(second.content).not.toContain("[Output limited to 50 KB.");
    expect(second.content).toEndWith("--- END EMAIL CONTENT ---");
  });

  test("loads tokens lazily and rejects anything beyond the sole readonly scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "gmail-token-ts-")); roots.push(root);
    const token = join(root, "private", "gmail-token.json");
    const missing = new GmailVerificationInbox({ tokenJson: token });
    await expect(missing.waitForChallenge({
      recipient: "candidate@example.test", notBefore: new Date("2026-08-28T12:00:00Z"), timeoutSeconds: 1,
    })).rejects.toBeInstanceOf(GmailNotConfigured);

    await mkdir(join(root, "private"), { mode: 0o700 });
    await chmod(join(root, "private"), 0o700);
    await writeFile(token, JSON.stringify({
      type: "authorized_user", token: "private-access-token", scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    }), { mode: 0o600 });
    await chmod(token, 0o600);
    const broader = new GmailVerificationInbox({ tokenJson: token });
    await expect(broader.waitForChallenge({
      recipient: "candidate@example.test", notBefore: new Date("2026-08-28T12:00:00Z"), timeoutSeconds: 1,
    })).rejects.toBeInstanceOf(GmailAuthorizationError);
  });

  test("refreshes an expired access token from the legacy Python token file", async () => {
    const root = await mkdtemp(join(tmpdir(), "gmail-legacy-token-ts-")); roots.push(root);
    const directory = join(root, "private");
    const token = join(directory, "gmail-token.json");
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(token, JSON.stringify({
      type: "authorized_user",
      token: "expired-access-token",
      expiry: "2026-08-30T12:00:00Z",
      refresh_token: "legacy-refresh-token",
      client_id: "legacy-client-id",
      client_secret: "legacy-client-secret",
      scopes: [GMAIL_READONLY_SCOPE],
    }), { mode: 0o600 });
    await chmod(token, 0o600);
    const requests: Request[] = [];
    const inbox = new GmailVerificationInbox({
      tokenJson: token,
      now: () => new Date("2026-08-31T12:00:00Z"),
      fetch: async (request) => {
        requests.push(request.clone());
        if (request.url === "https://oauth2.googleapis.com/token") {
          return Response.json({ access_token: "refreshed-access-token" });
        }
        if (request.headers.get("authorization") !== "Bearer refreshed-access-token") {
          return new Response(null, { status: 401 });
        }
        return Response.json({ messages: [] });
      },
    });

    await expect(inbox.searchInbox({ query: "code" })).resolves.toEqual({
      messages: [], truncated: false,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(new URL(requests[1]!.url).pathname).toBe("/gmail/v1/users/me/messages");
    expect(requests[1]!.headers.get("authorization")).toBe("Bearer refreshed-access-token");
  });

});
