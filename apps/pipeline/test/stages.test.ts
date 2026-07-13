import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AnalysisAgentInput } from "../src/agents/analysis-agent.ts";
import type { EditAgentInput } from "../src/agents/edit-agent.ts";
import type { TailoringAgentInput } from "../src/agents/tailoring-agent.ts";
import type { ContextSnapshot, EvidenceBlock, IndexedContextSource } from "../src/context/types.ts";
import { openPipelineDatabase } from "../src/db/database.ts";
import { ClaimRejectedError, PipelineRepository, type RunSourceSnapshotInput } from "../src/db/repository.ts";
import type { GeminiVisualInspection } from "../src/models/gemini-inspector.ts";
import type { CompileRequest, CompileResult } from "../src/resume/compiler.ts";
import {
  hashJobAnalysis,
  parseBaselineResume,
  renderTailoredResume,
  type EditResult,
  type JobAnalysis,
  type RepairResult,
  type TailoringPlan,
} from "../src/resume/index.ts";
import { PipelineStageProcessor, type PipelineStageDependencies } from "../src/stages/index.ts";
import { ARTIFACT_LIMITS, ArtifactStore } from "../src/system/artifacts.ts";

const baseline = await Bun.file(resolve(import.meta.dir, "../../../actual/resume-main/main.tex")).text();
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
    explicitEntityBindings: { "Sample Project": "SampleProject" },
  };
  const analysis: JobAnalysis = {
    id: "analysis-1",
    jobDescriptionSha256: createHash("sha256").update(jobDescription).digest("hex"),
    target: { title: "Software Engineer" },
    prioritizedKeywords: [{ keyword: "TypeScript", priority: "required", jdQuote: "Strong TypeScript", evidenceIds: ["evidence-0"] }],
    guidance: [{ guidance: "Prefer relevant work", evidenceIds: ["evidence-0"] }],
  };
  const evidenceByEntity = new Map(parsedBaseline.entities.map((entity, index) => [entity.entityId, `evidence-${index}`]));
  const plan: TailoringPlan = {
    id: "plan-1",
    analysisId: analysis.id,
    analysisSha256: hashJobAnalysis(analysis),
    decisions: parsedBaseline.bullets.map((bullet, index) => ({
      id: `decision-${index}`,
      section: bullet.section,
      entityId: bullet.entityId,
      baselineItemId: bullet.id,
      action: "retain",
      text: bullet.text,
      evidenceIds: [evidenceByEntity.get(bullet.entityId)!],
      factKeys: [],
      rationale: "Retain supported baseline claim",
    })),
    projectOrder: parsedBaseline.entities.filter((entity) => entity.section === "projects").map((entity) => entity.entityId),
    skillDecisions: parsedBaseline.skills.map((skill, index) => ({
      id: `skill-${index}`,
      entityId: "Example Company",
      category: skill.category,
      skill: skill.skill,
      action: "retain",
      evidenceIds: ["evidence-0"],
      rationale: "Retain supported baseline skill",
    })),
    factWinners: [],
    baselineOverrides: [],
    omissions: [],
  };
  return {
    snapshot,
    snapshotInput: {
      manifestSha256: snapshot.manifestSha256,
      baselineSha256: snapshot.baselineSha256,
      sourceHashes: snapshot.sourceHashes,
    },
    analysis,
    plan,
  };
}

interface HarnessOptions {
  readonly compileOutcomes?: readonly ("success" | "repairable" | "terminal")[];
  readonly deterministicPass?: boolean;
  readonly visual?: GeminiVisualInspection;
  readonly loadSourceContext?: PipelineStageDependencies["loadSourceContext"];
  readonly analysisAgent?: PipelineStageDependencies["analysisAgent"];
  readonly editAgent?: PipelineStageDependencies["editAgent"];
  readonly repairAgent?: PipelineStageDependencies["repairAgent"];
}

interface AgentInputs {
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
  readonly agentInputs: AgentInputs;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const jobDescription = "Strong TypeScript engineer";
  const fixtures = resumeFixtures(jobDescription);
  const database = openPipelineDatabase(":memory:");
  databases.push(database);
  let id = 0;
  let token = 0;
  const repository = new PipelineRepository(database, {
    idFactory: () => `stage-id-${++id}`,
    attemptSessionIdFactory: () => `session-${id}`,
    tokenFactory: () => Buffer.alloc(32, ++token).toString("base64url"),
  });
  const root = await mkdtemp(join(tmpdir(), "pipeline-stages-"));
  roots.push(root);
  const artifacts = new ArtifactStore(root);
  const inputRoot = await artifacts.createRunInput({ run: "stage-run" });
  const input = await artifacts.write(join(inputRoot, "job-description.txt"), jobDescription, 1024 * 1024);
  const run = repository.createQueuedRun(jobDescription, fixtures.snapshotInput, {
    sha256: input.sha256,
    path: input.path,
    byteSize: input.bytes,
  }, "stage-run");
  const compileOutcomes = [...(options.compileOutcomes ?? ["success"])] ;
  const compileModes: string[] = [];
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
  const agentInputs: AgentInputs = { analysis: [], tailoring: [], editing: [] };
  const dependencies: PipelineStageDependencies = {
    repository,
    artifacts,
    loadSourceContext: options.loadSourceContext ?? (() => ({ snapshot: fixtures.snapshot, baseline })),
    analysisAgent: options.analysisAgent ?? (async (attempt) => {
      agentInputs.analysis.push(attempt.input);
      return fixtures.analysis;
    }),
    tailoringAgent: async (attempt) => {
      agentInputs.tailoring.push(attempt.input);
      return { plan: fixtures.plan };
    },
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
    deterministicQa: async () => ({
      pass: options.deterministicPass ?? true,
      checks: [],
      warnings: [],
    }),
    rasterizer: async (request) => {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
      const artifact = await artifacts.write(request.outputPath, png, ARTIFACT_LIMITS.png);
      return { mediaType: "image/png", page: 1, dpi: 200, byteSize: artifact.bytes, path: artifact.path };
    },
    visualInspector: async () => options.visual ?? { status: "pass", summary: "Page is readable", findings: [] },
  };
  const processor = new PipelineStageProcessor(dependencies);
  return { repository, artifacts, processor, fixtures, runId: run.id, compileModes, agentInputs };
}

