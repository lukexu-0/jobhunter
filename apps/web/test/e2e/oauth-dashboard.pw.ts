import { createServer, type Server } from "node:http";
import { expect, test, type Route } from "@playwright/test";

type AuthResponseMode = "connected" | "transient-error";
const pipelinePort = Number(process.env.JOBHUNTER_E2E_PIPELINE_PORT ?? "3467");
const indeedCallbackPath = "/v1/auth/indeed/callback";

interface CallbackScenario {
  readonly receive: (callbackUrl: URL) => void;
}

let callbackScenario: CallbackScenario | null = null;
let pipelineServer: Server;

test.beforeAll(async () => {
  pipelineServer = createServer((request, response) => {
    const callbackUrl = new URL(request.url ?? "/", `http://127.0.0.1:${pipelinePort}`);
    if (
      request.method !== "GET"
      || callbackUrl.pathname !== indeedCallbackPath
      || callbackScenario === null
    ) {
      response.writeHead(404).end();
      return;
    }

    callbackScenario.receive(callbackUrl);
    response.writeHead(204, {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    }).end();
  });
  await new Promise<void>((resolve, reject) => {
    pipelineServer.once("error", reject);
    pipelineServer.listen(pipelinePort, "127.0.0.1", () => {
      pipelineServer.off("error", reject);
      resolve();
    });
  });
});

test.afterEach(() => {
  callbackScenario = null;
});

test.afterAll(async () => {
  if (!pipelineServer.listening) return;
  await new Promise<void>((resolve, reject) => {
    pipelineServer.close((error) => error ? reject(error) : resolve());
  });
});


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
        {
          provider: "indeed",
          state: "disconnected",
        },
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
  const indeed = providers.getByRole("listitem").filter({ hasText: "Indeed Jobs" });
  await expect(providers.getByRole("listitem")).toHaveCount(2);
  await expect(providers).not.toContainText("Google Antigravity");

  await expect(codex.getByText("connected", { exact: true })).toBeVisible();
  await expect(codex.getByText("codex-connected@example.test", { exact: true })).toBeVisible();
  await expect(codex.getByRole("button", { name: "Logout OpenAI Codex" })).toBeEnabled();
  await expect(indeed.getByText("disconnected", { exact: true })).toBeVisible();
  await expect(indeed.getByRole("button", { name: "Connect Indeed Jobs" })).toBeEnabled();

  await navigation.getByRole("link", { name: "Applications" }).click();
  await expect(page).toHaveURL(/\/$/);

  authResponseMode = "transient-error";
  const failedRefresh = page.waitForResponse((response) =>
    response.url().endsWith("/api/pipeline/auth") && response.status() === 503,
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
  await expect(indeed.getByText("disconnected", { exact: true })).toBeVisible();
  await expect(indeed.getByRole("button", { name: "Connect Indeed Jobs" })).toBeDisabled();

  await navigation.getByRole("link", { name: "Applications" }).click();
  await expect(page).toHaveURL(/\/$/);

  authResponseMode = "connected";
  const recoveredRefresh = page.waitForResponse((response) =>
    response.url().endsWith("/api/pipeline/auth") && response.status() === 200,
  );
  await navigation.getByRole("link", { name: "Providers" }).click();
  await (await recoveredRefresh).finished();

  await expect(page).toHaveURL(/\/providers$/);
  await expect(refreshError).toHaveCount(0);
  await expect(codex.getByText("connected", { exact: true })).toBeVisible();
  await expect(codex.getByRole("button", { name: "Logout OpenAI Codex" })).toBeEnabled();
  await expect(indeed.getByText("disconnected", { exact: true })).toBeVisible();
  await expect(indeed.getByRole("button", { name: "Connect Indeed Jobs" })).toBeEnabled();
});

