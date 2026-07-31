import { createHash } from "node:crypto";
import type { ContextSnapshot } from "../context/types.ts";
import { isMustIncludeEvidenceBlock } from "../context/directives.ts";
import { parseBaselineResume } from "./parser.ts";
import { EditResultSchema, JobAnalysisSchema, TailoringPlanSchema, type CommentDisposition, type EditResult, type JobAnalysis, type RepairResult, type TailoringPlan } from "./types.ts";
import { equivalentEntities, ResumeValidationError, validatePlanMustIncludeDirectives } from "./render.ts";

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

export type AnalysisSemanticIssueCode =
  | "job-description-hash"
  | "baseline-hash"
  | "snapshot-baseline-hash"
  | "unknown-evidence"
  | "jd-quote"
  | "jd-phrase"
  | "evidence-provenance"
  | "bullet-target"
  | "bullet-before"
  | "skill-target"
  | "skill-before"
  | "skill-existing"
  | "skill-duplicate"
  | "must-include-placement"
  | "must-include-support"
  | "must-include-required";

export type AnalysisSemanticIssueCategory =
  | "hashes-and-snapshot"
  | "evidence-identifiers"
  | "job-description-grounding"
  | "evidence-provenance"
  | "baseline-targets"
  | "skill-replacements"
  | "must-include-directives";

export interface AnalysisSemanticIssue {
  readonly code: AnalysisSemanticIssueCode;
  readonly category: AnalysisSemanticIssueCategory;
  readonly path: readonly (string | number)[];
  readonly message: string;
}

function semanticIssue(
  code: AnalysisSemanticIssueCode,
  category: AnalysisSemanticIssueCategory,
  path: readonly (string | number)[],
  message: string,
): AnalysisSemanticIssue {
  return { code, category, path, message };
}

