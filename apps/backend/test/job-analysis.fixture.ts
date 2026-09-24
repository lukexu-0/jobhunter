import { createHash } from "node:crypto";
import { SYNTHETIC_RESUME } from "./private-context.fixture.ts";
import { ANALYSIS_WORKFLOW_SHA256 } from "../src/agents/analysis-agent.ts";
import { ATS_KEYWORD_EXTRACTION_WORKFLOW_SHA256 } from "../src/agents/ats-keyword-extraction-agent.ts";
import { parseBaselineResume } from "../src/resume/parser.ts";
import type { AtsKeywordExtraction, JobAnalysis } from "../src/resume/types.ts";

export const KEYWORD_MAP_JOB_DESCRIPTION =
  "Strong TypeScript engineer using Next.js and Kubernetes";

export function atsKeywordExtractionFixture(options: {
  readonly rawJobDescription?: string;
  readonly jobDescriptionSha256?: string;
} = {}): AtsKeywordExtraction {
  const rawJobDescription = options.rawJobDescription ?? KEYWORD_MAP_JOB_DESCRIPTION;
  const supportedKeywords = [
    { id: "keyword-typescript", phrase: "TypeScript" },
    { id: "keyword-nextjs", phrase: "Next.js" },
    { id: "keyword-kubernetes", phrase: "Kubernetes" },
  ].filter((keyword) => rawJobDescription.toLocaleLowerCase().includes(keyword.phrase.toLocaleLowerCase()));
  if (supportedKeywords.length === 0) {
    throw new Error("ATS keyword extraction fixture requires a supported keyword in the job description");
  }
  return {
    schemaVersion: 1,
    jobDescriptionSha256: options.jobDescriptionSha256
      ?? createHash("sha256").update(rawJobDescription).digest("hex"),
    keywordExtractionWorkflowSha256: ATS_KEYWORD_EXTRACTION_WORKFLOW_SHA256,
    keywords: supportedKeywords.map((keyword) => ({
      ...keyword,
      jdQuote: rawJobDescription,
    })),
  };
}

export function jobAnalysisFixture(options: {
  readonly jobDescriptionSha256?: string;
  readonly baselineSource?: string;
  readonly jdQuote?: string;
} = {}): JobAnalysis {
  const baseline = parseBaselineResume(options.baselineSource ?? SYNTHETIC_RESUME);
  const bullet = baseline.bullets[0];
  const skill = baseline.skills.find((item) => item.skill === "JavaScript");
  if (!bullet || !skill) throw new Error("synthetic analysis fixture targets are unavailable");

  return {
    schemaVersion: 2,
    id: "analysis-1",
    jobDescriptionSha256: options.jobDescriptionSha256 ?? "a".repeat(64),
    analysisWorkflowSha256: ANALYSIS_WORKFLOW_SHA256,
    baselineSha256: baseline.sha256,
    target: {
      title: "Software Engineer",
      organization: "Example Co",
    },
    jdKeywords: [{
      id: "keyword-typescript",
      phrase: "TypeScript",
      jdQuote: options.jdQuote ?? "Build production TypeScript systems",
    }],
    exactEdits: [
      {
        id: "edit-example-impact",
        kind: "bullet",
        baselineItemId: bullet.id,
        section: bullet.section,
        entityId: bullet.entityId,
        before: bullet.text,
        after: "Built TypeScript tooling for Example Co to review sample pull requests and verify changes.",
        keywordIds: ["keyword-typescript"],
      },
      {
        id: "edit-typescript-skill",
        kind: "skill",
        baselineItemId: skill.id,
        category: skill.category,
        before: skill.skill,
        after: "TypeScript services",
        keywordIds: ["keyword-typescript"],
      },
    ],
  };
}
