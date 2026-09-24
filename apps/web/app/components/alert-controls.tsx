"use client";

import { useAlerts } from "../credentials/alert-provider";
import styles from "./alert-controls.module.css";

interface AlertControlsProps {
  readonly className?: string;
}

export function AlertControls({ className }: AlertControlsProps) {
  const {
    notificationPermission,
    notificationsEnabled,
    notificationRequestPending,
    setNotificationsEnabled,
    setSoundEnabled,
    soundEnabled,
  } = useAlerts();
  const browserNotificationsUnavailable = notificationPermission === null
    || notificationPermission === "denied"
    || notificationPermission === "unsupported";
  const browserNotificationLabel = notificationPermission === "denied"
    ? "Notifications blocked"
    : notificationPermission === "unsupported"
      ? "Notifications unavailable"
      : "Browser notifications";

  return (
    <div className={className ? `${styles.controls} ${className}` : styles.controls}>
      <label className={styles.toggle}>
        <input
          aria-label="Sound alerts"
          checked={soundEnabled ?? false}
          disabled={soundEnabled === null}
          onChange={(event) => setSoundEnabled(event.currentTarget.checked)}
          type="checkbox"
        />
        <span>Sound alerts</span>
      </label>
      <label className={styles.toggle}>
        <input
          aria-label="Browser notifications"
          checked={notificationsEnabled ?? false}
          disabled={browserNotificationsUnavailable || notificationRequestPending}
          onChange={(event) => void setNotificationsEnabled(event.currentTarget.checked)}
          type="checkbox"
        />
        <span>{browserNotificationLabel}</span>
      </label>
    </div>
  );
}

export function NotificationRecovery() {
  const { notificationPermission, notificationRequestPending, setNotificationsEnabled, statusMessage } = useAlerts();
  if (!statusMessage) return null;
  return (
    <section aria-label="Notification permissions" className={styles.recovery}>
      <p role="status">{statusMessage}</p>
      <div className={styles.actions}>
        {notificationPermission !== "unsupported" ? (
          <button
            className="inline-control"
            disabled={notificationRequestPending}
            onClick={() => void setNotificationsEnabled(true)}
            type="button"
          >
            {notificationRequestPending ? "Requesting permission…" : notificationPermission === "default"
              ? "Enable notifications" : "Retry notifications"}
          </button>
        ) : null}
        <button className="inline-control" onClick={() => void setNotificationsEnabled(false)} type="button">
          Turn off notifications
        </button>
      </div>
    </section>
  );
}
