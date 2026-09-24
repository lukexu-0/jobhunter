import { expect, test, type Page, type Route } from "@playwright/test";
import { ApplicationSessionSnapshotDtoSchema, type RunDto } from "../../app/lib/pipeline-contracts";
import { installBrowserNotificationProbe } from "./browser-notification-probe";

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

function dashboardRun({
  id,
  title,
  updatedAt,
  createdAt = updatedAt,
  applicationStatus = "pending",
  isApplying = false,
}: {
  id: string;
  title: string;
  updatedAt: number;
  createdAt?: number;
  applicationStatus?: RunDto["applicationStatus"];
  isApplying?: boolean;
}): RunDto {
  return {
    ...runFixture(),
    id,
    titleOverride: title,
    createdAt,
    updatedAt,
    applicationStatus,
    isApplying,
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

  for (const name of ["Role", "Organization", "Added", "Pipeline status", "Application status"]) {
    const heading = page.getByRole("columnheader", { name, exact: true });
    await expect(heading).toHaveCSS("background-color", "rgb(17, 20, 19)");
    await expect(heading).toHaveCSS("color", "rgb(210, 243, 76)");
    await expect(heading).toHaveCSS("font-size", "13px");
  }
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

test("shows a decorative mapped kind icon beside every populated application title", async ({ page }) => {
  const kinds = [
    {
      kind: "job",
      title: "Backend Engineer",
      visibleTitle: "Backend Engineer",
      accessibleName: "Open Backend Engineer job-kind-run",
    },
    {
      kind: "hackathon",
      title: "Build Sprint",
      visibleTitle: "Build Sprint",
      accessibleName: "Open hackathon Build Sprint hackatho…-run",
    },
    {
      kind: "competition",
      title: "Data Challenge",
      visibleTitle: "Data Challenge",
      accessibleName: "Open competition Data Challenge competit…-run",
    },
    {
      kind: "event",
      title: "Career Fair",
      visibleTitle: "Career Fair",
      accessibleName: "Open event Career Fair event-ki…-run",
    },
    {
      kind: "networking_event",
      title: "Alumni Mixer",
      visibleTitle: "Alumni Mixer",
      accessibleName: "Open networking event Alumni Mixer networki…-run",
    },
  ] as const;
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        runs: kinds.map(({ kind, title }) => ({
          ...runFixture(),
          id: `${kind}-kind-run`,
          opportunityKind: kind,
          titleOverride: title,
        })),
      }),
    });
  });
  await page.goto("/");

  for (const { accessibleName, visibleTitle } of kinds) {
    const link = page.getByRole("link", { name: accessibleName, exact: true });
    const label = link.locator(".application-link__label");
    const icon = link.locator("svg");
    await expect(link).toHaveAttribute("aria-label", accessibleName);
    await expect(label).toHaveText(visibleTitle);
    for (const prefix of ["Job", "Hackathon", "Competition", "Event", "Networking event"]) {
      await expect(label).not.toContainText(`${prefix} ·`);
      await expect(label).not.toContainText(`${prefix}. `);
    }
    await expect(icon).toHaveCount(1);
    await expect(icon).toHaveAttribute("aria-hidden", "true");
    await expect(icon).toHaveCSS("color", "rgb(210, 243, 76)");

    const [iconBox, labelBox] = await Promise.all([
      icon.boundingBox(),
      label.boundingBox(),
    ]);
    if (!iconBox || !labelBox) throw new Error("Application kind icon geometry is unavailable");
    const iconCenter = iconBox.y + iconBox.height / 2;
    const labelCenter = labelBox.y + labelBox.height / 2;
    expect(Math.abs(iconCenter - labelCenter)).toBeLessThanOrEqual(1);
  }
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

test("guides first-run setup only when the required resume baseline is missing", async ({ page }) => {
  await interceptEmptyRuns(page);
  let baselineMissing = true;
  await page.route("**/api/pipeline/context", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        fresh: !baselineMissing,
        manifestMatches: !baselineMissing,
        staleSources: [],
        missingSources: baselineMissing ? ["resume-baseline"] : [],
      }),
    });
  });

  await page.goto("/");
  const guidance = page.getByText(/Place your own generic resume\.tex/);
  await expect(guidance).toContainText(".jobhunt-data/user-info/resume-main/resume.tex");
  await expect(guidance).toContainText("required before creating an application");
  await expect(page.getByText("No applications yet. Enter an opportunity URL above to initialize one.")).toBeVisible();

  baselineMissing = false;
  await page.reload();
  await expect(guidance).toHaveCount(0);
  await expect(page.getByText("No applications yet. Enter an opportunity URL above to initialize one.")).toBeVisible();
});

test("uses six application columns in every table state", async ({ page }) => {
  let pendingRoute: Route | undefined;
  await page.route("**/api/pipeline/runs", async (route) => {
    pendingRoute = route;
  });
  await page.goto("/");
  await expect.poll(() => Boolean(pendingRoute)).toBe(true);

  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveCount(6);
  await expect(table.getByRole("columnheader", { name: "Revision", exact: true })).toHaveCount(0);
  await expect(table.getByText("Loading applications…", { exact: true })).toBeVisible();
  await expect(table.locator("tbody td[colspan]")).toHaveAttribute("colspan", "6");

  if (!pendingRoute) throw new Error("Loading request was not captured");
  await pendingRoute.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ runs: [] }),
  });
  await expect(page.getByText("No applications yet. Enter an opportunity URL above to initialize one.", { exact: true })).toBeVisible();
  await expect(table.locator("tbody td[colspan]")).toHaveAttribute("colspan", "6");

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
  await expect(table.locator("tbody td[colspan]")).toHaveAttribute("colspan", "6");

  await page.unroute("**/api/pipeline/runs");
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [runFixture()] }),
    });
  });
  await page.reload();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody tr").first().locator("td")).toHaveCount(6);
  await expect(table.getByText("R01", { exact: true })).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search applications" }).fill("no match");
  await expect(page.getByText("No applications match the current search and statuses.", { exact: true })).toBeVisible();
  await expect(table.locator("tbody td[colspan]")).toHaveAttribute("colspan", "6");
});

