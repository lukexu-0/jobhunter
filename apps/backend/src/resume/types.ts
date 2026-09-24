import { z } from "zod";
import { ARTIFACT_LIMITS } from "../system/artifacts.ts";

const Id = z.string().trim().min(1).max(200);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const PlainText = z.string().trim().min(1).max(2_000).refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), "control characters are not allowed");
export const ResumeSectionSchema = z.enum(["experience", "projects", "competitions-other", "technical-skills"]);
export type ResumeSection = z.infer<typeof ResumeSectionSchema>;

export const JobKeywordSchema = z.object({
  id: Id,
  phrase: PlainText,
  jdQuote: PlainText,
}).strict();
export type JobKeyword = z.infer<typeof JobKeywordSchema>;

export const AtsKeywordSchema = z.object({
  id: Id,
  phrase: PlainText,
  jdQuote: PlainText,
}).strict();
export type AtsKeyword = z.infer<typeof AtsKeywordSchema>;

export const AtsKeywordExtractionSchema = z.object({
  schemaVersion: z.literal(1),
  jobDescriptionSha256: Sha256,
  keywordExtractionWorkflowSha256: Sha256,
  keywords: z.array(AtsKeywordSchema).min(1).max(100).readonly(),
}).strict().superRefine((extraction, ctx) => {
  const keywordIds = extraction.keywords.map((keyword) => keyword.id);
  if (new Set(keywordIds).size !== keywordIds.length) {
    ctx.addIssue({ code: "custom", path: ["keywords"], message: "keyword IDs must be unique" });
  }
  const normalizedPhrases = extraction.keywords.map((keyword) => keyword.phrase.toLocaleLowerCase());
  if (new Set(normalizedPhrases).size !== normalizedPhrases.length) {
    ctx.addIssue({
      code: "custom",
      path: ["keywords"],
      message: "keyword phrases must be unique case-insensitively",
    });
  }
});
export type AtsKeywordExtraction = z.infer<typeof AtsKeywordExtractionSchema>;

const KeywordIds = z.array(Id)
  .min(1)
  .max(100)
  .refine((values) => new Set(values).size === values.length, "keyword IDs must be unique")
  .readonly();

export const BulletExactEditSchema = z.object({
  id: Id,
  kind: z.literal("bullet"),
  baselineItemId: Id,
  section: z.enum(["experience", "projects", "competitions-other"]),
  entityId: Id,
  before: PlainText,
  after: PlainText,
  keywordIds: KeywordIds,
}).strict();

export const SkillExactEditSchema = z.object({
  id: Id,
  kind: z.literal("skill"),
  baselineItemId: Id,
  category: PlainText,
  before: PlainText,
  after: PlainText.refine((value) => !value.includes(","), "skill replacement must not contain a comma"),
  keywordIds: KeywordIds,
}).strict();

export const ExactEditSchema = z.discriminatedUnion("kind", [BulletExactEditSchema, SkillExactEditSchema]);
export type ExactEdit = z.infer<typeof ExactEditSchema>;

export const JobAnalysisSchema = z.object({
  schemaVersion: z.literal(2),
  id: Id,
  jobDescriptionSha256: Sha256,
  analysisWorkflowSha256: Sha256,
  baselineSha256: Sha256,
  target: z.object({
    title: PlainText,
    organization: PlainText,
  }).strict(),
  jdKeywords: z.array(JobKeywordSchema).max(100).readonly(),
  exactEdits: z.array(ExactEditSchema).max(500).readonly(),
}).strict().superRefine((analysis, ctx) => {
  const keywordIds = analysis.jdKeywords.map((keyword) => keyword.id);
  if (new Set(keywordIds).size !== keywordIds.length) {
    ctx.addIssue({ code: "custom", path: ["jdKeywords"], message: "keyword IDs must be unique" });
  }
  const editIds = analysis.exactEdits.map((edit) => edit.id);
  if (new Set(editIds).size !== editIds.length) {
    ctx.addIssue({ code: "custom", path: ["exactEdits"], message: "edit IDs must be unique" });
  }
  const baselineItemIds = analysis.exactEdits.map((edit) => edit.baselineItemId);
  if (new Set(baselineItemIds).size !== baselineItemIds.length) {
    ctx.addIssue({ code: "custom", path: ["exactEdits"], message: "baseline item targets must be unique" });
  }
  const keywords = new Map(analysis.jdKeywords.map((keyword) => [keyword.id, keyword]));
  for (const [editIndex, edit] of analysis.exactEdits.entries()) {
    if (edit.before === edit.after) {
      ctx.addIssue({ code: "custom", path: ["exactEdits", editIndex, "after"], message: "replacement must change the baseline text" });
    }
    for (const [keywordIndex, keywordId] of edit.keywordIds.entries()) {
      const keyword = keywords.get(keywordId);
      if (!keyword) {
        ctx.addIssue({ code: "custom", path: ["exactEdits", editIndex, "keywordIds", keywordIndex], message: `unknown keyword ID ${keywordId}` });
        continue;
      }
      if (!edit.after.toLocaleLowerCase().includes(keyword.phrase.toLocaleLowerCase())) {
        ctx.addIssue({ code: "custom", path: ["exactEdits", editIndex, "after"], message: `replacement does not contain linked keyword ${keywordId}` });
      }
    }
  }
});
export type JobAnalysis = z.infer<typeof JobAnalysisSchema>;

