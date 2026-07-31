import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AnalysisAgentInput } from "../src/agents/analysis-agent.ts";
import type { AtsKeywordExtractionAgentInput } from "../src/agents/ats-keyword-extraction-agent.ts";
import type { EditAgentInput } from "../src/agents/edit-agent.ts";
import { buildMechanicalTailoringPlan, type TailoringAgentInput } from "../src/agents/tailoring-agent.ts";
import { ResumeDiffSchema } from "../src/contracts/index.ts";
import type { ContextSnapshot, EvidenceBlock, IndexedContextSource } from "../src/context/types.ts";
import { openPipelineDatabase } from "../src/db/database.ts";
import { ClaimRejectedError, PipelineRepository, type RunSourceSnapshotInput } from "../src/db/repository.ts";
import type { GeminiVisualInspection } from "../src/models/gemini-inspector.ts";
import type { CompileRequest, CompileResult } from "../src/resume/compiler.ts";
import {
  buildResumeDiff,
  parseBaselineResume,
  parseMacroCalls,
  renderTailoredResume,
  TailoringPlanSchema,
  type AtsKeywordExtraction,
  type EditResult,
  type DeterministicQaReport,
  type KeywordMapRequest,
  type JobAnalysis,
  type RepairResult,
  type TailoringPlan,
  type TailoringResult,
} from "../src/resume/index.ts";
import { PipelineStageProcessor, type PipelineStageDependencies } from "../src/stages/index.ts";
import { ARTIFACT_LIMITS, ArtifactStore } from "../src/system/artifacts.ts";
import { atsKeywordExtractionFixture, jobAnalysisFixture } from "./job-analysis.fixture.ts";

setDefaultTimeout(15_000);

const baseline = await Bun.file(resolve(import.meta.dir, "../../user-info/resume-main/Alex_Example_Resume.tex")).text();
const parsedBaseline = parseBaselineResume(baseline);
const databases: Database[] = [];
const roots: string[] = [];