test("shows total resumes beside the submitted application count", async ({ page }) => {
  const applicationStatuses: RunDto["applicationStatus"][] = [
    "pending",
    "did_not_apply",
    "manual_application",
    "applied",
    "oa_received",
    "oa_completed",
    "rejected",
    "interview",
    "accepted",
    "failed",
  ];
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        runs: applicationStatuses.map((applicationStatus, index) => dashboardRun({
          id: `summary-run-${index}`,
          title: `Summary role ${index}`,
          updatedAt: 1_700_000_000_000 + index,
          applicationStatus,
        })),
      }),
    });
  });
  await page.goto("/");

  const summary = page.getByRole("region", { name: "Resume and application counts" });
  const resumeMetric = summary.getByRole("group", { name: "Total resumes" });
  const applicationMetric = summary.getByRole("group", { name: "Applications" });
  await expect(resumeMetric.getByText("10", { exact: true })).toBeVisible();
  await expect(applicationMetric.getByText("6", { exact: true })).toBeVisible();
  await expect(summary.getByText("Total resumes", { exact: true })).toHaveCSS("font-size", "11px");

  const resumeBox = await resumeMetric.boundingBox();
  const applicationBox = await applicationMetric.boundingBox();
  if (!resumeBox || !applicationBox) throw new Error("Summary metric geometry is unavailable");

  expect(resumeBox.x + resumeBox.width).toBeLessThanOrEqual(applicationBox.x);
  expect(Math.abs(resumeBox.y + resumeBox.height - (applicationBox.y + applicationBox.height))).toBeLessThanOrEqual(1);
});

test("scrolls the applications table locally only when six columns do not fit", async ({ page }) => {
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

test("keeps the application toolbar within the viewport above its stacking breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await interceptEmptyRuns(page);
  await page.goto("/");

  const documentWidth = await page.locator("html").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(documentWidth.scrollWidth).toBe(documentWidth.clientWidth);
});

test("separates pipeline and application status across workflow stages", async ({ page }) => {
  const runs: RunDto[] = [
    { ...runFixture(), id: "tailoring-stage", titleOverride: "Tailoring role", status: "tailoring", applicationStatus: "pending" },
    { ...runFixture(), id: "review-stage", titleOverride: "Review role", status: "review", applicationStatus: "pending" },
    { ...runFixture(), id: "in-progress-stage", titleOverride: "In-progress role", status: "approved", applicationStatus: "pending" },
    { ...runFixture(), id: "completed-stage", titleOverride: "Completed role", status: "approved", applicationStatus: "applied" },
  ];
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs }),
    });
  });
  await page.goto("/");

  await expect(page.getByRole("columnheader", { name: "Pipeline status" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Application status" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Tailoring role" })).toContainText("Tailoring");
  await expect(page.getByRole("row").filter({ hasText: "Review role" })).toContainText("Awaiting review");
  await expect(page.getByRole("row").filter({ hasText: "In-progress role" })).toContainText("In-progress");
  await expect(page.getByRole("row").filter({ hasText: "Completed role" })).toContainText("Completed");
  const pendingApplicationStatus = page.getByRole("combobox", { name: /Application status for tailorin/ });
  await expect(pendingApplicationStatus).toHaveValue("pending");
  await expect(pendingApplicationStatus.locator("option:checked")).toHaveText("Pending application");
});

test("filters pipeline and application statuses independently", async ({ page }) => {
  const runs: RunDto[] = [
    { ...runFixture(), id: "filter-tailoring", titleOverride: "Tailoring role", status: "tailoring", applicationStatus: "pending" },
    { ...runFixture(), id: "filter-review", titleOverride: "Review role", status: "review", applicationStatus: "pending" },
    { ...runFixture(), id: "filter-progress", titleOverride: "In-progress role", status: "approved", applicationStatus: "pending" },
    { ...runFixture(), id: "filter-completed", titleOverride: "Completed role", status: "approved", applicationStatus: "applied" },
    { ...runFixture(), id: "filter-tailoring-failed", titleOverride: "Tailoring failure", status: "failed", applicationStatus: "pending" },
    { ...runFixture(), id: "filter-application-failed", titleOverride: "Application failure", status: "approved", applicationStatus: "pending", applicationFailureGeneration: 1 },
  ];
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ runs }) });
  });
  await page.goto("/");

  const pipelineFilter = page.getByRole("combobox", { name: "Filter applications by pipeline status" });
  const applicationFilter = page.getByRole("combobox", { name: "Filter applications by application status" });

  const rows = page.getByRole("table").locator("tbody");
  for (const title of ["Tailoring failure", "Application failure"]) {
    await expect(rows.getByRole("row").filter({ hasText: title }).getByLabel(/Pipeline status for/)).toHaveText("Failed");
  }
  await pipelineFilter.selectOption("failed");
  await expect(rows.getByRole("link")).toHaveText(["Tailoring failure", "Application failure"]);
  await applicationFilter.selectOption("applied");
  await expect(page.getByText("No applications match the current search and statuses.")).toBeVisible();
  await applicationFilter.selectOption("all");
  await pipelineFilter.selectOption("completed");
  await expect(rows.getByRole("link")).toHaveText(["Completed role"]);
  await pipelineFilter.selectOption("awaiting_review");
  await expect(page.getByRole("table").locator("tbody").getByRole("link")).toHaveText(["Review role"]);
  await applicationFilter.selectOption("applied");
  await expect(page.getByText("No applications match the current search and statuses.")).toBeVisible();
  await pipelineFilter.selectOption("all");
  await expect(page.getByRole("table").locator("tbody").getByRole("link")).toHaveText(["Completed role"]);
});

test("requests browser notifications on first startup and notifies once when a dashboard run becomes Awaiting review", async ({ page }) => {
  const notifications = await installBrowserNotificationProbe(page, {
    initialPermission: "default",
    notificationsEnabled: null,
  });
  let reviewReady = false;
  let listRequestCount = 0;
  const activeRun: RunDto = {
    ...runFixture(),
    id: "dashboard-review-alert",
    titleOverride: "Alert-ready role",
    status: "visual_qa",
    applicationStatus: "pending",
    revision: 5,
  };
  await page.route("**/api/pipeline/runs", async (route) => {
    listRequestCount += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        runs: [
          { ...activeRun, status: reviewReady ? "review" : "visual_qa" },
          {
            ...activeRun,
            id: "dashboard-poll-keeper",
            titleOverride: "Polling role",
            queueSequence: 2,
          },
        ],
      }),
    });
  });
  await page.goto("/");

  const browserNotifications = page.getByRole("checkbox", { name: "Browser notifications" });
  await expect(browserNotifications).toBeVisible();
  await expect.poll(() => page.evaluate(() => Notification.permission)).toBe("granted");
  await expect(browserNotifications).toBeChecked();

  reviewReady = true;
  await expect.poll(notifications, { timeout: 7_000 }).toEqual([{
    body: "Review the tailored resume in Jobhunt.",
    tag: expect.stringMatching(/^jobhunt:/),
    title: "Resume ready for review",
  }]);
  await expect(page.getByRole("row").filter({ hasText: "Alert-ready role" })).toContainText("Awaiting review");
  const requestCountAtNotification = listRequestCount;
  await expect.poll(() => listRequestCount, { timeout: 5_000 }).toBeGreaterThan(requestCountAtNotification);
  expect(await notifications()).toHaveLength(1);
});

