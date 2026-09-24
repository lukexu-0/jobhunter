import { describe, expect, test } from "bun:test";
import { AuthorizationSession, type AuthorizationTransport } from "../app/lib/authorization-session";
import type { AuthSession, AuthStatusResponse } from "../app/lib/pipeline-contracts";

const disconnected: AuthStatusResponse = {
  providers: [
    { provider: "openai-codex", state: "disconnected" },
    { provider: "google-antigravity", state: "disconnected" },
    { provider: "gmail", state: "disconnected" },
  ],
};
const pending: AuthSession = {
  id: "gmail-session", provider: "gmail", state: "pending", progress: [], expiresAt: 60_000,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function fixture(overrides: Partial<AuthorizationTransport> = {}, initialStatus?: AuthStatusResponse) {
  const timers = new Set<() => void>();
  const transport: AuthorizationTransport = {
    getAuthStatus: async () => disconnected,
    getApplicationModel: async () => ({ model: "gpt-5.6-sol" }),
    setApplicationModel: async (model) => ({ model }),
    startAuthSession: async (provider) => ({ ...pending, provider }),
    getAuthSession: async () => pending,
    cancelAuthSession: async () => ({ ...pending, state: "cancelled" }),
    answerAuthPrompt: async () => pending,
    disconnectAuthProvider: async () => {},
    ...overrides,
  };
  const owner = new AuthorizationSession({
    transport, initialStatus,
    schedule: (callback) => { timers.add(callback); return () => { timers.delete(callback); }; },
  });
  owner.start();
  return {
    owner,
    tick: async () => {
      const ready = [...timers];
      timers.clear();
      ready.forEach((callback) => callback());
      await settle();
    },
  };
}

describe("authorization session ownership", () => {
  test("waits for a pending status request to complete before polling again", async () => {
    const response = deferred<AuthSession>();
    let requests = 0;
    const { owner, tick } = fixture({
      getAuthSession: async () => { requests += 1; return response.promise; },
    });
    try {
      await owner.connect("gmail");
      await tick();
      await tick();
      await tick();
      expect(requests).toBe(1);
      response.resolve({ ...pending, state: "succeeded" });
      await settle();
      await tick();
      expect(owner.getSnapshot().sessions.gmail?.state).toBe("succeeded");
      expect(requests).toBe(1);
    } finally {
      owner.stop();
    }
  });
  test("cancelling a session fences a late poll failure and allows a new connection", async () => {
    const oldPoll = deferred<AuthSession>();
    let connection = 0;
    const { owner, tick } = fixture({
      startAuthSession: async () => ({ ...pending, id: ++connection === 1 ? pending.id : "new-session" }),
      getAuthSession: async () => oldPoll.promise,
    });
    try {
      await owner.connect("gmail");
      await tick();
      await owner.cancel(pending);
      await owner.connect("gmail");
      oldPoll.reject(new Error("state=private-old-session"));
      await settle();
      expect(owner.getSnapshot().sessions.gmail?.id).toBe("new-session");
      expect(owner.getSnapshot().notices.gmail).toBeUndefined();
      expect(owner.getSnapshot().busy.gmail).toBeUndefined();
    } finally {
      owner.stop();
    }
  });
  test("retains useful state on transient failures without exposing credentials and clears a recovered poll error", async () => {
    const connected: AuthStatusResponse = { providers: [
      { provider: "openai-codex", state: "connected", identity: { email: "local@example.test" } },
      disconnected.providers[1], disconnected.providers[2],
    ] };
    let fail = true;
    const { owner, tick } = fixture({
      getAuthStatus: async () => { throw new Error("token=private-status"); },
      getAuthSession: async () => {
        if (fail) throw new Error("code=private-code state=private-state");
        return { ...pending, progress: ["Continue sign-in"] };
      },
    }, connected);
    try {
      await owner.connect("gmail");
      await tick();
      expect(owner.getSnapshot().authStatus).toEqual(connected);
      expect(owner.getSnapshot().statusError).not.toBeNull();
      expect(owner.getSnapshot().notices.gmail?.tone).toBe("error");
      expect(JSON.stringify(owner.getSnapshot())).not.toContain("private-");
      fail = false;
      await tick();
      expect(owner.getSnapshot().sessions.gmail?.progress).toEqual(["Continue sign-in"]);
      expect(owner.getSnapshot().notices.gmail).toBeUndefined();
    } finally {
      owner.stop();
    }
  });
  test("a model selection supersedes an older status read and cannot publish after its owner stops", async () => {
    const oldRead = deferred<{ model: "gpt-5.6-sol" }>();
    const lateWrite = deferred<{ model: "gpt-5.6-sol" }>();
    const { owner } = fixture({
      getApplicationModel: async () => oldRead.promise,
      setApplicationModel: async (model) => model === "gpt-5.6-sol" ? lateWrite.promise : { model },
    });
    await owner.selectModel("gemini-3.8-flash");
    oldRead.resolve({ model: "gpt-5.6-sol" });
    await settle();
    expect(owner.getSnapshot().applicationModel).toBe("gemini-3.8-flash");
    const writing = owner.selectModel("gpt-5.6-sol");
    owner.stop();
    const stopped = owner.getSnapshot();
    lateWrite.resolve({ model: "gpt-5.6-sol" });
    await writing;
    expect(owner.getSnapshot()).toBe(stopped);
  });
  test("restarting an effect lifetime releases abandoned actions and rejects its late connection", async () => {
    const abandoned = deferred<AuthSession>();
    const { owner } = fixture({ startAuthSession: async () => abandoned.promise });
    const connecting = owner.connect("gmail");
    owner.stop();
    owner.start();
    try {
      expect(owner.getSnapshot().busy.gmail).toBeUndefined();
      abandoned.resolve(pending);
      expect(await connecting).toBeUndefined();
      expect(owner.getSnapshot().sessions.gmail).toBeUndefined();
    } finally {
      owner.stop();
    }
  });
});
