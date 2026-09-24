import { afterEach, expect, test } from "bun:test";
import {
  createApplicationSession,
  type ApplicationSessionTransport,
  type ApplicationSessionRun,
} from "../app/lib/application-session";
import type {
  ApplicationSessionSnapshotDto,
  ApplicationSessionView,
} from "../app/lib/pipeline-contracts";

const run: ApplicationSessionRun = {
  id: "run-1",
  revision: 1,
  status: "approved",
  currentPdfSha256: "a".repeat(64),
};
function snapshot(
  overrides: Partial<ApplicationSessionSnapshotDto> = {},
): ApplicationSessionSnapshotDto {
  return {
    generation: 1,
    bridgeState: "awaiting_human_review",
    harnessState: "awaiting_human_review",
    submissionPhase: "not_attempted",
    createdAt: 1,
    updatedAt: 2,
    terminalAt: null,
    expiresAt: 100,
    company: "Example",
    role: "Engineer",
    fieldsFilled: [],
    fieldsNeedingHuman: [],
    filesAttached: [],
    warnings: [],
    revisionCount: 0,
    playwrightCliDiagnostics: [],
    pendingAction: { type: "human_review" },
    error: null,
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const lifetimes: AbortController[] = [];
afterEach(() => {
  lifetimes.splice(0).forEach((controller) => controller.abort());
});
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function fixture(
  initial: ApplicationSessionView = snapshot(),
  overrides: Partial<ApplicationSessionTransport> = {},
) {
  const controller = new AbortController();
  lifetimes.push(controller);
  let view: ApplicationSessionView = initial;
  const reads: AbortSignal[] = [];
  const commands: unknown[] = [];
  const timers = new Set<() => void>();
  const transport: ApplicationSessionTransport = {
    get: async (_id, signal) => {
      reads.push(signal);
      return view;
    },
    start: async () => view,
    retry: async () => view,
    command: async (_id, command) => { commands.push(command); },
    close: async () => {},
    openBrowser: async () => {},
    ...overrides,
  };
  const session = createApplicationSession(run, {
    signal: controller.signal,
    transport,
    schedule: (callback) => {
      timers.add(callback);
      return () => { timers.delete(callback); };
    },
  });
  return {
    session,
    transport,
    commands,
    reads,
    controller,
    timers,
    setView: (next: ApplicationSessionView) => { view = next; },
    tick: async () => {
      const ready = [...timers];
      timers.clear();
      ready.forEach((callback) => callback());
      await flush();
    },
  };
}

test("accepted submit delivery stays busy until its authoritative projection arrives", async () => {
  const f = fixture();
  await flush();
  const delivered = await f.session.dispatch({ type: "submit" });
  expect(delivered.status).toBe("accepted");
  expect(f.session.getSnapshot().actionBusy).toBe("submit");
  await f.session.dispatch({ type: "submit" });
  expect(f.commands).toEqual([{ type: "submit" }]);
  f.setView(snapshot({ updatedAt: 3, revisionCount: 1 }));
  await f.tick();
  expect(f.session.getSnapshot().actionBusy).toBe("submit");
  f.setView(snapshot({ updatedAt: 4, bridgeState: "submitting", submissionPhase: "attempting", pendingAction: null }));
  await f.tick();
  expect(f.session.getSnapshot().actionBusy).toBeNull();
});

test("uncertain reserved cancellation reconciles after its recovery GET also fails, without replaying DELETE", async () => {
  const f = fixture(snapshot({ bridgeState: "reserved", harnessState: null, pendingAction: null }));
  await flush();
  let deletes = 0;
  f.transport.close = async () => { deletes += 1; throw new Error("connection lost"); };
  f.transport.get = async () => { throw new Error("offline"); };
  expect((await f.session.dispatch({ type: "cancel" })).status).toBe("ambiguous");
  expect(f.session.getSnapshot().actionBusy).toBe("cancel");
  f.transport.get = async () => snapshot({ bridgeState: "closed", updatedAt: 3, pendingAction: null });
  await f.tick();
  expect(f.session.getSnapshot().actionBusy).toBeNull();
  expect(f.session.getSnapshot().view).toMatchObject({ bridgeState: "closed" });
  expect(deletes).toBe(1);
});

test("unknown availability permits resume approval but does not start or repeat a mutation", async () => {
  let starts = 0;
  const f = fixture(snapshot(), {
    get: async () => { throw new Error("offline"); },
    start: async () => { starts += 1; return snapshot(); },
  });
  await flush();
  expect(f.session.getSnapshot().view).toBeNull();
  expect(f.session.getSnapshot().approvalAllowed).toBeTrue();
  expect(starts).toBe(0);
  f.transport.get = async () => ({ state: "not_started", canStart: false, canStartAfterApproval: false, blockedReason: "harness_unconfigured" });
  f.session.updateRun({ ...run, status: "review" });
  await flush();
  expect(f.session.getSnapshot().approvalAllowed).toBeFalse();
  expect(starts).toBe(0);
});

test("a submission projection cannot release the gate while HTTP delivery is pending", async () => {
  const delivery = deferred<void>();
  const f = fixture(snapshot(), { command: () => delivery.promise });
  await flush();
  const dispatch = f.session.dispatch({ type: "submit" });
  f.setView(snapshot({
    updatedAt: 3,
    bridgeState: "awaiting_human_navigation",
    submissionPhase: "attempting",
    pendingAction: { type: "human_navigation", instruction: "Complete CAPTCHA" },
  }));
  await f.tick();
  expect(f.session.getSnapshot().actionBusy).toBe("submit");
  delivery.resolve();
  expect((await dispatch).status).toBe("accepted");
  expect(f.session.getSnapshot().actionBusy).toBeNull();
});

test("ambiguous submission keeps its gate locked through replay and reconciles without resubmitting", async () => {
  const f = fixture();
  await flush();
  let submissions = 0;
  f.transport.command = async () => { submissions += 1; throw new Error("connection lost"); };
  expect((await f.session.dispatch({ type: "submit" })).status).toBe("ambiguous");
  f.setView(snapshot({ updatedAt: 3, company: "Reconnected" }));
  await f.tick();
  expect(f.session.getSnapshot().actionBusy).toBe("submit");
  expect((await f.session.dispatch({ type: "submit" })).status).toBe("rejected");
  f.setView(snapshot({ updatedAt: 4, bridgeState: "submission_uncertain", submissionPhase: "uncertain", pendingAction: null }));
  await f.tick();
  expect(f.session.getSnapshot().actionBusy).toBeNull();
  expect(submissions).toBe(1);
});

test("End session supersedes cancellation and ignores its late failure", async () => {
  const cancellation = deferred<void>();
  const f = fixture(snapshot({ bridgeState: "running", pendingAction: null }), { command: () => cancellation.promise });
  await flush();
  const cancel = f.session.dispatch({ type: "cancel" });
  f.transport.close = async () => { f.setView(snapshot({ bridgeState: "closed", updatedAt: 3, pendingAction: null })); };
  expect((await f.session.dispatch({ type: "close" })).status).toBe("accepted");
  expect(f.session.getSnapshot().actionBusy).toBeNull();
  cancellation.reject(new Error("late rejection"));
  await cancel;
  expect(f.session.getSnapshot().error).toBeNull();
  expect(f.session.getSnapshot().view).toMatchObject({ bridgeState: "closed" });
});

test("same-scope status and PDF changes refresh availability without losing pending delivery", async () => {
  const delivery = deferred<void>();
  const f = fixture(snapshot(), { command: () => delivery.promise });
  await flush();
  const request = f.session.dispatch({ type: "revise", context: "Correct the salary" });
  const nextRun = { ...run, status: "review" as const, currentPdfSha256: "b".repeat(64) };
  f.session.updateRun(nextRun);
  await flush();
  expect(f.reads).toHaveLength(2);
  expect(f.reads[1]!.aborted).toBeFalse();
  expect(f.session.getSnapshot().actionBusy).toBe("revise");
  delivery.resolve();
  await request;
  expect(f.session.getSnapshot().actionBusy).toBe("revise");
  f.setView(snapshot({ revisionCount: 1, updatedAt: 3 }));
  await f.tick();
  expect(f.session.getSnapshot().actionBusy).toBeNull();
});

test("revision changes abort the old lifetime and fence old mutation and read responses", async () => {
  const start = deferred<ApplicationSessionView>();
  const oldRead = deferred<ApplicationSessionView>();
  let mutationSignal: AbortSignal | undefined;
  const f = fixture(snapshot({ bridgeState: "reserved", pendingAction: null }), {
    start: (_id, _hash, signal) => { mutationSignal = signal; return start.promise; },
  });
  await flush();
  const resume = f.session.dispatch({ type: "resume" });
  f.transport.get = () => oldRead.promise;
  await f.tick();
  f.transport.get = async () => ({ state: "not_started", canStart: false, canStartAfterApproval: true });
  f.session.updateRun({ ...run, revision: 2, status: "review" });
  await flush();
  expect(mutationSignal?.aborted).toBeTrue();
  start.resolve(snapshot({ generation: 50, bridgeState: "running", updatedAt: 80 }));
  oldRead.resolve(snapshot({ generation: 50, updatedAt: 90 }));
  await resume;
  await flush();
  expect(f.session.getSnapshot().view).toMatchObject({ state: "not_started" });
  expect(f.session.getSnapshot().actionBusy).toBeNull();
  f.controller.abort();
  expect(f.timers.size).toBe(0);
});

test("steering ambiguity keeps the draft delivery blocked until an authoritative gate change", async () => {
  const f = fixture();
  await flush();
  let sends = 0;
  f.transport.command = async () => { sends += 1; throw new Error("connection lost"); };
  expect((await f.session.dispatch({ type: "steer", message: "Check the salary" })).status).toBe("ambiguous");
  expect(f.session.getSnapshot().steeringState).toBe("ambiguous");
  f.setView(snapshot({ updatedAt: 3 }));
  await f.tick();
  expect((await f.session.dispatch({ type: "steer", message: "Check the salary" })).status).toBe("rejected");
  f.setView(snapshot({
    updatedAt: 4,
    pendingAction: { type: "human_navigation", instruction: "Complete CAPTCHA" },
    bridgeState: "awaiting_human_navigation",
  }));
  await f.tick();
  expect(f.session.getSnapshot().steeringState).toBe("idle");
  expect(sends).toBe(1);
});

test("credentials stay busy through an unchanged gate and settle when the generation advances", async () => {
  const credentials = snapshot({ bridgeState: "awaiting_human_navigation", pendingAction: { type: "credentials" } });
  const f = fixture(credentials);
  await flush();
  await f.session.dispatch({ type: "sign_in", username: "applicant@example.test", password: "fake-fixture-password" });
  f.setView({ ...credentials, updatedAt: 3 });
  await f.tick();
  expect(f.session.getSnapshot().actionBusy).toBe("sign_in");
  f.setView({ ...credentials, generation: 2, updatedAt: 4 });
  await f.tick();
  expect(f.session.getSnapshot().actionBusy).toBeNull();
});

test("continuing without answers waits for the exact additional-information gate to change", async () => {
  const question = { id: "location", scope: "application" as const, question: "Where can you work?", answerType: "text" as const };
  const before = snapshot({ bridgeState: "awaiting_additional_info", pendingAction: { type: "additional_info", questions: [question] } });
  const f = fixture(before);
  await flush();
  await f.session.dispatch({ type: "continue_without_additional_info" });
  f.setView({ ...before, updatedAt: 3 });
  await f.tick();
  expect(f.session.getSnapshot().actionBusy).toBe("continue_without_additional_info");
  f.setView({
    ...before,
    updatedAt: 4,
    pendingAction: {
      type: "additional_info",
      questions: [{ ...question, question: "Where can you commute?" }],
    },
  });
  await f.tick();
  expect(f.session.getSnapshot().actionBusy).toBeNull();
});

test("terminal retry reconciles ambiguous delivery only when a newer generation appears", async () => {
  const failed = snapshot({ bridgeState: "failed", pendingAction: null });
  let retries = 0;
  const f = fixture(failed, { retry: async () => { retries += 1; throw new Error("connection lost"); } });
  await flush();
  await f.session.dispatch({ type: "retry" });
  f.setView({ ...failed, updatedAt: 3 });
  await f.tick();
  expect(f.session.getSnapshot().actionBusy).toBe("retry");
  f.setView(snapshot({ generation: 2, bridgeState: "running", updatedAt: 4, pendingAction: null }));
  await f.tick();
  expect(f.session.getSnapshot().actionBusy).toBeNull();
  expect(retries).toBe(1);
});

test("older generation, replayed time, and terminal resurrection cannot replace accepted projections", async () => {
  const current = snapshot({ generation: 2, updatedAt: 10 });
  const f = fixture(current);
  await flush();
  f.setView(snapshot({ generation: 1, updatedAt: 20 }));
  await f.tick();
  expect(f.session.getSnapshot().view).toBe(current);
  f.setView(snapshot({ generation: 2, updatedAt: 9 }));
  await f.tick();
  expect(f.session.getSnapshot().view).toBe(current);
  const terminal = snapshot({ generation: 2, bridgeState: "closed", updatedAt: 11, pendingAction: null });
  f.setView(terminal);
  await f.tick();
  f.setView(snapshot({ generation: 2, updatedAt: 12 }));
  f.session.updateRun({ ...run, currentPdfSha256: "b".repeat(64) });
  await flush();
  expect(f.session.getSnapshot().view).toBe(terminal);
});

test("unchanged reconciliation preserves the observable snapshot and does not notify subscribers", async () => {
  const f = fixture();
  await flush();
  const before = f.session.getSnapshot();
  let notifications = 0;
  const unsubscribe = f.session.subscribe(() => { notifications += 1; });
  await f.tick();
  expect(f.session.getSnapshot()).toBe(before);
  expect(notifications).toBe(0);
  unsubscribe();
});

test("confirmed review revision releases ambiguous steering while unchanged review projections retain the block", async () => {
  const f = fixture();
  await flush();
  let guidance = 0;
  f.transport.command = async (_id, command) => {
    if (command.type === "steer") {
      guidance += 1;
      if (guidance === 1) throw new Error("delivery uncertain");
    }
  };
  expect((await f.session.dispatch({ type: "steer", message: "Check salary" })).status).toBe("ambiguous");
  expect((await f.session.dispatch({ type: "revise", context: "Correct salary" })).status).toBe("accepted");
  f.setView(snapshot({ updatedAt: 3 }));
  await f.tick();
  expect(f.session.getSnapshot().steeringState).toBe("ambiguous");
  expect(f.session.getSnapshot().actionBusy).toBe("revise");
  expect((await f.session.dispatch({ type: "steer", message: "Check corrected salary" })).status).toBe("rejected");
  f.setView(snapshot({ updatedAt: 4, revisionCount: 1 }));
  await f.tick();
  expect(f.session.getSnapshot().actionBusy).toBeNull();
  expect(f.session.getSnapshot().steeringState).toBe("idle");
  expect((await f.session.dispatch({ type: "steer", message: "Check corrected salary" })).status).toBe("accepted");
  expect(guidance).toBe(2);
});