test("alerts for an application needing attention while viewing credentials", async ({ page }) => {
  const notifications = await installBrowserNotificationProbe(page);
  let applying = false;
  const run = dashboardRun({ id: "global-attention", title: "Background application", updatedAt: 10 });
  await page.route("**/api/pipeline/runs", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ runs: [{ ...run, isApplying: applying }] }),
  }));
  await page.route("**/api/pipeline/runs/global-attention/application", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(ApplicationSessionSnapshotDtoSchema.parse({
      generation: 1, bridgeState: "awaiting_human_navigation", harnessState: "awaiting_human_navigation",
      submissionPhase: "not_attempted", createdAt: 10, updatedAt: 11, terminalAt: null, expiresAt: null,
      company: null, role: null, fieldsFilled: [], fieldsNeedingHuman: [], filesAttached: [], warnings: [],
      revisionCount: 0, pendingAction: { type: "human_navigation", instruction: "Complete the checkpoint." },
      error: null,
    })),
  }));
  await page.goto("/");
  await expect(page.getByRole("row").filter({ hasText: "Background application" })).toBeVisible();
  await page.getByRole("link", { name: "Credentials", exact: true }).click();
  await expect(page).toHaveURL(/\/credentials$/);
  applying = true;
  await expect.poll(notifications, { timeout: 8_000 }).toEqual([{
    body: "Return to Jobhunt to continue the application.",
    tag: "jobhunt:application:global-attention",
    title: "Application needs attention",
  }]);
  await page.getByRole("link", { name: "Applications", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Background application" })).toBeVisible();
  expect(await notifications()).toHaveLength(1);
});

test("uses lifecycle order and exposes a square accessible row action menu without an arrow", async ({ page }) => {
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [runFixture()] }),
    });
  });
  await page.goto("/");

  const statusLabels = [
    "Pending application",
    "Did not apply",
    "Manual application",
    "Applied",
    "OA received",
    "OA completed",
    "Rejected",
    "Interview",
    "Accepted",
  ];
  const applicationFilter = page.getByRole("combobox", { name: "Filter applications by application status" });
  const rowStatus = page.getByRole("combobox", { name: "Application status for presenta…-run" });
  const row = page.getByRole("row").filter({ has: rowStatus });
  const trigger = row.getByRole("button", { name: "Actions for presenta…-run" });

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
  await applicationFilter.evaluate((element) => {
    (element as HTMLSelectElement).value = "pending";
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(trigger).toHaveCount(0);
  await expect(menu).toHaveCount(0);
  await page.evaluate(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
  await expect(page.getByRole("searchbox", { name: "Search applications" })).toBeFocused();
  await applicationFilter.evaluate((element) => {
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

  const trigger = page.getByRole("button", { name: "Actions for Externally deleted" });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
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

  const applicationFilter = page.getByRole("combobox", { name: "Filter applications by application status" });
  const rowStatus = page.getByRole("combobox", { name: "Application status for presenta…-run" });
  const failedOption = rowStatus.locator('option[value="failed"]');

  await expect(applicationFilter.locator('option[value="failed"]')).toHaveCount(0);
  await expect(rowStatus).toHaveValue("failed");
  await expect(failedOption).toBeDisabled();
  await expect(rowStatus.locator("option:not([disabled])")).toHaveText([
    "Pending application",
    "Did not apply",
    "Manual application",
    "Applied",
    "OA received",
    "OA completed",
    "Rejected",
    "Interview",
    "Accepted",
  ]);
});

test("renders application status text with stronger contrast", async ({ page }) => {
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [runFixture()] }),
    });
  });
  await page.goto("/");

  const rowStatus = page.getByRole("combobox", { name: "Application status for presenta…-run" });
  await expect(rowStatus).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(rowStatus).toHaveCSS("font-size", "15px");
});

test("keeps the action menu and dialog usable at narrow widths", async ({ page }) => {
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
  const sortControl = page.getByRole("combobox", { name: "Sort applications" });
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

  const trigger = page.getByRole("button", { name: "Actions for Focus target" });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
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

  const rowStatus = page.getByRole("combobox", { name: "Application status for presenta…-run" });
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

test("approves and immediately applies an awaiting-review resume from the dashboard", async ({ page }) => {
  const pdfSha256 = "a".repeat(64);
  let run: RunDto = {
    ...runFixture(),
    id: "direct-apply-review",
    titleOverride: "Review role",
    status: "review",
    applicationStatus: "pending",
    jobUrl: "https://example.com/jobs/review-role",
    currentPdfSha256: pdfSha256,
    visualAcknowledgementRequired: true,
  };
  const running = ApplicationSessionSnapshotDtoSchema.parse({
    generation: 1, bridgeState: "running", harnessState: "running",
    submissionPhase: "not_attempted", createdAt: 10, updatedAt: 11, terminalAt: null, expiresAt: null,
    company: null, role: null, fieldsFilled: [], fieldsNeedingHuman: [], filesAttached: [], warnings: [],
    revisionCount: 0, pendingAction: null, error: null,
  });
  const requests: string[] = [];
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [run] }),
    });
  });
  await page.route("**/api/pipeline/runs/direct-apply-review/approve", async (route) => {
    requests.push("approve");
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      expectedPdfSha256: pdfSha256,
      acknowledgeVisualIssues: true,
    });
    run = { ...run, status: "approved" };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
  });
  await page.route("**/api/pipeline/runs/direct-apply-review/application", async (route) => {
    if (route.request().method() === "GET" && run.isApplying) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(running) });
      return;
    }
    if (route.request().method() === "GET") {
      requests.push("preflight");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ state: "not_started", canStart: false, canStartAfterApproval: true }),
      });
      return;
    }
    requests.push("start");
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      expectedApprovedPdfSha256: pdfSha256,
      autoSubmit: true,
      autoEnd: true,
    });
    run = { ...run, isApplying: true, isApplicationSessionOpen: true };
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(running) });
  });

  await page.goto("/");
  await page.getByRole("checkbox", { name: "Auto-submit applications" }).check();
  await page.getByRole("checkbox", { name: "Auto-end successful sessions" }).check();

  const apply = page.getByRole("button", { name: "Apply for Review role" });
  await expect(apply).toBeVisible();
  await apply.click();
  await expect.poll(() => requests).toEqual(["preflight", "approve", "start"]);
  await expect(apply).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Open application sessions" })).toBeVisible();
  await expect(page).toHaveURL("/");
});

