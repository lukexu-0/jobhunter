import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JobAnalysis } from "../src/resume/types.ts";

export const ANALYSIS_WORKFLOW_PROMPT = readFileSync(
  resolve(import.meta.dir, "../../../planning/pipeline/analysis.md"),
  "utf8",
);
export const ANALYSIS_WORKFLOW_SHA256 = createHash("sha256")
  .update(ANALYSIS_WORKFLOW_PROMPT)
  .digest("hex");

const TAILORING_WORKFLOW = readFileSync(
  resolve(import.meta.dir, "../../../planning/pipeline/tailoring.md"),
  "utf8",
);
const TAILORING_PIPELINE_VALIDATION = TAILORING_WORKFLOW.indexOf("\n## Pipeline validation");
if (TAILORING_PIPELINE_VALIDATION < 0) throw new Error("tailoring fixture workflow is missing the pipeline validation boundary");
export const TAILORING_WORKFLOW_PROMPT = TAILORING_WORKFLOW.slice(0, TAILORING_PIPELINE_VALIDATION).trimEnd();
export const TAILORING_WORKFLOW_SHA256 = createHash("sha256")
  .update(TAILORING_WORKFLOW_PROMPT)
  .digest("hex");

export function jobAnalysisFixture(options: {
  readonly jobDescriptionSha256?: string;
  readonly evidenceId?: string;
} = {}): JobAnalysis {
  const evidenceIds = options.evidenceId ? [options.evidenceId] : [];
  const supported = (text: string) => ({ text, evidenceIds });
  const ats = (requiredAction: string) => ({
    status: "pass" as const,
    requiredAction,
    evidenceIds,
  });

  return {
    id: "analysis-1",
    jobDescriptionSha256: options.jobDescriptionSha256 ?? "a".repeat(64),
    analysisWorkflowSha256: ANALYSIS_WORKFLOW_SHA256,
    roleSummary: {
      company: "Example Co",
      role: "Software Engineer",
      archetype: "Agentic engineer",
      domain: "agentic",
      function: "build",
      seniority: "Senior",
      workModel: "full-remote",
      teamSize: "Not mentioned",
      tldr: "Build reliable agentic systems for production users.",
    },
    requirementEvidence: [{
      requirement: "Build production TypeScript systems",
      priority: "high",
      exactCvEvidence: options.evidenceId ? "Built production TypeScript systems" : "No evidence found",
      cvSourceLines: options.evidenceId ? ["Built production TypeScript systems"] : ["No evidence found"],
      matchStatus: options.evidenceId ? "direct" : "gap",
      evidenceIds,
    }],
    recruiterRisks: [{
      potentialDoubt: "Can the candidate build the required stack?",
      evidenceFromCvOrReport: options.evidenceId ? "Matching production project" : "No evidence found",
      candidateFacingFix: "Lead with the strongest truthful production example.",
      evidenceIds,
    }],
    gapsAndMitigations: [{
      gap: options.evidenceId ? "No direct domain title" : "No evidence found",
      classification: "nice-to-have",
      adjacentExperience: options.evidenceId ? "Adjacent agentic systems work" : "No evidence found",
      portfolioProof: options.evidenceId ? "Relevant production project" : "No evidence found",
      concreteMitigation: "Frame adjacent evidence without overstating it.",
      evidenceIds,
    }],
    keywordAlignment: [{
      jdVocabulary: "TypeScript",
      jdQuote: "Build production TypeScript systems",
      currentTruthfulCvWording: options.evidenceId ? "Built TypeScript services" : "No evidence found",
      recommendedReformulation: options.evidenceId ? "Built production TypeScript services" : "Not applicable",
      placements: ["Experience", "Technical Skills"],
      evidenceIds,
    }],
    proposedCvContent: {
      technicalSkills: [
        supported("TypeScript"),
        supported("Agent orchestration"),
        supported("Evaluation pipelines"),
        supported("Observability"),
        supported("Human-in-the-loop systems"),
        supported("Production delivery"),
      ],
      reorderedExperience: [{
        roleOrCompany: "Engineer / Example Co",
        bullets: [supported("Built a reliable production system for business users.")],
      }],
      selectedProjects: [
        supported("Agent orchestration project"),
        supported("Evaluation pipeline project"),
        supported("Production automation project"),
      ],
    },
    businessValueBulletReview: [{
      currentBullet: "Built a system",
      proposedBullet: "Built a production system that improved delivery reliability.",
      action: "Built",
      systemOrScope: "Production system",
      toolOrApproach: "TypeScript",
      outcomeOrProof: "Improved delivery reliability",
      evidenceIds,
    }],
    atsAndTruthfulnessReview: {
      parseableSingleColumnStructure: ats("Keep the single-column structure."),
      standardSectionHeaders: ats("Keep standard section headers."),
      selectableUtf8Text: ats("Keep text selectable and UTF-8 encoded."),
      truthfulKeywordUse: ats("Use TypeScript only in supported context."),
      noHiddenTextOrKeywordStuffing: ats("Do not add hidden text or keyword stuffing."),
      noUnsupportedSkillsOrMetrics: ats("Retain only supported skills and metrics."),
    },
    customizationPlan: [{
      section: "Experience",
      currentStatus: "Strong evidence is not prioritized",
      proposedChange: "Lead with agentic systems and production delivery.",
      why: "Makes the strongest truthful fit immediately visible.",
      evidenceIds,
    }],
  };
}
