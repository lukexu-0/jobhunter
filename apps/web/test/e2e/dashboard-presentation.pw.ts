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
    opportunityKind: "job",
    status: "approved",
    applicationStatus: "applied",
    queueSequence: 1,
    generateKeywordMap: false,
    skipReview: false,
    autoSubmit: false,
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
    queueSequence: 1,
    generateKeywordMap: false,
    skipReview: false,
    autoSubmit: false,
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
    queueSequence: 2,
    generateKeywordMap: false,
    skipReview: false,
    autoSubmit: false,
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
    queueSequence: 3,
    generateKeywordMap: false,
    skipReview: false,
    autoSubmit: false,
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

test("does not show a keyword-map control", async ({ page }) => {
  await interceptEmptyRuns(page);
  await page.goto("/");

  const initializer = page.getByRole("form", { name: "Initialize applications", exact: true });
  await expect(initializer.getByRole("checkbox", { name: "Skip résumé review", exact: true })).not.toBeChecked();
  await expect(initializer.getByRole("checkbox", { name: "Auto-submit application", exact: true })).not.toBeChecked();
  await expect(initializer.getByText("Generate resume-to-job-description keyword map", { exact: true })).toHaveCount(0);
});

test("labels the first application column Role", async ({ page }) => {
  await interceptEmptyRuns(page);
  await page.goto("/");

  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader", { name: "Role", exact: true })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Target role", exact: true })).toHaveCount(0);
});

test("presents application metadata headings on a raised high-contrast rail", async ({ page }) => {
  await interceptEmptyRuns(page);
  await page.goto("/");

  for (const name of ["Role", "Organization", "Updated", "Status"]) {
    const heading = page.getByRole("columnheader", { name, exact: true });
    await expect(heading).toHaveCSS("background-color", "rgb(17, 20, 19)");
    await expect(heading).toHaveCSS("color", "rgb(210, 243, 76)");
    await expect(heading).toHaveCSS("font-size", "13px");
  }
});

test("gives the Role heading extra space before Organization", async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 900 });
  await interceptEmptyRuns(page);
  await page.goto("/");

  const table = page.getByRole("table");
  const roleHeading = table.getByRole("columnheader", { name: "Role", exact: true });
  await expect(roleHeading).toHaveCSS("padding-left", "24px");
  await expect(roleHeading).toHaveCSS("padding-right", "24px");
  await expect(table.getByRole("columnheader", { name: "Organization", exact: true })).toHaveCSS("padding-right", "16px");

  const tableBox = await table.boundingBox();
  const roleBox = await roleHeading.boundingBox();
  if (!tableBox || !roleBox) throw new Error("Application header geometry is unavailable");
  expect(roleBox.width / tableBox.width).toBeCloseTo(0.32, 2);
});

test("insets application titles from the left table edge", async ({ page }) => {
  await interceptAnalyzedRun(page);
  await page.goto("/");

  const table = page.getByRole("table");
  const roleLink = page.getByRole("link", { name: "Open Staff AI Engineer" });
  const roleCell = page.getByRole("cell").filter({ has: roleLink });
  await expect(roleCell).toHaveCSS("padding-left", "16px");

  const tableBox = await table.boundingBox();
  const linkBox = await roleLink.boundingBox();
  if (!tableBox || !linkBox) throw new Error("Application title geometry is unavailable");
  expect(linkBox.x - tableBox.x).toBeCloseTo(16, 0);
});

test("renders updated dates in white", async ({ page }) => {
  await interceptAnalyzedRun(page);
  await page.goto("/");

  const updatedDates = page.getByRole("table").locator("time");
  await expect(updatedDates).toHaveCount(3);
  await expect(updatedDates.first()).toHaveCSS("color", "rgb(255, 255, 255)");
});

test("does not show the run ID beneath a populated role", async ({ page }) => {
  await interceptAnalyzedRun(page);
  await page.goto("/");

  const roleLink = page.getByRole("link", { name: "Open Staff AI Engineer" });
  const roleCell = page.getByRole("cell").filter({ has: roleLink });
  await expect(roleLink).toBeVisible();
  await expect(roleCell).toHaveText("Staff AI Engineer");
  await expect(roleCell).not.toContainText("presenta…-run");
});

