import { expect, test, type Page } from "@playwright/test";
import { type RunDto } from "@jobhunter/pipeline/contracts";

const reviewRun: RunDto = {
  id: "metadata-review-run",
  status: "review",
  applicationStatus: "applied",
  queueSequence: 1,
  generateKeywordMap: false,
  skipReview: false,
  autoSubmit: false,
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

async function interceptReviewRun(page: Page, listedRun: RunDto = reviewRun): Promise<void> {
  await page.route("**/api/pipeline/runs", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [listedRun] }),
    });
  });
  await page.route("**/api/pipeline/runs/metadata-review-run/artifacts/initial-job-analysis", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 2,
        id: "analysis-1",
        jobDescriptionSha256: "b".repeat(64),
        analysisWorkflowSha256: "c".repeat(64),
        baselineSha256: "d".repeat(64),
        target: {
          title: "  Staff AI Engineer  ",
          organization: "  Acme Systems  ",
        },
        jdKeywords: [],
        exactEdits: [],
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
  await expect(applicationRow).not.toContainText(/Tailoring\s+run/);
  await expect(applicationRow).not.toContainText("Not available");
});

test("prefers durable identity overrides over public job-analysis values", async ({ page }) => {
  await interceptReviewRun(page, {
    ...reviewRun,
    titleOverride: "Principal Platform Engineer",
    organizationOverride: "Override Industries",
  });
  await page.goto("/");

  const applicationRow = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Open Principal Platform Engineer metadata…-run" }),
  });
  await expect(applicationRow).toContainText("Principal Platform Engineer");
  await expect(applicationRow).toContainText("Override Industries");
  await expect(applicationRow).not.toContainText("Staff AI Engineer");
  await expect(applicationRow).not.toContainText("Acme Systems");
});

test("keeps loading a tailoring run artifact across polling and eventually shows its role", async ({ page }) => {
  const tailoringRun: RunDto = {
    ...reviewRun,
    id: "metadata-tailoring-run",
    status: "tailoring",
    queueSequence: 1,
    generateKeywordMap: false,
    skipReview: false,
    autoSubmit: false,
    artifacts: [{
      ...reviewRun.artifacts[0],
      id: "tailoring-job-analysis",
      href: "/v1/runs/metadata-tailoring-run/artifacts/tailoring-job-analysis",
    }],
  };
  let runListRequests = 0;
  let secondRunListRequest: () => void = () => {};
  const secondRunList = new Promise<void>((resolve) => {
    secondRunListRequest = resolve;
  });

  await page.route("**/api/pipeline/runs", async (route) => {
    expect(route.request().method()).toBe("GET");
    runListRequests += 1;
    if (runListRequests >= 2) secondRunListRequest();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [tailoringRun] }),
    });
  });
  await page.route("**/api/pipeline/runs/metadata-tailoring-run/artifacts/tailoring-job-analysis", async (route) => {
    await secondRunList;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 2,
        id: "analysis-tailoring",
        jobDescriptionSha256: "b".repeat(64),
        analysisWorkflowSha256: "c".repeat(64),
        baselineSha256: "d".repeat(64),
        target: { title: "Delayed Staff Engineer", organization: "Acme Systems" },
        jdKeywords: [],
        exactEdits: [],
      }),
    });
  });

  await page.goto("/");
  const applicationRow = page.getByRole("row").filter({
    has: page.getByRole("combobox", { name: /Application state for metadata…-run/ }),
  });
  await expect(applicationRow).toBeVisible();
  await expect(applicationRow).not.toContainText(/Tailoring\s+run/);
  const roleCell = applicationRow.locator("td").nth(0);
  const organizationCell = applicationRow.locator("td").nth(1);
  const roleLink = roleCell.getByRole("link", { name: "Open application metadata…-run" });
  const rolePlaceholder = roleLink.locator(".table-placeholder-line");
  const organizationPlaceholder = organizationCell.locator(".table-placeholder-line");
  await expect(roleLink).toBeVisible();
  await expect(roleLink).toHaveAttribute("aria-label", "Open application metadata…-run");
  await expect(rolePlaceholder).toBeVisible();
  await expect(rolePlaceholder).toHaveText("");
  await expect(rolePlaceholder).toHaveAttribute("aria-hidden", "true");
  await expect(organizationPlaceholder).toBeVisible();
  await expect(organizationPlaceholder).toHaveText("");
  await expect(organizationCell.getByRole("img", { name: "Unknown organization" })).toBeVisible();
  await expect(rolePlaceholder).toHaveCSS("width", "112px");
  await expect(rolePlaceholder).toHaveCSS("height", "2px");
  await expect(rolePlaceholder).toHaveCSS("background-color", "rgb(117, 126, 121)");
  await expect(organizationPlaceholder).toHaveClass(/\btable-placeholder-line--organization\b/);
  await expect(organizationPlaceholder).toHaveCSS("height", "2px");
  await expect(organizationPlaceholder).toHaveCSS("background-color", "rgb(117, 126, 121)");
  const rolePlaceholderBox = await rolePlaceholder.boundingBox();
  const organizationPlaceholderBox = await organizationPlaceholder.boundingBox();
  if (!rolePlaceholderBox || !organizationPlaceholderBox) throw new Error("Placeholder geometry is unavailable");
  expect(organizationPlaceholderBox.width / rolePlaceholderBox.width).toBeCloseTo(2 / 3, 1);
  await expect(applicationRow).toContainText("Delayed Staff Engineer", { timeout: 8_000 });
  expect(runListRequests).toBeGreaterThanOrEqual(2);
});
