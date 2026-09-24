import { expect, test } from "bun:test";

import { createHarnessHandler } from "../src/host/server.ts";
import type { SessionCreateInput } from "../src/host/sessions.ts";

const token = "t".repeat(32);
const authorization = { authorization: `Bearer ${token}` };

function stubGmailAuth() {
  return {
    async status() { return { state: "disconnected" as const }; },
    async start() { throw new Error("not used"); },
    async getSession() { throw new Error("not used"); },
    async disconnect() {},
    async completeCallback() { return false; },
  };
}

test("creates an authenticated source capture from one strict JSON request", async () => {
  const calls: unknown[] = [];
  const handler = createHarnessHandler({ bearerToken: token }, {
    gmailAuth: stubGmailAuth(),
    sourceCaptures: {
      async create(input: { capture_id: string; job_url: string }) {
        calls.push(input);
        return { capture_id: input.capture_id, state: "awaiting_human_verification" as const };
      },
      async complete() { throw new Error("not used"); },
      async delete() { throw new Error("not used"); },
    },
  });

  const response = await handler(new Request("http://127.0.0.1:8765/v1/source-captures", {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({
      capture_id: "00000000-0000-4000-8000-000000000040",
      job_url: "https://jobs.example.test/posting/42",
    }),
  }));

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({
    capture_id: "00000000-0000-4000-8000-000000000040",
    state: "awaiting_human_verification",
  });
  expect(calls).toEqual([{
    capture_id: "00000000-0000-4000-8000-000000000040",
    job_url: "https://jobs.example.test/posting/42",
  }]);
});

test("rejects JSON requests with a non-JSON media type before dispatch", async () => {
  let creates = 0;
  const handler = createHarnessHandler({ bearerToken: token }, {
    gmailAuth: stubGmailAuth(),
    sourceCaptures: {
      async create() { creates += 1; return { capture_id: "unused", state: "awaiting_human_verification" as const }; },
      async complete() { throw new Error("not used"); },
      async delete() { throw new Error("not used"); },
    },
  });
  const response = await handler(new Request("http://127.0.0.1:8765/v1/source-captures", {
    method: "POST",
    headers: { ...authorization, "content-type": "text/plain" },
    body: JSON.stringify({
      capture_id: "00000000-0000-4000-8000-000000000040",
      job_url: "https://jobs.example.test/posting/42",
    }),
  }));

  expect(response.status).toBe(422);
  expect(creates).toBe(0);
});


test("rejects oversized JSON requests before body parsing", async () => {
  let creates = 0;
  const handler = createHarnessHandler({ bearerToken: token }, {
    gmailAuth: stubGmailAuth(),
    sourceCaptures: {
      async create() { creates += 1; return { capture_id: "unused", state: "awaiting_human_verification" as const }; },
      async complete() { throw new Error("not used"); },
      async delete() { throw new Error("not used"); },
    },
  });
  const request = new Request("http://127.0.0.1:8765/v1/source-captures", {
    method: "POST",
    headers: {
      ...authorization,
      "content-type": "application/json",
      "content-length": String(1024 * 1024 + 1),
    },
    body: JSON.stringify({
      capture_id: "00000000-0000-4000-8000-000000000040",
      job_url: "https://jobs.example.test/posting/42",
    }),
  });

  const response = await handler(request);

  expect(response.status).toBe(422);
  expect(request.bodyUsed).toBe(false);
  expect(creates).toBe(0);
});

test("stops streamed JSON requests at the request-size limit", async () => {
  let creates = 0;
  const handler = createHarnessHandler({ bearerToken: token }, {
    gmailAuth: stubGmailAuth(),
    sourceCaptures: {
      async create() { creates += 1; return { capture_id: "unused", state: "awaiting_human_verification" as const }; },
      async complete() { throw new Error("not used"); },
      async delete() { throw new Error("not used"); },
    },
  });
  const body = `${" ".repeat(1024 * 1024)}${JSON.stringify({
    capture_id: "00000000-0000-4000-8000-000000000040",
    job_url: "https://jobs.example.test/posting/42",
  })}`;
  const response = await handler(new Request("http://127.0.0.1:8765/v1/source-captures", {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body,
  }));

  expect(response.status).toBe(422);
  expect(creates).toBe(0);
});

