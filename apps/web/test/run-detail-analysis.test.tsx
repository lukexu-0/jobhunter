import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalysisContent } from "../app/components/run-detail";

const evidenceIds = ["evidence-1"];

const analysis = {
  id: "analysis-1",
  jobDescriptionSha256: "a".repeat(64),
  analysisWorkflowSha256: "b".repeat(64),
  roleSummary: {
    company: "Acme Systems",
    role: "Staff AI Engineer",
    archetype: "Platform builder",
    domain: "agentic",
    function: "build",
    seniority: "Staff",
    workModel: "full-remote",
    teamSize: "Eight engineers",
    tldr: "Own the agent platform",
  },
  requirementEvidence: [{
    requirement: "Production TypeScript",
    priority: "high",
    exactCvEvidence: "Shipped typed services",
    cvSourceLines: ["Built a typed deployment service"],
    matchStatus: "direct",
    evidenceIds,
  }],
  recruiterRisks: [{
    potentialDoubt: "Limited named LLMOps ownership",
    evidenceFromCvOrReport: "The CV names adjacent platform work",
    candidateFacingFix: "Lead with the model gateway project",
    evidenceIds,
  }],
  gapsAndMitigations: [{
    gap: "No healthcare domain experience",
    classification: "nice-to-have",
    adjacentExperience: "Worked in regulated fintech",
    portfolioProof: "Published an auditability case study",
    concreteMitigation: "Connect regulated delivery to healthcare needs",
    evidenceIds,
  }],
  keywordAlignment: [{
    jdVocabulary: "Agent orchestration",
    jdQuote: "Build reliable agent orchestration",
    currentTruthfulCvWording: "Designed workflow coordination",
    recommendedReformulation: "Designed agent workflow orchestration",
    placements: ["Experience", "Technical Skills"],
    evidenceIds,
  }],
  proposedCvContent: {
    technicalSkills: [{ text: "Agent platforms", evidenceIds }],
    reorderedExperience: [{
      roleOrCompany: "Acme Platform Lead",
      bullets: [{ text: "Reduced deployment time by half", evidenceIds }],
    }],
    selectedProjects: [{ text: "Model gateway case study", evidenceIds }],
  },
  businessValueBulletReview: [{
    currentBullet: "Built a gateway",
    proposedBullet: "Built a gateway serving ten teams",
    action: "strengthen",
    systemOrScope: "Model gateway",
    toolOrApproach: "TypeScript and Kubernetes",
    outcomeOrProof: "Adopted by ten teams",
    evidenceIds,
  }],
  atsAndTruthfulnessReview: {
    parseableSingleColumnStructure: { status: "pass", requiredAction: "Keep the single-column layout", evidenceIds },
    standardSectionHeaders: { status: "pass", requiredAction: "Keep standard headings", evidenceIds },
    selectableUtf8Text: { status: "pass", requiredAction: "Retain selectable text", evidenceIds },
    truthfulKeywordUse: { status: "revise", requiredAction: "Use agent wording only where supported", evidenceIds },
    noHiddenTextOrKeywordStuffing: { status: "pass", requiredAction: "Do not add hidden keywords", evidenceIds },
    noUnsupportedSkillsOrMetrics: { status: "pass", requiredAction: "Keep metrics evidence-backed", evidenceIds },
  },
  customizationPlan: [{
    section: "Experience",
    currentStatus: "Strong evidence appears too late",
    proposedChange: "Lead with the agent platform focus",
    why: "Makes role fit immediate",
    evidenceIds,
  }],
};

const sectionHeadings = [
  "Role summary",
  "Requirement evidence",
  "Recruiter risks",
  "Gaps and mitigations",
  "Keyword alignment",
  "Proposed CV content",
  "Business value bullet review",
  "ATS and truthfulness review",
  "Customization plan",
];

describe("job analysis artifact rendering", () => {
  test("renders all nine structured sections and their key values", () => {
    const markup = renderToStaticMarkup(<AnalysisContent value={analysis} />);

    for (const heading of sectionHeadings) expect(markup).toContain(heading);
    for (const value of [
      "analysis-1",
      "Acme Systems",
      "Staff AI Engineer",
      "Own the agent platform",
      "Production TypeScript",
      "Shipped typed services",
      "Built a typed deployment service",
      "Limited named LLMOps ownership",
      "Lead with the model gateway project",
      "No healthcare domain experience",
      "Published an auditability case study",
      "Agent orchestration",
      "Designed agent workflow orchestration",
      "Agent platforms",
      "Acme Platform Lead",
      "Reduced deployment time by half",
      "Model gateway case study",
      "Built a gateway serving ten teams",
      "Adopted by ten teams",
      "Use agent wording only where supported",
      "Keep metrics evidence-backed",
      "Lead with the agent platform focus",
      "Makes role fit immediate",
      "Experience, Technical Skills",
      "evidence-1",
    ]) expect(markup).toContain(value);
  });

  test("fails soft when section records and arrays are missing or malformed", () => {
    const malformed = {
      roleSummary: [],
      requirementEvidence: "not-an-array",
      recruiterRisks: [null, "not-a-record"],
      gapsAndMitigations: {},
      keywordAlignment: [42],
      proposedCvContent: {
        technicalSkills: "not-an-array",
        reorderedExperience: [{ bullets: "not-an-array" }],
        selectedProjects: null,
      },
      businessValueBulletReview: null,
      atsAndTruthfulnessReview: null,
      customizationPlan: 42,
    };

    expect(() => renderToStaticMarkup(<AnalysisContent value={malformed} />)).not.toThrow();
    const markup = renderToStaticMarkup(<AnalysisContent value={malformed} />);
    for (const heading of sectionHeadings) expect(markup).toContain(heading);
    expect(markup).toContain("No requirement evidence was reported.");
    expect(markup).toContain("No business value bullet review was reported.");
    expect(markup).toContain("Status Not Reported");
  });
});