async function processToStop(harness: Harness): Promise<void> {
  const claim = harness.repository.acquire();
  if (!claim) throw new Error("claim missing");
  await harness.processor.processClaim(claim, new AbortController().signal);
  harness.repository.release(claim);
}

describe("pipeline stage processor", () => {
  test("runs the initial public state sequence, trusted plan render, QA, and immutable artifact finalization", async () => {
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
    expect(harness.agentInputs.analysis).toHaveLength(1);
    expect(harness.agentInputs.tailoring).toHaveLength(1);
    expect(Object.keys(harness.agentInputs.tailoring[0]!)).not.toContain("rawJobDescription");
    const texArtifact = harness.repository.getArtifact(harness.runId, "tailored-tex");
    expect(texArtifact).not.toBeNull();
    expect(await Bun.file(texArtifact!.path).text()).toBe(renderTailoredResume(harness.fixtures.plan, baseline, harness.fixtures.snapshot));
    expect(harness.repository.listResolvedArtifacts(harness.runId).map((artifact) => artifact.kind)).toEqual(expect.arrayContaining([
      "job-description", "job-analysis", "tailoring-plan", "change-summary", "evidence-ledger", "tailored-tex",
      "latex-log", "compiled-pdf", "deterministic-qa", "page-image", "visual-qa",
    ]));
    const timeline = harness.repository.timeline(harness.runId);
    expect(timeline.attempts.map((attempt) => attempt.stage)).toEqual(["analyzing", "tailoring", "compiling", "deterministic_qa", "visual_qa"]);
    expect(timeline.attempts.find((attempt) => attempt.stage === "compiling")?.compileCount).toBe(1);
    expect(JSON.stringify({ run: harness.repository.getRun(harness.runId), timeline })).not.toContain("token");
    expect(JSON.stringify(harness.repository.listResolvedArtifacts(harness.runId))).not.toContain("Strong TypeScript engineer");
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
    const deterministic = await createHarness({ deterministicPass: false });
    await processToStop(deterministic);
    expect(deterministic.repository.getRun(deterministic.runId)).toMatchObject({ status: "failed", failedStage: "deterministic_qa" });
    expect(deterministic.repository.getArtifact(deterministic.runId, "visual-qa")).toBeNull();

    for (const status of ["issue", "uncertain"] as const) {
      const visual = await createHarness({ visual: { status, summary: "Needs human judgement", findings: [{ severity: "warning", description: "Possible crowding", page: 1 }] } });
      await processToStop(visual);
      expect(visual.repository.getRun(visual.runId)).toMatchObject({ status: "review", visualAcknowledgementRequired: true });
      expect(visual.repository.getArtifact(visual.runId, "visual-qa")).not.toBeNull();
    }
  });

  test("human and machine edits reuse revision-one analysis and receive exact immutable prior QA", async () => {
    const editInputs: EditAgentInput[] = [];
    const harness = await createHarness({
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
    expect(editInputs[0]?.machineFindings).toBeUndefined();
    expect(editInputs[1]?.comments).toEqual([]);
    expect(editInputs[1]?.machineFindings).toEqual({
      deterministicQa: { pass: true, checks: [], warnings: [] },
      visualQa: { status: "pass", summary: "Page is readable", findings: [] },
    });
    expect(Object.keys(editInputs[0] ?? {})).not.toContain("rawJobDescription");
    expect(harness.repository.getArtifact(harness.runId, "job-analysis")?.revision).toBe(1);
    expect(harness.repository.getArtifact(harness.runId, "edit-request")?.revision).toBe(3);
    expect(harness.repository.getRun(harness.runId)?.status).toBe("review");
  });

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
    expect(harness.agentInputs.analysis).toHaveLength(0);
    expect(harness.repository.getArtifact(harness.runId, "job-analysis")).toBeNull();
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
    expect(harness.repository.getArtifact(harness.runId, "job-analysis")).toBeNull();
    expect(harness.repository.getRun(harness.runId)?.status).toBe("analyzing");
  });
});
