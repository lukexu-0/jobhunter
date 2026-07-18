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

test("shows only the requested keyword-map option label", async ({ page }) => {
  await interceptEmptyRuns(page);
  await page.goto("/");

  const initializer = page.getByRole("form", { name: "Initialize application" });
  const option = initializer.locator(".run-initializer__option");
  const checkbox = initializer.getByRole("checkbox", {
    name: "Generate resume to job Description keyword map",
    exact: true,
  });

  await expect(checkbox).toBeChecked();
  await expect(checkbox).not.toHaveAttribute("aria-describedby", /.+/);
  await expect(option).toHaveText("Generate resume to job Description keyword map");
  await expect(page.getByText("Generate keyword map PDF", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Creates a side-by-side visualization of your resume and the full job description.", { exact: true })).toHaveCount(0);
  await expect(option.locator("label")).toHaveCSS("color", "rgb(238, 241, 236)");
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
