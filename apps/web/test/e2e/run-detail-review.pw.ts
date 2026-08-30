import { createServer, type Server } from "node:http";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  ApiErrorSchema,
  ApplicationSessionEventDtoSchema,
  ApplicationSessionSnapshotDtoSchema,
  ApplicationSessionViewSchema,
  ArtifactDtoSchema,
  ResumeIterationListResponseSchema,
  RunDtoSchema,
  type ApiError,
  type ApplicationAdditionalInfoQuestion,
  type ApplicationPendingAction,
  type ApplicationSessionBridgeState,
  type ApplicationSessionCommand,
  type ApplicationSessionEventDto,
  type ApplicationSessionSnapshotDto,
  type ApplicationSessionView,
  type ArtifactDto,
  type HarnessSessionState,
  type ResumeIterationDto,
  type ResumeIterationListResponse,
  type RevisionOrigin,
  type RunDto,
  type RunStatus,
} from "@jobhunter/pipeline/contracts";

const runId = "run-detail-review-workspace";
const pipelineRunPath = `/api/pipeline/runs/${runId}`;
const nativeSsePort = Number(process.env.JOBHUNTER_E2E_PIPELINE_PORT ?? "3467");
const createdAt = 1_700_000_000_000;
const jobUrl = "https://jobs.example.com/platform-engineer";
const expiresAt = 1_700_086_400_000;
const pdfHash1 = "1".repeat(64);
const pdfHash2 = "2".repeat(64);
const pdfHash3 = "3".repeat(64);
const pdfHash4 = "4".repeat(64);
const privateHarnessValues = [
  "http://127.0.0.1:8765",
  "e8bd7e20-f9b7-46ad-974f-80703b09b554",
  "Bearer private-harness-token",
  "https://jobs.private.example.test/staff-engineer",
  "https://previous-approved-origin.private.example.test",
  "/home/private/applicant-profile.md",
  "private-returned-answer",
] as const;
const privateCredentialUsername = "credential-user@example.test";
const privateCredentialPassword = "credential password must stay private";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface QueuedReply {
  readonly status: number;
  readonly body?: unknown;
  readonly before?: () => void;
  readonly waitFor?: Promise<void>;
}

interface SseReply {
  readonly body: string;
  readonly publicEvents: readonly ApplicationSessionEventDto[];
  readonly waitFor: Promise<void>;
  readonly before?: () => void;
}

interface RequestRecord {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

interface MockPipeline {
  run: RunDto;
  iterations: ResumeIterationListResponse;
  application: ApplicationSessionView;
  editReply: RunDto | null;
  readonly runReplies: QueuedReply[];
  readonly editReplies: QueuedReply[];
  regenerateReply: RunDto | null;
  approveReply: RunDto | null;
  readonly startReplies: QueuedReply[];
  readonly retryReplies: QueuedReply[];
  readonly commandReplies: QueuedReply[];
  readonly suggestionReplies: QueuedReply[];
  readonly professionalizeReplies: QueuedReply[];
  readonly sseReplies: SseReply[];
  readonly useNativeSse: boolean;
  onDelete: (() => void) | null;
  readonly requests: RequestRecord[];
  readonly commands: ApplicationSessionCommand[];
  readonly startBodies: unknown[];
  readonly retryBodies: unknown[];
  readonly sseHeaders: Array<string | null>;
  readonly artifactRequests: string[];
  readonly publicResponseBodies: string[];
  runGetCount: number;
  applicationGetCount: number;
  deleteCount: number;
}

interface NativeSseScenario {
  readonly headers: Array<string | null>;
  readonly servedBodies: string[];
  readonly initialBody: string;
  readonly resumedBody: string;
  readonly initialFollowupBody?: string;
  readonly onResume: () => void;
  readonly waitForResume: Promise<void>;
  readonly waitForInitialClose?: Promise<void>;
  readonly waitForInitialFollowup?: Promise<void>;
}

let nativeSseScenario: NativeSseScenario | null = null;
let nativeSseServer: Server;

test.beforeAll(async () => {
  nativeSseServer = createServer(async (request, response) => {
    if (
      request.method !== "GET"
      || request.url !== `/v1/runs/${runId}/application/events`
      || nativeSseScenario === null
    ) {
      response.writeHead(404).end();
      return;
    }
    const rawCursor = request.headers["last-event-id"];
    if (!request.headers.accept?.includes("text/event-stream")) {
      response.writeHead(406).end();
      return;
    }
    const cursor = Array.isArray(rawCursor) ? rawCursor[0] ?? null : rawCursor ?? null;
    const connectionOrdinal = nativeSseScenario.headers.length + 1;
    nativeSseScenario.headers.push(cursor);
    const resumed = connectionOrdinal > 1;
    if (resumed) {
      await nativeSseScenario.waitForResume;
      nativeSseScenario.onResume();
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/event-stream",
      connection: "close",
    });
    const body = resumed ? nativeSseScenario.resumedBody : nativeSseScenario.initialBody;
    nativeSseScenario.servedBodies.push(body);
    response.write(body);
    if (!resumed && nativeSseScenario.initialFollowupBody !== undefined) {
      await nativeSseScenario.waitForInitialFollowup;
      nativeSseScenario.servedBodies.push(nativeSseScenario.initialFollowupBody);
      response.write(nativeSseScenario.initialFollowupBody);
    }
    if (!resumed) await nativeSseScenario.waitForInitialClose;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    nativeSseServer.once("error", reject);
    nativeSseServer.listen(nativeSsePort, "127.0.0.1", () => {
      nativeSseServer.off("error", reject);
      resolve();
    });
  });
});

test.afterEach(() => {
  nativeSseScenario = null;
});

test.afterAll(async () => {
  if (!nativeSseServer.listening) return;
  await new Promise<void>((resolve, reject) => {
    nativeSseServer.close((error) => error ? reject(error) : resolve());
  });
});

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function installSoundProbe(page: Page): Promise<() => Promise<number[]>> {
  await page.addInitScript(() => {
    const audioWindow = window as typeof window & { __soundFrequencies: number[] };
    Object.defineProperty(audioWindow, "__soundFrequencies", {
      configurable: true,
      value: [],
    });
    const nativeStart = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (when?: number): void {
      audioWindow.__soundFrequencies.push(this.frequency.value);
      nativeStart.call(this, when);
    };
  });
  return () => page.evaluate(() => (
    window as typeof window & { __soundFrequencies: number[] }
  ).__soundFrequencies);
}