test("completes a source capture only for an exact bodyless request", async () => {
  let completions = 0;
  const handler = createHarnessHandler({ bearerToken: token }, {
    gmailAuth: stubGmailAuth(),
    sourceCaptures: {
      async create() { throw new Error("not used"); },
      async complete(captureId) {
        completions += 1;
        return { capture_id: captureId, final_url: "https://jobs.example.test/application", source: "Rendered role" };
      },
      async delete() {},
    },
  });
  const path = "http://127.0.0.1:8765/v1/source-captures/00000000-0000-4000-8000-000000000040/complete";

  const rejected = await handler(new Request(path, { method: "POST", headers: authorization, body: "x" }));
  expect(rejected.status).toBe(422);
  expect(completions).toBe(0);

  const completed = await handler(new Request(path, { method: "POST", headers: authorization }));
  expect(completed.status).toBe(200);
  expect(await completed.json()).toEqual({
    capture_id: "00000000-0000-4000-8000-000000000040",
    final_url: "https://jobs.example.test/application",
    source: "Rendered role",
  });
  expect(completions).toBe(1);
});


test("deletes a source capture with no response body", async () => {
  const deleted: string[] = [];
  const handler = createHarnessHandler({ bearerToken: token }, {
    gmailAuth: stubGmailAuth(),
    sourceCaptures: {
      async create() { throw new Error("not used"); },
      async complete() { throw new Error("not used"); },
      async delete(captureId) { deleted.push(captureId); },
    },
  });
  const response = await handler(new Request(
    "http://127.0.0.1:8765/v1/source-captures/00000000-0000-4000-8000-000000000040",
    { method: "DELETE", headers: authorization },
  ));

  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect(deleted).toEqual(["00000000-0000-4000-8000-000000000040"]);
});


test("creates a session from strict multipart fields while preserving repeated uploads", async () => {
  const calls: unknown[] = [];
  const handler = createHarnessHandler({ bearerToken: token }, {
    gmailAuth: stubGmailAuth(),
    sessions: {
      async create(input: SessionCreateInput) {
        calls.push(input);
        return {
          session_id: input.sessionId!,
          state: "starting" as const,
          events_url: `http://127.0.0.1:8765/v1/sessions/${input.sessionId}/events`,
          commands_url: `http://127.0.0.1:8765/v1/sessions/${input.sessionId}/commands`,
        };
      },
    } as never,
  });
  const form = new FormData();
  form.append("session_id", "00000000-0000-4000-8000-000000000050");
  form.append("job_url", "https://jobs.example.test/posting/42?source=board");
  form.append("opportunity_kind", "hackathon");
  form.append("auto_submit", "true");
  form.append("auto_end", "false");
  form.append("personal_information", new File(["---\nfull_name: Ada Example\n---\nProfile"], "profile.md"));
  form.append("resume", new File(["%PDF-1.7"], "resume.pdf"));
  form.append("resume_source", new File(["Resume source"], "resume.tex"));
  form.append("context", new File(["first"], "first.md"));
  form.append("context", new File(["second"], "second.md"));
  form.append("anecdote", new File(["incident"], "incident.md"));

  const response = await handler(new Request("http://127.0.0.1:8765/v1/sessions", {
    method: "POST", headers: authorization, body: form,
  }));

  expect(response.status).toBe(202);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    sessionId: "00000000-0000-4000-8000-000000000050",
    jobUrl: "https://jobs.example.test/posting/42?source=board",
    opportunityKind: "hackathon",
    autoSubmit: true,
    autoEnd: false,
    context: [{ name: "first.md" }, { name: "second.md" }],
    anecdotes: [{ name: "incident.md" }],
  });
});


