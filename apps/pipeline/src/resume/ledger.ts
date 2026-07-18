import { createHash } from "node:crypto";
import type { ContextSnapshot } from "../context/types.ts";
import { extractMustIncludeDirectives } from "../context/directives.ts";
import { EditResultSchema, JobAnalysisSchema, TailoringPlanSchema, type CommentDisposition, type EditResult, type JobAnalysis, type RepairResult, type TailoringPlan } from "./types.ts";
import { equivalentEntities, ResumeValidationError, validatePlanDirectives } from "./render.ts";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function hashJobAnalysis(analysisInput: JobAnalysis): string {
  const analysis = JobAnalysisSchema.parse(analysisInput);
  return createHash("sha256").update(canonicalJson(analysis)).digest("hex");
}

export function validateAnalysisImmutability(planInput: TailoringPlan, analysisInput: JobAnalysis): void {
  const plan = TailoringPlanSchema.parse(planInput);
  const analysis = JobAnalysisSchema.parse(analysisInput);
  if (plan.analysisId !== analysis.id || plan.analysisSha256 !== hashJobAnalysis(analysis)) throw new ResumeValidationError("tailoring plan does not reference the immutable job analysis");
}

function analysisEvidenceReferences(analysis: JobAnalysis): readonly (readonly string[])[] {
  return [
    ...analysis.requirementEvidence.map((item) => item.evidenceIds),
    ...analysis.recruiterRisks.map((item) => item.evidenceIds),
    ...analysis.gapsAndMitigations.map((item) => item.evidenceIds),
    ...analysis.keywordAlignment.map((item) => item.evidenceIds),
    ...analysis.proposedCvContent.technicalSkills.map((item) => item.evidenceIds),
    ...analysis.proposedCvContent.reorderedExperience.flatMap((item) => item.bullets.map((bullet) => bullet.evidenceIds)),
    ...analysis.proposedCvContent.selectedProjects.map((item) => item.evidenceIds),
    ...analysis.businessValueBulletReview.map((item) => item.evidenceIds),
    analysis.atsAndTruthfulnessReview.parseableSingleColumnStructure.evidenceIds,
    analysis.atsAndTruthfulnessReview.standardSectionHeaders.evidenceIds,
    analysis.atsAndTruthfulnessReview.selectableUtf8Text.evidenceIds,
    analysis.atsAndTruthfulnessReview.truthfulKeywordUse.evidenceIds,
    analysis.atsAndTruthfulnessReview.noHiddenTextOrKeywordStuffing.evidenceIds,
    analysis.atsAndTruthfulnessReview.noUnsupportedSkillsOrMetrics.evidenceIds,
    ...analysis.customizationPlan.map((item) => item.evidenceIds),
  ];
}

export function validateAnalysisDirectives(analysisInput: JobAnalysis, snapshot: ContextSnapshot): void {
  const analysis = JobAnalysisSchema.parse(analysisInput);
  const extractedDirectives = extractMustIncludeDirectives(snapshot.sources, snapshot.evidence);
  if (JSON.stringify(snapshot.mustIncludeDirectives) !== JSON.stringify(extractedDirectives)) {
    throw new ResumeValidationError("context snapshot must-include directives do not match heading-backed evidence");
  }
  const evidenceById = new Map(snapshot.evidence.map((block) => [block.id, block]));
  const directiveByEvidenceId = new Map(snapshot.mustIncludeDirectives.map((directive) => [directive.evidenceId, directive]));
  const allReferences = analysisEvidenceReferences(analysis);
  for (const evidenceId of allReferences.flat()) {
    if (!evidenceById.has(evidenceId)) throw new ResumeValidationError(`job analysis cites unknown evidence ${evidenceId}`);
  }
  const proposedItems = [
    ...analysis.proposedCvContent.reorderedExperience.flatMap((experience) => experience.bullets),
    ...analysis.proposedCvContent.selectedProjects,
  ];
  const activatedDirectiveIds = new Set<string>();
  for (const directive of snapshot.mustIncludeDirectives) {
    const supportingItems = proposedItems.filter((item) => item.evidenceIds.some((evidenceId) => {
      if (directiveByEvidenceId.has(evidenceId)) return false;
      const evidence = evidenceById.get(evidenceId);
      return evidence !== undefined && equivalentEntities(evidence.entityId, directive.entityId, snapshot);
    }));
    if (supportingItems.length === 0) continue;
    activatedDirectiveIds.add(directive.evidenceId);
    if (!supportingItems.some((item) => item.evidenceIds.includes(directive.evidenceId))) {
      throw new ResumeValidationError(`proposed content for ${directive.entityId} omits must-include directive ${directive.evidenceId}`);
    }
  }
  for (const item of proposedItems) {
    for (const evidenceId of item.evidenceIds) {
      const directive = directiveByEvidenceId.get(evidenceId);
      if (!directive) continue;
      const hasSupportingEvidence = item.evidenceIds.some((supportingId) => {
        if (directiveByEvidenceId.has(supportingId)) return false;
        const evidence = evidenceById.get(supportingId);
        return evidence !== undefined && equivalentEntities(evidence.entityId, directive.entityId, snapshot);
      });
      if (!hasSupportingEvidence) {
        throw new ResumeValidationError(`proposed content misattributes must-include directive ${evidenceId}`);
      }
    }
  }
  for (const evidenceId of allReferences.flat()) {
    if (directiveByEvidenceId.has(evidenceId) && !activatedDirectiveIds.has(evidenceId)) {
      throw new ResumeValidationError(`inactive must-include directive ${evidenceId} cannot be cited as evidence`);
    }
  }
}

