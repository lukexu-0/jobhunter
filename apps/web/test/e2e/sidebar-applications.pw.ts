import { expect, test, type Page, type Route } from "@playwright/test";
import { type ApplicationStatus, type RunDto, type RunStatus } from "@jobhunter/pipeline/contracts";

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

async function interceptEmptyRuns(page: Page): Promise<void> {
  await page.route("**/api/pipeline/runs", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [] }),
    });
  });
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    rootScroll: document.documentElement.scrollWidth,
    rootClient: document.documentElement.clientWidth,
    bodyScroll: document.body.scrollWidth,
  }));
  expect(widths.rootScroll).toBe(widths.rootClient);
  expect(widths.bodyScroll).toBeLessThanOrEqual(widths.rootClient);
}

async function expectHorizontalNavigation(page: Page, width: number, currentLabel: "Applications" | "Providers"): Promise<void> {
  const sidebar = page.locator(".app-sidebar");
  const sidebarBox = await sidebar.boundingBox();
  if (!sidebarBox) throw new Error("Primary navigation geometry is unavailable");
  expect(sidebarBox).toMatchObject({ x: 0, y: 0, width, height: 48 });

  const sidebarStyle = await sidebar.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      position: style.position,
      borderRightWidth: style.borderRightWidth,
      borderBottomWidth: style.borderBottomWidth,
    };
  });
  expect(sidebarStyle).toEqual({
    position: "sticky",
    borderRightWidth: "0px",
    borderBottomWidth: "1px",
  });

  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  const links = navigation.getByRole("link");
  const firstBox = await links.nth(0).boundingBox();
  const secondBox = await links.nth(1).boundingBox();
  if (!firstBox || !secondBox) throw new Error("Primary navigation links are unavailable");
  expect(Math.abs(firstBox.width - secondBox.width)).toBeLessThanOrEqual(1);
  expect(firstBox.width + secondBox.width).toBe(width - 16);
  const linkStyle = await links.nth(0).evaluate((element) => {
    const style = getComputedStyle(element);
    return { justifyContent: style.justifyContent, whiteSpace: style.whiteSpace };
  });
  expect(linkStyle).toEqual({ justifyContent: "center", whiteSpace: "nowrap" });

  const current = navigation.getByRole("link", { name: currentLabel });
  await expect(current).toHaveAttribute("aria-current", "page");
  expect((await current.evaluate((element) => getComputedStyle(element).boxShadow))).toContain("0px -3px");
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string): number => {
    const channels = [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)]
      .map((channel) => Number.parseInt(channel, 16) / 255)
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  };
  const brighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (brighter + 0.05) / (darker + 0.05);
}

function cssRgb(hex: string): string {
  return `rgb(${Number.parseInt(hex.slice(1, 3), 16)}, ${Number.parseInt(hex.slice(3, 5), 16)}, ${Number.parseInt(hex.slice(5, 7), 16)})`;
}

test("shows the controlled initializer for an empty dashboard", async ({ page }) => {
  await interceptEmptyRuns(page);
  await page.goto("/");

  const heading = page.getByRole("heading", { name: "Applications" });
  const initializer = page.getByRole("form", { name: "Initialize application" });
  const keywordMap = initializer.getByRole("checkbox", { name: "Generate keyword map PDF", exact: true });
  await expect(initializer).toBeVisible();
  await expect(heading.locator("xpath=..").locator("+ form")).toHaveCount(1);
  await expect(initializer.getByLabel("Job posting URL")).toHaveAttribute("id", "job-url");
  await expect(keywordMap).toBeEnabled();
  await expect(keywordMap).toBeChecked();
  await expect(keywordMap).toHaveAttribute("aria-describedby", "generate-keyword-map-help");
  await expect(page.locator("#generate-keyword-map-help")).toHaveText(
    "Creates a side-by-side visualization of your resume and the full job description.",
  );
  await expect(initializer.getByRole("textbox")).toHaveCount(1);
  await expect(initializer.getByRole("button", { name: "Initialize" })).toBeDisabled();
  await expect(page.getByText("No applications yet. Enter a job posting URL above to initialize one.", { exact: true })).toBeVisible();

  await expect(page.getByRole("button", { name: /^(New|Close|Create run|Create first application|Cancel)$/ })).toHaveCount(0);
  await expect(page.locator(".run-composer")).toHaveCount(0);
});