test("rejects session uploads with a non-multipart media type before body parsing", async () => {
  const handler = createHarnessHandler({ bearerToken: token }, {
    gmailAuth: stubGmailAuth(),
    sessions: { async create() { throw new Error("not used"); } } as never,
  });
  const request = new Request("http://127.0.0.1:8765/v1/sessions", {
    method: "POST",
    headers: { ...authorization, "content-type": "text/plain" },
    body: "not multipart",
  });

  const response = await handler(request);

  expect(response.status).toBe(422);
  expect(request.bodyUsed).toBe(false);
});

test("rejects declared oversized session uploads before body parsing", async () => {
  const handler = createHarnessHandler({ bearerToken: token }, {
    gmailAuth: stubGmailAuth(),
    sessions: { async create() { throw new Error("not used"); } } as never,
  });
  const request = new Request("http://127.0.0.1:8765/v1/sessions", {
    method: "POST",
    headers: {
      ...authorization,
      "content-type": "multipart/form-data; boundary=test-boundary",
      "content-length": String(160 * 1024 * 1024 + 1),
    },
    body: "--test-boundary--\r\n",
  });

  const response = await handler(request);

  expect(response.status).toBe(422);
  expect(request.bodyUsed).toBe(false);
});

test("accepts one strict session command and returns no content", async () => {
  const commands: unknown[] = [];
  const sessions = {
    async command(sessionId: string, command: unknown) { commands.push({ sessionId, command }); },
  };
  const handler = createHarnessHandler({ bearerToken: token }, { gmailAuth: stubGmailAuth(), sessions: sessions as never });
  const response = await handler(new Request(
    "http://127.0.0.1:8765/v1/sessions/00000000-0000-4000-8000-000000000050/commands",
    { method: "POST", headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify({ type: "continue" }) },
  ));

  expect(response.status).toBe(202);
  expect(await response.text()).toBe("");
  expect(commands).toEqual([{
    sessionId: "00000000-0000-4000-8000-000000000050",
    command: { type: "continue" },
  }]);
});
test("matches uppercase UUIDs on session routes", async () => {
  const sessionId = "00000000-0000-4000-8000-0000000000AA";
  const commands: unknown[] = [];
  const sessions = {
    async command(actualSessionId: string, command: unknown) {
      commands.push({ sessionId: actualSessionId, command });
    },
  };
  const handler = createHarnessHandler(
    { bearerToken: token },
    { gmailAuth: stubGmailAuth(), sessions: sessions as never },
  );

  const response = await handler(new Request(
    `http://127.0.0.1:8765/v1/sessions/${sessionId}/commands`,
    {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ type: "continue" }),
    },
  ));

  expect(response.status).toBe(202);
  expect(commands).toEqual([{ sessionId, command: { type: "continue" } }]);
});

test("keeps public and model runtime-action endpoints distinct", async () => {
  const calls: string[] = [];
  const sessions = {
    async runtimeAction(_sessionId: string, action: unknown) { calls.push("public:" + JSON.stringify(action)); return { type: "continue" }; },
    async runtimeModelAction(_sessionId: string, action: unknown) { calls.push("model:" + JSON.stringify(action)); return { type: "continue" }; },
  };
  const handler = createHarnessHandler({ bearerToken: token }, { gmailAuth: stubGmailAuth(), sessions: sessions as never });
  const root = "http://127.0.0.1:8765/v1/sessions/00000000-0000-4000-8000-000000000050/runtime";
  const options = { method: "POST", headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify({ type: "request_human_navigation", instruction: "Complete verification" }) };

  const publicResponse = await handler(new Request(root + "/actions", options));
  const modelResponse = await handler(new Request(root + "/model-actions", options));

  expect(publicResponse.status).toBe(200);
  expect(modelResponse.status).toBe(200);
  expect(calls.map((call) => call.split(":", 1)[0])).toEqual(["public", "model"]);
});
test("applies Unicode text semantics on public and model runtime routes", async () => {
  const instructions: string[] = [];
  const sessions = {
    async runtimeAction(_sessionId: string, action: { instruction: string }) {
      instructions.push(action.instruction);
      return { type: "continue" };
    },
    async runtimeModelAction(_sessionId: string, action: { instruction: string }) {
      instructions.push(action.instruction);
      return { type: "continue" };
    },
  };
  const handler = createHarnessHandler(
    { bearerToken: token },
    { gmailAuth: stubGmailAuth(), sessions: sessions as never },
  );
  const roots = [
    "http://127.0.0.1:8765/v1/sessions/00000000-0000-4000-8000-000000000050/runtime/actions",
    "http://127.0.0.1:8765/v1/sessions/00000000-0000-4000-8000-000000000050/runtime/model-actions",
  ];
  const emojiInstruction = "🙂".repeat(1_001);

  for (const root of roots) {
    for (const instruction of [emojiInstruction, "\uFEFF"]) {
      const response = await handler(new Request(root, {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ type: "request_human_navigation", instruction }),
      }));
      expect(response.status).toBe(200);
    }
    const invalid = await handler(new Request(root, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ type: "request_human_navigation", instruction: "before\uD800after" }),
    }));
    expect(invalid.status).toBe(422);
  }

  expect(instructions).toEqual([emojiInstruction, "\uFEFF", emojiInstruction, "\uFEFF"]);
});


