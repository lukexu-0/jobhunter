import { expect, test, type Page } from "@playwright/test";
import { type RunDto } from "@jobhunter/pipeline/contracts";

const runId = "run-detail-analysis-v2";
const analysisArtifactId = "job-analysis-v2";
const extractionArtifactId = "ats-keyword-extraction-v1";

const run: RunDto = {
  id: runId,
  status: "approved",
  applicationStatus: "applied",
  queueSequence: 1,
  generateKeywordMap: true,
  revision: 2,
  origin: "initial",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  visualAcknowledgementRequired: false,
  attempts: [],
  artifacts: [
    {
      id: analysisArtifactId,
      kind: "job-analysis",
      revision: 0,
      attempt: 1,
      sha256: "a".repeat(64),
      bytes: 1_024,
      mediaType: "application/json",
      href: `/v1/runs/${runId}/artifacts/${analysisArtifactId}`,
      public: true,
      createdAt: 1_700_000_000_100,
    },
    {
      id: extractionArtifactId,
      kind: "ats-keyword-extraction",
      revision: 0,
      attempt: 1,
      sha256: "e".repeat(64),
      bytes: 1_024,
      mediaType: "application/json; charset=utf-8",
      href: `/v1/runs/${runId}/artifacts/${extractionArtifactId}`,
      public: true,
      createdAt: 1_700_000_000_090,
    },
  ],
  timeline: [],
};

const analysis = {
  schemaVersion: 2,
  id: "analysis-v2",
  jobDescriptionSha256: "b".repeat(64),
  analysisWorkflowSha256: "c".repeat(64),
  baselineSha256: "d".repeat(64),
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
  jobDescriptionSha256: "b".repeat(64),
  keywordExtractionWorkflowSha256: "f".repeat(64),
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

async function interceptRunDetail(page: Page, includeExtraction = true): Promise<void> {
  await page.route(`**/api/pipeline/runs/${runId}`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(includeExtraction
        ? run
        : { ...run, artifacts: run.artifacts.filter((artifact) => artifact.kind !== "ats-keyword-extraction") }),
    });
  });
  await page.route(`**/api/pipeline/runs/${runId}/artifacts/${analysisArtifactId}`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(analysis),
    });
  });
  if (!includeExtraction) return;
  await page.route(`**/api/pipeline/runs/${runId}/artifacts/${extractionArtifactId}`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(extraction),
    });
  });
}

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

test("shows the minimal summary and phrase-only keyword comparison", async ({ page }) => {
  await interceptRunDetail(page);
  await page.goto(`/runs/${runId}`);

  const title = page.getByRole("heading", { level: 1, name: "Staff AI Engineer" });
  const lifecycleBadge = page.getByText("Applied", { exact: true });
  await expect(title).toBeVisible();
  await expect(lifecycleBadge).toBeVisible();
  await expect(page.getByText("Acme Systems", { exact: true }).first()).toBeVisible();
  expect(await lifecycleBadge.evaluate((badge, heading) => Boolean(
    badge.compareDocumentPosition(heading as Node) & Node.DOCUMENT_POSITION_FOLLOWING
  ), await title.elementHandle())).toBe(true);
  const [badgeColor, lifecycleColor] = await lifecycleBadge.evaluate((badge) => {
    const rootStyles = getComputedStyle(document.documentElement);
    return [
      getComputedStyle(badge).getPropertyValue("--application-badge-color").trim(),
      rootStyles.getPropertyValue("--color-application-applied").trim(),
    ];
  });
  expect(badgeColor).toBe(lifecycleColor);
  await expect(page.getByText("Created", { exact: true })).toBeVisible();
  await expect(page.getByText("Last updated", { exact: true })).toBeVisible();
  for (const removedLabel of [
    "Application details",
    "Application status",
    "Pipeline status",
    "Revision",
    "Revision origin",
    "Current PDF",
    "Visual acknowledgement",
  ]) {
    await expect(page.getByText(removedLabel, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("heading", { name: "Job analysis", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Exact resume edits", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "JD keywords", exact: true })).toHaveCount(0);

  const included = page.getByRole("region", { name: "Keywords included" });
  const notIncluded = page.getByRole("region", { name: "Keywords not included" });
  await expect(included.getByRole("listitem")).toHaveText([
    "Operational observability",
    "Production TypeScript",
  ]);
  await expect(notIncluded.getByRole("listitem")).toHaveText([
    "Distributed tracing",
    "Zero-downtime delivery",
  ]);

  for (const privateDetail of [
    "analysis-v2",
    "keyword-observability",
    "keyword-typescript",
    "keyword-distributed-tracing",
    "keyword-zero-downtime",
    "Own Operational observability across every production service.",
    "Build reliable agent orchestration services with Production TypeScript.",
    "Lead Distributed tracing adoption across the platform.",
    "Create Zero-downtime delivery systems.",
    "evidence-observability",
    "evidence-keyword",
    "evidence-bullet",
    "evidence-skill",
    "Built typed deployment services for internal teams.",
    "Built Production TypeScript deployment services used by ten internal teams.",
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
    "d".repeat(64),
    "e".repeat(64),
    "f".repeat(64),
  ]) {
    await expect(page.getByText(privateDetail, { exact: true })).toHaveCount(0);
  }
  for (const heading of oldReportHeadings) {
    await expect(page.getByRole("heading", { name: heading, exact: true })).toHaveCount(0);
  }
});

test("keeps included phrases visible when keyword extraction is unavailable", async ({ page }) => {
  await interceptRunDetail(page, false);
  await page.goto(`/runs/${runId}`);

  const included = page.getByRole("region", { name: "Keywords included" });
  const notIncluded = page.getByRole("region", { name: "Keywords not included" });
  await expect(included.getByRole("listitem")).toHaveText([
    "Operational observability",
    "Production TypeScript",
  ]);
  await expect(notIncluded).toContainText("Keyword extraction is unavailable.");
  await expect(notIncluded.getByRole("list")).toHaveCount(0);
  await expect(included).not.toContainText("unavailable");
});