test("does not approve an awaiting-review resume when application preflight is blocked", async ({ page }) => {
  const pdfSha256 = "b".repeat(64);
  const run: RunDto = {
    ...runFixture(),
    id: "blocked-review-apply",
    titleOverride: "Blocked review role",
    status: "review",
    applicationStatus: "pending",
    jobUrl: "https://example.com/jobs/blocked-review-role",
    currentPdfSha256: pdfSha256,
  };
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ runs: [run] }) });
  });
  let approvalRequests = 0;
  await page.route("**/api/pipeline/runs/blocked-review-apply/approve", async (route) => {
    approvalRequests += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...run, status: "approved" }) });
  });
  await page.route("**/api/pipeline/runs/blocked-review-apply/application", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        state: "not_started",
        canStart: false,
        canStartAfterApproval: false,
        blockedReason: "harness_unconfigured",
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Apply for Blocked review role" }).click();

  await expect(page.getByRole("alert", { name: "Run action error" })).toHaveText(
    "Automatic application is not available for this run yet. Open the run to review what is required.",
  );
  expect(approvalRequests).toBe(0);
});

test("keeps a manual application visible without offering Apply", async ({ page }) => {
  const run: RunDto = {
    ...runFixture(),
    titleOverride: "Manual role",
    jobUrl: "https://example.com/jobs/manual",
    currentPdfSha256: "a".repeat(64),
    applicationStatus: "manual_application" as RunDto["applicationStatus"],
  };
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [run] }),
    });
  });
  await page.goto("/");

  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: /^Open Manual role/ }) });
  const rowStatus = row.getByRole("combobox", { name: /Application status/ });
  await expect(rowStatus).toHaveValue("manual_application");
  await expect(rowStatus.locator('option[value="manual_application"]')).toHaveText("Manual application");
  await expect(page.getByRole("button", { name: "Apply for Manual role" })).toHaveCount(0);
});

test("queues every applyable job from newest to oldest creation date", async ({ page }) => {
  const pdfSha256 = "b".repeat(64);
  const baseRun: RunDto = {
    ...runFixture(),
    jobUrl: "https://example.com/jobs/apply-all",
    currentPdfSha256: pdfSha256,
  };
  const runs: RunDto[] = [
    { ...baseRun, id: "apply-all-pending", titleOverride: "Older pending role", applicationStatus: "pending", createdAt: 100, updatedAt: 900 },
    { ...baseRun, id: "apply-all-skipped", titleOverride: "Newer skipped role", applicationStatus: "did_not_apply", createdAt: 300, updatedAt: 400 },
    { ...baseRun, id: "apply-all-manual", titleOverride: "Manual role", applicationStatus: "manual_application" },
    { ...baseRun, id: "apply-all-applied", titleOverride: "Applied role", applicationStatus: "applied" },
    { ...baseRun, id: "apply-all-no-url", titleOverride: "Missing URL role", jobUrl: undefined },
  ];
  const applyingRunIds = new Set<string>();
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        runs: runs.map((run) => applyingRunIds.has(run.id) ? { ...run, isApplying: true } : run),
      }),
    });
  });
  const running = ApplicationSessionSnapshotDtoSchema.parse({
    generation: 1, bridgeState: "running", harnessState: "running",
    submissionPhase: "not_attempted", createdAt: 10, updatedAt: 11, terminalAt: null, expiresAt: null,
    company: null, role: null, fieldsFilled: [], fieldsNeedingHuman: [], filesAttached: [], warnings: [],
    revisionCount: 0, pendingAction: null, error: null,
  });
  const startRequests: string[] = [];
  const startBodies: unknown[] = [];
  let releaseStarts: (() => void) | undefined;
  const startsReleased = new Promise<void>((resolve) => { releaseStarts = resolve; });
  await page.route("**/api/pipeline/runs/*/application", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "SESSION_NOT_FOUND", message: "No session" } }) });
      return;
    }
    const runId = new URL(route.request().url()).pathname.split("/").at(-2);
    if (!runId) throw new Error("Application start request omitted its run ID");
    startRequests.push(runId);
    startBodies.push(route.request().postDataJSON());
    applyingRunIds.add(runId);
    await startsReleased;
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(running) });
  });
  await page.goto("/");
  await page.getByRole("checkbox", { name: "Auto-submit applications" }).check();
  await page.getByRole("checkbox", { name: "Auto-end successful sessions" }).check();

  const applyAll = page.getByRole("button", { name: "Apply all" });
  await expect(applyAll).toBeEnabled();
  await applyAll.click();
  await expect.poll(() => startRequests).toEqual(["apply-all-skipped"]);
  await expect(applyAll).toBeDisabled();
  releaseStarts?.();
  await expect.poll(() => startRequests).toEqual(["apply-all-skipped", "apply-all-pending"]);
  expect(startBodies).toEqual([
    { expectedApprovedPdfSha256: pdfSha256, autoSubmit: true, autoEnd: true },
    { expectedApprovedPdfSha256: pdfSha256, autoSubmit: true, autoEnd: true },
  ]);
  await expect(page.getByRole("button", { name: "Apply all" })).toBeDisabled();
});