test("WEB-AUTH-002 forwards Indeed through the Next callback rewrite without exposing callback values", async ({ page }) => {
  const callbackCode = "indeed-callback-code-private";
  const oauthState = "indeed-oauth-state-private";
  const pkceChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  const indeedResource = "https://mcp.indeed.com/claude/mcp";
  const indeedScope = "job_seeker.jobs.search offline_access";
  const privateValues = [callbackCode, oauthState];
  const baseURL = test.info().project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("OAuth fixture requires a browser base URL");
  const callbackEndpoint = new URL("/api/pipeline/auth/indeed/callback", baseURL);
  const authorizationUrl = new URL("https://secure.indeed.com/oauth/v2/authorize");
  authorizationUrl.searchParams.set("client_id", "fixture-client");
  authorizationUrl.searchParams.set("redirect_uri", callbackEndpoint.href);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("state", oauthState);
  authorizationUrl.searchParams.set("code_challenge", pkceChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("resource", indeedResource);
  authorizationUrl.searchParams.set("scope", indeedScope);

  const browserContext = page.context();
  const observedRequests: Array<{
    readonly headers: Readonly<Record<string, string>>;
    readonly method: string;
    readonly postData: string | null;
    readonly url: string;
  }> = [];
  browserContext.on("request", (request) => {
    observedRequests.push({
      headers: request.headers(),
      method: request.method(),
      postData: request.postData(),
      url: request.url(),
    });
  });

  let indeedConnected = false;
  const callbackRecord: { forwardCount: number; url: URL | null } = {
    forwardCount: 0,
    url: null,
  };
  let releaseCallback = () => {};
  const callbackObserved = new Promise<void>((resolve) => {
    releaseCallback = resolve;
  });
  let markPollStarted = () => {};
  const pollStarted = new Promise<void>((resolve) => {
    markPollStarted = resolve;
  });
  callbackScenario = {
    receive: (callbackUrl) => {
      callbackRecord.url = callbackUrl;
      callbackRecord.forwardCount += 1;
      indeedConnected = true;
      releaseCallback();
    },
  };

  await browserContext.route("**/api/pipeline/auth", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        providers: [
          { provider: "openai-codex", state: "disconnected" },
          {
            provider: "indeed",
            state: indeedConnected ? "connected" : "disconnected",
            ...(indeedConnected ? { identity: { email: "indeed-connected@example.test" } } : {}),
          },
        ],
      }),
    });
  });
  await browserContext.route("**/api/pipeline/runs", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [] }),
    });
  });
  await browserContext.route("**/api/pipeline/auth/indeed/sessions", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postData()).toBe("{}");
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "indeed-session",
        provider: "indeed",
        state: "pending",
        url: authorizationUrl.href,
        instructions: "Complete authorization in the Indeed sign-in tab.",
        progress: ["Waiting for Indeed authorization."],
        expiresAt: 1_900_000_000_000,
      }),
    });
  });
  await browserContext.route("**/api/pipeline/auth/sessions/indeed-session", async (route) => {
    expect(route.request().method()).toBe("GET");
    markPollStarted();
    await callbackObserved;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "indeed-session",
        provider: "indeed",
        state: "succeeded",
        progress: ["Indeed authorization completed."],
        expiresAt: 1_900_000_000_000,
      }),
    });
  });
  await browserContext.route("https://secure.indeed.com/oauth/v2/authorize**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      headers: { "referrer-policy": "no-referrer" },
      body: "<!doctype html><title>Indeed authorization</title><p>Indeed authorization fixture</p>",
    });
  });

  await page.goto("/providers");

  const providers = page.getByRole("list", { name: "OAuth providers" });
  const codex = providers.getByRole("listitem").filter({ hasText: "OpenAI Codex" });
  const indeed = providers.getByRole("listitem").filter({ hasText: "Indeed Jobs" });
  await expect(providers.getByRole("listitem")).toHaveCount(2);
  await expect(codex.getByText("disconnected", { exact: true })).toBeVisible();
  await expect(codex.getByRole("button", { name: "Connect OpenAI Codex" })).toBeEnabled();
  await expect(indeed.getByText("disconnected", { exact: true })).toBeVisible();

  const popupPromise = page.waitForEvent("popup");
  await indeed.getByRole("button", { name: "Connect Indeed Jobs" }).click();
  const authorizationPage = await popupPromise;
  await authorizationPage.waitForURL((url) =>
    url.origin === authorizationUrl.origin && url.pathname === authorizationUrl.pathname
  );
  await authorizationPage.waitForLoadState("domcontentloaded");
  const openedAuthorizationUrl = new URL(authorizationPage.url());
  expect(
    openedAuthorizationUrl.origin === authorizationUrl.origin
      && openedAuthorizationUrl.pathname === authorizationUrl.pathname,
    "Indeed authorization did not open at the verified endpoint",
  ).toBe(true);
  expect(openedAuthorizationUrl.searchParams.get("redirect_uri")).toBe(callbackEndpoint.href);
  expect(openedAuthorizationUrl.searchParams.get("response_type")).toBe("code");
  expect(
    openedAuthorizationUrl.searchParams.get("state") === oauthState,
    "Indeed authorization did not preserve the opaque state",
  ).toBe(true);
  expect(openedAuthorizationUrl.searchParams.get("code_challenge")).toBe(pkceChallenge);
  expect(openedAuthorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(openedAuthorizationUrl.searchParams.getAll("resource")).toEqual([indeedResource]);
  expect(openedAuthorizationUrl.searchParams.getAll("scope")).toEqual([indeedScope]);
  expect(await authorizationPage.evaluate(() => window.opener === null)).toBe(true);
  const authorizationRequest = observedRequests.find(({ url }) => url === authorizationUrl.href);
  expect(authorizationRequest?.headers.referer).toBeUndefined();

  await expect(indeed.getByText("Authorization session", { exact: true })).toBeVisible();
  await expect(indeed.getByRole("link", { name: "Open Indeed Jobs sign-in" })).toBeVisible();
  await expect(indeed.getByRole("button", { name: "Cancel Indeed Jobs authorization" })).toBeEnabled();
  await expect(
    indeed.getByText("Your browser blocked the sign-in window. Use the Open sign-in link below.", { exact: true }),
  ).toHaveCount(0);
  await expect(codex.getByText("disconnected", { exact: true })).toBeVisible();
  await expect(codex.getByRole("button", { name: "Connect OpenAI Codex" })).toBeEnabled();
  const pendingProviderText = await page.locator("body").innerText();
  expect(
    privateValues.some((privateValue) => pendingProviderText.includes(privateValue)),
    "Pending provider status exposed private callback data",
  ).toBe(false);
  await pollStarted;

  const callbackUrl = new URL(callbackEndpoint);
  callbackUrl.searchParams.set("code", callbackCode);
  callbackUrl.searchParams.set("state", oauthState);
  callbackUrl.searchParams.set("iss", "https://secure.indeed.com");
  await authorizationPage.goto(callbackUrl.href).catch((error: unknown) => {
    if (!(error instanceof Error) || !error.message.includes("net::ERR_ABORTED")) {
      throw new Error("Indeed callback navigation did not complete safely");
    }
  });

  await expect(indeed.getByText("connected", { exact: true })).toBeVisible();
  await expect(indeed.getByText("indeed-connected@example.test", { exact: true })).toBeVisible();
  await expect(indeed.getByRole("button", { name: "Logout Indeed Jobs" })).toBeEnabled();
  await expect(indeed.getByRole("link", { name: "Open Indeed Jobs sign-in" })).toHaveCount(0);
  await expect(codex.getByText("disconnected", { exact: true })).toBeVisible();
  await expect(codex.getByRole("button", { name: "Connect OpenAI Codex" })).toBeEnabled();
  expect(callbackRecord.forwardCount).toBe(1);
  expect(
    callbackRecord.url?.pathname === indeedCallbackPath,
    "Next did not rewrite the callback to the versioned pipeline route",
  ).toBe(true);
  expect(
    callbackRecord.url?.searchParams.get("code") === callbackCode
      && callbackRecord.url?.searchParams.get("state") === oauthState,
    "The callback fixture did not receive the expected opaque values",
  ).toBe(true);
  expect(callbackRecord.url?.searchParams.get("iss")).toBe("https://secure.indeed.com");

  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  await navigation.getByRole("link", { name: "Applications" }).click();
  await expect(page).toHaveURL(/\/$/u);
  await navigation.getByRole("link", { name: "Providers" }).click();
  await expect(page).toHaveURL(/\/providers$/u);
  await expect(indeed.getByText("connected", { exact: true })).toBeVisible();
  await expect(codex.getByText("disconnected", { exact: true })).toBeVisible();

  const renderedProviderOutput = `${await page.locator("body").innerText()}\n${await page.content()}`;
  const renderedAuthorizationOutput =
    `${await authorizationPage.locator("body").innerText()}\n${await authorizationPage.content()}`;
  expect(
    privateValues.some((privateValue) =>
      renderedProviderOutput.includes(privateValue) || renderedAuthorizationOutput.includes(privateValue)
    ),
    "Rendered OAuth output exposed private callback data",
  ).toBe(false);
  const browserStorage = await page.evaluate(() => ({
    localStorage: { ...window.localStorage },
    sessionStorage: { ...window.sessionStorage },
  }));
  const browserSurfaceWithoutUrls = JSON.stringify({
    cookies: await browserContext.cookies(),
    requests: observedRequests.map(({ headers, method, postData }) => ({ headers, method, postData })),
    storage: browserStorage,
  });
  expect(
    privateValues.some((privateValue) => browserSurfaceWithoutUrls.includes(privateValue)),
    "Browser headers, cookies, or storage retained private callback data",
  ).toBe(false);

  const requestsContaining = (privateValue: string) => observedRequests.filter((request) =>
    request.url.includes(privateValue)
  );
  for (const request of [...requestsContaining(callbackCode), ...requestsContaining(oauthState)]) {
    const requestUrl = new URL(request.url);
    const isAuthorizationRequest =
      requestUrl.origin === authorizationUrl.origin && requestUrl.pathname === authorizationUrl.pathname;
    const isCallbackRequest =
      requestUrl.origin === callbackUrl.origin && requestUrl.pathname === callbackUrl.pathname;
    expect(
      isAuthorizationRequest || isCallbackRequest,
      "OAuth callback data appeared in an unrelated browser URL",
    ).toBe(true);
  }
  expect(
    requestsContaining(callbackCode).length,
    "The callback code must only be sent to the callback endpoint",
  ).toBe(1);
});

