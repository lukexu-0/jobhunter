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
import type {
  ApplicationAnswerSuggestionsResponse,
  ApplicationProfessionalizeRequest,
  ApplicationSessionCommand,
  ApplicationSessionEventDto,
  OpportunityKind,
} from "../src/contracts/index.ts";
import { OAuthRequiredError } from "../src/auth/oauth-only-resolver.ts";
import {
  ApplicationAnswerProfessionalizationError,
  type ProfessionalizeApplicationAnswer,
} from "../src/models/application-answer-professionalizer.ts";
import { openPipelineDatabase } from "../src/db/database.ts";
import {
  PipelineRepository,
  RepositoryConflictError,
  type ActiveStage,
} from "../src/db/repository.ts";
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
    slotReleased: state === "cancelled" || state === "failed" || state === "closed",
    company: "Example Corp",
    role: "Platform Engineer",
    fieldsFilled: [],
    fieldsNeedingHuman: [],
    filesAttached: ["resume.pdf"],
    playwrightCliDiagnostics: [],
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

function harnessTextQuestionSnapshot(
  question = "What name should applications use?",
  id = "preferred_name",
): ApplicationHarnessSnapshot {
  return {
    ...harnessSnapshot("awaiting_additional_info"),
    pendingAction: {
      type: "additional_info",
      questions: [{
        id,
        scope: "global",
        question,
        answerType: "text",
      }],
    },
  };
}

class FakeHarness implements ApplicationHarnessClient {
  readonly createCalls: ApplicationHarnessCreateInput[] = [];
  readonly getCalls: string[] = [];
  readonly streamCalls: Array<{ sessionId: string; lastEventId: number | undefined }> = [];
  readonly streamSignals: AbortSignal[] = [];
  readonly commandCalls: Array<{ sessionId: string; command: ApplicationSessionCommand }> = [];
  readonly deleteCalls: string[] = [];
  readonly suggestionCalls: Array<{ sessionId: string; questionId: string }> = [];
  readonly snapshots = new Map<string, ApplicationHarnessSnapshot>();
  events: ApplicationHarnessEvent[] = [];
  readonly getReplies: Array<Promise<ApplicationHarnessSnapshot>> = [];
  readonly streamReplies: Array<Promise<AsyncIterable<ApplicationHarnessEvent>>> = [];
  readonly suggestionReplies: Array<Promise<ApplicationAnswerSuggestionsResponse>> = [];
  suggestionsResponse: ApplicationAnswerSuggestionsResponse = { suggestions: [] };
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

  async suggestions(
    sessionId: string,
    questionId: string,
  ): Promise<ApplicationAnswerSuggestionsResponse> {
    this.suggestionCalls.push({ sessionId, questionId });
    const queued = this.suggestionReplies.shift();
    if (queued) return await queued;
    return this.suggestionsResponse;
  }