test("retries every and only failed tailoring run from Retry all", async ({ page }) => {
  let runs: RunDto[] = [
    { ...runFixture(), id: "retry-all-first", titleOverride: "First failed role", status: "failed" },
    { ...runFixture(), id: "retry-all-approved", titleOverride: "Approved role", status: "approved" },
    { ...runFixture(), id: "retry-all-second", titleOverride: "Second failed role", status: "failed" },
  ];
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ runs }) });
  });
  const retryRequests: string[] = [];
  let releaseRetries: (() => void) | undefined;
  const retriesReleased = new Promise<void>((resolve) => { releaseRetries = resolve; });
  await page.route("**/api/pipeline/runs/*/retry", async (route) => {
    expect(route.request().method()).toBe("POST");
    const runId = new URL(route.request().url()).pathname.split("/").at(-2);
    const run = runs.find((candidate) => candidate.id === runId);
    if (!runId || !run) throw new Error("Retry request omitted a failed run ID");
    retryRequests.push(runId);
    await retriesReleased;
    const updated = { ...run, status: "queued" as const };
    runs = runs.map((candidate) => candidate.id === runId ? updated : candidate);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(updated) });
  });
  await page.goto("/");

  const retryAll = page.getByRole("button", { name: "Retry all" });
  await expect(retryAll).toBeEnabled();
  await retryAll.click();
  await expect.poll(() => retryRequests.toSorted()).toEqual(["retry-all-first", "retry-all-second"]);
  await expect(retryAll).toBeDisabled();
  releaseRetries?.();
  await expect(retryAll).toBeDisabled();
});

test("starts unapplied resumes directly and confirms reapplying an applied resume", async ({ page }) => {
  const pdfSha256 = "a".repeat(64);
  const baseRun: RunDto = {
    ...runFixture(),
    jobUrl: "https://example.com/jobs/direct-apply",
    currentPdfSha256: pdfSha256,
  };
  const runs: RunDto[] = [
    { ...baseRun, id: "direct-apply-pending", titleOverride: "Pending role", applicationStatus: "pending" },
    { ...baseRun, id: "direct-apply-skipped", titleOverride: "Did not apply role", applicationStatus: "did_not_apply" },
    {
      ...baseRun,
      id: "direct-apply-lost-session",
      titleOverride: "Lost session role",
      applicationStatus: "pending",
    },
    { ...baseRun, id: "direct-apply-failed-status", titleOverride: "Failed status role", applicationStatus: "failed" },
    { ...baseRun, id: "direct-apply-complete", titleOverride: "Applied role", applicationStatus: "applied" },
  ];
  const running = ApplicationSessionSnapshotDtoSchema.parse({
    generation: 2, bridgeState: "running", harnessState: "running",
    submissionPhase: "not_attempted", createdAt: 10, updatedAt: 11, terminalAt: null, expiresAt: null,
    company: null, role: null, fieldsFilled: [], fieldsNeedingHuman: [], filesAttached: [], warnings: [],
    revisionCount: 0, pendingAction: null, error: null,
  });
  const lost = ApplicationSessionSnapshotDtoSchema.parse({
    ...running,
    generation: 1, bridgeState: "lost", harnessState: "running", terminalAt: 10,
    warnings: ["Verify whether the application was submitted before retrying."],
    error: null,
  });
  const applyingRunIds = new Set<string>();
  const listedRuns = () => runs.map((run) => applyingRunIds.has(run.id) ? { ...run, isApplying: true } : run);
  const fulfillRuns = (route: Route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ runs: listedRuns() }),
  });
  let holdNextRefresh = false;
  let heldRefresh: Route | undefined;
  await page.route("**/api/pipeline/runs", async (route) => {
    if (holdNextRefresh) {
      holdNextRefresh = false;
      heldRefresh = route;
      return;
    }
    await fulfillRuns(route);
  });
  let startRequests = 0;
  await page.route("**/api/pipeline/runs/direct-apply-skipped/application", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(running) });
      return;
    }
    startRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      expectedApprovedPdfSha256: pdfSha256,
      autoSubmit: false,
      autoEnd: false,
    });
    applyingRunIds.add("direct-apply-skipped");
    holdNextRefresh = true;
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(running) });
  });
  let terminalStartRequests = 0;
  await page.route("**/api/pipeline/runs/direct-apply-lost-session/application", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(running) });
      return;
    }
    terminalStartRequests += 1;
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(lost) });
  });
  let retryRequests = 0;
  await page.route("**/api/pipeline/runs/direct-apply-lost-session/application/retry", async (route) => {
    retryRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      expectedApprovedPdfSha256: pdfSha256,
      autoSubmit: false,
      autoEnd: false,
    });
    applyingRunIds.add("direct-apply-lost-session");
    holdNextRefresh = true;
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(running) });
  });
  let reapplyRequests = 0;
  await page.route("**/api/pipeline/runs/direct-apply-complete/application", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(running) });
      return;
    }
    reapplyRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      expectedApprovedPdfSha256: pdfSha256,
      autoSubmit: false,
      autoEnd: false,
      reapply: true,
    });
    applyingRunIds.add("direct-apply-complete");
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(running) });
  });
  await page.goto("/");

  const applyButtons = page.getByRole("button", { name: /^Apply for / });
  await expect(applyButtons).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Apply for Pending role" })).toBeVisible();
  const startApply = page.getByRole("button", { name: "Apply for Did not apply role" });
  const retryApply = page.getByRole("button", { name: "Apply for Lost session role" });
  await expect(page.getByRole("button", { name: "Apply for Failed status role" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply for Applied role", exact: true })).toHaveCount(0);
  const reapply = page.getByRole("button", { name: "Reapply for Applied role" });
  await expect(reapply).toBeVisible();
  await reapply.click();
  const reapplyDialog = page.getByRole("dialog", { name: "Reapply to Applied role?" });
  await expect(reapplyDialog).toBeVisible();
  expect(reapplyRequests).toBe(0);
  await reapplyDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(reapplyDialog).toHaveCount(0);

  await reapply.click();
  await page.getByRole("dialog", { name: "Reapply to Applied role?" })
    .getByRole("button", { name: "Reapply" }).click();
  await expect.poll(() => reapplyRequests).toBe(1);
  await expect(reapply).toHaveCount(0);

  await startApply.click();
  await expect.poll(() => heldRefresh !== undefined).toBe(true);
  await expect(startApply).toHaveCount(0);
  expect(startRequests).toBe(1);
  await expect(page).toHaveURL("/");
  const firstRefresh = heldRefresh;
  if (!firstRefresh) throw new Error("Post-start run refresh was not held");
  heldRefresh = undefined;
  await fulfillRuns(firstRefresh);

  await retryApply.click();
  await expect.poll(() => retryRequests).toBe(1);
  await expect.poll(() => heldRefresh !== undefined).toBe(true);
  await expect(retryApply).toHaveCount(0);
  expect(terminalStartRequests).toBe(1);
  await expect(page).toHaveURL("/");
  const secondRefresh = heldRefresh;
  if (!secondRefresh) throw new Error("Post-retry run refresh was not held");
  heldRefresh = undefined;
  await fulfillRuns(secondRefresh);
});

test("Cmd-click opens a run row and its title in new tabs without leaving the dashboard", async ({ context, page }) => {
  const run = { ...runFixture(), titleOverride: "Platform Engineer" };
  await context.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ runs: [run] }) });
  });
  await context.route("**/api/pipeline/runs/presentation-run", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(run) });
  });
  await page.goto("/");

  const row = page.getByRole("row").filter({ hasText: "Platform Engineer" });
  const [rowTab] = await Promise.all([
    context.waitForEvent("page", { timeout: 5_000 }),
    row.getByRole("cell").nth(1).click({ modifiers: ["Meta"] }),
  ]);
  await expect(rowTab).toHaveURL(/\/runs\/presentation-run$/);
  await expect(page).toHaveURL("/");
  await expect(row).toBeVisible();
  await rowTab.close();

  const [titleTab] = await Promise.all([
    context.waitForEvent("page", { timeout: 5_000 }),
    row.getByRole("link").click({ modifiers: ["ControlOrMeta"] }),
  ]);
  await expect(titleTab).toHaveURL(/\/runs\/presentation-run$/);
  await expect(page).toHaveURL("/");
  expect(context.pages()).toHaveLength(2);
  await titleTab.close();
});

