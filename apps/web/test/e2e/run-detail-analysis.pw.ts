import { expect, test, type Page } from "@playwright/test";
import { type RunDto } from "@jobhunter/pipeline/contracts";

const runId = "run-detail-analysis-v2";
const analysisArtifactId = "job-analysis-v2";

const run: RunDto = {
  id: runId,
  status: "approved",
  applicationStatus: "applied",
  revision: 2,
  origin: "initial",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  visualAcknowledgementRequired: false,
  attempts: [],
  artifacts: [{
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
  }],
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

async function interceptRunDetail(page: Page): Promise<void> {
  await page.route(`**/api/pipeline/runs/${runId}`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(run),
    });
  });
  await page.route(`**/api/pipeline/runs/${runId}/artifacts/${analysisArtifactId}`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(analysis),
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

test("renders the schema-v2 job analysis without legacy report sections", async ({ page }) => {
  await interceptRunDetail(page);
  await page.goto(`/runs/${runId}`);

  await expect(page.getByRole("heading", { level: 1, name: "Staff AI Engineer" })).toBeVisible();
  await expect(page.getByText("Acme Systems", { exact: true }).first()).toBeVisible();

  const panel = page.getByRole("region", { name: "Job analysis" });
  await expect(panel.getByRole("heading", { name: "JD keywords" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Exact resume edits" })).toBeVisible();
  await expect(panel.getByText("Build reliable agent orchestration services with Production TypeScript.", { exact: true })).toBeVisible();
  await expect(panel.getByText("Built typed deployment services for internal teams.", { exact: true })).toBeVisible();
  await expect(panel.getByText("Built Production TypeScript deployment services used by ten internal teams.", { exact: true })).toBeVisible();
  await expect(panel.getByText("TypeScript", { exact: true })).toBeVisible();
  await expect(panel.getByText("Production TypeScript", { exact: true }).first()).toBeVisible();
  const linkedKeywordIds = panel.getByLabel("Linked keyword IDs");
  await expect(linkedKeywordIds).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    await expect(linkedKeywordIds.nth(index)).toHaveText("keyword-typescript");
  }
  const evidenceIds = panel.getByLabel("Evidence IDs");
  await expect(evidenceIds).toHaveCount(3);
  for (const evidenceId of ["evidence-keyword", "evidence-bullet", "evidence-skill"]) {
    await expect(evidenceIds.filter({ hasText: evidenceId }).first()).toBeVisible();
  }
  for (const heading of oldReportHeadings) {
    await expect(page.getByRole("heading", { name: heading, exact: true })).toHaveCount(0);
  }
});