export function validateCommentDispositions(comments: readonly string[], dispositions: readonly CommentDisposition[], snapshot: ContextSnapshot): void {
  if (comments.length !== dispositions.length) throw new ResumeValidationError("every comment requires exactly one disposition");
  const indexes = dispositions.map((item) => item.commentIndex);
  if (new Set(indexes).size !== indexes.length || indexes.some((index) => index < 0 || index >= comments.length)) throw new ResumeValidationError("comment dispositions contain missing, duplicate, or unknown indexes");
  const evidenceIds = new Set(snapshot.evidence.map((block) => block.id));
  for (let index = 0; index < comments.length; index++) {
    const comment = comments[index];
    if (!comment?.trim()) throw new ResumeValidationError(`comment ${index} is empty`);
    const disposition = dispositions.find((item) => item.commentIndex === index);
    if (!disposition) throw new ResumeValidationError(`comment ${index} has no disposition`);
    for (const evidenceId of disposition.evidenceIds) if (!evidenceIds.has(evidenceId)) throw new ResumeValidationError(`comment disposition cites unknown evidence ${evidenceId}`);
  }
}

export interface EvidenceLedger {
  readonly version: 1;
  readonly context: { readonly manifestSha256: string; readonly baselineSha256: string; readonly sourceHashes: Readonly<Record<string, string>> };
  readonly analysis: { readonly id: string; readonly sha256: string; readonly jobDescriptionSha256: string; readonly keywordCitations: readonly { readonly keyword: string; readonly jdQuote: string; readonly evidenceIds: readonly string[] }[] };
  readonly plan: { readonly id: string; readonly tailoringWorkflowSha256: string; readonly decisions: TailoringPlan["decisions"]; readonly projectOrder: readonly string[]; readonly skillDecisions: TailoringPlan["skillDecisions"]; readonly factWinners: TailoringPlan["factWinners"]; readonly baselineOverrides: TailoringPlan["baselineOverrides"]; readonly omissions: TailoringPlan["omissions"] };
  readonly entityBindings: Readonly<Record<string, string>>;
  readonly citations: readonly { readonly evidenceId: string; readonly sourceId: string; readonly sourceVersionId: string; readonly entityId: string; readonly caveats: readonly string[]; readonly sha256: string }[];
  readonly comments: readonly { readonly index: number; readonly text: string; readonly disposition: CommentDisposition }[];
  readonly repairs: readonly { readonly status: RepairResult["status"]; readonly changes: RepairResult["changes"]; readonly remainingDiagnostics: readonly string[] }[];
}

export interface EvidenceLedgerOptions {
  readonly comments?: readonly string[];
  readonly commentDispositions?: readonly CommentDisposition[];
  readonly repairHistory?: readonly RepairResult[];
}

