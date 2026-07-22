import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  ApplicationHarnessError,
  type ApplicationHarnessClient,
  type ApplicationHarnessCreateInput,
  type ApplicationHarnessEvent,
  type ApplicationHarnessSnapshot,
} from "../src/api/application-harness-client.ts";
import {
  ApplicationSessionService,
  type ApplicationSessionStreamItem,
  readApplicantProfileMarkdown,
} from "../src/api/application-session-service.ts";
import type { ApplicationSessionCommand, ApplicationSessionEventDto } from "../src/contracts/index.ts";
import { openPipelineDatabase } from "../src/db/database.ts";
import { PipelineRepository, type ActiveStage } from "../src/db/repository.ts";
import { ArtifactStore } from "../src/system/artifacts.ts";

const JOB_URL = "https://jobs.example.test/roles/123?source=private";
const PROFILE = "# Applicant profile\n\nPrivate candidate evidence.\n";
const FIRST_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nprivate approved resume\n%%EOF\n");

const databases: Database[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  while (databases.length > 0) databases.pop()?.close();
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function harnessSnapshot(
  state: ApplicationHarnessSnapshot["state"] = "running",
): ApplicationHarnessSnapshot {
  return {
    state,
    createdAt: 10_000,
    updatedAt: 10_100,
    expiresAt: 20_000,
    company: "Example Corp",
    role: "Platform Engineer",
    fieldsFilled: [],
    fieldsNeedingHuman: [],
    filesAttached: ["resume.pdf"],
    warnings: [],
    revisionCount: 0,
    pendingAction: null,
    error: null,
  };
}

function harnessReviewSnapshot(): ApplicationHarnessSnapshot {
  return {
    ...harnessSnapshot("awaiting_human_review"),
    pendingAction: { type: "human_review" },
  };
}

class FakeHarness implements ApplicationHarnessClient {
  readonly createCalls: ApplicationHarnessCreateInput[] = [];
  readonly getCalls: string[] = [];
  readonly streamCalls: Array<{ sessionId: string; lastEventId: number | undefined }> = [];
  readonly commandCalls: Array<{ sessionId: string; command: ApplicationSessionCommand }> = [];
  readonly deleteCalls: string[] = [];
  readonly snapshots = new Map<string, ApplicationHarnessSnapshot>();
  events: ApplicationHarnessEvent[] = [];
  readonly getReplies: Array<Promise<ApplicationHarnessSnapshot>> = [];
  createError: ApplicationHarnessError | null = null;
  commandError: ApplicationHarnessError | null = null;
  deleteError: ApplicationHarnessError | null = null;
  streamError: ApplicationHarnessError | null = null;
  snapshotAfterCreate = harnessSnapshot();
  storeSnapshotBeforeCreateError = false;

  async create(input: ApplicationHarnessCreateInput): Promise<void> {
    this.createCalls.push({
      ...input,
      resumePdf: Uint8Array.from(input.resumePdf),
    });
    if (this.createError) {
      if (this.storeSnapshotBeforeCreateError) {
        this.snapshots.set(input.sessionId, this.snapshotAfterCreate);
      }
      throw this.createError;
    }
    this.snapshots.set(input.sessionId, this.snapshotAfterCreate);
  }

  async get(sessionId: string): Promise<ApplicationHarnessSnapshot> {
    this.getCalls.push(sessionId);
    const queued = this.getReplies.shift();
    if (queued) return await queued;
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot) throw new ApplicationHarnessError("session_not_found");
    return snapshot;
  }

  async stream(
    sessionId: string,
    lastEventId: number | undefined,
  ): Promise<AsyncIterable<ApplicationHarnessEvent>> {
    this.streamCalls.push({ sessionId, lastEventId });
    if (this.streamError) throw this.streamError;
    const events = this.events;
    return {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    };
  }

  async command(sessionId: string, command: ApplicationSessionCommand): Promise<void> {
    this.commandCalls.push({ sessionId, command });
    if (this.commandError) throw this.commandError;
  }

  async delete(sessionId: string): Promise<void> {
    this.deleteCalls.push(sessionId);
    if (this.deleteError) throw this.deleteError;
    this.snapshots.delete(sessionId);
  }
}

