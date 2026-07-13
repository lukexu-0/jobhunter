import { CLAIM_HEARTBEAT_MS, CLAIM_TTL_MS, type RunClaim } from "./claims";

export interface SchedulerRepository {
  acquire(): RunClaim | null;
  heartbeat(claim: Pick<RunClaim, "runId" | "token">): RunClaim;
  release(claim: Pick<RunClaim, "runId" | "token">): void;
}

export type ClaimedRunProcessor = (claim: RunClaim, signal: AbortSignal) => Promise<void>;

export interface WorkerSchedulerOptions {
  heartbeatMs?: number;
  recoveryDelayMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  setTimeout?: typeof globalThis.setTimeout;
  onError?: (error: unknown) => void;
}

export class WorkerScheduler {
  readonly #heartbeatMs: number;
  readonly #recoveryDelayMs: number;
  readonly #setInterval: typeof globalThis.setInterval;
  readonly #clearInterval: typeof globalThis.clearInterval;
  readonly #setTimeout: typeof globalThis.setTimeout;
  readonly #onError: (error: unknown) => void;
  #running: Promise<void> | undefined;
  #closed = false;

  constructor(
    private readonly repository: SchedulerRepository,
    private readonly processClaim: ClaimedRunProcessor,
    options: WorkerSchedulerOptions = {},
  ) {
    this.#heartbeatMs = options.heartbeatMs ?? CLAIM_HEARTBEAT_MS;
    this.#recoveryDelayMs = options.recoveryDelayMs ?? CLAIM_TTL_MS;
    this.#setInterval = options.setInterval ?? globalThis.setInterval;
    this.#clearInterval = options.clearInterval ?? globalThis.clearInterval;
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.#onError = options.onError ?? (() => undefined);
  }

  kick(): void {
    if (this.#closed || this.#running) return;
    this.#running = this.#drain().finally(() => {
      this.#running = undefined;
    });
  }

  async waitForIdle(): Promise<void> {
    await this.#running;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#running;
  }

  async #drain(): Promise<void> {
    while (!this.#closed) {
      let claim: RunClaim | null;
      try {
        claim = this.repository.acquire();
      } catch (error) {
        this.#onError(error);
        return;
      }
      if (!claim) return;
      await this.#processOne(claim);
    }
  }

  async #processOne(claim: RunClaim): Promise<void> {
    const controller = new AbortController();
    let leaseLive = true;
    let heartbeatRunning = false;
    const heartbeat = async () => {
      if (heartbeatRunning || controller.signal.aborted) return;
      heartbeatRunning = true;
      try {
        this.repository.heartbeat(claim);
      } catch (error) {
        leaseLive = false;
        controller.abort(error);
      } finally {
        heartbeatRunning = false;
      }
    };
    const timer = this.#setInterval(() => void heartbeat(), this.#heartbeatMs);
    timer.unref?.();
    try {
      await this.processClaim(claim, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) this.#onError(error);
    } finally {
      this.#clearInterval(timer);
      if (leaseLive) {
        try {
          this.repository.release(claim);
        } catch (error) {
          leaseLive = false;
          controller.abort(error);
        }
      }
      if (!leaseLive && !this.#closed) {
        const recovery = this.#setTimeout(() => this.kick(), this.#recoveryDelayMs);
        recovery.unref?.();
      }
    }
  }
}
