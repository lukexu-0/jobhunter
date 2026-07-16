import { z } from "zod";

const Id = z.string().trim().min(1).max(200);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const PlainText = z.string().trim().min(1).max(2_000).refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), "control characters are not allowed");
const EvidenceIds = z.array(Id).min(1).max(32).readonly();

const AnalysisEvidenceIds = z.array(Id).max(32).readonly();
const EvidenceBackedTextSchema = z.object({
  text: PlainText,
  evidenceIds: AnalysisEvidenceIds,
}).strict();
const RequiredClarityFindingSchema = z.object({
  status: z.enum(["clear", "revise"]),
  evidenceOrRequiredRewrite: PlainText,
  evidenceIds: AnalysisEvidenceIds,
}).strict();
const OptionalClarityFindingSchema = z.object({
  status: z.enum(["clear", "revise", "not-applicable"]),
  evidenceOrRequiredRewrite: PlainText,
  evidenceIds: AnalysisEvidenceIds,
}).strict();
const AtsFindingSchema = z.object({
  status: z.enum(["pass", "revise"]),
  requiredAction: PlainText,
  evidenceIds: AnalysisEvidenceIds,
}).strict();

export const ResumeSectionSchema = z.enum(["experience", "projects", "competitions-other", "technical-skills"]);
export type ResumeSection = z.infer<typeof ResumeSectionSchema>;

export const JobAnalysisSchema = z.object({
  id: Id,
  jobDescriptionSha256: Sha256,
  analysisWorkflowSha256: Sha256,
  roleSummary: z.object({
    company: PlainText,
    role: PlainText,
    archetype: PlainText,
    domain: z.enum(["platform", "agentic", "LLMOps", "ML", "enterprise", "not-mentioned"]),
    function: z.enum(["build", "consult", "manage", "deploy", "not-mentioned"]),
    seniority: PlainText,
    workModel: z.enum(["full-remote", "hybrid", "onsite", "not-mentioned"]),
    teamSize: PlainText,
    tldr: PlainText,
  }).strict(),
  requirementEvidence: z.array(z.object({
    requirement: PlainText,
    priority: z.enum(["high", "medium", "low"]),
    exactCvEvidence: PlainText,
    cvSourceLines: z.array(PlainText).max(32).readonly(),
    matchStatus: z.enum(["direct", "adjacent", "gap"]),
    evidenceIds: AnalysisEvidenceIds,
  }).strict()).min(1).max(100).readonly(),
  recruiterRisks: z.array(z.object({
    potentialDoubt: PlainText,
    evidenceFromCvOrReport: PlainText,
    candidateFacingFix: PlainText,
    evidenceIds: AnalysisEvidenceIds,
  }).strict()).min(1).max(50).readonly(),
  gapsAndMitigations: z.array(z.object({
    gap: PlainText,
    classification: z.enum(["hard-blocker", "nice-to-have"]),
    adjacentExperience: PlainText,
    portfolioProof: PlainText,
    concreteMitigation: PlainText,
    evidenceIds: AnalysisEvidenceIds,
  }).strict()).min(1).max(50).readonly(),
  keywordAlignment: z.array(z.object({
    jdVocabulary: PlainText,
    jdQuote: PlainText,
    currentTruthfulCvWording: PlainText,
    recommendedReformulation: PlainText,
    placement: z.enum(["Summary", "Experience", "Skills", "Projects"]),
    evidenceIds: AnalysisEvidenceIds,
  }).strict()).min(1).max(100).readonly(),
  proposedCvContent: z.object({
    professionalSummary: EvidenceBackedTextSchema,
    coreCompetencies: z.array(EvidenceBackedTextSchema).min(6).max(8).readonly(),
    reorderedExperience: z.array(z.object({
      roleOrCompany: PlainText,
      bullets: z.array(EvidenceBackedTextSchema).min(1).max(50).readonly(),
    }).strict()).min(1).max(50).readonly(),
    selectedProjects: z.array(EvidenceBackedTextSchema).min(3).max(4).readonly(),
  }).strict(),
  businessValueBulletReview: z.array(z.object({
    currentBullet: PlainText,
    proposedBullet: PlainText,
    action: PlainText,
    systemOrScope: PlainText,
    toolOrApproach: PlainText,
    outcomeOrProof: PlainText,
    evidenceIds: AnalysisEvidenceIds,
  }).strict()).min(1).max(100).readonly(),
  sixSecondClarityGate: z.object({
    targetRoleOrArchetype: RequiredClarityFindingSchema,
    strongestMatchingStackOrDomain: RequiredClarityFindingSchema,
    productionOrBusinessOutcome: RequiredClarityFindingSchema,
    appropriateLocationOrRemoteFit: OptionalClarityFindingSchema,
    relevantPortfolioOrCaseStudyLink: OptionalClarityFindingSchema,
  }).strict(),
  atsAndTruthfulnessReview: z.object({
    parseableSingleColumnStructure: AtsFindingSchema,
    standardSectionHeaders: AtsFindingSchema,
    selectableUtf8Text: AtsFindingSchema,
    truthfulKeywordUse: AtsFindingSchema,
    noHiddenTextOrKeywordStuffing: AtsFindingSchema,
    noUnsupportedSkillsOrMetrics: AtsFindingSchema,
  }).strict(),
  customizationPlan: z.array(z.object({
    section: PlainText,
    currentStatus: PlainText,
    proposedChange: PlainText,
    why: PlainText,
    evidenceIds: AnalysisEvidenceIds,
  }).strict()).min(1).max(100).readonly(),
  rankedRecommendations: z.object({
    cvChanges: z.array(EvidenceBackedTextSchema).length(5).readonly(),
    linkedInChanges: z.array(EvidenceBackedTextSchema).length(5).readonly(),
  }).strict(),
}).strict();
export type JobAnalysis = z.infer<typeof JobAnalysisSchema>;