  async stream(
    sessionId: string,
    lastEventId: number | undefined,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ApplicationHarnessEvent>> {
    this.streamSignals.push(signal);
    this.streamCalls.push({ sessionId, lastEventId });
    if (this.streamError) throw this.streamError;
    const queued = this.streamReplies.shift();
    if (queued) return await queued;
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

async function createApprovedRun(
  repository: PipelineRepository,
  database: Database,
  artifacts: ArtifactStore,
  options: {
    readonly id: string;
    readonly approved?: boolean;
    readonly autoSubmit?: boolean;
    readonly skipReview?: boolean;
    readonly jobUrl?: string | null;
    readonly opportunityKind?: OpportunityKind;
  },
) {
  const run = repository.createRun(
    "Private job description",
    options.id,
    true,
    options.skipReview ?? false,
    options.autoSubmit ?? false,
    options.opportunityKind ?? "job",
  );
  database.query("UPDATE runs SET job_url = ? WHERE id = ?").run(
    options.jobUrl === undefined ? JOB_URL : options.jobUrl,
    run.id,
  );
  await artifacts.createRunInput({ run: run.queueSequence });
  const claim = repository.acquire();
  if (!claim || claim.runId !== run.id) throw new Error("claim missing");
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
  const pdf = await artifacts.write(
    join(attemptRoot, "resume.pdf"),
    PDF_BYTES,
    10 * 1024 * 1024,
  );
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
  return { pdf, run };
}

async function createTarget(options: {
  approved?: boolean;
  harness?: FakeHarness | null;
  autoSubmit?: boolean;
  skipReview?: boolean;
  jobUrl?: string | null;
  opportunityKind?: OpportunityKind;
  profileReader?: () => string | Promise<string>;
  sessionIds?: string[];
  onApplicationSessionReleased?: () => void;
  professionalizeAnswer?: ProfessionalizeApplicationAnswer;
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
  const { pdf, run } = await createApprovedRun(repository, database, artifacts, {
    id: "run-1",
    ...(options.approved === undefined ? {} : { approved: options.approved }),
    ...(options.autoSubmit === undefined ? {} : { autoSubmit: options.autoSubmit }),
    ...(options.skipReview === undefined ? {} : { skipReview: options.skipReview }),
    ...(options.jobUrl === undefined ? {} : { jobUrl: options.jobUrl }),
    ...(options.opportunityKind === undefined ? {} : { opportunityKind: options.opportunityKind }),
  });

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
    ...(options.professionalizeAnswer
      ? { professionalizeAnswer: options.professionalizeAnswer }
      : {}),
    ...(options.onApplicationSessionReleased
      ? { onApplicationSessionReleased: options.onApplicationSessionReleased }
      : {}),
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

  test("starts one eligible skip-review application and leaves manual-review runs idle", async () => {
    const automatic = await createTarget({ skipReview: true });

    expect(await automatic.service.startNextAutomaticApplication(signal())).toBe(true);
    expect(automatic.harness!.createCalls).toHaveLength(1);

    const manual = await createTarget({ skipReview: false });
    expect(await manual.service.startNextAutomaticApplication(signal())).toBe(false);
    expect(manual.harness!.createCalls).toHaveLength(0);
  });

  test("serializes automatic starts while the harness is occupied and continues after close", async () => {
    let availabilityKicks = 0;
    const target = await createTarget({
      skipReview: true,
      onApplicationSessionReleased: () => { availabilityKicks++; },
      sessionIds: [FIRST_SESSION_ID, SECOND_SESSION_ID],
    });
    const second = await createApprovedRun(
      target.repository,
      target.database,
      target.artifacts,
      { id: "run-2", skipReview: true, autoSubmit: true },
    );

    expect(await target.service.startNextAutomaticApplication(signal())).toBe(true);
    expect(await target.service.startNextAutomaticApplication(signal())).toBe(false);
    expect(target.harness!.createCalls.map((call) => call.sessionId)).toEqual([
      FIRST_SESSION_ID,
    ]);

    await target.service.close(target.runId, signal());
    expect(availabilityKicks).toBe(1);
    expect(await target.service.startNextAutomaticApplication(signal())).toBe(true);
    expect(target.harness!.createCalls.map((call) => call.sessionId)).toEqual([
      FIRST_SESSION_ID,
      SECOND_SESSION_ID,
    ]);
    expect(target.harness!.createCalls[1]).toMatchObject({
      autoSubmit: true,
      jobUrl: JOB_URL,
    });
    expect(target.repository.getLatestApplicationSession(second.run.id)).toMatchObject({
      bridgeState: "running",
      pdfSha256: second.pdf.sha256,
    });
  });

  test("restores cleanup observation for an unreleased live session after restart", async () => {
    const released = deferred<void>();
    let availabilityKicks = 0;
    const target = await createTarget({
      skipReview: true,
      sessionIds: [FIRST_SESSION_ID, SECOND_SESSION_ID],
    });
    const second = await createApprovedRun(
      target.repository,
      target.database,
      target.artifacts,
      { id: "run-2", skipReview: true },
    );
    expect(await target.service.startNextAutomaticApplication(signal())).toBe(true);

    const cleanupStream = deferred<AsyncIterable<ApplicationHarnessEvent>>();
    target.harness!.streamReplies.push(cleanupStream.promise);
    const restarted = new ApplicationSessionService({
      repository: target.repository,
      artifacts: target.artifacts,
      harness: target.harness!,
      uuidFactory: () => SECOND_SESSION_ID,
      profileReader: () => PROFILE,
      onApplicationSessionReleased: () => {
        availabilityKicks++;
        released.resolve();
      },
    });
    const previousStreamCalls = target.harness!.streamCalls.length;

    expect(await restarted.startNextAutomaticApplication(signal())).toBe(false);
    expect(target.harness!.streamCalls).toHaveLength(previousStreamCalls + 1);
    expect(target.harness!.streamCalls.at(-1)).toEqual({
      sessionId: FIRST_SESSION_ID,
      lastEventId: undefined,
    });

    target.harness!.snapshots.delete(FIRST_SESSION_ID);
    cleanupStream.resolve({
      async *[Symbol.asyncIterator]() {
        throw new ApplicationHarnessError("session_not_found");
      },
    });
    await released.promise;
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "lost",
      slotReleased: true,
    });
    expect(availabilityKicks).toBe(1);

    expect(await restarted.startNextAutomaticApplication(signal())).toBe(true);
    expect(target.repository.getLatestApplicationSession(second.run.id)).toMatchObject({
      bridgeState: "running",
      slotReleased: false,
    });
    await restarted.dispose();
  });

  test("releases a never-observed reservation after restart when the harness is missing", async () => {
    let availabilityKicks = 0;
    const target = await createTarget({
      skipReview: true,
      sessionIds: [FIRST_SESSION_ID, SECOND_SESSION_ID],
    });
    const second = await createApprovedRun(
      target.repository,
      target.database,
      target.artifacts,
      { id: "run-2", skipReview: true },
    );
    target.repository.reserveApplicationSession(
      target.runId,
      null,
      FIRST_SESSION_ID,
      target.pdf.sha256,
    );
    const restarted = new ApplicationSessionService({
      repository: target.repository,
      artifacts: target.artifacts,
      harness: target.harness!,
      uuidFactory: () => SECOND_SESSION_ID,
      profileReader: () => PROFILE,
      onApplicationSessionReleased: () => { availabilityKicks++; },
    });

    expect(await restarted.startNextAutomaticApplication(signal())).toBe(true);
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "closed",
      slotReleased: true,
    });
    expect(target.repository.getLatestApplicationSession(second.run.id)).toMatchObject({
      bridgeState: "running",
      slotReleased: false,
    });
    expect(availabilityKicks).toBe(1);
    await restarted.dispose();
  });

  test("keeps an automatic-start failure approved and recoverable through the existing start path", async () => {
    const harness = new FakeHarness();
    harness.createError = new ApplicationHarnessError("unavailable");
    const target = await createTarget({ harness, skipReview: true });

    await expect(
      target.service.startNextAutomaticApplication(signal()),
    ).rejects.toMatchObject({ code: "APPLICATION_HARNESS_UNAVAILABLE" });
    expect(target.repository.getRun(target.runId)).toMatchObject({
      status: "approved",
      approvedPdfSha256: target.pdf.sha256,
    });

    harness.createError = null;
    await expect(
      target.service.start(target.runId, target.pdf.sha256, signal()),
    ).resolves.toMatchObject({ bridgeState: "running" });
    expect(harness.createCalls).toHaveLength(2);
    expect(harness.createCalls[0]?.sessionId).toBe(harness.createCalls[1]?.sessionId);
  });
  test("uploads the manual run mode with the reserved UUID, private sources, and verified PDF", async () => {
    const target = await createTarget();

    const view = await target.service.start(target.runId, target.pdf.sha256, signal());

    expect(target.harness!.createCalls).toHaveLength(1);
    expect(target.harness!.createCalls[0]).toEqual({
      sessionId: FIRST_SESSION_ID,
      jobUrl: JOB_URL,
      opportunityKind: "job",
      personalInformationMarkdown: PROFILE,
      resumePdf: PDF_BYTES,
      autoSubmit: false,
    });
    expect(view).toMatchObject({ generation: 1, bridgeState: "running", harnessState: "running" });
    expect(view).not.toHaveProperty("sessionId");
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(FIRST_SESSION_ID);
    expect(serialized).not.toContain(JOB_URL);
    expect(serialized).not.toContain(PROFILE);
  });

  test("uploads the persisted auto-submit run mode", async () => {
    const target = await createTarget({ autoSubmit: true });

    await target.service.start(target.runId, target.pdf.sha256, signal());

    expect(target.harness!.createCalls).toHaveLength(1);
    expect(target.harness!.createCalls[0]?.autoSubmit).toBe(true);
  });

