import { expect, test, type Page, type Route } from "@playwright/test";
import { type RunDto } from "@jobhunter/pipeline/contracts";

const newerRun: RunDto = {
  id: "newer-run",
  opportunityKind: "job",
  status: "approved",
  applicationStatus: "applied",
  revision: 2,
  origin: "initial",
  queueSequence: 2,
  generateKeywordMap: false,
  skipReview: false,
  autoSubmit: false,
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
    has: page.getByRole("combobox", { name: "Application status for newer-run" }),
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

test("WEB-UI-002 keeps a successful application-status patch after an older list GET completes", async ({ page }) => {
  const activeRun: RunDto = {
    ...newerRun,
    id: "patch-run",
    status: "tailoring",
    applicationStatus: "applied",
    revision: 1,
    queueSequence: 1,
    updatedAt: 1_700_000_000_000,
  };
  const staleListRun: RunDto = {
    ...activeRun,
    status: "approved",
    revision: 2,
    updatedAt: 1_700_000_001_000,
  };
  const patchedRun: RunDto = {
    ...staleListRun,
    applicationStatus: "interview",
    updatedAt: 1_700_000_002_000,
  };
  let listRequests = 0;
  let markStaleStarted: () => void = () => {};
  const staleStarted = new Promise<void>((resolve) => {
    markStaleStarted = resolve;
  });
  let releaseStale: () => void = () => {};
  const staleRelease = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  let markPatchCompleted: () => void = () => {};
  const patchCompleted = new Promise<void>((resolve) => {
    markPatchCompleted = resolve;
  });

  await page.route("**/api/pipeline/runs", async (route) => {
    expect(route.request().method()).toBe("GET");
    listRequests += 1;
    if (listRequests === 1) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ runs: [activeRun] }),
      });
      return;
    }

    expect(listRequests).toBe(2);
    markStaleStarted();
    await staleRelease;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [staleListRun] }),
    });
  });
  await page.route("**/api/pipeline/runs/patch-run", async (route) => {
    expect(route.request().method()).toBe("PATCH");
    expect(route.request().postDataJSON()).toEqual({ applicationStatus: "interview" });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(patchedRun),
    });
    markPatchCompleted();
  });

  await page.goto("/");
  const applicationState = page.getByRole("combobox", {
    name: "Application status for patch-run",
  });
  await expect(applicationState).toHaveValue("applied");
  await staleStarted;

  await applicationState.selectOption("interview");
  await patchCompleted;
  await expect(applicationState).toHaveValue("interview");

  const staleResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/pipeline/runs")
      && response.request().method() === "GET",
  );
  releaseStale();
  await (await staleResponse).finished();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  expect(await applicationState.inputValue()).toBe("interview");
});

test("WEB-METADATA-001 retries a failed public job-analysis read on a later active-run poll", async ({ page }) => {
  const retryRun: RunDto = {
    ...newerRun,
    id: "retry-run",
    status: "tailoring",
    applicationStatus: "applied",
    revision: 1,
    queueSequence: 1,
    updatedAt: 1_700_000_000_000,
    artifacts: [{
      id: "retry-job-analysis",
      kind: "job-analysis",
      revision: 0,
      attempt: 1,
      sha256: "e".repeat(64),
      bytes: 512,
      mediaType: "application/json",
      href: "/v1/runs/retry-run/artifacts/retry-job-analysis",
      public: true,
      createdAt: 1_700_000_000_100,
    }],
  };
  let listRequests = 0;
  let artifactReads = 0;
  let markFirstArtifactFailure: () => void = () => {};
  const firstArtifactFailure = new Promise<void>((resolve) => {
    markFirstArtifactFailure = resolve;
  });

  await page.route("**/api/pipeline/runs", async (route) => {
    expect(route.request().method()).toBe("GET");
    listRequests += 1;
    if (listRequests === 2) await firstArtifactFailure;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [retryRun] }),
    });
  });
  await page.route("**/api/pipeline/runs/retry-run/artifacts/retry-job-analysis", async (route) => {
    expect(route.request().method()).toBe("GET");
    artifactReads += 1;
    if (artifactReads === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "ARTIFACT_UNAVAILABLE", message: "Job analysis is temporarily unavailable." },
        }),
      });
      markFirstArtifactFailure();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 2,
        id: "analysis-retry",
        jobDescriptionSha256: "f".repeat(64),
        analysisWorkflowSha256: "1".repeat(64),
        baselineSha256: "2".repeat(64),
        target: {
          title: "Retry Staff Engineer",
          organization: "Retry Systems",
        },
        jdKeywords: [],
        exactEdits: [],
      }),
    });
  });

  await page.goto("/");
  const applicationRow = page.getByRole("row").filter({
    has: page.getByRole("combobox", { name: "Application status for retry-run" }),
  });
  await expect(applicationRow).toBeVisible();
  await firstArtifactFailure;

  await expect(applicationRow).toContainText("Retry Staff Engineer", { timeout: 8_000 });
  await expect(applicationRow).toContainText("Retry Systems");
  expect(artifactReads).toBeGreaterThanOrEqual(2);
});
