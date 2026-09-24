import { expect, test } from "bun:test";
import type {
  GmailAuthHarnessClient,
  GmailAuthSession,
  GmailAuthStatus,
} from "../src/api/application-harness-client";
import { createGmailAuthProviderHooks } from "../src/auth/gmail-provider";

const SESSION_ID = "A".repeat(43);

class FakeGmailHarness implements GmailAuthHarnessClient {
  readonly calls: string[] = [];
  readonly signals: AbortSignal[] = [];
  readonly sessions: GmailAuthSession[] = [{
    id: SESSION_ID,
    state: "pending",
    expiresAt: Date.parse("2026-08-31T20:15:00Z"),
  }, {
    id: SESSION_ID,
    state: "succeeded",
    expiresAt: Date.parse("2026-08-31T20:15:00Z"),
  }];

  async getGmailAuth(signal: AbortSignal): Promise<GmailAuthStatus> {
    this.calls.push("status");
    this.signals.push(signal);
    return { state: "connected", identity: { email: "person@example.test" } };
  }

  async createGmailAuthSession(signal: AbortSignal): Promise<GmailAuthSession> {
    this.calls.push("create");
    this.signals.push(signal);
    return {
      id: SESSION_ID,
      state: "pending",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=opaque",
      expiresAt: Date.parse("2026-08-31T20:15:00Z"),
    };
  }

  async getGmailAuthSession(sessionId: string, signal: AbortSignal): Promise<GmailAuthSession> {
    this.calls.push(`poll:${sessionId}`);
    this.signals.push(signal);
    return this.sessions.shift()!;
  }

  async deleteGmailAuth(signal: AbortSignal): Promise<void> {
    this.calls.push("delete");
    this.signals.push(signal);
  }
}

test("Gmail provider opens authorization and polls the harness until success", async () => {
  const harness = new FakeGmailHarness();
  const pollSignals: AbortSignal[] = [];
  const hooks = createGmailAuthProviderHooks(harness, {
    waitForPoll: async (signal) => { pollSignals.push(signal); },
  });
  const controller = new AbortController();
  const authorizationUrls: string[] = [];

  await hooks.login({
    signal: controller.signal,
    onAuth: ({ url }) => authorizationUrls.push(url),
    onProgress: () => undefined,
    onPrompt: async () => "",
    onManualCodeInput: async () => "",
  });
  hooks.assertConnected();

  expect(authorizationUrls).toEqual([
    "https://accounts.google.com/o/oauth2/v2/auth?state=opaque",
  ]);
  expect(harness.calls).toEqual([
    "create",
    `poll:${SESSION_ID}`,
    `poll:${SESSION_ID}`,
  ]);
  expect(harness.signals).toEqual([
    controller.signal,
    controller.signal,
    controller.signal,
  ]);
  expect(pollSignals).toEqual([controller.signal, controller.signal]);
  await expect(hooks.status()).resolves.toEqual({
    state: "connected",
    identity: { email: "person@example.test" },
  });
  await hooks.logout();
  expect(harness.calls.slice(-2)).toEqual(["status", "delete"]);
});
test("Gmail provider stops polling immediately when authorization is aborted", async () => {
  const harness = new FakeGmailHarness();
  const hooks = createGmailAuthProviderHooks(harness);
  const controller = new AbortController();
  const login = hooks.login({
    signal: controller.signal,
    onAuth: () => undefined,
    onProgress: () => undefined,
    onPrompt: async () => "",
    onManualCodeInput: async () => "",
  });
  await Promise.resolve();
  const reason = new DOMException("User cancelled", "AbortError");
  controller.abort(reason);

  await expect(login).rejects.toBe(reason);
  expect(harness.calls).toEqual(["create"]);
});
