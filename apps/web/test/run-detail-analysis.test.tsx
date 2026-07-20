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
  jdKeywords: [
    {
      id: "keyword-observability",
      phrase: "Operational observability",
      jdQuote: "Own Operational observability across every production service.",
      evidenceIds: ["evidence-observability"],
    },
    {
      id: "keyword-typescript",
      phrase: "Production TypeScript",
      jdQuote: "Build reliable agent orchestration services with Production TypeScript.",
      evidenceIds: ["evidence-keyword"],
    },
  ],
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

const extraction = {
  schemaVersion: 1,
  jobDescriptionSha256: "a".repeat(64),
  keywordExtractionWorkflowSha256: "e".repeat(64),
  keywords: [
    {
      id: "keyword-distributed-tracing",
      phrase: "Distributed tracing",
      jdQuote: "Lead Distributed tracing adoption across the platform.",
    },
    {
      id: "keyword-typescript",
      phrase: "Production TypeScript",
      jdQuote: "Build reliable agent orchestration services with Production TypeScript.",
    },
    {
      id: "keyword-zero-downtime",
      phrase: "Zero-downtime delivery",
      jdQuote: "Create Zero-downtime delivery systems.",
    },
    {
      id: "keyword-observability",
      phrase: "Operational observability",
      jdQuote: "Own Operational observability across every production service.",
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
  test("renders phrase-only included and not-included keyword lists in source order", () => {
    const markup = renderToStaticMarkup(
      <AnalysisContent value={analysis} extraction={extraction} extractionAvailable />,
    );

    for (const heading of ["Keywords included", "Keywords not included"]) {
      expect(markup).toContain(heading);
    }
    expect(markup.match(/aria-labelledby="keywords-(?:included|not-included)-heading"/g)).toHaveLength(2);
    expect(markup.match(/<ul/g)).toHaveLength(2);
    for (const phrase of [
      "Operational observability",
      "Production TypeScript",
      "Distributed tracing",
      "Zero-downtime delivery",
    ]) {
      expect(markup).toContain(phrase);
    }
    expect(markup.indexOf("Operational observability")).toBeLessThan(markup.indexOf("Production TypeScript"));
    expect(markup.indexOf("Distributed tracing")).toBeLessThan(markup.indexOf("Zero-downtime delivery"));
    for (const privateDetail of [
      "analysis-1",
      "Staff AI Engineer",
      "Acme Systems",
      "Own Operational observability across every production service.",
      "Build reliable agent orchestration services with Production TypeScript.",
      "Lead Distributed tracing adoption across the platform.",
      "Create Zero-downtime delivery systems.",
      "bullet-experience-platform-1",
      "experience-platform",
      "Built typed deployment services for internal teams.",
      "Built Production TypeScript deployment services used by ten internal teams.",
      "skill-languages-typescript",
      "Languages",
      "keyword-observability",
      "keyword-typescript",
      "keyword-distributed-tracing",
      "keyword-zero-downtime",
      "evidence-observability",
      "evidence-keyword",
      "evidence-bullet",
      "evidence-skill",
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
      "e".repeat(64),
      "Exact resume edits",
      "JD keywords",
    ]) {
      expect(markup).not.toContain(privateDetail);
    }
    for (const heading of oldReportHeadings) {
      expect(markup).not.toContain(heading);
    }
    expect(markup).not.toContain(unsupportedLegacyMessage);
  });

  test("keeps included phrases visible when extraction is unavailable", () => {
    const markup = renderToStaticMarkup(<AnalysisContent value={analysis} />);

    expect(markup).toContain("Keywords included");
    expect(markup).toContain("Operational observability");
    expect(markup).toContain("Production TypeScript");
    expect(markup).toContain("Keywords not included");
    expect(markup).toContain("Keyword extraction is unavailable.");
    expect(markup.split("Keyword extraction is unavailable.")).toHaveLength(2);
    expect(markup.indexOf("Keyword extraction is unavailable."))
      .toBeGreaterThan(markup.indexOf("Keywords not included"));
  });

  test("shows concise states for empty keyword lists", () => {
    const noIncludedMarkup = renderToStaticMarkup(
      <AnalysisContent
        value={{ schemaVersion: 2, jdKeywords: [] }}
        extraction={{
          schemaVersion: 1,
          keywords: [{ id: "keyword-accessibility", phrase: "Accessible interfaces" }],
        }}
        extractionAvailable
      />,
    );
    expect(noIncludedMarkup).toContain("No keywords are included.");
    expect(noIncludedMarkup).toContain("Accessible interfaces");

    const noAbsentMarkup = renderToStaticMarkup(
      <AnalysisContent
        value={{
          schemaVersion: 2,
          jdKeywords: [{ id: "keyword-accessibility", phrase: "Accessible interfaces" }],
        }}
        extraction={{
          schemaVersion: 1,
          keywords: [{ id: "keyword-accessibility", phrase: "Accessible interfaces" }],
        }}
        extractionAvailable
      />,
    );
    expect(noAbsentMarkup).toContain("Accessible interfaces");
    expect(noAbsentMarkup).toContain("All extracted keywords are included.");
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
