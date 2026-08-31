import type {
  ApplicationPendingAction,
  ApplicationSessionSnapshotDto,
  ApplicationSessionView,
  RunDto,
} from "@jobhunter/pipeline/contracts";

type AlertKind = "attention" | "success" | "failure";

interface BrowserAlertNotification {
  readonly href: string;
  readonly body: string;
  readonly title: string;
}

interface AlertDescriptor {
  readonly identity: string;
  readonly kind: AlertKind;
  readonly notification: BrowserAlertNotification;
}

interface AlertLedgerEntry {
  current: AlertDescriptor | null;
  deliveredNotificationIdentity: string | null;
  deliveredSoundIdentity: string | null;
}

type AlertLedger = Record<string, AlertLedgerEntry>;

type AudioContextWindow = typeof window & {
  readonly webkitAudioContext?: typeof AudioContext;
};

const LEDGER_STORAGE_KEY = "jobhunter.alerts.ledger.v2";
const FREQUENCIES_BY_KIND: Record<AlertKind, readonly number[]> = {
  attention: [740, 988],
  success: [523, 659, 784],
  failure: [392, 262],
};
const NOTIFICATION_COPY_BY_KIND: Record<AlertKind, Readonly<{ body: string; title: string }>> = {
  attention: {
    body: "Return to Jobhunter to continue the application.",
    title: "Application needs attention",
  },
  success: {
    body: "Jobhunter submitted the application successfully.",
    title: "Application submitted",
  },
  failure: {
    body: "Open Jobhunter to review the failure and retry.",
    title: "Application failed",
  },
};
const TONE_VOLUME = 0.12;
const TONE_ATTACK_SECONDS = 0.015;
const TONE_DURATION_SECONDS = 0.18;
const TONE_GAP_SECONDS = 0.07;

function notificationForKind(kind: AlertKind, href: string): BrowserAlertNotification {
  return { ...NOTIFICATION_COPY_BY_KIND[kind], href };
}

function pendingActionPayload(
  action: ApplicationPendingAction,
  snapshot: ApplicationSessionSnapshotDto,
): unknown {
  if (action.type === "human_navigation") return action.instruction;
  if (action.type === "additional_info") return action.questions;
  if (action.type === "origin_approval") return action.origin;
  if (action.type === "human_review") return snapshot.revisionCount;
  return null;
}

function applicationAlertDescriptor(
  runId: string,
  view: ApplicationSessionView,
): AlertDescriptor | null {
  if ("state" in view || !("bridgeState" in view)) return null;
  if (view.bridgeState === "failed") {
    return {
      identity: JSON.stringify([runId, view.generation, "failed"]),
      kind: "failure",
      notification: notificationForKind(
        "failure",
        `/runs/${encodeURIComponent(runId)}`,
      ),
    };
  }
  if (view.submissionPhase === "submitted") {
    return {
      identity: JSON.stringify([runId, view.generation, "submitted"]),
      kind: "success",
      notification: notificationForKind(
        "success",
        `/runs/${encodeURIComponent(runId)}`,
      ),
    };
  }
  if (view.pendingAction === null) return null;
  const action = view.pendingAction;
  return {
    identity: JSON.stringify([
      runId,
      view.generation,
      action.type,
      pendingActionPayload(action, view),
    ]),
    kind: "attention",
    notification: notificationForKind(
      "attention",
      `/runs/${encodeURIComponent(runId)}`,
    ),
  };
}

function runAlertDescriptor(run: RunDto): AlertDescriptor | null {
  if (run.status !== "review") return null;
  return {
    identity: JSON.stringify([run.id, run.revision, "review"]),
    kind: "attention",
    notification: {
      body: "Review the tailored resume in Jobhunter.",
      href: `/runs/${encodeURIComponent(run.id)}`,
      title: "Resume ready for review",
    },
  };
}

function isDescriptor(value: unknown): value is AlertDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AlertDescriptor>;
  const notification = candidate.notification as Partial<BrowserAlertNotification> | undefined;
  return typeof candidate.identity === "string"
    && (
      candidate.kind === "attention"
      || candidate.kind === "success"
      || candidate.kind === "failure"
    )
    && typeof notification?.body === "string"
    && typeof notification.href === "string"
    && typeof notification.title === "string";
}

function readLedger(): AlertLedger {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(LEDGER_STORAGE_KEY);
    if (raw === null) return {};
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const ledger: AlertLedger = {};
    for (const [scope, rawEntry] of Object.entries(value)) {
      if (typeof rawEntry !== "object" || rawEntry === null) continue;
      const candidate = rawEntry as Partial<AlertLedgerEntry>;
      const current = candidate.current;
      const deliveredNotificationIdentity = candidate.deliveredNotificationIdentity;
      const deliveredSoundIdentity = candidate.deliveredSoundIdentity;
      if (current !== null && !isDescriptor(current)) continue;
      if (
        deliveredNotificationIdentity !== null
        && typeof deliveredNotificationIdentity !== "string"
      ) continue;
      if (deliveredSoundIdentity !== null && typeof deliveredSoundIdentity !== "string") continue;
      ledger[scope] = {
        current,
        deliveredNotificationIdentity,
        deliveredSoundIdentity,
      };
    }
    return ledger;
  } catch {
    return {};
  }
}

export class AlertController {
  private readonly ledger: AlertLedger;
  private readonly pending = new Map<string, AlertDescriptor>();
  private audioContext: AudioContext | null = null;
  private browserNotificationsEnabled = false;
  private soundEnabled = false;
  private primed = false;

