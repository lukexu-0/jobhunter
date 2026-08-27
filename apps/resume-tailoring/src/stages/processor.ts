import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ANALYSIS_WORKFLOW_SHA256,
  runAtsKeywordExtractionAgent,
  runAnalysisAgent,
  validateAnalysisAgainstAtsKeywordExtraction,
  runEditAgent,
  runRepairAgent,
  runTailoringAgent,
  validateAtsKeywordExtractionAgainstJobDescription,
  validatePersistedAnalysisAgainstAtsKeywordExtraction,
  validatePersistedAtsKeywordExtractionAgainstJobDescription,
  type AgentRuntimeDependencies,
  type ModelTraceEvent,
  type ModelTraceSink,
  type OnePageCorrection,
} from "../agents/index.ts";
import type { ContextSnapshot } from "../context/types.ts";
import { isMustIncludeEvidenceBlock } from "../context/directives.ts";
import { ResumeDiffSchema } from "../contracts/index.ts";
import { ClaimRejectedError, type AttemptArtifactInput, type PublicArtifact, type PublicAttempt, type PublicRun } from "../db/repository.ts";
import { inspectResumePng, type VisualInspectorOptions } from "../models/visual-inspector.ts";
import { compileResume, type CompileResult } from "../resume/compiler.ts";
import { renderKeywordMapArtifacts } from "../resume/keyword-map.ts";
import {
  AtsKeywordExtractionSchema,
  assertResumeDiffMatchesTailoredSource,
  buildResumeDiff,
  buildEvidenceLedger,
  equivalentEntities,
  JobAnalysisSchema,
  type JobAnalysis,
  parseBaselineResume,
  rasterizePdfPage,
  renderEditedResume,
  renderTailoredResume,
  runDeterministicPdfQa,
  TailoringPlanSchema,
  type TailoringPlan,
  validateAnalysisAgainstBaseline,
  validateAnalysisImmutability,
  validateRepairCandidate,
} from "../resume/index.ts";
import { ARTIFACT_LIMITS, ArtifactStore, artifactExists, type ArtifactAddress, type ArtifactMetadata } from "../system/artifacts.ts";
import type { ProcessBoundary } from "../system/process.ts";
import { readProcessStartToken, type RunClaim } from "../worker/claims.ts";
import type { StageRepository, StageSourceContext } from "./types.ts";

const JSON_LIMIT = 2 * 1024 * 1024;
const JOB_DESCRIPTION_LIMIT = 1024 * 1024;
const REQUIRED_HEADINGS = ["Education", "Experience", "Projects", "Competitions & Other", "Technical Skills"] as const;
const MAX_ONE_PAGE_CORRECTIONS = 5;
const MAX_AGENT_TRANSCRIPT_EVENTS = 128;
const MAX_AGENT_TRANSCRIPT_BYTES = JSON_LIMIT - 128 * 1024;
const MAX_AGENT_TRANSCRIPT_PREVIEW_CHARS = 32 * 1024;

function onePageCorrectionNote(pageCount: number, overflowLineCount: number): string {
  const pagesOverLimit = pageCount - 1;
  const pageNoun = pagesOverLimit === 1 ? "page" : "pages";
  const lineNoun = overflowLineCount === 1 ? "line" : "lines";
  return `Resume is ${pageCount} pages, ${pagesOverLimit} ${pageNoun} over the one-page limit, with ${overflowLineCount} visible ${lineNoun} after page 1. Remove lower-priority content until it fits.`;
}

function legacyOnePageCorrectionNote(overflowLineCount: number): string {
  const noun = overflowLineCount === 1 ? "line" : "lines";
  return `${overflowLineCount} visible ${noun} over one page. Remove lower-priority content until it fits.`;
}
const SECTION_OMISSION_PRIORITY: Readonly<Record<OnePageCorrection["candidates"][number]["section"], number>> = {
  "competitions-other": 0,
  projects: 1,
  experience: 2,
};

function mustIncludeSectionEvidenceIds(snapshot: ContextSnapshot): readonly string[] {
  const sourceById = new Map(snapshot.sources.map((source) => [source.id, source]));
  return snapshot.evidence
    .filter((block) => isMustIncludeEvidenceBlock(sourceById.get(block.sourceId), block))
    .map((block) => block.id);
}

interface OnePageCorrectionArtifact {
  readonly failureCount: number;
  readonly pageCount: number | null;
  readonly pagesOverLimit: number | null;
  readonly overflowLineCount: number;
  readonly note: string;
}