test("rejects model-only actions on the public runtime route during validation", async () => {
  const calls: string[] = [];
  const sessions = {
    async runtimeAction() { calls.push("public"); return { type: "continue" }; },
    async runtimeModelAction(_sessionId: string, action: { type: string }) {
      calls.push(action.type);
      return { type: "continue" };
    },
  };
  const handler = createHarnessHandler({ bearerToken: token }, { gmailAuth: stubGmailAuth(), sessions: sessions as never });
  const root = "http://127.0.0.1:8765/v1/sessions/00000000-0000-4000-8000-000000000050/runtime";
  const modelOnlyActions = [
    { type: "get_credentials" },
    { type: "read_user_info" },
    { type: "read_inbox" },
    { type: "read_email", email_id: "message_42" },
  ];

  for (const action of modelOnlyActions) {
    const request = () => ({
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(action),
    });
    const publicResponse = await handler(new Request(root + "/actions", request()));
    const modelResponse = await handler(new Request(root + "/model-actions", request()));

    expect(publicResponse.status).toBe(422);
    expect(await publicResponse.json()).toEqual({ code: "invalid_request", message: "Request is invalid" });
    expect(modelResponse.status).toBe(200);
  }
  expect(calls).toEqual(modelOnlyActions.map(({ type }) => type));
});

test("returns the public session snapshot for an exact bodyless request", async () => {
  const snapshot = { session_id: "00000000-0000-4000-8000-000000000050", state: "running" };
  const sessions = { getSnapshot(sessionId: string) { expect(sessionId).toBe(snapshot.session_id); return snapshot; } };
  const handler = createHarnessHandler({ bearerToken: token }, { gmailAuth: stubGmailAuth(), sessions: sessions as never });

  const response = await handler(new Request(
    `http://127.0.0.1:8765/v1/sessions/${snapshot.session_id}`,
    { headers: authorization },
  ));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(snapshot);
});


test("opens the owned browser target only for a bodyless request", async () => {
  const opened: string[] = [];
  const sessions = { async openBrowser(sessionId: string) { opened.push(sessionId); } };
  const handler = createHarnessHandler({ bearerToken: token }, { gmailAuth: stubGmailAuth(), sessions: sessions as never });
  const path = "http://127.0.0.1:8765/v1/sessions/00000000-0000-4000-8000-000000000050/browser/open";

  const rejected = await handler(new Request(path, { method: "POST", headers: authorization, body: "{}" }));
  const response = await handler(new Request(path, { method: "POST", headers: authorization }));

  expect(rejected.status).toBe(422);
  expect(response.status).toBe(204);
  expect(opened).toEqual(["00000000-0000-4000-8000-000000000050"]);
});