  constructor() {
    this.ledger = readLedger();
  }

  configure(options: {
    readonly browserNotificationsEnabled: boolean;
    readonly soundEnabled: boolean;
  }): void {
    this.browserNotificationsEnabled = options.browserNotificationsEnabled;
    this.soundEnabled = options.soundEnabled;
    if (!this.soundEnabled) this.pending.clear();
    for (const [scope, entry] of Object.entries(this.ledger)) {
      this.deliverEnabledChannels(scope, entry);
    }
  }

  observeRun(run: RunDto): void {
    this.observe(`run:${run.id}`, runAlertDescriptor(run), false);
  }

  observeApplication(runId: string, view: ApplicationSessionView): void {
    this.observe(
      `application:${runId}`,
      applicationAlertDescriptor(runId, view),
    );
  }

  prime(): void {
    this.primed = true;
    const context = this.getAudioContext();
    if (context === null) return;
    if (context.state === "suspended") {
      void context.resume().then(() => this.flushPending()).catch(() => undefined);
      return;
    }
    this.flushPending();
  }

  deactivate(): void {
    this.primed = false;
    const context = this.audioContext;
    this.audioContext = null;
    if (context === null || context.state === "closed") return;
    void context.close().catch(() => undefined);
  }

  private observe(
    scope: string,
    descriptor: AlertDescriptor | null,
    alertInitial = true,
  ): void {
    const entry = this.ledger[scope];
    if (entry === undefined) {
      const deliveredIdentity = alertInitial ? null : descriptor?.identity ?? null;
      const nextEntry = {
        current: descriptor,
        deliveredNotificationIdentity: deliveredIdentity,
        deliveredSoundIdentity: deliveredIdentity,
      };
      this.ledger[scope] = nextEntry;
      this.persistLedger();
      if (alertInitial) this.deliverEnabledChannels(scope, nextEntry);
      return;
    }
    if (descriptor === null) {
      if (
        entry.current !== null
        || entry.deliveredNotificationIdentity !== null
        || entry.deliveredSoundIdentity !== null
      ) {
        entry.current = null;
        entry.deliveredNotificationIdentity = null;
        entry.deliveredSoundIdentity = null;
        this.pending.delete(scope);
        this.persistLedger();
      }
      return;
    }
    if (entry.current?.identity !== descriptor.identity) {
      entry.current = descriptor;
      entry.deliveredNotificationIdentity = null;
      entry.deliveredSoundIdentity = null;
      this.pending.delete(scope);
      this.persistLedger();
    }
    this.deliverEnabledChannels(scope, entry);
  }

  private deliverEnabledChannels(scope: string, entry: AlertLedgerEntry): void {
    const descriptor = entry.current;
    if (descriptor === null) return;
    if (this.soundEnabled && entry.deliveredSoundIdentity !== descriptor.identity) {
      entry.deliveredSoundIdentity = descriptor.identity;
      this.pending.set(scope, descriptor);
      this.persistLedger();
      if (this.primed) this.flushPending();
    }
    if (
      this.browserNotificationsEnabled
      && entry.deliveredNotificationIdentity !== descriptor.identity
    ) {
      entry.deliveredNotificationIdentity = descriptor.identity;
      this.persistLedger();
      this.showBrowserNotification(scope, descriptor);
    }
  }

  private flushPending(): void {
    if (!this.soundEnabled || !this.primed || this.pending.size === 0) return;
    const context = this.getAudioContext();
    if (context === null || context.state === "closed") return;
    let delay = 0;
    for (const descriptor of this.pending.values()) {
      this.play(context, descriptor.kind, delay);
      delay += 0.6;
    }
    this.pending.clear();
  }

  private getAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (this.audioContext !== null && this.audioContext.state !== "closed") {
      return this.audioContext;
    }
    const audioWindow = window as AudioContextWindow;
    const AudioContextConstructor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
    if (AudioContextConstructor === undefined) return null;
    try {
      this.audioContext = new AudioContextConstructor();
      return this.audioContext;
    } catch {
      return null;
    }
  }

  private play(context: AudioContext, kind: AlertKind, delay: number): void {
    const frequencies = FREQUENCIES_BY_KIND[kind];
    frequencies.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const startAt = context.currentTime
        + delay
        + index * (TONE_DURATION_SECONDS + TONE_GAP_SECONDS);
      const stopAt = startAt + TONE_DURATION_SECONDS;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(TONE_VOLUME, startAt + TONE_ATTACK_SECONDS);
      gain.gain.linearRampToValueAtTime(0, stopAt);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.addEventListener("ended", () => {
        oscillator.disconnect();
        gain.disconnect();
      }, { once: true });
      oscillator.start(startAt);
      oscillator.stop(stopAt);
    });
  }

  private showBrowserNotification(scope: string, descriptor: AlertDescriptor): boolean {
    if (
      typeof window === "undefined"
      || !("Notification" in window)
      || window.Notification.permission !== "granted"
    ) return false;
    try {
      const browserNotification = new window.Notification(descriptor.notification.title, {
        body: descriptor.notification.body,
        tag: `jobhunter:${scope}`,
      });
      browserNotification.onclick = () => {
        window.focus();
        window.location.assign(descriptor.notification.href);
        browserNotification.close();
      };
      return true;
    } catch {
      return false;
    }
  }

  private persistLedger(): void {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(this.ledger));
    } catch {
      // Alerts remain available for the current mount when storage is unavailable.
    }
  }
}