function parseOnePageCorrectionArtifact(value: unknown): OnePageCorrectionArtifact {
  if (!value || typeof value !== "object") throw new Error("one-page correction artifact is invalid");
  const candidate = value as Partial<OnePageCorrectionArtifact>;
  if (!Number.isSafeInteger(candidate.failureCount)
    || candidate.failureCount! < 1
    || candidate.failureCount! > MAX_ONE_PAGE_CORRECTIONS) {
    throw new Error("one-page correction failure count is invalid");
  }
  const legacyArtifact = candidate.pageCount === undefined
    && candidate.pagesOverLimit === undefined;
  if (!legacyArtifact) {
    if (!Number.isSafeInteger(candidate.pageCount) || candidate.pageCount! < 2) {
      throw new Error("one-page correction page count is invalid");
    }
    if (!Number.isSafeInteger(candidate.pagesOverLimit)
      || candidate.pagesOverLimit !== candidate.pageCount! - 1) {
      throw new Error("one-page correction page excess is invalid");
    }
  }
  if (!Number.isSafeInteger(candidate.overflowLineCount) || candidate.overflowLineCount! < 1) {
    throw new Error("one-page correction overflow line count is invalid");
  }
  const expectedNote = legacyArtifact
    ? legacyOnePageCorrectionNote(candidate.overflowLineCount!)
    : onePageCorrectionNote(candidate.pageCount!, candidate.overflowLineCount!);
  if (candidate.note !== expectedNote) {
    throw new Error("one-page correction note is invalid");
  }
  return {
    failureCount: candidate.failureCount!,
    pageCount: legacyArtifact ? null : candidate.pageCount!,
    pagesOverLimit: legacyArtifact ? null : candidate.pagesOverLimit!,
    overflowLineCount: candidate.overflowLineCount!,
    note: candidate.note,
  };
}

function validateOnePageCorrectionPlan(
  plan: TailoringPlan,
  correction: OnePageCorrection | undefined,
): void {
  const expected = correction?.candidates.slice(0, correction.requiredOmissionCount) ?? [];
  if (plan.omissions.length !== expected.length) {
    throw new Error("tailoring plan does not apply the current one-page correction strength");
  }
  for (const [index, candidate] of expected.entries()) {
    const omission = plan.omissions[index];
    if (!omission
      || omission.baselineItemId !== candidate.baselineItemId
      || omission.evidenceIds.length !== candidate.evidenceIds.length
      || omission.evidenceIds.some((evidenceId, evidenceIndex) =>
        evidenceId !== candidate.evidenceIds[evidenceIndex])) {
      throw new Error("tailoring plan does not match the current one-page correction");
    }
  }
}

export interface PipelineStageDependencies {
  readonly repository: StageRepository;
  readonly artifacts: ArtifactStore;
  readonly loadSourceContext: (runId: string) => Promise<StageSourceContext> | StageSourceContext;
  readonly agentRuntime?: AgentRuntimeDependencies;
  readonly processBoundary?: ProcessBoundary;
  readonly visualInspectorOptions?: VisualInspectorOptions;
  readonly analysisAgent?: typeof runAnalysisAgent;
  readonly atsKeywordExtractionAgent?: typeof runAtsKeywordExtractionAgent;
  readonly tailoringAgent?: typeof runTailoringAgent;
  readonly editAgent?: typeof runEditAgent;
  readonly repairAgent?: typeof runRepairAgent;
  readonly compiler?: typeof compileResume;
  readonly keywordMapRenderer?: typeof renderKeywordMapArtifacts;
  readonly deterministicQa?: typeof runDeterministicPdfQa;
  readonly rasterizer?: typeof rasterizePdfPage;
  readonly visualInspector?: typeof inspectResumePng;
}

interface AttemptAudit {
  toolCount: number;
  compileCount: number;
}

interface BoundedTranscriptEntry {
  readonly bytes: number;
  readonly serialized: string;
}

class BoundedAgentTranscript implements ModelTraceSink {
  readonly #entries: BoundedTranscriptEntry[] = [];
  #bytes = 0;
  #truncated = false;

  get isEmpty(): boolean {
    return this.#entries.length === 0;
  }

  record(event: ModelTraceEvent): void {
    let serialized: string;
    try {
      serialized = JSON.stringify(event);
    } catch {
      this.#truncated = true;
      return;
    }
    const originalBytes = Buffer.byteLength(serialized);
    let persistedEvent: string;
    let bytes: number;
    if (originalBytes > MAX_AGENT_TRANSCRIPT_BYTES) {
      this.#truncated = true;
      const preview = {
        type: "trace_event_truncated",
        originalType: event.type,
        originalBytes,
        head: serialized.slice(0, MAX_AGENT_TRANSCRIPT_PREVIEW_CHARS),
        tail: serialized.slice(-MAX_AGENT_TRANSCRIPT_PREVIEW_CHARS),
      };
      persistedEvent = JSON.stringify(preview);
      bytes = Buffer.byteLength(persistedEvent);
    } else {
      persistedEvent = serialized;
      bytes = originalBytes;
    }
    this.#entries.push({ bytes, serialized: persistedEvent });
    this.#bytes += bytes;
    while (
      this.#entries.length > MAX_AGENT_TRANSCRIPT_EVENTS
      || this.#bytes > MAX_AGENT_TRANSCRIPT_BYTES
    ) {
      const removed = this.#entries.shift();
      if (!removed) break;
      this.#bytes -= removed.bytes;
      this.#truncated = true;
    }
  }