for (const outcome of ["success", "failure"] as const) {
  test(
    outcome === "success"
      ? "late successful identity edits cannot close a replacement dialog"
      : "late failed identity edits cannot overwrite a replacement dialog's errors",
    async ({ page }) => {
      const first: RunDto = { ...runFixture(), id: "dialog-first", titleOverride: "First role" };
      const second: RunDto = { ...runFixture(), id: "dialog-second", titleOverride: "Second role" };
      let listed = [first, second];
      let pendingPatch: Route | undefined;
      let markPatchStarted!: () => void;
      const patchStarted = new Promise<void>((resolve) => { markPatchStarted = resolve; });
      await page.route("**/api/pipeline/runs", (route) => route.fulfill({
        contentType: "application/json", body: JSON.stringify({ runs: listed }),
      }));
      await page.route("**/api/pipeline/runs/dialog-first", (route) => {
        expect(route.request().method()).toBe("PATCH");
        pendingPatch = route;
        markPatchStarted();
      });
      await page.route("**/api/pipeline/runs/dialog-second", (route) => route.fulfill({
        status: 409, contentType: "application/json",
        body: JSON.stringify({ error: { code: "IDENTITY_UPDATE_REJECTED", message: "Second role update was rejected." } }),
      }));
      await page.goto("/");
      const firstTrigger = page.getByRole("button", { name: "Actions for First role" });
      await firstTrigger.scrollIntoViewIfNeeded();
      await firstTrigger.click();
      await page.getByRole("menuitem", { name: "Edit title" }).click();
      const dialog = page.getByRole("dialog", { name: "Edit application title" });
      const input = dialog.getByRole("textbox", { name: "Title" });
      await input.fill("First role edited");
      await dialog.getByRole("button", { name: "Save" }).click();
      await patchStarted;
      listed = [second];
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });
      const secondTrigger = page.getByRole("button", { name: "Actions for Second role" });
      await secondTrigger.scrollIntoViewIfNeeded();
      await secondTrigger.click();
      await page.getByRole("menuitem", { name: "Edit title" }).click();
      await expect(input).toHaveValue("Second role");
      await input.fill("Replacement draft");
      await expect(input).toBeFocused();

      if (!pendingPatch) throw new Error("First identity request was not intercepted");
      const patch = pendingPatch;
      const response = page.waitForResponse((next) => next.request() === patch.request());
      await patch.fulfill(outcome === "success" ? {
        contentType: "application/json",
        body: JSON.stringify({ ...first, titleOverride: "First role edited", updatedAt: first.updatedAt + 1 }),
      } : {
        status: 409, contentType: "application/json",
        body: JSON.stringify({ error: { code: "IDENTITY_UPDATE_REJECTED", message: "First role update was rejected." } }),
      });
      await (await response).finished();
      await page.evaluate(() => new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
      }));
      await expect(dialog).toBeVisible();
      await expect(input).toHaveValue("Replacement draft");
      await expect(input).toBeFocused();
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      if (outcome === "failure") {
        await dialog.getByRole("button", { name: "Save" }).click();
        await expect(dialog.getByRole("alert")).toHaveText("Second role update was rejected.");
        await expect(input).toHaveValue("Replacement draft");
      }
    },
  );
}

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

  const rowStatus = page.getByRole("combobox", { name: "Application status for presenta…-run" });
  const row = page.getByRole("row").filter({ has: rowStatus });
  const trigger = row.getByRole("button", { name: "Actions for Original title" });
  await trigger.scrollIntoViewIfNeeded();
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
  await expect(page.getByText("No applications match the current search and statuses.")).toBeVisible();

  await search.fill("Final title");
  const finalTrigger = row.getByRole("button", { name: "Actions for Final title" });
  await finalTrigger.click();
  await page.getByRole("menuitem", { name: "Edit title" }).click();
  await input.fill("Renamed title");
  await save.click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(search).toBeFocused();
  await expect(page.getByText("No applications match the current search and statuses.")).toBeVisible();
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

  const rowStatus = page.getByRole("combobox", { name: "Application status for presenta…-run" });
  const row = page.getByRole("row").filter({ has: rowStatus });
  const trigger = row.getByRole("button", { name: "Actions for Delete candidate" });
  await trigger.scrollIntoViewIfNeeded();
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
  await expect(page.getByText("No applications yet. Enter an opportunity URL above to initialize one.")).toBeVisible();
  expect(deleteBodies).toEqual([null, null]);
});