afterEach(async () => {
  while (databases.length) databases.pop()?.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface ResumeFixtures {
  readonly snapshot: ContextSnapshot;
  readonly snapshotInput: RunSourceSnapshotInput;
  readonly atsKeywordExtraction: AtsKeywordExtraction;
  readonly analysis: JobAnalysis;
  readonly plan: TailoringPlan;
}

function resumeFixtures(jobDescription: string): ResumeFixtures {
  const sources: IndexedContextSource[] = [
    {
      id: "source-baseline",
      relativePath: "authoritative-baseline.tex",
      kind: "baseline",
      entityId: "candidate-resume",
      displayName: "Synthetic canonical resume",
      baselineEntityIds: [],
      sourceVersionId: "version-baseline",
      sha256: parsedBaseline.sha256,
      bytes: 10,
      indexedAt: 1,
    },
    {
      id: "source-automated-testing",
      relativePath: "authoritative-automated-testing.md",
      kind: "authoritative-markdown",
      entityId: "experience:example-company",
      displayName: "Synthetic automated testing context",
      baselineEntityIds: ["Example Company"],
      sourceVersionId: "version-automated-testing",
      sha256: "b".repeat(64),
      bytes: 10,
      indexedAt: 1,
    },
    {
      id: "source-reward-scheduler",
      relativePath: "authoritative-reward-scheduler.md",
      kind: "authoritative-markdown",
      entityId: "project:sample-project-archive",
      displayName: "Synthetic reward scheduler context",
      baselineEntityIds: ["Sample Project Archive"],
      sourceVersionId: "version-reward-scheduler",
      sha256: "c".repeat(64),
      bytes: 10,
      indexedAt: 1,
    },
    {
      id: "source-sample-project",
      relativePath: "authoritative-sample-project.md",
      kind: "authoritative-markdown",
      entityId: "project:sample-project",
      displayName: "Synthetic sampleProject verification context",
      baselineEntityIds: ["Sample Project", "SampleProject"],
      sourceVersionId: "version-sample-project",
      sha256: "d".repeat(64),
      bytes: 10,
      indexedAt: 1,
    },
  ];
  const sourceIndexByEntity: Readonly<Record<string, number>> = {
    "Example Company": 1,
    "Sample Project Archive": 2,
    "Sample Project": 3,
    SampleProject: 3,
  };
  const evidence: EvidenceBlock[] = parsedBaseline.entities.map((entity, index) => {
    const source = sources[sourceIndexByEntity[entity.entityId] ?? 0]!;
    return {
      id: `evidence-${index}`,
      sourceVersionId: source.sourceVersionId,
      sourceId: source.id,
      entityId: entity.entityId === "Sample Project" ? "SampleProject" : entity.entityId,
      ordinal: 0,
      headingPath: [entity.entityId],
      text: `${entity.bullets.map((item) => item.text).join(" ")} supported fact`,
      caveats: ["Keep source caveat"],
      sha256: source.sha256,
    };
  });
  const snapshot: ContextSnapshot = {
    manifestSha256: "a".repeat(64),
    baselineSha256: parsedBaseline.sha256,
    sourceHashes: Object.fromEntries(sources.map((source) => [source.id, source.sha256])),
    sources,
    evidence,
    mustIncludeDirectives: [],
    explicitEntityBindings: { "Sample Project": "SampleProject" },
  };
  const atsKeywordExtraction = atsKeywordExtractionFixture({ rawJobDescription: jobDescription });
  const analysis = jobAnalysisFixture({
    jobDescriptionSha256: createHash("sha256").update(jobDescription).digest("hex"),
    evidenceId: "evidence-0",
    baselineSource: baseline,
    jdQuote: jobDescription,
  });
  const plan = buildMechanicalTailoringPlan(analysis, baseline);
  return {
    snapshot,
    snapshotInput: {
      manifestSha256: snapshot.manifestSha256,
      baselineSha256: snapshot.baselineSha256,
      sourceHashes: snapshot.sourceHashes,
    },
    atsKeywordExtraction,
    analysis,
    plan,
  };
}

const ACTIVE_DIRECTIVE_EVIDENCE_ID = "active-directive";

function resumeFixturesWithActiveDirective(jobDescription: string): ResumeFixtures {
  const fixtures = resumeFixtures(jobDescription);
  const bulletEdit = fixtures.analysis.exactEdits.find((edit) => edit.kind === "bullet")!;
  const existingSource = fixtures.snapshot.sources.find((source) =>
    source.id === "source-automated-testing")!;
  const source: IndexedContextSource = {
    ...existingSource,
    baselineEntityIds: [...existingSource.baselineEntityIds, bulletEdit.entityId],
  };
  const factualEvidence: EvidenceBlock = {
    ...fixtures.snapshot.evidence[0]!,
    sourceVersionId: source.sourceVersionId,
    sourceId: source.id,
    entityId: source.entityId,
    sha256: source.sha256,
  };
  const directiveEvidence: EvidenceBlock = {
    ...factualEvidence,
    id: ACTIVE_DIRECTIVE_EVIDENCE_ID,
    ordinal: factualEvidence.ordinal + 1,
    text: "The resume must include the candidate's supported testing impact.",
  };
  const snapshot: ContextSnapshot = {
    ...fixtures.snapshot,
    sources: fixtures.snapshot.sources.map((candidate) =>
      candidate.id === source.id ? source : candidate),
    evidence: [
      factualEvidence,
      ...fixtures.snapshot.evidence.slice(1),
      directiveEvidence,
    ],
    mustIncludeDirectives: [{
      evidenceId: directiveEvidence.id,
      sourceId: directiveEvidence.sourceId,
      entityId: directiveEvidence.entityId,
      text: directiveEvidence.text,
    }],
  };
  const analysis: JobAnalysis = {
    ...fixtures.analysis,
    exactEdits: fixtures.analysis.exactEdits.map((edit) => edit.kind === "bullet"
      ? { ...edit, evidenceIds: [...edit.evidenceIds, directiveEvidence.id] }
      : edit),
  };
  return {
    ...fixtures,
    snapshot,
    snapshotInput: {
      manifestSha256: snapshot.manifestSha256,
      baselineSha256: snapshot.baselineSha256,
      sourceHashes: snapshot.sourceHashes,
    },
    analysis,
    plan: buildMechanicalTailoringPlan(
      analysis,
      baseline,
      undefined,
      [directiveEvidence.id],
    ),
  };
}

function dropAnalyzedRewrite(plan: TailoringPlan): TailoringPlan {
  const rewrite = plan.decisions.find((decision) => decision.action === "rewrite")!;
  const originalBullet = parsedBaseline.bullets.find((bullet) =>
    bullet.id === rewrite.baselineItemId)!;
  return TailoringPlanSchema.parse({
    ...plan,
    decisions: plan.decisions.map((decision) =>
      decision.id === rewrite.id
        ? {
            ...decision,
            action: "retain",
            text: originalBullet.text,
            evidenceIds: [],
            factKeys: [],
            rationale: "Drop all analyzed support.",
          }
        : decision),
    baselineOverrides: plan.baselineOverrides.filter((override) =>
      override.baselineItemId !== rewrite.baselineItemId),
  });
}

interface HarnessOptions {
  readonly fixtures?: ResumeFixtures;
  readonly compileOutcomes?: readonly ("success" | "repairable" | "terminal")[];
  readonly deterministicPass?: boolean;
  readonly deterministicReports?: readonly DeterministicQaReport[];
  readonly visual?: GeminiVisualInspection;
  readonly deterministicQa?: PipelineStageDependencies["deterministicQa"];
  readonly loadSourceContext?: PipelineStageDependencies["loadSourceContext"];
  readonly atsKeywordExtractionAgent?: PipelineStageDependencies["atsKeywordExtractionAgent"];
  readonly analysisAgent?: PipelineStageDependencies["analysisAgent"];
  readonly tailoringAgent?: PipelineStageDependencies["tailoringAgent"];
  readonly editAgent?: PipelineStageDependencies["editAgent"];
  readonly repairAgent?: PipelineStageDependencies["repairAgent"];
  readonly generateKeywordMap?: boolean;
  readonly keywordMapRenderer?: PipelineStageDependencies["keywordMapRenderer"];
}

interface AgentInputs {
  readonly atsKeywordExtraction: AtsKeywordExtractionAgentInput[];
  readonly analysis: AnalysisAgentInput[];
  readonly tailoring: TailoringAgentInput[];
  readonly editing: EditAgentInput[];
}

interface Harness {
  readonly repository: PipelineRepository;
  readonly artifacts: ArtifactStore;
  readonly processor: PipelineStageProcessor;
  readonly fixtures: ResumeFixtures;
  readonly runId: string;
  readonly compileModes: string[];
  readonly agentOrder: string[];
  readonly agentInputs: AgentInputs;
  readonly tailoringResults: TailoringResult[];
  readonly keywordMapCalls: { count: number; requests: KeywordMapRequest[] };
  readonly database: Database;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const jobDescription = "Strong TypeScript engineer";
  const fixtures = options.fixtures ?? resumeFixtures(jobDescription);
  const database = openPipelineDatabase(":memory:");
  databases.push(database);
  let now = 0;
  let id = 0;
  let token = 0;
  const repository = new PipelineRepository(database, {
    now: () => ++now,
    idFactory: () => `stage-id-${++id}`,
    attemptSessionIdFactory: () => `session-${id}`,
    tokenFactory: () => Buffer.alloc(32, ++token).toString("base64url"),
  });
  const root = await mkdtemp(join(tmpdir(), "pipeline-stages-"));
  roots.push(root);
  const artifacts = new ArtifactStore(root);
  const queueSequence = repository.nextQueueSequence();
  const inputRoot = await artifacts.createRunInput({ run: queueSequence });
  const input = await artifacts.write(join(inputRoot, "job-description.txt"), jobDescription, 1024 * 1024);
  const run = repository.createQueuedRun(jobDescription, "https://jobs.example.test/stage-run", fixtures.snapshotInput, {
    sha256: input.sha256,
    path: input.path,
    byteSize: input.bytes,
  }, "stage-run", options.generateKeywordMap ?? false, queueSequence);
  const compileOutcomes = [...(options.compileOutcomes ?? ["success"])] ;
  const compileModes: string[] = [];
  const keywordMapCalls: { count: number; requests: KeywordMapRequest[] } = {
    count: 0,
    requests: [],
  };
  const deterministicReports = [...(options.deterministicReports ?? [])];
  const compiler = async (request: CompileRequest): Promise<CompileResult> => {
    request.signal?.throwIfAborted();
    compileModes.push(request.mode);
    const outcome = compileOutcomes.shift() ?? "success";
    const attemptRoot = await request.artifacts.createAttempt(request.address);
    const tex = await request.artifacts.write(join(attemptRoot, "main.tex"), request.tex, ARTIFACT_LIMITS.tex);
    const log = await request.artifacts.write(join(attemptRoot, "compile.log"), outcome === "success" ? "compile ok" : `${outcome} compile failure`, ARTIFACT_LIMITS.log);
    if (outcome !== "success") return {
      ok: false,
      attemptRoot,
      tex,
      log,
      classification: outcome,
      reason: `${outcome} compile failure`,
    };
    const pdf = await request.artifacts.write(join(attemptRoot, "resume.pdf"), "%PDF-1.7\nresume", ARTIFACT_LIMITS.pdf);
    return {
      ok: true,
      attemptRoot,
      tex,
      log,
      pdf,
      process: {
        command: "latexmk",
        args: [],
        pid: 101,
        processStartToken: "start",
        code: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        killAcknowledged: false,
        stdout: { data: new Uint8Array(), bytes: 0, truncated: false },
        stderr: { data: new Uint8Array(), bytes: 0, truncated: false },
      },
    };
  };
  const agentInputs: AgentInputs = {
    atsKeywordExtraction: [],
    analysis: [],
    tailoring: [],
    editing: [],
  };
  const agentOrder: string[] = [];
  const tailoringResults: TailoringResult[] = [];
  const dependencies: PipelineStageDependencies = {
    repository,
    artifacts,
    loadSourceContext: options.loadSourceContext ?? (() => ({ snapshot: fixtures.snapshot, baseline })),
    atsKeywordExtractionAgent: options.atsKeywordExtractionAgent ?? (async (attempt) => {
      agentOrder.push("ats-keyword-extraction");
      agentInputs.atsKeywordExtraction.push(attempt.input);
      return fixtures.atsKeywordExtraction;
    }),
    analysisAgent: options.analysisAgent ?? (async (attempt) => {
      agentOrder.push("analysis");
      agentInputs.analysis.push(attempt.input);
      return fixtures.analysis;
    }),
    tailoringAgent: options.tailoringAgent ?? (async (attempt) => {
      agentInputs.tailoring.push(attempt.input);
      const result: TailoringResult = {
        plan: buildMechanicalTailoringPlan(
          fixtures.analysis,
          baseline,
          attempt.input.onePageCorrection,
          attempt.input.mustIncludeEvidenceIds,
        ),
        toolCount: 4,
      };
      tailoringResults.push(result);
      return result;
    }),
    editAgent: options.editAgent ?? (async (attempt) => {
      agentInputs.editing.push(attempt.input);
      const result: EditResult = {
        plan: fixtures.plan,
        commentDispositions: attempt.input.comments?.map((_, commentIndex) => ({
          commentIndex,
          status: "applied",
          rationale: "Applied using existing evidence",
          evidenceIds: ["evidence-0"],
        })) ?? [],
      };
      return result;
    }),
    ...(options.repairAgent === undefined ? {} : { repairAgent: options.repairAgent }),
    compiler,
    keywordMapRenderer: options.keywordMapRenderer ?? (async (request) => {
      keywordMapCalls.count += 1;
      keywordMapCalls.requests.push(request);
      return await request.artifacts.write(
        join(dirname(request.compiledPdf.path), "keyword-map.pdf"),
        "%PDF-1.7\nkeyword-map",
        ARTIFACT_LIMITS.pdf,
      );
    }),
    deterministicQa: options.deterministicQa ?? (async () => deterministicReports.shift()
      ?? (options.deterministicPass === false
        ? { pass: false, checks: [], warnings: [] }
        : ONE_PAGE_QA)),
    rasterizer: async (request) => {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
      const artifact = await artifacts.write(request.outputPath, png, ARTIFACT_LIMITS.png);
      return { mediaType: "image/png", page: 1, dpi: 200, byteSize: artifact.bytes, path: artifact.path };
    },
    visualInspector: async () => options.visual ?? { status: "pass", summary: "Page is readable", findings: [] },
  };
  const processor = new PipelineStageProcessor(dependencies);
  return {
    repository,
    artifacts,
    processor,
    fixtures,
    runId: run.id,
    compileModes,
    agentInputs,
    agentOrder,
    tailoringResults,
    keywordMapCalls,
    database,
  };
}

async function processToStop(harness: Harness): Promise<void> {
  const claim = harness.repository.acquire();
  if (!claim) throw new Error("claim missing");
  await harness.processor.processClaim(claim, new AbortController().signal);
  harness.repository.release(claim);
}
async function reportUnexpectedFailure(harness: Harness): Promise<void> {
  const run = harness.repository.getRun(harness.runId);
  if (run?.status !== "failed") return;
  const diagnostic = harness.repository.getArtifact(harness.runId, "stage-error", run.currentRevision);
  const text = diagnostic
    ? Buffer.from(await harness.artifacts.read(diagnostic.path, ARTIFACT_LIMITS.log)).toString("utf8")
    : "(no persisted stage-error artifact)";
  throw new Error(`Unexpected pipeline failure at ${run.failedStage ?? "unknown stage"}:\n${text}`);
}


const MULTI_PAGE_QA: DeterministicQaReport = {
  pass: false,
  checks: [{ id: "one-page", status: "fail", detail: "PDF does not have exactly one page" }],
  warnings: [],
};

const ONE_PAGE_QA: DeterministicQaReport = {
  pass: true,
  checks: [{ id: "one-page", status: "pass", detail: "PDF has exactly one page" }],
  warnings: [],
};

describe.skipIf(process.platform !== "linux")("pipeline stage processor cases requiring Linux /proc process identity", () => {
  test("runs the initial public state sequence, QA, and immutable artifact finalization", async () => {
    const harness = await createHarness();
    await processToStop(harness);

    expect(harness.repository.getRun(harness.runId)?.status).toBe("review");
    const transitions = harness.repository.timeline(harness.runId).events
      .filter((event) => event.kind === "run.transitioned")
      .map((event) => event.payload);
    expect(transitions).toEqual([
      { from: "queued", to: "analyzing", failedStage: null },
      { from: "analyzing", to: "tailoring", failedStage: null },
      { from: "tailoring", to: "compiling", failedStage: null },
      { from: "compiling", to: "deterministic_qa", failedStage: null },
      { from: "deterministic_qa", to: "visual_qa", failedStage: null },
      { from: "visual_qa", to: "review", failedStage: null },
    ]);
    expect(harness.agentOrder).toEqual(["ats-keyword-extraction", "analysis"]);
    expect(harness.agentInputs.atsKeywordExtraction).toEqual([{
      rawJobDescription: "Strong TypeScript engineer",
    }]);
    expect(harness.agentInputs.analysis).toHaveLength(1);
    expect(harness.agentInputs.analysis[0]?.canonicalCv).toBe(baseline);
    expect(harness.agentInputs.analysis[0]?.context).toEqual(harness.fixtures.snapshot);
    expect(harness.agentInputs.analysis[0]?.atsKeywordExtraction)
      .toBe(harness.fixtures.atsKeywordExtraction);
    expect(harness.agentInputs.tailoring).toHaveLength(1);
    expect(Object.keys(harness.agentInputs.tailoring[0]!)).not.toContain("rawJobDescription");
    expect(Object.keys(harness.agentInputs.tailoring[0]!)).not.toContain("context");
    expect(harness.agentInputs.tailoring[0]?.analysis).toEqual(harness.fixtures.analysis);
    const [result] = harness.tailoringResults;
    expect(result).toBeDefined();
    const texArtifact = harness.repository.getArtifact(harness.runId, "tailored-tex");
    expect(texArtifact).not.toBeNull();
    expect(await Bun.file(texArtifact!.path).text()).toBe(
      renderTailoredResume(result!.plan, baseline, harness.fixtures.snapshot),
    );
    const diffArtifact = harness.repository.getArtifact(harness.runId, "resume-diff");
    expect(diffArtifact).not.toBeNull();
    expect(ResumeDiffSchema.parse(JSON.parse(await Bun.file(diffArtifact!.path).text()))).toEqual(
      buildResumeDiff(baseline, result!.plan),
    );
    expect(harness.repository.listResolvedArtifacts(harness.runId).map((artifact) => artifact.kind)).toEqual(expect.arrayContaining([
      "job-description", "ats-keyword-extraction", "job-analysis", "tailoring-plan", "change-summary", "resume-diff", "evidence-ledger", "tailored-tex",
      "latex-log", "compiled-pdf", "deterministic-qa", "page-image", "visual-qa",
    ]));
    const timeline = harness.repository.timeline(harness.runId);
    expect(timeline.attempts.map((attempt) => attempt.stage)).toEqual(["analyzing", "tailoring", "compiling", "deterministic_qa", "visual_qa"]);
    expect(timeline.attempts.find((attempt) => attempt.stage === "analyzing")?.toolCount).toBe(2);
    expect(timeline.attempts.find((attempt) => attempt.stage === "compiling")?.compileCount).toBe(1);
    const jobDescriptionArtifact = harness.repository.getArtifact(harness.runId, "job-description");
    const extractionArtifact = harness.repository.getArtifact(harness.runId, "ats-keyword-extraction");
    const analysisArtifact = harness.repository.getArtifact(harness.runId, "job-analysis");
    const sourceArtifactId = (artifactId: string): string | null | undefined =>
      harness.database.query<{ source_artifact_id: string | null }, [string]>(
        "SELECT source_artifact_id FROM artifacts WHERE id=?",
      ).get(artifactId)?.source_artifact_id;
    expect(sourceArtifactId(extractionArtifact!.id)).toBe(jobDescriptionArtifact!.id);
    expect(sourceArtifactId(analysisArtifact!.id)).toBe(extractionArtifact!.id);
    expect(JSON.stringify({ run: harness.repository.getRun(harness.runId), timeline })).not.toContain("token");
    expect(JSON.stringify(harness.repository.listResolvedArtifacts(harness.runId))).not.toContain("Strong TypeScript engineer");
    expect(harness.keywordMapCalls.count).toBe(0);
    expect(harness.repository.getArtifact(harness.runId, "keyword-map-pdf")).toBeNull();
  });

  test("rejects missing active directives before analysis artifacts finalize", async () => {
    const activeFixtures = resumeFixturesWithActiveDirective("Strong TypeScript engineer");
    const unsupported = resumeFixtures("Strong TypeScript engineer");
    const harness = await createHarness({
      fixtures: {
        ...activeFixtures,
        analysis: unsupported.analysis,
        plan: unsupported.plan,
      },
    });

    await processToStop(harness);

    expect(harness.repository.getRun(harness.runId)).toMatchObject({
      status: "failed",
      failedStage: "analyzing",
    });
    expect(harness.repository.getArtifact(harness.runId, "ats-keyword-extraction")).toBeNull();
    expect(harness.repository.getArtifact(harness.runId, "job-analysis")).toBeNull();
  });

  test("rejects an initial plan that drops all support for an analysis-active directive", async () => {
    const fixtures = resumeFixturesWithActiveDirective("Strong TypeScript engineer");
    const dropped = dropAnalyzedRewrite(fixtures.plan);
    const harness = await createHarness({
      fixtures,
      tailoringAgent: async () => ({ plan: dropped, toolCount: 4 }),
    });

    await processToStop(harness);

    expect(harness.repository.getRun(harness.runId)).toMatchObject({
      status: "failed",
      failedStage: "tailoring",
    });
    expect(harness.repository.getArtifact(harness.runId, "tailoring-plan")).toBeNull();
    expect(harness.repository.getArtifact(harness.runId, "evidence-ledger")).toBeNull();
    expect(harness.repository.getArtifact(harness.runId, "tailored-tex")).toBeNull();
  });

  test("persists canonical TeX rendered from an injected reduced tailoring result", async () => {
    const fixture = resumeFixtures("Strong TypeScript engineer");
    const result: TailoringResult = { plan: fixture.plan, toolCount: 4 };
    const harness = await createHarness({
      tailoringAgent: async () => result,
    });

    await processToStop(harness);

    expect(harness.repository.getRun(harness.runId)?.status).toBe("review");
    const artifact = harness.repository.getArtifact(harness.runId, "tailored-tex");
    expect(artifact).not.toBeNull();
    expect(await Bun.file(artifact!.path).text()).toBe(
      renderTailoredResume(result.plan, baseline, fixture.snapshot),
    );
  });

  test("generates and finalizes the requested keyword map only after deterministic QA passes", async () => {
    const harness = await createHarness({ generateKeywordMap: true });
    await processToStop(harness);

    expect(harness.keywordMapCalls.count).toBe(1);
    expect(harness.keywordMapCalls.requests[0]?.atsKeywordExtraction)
      .toEqual(harness.fixtures.atsKeywordExtraction);
    expect(harness.keywordMapCalls.requests[0]?.analysis).toEqual(harness.fixtures.analysis);
    expect(harness.repository.getRun(harness.runId)?.status).toBe("review");
    const compiled = harness.repository.getArtifact(harness.runId, "compiled-pdf");
    const keywordMap = harness.repository.getArtifact(harness.runId, "keyword-map-pdf");
    expect(compiled).not.toBeNull();
    expect(keywordMap).not.toBeNull();
    expect(keywordMap?.revision).toBe(compiled?.revision);
    expect(harness.database.query<{ source_artifact_id: string | null }, [string]>(
      "SELECT source_artifact_id FROM artifacts WHERE id=?",
    ).get(keywordMap!.id)?.source_artifact_id).toBe(compiled!.id);
    expect(harness.repository.timeline(harness.runId).events
      .filter((event) => event.kind === "artifact.finalized")
      .map((event) => event.payload && typeof event.payload === "object" && "kind" in event.payload
        && typeof event.payload.kind === "string" ? event.payload.kind : undefined)).toEqual(expect.arrayContaining([
      "compiled-pdf",
      "keyword-map-pdf",
      "deterministic-qa",
    ]));
  });

  test("routes multi-page PDFs back to same-revision tailoring with or without a keyword map request", async () => {
    for (const generateKeywordMap of [false, true]) {
      const harness = await createHarness({
        generateKeywordMap,
        deterministicReports: [MULTI_PAGE_QA, ONE_PAGE_QA],
      });
      await processToStop(harness);
      await reportUnexpectedFailure(harness);

      expect(harness.repository.getRun(harness.runId)).toMatchObject({
        status: "review",
        currentRevision: 1,
        failedStage: null,
      });
      expect(harness.agentInputs.tailoring).toHaveLength(2);
      expect(harness.agentInputs.tailoring[0]?.onePageCorrection).toBeUndefined();
      expect(harness.agentInputs.tailoring[1]?.onePageCorrection).toMatchObject({
        note: "The compiled resume MUST be exactly one page. Cut lower-priority content as needed while preserving truthfulness and readability.",
        failureCount: 1,
        requiredOmissionCount: 1,
      });
      expect(harness.tailoringResults[1]?.plan.omissions).toHaveLength(1);
      const timeline = harness.repository.timeline(harness.runId);
      const deterministicAttempts = timeline.attempts
        .filter((attempt) => attempt.stage === "deterministic_qa");
      const compilingAttempts = timeline.attempts
        .filter((attempt) => attempt.stage === "compiling");
      const correction = harness.repository.getArtifact(harness.runId, "one-page-correction");
      const deterministicReport = harness.repository.getArtifact(harness.runId, "deterministic-qa");
      const compiled = harness.repository.getArtifact(harness.runId, "compiled-pdf");
      const compiledTex = harness.repository.getArtifact(harness.runId, "tailored-tex");
      const tailoringPlan = harness.repository.getArtifact(harness.runId, "tailoring-plan");
      const sourceArtifactId = (artifactId: string): string | null | undefined =>
        harness.database.query<{ source_artifact_id: string | null }, [string]>(
          "SELECT source_artifact_id FROM artifacts WHERE id=?",
        ).get(artifactId)?.source_artifact_id;
      const firstAttemptArtifacts = harness.database.query<{
        id: string;
        kind: string;
        path: string;
        source_artifact_id: string | null;
        source_attempt_id: string | null;
      }, [string]>(`
        SELECT artifact.id,
               artifact.kind,
               artifact.path,
               artifact.source_artifact_id,
               source.attempt_id AS source_attempt_id
        FROM artifacts AS artifact
        LEFT JOIN artifacts AS source ON source.id = artifact.source_artifact_id
        WHERE artifact.attempt_id = ?
          AND artifact.kind IN ('deterministic-qa', 'one-page-correction')
        ORDER BY artifact.kind
      `).all(deterministicAttempts[0]!.id);
      const firstDeterministicReport = firstAttemptArtifacts
        .find((artifact) => artifact.kind === "deterministic-qa");
      const firstCorrection = firstAttemptArtifacts
        .find((artifact) => artifact.kind === "one-page-correction");
      expect(firstAttemptArtifacts.map((artifact) => artifact.kind)).toEqual([
        "deterministic-qa",
        "one-page-correction",
      ]);
      expect(dirname(firstDeterministicReport!.path)).toBe(dirname(firstCorrection!.path));
      expect(firstCorrection?.source_artifact_id).toBe(firstDeterministicReport?.id);
      expect(firstDeterministicReport?.source_attempt_id).toBe(compilingAttempts[0]?.id);
      expect(harness.repository.getArtifact(harness.runId, "stage-error")).toBeNull();
      expect(correction?.attemptId).toBe(deterministicAttempts[0]?.id);
      expect(deterministicReport?.attemptId).toBe(deterministicAttempts[1]?.id);
      expect(compiled?.attemptId).toBe(compilingAttempts[1]?.id);
      expect(compiledTex?.attemptId).toBe(compilingAttempts[1]?.id);
      expect(sourceArtifactId(deterministicReport!.id)).toBe(compiled?.id);
      expect(sourceArtifactId(compiled!.id)).toBe(compiledTex?.id);
      expect(sourceArtifactId(tailoringPlan!.id)).toBe(correction?.id);
      expect(deterministicAttempts
        .map((attempt) => ({ revision: attempt.revision, status: attempt.status }))).toEqual([
        { revision: 1, status: "failed" },
        { revision: 1, status: "succeeded" },
      ]);
      expect(timeline.events
        .filter((event) => event.kind === "run.transitioned")
        .map((event) => event.payload)).toEqual(expect.arrayContaining([
        { from: "deterministic_qa", to: "tailoring", failedStage: null },
        { from: "deterministic_qa", to: "visual_qa", failedStage: null },
      ]));
      expect(harness.keywordMapCalls.count).toBe(generateKeywordMap ? 1 : 0);
      expect(harness.repository.getArtifact(harness.runId, "keyword-map-pdf") !== null)
        .toBe(generateKeywordMap);
    }
  });

  test("excludes must-include directive evidence from one-page correction candidates", async () => {
    const baseFixture = resumeFixtures("Strong TypeScript engineer");
    const competition = parsedBaseline.entities.find((entity) =>
      entity.section === "competitions-other")!;
    const replacedEvidence = baseFixture.snapshot.evidence.find((evidence) =>
      evidence.entityId === competition.entityId)!;
    const existingSource = baseFixture.snapshot.sources.find((candidate) =>
      candidate.id === "source-reward-scheduler")!;
    const source: IndexedContextSource = {
      ...existingSource,
      baselineEntityIds: [...existingSource.baselineEntityIds, competition.entityId],
    };
    const factualEvidence: EvidenceBlock = {
      id: "competition-fact",
      sourceVersionId: source.sourceVersionId,
      sourceId: source.id,
      entityId: source.entityId,
      ordinal: 1,
      headingPath: [competition.entityId],
      text: competition.bullets[0]!.text,
      caveats: [],
      sha256: source.sha256,
    };
    const directiveEvidence: EvidenceBlock = {
      ...factualEvidence,
      id: "competition-directive",
      ordinal: 0,
      text: "The resume must include the competition result when supported.",
    };
    const sources = baseFixture.snapshot.sources.map((candidate) =>
      candidate.id === source.id ? source : candidate);
    const snapshot: ContextSnapshot = {
      ...baseFixture.snapshot,
      sources,
      sourceHashes: Object.fromEntries(sources.map((item) => [item.id, item.sha256])),
      evidence: [
        directiveEvidence,
        factualEvidence,
        ...baseFixture.snapshot.evidence.filter((evidence) => evidence.id !== replacedEvidence.id),
      ],
      mustIncludeDirectives: [{
        evidenceId: directiveEvidence.id,
        sourceId: directiveEvidence.sourceId,
        entityId: directiveEvidence.entityId,
        text: directiveEvidence.text,
      }],
    };
    const fixtures: ResumeFixtures = {
      ...baseFixture,
      snapshot,
      snapshotInput: {
        manifestSha256: snapshot.manifestSha256,
        baselineSha256: snapshot.baselineSha256,
        sourceHashes: snapshot.sourceHashes,
      },
    };
    const harness = await createHarness({
      fixtures,
      deterministicReports: [MULTI_PAGE_QA, ONE_PAGE_QA],
    });

    await processToStop(harness);

    const correction = harness.agentInputs.tailoring[1]?.onePageCorrection;
    expect(correction?.candidates.flatMap((candidate) => candidate.evidenceIds))
      .not.toContain(directiveEvidence.id);
    expect(correction?.candidates.flatMap((candidate) => candidate.evidenceIds))
      .toContain(factualEvidence.id);
    await reportUnexpectedFailure(harness);
    expect(harness.repository.getRun(harness.runId)?.status).toBe("review");
  });

  test("repeats progressively stronger one-page corrections until deterministic QA passes", async () => {
    const harness = await createHarness({
      generateKeywordMap: true,
      deterministicReports: [MULTI_PAGE_QA, MULTI_PAGE_QA, ONE_PAGE_QA],
    });
    await processToStop(harness);
    await reportUnexpectedFailure(harness);

    expect(harness.repository.getRun(harness.runId)?.status).toBe("review");
    expect(harness.agentInputs.tailoring.map((input) =>
      input.onePageCorrection?.failureCount ?? 0)).toEqual([0, 1, 2]);
    expect(harness.agentInputs.tailoring.map((input) =>
      input.onePageCorrection?.requiredOmissionCount ?? 0)).toEqual([0, 1, 2]);
    expect(harness.tailoringResults.map((result) => result.plan.omissions.length)).toEqual([0, 1, 2]);
    const timeline = harness.repository.timeline(harness.runId);
    const deterministicAttempts = timeline.attempts
      .filter((attempt) => attempt.stage === "deterministic_qa");
    const compilingAttempts = timeline.attempts
      .filter((attempt) => attempt.stage === "compiling");
    expect(deterministicAttempts.map((attempt) => attempt.status)).toEqual(["failed", "failed", "succeeded"]);
    const correction = harness.repository.getArtifact(harness.runId, "one-page-correction");
    expect(correction?.attemptId).toBe(deterministicAttempts[1]?.id);
    expect(await Bun.file(correction!.path).json()).toMatchObject({ failureCount: 2 });
    expect(harness.repository.getArtifact(harness.runId, "deterministic-qa")?.attemptId)
      .toBe(deterministicAttempts[2]?.id);
    expect(harness.repository.getArtifact(harness.runId, "compiled-pdf")?.attemptId)
      .toBe(compilingAttempts[2]?.id);
    expect(harness.keywordMapCalls.count).toBe(1);
    expect(harness.repository.getArtifact(harness.runId, "keyword-map-pdf")).not.toBeNull();
  });

  test("fails deterministic QA when an eligible requested keyword map cannot be generated", async () => {
    const harness = await createHarness({
      generateKeywordMap: true,
      keywordMapRenderer: async () => {
        throw new Error("bbox extraction failed");
      },
    });
    await processToStop(harness);

    expect(harness.repository.getRun(harness.runId)).toMatchObject({ status: "failed", failedStage: "deterministic_qa" });
    expect(harness.repository.getArtifact(harness.runId, "compiled-pdf")).not.toBeNull();
    expect(harness.repository.getArtifact(harness.runId, "keyword-map-pdf")).toBeNull();
    expect(harness.repository.timeline(harness.runId).attempts.find((attempt) => attempt.stage === "deterministic_qa")).toMatchObject({
      status: "failed",
    });
  });

  test("fails keyword-map QA instead of falling back from an invalid extraction artifact", async () => {
    const harness = await createHarness({
      generateKeywordMap: true,
      deterministicQa: async () => {
        const extractionArtifact = harness.repository.getArtifact(
          harness.runId,
          "ats-keyword-extraction",
        );
        if (!extractionArtifact) throw new Error("test extraction artifact is missing");
        await Bun.write(extractionArtifact.path, JSON.stringify({
          ...harness.fixtures.atsKeywordExtraction,
          jobDescriptionSha256: "f".repeat(64),
        }));
        return ONE_PAGE_QA;
      },
    });

    await processToStop(harness);

    expect(harness.repository.getRun(harness.runId)).toMatchObject({
      status: "failed",
      failedStage: "deterministic_qa",
    });
    expect(harness.keywordMapCalls.count).toBe(0);
    expect(harness.repository.getArtifact(harness.runId, "keyword-map-pdf")).toBeNull();
  });

  test("finalizes neither analyzing product when ATS extraction fails", async () => {
    let analysisCalls = 0;
    const harness = await createHarness({
      atsKeywordExtractionAgent: async () => {
        throw new Error("transient ATS extraction failure");
      },
      analysisAgent: async () => {
        analysisCalls += 1;
        return harness.fixtures.analysis;
      },
    });

    await processToStop(harness);

    expect(harness.repository.getRun(harness.runId)).toMatchObject({
      status: "failed",
      failedStage: "analyzing",
    });
    expect(analysisCalls).toBe(0);
    expect(harness.repository.getArtifact(harness.runId, "ats-keyword-extraction")).toBeNull();
    expect(harness.repository.getArtifact(harness.runId, "job-analysis")).toBeNull();
  });

  test("retries a failed analysis before its immutable artifact exists", async () => {
    let analysisCalls = 0;
    const harness = await createHarness({
      analysisAgent: async () => {
        analysisCalls += 1;
        if (analysisCalls === 1) throw new Error("transient analysis failure");
        return harness.fixtures.analysis;
      },
    });
    await processToStop(harness);
    expect(harness.repository.getRun(harness.runId)).toMatchObject({ status: "failed", failedStage: "analyzing" });
    expect(harness.repository.getArtifact(harness.runId, "job-analysis")).toBeNull();
    expect(harness.repository.getArtifact(harness.runId, "ats-keyword-extraction")).toBeNull();
    expect(harness.agentInputs.atsKeywordExtraction).toHaveLength(1);
    const diagnostic = harness.repository.getArtifact(harness.runId, "stage-error");
    expect(diagnostic).not.toBeNull();
    expect(Buffer.from(await harness.artifacts.read(diagnostic!.path, ARTIFACT_LIMITS.log)).toString("utf8"))
      .toBe("Error: transient analysis failure\n");

    harness.repository.retry(harness.runId, harness.fixtures.snapshotInput);
    await processToStop(harness);

    expect(analysisCalls).toBe(2);
    expect(harness.agentInputs.atsKeywordExtraction).toHaveLength(2);
    expect(harness.repository.getRun(harness.runId)?.status).toBe("review");
    expect(harness.repository.getArtifact(harness.runId, "ats-keyword-extraction")?.revision).toBe(2);
    expect(harness.repository.getArtifact(harness.runId, "job-analysis")?.revision).toBe(2);
  });

  test("inherits analyzing artifacts on later-stage retry without rerunning either agent", async () => {
    const deterministicFailure: DeterministicQaReport = {
      pass: false,
      checks: [{ id: "text-output", status: "fail", detail: "Synthetic deterministic failure" }],
      warnings: [],
    };
    const harness = await createHarness({
      deterministicReports: [deterministicFailure, ONE_PAGE_QA],
    });
    await processToStop(harness);
    expect(harness.repository.getRun(harness.runId)).toMatchObject({
      status: "failed",
      failedStage: "deterministic_qa",
    });
    expect(harness.agentInputs.atsKeywordExtraction).toHaveLength(1);
    expect(harness.agentInputs.analysis).toHaveLength(1);

    harness.repository.retry(harness.runId, harness.fixtures.snapshotInput);
    await processToStop(harness);

    expect(harness.repository.getRun(harness.runId)).toMatchObject({
      status: "review",
      currentRevision: 2,
    });
    expect(harness.agentInputs.atsKeywordExtraction).toHaveLength(1);
    expect(harness.agentInputs.analysis).toHaveLength(1);
    expect(harness.repository.getArtifact(harness.runId, "ats-keyword-extraction")?.revision).toBe(1);
    expect(harness.repository.getArtifact(harness.runId, "job-analysis")?.revision).toBe(1);
  });

  test("allows at most bounded repair candidate compiles and requires a fresh authoritative full compile", async () => {
    let repairInput: { failedTex: string; latexLog: string } | undefined;
    const harness = await createHarness({
      compileOutcomes: ["repairable", "success", "success"],
      repairAgent: async (attempt): Promise<RepairResult> => {
        repairInput = { failedTex: attempt.input.failedTex, latexLog: attempt.input.latexLog };
        const valid = await attempt.input.operations.validateCandidate(attempt.input.failedTex, attempt.signal);
        expect(valid.ok).toBeTrue();
        const candidate = await attempt.input.operations.compileCandidate(attempt.input.failedTex, attempt.signal);
        expect(candidate.ok).toBeTrue();
        return { status: "repaired", tailoredTex: attempt.input.failedTex, changes: [{ category: "escaping", summary: "Restored escaping" }], remainingDiagnostics: [] };
      },
    });
    await processToStop(harness);

    expect(harness.repository.getRun(harness.runId)?.status).toBe("review");
    expect(harness.compileModes).toEqual(["full", "candidate", "full"]);
    expect(repairInput?.latexLog).toContain("repairable compile failure");
    const attempts = harness.repository.timeline(harness.runId).attempts;
    expect(attempts.map((attempt) => attempt.stage)).toEqual([
      "analyzing", "tailoring", "compiling", "repairing", "compiling", "deterministic_qa", "visual_qa",
    ]);
    expect(attempts.find((attempt) => attempt.stage === "repairing")?.compileCount).toBe(1);
    expect(harness.repository.getArtifact(harness.runId, "repair-report")).not.toBeNull();
  });

  test("persists processor-created repairing attempts with the repair-loop origin", async () => {
    const harness = await createHarness({
      compileOutcomes: ["repairable", "success"],
      repairAgent: async (attempt): Promise<RepairResult> => ({
        status: "repaired",
        tailoredTex: attempt.input.failedTex,
        changes: [{ category: "escaping", summary: "Restored escaping" }],
        remainingDiagnostics: [],
      }),
    });

    await processToStop(harness);

    const repairingAttempt = harness.repository.timeline(harness.runId).attempts
      .find((attempt) => attempt.stage === "repairing");
    expect(repairingAttempt?.origin).toBe("repair_loop");
  });

  test("rejects a repair that would make the current resume diff stale", async () => {
    let candidateValidated = false;
    let candidateCompiled = false;
    const harness = await createHarness({
      compileOutcomes: ["repairable", "success"],
      repairAgent: async (attempt): Promise<RepairResult> => {
        const parsed = parseBaselineResume(attempt.input.failedTex);
        const [firstBullet] = parseMacroCalls(parsed.regions.experience.body, "resumeItem", 1);
        if (!firstBullet) throw new Error("repair test requires an experience bullet");
        const start = parsed.regions.experience.bodyStart + firstBullet.start;
        const end = parsed.regions.experience.bodyStart + firstBullet.end;
        const tailoredTex = `${attempt.input.failedTex.slice(0, start)}\\resumeItem{Changed without updating the resume diff.}${attempt.input.failedTex.slice(end)}`;
        const valid = await attempt.input.operations.validateCandidate(tailoredTex, attempt.signal);
        candidateValidated = valid.ok;
        if (!valid.ok) throw new Error(valid.diagnostics.join("\n"));
        const candidate = await attempt.input.operations.compileCandidate(tailoredTex, attempt.signal);
        candidateCompiled = candidate.ok;
        if (!candidate.ok) throw new Error(candidate.diagnostics.join("\n"));
        return {
          status: "repaired",
          tailoredTex,
          changes: [{ category: "escaping", summary: "Changed a resume bullet" }],
          remainingDiagnostics: [],
        };
      },
    });
    await processToStop(harness);

    expect(candidateValidated).toBeTrue();
    expect(candidateCompiled).toBeTrue();
    expect(harness.repository.getRun(harness.runId)).toMatchObject({
      status: "failed",
      failedStage: "repairing",
    });
  });

  test("treats the post-repair full compile as authority and terminalizes a failed repaired revision", async () => {
    const harness = await createHarness({
      compileOutcomes: ["repairable", "success", "repairable"],
      repairAgent: async (attempt): Promise<RepairResult> => {
        await attempt.input.operations.validateCandidate(attempt.input.failedTex, attempt.signal);
        await attempt.input.operations.compileCandidate(attempt.input.failedTex, attempt.signal);
        return { status: "repaired", tailoredTex: attempt.input.failedTex, changes: [{ category: "escaping", summary: "Restored escaping" }], remainingDiagnostics: [] };
      },
    });
    await processToStop(harness);

    expect(harness.compileModes).toEqual(["full", "candidate", "full"]);
    expect(harness.repository.getRun(harness.runId)).toMatchObject({ status: "failed", failedStage: "compiling" });
    expect(harness.repository.getArtifact(harness.runId, "compiled-pdf")).toBeNull();
    expect(harness.repository.getArtifact(harness.runId, "latex-log")).not.toBeNull();
  });

  test("always finalizes bounded terminal compile logs and never finalizes a failed PDF", async () => {
    const harness = await createHarness({ compileOutcomes: ["terminal"] });
    await processToStop(harness);

    expect(harness.repository.getRun(harness.runId)).toMatchObject({ status: "failed", failedStage: "compiling" });
    const log = harness.repository.getArtifact(harness.runId, "latex-log");
    expect(log?.byteSize).toBeLessThanOrEqual(ARTIFACT_LIMITS.log);
    expect(harness.repository.getArtifact(harness.runId, "compiled-pdf")).toBeNull();
    expect(harness.repository.timeline(harness.runId).attempts.find((attempt) => attempt.stage === "compiling")).toMatchObject({ status: "failed", compileCount: 1 });
  });

  test("fails deterministic defects but keeps visual issues and uncertainty reviewable with acknowledgement", async () => {
    const deterministic = await createHarness({
      deterministicReports: [{
        pass: false,
        checks: [{ id: "letter-size", status: "fail", detail: "page is not US Letter" }],
        warnings: [],
      }],
    });
    await processToStop(deterministic);
    expect(deterministic.repository.getRun(deterministic.runId)).toMatchObject({ status: "failed", failedStage: "deterministic_qa" });
    expect(deterministic.repository.getArtifact(deterministic.runId, "visual-qa")).toBeNull();
    expect(deterministic.repository.getArtifact(deterministic.runId, "one-page-correction")).toBeNull();

    for (const status of ["issue", "uncertain"] as const) {
      const visual = await createHarness({ visual: { status, summary: "Needs human judgement", findings: [{ severity: "warning", description: "Possible crowding", page: 1 }] } });
      await processToStop(visual);
      expect(visual.repository.getRun(visual.runId)).toMatchObject({ status: "review", visualAcknowledgementRequired: true });
      expect(visual.repository.getArtifact(visual.runId, "visual-qa")).not.toBeNull();
    }
  });

  test("rejects an edited plan that drops all support for an analysis-active directive", async () => {
    const fixtures = resumeFixturesWithActiveDirective("Strong TypeScript engineer");
    const harness = await createHarness({
      fixtures,
      editAgent: async (attempt) => ({
        plan: dropAnalyzedRewrite(attempt.input.currentPlan),
        commentDispositions: [{
          commentIndex: 0,
          status: "applied",
          rationale: "Attempt to drop the rewrite.",
          evidenceIds: ["evidence-0"],
        }],
      }),
    });
    await processToStop(harness);
    expect(harness.repository.getRun(harness.runId)?.status).toBe("review");
    expect(harness.agentInputs.tailoring[0]?.mustIncludeEvidenceIds)
      .toEqual([ACTIVE_DIRECTIVE_EVIDENCE_ID]);
    const firstPdf = harness.repository.getArtifact(harness.runId, "compiled-pdf")!;
    harness.repository.editRun(
      harness.runId,
      "drop the rewritten impact",
      firstPdf.sha256,
      fixtures.snapshotInput,
    );

    await processToStop(harness);

    expect(harness.repository.getRun(harness.runId)).toMatchObject({
      status: "failed",
      failedStage: "editing",
      currentRevision: 2,
    });
    expect(harness.repository.getArtifact(harness.runId, "tailoring-plan")?.revision).toBe(1);
    expect(harness.repository.timeline(harness.runId).attempts
      .find((attempt) => attempt.stage === "editing")).toMatchObject({ status: "failed" });
  });

  test("human and machine edits reuse revision-one analysis and receive exact immutable prior QA", async () => {
    const editInputs: EditAgentInput[] = [];
    const harness = await createHarness({
      deterministicReports: [MULTI_PAGE_QA, ONE_PAGE_QA],
      editAgent: async (attempt) => {
        editInputs.push(attempt.input);
        return {
          plan: attempt.input.currentPlan,
          commentDispositions: attempt.input.comments?.map((_, commentIndex) => ({
            commentIndex,
            status: "applied",
            rationale: "Applied using existing evidence",
            evidenceIds: ["evidence-0"],
          })) ?? [],
        };
      },
    });
    await processToStop(harness);
    const firstPdf = harness.repository.getArtifact(harness.runId, "compiled-pdf")!;
    harness.repository.editRun(harness.runId, "shorten the second experience bullet", firstPdf.sha256, harness.fixtures.snapshotInput);
    await processToStop(harness);

    const secondPdf = harness.repository.getArtifact(harness.runId, "compiled-pdf")!;
    harness.repository.regenerate(harness.runId, secondPdf.sha256, harness.fixtures.snapshotInput);
    await processToStop(harness);

    expect(harness.agentInputs.analysis).toHaveLength(1);
    expect(editInputs).toHaveLength(2);
    expect(editInputs[0]?.comments).toEqual(["shorten the second experience bullet"]);
    expect(editInputs[0]?.deterministicQa).toEqual(ONE_PAGE_QA);
    expect(editInputs.every((input) => input.context === harness.fixtures.snapshot)).toBeTrue();
    expect(editInputs[0]?.machineFindings).toBeUndefined();
    expect(editInputs[1]?.comments).toEqual([]);
    expect(editInputs[1]?.machineFindings).toEqual({
      deterministicQa: ONE_PAGE_QA,
      visualQa: { status: "pass", summary: "Page is readable", findings: [] },
    });
    expect(Object.keys(editInputs[0] ?? {})).not.toContain("rawJobDescription");
    expect(harness.repository.getArtifact(harness.runId, "job-analysis")?.revision).toBe(1);
    expect(harness.repository.getArtifact(harness.runId, "edit-request")?.revision).toBe(3);
    const currentDiff = harness.repository.getArtifact(harness.runId, "resume-diff");
    expect(currentDiff?.revision).toBe(3);
    expect(ResumeDiffSchema.parse(JSON.parse(await Bun.file(currentDiff!.path).text()))).toEqual(
      buildResumeDiff(baseline, editInputs[1]!.currentPlan),
    );
    expect(harness.repository.getRun(harness.runId)?.status).toBe("review");
  });


  test("acknowledges only the active attempt after claim-loss cancellation and commits nothing later", async () => {
    const started = Promise.withResolvers<void>();
    const harness = await createHarness({
      analysisAgent: async (attempt) => {
        started.resolve();
        await new Promise<void>((resolvePromise, rejectPromise) => {
          if (attempt.signal.aborted) rejectPromise(attempt.signal.reason);
          else attempt.signal.addEventListener("abort", () => rejectPromise(attempt.signal.reason), { once: true });
        });
        throw new Error("unreachable");
      },
    });
    const claim = harness.repository.acquire()!;
    const controller = new AbortController();
    const processing = harness.processor.processClaim(claim, controller.signal);
    await started.promise;
    controller.abort(new ClaimRejectedError("heartbeat lost"));
    await processing;

    const attempts = harness.repository.timeline(harness.runId).attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ stage: "analyzing", status: "cancelled" });
    expect(attempts[0]?.cancellationAcknowledgedAt).not.toBeNull();
    expect(harness.repository.getArtifact(harness.runId, "ats-keyword-extraction")).toBeNull();
    expect(harness.repository.getArtifact(harness.runId, "job-analysis")).toBeNull();
    expect(harness.repository.getRun(harness.runId)?.status).toBe("analyzing");
  });
});

describe("pipeline stage processor portable pre-attempt behavior", () => {
  test("detects source drift before agent execution and fails the active stage", async () => {
    let loads = 0;
    const fixture = resumeFixtures("Strong TypeScript engineer");
    const harness = await createHarness({
      loadSourceContext: () => {
        loads += 1;
        if (loads === 1) return { snapshot: fixture.snapshot, baseline };
        return { snapshot: { ...fixture.snapshot, manifestSha256: "f".repeat(64) }, baseline };
      },
    });
    await processToStop(harness);

    expect(harness.repository.getRun(harness.runId)).toMatchObject({ status: "failed", failedStage: "analyzing" });
    expect(harness.agentInputs.atsKeywordExtraction).toHaveLength(0);
    expect(harness.agentInputs.analysis).toHaveLength(0);
    expect(harness.repository.getArtifact(harness.runId, "ats-keyword-extraction")).toBeNull();
    expect(harness.repository.getArtifact(harness.runId, "job-analysis")).toBeNull();
  });
});