test("uses shared request eligibility and remains usable without overflow", async ({ page }) => {
  await interceptEmptyRuns(page);

  for (const width of [1_672, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");

    const initializer = page.getByRole("form", { name: "Initialize application" });
    const input = initializer.getByRole("textbox", { name: "Job posting URL" });
    const initialize = initializer.getByRole("button", { name: "Initialize" });
    const keywordMap = initializer.getByRole("checkbox", { name: "Generate keyword map PDF", exact: true });
    await expect(input).toHaveAttribute("type", "url");
    await expect(input).toHaveAttribute("inputmode", "url");
    await expect(input).toHaveAttribute("autocapitalize", "none");
    await expect(input).toHaveAttribute("autocorrect", "off");
    await expect(input).toHaveAttribute("spellcheck", "false");
    await expect(input).toHaveAttribute("placeholder", "https://company.com/jobs/role");

    for (const invalidUrl of ["", "   ", "example.com/job", "ftp://example.com/job", "https://user:pass@example.com/job"]) {
      await input.fill(invalidUrl);
      await expect(initialize).toBeDisabled();
    }
    await keywordMap.check();
    await expect(initialize).toBeDisabled();
    await input.fill("https://jobs.example.test/roles/123");
    await expect(initialize).toBeEnabled();

    const formBox = await initializer.boundingBox();
    const inputBox = await input.boundingBox();
    const buttonBox = await initialize.boundingBox();
    const optionBox = await keywordMap.locator("xpath=..").boundingBox();
    if (!formBox || !inputBox || !buttonBox || !optionBox) throw new Error("Initializer geometry is unavailable");
    expect(inputBox.x).toBe(formBox.x);
    expect(optionBox.x).toBe(formBox.x);
    expect(optionBox.width).toBe(formBox.width);
    expect(optionBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height);
    if (width > 560) {
      expect(buttonBox.x + buttonBox.width).toBe(formBox.x + formBox.width);
      expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(buttonBox.x);
    } else {
      expect(buttonBox.x).toBe(formBox.x);
      expect(buttonBox.width).toBe(formBox.width);
      expect(buttonBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height);
      expect(buttonBox.y).toBeGreaterThanOrEqual(optionBox.y + optionBox.height);
    }
    await expectNoDocumentOverflow(page);
  }
});


test("posts the canonical URL and default keyword map, disables while pending, and navigates on success", async ({ page }) => {
  const initializedRun = runFixture("initialized-run", "applied", "failed");
  let postedBody: string | null = null;
  let pendingPost: Route | undefined;
  const { promise: postStarted, resolve: markPostStarted } = Promise.withResolvers<void>();

  await page.route("**/api/pipeline/runs", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ runs: [] }),
      });
      return;
    }

    expect(request.method()).toBe("POST");
    expect(request.headers()["content-type"]).toContain("application/json");
    postedBody = request.postData();
    pendingPost = route;
    markPostStarted();
  });
  await page.route("**/api/pipeline/runs/initialized-run", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(initializedRun),
    });
  });
  await page.goto("/");

  const initializer = page.getByRole("form", { name: "Initialize application" });
  const input = initializer.getByRole("textbox", { name: "Job posting URL" });
  const initialize = initializer.getByRole("button", { name: "Initialize" });
  const keywordMap = initializer.getByRole("checkbox", { name: "Generate keyword map PDF", exact: true });
  await input.fill("HTTPS://Jobs.Example.Test:443/roles/123?source=ui#description");
  await expect(keywordMap).toBeChecked();
  await initialize.click();
  await postStarted;

  expect(postedBody).toBe(JSON.stringify({
    jobUrl: "https://jobs.example.test/roles/123?source=ui",
    generateKeywordMap: true,
  }));
  await expect(input).toBeDisabled();
  await expect(keywordMap).toBeDisabled();
  await expect(page.getByRole("button", { name: "Initializing…" })).toBeDisabled();

  if (!pendingPost) throw new Error("Initialize request was not intercepted");
  await pendingPost.fulfill({
    status: 201,
    contentType: "application/json",
    body: JSON.stringify(initializedRun),
  });

  await expect(page).toHaveURL(/\/runs\/initialized-run$/);
  await expect(page.getByRole("heading", { name: "Run initialized-run" })).toBeVisible();
});

