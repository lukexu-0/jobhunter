import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalysisContent } from "../app/components/run-detail";

const analysis = {
  schemaVersion: 2,
  id: "analysis-1",
  jobDescriptionSha256: "a".repeat(64),
  analysisWorkflowSha256: "b".repeat(64),
  baselineSha256: "c".repeat(64),
  target: {
    title: "Staff AI Engineer",
    organization: "Acme Systems",
  },
  jdKeywords: [{
    id: "keyword-typescript",
    phrase: "Production TypeScript",
    jdQuote: "Build reliable agent orchestration services with Production TypeScript.",
    evidenceIds: ["evidence-keyword"],
  }],
  exactEdits: [
    {
      id: "edit-bullet",
      kind: "bullet",
      baselineItemId: "bullet-experience-platform-1",
      section: "experience",
      entityId: "experience-platform",
      before: "Built typed deployment services for internal teams.",
      after: "Built Production TypeScript deployment services used by ten internal teams.",
      keywordIds: ["keyword-typescript"],
      evidenceIds: ["evidence-keyword", "evidence-bullet"],
    },
    {
      id: "edit-skill",
      kind: "skill",
      baselineItemId: "skill-languages-typescript",
      category: "Languages",
      evidenceEntityId: "skills",
      before: "TypeScript",
      after: "Production TypeScript",
      keywordIds: ["keyword-typescript"],
      evidenceIds: ["evidence-keyword", "evidence-skill"],
    },
  ],
};

const oldReportHeadings = [
  "Role summary",
  "Requirement evidence",
  "Recruiter risks",
  "Gaps and mitigations",
  "Keyword alignment",
  "Proposed CV content",
  "Business value bullet review",
  "Truthful keyword use",
  "Customization plan",
];

const unsupportedLegacyMessage =
  "Unsupported legacy job-analysis artifact. This view requires schemaVersion 2.";

describe("job analysis artifact rendering", () => {
  test("renders only schema-v2 target, JD keywords, and exact resume edits", () => {
    const markup = renderToStaticMarkup(<AnalysisContent value={analysis} />);

    for (const heading of ["JD keywords", "Exact resume edits"]) {
      expect(markup).toContain(heading);
    }
    for (const value of [
      "analysis-1",
      "Staff AI Engineer",
      "Acme Systems",
      "Build reliable agent orchestration services with Production TypeScript.",
      "bullet-experience-platform-1",
      "experience-platform",
      "Built typed deployment services for internal teams.",
      "Built Production TypeScript deployment services used by ten internal teams.",
      "skill-languages-typescript",
      "Languages",
      "TypeScript",
      "Production TypeScript",
      "keyword-typescript",
      "evidence-keyword",
      "evidence-bullet",
      "evidence-skill",
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
    ]) {
      expect(markup).toContain(value);
    }
    expect(markup.match(/aria-label="Linked keyword IDs"/g)).toHaveLength(2);
    expect(markup.match(/aria-label="Evidence IDs"/g)).toHaveLength(3);
    for (const heading of oldReportHeadings) {
      expect(markup).not.toContain(heading);
    }
    expect(markup).not.toContain(unsupportedLegacyMessage);
  });

  test("shows one unsupported message for missing and non-v2 payloads", () => {
    for (const value of [undefined, {}, { schemaVersion: 1 }]) {
      const markup = renderToStaticMarkup(<AnalysisContent value={value} />);
      expect(markup).toContain(unsupportedLegacyMessage);
      expect(markup.split(unsupportedLegacyMessage)).toHaveLength(2);
      expect(markup).not.toContain("JD keywords");
      expect(markup).not.toContain("Exact resume edits");
    }
  });
});
