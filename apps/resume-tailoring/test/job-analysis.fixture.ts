import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ANALYSIS_WORKFLOW_SHA256 } from "../src/agents/analysis-agent.ts";
import { parseBaselineResume } from "../src/resume/parser.ts";
import type { JobAnalysis } from "../src/resume/types.ts";

const CANONICAL_BASELINE = readFileSync(resolve(import.meta.dir, "../../user-info/resume-main/main.tex"), "utf8");

export function jobAnalysisFixture(options: {
  readonly jobDescriptionSha256?: string;
  readonly evidenceId?: string;
  readonly baselineSource?: string;
  readonly jdQuote?: string;
} = {}): JobAnalysis {
  const baseline = parseBaselineResume(options.baselineSource ?? CANONICAL_BASELINE);
  const bullet = baseline.bullets[0];
  const skill = baseline.skills.find((item) => item.skill === "JavaScript");
  if (!bullet || !skill) throw new Error("canonical analysis fixture targets are unavailable");
  const evidenceId = options.evidenceId ?? "evidence-0";

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
      evidenceIds: [evidenceId],
    }],
    exactEdits: [
      {
        id: "edit-example-impact",
        kind: "bullet",
        baselineItemId: bullet.id,
        section: bullet.section,
        entityId: bullet.entityId,
        before: bullet.text,
        after: "Improved a sample validation workflow by building deterministic TypeScript test automation.",
        keywordIds: ["keyword-typescript"],
        evidenceIds: [evidenceId],
      },
      {
        id: "edit-typescript-skill",
        kind: "skill",
        baselineItemId: skill.id,
        category: skill.category,
        evidenceEntityId: bullet.entityId,
        before: skill.skill,
        after: "TypeScript services",
        keywordIds: ["keyword-typescript"],
        evidenceIds: [evidenceId],
      },
    ],
  };
}
