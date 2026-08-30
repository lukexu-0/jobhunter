import type {
  ApplicationPendingAction,
  ApplicationSessionSnapshotDto,
  ApplicationSessionView,
} from "@jobhunter/pipeline/contracts";

export type SoundAlertKind = "attention" | "success" | "failure";

interface AlertDescriptor {
  readonly identity: string;
  readonly kind: SoundAlertKind;
}

interface AlertLedgerEntry {
  current: AlertDescriptor | null;
  deliveredIdentity: string | null;
}

type AlertLedger = Record<string, AlertLedgerEntry>;

type AudioContextWindow = typeof window & {
  readonly webkitAudioContext?: typeof AudioContext;
};

const LEDGER_STORAGE_KEY = "jobhunter.sound-alerts.ledger.v1";
const FREQUENCIES_BY_KIND: Record<SoundAlertKind, readonly number[]> = {
  attention: [740, 988],
  success: [523, 659, 784],
  failure: [392, 262],
};
const TONE_VOLUME = 0.12;
const TONE_ATTACK_SECONDS = 0.015;
const TONE_DURATION_SECONDS = 0.18;
const TONE_GAP_SECONDS = 0.07;

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
    };
  }
  if (view.submissionPhase === "submitted") {
    return {
      identity: JSON.stringify([runId, view.generation, "submitted"]),
      kind: "success",
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
  };
}

function isDescriptor(value: unknown): value is AlertDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AlertDescriptor>;
  return typeof candidate.identity === "string"
    && (
      candidate.kind === "attention"
      || candidate.kind === "success"
      || candidate.kind === "failure"
    );
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
      const deliveredIdentity = candidate.deliveredIdentity;
      if (current !== null && !isDescriptor(current)) continue;
      if (deliveredIdentity !== null && typeof deliveredIdentity !== "string") continue;
      ledger[scope] = { current, deliveredIdentity };
    }
    return ledger;
  } catch {
    return {};
  }
}

export class SoundAlertController {
  private readonly ledger: AlertLedger;
  private readonly pending = new Map<string, AlertDescriptor>();
  private audioContext: AudioContext | null = null;
  private enabled = false;
  private primed = false;

  constructor() {
    this.ledger = readLedger();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.pending.clear();
      return;
    }
    for (const [scope, entry] of Object.entries(this.ledger)) {
      if (
        entry.current !== null
        && entry.current.identity !== entry.deliveredIdentity
      ) {
        this.deliver(scope, entry.current);
      }
    }
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

  private observe(scope: string, descriptor: AlertDescriptor | null): void {
    const entry = this.ledger[scope];
    if (entry === undefined) {
      this.ledger[scope] = { current: descriptor, deliveredIdentity: null };
      this.persistLedger();
      if (descriptor !== null && this.enabled) this.deliver(scope, descriptor);
      return;
    }
    if (descriptor === null) {
      if (entry.current !== null || entry.deliveredIdentity !== null) {
        entry.current = null;
        entry.deliveredIdentity = null;
        this.pending.delete(scope);
        this.persistLedger();
      }
      return;
    }
    if (entry.current?.identity !== descriptor.identity) {
      entry.current = descriptor;
      entry.deliveredIdentity = null;
      this.pending.delete(scope);
      this.persistLedger();
    }
    if (entry.deliveredIdentity !== descriptor.identity && this.enabled) {
      this.deliver(scope, descriptor);
    }
  }

  private deliver(scope: string, descriptor: AlertDescriptor): void {
    const entry = this.ledger[scope];
    if (entry === undefined || entry.current?.identity !== descriptor.identity) return;
    entry.deliveredIdentity = descriptor.identity;
    this.pending.set(scope, descriptor);
    this.persistLedger();
    if (this.primed) this.flushPending();
  }

  private flushPending(): void {
    if (!this.enabled || !this.primed || this.pending.size === 0) return;
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

  private play(context: AudioContext, kind: SoundAlertKind, delay: number): void {
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

  private persistLedger(): void {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(this.ledger));
    } catch {
      // Alerts remain available for the current mount when storage is unavailable.
    }
  }
}