  test("uploads the persisted non-job opportunity kind without exposing it publicly", async () => {
    const target = await createTarget({ opportunityKind: "event" });

    const view = await target.service.start(target.runId, target.pdf.sha256, signal());

    expect(target.harness!.createCalls[0]?.opportunityKind).toBe("event");
    expect(view).not.toHaveProperty("opportunityKind");
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

    const privateHttps = await createTarget({ jobUrl: "https://127.0.0.1/private" });
    expect(await privateHttps.service.get(privateHttps.runId)).toMatchObject({
      state: "not_started",
      blockedReason: "job_url_requires_https",
    });
    const localHttps = await createTarget({ jobUrl: "https://jobs.localhost/private" });
    expect(await localHttps.service.get(localHttps.runId)).toMatchObject({
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
      privateHttps.service.start(privateHttps.runId, privateHttps.pdf.sha256, signal()),
    ).rejects.toMatchObject({ code: "APPLICATION_SOURCE_UNAVAILABLE", status: 409 });
    await expect(
      localHttps.service.start(localHttps.runId, localHttps.pdf.sha256, signal()),
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

  test("marks an observed 404 lost, signals availability once, and rotates only through explicit terminal retry", async () => {
    let availabilityKicks = 0;
    const target = await createTarget({
      sessionIds: [FIRST_SESSION_ID, SECOND_SESSION_ID, THIRD_SESSION_ID],
      onApplicationSessionReleased: () => { availabilityKicks++; },
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
    expect(availabilityKicks).toBe(1);

    expect(await target.service.start(target.runId, target.pdf.sha256, signal())).toEqual(lost);
    expect(target.repository.getLatestApplicationSession(target.runId)?.generation).toBe(1);
    expect(availabilityKicks).toBe(1);

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
      let terminalKicks = 0;
      const terminal = await createTarget({
        harness: terminalHarness,
        sessionIds: [FIRST_SESSION_ID, SECOND_SESSION_ID],
        onApplicationSessionReleased: () => { terminalKicks++; },
      });
      expect(await terminal.service.start(terminal.runId, terminal.pdf.sha256, signal()))
        .toMatchObject({ generation: 1, bridgeState });
      expect(terminalKicks).toBe(1);
      expect(await terminal.service.retry(terminal.runId, terminal.pdf.sha256, signal()))
        .toMatchObject({ generation: 2, bridgeState });
    }
  });

  test("signals availability only after terminal harness cleanup releases the slot", async () => {
    let availabilityKicks = 0;
    const target = await createTarget({
      onApplicationSessionReleased: () => { availabilityKicks++; },
    });
    await target.service.start(target.runId, target.pdf.sha256, signal());
    const earlyTimeout: ApplicationHarnessSnapshot = {
      ...harnessSnapshot("failed"),
      updatedAt: 10_200,
      slotReleased: false,
      error: {
        code: "session_timeout",
        message: "The application session expired",
      },
    };
    const releasedTimeout: ApplicationHarnessSnapshot = {
      ...earlyTimeout,
      slotReleased: true,
    };
    target.harness!.events = [{
      id: 1,
      event: "failed",
      session: earlyTimeout,
      detail: {},
    }, {
      id: 2,
      event: "snapshot",
      session: releasedTimeout,
      detail: {},
    }, {
      id: 3,
      event: "snapshot",
      session: releasedTimeout,
      detail: {},
    }];

    const stream = await target.service.events(target.runId, undefined, signal());
    const iterator = stream[Symbol.asyncIterator]();
    const early = await iterator.next();
    expect(early.done).toBeFalse();
    expect(early.value?.event.session).toMatchObject({
      bridgeState: "failed",
      error: { code: "session_timeout" },
    });
    expect(JSON.stringify(early.value)).not.toContain("slotReleased");
    expect(availabilityKicks).toBe(0);
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "failed",
      slotReleased: false,
    });

    expect((await iterator.next()).done).toBeFalse();
    expect(availabilityKicks).toBe(1);
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "failed",
      slotReleased: true,
    });
    expect((await iterator.next()).done).toBeFalse();
    expect(availabilityKicks).toBe(1);
    expect((await iterator.next()).done).toBeTrue();
  });

  test("signals a durable slot release only once before a later lost transition", async () => {
    let availabilityKicks = 0;
    const target = await createTarget({
      onApplicationSessionReleased: () => { availabilityKicks++; },
    });
    await target.service.start(target.runId, target.pdf.sha256, signal());
    target.harness!.events = [{
      id: 1,
      event: "failed",
      session: {
        ...harnessSnapshot("failed"),
        slotReleased: true,
        error: {
          code: "browser_failed",
          message: "The browser session failed",
        },
      },
      detail: {},
    }];
    for await (const _event of await target.service.events(
      target.runId,
      undefined,
      signal(),
    )) {
      // A stale terminal projection releases the physical slot but retains the live view.
    }
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "running",
      slotReleased: true,
    });
    expect(availabilityKicks).toBe(1);

    target.harness!.streamError = new ApplicationHarnessError("session_not_found");
    await expect(target.service.events(target.runId, undefined, signal()))
      .rejects.toMatchObject({ code: "RUN_CONFLICT", status: 409 });

    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "lost",
      slotReleased: true,
    });
    expect(availabilityKicks).toBe(1);
  });

  test("reconciles a persisted terminal slot before starting the next automatic run", async () => {
    let availabilityKicks = 0;
    const target = await createTarget({
      skipReview: true,
      onApplicationSessionReleased: () => { availabilityKicks++; },
      sessionIds: [FIRST_SESSION_ID, SECOND_SESSION_ID],
    });
    const second = await createApprovedRun(
      target.repository,
      target.database,
      target.artifacts,
      { id: "run-2", skipReview: true },
    );
    expect(await target.service.startNextAutomaticApplication(signal())).toBe(true);

    const earlyTimeout: ApplicationHarnessSnapshot = {
      ...harnessSnapshot("failed"),
      updatedAt: 10_200,
      slotReleased: false,
      error: {
        code: "session_timeout",
        message: "The application session expired",
      },
    };
    target.harness!.events = [{
      id: 1,
      event: "failed",
      session: earlyTimeout,
      detail: {},
    }];
    const stream = await target.service.events(target.runId, undefined, signal());
    const observerStream = deferred<AsyncIterable<ApplicationHarnessEvent>>();
    target.harness!.streamReplies.push(observerStream.promise);
    for await (const _event of stream) {
      // Consume the terminal event so the unreleased latch is durable.
    }
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "failed",
      slotReleased: false,
    });
    expect(target.repository.getNextAutomaticApplicationStart()).toBeNull();
    expect(availabilityKicks).toBe(0);

    target.harness!.snapshots.set(FIRST_SESSION_ID, {
      ...earlyTimeout,
      slotReleased: true,
    });
    const recovered = new ApplicationSessionService({
      repository: target.repository,
      artifacts: target.artifacts,
      harness: target.harness!,
      uuidFactory: () => SECOND_SESSION_ID,
      profileReader: () => PROFILE,
      onApplicationSessionReleased: () => { availabilityKicks++; },
    });
    const previousReleaseReads = target.harness!.getCalls.filter(
      (sessionId) => sessionId === FIRST_SESSION_ID,
    ).length;

    expect(await recovered.startNextAutomaticApplication(signal())).toBe(true);
    expect(target.harness!.getCalls.filter(
      (sessionId) => sessionId === FIRST_SESSION_ID,
    )).toHaveLength(previousReleaseReads + 1);
    expect(target.harness!.createCalls.map(({ sessionId }) => sessionId)).toEqual([
      FIRST_SESSION_ID,
      SECOND_SESSION_ID,
    ]);
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "failed",
      slotReleased: true,
    });
    expect(target.repository.getLatestApplicationSession(second.run.id)).toMatchObject({
      bridgeState: "running",
      slotReleased: false,
    });
    expect(availabilityKicks).toBe(1);
    observerStream.resolve({
      async *[Symbol.asyncIterator]() {
        // Let the retired service observer see the durable release and exit.
      },
    });
    await Promise.resolve();
  });

  test("keeps observing cleanup after the client event stream ends", async () => {
    const released = deferred<void>();
    let availabilityKicks = 0;
    const target = await createTarget({
      skipReview: true,
      onApplicationSessionReleased: () => {
        availabilityKicks++;
        released.resolve();
      },
      sessionIds: [FIRST_SESSION_ID, SECOND_SESSION_ID],
    });
    const second = await createApprovedRun(
      target.repository,
      target.database,
      target.artifacts,
      { id: "run-2", skipReview: true },
    );
    expect(await target.service.startNextAutomaticApplication(signal())).toBe(true);

    const earlyTimeout: ApplicationHarnessSnapshot = {
      ...harnessSnapshot("failed"),
      updatedAt: 10_200,
      slotReleased: false,
      error: {
        code: "session_timeout",
        message: "The application session expired",
      },
    };
    const releasedTimeout: ApplicationHarnessSnapshot = {
      ...earlyTimeout,
      slotReleased: true,
    };
    target.harness!.events = [{
      id: 1,
      event: "failed",
      session: earlyTimeout,
      detail: {},
    }];
    const clientStream = await target.service.events(target.runId, undefined, signal());
    const cleanupEvents = deferred<AsyncIterable<ApplicationHarnessEvent>>();
    target.harness!.streamReplies.push(cleanupEvents.promise);
    for await (const _event of clientStream) {
      // The simulated client stream ends after the early terminal event.
    }

    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "failed",
      slotReleased: false,
    });
    expect(target.harness!.streamCalls.at(-1)).toEqual({
      sessionId: FIRST_SESSION_ID,
      lastEventId: 1,
    });
    cleanupEvents.resolve({
      async *[Symbol.asyncIterator]() {
        yield {
          id: 2,
          event: "snapshot",
          session: releasedTimeout,
          detail: {},
        };
      },
    });
    await released.promise;

    expect(availabilityKicks).toBe(1);
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "failed",
      slotReleased: true,
      lastUpstreamEventId: 2,
    });
    expect(target.repository.getNextAutomaticApplicationStart()).toEqual({
      runId: second.run.id,
      approvedPdfSha256: second.pdf.sha256,
    });
    expect(await target.service.startNextAutomaticApplication(signal())).toBe(true);
    expect(target.harness!.createCalls.map(({ sessionId }) => sessionId)).toEqual([
      FIRST_SESSION_ID,
      SECOND_SESSION_ID,
    ]);
  });

  test("stops cleanup observers without releasing the slot during service disposal", async () => {
    let availabilityKicks = 0;
    const target = await createTarget({
      onApplicationSessionReleased: () => { availabilityKicks++; },
    });
    await target.service.start(target.runId, target.pdf.sha256, signal());
    const earlyTimeout: ApplicationHarnessSnapshot = {
      ...harnessSnapshot("failed"),
      updatedAt: 10_200,
      slotReleased: false,
      error: {
        code: "session_timeout",
        message: "The application session expired",
      },
    };
    target.harness!.events = [{
      id: 1,
      event: "failed",
      session: earlyTimeout,
      detail: {},
    }];
    const clientStream = await target.service.events(target.runId, undefined, signal());
    const observerStream = deferred<AsyncIterable<ApplicationHarnessEvent>>();
    target.harness!.streamReplies.push(observerStream.promise);
    for await (const _event of clientStream) {
      // The client disconnects after persisting the early terminal snapshot.
    }
    const observerSignal = target.harness!.streamSignals.at(-1);
    expect(observerSignal?.aborted).toBeFalse();

    const disposal = target.service.dispose();
    expect(observerSignal?.aborted).toBeTrue();
    observerStream.resolve({
      async *[Symbol.asyncIterator]() {
        yield {
          id: 2,
          event: "snapshot",
          session: { ...earlyTimeout, slotReleased: true },
          detail: {},
        };
      },
    });
    await disposal;

    expect(availabilityKicks).toBe(0);
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "failed",
      slotReleased: false,
    });
  });

  test("releases a retained submitted slot when the harness session is missing", async () => {
    let availabilityKicks = 0;
    const target = await createTarget({
      onApplicationSessionReleased: () => { availabilityKicks++; },
    });
    target.harness!.snapshotAfterCreate = harnessReviewSnapshot();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    target.repository.claimApplicationSubmission(FIRST_SESSION_ID);
    target.repository.finalizeApplicationSubmission(FIRST_SESSION_ID, "submitted");
    target.harness!.events = [{
      id: 1,
      event: "application_submitted",
      session: { ...harnessSnapshot("submitted"), updatedAt: 10_200 },
      detail: {},
    }];
    for await (const _event of await target.service.events(
      target.runId,
      undefined,
      signal(),
    )) {
      // Persist the final submission projection while cleanup is still pending.
    }
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "submitted",
      submissionPhase: "submitted",
      slotReleased: false,
    });
    expect(availabilityKicks).toBe(0);

    target.harness!.streamError = new ApplicationHarnessError("session_not_found");
    await expect(target.service.events(target.runId, undefined, signal()))
      .rejects.toMatchObject({ code: "RUN_CONFLICT", status: 409 });

    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "submitted",
      submissionPhase: "submitted",
      slotReleased: true,
    });
    expect(availabilityKicks).toBe(1);
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

  test("automatically starts an approved edited revision after its cancelled generation is closed", async () => {
    const harness = new FakeHarness();
    harness.snapshotAfterCreate = harnessSnapshot("cancelled");
    const target = await createTarget({
      harness,
      skipReview: true,
      sessionIds: [FIRST_SESSION_ID, SECOND_SESSION_ID, THIRD_SESSION_ID],
    });

    const cancelled = await target.service.start(target.runId, target.pdf.sha256, signal());
    expect(cancelled).toMatchObject({ generation: 1, bridgeState: "cancelled" });
    expect(await target.service.start(target.runId, target.pdf.sha256, signal()))
      .toEqual(cancelled);
    expect(harness.createCalls).toHaveLength(1);

    target.repository.editRun(
      target.runId,
      "Emphasize the platform ownership work.",
      target.pdf.sha256,
    );
    await target.service.close(target.runId, signal());
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      generation: 1,
      bridgeState: "closed",
      resumeRevision: 1,
    });

    const claim = target.repository.acquire();
    if (!claim || claim.runId !== target.runId) throw new Error("edit claim missing");
    for (const stage of ["compiling", "deterministic_qa", "visual_qa"] as const) {
      target.repository.transition(claim, stage);
    }
    const attempt = target.repository.startAttempt(claim, "visual_qa");
    const attemptRoot = await target.artifacts.createAttempt({
      run: target.repository.getRun(target.runId)!.queueSequence,
      revision: "2",
      stage: "visual_qa",
      attempt: attempt.attemptNo,
    });
    const editedPdfBytes = new TextEncoder().encode(
      "%PDF-1.7\nrevised approved resume\n%%EOF\n",
    );
    const editedPdf = await target.artifacts.write(
      join(attemptRoot, "resume.pdf"),
      editedPdfBytes,
      10 * 1024 * 1024,
    );
    target.repository.finalizeArtifact(claim, {
      attemptId: attempt.id,
      stage: "visual_qa",
      kind: "compiled-pdf",
      sha256: editedPdf.sha256,
      path: editedPdf.path,
      byteSize: editedPdf.bytes,
    });
    target.repository.finishAttempt(claim, attempt.id, "succeeded");
    target.repository.transition(claim, "review");
    target.repository.release(claim);

    expect(await target.service.get(target.runId)).toEqual({
      state: "not_started",
      canStart: false,
      canStartAfterApproval: true,
    });

    harness.snapshotAfterCreate = harnessSnapshot("running");
    const blocker = await createApprovedRun(
      target.repository,
      target.database,
      target.artifacts,
      { id: "run-2" },
    );
    expect(await target.service.start(blocker.run.id, blocker.pdf.sha256, signal()))
      .toMatchObject({ generation: 1, bridgeState: "running" });

    target.repository.approve(target.runId, editedPdf.sha256);
    expect(await target.service.get(target.runId)).toEqual({
      state: "not_started",
      canStart: true,
      canStartAfterApproval: false,
    });
    expect(await target.service.startNextAutomaticApplication(signal())).toBe(false);
    expect(harness.createCalls).toHaveLength(2);

    await target.service.close(blocker.run.id, signal());
    expect(await target.service.startNextAutomaticApplication(signal())).toBe(true);
    expect(harness.createCalls).toHaveLength(3);
    expect(harness.createCalls[2]).toMatchObject({
      sessionId: THIRD_SESSION_ID,
      resumePdf: editedPdfBytes,
    });
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      generation: 2,
      sessionId: THIRD_SESSION_ID,
      bridgeState: "running",
      resumeRevision: 2,
      pdfSha256: editedPdf.sha256,
    });
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
        playwrightCliDiagnostics: [{
          step: 3,
          status: "failed",
          exitCode: 1,
          timedOut: false,
          errorCategory: "process_exit",
          stderrExcerpt: "[redacted]",
          stderrTruncated: true,
        }],
      },
      detail: { stepNumber: 3 },
    }];

    const items: ApplicationSessionStreamItem[] = [];
    for await (const item of await target.service.events(
      target.runId,
      { generation: 1, upstreamEventId: 5 },
      signal(),
    )) items.push(item);

    expect(target.harness!.streamCalls).toEqual([{
      sessionId: FIRST_SESSION_ID,
      lastEventId: 5,
    }]);
    expect(items).toEqual([{
      id: "1:6",
      event: {
        generation: 1,
        event: "snapshot",
        session: expect.objectContaining({
          generation: 1,
          bridgeState: "running",
        }),
        detail: {},
      },
    }, {
      id: "1:7",
      event: {
        generation: 1,
        event: "agent_step",
        session: expect.objectContaining({
          generation: 1,
          bridgeState: "running",
          warnings: ["Review the highlighted field"],
          playwrightCliDiagnostics: [{
            step: 3,
            status: "failed",
            exitCode: 1,
            timedOut: false,
            errorCategory: "process_exit",
            stderrExcerpt: "[redacted]",
            stderrTruncated: true,
          }],
        }),
        detail: { stepNumber: 3 },
      },
    }]);
    expect(items[1]?.event.session.updatedAt).toBeGreaterThan(started.updatedAt);
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      generation: 1,
      bridgeState: "running",
      lastUpstreamEventId: 7,
      publicSnapshot: expect.objectContaining({
        generation: 1,
        warnings: ["Review the highlighted field"],
        playwrightCliDiagnostics: [{
          step: 3,
          status: "failed",
          exitCode: 1,
          timedOut: false,
          errorCategory: "process_exit",
          stderrExcerpt: "[redacted]",
          stderrTruncated: true,
        }],
      }),
    });
    const serialized = JSON.stringify(items);
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

  test("replays the persisted credential marker when a connecting browser is behind", async () => {
    const target = await createTarget();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    const gateEvent: ApplicationHarnessEvent = {
      id: 7,
      event: "credentials_required",
      session: {
        ...harnessSnapshot("awaiting_human_navigation"),
        updatedAt: 10_200,
        pendingAction: {
          type: "credentials",
        },
      },
      detail: {},
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
          bridgeState: "awaiting_human_navigation",
          pendingAction: {
            type: "credentials",
          },
        }),
        detail: {},
      },
    });
    await behind.return?.(undefined);
  });

  test("replays the durable snapshot when another stream advances the cursor", async () => {
    const target = await createTarget();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    target.harness!.events = [{
      id: 6,
      event: "agent_step",
      session: {
        ...harnessSnapshot("running"),
        updatedAt: 10_400,
      },
      detail: { stepNumber: 2 },
    }, {
      id: 7,
      event: "agent_step",
      session: {
        ...harnessSnapshot("running"),
        updatedAt: 10_401,
      },
      detail: { stepNumber: 3 },
    }];
    const stream = await target.service.events(target.runId, undefined, signal());
    const current = target.repository.getLatestApplicationSession(target.runId);
    if (!current || current.publicSnapshot === null) throw new Error("snapshot missing");
    target.repository.recordApplicationSnapshot(target.runId, {
      slotReleased: false,
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

    expect(items).toEqual([{
      id: "1:7",
      event: {
        generation: 1,
        event: "snapshot",
        session: expect.objectContaining({
          generation: 1,
          bridgeState: "running",
          updatedAt: 10_300,
        }),
        detail: {},
      },
    }]);
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      lastUpstreamEventId: 7,
      publicSnapshot: expect.objectContaining({ updatedAt: 10_300 }),
    });
  });

  test("advances and emits a stale higher cursor without replacing the durable projection", async () => {
    const target = await createTarget();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    const current = target.repository.getLatestApplicationSession(target.runId);
    if (!current || current.publicSnapshot === null) throw new Error("snapshot missing");
    target.repository.recordApplicationSnapshot(target.runId, {
      slotReleased: false,
      generation: 1,
      sessionId: FIRST_SESSION_ID,
      bridgeState: "running",
      publicSnapshot: {
        ...(current.publicSnapshot as Record<string, unknown>),
        bridgeState: "running",
        harnessState: "running",
        updatedAt: 10_200,
        role: "Durable role",
        pendingAction: null,
      },
      lastUpstreamEventId: 6,
    });
    const staleEvent: ApplicationHarnessEvent = {
      id: 7,
      event: "agent_step",
      session: {
        ...harnessSnapshot("running"),
        updatedAt: 10_199,
        role: "Stale role",
      },
      detail: { stepNumber: 4 },
    };
    target.harness!.events = [staleEvent];

    const items: ApplicationSessionStreamItem[] = [];
    for await (const item of await target.service.events(
      target.runId,
      { generation: 1, upstreamEventId: 6 },
      signal(),
    )) items.push(item);

    expect(items).toEqual([{
      id: "1:7",
      event: {
        generation: 1,
        event: "snapshot",
        session: expect.objectContaining({
          bridgeState: "running",
          updatedAt: 10_200,
          role: "Durable role",
        }),
        detail: {},
      },
    }]);
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      lastUpstreamEventId: 7,
      publicSnapshot: expect.objectContaining({
        updatedAt: 10_200,
        role: "Durable role",
      }),
    });

    target.harness!.events = [staleEvent];
    const reconnectItems: ApplicationSessionStreamItem[] = [];
    for await (const item of await target.service.events(
      target.runId,
      { generation: 1, upstreamEventId: 7 },
      signal(),
    )) reconnectItems.push(item);
    expect(reconnectItems).toEqual([]);
    expect(target.harness!.streamCalls.at(-1)).toEqual({
      sessionId: FIRST_SESSION_ID,
      lastEventId: 7,
    });
  });

  test("reconciles a stale terminal event after a claimed submission as uncertainty", async () => {
    const target = await createTarget();
    target.harness!.snapshotAfterCreate = harnessReviewSnapshot();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    target.repository.claimApplicationSubmission(FIRST_SESSION_ID);
    const current = target.repository.getLatestApplicationSession(target.runId);
    if (!current || current.publicSnapshot === null) throw new Error("snapshot missing");
    target.repository.recordApplicationSnapshot(target.runId, {
      slotReleased: false,
      generation: 1,
      sessionId: FIRST_SESSION_ID,
      bridgeState: "submitting",
      publicSnapshot: {
        ...(current.publicSnapshot as Record<string, unknown>),
        bridgeState: "submitting",
        harnessState: "submitting",
        submissionPhase: "attempting",
        updatedAt: 10_200,
        pendingAction: null,
      },
      lastUpstreamEventId: 6,
    });
    target.harness!.events = [{
      id: 7,
      event: "application_submitted",
      session: {
        ...harnessSnapshot("submitted"),
        updatedAt: 10_199,
      },
      detail: {},
    }];

    const items: ApplicationSessionStreamItem[] = [];
    for await (const item of await target.service.events(
      target.runId,
      { generation: 1, upstreamEventId: 6 },
      signal(),
    )) items.push(item);

    expect(items).toEqual([{
      id: "1:7",
      event: {
        generation: 1,
        event: "snapshot",
        session: expect.objectContaining({
          bridgeState: "submission_uncertain",
          harnessState: "submission_uncertain",
          submissionPhase: "uncertain",
          updatedAt: expect.any(Number),
        }),
        detail: {},
      },
    }]);
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "submission_uncertain",
      submissionPhase: "uncertain",
      lastUpstreamEventId: 7,
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

  test("rejects submit until the durable projection is awaiting human review", async () => {
    const running = await createTarget();
    await running.service.start(running.runId, running.pdf.sha256, signal());
    await expect(running.service.command(
      running.runId,
      { type: "submit" },
      signal(),
    )).rejects.toMatchObject({
      code: "APPLICATION_COMMAND_CONFLICT",
      status: 409,
    });
    expect(running.harness!.commandCalls).toEqual([]);

    const reviewHarness = new FakeHarness();
    reviewHarness.snapshotAfterCreate = harnessReviewSnapshot();
    const review = await createTarget({ harness: reviewHarness });
    await review.service.start(review.runId, review.pdf.sha256, signal());
    await review.service.command(review.runId, { type: "submit" }, signal());
    expect(reviewHarness.commandCalls).toEqual([{
      sessionId: FIRST_SESSION_ID,
      command: { type: "submit" },
    }]);
  });

  test("persists an expired terminal snapshot before returning command conflict", async () => {
    const target = await createTarget();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    const expiredSnapshot: ApplicationHarnessSnapshot = {
      ...harnessSnapshot("failed"),
      updatedAt: 20_000,
      slotReleased: false,
      error: {
        code: "session_timeout",
        message: "The application session expired",
      },
    };
    target.harness!.snapshots.set(FIRST_SESSION_ID, expiredSnapshot);
    target.harness!.commandError = new ApplicationHarnessError("session_terminal");
    const getCallCount = target.harness!.getCalls.length;

    await expect(
      target.service.command(target.runId, { type: "cancel" }, signal()),
    ).rejects.toMatchObject({
      code: "APPLICATION_COMMAND_CONFLICT",
      status: 409,
    });

    const reconciliationReads = target.harness!.getCalls.slice(getCallCount);
    expect(reconciliationReads.length).toBeGreaterThanOrEqual(1);
    expect(reconciliationReads.every((sessionId) => sessionId === FIRST_SESSION_ID)).toBeTrue();
    expect(await target.service.get(target.runId)).toMatchObject({
      generation: 1,
      bridgeState: "failed",
      harnessState: "failed",
      updatedAt: 20_000,
      terminalAt: expect.any(Number),
      pendingAction: null,
      error: {
        code: "session_timeout",
        message: "The application session expired",
      },
    });
    expect(target.repository.getLatestApplicationSession(target.runId)).toMatchObject({
      bridgeState: "failed",
      publicSnapshot: expect.objectContaining({
        bridgeState: "failed",
        harnessState: "failed",
        error: {
          code: "session_timeout",
          message: "The application session expired",
        },
      }),
    });
  });

  test("preserves a repository conflict while reconciling a command", async () => {
    const target = await createTarget();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    const harness = target.harness!;
    harness.commandError = new ApplicationHarnessError("command_conflict");
    target.repository.recordApplicationSnapshotWithSlotTransition = () => {
      throw new RepositoryConflictError("application session changed");
    };

    await expect(
      target.service.command(target.runId, { type: "cancel" }, signal()),
    ).rejects.toMatchObject({
      code: "RUN_CONFLICT",
      status: 409,
    });
    expect(harness.getCalls.at(-1)).toBe(FIRST_SESSION_ID);
  });

  test("marks a missing harness session lost while reconciling a command", async () => {
    const target = await createTarget();
    await target.service.start(target.runId, target.pdf.sha256, signal());
    const harness = target.harness!;
    harness.commandError = new ApplicationHarnessError("command_conflict");
    harness.snapshots.delete(FIRST_SESSION_ID);

    await expect(
      target.service.command(target.runId, { type: "cancel" }, signal()),
    ).rejects.toMatchObject({
      code: "APPLICATION_COMMAND_CONFLICT",
      status: 409,
    });
    await expect(target.service.get(target.runId)).resolves.toMatchObject({
      generation: 1,
      bridgeState: "lost",
      pendingAction: null,
    });
  });

  test("forwards credentials only to the harness and retains only the durable gate marker", async () => {
    const harness = new FakeHarness();
    harness.snapshotAfterCreate = {
      ...harnessSnapshot("awaiting_human_navigation"),
      pendingAction: { type: "credentials" },
    };
    const target = await createTarget({ harness });
    await target.service.start(target.runId, target.pdf.sha256, signal());
    const commands = [
      {
        type: "sign_in",
        username: "sign-in-private@example.test",
        password: "PRIVATE SIGN IN PASSWORD",
      },
      {
        type: "save_credentials",
        username: "saved-private@example.test",
        password: "PRIVATE SAVED PASSWORD",
      },
    ] satisfies ApplicationSessionCommand[];

    for (const command of commands) {
      await expect(target.service.command(target.runId, command, signal()))
        .resolves.toBeUndefined();
    }

    expect(harness.commandCalls).toEqual(commands.map((command) => ({
      sessionId: FIRST_SESSION_ID,
      command,
    })));
    const publicData = JSON.stringify({
      snapshot: await target.service.get(target.runId),
      durableProjection: target.repository.getLatestApplicationSession(target.runId)
        ?.publicSnapshot,
    });
    expect(JSON.parse(publicData)).toMatchObject({
      snapshot: {
        bridgeState: "awaiting_human_navigation",
        pendingAction: { type: "credentials" },
      },
      durableProjection: {
        bridgeState: "awaiting_human_navigation",
        pendingAction: { type: "credentials" },
      },
    });
    for (const command of commands) {
      expect(publicData).not.toContain(command.username);
      expect(publicData).not.toContain(command.password);
    }

    harness.commandError = new ApplicationHarnessError("command_conflict");
    let conflict: unknown;
    try {
      await target.service.command(target.runId, commands[0]!, signal());
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({
      code: "APPLICATION_COMMAND_CONFLICT",
      message: "The application state changed; review the latest session state",
      status: 409,
    });
    expect(String(conflict)).not.toContain(commands[0]!.username);
    expect(String(conflict)).not.toContain(commands[0]!.password);
  });

  test("forwards accepted live commands without persistence and closes active, reserved, and lost sessions", async () => {
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
    const privateFinalAnswer = "PROFESSIONAL PRIVATE ANSWER";
    const command: ApplicationSessionCommand = {
      type: "provide_additional_info",
      answers: [{
        id: "preferred_name",
        status: "answered",
        raw_value: privateAnswer,
        value: privateFinalAnswer,
      }],
    };
    await commandTarget.service.command(commandTarget.runId, command, signal());
    expect(commandHarness.commandCalls).toEqual([{
      sessionId: FIRST_SESSION_ID,
      command,
    }]);
    expect(JSON.stringify(
      commandTarget.repository.getLatestApplicationSession(commandTarget.runId)?.publicSnapshot,
    )).not.toContain(privateAnswer);
    expect(JSON.stringify(
      commandTarget.repository.getLatestApplicationSession(commandTarget.runId)?.publicSnapshot,
    )).not.toContain(privateFinalAnswer);

    const getCallCountBeforeConflict = commandHarness.getCalls.length;
    commandHarness.commandError = new ApplicationHarnessError("command_conflict");
    await expect(
      commandTarget.service.command(commandTarget.runId, command, signal()),
    ).rejects.toMatchObject({
      code: "APPLICATION_COMMAND_CONFLICT",
      message: "The application state changed; review the latest session state",
      status: 409,
    });
    expect(commandHarness.getCalls.slice(getCallCountBeforeConflict)).toEqual([
      FIRST_SESSION_ID,
    ]);
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
    expect(target.repository.getRun(target.runId)?.applicationStatus).toBe("pending");
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

  test("brokers only strict suggestions for the current live text question", async () => {
    const harness = new FakeHarness();
    harness.snapshotAfterCreate = harnessTextQuestionSnapshot();
    harness.suggestionsResponse = {
      suggestions: [{
        question: "What name should applications use?",
        answer: "Please use Alex Morgan.",
      }],
    };
    const target = await createTarget({ harness });
    await target.service.start(target.runId, target.pdf.sha256, signal());

    await expect(target.service.suggestions(
      target.runId,
      "preferred_name",
      signal(),
    )).resolves.toEqual(harness.suggestionsResponse);
    expect(harness.suggestionCalls).toEqual([{
      sessionId: FIRST_SESSION_ID,
      questionId: "preferred_name",
    }]);
    expect(JSON.stringify(await target.service.suggestions(
      target.runId,
      "preferred_name",
      signal(),
    ))).not.toContain("key");

    harness.snapshots.set(FIRST_SESSION_ID, {
      ...harnessSnapshot("awaiting_additional_info"),
      pendingAction: {
        type: "additional_info",
        questions: [{
          id: "preferred_name",
          scope: "global",
          question: "May we contact your manager?",
          answerType: "boolean",
        }],
      },
    });
    await expect(target.service.suggestions(
      target.runId,
      "preferred_name",
      signal(),
    )).rejects.toMatchObject({
      code: "APPLICATION_QUESTION_STALE",
      status: 409,
    });
    expect(harness.suggestionCalls).toHaveLength(2);
  });

  test("does not return suggestions after the pending question changes during the broker call", async () => {
    const harness = new FakeHarness();
    harness.snapshotAfterCreate = harnessTextQuestionSnapshot();
    const pending = deferred<ApplicationAnswerSuggestionsResponse>();
    harness.suggestionReplies.push(pending.promise);
    const target = await createTarget({ harness });
    await target.service.start(target.runId, target.pdf.sha256, signal());

    const request = target.service.suggestions(
      target.runId,
      "preferred_name",
      signal(),
    );
    await Promise.resolve();
    harness.snapshots.set(
      FIRST_SESSION_ID,
      harnessTextQuestionSnapshot("What legal name should applications use?"),
    );
    pending.resolve({
      suggestions: [{
        question: "Private prior question",
        answer: "Private prior answer",
      }],
    });

    const error = await request.catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "APPLICATION_QUESTION_STALE",
      message: "The application question changed; review the latest session state",
      status: 409,
    });
    expect(JSON.stringify(error)).not.toContain("Private prior");
  });

  test("professionalizes the current text question and rejects a result when the gate changes", async () => {
    const harness = new FakeHarness();
    harness.snapshotAfterCreate = harnessTextQuestionSnapshot();
    const revisions = deferred<string>();
    const professionalizeCalls: Array<{
      question: string;
      request: ApplicationProfessionalizeRequest;
      signal: AbortSignal | undefined;
    }> = [];
    const target = await createTarget({
      harness,
      professionalizeAnswer: async (question, request, requestSignal) => {
        professionalizeCalls.push({ question, request, signal: requestSignal });
        return await revisions.promise;
      },
    });
    await target.service.start(target.runId, target.pdf.sha256, signal());
    const requestSignal = signal();
    const request = target.service.professionalize(
      target.runId,
      "preferred_name",
      {
        promptId: "default",
        draft: "call me alex",
        instruction: "Use a complete sentence.",
      },
      requestSignal,
    );
    await Promise.resolve();
    harness.snapshots.set(
      FIRST_SESSION_ID,
      harnessTextQuestionSnapshot("What legal name should applications use?"),
    );
    revisions.resolve("Please use Alex Morgan.");

    await expect(request).rejects.toMatchObject({
      code: "APPLICATION_QUESTION_STALE",
      status: 409,
    });
    expect(professionalizeCalls).toEqual([{
      question: "What name should applications use?",
      request: {
        promptId: "default",
        draft: "call me alex",
        instruction: "Use a complete sentence.",
      },
      signal: requestSignal,
    }]);
  });

  test("returns one strict professional answer and maps model failures to bounded public errors", async () => {
    const harness = new FakeHarness();
    harness.snapshotAfterCreate = harnessTextQuestionSnapshot();
    const target = await createTarget({
      harness,
      professionalizeAnswer: async () => "Please use Alex Morgan.",
    });
    await target.service.start(target.runId, target.pdf.sha256, signal());
    await expect(target.service.professionalize(
      target.runId,
      "preferred_name",
      { promptId: "default", draft: "call me alex" },
      signal(),
    )).resolves.toEqual({ answer: "Please use Alex Morgan." });

    const failures = [
      [new OAuthRequiredError("openai-codex"), "OAUTH_REQUIRED", 409],
      [
        new ApplicationAnswerProfessionalizationError(
          "timeout",
          "private timeout detail",
        ),
        "MODEL_TIMEOUT",
        504,
      ],
      [
        new ApplicationAnswerProfessionalizationError(
          "invalid_output",
          "private invalid answer",
        ),
        "INVALID_MODEL_OUTPUT",
        502,
      ],
      [
        new ApplicationAnswerProfessionalizationError(
          "unavailable",
          "Bearer private provider detail",
        ),
        "MODEL_PROVIDER_FAILED",
        502,
      ],
    ] as const;
    for (const [failure, code, status] of failures) {
      const failedHarness = new FakeHarness();
      failedHarness.snapshotAfterCreate = harnessTextQuestionSnapshot();
      const failed = await createTarget({
        harness: failedHarness,
        professionalizeAnswer: async () => { throw failure; },
      });
      await failed.service.start(failed.runId, failed.pdf.sha256, signal());
      const error = await failed.service.professionalize(
        failed.runId,
        "preferred_name",
        { promptId: "default", draft: "draft" },
        signal(),
      ).catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code, status });
      expect(String(error)).not.toContain("private");
      expect(String(error)).not.toContain("Bearer");
    }
  });
});
