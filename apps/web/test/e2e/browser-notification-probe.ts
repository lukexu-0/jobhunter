import type { Page } from "@playwright/test";

export interface BrowserNotificationRecord {
  readonly body: string;
  readonly tag: string;
  readonly title: string;
}

export async function installBrowserNotificationProbe(
  page: Page,
  options: {
    readonly initialPermission?: NotificationPermission;
    readonly notificationsEnabled?: boolean;
  } = {},
): Promise<() => Promise<BrowserNotificationRecord[]>> {
  await page.addInitScript((initial) => {
    const notificationWindow = window as typeof window & {
      __browserNotifications: BrowserNotificationRecord[];
    };
    Object.defineProperty(notificationWindow, "__browserNotifications", {
      configurable: true,
      value: [],
    });
    const permissionStorageKey = "jobhunter.test.browser-notification-permission";
    let permission = window.localStorage.getItem(permissionStorageKey) as NotificationPermission | null;
    if (permission === null) {
      permission = initial.permission;
      window.localStorage.setItem(permissionStorageKey, permission);
    }
    class BrowserNotificationProbe {
      static get permission(): NotificationPermission {
        return permission!;
      }

      static requestPermission(): Promise<NotificationPermission> {
        permission = "granted";
        window.localStorage.setItem(permissionStorageKey, permission);
        return Promise.resolve(permission);
      }

      constructor(title: string, notificationOptions: NotificationOptions = {}) {
        notificationWindow.__browserNotifications.push({
          body: notificationOptions.body ?? "",
          tag: notificationOptions.tag ?? "",
          title,
        });
      }
    }
    Object.defineProperty(notificationWindow, "Notification", {
      configurable: true,
      value: BrowserNotificationProbe,
    });
    if (window.localStorage.getItem("jobhunter.browser-notifications.enabled") === null) {
      window.localStorage.setItem(
        "jobhunter.browser-notifications.enabled",
        String(initial.notificationsEnabled),
      );
    }
  }, {
    notificationsEnabled: options.notificationsEnabled ?? true,
    permission: options.initialPermission ?? "granted",
  });
  return () => page.evaluate(() => (
    window as typeof window & { __browserNotifications: BrowserNotificationRecord[] }
  ).__browserNotifications);
}