test("prioritizes every non-ended session and restores closed sessions to creation order", async ({ page }) => {
  const baseTime = 1_700_000_000_000;
  const openSessionRun: RunDto = {
    ...dashboardRun({
      id: "open-session-priority",
      title: "Submitted oldest",
      updatedAt: baseTime + 300,
      isApplying: false,
    }),
    isApplicationSessionOpen: true,
  };
  const closedSessionRun: RunDto = {
    ...openSessionRun,
    isApplicationSessionOpen: false,
  };
  const submitted = ApplicationSessionSnapshotDtoSchema.parse({
    generation: 1, bridgeState: "submitted", harnessState: "submitted",
    submissionPhase: "submitted", createdAt: 10, updatedAt: 11, terminalAt: null, expiresAt: null,
    company: null, role: null, fieldsFilled: [], fieldsNeedingHuman: [], filesAttached: [], warnings: [],
    revisionCount: 0, playwrightCliDiagnostics: [], pendingAction: null, error: null,
  });
  const otherRuns = [
    dashboardRun({ id: "ordinary-old", title: "Ordinary old", createdAt: baseTime + 200, updatedAt: baseTime + 900 }),
    dashboardRun({ id: "ordinary-new", title: "Ordinary new", updatedAt: baseTime + 400, applicationStatus: "applied" }),
    dashboardRun({ id: "rejected-new", title: "Rejected new", updatedAt: baseTime + 500, applicationStatus: "rejected" }),
    dashboardRun({ id: "rejected-old", title: "Rejected old", updatedAt: baseTime + 50, applicationStatus: "rejected" }),
  ];
  let pollRequests = 0;
  let holdPoll = false;
  let pendingPoll: Route | undefined;
  await page.route("**/api/pipeline/runs/open-session-priority/application", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(submitted),
  }));
  await page.route("**/api/pipeline/runs", async (route) => {
    if (!holdPoll) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ runs: [openSessionRun, ...otherRuns] }),
      });
      return;
    }
    pollRequests += 1;
    pendingPoll = route;
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const table = page.getByRole("table");
  const roleLinks = table.locator("tbody").getByRole("link");
  const sessionRow = table.getByRole("row").filter({ hasText: "Submitted oldest" });
  const openSessions = page.getByRole("region", { name: "Open application sessions", exact: true });
  await expect(openSessions).toBeVisible();
  await expect(openSessions.getByRole("link")).toHaveCount(1);
  await expect(openSessions.getByRole("link", { name: /Submitted oldest/ })).toHaveAttribute("href", "/runs/open-session-priority");
  const pipelineStatus = sessionRow.getByLabel(/Pipeline status for .*: In-progress/);
  await expect(pipelineStatus).toHaveText("In-progress");
  await expect(roleLinks).toHaveText([
    "Submitted oldest",
    "Ordinary new",
    "Ordinary old",
    "Rejected new",
    "Rejected old",
  ]);

  await page.getByRole("combobox", { name: "Sort applications" }).selectOption("oldest");
  await expect(roleLinks).toHaveText([
    "Submitted oldest",
    "Ordinary old",
    "Ordinary new",
    "Rejected old",
    "Rejected new",
  ]);

  holdPoll = true;
  await page.waitForTimeout(3_250);
  expect(pollRequests).toBe(1);
  await expect.poll(() => Boolean(pendingPoll), { timeout: 5_000 }).toBe(true);
  await pendingPoll!.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ runs: [closedSessionRun, ...otherRuns] }),
  });

  await expect(openSessions).toHaveCount(0);
  await expect(pipelineStatus).toHaveText("In-progress");
  await expect(roleLinks).toHaveText([
    "Ordinary old",
    "Submitted oldest",
    "Ordinary new",
    "Rejected old",
    "Rejected new",
  ]);
});

test("ends every and only open application session with bodyless requests", async ({ page }) => {
  const openIds = new Set(["end-all-running", "end-all-submitted"]);
  const runs = [
    dashboardRun({ id: "end-all-running", title: "Running session", updatedAt: 300, isApplying: true }),
    dashboardRun({ id: "end-all-submitted", title: "Submitted session", updatedAt: 200 }),
    dashboardRun({ id: "end-all-closed", title: "Closed session", updatedAt: 100 }),
  ];
  const running = ApplicationSessionSnapshotDtoSchema.parse({
    generation: 1, bridgeState: "running", harnessState: "running",
    submissionPhase: "not_attempted", createdAt: 10, updatedAt: 11, terminalAt: null, expiresAt: null,
    company: null, role: null, fieldsFilled: [], fieldsNeedingHuman: [], filesAttached: [], warnings: [],
    revisionCount: 0, playwrightCliDiagnostics: [], pendingAction: null, error: null,
  });
  const endedIds: string[] = [];
  const deleteBodies: Array<string | null> = [];

  await page.route("**/api/pipeline/runs/*/application", async (route) => {
    const match = new URL(route.request().url()).pathname.match(/\/runs\/([^/]+)\/application$/);
    expect(match).not.toBeNull();
    const id = decodeURIComponent(match![1]!);
    if (route.request().method() === "GET") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(running) });
      return;
    }
    expect(route.request().method()).toBe("DELETE");
    deleteBodies.push(route.request().postData());
    endedIds.push(id);
    openIds.delete(id);
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/pipeline/runs", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      runs: runs.map((run) => ({
        ...run,
        isApplying: run.id === "end-all-running" && openIds.has(run.id),
        isApplicationSessionOpen: openIds.has(run.id),
      })),
    }),
  }));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const openSessions = page.getByRole("region", { name: "Open application sessions" });
  await expect(openSessions.getByRole("link")).toHaveCount(2);
  await openSessions.getByRole("button", { name: "End all" }).click();

  await expect.poll(() => endedIds.sort()).toEqual(["end-all-running", "end-all-submitted"]);
  expect(deleteBodies).toEqual([null, null]);
  await expect(openSessions).toHaveCount(0);
});

