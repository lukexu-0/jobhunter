import { expect, test } from "bun:test";

import { ApplicationSessionWorker } from "../src/application/application-session-worker.ts";
import { DEFAULT_APPLICATION_CREDENTIALS } from "../src/application/application-account.ts";
import type { PlaywrightCliRuntime } from "../src/host/playwright-cli.ts";
import type { ApplicationRunResult, SessionSnapshot } from "../src/contracts/models.ts";
import type { SessionCreateInput, SessionWorkerContext } from "../src/host/sessions.ts";

class Runtime {
  async getCurrentPageUrl() { return "https://jobs.example.test/application"; }
  async suppressPrivateCapture() {}
  async activatePrivateValues(_values: readonly string[]) {}
  async signIn(_input: Record<string, string | undefined>) {}
  async openBrowser() {}
  async close() {}
}

const userInfoStore = {
  async merge() { return []; },
  async suggestions() { return []; },
  async readContents() { return "{}\n"; },
};

const input = {
  jobUrl: "https://jobs.example.test/posting/42",
  opportunityKind: "job",
  autoSubmit: false,
  autoEnd: false,
} as SessionCreateInput;

async function flush(): Promise<void> {
  for (let count = 0; count < 5; count += 1) await Promise.resolve();
}

test("runtime navigation gate publishes an actionable snapshot and resumes by command", async () => {
  const transitions: Array<{ state: string; event: string | null; patch?: unknown }> = [];
  const context: SessionWorkerContext = {
    sessionId: "00000000-0000-4000-8000-000000000030",
    slot: 0,
    input,
    transition(state, event, _detail, patch) { transitions.push({ state, event, patch }); },
    markSubmissionStarted() {},
  };
  const worker = new ApplicationSessionWorker({
    context,
    runtime: new Runtime() as PlaywrightCliRuntime,
    userInfoStore,
    applicationTask: "Apply to the requested role.",
    runtimeOrigin: "http://127.0.0.1:8765",
    agent: {
      modelMetadata: { modelProvider: "openai-codex", model: "gpt-5.6-sol", reasoning: "medium" },
      async run() { throw new Error("not used"); },
      async steer() {},
      async close() {},
    },
  });

  const action = worker.invoke({
    type: "runtime_action",
    action: { type: "request_human_navigation", instruction: "Complete the CAPTCHA" },
    modelAction: true,
  });
  await flush();

  expect(transitions.at(-1)).toMatchObject({
    state: "awaiting_human_navigation",
    event: "human_navigation_required",
    patch: { pending_action: { type: "human_navigation", instruction: "Complete the CAPTCHA" } },
  });

  await worker.invoke({ type: "command", command: { type: "continue" } });
  await expect(action).resolves.toEqual({ type: "continue" });
  await worker.close();
});


test("fresh install does not disclose blank default sign-in credentials to the agent", async () => {
  const worker = new ApplicationSessionWorker({
    context: {
      sessionId: "00000000-0000-4000-8000-000000000034", slot: 0, input,
      transition() {}, markSubmissionStarted() {},
    },
    runtime: new Runtime() as PlaywrightCliRuntime,
    userInfoStore,
    applicationTask: "Apply.",
    runtimeOrigin: "http://127.0.0.1:8765",
    ...(DEFAULT_APPLICATION_CREDENTIALS === undefined ? {} : { defaultCredentials: DEFAULT_APPLICATION_CREDENTIALS }),
    agent: {
      modelMetadata: { modelProvider: "openai-codex", model: "gpt-5.6-sol", reasoning: "medium" },
      async run() { throw new Error("not used"); }, async steer() {}, async close() {},
    },
  });
  try {
    await expect(worker.invoke({ type: "runtime_action", modelAction: true, action: { type: "get_credentials" } }))
      .rejects.toMatchObject({ statusCode: 409, code: "command_conflict" });
  } finally {
    await worker.close();
  }
});

