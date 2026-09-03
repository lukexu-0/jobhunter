"use client";

import { useAlerts } from "../providers/alert-provider";
import styles from "./alert-controls.module.css";

interface AlertControlsProps {
  readonly className?: string;
}

export function AlertControls({ className }: AlertControlsProps) {
  const {
    notificationPermission,
    notificationsEnabled,
    setNotificationsEnabled,
    setSoundEnabled,
    soundEnabled,
    statusMessage,
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
          disabled={browserNotificationsUnavailable}
          onChange={(event) => void setNotificationsEnabled(event.currentTarget.checked)}
          type="checkbox"
        />
        <span>{browserNotificationLabel}</span>
      </label>
      <span aria-live="polite" className="visually-hidden" role="status">
        {statusMessage}
      </span>
    </div>
  );
}
