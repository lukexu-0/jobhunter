import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  runAnalysisAgent,
  runEditAgent,
  runRepairAgent,
  runTailoringAgent,
  type AgentRuntimeDependencies,
} from "../agents/index.ts";
import type { ContextSnapshot } from "../context/types.ts";
import { ClaimRejectedError, type PublicArtifact, type PublicAttempt, type PublicRun } from "../db/repository.ts";
import { inspectResumePng, type GeminiInspectorOptions } from "../models/gemini-inspector.ts";
import { compileResume, type CompileResult } from "../resume/compiler.ts";
import {
  buildEvidenceLedger,
  JobAnalysisSchema,
  rasterizePdfPage,
  renderEditedResume,
  renderTailoredResume,
  runDeterministicPdfQa,
  TailoringPlanSchema,
  validateAnalysisImmutability,
  validateRepairCandidate,
  type TailoringPlan,
} from "../resume/index.ts";
import { ARTIFACT_LIMITS, ArtifactStore, artifactExists, type ArtifactAddress, type ArtifactMetadata } from "../system/artifacts.ts";
import type { ProcessBoundary } from "../system/process.ts";
import { readProcessStartToken, type RunClaim } from "../worker/claims.ts";
import type { StageRepository, StageSourceContext } from "./types.ts";

const JSON_LIMIT = 2 * 1024 * 1024;
const JOB_DESCRIPTION_LIMIT = 1024 * 1024;
const REQUIRED_HEADINGS = ["Education", "Experience", "Projects", "Technical Skills"] as const;

export interface PipelineStageDependencies {
  readonly repository: StageRepository;
  readonly artifacts: ArtifactStore;
  readonly loadSourceContext: (runId: string) => Promise<StageSourceContext> | StageSourceContext;
  readonly agentRuntime?: AgentRuntimeDependencies;
  readonly processBoundary?: ProcessBoundary;
  readonly gemini?: GeminiInspectorOptions;
  readonly analysisAgent?: typeof runAnalysisAgent;
  readonly tailoringAgent?: typeof runTailoringAgent;
  readonly editAgent?: typeof runEditAgent;
  readonly repairAgent?: typeof runRepairAgent;
  readonly compiler?: typeof compileResume;
  readonly deterministicQa?: typeof runDeterministicPdfQa;
  readonly rasterizer?: typeof rasterizePdfPage;
  readonly visualInspector?: typeof inspectResumePng;
}

interface AttemptAudit {
  toolCount: number;
  compileCount: number;
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error instanceof ClaimRejectedError || (error instanceof DOMException && error.name === "AbortError");
}

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function selectedEvidenceText(plan: TailoringPlan): readonly string[] {
  return [
    ...plan.decisions.filter((decision) => decision.action !== "omit" && decision.text !== null).map((decision) => decision.text!),
    ...plan.skillDecisions.filter((decision) => decision.action !== "omit").map((decision) => decision.skill),
    ...plan.baselineOverrides.map((override) => override.replacement),
  ];
}

function sourceInput(snapshot: ContextSnapshot) {
  return {
    manifestSha256: snapshot.manifestSha256,
    baselineSha256: snapshot.baselineSha256,
    sourceHashes: snapshot.sourceHashes,
  };
}

export class PipelineStageProcessor {
  readonly #repository: StageRepository;
  readonly #artifacts: ArtifactStore;
  readonly #loadSourceContext: PipelineStageDependencies["loadSourceContext"];
  readonly #agentRuntime: AgentRuntimeDependencies | undefined;
  readonly #processBoundary: ProcessBoundary | undefined;
  readonly #gemini: GeminiInspectorOptions | undefined;
  readonly #analysisAgent: typeof runAnalysisAgent;
  readonly #tailoringAgent: typeof runTailoringAgent;
  readonly #editAgent: typeof runEditAgent;
  readonly #repairAgent: typeof runRepairAgent;
  readonly #compiler: typeof compileResume;
  readonly #deterministicQa: typeof runDeterministicPdfQa;
  readonly #rasterizer: typeof rasterizePdfPage;
  readonly #visualInspector: typeof inspectResumePng;

