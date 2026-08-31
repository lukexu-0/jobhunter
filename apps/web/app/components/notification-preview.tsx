"use client";

import type { AlertKind } from "../lib/alerts";
import { useAlerts } from "../providers/alert-provider";

const PREVIEWS: ReadonlyArray<{
  readonly description: string;
  readonly kind: AlertKind;
  readonly label: string;
}> = [
  {
    description: "Review or input is required.",
    kind: "attention",
    label: "Attention",
  },
  {
    description: "An application was submitted.",
    kind: "success",
    label: "Success",
  },
  {
    description: "The application agent failed.",
    kind: "failure",
    label: "Failure",
  },
];

export function NotificationPreview() {
  const {
    notificationPermission,
    notificationsEnabled,
    setNotificationsEnabled,
    setSoundEnabled,
    soundEnabled,
    testNotification,
    testSound,
    testStatus,
  } = useAlerts();

  const browserStatus = notificationPermission === null
    ? "Checking"
    : notificationPermission === "unsupported"
      ? "Unsupported"
      : notificationPermission === "denied"
        ? "Blocked"
        : notificationsEnabled
          ? "Enabled"
          : "Not enabled";
  const canEnableNotifications = notificationPermission === "default"
    || (notificationPermission === "granted" && !notificationsEnabled);

  return (
    <section className="notification-preview" aria-labelledby="notification-preview-title">
      <header className="workspace-header notification-preview__header">
        <div className="workspace-header__copy">
          <p className="kicker">Alerts</p>
          <h1 className="workspace-title" id="notification-preview-title">Notification previews</h1>
          <p className="workspace-summary">
            Play every alert in this browser, then enable system notifications for live pipeline events.
          </p>
        </div>
      </header>

      <div className="notification-settings">
        <section className="notification-setting" aria-labelledby="sound-alert-setting">
          <div>
            <p className="kicker">Sound</p>
            <h2 id="sound-alert-setting">Sound alerts</h2>
            <p>Plays a short tone when a pipeline event needs attention or reaches a terminal state.</p>
          </div>
          <label className="notification-toggle">
            <input
              aria-label="Sound alerts"
              checked={soundEnabled ?? false}
              disabled={soundEnabled === null}
              onChange={(event) => setSoundEnabled(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>{soundEnabled ? "Enabled" : "Disabled"}</span>
          </label>
        </section>

        <section className="notification-setting" aria-labelledby="browser-alert-setting">
          <div>
            <p className="kicker">System</p>
            <h2 id="browser-alert-setting">Browser notifications</h2>
            <p>Shows an operating-system notification while Jobhunter is open in this browser.</p>
          </div>
          <div className="notification-setting__actions">
            {notificationsEnabled ? (
              <button
                className="control control--quiet"
                onClick={() => void setNotificationsEnabled(false)}
                type="button"
              >
                Disable browser notifications
              </button>
            ) : canEnableNotifications ? (
              <button
                className="control control--primary"
                onClick={() => void setNotificationsEnabled(true)}
                type="button"
              >
                Enable browser notifications
              </button>
            ) : null}
          </div>
        </section>

        <p className="notification-status" aria-live="polite" role="status">
          Browser notifications: {browserStatus}.
          {testStatus ? ` ${testStatus}` : ""}
        </p>
      </div>

      <div className="notification-preview__grid">
        {PREVIEWS.map((preview) => (
          <section className={`notification-preview-card notification-preview-card--${preview.kind}`} key={preview.kind}>
            <div>
              <p className="kicker">{preview.kind}</p>
              <h2>{preview.label}</h2>
              <p>{preview.description}</p>
            </div>
            <div className="notification-preview-card__actions">
              <button
                className="control control--primary"
                disabled={soundEnabled !== true}
                onClick={() => testSound(preview.kind)}
                type="button"
              >
                Play {preview.kind} sound
              </button>
              <button
                className="control control--quiet"
                disabled={notificationsEnabled !== true}
                onClick={() => testNotification(preview.kind)}
                type="button"
              >
                Send {preview.kind} notification
              </button>
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
