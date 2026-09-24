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
        { provider: "google-antigravity", state: "disconnected" },
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
  await page.route("**/api/pipeline/auth/application-model", async (route) => {
    await route.fulfill({ json: { model: "gpt-5.6-sol" } });
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
  await expect(credentials.getByRole("button", { name: "Connect Google Antigravity" })).toBeEnabled();
  await expect(gmail.getByRole("button", { name: "Connect Gmail" })).toBeEnabled();
  await expect(credentials).not.toContainText("Indeed Jobs");

  await expect(codex.getByText("connected", { exact: true })).toBeVisible();
  await expect(codex.getByText("codex-connected@example.test", { exact: true })).toBeVisible();
  await expect(codex.getByText("acct-local-1234", { exact: true })).toHaveCount(0);
  await expect(codex).not.toContainText("openai-codex");
  await expect(gmail).not.toContainText("gmail");
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

  const refreshError = page.getByRole("region", { name: "OAuth credentials" }).getByRole("alert");
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

for (const [provider, name] of [["gmail", "Gmail"], ["google-antigravity", "Google Antigravity"]] as const) {
  test(`opens ${name} authorization in a popup window`, async ({ page }) => {
    await page.context().route("**/api/pipeline/auth", fulfillProviderStatuses);
    await page.context().route("**/api/pipeline/auth/application-model", async (route) => {
      await route.fulfill({ json: { model: "gpt-5.6-sol" } });
    });
    await page.context().route("**/api/pipeline/runs", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ runs: [] }),
      });
    });
    await page.context().route(`**/api/pipeline/auth/${provider}/sessions`, async (route) => {
      expect(route.request().method()).toBe("POST");
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: `${provider}-popup-session`,
          provider,
          state: "pending",
          url: `${new URL(page.url()).origin}/credentials?oauth-popup=1`,
          progress: [],
          expiresAt: Date.now() + 60_000,
        }),
      });
    });
    await page.context().route(`**/api/pipeline/auth/sessions/${provider}-popup-session`, async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: `${provider}-popup-session`,
          provider,
          state: "pending",
          progress: [],
          expiresAt: Date.now() + 60_000,
        }),
      });
    });
    await page.goto("/credentials");
    const popupOpened = page.waitForEvent("popup");
    await page.getByRole("button", { name: `Connect ${name}` }).click();
    const popup = await popupOpened;
    await popup.waitForURL(/oauth-popup=1/);
    await popup.waitForLoadState("domcontentloaded");
    const dimensions = await popup.evaluate(() => ({ width: outerWidth, height: outerHeight }));
  
    expect(dimensions.width).toBeGreaterThanOrEqual(560);
    expect(dimensions.width).toBeLessThanOrEqual(700);
    expect(dimensions.height).toBeGreaterThanOrEqual(650);
    expect(dimensions.height).toBeLessThanOrEqual(850);
  });
}

for (const [provider, name, responseValue] of [
  ["openai-codex", "OpenAI Codex", "manual-test-code"],
  ["gmail", "Gmail", "http://localhost/oauth/callback?code=callback-test-code&state=callback-test-state"],
] as const) {
  test("completes and disconnects " + name + " using a private prompt response", async ({ page }) => {
    let connected = false;
    const session = {
      id: provider + "-prompt-session", provider, state: "pending", progress: [],
      expiresAt: Date.now() + 60_000,
      url: "http://localhost/sign-in",
      prompt: { kind: provider === "gmail" ? "prompt" : "manual-code", message: "Enter authorization response" },
    };
    await page.addInitScript(() => { window.open = () => null; });
    await page.route("**/api/pipeline/auth", async (route) => {
      await route.fulfill({ json: {
        providers: ["openai-codex", "google-antigravity", "gmail"].map((candidate) => ({
          provider: candidate,
          state: candidate === provider && connected ? "connected" : "disconnected",
          ...(candidate === provider && connected ? { identity: { email: "authorized@example.test" } } : {}),
        })),
      } });
    });
    await page.route("**/api/pipeline/auth/application-model", async (route) => {
      await route.fulfill({ json: { model: "gpt-5.6-sol" } });
    });
    await page.route("**/api/pipeline/runs", async (route) => { await route.fulfill({ json: { runs: [] } }); });
    await page.route("**/api/pipeline/auth/" + provider + "/sessions", async (route) => {
      await route.fulfill({ status: 201, json: session });
    });
    await page.route("**/api/pipeline/auth/sessions/" + session.id, async (route) => {
      await route.fulfill({ json: session });
    });
    await page.route("**/api/pipeline/auth/sessions/" + session.id + "/prompt", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ value: responseValue });
      connected = true;
      await route.fulfill({ json: { ...session, state: "succeeded", prompt: undefined } });
    });
    await page.route("**/api/pipeline/auth/" + provider, async (route) => {
      expect(route.request().method()).toBe("DELETE");
      connected = false;
      await route.fulfill({ status: 204 });
    });

    await page.goto("/credentials");
    const row = page.getByRole("list", { name: "Credentials" }).getByRole("listitem").filter({ hasText: name });
    await row.getByRole("button", { name: "Connect " + name }).click();
    await expect(row.getByRole("alert")).toBeVisible();
    await expect(row.getByRole("link", { name: "Open " + name + " sign-in" })).toBeVisible();
    await row.getByLabel("Enter authorization response").fill(responseValue);
    await row.getByRole("button", { name: "Submit " + name + " authorization response" }).click();
    await expect(row.getByText("connected", { exact: true })).toBeVisible();
    await expect(row.getByText("authorized@example.test")).toBeVisible();
    await expect(row.getByRole("textbox")).toHaveCount(0);
    await expect(row).not.toContainText(responseValue);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(responseValue);
    await row.getByRole("button", { name: "Logout " + name }).click();
    await expect(row.getByRole("button", { name: "Connect " + name })).toBeEnabled();
    await expect(row.getByRole("link", { name: "Open " + name + " sign-in" })).toHaveCount(0);
  });
}

test("switches application models without changing connected credentials", async ({ page }) => {
  await page.route("**/api/pipeline/auth", async (route) => {
    await route.fulfill({ json: { providers: [
      { provider: "openai-codex", state: "connected" },
      { provider: "google-antigravity", state: "connected" },
      { provider: "gmail", state: "disconnected" },
    ] } });
  });
  await page.route("**/api/pipeline/runs", async (route) => { await route.fulfill({ json: { runs: [] } }); });
  await page.route("**/api/pipeline/auth/application-model", async (route) => {
    await route.fulfill({ json: route.request().method() === "PUT" ? route.request().postDataJSON() : { model: "gpt-5.6-sol" } });
  });
  await page.goto("/credentials");
  const model = page.getByRole("switch", { name: "Use Google Antigravity 3.8 Flash for applications" });
  await expect(model).toBeEnabled();
  await model.click();
  await expect(model).toBeChecked();
  await model.click();
  await expect(model).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Logout OpenAI Codex" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Logout Google Antigravity" })).toBeEnabled();
});
