import { expect, test, type Page } from "@playwright/test";
import type { ApplicationStatus, RunDto, RunStatus } from "@jobhunter/pipeline/contracts";

function runFixture(id: string, applicationStatus: ApplicationStatus, status: RunStatus): RunDto {
  return {
    id,
    status,
    applicationStatus,
    revision: 1,
    origin: "initial",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    visualAcknowledgementRequired: false,
    attempts: [],
    artifacts: [],
    timeline: [],
  };
}

const lifecycleRuns: readonly RunDto[] = [
  runFixture("lifecycle-applied", "applied", "failed"),
  runFixture("lifecycle-rejected", "rejected", "approved"),
  runFixture("lifecycle-interview", "interview", "queued"),
  runFixture("lifecycle-accepted", "accepted", "failed"),
  runFixture("lifecycle-failed", "failed", "review"),
];

async function interceptRuns(page: Page): Promise<void> {
  await page.route("**/api/pipeline/runs", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: lifecycleRuns }),
    });
  });
}

test("filters by user-managed application state", async ({ page }) => {
  await interceptRuns(page);
  await page.goto("/");

  const state = page.getByRole("combobox", { name: "Filter applications by state" });
  await expect(state.locator("option")).toHaveText([
    "All states",
    "Applied",
    "Rejected",
    "Interview",
    "Accepted",
    "Failed",
  ]);

  await state.selectOption("interview");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator('tbody a.application-link[href="/runs/lifecycle-interview"]')).toBeVisible();

  await state.selectOption("failed");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator('tbody a.application-link[href="/runs/lifecycle-failed"]')).toBeVisible();
});

test("lets the user change application state", async ({ page }) => {
  await interceptRuns(page);
  let requestBody: string | null = null;
  await page.route("**/api/pipeline/runs/lifecycle-applied", async (route) => {
    expect(route.request().method()).toBe("PATCH");
    requestBody = route.request().postData();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...lifecycleRuns[0],
        applicationStatus: "failed",
        updatedAt: 1_700_000_001_000,
      }),
    });
  });
  await page.goto("/");

  const applicationState = page.getByRole("combobox", {
    name: "Application state for lifecycl…lied",
  });
  await expect(applicationState).toHaveValue("applied");

  await applicationState.selectOption("failed");

  expect(requestBody).toBe('{\"applicationStatus\":\"failed\"}');
  await expect(applicationState).toHaveValue("failed");
  await expect(applicationState).toBeEnabled();
});

test("retains application state when an update fails", async ({ page }) => {
  await interceptRuns(page);
  await page.route("**/api/pipeline/runs/lifecycle-applied", async (route) => {
    expect(route.request().method()).toBe("PATCH");
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "RUN_CONFLICT", message: "The application status changed." },
      }),
    });
  });
  await page.goto("/");

  const applicationState = page.getByRole("combobox", {
    name: "Application state for lifecycl…lied",
  });
  await expect(applicationState).toHaveValue("applied");

  await applicationState.selectOption("failed");

  await expect(applicationState).toHaveValue("applied");
  await expect(applicationState).toBeEnabled();
  await expect(page.getByRole("alert", { name: "Application state update error" })).toContainText("Application state could not be updated. Try again.");
});

test("shows application and pipeline status separately on run detail", async ({ page }) => {
  const detailRun = runFixture("lifecycle-detail", "rejected", "failed");
  await page.route("**/api/pipeline/runs/lifecycle-detail", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detailRun),
    });
  });
  await page.goto("/runs/lifecycle-detail");

  const metadata = page.getByRole("complementary", { name: "Run metadata and history" }).locator("dl").first();
  const applicationStatus = metadata.locator("dt").filter({ hasText: /^Application status$/ }).locator("..").locator("dd");
  const pipelineStatus = metadata.locator("dt").filter({ hasText: /^Pipeline status$/ }).locator("..").locator("dd");

  await expect(applicationStatus).toHaveText("Rejected");
  await expect(pipelineStatus).toHaveText("Failed");
});

test("navigates between Applications and Providers", async ({ page }) => {
  await interceptRuns(page);
  await page.route("**/api/pipeline/auth", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        providers: [
          { provider: "openai-codex", state: "disconnected" },
          { provider: "google-antigravity", state: "disconnected" },
        ],
      }),
    });
  });
  await page.goto("/");

  const primaryNavigation = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(primaryNavigation.getByRole("link")).toHaveText(["Applications", "Providers"]);
  await expect(primaryNavigation.getByRole("link", { name: "Applications" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Provider access" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "OAuth providers" })).toHaveCount(0);

  await primaryNavigation.getByRole("link", { name: "Providers" }).click();

  await expect(page).toHaveURL(/\/providers$/);
  await expect(primaryNavigation.getByRole("link", { name: "Providers" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Provider access" })).toBeVisible();
  const providerRows = page.getByRole("list", { name: "OAuth providers" }).getByRole("listitem");
  await expect(providerRows).toHaveCount(2);
  await expect(providerRows.nth(0)).toContainText("OpenAI Codex");
  await expect(providerRows.nth(1)).toContainText("Google Antigravity");
});