export function collectAnalysisSemanticIssues(
  analysisInput: JobAnalysis,
  jobDescriptionSource: string,
  baselineSource: string,
  snapshot: ContextSnapshot,
): readonly AnalysisSemanticIssue[] {
  const analysis = JobAnalysisSchema.parse(analysisInput);
  const baseline = parseBaselineResume(baselineSource);
  const issues: AnalysisSemanticIssue[] = [];
  const jobDescriptionSha256 = createHash("sha256").update(jobDescriptionSource).digest("hex");
  if (analysis.jobDescriptionSha256 !== jobDescriptionSha256) {
    issues.push(semanticIssue(
      "job-description-hash",
      "hashes-and-snapshot",
      ["jobDescriptionSha256"],
      "must match the supplied job description hash",
    ));
  }
  if (analysis.baselineSha256 !== baseline.sha256) {
    issues.push(semanticIssue(
      "baseline-hash",
      "hashes-and-snapshot",
      ["baselineSha256"],
      "must match the supplied baseline hash",
    ));
  }
  if (snapshot.baselineSha256 !== baseline.sha256) {
    issues.push(semanticIssue(
      "snapshot-baseline-hash",
      "hashes-and-snapshot",
      ["baselineSha256"],
      "must match the immutable context snapshot",
    ));
  }

  const evidenceById = new Map(snapshot.evidence.map((block) => [block.id, block]));
  const sourceById = new Map(snapshot.sources.map((source) => [source.id, source]));
  for (let keywordIndex = 0; keywordIndex < analysis.jdKeywords.length; keywordIndex++) {
    const keyword = analysis.jdKeywords[keywordIndex]!;
    for (let evidenceIndex = 0; evidenceIndex < keyword.evidenceIds.length; evidenceIndex++) {
      if (!evidenceById.has(keyword.evidenceIds[evidenceIndex]!)) {
        issues.push(semanticIssue(
          "unknown-evidence",
          "evidence-identifiers",
          ["jdKeywords", keywordIndex, "evidenceIds", evidenceIndex],
          "must contain only supplied evidence IDs",
        ));
      }
    }
  }
  for (let editIndex = 0; editIndex < analysis.exactEdits.length; editIndex++) {
    const edit = analysis.exactEdits[editIndex]!;
    for (let evidenceIndex = 0; evidenceIndex < edit.evidenceIds.length; evidenceIndex++) {
      if (!evidenceById.has(edit.evidenceIds[evidenceIndex]!)) {
        issues.push(semanticIssue(
          "unknown-evidence",
          "evidence-identifiers",
          ["exactEdits", editIndex, "evidenceIds", evidenceIndex],
          "must contain only supplied evidence IDs",
        ));
      }
    }
  }

  for (let keywordIndex = 0; keywordIndex < analysis.jdKeywords.length; keywordIndex++) {
    const keyword = analysis.jdKeywords[keywordIndex]!;
    if (!jobDescriptionSource.includes(keyword.jdQuote)) {
      issues.push(semanticIssue(
        "jd-quote",
        "job-description-grounding",
        ["jdKeywords", keywordIndex, "jdQuote"],
        "must occur verbatim in the supplied job description",
      ));
    }
    if (!keyword.jdQuote.toLocaleLowerCase().includes(keyword.phrase.toLocaleLowerCase())) {
      issues.push(semanticIssue(
        "jd-phrase",
        "job-description-grounding",
        ["jdKeywords", keywordIndex, "phrase"],
        "must occur case-insensitively in its exact JD quote",
      ));
    }
  }

  const bullets = new Map(baseline.bullets.map((bullet) => [bullet.id, bullet]));
  const skills = new Map(baseline.skills.map((skill) => [skill.id, skill]));
  const replacementSkills = new Set<string>();
  const baselineSkills = new Set(baseline.skills.map((skill) => `${skill.category}\u0000${skill.skill}`));
  for (let editIndex = 0; editIndex < analysis.exactEdits.length; editIndex++) {
    const edit = analysis.exactEdits[editIndex]!;
    const evidenceEntityId = edit.kind === "bullet" ? edit.entityId : edit.evidenceEntityId;
    for (let evidenceIndex = 0; evidenceIndex < edit.evidenceIds.length; evidenceIndex++) {
      const evidenceId = edit.evidenceIds[evidenceIndex]!;
      const block = evidenceById.get(evidenceId);
      if (!block) continue;
      const source = sourceById.get(block.sourceId);
      if (source?.kind !== "baseline" && !equivalentEntities(evidenceEntityId, block.entityId, snapshot)) {
        issues.push(semanticIssue(
          "evidence-provenance",
          "evidence-provenance",
          ["exactEdits", editIndex, "evidenceIds", evidenceIndex],
          "must have valid baseline or entity-equivalent provenance",
        ));
      }
    }
    if (edit.kind === "bullet") {
      const bullet = bullets.get(edit.baselineItemId);
      if (!bullet || bullet.section !== edit.section || bullet.entityId !== edit.entityId) {
        issues.push(semanticIssue(
          "bullet-target",
          "baseline-targets",
          ["exactEdits", editIndex, "baselineItemId"],
          "must identify the matching supplied baseline bullet and metadata",
        ));
      } else if (bullet.text !== edit.before) {
        issues.push(semanticIssue(
          "bullet-before",
          "baseline-targets",
          ["exactEdits", editIndex, "before"],
          "must exactly match the supplied baseline bullet text",
        ));
      }
      continue;
    }
    const skill = skills.get(edit.baselineItemId);
    if (!skill || skill.category !== edit.category) {
      issues.push(semanticIssue(
        "skill-target",
        "baseline-targets",
        ["exactEdits", editIndex, "baselineItemId"],
        "must identify the matching supplied baseline skill and category",
      ));
    } else if (skill.skill !== edit.before) {
      issues.push(semanticIssue(
        "skill-before",
        "baseline-targets",
        ["exactEdits", editIndex, "before"],
        "must exactly match the supplied baseline skill text",
      ));
    }
    const replacementKey = `${edit.category}\u0000${edit.after}`;
    if (baselineSkills.has(replacementKey)) {
      issues.push(semanticIssue(
        "skill-existing",
        "skill-replacements",
        ["exactEdits", editIndex, "after"],
        "must not duplicate an existing baseline skill in its category",
      ));
    }
    if (replacementSkills.has(replacementKey)) {
      issues.push(semanticIssue(
        "skill-duplicate",
        "skill-replacements",
        ["exactEdits", editIndex, "after"],
        "must not duplicate another replacement skill in its category",
      ));
    }
    replacementSkills.add(replacementKey);
  }
  const directiveByEvidenceId = new Map(
    snapshot.mustIncludeDirectives.map((directive) => [directive.evidenceId, directive]),
  );
  const mustIncludeEvidenceIds = new Set(
    snapshot.evidence
      .filter((block) => isMustIncludeEvidenceBlock(sourceById.get(block.sourceId), block))
      .map((block) => block.id),
  );
  const hasFactualSupport = (
    evidenceIds: readonly string[],
    directive: ContextSnapshot["mustIncludeDirectives"][number],
  ): boolean => evidenceIds.some((evidenceId) => {
    if (mustIncludeEvidenceIds.has(evidenceId)) return false;
    const block = evidenceById.get(evidenceId);
    const source = block ? sourceById.get(block.sourceId) : undefined;
    return Boolean(block
      && source?.kind === "authoritative-markdown"
      && equivalentEntities(block.entityId, directive.entityId, snapshot));
  });
  const bulletEdits = analysis.exactEdits.filter((edit) => edit.kind === "bullet");
  const activeDirectiveIds = new Set(
    snapshot.mustIncludeDirectives
      .filter((directive) => bulletEdits.some((edit) =>
        hasFactualSupport(edit.evidenceIds, directive)))
      .map((directive) => directive.evidenceId),
  );
  for (let keywordIndex = 0; keywordIndex < analysis.jdKeywords.length; keywordIndex++) {
    const keyword = analysis.jdKeywords[keywordIndex]!;
    for (let evidenceIndex = 0; evidenceIndex < keyword.evidenceIds.length; evidenceIndex++) {
      if (!mustIncludeEvidenceIds.has(keyword.evidenceIds[evidenceIndex]!)) continue;
      issues.push(semanticIssue(
        "must-include-placement",
        "must-include-directives",
        ["jdKeywords", keywordIndex, "evidenceIds", evidenceIndex],
        "must not cite requirement evidence as JD-keyword factual support",
      ));
    }
  }
  for (let editIndex = 0; editIndex < analysis.exactEdits.length; editIndex++) {
    const edit = analysis.exactEdits[editIndex]!;
    for (let evidenceIndex = 0; evidenceIndex < edit.evidenceIds.length; evidenceIndex++) {
      const evidenceId = edit.evidenceIds[evidenceIndex]!;
      if (!mustIncludeEvidenceIds.has(evidenceId)) continue;
      const directive = directiveByEvidenceId.get(evidenceId);
      if (!directive) {
        issues.push(semanticIssue(
          "must-include-placement",
          "must-include-directives",
          ["exactEdits", editIndex, "evidenceIds", evidenceIndex],
          "must not cite non-directive Must Include section evidence",
        ));
        continue;
      }
      if (edit.kind === "skill") {
        issues.push(semanticIssue(
          "must-include-placement",
          "must-include-directives",
          ["exactEdits", editIndex, "evidenceIds", evidenceIndex],
          "must not cite requirement evidence on a skill edit",
        ));
      } else if (!activeDirectiveIds.has(directive.evidenceId)) {
        issues.push(semanticIssue(
          "must-include-support",
          "must-include-directives",
          ["exactEdits", editIndex, "evidenceIds", evidenceIndex],
          "must cite an active requirement with non-directive same-entity factual support",
        ));
      } else if (!hasFactualSupport(edit.evidenceIds, directive)) {
        issues.push(semanticIssue(
          "must-include-support",
          "must-include-directives",
          ["exactEdits", editIndex, "evidenceIds", evidenceIndex],
          "must pair requirement evidence with non-directive same-entity factual support on the same bullet edit",
        ));
      }
    }
  }
  for (let directiveIndex = 0; directiveIndex < snapshot.mustIncludeDirectives.length; directiveIndex++) {
    const directive = snapshot.mustIncludeDirectives[directiveIndex]!;
    if (!activeDirectiveIds.has(directive.evidenceId)) continue;
    const placed = bulletEdits.some((edit) =>
      edit.evidenceIds.includes(directive.evidenceId)
      && hasFactualSupport(edit.evidenceIds, directive));
    if (placed) continue;
    issues.push(semanticIssue(
      "must-include-required",
      "must-include-directives",
      ["mustIncludeDirectives", directiveIndex, "evidenceId"],
      "must be cited on a fact-supported bullet edit when active",
    ));
  }
  return issues;
}