async function createTarget(options: {
  approved?: boolean;
  harness?: FakeHarness | null;
  jobUrl?: string | null;
  profileReader?: () => string | Promise<string>;
  sessionIds?: string[];
} = {}) {
  let now = 1_000;
  const database = openPipelineDatabase(":memory:", { now: () => now });
  databases.push(database);
  const repository = new PipelineRepository(database, {
    now: () => now,
    idFactory: (() => {
      let value = 0;
      return () => `fixture-id-${++value}`;
    })(),
  });
  const artifactRoot = await mkdtemp(join(tmpdir(), "application-session-service-"));
  temporaryRoots.push(artifactRoot);
  const artifacts = new ArtifactStore(artifactRoot);
  const run = repository.createRun("Private job description", "run-1");
  database.query("UPDATE runs SET job_url = ? WHERE id = ?").run(
    options.jobUrl === undefined ? JOB_URL : options.jobUrl,
    run.id,
  );
  await artifacts.createRunInput({ run: run.queueSequence });
  const claim = repository.acquire();
  if (!claim) throw new Error("claim missing");
  const stages: ActiveStage[] = [
    "analyzing",
    "tailoring",
    "compiling",
    "deterministic_qa",
    "visual_qa",
  ];
  for (const stage of stages) repository.transition(claim, stage);
  const attempt = repository.startAttempt(claim, "visual_qa");
  const attemptRoot = await artifacts.createAttempt({
    run: run.queueSequence,
    revision: "1",
    stage: "visual_qa",
    attempt: attempt.attemptNo,
  });
  const pdf = await artifacts.write(join(attemptRoot, "resume.pdf"), PDF_BYTES, 10 * 1024 * 1024);
  repository.finalizeArtifact(claim, {
    attemptId: attempt.id,
    stage: "visual_qa",
    kind: "compiled-pdf",
    sha256: pdf.sha256,
    path: pdf.path,
    byteSize: pdf.bytes,
  });
  repository.finishAttempt(claim, attempt.id, "succeeded");
  repository.transition(claim, "review");
  repository.release(claim);
  if (options.approved !== false) repository.approve(run.id, pdf.sha256);

  const harness = options.harness === undefined ? new FakeHarness() : options.harness;
  const sessionIds = options.sessionIds ?? [FIRST_SESSION_ID, SECOND_SESSION_ID];
  let sessionIndex = 0;
  const service = new ApplicationSessionService({
    repository,
    artifacts,
    ...(harness ? { harness } : {}),
    uuidFactory: () => sessionIds[sessionIndex++] ?? SECOND_SESSION_ID,
    now: () => now,
    profileReader: options.profileReader ?? (() => PROFILE),
  });
  return {
    artifacts,
    database,
    harness,
    pdf,
    repository,
    runId: run.id,
    service,
    setNow(value: number) { now = value; },
  };
}

const signal = () => new AbortController().signal;

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function createProfileRoot(): Promise<{ root: string; profilePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "application-profile-reader-"));
  temporaryRoots.push(root);
  const profilePath = join(
    root,
    "apps/user-info/current-context/personal/applicant-profile.md",
  );
  await mkdir(dirname(profilePath), { recursive: true });
  return { root, profilePath };
}

