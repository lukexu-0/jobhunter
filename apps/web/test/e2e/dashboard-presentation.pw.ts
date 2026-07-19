import { expect, test, type Page, type Route } from "@playwright/test";
import { type RunDto } from "@jobhunter/pipeline/contracts";

async function interceptEmptyRuns(page: Page): Promise<void> {
  await page.route("**/api/pipeline/runs", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [] }),
    });
  });
}

function runFixture(): RunDto {
  return {
    id: "presentation-run",
    status: "approved",
    applicationStatus: "applied",
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

async function interceptAnalyzedRun(page: Page): Promise<void> {
  const run: RunDto = {
    ...runFixture(),
    id: "presentation-identity-run",
    artifacts: [{
      id: "presentation-job-analysis",
      kind: "job-analysis",
      revision: 0,
      attempt: 1,
      sha256: "a".repeat(64),
      bytes: 512,
      mediaType: "application/json",
      href: "/v1/runs/presentation-identity-run/artifacts/presentation-job-analysis",
      public: true,
      createdAt: 1_700_000_000_100,
    }],
  };
  const explicitOrganizationRun: RunDto = {
    ...runFixture(),
    id: "presentation-not-mentioned",
    artifacts: [{
      id: "not-mentioned-job-analysis",
      kind: "job-analysis",
      revision: 0,
      attempt: 1,
      sha256: "b".repeat(64),
      bytes: 512,
      mediaType: "application/json",
      href: "/v1/runs/presentation-not-mentioned/artifacts/not-mentioned-job-analysis",
      public: true,
      createdAt: 1_700_000_000_200,
    }],
  };
  const malformedTargetRun: RunDto = {
    ...runFixture(),
    id: "presentation-malformed-target",
    artifacts: [{
      id: "malformed-target-job-analysis",
      kind: "job-analysis",
      revision: 0,
      attempt: 1,
      sha256: "c".repeat(64),
      bytes: 512,
      mediaType: "application/json",
      href: "/v1/runs/presentation-malformed-target/artifacts/malformed-target-job-analysis",
      public: true,
      createdAt: 1_700_000_000_300,
    }],
  };
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [run, explicitOrganizationRun, malformedTargetRun] }),
    });
  });
  await page.route("**/api/pipeline/runs/presentation-identity-run/artifacts/presentation-job-analysis", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 2,
        id: "analysis-identity",
        jobDescriptionSha256: "d".repeat(64),
        analysisWorkflowSha256: "e".repeat(64),
        baselineSha256: "f".repeat(64),
        target: {
          title: "Staff AI Engineer",
          organization: "Acme Systems",
        },
        jdKeywords: [],
        exactEdits: [],
      }),
    });
  });
  await page.route("**/api/pipeline/runs/presentation-not-mentioned/artifacts/not-mentioned-job-analysis", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 2,
        id: "analysis-not-mentioned",
        jobDescriptionSha256: "1".repeat(64),
        analysisWorkflowSha256: "2".repeat(64),
        baselineSha256: "3".repeat(64),
        target: {
          title: "Product Designer",
          organization: "Not mentioned",
        },
        jdKeywords: [],
        exactEdits: [],
      }),
    });
  });
  await page.route("**/api/pipeline/runs/presentation-malformed-target/artifacts/malformed-target-job-analysis", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 2,
        id: "analysis-malformed-target",
        jobDescriptionSha256: "4".repeat(64),
        analysisWorkflowSha256: "5".repeat(64),
        baselineSha256: "6".repeat(64),
        target: {
          title: 42,
          organization: "Should not be displayed",
        },
        jdKeywords: [],
        exactEdits: [],
      }),
    });
  });
}

