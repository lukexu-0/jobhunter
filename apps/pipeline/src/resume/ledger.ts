import { createHash } from "node:crypto";
import type { ContextSnapshot } from "../context/types.ts";
import { EditResultSchema, JobAnalysisSchema, TailoringPlanSchema, type CommentDisposition, type EditResult, type JobAnalysis, type RepairResult, type TailoringPlan } from "./types.ts";
import { ResumeValidationError } from "./render.ts";

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
  readonly plan: { readonly id: string; readonly decisions: TailoringPlan["decisions"]; readonly projectOrder: readonly string[]; readonly skillDecisions: TailoringPlan["skillDecisions"]; readonly factWinners: TailoringPlan["factWinners"]; readonly baselineOverrides: TailoringPlan["baselineOverrides"]; readonly omissions: TailoringPlan["omissions"] };
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
  const comments = options.comments ?? [];
  const dispositions = options.commentDispositions ?? [];
  validateCommentDispositions(comments, dispositions, snapshot);
  validateAppliedCommentEvidence(plan, dispositions);
  const evidenceById = new Map(snapshot.evidence.map((block) => [block.id, block]));
  const cited = new Set<string>();
  for (const keyword of analysis.prioritizedKeywords) for (const id of keyword.evidenceIds) cited.add(id);
  for (const guidance of analysis.guidance) for (const id of guidance.evidenceIds) cited.add(id);
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
    analysis: { id: analysis.id, sha256: hashJobAnalysis(analysis), jobDescriptionSha256: analysis.jobDescriptionSha256, keywordCitations: analysis.prioritizedKeywords.map(({ keyword, jdQuote, evidenceIds }) => ({ keyword, jdQuote, evidenceIds })) },
    plan: { id: plan.id, decisions: plan.decisions, projectOrder: plan.projectOrder, skillDecisions: plan.skillDecisions, factWinners: plan.factWinners, baselineOverrides: plan.baselineOverrides, omissions: plan.omissions },
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
  validateCommentDispositions(comments, result.commentDispositions, snapshot);
  validateAppliedCommentEvidence(result.plan, result.commentDispositions);
}