export const FactWinnerSchema = z.object({
  factKey: Id,
  value: PlainText,
  entityId: Id,
  evidenceId: Id,
}).strict();
export type FactWinner = z.infer<typeof FactWinnerSchema>;

export const TailoringDecisionSchema = z.object({
  id: Id,
  section: z.enum(["experience", "projects", "competitions-other"]),
  entityId: Id,
  baselineItemId: Id.nullable(),
  action: z.enum(["retain", "rewrite", "add", "omit"]),
  text: PlainText.nullable(),
  evidenceIds: EvidenceIds,
  factKeys: z.array(Id).max(32).readonly().default([]),
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
  entityId: Id,
  category: PlainText,
  skill: PlainText,
  action: z.enum(["retain", "add", "omit"]),
  evidenceIds: EvidenceIds,
  rationale: PlainText,
}).strict();
export type SkillDecision = z.infer<typeof SkillDecisionSchema>;

export const BaselineOverrideSchema = z.object({
  baselineItemId: Id,
  replacement: PlainText,
  evidenceIds: EvidenceIds,
  rationale: PlainText,
}).strict();

export const CommentDispositionSchema = z.object({
  commentIndex: z.number().int().nonnegative(),
  status: z.enum(["applied", "rejected", "clarification-needed"]),
  rationale: PlainText,
  evidenceIds: z.array(Id).max(32).readonly(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "applied" && value.evidenceIds.length === 0) ctx.addIssue({ code: "custom", path: ["evidenceIds"], message: "applied comments require evidence" });
});
export type CommentDisposition = z.infer<typeof CommentDispositionSchema>;

export const TailoringPlanSchema = z.object({
  id: Id,
  analysisId: Id,
  analysisSha256: Sha256,
  tailoringWorkflowSha256: Sha256,
  decisions: z.array(TailoringDecisionSchema).max(500).readonly(),
  projectOrder: z.array(Id).max(100).readonly(),
  skillDecisions: z.array(SkillDecisionSchema).max(500).readonly(),
  factWinners: z.array(FactWinnerSchema).max(500).readonly(),
  baselineOverrides: z.array(BaselineOverrideSchema).max(100).readonly(),
  omissions: z.array(z.object({ baselineItemId: Id, rationale: PlainText, evidenceIds: EvidenceIds }).strict()).max(500).readonly(),
}).strict();
export type TailoringPlan = z.infer<typeof TailoringPlanSchema>;

export const TailoringSubmissionSchema = z.object({ plan: TailoringPlanSchema }).strict();
export type TailoringSubmission = z.infer<typeof TailoringSubmissionSchema>;

export const TailoringResultSchema = z.object({
  plan: TailoringPlanSchema,
  tailoredTex: z.string().max(256 * 1024),
  toolCount: z.number().int().min(4).max(8),
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
  tailoredTex: z.string().max(256 * 1024).nullable(),
  changes: z.array(RepairChangeSchema).max(100).readonly(),
  remainingDiagnostics: z.array(z.string().max(2_000)).max(100).readonly(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "repaired" && value.tailoredTex === null) ctx.addIssue({ code: "custom", path: ["tailoredTex"], message: "repaired result requires TeX" });
  if (value.status === "unrepaired" && value.tailoredTex !== null) ctx.addIssue({ code: "custom", path: ["tailoredTex"], message: "unrepaired result cannot contain TeX" });
});
export type RepairResult = z.infer<typeof RepairResultSchema>;
