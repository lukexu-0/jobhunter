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
  afterDrain?: () => void | Promise<void>;
}

export class WorkerScheduler {
  readonly #heartbeatMs: number;
  readonly #recoveryDelayMs: number;
  readonly #setInterval: typeof globalThis.setInterval;
  readonly #clearInterval: typeof globalThis.clearInterval;
  readonly #setTimeout: typeof globalThis.setTimeout;
  readonly #onError: (error: unknown) => void;
  readonly #afterDrain: () => void | Promise<void>;
  readonly #shutdownReason = new DOMException("Worker scheduler closed", "AbortError");
  #running: Promise<void> | undefined;
  #activeController: AbortController | undefined;
  #kickPending = false;
  #recoveryPending = false;
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
    this.#afterDrain = options.afterDrain ?? (() => undefined);
  }

  kick(): void {
    if (this.#closed || this.#recoveryPending) return;
    if (this.#running) {
      this.#kickPending = true;
      return;
    }
    this.#running = this.#drain().finally(() => {
      this.#running = undefined;
      if (this.#kickPending && !this.#closed && !this.#recoveryPending) {
        this.#kickPending = false;
        this.kick();
      }
    });
  }

  async waitForIdle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#activeController?.abort(this.#shutdownReason);
    this.#kickPending = false;
    this.#recoveryPending = false;
    await this.waitForIdle();
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
      if (!claim) {
        try {
          await this.#afterDrain();
        } catch (error) {
          this.#onError(error);
        }
        return;
      }
      if (!await this.#processOne(claim)) return;
    }
  }

  async #processOne(claim: RunClaim): Promise<boolean> {
    const controller = new AbortController();
    this.#activeController = controller;
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
        this.#recoveryPending = true;
        this.#kickPending = false;
        const recovery = this.#setTimeout(() => {
          this.#recoveryPending = false;
          this.kick();
        }, this.#recoveryDelayMs);
        recovery.unref?.();
      }
      if (this.#activeController === controller) this.#activeController = undefined;
    }
    return leaseLive;
  }
}
