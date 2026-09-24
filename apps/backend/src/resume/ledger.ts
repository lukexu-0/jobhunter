import { createHash } from "node:crypto";
import type { ContextSnapshot } from "../context/types.ts";
import { parseBaselineResume } from "./parser.ts";
import { EditResultSchema, JobAnalysisSchema, TailoringPlanSchema, type CommentDisposition, type EditResult, type JobAnalysis, type TailoringPlan } from "./types.ts";
import { ResumeValidationError } from "./render.ts";

export function canonicalJson(value: unknown): string {
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
  | "jd-quote"
  | "jd-phrase"
  | "bullet-target"
  | "bullet-before"
  | "skill-target"
  | "skill-before"
  | "skill-existing"
  | "skill-duplicate";

export type AnalysisSemanticIssueCategory =
  | "hashes-and-snapshot"
  | "job-description-grounding"
  | "baseline-targets"
  | "skill-replacements";

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
): string {
  const { edit, keyword } = indexedAnalysisValue(analysis, issue);
  switch (issue.code) {
    case "job-description-hash":
      return "job analysis job description hash does not match the source";
    case "baseline-hash":
    case "snapshot-baseline-hash":
      return "job analysis baseline hash does not match the source";
    case "jd-quote":
      return `keyword ${keyword?.id ?? "unknown"} quote does not occur verbatim in the job description`;
    case "jd-phrase":
      return `keyword ${keyword?.id ?? "unknown"} phrase does not occur in its JD quote`;
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
  if (firstIssue) throw new ResumeValidationError(failFastSemanticMessage(firstIssue, analysis));
  return analysis;
}

export function validateCommentDispositions(comments: readonly string[], dispositions: readonly CommentDisposition[]): void {
  if (comments.length !== dispositions.length) throw new ResumeValidationError("every comment requires exactly one disposition");
  const indexes = dispositions.map((item) => item.commentIndex);
  if (new Set(indexes).size !== indexes.length || indexes.some((index) => index < 0 || index >= comments.length)) throw new ResumeValidationError("comment dispositions contain missing, duplicate, or unknown indexes");
  for (let index = 0; index < comments.length; index++) {
    const comment = comments[index];
    if (!comment?.trim()) throw new ResumeValidationError(`comment ${index} is empty`);
    const disposition = dispositions.find((item) => item.commentIndex === index);
    if (!disposition) throw new ResumeValidationError(`comment ${index} has no disposition`);
  }
}

export function validateEditResult(resultInput: EditResult, comments: readonly string[], analysis: JobAnalysis): void {
  const result = EditResultSchema.parse(resultInput);
  validateAnalysisImmutability(result.plan, analysis);
  validateCommentDispositions(comments, result.commentDispositions);
}