export function buildEvidenceLedger(analysisInput: JobAnalysis, planInput: TailoringPlan, snapshot: ContextSnapshot, options: EvidenceLedgerOptions = {}): EvidenceLedger {
  const analysis = JobAnalysisSchema.parse(analysisInput);
  const plan = TailoringPlanSchema.parse(planInput);
  validateAnalysisImmutability(plan, analysis);
  validateAnalysisDirectives(analysis, snapshot);
  validatePlanDirectives(plan, snapshot);
  const comments = options.comments ?? [];
  const dispositions = options.commentDispositions ?? [];
  validateCommentDispositions(comments, dispositions, snapshot);
  validateAppliedCommentEvidence(plan, dispositions);
  const evidenceById = new Map(snapshot.evidence.map((block) => [block.id, block]));
  const cited = new Set<string>();
  for (const evidenceIds of analysisEvidenceReferences(analysis)) for (const id of evidenceIds) cited.add(id);
  for (const decision of plan.decisions) for (const id of decision.evidenceIds) cited.add(id);
  for (const skill of plan.skillDecisions) for (const id of skill.evidenceIds) cited.add(id);
  for (const omission of plan.omissions) for (const id of omission.evidenceIds) cited.add(id);
  for (const override of plan.baselineOverrides) for (const id of override.evidenceIds) cited.add(id);
  for (const winner of plan.factWinners) cited.add(winner.evidenceId);
  for (const disposition of dispositions) for (const id of disposition.evidenceIds) cited.add(id);
  const citations = [...cited].sort().map((id) => {
    const block = evidenceById.get(id);
    if (!block) throw new ResumeValidationError(`evidence ledger cites unknown evidence ${id}`);
    return { evidenceId: id, sourceId: block.sourceId, sourceVersionId: block.sourceVersionId, entityId: block.entityId, caveats: block.caveats, sha256: block.sha256 };
  });
  return {
    version: 1,
    context: { manifestSha256: snapshot.manifestSha256, baselineSha256: snapshot.baselineSha256, sourceHashes: Object.freeze({ ...snapshot.sourceHashes }) },
    analysis: { id: analysis.id, sha256: hashJobAnalysis(analysis), jobDescriptionSha256: analysis.jobDescriptionSha256, keywordCitations: analysis.keywordAlignment.map(({ jdVocabulary: keyword, jdQuote, evidenceIds }) => ({ keyword, jdQuote, evidenceIds })) },
    plan: { id: plan.id, tailoringWorkflowSha256: plan.tailoringWorkflowSha256, decisions: plan.decisions, projectOrder: plan.projectOrder, skillDecisions: plan.skillDecisions, factWinners: plan.factWinners, baselineOverrides: plan.baselineOverrides, omissions: plan.omissions },
    entityBindings: Object.freeze({ ...snapshot.explicitEntityBindings }),
    citations,
    comments: comments.map((text, index) => ({ index, text, disposition: dispositions.find((item) => item.commentIndex === index)! })),
    repairs: (options.repairHistory ?? []).map((repair) => ({ status: repair.status, changes: repair.changes, remainingDiagnostics: repair.remainingDiagnostics })),
  };
}
function validateAppliedCommentEvidence(plan: TailoringPlan, dispositions: readonly CommentDisposition[]): void {
  const planEvidence = new Set([
    ...plan.decisions.flatMap((decision) => decision.evidenceIds),
    ...plan.skillDecisions.flatMap((decision) => decision.evidenceIds),
    ...plan.baselineOverrides.flatMap((override) => override.evidenceIds),
  ]);
  for (const disposition of dispositions) {
    if (disposition.status !== "applied") continue;
    for (const evidenceId of disposition.evidenceIds) {
      if (!planEvidence.has(evidenceId)) throw new ResumeValidationError(`applied comment evidence ${evidenceId} is not used by the resulting plan`);
    }
  }
}


export function validateEditResult(resultInput: EditResult, comments: readonly string[], analysis: JobAnalysis, snapshot: ContextSnapshot): void {
  const result = EditResultSchema.parse(resultInput);
  validateAnalysisImmutability(result.plan, analysis);
  validatePlanDirectives(result.plan, snapshot);
  validateCommentDispositions(comments, result.commentDispositions, snapshot);
  validateAppliedCommentEvidence(result.plan, result.commentDispositions);
}
