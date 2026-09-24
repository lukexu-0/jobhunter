import { expect, test } from "bun:test";
import type { ApplicationSessionView, RunDto } from "../app/lib/pipeline-contracts";
import { RunCollection } from "../app/lib/run-collection";

const run: RunDto = {
  id: "collection-run", opportunityKind: "job", status: "review", applicationStatus: "pending",
  generateKeywordMap: false, skipReview: false, autoSubmit: false, queueSequence: 1,
  revision: 1, origin: "initial", createdAt: 1, updatedAt: 2,
  visualAcknowledgementRequired: false, attempts: [], artifacts: [], timeline: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("an accepted status change survives an older list and is not observed as rolled back", async () => {
  const heldList = deferred<RunDto[]>();
  let list = Promise.resolve([run]);
  const observed: string[] = [];
  const collection = new RunCollection({
    listRuns: () => list,
    observeRun: (next) => observed.push(next.applicationStatus),
  });
  await collection.refresh();
  list = heldList.promise;
  const refresh = collection.refresh();
  collection.acceptRun({ ...run, applicationStatus: "interview", updatedAt: 3 });
  heldList.resolve([run]);
  await refresh;

  expect(collection.getSnapshot().runs?.[0]?.applicationStatus).toBe("interview");
  expect(observed).toEqual(["pending", "interview"]);
  collection.stop();
});

test("mixed bulk retry results cannot roll back newer progress from a list refresh", async () => {
  const first = { ...run, id: "first", status: "failed" as RunDto["status"] };
  const second = { ...run, id: "second", status: "failed" as RunDto["status"] };
  let listed = [first, second];
  const collection = new RunCollection({ listRuns: async () => listed });
  await collection.refresh();
  const success = deferred<RunDto>();
  const failure = deferred<RunDto>();
  const batch = Promise.allSettled([success.promise, failure.promise].map(async (result) => {
    collection.acceptRun(await result);
  }));

  listed = [{ ...first, status: "review", updatedAt: 4 }, second];
  await collection.refresh();
  success.resolve({ ...first, status: "tailoring", updatedAt: 3 });
  failure.reject(new Error("retry unavailable"));
  await batch;

  expect(collection.getSnapshot().runs?.map(({ id, status }) => [id, status])).toEqual([
    ["first", "review"], ["second", "failed"],
  ]);
  // A fresh list is authoritative for removal, not merged with past mutations.
  listed = [second];
  await collection.refresh();
  expect(collection.getSnapshot().runs?.map(({ id }) => id)).toEqual(["second"]);
  collection.stop();
});

test("removal fences pending identity and attention reads, including their observers", async () => {
  const identity = deferred<{ schemaVersion: number; target: { title: string } }>();
  const attention = deferred<ApplicationSessionView>();
  const attentionStarted = deferred<void>();
  const observed: string[] = [];
  const collection = new RunCollection({
    listRuns: async () => [{ ...run, isApplicationSessionOpen: true, artifacts: [{
      id: "analysis", kind: "job-analysis", revision: 0, attempt: 1,
      sha256: "a".repeat(64), bytes: 100, mediaType: "application/json",
      href: "/v1/runs/collection-run/artifacts/analysis", public: true, createdAt: 1,
    }] }],
    readJsonArtifact: () => identity.promise,
    getApplicationSession: () => { attentionStarted.resolve(); return attention.promise; },
    observeApplication: (id) => observed.push(id),
  });
  const stopIdentities = collection.watchJobIdentities();
  const refresh = collection.refresh();
  await attentionStarted.promise;
  collection.acceptRemoval(run.id);
  identity.resolve({ schemaVersion: 2, target: { title: "Removed role" } });
  attention.resolve({ state: "not_started", canStart: true, canStartAfterApproval: false });
  await refresh;
  await Promise.resolve();

  expect(collection.getSnapshot().runs).toEqual([]);
  expect(collection.getSnapshot().jobIdentities).toEqual({});
  expect([...collection.getSnapshot().applicationAttention]).toEqual([]);
  expect(observed).toEqual([]);
  stopIdentities();
  collection.stop();
});

test("provider refreshes outside the dashboard do not request optional job artifacts", async () => {
  let reads = 0;
  const collection = new RunCollection({
    listRuns: async () => [{ ...run, artifacts: [{
      id: "analysis", kind: "job-analysis", revision: 0, attempt: 1,
      sha256: "a".repeat(64), bytes: 100, mediaType: "application/json",
      href: "/v1/runs/collection-run/artifacts/analysis", public: true, createdAt: 1,
    }] }],
    readJsonArtifact: async () => { reads += 1; return {}; },
  });
  await collection.refresh();
  expect(reads).toBe(0);
  collection.stop();
});

test("creation batches preserve input order without replacing runs already advanced by a list", async () => {
  const existing = { ...run, id: "existing" };
  const created = { ...run, id: "new", status: "tailoring" as const };
  const progressed = { ...created, status: "review" as const, updatedAt: 5 };
  const other = { ...run, id: "other-new" };
  let listed: RunDto[] = [existing, progressed];
  const collection = new RunCollection({ listRuns: async () => listed });
  const result = deferred<RunDto[]>();
  const creation = collection.collectCreatedRuns(() => result.promise);
  await collection.refresh();
  result.resolve([created, other, created]);
  await creation;
  expect(collection.getSnapshot().runs?.map(({ id, status }) => [id, status])).toEqual([
    ["new", "review"], ["other-new", "review"], ["existing", "review"],
  ]);
  listed = [existing];
  await collection.refresh();
  expect(collection.getSnapshot().runs?.map(({ id }) => id)).toEqual(["existing"]);
  collection.acceptRun({ ...created, updatedAt: 9 });
  expect(collection.getSnapshot().runs?.map(({ id }) => id)).toEqual(["existing"]);
  collection.stop();
});

test("accepted application starts retain durable applied outcomes through transient session flags", async () => {
  const applied = { ...run, applicationStatus: "applied" as const };
  const collection = new RunCollection({ listRuns: async () => [applied] });
  await collection.refresh();
  collection.acceptApplicationStarted(run.id);
  expect(collection.getSnapshot().runs?.[0]).toMatchObject({
    applicationStatus: "applied", isApplying: true, isApplicationSessionOpen: true,
  });
  collection.stop();
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

class Clock {
  now = 0;
  nextId = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, milliseconds: number): number {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.now + milliseconds, callback });
    return id;
  }
  clearTimeout(timer: unknown): void {
    this.tasks.delete(timer as number);
  }
  async advance(milliseconds: number): Promise<void> {
    const end = this.now + milliseconds;
    while (true) {
      await settle();
      const due = [...this.tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.tasks.delete(due[0]);
      due[1].callback();
    }
    this.now = end;
  }
}

test("polling waits for each refresh, bounds hung reads at ten seconds, and recovers without stale publication", async () => {
  const clock = new Clock();
  const held = deferred<RunDto[]>();
  let calls = 0;
  let firstSignal: AbortSignal | undefined;
  const collection = new RunCollection({
    clock,
    listRuns: (signal) => {
      calls += 1;
      if (calls === 1) { firstSignal = signal; return held.promise; }
      return Promise.resolve([run]);
    },
  });
  collection.start();
  await clock.advance(9_999);
  expect(calls).toBe(1);
  expect(collection.getSnapshot().isLoadingRuns).toBe(true);
  await clock.advance(1);
  expect(firstSignal?.aborted).toBe(true);
  expect(collection.getSnapshot().isLoadingRuns).toBe(false);
  expect(collection.getSnapshot().runsError).not.toBeNull();
  await clock.advance(2_999);
  expect(calls).toBe(1);
  await clock.advance(1);
  expect(collection.getSnapshot().runs?.map(({ id }) => id)).toEqual([run.id]);
  expect(collection.getSnapshot().runsError).toBeNull();
  held.resolve([]);
  await settle();
  expect(collection.getSnapshot().runs?.map(({ id }) => id)).toEqual([run.id]);
  collection.stop();
  await clock.advance(30_000);
  expect(calls).toBe(2);
});

test("attention reads cap concurrency at three and timed-out sessions do not hide queued attention", async () => {
  const clock = new Clock();
  const reads: string[] = [];
  const observed: string[] = [];
  const attention: ApplicationSessionView = {
    generation: 1, bridgeState: "awaiting_human_navigation", harnessState: "awaiting_human_navigation",
    submissionPhase: "not_attempted", createdAt: 1, updatedAt: 2,
    terminalAt: null, expiresAt: null, company: null, role: null,
    fieldsFilled: [], fieldsNeedingHuman: [], filesAttached: [], warnings: [],
    revisionCount: 0, playwrightCliDiagnostics: [],
    pendingAction: { type: "human_navigation", instruction: "Complete the checkpoint." }, error: null,
  };
  const collection = new RunCollection({
    clock,
    listRuns: async () => [1, 2, 3, 4].map((id) => ({ ...run, id: String(id), isApplicationSessionOpen: true })),
    getApplicationSession: (id) => {
      reads.push(id);
      return id === "4" ? Promise.resolve(attention) : new Promise(() => {});
    },
    observeApplication: (id) => observed.push(id),
  });
  const refresh = collection.refresh();
  await settle();
  expect(reads).toEqual(["1", "2", "3"]);
  await clock.advance(10_000);
  await refresh;
  expect(reads).toEqual(["1", "2", "3", "4"]);
  expect(observed).toEqual(["4"]);
  expect([...collection.getSnapshot().applicationAttention]).toEqual(["4"]);
  expect(collection.getSnapshot().runs?.map(({ applicationStatus }) => applicationStatus)).toEqual([
    "pending", "pending", "pending", "pending",
  ]);
  collection.stop();
});

test("closed sessions receive a final successful observation even after a temporary read failure", async () => {
  let open = true;
  let fail = false;
  const observed: ApplicationSessionView[] = [];
  const view: ApplicationSessionView = {
    generation: 1, bridgeState: "awaiting_human_navigation", harnessState: "awaiting_human_navigation",
    submissionPhase: "not_attempted", createdAt: 1, updatedAt: 2,
    terminalAt: null, expiresAt: null, company: null, role: null,
    fieldsFilled: [], fieldsNeedingHuman: [], filesAttached: [], warnings: [],
    revisionCount: 0, playwrightCliDiagnostics: [],
    pendingAction: { type: "human_navigation", instruction: "Complete the checkpoint." }, error: null,
  };
  const closed: ApplicationSessionView = {
    ...view, bridgeState: "closed", harnessState: "closed", pendingAction: null, terminalAt: 3, updatedAt: 3,
  };
  const collection = new RunCollection({
    listRuns: async () => [{ ...run, isApplicationSessionOpen: open }],
    getApplicationSession: async () => {
      if (fail) throw new Error("unavailable");
      return open ? view : closed;
    },
    observeApplication: (_, next) => observed.push(next),
  });
  await collection.refresh();
  expect([...collection.getSnapshot().applicationAttention]).toEqual([run.id]);
  open = false;
  fail = true;
  await collection.refresh();
  expect([...collection.getSnapshot().applicationAttention]).toEqual([]);
  fail = false;
  await collection.refresh();
  await collection.refresh();
  expect(observed).toEqual([view, closed]);
  collection.stop();
});

test("identity reads survive polling, retry failures, and cannot overwrite a newer artifact", async () => {
  const oldIdentity = deferred<{ schemaVersion: number; target: { title: string } }>();
  const artifact: RunDto["artifacts"][number] = {
    id: "old-analysis", kind: "job-analysis", revision: 0, attempt: 1,
    sha256: "a".repeat(64), bytes: 100, mediaType: "application/json",
    href: "/v1/runs/collection-run/artifacts/old-analysis", public: true, createdAt: 1,
  };
  let listed = { ...run, titleOverride: "Durable title", artifacts: [artifact] };
  const reads: string[] = [];
  let failed = false;
  const collection = new RunCollection({
    listRuns: async () => [listed],
    readJsonArtifact: async (next) => {
      reads.push(next.id);
      if (next.id === artifact.id) return oldIdentity.promise;
      if (!failed) { failed = true; throw new Error("Artifact unavailable"); }
      return { schemaVersion: 2, target: { title: " New role ", organization: " Example " } };
    },
  });
  const stopIdentities = collection.watchJobIdentities();
  await collection.refresh();
  await collection.refresh();
  expect(reads).toEqual(["old-analysis"]);
  listed = { ...listed, artifacts: [{ ...artifact, id: "new-analysis", createdAt: 2 }] };
  await collection.refresh();
  await settle();
  await collection.refresh();
  await settle();
  oldIdentity.resolve({ schemaVersion: 2, target: { title: "Stale role" } });
  await settle();
  expect(collection.getSnapshot().jobIdentities[run.id]).toEqual({ title: "New role", organization: "Example" });
  expect(collection.getSnapshot().runs?.[0]?.titleOverride).toBe("Durable title");
  expect(reads).toEqual(["old-analysis", "new-analysis", "new-analysis"]);
  stopIdentities();
  collection.stop();
});

test("stopping and restarting the owner fences old list errors and reschedules only the active lifetime", async () => {
  const clock = new Clock();
  const held = deferred<RunDto[]>();
  let calls = 0;
  const collection = new RunCollection({
    clock,
    listRuns: () => ++calls === 1 ? held.promise : Promise.resolve([run]),
  });
  expect(calls).toBe(0);
  collection.start();
  collection.stop();
  collection.start();
  await settle();
  held.reject(new Error("private transport detail"));
  await settle();
  expect(collection.getSnapshot().runs?.map(({ id }) => id)).toEqual([run.id]);
  expect(collection.getSnapshot().runsError).toBeNull();
  await clock.advance(3_000);
  expect(calls).toBe(3);
  collection.stop();
  await clock.advance(20_000);
  expect(calls).toBe(3);
});

test("settling a creation batch cannot resurrect explicit or authoritative-list removals", async () => {
  const deleted = { ...run, id: "deleted" };
  const disappeared = { ...run, id: "disappeared" };
  const survivor = { ...run, id: "survivor" };
  let listed: RunDto[] = [deleted, disappeared];
  const observed: string[] = [];
  const collection = new RunCollection({
    listRuns: async () => listed,
    observeRun: (next) => observed.push(next.id),
  });
  const result = deferred<RunDto[]>();
  const creation = collection.collectCreatedRuns(() => result.promise);
  await collection.refresh();
  collection.acceptRemoval(deleted.id);
  listed = [];
  await collection.refresh();
  observed.length = 0;

  result.resolve([deleted, disappeared, survivor]);
  await creation;
  expect(collection.getSnapshot().runs?.map(({ id }) => id)).toEqual(["survivor"]);
  expect(observed).toEqual(["survivor"]);
  listed = [deleted];
  await collection.refresh();
  expect(collection.getSnapshot().runs?.map(({ id }) => id)).toEqual(["deleted"]);
  collection.stop();
});
