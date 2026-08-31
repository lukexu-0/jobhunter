import { expect, test, type Page } from "@playwright/test";

interface BrowserNotificationRecord {
  readonly body: string;
  readonly title: string;
}

async function installPreviewProbes(page: Page): Promise<{
  readonly frequencies: () => Promise<number[]>;
  readonly notifications: () => Promise<BrowserNotificationRecord[]>;
}> {
  await page.addInitScript(() => {
    const previewWindow = window as typeof window & {
      __previewFrequencies: number[];
      __previewNotifications: BrowserNotificationRecord[];
    };
    Object.defineProperties(previewWindow, {
      __previewFrequencies: { configurable: true, value: [] },
      __previewNotifications: { configurable: true, value: [] },
    });

    const nativeStart = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (when?: number): void {
      previewWindow.__previewFrequencies.push(this.frequency.value);
      nativeStart.call(this, when);
    };

    let permission: NotificationPermission = "default";
    class BrowserNotificationProbe {
      static get permission(): NotificationPermission {
        return permission;
      }

      static requestPermission(): Promise<NotificationPermission> {
        permission = "granted";
        return Promise.resolve(permission);
      }

      onclick: (() => void) | null = null;

      constructor(title: string, options: NotificationOptions = {}) {
        previewWindow.__previewNotifications.push({
          body: options.body ?? "",
          title,
        });
      }

      close(): void {}
    }
    Object.defineProperty(previewWindow, "Notification", {
      configurable: true,
      value: BrowserNotificationProbe,
    });
  });

  return {
    frequencies: () => page.evaluate(() => (
      window as typeof window & { __previewFrequencies: number[] }
    ).__previewFrequencies),
    notifications: () => page.evaluate(() => (
      window as typeof window & { __previewNotifications: BrowserNotificationRecord[] }
    ).__previewNotifications),
  };
}

test("previews every sound and enables browser notifications", async ({ page }) => {
  const probes = await installPreviewProbes(page);
  await page.goto("/notifications");

  await expect(page.getByRole("heading", { name: "Notification previews", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: "Alerts" })).toHaveAttribute("aria-current", "page");

  const soundAlerts = page.getByRole("checkbox", { name: "Sound alerts" });
  await expect(soundAlerts).toBeChecked();
  await page.getByRole("button", { name: "Play attention sound" }).click();
  await expect.poll(probes.frequencies).toEqual([740, 988]);
  await page.getByRole("button", { name: "Play success sound" }).click();
  await expect.poll(probes.frequencies).toEqual([740, 988, 523, 659, 784]);
  await page.getByRole("button", { name: "Play failure sound" }).click();
  await expect.poll(probes.frequencies).toEqual([740, 988, 523, 659, 784, 392, 262]);

  await expect(page.getByRole("status")).toContainText("Browser notifications: Not enabled");
  await page.getByRole("button", { name: "Enable browser notifications" }).click();
  await expect(page.getByRole("status")).toContainText("Browser notifications: Enabled");
  await expect.poll(() => page.evaluate(() => (
    window.localStorage.getItem("jobhunter.browser-notifications.enabled")
  ))).toBe("true");

  await page.getByRole("button", { name: "Send attention notification" }).click();
  await page.getByRole("button", { name: "Send success notification" }).click();
  await page.getByRole("button", { name: "Send failure notification" }).click();
  await expect.poll(probes.notifications).toEqual([
    {
      body: "Return to Jobhunter to continue the application.",
      title: "Application needs attention",
    },
    {
      body: "Jobhunter submitted the application successfully.",
      title: "Application submitted",
    },
    {
      body: "Open Jobhunter to review the failure and retry.",
      title: "Application failed",
    },
  ]);

  await page.getByRole("button", { name: "Disable browser notifications" }).click();
  await expect(page.getByRole("status")).toContainText("Browser notifications: Not enabled");
  await expect(page.getByRole("button", { name: "Send attention notification" })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (
    window.localStorage.getItem("jobhunter.browser-notifications.enabled")
  ))).toBe("false");
});