describe("application session service", () => {
  test("uploads only the reserved UUID, private URL, exact profile, and verified approved PDF", async () => {
    const target = await createTarget();

    const view = await target.service.start(target.runId, target.pdf.sha256, signal());

    expect(target.harness!.createCalls).toHaveLength(1);
    expect(target.harness!.createCalls[0]).toEqual({
      sessionId: FIRST_SESSION_ID,
      jobUrl: JOB_URL,
      personalInformationMarkdown: PROFILE,
      resumePdf: PDF_BYTES,
    });
    expect(view).toMatchObject({ generation: 1, bridgeState: "running", harnessState: "running" });
    expect(view).not.toHaveProperty("sessionId");
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(FIRST_SESSION_ID);
    expect(serialized).not.toContain(JOB_URL);
    expect(serialized).not.toContain(PROFILE);
  });

  test("reports exact eligibility blockers without exposing private sources", async () => {
    const review = await createTarget({ approved: false });
    expect(await review.service.get(review.runId)).toEqual({
      state: "not_started",
      canStart: false,
      canStartAfterApproval: true,
    });

    const legacy = await createTarget({ jobUrl: null });
    expect(await legacy.service.get(legacy.runId)).toMatchObject({
      state: "not_started",
      blockedReason: "legacy_job_url_unavailable",
    });

    const insecure = await createTarget({ jobUrl: "http://jobs.example.test/private" });
    expect(await insecure.service.get(insecure.runId)).toMatchObject({
      state: "not_started",
      blockedReason: "job_url_requires_https",
    });

    const unconfigured = await createTarget({ harness: null });
    expect(await unconfigured.service.get(unconfigured.runId)).toMatchObject({
      state: "not_started",
      blockedReason: "harness_unconfigured",
    });
    await expect(
      unconfigured.service.start(unconfigured.runId, unconfigured.pdf.sha256, signal()),
    ).rejects.toMatchObject({
      code: "APPLICATION_HARNESS_UNAVAILABLE",
      status: 503,
      message: "The local application service is unavailable",
    });
    expect(unconfigured.repository.getLatestApplicationSession(unconfigured.runId)).toBeNull();

    const unavailableProfile = await createTarget({
      profileReader: () => {
        throw new Error(`cannot read ${JOB_URL}`);
      },
    });
    expect(await unavailableProfile.service.get(unavailableProfile.runId)).toMatchObject({
      state: "not_started",
      blockedReason: "profile_unavailable",
    });
    await expect(
      unavailableProfile.service.start(
        unavailableProfile.runId,
        unavailableProfile.pdf.sha256,
        signal(),
      ),
    ).rejects.toMatchObject({
      code: "APPLICATION_SOURCE_UNAVAILABLE",
      status: 409,
      message: "Application source files are unavailable",
    });
    expect(unavailableProfile.repository.getLatestApplicationSession(unavailableProfile.runId))
      .toBeNull();

    await expect(
      review.service.start(review.runId, review.pdf.sha256, signal()),
    ).rejects.toMatchObject({ code: "RUN_CONFLICT", status: 409 });
    await expect(
      legacy.service.start(legacy.runId, legacy.pdf.sha256, signal()),
    ).rejects.toMatchObject({ code: "APPLICATION_SOURCE_UNAVAILABLE", status: 409 });
    await expect(
      insecure.service.start(insecure.runId, insecure.pdf.sha256, signal()),
    ).rejects.toMatchObject({ code: "APPLICATION_SOURCE_UNAVAILABLE", status: 409 });
    await expect(
      review.service.start(review.runId, "f".repeat(64), signal()),
    ).rejects.toMatchObject({ code: "RUN_CONFLICT", status: 409 });
  });

  test("default profile reader returns exact fatal UTF-8 Markdown and rejects unsafe files", async () => {
    const exact = await createProfileRoot();
    const markdown = "# Exact profile\n\nDo not trim this trailing space. \n";
    await writeFile(exact.profilePath, markdown);
    expect(await readApplicantProfileMarkdown(exact.root)).toBe(markdown);

    const invalidUtf8 = await createProfileRoot();
    await writeFile(invalidUtf8.profilePath, Uint8Array.of(0xc3, 0x28));
    await expect(readApplicantProfileMarkdown(invalidUtf8.root)).rejects.toThrow();

    const empty = await createProfileRoot();
    await writeFile(empty.profilePath, "");
    await expect(readApplicantProfileMarkdown(empty.root)).rejects.toThrow(/size/);

    const oversized = await createProfileRoot();
    await writeFile(oversized.profilePath, new Uint8Array(1024 * 1024 + 1));
    await expect(readApplicantProfileMarkdown(oversized.root)).rejects.toThrow(/size/);

    const linked = await createProfileRoot();
    const source = join(linked.root, "profile-source.md");
    await writeFile(source, PROFILE);
    await symlink(source, linked.profilePath);
    await expect(readApplicantProfileMarkdown(linked.root)).rejects.toThrow(/symlink/);

    const nonregular = await createProfileRoot();
    await mkdir(nonregular.profilePath);
    await expect(readApplicantProfileMarkdown(nonregular.root)).rejects.toThrow(/regular file/);
  });

  test("reserves before artifact I/O and closes deterministic source failures", async () => {
    const target = await createTarget();
    let readCount = 0;
    const service = new ApplicationSessionService({
      repository: target.repository,
      artifacts: {
        read: async () => {
          readCount += 1;
          expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
            generation: 1,
            bridgeState: "reserved",
            sessionId: FIRST_SESSION_ID,
            pdfSha256: target.pdf.sha256,
          });
          throw new Error(`private artifact path for ${JOB_URL}`);
        },
      },
      harness: target.harness!,
      uuidFactory: () => FIRST_SESSION_ID,
      now: () => 1_000,
      profileReader: () => PROFILE,
    });

    await expect(
      service.start(target.runId, target.pdf.sha256, signal()),
    ).rejects.toMatchObject({
      code: "APPLICATION_SOURCE_UNAVAILABLE",
      status: 409,
      message: "Application source files are unavailable",
    });

    expect(readCount).toBe(1);
    const closed = target.repository.getLatestApplicationSession(target.runId);
    expect(closed).toMatchObject({
      generation: 1,
      bridgeState: "closed",
      terminalAt: 1_001,
    });
    expect(closed?.publicSnapshot).toMatchObject({
      generation: 1,
      bridgeState: "closed",
      harnessState: null,
    });
    expect(JSON.stringify(closed?.publicSnapshot)).not.toContain(FIRST_SESSION_ID);
    expect(target.harness!.createCalls).toHaveLength(0);
  });

  test("close waits for a reserved start and then closes the created harness session", async () => {
    const target = await createTarget();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    const service = new ApplicationSessionService({
      repository: target.repository,
      artifacts: {
        read: async (path, maxBytes) => {
          readStarted.resolve(undefined);
          await releaseRead.promise;
          return await target.artifacts.read(path, maxBytes);
        },
      },
      harness: target.harness!,
      uuidFactory: () => FIRST_SESSION_ID,
      now: () => 1_000,
      profileReader: () => PROFILE,
    });

    const started = service.start(target.runId, target.pdf.sha256, signal());
    await readStarted.promise;
    const closed = service.close(target.runId, signal());
    releaseRead.resolve(undefined);
    await Promise.all([started, closed]);

    expect(target.harness!.createCalls).toHaveLength(1);
    expect(target.harness!.deleteCalls).toEqual([FIRST_SESSION_ID]);
    expect(target.harness!.snapshots.has(FIRST_SESSION_ID)).toBeFalse();
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "closed",
      submissionPhase: "not_attempted",
    });
  });

  test("concurrent compare-and-swap starters converge on one reserved UUID", async () => {
    const target = await createTarget();
    const first = new ApplicationSessionService({
      repository: target.repository,
      artifacts: target.artifacts,
      harness: target.harness!,
      uuidFactory: () => FIRST_SESSION_ID,
      now: () => 1_000,
      profileReader: async () => PROFILE,
    });
    const second = new ApplicationSessionService({
      repository: target.repository,
      artifacts: target.artifacts,
      harness: target.harness!,
      uuidFactory: () => SECOND_SESSION_ID,
      now: () => 1_000,
      profileReader: async () => PROFILE,
    });

    const [firstView, secondView] = await Promise.all([
      first.start(target.runId, target.pdf.sha256, signal()),
      second.start(target.runId, target.pdf.sha256, signal()),
    ]);

    expect(firstView).toEqual(secondView);
    expect(firstView).toMatchObject({ generation: 1, bridgeState: "running" });
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      generation: 1,
      sessionId: FIRST_SESSION_ID,
      pdfSha256: target.pdf.sha256,
    });
    expect(target.harness!.createCalls.length).toBeGreaterThanOrEqual(1);
    expect(target.harness!.createCalls.every((call) => call.sessionId === FIRST_SESSION_ID)).toBeTrue();
    expect(JSON.stringify(firstView)).not.toContain(FIRST_SESSION_ID);
    expect(JSON.stringify(firstView)).not.toContain(SECOND_SESSION_ID);
  });

  test("keeps the newest harness snapshot when concurrent resumes finish out of order", async () => {
    const target = await createTarget();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    const newerReply = deferred<ApplicationHarnessSnapshot>();
    const olderReply = deferred<ApplicationHarnessSnapshot>();
    target.harness!.getReplies.push(newerReply.promise, olderReply.promise);
    const newerSnapshot = {
      ...harnessSnapshot("awaiting_origin_approval"),
      updatedAt: 10_300,
      role: "Newest public role",
      pendingAction: {
        type: "origin_approval" as const,
        origin: "https://newest.example.test",
      },
    };
    const olderSnapshot = {
      ...harnessSnapshot("running"),
      updatedAt: 10_200,
      role: "Stale public role",
    };

    const newerStart = target.service.start(target.runId, target.pdf.sha256, signal());
    const olderStart = target.service.start(target.runId, target.pdf.sha256, signal());
    newerReply.resolve(newerSnapshot);
    const newerView = await newerStart;
    olderReply.resolve(olderSnapshot);
    const convergedView = await olderStart;

    expect(newerView).toMatchObject({
      bridgeState: "awaiting_origin_approval",
      role: "Newest public role",
      pendingAction: {
        type: "origin_approval",
        origin: "https://newest.example.test",
      },
    });
    expect(convergedView).toEqual(newerView);
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "awaiting_origin_approval",
      publicSnapshot: expect.objectContaining({
        updatedAt: 10_300,
        role: "Newest public role",
      }),
    });
  });

  test("recovers a timed-out or same-ID create and rejects an unrelated singleton", async () => {
    const timedOutHarness = new FakeHarness();
    timedOutHarness.createError = new ApplicationHarnessError("unavailable");
    timedOutHarness.storeSnapshotBeforeCreateError = true;
    const timedOut = await createTarget({ harness: timedOutHarness });

    await expect(
      timedOut.service.start(timedOut.runId, timedOut.pdf.sha256, signal()),
    ).rejects.toMatchObject({
      code: "APPLICATION_HARNESS_UNAVAILABLE",
      message: "The local application service is unavailable",
      status: 503,
    });
    expect(timedOut.repository.getLatestApplicationSession(timedOut.runId)).toMatchObject({
      generation: 1,
      bridgeState: "reserved",
      publicSnapshot: null,
      sessionId: FIRST_SESSION_ID,
    });

    timedOutHarness.createError = null;
    const recovered = await timedOut.service.start(
      timedOut.runId,
      timedOut.pdf.sha256,
      signal(),
    );
    expect(recovered).toMatchObject({ generation: 1, bridgeState: "running" });
    expect(timedOutHarness.createCalls).toHaveLength(1);

    const sameIdHarness = new FakeHarness();
    sameIdHarness.createError = new ApplicationHarnessError("session_active_same_id");
    sameIdHarness.storeSnapshotBeforeCreateError = true;
    const sameId = await createTarget({ harness: sameIdHarness });
    expect(await sameId.service.start(sameId.runId, sameId.pdf.sha256, signal()))
      .toMatchObject({ generation: 1, bridgeState: "running" });
    expect(sameIdHarness.getCalls).toEqual([FIRST_SESSION_ID, FIRST_SESSION_ID]);

    const busyHarness = new FakeHarness();
    busyHarness.createError = new ApplicationHarnessError("session_active_different_id");
    const busy = await createTarget({ harness: busyHarness });
    await expect(
      busy.service.start(busy.runId, busy.pdf.sha256, signal()),
    ).rejects.toMatchObject({
      code: "APPLICATION_SESSION_BUSY",
      message: "Another application session is active",
      status: 409,
    });
    expect(busy.repository.getLatestApplicationSession(busy.runId)).toMatchObject({
      generation: 1,
      bridgeState: "reserved",
      publicSnapshot: null,
    });
    expect(JSON.stringify(busy.repository.getLatestApplicationSession(busy.runId)?.publicSnapshot))
      .not.toContain(JOB_URL);
  });

  test("marks an observed 404 lost and rotates only through explicit terminal retry", async () => {
    const target = await createTarget({
      sessionIds: [FIRST_SESSION_ID, SECOND_SESSION_ID, THIRD_SESSION_ID],
    });
    const first = await target.service.start(target.runId, target.pdf.sha256, signal());
    expect(first).toMatchObject({ generation: 1, bridgeState: "running" });

    target.harness!.snapshots.delete(FIRST_SESSION_ID);
    target.setNow(1_100);
    const lost = await target.service.start(target.runId, target.pdf.sha256, signal());
    expect(lost).toMatchObject({
      generation: 1,
      bridgeState: "lost",
      harnessState: "running",
      terminalAt: 1_100,
      pendingAction: null,
    });
    expect(lost.warnings).toContain("Verify whether the application was submitted before retrying.");
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      generation: 1,
      bridgeState: "lost",
      terminalAt: 1_100,
      sessionId: FIRST_SESSION_ID,
    });

    expect(await target.service.start(target.runId, target.pdf.sha256, signal())).toEqual(lost);
    expect(target.repository.getLatestApplicationSession(target.runId)?.generation).toBe(1);

    const retried = await target.service.retry(target.runId, target.pdf.sha256, signal());
    expect(retried).toMatchObject({ generation: 2, bridgeState: "running" });
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      generation: 2,
      sessionId: SECOND_SESSION_ID,
      pdfSha256: target.pdf.sha256,
    });

    const active = await createTarget();
    await active.service.start(active.runId, active.pdf.sha256, signal());
    await expect(
      active.service.retry(active.runId, active.pdf.sha256, signal()),
    ).rejects.toMatchObject({ code: "RUN_CONFLICT", status: 409 });

    for (const bridgeState of ["cancelled", "failed", "closed"] as const) {
      const terminalHarness = new FakeHarness();
      terminalHarness.snapshotAfterCreate = bridgeState === "failed"
        ? {
          ...harnessSnapshot("failed"),
          error: { code: "browser_failed", message: "The browser session failed" },
        }
        : harnessSnapshot(bridgeState);
      const terminal = await createTarget({
        harness: terminalHarness,
        sessionIds: [FIRST_SESSION_ID, SECOND_SESSION_ID],
      });
      expect(await terminal.service.start(terminal.runId, terminal.pdf.sha256, signal()))
        .toMatchObject({ generation: 1, bridgeState });
      expect(await terminal.service.retry(terminal.runId, terminal.pdf.sha256, signal()))
        .toMatchObject({ generation: 2, bridgeState });
    }
  });


  test("returns an existing terminal snapshot before source and configuration checks", async () => {
    const harness = new FakeHarness();
    harness.snapshotAfterCreate = harnessSnapshot("cancelled");
    const target = await createTarget({ harness });
    const terminal = await target.service.start(target.runId, target.pdf.sha256, signal());
    target.database.query(`
      INSERT INTO run_artifact_retention(run_id, state, selected_at)
      VALUES (?, 'pruning', 1000)
    `).run(target.runId);
    const recovery = new ApplicationSessionService({
      repository: target.repository,
      artifacts: target.artifacts,
      profileReader: () => {
        throw new Error("profile unavailable");
      },
    });
    const getCalls = harness.getCalls.length;

    expect(await recovery.start(target.runId, target.pdf.sha256, signal())).toEqual(terminal);
    expect(harness.getCalls).toHaveLength(getCalls);
    expect(target.repository.getLatestApplicationSession(target.runId)?.generation).toBe(1);
  });

  test("persists each upstream cursor and projected snapshot before yielding its generation event", async () => {
    const target = await createTarget();
    const started = await target.service.start(target.runId, target.pdf.sha256, signal());
    target.harness!.events = [{
      id: 6,
      event: "snapshot",
      session: harnessSnapshot("starting"),
      detail: {},
    }, {
      id: 7,
      event: "agent_step",
      session: {
        ...harnessSnapshot("running"),
        updatedAt: harnessSnapshot().updatedAt + 1,
        warnings: ["Review the highlighted field"],
      },
      detail: { stepNumber: 3 },
    }];

    const iterator = (await target.service.events(
      target.runId,
      { generation: 1, upstreamEventId: 5 },
      signal(),
    ))[Symbol.asyncIterator]();
    const item = await iterator.next();

    expect(target.harness!.streamCalls).toEqual([{
      sessionId: FIRST_SESSION_ID,
      lastEventId: 5,
    }]);
    expect(item.done).toBeFalse();
    expect(item.value).toEqual({
      id: "1:7",
      event: {
        generation: 1,
        event: "agent_step",
        session: expect.objectContaining({
          generation: 1,
          bridgeState: "running",
          warnings: ["Review the highlighted field"],
        }),
        detail: { stepNumber: 3 },
      },
    });
    expect(item.value?.event.session.updatedAt).toBeGreaterThan(started.updatedAt);
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      generation: 1,
      bridgeState: "running",
      lastUpstreamEventId: 7,
      publicSnapshot: expect.objectContaining({
        generation: 1,
        warnings: ["Review the highlighted field"],
      }),
    });
    const serialized = JSON.stringify(item.value);
    expect(serialized).not.toContain(FIRST_SESSION_ID);
    expect(serialized).not.toContain(JOB_URL);
    expect(serialized).not.toContain(PROFILE);
    const nextGeneration = (await target.service.events(
      target.runId,
      { generation: 2, upstreamEventId: 99 },
      signal(),
    ))[Symbol.asyncIterator]();
    await nextGeneration.next();
    expect(target.harness!.streamCalls[1]).toEqual({
      sessionId: FIRST_SESSION_ID,
      lastEventId: undefined,
    });
    await nextGeneration.return?.(undefined);
  });

  test("replays the persisted projection when a connecting browser is behind the durable cursor", async () => {
    const target = await createTarget();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    const gateEvent: ApplicationHarnessEvent = {
      id: 7,
      event: "origin_approval_required",
      session: {
        ...harnessSnapshot("awaiting_origin_approval"),
        updatedAt: 10_200,
        pendingAction: {
          type: "origin_approval",
          origin: "https://approval.example.test",
        },
      },
      detail: { origin: "https://approval.example.test" },
    };
    target.harness!.events = [gateEvent];
    const persisting = (await target.service.events(
      target.runId,
      { generation: 1, upstreamEventId: 6 },
      signal(),
    ))[Symbol.asyncIterator]();
    expect((await persisting.next()).value?.id).toBe("1:7");
    await persisting.return?.(undefined);

    target.harness!.events = [gateEvent];
    const behind = (await target.service.events(
      target.runId,
      undefined,
      signal(),
    ))[Symbol.asyncIterator]();
    const replayed = await behind.next();

    expect(replayed.done).toBeFalse();
    expect(replayed.value).toEqual({
      id: "1:7",
      event: {
        generation: 1,
        event: "snapshot",
        session: expect.objectContaining({
          generation: 1,
          bridgeState: "awaiting_origin_approval",
          pendingAction: {
            type: "origin_approval",
            origin: "https://approval.example.test",
          },
        }),
        detail: {},
      },
    });
    await behind.return?.(undefined);
  });

  test("does not emit a stale SSE frame after another stream advances the durable cursor", async () => {
    const target = await createTarget();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    target.harness!.events = [{
      id: 6,
      event: "agent_step",
      session: {
        ...harnessSnapshot("running"),
        updatedAt: 10_200,
      },
      detail: { stepNumber: 2 },
    }];
    const stream = await target.service.events(target.runId, undefined, signal());
    const current = target.repository.getLatestApplicationSession(target.runId);
    if (!current || current.publicSnapshot === null) throw new Error("snapshot missing");
    target.repository.recordApplicationSnapshot(target.runId, {
      generation: 1,
      sessionId: FIRST_SESSION_ID,
      bridgeState: "running",
      publicSnapshot: {
        ...(current.publicSnapshot as Record<string, unknown>),
        bridgeState: "running",
        harnessState: "running",
        updatedAt: 10_300,
        pendingAction: null,
      },
      lastUpstreamEventId: 7,
    });

    const items: ApplicationSessionStreamItem[] = [];
    for await (const item of stream) items.push(item);

    expect(items).toEqual([]);
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      lastUpstreamEventId: 7,
      publicSnapshot: expect.objectContaining({ updatedAt: 10_300 }),
    });
  });

  test("maps an upstream SSE open failure before exposing an event iterator", async () => {
    const target = await createTarget();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    target.harness!.streamError = new ApplicationHarnessError("unavailable");

    await expect(target.service.events(
      target.runId,
      undefined,
      signal(),
    )).rejects.toMatchObject({
      code: "APPLICATION_HARNESS_UNAVAILABLE",
      status: 503,
    });
  });

  test("forwards live commands without persistence and closes active, reserved, and lost sessions", async () => {
    const commandHarness = new FakeHarness();
    commandHarness.snapshotAfterCreate = {
      ...harnessSnapshot("awaiting_additional_info"),
      pendingAction: {
        type: "additional_info",
        questions: [{
          id: "preferred_name",
          scope: "global",
          question: "What name should applications use?",
          answerType: "text",
        }],
      },
    };
    const commandTarget = await createTarget({ harness: commandHarness });
    await commandTarget.service.start(
      commandTarget.runId,
      commandTarget.pdf.sha256,
      signal(),
    );
    const privateAnswer = "PRIVATE ANSWER VALUE";
    const command: ApplicationSessionCommand = {
      type: "provide_additional_info",
      answers: [{ id: "preferred_name", status: "answered", value: privateAnswer }],
    };
    await commandTarget.service.command(commandTarget.runId, command, signal());
    expect(commandHarness.commandCalls).toEqual([{
      sessionId: FIRST_SESSION_ID,
      command,
    }]);
    expect(JSON.stringify(
      commandTarget.repository.getLatestApplicationSession(commandTarget.runId)?.publicSnapshot,
    )).not.toContain(privateAnswer);

    commandHarness.commandError = new ApplicationHarnessError("command_conflict");
    await expect(
      commandTarget.service.command(commandTarget.runId, command, signal()),
    ).rejects.toMatchObject({
      code: "APPLICATION_COMMAND_CONFLICT",
      message: "The application state changed; review the latest session state",
      status: 409,
    });
    commandHarness.commandError = null;
    await commandTarget.service.close(commandTarget.runId, signal());
    expect(commandHarness.deleteCalls).toEqual([FIRST_SESSION_ID]);
    expect(commandTarget.repository.getLatestApplicationSession(commandTarget.runId)).toMatchObject({
      bridgeState: "closed",
      publicSnapshot: expect.objectContaining({
        bridgeState: "closed",
        harnessState: "closed",
      }),
    });

    const reservedHarness = new FakeHarness();
    reservedHarness.createError = new ApplicationHarnessError("unavailable");
    const reserved = await createTarget({ harness: reservedHarness });
    await expect(
      reserved.service.start(reserved.runId, reserved.pdf.sha256, signal()),
    ).rejects.toMatchObject({ code: "APPLICATION_HARNESS_UNAVAILABLE" });
    const restartedWithoutHarness = new ApplicationSessionService({
      repository: reserved.repository,
      artifacts: reserved.artifacts,
      uuidFactory: () => SECOND_SESSION_ID,
      now: () => 1_000,
      profileReader: () => PROFILE,
    });
    await restartedWithoutHarness.close(reserved.runId, signal());
    expect(reservedHarness.deleteCalls).toHaveLength(0);
    expect(reserved.repository.getLatestApplicationSession(reserved.runId)).toMatchObject({
      bridgeState: "closed",
      publicSnapshot: expect.objectContaining({
        bridgeState: "closed",
        harnessState: null,
      }),
    });

    const lost = await createTarget();
    await lost.service.start(lost.runId, lost.pdf.sha256, signal());
    lost.harness!.snapshots.delete(FIRST_SESSION_ID);
    await lost.service.start(lost.runId, lost.pdf.sha256, signal());
    await lost.service.close(lost.runId, signal());
    expect(lost.harness!.deleteCalls).toHaveLength(0);
    expect(lost.repository.getLatestApplicationSession(lost.runId)).toMatchObject({
      generation: 1,
      bridgeState: "closed",
      publicSnapshot: expect.objectContaining({
        bridgeState: "closed",
        harnessState: null,
      }),
    });

    for (const [state, snapshot] of [
      ["cancelled", harnessSnapshot("cancelled")],
      ["failed", {
        ...harnessSnapshot("failed"),
        error: {
          code: "browser_failed",
          message: "The browser session failed",
        },
      }],
    ] as const) {
      const terminalHarness = new FakeHarness();
      terminalHarness.snapshotAfterCreate = snapshot;
      const terminal = await createTarget({ harness: terminalHarness });
      expect(await terminal.service.start(terminal.runId, terminal.pdf.sha256, signal()))
        .toMatchObject({ bridgeState: state });
      await terminal.service.close(terminal.runId, signal());
      expect(terminalHarness.deleteCalls).toEqual([FIRST_SESSION_ID]);
      expect(terminal.repository.getLatestApplicationSession(terminal.runId)).toMatchObject({
        bridgeState: "closed",
        publicSnapshot: expect.objectContaining({
          bridgeState: "closed",
          harnessState: "closed",
          error: null,
        }),
      });
      expect(JSON.stringify(
        terminal.repository.getLatestApplicationSession(terminal.runId)?.publicSnapshot,
      )).not.toContain(FIRST_SESSION_ID);
    }
  });

  test("overlays claimed and submitted phases, streams fixed events, and retains finality after close", async () => {
    const target = await createTarget();
    target.harness!.snapshotAfterCreate = harnessReviewSnapshot();
    const initial = await target.service.start(target.runId, target.pdf.sha256, signal());
    expect(initial.submissionPhase).toBe("not_attempted");
    target.repository.claimApplicationSubmission(FIRST_SESSION_ID);

    expect(await target.service.get(target.runId)).toMatchObject({
      bridgeState: "submitting",
      harnessState: "submitting",
      submissionPhase: "attempting",
    });
    target.harness!.events = [{
      id: 1,
      event: "submission_started",
      session: { ...harnessSnapshot("submitting"), updatedAt: 10_200 },
      detail: {},
    }];
    const started: ApplicationSessionEventDto[] = [];
    for await (const item of await target.service.events(target.runId, undefined, signal())) {
      started.push(item.event);
    }
    expect(started).toEqual([expect.objectContaining({
      event: "submission_started",
      session: expect.objectContaining({
        bridgeState: "submitting",
        submissionPhase: "attempting",
      }),
    })]);

    target.repository.finalizeApplicationSubmission(FIRST_SESSION_ID, "submitted");
    target.harness!.events = [{
      id: 2,
      event: "application_submitted",
      session: { ...harnessSnapshot("submitted"), updatedAt: 10_300 },
      detail: {},
    }];
    const submitted: ApplicationSessionStreamItem[] = [];
    for await (const item of await target.service.events(
      target.runId,
      { generation: 1, upstreamEventId: 1 },
      signal(),
    )) submitted.push(item);
    expect(submitted).toEqual([expect.objectContaining({
      id: "1:2",
      event: expect.objectContaining({
        event: "application_submitted",
        session: expect.objectContaining({
          bridgeState: "submitted",
          harnessState: "submitted",
          submissionPhase: "submitted",
        }),
      }),
    })]);
    expect(target.repository.getRun(target.runId)?.applicationStatus).toBe("applied");

    await expect(target.service.command(target.runId, { type: "submit" }, signal()))
      .rejects.toMatchObject({
        code: "APPLICATION_SUBMISSION_FINAL",
        message: "The application submission cannot be retried",
        status: 409,
      });
    expect(target.harness!.commandCalls).toEqual([]);
    target.harness!.deleteError = new ApplicationHarnessError("session_not_found");
    await target.service.close(target.runId, signal());
    expect(await target.service.get(target.runId)).toMatchObject({
      bridgeState: "closed",
      submissionPhase: "submitted",
    });
    await expect(target.service.start(target.runId, target.pdf.sha256, signal()))
      .rejects.toMatchObject({ code: "APPLICATION_SUBMISSION_FINAL", status: 409 });
    await expect(target.service.retry(target.runId, target.pdf.sha256, signal()))
      .rejects.toMatchObject({ code: "APPLICATION_SUBMISSION_FINAL", status: 409 });
  });

  test("blocks start and retry while a claimed submission awaits reconciliation", async () => {
    const target = await createTarget();
    target.harness!.snapshotAfterCreate = harnessReviewSnapshot();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    target.repository.claimApplicationSubmission(FIRST_SESSION_ID);
    target.database.query(`
      UPDATE run_application_sessions
      SET bridge_state = 'closed', terminal_at = 1010
      WHERE session_id = ?
    `).run(FIRST_SESSION_ID);

    await expect(target.service.start(target.runId, target.pdf.sha256, signal()))
      .rejects.toMatchObject({
        code: "APPLICATION_SUBMISSION_FINAL",
        message: "The application submission cannot be retried",
        status: 409,
      });
    await expect(target.service.retry(target.runId, target.pdf.sha256, signal()))
      .rejects.toMatchObject({
        code: "APPLICATION_SUBMISSION_FINAL",
        message: "The application submission cannot be retried",
        status: 409,
      });
    expect(target.harness!.createCalls).toHaveLength(1);
  });

  test("converts post-claim harness loss to non-applied retained uncertainty", async () => {
    const target = await createTarget();
    target.harness!.snapshotAfterCreate = harnessReviewSnapshot();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    target.repository.claimApplicationSubmission(FIRST_SESSION_ID);
    target.harness!.streamError = new ApplicationHarnessError("session_not_found");

    await expect(target.service.events(target.runId, undefined, signal()))
      .rejects.toMatchObject({ code: "RUN_CONFLICT", status: 409 });

    expect(await target.service.get(target.runId)).toMatchObject({
      bridgeState: "submission_uncertain",
      harnessState: "submission_uncertain",
      submissionPhase: "uncertain",
      pendingAction: null,
      error: null,
      warnings: [
        "The application submission could not be verified. Check the headed browser if it is still available, then close this session.",
      ],
    });
    expect(target.repository.getRun(target.runId)?.applicationStatus).toBe("pending");
    await expect(target.service.retry(target.runId, target.pdf.sha256, signal()))
      .rejects.toMatchObject({
        code: "APPLICATION_SUBMISSION_FINAL",
        message: "The application submission cannot be retried",
        status: 409,
      });
  });

  test("converts a terminal harness snapshot after claim into retained uncertainty", async () => {
    const target = await createTarget();
    target.harness!.snapshotAfterCreate = harnessReviewSnapshot();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    target.repository.claimApplicationSubmission(FIRST_SESSION_ID);
    target.harness!.events = [{
      id: 1,
      event: "submission_uncertain",
      session: { ...harnessSnapshot("closed"), updatedAt: 10_200 },
      detail: {},
    }];

    const events: ApplicationSessionStreamItem[] = [];
    for await (const item of await target.service.events(target.runId, undefined, signal())) {
      events.push(item);
    }

    expect(events).toEqual([expect.objectContaining({
      id: "1:1",
      event: expect.objectContaining({
        session: expect.objectContaining({
          bridgeState: "closed",
          submissionPhase: "uncertain",
          warnings: [
            "The application submission could not be verified. Check the headed browser if it is still available, then close this session.",
          ],
        }),
      }),
    })]);
    expect(target.repository.getRun(target.runId)?.applicationStatus).toBe("pending");
    await expect(target.service.retry(target.runId, target.pdf.sha256, signal()))
      .rejects.toMatchObject({ code: "APPLICATION_SUBMISSION_FINAL", status: 409 });
  });

  test("close preserves a concurrent submitted finalization and still closes the browser", async () => {
    const target = await createTarget();
    target.harness!.snapshotAfterCreate = harnessReviewSnapshot();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    target.repository.claimApplicationSubmission(FIRST_SESSION_ID);
    const finalize = target.repository.finalizeApplicationSubmission.bind(target.repository);
    let raced = false;
    target.repository.finalizeApplicationSubmission = (sessionId, outcome) => {
      if (!raced && outcome === "uncertain") {
        raced = true;
        finalize(sessionId, "submitted");
      }
      finalize(sessionId, outcome);
    };

    await target.service.close(target.runId, signal());

    expect(target.harness!.deleteCalls).toEqual([FIRST_SESSION_ID]);
    expect(await target.service.get(target.runId)).toMatchObject({
      bridgeState: "closed",
      submissionPhase: "submitted",
    });
    expect(target.repository.getRun(target.runId)?.applicationStatus).toBe("applied");
  });

  test("closing after a committed claim finalizes uncertainty before releasing liveness", async () => {
    const target = await createTarget();
    target.harness!.snapshotAfterCreate = harnessReviewSnapshot();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    target.repository.claimApplicationSubmission(FIRST_SESSION_ID);

    await target.service.close(target.runId, signal());

    expect(await target.service.get(target.runId)).toMatchObject({
      bridgeState: "closed",
      submissionPhase: "uncertain",
      warnings: [
        "The application submission could not be verified. Check the headed browser if it is still available, then close this session.",
      ],
    });
    expect(target.repository.getRun(target.runId)?.applicationStatus).toBe("pending");
    await expect(target.service.retry(target.runId, target.pdf.sha256, signal()))
      .rejects.toMatchObject({ code: "APPLICATION_SUBMISSION_FINAL", status: 409 });
  });
});