export const TailoringDecisionSchema = z.object({
  id: Id,
  section: z.enum(["experience", "projects", "competitions-other"]),
  entityId: Id,
  baselineItemId: Id.nullable(),
  action: z.enum(["retain", "rewrite", "add", "omit"]),
  text: PlainText.nullable(),
  rationale: PlainText,
}).strict().superRefine((decision, ctx) => {
  if ((decision.action === "retain" || decision.action === "rewrite" || decision.action === "omit") && decision.baselineItemId === null) {
    ctx.addIssue({ code: "custom", path: ["baselineItemId"], message: `${decision.action} requires a baseline item` });
  }
  if (decision.action === "add" && decision.baselineItemId !== null) ctx.addIssue({ code: "custom", path: ["baselineItemId"], message: "add must not identify a baseline item" });
  if (decision.action === "omit" && decision.text !== null) ctx.addIssue({ code: "custom", path: ["text"], message: "omit must not contain text" });
  if (decision.action !== "omit" && decision.text === null) ctx.addIssue({ code: "custom", path: ["text"], message: `${decision.action} requires text` });
});
export type TailoringDecision = z.infer<typeof TailoringDecisionSchema>;

export const SkillDecisionSchema = z.object({
  id: Id,
  category: PlainText,
  skill: PlainText,
  action: z.enum(["retain", "add", "omit"]),
  rationale: PlainText,
}).strict();
export type SkillDecision = z.infer<typeof SkillDecisionSchema>;

export const BaselineOverrideSchema = z.object({
  baselineItemId: Id,
  replacement: PlainText,
  rationale: PlainText,
}).strict();

export const CommentDispositionSchema = z.object({
  commentIndex: z.number().int().nonnegative(),
  status: z.enum(["applied", "rejected", "clarification-needed"]),
  rationale: PlainText,
}).strict();
export type CommentDisposition = z.infer<typeof CommentDispositionSchema>;

export const TailoringPlanSchema = z.object({
  id: Id,
  analysisId: Id,
  analysisSha256: Sha256,
  tailoringWorkflowSha256: Sha256,
  decisions: z.array(TailoringDecisionSchema).max(500).readonly(),
  projectOrder: z.array(Id).max(100).readonly(),
  skillDecisions: z.array(SkillDecisionSchema).max(500).readonly(),
  baselineOverrides: z.array(BaselineOverrideSchema).max(100).readonly(),
  omissions: z.array(z.object({ baselineItemId: Id, rationale: PlainText }).strict()).max(500).readonly(),
}).strict();
export type TailoringPlan = z.infer<typeof TailoringPlanSchema>;


export const TailoringResultSchema = z.object({
  plan: TailoringPlanSchema,
  toolCount: z.number().int().min(4).max(101),
}).strict();
export type TailoringResult = z.infer<typeof TailoringResultSchema>;

export const EditResultSchema = z.object({
  plan: TailoringPlanSchema,
  commentDispositions: z.array(CommentDispositionSchema).max(100).readonly(),
}).strict();
export type EditResult = z.infer<typeof EditResultSchema>;

export const RepairChangeSchema = z.object({
  category: z.enum(["syntax", "macro-call", "escaping"]),
  summary: PlainText,
}).strict();

export const RepairResultSchema = z.object({
  status: z.enum(["repaired", "unrepaired"]),
  tailoredTex: z.string().max(ARTIFACT_LIMITS.tex).nullable(),
  changes: z.array(RepairChangeSchema).max(100).readonly(),
  remainingDiagnostics: z.array(z.string().max(2_000)).max(100).readonly(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "repaired" && value.tailoredTex === null) ctx.addIssue({ code: "custom", path: ["tailoredTex"], message: "repaired result requires TeX" });
  if (value.status === "unrepaired" && value.tailoredTex !== null) ctx.addIssue({ code: "custom", path: ["tailoredTex"], message: "unrepaired result cannot contain TeX" });
});
export type RepairResult = z.infer<typeof RepairResultSchema>;
