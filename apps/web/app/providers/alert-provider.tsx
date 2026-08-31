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
import type { ApplicationSessionView, RunDto } from "@jobhunter/pipeline/contracts";
import { AlertController, type AlertKind } from "../lib/alerts";

const SOUND_ENABLED_STORAGE_KEY = "jobhunter.sound-alerts.enabled";
const BROWSER_NOTIFICATIONS_STORAGE_KEY = "jobhunter.browser-notifications.enabled";
const KIND_LABEL: Record<AlertKind, string> = {
  attention: "Attention",
  success: "Success",
  failure: "Failure",
};

type BrowserNotificationPermission = NotificationPermission | "unsupported" | null;

interface Alerts {
  readonly notificationPermission: BrowserNotificationPermission;
  readonly notificationsEnabled: boolean | null;
  readonly observeRun: (run: RunDto) => void;
  readonly observeApplication: (runId: string, view: ApplicationSessionView) => void;
  readonly setNotificationsEnabled: (enabled: boolean) => Promise<void>;
  readonly setSoundEnabled: (enabled: boolean) => void;
  readonly soundEnabled: boolean | null;
  readonly testNotification: (kind: AlertKind) => void;
  readonly testSound: (kind: AlertKind) => void;
  readonly testStatus: string;
}

const AlertsContext = createContext<Alerts | null>(null);

export function AlertProvider({ children }: Readonly<{ children: ReactNode }>) {
  const controllerRef = useRef<AlertController | null>(null);
  if (controllerRef.current === null) controllerRef.current = new AlertController();
  const controller = controllerRef.current;
  const settingsRef = useRef({
    browserNotificationsEnabled: false,
    soundEnabled: true,
  });
  const [soundEnabled, setSoundEnabledState] = useState<boolean | null>(null);
  const [notificationsEnabled, setNotificationsEnabledState] = useState<boolean | null>(null);
  const [notificationPermission, setNotificationPermission] =
    useState<BrowserNotificationPermission>(null);
  const [testStatus, setTestStatus] = useState("");

  const observeRun = useCallback((run: RunDto) => {
    controller.observeRun(run);
  }, [controller]);

  const observeApplication = useCallback((runId: string, view: ApplicationSessionView) => {
    controller.observeApplication(runId, view);
  }, [controller]);

  const setSoundEnabled = useCallback((nextEnabled: boolean) => {
    settingsRef.current.soundEnabled = nextEnabled;
    controller.configure(settingsRef.current);
    setSoundEnabledState(nextEnabled);
    setTestStatus("");
    try {
      window.localStorage.setItem(SOUND_ENABLED_STORAGE_KEY, String(nextEnabled));
    } catch {
      // The in-memory preference remains effective when storage is unavailable.
    }
  }, [controller]);

  const setNotificationsEnabled = useCallback(async (nextEnabled: boolean) => {
    if (!nextEnabled) {
      settingsRef.current.browserNotificationsEnabled = false;
      controller.configure(settingsRef.current);
      setNotificationsEnabledState(false);
      setTestStatus("");
      try {
        window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, "false");
      } catch {
        // The in-memory preference remains effective when storage is unavailable.
      }
      return;
    }

    if (typeof window.Notification === "undefined") {
      settingsRef.current.browserNotificationsEnabled = false;
      controller.configure(settingsRef.current);
      setNotificationPermission("unsupported");
      setNotificationsEnabledState(false);
      setTestStatus("Browser notifications are unavailable in this browser.");
      return;
    }

    let permission = window.Notification.permission;
    if (permission === "default") {
      try {
        permission = await window.Notification.requestPermission();
      } catch {
        permission = "denied";
      }
    }

    const enabled = permission === "granted";
    settingsRef.current.browserNotificationsEnabled = enabled;
    controller.configure(settingsRef.current);
    setNotificationPermission(permission);
    setNotificationsEnabledState(enabled);
    setTestStatus(enabled
      ? ""
      : "Browser notifications are blocked. Change the permission in browser settings.");
    try {
      window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, String(enabled));
    } catch {
      // The in-memory preference remains effective when storage is unavailable.
    }
  }, [controller]);

  const testSound = useCallback((kind: AlertKind) => {
    setTestStatus(controller.playTestSound(kind)
      ? `${KIND_LABEL[kind]} sound played.`
      : "Sound is unavailable in this browser.");
  }, [controller]);

  const testNotification = useCallback((kind: AlertKind) => {
    setTestStatus(controller.showTestNotification(kind)
      ? `${KIND_LABEL[kind]} browser notification sent.`
      : "Browser notifications are not enabled.");
  }, [controller]);

  useEffect(() => {
    let storedSoundEnabled = true;
    let storedNotificationsEnabled = false;
    try {
      storedSoundEnabled = window.localStorage.getItem(SOUND_ENABLED_STORAGE_KEY) !== "false";
      storedNotificationsEnabled = window.localStorage.getItem(
        BROWSER_NOTIFICATIONS_STORAGE_KEY,
      ) === "true";
    } catch {
      // Defaults remain effective when browser preference storage is unavailable.
    }

    const permission: BrowserNotificationPermission = typeof window.Notification === "undefined"
      ? "unsupported"
      : window.Notification.permission;
    const effectiveNotificationsEnabled = storedNotificationsEnabled && permission === "granted";
    settingsRef.current = {
      browserNotificationsEnabled: effectiveNotificationsEnabled,
      soundEnabled: storedSoundEnabled,
    };
    controller.configure(settingsRef.current);
    setSoundEnabledState(storedSoundEnabled);
    setNotificationsEnabledState(effectiveNotificationsEnabled);
    setNotificationPermission(permission);

    const primeAudio = () => controller.prime();
    document.addEventListener("pointerdown", primeAudio, true);
    document.addEventListener("keydown", primeAudio, true);
    return () => {
      document.removeEventListener("pointerdown", primeAudio, true);
      document.removeEventListener("keydown", primeAudio, true);
      controller.deactivate();
    };
  }, [controller]);

  const value = useMemo(
    () => ({
      notificationPermission,
      notificationsEnabled,
      observeApplication,
      observeRun,
      setNotificationsEnabled,
      setSoundEnabled,
      soundEnabled,
      testNotification,
      testSound,
      testStatus,
    }),
    [
      notificationPermission,
      notificationsEnabled,
      observeApplication,
      observeRun,
      setNotificationsEnabled,
      setSoundEnabled,
      soundEnabled,
      testNotification,
      testSound,
      testStatus,
    ],
  );
  return <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>;
}

export function useAlerts(): Alerts {
  const value = useContext(AlertsContext);
  if (value === null) throw new Error("useAlerts must be used within AlertProvider");
  return value;
}