function indexedAnalysisValue(
  analysis: JobAnalysis,
  issue: AnalysisSemanticIssue,
): { readonly edit?: JobAnalysis["exactEdits"][number]; readonly keyword?: JobAnalysis["jdKeywords"][number] } {
  const index = typeof issue.path[1] === "number" ? issue.path[1] : undefined;
  if (issue.path[0] === "exactEdits" && index !== undefined) {
    const edit = analysis.exactEdits[index];
    if (edit) return { edit };
  }
  if (issue.path[0] === "jdKeywords" && index !== undefined) {
    const keyword = analysis.jdKeywords[index];
    if (keyword) return { keyword };
  }
  return {};
}

function failFastSemanticMessage(
  issue: AnalysisSemanticIssue,
  analysis: JobAnalysis,
  snapshot: ContextSnapshot,
): string {
  const { edit, keyword } = indexedAnalysisValue(analysis, issue);
  switch (issue.code) {
    case "job-description-hash":
      return "job analysis job description hash does not match the source";
    case "baseline-hash":
    case "snapshot-baseline-hash":
      return "job analysis baseline hash does not match the source";
    case "unknown-evidence": {
      const evidenceIndex = issue.path[3];
      const evidenceId = typeof evidenceIndex === "number"
        ? (edit?.evidenceIds[evidenceIndex] ?? keyword?.evidenceIds[evidenceIndex])
        : undefined;
      return `job analysis cites unknown evidence ${evidenceId ?? "unknown"}`;
    }
    case "jd-quote":
      return `keyword ${keyword?.id ?? "unknown"} quote does not occur verbatim in the job description`;
    case "jd-phrase":
      return `keyword ${keyword?.id ?? "unknown"} phrase does not occur in its JD quote`;
    case "evidence-provenance": {
      const evidenceIndex = issue.path[3];
      const evidenceId = typeof evidenceIndex === "number" ? edit?.evidenceIds[evidenceIndex] : undefined;
      const block = evidenceId === undefined ? undefined : snapshot.evidence.find((item) => item.id === evidenceId);
      const evidenceEntityId = edit?.kind === "bullet" ? edit.entityId : edit?.evidenceEntityId;
      return `evidence ${evidenceId ?? "unknown"} is attributed to ${block?.entityId ?? "unknown"}, not ${evidenceEntityId ?? "unknown"}`;
    }
    case "bullet-target":
      return `bullet edit ${edit?.id ?? "unknown"} targets an unknown or mismatched baseline item`;
    case "bullet-before":
      return `bullet edit ${edit?.id ?? "unknown"} has stale before text`;
    case "skill-target":
      return `skill edit ${edit?.id ?? "unknown"} targets an unknown or mismatched baseline item`;
    case "skill-before":
      return `skill edit ${edit?.id ?? "unknown"} has stale before text`;
    case "skill-existing":
      return `replacement skill ${edit?.after ?? "unknown"} already exists`;
    case "skill-duplicate":
      return `duplicate replacement skill ${edit?.after ?? "unknown"}`;
    case "must-include-placement": {
      const evidenceIndex = issue.path[3];
      const evidenceId = typeof evidenceIndex === "number"
        ? (edit?.evidenceIds[evidenceIndex] ?? keyword?.evidenceIds[evidenceIndex])
        : undefined;
      const target = keyword ? "a JD keyword" : edit?.kind === "skill" ? "a skill edit" : "a bullet edit";
      return `requirement evidence ${evidenceId ?? "unknown"} cannot be used by ${target}`;
    }
    case "must-include-support": {
      const evidenceIndex = issue.path[3];
      const evidenceId = typeof evidenceIndex === "number" ? edit?.evidenceIds[evidenceIndex] : undefined;
      return `requirement evidence ${evidenceId ?? "unknown"} lacks non-directive same-entity factual support on its bullet edit`;
    }
    case "must-include-required": {
      const directiveIndex = issue.path[1];
      const directive = typeof directiveIndex === "number"
        ? snapshot.mustIncludeDirectives[directiveIndex]
        : undefined;
      return `active must-include directive ${directive?.evidenceId ?? "unknown"} is missing from a supported bullet edit`;
    }
  }
}