test("WEB-AUTH-003 offers a manual Indeed sign-in link when the browser blocks the reserved tab", async ({ page }) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await page.route("**/api/pipeline/auth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        providers: [
          { provider: "openai-codex", state: "disconnected" },
          { provider: "indeed", state: "disconnected" },
        ],
      }),
    });
  });
  await page.route("**/api/pipeline/runs", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [] }),
    });
  });
  const authorizationUrl = "https://secure.indeed.com/oauth/v2/authorize?fixture=blocked";
  await page.route("**/api/pipeline/auth/indeed/sessions", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "blocked-indeed-session",
        provider: "indeed",
        state: "pending",
        url: authorizationUrl,
        instructions: "Complete authorization with the manual sign-in link.",
        progress: [],
        expiresAt: 1_900_000_000_000,
      }),
    });
  });
  await page.route("**/api/pipeline/auth/sessions/blocked-indeed-session", async (route) => {
    const method = route.request().method();
    expect(["DELETE", "GET"]).toContain(method);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "blocked-indeed-session",
        provider: "indeed",
        state: method === "DELETE" ? "cancelled" : "pending",
        url: authorizationUrl,
        instructions: "Complete authorization with the manual sign-in link.",
        progress: [],
        expiresAt: 1_900_000_000_000,
      }),
    });
  });

  await page.goto("/providers");
  const providers = page.getByRole("list", { name: "OAuth providers" });
  const indeed = providers.getByRole("listitem").filter({ hasText: "Indeed Jobs" });
  await indeed.getByRole("button", { name: "Connect Indeed Jobs" }).click();

  await expect(
    indeed.getByText("Your browser blocked the sign-in window. Use the Open sign-in link below.", { exact: true }),
  ).toBeVisible();
  await expect(indeed.getByRole("link", { name: "Open Indeed Jobs sign-in" })).toHaveAttribute(
    "href",
    authorizationUrl,
  );
  await expect(indeed.getByRole("button", { name: "Cancel Indeed Jobs authorization" })).toBeEnabled();
  await indeed.getByRole("button", { name: "Cancel Indeed Jobs authorization" }).click();
  await expect(indeed.getByText("Authorization was cancelled.", { exact: true })).toHaveCount(1);
});
