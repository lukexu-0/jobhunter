import { expect, test, type Page } from "@playwright/test";
import { type RunDto } from "@jobhunter/pipeline/contracts";

const reviewRun: RunDto = {
  id: "metadata-review-run",
  status: "review",
  applicationStatus: "applied",
  revision: 4,
  origin: "initial",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  visualAcknowledgementRequired: false,
  attempts: [],
  artifacts: [{
    id: "initial-job-analysis",
    kind: "job-analysis",
    revision: 0,
    attempt: 1,
    sha256: "a".repeat(64),
    bytes: 512,
    mediaType: "application/json",
    href: "/v1/runs/metadata-review-run/artifacts/initial-job-analysis",
    public: true,
    createdAt: 1_700_000_000_100,
  }],
  timeline: [],
};

async function interceptReviewRun(page: Page): Promise<void> {
  await page.route("**/api/pipeline/runs", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [reviewRun] }),
    });
  });
  await page.route("**/api/pipeline/runs/metadata-review-run/artifacts/initial-job-analysis", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "analysis-1",
        jobDescriptionSha256: "b".repeat(64),
        analysisWorkflowSha256: "c".repeat(64),
        roleSummary: {
          role: "  Staff AI Engineer  ",
          company: "  Acme Systems  ",
          archetype: "Platform builder",
          domain: "agentic",
          function: "build",
          seniority: "Staff",
          workModel: "hybrid",
          teamSize: "Not mentioned",
          tldr: "Build reliable AI infrastructure.",
        },
      }),
    });
  });
}

test("loads application identity from the initial public job analysis", async ({ page }) => {
  await interceptReviewRun(page);
  await page.goto("/");

  const applicationRow = page.getByRole("row").filter({
    has: page.getByRole("link", { name: /Open .*metadata…-run/ }),
  });
  await expect(applicationRow).toContainText("Staff AI Engineer");
  await expect(applicationRow).toContainText("Acme Systems");
  await expect(applicationRow).not.toContainText("Tailoring run");
  await expect(applicationRow).not.toContainText("Not available");
});