export function validateAnalysisAgainstBaseline(
  analysisInput: JobAnalysis,
  jobDescriptionSource: string,
  baselineSource: string,
  snapshot: ContextSnapshot,
): JobAnalysis {
  const analysis = JobAnalysisSchema.parse(analysisInput);
  const issues = collectAnalysisSemanticIssues(analysis, jobDescriptionSource, baselineSource, snapshot);
  const firstIssue = issues[0];
  if (firstIssue) throw new ResumeValidationError(failFastSemanticMessage(firstIssue, analysis, snapshot));
  return analysis;
}

function validateKnownAnalysisEvidence(analysis: JobAnalysis, snapshot: ContextSnapshot): void {
  const evidenceIds = new Set(snapshot.evidence.map((block) => block.id));
  for (const keyword of analysis.jdKeywords) {
    for (const evidenceId of keyword.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) throw new ResumeValidationError(`job analysis cites unknown evidence ${evidenceId}`);
    }
  }
  for (const edit of analysis.exactEdits) {
    for (const evidenceId of edit.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) throw new ResumeValidationError(`job analysis cites unknown evidence ${evidenceId}`);
    }
  }
}

function validateAnalysisPlanMustIncludeContinuity(
  analysis: JobAnalysis,
  plan: TailoringPlan,
  snapshot: ContextSnapshot,
): void {
  const evidenceById = new Map(snapshot.evidence.map((block) => [block.id, block]));
  const sourceById = new Map(snapshot.sources.map((source) => [source.id, source]));
  const mustIncludeEvidenceIds = new Set(
    snapshot.evidence
      .filter((block) => isMustIncludeEvidenceBlock(sourceById.get(block.sourceId), block))
      .map((block) => block.id),
  );
  const hasFactualSupport = (
    evidenceIds: readonly string[],
    directive: ContextSnapshot["mustIncludeDirectives"][number],
  ): boolean => evidenceIds.some((evidenceId) => {
    if (mustIncludeEvidenceIds.has(evidenceId)) return false;
    const block = evidenceById.get(evidenceId);
    const source = block ? sourceById.get(block.sourceId) : undefined;
    return Boolean(block
      && source?.kind === "authoritative-markdown"
      && equivalentEntities(block.entityId, directive.entityId, snapshot));
  });
  const bulletEdits = analysis.exactEdits.filter((edit) => edit.kind === "bullet");
  const includedDecisions = plan.decisions.filter((decision) =>
    decision.action === "add" || decision.action === "rewrite");
  for (const directive of snapshot.mustIncludeDirectives) {
    const active = bulletEdits.some((edit) =>
      hasFactualSupport(edit.evidenceIds, directive));
    if (!active) continue;
    const preserved = includedDecisions.some((decision) =>
      decision.evidenceIds.includes(directive.evidenceId)
      && equivalentEntities(decision.entityId, directive.entityId, snapshot)
      && hasFactualSupport(decision.evidenceIds, directive));
    if (!preserved) {
      throw new ResumeValidationError(`analysis-active must-include directive ${directive.evidenceId} is missing from a supported decision`);
    }
  }
}

