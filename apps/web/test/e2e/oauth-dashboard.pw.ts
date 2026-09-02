import { expect, test, type Route } from "@playwright/test";

type AuthResponseMode = "connected" | "transient-error";

async function fulfillProviderStatuses(route: Route): Promise<void> {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      providers: [
        {
          provider: "openai-codex",
          state: "connected",
          identity: { email: "codex-connected@example.test", accountId: "acct-local-1234" },
        },
        { provider: "gmail", state: "disconnected" },
      ],
    }),
  });
}

test("WEB-AUTH-001 retains connected credential controls across a transient background refresh error", async ({ page }) => {
  let authResponseMode: AuthResponseMode = "connected";
  const quotedCode = "quoted-json-code-private";
  const quotedState = "quoted-json-state-private";

  await page.route("**/api/pipeline/auth", async (route) => {
    expect(route.request().method()).toBe("GET");

    if (authResponseMode === "transient-error") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "AUTH_STATUS_UNAVAILABLE",
            message: `Credential status failed: {"code":"${quotedCode}","state":"${quotedState}"}`,
          },
        }),
      });
      return;
    }

    await fulfillProviderStatuses(route);
  });
  await page.route("**/api/pipeline/runs", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [] }),
    });
  });

  const legacyRoute = await page.request.get("/providers");
  expect(legacyRoute.status()).toBe(404);

  await page.goto("/credentials");

  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  const credentials = page.getByRole("list", { name: "Credentials" });
  const codex = credentials.getByRole("listitem").filter({ hasText: "OpenAI Codex" });
  const gmail = credentials.getByRole("listitem").filter({ hasText: "Gmail" });
  await expect(credentials.getByRole("listitem")).toHaveCount(2);
  await expect(gmail.getByRole("button", { name: "Connect Gmail" })).toBeEnabled();
  await expect(credentials).not.toContainText("Indeed Jobs");

  await expect(codex.getByText("connected", { exact: true })).toBeVisible();
  await expect(codex.getByText("codex-connected@example.test", { exact: true })).toBeVisible();
  await expect(codex.getByText("acct-local-1234", { exact: true })).toBeVisible();
  await expect(credentials).not.toContainText("***");
  await expect(codex.getByRole("button", { name: "Logout OpenAI Codex" })).toBeEnabled();

  await navigation.getByRole("link", { name: "Applications" }).click();
  await expect(page).toHaveURL(/\/$/);

  authResponseMode = "transient-error";
  const failedRefresh = page.waitForResponse((response) =>
    response.url().endsWith("/api/pipeline/auth") && response.status() === 503
  );
  await navigation.getByRole("link", { name: "Credentials" }).click();
  await (await failedRefresh).finished();

  const refreshError = page.getByRole("alert").filter({
    has: page.getByText(
      'Credential status failed: {"code":"[redacted]","state":"[redacted]"}',
      { exact: true },
    ),
  });
  await expect(refreshError).toHaveCount(1);
  await expect(refreshError).not.toContainText(quotedCode);
  await expect(refreshError).not.toContainText(quotedState);
  await expect(codex.getByText("connected", { exact: true })).toBeVisible();
  await expect(codex.getByRole("button", { name: "Logout OpenAI Codex" })).toBeEnabled();

  await navigation.getByRole("link", { name: "Applications" }).click();
  await expect(page).toHaveURL(/\/$/);

  authResponseMode = "connected";
  const recoveredRefresh = page.waitForResponse((response) =>
    response.url().endsWith("/api/pipeline/auth") && response.status() === 200
  );
  await navigation.getByRole("link", { name: "Credentials" }).click();
  await (await recoveredRefresh).finished();

  await expect(page).toHaveURL(/\/credentials$/);
  await expect(refreshError).toHaveCount(0);
  await expect(codex.getByText("connected", { exact: true })).toBeVisible();
  await expect(codex.getByRole("button", { name: "Logout OpenAI Codex" })).toBeEnabled();
});

test("WEB-AUTH-002 opens Gmail authorization in a popup window", async ({ page }) => {
  await page.context().route("**/api/pipeline/auth", fulfillProviderStatuses);
  await page.context().route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [] }),
    });
  });
  await page.context().route("**/api/pipeline/auth/gmail/sessions", async (route) => {
    expect(route.request().method()).toBe("POST");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "gmail-popup-session",
        provider: "gmail",
        state: "pending",
        url: `${new URL(page.url()).origin}/credentials?oauth-popup=1`,
        progress: [],
        expiresAt: Date.now() + 60_000,
      }),
    });
  });
  await page.context().route("**/api/pipeline/auth/sessions/gmail-popup-session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "gmail-popup-session",
        provider: "gmail",
        state: "pending",
        progress: [],
        expiresAt: Date.now() + 60_000,
      }),
    });
  });
  await page.goto("/credentials");
  const popupOpened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect Gmail" }).click();
  const popup = await popupOpened;
  await popup.waitForURL(/oauth-popup=1/);
  await popup.waitForLoadState("domcontentloaded");
  const dimensions = await popup.evaluate(() => ({ width: outerWidth, height: outerHeight }));

  expect(dimensions.width).toBeGreaterThanOrEqual(560);
  expect(dimensions.width).toBeLessThanOrEqual(700);
  expect(dimensions.height).toBeGreaterThanOrEqual(650);
  expect(dimensions.height).toBeLessThanOrEqual(850);
});