test("returns bounded suggestions only for a valid pending question id", async () => {
  const sessions = { async suggestions(sessionId: string, questionId: string) {
    expect(sessionId).toBe("00000000-0000-4000-8000-000000000050");
    expect(questionId).toBe("availability");
    return { suggestions: [{ question: "When can you start?", answer: "June" }] };
  } };
  const handler = createHarnessHandler({ bearerToken: token }, { gmailAuth: stubGmailAuth(), sessions: sessions as never });
  const response = await handler(new Request(
    "http://127.0.0.1:8765/v1/sessions/00000000-0000-4000-8000-000000000050/additional-info/availability/suggestions",
    { headers: authorization },
  ));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ suggestions: [{ question: "When can you start?", answer: "June" }] });
});


test("deletes a session idempotently through a bodyless request", async () => {
  const deleted: string[] = [];
  const sessions = { async delete(sessionId: string) { deleted.push(sessionId); } };
  const handler = createHarnessHandler({ bearerToken: token }, { gmailAuth: stubGmailAuth(), sessions: sessions as never });
  const response = await handler(new Request(
    "http://127.0.0.1:8765/v1/sessions/00000000-0000-4000-8000-000000000050",
    { method: "DELETE", headers: authorization },
  ));

  expect(response.status).toBe(204);
  expect(deleted).toEqual(["00000000-0000-4000-8000-000000000050"]);
});


test("streams SSE heartbeats with replay cursor and buffering headers", async () => {
  const seen: Array<number | null | undefined> = [];
  const sessions = {
    getSnapshot() { return { state: "running" }; },
    subscribeEvents(_sessionId: string, lastEventId?: number | null) {
      seen.push(lastEventId);
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    },
  };
  const handler = createHarnessHandler({ bearerToken: token }, { gmailAuth: stubGmailAuth(), sessions: sessions as never });
  const response = await handler(new Request(
    "http://127.0.0.1:8765/v1/sessions/00000000-0000-4000-8000-000000000050/events",
    { headers: { ...authorization, "last-event-id": "2" } },
  ));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toStartWith("text/event-stream");
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  expect(await response.text()).toBe(": heartbeat\n\n");
  expect(seen).toEqual([2]);
});


test("streams the complete harness event in each SSE data field", async () => {
  const event = {
    id: 3,
    event: "agent_step",
    session: {
      session_id: "00000000-0000-4000-8000-000000000050",
      state: "running",
    },
    detail: { step_number: 2 },
  };
  const sessions = {
    getSnapshot() { return event.session; },
    subscribeEvents() {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(event);
          controller.close();
        },
      });
    },
  };
  const handler = createHarnessHandler({ bearerToken: token }, { gmailAuth: stubGmailAuth(), sessions: sessions as never });
  const response = await handler(new Request(
    "http://127.0.0.1:8765/v1/sessions/00000000-0000-4000-8000-000000000050/events",
    { headers: authorization },
  ));

  expect(response.status).toBe(200);
  expect(await response.text()).toBe(
    'id: 3\nevent: agent_step\ndata: {"id":3,"event":"agent_step","session":{"session_id":"00000000-0000-4000-8000-000000000050","state":"running"},"detail":{"step_number":2}}\n\n: heartbeat\n\n',
  );
});


test("returns only the existing session id for an active-session conflict", async () => {
  const sessions = { async create() {
    const error = new (await import("../src/host/artifacts.ts")).HarnessServiceError(409, "session_active", "private", "00000000-0000-4000-8000-000000000050");
    throw error;
  } };
  const handler = createHarnessHandler({ bearerToken: token }, { gmailAuth: stubGmailAuth(), sessions: sessions as never });
  const form = new FormData();
  form.append("job_url", "https://jobs.example.test/posting/42");
  form.append("opportunity_kind", "job");
  form.append("personal_information", new File(["profile"], "profile.md"));
  form.append("resume", new File(["pdf"], "resume.pdf"));
  form.append("resume_source", new File(["source"], "resume.tex"));
  const response = await handler(new Request("http://127.0.0.1:8765/v1/sessions", { method: "POST", headers: authorization, body: form }));

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    code: "session_active",
    session_id: "00000000-0000-4000-8000-000000000050",
  });
});