  constructor(dependencies: PipelineStageDependencies) {
    this.#repository = dependencies.repository;
    this.#artifacts = dependencies.artifacts;
    this.#loadSourceContext = dependencies.loadSourceContext;
    this.#agentRuntime = dependencies.agentRuntime;
    this.#processBoundary = dependencies.processBoundary;
    this.#gemini = dependencies.gemini;
    this.#analysisAgent = dependencies.analysisAgent ?? runAnalysisAgent;
    this.#tailoringAgent = dependencies.tailoringAgent ?? runTailoringAgent;
    this.#editAgent = dependencies.editAgent ?? runEditAgent;
    this.#repairAgent = dependencies.repairAgent ?? runRepairAgent;
    this.#compiler = dependencies.compiler ?? compileResume;
    this.#deterministicQa = dependencies.deterministicQa ?? runDeterministicPdfQa;
    this.#rasterizer = dependencies.rasterizer ?? rasterizePdfPage;
    this.#visualInspector = dependencies.visualInspector ?? inspectResumePng;
  }

  async processClaim(claim: RunClaim, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const run = this.#requiredRun(claim.runId);
      if (run.status === "review" || run.status === "approved" || run.status === "failed") return;
      if (run.status === "queued") {
        this.#repository.transition(claim, "analyzing");
        continue;
      }
      const stage = run.status;
      let attempt: PublicAttempt | undefined;
      const audit: AttemptAudit = { toolCount: 0, compileCount: 0 };
      try {
        const sources = await this.#verifiedSources(run.id, signal);
        signal.throwIfAborted();
        const processStartToken = readProcessStartToken();
        if (processStartToken === undefined) throw new Error("worker process identity is unavailable");
        attempt = this.#repository.startAttempt(claim, stage, {
          processPid: process.pid,
          processStartToken,
        });
        await this.#runStage(claim, run, attempt, sources, signal, audit);
      } catch (error) {
        if (isCancellation(error, signal)) {
          if (attempt) this.#repository.acknowledgeCancellation(attempt.id, claim.token);
          return;
        }
        if (attempt) {
          try { this.#repository.finishAttempt(claim, attempt.id, "failed", audit); }
          catch (finishError) {
            if (isCancellation(finishError, signal)) {
              this.#repository.acknowledgeCancellation(attempt.id, claim.token);
              return;
            }
            throw finishError;
          }
        }
        this.#repository.transition(claim, "failed", { failedStage: stage });
        return;
      }
    }
  }

  async #runStage(
    claim: RunClaim,
    run: PublicRun,
    attempt: PublicAttempt,
    sources: StageSourceContext,
    signal: AbortSignal,
    audit: AttemptAudit,
  ): Promise<void> {
    switch (attempt.stage) {
      case "analyzing": await this.#analyze(claim, run, attempt, sources, signal, audit); return;
      case "tailoring": await this.#tailor(claim, run, attempt, sources, signal, audit); return;
      case "editing": await this.#edit(claim, run, attempt, sources, signal, audit); return;
      case "compiling": await this.#compile(claim, run, attempt, sources, signal, audit); return;
      case "repairing": await this.#repair(claim, run, attempt, sources, signal, audit); return;
      case "deterministic_qa": await this.#deterministic(claim, run, attempt, sources, signal, audit); return;
      case "visual_qa": await this.#visual(claim, run, attempt, sources, signal, audit); return;
    }
  }

  async #analyze(claim: RunClaim, run: PublicRun, attempt: PublicAttempt, sources: StageSourceContext, signal: AbortSignal, audit: AttemptAudit): Promise<void> {
    if (run.currentRevision !== 1 || this.#repository.getArtifact(run.id, "job-analysis")) throw new Error("analysis is immutable and may run only once in revision 1");
    const inputArtifact = this.#requiredArtifact(run.id, "job-description");
    const rawJobDescription = await this.#readText(inputArtifact, JOB_DESCRIPTION_LIMIT);
    await this.#verifyAgain(run.id, signal);
    const analysis = await this.#analysisAgent({
      attemptSessionId: attempt.attemptSessionId,
      input: { rawJobDescription, evidence: sources.snapshot.evidence },
      signal,
      ...(this.#agentRuntime ? { runtime: this.#agentRuntime } : {}),
    });
    audit.toolCount = 1;
    if (analysis.jobDescriptionSha256 !== createHash("sha256").update(rawJobDescription).digest("hex")) {
      throw new Error("job analysis does not match the immutable job description");
    }
    signal.throwIfAborted();
    await this.#verifyAgain(run.id, signal);
    const artifact = await this.#writeJson(run, attempt, "job-analysis", analysis);
    this.#finalize(claim, attempt, "job-analysis", artifact, inputArtifact.id);
    this.#repository.finishAttempt(claim, attempt.id, "succeeded", audit);
    this.#repository.transition(claim, "tailoring");
  }

  async #tailor(claim: RunClaim, run: PublicRun, attempt: PublicAttempt, sources: StageSourceContext, signal: AbortSignal, audit: AttemptAudit): Promise<void> {
    const analysisArtifact = this.#requiredArtifact(run.id, "job-analysis");
    const analysis = JobAnalysisSchema.parse(await this.#readJson(analysisArtifact));
    await this.#verifyAgain(run.id, signal);
    const result = await this.#tailoringAgent({
      attemptSessionId: attempt.attemptSessionId,
      input: { analysis, baseline: sources.baseline, evidence: sources.snapshot.evidence },
      signal,
      ...(this.#agentRuntime ? { runtime: this.#agentRuntime } : {}),
    });
    audit.toolCount = 1;
    validateAnalysisImmutability(result.plan, analysis);
    const tailoredTex = renderTailoredResume(result.plan, sources.baseline, sources.snapshot);
    const ledger = buildEvidenceLedger(analysis, result.plan, sources.snapshot);
    signal.throwIfAborted();
    await this.#verifyAgain(run.id, signal);
    const root = await this.#artifacts.createAttempt(this.#address(run, attempt));
    const planMeta = await this.#artifacts.write(join(root, "tailoring-plan.json"), json(result.plan), JSON_LIMIT);
    const summaryMeta = await this.#artifacts.write(join(root, "change-summary.json"), json({ planId: result.plan.id, decisions: result.plan.decisions, skillDecisions: result.plan.skillDecisions, omissions: result.plan.omissions }), JSON_LIMIT);
    const ledgerMeta = await this.#artifacts.write(join(root, "evidence-ledger.json"), json(ledger), JSON_LIMIT);
    const texMeta = await this.#artifacts.write(join(root, "resume.tex"), tailoredTex, ARTIFACT_LIMITS.tex);
    this.#finalize(claim, attempt, "tailoring-plan", planMeta, analysisArtifact.id);
    this.#finalize(claim, attempt, "change-summary", summaryMeta, analysisArtifact.id);
    this.#finalize(claim, attempt, "evidence-ledger", ledgerMeta, analysisArtifact.id);
    this.#finalize(claim, attempt, "tailored-tex", texMeta, analysisArtifact.id);
    this.#repository.finishAttempt(claim, attempt.id, "succeeded", audit);
    this.#repository.transition(claim, "compiling");
  }

  async #edit(claim: RunClaim, run: PublicRun, attempt: PublicAttempt, sources: StageSourceContext, signal: AbortSignal, audit: AttemptAudit): Promise<void> {
    const request = this.#repository.getEditRequest(run.id, run.currentRevision);
    if (!request) throw new Error("edit request is missing");
    const analysisArtifact = this.#requiredArtifact(run.id, "job-analysis");
    const planArtifact = this.#requiredArtifact(run.id, "tailoring-plan", request.sourceRevision);
    const texArtifact = this.#requiredArtifact(run.id, "tailored-tex", request.sourceRevision);
    const deterministicArtifact = this.#requiredArtifact(run.id, "deterministic-qa", request.sourceRevision);
    const visualArtifact = this.#requiredArtifact(run.id, "visual-qa", request.sourceRevision);
    const analysis = JobAnalysisSchema.parse(await this.#readJson(analysisArtifact));
    const currentPlan = TailoringPlanSchema.parse(await this.#readJson(planArtifact));
    const currentTailoredTex = await this.#readText(texArtifact, ARTIFACT_LIMITS.tex);
    const deterministicQa = await this.#readJson(deterministicArtifact);
    const visualQa = await this.#readJson(visualArtifact);
    const comments = request.origin === "human_edit" ? [request.comments] : [];
    await this.#verifyAgain(run.id, signal);
    const result = await this.#editAgent({
      attemptSessionId: attempt.attemptSessionId,
      input: {
        analysis,
        currentPlan,
        currentTailoredTex,
        evidence: sources.snapshot.evidence,
        deterministicQa,
        visualQa,
        comments,
        ...(request.origin === "machine_regenerate" ? { machineFindings: { deterministicQa, visualQa } } : {}),
      },
      signal,
      ...(this.#agentRuntime ? { runtime: this.#agentRuntime } : {}),
    });
    audit.toolCount = 1;
    const tailoredTex = renderEditedResume(result, comments, analysis, sources.baseline, sources.snapshot);
    const ledger = buildEvidenceLedger(analysis, result.plan, sources.snapshot, { comments, commentDispositions: result.commentDispositions });
    signal.throwIfAborted();
    await this.#verifyAgain(run.id, signal);
    const root = await this.#artifacts.createAttempt(this.#address(run, attempt));
    const requestMeta = await this.#artifacts.write(join(root, "edit-request.json"), json(request), JSON_LIMIT);
    const reportMeta = await this.#artifacts.write(join(root, "edit-report.json"), json(result), JSON_LIMIT);
    const planMeta = await this.#artifacts.write(join(root, "tailoring-plan.json"), json(result.plan), JSON_LIMIT);
    const summaryMeta = await this.#artifacts.write(join(root, "change-summary.json"), json({ planId: result.plan.id, decisions: result.plan.decisions, skillDecisions: result.plan.skillDecisions, omissions: result.plan.omissions, commentDispositions: result.commentDispositions }), JSON_LIMIT);
    const ledgerMeta = await this.#artifacts.write(join(root, "evidence-ledger.json"), json(ledger), JSON_LIMIT);
    const texMeta = await this.#artifacts.write(join(root, "resume.tex"), tailoredTex, ARTIFACT_LIMITS.tex);
    this.#finalize(claim, attempt, "edit-request", requestMeta);
    this.#finalize(claim, attempt, "edit-report", reportMeta, planArtifact.id);
    this.#finalize(claim, attempt, "tailoring-plan", planMeta, planArtifact.id);
    this.#finalize(claim, attempt, "change-summary", summaryMeta, planArtifact.id);
    this.#finalize(claim, attempt, "evidence-ledger", ledgerMeta, planArtifact.id);
    this.#finalize(claim, attempt, "tailored-tex", texMeta, texArtifact.id);
    this.#repository.finishAttempt(claim, attempt.id, "succeeded", audit);
    this.#repository.transition(claim, "compiling");
  }

  async #compile(claim: RunClaim, run: PublicRun, attempt: PublicAttempt, _sources: StageSourceContext, signal: AbortSignal, audit: AttemptAudit): Promise<void> {
    const texArtifact = this.#requiredArtifact(run.id, "tailored-tex");
    const tex = await this.#readText(texArtifact, ARTIFACT_LIMITS.tex);
    await this.#verifyAgain(run.id, signal);
    const address = this.#address(run, attempt);
    let result: CompileResult;
    try {
      result = await this.#compiler({
        artifacts: this.#artifacts,
        address,
        tex,
        mode: "full",
        signal,
        ...(this.#processBoundary ? { processBoundary: this.#processBoundary } : {}),
      });
      audit.compileCount = 1;
    } catch (error) {
      audit.compileCount = 1;
      if (isCancellation(error, signal)) throw error;
      await this.#verifyAgain(run.id, signal);
      const root = this.#artifacts.attemptRoot(address);
      if (!await artifactExists(root)) await this.#artifacts.createAttempt(address);
      const diagnostic = Buffer.from(error instanceof Error ? error.message : String(error), "utf8").subarray(0, ARTIFACT_LIMITS.log);
      const log = await this.#artifacts.write(join(root, "compile-error.log"), diagnostic, ARTIFACT_LIMITS.log);
      this.#finalize(claim, attempt, "latex-log", log, texArtifact.id);
      this.#repository.finishAttempt(claim, attempt.id, "failed", audit);
      this.#repository.transition(claim, "failed", { failedStage: "compiling" });
      return;
    }
    signal.throwIfAborted();
    await this.#verifyAgain(run.id, signal);
    this.#finalize(claim, attempt, "latex-log", result.log, texArtifact.id);
    if (result.tex) this.#finalize(claim, attempt, "tailored-tex", result.tex, texArtifact.id);
    if (result.ok) {
      this.#finalize(claim, attempt, "compiled-pdf", result.pdf, texArtifact.id);
      this.#repository.finishAttempt(claim, attempt.id, "succeeded", audit);
      this.#repository.transition(claim, "deterministic_qa");
      return;
    }
    this.#repository.finishAttempt(claim, attempt.id, "failed", audit);
    const repairedInCurrentRevision = this.#repository.getArtifact(run.id, "repair-report")?.revision === run.currentRevision;
    if (result.classification === "repairable" && !repairedInCurrentRevision) this.#repository.transition(claim, "repairing");
    else this.#repository.transition(claim, "failed", { failedStage: "compiling" });
  }

  async #repair(claim: RunClaim, run: PublicRun, attempt: PublicAttempt, sources: StageSourceContext, signal: AbortSignal, audit: AttemptAudit): Promise<void> {
    const texArtifact = this.#requiredArtifact(run.id, "tailored-tex");
    const logArtifact = this.#requiredArtifact(run.id, "latex-log");
    const failedTex = await this.#readText(texArtifact, ARTIFACT_LIMITS.tex);
    const latexLog = await this.#readText(logArtifact, ARTIFACT_LIMITS.log);
    let candidateCompiles = 0;
    await this.#verifyAgain(run.id, signal);
    const result = await this.#repairAgent({
      attemptSessionId: attempt.attemptSessionId,
      input: {
        failedTexArtifactId: texArtifact.id,
        latexLogArtifactId: logArtifact.id,
        failedTex,
        latexLog,
        canonicalBaseline: sources.baseline,
        operations: {
          validateCandidate: async (tailoredTex, toolSignal) => {
            audit.toolCount += 1;
            toolSignal.throwIfAborted();
            try {
              validateRepairCandidate(failedTex, tailoredTex, sources.baseline);
              return { ok: true, diagnostics: [] };
            } catch (error) {
              return { ok: false, diagnostics: [error instanceof Error ? error.message : String(error)] };
            }
          },
          compileCandidate: async (tailoredTex, toolSignal) => {
            audit.toolCount += 1;
            if (candidateCompiles >= 3) throw new Error("repair candidate compile limit exceeded");
            await this.#verifyAgain(run.id, toolSignal);
            candidateCompiles += 1;
            const compile = await this.#compiler({
              artifacts: this.#artifacts,
              address: { run: run.id, revision: String(run.currentRevision), stage: `repair-candidate-${attempt.attemptNo}`, attempt: candidateCompiles },
              tex: tailoredTex,
              mode: "candidate",
              signal: toolSignal,
              ...(this.#processBoundary ? { processBoundary: this.#processBoundary } : {}),
            });
            audit.compileCount = candidateCompiles;
            toolSignal.throwIfAborted();
            await this.#verifyAgain(run.id, toolSignal);
            return { ok: compile.ok, diagnostics: compile.ok ? [] : [compile.reason] };
          },
        },
      },
      signal,
      ...(this.#agentRuntime ? { runtime: this.#agentRuntime } : {}),
    });
    audit.toolCount += 1;
    signal.throwIfAborted();
    await this.#verifyAgain(run.id, signal);
    const root = await this.#artifacts.createAttempt(this.#address(run, attempt));
    const reportMeta = await this.#artifacts.write(join(root, "repair-report.json"), json(result), JSON_LIMIT);
    this.#finalize(claim, attempt, "repair-report", reportMeta, logArtifact.id);
    if (result.status !== "repaired" || result.tailoredTex === null) {
      this.#repository.finishAttempt(claim, attempt.id, "failed", audit);
      this.#repository.transition(claim, "failed", { failedStage: "repairing" });
      return;
    }
    validateRepairCandidate(failedTex, result.tailoredTex, sources.baseline);
    const texMeta = await this.#artifacts.write(join(root, "resume.tex"), result.tailoredTex, ARTIFACT_LIMITS.tex);
    this.#finalize(claim, attempt, "tailored-tex", texMeta, texArtifact.id);
    this.#repository.finishAttempt(claim, attempt.id, "succeeded", audit);
    this.#repository.transition(claim, "compiling");
  }

  async #deterministic(claim: RunClaim, run: PublicRun, attempt: PublicAttempt, _sources: StageSourceContext, signal: AbortSignal, audit: AttemptAudit): Promise<void> {
    const pdf = this.#requiredArtifact(run.id, "compiled-pdf");
    const log = this.#requiredArtifact(run.id, "latex-log");
    const plan = TailoringPlanSchema.parse(await this.#readJson(this.#requiredArtifact(run.id, "tailoring-plan")));
    const latexLog = await this.#readText(log, ARTIFACT_LIMITS.log);
    await this.#verifyAgain(run.id, signal);
    const report = await this.#deterministicQa({
      pdfPath: pdf.path,
      cwd: dirname(pdf.path),
      requiredHeadings: REQUIRED_HEADINGS,
      selectedEvidenceText: selectedEvidenceText(plan),
      latexLog,
      signal,
      ...(this.#processBoundary ? { boundary: this.#processBoundary } : {}),
    });
    signal.throwIfAborted();
    await this.#verifyAgain(run.id, signal);
    const artifact = await this.#writeJson(run, attempt, "deterministic-qa", report);
    this.#finalize(claim, attempt, "deterministic-qa", artifact, pdf.id);
    if (!report.pass) {
      this.#repository.finishAttempt(claim, attempt.id, "failed", audit);
      this.#repository.transition(claim, "failed", { failedStage: "deterministic_qa" });
      return;
    }
    this.#repository.finishAttempt(claim, attempt.id, "succeeded", audit);
    this.#repository.transition(claim, "visual_qa");
  }

  async #visual(claim: RunClaim, run: PublicRun, attempt: PublicAttempt, _sources: StageSourceContext, signal: AbortSignal, audit: AttemptAudit): Promise<void> {
    const pdf = this.#requiredArtifact(run.id, "compiled-pdf");
    const root = await this.#artifacts.createAttempt(this.#address(run, attempt));
    await this.#verifyAgain(run.id, signal);
    const raster = await this.#rasterizer({
      pdfPath: pdf.path,
      outputPath: join(root, "resume-page-1.png"),
      cwd: root,
      signal,
      ...(this.#processBoundary ? { boundary: this.#processBoundary } : {}),
    });
    signal.throwIfAborted();
    await this.#verifyAgain(run.id, signal);
    const png = await this.#artifacts.read(raster.path, ARTIFACT_LIMITS.png);
    const pngMeta: ArtifactMetadata = {
      path: raster.path,
      bytes: raster.byteSize,
      sha256: createHash("sha256").update(png).digest("hex"),
    };
    this.#finalize(claim, attempt, "page-image", pngMeta, pdf.id);
    await this.#verifyAgain(run.id, signal);
    const visual = await this.#visualInspector(png, attempt.attemptSessionId, signal, this.#gemini);
    signal.throwIfAborted();
    await this.#verifyAgain(run.id, signal);
    const reportMeta = await this.#artifacts.write(join(root, "visual-qa.json"), json(visual), JSON_LIMIT);
    this.#finalize(claim, attempt, "visual-qa", reportMeta, pdf.id);
    this.#repository.finishAttempt(claim, attempt.id, "succeeded", audit);
    this.#repository.transition(claim, "review", { visualAcknowledgementRequired: visual.status !== "pass" });
  }

  #requiredRun(runId: string): PublicRun {
    const run = this.#repository.getRun(runId);
    if (!run) throw new Error("claimed run does not exist");
    return run;
  }

  #requiredArtifact(runId: string, kind: string, revision?: number): PublicArtifact {
    const artifact = this.#repository.getArtifact(runId, kind, revision);
    if (!artifact) throw new Error(`required ${kind} artifact is missing`);
    return artifact;
  }

  async #readText(artifact: PublicArtifact, limit: number): Promise<string> {
    return Buffer.from(await this.#artifacts.read(artifact.path, limit)).toString("utf8");
  }

  async #readJson(artifact: PublicArtifact): Promise<unknown> {
    return JSON.parse(await this.#readText(artifact, JSON_LIMIT));
  }

  async #writeJson(run: PublicRun, attempt: PublicAttempt, name: string, value: unknown): Promise<ArtifactMetadata> {
    const root = await this.#artifacts.createAttempt(this.#address(run, attempt));
    return await this.#artifacts.write(join(root, `${name}.json`), json(value), JSON_LIMIT);
  }

  #address(run: PublicRun, attempt: PublicAttempt): ArtifactAddress {
    return { run: run.id, revision: String(run.currentRevision), stage: attempt.stage, attempt: attempt.attemptNo };
  }

  #finalize(claim: RunClaim, attempt: PublicAttempt, kind: string, metadata: ArtifactMetadata, sourceArtifactId?: string): PublicArtifact {
    return this.#repository.finalizeArtifact(claim, {
      attemptId: attempt.id,
      stage: attempt.stage,
      kind,
      sha256: metadata.sha256,
      path: metadata.path,
      byteSize: metadata.bytes,
      ...(sourceArtifactId ? { sourceArtifactId } : {}),
    });
  }

  async #verifiedSources(runId: string, signal: AbortSignal): Promise<StageSourceContext> {
    signal.throwIfAborted();
    const sources = await this.#loadSourceContext(runId);
    signal.throwIfAborted();
    this.#repository.assertSourceSnapshot(runId, sourceInput(sources.snapshot));
    return sources;
  }

  async #verifyAgain(runId: string, signal: AbortSignal): Promise<void> {
    await this.#verifiedSources(runId, signal);
  }

}