test("shows only the requested keyword-map option label", async ({ page }) => {
  await interceptEmptyRuns(page);
  await page.goto("/");

  const initializer = page.getByRole("form", { name: "Initialize application" });
  const option = initializer.locator(".run-initializer__option");
  const checkbox = initializer.getByRole("checkbox", {
    name: "Generate resume-to-job-description keyword map",
    exact: true,
  });

  await expect(checkbox).toBeChecked();
  await expect(checkbox).not.toHaveAttribute("aria-describedby", /.+/);
  await expect(option).toHaveText("Generate resume-to-job-description keyword map");
  await expect(page.getByText("Generate keyword map PDF", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Creates a side-by-side visualization of your resume and the full job description.", { exact: true })).toHaveCount(0);
  await expect(option.locator("label")).toHaveCSS("color", "rgb(238, 241, 236)");
});

test("does not show the run ID beneath a populated target role", async ({ page }) => {
  await interceptAnalyzedRun(page);
  await page.goto("/");

  const roleLink = page.getByRole("link", { name: "Open Staff AI Engineer" });
  const targetRoleCell = page.getByRole("cell").filter({ has: roleLink });
  await expect(roleLink).toBeVisible();
  await expect(targetRoleCell).toHaveText("Staff AI Engineer");
  await expect(targetRoleCell).not.toContainText("presenta…-run");
});

test("preserves an explicit Not mentioned organization while malformed targets use generic fallbacks", async ({ page }) => {
  await interceptAnalyzedRun(page);
  await page.goto("/");

  const role = page.getByRole("link", { name: "Open Staff AI Engineer" });
  const organization = page.getByText("Acme Systems", { exact: true });
  const explicitOrganizationRow = page.getByRole("row").filter({ hasText: "Product Designer" });
  const explicitOrganization = explicitOrganizationRow.getByText("Not mentioned", { exact: true });
  const malformedRole = page.getByRole("link", { name: "Open tailoring run presenta…rget" });
  const malformedTargetRow = page.getByRole("row").filter({ has: malformedRole });
  const malformedOrganization = malformedTargetRow.getByText("Not available", { exact: true });

  for (const identity of [role, organization, explicitOrganization]) {
    await expect(identity).toHaveCSS("color", "rgb(238, 241, 236)");
    await expect(identity).toHaveCSS("font-weight", "700");
    await expect(identity).toHaveCSS("font-size", "20px");
  }
  await expect(malformedRole).toHaveText("Tailoring run");
  await expect(malformedOrganization).toHaveCSS("color", "rgb(117, 126, 121)");
  await expect(malformedOrganization).toHaveCSS("font-weight", "400");
  await expect(malformedOrganization).toHaveCSS("font-size", "11px");
  await expect(page.getByText("Should not be displayed", { exact: true })).toHaveCount(0);
});

test("uses five application columns in every table state", async ({ page }) => {
  let pendingRoute: Route | undefined;
  await page.route("**/api/pipeline/runs", async (route) => {
    pendingRoute = route;
  });
  await page.goto("/");
  await expect.poll(() => Boolean(pendingRoute)).toBe(true);

  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveCount(5);
  await expect(table.getByRole("columnheader", { name: "Revision", exact: true })).toHaveCount(0);
  await expect(table.getByText("Loading applications…", { exact: true })).toBeVisible();
  await expect(table.locator("tbody td[colspan]")).toHaveAttribute("colspan", "5");

  if (!pendingRoute) throw new Error("Loading request was not captured");
  await pendingRoute.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ runs: [] }),
  });
  await expect(page.getByText("No applications yet. Enter a job posting URL above to initialize one.", { exact: true })).toBeVisible();
  await expect(table.locator("tbody td[colspan]")).toHaveAttribute("colspan", "5");

  await page.unroute("**/api/pipeline/runs");
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Dashboard unavailable" }),
    });
  });
  await page.reload();
  await expect(table.getByRole("alert")).toContainText("The pipeline request failed.");
  await expect(table.locator("tbody td[colspan]")).toHaveAttribute("colspan", "5");

  await page.unroute("**/api/pipeline/runs");
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [runFixture()] }),
    });
  });
  await page.reload();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody tr").first().locator("td")).toHaveCount(5);
  await expect(table.getByText("R01", { exact: true })).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search applications" }).fill("no match");
  await expect(page.getByText("No applications match the current search and state.", { exact: true })).toBeVisible();
  await expect(table.locator("tbody td[colspan]")).toHaveAttribute("colspan", "5");
});

