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
    readonly notificationsEnabled?: boolean | null;
    readonly requireUserGesture?: boolean;
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
    const permissionStorageKey = "jobhunt.test.browser-notification-permission";
    let permission = window.localStorage.getItem(permissionStorageKey) as NotificationPermission | null;
    if (permission === null) {
      permission = initial.permission;
      window.localStorage.setItem(permissionStorageKey, permission);
    }
    let userGesture = false;
    const recordGesture = (event: Event) => { if (event.isTrusted) userGesture = true; };
    document.addEventListener("pointerdown", recordGesture, true);
    document.addEventListener("keydown", recordGesture, true);
    class BrowserNotificationProbe {
      static get permission(): NotificationPermission {
        return window.localStorage.getItem(permissionStorageKey) as NotificationPermission;
      }

      static requestPermission(): Promise<NotificationPermission> {
        if (initial.requireUserGesture && !userGesture) {
          return Promise.resolve(BrowserNotificationProbe.permission);
        }
        permission = "granted";
        window.localStorage.setItem(permissionStorageKey, permission);
        return Promise.resolve(permission);
      }

      constructor(title: string, notificationOptions: NotificationOptions = {}) {
        if (BrowserNotificationProbe.permission !== "granted"
          || window.localStorage.getItem("jobhunt.test.notification-construction-failure") === "true") {
          throw new Error("Browser notification unavailable");
        }
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
    if (
      initial.notificationsEnabled !== null
      && window.localStorage.getItem("jobhunt.browser-notifications.enabled") === null
    ) {
      window.localStorage.setItem(
        "jobhunt.browser-notifications.enabled",
        String(initial.notificationsEnabled),
      );
    }
  }, {
    notificationsEnabled: options.notificationsEnabled === undefined
      ? true
      : options.notificationsEnabled,
    permission: options.initialPermission ?? "granted",
    requireUserGesture: options.requireUserGesture ?? false,
  });
  return () => page.evaluate(() => (
    window as typeof window & { __browserNotifications: BrowserNotificationRecord[] }
  ).__browserNotifications);
}
