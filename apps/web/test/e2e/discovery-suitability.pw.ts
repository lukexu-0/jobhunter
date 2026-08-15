import { expect, test } from "@playwright/test";
import type { DiscoveryJob } from "@jobhunter/pipeline/contracts";

const catalogJob: DiscoveryJob = {
  id: "catalog-job",
  title: "Platform Engineering Intern",
  company: "Example Labs",
  location: "Remote",
  roles: ["software_engineering"],
  season: "summer",
  suitable: true,
  canonicalUrl: "https://example.com/jobs/catalog-job",
  applyUrl: "https://example.com/jobs/catalog-job/apply",
  descriptionPreview: "Build production systems with a small engineering team.",
  queueable: true,
  postedAt: null,
  firstSeenAt: 1_775_174_400_000,
  lastSeenAt: 1_775_174_460_000,
  status: "open",
  sourceNames: ["Simplify"],
};

test("filters discovery by suitable and unsuitable jobs from the first page", async ({ page }) => {
  await page.route(/\/api\/pipeline\/discovery(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ jobs: [catalogJob], total: 1_001, lastSyncAt: null }),
    });
  });

  const initialRequestPromise = page.waitForRequest(/\/api\/pipeline\/discovery(?:\?.*)?$/);
  await page.goto("/discovery");
  const initialRequest = new URL((await initialRequestPromise).url());
  const suitabilityControl = page.locator("label.select-control", {
    hasText: "Suitability",
  });
  const suitability = suitabilityControl.getByRole("combobox");
  await expect(suitabilityControl).toContainText("Suitability");
  await expect(suitability).toHaveValue("all");
  await expect(suitability.locator("option")).toHaveText([
    "All suitability",
    "Suitable",
    "Unsuitable",
  ]);
  expect(initialRequest.searchParams.has("suitable")).toBe(false);

  await page.getByRole("checkbox", {
    name: "Select Platform Engineering Intern at Example Labs",
  }).check();
  const nextPageRequestPromise = page.waitForRequest((request) => (
    new URL(request.url()).searchParams.get("offset") === "1000"
  ));
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const nextPageRequest = new URL((await nextPageRequestPromise).url());
  expect(nextPageRequest.searchParams.get("offset")).toBe("1000");

  await page.getByRole("checkbox", {
    name: "Select Platform Engineering Intern at Example Labs",
  }).check();
  const suitableRequestPromise = page.waitForRequest((request) => (
    new URL(request.url()).searchParams.get("suitable") === "true"
  ));
  await suitability.selectOption("true");
  const suitableRequest = new URL((await suitableRequestPromise).url());
  expect(suitableRequest.searchParams.get("suitable")).toBe("true");
  expect(suitableRequest.searchParams.get("offset")).toBe("0");
  await expect(page.getByRole("checkbox", {
    name: "Select Platform Engineering Intern at Example Labs",
  })).not.toBeChecked();

  await page.getByRole("checkbox", {
    name: "Select Platform Engineering Intern at Example Labs",
  }).check();
  const unsuitableRequestPromise = page.waitForRequest((request) => (
    new URL(request.url()).searchParams.get("suitable") === "false"
  ));
  await suitability.selectOption("false");
  const unsuitableRequest = new URL((await unsuitableRequestPromise).url());
  expect(unsuitableRequest.searchParams.get("suitable")).toBe("false");
  expect(unsuitableRequest.searchParams.get("offset")).toBe("0");
  await expect(page.getByRole("checkbox", {
    name: "Select Platform Engineering Intern at Example Labs",
  })).not.toBeChecked();
});
