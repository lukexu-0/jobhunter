import { expect, test } from "@playwright/test";

const startedAt = Date.UTC(2030, 0, 2, 14);
const completedAt = startedAt + 30_000;
const startAt = Date.UTC(2030, 1, 3, 17);

const event = {
  id: "3f95527c-a45c-48e9-b36f-023c2b66f370",
  title: "Technology recruiting forum",
  organizer: "Example Organizer",
  startAt,
  endAt: startAt + 3_600_000,
  timezone: "America/New_York",
  location: "Online and Example Hall",
  attendance: "hybrid",
  registrationUrl: "https://events.example.test/register",
  sourceUrls: ["https://events.example.test/source"],
  eligibilitySummary: "Open to current students.",
  matchedForApplicant: true,
  firstSeenAt: startedAt,
  lastSeenAt: completedAt,
};

const unmatchedEvent = {
  ...event,
  id: "c8a654d2-9d94-4da5-b7fb-2498137dc550",
  title: "School-restricted forum",
  eligibilitySummary: "Open to another university only.",
  matchedForApplicant: false,
};

const issue = {
  sourceId: "example-source",
  sourceName: "Example Source",
  sourceUrl: "https://events.example.test/source",
  code: "SOURCE_UNAVAILABLE",
  message: "The source did not respond.",
  occurredAt: completedAt,
};

function dashboard(state: "partial" | "completed" = "partial") {
  return {
    preferences: { school: "State University" },
    schedule: {
      cadenceHours: 24,
      nextRunAt: startedAt + 86_400_000,
      running: false,
      sourceCount: 28,
    },
    latestRun: {
      id: "events-run-1",
      trigger: "scheduled",
      state,
      startedAt,
      completedAt,
      sourceCount: 28,
      succeededSourceCount: state === "completed" ? 28 : 27,
      failedSourceCount: state === "completed" ? 0 : 1,
      eventCount: 1,
    },
    events: [event, unmatchedEvent],
    issues: state === "completed" ? [] : [issue],
  };
}

test("EVENTS-UI-001 saves school, starts a scrape, and retains the loaded snapshot across refresh errors", async ({ page }) => {
  let dashboardGets = 0;
  let refreshMode: "loaded" | "error" | "completed" = "loaded";
  const preferenceRequests: unknown[] = [];
  const scrapeRequests: unknown[] = [];

  await page.route("**/api/pipeline/events**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname.endsWith("/preferences")) {
      expect(request.method()).toBe("PUT");
      preferenceRequests.push(request.postDataJSON());
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ school: "Technical Institute" }),
      });
      return;
    }

    if (pathname.endsWith("/scrape")) {
      expect(request.method()).toBe("POST");
      scrapeRequests.push(request.postDataJSON());
      refreshMode = "error";
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          run: {
            id: "events-run-2",
            trigger: "manual",
            state: "running",
            startedAt: completedAt + 1_000,
            sourceCount: 28,
            succeededSourceCount: 0,
            failedSourceCount: 0,
            eventCount: 0,
          },
        }),
      });
      return;
    }

    expect(request.method()).toBe("GET");
    dashboardGets += 1;
    if (refreshMode === "error") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "EVENT_SCRAPE_FAILED", message: "private upstream detail" },
        }),
      });
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(dashboard(refreshMode === "completed" ? "completed" : "partial")),
    });
  });

  await page.goto("/events");

  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(navigation.getByRole("link")).toHaveText(["Applications", "Discovery", "Events", "Providers"]);
  await expect(navigation.getByRole("link", { name: "Events" })).toHaveAttribute("aria-current", "page");

  const school = page.getByRole("textbox", { name: "School" });
  await expect(school).toHaveValue("State University");
  await school.fill("  Technical Institute  ");
  await page.getByRole("button", { name: "Save school" }).click();
  await expect.poll(() => preferenceRequests).toEqual([{ school: "Technical Institute" }]);
  await expect(school).toHaveValue("Technical Institute");

  const events = page.getByRole("region", { name: "Upcoming recruiting events" });
  await expect(events.getByText("Technology recruiting forum", { exact: true })).toBeVisible();
  await expect(events.getByText("Matched", { exact: true })).toBeVisible();
  await expect(events.getByText("Not matched", { exact: true })).toBeVisible();
  await expect(events.getByRole("link", { name: "Register for Technology recruiting forum" })).toHaveAttribute(
    "href",
    "https://events.example.test/register",
  );

  const issues = page.getByRole("region", { name: "Latest scrape source issues" });
  await expect(issues.getByText("Example Source", { exact: true })).toBeVisible();
  await expect(issues.getByText("SOURCE_UNAVAILABLE", { exact: true })).toBeVisible();
  await expect(issues.getByText("The source did not respond.", { exact: true })).toBeVisible();
  await expect(issues.getByRole("link", { name: "Open Example Source source" })).toHaveAttribute(
    "href",
    "https://events.example.test/source",
  );

  const failedRefresh = page.waitForResponse((response) =>
    response.url().endsWith("/api/pipeline/events") && response.status() === 503,
  );
  await page.getByRole("button", { name: "Scrape now" }).click();
  await expect.poll(() => scrapeRequests).toEqual([{}]);
  await expect(
    page.getByRole("region", { name: "Schedule and latest run" })
      .getByText("Running", { exact: true })
      .last(),
  ).toBeVisible();
  await (await failedRefresh).finished();
  await expect(page.getByRole("alert").filter({ hasText: "The pipeline request failed." })).toBeVisible();
  await expect(events.getByText("Technology recruiting forum", { exact: true })).toBeVisible();

  refreshMode = "completed";
  await expect.poll(() => dashboardGets, { timeout: 7_000 }).toBeGreaterThanOrEqual(3);
  await expect(
    page.getByRole("region", { name: "Schedule and latest run" })
      .locator(".status-badge")
      .filter({ hasText: /^Completed$/ }),
  ).toBeVisible();

  await page.setViewportSize({ width: 375, height: 900 });
  const tableScroller = page.locator(".events-table-scroll").first();
  expect(await tableScroller.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});