test("retains the URL and restores accessible controls after a fixed server failure", async ({ page }) => {
  const submittedUrl = "https://jobs.example.test/unavailable#details";
  let postCount = 0;
  await page.route("**/api/pipeline/runs", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ runs: [] }),
      });
      return;
    }

    expect(request.method()).toBe("POST");
    postCount += 1;
    expect(request.postDataJSON()).toEqual({
      jobUrl: "https://jobs.example.test/unavailable",
      generateKeywordMap: postCount === 1,
    });
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "JOB_DESCRIPTION_UNAVAILABLE",
          message: "The page does not contain a usable job description",
        },
      }),
    });
  });
  await page.goto("/");

  const input = page.getByRole("textbox", { name: "Job posting URL" });
  await input.fill(submittedUrl);
  await page.getByRole("button", { name: "Initialize" }).click();

  const alert = page.locator("#job-url-error");
  await expect(alert).toHaveAttribute("id", "job-url-error");
  await expect(alert).toHaveText("The page does not contain a usable job description");
  await expect(input).toHaveValue(submittedUrl);
  await expect(input).toBeEnabled();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(input).toHaveAttribute("aria-describedby", "job-url-error");
  await expect(page.getByRole("button", { name: "Initialize" })).toBeEnabled();

  const keywordMap = page.getByRole("checkbox", { name: "Generate keyword map PDF", exact: true });
  await expect(keywordMap).toBeChecked();
  await keywordMap.uncheck();
  await expect(alert).toHaveCount(0);
  await expect(input).toHaveValue(submittedUrl);
  await expect(input).not.toHaveAttribute("aria-invalid");
  await expect(input).not.toHaveAttribute("aria-describedby");
  await expect(page.getByRole("button", { name: "Initialize" })).toBeEnabled();

  await page.getByRole("button", { name: "Initialize" }).click();
  await expect(alert).toBeVisible();
  await expect(keywordMap).not.toBeChecked();

  await input.fill("https://jobs.example.test/another-role");
  await expect(alert).toHaveCount(0);
  await expect(input).not.toHaveAttribute("aria-invalid");
  await expect(input).not.toHaveAttribute("aria-describedby");
  await expect(page.getByRole("button", { name: "Initialize" })).toBeEnabled();
  expect(postCount).toBe(2);
});

test("uppercases PDF only for the keyword-map artifact download", async ({ page }) => {
  const artifactRun: RunDto = {
    ...runFixture("artifact-run", "applied", "approved"),
    artifacts: [
      {
        id: "compiled",
        kind: "compiled-pdf",
        revision: 1,
        attempt: 1,
        sha256: "a".repeat(64),
        bytes: 1_024,
        mediaType: "application/pdf",
        href: "/v1/runs/artifact-run/artifacts/compiled",
        public: true,
        createdAt: 1_700_000_000_001,
      },
      {
        id: "keyword-map",
        kind: "keyword-map-pdf",
        revision: 1,
        attempt: 1,
        sha256: "b".repeat(64),
        bytes: 2_048,
        mediaType: "application/pdf",
        href: "/v1/runs/artifact-run/artifacts/keyword-map",
        public: true,
        createdAt: 1_700_000_000_002,
      },
    ],
  };
  await page.route("**/api/pipeline/runs/artifact-run", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(artifactRun),
    });
  });

  await page.goto("/runs/artifact-run");

  await expect(page.getByText("Keyword Map PDF", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download Keyword Map PDF, revision 1" })).toBeVisible();
  await expect(page.getByText("Compiled Pdf", { exact: true })).toBeVisible();
});

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

test("shows application and pipeline status separately", async ({ page }) => {
  const detailRun = runFixture("lifecycle-detail", "rejected", "failed");
  await page.route("**/api/pipeline/runs/lifecycle-detail", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(detailRun),
    });
  });
  await page.goto("/runs/lifecycle-detail");

  const metadataPane = page.getByRole("complementary", { name: "Run metadata and history" });
  const metadata = metadataPane.locator("dl").first();
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
  const providerList = page.getByRole("list", { name: "OAuth providers" });
  const providerRows = providerList.getByRole("listitem");
  await expect(providerRows).toHaveCount(2);
  await expect(providerRows).toContainText([
    "OpenAI Codex",
    "Google Antigravity",
  ]);
  await expect(providerRows.nth(0)).toContainText("OAuth access for tailoring and fallback job-posting extraction.");
});

