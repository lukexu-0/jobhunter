import { expect, test, type Page } from "@playwright/test";
import { type RunDto } from "@jobhunter/pipeline/contracts";

const runId = "inherited-resolved-artifacts";
const resumeArtifactId = "compiled-pdf-revision-1";
const activeRunId = "active-run-poll-resilience";
const refreshError = "Run refresh temporarily unavailable.";
const keywordMapArtifactId = "keyword-map-revision-1";
const inheritedPdfSha256 = "1111111111111111111111111111111111111111111111111111111111111111";

const reviewRun: RunDto = {
  id: runId,
  status: "review",
  applicationStatus: "pending",
  revision: 2,
  origin: "initial",
  queueSequence: 2,
  generateKeywordMap: true,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
  visualAcknowledgementRequired: false,
  currentPdfSha256: inheritedPdfSha256,
  attempts: [],
  artifacts: [
    {
      id: resumeArtifactId,
      kind: "compiled-pdf",
      revision: 1,
      attempt: 1,
      sha256: inheritedPdfSha256,
      bytes: 12_345,
      mediaType: "application/pdf",
      href: `/v1/runs/${runId}/artifacts/${resumeArtifactId}`,
      public: true,
      createdAt: 1_700_000_000_100,
    },
    {
      id: keywordMapArtifactId,
      kind: "keyword-map-pdf",
      revision: 1,
      attempt: 1,
      sha256: "2222222222222222222222222222222222222222222222222222222222222222",
      bytes: 23_456,
      mediaType: "application/pdf",
      href: `/v1/runs/${runId}/artifacts/${keywordMapArtifactId}`,
      public: true,
      createdAt: 1_700_000_000_200,
    },
  ],
  timeline: [],
};

const activeRun: RunDto = {
  ...reviewRun,
  id: activeRunId,
  status: "tailoring",
  revision: 3,
  updatedAt: 1_700_000_002_000,
  artifacts: reviewRun.artifacts.map((artifact) => ({
    ...artifact,
    href: artifact.href.replace(runId, activeRunId),
  })),
};

async function interceptReviewRun(page: Page): Promise<void> {
  await page.route(`**/api/pipeline/runs/${runId}`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(reviewRun),
    });
  });
  await page.route(`**/api/pipeline/runs/${runId}/artifacts/*`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/pdf",
      body: Buffer.from("%PDF-1.4\n% inherited artifact fixture\n%%EOF\n"),
    });
  });
}

test("WEB-RETRY-001 keeps the last successful active-run detail visible when polling fails", async ({ page }) => {
  let runRequests = 0;
  await page.route(`**/api/pipeline/runs/${activeRunId}`, async (route) => {
    expect(route.request().method()).toBe("GET");
    runRequests += 1;
    if (runRequests === 1) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(activeRun),
      });
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "RUN_REFRESH_CONFLICT",
          message: refreshError,
        },
      }),
    });
  });

  await page.goto(`/runs/${activeRunId}`);
  const title = page.getByRole("heading", { level: 1, name: "Application" });
  const viewer = page.getByRole("region", { name: "Document viewer" });
  const documentStatus = viewer.getByRole("heading", { level: 3, name: "Tailoring resume" });
  await expect(title).toBeVisible();
  await expect(viewer).toBeVisible();
  await expect(documentStatus).toBeVisible();

  await expect.poll(() => runRequests).toBeGreaterThanOrEqual(2);
  await expect(page.getByText(refreshError, { exact: true })).toBeVisible();
  await expect(title).toBeVisible();
  await expect(viewer).toBeVisible();
  await expect(documentStatus).toBeVisible();
  await expect(page.getByText("Run unavailable", { exact: true })).toHaveCount(0);
});

test("keeps inherited resolved documents visible after a late-stage revision", async ({ page }) => {
  await interceptReviewRun(page);
  await page.goto(`/runs/${runId}`);

  const viewer = page.getByRole("region", { name: "Document viewer" });
  const tablist = viewer.getByRole("tablist", { name: "Document views" });
  const resumeTab = tablist.getByRole("tab", { name: "Resume" });
  const keywordMapTab = tablist.getByRole("tab", { name: "Keyword map" });
  const resumePanel = viewer.locator("#resume-document-panel");
  const resumeHref = `/api/pipeline/runs/${runId}/artifacts/${resumeArtifactId}`;

  await expect(tablist.getByRole("tab")).toHaveText(["Resume", "Keyword map"]);
  await expect(resumeTab).toHaveAttribute("aria-controls", "resume-document-panel");
  await expect(resumePanel).toBeVisible();
  await expect(resumePanel.locator('object[type="application/pdf"]')).toHaveAttribute("data", resumeHref);
  await expect(viewer.getByRole("link", { name: "Download current PDF" })).toHaveAttribute("href", resumeHref);
  await expect(keywordMapTab).toHaveAttribute("aria-controls", "keyword-map-document-panel");
});

test("WEB-DOWNLOAD-001 makes the PDF object fallback download the current resume", async ({ page }) => {
  await interceptReviewRun(page);
  await page.goto(`/runs/${runId}`);

  const resumeHref = `/api/pipeline/runs/${runId}/artifacts/${resumeArtifactId}`;
  const pdfObject = page.locator("#resume-document-panel").locator('object[type="application/pdf"]');
  const fallbackDownload = pdfObject.locator("a", { hasText: "Download the current resume" });

  await expect(pdfObject).toHaveAttribute("data", resumeHref);
  await expect(fallbackDownload).toHaveText("Download the current resume");
  await expect(fallbackDownload).toHaveAttribute("href", resumeHref);
  await expect(fallbackDownload).toHaveAttribute("download", "");
});
