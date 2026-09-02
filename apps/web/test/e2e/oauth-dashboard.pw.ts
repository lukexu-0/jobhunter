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
          identity: { email: "codex-connected@example.test" },
        },
        { provider: "gmail", state: "disconnected" },
      ],
    }),
  });
}

test("WEB-AUTH-001 retains connected provider controls across a transient background refresh error", async ({ page }) => {
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
            message: `Provider status failed: {"code":"${quotedCode}","state":"${quotedState}"}`,
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

  await page.goto("/providers");

  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  const providers = page.getByRole("list", { name: "OAuth providers" });
  const codex = providers.getByRole("listitem").filter({ hasText: "OpenAI Codex" });
  const gmail = providers.getByRole("listitem").filter({ hasText: "Gmail" });
  await expect(providers.getByRole("listitem")).toHaveCount(2);
  await expect(providers).not.toContainText("Indeed Jobs");

  await expect(codex.getByText("connected", { exact: true })).toBeVisible();
  await expect(codex.getByText("codex-connected@example.test", { exact: true })).toBeVisible();
  await expect(codex.getByRole("button", { name: "Logout OpenAI Codex" })).toBeEnabled();
  await expect(gmail.getByText("disconnected", { exact: true })).toBeVisible();
  await expect(gmail.getByRole("button", { name: "Connect Gmail" })).toBeEnabled();

  await navigation.getByRole("link", { name: "Applications" }).click();
  await expect(page).toHaveURL(/\/$/);

  authResponseMode = "transient-error";
  const failedRefresh = page.waitForResponse((response) =>
    response.url().endsWith("/api/pipeline/auth") && response.status() === 503
  );
  await navigation.getByRole("link", { name: "Providers" }).click();
  await (await failedRefresh).finished();

  const refreshError = page.getByRole("alert").filter({
    has: page.getByText(
      'Provider status failed: {"code":"[redacted]","state":"[redacted]"}',
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
  await navigation.getByRole("link", { name: "Providers" }).click();
  await (await recoveredRefresh).finished();

  await expect(page).toHaveURL(/\/providers$/);
  await expect(refreshError).toHaveCount(0);
  await expect(codex.getByText("connected", { exact: true })).toBeVisible();
  await expect(codex.getByRole("button", { name: "Logout OpenAI Codex" })).toBeEnabled();
});
