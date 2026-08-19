import type {
  ApplicationSessionSnapshotDto,
  ApplicationSessionView,
} from "@jobhunter/pipeline/contracts";

const TONE_FREQUENCY_HZ = 660;
const TONE_VOLUME = 0.025;
const TONE_ATTACK_SECONDS = 0.01;
const TONE_DURATION_SECONDS = 0.12;

type AudioContextWindow = typeof window & {
  readonly webkitAudioContext?: typeof AudioContext;
};

function actionableGateIdentity(snapshot: ApplicationSessionSnapshotDto): string | null {
  const action = snapshot.pendingAction;
  if (action === null || action.type === "origin_approval") return null;

  let payload: unknown = null;
  if (action.type === "human_navigation") payload = action.instruction;
  if (action.type === "additional_info") payload = action.questions;
  return JSON.stringify([snapshot.generation, action.type, payload]);
}

export class ApplicationHelpSound {
  private audioContext: AudioContext | null = null;
  private currentGateIdentity: string | null = null;
  private hasBaseline = false;
  private isDisposed = false;
  private isPrimed = false;

  observeAcceptedView(view: ApplicationSessionView): void {
    if (this.isDisposed) return;

    const snapshot = "state" in view ? null : view;
    if (snapshot === null) {
      if (this.hasBaseline) this.currentGateIdentity = null;
      return;
    }

    const nextGateIdentity = actionableGateIdentity(snapshot);
    if (!this.hasBaseline) {
      this.hasBaseline = true;
      this.currentGateIdentity = nextGateIdentity;
      return;
    }

    if (nextGateIdentity === null) {
      this.currentGateIdentity = null;
      return;
    }
    if (nextGateIdentity === this.currentGateIdentity) return;

    this.currentGateIdentity = nextGateIdentity;
    if (this.isPrimed) this.playTone(nextGateIdentity);
  }

  prime(): void {
    if (this.isDisposed) return;
    this.isPrimed = true;

    const context = this.getAudioContext();
    if (context?.state !== "suspended") return;
    try {
      void context.resume().catch(() => undefined);
    } catch {
      // Browser audio support is optional.
    }
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.currentGateIdentity = null;
    this.hasBaseline = false;
    this.isPrimed = false;

    const context = this.audioContext;
    this.audioContext = null;
    if (context === null || context.state === "closed") return;
    try {
      void context.close().catch(() => undefined);
    } catch {
      // Browser audio support is optional.
    }
  }

  private getAudioContext(): AudioContext | null {
    if (this.isDisposed || typeof window === "undefined") return null;
    if (this.audioContext !== null && this.audioContext.state !== "closed") {
      return this.audioContext;
    }

    const audioWindow = window as AudioContextWindow;
    const AudioContextConstructor = audioWindow.AudioContext
      ?? audioWindow.webkitAudioContext;
    if (AudioContextConstructor === undefined) return null;

    try {
      this.audioContext = new AudioContextConstructor();
      return this.audioContext;
    } catch {
      return null;
    }
  }

  private playTone(gateIdentity: string): void {
    const context = this.getAudioContext();
    if (context === null) return;
    if (context.state === "suspended") {
      try {
        void context.resume().then(() => {
          if (
            !this.isDisposed
            && this.currentGateIdentity === gateIdentity
            && context.state !== "closed"
          ) {
            this.startTone(context);
          }
        }).catch(() => undefined);
      } catch {
        // Browser audio support is optional.
      }
      return;
    }
    if (context.state !== "closed") this.startTone(context);
  }

  private startTone(context: AudioContext): void {
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const startAt = context.currentTime;
      const stopAt = startAt + TONE_DURATION_SECONDS;

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(TONE_FREQUENCY_HZ, startAt);
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
    } catch {
      // Browser audio support is optional.
    }
  }
}
