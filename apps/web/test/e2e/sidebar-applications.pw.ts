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

test("uses the light mint palette across surfaces and states", async ({ page }) => {
  const expectedColors = {
    "--color-canvas": "#f4faf6",
    "--color-surface": "#eaf4ee",
    "--color-surface-raised": "#dfede5",
    "--color-surface-hover": "#d4e7db",
    "--color-border": "#bad3c4",
    "--color-border-strong": "#668a76",
    "--color-text": "#143b2b",
    "--color-muted": "#365d4b",
    "--color-faint": "#4d6f5f",
    "--color-accent": "#176b47",
    "--color-accent-hover": "#0f5537",
    "--color-good": "#1c6842",
    "--color-info": "#256753",
    "--color-warning": "#536b2f",
    "--color-danger": "#2f5334",
    "--color-focus": "#0b7548",
    "--color-application-applied": "#2f6f55",
    "--color-application-rejected": "#52653a",
    "--color-application-interview": "#1f6a62",
    "--color-application-accepted": "#176b3d",
    "--color-application-failed": "#234b32",
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
  expect(rootStyle.colorScheme).toBe("light");
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
  expect(contrastRatio(expectedColors["--color-border-strong"], expectedColors["--color-canvas"])).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(expectedColors["--color-border-strong"], expectedColors["--color-surface"])).toBeGreaterThanOrEqual(3);
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
