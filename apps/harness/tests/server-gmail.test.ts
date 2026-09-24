import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GmailOAuthManager } from "../src/host/gmail.ts";
import { createHarnessHandler } from "../src/host/server.ts";

function createHandler() {
  const missingRoot = join(tmpdir(), `jobhunt-gmail-${randomUUID()}`);
  const gmailAuth = new GmailOAuthManager({
    clientJson: join(missingRoot, "client.json"),
    tokenJson: join(missingRoot, "token.json"),
    redirectUri: "http://127.0.0.1:8865/oauth/gmail/callback",
  });
  return createHarnessHandler(
    { bearerToken: "test-token" },
    { gmailAuth },
  );
}

test("rejects an invalid Gmail authorization session identifier", async () => {
  const response = await createHandler()(
    new Request("http://127.0.0.1/v1/gmail-auth/sessions/not-valid", {
      headers: { authorization: "Bearer test-token" },
    }),
  );

  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({
    code: "invalid_request",
    message: "Request is invalid",
  });
});

test("disconnects Gmail authorization idempotently", async () => {
  const response = await createHandler()(
    new Request("http://127.0.0.1/v1/gmail-auth", {
      method: "DELETE",
      headers: { authorization: "Bearer test-token" },
    }),
  );

  expect(response.status).toBe(204);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("");
});

test("starts Gmail authorization with the HTTP session contract", async () => {
  const expiresAt = new Date("2026-09-17T12:00:00.000Z");
  const gmailAuth = {
    async status() { return { state: "disconnected" as const }; },
    async start() {
      return {
        id: "A".repeat(43),
        state: "pending" as const,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=opaque",
        expiresAt,
      };
    },
    async getSession() { throw new Error("not used"); },
    async disconnect() {},
    async completeCallback() { return false; },
  };
  const handler = createHarnessHandler({ bearerToken: "test-token" }, { gmailAuth });

  const response = await handler(new Request("http://127.0.0.1/v1/gmail-auth/sessions", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: "{}",
  }));

  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    id: "A".repeat(43),
    state: "pending",
    authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?state=opaque",
    expires_at: "2026-09-17T12:00:00.000Z",
  });
});

test("polls Gmail authorization with the HTTP session contract", async () => {
  const sessionId = "B".repeat(43);
  const gmailAuth = {
    async status() { return { state: "disconnected" as const }; },
    async start() { throw new Error("not used"); },
    async getSession(id: string) {
      expect(id).toBe(sessionId);
      return {
        id,
        state: "pending" as const,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=poll",
        expiresAt: new Date("2026-09-17T12:05:00.000Z"),
      };
    },
    async disconnect() {},
    async completeCallback() { return false; },
  };
  const handler = createHarnessHandler({ bearerToken: "test-token" }, { gmailAuth });

  const response = await handler(new Request(
    "http://127.0.0.1/v1/gmail-auth/sessions/" + sessionId,
    { headers: { authorization: "Bearer test-token" } },
  ));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    id: sessionId,
    state: "pending",
    authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?state=poll",
    expires_at: "2026-09-17T12:05:00.000Z",
  });
});

test("completes Gmail OAuth without bearer auth and returns locked-down HTML", async () => {
  const callbacks: unknown[] = [];
  const gmailAuth = {
    async status() { return { state: "disconnected" as const }; },
    async start() { throw new Error("not used"); },
    async getSession() { throw new Error("not used"); },
    async disconnect() {},
    async completeCallback(input: unknown) { callbacks.push(input); return true; },
  };
  const handler = createHarnessHandler({ bearerToken: "test-token" }, { gmailAuth });
  const response = await handler(new Request(
    "http://127.0.0.1/oauth/gmail/callback?state=abc&code=code&iss=https%3A%2F%2Faccounts.google.com",
  ));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(await response.text()).toContain("Gmail connected. You may close this window.");
  expect(callbacks).toEqual([{ state: "abc", code: "code", error: null }]);
});