  serialize(stage: PublicAttempt["stage"], attemptId: string): string {
    const header = JSON.stringify({
      schemaVersion: 1,
      stage,
      attemptId,
      truncated: this.#truncated,
    });
    return `${header.slice(0, -1)},"events":[${this.#entries.map((entry) => entry.serialized).join(",")}]}\n`;
  }
}

function agentRuntimeWithTranscript(
  runtime: AgentRuntimeDependencies | undefined,
  transcript: BoundedAgentTranscript,
): AgentRuntimeDependencies {
  const existingSink = runtime?.modelTraceSink;
  if (!existingSink) return { ...runtime, modelTraceSink: transcript };
  const combinedSink: ModelTraceSink = {
    async record(event) {
      transcript.record(event);
      await existingSink.record(event);
    },
  };
  return { ...runtime, modelTraceSink: combinedSink };
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error instanceof ClaimRejectedError || (error instanceof DOMException && error.name === "AbortError");
}

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function failureDiagnostic(error: unknown): Uint8Array {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : `NonError: ${String(error)}`;
  const redacted = raw
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b((?:access|refresh|id)[_-]?token|api[_-]?key|authorization|password|secret)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return Buffer.from(`${redacted}\n`, "utf8").subarray(0, ARTIFACT_LIMITS.log);
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
  readonly #visualInspectorOptions: VisualInspectorOptions | undefined;
  readonly #analysisAgent: typeof runAnalysisAgent;
  readonly #atsKeywordExtractionAgent: typeof runAtsKeywordExtractionAgent;
  readonly #tailoringAgent: typeof runTailoringAgent;
  readonly #editAgent: typeof runEditAgent;
  readonly #repairAgent: typeof runRepairAgent;
  readonly #compiler: typeof compileResume;
  readonly #keywordMapRenderer: typeof renderKeywordMapArtifacts;
  readonly #deterministicQa: typeof runDeterministicPdfQa;
  readonly #rasterizer: typeof rasterizePdfPage;
  readonly #visualInspector: typeof inspectResumePng;

  constructor(dependencies: PipelineStageDependencies) {
    this.#repository = dependencies.repository;
    this.#artifacts = dependencies.artifacts;
    this.#loadSourceContext = dependencies.loadSourceContext;
    this.#agentRuntime = dependencies.agentRuntime;
    this.#processBoundary = dependencies.processBoundary;
    this.#visualInspectorOptions = dependencies.visualInspectorOptions;
    this.#analysisAgent = dependencies.analysisAgent ?? runAnalysisAgent;
    this.#atsKeywordExtractionAgent =
      dependencies.atsKeywordExtractionAgent ?? runAtsKeywordExtractionAgent;
    this.#tailoringAgent = dependencies.tailoringAgent ?? runTailoringAgent;
    this.#editAgent = dependencies.editAgent ?? runEditAgent;
    this.#repairAgent = dependencies.repairAgent ?? runRepairAgent;
    this.#compiler = dependencies.compiler ?? compileResume;
    this.#keywordMapRenderer = dependencies.keywordMapRenderer ?? renderKeywordMapArtifacts;
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
      const transcript = new BoundedAgentTranscript();
      const agentRuntime = agentRuntimeWithTranscript(this.#agentRuntime, transcript);
      try {
        const sources = await this.#verifiedSources(run.id, signal);
        signal.throwIfAborted();
        const processStartToken = readProcessStartToken();
        if (processStartToken === undefined) throw new Error("worker process identity is unavailable");
        attempt = this.#repository.startAttempt(claim, stage, {
          ...(stage === "repairing" ? { origin: "repair_loop" as const } : {}),
          processPid: process.pid,
          processStartToken,
        });
        await this.#runStage(claim, run, attempt, sources, signal, audit, agentRuntime);
      } catch (error) {
        if (isCancellation(error, signal)) {
          if (attempt) this.#repository.acknowledgeCancellation(attempt.id, claim.token);
          return;
        }
        if (attempt) {
          let failureArtifacts: AttemptArtifactInput[] = [];
          try {
            failureArtifacts = await this.#recordFailure(run, attempt, error, transcript);
          } catch (diagnosticError) {
            console.error("Failed to persist stage diagnostic", diagnosticError);
          }
          try {
            this.#repository.finishAttempt(
              claim,
              attempt.id,
              "failed",
              audit,
              failureArtifacts,
            );
          } catch (finishError) {
            await this.#removeFailureArtifacts(failureArtifacts);
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
    agentRuntime: AgentRuntimeDependencies,
  ): Promise<void> {
    switch (attempt.stage) {
      case "analyzing": await this.#analyze(claim, run, attempt, sources, signal, audit, agentRuntime); return;
      case "tailoring": await this.#tailor(claim, run, attempt, sources, signal, audit, agentRuntime); return;
      case "editing": await this.#edit(claim, run, attempt, sources, signal, audit, agentRuntime); return;
      case "compiling": await this.#compile(claim, run, attempt, sources, signal, audit); return;
      case "repairing": await this.#repair(claim, run, attempt, sources, signal, audit, agentRuntime); return;
      case "deterministic_qa": await this.#deterministic(claim, run, attempt, sources, signal, audit); return;
      case "visual_qa": await this.#visual(claim, run, attempt, sources, signal, audit); return;
    }
  }

  async #analyze(claim: RunClaim, run: PublicRun, attempt: PublicAttempt, sources: StageSourceContext, signal: AbortSignal, audit: AttemptAudit, agentRuntime: AgentRuntimeDependencies): Promise<void> {
    if (this.#repository.getArtifact(run.id, "ats-keyword-extraction")) {
      throw new Error("ATS keyword extraction is immutable once finalized");
    }
    if (this.#repository.getArtifact(run.id, "job-analysis")) {
      throw new Error("job analysis is immutable once finalized");
    }
    const inputArtifact = this.#requiredArtifact(run.id, "job-description");
    const rawJobDescription = await this.#readText(inputArtifact, JOB_DESCRIPTION_LIMIT);
    await this.#verifyAgain(run.id, signal);
    const atsKeywordExtraction = await this.#atsKeywordExtractionAgent({
      attemptSessionId: attempt.attemptSessionId,
      input: {
        opportunityKind: run.opportunityKind,
        rawJobDescription,
      },
      signal,
      runtime: agentRuntime,
    });
    audit.toolCount = 1;
    validateAtsKeywordExtractionAgainstJobDescription(
      atsKeywordExtraction,
      rawJobDescription,
      run.opportunityKind,
    );
    const analysis = await this.#analysisAgent({
      attemptSessionId: attempt.attemptSessionId,
      input: {
        opportunityKind: run.opportunityKind,
        rawJobDescription,
        atsKeywordExtraction,
        canonicalCv: sources.baseline,
        context: sources.snapshot,
      },
      signal,
      runtime: agentRuntime,
    });
    audit.toolCount = 2;
    if (analysis.analysisWorkflowSha256 !== ANALYSIS_WORKFLOW_SHA256) {
      throw new Error("job analysis does not match the configured analysis workflow");
    }
    validateAnalysisAgainstAtsKeywordExtraction(analysis, atsKeywordExtraction, run.opportunityKind);
    validateAnalysisAgainstBaseline(analysis, rawJobDescription, sources.baseline, sources.snapshot);
    signal.throwIfAborted();
    const root = await this.#artifacts.createAttempt(this.#address(run, attempt));
    const extractionMetadata = await this.#artifacts.write(
      join(root, "ats-keyword-extraction.json"),
      json(atsKeywordExtraction),
      JSON_LIMIT,
    );
    const analysisMetadata = await this.#artifacts.write(
      join(root, "job-analysis.json"),
      json(analysis),
      JSON_LIMIT,
    );
    await this.#verifyAgain(run.id, signal);
    const extractionArtifact = this.#finalize(
      claim,
      attempt,
      "ats-keyword-extraction",
      extractionMetadata,
      inputArtifact.id,
    );
    this.#finalize(
      claim,
      attempt,
      "job-analysis",
      analysisMetadata,
      extractionArtifact.id,
    );
    this.#repository.finishAttempt(claim, attempt.id, "succeeded", audit);
    this.#repository.transition(claim, "tailoring");
  }

  async #tailor(claim: RunClaim, run: PublicRun, attempt: PublicAttempt, sources: StageSourceContext, signal: AbortSignal, audit: AttemptAudit, agentRuntime: AgentRuntimeDependencies): Promise<void> {
    const analysisArtifact = this.#requiredArtifact(run.id, "job-analysis");
    const analysis = JobAnalysisSchema.parse(await this.#readJson(analysisArtifact));
    const mustIncludeEvidenceIds = mustIncludeSectionEvidenceIds(sources.snapshot);
    const mustIncludeEvidenceIdSet = new Set(mustIncludeEvidenceIds);
    const correctionArtifact = this.#currentRevisionArtifact(run, "one-page-correction");
    const onePageCorrection = correctionArtifact
      ? await this.#onePageCorrection(correctionArtifact, sources, analysis, mustIncludeEvidenceIdSet)
      : undefined;
    await this.#verifyAgain(run.id, signal);
    const result = await this.#tailoringAgent({
      attemptSessionId: attempt.attemptSessionId,
      input: {
        analysis,
        baseline: sources.baseline,
        mustIncludeEvidenceIds,
        operations: {
          renderPlan: (plan, toolSignal) => {
            toolSignal.throwIfAborted();
            return renderTailoredResume(plan, sources.baseline, sources.snapshot);
          },
        },
        ...(onePageCorrection ? { onePageCorrection } : {}),
      },
      signal,
      runtime: agentRuntime,
    });
    audit.toolCount = result.toolCount;
    validateAnalysisImmutability(result.plan, analysis);
    validateOnePageCorrectionPlan(result.plan, onePageCorrection);
    const tailoredTex = renderTailoredResume(result.plan, sources.baseline, sources.snapshot);
    const ledger = buildEvidenceLedger(analysis, result.plan, sources.snapshot);
    const resumeDiff = buildResumeDiff(sources.baseline, result.plan);
    signal.throwIfAborted();
    await this.#verifyAgain(run.id, signal);
    const root = await this.#artifacts.createAttempt(this.#address(run, attempt));
    const planMeta = await this.#artifacts.write(join(root, "tailoring-plan.json"), json(result.plan), JSON_LIMIT);
    const summaryMeta = await this.#artifacts.write(join(root, "change-summary.json"), json({ planId: result.plan.id, decisions: result.plan.decisions, skillDecisions: result.plan.skillDecisions, omissions: result.plan.omissions }), JSON_LIMIT);
    const diffMeta = await this.#artifacts.write(join(root, "resume-diff.json"), json(resumeDiff), JSON_LIMIT);
    const ledgerMeta = await this.#artifacts.write(join(root, "evidence-ledger.json"), json(ledger), JSON_LIMIT);
    const texMeta = await this.#artifacts.write(join(root, "resume.tex"), tailoredTex, ARTIFACT_LIMITS.tex);
    const sourceArtifactId = correctionArtifact?.id ?? analysisArtifact.id;
    const finalizedPlan = this.#finalize(claim, attempt, "tailoring-plan", planMeta, sourceArtifactId);
    this.#finalize(claim, attempt, "change-summary", summaryMeta, sourceArtifactId);
    this.#finalize(claim, attempt, "resume-diff", diffMeta, finalizedPlan.id);
    this.#finalize(claim, attempt, "evidence-ledger", ledgerMeta, sourceArtifactId);
    this.#finalize(claim, attempt, "tailored-tex", texMeta, sourceArtifactId);
    this.#repository.finishAttempt(claim, attempt.id, "succeeded", audit);
    this.#repository.transition(claim, "compiling");
  }

  async #edit(claim: RunClaim, run: PublicRun, attempt: PublicAttempt, sources: StageSourceContext, signal: AbortSignal, audit: AttemptAudit, agentRuntime: AgentRuntimeDependencies): Promise<void> {
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
        context: sources.snapshot,
        deterministicQa,
        visualQa,
        comments,
        ...(request.origin === "machine_regenerate" ? { machineFindings: { deterministicQa, visualQa } } : {}),
      },
      signal,
      runtime: agentRuntime,
    });
    audit.toolCount = 1;
    const tailoredTex = renderEditedResume(result, comments, analysis, sources.baseline, sources.snapshot);
    const ledger = buildEvidenceLedger(analysis, result.plan, sources.snapshot, { comments, commentDispositions: result.commentDispositions });
    const resumeDiff = buildResumeDiff(sources.baseline, result.plan);
    signal.throwIfAborted();
    await this.#verifyAgain(run.id, signal);
    const root = await this.#artifacts.createAttempt(this.#address(run, attempt));
    const requestMeta = await this.#artifacts.write(join(root, "edit-request.json"), json(request), JSON_LIMIT);
    const reportMeta = await this.#artifacts.write(join(root, "edit-report.json"), json(result), JSON_LIMIT);
    const planMeta = await this.#artifacts.write(join(root, "tailoring-plan.json"), json(result.plan), JSON_LIMIT);
    const summaryMeta = await this.#artifacts.write(join(root, "change-summary.json"), json({ planId: result.plan.id, decisions: result.plan.decisions, skillDecisions: result.plan.skillDecisions, omissions: result.plan.omissions, commentDispositions: result.commentDispositions }), JSON_LIMIT);
    const diffMeta = await this.#artifacts.write(join(root, "resume-diff.json"), json(resumeDiff), JSON_LIMIT);
    const ledgerMeta = await this.#artifacts.write(join(root, "evidence-ledger.json"), json(ledger), JSON_LIMIT);
    const texMeta = await this.#artifacts.write(join(root, "resume.tex"), tailoredTex, ARTIFACT_LIMITS.tex);
    this.#finalize(claim, attempt, "edit-request", requestMeta);
    this.#finalize(claim, attempt, "edit-report", reportMeta, planArtifact.id);
    const finalizedPlan = this.#finalize(claim, attempt, "tailoring-plan", planMeta, planArtifact.id);
    this.#finalize(claim, attempt, "change-summary", summaryMeta, planArtifact.id);
    this.#finalize(claim, attempt, "resume-diff", diffMeta, finalizedPlan.id);
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
    let compiledTexArtifact = texArtifact;
    if (result.tex) compiledTexArtifact = this.#finalize(claim, attempt, "tailored-tex", result.tex, texArtifact.id);
    if (result.ok) {
      this.#finalize(claim, attempt, "compiled-pdf", result.pdf, compiledTexArtifact.id);
      this.#repository.finishAttempt(claim, attempt.id, "succeeded", audit);
      this.#repository.transition(claim, "deterministic_qa");
      return;
    }
    this.#repository.finishAttempt(claim, attempt.id, "failed", audit);
    const repairedInCurrentRevision = this.#repository.getArtifact(run.id, "repair-report")?.revision === run.currentRevision;
    if (result.classification === "repairable" && !repairedInCurrentRevision) this.#repository.transition(claim, "repairing");
    else this.#repository.transition(claim, "failed", { failedStage: "compiling" });
  }

  async #repair(claim: RunClaim, run: PublicRun, attempt: PublicAttempt, sources: StageSourceContext, signal: AbortSignal, audit: AttemptAudit, agentRuntime: AgentRuntimeDependencies): Promise<void> {
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
              validateRepairCandidate(tailoredTex, sources.baseline);
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
              address: { run: run.queueSequence, revision: String(run.currentRevision), stage: `repair-candidate-${attempt.attemptNo}`, attempt: candidateCompiles },
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
      runtime: agentRuntime,
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
    validateRepairCandidate(result.tailoredTex, sources.baseline);
    const diffArtifact = this.#requiredArtifact(run.id, "resume-diff");
    const resumeDiff = ResumeDiffSchema.parse(await this.#readJson(diffArtifact));
    assertResumeDiffMatchesTailoredSource(resumeDiff, result.tailoredTex);
    const texMeta = await this.#artifacts.write(join(root, "resume.tex"), result.tailoredTex, ARTIFACT_LIMITS.tex);
    this.#finalize(claim, attempt, "tailored-tex", texMeta, texArtifact.id);
    this.#repository.finishAttempt(claim, attempt.id, "succeeded", audit);
    this.#repository.transition(claim, "compiling");
  }

  async #deterministic(claim: RunClaim, run: PublicRun, attempt: PublicAttempt, sources: StageSourceContext, signal: AbortSignal, audit: AttemptAudit): Promise<void> {
    const pdf = this.#requiredArtifact(run.id, "compiled-pdf");
    const log = this.#requiredArtifact(run.id, "latex-log");
    const latexLog = await this.#readText(log, ARTIFACT_LIMITS.log);
    await this.#verifyAgain(run.id, signal);
    const report = await this.#deterministicQa({
      pdfPath: pdf.path,
      cwd: dirname(pdf.path),
      requiredHeadings: REQUIRED_HEADINGS,
      latexLog,
      signal,
      ...(this.#processBoundary ? { boundary: this.#processBoundary } : {}),
    });
    signal.throwIfAborted();
    await this.#verifyAgain(run.id, signal);
    const root = await this.#artifacts.createAttempt(this.#address(run, attempt));
    const artifact = await this.#artifacts.write(join(root, "deterministic-qa.json"), json(report), JSON_LIMIT);
    const deterministicArtifact = this.#finalize(claim, attempt, "deterministic-qa", artifact, pdf.id);
    const onePageCheck = report.checks.find((check) => check.id === "one-page");
    const failedChecks = report.checks.filter((check) => check.status === "fail");
    const pureOnePageFailure = !report.pass
      && failedChecks.length === 1
      && failedChecks[0]?.id === "one-page";
    const hasPositiveOverflowLineCount = Number.isSafeInteger(report.overflowLineCount)
      && report.overflowLineCount! > 0;
    const hasValidPageExcess = Number.isSafeInteger(report.pageCount)
      && report.pageCount! >= 2
      && Number.isSafeInteger(report.pagesOverLimit)
      && report.pagesOverLimit === report.pageCount! - 1;
    if (pureOnePageFailure && hasPositiveOverflowLineCount && hasValidPageExcess) {
      const priorArtifact = this.#currentRevisionArtifact(run, "one-page-correction");
      const prior = priorArtifact
        ? parseOnePageCorrectionArtifact(await this.#readJson(priorArtifact))
        : undefined;
      const priorFailureCount = prior?.failureCount ?? 0;
      if (priorFailureCount < MAX_ONE_PAGE_CORRECTIONS) {
        const analysis = JobAnalysisSchema.parse(
          await this.#readJson(this.#requiredArtifact(run.id, "job-analysis")),
        );
        const candidates = this.#onePageCorrectionCandidates(
          sources,
          analysis,
          new Set(mustIncludeSectionEvidenceIds(sources.snapshot)),
        );
        if (priorFailureCount < candidates.length) {
          const correction: OnePageCorrectionArtifact = {
            failureCount: priorFailureCount + 1,
            pageCount: report.pageCount!,
            pagesOverLimit: report.pagesOverLimit!,
            overflowLineCount: report.overflowLineCount!,
            note: onePageCorrectionNote(report.pageCount!, report.overflowLineCount!),
          };
          const correctionMeta = await this.#artifacts.write(
            join(root, "one-page-correction.json"),
            json(correction),
            JSON_LIMIT,
          );
          this.#finalize(claim, attempt, "one-page-correction", correctionMeta, deterministicArtifact.id);
          signal.throwIfAborted();
          await this.#verifyAgain(run.id, signal);
          this.#repository.finishAttempt(claim, attempt.id, "failed", audit);
          this.#repository.transition(claim, "tailoring");
          return;
        }
      }
    }
    if (!report.pass || onePageCheck?.status !== "pass") {
      this.#repository.finishAttempt(claim, attempt.id, "failed", audit);
      this.#repository.transition(claim, "failed", { failedStage: "deterministic_qa" });
      return;
    }
    if (run.generateKeywordMap) {
      const atsKeywordExtraction = AtsKeywordExtractionSchema.parse(
        await this.#readJson(this.#requiredArtifact(run.id, "ats-keyword-extraction")),
      );
      validatePersistedAtsKeywordExtractionAgainstJobDescription(
        atsKeywordExtraction,
        run.jobDescription,
      );
      const analysis = JobAnalysisSchema.parse(
        await this.#readJson(this.#requiredArtifact(run.id, "job-analysis")),
      );
      validatePersistedAnalysisAgainstAtsKeywordExtraction(analysis, atsKeywordExtraction);
      const keywordMap = await this.#keywordMapRenderer({
        artifacts: this.#artifacts,
        compiledPdf: {
          path: pdf.path,
          bytes: pdf.byteSize,
          sha256: pdf.sha256,
        },
        jobDescription: run.jobDescription,
        analysis,
        atsKeywordExtraction,
        signal,
        ...(this.#processBoundary ? { processBoundary: this.#processBoundary } : {}),
      });
      signal.throwIfAborted();
      await this.#verifyAgain(run.id, signal);
      this.#finalize(claim, attempt, "keyword-map-pdf", keywordMap.pdf, pdf.id);
      this.#finalize(claim, attempt, "keyword-map", keywordMap.coverage, pdf.id);
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
    const visual = await this.#visualInspector(png, attempt.attemptSessionId, signal, this.#visualInspectorOptions);
    signal.throwIfAborted();
    await this.#verifyAgain(run.id, signal);
    const reportMeta = await this.#artifacts.write(join(root, "visual-qa.json"), json(visual), JSON_LIMIT);
    this.#finalize(claim, attempt, "visual-qa", reportMeta, pdf.id);
    this.#repository.finishAttempt(claim, attempt.id, "succeeded", audit);
    this.#repository.completeVisualQa(claim, pdf.sha256, visual.status !== "pass");
  }

  async #recordFailure(
    run: PublicRun,
    attempt: PublicAttempt,
    error: unknown,
    transcript: BoundedAgentTranscript,
  ): Promise<AttemptArtifactInput[]> {
    const root = this.#artifacts.attemptRoot(this.#address(run, attempt));
    if (!await artifactExists(root)) await this.#artifacts.createAttempt(this.#address(run, attempt));
    const metadata = await this.#artifacts.write(
      join(root, "stage-error.log"),
      failureDiagnostic(error),
      ARTIFACT_LIMITS.log,
    );
    const failureArtifacts: AttemptArtifactInput[] = [{
      stage: attempt.stage,
      kind: "stage-error",
      sha256: metadata.sha256,
      path: metadata.path,
      byteSize: metadata.bytes,
    }];
    if (transcript.isEmpty) return failureArtifacts;
    try {
      const transcriptMetadata = await this.#artifacts.write(
        join(root, "agent-transcript.json"),
        transcript.serialize(attempt.stage, attempt.id),
        JSON_LIMIT,
      );
      failureArtifacts.push({
        stage: attempt.stage,
        kind: "agent-transcript",
        sha256: transcriptMetadata.sha256,
        path: transcriptMetadata.path,
        byteSize: transcriptMetadata.bytes,
      });
    } catch (transcriptError) {
      console.error("Failed to persist agent transcript", transcriptError);
    }
    return failureArtifacts;
  }

  async #removeFailureArtifacts(artifacts: readonly AttemptArtifactInput[]): Promise<void> {
    await Promise.all(artifacts.map(async (artifact) => {
      try {
        await rm(artifact.path, { force: true });
      } catch (error) {
        console.error("Failed to remove uncommitted stage diagnostic", error);
      }
    }));
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

  async #onePageCorrection(
    artifact: PublicArtifact,
    sources: StageSourceContext,
    analysis: JobAnalysis,
    mustIncludeEvidenceIds: ReadonlySet<string>,
  ): Promise<OnePageCorrection> {
    const state = parseOnePageCorrectionArtifact(await this.#readJson(artifact));
    const candidates = this.#onePageCorrectionCandidates(
      sources,
      analysis,
      mustIncludeEvidenceIds,
    );
    if (candidates.length === 0) {
      throw new Error("one-page correction has no evidence-backed omission candidates");
    }
    return {
      pageCount: state.pageCount,
      pagesOverLimit: state.pagesOverLimit,
      overflowLineCount: state.overflowLineCount,
      note: state.note,
      failureCount: state.failureCount,
      requiredOmissionCount: Math.min(state.failureCount, candidates.length),
      candidates,
    };
  }

  #onePageCorrectionCandidates(
    sources: StageSourceContext,
    analysis: JobAnalysis,
    mustIncludeEvidenceIds: ReadonlySet<string>,
  ): OnePageCorrection["candidates"] {
    const baseline = parseBaselineResume(sources.baseline);
    const baselineSourceIds = new Set(
      sources.snapshot.sources.filter((source) => source.kind === "baseline").map((source) => source.id),
    );
    const editTargets = new Set(analysis.exactEdits.map((edit) => edit.baselineItemId));
    const directiveEvidenceIds = new Set(
      sources.snapshot.mustIncludeDirectives.map((directive) => directive.evidenceId),
    );
    const mustIncludeEditTargets = new Set(
      analysis.exactEdits
        .filter((edit) => edit.kind === "bullet"
          && edit.evidenceIds.some((evidenceId) => directiveEvidenceIds.has(evidenceId)))
        .map((edit) => edit.baselineItemId),
    );
    return baseline.bullets
      .map((bullet, index) => {
        if (mustIncludeEditTargets.has(bullet.id)) return undefined;
        const evidence = sources.snapshot.evidence.find((candidate) =>
          !mustIncludeEvidenceIds.has(candidate.id)
          && baselineSourceIds.has(candidate.sourceId)
          && equivalentEntities(candidate.entityId, bullet.entityId, sources.snapshot))
          ?? sources.snapshot.evidence.find((candidate) =>
            !mustIncludeEvidenceIds.has(candidate.id)
            && equivalentEntities(candidate.entityId, bullet.entityId, sources.snapshot));
        return evidence ? {
          baselineItemId: bullet.id,
          section: bullet.section,
          entityId: bullet.entityId,
          text: bullet.text,
          evidenceIds: [evidence.id],
          priority: SECTION_OMISSION_PRIORITY[bullet.section],
          edited: editTargets.has(bullet.id) ? 1 : 0,
          index,
        } : undefined;
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
      .sort((left, right) =>
        left.edited - right.edited
        || left.priority - right.priority
        || right.index - left.index)
      .map(({ baselineItemId, section, entityId, text, evidenceIds }) => ({
        baselineItemId,
        section,
        entityId,
        text,
        evidenceIds,
      }));
  }

  #currentRevisionArtifact(run: PublicRun, kind: string): PublicArtifact | null {
    const artifact = this.#repository.getArtifact(run.id, kind, run.currentRevision);
    return artifact?.revision === run.currentRevision ? artifact : null;
  }

  #address(run: PublicRun, attempt: PublicAttempt): ArtifactAddress {
    return { run: run.queueSequence, revision: String(run.currentRevision), stage: attempt.stage, attempt: attempt.attemptNo };
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