test("uses the reference-width sidebar and full display workspace", async ({ page }) => {
  await page.setViewportSize({ width: 1_672, height: 941 });
  await interceptRuns(page);
  await page.goto("/");

  const sidebarBox = await page.locator(".app-sidebar").boundingBox();
  const shellWorkspaceBox = await page.locator(".app-shell__workspace").boundingBox();
  const workspaceBox = await page.locator(".workspace").boundingBox();
  const contentBox = await page.locator(".applications-header").boundingBox();
  if (!sidebarBox || !shellWorkspaceBox || !workspaceBox || !contentBox) {
    throw new Error("Application shell geometry is unavailable");
  }

  expect(sidebarBox.width).toBe(248);
  expect(shellWorkspaceBox.x).toBe(248);
  expect(shellWorkspaceBox.width).toBe(1_424);
  expect(workspaceBox.x).toBe(248);
  expect(workspaceBox.width).toBe(1_424);
  expect(contentBox.x).toBe(288);
  expect(contentBox.x + contentBox.width).toBe(1_632);
  await expect(page.getByText("Resume tailoring", { exact: true })).toHaveCount(0);

  const overflow = await page.evaluate(() => ({
    rootWidth: document.documentElement.scrollWidth,
    rootClientWidth: document.documentElement.clientWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(overflow.rootWidth).toBe(overflow.rootClientWidth);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.rootClientWidth);
});

test("uses horizontal navigation and local scrollers on narrow displays", async ({ page }) => {
  test.setTimeout(60_000);
  await interceptRuns(page);
  const detailRun = runFixture("lifecycle-detail", "rejected", "failed");
  await page.route("**/api/pipeline/runs/lifecycle-detail", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(detailRun) });
  });
  await page.route("**/api/pipeline/auth", async (route) => {
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

  for (const width of [768, 375, 320, 300, 280]) {
    await page.setViewportSize({ width, height: 900 });

    await page.goto("/");
    await expectHorizontalNavigation(page, width, "Applications");
    await expectNoDocumentOverflow(page);
    const tableScroller = page.locator(".applications-table-scroll");
    expect(await tableScroller.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
    expect(await tableScroller.evaluate((element) => element.scrollWidth)).toBeGreaterThan(
      await tableScroller.evaluate((element) => element.clientWidth),
    );

    await page.goto("/providers");
    await expectHorizontalNavigation(page, width, "Providers");
    await expectNoDocumentOverflow(page);
    const providerRow = page.locator(".provider-row").first();
    expect(await providerRow.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/))).toHaveLength(1);
    const providerRowBox = await providerRow.boundingBox();
    const providerWorkspaceBox = await page.locator(".workspace").boundingBox();
    if (!providerRowBox || !providerWorkspaceBox) throw new Error("Provider layout geometry is unavailable");
    expect(providerRowBox.x + providerRowBox.width).toBeLessThanOrEqual(providerWorkspaceBox.x + providerWorkspaceBox.width);

    await page.goto("/runs/lifecycle-detail");
    await expectHorizontalNavigation(page, width, "Applications");
    await expectNoDocumentOverflow(page);
    const stageList = page.locator('[class*="stageList"]').first();
    const viewerCanvas = page.locator('[class*="viewerCanvas"]').first();
    expect(await stageList.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
    expect(await viewerCanvas.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
    if (width <= 320) {
      const viewerControls = page.locator('[class*="viewerControls"]').first();
      expect(await viewerControls.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
    }
  }
});

test("uses the original dark palette across surfaces and states", async ({ page }) => {
  const expectedColors = {
    "--color-canvas": "#050606",
    "--color-surface": "#090b0b",
    "--color-surface-raised": "#111413",
    "--color-surface-hover": "#171b1a",
    "--color-border": "#252a28",
    "--color-border-strong": "#4b5450",
    "--color-text": "#eef1ec",
    "--color-muted": "#a4ada7",
    "--color-faint": "#757e79",
    "--color-accent": "#d2f34c",
    "--color-accent-hover": "#e1ff68",
    "--color-good": "#86d79d",
    "--color-info": "#83c6ef",
    "--color-warning": "#ebca73",
    "--color-danger": "#ef8a82",
    "--color-focus": "#d2f34c",
    "--color-application-applied": "#c2a7ef",
    "--color-application-rejected": "#e8ad73",
    "--color-application-interview": "#79cae8",
    "--color-application-accepted": "#79cf92",
    "--color-application-failed": "#ef8179",
  } as const;
  await page.setViewportSize({ width: 1_672, height: 941 });
  await interceptRuns(page);
  await page.goto("/");
  await expect(page.locator(".application-status-control")).toHaveCount(5);

  const rootStyle = await page.evaluate((tokens) => {
    const style = getComputedStyle(document.documentElement);
    return {
      colorScheme: style.colorScheme,
      tokens: Object.fromEntries(tokens.map((token) => [token, style.getPropertyValue(token).trim()])),
    };
  }, Object.keys(expectedColors));
  expect(rootStyle.colorScheme).toBe("dark");
  expect(rootStyle.tokens).toEqual(expectedColors);

  expect(await page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(cssRgb(expectedColors["--color-canvas"]));
  expect(await page.locator(".app-sidebar").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(cssRgb(expectedColors["--color-surface"]));
  const applicationsLink = page.getByRole("link", { name: "Applications" });
  expect(await applicationsLink.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(cssRgb(expectedColors["--color-surface-raised"]));
  expect(await page.locator(".search-control").evaluate((element) => getComputedStyle(element).borderColor)).toBe(cssRgb(expectedColors["--color-border-strong"]));

  await applicationsLink.focus();
  expect(await applicationsLink.evaluate((element) => getComputedStyle(element).outlineColor)).toBe(cssRgb(expectedColors["--color-focus"]));

  for (const status of ["applied", "rejected", "interview", "accepted", "failed"] as const) {
    const token = `--color-application-${status}` as keyof typeof expectedColors;
    const control = page.locator(`.application-status-control--${status}`);
    const style = await control.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        statusColor: computed.getPropertyValue("--application-status-color").trim(),
        color: computed.color,
        borderColor: computed.borderColor,
        backgroundColor: computed.backgroundColor,
      };
    });
    expect(style).toEqual({
      statusColor: expectedColors[token],
      color: cssRgb(expectedColors[token]),
      borderColor: cssRgb(expectedColors[token]),
      backgroundColor: cssRgb(expectedColors["--color-surface"]),
    });
  }

  const foregroundTokens = [
    "--color-text",
    "--color-muted",
    "--color-faint",
    "--color-accent",
    "--color-accent-hover",
    "--color-good",
    "--color-info",
    "--color-warning",
    "--color-danger",
    "--color-focus",
    "--color-application-applied",
    "--color-application-rejected",
    "--color-application-interview",
    "--color-application-accepted",
    "--color-application-failed",
  ] as const;
  for (const token of foregroundTokens) {
    expect(contrastRatio(expectedColors[token], expectedColors["--color-canvas"])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(expectedColors[token], expectedColors["--color-surface"])).toBeGreaterThanOrEqual(4.5);
  }
});

test("uses route-workspace breakpoints for detail panes", async ({ page }) => {
  const detailRun = runFixture("lifecycle-detail", "rejected", "failed");
  await page.route("**/api/pipeline/runs/lifecycle-detail", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(detailRun) });
  });

  await page.setViewportSize({ width: 1_672, height: 941 });
  await page.goto("/runs/lifecycle-detail");
  const wideGeometry = await page.locator(".app-shell__workspace").evaluate((workspace) => ({
    width: workspace.getBoundingClientRect().width,
    rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  }));
  expect(wideGeometry.width / wideGeometry.rootFontSize).toBeGreaterThan(78);
  expect(await page.locator('[class*="paneGrid"]').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/))).toHaveLength(3);

  await page.setViewportSize({ width: 1_440, height: 941 });
  await page.goto("/runs/lifecycle-detail");
  const narrowGeometry = await page.locator(".app-shell__workspace").evaluate((workspace) => ({
    width: workspace.getBoundingClientRect().width,
    rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  }));
  expect(narrowGeometry.width / narrowGeometry.rootFontSize).toBeLessThanOrEqual(78);
  expect(await page.locator('[class*="paneGrid"]').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/))).toHaveLength(1);
});
