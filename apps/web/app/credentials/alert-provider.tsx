"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ApplicationSessionView, RunDto } from "../lib/pipeline-contracts";
import { AlertController } from "../lib/alerts";

const SOUND_ENABLED_STORAGE_KEY = "jobhunt.sound-alerts.enabled";
const BROWSER_NOTIFICATIONS_STORAGE_KEY = "jobhunt.browser-notifications.enabled";

type BrowserNotificationPermission = NotificationPermission | "unsupported" | null;

interface Alerts {
  readonly notificationPermission: BrowserNotificationPermission;
  readonly notificationsEnabled: boolean | null;
  readonly notificationRequestPending: boolean;
  readonly observeRun: (run: RunDto) => void;
  readonly observeApplication: (runId: string, view: ApplicationSessionView) => void;
  readonly setNotificationsEnabled: (enabled: boolean) => Promise<void>;
  readonly setSoundEnabled: (enabled: boolean) => void;
  readonly soundEnabled: boolean | null;
  readonly statusMessage: string;
}

const AlertsContext = createContext<Alerts | null>(null);

export function AlertProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [notificationFailure, setNotificationFailure] = useState(false);
  const controllerRef = useRef<AlertController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new AlertController(() => setNotificationFailure(true));
  }
  const controller = controllerRef.current;
  const mountedRef = useRef(false);
  const automaticPermissionRequestedRef = useRef(false);
  const permissionRequestRef = useRef<Promise<NotificationPermission> | null>(null);
  const preferenceVersionRef = useRef(0);
  const notificationsPreferredRef = useRef(true);
  const permissionRef = useRef<BrowserNotificationPermission>(null);
  const settingsRef = useRef({ browserNotificationsEnabled: false, soundEnabled: true });
  const [soundEnabled, setSoundEnabledState] = useState<boolean | null>(null);
  const [notificationsPreferred, setNotificationsPreferred] = useState<boolean | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<BrowserNotificationPermission>(null);
  const [notificationRequestPending, setNotificationRequestPending] = useState(false);

  const observeRun = useCallback((run: RunDto) => controller.observeRun(run), [controller]);
  const observeApplication = useCallback((runId: string, view: ApplicationSessionView) => {
    controller.observeApplication(runId, view);
  }, [controller]);

  const applyPermission = useCallback((permission: BrowserNotificationPermission) => {
    permissionRef.current = permission;
    setNotificationPermission(permission);
    settingsRef.current.browserNotificationsEnabled = notificationsPreferredRef.current && permission === "granted";
    setNotificationFailure(false);
    controller.configure(settingsRef.current);
  }, [controller]);

  const setSoundEnabled = useCallback((nextEnabled: boolean) => {
    settingsRef.current.soundEnabled = nextEnabled;
    controller.configure(settingsRef.current);
    setSoundEnabledState(nextEnabled);
    try {
      window.localStorage.setItem(SOUND_ENABLED_STORAGE_KEY, String(nextEnabled));
    } catch {
      // The in-memory preference remains effective when storage is unavailable.
    }
  }, [controller]);

  const setNotificationsEnabled = useCallback(async (nextEnabled: boolean) => {
    notificationsPreferredRef.current = nextEnabled;
    setNotificationsPreferred(nextEnabled);
    const version = ++preferenceVersionRef.current;
    try {
      // A dismissed or failed permission request is not an opt-out.
      window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, String(nextEnabled));
    } catch {
      // The in-memory preference remains effective when storage is unavailable.
    }
    let permission: BrowserNotificationPermission = typeof window.Notification === "undefined"
      ? "unsupported"
      : window.Notification.permission;
    if (nextEnabled && permission === "default") {
      setNotificationRequestPending(true);
      try {
        // Called synchronously from the retry button so browsers receive the user gesture.
        permissionRequestRef.current ??= window.Notification.requestPermission();
        permission = await permissionRequestRef.current;
      } catch {
        permission = window.Notification.permission;
      } finally {
        permissionRequestRef.current = null;
        if (mountedRef.current) setNotificationRequestPending(false);
      }
    }
    if (!mountedRef.current || version !== preferenceVersionRef.current) return;
    applyPermission(permission);
  }, [applyPermission]);

  useEffect(() => {
    mountedRef.current = true;
    let storedSoundEnabled = true;
    let storedNotificationsEnabled = true;
    try {
      storedSoundEnabled = window.localStorage.getItem(SOUND_ENABLED_STORAGE_KEY) !== "false";
      storedNotificationsEnabled = window.localStorage.getItem(BROWSER_NOTIFICATIONS_STORAGE_KEY) !== "false";
    } catch {
      // Defaults remain effective when browser preference storage is unavailable.
    }
    settingsRef.current.soundEnabled = storedSoundEnabled;
    notificationsPreferredRef.current = storedNotificationsEnabled;
    setSoundEnabledState(storedSoundEnabled);
    setNotificationsPreferred(storedNotificationsEnabled);
    const permission = typeof window.Notification === "undefined" ? "unsupported" : window.Notification.permission;
    applyPermission(permission);
    if (storedNotificationsEnabled && permission === "default" && !automaticPermissionRequestedRef.current) {
      automaticPermissionRequestedRef.current = true;
      void setNotificationsEnabled(true);
    }

    const primeAudio = () => controller.prime();
    const synchronizePermission = () => {
      const next = typeof window.Notification === "undefined" ? "unsupported" : window.Notification.permission;
      if (next !== permissionRef.current) applyPermission(next);
    };
    document.addEventListener("pointerdown", primeAudio, true);
    document.addEventListener("keydown", primeAudio, true);
    window.addEventListener("focus", synchronizePermission);
    document.addEventListener("visibilitychange", synchronizePermission);
    let disposed = false;
    let permissionStatus: PermissionStatus | undefined;
    if (navigator.permissions) {
      void navigator.permissions.query({ name: "notifications" }).then((status) => {
        if (disposed) return;
        permissionStatus = status;
        status.addEventListener("change", synchronizePermission);
        synchronizePermission();
      }).catch(() => {
        // Focus and visibility changes also refresh permission in browsers without this query.
      });
    }
    return () => {
      mountedRef.current = false;
      disposed = true;
      permissionStatus?.removeEventListener("change", synchronizePermission);
      document.removeEventListener("pointerdown", primeAudio, true);
      document.removeEventListener("keydown", primeAudio, true);
      window.removeEventListener("focus", synchronizePermission);
      document.removeEventListener("visibilitychange", synchronizePermission);
      controller.deactivate();
    };
  }, [applyPermission, controller, setNotificationsEnabled]);

  useEffect(() => {
    if (!notificationFailure || !notificationsPreferredRef.current) return;
    const permission = typeof window.Notification === "undefined" ? "unsupported" : window.Notification.permission;
    if (permission !== permissionRef.current) applyPermission(permission);
    if (permission === "default" && !automaticPermissionRequestedRef.current) {
      automaticPermissionRequestedRef.current = true;
      void setNotificationsEnabled(true);
    }
  }, [applyPermission, notificationFailure, setNotificationsEnabled]);

  const notificationsEnabled = notificationsPreferred === null
    ? null
    : notificationsPreferred && notificationPermission === "granted";
  let statusMessage = "";
  if (notificationsPreferred) {
    if (notificationPermission === "default") {
      statusMessage = "Allow browser notifications so Jobhunt can alert you when it needs your attention.";
    } else if (notificationPermission === "denied") {
      statusMessage = "Notifications are blocked. Allow notifications for this site in your browser settings, then retry.";
    } else if (notificationPermission === "unsupported") {
      statusMessage = "Browser notifications are unavailable in this browser. Use a browser that supports notifications.";
    } else if (notificationFailure) {
      statusMessage = "Jobhunt could not show a notification. Check browser and system notification settings, then retry. Your alert is still pending.";
    }
  }
  const value = useMemo(() => ({
    notificationPermission, notificationsEnabled, notificationRequestPending,
    observeApplication, observeRun, setNotificationsEnabled, setSoundEnabled, soundEnabled, statusMessage,
  }), [
    notificationPermission, notificationsEnabled, notificationRequestPending,
    observeApplication, observeRun, setNotificationsEnabled, setSoundEnabled, soundEnabled, statusMessage,
  ]);
  return <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>;
}

export function useAlerts(): Alerts {
  const value = useContext(AlertsContext);
  if (value === null) throw new Error("useAlerts must be used within AlertProvider");
  return value;
}
