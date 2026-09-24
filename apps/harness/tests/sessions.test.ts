import { expect, test } from "bun:test";

import type { ApplicationRunResult } from "../src/contracts/models.ts";
import { ApplicationAgentError } from "../src/application/application-agent.ts";
import {
  ApplicationSessionManager,
  type SessionWorker,
  type SessionWorkerContext,
} from "../src/host/sessions.ts";

class Worker implements SessionWorker {
  readonly modelMetadata = {
    model_provider: "openai-codex" as const,
    model: "gpt-5.6-sol" as const,
    reasoning: "medium" as const,
  };
  readonly #result: Promise<ApplicationRunResult>;
  readonly #finish: (result: ApplicationRunResult) => void;

  constructor() {
    const { promise, resolve } = Promise.withResolvers<ApplicationRunResult>();
    this.#result = promise;
    this.#finish = resolve;
  }

  async run(): Promise<ApplicationRunResult> {
    return this.#result;
  }

  finish(result: ApplicationRunResult): void {
    this.#finish(result);
  }

  async invoke(): Promise<undefined> {
    return undefined;
  }

  async close(): Promise<void> {}
}

class CloseRejectingWorker implements SessionWorker {
  readonly modelMetadata = {
    model_provider: "openai-codex" as const,
    model: "gpt-5.6-sol" as const,
    reasoning: "medium" as const,
  };
  readonly #promise: Promise<ApplicationRunResult>;
  readonly #reject: (reason?: unknown) => void;

  constructor() {
    const deferred = Promise.withResolvers<ApplicationRunResult>();
    this.#promise = deferred.promise;
    this.#reject = deferred.reject;
  }