test("preserves an explicit Not mentioned organization while malformed targets use generic fallbacks", async ({ page }) => {
  await interceptAnalyzedRun(page);
  await page.goto("/");

  const role = page.getByRole("link", { name: "Open Staff AI Engineer" });
  const organization = page.getByText("Acme Systems", { exact: true });
  const explicitOrganizationRow = page.getByRole("row").filter({ hasText: "Product Designer" });
  const explicitOrganization = explicitOrganizationRow.getByText("Not mentioned", { exact: true });
  const malformedRole = page.getByRole("link", { name: "Open application presenta…rget" });
  const malformedTargetRow = page.getByRole("row").filter({ has: malformedRole });
  const malformedRoleCell = malformedTargetRow.locator("td").nth(0);
  const malformedOrganizationCell = malformedTargetRow.locator("td").nth(1);
  const malformedRolePlaceholder = malformedRoleCell.locator(".table-placeholder-line");
  const malformedOrganizationPlaceholder = malformedOrganizationCell.locator(".table-placeholder-line");

  for (const identity of [role, organization, explicitOrganization]) {
    await expect(identity).toHaveCSS("color", "rgb(238, 241, 236)");
    await expect(identity).toHaveCSS("font-weight", "700");
    await expect(identity).toHaveCSS("font-size", "20px");
  }
  await expect(malformedRole).toBeVisible();
  await expect(malformedRole).toHaveAttribute("aria-label", "Open application presenta…rget");
  await expect(malformedRolePlaceholder).toBeVisible();
  await expect(malformedRolePlaceholder).toHaveText("");
  await expect(malformedRolePlaceholder).toHaveAttribute("aria-hidden", "true");
  await expect(malformedOrganizationPlaceholder).toBeVisible();
  await expect(malformedOrganizationPlaceholder).toHaveText("");
  await expect(malformedOrganizationCell.getByRole("img", { name: "Unknown organization" })).toBeVisible();
  await expect(malformedRolePlaceholder).toHaveCSS("width", "112px");
  await expect(malformedRolePlaceholder).toHaveCSS("height", "2px");
  await expect(malformedRolePlaceholder).toHaveCSS("background-color", "rgb(117, 126, 121)");
  await expect(malformedOrganizationPlaceholder).toHaveClass(/\btable-placeholder-line--organization\b/);
  await expect(malformedOrganizationPlaceholder).toHaveCSS("height", "2px");
  await expect(malformedOrganizationPlaceholder).toHaveCSS("background-color", "rgb(117, 126, 121)");
  const rolePlaceholderBox = await malformedRolePlaceholder.boundingBox();
  const organizationPlaceholderBox = await malformedOrganizationPlaceholder.boundingBox();
  if (!rolePlaceholderBox || !organizationPlaceholderBox) throw new Error("Placeholder geometry is unavailable");
  expect(organizationPlaceholderBox.width / rolePlaceholderBox.width).toBeCloseTo(2 / 3, 1);
  await expect(malformedTargetRow).not.toContainText(/Tailoring\s+run/);
  await expect(page.getByText("Not available", { exact: true })).toHaveCount(0);
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

test("uses the shared lifecycle order and exposes a square accessible row action menu without an arrow", async ({ page }) => {
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [runFixture()] }),
    });
  });
  await page.goto("/");

  const statusLabels = ["Pending", "Applied", "Rejected", "Interview", "Accepted"];
  const filter = page.getByRole("combobox", { name: "Filter applications by state" });
  const rowStatus = page.getByRole("combobox", { name: "Application state for presenta…-run" });
  const row = page.getByRole("row").filter({ has: rowStatus });
  const trigger = row.getByRole("button", { name: "Actions for presenta…-run" });

  await expect(filter.locator("option")).toHaveText(["All states", ...statusLabels]);
  await expect(rowStatus.locator("option")).toHaveText(statusLabels);
  await expect(row.getByRole("link", { name: "Open application presenta…-run" })).toHaveCount(1);
  await expect(row.locator(".row-arrow")).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toHaveCSS("width", "44px");
  await expect(trigger).toHaveCSS("height", "44px");
  await expect(trigger).toHaveCSS("border-radius", "0px");
  await expect(trigger).toHaveCSS("border-color", "rgb(210, 243, 76)");
  await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await trigger.hover();
  await expect(trigger).toHaveCSS("background-color", "rgb(210, 243, 76)");
  await expect(trigger).toHaveCSS("color", "rgb(5, 6, 6)");

  await trigger.click();
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const menu = page.getByRole("menu", { name: "Actions for presenta…-run" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText(["Edit title", "Edit organization", "Delete"]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.locator(".applications-table-scroll").evaluate((element) => {
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await filter.evaluate((element) => {
    (element as HTMLSelectElement).value = "pending";
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(trigger).toHaveCount(0);
  await expect(menu).toHaveCount(0);
  await page.evaluate(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
  await expect(page.getByRole("searchbox", { name: "Search applications" })).toBeFocused();
  await filter.evaluate((element) => {
    (element as HTMLSelectElement).value = "all";
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(trigger).toBeVisible();
  await expect(menu).toHaveCount(0);
});

test("closes a stale action dialog when polling removes its application", async ({ page }) => {
  const run: RunDto = {
    ...runFixture(),
    status: "queued",
    titleOverride: "Externally deleted",
  };
  let listRequests = 0;
  await page.route("**/api/pipeline/runs", async (route) => {
    listRequests += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: listRequests === 1 ? [run] : [] }),
    });
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Actions for Externally deleted" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete application?" });
  await expect(dialog).toBeVisible();

  await expect(dialog).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByRole("searchbox", { name: "Search applications" })).toBeFocused();
});

test("keeps an existing Failed status visible but not selectable", async ({ page }) => {
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [{ ...runFixture(), applicationStatus: "failed" }] }),
    });
  });
  await page.goto("/");

  const filter = page.getByRole("combobox", { name: "Filter applications by state" });
  const rowStatus = page.getByRole("combobox", { name: "Application state for presenta…-run" });
  const failedOption = rowStatus.locator('option[value="failed"]');

  await expect(filter.locator('option[value="failed"]')).toHaveCount(0);
  await expect(rowStatus).toHaveValue("failed");
  await expect(failedOption).toBeDisabled();
  await expect(rowStatus.locator("option:not([disabled])")).toHaveText(["Pending", "Applied", "Rejected", "Interview", "Accepted"]);
});

