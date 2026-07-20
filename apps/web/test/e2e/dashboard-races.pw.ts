import { expect, test, type Page, type Route } from "@playwright/test";
import { type RunDto } from "@jobhunter/pipeline/contracts";

const newerRun: RunDto = {
  id: "newer-run",
  status: "approved",
  applicationStatus: "applied",
  revision: 2,
  origin: "initial",
  queueSequence: 2,
  generateKeywordMap: false,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
  visualAcknowledgementRequired: false,
  attempts: [],
  artifacts: [],
  timeline: [],
};

function fulfillError(route: Route, message: string): Promise<void> {
  return route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({
      error: { code: "RUN_CONFLICT", message },
    }),
  });
}

test("ignores an older run-list failure after a newer list has loaded", async ({ page }) => {
  let requestCount = 0;
  let markOlderStarted: () => void = () => {};
  const olderStarted = new Promise<void>((resolve) => {
    markOlderStarted = resolve;
  });
  let releaseOlder: () => void = () => {};
  const olderRelease = new Promise<void>((resolve) => {
    releaseOlder = resolve;
  });

  await page.route("**/api/pipeline/runs", async (route) => {
    expect(route.request().method()).toBe("GET");
    requestCount += 1;

    if (requestCount === 1) {
      await fulfillError(route, "Initial list unavailable");
      return;
    }

    if (requestCount === 2) {
      markOlderStarted();
      await olderRelease;
      await fulfillError(route, "Stale list failure");
      return;
    }

    expect(requestCount).toBe(3);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [newerRun] }),
    });
  });

  await page.goto("/");
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  const initialFailure = page.getByText("Initial list unavailable", { exact: true });
  const staleFailure = page.getByText("Stale list failure", { exact: true });

  await retry.click();
  await olderStarted;
  await retry.click();

  const newerRow = page.getByRole("row").filter({
    has: page.getByRole("combobox", { name: "Application state for newer-run" }),
  });
  await expect(newerRow).toBeVisible();
  await expect(initialFailure).not.toBeVisible();
  await expect(staleFailure).not.toBeVisible();

  const staleResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/pipeline/runs") && response.status() === 409,
  );
  releaseOlder();
  await (await staleResponse).finished();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  await expect(newerRow).toBeVisible();
  await expect(initialFailure).not.toBeVisible();
  await expect(staleFailure).not.toBeVisible();
});