export function validateCommentDispositions(comments: readonly string[], dispositions: readonly CommentDisposition[], snapshot: ContextSnapshot): void {
  if (comments.length !== dispositions.length) throw new ResumeValidationError("every comment requires exactly one disposition");
  const indexes = dispositions.map((item) => item.commentIndex);
  if (new Set(indexes).size !== indexes.length || indexes.some((index) => index < 0 || index >= comments.length)) throw new ResumeValidationError("comment dispositions contain missing, duplicate, or unknown indexes");
  const evidenceIds = new Set(snapshot.evidence.map((block) => block.id));
  const sourceById = new Map(snapshot.sources.map((source) => [source.id, source]));
  const mustIncludeEvidenceIds = new Set(
    snapshot.evidence
      .filter((block) => isMustIncludeEvidenceBlock(sourceById.get(block.sourceId), block))
      .map((block) => block.id),
  );
  for (let index = 0; index < comments.length; index++) {
    const comment = comments[index];
    if (!comment?.trim()) throw new ResumeValidationError(`comment ${index} is empty`);
    const disposition = dispositions.find((item) => item.commentIndex === index);
    if (!disposition) throw new ResumeValidationError(`comment ${index} has no disposition`);
    for (const evidenceId of disposition.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) throw new ResumeValidationError(`comment disposition cites unknown evidence ${evidenceId}`);
      if (mustIncludeEvidenceIds.has(evidenceId)) throw new ResumeValidationError(`requirement evidence ${evidenceId} cannot support a comment disposition`);
    }
  }
}