function onePagePdfFixture(): Buffer {
  const stream = "BT /F1 24 Tf 72 540 Td (Review workspace fixture) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

const pdfFixture = onePagePdfFixture();

function artifact(
  revision: number,
  kind: ArtifactDto["kind"],
  id: string,
  sha256: string,
  mediaType: string,
): ArtifactDto {
  return ArtifactDtoSchema.parse({
    id,
    kind,
    revision,
    attempt: 1,
    sha256,
    bytes: kind.endsWith("pdf") || kind === "compiled-pdf" ? pdfFixture.byteLength : 1_024,
    mediaType,
    href: `/v1/runs/${runId}/iterations/${revision}/artifacts/${id}`,
    public: true,
    createdAt: createdAt + revision * 1_000,
  });
}

function revisionArtifacts(revision: number, pdfSha256: string): ArtifactDto[] {
  return [
    artifact(revision, "job-analysis", `analysis-r${revision}`, "a".repeat(64), "application/json"),
    artifact(revision, "ats-keyword-extraction", `extraction-r${revision}`, "b".repeat(64), "application/json; charset=utf-8"),
    artifact(revision, "compiled-pdf", `resume-r${revision}`, pdfSha256, "application/pdf"),
    artifact(revision, "keyword-map-pdf", `keyword-map-r${revision}`, "c".repeat(64), "application/pdf"),
    artifact(revision, "keyword-map", `keyword-coverage-r${revision}`, "e".repeat(64), "application/json"),
    artifact(revision, "resume-diff", `diff-r${revision}`, "d".repeat(64), "application/json"),
  ];
}

function iteration(
  revision: number,
  origin: RevisionOrigin,
  pdfSha256: string,
  status: ResumeIterationDto["status"] = "review",
): ResumeIterationDto {
  return {
    revision,
    origin,
    status,
    createdAt: createdAt + revision * 10_000,
    pdfSha256,
    artifacts: revisionArtifacts(revision, pdfSha256),
  } satisfies ResumeIterationDto;
}

function iterationList(...iterations: ResumeIterationDto[]): ResumeIterationListResponse {
  return ResumeIterationListResponseSchema.parse({
    artifactState: "retained",
    iterations,
  });
}

function currentRunArtifacts(revision: number, pdfSha256: string): ArtifactDto[] {
  return revisionArtifacts(revision, pdfSha256).map((candidate) => ArtifactDtoSchema.parse({
    ...candidate,
    href: `/v1/runs/${runId}/artifacts/${candidate.id}`,
  }));
}

function runFixture(options: {
  readonly status?: RunStatus;
  readonly revision?: number;
  readonly origin?: RevisionOrigin;
  readonly pdfSha256?: string | null;
  readonly visualAcknowledgementRequired?: boolean;
} = {}): RunDto {
  const revision = options.revision ?? 2;
  const pdfSha256 = options.pdfSha256 === undefined ? pdfHash2 : options.pdfSha256;
  return RunDtoSchema.parse({
    id: runId,
    opportunityKind: "job",
    status: options.status ?? "review",
    applicationStatus: "pending",
    generateKeywordMap: true,
    skipReview: false,
    autoSubmit: false,
    queueSequence: 1,
    revision,
    origin: options.origin ?? "human-comments",
    createdAt,
    updatedAt: createdAt + revision * 10_000,
    ...(pdfSha256 === null ? {} : { currentPdfSha256: pdfSha256 }),
    visualAcknowledgementRequired: options.visualAcknowledgementRequired ?? false,
    attempts: [],
    artifacts: pdfSha256 === null ? [] : currentRunArtifacts(revision, pdfSha256),
    timeline: [],
  });
}

function notStartedAfterApproval(): ApplicationSessionView {
  return ApplicationSessionViewSchema.parse({
    state: "not_started",
    canStart: false,
    canStartAfterApproval: true,
  });
}

function notStartedApproved(): ApplicationSessionView {
  return ApplicationSessionViewSchema.parse({
    state: "not_started",
    canStart: true,
    canStartAfterApproval: false,
  });
}

function notStartedBlocked(
  blockedReason: "legacy_job_url_unavailable" | "job_url_requires_https" | "resume_not_approved" | "artifacts_pruned" | "harness_unconfigured" | "profile_unavailable",
): ApplicationSessionView {
  return ApplicationSessionViewSchema.parse({
    state: "not_started",
    canStart: false,
    canStartAfterApproval: false,
    blockedReason,
  });
}

function snapshotFixture(options: {
  readonly bridgeState: ApplicationSessionBridgeState;
  readonly generation?: number;
  readonly updatedAt?: number;
  readonly harnessState?: HarnessSessionState | null;
  readonly pendingAction?: ApplicationPendingAction | null;
  readonly submissionPhase?: ApplicationSessionSnapshotDto["submissionPhase"];
  readonly revisionCount?: number;
  readonly company?: string;
  readonly role?: string;
  readonly fieldsFilled?: ApplicationSessionSnapshotDto["fieldsFilled"];
  readonly fieldsNeedingHuman?: ApplicationSessionSnapshotDto["fieldsNeedingHuman"];
  readonly filesAttached?: readonly string[];
  readonly warnings?: readonly string[];
}): ApplicationSessionSnapshotDto {
  const generation = options.generation ?? 1;
  const updatedAt = options.updatedAt ?? createdAt + generation * 100;
  const terminal = ["cancelled", "failed", "closed", "lost"].includes(options.bridgeState);
  const harnessState = options.harnessState !== undefined
    ? options.harnessState
    : options.bridgeState === "reserved"
      ? null
      : options.bridgeState === "lost"
        ? "running"
        : options.bridgeState;
  return ApplicationSessionSnapshotDtoSchema.parse({
    generation,
    bridgeState: options.bridgeState,
    harnessState,
    submissionPhase: options.submissionPhase
      ?? (options.bridgeState === "submitting"
        ? "attempting"
        : options.bridgeState === "submitted"
          ? "submitted"
          : options.bridgeState === "submission_uncertain"
            ? "uncertain"
            : "not_attempted"),
    createdAt,
    updatedAt,
    terminalAt: terminal ? updatedAt : null,
    expiresAt: options.bridgeState === "reserved" ? null : expiresAt,
    company: options.company ?? "Public Example Company",
    role: options.role ?? "Public Staff Engineer",
    fieldsFilled: options.fieldsFilled ?? [{
      label: "Legal name",
      fieldType: "text",
      valuePresent: true,
      note: "Filled from the applicant profile",
    }],
    fieldsNeedingHuman: options.fieldsNeedingHuman ?? [],
    filesAttached: options.filesAttached ?? ["tailored-resume.pdf"],
    warnings: options.warnings ?? [],
    revisionCount: options.revisionCount ?? 0,
    pendingAction: options.pendingAction ?? null,
    error: options.bridgeState === "failed"
      ? { code: "browser_failed", message: "The browser session failed" }
      : null,
  });
}

function apiError(code: string, message: string): ApiError {
  return ApiErrorSchema.parse({ error: { code, message } });
}

function eventFixture(
  event: ApplicationSessionEventDto["event"],
  session: ApplicationSessionSnapshotDto,
  detail: unknown,
): ApplicationSessionEventDto {
  return ApplicationSessionEventDtoSchema.parse({
    generation: session.generation,
    event,
    session,
    detail,
  });
}

function eventBlock(event: ApplicationSessionEventDto, cursor: number): string {
  return `id: ${event.generation}:${cursor}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
}

function queueSse(
  mock: MockPipeline,
  event: ApplicationSessionEventDto,
  cursor: number,
  waitFor: Promise<void> = Promise.resolve(),
  before?: () => void,
): void {
  mock.sseReplies.push({
    body: `retry: 25\n${eventBlock(event, cursor)}`,
    publicEvents: [event],
    waitFor,
    before,
  });
}

function queueSseBatch(
  mock: MockPipeline,
  events: ReadonlyArray<{ readonly event: ApplicationSessionEventDto; readonly cursor: number }>,
  waitFor: Promise<void> = Promise.resolve(),
  before?: () => void,
): void {
  mock.sseReplies.push({
    body: `retry: 100\n${events.map(({ event, cursor }) => eventBlock(event, cursor)).join("")}`,
    publicEvents: events.map(({ event }) => event),
    waitFor,
    before,
  });
}

function queueMalformedSse(
  mock: MockPipeline,
  body: string,
  before?: () => void,
): void {
  mock.sseReplies.push({
    body,
    publicEvents: [],
    waitFor: Promise.resolve(),
    before,
  });
}

function analysisPayload(revision: number): unknown {
  return {
    schemaVersion: 2,
    id: `analysis-public-r${revision}`,
    jobDescriptionSha256: "e".repeat(64),
    analysisWorkflowSha256: "f".repeat(64),
    baselineSha256: "0".repeat(64),
    target: {
      title: `Public Role ${revision}`,
      organization: `Public Organization ${revision}`,
    },
    jdKeywords: [{
      id: `included-r${revision}`,
      phrase: `Revision ${revision} orchestration`,
      jdQuote: `Revision ${revision} orchestration is required.`,
      evidenceIds: [`evidence-r${revision}`],
    }],
    exactEdits: [],
  };
}

function extractionPayload(revision: number): unknown {
  return {
    schemaVersion: 1,
    jobDescriptionSha256: "e".repeat(64),
    keywordExtractionWorkflowSha256: "f".repeat(64),
    keywords: [
      {
        id: `included-r${revision}`,
        phrase: `Revision ${revision} orchestration`,
        jdQuote: `Revision ${revision} orchestration is required.`,
      },
      {
        id: `missing-r${revision}`,
        phrase: `Revision ${revision} missing phrase`,
        jdQuote: `Revision ${revision} missing phrase is useful.`,
      },
    ],
  };
}

function keywordCoveragePayload(revision: number, pdfSha256: string): unknown {
  return {
    schemaVersion: 1,
    pdfSha256,
    keywords: [
      {
        id: `included-r${revision}`,
        phrase: `Revision ${revision} orchestration`,
        found: true,
      },
      {
        id: `missing-r${revision}`,
        phrase: `Revision ${revision} missing phrase`,
        found: false,
      },
    ],
  };
}

function diffPayload(revision: number): unknown {
  return {
    schemaVersion: 1,
    baselineSha256: "0".repeat(64),
    planId: `plan-r${revision}`,
    sections: [{
      id: "experience",
      label: "Experience",
      groups: [{
        id: "public-company",
        label: "Public Company",
        rows: [{
          id: `row-r${revision}`,
          kind: "bullet",
          change: "edited",
          before: "Canonical public resume line.",
          after: `Current public resume line for revision ${revision}.`,
        }],
      }],
    }],
  };
}

async function fulfillJson(
  route: Route,
  mock: MockPipeline,
  body: unknown,
  status = 200,
): Promise<void> {
  const serialized = JSON.stringify(body);
  mock.publicResponseBodies.push(serialized);
  await route.fulfill({
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
    body: serialized,
  });
}

async function installPipeline(
  page: Page,
  options: {
    readonly run?: RunDto;
    readonly iterations?: ResumeIterationListResponse;
    readonly application?: ApplicationSessionView;
    readonly useNativeSse?: boolean;
  } = {},
): Promise<MockPipeline> {
  const mock: MockPipeline = {
    run: options.run ?? runFixture(),
    iterations: options.iterations ?? iterationList(
      iteration(1, "initial", pdfHash1),
      iteration(2, "human-comments", pdfHash2),
    ),
    application: options.application ?? notStartedAfterApproval(),
    runReplies: [],
    editReply: null,
    editReplies: [],
    regenerateReply: null,
    approveReply: null,
    startReplies: [],
    retryReplies: [],
    commandReplies: [],
    suggestionReplies: [],
    professionalizeReplies: [],
    sseReplies: [],
    useNativeSse: options.useNativeSse ?? false,
    onDelete: null,
    requests: [],
    commands: [],
    startBodies: [],
    retryBodies: [],
    sseHeaders: [],
    artifactRequests: [],
    publicResponseBodies: [],
    runGetCount: 0,
    applicationGetCount: 0,
    deleteCount: 0,
  };

  await page.route("**/api/pipeline/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    expect(url.search).toBe("");
    const requestBody = method === "POST" ? request.postDataJSON() as unknown : undefined;
    mock.requests.push({ method, path, ...(requestBody === undefined ? {} : { body: requestBody }) });

    if (path === pipelineRunPath && method === "GET") {
      mock.runGetCount += 1;
      const queuedReply = mock.runReplies.shift();
      if (queuedReply) {
        await queuedReply.waitFor;
        queuedReply.before?.();
        if (queuedReply.status !== 200) {
          await fulfillJson(route, mock, queuedReply.body, queuedReply.status);
          return;
        }
        mock.run = RunDtoSchema.parse(queuedReply.body ?? mock.run);
      }
      await fulfillJson(route, mock, RunDtoSchema.parse(mock.run));
      return;
    }
    if (path === `${pipelineRunPath}/iterations` && method === "GET") {
      await fulfillJson(route, mock, ResumeIterationListResponseSchema.parse(mock.iterations));
      return;
    }

    const artifactPrefix = `${pipelineRunPath}/iterations/`;
    if (path.startsWith(artifactPrefix) && method === "GET") {
      const segments = path.slice(pipelineRunPath.length + 1).split("/");
      expect(segments).toHaveLength(4);
      expect(segments[0]).toBe("iterations");
      expect(segments[2]).toBe("artifacts");
      const revision = Number(segments[1]);
      const artifactId = decodeURIComponent(segments[3]!);
      const selectedIteration = mock.iterations.iterations.find((candidate) => candidate.revision === revision);
      const selectedArtifact = selectedIteration?.artifacts.find((candidate) => candidate.id === artifactId);
      expect(selectedArtifact, `authorized artifact ${revision}/${artifactId}`).toBeDefined();
      mock.artifactRequests.push(path);
      if (selectedArtifact?.kind === "job-analysis") {
        await fulfillJson(route, mock, analysisPayload(revision));
        return;
      }
      if (selectedArtifact?.kind === "ats-keyword-extraction") {
        await fulfillJson(route, mock, extractionPayload(revision));
        return;
      }
      if (selectedArtifact?.kind === "keyword-map") {
        await fulfillJson(route, mock, keywordCoveragePayload(revision, selectedIteration!.pdfSha256));
        return;
      }
      if (selectedArtifact?.kind === "resume-diff") {
        await fulfillJson(route, mock, diffPayload(revision));
        return;
      }
      if (selectedArtifact?.kind === "compiled-pdf" || selectedArtifact?.kind === "keyword-map-pdf") {
        await route.fulfill({
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/pdf",
          },
          body: pdfFixture,
        });
        return;
      }
      throw new Error(`No public artifact fixture for ${revision}/${artifactId}`);
    }

    if (path === `${pipelineRunPath}/edit` && method === "POST") {
      const queuedReply = mock.editReplies.shift();
      if (queuedReply) {
        await queuedReply.waitFor;
        queuedReply.before?.();
        if (queuedReply.status !== 200) {
          await fulfillJson(route, mock, queuedReply.body, queuedReply.status);
          return;
        }
      }
      if (!mock.editReply) throw new Error("Unexpected edit request without a queued run reply");
      mock.run = RunDtoSchema.parse(mock.editReply);
      await fulfillJson(route, mock, mock.run);
      return;
    }
    if (path === `${pipelineRunPath}/regenerate` && method === "POST") {
      if (!mock.regenerateReply) throw new Error("Unexpected regeneration request without a queued run reply");
      mock.run = RunDtoSchema.parse(mock.regenerateReply);
      await fulfillJson(route, mock, mock.run);
      return;
    }
    if (path === `${pipelineRunPath}/approve` && method === "POST") {
      if (!mock.approveReply) throw new Error("Unexpected approval request without a queued run reply");
      mock.run = RunDtoSchema.parse(mock.approveReply);
      await fulfillJson(route, mock, mock.run);
      return;
    }

    const additionalInfoPrefix = `${pipelineRunPath}/application/additional-info/`;
    if (
      path.startsWith(additionalInfoPrefix)
      && path.endsWith("/suggestions")
      && method === "POST"
    ) {
      expect(requestBody).toEqual({});
      const reply = mock.suggestionReplies.shift();
      if (!reply) throw new Error("Unexpected previous-answer request without a queued reply");
      await reply.waitFor;
      reply.before?.();
      await fulfillJson(route, mock, reply.body, reply.status);
      return;
    }
    if (
      path.startsWith(additionalInfoPrefix)
      && path.endsWith("/professionalize")
      && method === "POST"
    ) {
      const reply = mock.professionalizeReplies.shift();
      if (!reply) throw new Error("Unexpected professionalize request without a queued reply");
      await reply.waitFor;
      reply.before?.();
      await fulfillJson(route, mock, reply.body, reply.status);
      return;
    }

    if (path === `${pipelineRunPath}/application/events` && method === "GET") {
      if (mock.useNativeSse) {
        await route.continue();
        return;
      }
      const requestHeaders = await request.allHeaders();
      expect(requestHeaders.accept).toContain("text/event-stream");
      mock.sseHeaders.push(requestHeaders["last-event-id"] ?? null);
      const reply = mock.sseReplies.shift();
      if (!reply) {
        await route.fulfill({
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "text/event-stream",
          },
          body: "retry: 60000\n\n",
        });
        return;
      }
      await reply.waitFor;
      reply.before?.();
      for (const event of reply.publicEvents) {
        mock.publicResponseBodies.push(JSON.stringify(event));
      }
      await route.fulfill({
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/event-stream",
        },
        body: reply.body,
      });
      return;
    }

    if (path === `${pipelineRunPath}/application/commands` && method === "POST") {
      const parsed = requestBody as ApplicationSessionCommand;
      mock.commands.push(parsed);
      const reply = mock.commandReplies.shift() ?? { status: 202 };
      await reply.waitFor;
      reply.before?.();
      if (reply.status === 0) {
        await route.abort("connectionfailed");
        return;
      }
      if (reply.status === 202) {
        await route.fulfill({ status: 202 });
      } else {
        await fulfillJson(route, mock, reply.body, reply.status);
      }
      return;
    }

    if (path === `${pipelineRunPath}/application/retry` && method === "POST") {
      mock.retryBodies.push(requestBody);
      const reply = mock.retryReplies.shift();
      if (!reply) throw new Error("Unexpected application retry without a queued reply");
      reply.before?.();
      if (reply.status === 202) {
        mock.application = ApplicationSessionSnapshotDtoSchema.parse(reply.body);
      }
      await fulfillJson(route, mock, reply.body, reply.status);
      return;
    }

    if (path === `${pipelineRunPath}/application` && method === "GET") {
      mock.applicationGetCount += 1;
      await fulfillJson(route, mock, ApplicationSessionViewSchema.parse(mock.application));
      return;
    }
    if (path === `${pipelineRunPath}/application` && method === "POST") {
      mock.startBodies.push(requestBody);
      const reply = mock.startReplies.shift();
      if (!reply) throw new Error("Unexpected application start without a queued reply");
      reply.before?.();
      if (reply.status === 202) {
        mock.application = ApplicationSessionSnapshotDtoSchema.parse(reply.body);
      }
      await fulfillJson(route, mock, reply.body, reply.status);
      return;
    }
    if (path === `${pipelineRunPath}/application` && method === "DELETE") {
      expect(request.postData()).toBeNull();
      expect((await request.allHeaders())["content-type"]).toBeUndefined();
      mock.deleteCount += 1;
      mock.onDelete?.();
      await route.fulfill({ status: 204 });
      return;
    }

    throw new Error(`Unhandled pipeline request: ${method} ${path}`);
  });

  return mock;
}

function questionFixtures(): ApplicationAdditionalInfoQuestion[] {
  return [
    { id: "legal_name", scope: "global", question: "What name should appear?", answerType: "text" },
    { id: "work_authorized", scope: "global", question: "Are you authorized to work?", answerType: "boolean" },
    {
      id: "preferred_office",
      scope: "application",
      question: "Which office do you prefer?",
      answerType: "single_select",
      options: [
        { id: "remote", label: "Remote" },
        { id: "hybrid", label: "Hybrid" },
      ],
    },
    {
      id: "available_shifts",
      scope: "application",
      question: "Which shifts are available?",
      answerType: "multi_select",
      options: [
        { id: "day", label: "Day" },
        { id: "evening", label: "Evening" },
        { id: "weekend", label: "Weekend" },
      ],
    },
    { id: "portfolio_note", scope: "application", question: "Optional portfolio note?", answerType: "text" },
  ];
}

async function installControlledEventSource(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const instances: EventTarget[] = [];
    class ControlledEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly url: string;
      readonly withCredentials = false;
      readyState = ControlledEventSource.OPEN;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        instances.push(this);
        window.setTimeout(() => this.onopen?.(new Event("open")), 0);
      }

      close(): void {
        this.readyState = ControlledEventSource.CLOSED;
      }
    }
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: ControlledEventSource,
    });
    Object.defineProperty(window, "__applicationEventSources", {
      configurable: true,
      value: instances,
    });
  });
}

async function controlledEventSourceCount(page: Page): Promise<number> {
  return page.evaluate(() => (
    window as typeof window & { __applicationEventSources: EventTarget[] }
  ).__applicationEventSources.length);
}

async function emitControlledEventSourceError(page: Page, sourceIndex: number): Promise<void> {
  await page.evaluate((index) => {
    const sources = (
      window as typeof window & {
        __applicationEventSources: Array<EventTarget & {
          onerror: ((event: Event) => void) | null;
        }>;
      }
    ).__applicationEventSources;
    sources[index]?.onerror?.(new Event("error"));
  }, sourceIndex);
}

async function emitControlledApplicationEvent(
  page: Page,
  event: ApplicationSessionEventDto,
  cursor: number,
  sourceIndex: number,
): Promise<void> {
  await page.evaluate(({ data, eventName, index, lastEventId }) => {
    const sources = (
      window as typeof window & { __applicationEventSources: EventTarget[] }
    ).__applicationEventSources;
    sources[index]?.dispatchEvent(new MessageEvent(eventName, { data, lastEventId }));
  }, {
    data: JSON.stringify(event),
    eventName: event.event,
    index: sourceIndex,
    lastEventId: `${event.generation}:${cursor}`,
  });
}

function approvedRun(): RunDto {
  return RunDtoSchema.parse({
    ...runFixture({ status: "approved", revision: 2, origin: "human-comments", pdfSha256: pdfHash2 }),
    jobUrl,
  });
}

function approvedIterations(): ResumeIterationListResponse {
  return iterationList(
    iteration(1, "initial", pdfHash1),
    iteration(2, "human-comments", pdfHash2, "approved"),
  );
}

test("shows opportunity kind in white beside application status", async ({ page }) => {
  await installPipeline(page, {
    run: { ...runFixture(), opportunityKind: "hackathon" },
  });
  await page.goto(`/runs/${runId}`);

  const summary = page.getByRole("complementary", {
    name: "Hackathon summary and keyword comparison",
  });
  const kind = summary.locator("p", { hasText: "Hackathon" });
  const icon = kind.locator("svg");
  const status = summary.getByText("Pending", { exact: true });
  await expect(kind).toHaveCSS("color", "rgb(238, 241, 236)");
  await expect(icon).toHaveCount(1);
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  await expect(icon).toHaveCSS("color", "rgb(238, 241, 236)");

  const [kindBox, iconBox, statusBox] = await Promise.all([
    kind.boundingBox(),
    icon.boundingBox(),
    status.boundingBox(),
  ]);
  expect(kindBox).not.toBeNull();
  expect(iconBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  expect(statusBox!.x).toBeGreaterThan(kindBox!.x + kindBox!.width);
  const kindCenter = kindBox!.y + kindBox!.height / 2;
  const statusCenter = statusBox!.y + statusBox!.height / 2;
  const iconCenter = iconBox!.y + iconBox!.height / 2;
  expect(Math.abs(kindCenter - statusCenter)).toBeLessThanOrEqual(1);
  expect(Math.abs(iconCenter - kindCenter)).toBeLessThanOrEqual(1);
});

async function assertNoPrivateHarnessDetails(page: Page, mock: MockPipeline): Promise<void> {
  const serializedResponses = mock.publicResponseBodies.join("\n");
  for (const privateValue of privateHarnessValues) {
    expect(serializedResponses).not.toContain(privateValue);
    await expect(page.getByRole("main")).not.toContainText(privateValue);
  }
}

test("selects an historical iteration through revision-scoped documents and returns to latest", async ({ page }) => {
  const mock = await installPipeline(page);
  await page.goto(`/runs/${runId}`);

  const iterationSelect = page.getByLabel("Displayed resume");
  await expect(iterationSelect).toHaveValue("2");
  await expect(page.getByRole("heading", { level: 1, name: "Public Role 2" })).toBeVisible();
  await expect(page.getByText("Revision 2 orchestration", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Selected resume PDF for Public Role 2")).toHaveAttribute(
    "data",
    `${pipelineRunPath}/iterations/2/artifacts/resume-r2`,
  );

  await iterationSelect.selectOption("1");
  await expect(iterationSelect).toHaveValue("1");
  await expect(page.getByRole("heading", { level: 1, name: "Public Role 1" })).toBeVisible();
  await expect(page.getByText("Revision 1 orchestration", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Selected resume PDF for Public Role 1")).toHaveAttribute(
    "data",
    `${pipelineRunPath}/iterations/1/artifacts/resume-r1`,
  );
  await expect(page.getByRole("link", { name: "Download selected PDF" })).toHaveAttribute(
    "href",
    `${pipelineRunPath}/iterations/1/artifacts/resume-r1`,
  );
  await expect(page.getByLabel("Edit instructions")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Request edits" })).toHaveCount(0);

  await page.getByRole("tab", { name: "Keyword map" }).click();
  await expect(page.getByRole("link", { name: "Download keyword map PDF" })).toHaveAttribute(
    "href",
    `${pipelineRunPath}/iterations/1/artifacts/keyword-map-r1`,
  );
  await page.getByRole("tab", { name: "Diff" }).click();
  await expect(page.getByRole("table", { name: "Canonical and current resume comparison" })).toContainText(
    "Current public resume line for revision 1.",
  );

  await iterationSelect.selectOption("2");
  await expect(iterationSelect).toHaveValue("2");
  await expect(page.getByRole("tab", { name: "Resume" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Selected resume PDF for Public Role 2")).toHaveAttribute(
    "data",
    `${pipelineRunPath}/iterations/2/artifacts/resume-r2`,
  );
  await expect(page.getByRole("button", { name: "Request edits" })).toBeEnabled();
  await expect.poll(() => mock.artifactRequests.some((path) => path.endsWith("/iterations/1/artifacts/analysis-r1"))).toBe(true);
  expect(mock.artifactRequests.every((path) => path.includes(`${pipelineRunPath}/iterations/`))).toBe(true);
});

test("direct edit requests retain failed input and follow the latest reviewed revision", async ({ page }) => {
  const mock = await installPipeline(page);
  const editingRun = runFixture({ status: "editing", revision: 3, origin: "human-comments", pdfSha256: null });
  const editedIteration = iteration(3, "human-comments", pdfHash3);
  const editedRun = runFixture({ status: "review", revision: 3, origin: "human-comments", pdfSha256: pdfHash3 });
  mock.editReplies.push({
    status: 409,
    body: apiError("STALE_PDF", "The resume changed; review the latest version"),
  });
  mock.editReply = editingRun;

  await page.goto(`/runs/${runId}`);
  const iterationSelect = page.getByLabel("Displayed resume");
  await iterationSelect.selectOption("1");
  await expect(page.getByLabel("Edit instructions")).toHaveCount(0);
  await iterationSelect.selectOption("2");
  await expect(iterationSelect).toHaveValue("2");
  const editInstructions = page.getByLabel("Edit instructions");
  const requestEdits = page.getByRole("button", { name: "Request edits" });
  await editInstructions.fill("  Emphasize launch ownership.  ");
  mock.application = notStartedBlocked("resume_not_approved");
  await requestEdits.click();
  await expect(page.getByRole("alert").filter({
    hasText: "The resume changed; review the latest version",
  })).toBeVisible();
  await expect(editInstructions).toHaveValue("  Emphasize launch ownership.  ");
  await expect(requestEdits).toBeEnabled();
  await requestEdits.click();

  await expect.poll(() => mock.requests.filter((request) => request.path.endsWith("/edit")).length).toBe(2);
  expect(mock.requests.find((request) => request.path.endsWith("/edit"))?.body).toEqual({
    comments: "Emphasize launch ownership.",
    expectedPdfSha256: pdfHash2,
  });
  await expect(page.getByLabel("Displayed resume")).toHaveValue("2");
  await expect(page.getByLabel("Selected resume PDF for Public Role 2")).toHaveAttribute(
    "data",
    `${pipelineRunPath}/iterations/2/artifacts/resume-r2`,
  );

  mock.run = editedRun;
  mock.iterations = iterationList(
    iteration(1, "initial", pdfHash1),
    iteration(2, "human-comments", pdfHash2),
    editedIteration,
  );
  mock.application = notStartedAfterApproval();
  await page.waitForTimeout(2_600);
  await expect(page.getByLabel("Displayed resume")).toHaveValue("3");
  await expect(page.getByLabel("Displayed resume").getByRole("option", { selected: true })).toHaveText(
    "Iteration 3 — Latest",
  );
  await expect(page.getByLabel("Selected resume PDF for Public Role 3")).toHaveAttribute(
    "data",
    `${pipelineRunPath}/iterations/3/artifacts/resume-r3`,
  );

});

test("pasted review approves without starting an application", async ({ page }) => {
  const approved = runFixture({
    status: "approved",
    revision: 2,
    origin: "human-comments",
    pdfSha256: pdfHash2,
  });
  const mock = await installPipeline(page, {
    run: runFixture(),
    application: notStartedBlocked("legacy_job_url_unavailable"),
  });
  mock.approveReply = approved;

  await page.goto(`/runs/${runId}`);

  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeEnabled();
  mock.iterations = approvedIterations();
  await approve.click();

  await expect.poll(() => mock.requests.filter((request) => request.method === "POST")).toEqual([{
    method: "POST",
    path: `${pipelineRunPath}/approve`,
    body: {
      expectedPdfSha256: pdfHash2,
      acknowledgeVisualIssues: false,
    },
  }]);
  expect(mock.startBodies).toEqual([]);
  await expect(page.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);
  await expect(page.getByText(
    "Automatic application is unavailable for this opportunity.",
    { exact: true },
  )).toBeVisible();
});

test("approved pasted run without a job URL never offers standalone Apply", async ({ page }) => {
  const mock = await installPipeline(page, {
    run: runFixture({ status: "approved", revision: 2, origin: "human-comments", pdfSha256: pdfHash2 }),
    iterations: approvedIterations(),
    application: notStartedApproved(),
  });

  await page.goto(`/runs/${runId}`);

  await expect.poll(() => mock.applicationGetCount).toBeGreaterThanOrEqual(1);
  await expect(page.getByLabel("Displayed resume")).toHaveValue("2");
  await expect(page.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);
  await expect(page.getByText("Automatic application is unavailable for this opportunity.", { exact: true })).toBeVisible();
});

test("failed application start keeps approval and exposes a standalone Apply retry", async ({ page }) => {
  const reviewRun = RunDtoSchema.parse({
    ...runFixture({ visualAcknowledgementRequired: true }),
    jobUrl,
  });
  const approved = approvedRun();
  const starting = snapshotFixture({ bridgeState: "starting", updatedAt: createdAt + 500 });
  const mock = await installPipeline(page, { run: reviewRun });
  mock.approveReply = approved;
  mock.startReplies.push({
    status: 503,
    body: apiError("APPLICATION_HARNESS_UNAVAILABLE", "The local application service is unavailable"),
    before: () => {
      mock.application = notStartedApproved();
    },
  });
  mock.startReplies.push({ status: 202, body: starting });

  await page.goto(`/runs/${runId}`);
  await page.getByRole("checkbox", {
    name: "I reviewed the reported visual QA issues and accept them.",
  }).check();
  mock.iterations = approvedIterations();
  await page.getByRole("button", { name: "Approve and apply" }).click();

  await expect.poll(() => mock.startBodies.length).toBe(1);
  expect(mock.requests.filter((request) => request.method === "POST").map((request) => request.path)).toEqual([
    `${pipelineRunPath}/approve`,
    `${pipelineRunPath}/application`,
  ]);
  expect(mock.requests.find((request) => request.path.endsWith("/approve"))?.body).toEqual({
    expectedPdfSha256: pdfHash2,
    acknowledgeVisualIssues: true,
  });
  expect(mock.startBodies).toEqual([{ expectedApprovedPdfSha256: pdfHash2 }]);
  await expect.poll(() => mock.applicationGetCount).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("alert").filter({
    hasText: "The local application service is unavailable",
  })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request edits" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Regenerate" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve and apply" })).toHaveCount(0);
  const apply = page.getByRole("button", { name: "Apply", exact: true });
  await expect(apply).toBeVisible();
  await apply.click();
  await expect.poll(() => mock.startBodies.length).toBe(2);
  expect(mock.startBodies).toEqual([
    { expectedApprovedPdfSha256: pdfHash2 },
    { expectedApprovedPdfSha256: pdfHash2 },
  ]);
  await expect(page.getByRole("status").filter({ hasText: "Starting browser" })).toBeVisible();
  await expect(page.getByText("Pending", { exact: true })).toBeVisible();
});

test("an accepted live projection clears a stale application load failure", async ({ page }) => {
  const running = snapshotFixture({
    bridgeState: "running",
    updatedAt: createdAt + 100,
  });
  const failed = snapshotFixture({
    bridgeState: "failed",
    updatedAt: createdAt + 200,
  });
  const failedFrame = deferred();
  const mock = await installPipeline(page, {
    run: runFixture({ status: "queued" }),
    application: running,
  });
  queueSse(mock, eventFixture("failed", failed, {}), 2, failedFrame.promise);
  let failedApplicationReads = 0;
  await page.route(`**${pipelineRunPath}/application`, async (route) => {
    if (
      route.request().method() === "GET"
      && mock.run.status === "approved"
    ) {
      failedApplicationReads += 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify(apiError(
          "APPLICATION_HARNESS_UNAVAILABLE",
          "Temporary application read failure",
        )),
      });
      return;
    }
    await route.fallback();
  });

  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole("status").filter({ hasText: "Applying" })).toBeVisible();
  mock.run = approvedRun();
  mock.iterations = approvedIterations();
  await page.waitForTimeout(2_600);
  const loadFailure = page.getByRole("alert").filter({
    hasText: "The local application service is unavailable",
  });
  await expect.poll(() => failedApplicationReads).toBeGreaterThan(0);
  await expect(loadFailure).toBeVisible();

  failedFrame.resolve();
  await expect(page.getByRole("status").filter({ hasText: "Failed" })).toBeVisible();
  await expect(loadFailure).toHaveCount(0);
  mock.application = failed;
});


test("alerts once when an application is already waiting for human input", async ({ page }) => {
  const frequencies = await installSoundProbe(page);
  const navigation = snapshotFixture({
    bridgeState: "awaiting_human_navigation",
    generation: 4,
    pendingAction: {
      type: "human_navigation",
      instruction: "Complete the public identity check.",
    },
    updatedAt: createdAt + 200,
  });
  await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: navigation,
  });

  await page.goto(`/runs/${runId}`);
  await expect(page.getByText("Complete the public identity check.", { exact: true })).toBeVisible();
  expect(await frequencies()).toEqual([]);

  await page.getByRole("heading", { name: "Public Role 2", exact: true, level: 1 }).click();
  await expect.poll(frequencies).toEqual([740, 988]);

  await page.reload();
  await expect(page.getByText("Complete the public identity check.", { exact: true })).toBeVisible();
  await page.getByRole("heading", { name: "Public Role 2", exact: true, level: 1 }).click();
  await page.waitForTimeout(100);
  expect(await frequencies()).toEqual([]);
});

test("plays one success alert when the application is submitted", async ({ page }) => {
  const frequencies = await installSoundProbe(page);
  await installControlledEventSource(page);
  const running = snapshotFixture({
    bridgeState: "running",
    generation: 6,
    updatedAt: createdAt + 100,
  });
  const submitted = snapshotFixture({
    bridgeState: "submitted",
    generation: 6,
    updatedAt: createdAt + 200,
  });
  const submittedReplay = snapshotFixture({
    bridgeState: "submitted",
    generation: 6,
    updatedAt: createdAt + 300,
    warnings: ["Newer submitted projection accepted."],
  });
  const closed = snapshotFixture({
    bridgeState: "closed",
    generation: 6,
    submissionPhase: "submitted",
    updatedAt: createdAt + 400,
  });
  await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: running,
  });

  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole("status").filter({ hasText: "Applying" })).toBeVisible();
  await expect.poll(() => controlledEventSourceCount(page)).toBeGreaterThan(0);
  await page.getByRole("heading", { name: "Public Role 2", exact: true, level: 1 }).click();
  const sourceIndex = (await controlledEventSourceCount(page)) - 1;

  await emitControlledApplicationEvent(
    page,
    eventFixture("application_submitted", submitted, {}),
    40,
    sourceIndex,
  );
  await expect.poll(frequencies).toEqual([523, 659, 784]);

  await emitControlledApplicationEvent(
    page,
    eventFixture("snapshot", submittedReplay, {}),
    41,
    sourceIndex,
  );
  await emitControlledApplicationEvent(
    page,
    eventFixture("closed", closed, {}),
    42,
    sourceIndex,
  );
  await page.waitForTimeout(100);
  expect(await frequencies()).toEqual([523, 659, 784]);
});

test("plays one failure alert when the application agent fails", async ({ page }) => {
  const frequencies = await installSoundProbe(page);
  await installControlledEventSource(page);
  const running = snapshotFixture({
    bridgeState: "running",
    generation: 8,
    updatedAt: createdAt + 100,
  });
  const failed = snapshotFixture({
    bridgeState: "failed",
    generation: 8,
    updatedAt: createdAt + 200,
  });
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: running,
  });

  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole("status").filter({ hasText: "Applying" })).toBeVisible();
  await expect.poll(() => controlledEventSourceCount(page)).toBeGreaterThan(0);
  await page.getByRole("heading", { name: "Public Role 2", exact: true, level: 1 }).click();
  const sourceIndex = (await controlledEventSourceCount(page)) - 1;

  await emitControlledApplicationEvent(
    page,
    eventFixture("failed", failed, {}),
    50,
    sourceIndex,
  );
  await expect.poll(frequencies).toEqual([392, 262]);

  mock.application = failed;
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: "Failed" })).toBeVisible();
  await page.getByRole("heading", { name: "Public Role 2", exact: true, level: 1 }).click();
  await page.waitForTimeout(100);
  expect(await frequencies()).toEqual([]);
});

test("plays an attention alert when resume tailoring becomes ready for review", async ({ page }) => {
  const frequencies = await installSoundProbe(page);
  const visualQa = runFixture({
    status: "visual_qa",
    revision: 5,
    origin: "human-comments",
    pdfSha256: pdfHash4,
  });
  const review = runFixture({
    status: "review",
    revision: 5,
    origin: "human-comments",
    pdfSha256: pdfHash4,
  });
  const mock = await installPipeline(page, {
    run: visualQa,
    application: notStartedAfterApproval(),
  });

  await page.goto(`/runs/${runId}`);
  const workflow = page.getByRole("list", { name: "Workflow progress" });
  const visualQaStage = workflow.getByRole("listitem").filter({ hasText: "Visual QA" });
  const reviewStage = workflow.getByRole("listitem").filter({ hasText: "Review" });
  await expect(visualQaStage).toHaveAttribute("aria-current", "step");
  await visualQaStage.click();
  mock.run = review;

  await expect(reviewStage).toHaveAttribute("aria-current", "step", { timeout: 6_000 });
  await expect.poll(frequencies).toEqual([740, 988]);

  await page.reload();
  await expect(reviewStage).toHaveAttribute("aria-current", "step");
  await reviewStage.click();
  await page.waitForTimeout(100);
  expect(await frequencies()).toEqual([]);
});

test("persists sound alerts and lets the user test the attention sound", async ({ page }) => {
  const frequencies = await installSoundProbe(page);
  await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: snapshotFixture({ bridgeState: "running" }),
  });

  await page.goto(`/runs/${runId}`);
  const soundToggle = page.getByRole("checkbox", { name: "Sound alerts" });
  const testSound = page.getByRole("button", { name: "Test sound" });
  await expect(soundToggle).toBeChecked();
  await expect(testSound).toBeEnabled();

  await testSound.click();
  await expect.poll(frequencies).toEqual([740, 988]);
  await soundToggle.uncheck();
  await expect(testSound).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (
    window.localStorage.getItem("jobhunter.sound-alerts.enabled")
  ))).toBe("false");

  await page.reload();
  await expect(soundToggle).not.toBeChecked();
  await expect(testSound).toBeDisabled();
  expect(await frequencies()).toEqual([]);

  await soundToggle.check();
  await expect(testSound).toBeEnabled();
  await testSound.click();
  await expect.poll(frequencies).toEqual([740, 988]);
  await expect.poll(() => page.evaluate(() => (
    window.localStorage.getItem("jobhunter.sound-alerts.enabled")
  ))).toBe("true");
});

test("additional-information answers survive conflict reconciliation and clear only on progress", async ({ page }) => {
  const questions = questionFixtures();
  const initial = snapshotFixture({
    bridgeState: "awaiting_additional_info",
    pendingAction: { type: "additional_info", questions },
    updatedAt: createdAt + 100,
  });
  const authoritativeQuestions = snapshotFixture({
    bridgeState: "awaiting_additional_info",
    pendingAction: { type: "additional_info", questions },
    updatedAt: createdAt + 200,
  });
  const progressed = snapshotFixture({
    bridgeState: "running",
    updatedAt: createdAt + 300,
  });
  const conflictFrame = deferred();
  const progressFrame = deferred();
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: initial,
  });
  mock.commandReplies.push({
    status: 409,
    body: apiError(
      "APPLICATION_COMMAND_CONFLICT",
      "The application state changed; review the latest session state",
    ),
    before: () => {
      mock.application = authoritativeQuestions;
    },
  });
  mock.commandReplies.push({ status: 202 }, { status: 202 });
  queueSse(
    mock,
    eventFixture("snapshot", authoritativeQuestions, {}),
    2,
    conflictFrame.promise,
  );
  queueSse(
    mock,
    eventFixture("additional_info_saved", progressed, { count: questions.length }),
    3,
    progressFrame.promise,
  );

  await page.goto(`/runs/${runId}`);
  const nameQuestion = page.getByRole("group", { name: "What name should appear?" });
  const authorizationQuestion = page.getByRole("group", { name: "Are you authorized to work?" });
  const officeQuestion = page.getByRole("group", { name: "Which office do you prefer?" });
  const shiftsQuestion = page.getByRole("group", { name: "Which shifts are available?" });
  const declineQuestion = page.getByRole("group", { name: "Optional portfolio note?" });
  await expect(page.getByText("Saved for future applications", { exact: true })).toHaveCount(2);
  await expect(page.getByText("Used for this job only", { exact: true })).toHaveCount(3);

  await nameQuestion.getByRole("textbox", { name: "Answer", exact: true }).fill("  Ada Public  ");
  await authorizationQuestion.getByRole("radio", { name: "No" }).check();
  await officeQuestion.getByRole("radio", { name: "Hybrid" }).check();
  await shiftsQuestion.getByRole("checkbox", { name: "Day" }).check();
  await shiftsQuestion.getByRole("checkbox", { name: "Weekend" }).check();
  await declineQuestion.getByRole("checkbox", { name: "Decline to answer" }).check();

  const expectedCommand: ApplicationSessionCommand = {
    type: "provide_additional_info",
    answers: [
      {
        id: "legal_name",
        status: "answered",
        raw_value: "Ada Public",
        value: "Ada Public",
      },
      { id: "work_authorized", status: "answered", value: false },
      { id: "preferred_office", status: "answered", option_id: "hybrid" },
      { id: "available_shifts", status: "answered", option_ids: ["day", "weekend"] },
      { id: "portfolio_note", status: "declined" },
    ],
  };
  await page.getByRole("button", { name: "Answer questions", exact: true }).click();
  await expect.poll(() => mock.commands.length).toBe(1);
  expect(mock.commands[0]).toEqual(expectedCommand);
  await expect(page.getByRole("alert").filter({
    hasText: "The application state changed; review the latest session state",
  })).toBeVisible();
  await expect(nameQuestion.getByRole("textbox", { name: "Answer", exact: true }))
    .toHaveValue("  Ada Public  ");
  await expect(authorizationQuestion.getByRole("radio", { name: "No" })).toBeChecked();
  await expect(officeQuestion.getByRole("radio", { name: "Hybrid" })).toBeChecked();
  await expect(shiftsQuestion.getByRole("checkbox", { name: "Day" })).toBeChecked();
  await expect(shiftsQuestion.getByRole("checkbox", { name: "Weekend" })).toBeChecked();
  await expect(declineQuestion.getByRole("checkbox", { name: "Decline to answer" })).toBeChecked();

  conflictFrame.resolve();
  await expect.poll(() => mock.sseHeaders.length).toBeGreaterThanOrEqual(1);
  await expect(page.getByRole("alert").filter({
    hasText: "The application state changed; review the latest session state",
  })).toBeVisible();
  await expect(nameQuestion.getByRole("textbox", { name: "Answer", exact: true }))
    .toHaveValue("  Ada Public  ");

  const gatedGuidance = "Use only verified profile facts.";
  await page.getByRole("textbox", { name: "Steer the agent" })
    .fill(gatedGuidance);
  await page.getByRole("button", { name: "Send guidance" }).click();
  await expect.poll(() => mock.commands.length).toBe(2);
  expect(mock.commands[1]).toEqual({ type: "steer", message: gatedGuidance });
  await expect(page.getByRole("button", { name: "Answer questions", exact: true }))
    .toBeEnabled();
  await expect(page.getByRole("heading", { name: "Additional information needed" })).toBeVisible();
  await expect(nameQuestion.getByRole("textbox", { name: "Answer", exact: true }))
    .toHaveValue("  Ada Public  ");

  progressFrame.resolve();
  await expect(page.getByRole("heading", { name: "Additional information needed" })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Applying" })).toBeVisible();
  mock.application = progressed;
  await expect(page.getByRole("group", { name: "What name should appear?" })).toHaveCount(0);
});

test("additional-information answers recover through a fresh EventSource after an error", async ({ page }) => {
  const questions = [questionFixtures()[0]!];
  const awaitingAnswers = snapshotFixture({
    bridgeState: "awaiting_additional_info",
    pendingAction: { type: "additional_info", questions },
    updatedAt: createdAt + 100,
  });
  const running = snapshotFixture({
    bridgeState: "running",
    updatedAt: createdAt + 200,
  });
  const savedEvent = eventFixture("additional_info_saved", running, { count: questions.length });
  const expectedCommand: ApplicationSessionCommand = {
    type: "provide_additional_info",
    answers: [{
      id: "legal_name",
      status: "answered",
      raw_value: "Ada Public",
      value: "Ada Public",
    }],
  };
  await installControlledEventSource(page);
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: awaitingAnswers,
  });
  mock.commandReplies.push({ status: 202 });

  await page.goto(`/runs/${runId}`);
  const questionGate = page.getByRole("heading", { name: "Additional information needed" });
  const nameAnswer = page
    .getByRole("group", { name: "What name should appear?" })
    .getByRole("textbox", { name: "Answer", exact: true });
  await expect(questionGate).toBeVisible();
  await expect.poll(() => controlledEventSourceCount(page)).toBe(1);
  await nameAnswer.fill("  Ada Public  ");
  await page.getByRole("button", { name: "Answer questions", exact: true }).click();

  await expect.poll(() => mock.commands.length).toBe(1);
  expect(mock.commands).toEqual([expectedCommand]);
  const confirmedApplicationReads = mock.applicationGetCount;
  await emitControlledEventSourceError(page, 0);
  await emitControlledEventSourceError(page, 0);
  expect(await page.evaluate(() => {
    const sources = (
      window as typeof window & {
        __applicationEventSources: Array<EventTarget & { readyState: number }>;
      }
    ).__applicationEventSources;
    return sources[0]?.readyState;
  })).toBe(2);

  const reconnectNotice = page.getByRole("status").filter({
    hasText: "Reconnecting to live application updates. The latest confirmed state remains visible.",
  });
  await expect(reconnectNotice).toBeVisible();
  await expect(questionGate).toBeVisible();
  await expect(nameAnswer).toHaveValue("  Ada Public  ");
  await expect.poll(() => mock.applicationGetCount).toBe(confirmedApplicationReads + 1);
  await expect.poll(
    () => controlledEventSourceCount(page),
    { intervals: [50, 100, 250], timeout: 1_500 },
  ).toBe(2);
  expect(mock.commands).toEqual([expectedCommand]);

  mock.application = running;
  await emitControlledApplicationEvent(page, savedEvent, 2, 1);

  await expect(questionGate).toHaveCount(0);
  await expect(reconnectNotice).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Applying" })).toBeVisible();
  expect(await controlledEventSourceCount(page)).toBe(2);
  expect(mock.commands).toEqual([expectedCommand]);
});

test("additional-information Continue sends no answers and stays busy across a same-gate projection", async ({ page }) => {
  const questions: ApplicationAdditionalInfoQuestion[] = [{
    id: "location",
    scope: "application",
    question: "Which locations can you work from?",
    answerType: "text",
  }];
  const initial = snapshotFixture({
    bridgeState: "awaiting_additional_info",
    pendingAction: { type: "additional_info", questions },
    updatedAt: createdAt + 100,
  });
  const sameGate = snapshotFixture({
    bridgeState: "awaiting_additional_info",
    pendingAction: { type: "additional_info", questions },
    updatedAt: createdAt + 200,
    company: "Same gate projection",
  });
  const progressed = snapshotFixture({
    bridgeState: "running",
    updatedAt: createdAt + 300,
    company: "Progressed projection",
  });
  const sameGateFrame = deferred();
  const progressFrame = deferred();
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: initial,
  });
  queueSse(
    mock,
    eventFixture("snapshot", sameGate, {}),
    2,
    sameGateFrame.promise,
  );
  queueSse(
    mock,
    eventFixture("snapshot", progressed, {}),
    3,
    progressFrame.promise,
  );

  await page.goto(`/runs/${runId}`);
  const continueButton = page.getByRole("button", { name: "Continue", exact: true });
  await expect(continueButton).toBeVisible();
  await expect(continueButton).toBeEnabled();
  await expect(page.getByRole("button", { name: "Answer questions", exact: true }))
    .toBeDisabled();

  await continueButton.click();
  await expect.poll(() => mock.commands.length).toBe(1);
  expect(mock.commands[0]).toEqual({ type: "continue_without_additional_info" });
  const continuingButton = page.getByRole("button", { name: "Continuing…", exact: true });
  await expect(continuingButton).toBeDisabled();

  sameGateFrame.resolve();
  await expect(page.getByText("Same gate projection", { exact: true })).toBeVisible();
  await expect(continuingButton).toBeDisabled();
  expect(mock.commands).toEqual([{ type: "continue_without_additional_info" }]);

  progressFrame.resolve();
  await expect(page.getByText("Progressed projection", { exact: true })).toBeVisible();
  await expect(continuingButton).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Additional information needed" }))
    .toHaveCount(0);
  expect(mock.commands).toEqual([{ type: "continue_without_additional_info" }]);
});

test("a changed question gate suppresses stale continuation after steering", async ({ page }) => {
  const oldQuestion: ApplicationAdditionalInfoQuestion = {
    id: "old_question",
    scope: "application",
    question: "What should the old gate answer?",
    answerType: "text",
  };
  const newQuestion: ApplicationAdditionalInfoQuestion = {
    id: "new_question",
    scope: "application",
    question: "What should the current gate answer?",
    answerType: "text",
  };
  const initial = snapshotFixture({
    bridgeState: "awaiting_additional_info",
    pendingAction: { type: "additional_info", questions: [oldQuestion] },
    updatedAt: createdAt + 100,
  });
  const changed = snapshotFixture({
    bridgeState: "awaiting_additional_info",
    pendingAction: { type: "additional_info", questions: [newQuestion] },
    updatedAt: createdAt + 200,
  });
  const steerReply = deferred();
  const gateFrame = deferred();
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: initial,
  });
  let staleSteerSettled = false;
  mock.commandReplies.push(
    {
      status: 202,
      waitFor: steerReply.promise,
      before: () => {
        staleSteerSettled = true;
      },
    },
    { status: 202 },
  );
  queueSse(
    mock,
    eventFixture("snapshot", changed, {}),
    2,
    gateFrame.promise,
    () => {
      mock.application = changed;
    },
  );

  await page.goto(`/runs/${runId}`);
  await page.getByRole("textbox", { name: "Steer the agent" })
    .fill("Use the current question only.");
  await page.getByRole("group", { name: oldQuestion.question })
    .getByRole("textbox", { name: "Answer", exact: true })
    .fill("Stale answer");
  await page.getByRole("button", { name: "Send guidance" }).click();
  await expect.poll(() => mock.commands.length).toBe(1);

  gateFrame.resolve();
  await expect(page.getByRole("group", { name: newQuestion.question })).toBeVisible();
  const currentGuidance = page.getByRole("textbox", { name: "Steer the agent" });
  await currentGuidance.fill("Use the current gate.");
  await page.getByRole("button", { name: "Send guidance" }).click();
  await expect.poll(() => mock.commands.length).toBe(2);
  expect(mock.commands[1]).toEqual({
    type: "steer",
    message: "Use the current gate.",
  });
  await expect(page.getByRole("status").filter({
    hasText: "Guidance queued for the next agent step.",
  })).toBeVisible();

  steerReply.resolve();
  await expect.poll(() => staleSteerSettled).toBe(true);
  await page.waitForTimeout(50);
  expect(mock.commands).toEqual([
    { type: "steer", message: "Use the current question only." },
    { type: "steer", message: "Use the current gate." },
  ]);
});

test("an authoritative replacement gate clears ambiguous steering delivery", async ({ page }) => {
  const oldQuestion: ApplicationAdditionalInfoQuestion = {
    id: "old_question",
    scope: "application",
    question: "What should the old gate answer?",
    answerType: "text",
  };
  const newQuestion: ApplicationAdditionalInfoQuestion = {
    id: "new_question",
    scope: "application",
    question: "What should the current gate answer?",
    answerType: "text",
  };
  const initial = snapshotFixture({
    bridgeState: "awaiting_additional_info",
    pendingAction: { type: "additional_info", questions: [oldQuestion] },
    updatedAt: createdAt + 100,
  });
  const changed = snapshotFixture({
    bridgeState: "awaiting_additional_info",
    pendingAction: { type: "additional_info", questions: [newQuestion] },
    updatedAt: createdAt + 200,
  });
  const gateFrame = deferred();
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: initial,
  });
  mock.commandReplies.push(
    {
      status: 503,
      body: apiError("APPLICATION_HARNESS_UNAVAILABLE", "private upstream detail"),
    },
    { status: 202 },
  );
  queueSse(
    mock,
    eventFixture("snapshot", changed, {}),
    2,
    gateFrame.promise,
    () => {
      mock.application = changed;
    },
  );

  await page.goto(`/runs/${runId}`);
  const guidance = page.getByRole("textbox", { name: "Steer the agent" });
  const send = page.getByRole("button", { name: "Send guidance" });
  await guidance.fill("Use the old gate.");
  await send.click();
  await expect(page.getByRole("alert").filter({
    hasText: "Guidance delivery could not be confirmed",
  })).toBeVisible();
  await expect(send).toBeDisabled();

  gateFrame.resolve();
  await expect(page.getByRole("group", { name: newQuestion.question })).toBeVisible();
  await expect(send).toBeEnabled();
  await guidance.fill("Use the current gate.");
  await send.click();
  await expect.poll(() => mock.commands.length).toBe(2);
  expect(mock.commands).toEqual([
    { type: "steer", message: "Use the old gate." },
    { type: "steer", message: "Use the current gate." },
  ]);
});

test("professional answers support keyboard revisions, retain the raw draft, and survive conflicts", async ({ page }) => {
  const question: ApplicationAdditionalInfoQuestion = {
    id: "motivation",
    scope: "application",
    question: "Why are you interested in this role?",
    answerType: "text",
  };
  const application = snapshotFixture({
    bridgeState: "awaiting_additional_info",
    pendingAction: { type: "additional_info", questions: [question] },
  });
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application,
  });
  mock.professionalizeReplies.push(
    {
      status: 200,
      body: { answer: "I build reliable systems for regulated teams." },
    },
    {
      status: 200,
      body: { answer: "I build reliable systems for regulated organizations." },
    },
  );
  mock.commandReplies.push({
    status: 409,
    body: apiError(
      "APPLICATION_COMMAND_CONFLICT",
      "The application state changed; review the latest session state",
    ),
  });

  await page.goto(`/runs/${runId}`);
  const group = page.getByRole("group", { name: question.question });
  const answer = group.getByRole("textbox", { name: "Answer", exact: true });
  await answer.fill("  built reliable systems for regulated teams  ");

  const settings = group.getByRole("button", { name: "Professionalize settings" });
  await settings.focus();
  await page.keyboard.press("Enter");
  await expect(settings).toHaveAttribute("aria-expanded", "true");
  await expect(group.getByRole("radio", { name: "Default" })).toBeChecked();
  await expect(group.getByText(
    "Default Sol turns loose thoughts into a concise professional answer without adding facts.",
    { exact: true },
  )).toBeVisible();

  await group.getByRole("button", { name: "Professionalize", exact: true }).click();
  await expect(group.getByRole("status")).toContainText("Professional answer ready");
  await expect(answer).toHaveValue("I build reliable systems for regulated teams.");

  const editSpecification = group.getByRole("textbox", { name: "Edit specification" });
  await editSpecification.press("Enter");
  expect(mock.commands).toEqual([]);
  expect(mock.requests.filter(({ path }) => path.endsWith("/professionalize"))).toHaveLength(1);

  await answer.fill("I build reliable systems for regulated banks and teams.");
  await editSpecification.fill("Make it concise.");
  await editSpecification.press("Enter");
  await expect(answer).toHaveValue("I build reliable systems for regulated organizations.");
  expect(mock.commands).toEqual([]);
  const modelRequests = mock.requests.filter(({ path }) => path.endsWith("/professionalize"));
  expect(modelRequests.map(({ body }) => body)).toEqual([
    {
      promptId: "default",
      draft: "built reliable systems for regulated teams",
    },
    {
      promptId: "default",
      draft: "I build reliable systems for regulated banks and teams.",
      instruction: "Make it concise.",
    },
  ]);

  await page.getByRole("button", { name: "Answer questions", exact: true }).click();
  await expect.poll(() => mock.commands.length).toBe(1);
  expect(mock.commands[0]).toEqual({
    type: "provide_additional_info",
    answers: [{
      id: "motivation",
      status: "answered",
      raw_value: "built reliable systems for regulated teams",
      value: "I build reliable systems for regulated organizations.",
    }],
  });
  await expect(page.getByRole("alert").filter({
    hasText: "The application state changed; review the latest session state",
  })).toBeVisible();
  await expect(answer).toHaveValue("I build reliable systems for regulated organizations.");
  await expect(group.getByRole("textbox", { name: "Edit specification" })).toBeVisible();
});

test("a previous answer can seed the raw draft without leaking storage metadata", async ({ page }) => {
  const question: ApplicationAdditionalInfoQuestion = {
    id: "motivation",
    scope: "application",
    question: "Why this role?",
    answerType: "text",
  };
  const application = snapshotFixture({
    bridgeState: "awaiting_additional_info",
    pendingAction: { type: "additional_info", questions: [question] },
  });
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application,
  });
  mock.suggestionReplies.push({
    status: 200,
    body: {
      suggestions: [{
        question: "What interests you about reliability work?",
        answer: "I value careful engineering for systems people depend on.",
      }],
    },
  });
  mock.commandReplies.push({ status: 202 });
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto(`/runs/${runId}`);
  const group = page.getByRole("group", { name: question.question });
  await group.getByRole("button", { name: "Previous answers" }).click();
  await expect(group.getByText(
    "What interests you about reliability work?",
    { exact: true },
  )).toBeVisible();
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  )).toBe(true);
  await group.getByRole("button", {
    name: "Use answer: I value careful engineering for systems people depend on.",
  }).click();
  const answer = group.getByRole("textbox", { name: "Answer", exact: true });
  await expect(answer).toHaveValue(
    "I value careful engineering for systems people depend on.",
  );
  await answer.fill("I value careful engineering for dependable systems.");
  await page.getByRole("button", { name: "Answer questions", exact: true }).click();
  await expect.poll(() => mock.commands.length).toBe(1);
  expect(mock.commands[0]).toEqual({
    type: "provide_additional_info",
    answers: [{
      id: "motivation",
      status: "answered",
      raw_value: "I value careful engineering for systems people depend on.",
      value: "I value careful engineering for dependable systems.",
    }],
  });
  const sourceResponse = mock.publicResponseBodies.find((body) =>
    body.includes("I value careful engineering for systems people depend on.")
  );
  expect(sourceResponse).toBeDefined();
  expect(sourceResponse).not.toContain("raw_value");
  expect(sourceResponse).not.toContain("jobUrl");
  expect(sourceResponse).not.toContain("storage");
});

test("previous-answer sources cannot replace the dispatched answer while its command is pending", async ({ page }) => {
  const question: ApplicationAdditionalInfoQuestion = {
    id: "motivation",
    scope: "application",
    question: "Why this role?",
    answerType: "text",
  };
  const application = snapshotFixture({
    bridgeState: "awaiting_additional_info",
    pendingAction: { type: "additional_info", questions: [question] },
  });
  const commandReply = deferred();
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application,
  });
  mock.suggestionReplies.push({
    status: 200,
    body: {
      suggestions: [{
        question: "What interests you about reliability work?",
        answer: "A different saved answer.",
      }],
    },
  });
  mock.commandReplies.push({ status: 202, waitFor: commandReply.promise });

  await page.goto(`/runs/${runId}`);
  const group = page.getByRole("group", { name: question.question });
  const answer = group.getByRole("textbox", { name: "Answer", exact: true });
  await answer.fill("The final answer dispatched to the browser.");
  await group.getByRole("button", { name: "Previous answers" }).click();
  const useAnswer = group.getByRole("button", {
    name: "Use answer: A different saved answer.",
  });
  await expect(useAnswer).toBeEnabled();

  await page.getByRole("button", { name: "Answer questions", exact: true }).click();
  await expect.poll(() => mock.commands.length).toBe(1);
  expect(mock.commands[0]).toEqual({
    type: "provide_additional_info",
    answers: [{
      id: "motivation",
      status: "answered",
      raw_value: "The final answer dispatched to the browser.",
      value: "The final answer dispatched to the browser.",
    }],
  });
  await expect(useAnswer).toBeDisabled();
  await useAnswer.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(answer).toHaveValue("The final answer dispatched to the browser.");

  commandReply.resolve();
});

test("professionalize failures stay local to their question and keep the draft editable", async ({ page }) => {
  const question: ApplicationAdditionalInfoQuestion = {
    id: "motivation",
    scope: "application",
    question: "Why this role?",
    answerType: "text",
  };
  const application = snapshotFixture({
    bridgeState: "awaiting_additional_info",
    pendingAction: { type: "additional_info", questions: [question] },
  });
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application,
  });
  mock.professionalizeReplies.push({
    status: 504,
    body: apiError("MODEL_TIMEOUT", "upstream private timeout details"),
  });

  await page.goto(`/runs/${runId}`);
  const group = page.getByRole("group", { name: question.question });
  const answer = group.getByRole("textbox", { name: "Answer", exact: true });
  await answer.fill("facts that should remain");
  await group.getByRole("button", { name: "Professionalize", exact: true }).click();
  await expect(group.getByRole("alert")).toHaveText("The model request timed out");
  await expect(answer).toHaveValue("facts that should remain");
  await expect(answer).toBeEditable();
  await expect(page.getByText("upstream private timeout details", { exact: true })).toHaveCount(0);
});

test("a professionalize response from an old question gate cannot replace the new gate", async ({ page }) => {
  const oldQuestion: ApplicationAdditionalInfoQuestion = {
    id: "motivation",
    scope: "application",
    question: "Why this role?",
    answerType: "text",
  };
  const newQuestion: ApplicationAdditionalInfoQuestion = {
    id: "role_fit",
    scope: "application",
    question: "What makes you a strong fit?",
    answerType: "text",
  };
  const initial = snapshotFixture({
    bridgeState: "awaiting_additional_info",
    pendingAction: { type: "additional_info", questions: [oldQuestion] },
    updatedAt: createdAt + 100,
  });
  const changed = snapshotFixture({
    bridgeState: "awaiting_additional_info",
    pendingAction: { type: "additional_info", questions: [newQuestion] },
    updatedAt: createdAt + 200,
  });
  const modelFrame = deferred();
  const gateFrame = deferred();
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: initial,
  });
  mock.professionalizeReplies.push({
    status: 200,
    body: { answer: "An obsolete professional answer." },
    waitFor: modelFrame.promise,
  });
  queueSse(
    mock,
    eventFixture("snapshot", changed, {}),
    2,
    gateFrame.promise,
    () => {
      mock.application = changed;
    },
  );

  await page.goto(`/runs/${runId}`);
  const oldGroup = page.getByRole("group", { name: oldQuestion.question });
  await oldGroup.getByRole("textbox", { name: "Answer", exact: true }).fill("old loose facts");
  await oldGroup.getByRole("button", { name: "Professionalize", exact: true }).click();
  await expect(oldGroup.getByRole("button", { name: "Professionalizing…" })).toBeDisabled();

  gateFrame.resolve();
  const newGroup = page.getByRole("group", { name: newQuestion.question });
  await expect(newGroup).toBeVisible();
  modelFrame.resolve();
  await expect(newGroup.getByRole("textbox", { name: "Answer", exact: true })).toHaveValue("");
  await expect(page.getByText("An obsolete professional answer.", { exact: true })).toHaveCount(0);
});

test("credential gate sends exact actions, retains failures, clears on progress, and fits mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const initialCredentials = snapshotFixture({
    bridgeState: "awaiting_human_navigation",
    pendingAction: { type: "credentials" },
    updatedAt: createdAt + 100,
  });
  const authoritativeCredentials = snapshotFixture({
    bridgeState: "awaiting_human_navigation",
    pendingAction: { type: "credentials" },
    updatedAt: createdAt + 150,
  });
  const changedCredentials = snapshotFixture({
    bridgeState: "awaiting_human_navigation",
    generation: 2,
    pendingAction: { type: "credentials" },
    updatedAt: createdAt + 200,
  });
  const progressed = snapshotFixture({
    bridgeState: "running",
    generation: 2,
    updatedAt: createdAt + 300,
  });
  const returnedCredentials = snapshotFixture({
    bridgeState: "awaiting_human_navigation",
    generation: 2,
    pendingAction: { type: "credentials" },
    updatedAt: createdAt + 400,
  });
  const changedFrame = deferred();
  const progressFrame = deferred();
  const returnFrame = deferred();
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: initialCredentials,
  });
  mock.commandReplies.push({
    status: 409,
    body: apiError(
      "APPLICATION_COMMAND_CONFLICT",
      "The application state changed; review the latest session state",
    ),
    before: () => {
      mock.application = authoritativeCredentials;
    },
  });
  mock.commandReplies.push({ status: 202 });
  queueSse(
    mock,
    eventFixture("credentials_required", changedCredentials, {}),
    2,
    changedFrame.promise,
    () => {
      mock.application = changedCredentials;
    },
  );
  queueSse(
    mock,
    eventFixture("snapshot", progressed, {}),
    3,
    progressFrame.promise,
    () => {
      mock.application = progressed;
    },
  );
  queueSse(
    mock,
    eventFixture("credentials_required", returnedCredentials, {}),
    4,
    returnFrame.promise,
    () => {
      mock.application = returnedCredentials;
    },
  );

  await page.goto(`/runs/${runId}`);
  const credentialsForm = page.getByRole("form", { name: "Credentials needed" });
  const username = page.getByLabel("Username or email");
  const password = page.getByLabel("Password");
  const signIn = credentialsForm.getByRole("button", { name: "Sign in with credentials" });
  const save = credentialsForm.getByRole("button", { name: "Save credentials", exact: true });
  await expect(credentialsForm).toBeVisible();
  await expect(credentialsForm.getByRole("button")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Cancel application" })).toBeVisible();
  await expect(credentialsForm).toHaveAttribute("autocomplete", "off");
  await expect(username).toHaveAttribute("autocomplete", "off");
  await expect(password).toHaveAttribute("autocomplete", "new-password");
  await expect(password).toHaveAttribute("type", "password");
  await expect(username).toHaveAttribute("required", "");
  await expect(password).toHaveAttribute("required", "");
  await expect(credentialsForm).toContainText("private local credential file");
  await expect(credentialsForm).toContainText("after creating an account in headed Chrome");
  await username.focus();
  await username.press("Tab");
  await expect(password).toBeFocused();
  await password.press("Tab");
  await expect(signIn).toBeFocused();
  await signIn.press("Tab");
  await expect(save).toBeFocused();
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  )).toBe(true);
  const formBox = await credentialsForm.boundingBox();
  if (!formBox) throw new Error("Credential form has no layout box");
  for (const control of [
    username,
    password,
    signIn,
    save,
  ]) {
    const controlBox = await control.boundingBox();
    if (!controlBox) throw new Error("Credential control has no layout box");
    expect(Math.floor(controlBox.x)).toBeGreaterThanOrEqual(Math.floor(formBox.x));
    expect(Math.ceil(controlBox.x + controlBox.width))
      .toBeLessThanOrEqual(Math.ceil(formBox.x + formBox.width));
  }

  await password.fill(privateCredentialPassword);
  await signIn.press("Enter");
  await expect(page.getByRole("alert").filter({
    hasText: "Enter a username or email between 1 and 320 characters.",
  })).toBeVisible();
  await expect(username).toBeFocused();
  await expect(password).toHaveValue(privateCredentialPassword);
  expect(mock.commands).toHaveLength(0);
  await username.fill("\u001c");
  await signIn.press("Enter");
  await expect(page.getByRole("alert").filter({
    hasText: "Enter a username or email between 1 and 320 characters.",
  })).toBeVisible();
  await expect(username).toBeFocused();
  await expect(username).toHaveValue("\u001c");
  await expect(password).toHaveValue(privateCredentialPassword);
  expect(mock.commands).toHaveLength(0);
  await username.fill("account\u0000name");
  await signIn.press("Enter");
  await expect(page.getByRole("alert").filter({
    hasText: "Enter a username or email between 1 and 320 characters.",
  })).toBeVisible();
  await expect(username).toBeFocused();
  await expect(username).toHaveValue("account\u0000name");
  await expect(password).toHaveValue(privateCredentialPassword);
  expect(mock.commands).toHaveLength(0);

  await username.fill(privateCredentialUsername);
  await password.fill("pass\u0000word");
  await signIn.press("Enter");
  await expect(page.getByRole("alert").filter({
    hasText: "Enter a password between 1 and 4,096 characters.",
  })).toBeVisible();
  await expect(password).toBeFocused();
  await expect(username).toHaveValue(privateCredentialUsername);
  await expect(password).toHaveValue("pass\u0000word");
  expect(mock.commands).toHaveLength(0);

  await password.fill(privateCredentialPassword);

  await username.fill(`  ${privateCredentialUsername}  `);
  await signIn.click();
  await expect.poll(() => mock.commands.length).toBe(1);
  expect(mock.commands[0]).toEqual({
    type: "sign_in",
    username: privateCredentialUsername,
    password: privateCredentialPassword,
  });
  await expect(page.getByRole("alert").filter({
    hasText: "The application state changed; review the latest session state",
  })).toBeVisible();
  await expect(username).toHaveValue(`  ${privateCredentialUsername}  `);
  await expect(password).toHaveValue(privateCredentialPassword);
  await expect(signIn).toBeEnabled();
  const statusText = (await page.getByRole("status").allInnerTexts()).join(" ");
  expect(statusText).not.toContain(privateCredentialUsername);
  expect(statusText).not.toContain(privateCredentialPassword);
  const renderedText = await page.locator("body").innerText();
  expect(renderedText).not.toContain(privateCredentialUsername);
  expect(renderedText).not.toContain(privateCredentialPassword);

  changedFrame.resolve();
  await expect(username).toHaveValue("");
  await expect(password).toHaveValue("");

  const savedUsername = "new-account@example.test";
  const savedPassword = "new account private password";
  await username.fill(savedUsername);
  await password.fill(savedPassword);
  await save.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => mock.commands.length).toBe(2);
  expect(mock.commands[1]).toEqual({
    type: "save_credentials",
    username: savedUsername,
    password: savedPassword,
  });
  await expect(credentialsForm.getByRole("button", { name: "Saving credentials…" }))
    .toBeDisabled();
  await expect(username).toBeDisabled();
  await expect(password).toBeDisabled();
  await expect(username).toHaveValue(savedUsername);
  await expect(password).toHaveValue(savedPassword);

  progressFrame.resolve();
  await expect(credentialsForm).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Applying" })).toBeVisible();
  returnFrame.resolve();
  await expect(page.getByRole("form", { name: "Credentials needed" })).toBeVisible();
  await expect(page.getByLabel("Username or email")).toHaveValue("");
  await expect(page.getByLabel("Password")).toHaveValue("");
  const finalRenderedText = await page.locator("body").innerText();
  expect(finalRenderedText).not.toContain(privateCredentialUsername);
  expect(finalRenderedText).not.toContain(privateCredentialPassword);
  expect(finalRenderedText).not.toContain(savedUsername);
  expect(finalRenderedText).not.toContain(savedPassword);
  const publicResponses = mock.publicResponseBodies.join(" ");
  expect(publicResponses).not.toContain(privateCredentialUsername);
  expect(publicResponses).not.toContain(privateCredentialPassword);
  expect(publicResponses).not.toContain(savedUsername);
  expect(publicResponses).not.toContain(savedPassword);
});

test("credential values survive a network failure while both actions stay latched", async ({ page }) => {
  const credentials = snapshotFixture({
    bridgeState: "awaiting_human_navigation",
    pendingAction: { type: "credentials" },
    updatedAt: createdAt + 100,
  });
  const cancelled = snapshotFixture({
    bridgeState: "cancelled",
    updatedAt: createdAt + 200,
  });
  const cancelFrame = deferred();
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: credentials,
  });
  mock.commandReplies.push({ status: 0 }, { status: 202 });
  queueSse(
    mock,
    eventFixture("cancelled", cancelled, {}),
    2,
    cancelFrame.promise,
    () => {
      mock.application = cancelled;
    },
  );

  await page.goto(`/runs/${runId}`);
  const credentialsForm = page.getByRole("form", { name: "Credentials needed" });
  const username = page.getByLabel("Username or email");
  const password = page.getByLabel("Password");
  await username.fill(privateCredentialUsername);
  await password.fill(privateCredentialPassword);
  await credentialsForm.getByRole("button", { name: "Sign in with credentials" }).click();

  await expect.poll(() => mock.commands.length).toBe(1);
  expect(mock.commands[0]).toEqual({
    type: "sign_in",
    username: privateCredentialUsername,
    password: privateCredentialPassword,
  });
  await expect(page.getByRole("alert").filter({
    hasText: "The pipeline service could not be reached.",
  })).toBeVisible();
  await expect(credentialsForm.getByRole("button", { name: "Signing in…" })).toBeDisabled();
  await expect(credentialsForm.getByRole("button", {
    name: "Save credentials",
    exact: true,
  })).toBeDisabled();
  await expect(username).toBeDisabled();
  await expect(password).toBeDisabled();
  await expect(username).toHaveValue(privateCredentialUsername);
  await expect(password).toHaveValue(privateCredentialPassword);
  const statusText = (await page.getByRole("status").allInnerTexts()).join(" ");
  expect(statusText).not.toContain(privateCredentialUsername);
  expect(statusText).not.toContain(privateCredentialPassword);
  const renderedText = await page.locator("body").innerText();
  expect(renderedText).not.toContain(privateCredentialUsername);
  expect(renderedText).not.toContain(privateCredentialPassword);
  const cancel = page.getByRole("button", { name: "Cancel application" });
  await expect(cancel).toBeEnabled();
  await cancel.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => mock.commands.length).toBe(2);
  expect(mock.commands[1]).toEqual({ type: "cancel" });
  await expect(page.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
  await expect(page.getByRole("status").filter({
    hasText: "Waiting for credentials — Cancelling application",
  })).toBeVisible();
  await expect(username).toHaveValue(privateCredentialUsername);
  await expect(password).toHaveValue(privateCredentialPassword);

  cancelFrame.resolve();
  await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeVisible();
  await expect(credentialsForm).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel application" })).toHaveCount(0);
  expect(mock.commands).toEqual([
    {
      type: "sign_in",
      username: privateCredentialUsername,
      password: privateCredentialPassword,
    },
    { type: "cancel" },
  ]);
});

test("an uncertain revision response keeps the command latch engaged", async ({ page }) => {
  const review = snapshotFixture({
    bridgeState: "awaiting_human_review",
    pendingAction: { type: "human_review" },
    updatedAt: createdAt + 100,
  });
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: review,
  });
  mock.commandReplies.push({
    status: 503,
    body: apiError("PIPELINE_UNAVAILABLE", "The pipeline request failed."),
  });

  await page.goto(`/runs/${runId}`);
  await page.getByLabel("Revision instructions").fill("Correct the public salary field.");
  await page.getByRole("button", { name: "Request application revision" }).click();

  await expect.poll(() => mock.commands.length).toBe(1);
  expect(mock.commands[0]).toEqual({
    type: "revise",
    context: "Correct the public salary field.",
  });
  await expect(page.getByRole("alert").filter({
    hasText: "The pipeline request failed.",
  })).toBeVisible();
  await expect(page.getByRole("button", { name: "Requesting revision…" })).toBeDisabled();
});

test("an uncertain retry response keeps the lifecycle latch engaged", async ({ page }) => {
  const failed = snapshotFixture({
    bridgeState: "failed",
    updatedAt: createdAt + 100,
  });
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: failed,
  });
  mock.retryReplies.push({
    status: 503,
    body: apiError("PIPELINE_UNAVAILABLE", "The pipeline request failed."),
  });

  await page.goto(`/runs/${runId}`);
  await page.getByRole("button", { name: "Retry applying" }).click();

  await expect.poll(() => mock.retryBodies.length).toBe(1);
  await expect(page.getByRole("alert").filter({
    hasText: "The pipeline request failed.",
  })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retrying…" })).toBeDisabled();
});

test("a definite submit conflict releases the approval latch", async ({ page }) => {
  const review = snapshotFixture({
    bridgeState: "awaiting_human_review",
    pendingAction: { type: "human_review" },
    updatedAt: createdAt + 100,
  });
  const refreshedReview = snapshotFixture({
    bridgeState: "awaiting_human_review",
    pendingAction: { type: "human_review" },
    updatedAt: createdAt + 200,
  });
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: review,
  });
  mock.commandReplies.push({
    status: 409,
    body: apiError(
      "APPLICATION_COMMAND_CONFLICT",
      "The application state changed; review the latest session state",
    ),
    before: () => {
      mock.application = refreshedReview;
    },
  });

  await page.goto(`/runs/${runId}`);
  const submitButton = page.getByRole("button", { name: "Approve and submit" }).first();
  await submitButton.click();
  await page.getByRole("dialog", { name: "Submit this application?" })
    .getByRole("button", { name: "Approve and submit" })
    .click();

  await expect.poll(() => mock.commands.length).toBe(1);
  expect(mock.commands[0]).toEqual({ type: "submit" });
  await expect(page.getByRole("alert").filter({
    hasText: "The application state changed; review the latest session state",
  })).toBeVisible();
  await expect(submitButton).toBeEnabled();
});

test("preserves a downstream lifecycle while an application remains parked for review", async ({ page }) => {
  const review = snapshotFixture({
    bridgeState: "awaiting_human_review",
    pendingAction: { type: "human_review" },
    updatedAt: createdAt + 300,
  });
  const mock = await installPipeline(page, {
    run: { ...approvedRun(), applicationStatus: "oa_received" },
    iterations: approvedIterations(),
    application: review,
  });

  await page.goto(`/runs/${runId}`);

  const applicationSummary = page.getByRole("complementary", {
    name: "Application summary and keyword comparison",
  });
  await expect(page.getByRole("heading", { name: "Review the application" })).toBeVisible();
  await expect(applicationSummary.getByText("OA received", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: /^Waiting for review!$/ }))
    .toHaveText("Waiting for review!");
  await expect.poll(() => mock.runGetCount).toBe(1);
});

test("navigation, human review, submit approval, and close use exact public commands", async ({ page }) => {
  const navigation = snapshotFixture({
    bridgeState: "awaiting_human_navigation",
    pendingAction: { type: "human_navigation", instruction: "Complete the public sign-in checkpoint." },
    updatedAt: createdAt + 100,
  });
  const unrelatedNavigation = snapshotFixture({
    bridgeState: "awaiting_human_navigation",
    pendingAction: { type: "human_navigation", instruction: "Complete the public sign-in checkpoint." },
    updatedAt: createdAt + 150,
    company: "Unrelated progress company",
  });
  const review = snapshotFixture({
    bridgeState: "awaiting_human_review",
    pendingAction: { type: "human_review" },
    updatedAt: createdAt + 300,
    fieldsFilled: [{
      label: "Email",
      fieldType: "text",
      valuePresent: true,
      note: "Filled",
    }],
    fieldsNeedingHuman: [{
      label: "Salary expectation",
      fieldType: "text",
      valuePresent: false,
      note: "Review in Chrome",
    }],
    warnings: ["Confirm the public salary range."],
  });
  const revised = snapshotFixture({
    bridgeState: "awaiting_human_review",
    pendingAction: { type: "human_review" },
    updatedAt: createdAt + 400,
    revisionCount: 1,
    warnings: ["Confirm the public salary range."],
  });
  const submitted = snapshotFixture({
    bridgeState: "submitted",
    updatedAt: createdAt + 500,
    revisionCount: 1,
  });
  const closed = snapshotFixture({
    bridgeState: "closed",
    submissionPhase: "submitted",
    updatedAt: createdAt + 600,
    revisionCount: 1,
  });
  const unrelatedFrame = deferred();
  const continueFrame = deferred();
  const continueResponse = deferred();
  const reviseFrame = deferred();
  const submittedFrame = deferred();
  const closeFrame = deferred();
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: navigation,
  });
  mock.commandReplies.push(
    { status: 202, waitFor: continueResponse.promise },
  );
  queueSse(mock, eventFixture("snapshot", unrelatedNavigation, {}), 2, unrelatedFrame.promise);
  queueSse(mock, eventFixture("review_required", review, {}), 3, continueFrame.promise);
  queueSse(mock, eventFixture("revision_applied", revised, { revisionCount: 1 }), 4, reviseFrame.promise);
  queueSse(mock, eventFixture("application_submitted", submitted, {}), 5, submittedFrame.promise);
  queueSse(mock, eventFixture("closed", closed, {}), 6, closeFrame.promise);

  await page.goto(`/runs/${runId}`);
  const applicationPanel = page.getByRole("region", {
    name: "Application",
    exact: true,
  });
  const workflow = page.getByRole("list", { name: "Workflow progress" });
  const applyingStage = workflow.getByRole("listitem").filter({ hasText: "Applying" });
  const appliedStage = workflow.getByRole("listitem").filter({ hasText: "Applied" });
  await expect(applyingStage).toHaveAttribute("aria-current", "step");
  await expect(appliedStage).not.toHaveAttribute("aria-current", "step");
  await expect(page.getByText("Complete the public sign-in checkpoint.")).toBeVisible();
  await page.getByRole("button", { name: "Continue application" }).click();
  await expect.poll(() => mock.commands.length).toBe(1);
  expect(mock.commands[0]).toEqual({ type: "continue" });
  await expect(page.getByRole("button", { name: "Continuing…" })).toBeDisabled();
  unrelatedFrame.resolve();
  await expect(applicationPanel.getByText("Unrelated progress company", { exact: true }))
    .toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continuing…" })).toBeDisabled();
  const continueAccepted = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `${pipelineRunPath}/application/commands`
    && response.request().method() === "POST"
    && response.status() === 202
  );
  continueResponse.resolve();
  await continueAccepted;
  await page.evaluate(() => new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  }));
  await expect(page.getByRole("button", { name: "Continuing…" })).toBeDisabled();
  continueFrame.resolve();


  await expect(page.getByRole("heading", { name: "Review the application" })).toBeVisible();
  const applicationSummary = page.getByRole("complementary", {
    name: "Application summary and keyword comparison",
  });
  await expect(applicationSummary.getByText("Pending", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: /^Waiting for review!$/ }))
    .toHaveText("Waiting for review!");
  await expect.poll(() => mock.runGetCount).toBe(1);
  await expect(applyingStage).toHaveAttribute("aria-current", "step");
  await expect(appliedStage.locator("svg")).toHaveCount(0);
  await expect(
    applicationPanel.getByText("Public Example Company", { exact: true }),
  ).toHaveCount(0);
  await expect(
    applicationPanel.getByText("Public Staff Engineer", { exact: true }),
  ).toHaveCount(0);
  await expect(applicationPanel.getByText("Email", { exact: true })).toHaveCount(0);
  await expect(
    applicationPanel.getByText("Salary expectation", { exact: true }),
  ).toHaveCount(0);
  const applicationWarnings = applicationPanel.getByRole("alert", {
    name: "Application warnings",
  });
  await expect(applicationWarnings).toBeVisible();
  await expect(applicationWarnings).toHaveText("Confirm the public salary range.");
  const requestRevisionButton = page.getByRole("button", { name: "Request application revision" });
  const submitButton = page.getByRole("button", { name: "Approve and submit" }).first();
  await expect(requestRevisionButton).toBeDisabled();
  await expect(submitButton).toBeEnabled();
  mock.application = review;
  const revisionInstructions = page.getByLabel("Revision instructions");
  await revisionInstructions.fill("  Correct the public salary field.  ");
  await requestRevisionButton.click();
  await expect.poll(() => mock.commands.length).toBe(2);
  expect(mock.commands[1]).toEqual({
    type: "revise",
    context: "Correct the public salary field.",
  });
  await expect(page.getByRole("button", { name: "Requesting revision…" })).toBeDisabled();
  reviseFrame.resolve();
  await expect(requestRevisionButton).toBeEnabled();
  await expect(
    applicationPanel.getByText("Application revisions", { exact: true }),
  ).toHaveCount(0);
  await expect(applicationPanel.getByText("1", { exact: true })).toHaveCount(0);
  mock.application = revised;

  await submitButton.click();
  const submitDialog = page.getByRole("dialog", { name: "Submit this application?" });
  await expect(submitDialog).toBeVisible();
  await expect(submitDialog).toContainText(
    "This action is irreversible. The application assistant will submit the completed application in the headed browser. Continue only after you have reviewed every field and warning.",
  );
  await submitDialog.getByRole("button", { name: "Approve and submit" }).click();
  await expect.poll(() => mock.commands.length).toBe(3);
  expect(mock.commands[2]).toEqual({ type: "submit" });
  await expect(page.getByRole("button", { name: "Approving submission…" })).toBeDisabled();
  mock.run = {
    ...mock.run,
    applicationStatus: "applied",
    updatedAt: mock.run.updatedAt + 1,
  };
  submittedFrame.resolve();

  await expect(page.getByRole("status").filter({ hasText: "Application submitted" })).toBeVisible();
  await expect(page.getByText(/Headed Chrome stays open until .* so you can inspect the final application state/)).toBeVisible();
  await expect.poll(() => mock.runGetCount).toBe(2);
  await expect(applyingStage).not.toHaveAttribute("aria-current", "step");
  await expect(applyingStage.locator("svg")).toHaveCount(1);
  await expect(appliedStage.locator("svg")).toHaveCount(1);
  mock.application = submitted;
  await expect(page.getByRole("button", { name: "Cancel application" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close browser" })).toBeVisible();
  await expect(page.getByText("Applied", { exact: true }).first()).toBeVisible();

  mock.onDelete = () => {
    mock.application = closed;
    closeFrame.resolve();
  };
  await page.getByRole("button", { name: "Close browser" }).click();
  await expect.poll(() => mock.deleteCount).toBe(1);
  await expect(page.getByRole("status").filter({ hasText: "Closed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry applying" })).toHaveCount(0);
  expect(mock.commands).toEqual([
    { type: "continue" },
    { type: "revise", context: "Correct the public salary field." },
    { type: "submit" },
  ]);
});

test("submission uncertainty keeps Applying current and never offers Retry", async ({ page }) => {
  const initialRun = approvedRun();
  const refreshedRun: RunDto = {
    ...initialRun,
    updatedAt: initialRun.updatedAt + 1,
  };
  const uncertain = snapshotFixture({
    bridgeState: "submission_uncertain",
    submissionPhase: "uncertain",
    updatedAt: createdAt + 500,
    warnings: [
      "The application submission could not be verified. Check the headed browser if it is still available, then close this session.",
    ],
  });
  const mock = await installPipeline(page, {
    run: initialRun,
    iterations: approvedIterations(),
    application: uncertain,
  });
  mock.runReplies.push(
    { status: 200, body: initialRun },
    { status: 200, body: refreshedRun },
  );

  await page.goto(`/runs/${runId}`);
  const workflow = page.getByRole("list", { name: "Workflow progress" });
  const applyingStage = workflow.getByRole("listitem").filter({ hasText: "Applying" });
  const appliedStage = workflow.getByRole("listitem").filter({ hasText: "Applied" });
  await expect(applyingStage).toHaveAttribute("aria-current", "step");
  await expect(appliedStage).not.toHaveAttribute("aria-current", "step");
  await expect(appliedStage.locator("svg")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close browser" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry applying" })).toHaveCount(0);
  await expect(page.getByText("The application submission could not be verified.", {
    exact: false,
  })).toBeVisible();
  await expect(page.getByText("Pending", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: /^Waiting for review!$/ })).toHaveCount(0);
  await expect.poll(() => mock.runGetCount).toBe(2);
});

test("a closed submitted session refreshes the authoritative run status", async ({ page }) => {
  const initialRun = approvedRun();
  const appliedRun: RunDto = {
    ...initialRun,
    applicationStatus: "applied",
    updatedAt: initialRun.updatedAt + 1,
  };
  const closed = snapshotFixture({
    bridgeState: "closed",
    harnessState: "closed",
    submissionPhase: "submitted",
    updatedAt: createdAt + 500,
  });
  const mock = await installPipeline(page, {
    run: initialRun,
    iterations: approvedIterations(),
    application: closed,
  });
  mock.runReplies.push(
    { status: 200, body: initialRun },
    { status: 200, body: appliedRun },
  );

  await page.goto(`/runs/${runId}`);
  await expect.poll(() => mock.runGetCount).toBe(2);
  await expect(
    page.getByRole("complementary", { name: "Application summary and keyword comparison" })
      .getByText("Applied", { exact: true }),
  ).toBeVisible();
  const appliedStage = page.getByRole("list", { name: "Workflow progress" })
    .getByRole("listitem")
    .filter({ hasText: "Applied" });
  await expect(appliedStage.locator("svg")).toHaveCount(1);
});

test("a failed submitted-run refresh is retryable without resubmitting", async ({ page }) => {
  const initialRun = approvedRun();
  const appliedRun: RunDto = {
    ...initialRun,
    applicationStatus: "applied",
    updatedAt: initialRun.updatedAt + 1,
  };
  const submitted = snapshotFixture({
    bridgeState: "submitted",
    updatedAt: createdAt + 500,
  });
  const mock = await installPipeline(page, {
    run: initialRun,
    iterations: approvedIterations(),
    application: submitted,
  });
  mock.runReplies.push(
    { status: 200, body: initialRun },
    {
      status: 503,
      body: {
        error: {
          code: "HARNESS_UNAVAILABLE",
          message: "Run refresh unavailable",
        },
      },
    },
  );

  await page.goto(`/runs/${runId}`);
  await expect.poll(() => mock.runGetCount).toBe(2);
  const refreshAlert = page.getByRole("alert").filter({ hasText: "The pipeline request failed." });
  await expect(refreshAlert).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Application summary and keyword comparison" })
      .getByText("Pending", { exact: true }),
  ).toBeVisible();
  const appliedStage = page.getByRole("list", { name: "Workflow progress" })
    .getByRole("listitem")
    .filter({ hasText: "Applied" });
  await expect(appliedStage.locator("svg")).toHaveCount(1);

  mock.runReplies.push({ status: 200, body: appliedRun });
  await refreshAlert.getByRole("button", { name: "Retry status refresh" }).click();
  await expect.poll(() => mock.runGetCount).toBe(3);
  await expect(refreshAlert).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "Application summary and keyword comparison" })
      .getByText("Applied", { exact: true }),
  ).toBeVisible();
  expect(mock.commands).toEqual([]);
});

test("Ctrl-Enter requests exact-hash resume edits for an approved initial revision after cancellation", async ({ page }) => {
  const initialApprovedRun = runFixture({
    status: "approved",
    revision: 1,
    origin: "initial",
    pdfSha256: pdfHash1,
  });
  const editingRun = runFixture({
    status: "editing",
    revision: 2,
    origin: "human-comments",
    pdfSha256: null,
  });
  const cancelled = snapshotFixture({
    bridgeState: "cancelled",
    submissionPhase: "not_attempted",
  });
  const mock = await installPipeline(page, {
    run: initialApprovedRun,
    iterations: iterationList(iteration(1, "initial", pdfHash1, "approved")),
    application: cancelled,
  });
  mock.editReply = editingRun;

  await page.goto(`/runs/${runId}`);

  await expect(page.getByLabel("Displayed resume")).toHaveValue("1");
  await expect(page.getByLabel("Selected resume PDF for Public Role 1")).toHaveAttribute(
    "data",
    `${pipelineRunPath}/iterations/1/artifacts/resume-r1`,
  );
  await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeVisible();
  const editInstructions = page.getByLabel("Edit instructions");
  const requestEdits = page.getByRole("button", { name: "Request edits" });
  await expect(editInstructions).toBeVisible();
  await expect(editInstructions).toBeEnabled();
  await expect(requestEdits).toBeVisible();
  await expect(requestEdits).toBeEnabled();
  await expect(page.getByRole("button", { name: "Regenerate" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve and apply" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);

  await editInstructions.fill("  Strengthen initial platform ownership.  ");
  await editInstructions.press("Control+Enter");

  await expect.poll(
    () => mock.requests.filter((request) => request.path === `${pipelineRunPath}/edit`).length,
  ).toBe(1);
  expect(mock.requests.find((request) => request.path === `${pipelineRunPath}/edit`)).toEqual({
    method: "POST",
    path: `${pipelineRunPath}/edit`,
    body: {
      comments: "Strengthen initial platform ownership.",
      expectedPdfSha256: pdfHash1,
    },
  });
});

test("a reserved generation resumes, running cancel is a command, and cancelled application permits resume edits", async ({ page }) => {
  const reserved = snapshotFixture({ bridgeState: "reserved" });
  const running = snapshotFixture({ bridgeState: "running", updatedAt: createdAt + 200 });
  const cancelled = snapshotFixture({ bridgeState: "cancelled", updatedAt: createdAt + 300 });
  const editingRun = runFixture({
    status: "editing",
    revision: 3,
    origin: "human-comments",
    pdfSha256: null,
  });
  const revisedIteration = iteration(3, "human-comments", pdfHash3);
  const revisedRun = runFixture({
    status: "review",
    revision: 3,
    origin: "human-comments",
    pdfSha256: pdfHash3,
  });
  const revisedApprovedRun = runFixture({
    status: "approved",
    revision: 3,
    origin: "human-comments",
    pdfSha256: pdfHash3,
  });
  const revisedStarting = snapshotFixture({
    bridgeState: "starting",
    generation: 2,
    updatedAt: createdAt + 400,
  });
  const cancelFrame = deferred();
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: reserved,
  });
  mock.startReplies.push(
    { status: 202, body: running },
    { status: 202, body: revisedStarting },
  );
  queueSse(mock, eventFixture("cancelled", cancelled, {}), 2, cancelFrame.promise);
  mock.editReply = editingRun;
  mock.editReplies.push({
    status: 200,
    before: () => {
      mock.application = notStartedAfterApproval();
    },
  });
  mock.approveReply = revisedApprovedRun;

  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole("status").filter({ hasText: "Preparing browser" })).toBeVisible();
  await page.getByRole("button", { name: "Start applying" }).click();
  await expect.poll(() => mock.startBodies.length).toBe(1);
  expect(mock.startBodies[0]).toEqual({ expectedApprovedPdfSha256: pdfHash2 });
  await expect(page.getByRole("status").filter({ hasText: "Applying" })).toBeVisible();

  await page.getByRole("button", { name: "Cancel application" }).click();
  await expect.poll(() => mock.commands.length).toBe(1);
  expect(mock.commands[0]).toEqual({ type: "cancel" });
  await expect(page.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
  cancelFrame.resolve();
  await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeVisible();
  mock.application = cancelled;
  await expect(page.getByRole("button", { name: "Retry applying" })).toBeVisible();

  const editInstructions = page.getByLabel("Edit instructions");
  const requestEdits = page.getByRole("button", { name: "Request edits" });
  await expect(page.getByLabel("Displayed resume")).toHaveValue("2");
  await expect(editInstructions).toBeVisible();
  await expect(requestEdits).toBeEnabled();
  await expect(page.getByRole("button", { name: "Regenerate" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve and apply" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);

  await editInstructions.fill("  Strengthen platform ownership.  ");
  await requestEdits.click();

  await expect.poll(
    () => mock.requests.filter((request) => request.path === `${pipelineRunPath}/edit`).length,
  ).toBe(1);
  expect(mock.requests.find((request) => request.path === `${pipelineRunPath}/edit`)).toEqual({
    method: "POST",
    path: `${pipelineRunPath}/edit`,
    body: {
      comments: "Strengthen platform ownership.",
      expectedPdfSha256: pdfHash2,
    },
  });
  await expect(editInstructions).toHaveCount(0);
  await expect(requestEdits).toHaveCount(0);
  expect(mock.run.revision).toBe(3);
  expect(mock.deleteCount).toBe(0);

  mock.run = revisedRun;
  mock.iterations = iterationList(
    iteration(1, "initial", pdfHash1),
    iteration(2, "human-comments", pdfHash2, "approved"),
    revisedIteration,
  );
  await page.waitForTimeout(2_600);

  await expect(page.getByLabel("Displayed resume")).toHaveValue("3");
  await expect(page.getByLabel("Selected resume PDF for Public Role 3")).toHaveAttribute(
    "data",
    `${pipelineRunPath}/iterations/3/artifacts/resume-r3`,
  );
  await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry applying" })).toHaveCount(0);
  const approveAndApply = page.getByRole("button", { name: "Approve and apply" });
  await expect(approveAndApply).toBeEnabled();

  mock.iterations = iterationList(
    iteration(1, "initial", pdfHash1),
    iteration(2, "human-comments", pdfHash2, "approved"),
    iteration(3, "human-comments", pdfHash3, "approved"),
  );
  await approveAndApply.click();

  await expect.poll(() => mock.startBodies.length).toBe(2);
  expect(mock.requests.filter((request) => request.path === `${pipelineRunPath}/approve`)).toEqual([{
    method: "POST",
    path: `${pipelineRunPath}/approve`,
    body: {
      expectedPdfSha256: pdfHash3,
      acknowledgeVisualIssues: false,
    },
  }]);
  expect(mock.startBodies).toEqual([
    { expectedApprovedPdfSha256: pdfHash2 },
    { expectedApprovedPdfSha256: pdfHash3 },
  ]);
  await expect(page.getByRole("status").filter({ hasText: "Starting browser" })).toBeVisible();
});

test("a not-yet-created reserved generation cancels locally with DELETE", async ({ page }) => {
  const reserved = snapshotFixture({ bridgeState: "reserved" });
  const closed = snapshotFixture({
    bridgeState: "closed",
    harnessState: null,
    updatedAt: createdAt + 200,
  });
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: reserved,
  });
  mock.onDelete = () => {
    mock.application = closed;
  };

  await page.goto(`/runs/${runId}`);
  await page.getByRole("button", { name: "Cancel application" }).click();
  await expect.poll(() => mock.deleteCount).toBe(1);
  expect(mock.commands).toEqual([]);
  await expect(page.getByRole("status").filter({ hasText: "Closed" })).toBeVisible();
});

test("lost, failed, and closed generations retry with the approved hash and fresh stream cursors", async ({ page }) => {
  const lost = snapshotFixture({ bridgeState: "lost", generation: 2, updatedAt: createdAt + 200 });
  const running3 = snapshotFixture({ bridgeState: "running", generation: 3, updatedAt: createdAt + 300 });
  const failed3 = snapshotFixture({ bridgeState: "failed", generation: 3, updatedAt: createdAt + 400 });
  const running4 = snapshotFixture({ bridgeState: "running", generation: 4, updatedAt: createdAt + 500 });
  const closed4 = snapshotFixture({ bridgeState: "closed", generation: 4, updatedAt: createdAt + 600 });
  const reserved5 = snapshotFixture({ bridgeState: "reserved", generation: 5, updatedAt: createdAt + 700 });
  const failedFrame = deferred();
  const closedFrame = deferred();
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: lost,
  });
  mock.retryReplies.push(
    { status: 202, body: running3 },
    { status: 202, body: running4 },
    { status: 202, body: reserved5 },
  );
  queueSse(mock, eventFixture("failed", failed3, {}), 1, failedFrame.promise);
  queueSse(mock, eventFixture("closed", closed4, {}), 1, closedFrame.promise);

  await page.goto(`/runs/${runId}`);
  await expect(page.getByText("Before retrying, verify whether the application was submitted.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Retry applying" }).click();
  await expect.poll(() => mock.retryBodies.length).toBe(1);
  failedFrame.resolve();
  await expect(page.getByRole("status").filter({ hasText: "Failed" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "The browser session failed" })).toBeVisible();
  mock.application = failed3;

  await page.getByRole("button", { name: "Retry applying" }).click();
  await expect.poll(() => mock.retryBodies.length).toBe(2);
  closedFrame.resolve();
  await expect(page.getByRole("status").filter({ hasText: "Closed" })).toBeVisible();
  mock.application = closed4;

  await page.getByRole("button", { name: "Retry applying" }).click();
  await expect.poll(() => mock.retryBodies.length).toBe(3);
  await expect(page.getByRole("status").filter({ hasText: "Preparing browser" })).toBeVisible();
  expect(mock.retryBodies).toEqual([
    { expectedApprovedPdfSha256: pdfHash2 },
    { expectedApprovedPdfSha256: pdfHash2 },
    { expectedApprovedPdfSha256: pdfHash2 },
  ]);
  expect(mock.sseHeaders.slice(0, 2)).toEqual([null, null]);
});

test("finite SSE replay preserves the current gate, reconnects with a fresh source for durable recovery, and reconciles lost", async ({ page }) => {
  const olderNavigation = snapshotFixture({
    bridgeState: "awaiting_human_navigation",
    generation: 2,
    pendingAction: { type: "human_navigation", instruction: "Stale navigation instruction." },
    updatedAt: createdAt + 100,
    company: "Stale Regression Company",
  });
  const currentOrigin = snapshotFixture({
    bridgeState: "awaiting_origin_approval",
    generation: 2,
    pendingAction: { type: "origin_approval", origin: "https://current.example.test" },
    updatedAt: createdAt + 200,
  });
  const staleGeneration = snapshotFixture({
    bridgeState: "awaiting_human_navigation",
    generation: 1,
    pendingAction: { type: "human_navigation", instruction: "Generation one must stay stale." },
    updatedAt: createdAt + 900,
    company: "Stale Generation Company",
  });
  const lost = snapshotFixture({
    bridgeState: "lost",
    generation: 2,
    updatedAt: createdAt + 300,
  });
  const resumeFrame = deferred();
  const initialClose = deferred();
  const initialFollowup = deferred();
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: olderNavigation,
    useNativeSse: true,
  });
  const replayEvents = [
    eventFixture("human_navigation_required", olderNavigation, {
      instruction: "Stale navigation instruction.",
    }),
    eventFixture("origin_approval_required", currentOrigin, {
      origin: "https://current.example.test",
    }),
  ] as const;
  const staleEvent = eventFixture("human_navigation_required", staleGeneration, {
    instruction: "Generation one must stay stale.",
  });
  nativeSseScenario = {
    headers: mock.sseHeaders,
    servedBodies: mock.publicResponseBodies,
    initialBody: `retry: 25\n${eventBlock(replayEvents[0], 6)}`,
    initialFollowupBody: eventBlock(replayEvents[1], 7),
    resumedBody: `retry: 60000\n${eventBlock(staleEvent, 99)}`,
    waitForResume: resumeFrame.promise,
    waitForInitialClose: initialClose.promise,
    waitForInitialFollowup: initialFollowup.promise,
    onResume: () => {
      mock.application = lost;
    },
  };

  await page.goto(`/runs/${runId}`);
  await expect.poll(() => mock.sseHeaders.length).toBeGreaterThanOrEqual(1);
  initialFollowup.resolve();
  try {
    await expect(page.getByText("https://current.example.test", { exact: true })).toBeVisible();
  } finally {
    initialClose.resolve();
  }
  await expect(page.getByText("Stale navigation instruction.", { exact: true })).toHaveCount(0);
  await expect.poll(() => mock.sseHeaders.length).toBeGreaterThanOrEqual(2);
  await expect.poll(() => mock.sseHeaders.slice(0, 2)).toEqual([null, null]);
  resumeFrame.resolve();

  await expect(page.getByRole("status").filter({ hasText: "Connection lost" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry applying" })).toBeVisible();
  await expect(page.getByText("Generation one must stay stale.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Stale Generation Company", { exact: true })).toHaveCount(0);
  expect(mock.applicationGetCount).toBeGreaterThanOrEqual(3);
  expect(mock.runGetCount).toBe(1);
  expect(mock.commands).toEqual([]);
  expect(mock.startBodies).toEqual([]);
  expect(mock.retryBodies).toEqual([]);
  await assertNoPrivateHarnessDetails(page, mock);
});

test("an invalid live frame reconnects before a later gate command can wedge", async ({ page }) => {
  const navigation = snapshotFixture({
    bridgeState: "awaiting_human_navigation",
    generation: 2,
    pendingAction: { type: "human_navigation", instruction: "Use the public navigation step." },
    updatedAt: createdAt + 100,
  });
  const origin = snapshotFixture({
    bridgeState: "awaiting_origin_approval",
    generation: 2,
    pendingAction: { type: "origin_approval", origin: "https://recovered.example.test" },
    updatedAt: createdAt + 200,
  });
  const recoveredEvent = eventFixture("origin_approval_required", origin, {
    origin: "https://recovered.example.test",
  });
  await installControlledEventSource(page);
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: navigation,
  });

  await page.goto(`/runs/${runId}`);
  await expect(page.getByText("Use the public navigation step.", { exact: true })).toBeVisible();
  const initialSourceCount = await controlledEventSourceCount(page);
  await page.evaluate(() => {
    const sources = (
      window as typeof window & { __applicationEventSources: EventTarget[] }
    ).__applicationEventSources;
    sources.at(-1)?.dispatchEvent(new MessageEvent("snapshot", {
      data: "not-json",
      lastEventId: "2:8",
    }));
  });

  await expect(page.getByRole("alert").filter({
    hasText: "The application service returned an invalid live update.",
  })).toBeVisible();
  await expect.poll(() => mock.applicationGetCount).toBeGreaterThanOrEqual(2);
  await expect.poll(() => controlledEventSourceCount(page)).toBeGreaterThan(initialSourceCount);
  await emitControlledApplicationEvent(page, recoveredEvent, 9, initialSourceCount);

  await expect(page.getByText("https://recovered.example.test", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert").filter({
    hasText: "The application service returned an invalid live update.",
  })).toHaveCount(0);
});

test("an invalid SSE frame reconciles through authoritative GET and does not render its private payload", async ({ page }) => {
  const running = snapshotFixture({ bridgeState: "running", generation: 2, updatedAt: createdAt + 100 });
  const lost = snapshotFixture({ bridgeState: "lost", generation: 2, updatedAt: createdAt + 200 });
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: running,
  });
  const malformedSession = {
    ...running,
    harnessBaseUrl: privateHarnessValues[0],
    harnessSessionId: privateHarnessValues[1],
    authorization: privateHarnessValues[2],
    jobUrl: privateHarnessValues[3],
    approvedOrigins: [privateHarnessValues[4]],
    profilePath: privateHarnessValues[5],
    acceptedAnswers: [privateHarnessValues[6]],
  };
  queueMalformedSse(
    mock,
    `retry: 25\nid: 2:8\nevent: snapshot\ndata: ${JSON.stringify({
      generation: 2,
      event: "snapshot",
      session: malformedSession,
      detail: {},
    })}\n\n`,
    () => {
      mock.application = lost;
    },
  );

  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole("status").filter({ hasText: "Connection lost" })).toBeVisible();
  expect(mock.applicationGetCount).toBeGreaterThanOrEqual(2);
  for (const privateValue of privateHarnessValues) {
    await expect(page.getByText(privateValue, { exact: false })).toHaveCount(0);
  }
});

test("guidance remains accessible across gates and ambiguous delivery resets on state exit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const running = snapshotFixture({
    bridgeState: "running",
    updatedAt: createdAt + 100,
  });
  const waiting = snapshotFixture({
    bridgeState: "awaiting_human_navigation",
    updatedAt: createdAt + 200,
    pendingAction: {
      type: "human_navigation",
      instruction: "Complete the public checkpoint.",
    },
  });
  const resumed = snapshotFixture({
    bridgeState: "running",
    updatedAt: createdAt + 300,
  });
  const leaveRunning = deferred();
  const returnToRunning = deferred();
  const ambiguousDelivery = deferred();
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: running,
  });
  queueSse(
    mock,
    eventFixture("human_navigation_required", waiting, {
      instruction: "Complete the public checkpoint.",
    }),
    2,
    leaveRunning.promise,
  );
  queueSse(
    mock,
    eventFixture("snapshot", resumed, {}),
    3,
    returnToRunning.promise,
  );
  mock.commandReplies.push(
    { status: 202 },
    {
      status: 409,
      body: apiError(
        "APPLICATION_COMMAND_CONFLICT",
        "The application state changed; review the latest session state",
      ),
    },
    {
      status: 503,
      body: apiError("APPLICATION_HARNESS_UNAVAILABLE", "private upstream detail"),
      waitFor: ambiguousDelivery.promise,
    },
    { status: 202 },
    { status: 202 },
  );

  await page.goto(`/runs/${runId}`);
  const applicationPanel = page.getByRole("region", {
    name: "Application",
    exact: true,
  });
  const form = applicationPanel.getByRole("form", { name: "Steer the agent" });
  const guidance = form.getByRole("textbox", { name: "Steer the agent" });
  const send = page.getByRole("button", { name: "Send guidance" });
  const cancel = page.getByRole("button", { name: "Cancel application" });
  const applicationState = applicationPanel.getByRole("status").filter({
    hasText: /^Applying$/,
  });
  await expect(form).toBeVisible();
  await expect(guidance).toBeVisible();
  await expect(form.getByText("Steer the agent", { exact: true })).toHaveCount(1);
  await expect(applicationState).toHaveText("Applying");
  await expect(
    applicationPanel.getByRole("heading", { name: "Guide the application agent" }),
  ).toHaveCount(0);
  await expect(applicationPanel.getByText("Operator guidance", { exact: true })).toHaveCount(0);
  await expect(applicationPanel.getByText(
    "Delivered once before the next agent step. If an action is waiting, delivery releases it immediately. Guidance is not saved to your profile or application facts.",
    { exact: true },
  )).toHaveCount(0);
  const applicationStateBox = await applicationState.boundingBox();
  expect(applicationStateBox).not.toBeNull();
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )).toBe(true);
  const formBox = await form.boundingBox();
  expect(formBox).not.toBeNull();
  expect(formBox!.x + formBox!.width).toBeLessThanOrEqual(390);
  expect(formBox!.y + formBox!.height).toBeLessThanOrEqual(applicationStateBox!.y);

  await guidance.fill("contains\u0000nul");
  await send.click();
  await expect(page.getByRole("alert").filter({
    hasText: "Enter guidance between 1 and 8,000 Unicode characters without null characters.",
  })).toBeVisible();
  expect(mock.commands).toEqual([]);

  await guidance.fill("First line");
  await guidance.press("Enter");
  await guidance.type("Second line");
  await expect(guidance).toHaveValue("First line\nSecond line");
  expect(mock.commands).toEqual([]);
  await guidance.fill("\u001c  Check the public salary field.  \u001f");
  await guidance.focus();
  await guidance.press("Tab");
  await expect(send).toBeFocused();
  await send.press("Enter");
  await expect.poll(() => mock.commands.length).toBe(1);
  expect(mock.commands[0]).toEqual({
    type: "steer",
    message: "Check the public salary field.",
  });
  await expect(guidance).toHaveValue("");
  const queuedStatus = page.getByRole("status").filter({
    hasText: "Guidance queued for the next agent step.",
  });
  await expect(queuedStatus).toHaveText("Guidance queued for the next agent step.");
  await expect(queuedStatus).toHaveAttribute("aria-live", "polite");

  const rejectedDraft = "Check only the public compensation field.";
  await guidance.fill(rejectedDraft);
  await send.click();
  await expect.poll(() => mock.commands.length).toBe(2);
  expect(mock.commands[1]).toEqual({ type: "steer", message: rejectedDraft });
  await expect(guidance).toHaveValue(rejectedDraft);
  await expect(page.getByRole("alert").filter({
    hasText: "The application state changed; review the latest session state",
  })).toBeVisible();
  await expect(send).toBeEnabled();

  const ambiguousDraft = "Use the alternate public office location.";
  await guidance.fill(ambiguousDraft);
  await send.click();
  await expect.poll(() => mock.commands.length).toBe(3);
  expect(mock.commands[2]).toEqual({ type: "steer", message: ambiguousDraft });
  await expect(page.getByRole("button", { name: "Sending guidance…" })).toBeDisabled();
  await expect(cancel).toBeEnabled();
  ambiguousDelivery.resolve();
  await expect(guidance).toHaveValue(ambiguousDraft);
  await expect(page.getByRole("alert").filter({
    hasText: "Guidance delivery could not be confirmed",
  })).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(cancel).toBeEnabled();
  expect(mock.commands).toHaveLength(3);

  leaveRunning.resolve();
  await expect(form).toBeVisible();
  await expect(page.getByRole("heading", { name: "Navigation needed" })).toBeVisible();
  await expect(guidance).toHaveValue("");
  await expect(send).toBeEnabled();

  const gatedDraft = "Retry the public checkpoint with the verified address.";
  await guidance.fill(gatedDraft);
  await page.getByRole("button", { name: "Send guidance" }).click();
  await expect.poll(() => mock.commands.length).toBe(4);
  expect(mock.commands[3]).toEqual({ type: "steer", message: gatedDraft });

  returnToRunning.resolve();
  await expect(page.getByRole("form", { name: "Steer the agent" })).toBeVisible();
  await expect(guidance).toHaveValue("");
  await expect(send).toBeEnabled();

  await guidance.fill("Resume using only the verified public address.");
  await send.click();
  await expect.poll(() => mock.commands.length).toBe(5);
  expect(mock.commands[4]).toEqual({
    type: "steer",
    message: "Resume using only the verified public address.",
  });
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )).toBe(true);
});

test("cancelling during steering suppresses navigation continuation", async ({ page }) => {
  const waiting = snapshotFixture({
    bridgeState: "awaiting_human_navigation",
    updatedAt: createdAt + 100,
    pendingAction: {
      type: "human_navigation",
      instruction: "Complete the public checkpoint.",
    },
  });
  const steerReply = deferred();
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: waiting,
  });
  mock.commandReplies.push(
    { status: 202, waitFor: steerReply.promise },
    { status: 202 },
  );

  await page.goto(`/runs/${runId}`);
  await page.getByRole("textbox", { name: "Steer the agent" })
    .fill("Retry the checkpoint once.");
  await page.getByRole("button", { name: "Send guidance" }).click();
  await expect.poll(() => mock.commands.length).toBe(1);
  await expect(page.getByRole("button", { name: "Continue application" }))
    .toBeDisabled();

  await page.getByRole("button", { name: "Cancel application" }).click();
  await expect.poll(() => mock.commands.length).toBe(2);
  expect(mock.commands).toEqual([
    { type: "steer", message: "Retry the checkpoint once." },
    { type: "cancel" },
  ]);

  steerReply.resolve();
  await expect(page.getByRole("status").filter({
    hasText: "Guidance was queued, but the application state changed.",
  })).toBeVisible();
  await page.waitForTimeout(50);
  expect(mock.commands).toHaveLength(2);
});

test("ordinary navigation continues after ambiguous steering settles", async ({ page }) => {
  const waiting = snapshotFixture({
    bridgeState: "awaiting_human_navigation",
    updatedAt: createdAt + 100,
    pendingAction: {
      type: "human_navigation",
      instruction: "Complete the public checkpoint.",
    },
  });
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: waiting,
  });
  mock.commandReplies.push(
    {
      status: 503,
      body: apiError("APPLICATION_HARNESS_UNAVAILABLE", "private upstream detail"),
    },
    { status: 202 },
  );

  await page.goto(`/runs/${runId}`);
  await page.getByRole("textbox", { name: "Steer the agent" })
    .fill("Retry the checkpoint once.");
  await page.getByRole("button", { name: "Send guidance" }).click();
  await expect(page.getByRole("alert").filter({
    hasText: "Guidance delivery could not be confirmed",
  })).toBeVisible();

  const continueApplication = page.getByRole("button", {
    name: "Continue application",
  });
  await expect(continueApplication).toBeEnabled();
  await continueApplication.click();
  await expect.poll(() => mock.commands.length).toBe(2);
  expect(mock.commands).toEqual([
    { type: "steer", message: "Retry the checkpoint once." },
    { type: "continue" },
  ]);
});

test("retry current sends only fixed guidance at a navigation gate", async ({ page }) => {
  const waiting = snapshotFixture({
    bridgeState: "awaiting_human_navigation",
    updatedAt: createdAt + 100,
    pendingAction: {
      type: "human_navigation",
      instruction: "Complete the public checkpoint.",
    },
  });
  const mock = await installPipeline(page, {
    run: approvedRun(),
    iterations: approvedIterations(),
    application: waiting,
  });

  await page.goto(`/runs/${runId}`);
  const guidance = page.getByRole("textbox", { name: "Steer the agent" });
  await guidance.fill("Keep this draft for later.");
  const retryCurrent = page.getByRole("button", { name: "Retry current action" });
  await expect(retryCurrent).toHaveAttribute("title", "Retry current action");
  const retryBox = await retryCurrent.boundingBox();
  expect(retryBox).not.toBeNull();
  expect(Math.abs(retryBox!.width - retryBox!.height)).toBeLessThanOrEqual(1);
  await retryCurrent.click();

  await expect.poll(() => mock.commands.length).toBe(1);
  expect(mock.commands).toEqual([
    { type: "steer", message: "Retry the current action." },
  ]);
  await expect(guidance).toHaveValue("Keep this draft for later.");
  await expect(page.getByRole("status").filter({
    hasText: "Retry guidance queued for the next agent step.",
  })).toBeVisible();
});

test("390px workspace has no overflow, exposes keyboard review controls, and announces application state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = await installPipeline(page);
  await page.goto(`/runs/${runId}`);

  await expect(page.getByRole("complementary", { name: "Review and opportunity workspace" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const editInstructions = page.getByLabel("Edit instructions");
  const requestEdits = page.getByRole("button", { name: "Request edits" });
  await editInstructions.focus();
  await expect(editInstructions).toBeFocused();
  await editInstructions.press("Tab");
  await expect(requestEdits).toBeFocused();

  mock.run = approvedRun();
  mock.iterations = approvedIterations();
  mock.application = snapshotFixture({ bridgeState: "failed", updatedAt: createdAt + 200 });
  await page.reload();
  const liveState = page.getByRole("status").filter({ hasText: "Failed" });
  await expect(liveState).toBeVisible();
  await expect(liveState).toHaveAttribute("aria-live", "polite");
  await expect(liveState).toHaveAttribute("aria-atomic", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