test("projects human review fields into the live session snapshot", async () => {
  const transitions: Array<{ state: string; patch?: Partial<SessionSnapshot> }> = [];
  const context: SessionWorkerContext = {
    sessionId: "00000000-0000-4000-8000-000000000031", slot: 0,
    input: { ...input, autoSubmit: true },
    transition(state, _event, _detail, patch) { transitions.push({ state, ...(patch === undefined ? {} : { patch }) }); },
    markSubmissionStarted() {},
  };
  const worker = new ApplicationSessionWorker({
    context, runtime: new Runtime() as PlaywrightCliRuntime, userInfoStore,
    applicationTask: "Apply.", runtimeOrigin: "http://127.0.0.1:8765",
    agent: {
      modelMetadata: { modelProvider: "openai-codex", model: "gpt-5.6-sol", reasoning: "medium" },
      async run() { throw new Error("not used"); }, async steer() {}, async close() {},
    },
  });
  await worker.invoke({ type: "runtime_action", modelAction: true, action: {
    type: "request_human_review",
    result: {
      status: "ready_for_submission", company: "Example Systems", role: "Engineer",
      job_url: input.jobUrl, final_url: "https://jobs.example.test/application",
      fields_filled: [{ label: "Name", field_type: "text", value_present: true, note: "" }],
      fields_needing_human: [], files_attached: ["resume.pdf"], warnings: ["Review salary"],
      revision_count: 0, submit_attempted: false,
    },
  } });
  expect(transitions.some(({ patch }) => patch?.company === "Example Systems"
    && Array.isArray(patch.fields_filled) && patch?.files_attached?.[0] === "resume.pdf")).toBe(true);
  await worker.close();
});

test("publishes bounded redacted diagnostics and agent step for browser execution", async () => {
  const transitions: Array<{ event: string | null; detail: Record<string, unknown>; patch: Record<string, unknown> }> = [];
  const context: SessionWorkerContext = {
    sessionId: "00000000-0000-4000-8000-000000000032", slot: 0, input,
    transition(_state, event, detail = {}, patch = {}) { transitions.push({ event, detail: { ...detail }, patch: { ...patch } }); },
    markSubmissionStarted() {},
  };
  const runtime = Object.assign(new Runtime(), { async execute() { return {
    exitCode: 1, stdout: "", stderr: "private failure", timedOut: false,
    stdoutTruncated: false, stderrTruncated: true, cliErrorCategory: "unknown" as const,
    observation: { url: "https://jobs.example.test/application?token=private", title: "Apply", tabs: [], dom: "", pageInfo: null, screenshot: null },
  }; } });
  const worker = new ApplicationSessionWorker({
    context, runtime, userInfoStore, applicationTask: "Apply.", runtimeOrigin: "http://127.0.0.1:8765",
    agent: {
      modelMetadata: { modelProvider: "openai-codex", model: "gpt-5.6-sol", reasoning: "medium" },
      async run() { throw new Error("not used"); }, async steer() {}, async close() {},
    },
  });
  await worker.invoke({ type: "runtime_action", modelAction: true, action: { type: "playwright_cli", command: "snapshot", args: [] } });
  expect(transitions.at(-1)).toEqual({
    event: "agent_step",
    detail: { step_number: 1, current_url: "https://jobs.example.test/application" },
    patch: { playwright_cli_diagnostics: [{ step: 1, status: "failed", exit_code: 1, error_category: "process_exit", stderr_excerpt: "[redacted]", stderr_truncated: true }] },
  });
  await worker.close();
});


test("adds same-browser recovery instructions and operator guidance on rerun", async () => {
  let task = "";
  const context: SessionWorkerContext = {
    sessionId: "00000000-0000-4000-8000-000000000033", slot: 0, input,
    transition() {}, markSubmissionStarted() {},
  };
  const worker = new ApplicationSessionWorker({
    context, runtime: new Runtime() as PlaywrightCliRuntime, userInfoStore,
    applicationTask: JSON.stringify({ user_info: { saved_global: {}, saved_application: {} } }),
    runtimeOrigin: "http://127.0.0.1:8765",
    agent: {
      modelMetadata: { modelProvider: "openai-codex", model: "gpt-5.6-sol", reasoning: "medium" },
      async run(options) { task = options.task; return new Promise<ApplicationRunResult>(() => {}); },
      async steer() {}, async close() {},
    },
  });
  void worker.run(["Use the connected provider"]);
  await flush();
  expect(JSON.parse(task).recovery).toEqual({
    instruction: "The previous agent run stopped. The same browser is still open. Inspect the current page before taking any action. Do not replay the previous click or assume it failed. Obtain fresh final review before submitting. Never repeat a possible submission.",
    operator_guidance: ["Use the connected provider"],
  });
  await worker.close();
});