test("renders application status text with stronger contrast", async ({ page }) => {
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [runFixture()] }),
    });
  });
  await page.goto("/");

  const rowStatus = page.getByRole("combobox", { name: "Application state for presenta…-run" });
  await expect(rowStatus).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(rowStatus).toHaveCSS("font-size", "13px");
});

test("keeps the action trigger inset and its menu and dialog usable at narrow widths", async ({ page }) => {
  const run = {
    ...runFixture(),
    titleOverride: "Platform Engineer",
    organizationOverride: "Example Labs",
  };
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [run] }),
    });
  });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "Actions for Platform Engineer" });
  await trigger.scrollIntoViewIfNeeded();
  const triggerCell = trigger.locator("..");
  await expect(triggerCell).toHaveCSS("padding-right", "16px");
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Actions for Platform Engineer" });
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  if (!menuBox) throw new Error("Action menu geometry is unavailable");
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(320);
  expect(menuBox.y).toBeGreaterThanOrEqual(0);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(640);

  await menu.getByRole("menuitem", { name: "Edit organization" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit application organization" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Organization" })).toHaveValue("Example Labs");
  const dialogBox = await dialog.boundingBox();
  if (!dialogBox) throw new Error("Action dialog geometry is unavailable");
  expect(dialogBox.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(320);
  expect(dialogBox.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(640);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Edit organization" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(menu).toBeVisible();
  await page.getByRole("heading", { name: "Applications" }).click();
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(menu).toBeVisible();
  const sortControl = page.getByRole("button", { name: /Sort by updated date/ });
  await sortControl.click();
  await expect(menu).toHaveCount(0);
  await expect(sortControl).toBeFocused();

});

test("preserves focus transferred by the Search applications label while dismissing the action menu", async ({ page }) => {
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [{ ...runFixture(), titleOverride: "Focus target" }] }),
    });
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Actions for Focus target" }).click();
  const menu = page.getByRole("menu", { name: "Actions for Focus target" });
  await expect(menu).toBeVisible();

  const search = page.getByRole("searchbox", { name: "Search applications" });
  await page.locator(".search-control svg").click();
  await expect(menu).toHaveCount(0);
  await expect(search).toBeFocused();
});

test("keeps the hollow action trigger fully visible while hovering a populated application", async ({ page }) => {
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [{ ...runFixture(), titleOverride: "Platform Engineer" }] }),
    });
  });
  await page.setViewportSize({ width: 1_280, height: 900 });
  await page.goto("/");

  const scroller = page.locator(".applications-table-scroll");
  const trigger = page.getByRole("button", { name: "Actions for Platform Engineer" });
  await trigger.hover();

  const scrollerBox = await scroller.boundingBox();
  const triggerBox = await trigger.boundingBox();
  if (!scrollerBox || !triggerBox) throw new Error("Hovered application action geometry is unavailable");
  expect(triggerBox.x + triggerBox.width, "Hovered row action should remain fully visible").toBeLessThanOrEqual(
    scrollerBox.x + scrollerBox.width + 1,
  );
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

