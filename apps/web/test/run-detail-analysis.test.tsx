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
    placement: "Experience",
    evidenceIds,
  }],
  proposedCvContent: {
    professionalSummary: { text: "Staff engineer building reliable AI platforms", evidenceIds },
    coreCompetencies: [{ text: "Agent platforms", evidenceIds }],
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
  sixSecondClarityGate: {
    targetRoleOrArchetype: { status: "clear", evidenceOrRequiredRewrite: "Staff AI platform engineer is explicit", evidenceIds },
    strongestMatchingStackOrDomain: { status: "clear", evidenceOrRequiredRewrite: "TypeScript platform stack is prominent", evidenceIds },
    productionOrBusinessOutcome: { status: "revise", evidenceOrRequiredRewrite: "Move the adoption result higher", evidenceIds },
    appropriateLocationOrRemoteFit: { status: "clear", evidenceOrRequiredRewrite: "Remote location is stated", evidenceIds },
    relevantPortfolioOrCaseStudyLink: { status: "not-applicable", evidenceOrRequiredRewrite: "No public link is required", evidenceIds },
  },
  atsAndTruthfulnessReview: {
    parseableSingleColumnStructure: { status: "pass", requiredAction: "Keep the single-column layout", evidenceIds },
    standardSectionHeaders: { status: "pass", requiredAction: "Keep standard headings", evidenceIds },
    selectableUtf8Text: { status: "pass", requiredAction: "Retain selectable text", evidenceIds },
    truthfulKeywordUse: { status: "revise", requiredAction: "Use agent wording only where supported", evidenceIds },
    noHiddenTextOrKeywordStuffing: { status: "pass", requiredAction: "Do not add hidden keywords", evidenceIds },
    noUnsupportedSkillsOrMetrics: { status: "pass", requiredAction: "Keep metrics evidence-backed", evidenceIds },
  },
  customizationPlan: [{
    section: "Summary",
    currentStatus: "Too general",
    proposedChange: "Name the agent platform focus",
    why: "Makes role fit immediate",
    evidenceIds,
  }],
  rankedRecommendations: {
    cvChanges: [{ text: "Promote the model gateway bullet", evidenceIds }],
    linkedInChanges: [{ text: "Add agent platforms to the headline", evidenceIds }],
  },
};

const sectionHeadings = [
  "Role summary",
  "Requirement evidence",
  "Recruiter risks",
  "Gaps and mitigations",
  "Keyword alignment",
  "Proposed CV content",
  "Business value bullet review",
  "Six-second clarity gate",
  "ATS and truthfulness review",
  "Customization plan",
  "Ranked recommendations",
];

describe("job analysis artifact rendering", () => {
  test("renders all eleven structured sections and their key values", () => {
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
      "Staff engineer building reliable AI platforms",
      "Agent platforms",
      "Acme Platform Lead",
      "Reduced deployment time by half",
      "Model gateway case study",
      "Built a gateway serving ten teams",
      "Adopted by ten teams",
      "Staff AI platform engineer is explicit",
      "No public link is required",
      "Use agent wording only where supported",
      "Keep metrics evidence-backed",
      "Name the agent platform focus",
      "Makes role fit immediate",
      "Promote the model gateway bullet",
      "Add agent platforms to the headline",
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
        professionalSummary: [],
        coreCompetencies: "not-an-array",
        reorderedExperience: [{ bullets: "not-an-array" }],
        selectedProjects: null,
      },
      businessValueBulletReview: null,
      sixSecondClarityGate: [],
      atsAndTruthfulnessReview: null,
      customizationPlan: 42,
      rankedRecommendations: "not-a-record",
    };

    expect(() => renderToStaticMarkup(<AnalysisContent value={malformed} />)).not.toThrow();
    const markup = renderToStaticMarkup(<AnalysisContent value={malformed} />);
    for (const heading of sectionHeadings) expect(markup).toContain(heading);
    expect(markup).toContain("No requirement evidence was reported.");
    expect(markup).toContain("No business value bullet review was reported.");
    expect(markup).toContain("Status Not Reported");
  });
});