export interface EvidenceLedger {
  readonly version: 2;
  readonly context: { readonly manifestSha256: string; readonly baselineSha256: string; readonly sourceHashes: Readonly<Record<string, string>> };
  readonly analysis: { readonly id: string; readonly sha256: string; readonly jobDescriptionSha256: string; readonly jdKeywords: JobAnalysis["jdKeywords"]; readonly exactEdits: JobAnalysis["exactEdits"] };
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

function analysisEvidenceReferences(analysis: JobAnalysis): readonly (readonly string[])[] {
  return [
    ...analysis.jdKeywords.map((keyword) => keyword.evidenceIds),
    ...analysis.exactEdits.map((edit) => edit.evidenceIds),
  ];
}

export function buildEvidenceLedger(analysisInput: JobAnalysis, planInput: TailoringPlan, snapshot: ContextSnapshot, options: EvidenceLedgerOptions = {}): EvidenceLedger {
  const analysis = JobAnalysisSchema.parse(analysisInput);
  const plan = TailoringPlanSchema.parse(planInput);
  validateAnalysisImmutability(plan, analysis);
  validateKnownAnalysisEvidence(analysis, snapshot);
  validatePlanMustIncludeDirectives(plan, snapshot);
  validateAnalysisPlanMustIncludeContinuity(analysis, plan, snapshot);
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
    version: 2,
    context: { manifestSha256: snapshot.manifestSha256, baselineSha256: snapshot.baselineSha256, sourceHashes: Object.freeze({ ...snapshot.sourceHashes }) },
    analysis: { id: analysis.id, sha256: hashJobAnalysis(analysis), jobDescriptionSha256: analysis.jobDescriptionSha256, jdKeywords: analysis.jdKeywords, exactEdits: analysis.exactEdits },
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
  validatePlanMustIncludeDirectives(result.plan, snapshot);
  validateAnalysisPlanMustIncludeContinuity(analysis, result.plan, snapshot);
  validateCommentDispositions(comments, result.commentDispositions, snapshot);
  validateAppliedCommentEvidence(result.plan, result.commentDispositions);
}
