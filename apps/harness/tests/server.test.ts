import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GmailOAuthManager } from "../src/host/gmail.ts";
import { createHarnessHandler, startHarnessServer } from "../src/host/server.ts";

function gmailManagerWithMissingStorage(): GmailOAuthManager {
  const missingRoot = join(tmpdir(), `jobhunt-gmail-${randomUUID()}`);
  return new GmailOAuthManager({
    clientJson: join(missingRoot, "client.json"),
    tokenJson: join(missingRoot, "token.json"),
    redirectUri: "http://127.0.0.1:8865/oauth/gmail/callback",
  });
}

describe("harness HTTP service", () => {
  test("reports health without authentication", async () => {
    const handler = createHarnessHandler({ bearerToken: "test-token" });

    const response = await handler(new Request("http://127.0.0.1/healthz"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("keeps long-running requests open beyond Bun's default timeout", async () => {
    const server = startHarnessServer(0, async () => {
      await Bun.sleep(12_500);
      return new Response("completed");
    });

    try {
      const response = await fetch(server.url, { timeout: false } as RequestInit & { timeout: false });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("completed");
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("rejects unauthenticated API requests", async () => {
    const handler = createHarnessHandler({ bearerToken: "test-token" });

    const response = await handler(new Request("http://127.0.0.1/v1/unknown"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      code: "unauthorized",
      message: "Unauthorized",
    });
  });

  test("accepts only the exact bearer authorization value", async () => {
    const handler = createHarnessHandler({ bearerToken: "test-token" });

    const wrongScheme = await handler(
      new Request("http://127.0.0.1/v1/unknown", {
        headers: { authorization: "bearer test-token" },
      }),
    );
    const extraSeparator = await handler(
      new Request("http://127.0.0.1/v1/unknown", {
        headers: { authorization: "Bearer  test-token" },
      }),
    );
    const accepted = await handler(
      new Request("http://127.0.0.1/v1/unknown", {
        headers: { authorization: "Bearer test-token" },
      }),
    );

    expect(wrongScheme.status).toBe(401);
    expect(extraSeparator.status).toBe(401);
    expect(accepted.status).toBe(404);
  });

  test("reports disconnected Gmail authorization through the authenticated API", async () => {
    const handler = createHarnessHandler(
      { bearerToken: "test-token" },
      { gmailAuth: gmailManagerWithMissingStorage() },
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/gmail-auth", {
        headers: { authorization: "Bearer test-token" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ state: "disconnected" });
  });

  test("rejects a declared body on the Gmail status endpoint", async () => {
    const handler = createHarnessHandler(
      { bearerToken: "test-token" },
      { gmailAuth: gmailManagerWithMissingStorage() },
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/gmail-auth", {
        headers: {
          authorization: "Bearer test-token",
          "content-length": "1",
        },
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      code: "invalid_request",
      message: "Request is invalid",
    });
  });

  test("rejects nonempty Gmail authorization session input", async () => {
    const handler = createHarnessHandler(
      { bearerToken: "test-token" },
      { gmailAuth: gmailManagerWithMissingStorage() },
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/gmail-auth/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ unexpected: true }),
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      code: "invalid_request",
      message: "Request is invalid",
    });
  });

  test("returns the public Gmail service error when authorization cannot start", async () => {
    const handler = createHarnessHandler(
      { bearerToken: "test-token" },
      { gmailAuth: gmailManagerWithMissingStorage() },
    );

    const response = await handler(
      new Request("http://127.0.0.1/v1/gmail-auth/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "gmail_oauth_unavailable",
      message: "Gmail connection is unavailable",
    });
  });
});
