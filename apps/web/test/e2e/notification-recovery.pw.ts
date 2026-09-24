import { expect, test, type Page } from "@playwright/test";
import { ApplicationSessionSnapshotDtoSchema, RunDtoSchema, type ApplicationSessionSnapshotDto } from "../../app/lib/pipeline-contracts";
import { installBrowserNotificationProbe } from "./browser-notification-probe";

async function interceptWaitingApplication(page: Page): Promise<{ session: ApplicationSessionSnapshotDto }> {
  const run = RunDtoSchema.parse({
    id: "permission-recovery", opportunityKind: "job", status: "approved", applicationStatus: "pending",
    isApplying: true, generateKeywordMap: false, skipReview: false, autoSubmit: false, queueSequence: 1,
    revision: 1, origin: "initial", createdAt: 1, updatedAt: 2, visualAcknowledgementRequired: false,
    attempts: [], artifacts: [], timeline: [],
  });
  const session = ApplicationSessionSnapshotDtoSchema.parse({
    generation: 1, bridgeState: "awaiting_human_navigation", harnessState: "awaiting_human_navigation",
    submissionPhase: "not_attempted", createdAt: 1, updatedAt: 2, terminalAt: null, expiresAt: null,
    company: null, role: null, fieldsFilled: [], fieldsNeedingHuman: [], filesAttached: [], warnings: [],
    revisionCount: 0, pendingAction: { type: "human_navigation", instruction: "Complete the checkpoint." },
    error: null,
  });
  const projection = { session };
  await page.route("**/api/pipeline/runs", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ runs: [run] }),
  }));
  await page.route("**/api/pipeline/runs/permission-recovery/application", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify(projection.session),
  }));
  return projection;
}

const attentionNotification = {
  title: "Application needs attention",
  body: "Return to Jobhunt to continue the application.",
  tag: "jobhunt:application:permission-recovery",
};

test("offers a user-gesture permission request on every page without losing the waiting alert", async ({ page }) => {
  const notifications = await installBrowserNotificationProbe(page, {
    initialPermission: "default", notificationsEnabled: null, requireUserGesture: true,
  });
  await interceptWaitingApplication(page);
  await page.goto("/credentials");
  const enable = page.getByRole("button", { name: /^Enable notifications$/i });
  await expect(enable).toBeVisible();
  expect(await notifications()).toEqual([]);
  await page.reload();
  await expect(enable).toBeVisible();
  await enable.click();
  await expect.poll(notifications).toEqual([attentionNotification]);
  await expect(enable).toHaveCount(0);
});

test("retries a failed notification without dropping the pending attention request", async ({ page }) => {
  const notifications = await installBrowserNotificationProbe(page);
  await page.addInitScript(() => localStorage.setItem("jobhunt.test.notification-construction-failure", "true"));
  await interceptWaitingApplication(page);
  await page.goto("/credentials");
  const recovery = page.getByRole("region", { name: "Notification permissions" });
  const retry = recovery.getByRole("button", { name: /^Retry notifications$/i });
  await expect(retry).toBeVisible();
  expect(await notifications()).toEqual([]);
  await page.evaluate(() => localStorage.setItem("jobhunt.test.notification-construction-failure", "false"));
  await retry.click();
  await expect.poll(notifications).toEqual([attentionNotification]);
  await expect(recovery).toHaveCount(0);
});

test("requests permission again after it is revoked while the application is open", async ({ page }) => {
  const notifications = await installBrowserNotificationProbe(page, { requireUserGesture: true });
  const projection = await interceptWaitingApplication(page);
  const waiting = projection.session;
  projection.session = { ...waiting, bridgeState: "running", harnessState: "running", pendingAction: null, updatedAt: 1 };
  const initialSnapshot = page.waitForResponse("**/api/pipeline/runs/permission-recovery/application");
  await page.goto("/credentials");
  await initialSnapshot;
  await page.evaluate(() => localStorage.setItem("jobhunt.test.browser-notification-permission", "default"));
  projection.session = waiting;
  const enable = page.getByRole("button", { name: /^Enable notifications$/i });
  await expect(enable).toBeVisible({ timeout: 8_000 });
  expect(await notifications()).toEqual([]);
  await enable.click();
  await expect.poll(notifications).toEqual([attentionNotification]);
});

test("explains blocked notifications and recovers when browser permission changes", async ({ page }) => {
  const notifications = await installBrowserNotificationProbe(page, { initialPermission: "denied" });
  await interceptWaitingApplication(page);
  await page.goto("/credentials");
  const recovery = page.getByRole("region", { name: "Notification permissions" });
  await expect(recovery).toContainText(/browser settings/);
  await recovery.getByRole("button", { name: /^Retry notifications$/i }).click();
  expect(await notifications()).toEqual([]);
  await expect(recovery).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem("jobhunt.test.browser-notification-permission", "granted");
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(notifications).toEqual([attentionNotification]);
  await expect(recovery).toHaveCount(0);
});