test("keeps active application sessions in pending status and visible independently of table filters", async ({ page }) => {
  const runs = [
    dashboardRun({
      id: "filter-applying",
      title: "Active pending application",
      updatedAt: 1_700_000_000_300,
      isApplying: true,
    }),
    dashboardRun({
      id: "filter-pending",
      title: "Durable pending application",
      updatedAt: 1_700_000_000_200,
    }),
    dashboardRun({
      id: "filter-applied",
      title: "Durable applied application",
      updatedAt: 1_700_000_000_100,
      applicationStatus: "applied",
    }),
  ];
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs }),
    });
  });
  await page.goto("/");

  const activeApplications = page.getByRole("region", { name: "Open application sessions", exact: true });
  const activeLink = activeApplications.getByRole("link", { name: /Active pending application/ });
  const pipelineFilter = page.getByRole("combobox", { name: "Filter applications by pipeline status" });
  const applicationFilter = page.getByRole("combobox", { name: "Filter applications by application status" });
  const visibleRoleLinks = page.getByRole("table").locator("tbody").getByRole("link");
  await applicationFilter.selectOption("pending");
  await expect(visibleRoleLinks).toHaveText(["Active pending application", "Durable pending application"]);
  await expect(activeApplications.getByRole("link")).toHaveCount(1);
  await expect(activeLink).toBeVisible();

  await applicationFilter.selectOption("applied");
  await expect(visibleRoleLinks).toHaveText(["Durable applied application"]);
  await expect(activeLink).toBeVisible();

  await applicationFilter.selectOption("all");
  await pipelineFilter.selectOption("completed");
  await expect(visibleRoleLinks).toHaveText(["Durable applied application"]);
  await expect(activeLink).toBeVisible();

  await pipelineFilter.selectOption("all");
  await page.getByRole("searchbox", { name: "Search applications" }).fill("Durable pending");
  await expect(visibleRoleLinks).toHaveText(["Durable pending application"]);
  await expect(activeLink).toBeVisible();
});

test("updates active application attention from session polls without losing unresolved attention on read failure", async ({ page }) => {
  test.setTimeout(45_000);
  const run = dashboardRun({ id: "attention-lifecycle", title: "Attention lifecycle application", updatedAt: 10, isApplying: true });
  let applying = true;
  let pendingSession: Route | undefined;
  const running = ApplicationSessionSnapshotDtoSchema.parse({
    generation: 1, bridgeState: "running", harnessState: "running",
    submissionPhase: "not_attempted", createdAt: 10, updatedAt: 11, terminalAt: null, expiresAt: null,
    company: null, role: null, fieldsFilled: [], fieldsNeedingHuman: [], filesAttached: [], warnings: [],
    revisionCount: 0, pendingAction: null, error: null,
  });
  await page.route("**/api/pipeline/runs", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ runs: [{ ...run, isApplying: applying }] }),
  }));
  await page.route("**/api/pipeline/runs/attention-lifecycle/application", (route) => {
    pendingSession = route;
  });
  const waitForSessionPoll = async () => {
    await expect.poll(() => Boolean(pendingSession), { timeout: 7_000 }).toBe(true);
  };
  const answerSessionPoll = async (snapshot: typeof running, status = 200) => {
    await waitForSessionPoll();
    const route = pendingSession!;
    pendingSession = undefined;
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(status === 200 ? ApplicationSessionSnapshotDtoSchema.parse(snapshot) : { error: "Temporary session read failure" }),
    });
    // The next real provider poll starts only after this response has been processed.
    await waitForSessionPoll();
  };
  await page.goto("/");
  const activeApplications = page.getByRole("region", { name: "Open application sessions", exact: true });
  const activeCard = activeApplications.getByRole("link", { name: /Attention lifecycle application/ });
  const attention = activeCard.getByText("Needs attention", { exact: true });
  await answerSessionPoll(running);
  await expect(activeCard).toBeVisible();
  await expect(attention).toHaveCount(0);

  await answerSessionPoll({ ...running, bridgeState: "awaiting_human_review", harnessState: "awaiting_human_review", pendingAction: { type: "human_review" } });
  await expect(attention).toBeVisible();

  await answerSessionPoll(running, 503);
  await expect(attention).toBeVisible();
  await expect(activeCard).toBeVisible();

  await answerSessionPoll(running);
  await expect(attention).toHaveCount(0);
  await expect(activeCard).toBeVisible();

  await answerSessionPoll({ ...running, bridgeState: "awaiting_human_navigation", harnessState: "awaiting_human_navigation", pendingAction: { type: "human_navigation", instruction: "Complete the checkpoint." } });
  await expect(attention).toBeVisible();
  await answerSessionPoll(running);
  await expect(attention).toHaveCount(0);
  await answerSessionPoll({ ...running, bridgeState: "awaiting_human_navigation", harnessState: "awaiting_human_navigation", pendingAction: { type: "credentials" } });
  await expect(attention).toBeVisible();

  applying = false;
  await pendingSession!.fulfill({ contentType: "application/json", body: JSON.stringify(running) });
  await expect(activeApplications).toHaveCount(0);
  await expect(page.getByRole("table").getByRole("link", { name: /Attention lifecycle application/ })).toBeVisible();
});

test("keeps every active application visible while paginating and resets every page size change to page 1", async ({ page }) => {
  const runs = Array.from({ length: 70 }, (_, index) => dashboardRun({
    id: `page-size-${index + 1}`,
    title: `Application ${String(index + 1).padStart(2, "0")}`,
    updatedAt: 1_700_000_000_000 + index,
    isApplying: index < 12,
  }));
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs }),
    });
  });
  await page.goto("/");

  const activeApplications = page.getByRole("region", { name: "Open application sessions", exact: true });
  const activeLinks = activeApplications.getByRole("link");
  const tableLinks = page.getByRole("table").locator("tbody").getByRole("link");
  const pageSize = page.getByRole("combobox", { name: "Applications per page" });
  const pagination = page.getByRole("navigation", { name: "Applications pagination" });
  await expect(pageSize.locator("option")).toHaveText(["10", "20", "50"]);
  await expect(pageSize).toHaveValue("10");
  await expect(pagination).toContainText("Showing 1 to 10 of 70 applications");
  await expect(activeLinks).toHaveCount(12);
  await expect(activeLinks.filter({ hasText: "Application 01" })).toBeVisible();
  await expect(tableLinks.filter({ hasText: "Application 01" })).toHaveCount(0);

  for (const size of [20, 50, 10]) {
    await pagination.getByRole("button", { name: "Next page" }).click();
    await expect(pagination.getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
    await expect(activeLinks).toHaveCount(12);
    await expect(activeLinks.filter({ hasText: "Application 12" })).toBeVisible();
    await expect(tableLinks.filter({ hasText: "Application 12" })).toHaveCount(0);
    await pageSize.selectOption(String(size));
    await expect(pagination.getByRole("button", { name: "Page 1" })).toHaveAttribute("aria-current", "page");
    await expect(pagination).toContainText(`Showing 1 to ${size} of 70 applications`);
  }
});