test("retains identity input on failure and updates the row only after a successful edit", async ({ page }) => {
  const run: RunDto = {
    ...runFixture(),
    titleOverride: "Original title",
    organizationOverride: "Original organization",
  };
  const patchBodies: unknown[] = [];
  let releaseFirstPatch: () => void = () => {};
  let markFirstPatchStarted: () => void = () => {};
  const firstPatchGate = new Promise<void>((resolve) => {
    releaseFirstPatch = resolve;
  });
  const firstPatchStarted = new Promise<void>((resolve) => {
    markFirstPatchStarted = resolve;
  });

  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [run] }),
    });
  });
  await page.route("**/api/pipeline/runs/presentation-run", async (route) => {
    expect(route.request().method()).toBe("PATCH");
    const body = route.request().postDataJSON() as { title: string };
    patchBodies.push(body);
    if (patchBodies.length === 1) {
      markFirstPatchStarted();
      await firstPatchGate;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "IDENTITY_UPDATE_REJECTED", message: "Identity update was rejected." } }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...run, titleOverride: body.title }),
    });
  });
  await page.goto("/");

  const rowStatus = page.getByRole("combobox", { name: "Application state for presenta…-run" });
  const row = page.getByRole("row").filter({ has: rowStatus });
  const trigger = row.getByRole("button", { name: "Actions for Original title" });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Edit title" }).click();

  const dialog = page.getByRole("dialog", { name: "Edit application title" });
  const input = dialog.getByRole("textbox", { name: "Title" });
  const save = dialog.getByRole("button", { name: "Save" });
  await expect(input).toHaveValue("Original title");
  await input.fill("  New title  ");
  await save.click();
  await firstPatchStarted;
  await expect(input).toBeDisabled();
  await expect(rowStatus).toBeDisabled();
  await expect(trigger).toBeDisabled();
  await expect(row).toContainText("Original title");
  releaseFirstPatch();

  await expect(dialog.getByRole("alert")).toHaveText("Identity update was rejected.");
  await expect(input).toHaveValue("  New title  ");
  await expect(row).toContainText("Original title");
  await expect(row).not.toContainText("New title");

  await input.fill("  Final title  ");
  await save.click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText("Final title");
  await expect(row.locator(".run-action-trigger")).toBeFocused();
  expect(patchBodies).toEqual([
    { title: "New title" },
    { title: "Final title" },
  ]);

  const search = page.getByRole("searchbox", { name: "Search applications" });
  await search.fill("Final title");
  await expect(row).toBeVisible();
  await search.fill("Original title");
  await expect(page.getByText("No applications match the current search and state.")).toBeVisible();

  await search.fill("Final title");
  const finalTrigger = row.getByRole("button", { name: "Actions for Final title" });
  await finalTrigger.click();
  await page.getByRole("menuitem", { name: "Edit title" }).click();
  await input.fill("Renamed title");
  await save.click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(search).toBeFocused();
  await expect(page.getByText("No applications match the current search and state.")).toBeVisible();
  expect(patchBodies).toEqual([
    { title: "New title" },
    { title: "Final title" },
    { title: "Renamed title" },
  ]);
});

test("requires delete confirmation and removes a run only after a successful bodyless response", async ({ page }) => {
  const run: RunDto = {
    ...runFixture(),
    titleOverride: "Delete candidate",
    organizationOverride: "Example Labs",
  };
  const deleteBodies: Array<string | null> = [];
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [run] }),
    });
  });
  await page.route("**/api/pipeline/runs/presentation-run", async (route) => {
    expect(route.request().method()).toBe("DELETE");
    deleteBodies.push(route.request().postData());
    if (deleteBodies.length === 1) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "RUN_BUSY", message: "Deletion is temporarily blocked." } }),
      });
      return;
    }
    await route.fulfill({ status: 204 });
  });
  await page.goto("/");

  const rowStatus = page.getByRole("combobox", { name: "Application state for presenta…-run" });
  const row = page.getByRole("row").filter({ has: rowStatus });
  const trigger = row.getByRole("button", { name: "Actions for Delete candidate" });
  const openDeleteDialog = async () => {
    await trigger.click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    return page.getByRole("dialog", { name: "Delete application?" });
  };

  let dialog = await openDeleteDialog();
  await expect(dialog).toContainText("Delete Delete candidate from the dashboard?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(deleteBodies).toEqual([]);
  await expect(row).toBeVisible();

  dialog = await openDeleteDialog();
  await dialog.getByRole("button", { name: "Delete application" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Deletion is temporarily blocked.");
  await expect(row).toBeVisible();
  expect(deleteBodies).toEqual([null]);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(row).toBeVisible();

  dialog = await openDeleteDialog();
  await dialog.getByRole("button", { name: "Delete application" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(trigger).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "Search applications" })).toBeFocused();
  await expect(page.getByText("No applications yet. Enter a job posting URL above to initialize one.")).toBeVisible();
  expect(deleteBodies).toEqual([null, null]);
});