test("places the total count before its bottom-aligned label", async ({ page }) => {
  await interceptEmptyRuns(page);
  await page.goto("/");

  const summary = page.getByRole("region", { name: "Application count" });
  const total = summary.getByText("0", { exact: true });
  const label = summary.getByText("Total applications", { exact: true });
  await expect(label).toHaveCSS("font-size", "11px");

  const totalBox = await total.boundingBox();
  const labelBox = await label.boundingBox();
  if (!totalBox || !labelBox) throw new Error("Application metric geometry is unavailable");

  expect(totalBox.x + totalBox.width).toBeLessThanOrEqual(labelBox.x);
  expect(Math.abs(totalBox.y + totalBox.height - (labelBox.y + labelBox.height))).toBeLessThanOrEqual(1);
});

test("scrolls the applications table locally only when five columns do not fit", async ({ page }) => {
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [runFixture()] }),
    });
  });

  await page.setViewportSize({ width: 1_280, height: 900 });
  await page.goto("/");
  const scroller = page.locator(".applications-table-scroll");
  await expect(scroller).toBeVisible();
  expect(await scroller.evaluate((element) => element.scrollWidth)).toBe(
    await scroller.evaluate((element) => element.clientWidth),
  );

  await page.setViewportSize({ width: 768, height: 900 });
  expect(await scroller.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
  expect(await scroller.evaluate((element) => element.scrollWidth)).toBeGreaterThan(
    await scroller.evaluate((element) => element.clientWidth),
  );
});

test("uses the shared lifecycle order and presents one named row link with a visual-only arrow", async ({ page }) => {
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [runFixture()] }),
    });
  });
  await page.goto("/");

  const statusLabels = ["Pending", "Applied", "Rejected", "Interview", "Accepted", "Failed"];
  const filter = page.getByRole("combobox", { name: "Filter applications by state" });
  const rowStatus = page.getByRole("combobox", { name: "Application state for presenta…-run" });
  const row = page.getByRole("row").filter({ has: rowStatus });
  const arrow = row.locator(".row-arrow");

  await expect(filter.locator("option")).toHaveText(["All states", ...statusLabels]);
  await expect(rowStatus.locator("option")).toHaveText(statusLabels);
  await expect(row.getByRole("link", { name: "Open tailoring run presenta…-run" })).toHaveCount(1);
  await expect(row.getByRole("link")).toHaveCount(1);
  await expect(arrow).toHaveAttribute("aria-hidden", "true");
  expect(await arrow.evaluate((element) => element.tagName)).toBe("SPAN");
  expect(await arrow.evaluate((element) => (element as HTMLElement).tabIndex)).toBe(-1);
  await expect(arrow).toHaveCSS("border-top-width", "0px");
  await expect(arrow).toHaveCSS("box-shadow", "none");
  await expect(arrow).toHaveCSS("text-shadow", "none");
});

test("opens a run from a non-interactive cell without letting the status selector navigate", async ({ page }) => {
  const run = runFixture();
  let patchCount = 0;
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [run] }),
    });
  });
  await page.route("**/api/pipeline/runs/presentation-run", async (route) => {
    if (route.request().method() === "PATCH") {
      patchCount += 1;
      expect(route.request().postDataJSON()).toEqual({ applicationStatus: "pending" });
    } else {
      expect(route.request().method()).toBe("GET");
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...run, applicationStatus: "pending" }),
    });
  });
  await page.goto("/");

  const rowStatus = page.getByRole("combobox", { name: "Application state for presenta…-run" });
  const row = page.getByRole("row").filter({ has: rowStatus });
  await rowStatus.click();
  expect(new URL(page.url()).pathname).toBe("/");
  await rowStatus.selectOption("pending");
  await expect(rowStatus).toHaveValue("pending");
  expect(patchCount).toBe(1);
  expect(new URL(page.url()).pathname).toBe("/");

  await row.getByRole("cell").nth(1).click();
  await expect(page).toHaveURL(/\/runs\/presentation-run$/);
});