  async run(): Promise<ApplicationRunResult> { return this.#promise; }
  async invoke(): Promise<undefined> { return undefined; }
  async close(): Promise<void> { this.#reject(new Error("closed")); await Bun.sleep(0); }
}

function upload(name: string): File {
  return new File(["fixture"], name);
}

function createInput(sessionId: string) {
  return {
    sessionId,
    jobUrl: "https://jobs.example.test/posting/42",
    opportunityKind: "job" as const,
    autoSubmit: false,
    autoEnd: false,
    personalInformation: upload("profile.yaml"),
    resume: upload("resume.pdf"),
    resumeSource: upload("resume.tex"),
    context: [],
    anecdotes: [],
  };
}

test("reserves eight application slots and rejects the ninth session", async () => {
  const slots: number[] = [];
  const manager = new ApplicationSessionManager({
    origin: "http://127.0.0.1:8865",
    workerFactory: async ({ slot }) => {
      slots.push(slot);
      return new Worker();
    },
  });

  for (let index = 1; index <= 8; index += 1) {
    const sessionId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    await expect(manager.create(createInput(sessionId))).resolves.toMatchObject({
      session_id: sessionId,
      state: "starting",
    });
  }

  await expect(manager.create(createInput("00000000-0000-4000-8000-000000000009"))).rejects.toMatchObject({
    statusCode: 409,
    code: "session_capacity",
    publicMessage: "Eight application sessions are already active",
  });
  expect(slots).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
});

test("retains a submitted session after one latched submission action", async () => {
  const worker = new Worker();
  let workerContext: SessionWorkerContext | undefined;
  const manager = new ApplicationSessionManager({
    origin: "http://127.0.0.1:8865",
    workerFactory: async (context) => {
      workerContext = context;
      return worker;
    },
  });
  const sessionId = "00000000-0000-4000-8000-000000000010";
  await manager.create(createInput(sessionId));
  expect(manager.getSnapshot(sessionId).state).toBe("running");

  workerContext!.markSubmissionStarted();
  expect(manager.getSnapshot(sessionId).state).toBe("submitting");
  worker.finish({
    status: "submitted",
    company: "Example Systems",
    role: "Engineer",
    job_url: "https://jobs.example.test/posting/42",
    final_url: "https://jobs.example.test/application/complete",
    fields_filled: [],
    fields_needing_human: [],
    files_attached: ["resume.pdf"],
    warnings: [],
    revision_count: 0,
    submit_attempted: true,
  });
  await Promise.resolve();
  await Promise.resolve();

  expect(manager.getSnapshot(sessionId)).toMatchObject({
    state: "submitted",
    company: "Example Systems",
    role: "Engineer",
    slot_released: false,
  });
  expect(manager.activeSessionCount).toBe(1);
});


test("rejects a submitted result before an approved action starts", async () => {
  const worker = new Worker();
  const manager = new ApplicationSessionManager({
    origin: "http://127.0.0.1:8865",
    workerFactory: async () => worker,
  });
  const sessionId = "00000000-0000-4000-8000-000000000011";
  await manager.create(createInput(sessionId));

  worker.finish({
    status: "submitted",
    company: "Example Systems",
    role: "Engineer",
    job_url: "https://jobs.example.test/posting/42",
    final_url: "https://jobs.example.test/application/complete",
    fields_filled: [],
    fields_needing_human: [],
    files_attached: ["resume.pdf"],
    warnings: [],
    revision_count: 0,
    submit_attempted: true,
  });
  await Promise.resolve();
  await Promise.resolve();

  expect(manager.getSnapshot(sessionId)).toMatchObject({
    state: "failed",
    error: { code: "invalid_model_output" },
    slot_released: true,
  });
});


test("rejects application creation while a source capture owns the browser", async () => {
  const manager = new ApplicationSessionManager({
    origin: "http://127.0.0.1:8865",
    workerFactory: async () => new Worker(),
    exclusiveOwner: () => "00000000-0000-4000-8000-000000000099",
  });

  await expect(manager.create(createInput("00000000-0000-4000-8000-000000000012"))).rejects.toMatchObject({
    statusCode: 409,
    code: "session_active",
    sessionId: "00000000-0000-4000-8000-000000000099",
  });
});


async function flushSessionTasks(): Promise<void> {
  for (let count = 0; count < 8; count += 1) await Promise.resolve();
}

test("parks agent failures for guided recovery in the same session", async () => {
  class RecoveringWorker implements SessionWorker {
    readonly modelMetadata = { model_provider: "openai-codex" as const, model: "gpt-5.6-sol" as const, reasoning: "medium" as const };
    runs = 0;
    guidance: readonly string[] | undefined;
    async run(recoveryGuidance?: readonly string[]): Promise<ApplicationRunResult> {
      this.runs += 1;
      this.guidance = recoveryGuidance;
      if (this.runs === 1) throw new ApplicationAgentError("usage_exhausted");
      return new Promise<ApplicationRunResult>(() => {});
    }
    async invoke(): Promise<undefined> { return undefined; }
    async close(): Promise<void> {}
  }
  const worker = new RecoveringWorker();
  const manager = new ApplicationSessionManager({
    origin: "http://127.0.0.1:8865", workerFactory: async () => worker,
  });
  const sessionId = "00000000-0000-4000-8000-000000000013";
  await manager.create(createInput(sessionId));
  await flushSessionTasks();

  expect(manager.getSnapshot(sessionId)).toMatchObject({
    state: "awaiting_human_navigation",
    pending_action: { type: "human_navigation" },
  });
  const recoveryAction = manager.getSnapshot(sessionId).pending_action;
  expect(recoveryAction?.type === "human_navigation" ? recoveryAction.instruction : "").toContain("usage quota is exhausted");
  await expect(manager.runtimeModelAction(sessionId, { type: "read_user_info" })).rejects.toMatchObject({
    statusCode: 409, code: "command_conflict",
  });
  await manager.command(sessionId, { type: "steer", message: "Use the connected provider" });
  await manager.command(sessionId, { type: "continue" });
  await flushSessionTasks();

  expect(worker.runs).toBe(2);
  expect(worker.guidance).toEqual(["Use the connected provider"]);
  expect(manager.getSnapshot(sessionId)).toMatchObject({ state: "running", pending_action: null });
  await manager.delete(sessionId);
});

test("rejects commands and runtime actions after a submission outcome", async () => {
  let context!: SessionWorkerContext;
  const manager = new ApplicationSessionManager({
    origin: "http://127.0.0.1:8865",
    workerFactory: async (value) => { context = value; return new Worker(); },
  });
  const sessionId = "00000000-0000-4000-8000-000000000014";
  await manager.create(createInput(sessionId));
  context.transition("submitted", "application_submitted");
  await expect(manager.command(sessionId, { type: "steer", message: "retry" })).rejects.toMatchObject({
    statusCode: 409, code: "command_conflict",
  });
  await expect(manager.runtimeAction(sessionId, { type: "playwright_cli", command: "snapshot", args: [] })).rejects.toMatchObject({
    statusCode: 409, code: "command_conflict",
  });
  await manager.delete(sessionId);
});


test("preserves pipeline error taxonomy during session startup", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000015";
  const manager = new ApplicationSessionManager({
    origin: "http://127.0.0.1:8865",
    workerFactory: async () => {
      throw new ApplicationAgentError("usage_exhausted");
    },
  });
  await expect(manager.create(createInput(sessionId))).rejects.toMatchObject({
    statusCode: 429, code: "usage_exhausted", publicMessage: "The model provider's usage quota is exhausted",
  });
  expect(manager.getSnapshot(sessionId)).toMatchObject({
    state: "failed", error: { code: "usage_exhausted", message: "The model provider's usage quota is exhausted" },
  });
});

test("keeps a closed tombstone when closing rejects the active worker run", async () => {
  const worker = new CloseRejectingWorker();
  const manager = new ApplicationSessionManager({
    origin: "http://127.0.0.1:8865",
    workerFactory: async () => worker,
  });
  const sessionId = "00000000-0000-4000-8000-000000000099";
  await manager.create(createInput(sessionId));

  await manager.delete(sessionId);

  expect(manager.getSnapshot(sessionId)).toMatchObject({ state: "closed", slot_released: true, pending_action: null });
  expect(manager.activeSessionCount).toBe(0);
});
