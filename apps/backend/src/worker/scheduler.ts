import { CLAIM_HEARTBEAT_MS, CLAIM_TTL_MS, RUN_CLAIM_CAPACITY, type RunClaim } from "./claims";

export interface SchedulerRepository {
  acquire(): RunClaim | null;
  heartbeat(claim: Pick<RunClaim, "runId" | "token">): RunClaim;
  release(claim: Pick<RunClaim, "runId" | "token">): void;
}

export type ClaimedRunProcessor = (claim: RunClaim, signal: AbortSignal) => Promise<void>;

export interface WorkerSchedulerOptions {
  heartbeatMs?: number;
  concurrency?: number;
  recoveryDelayMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  setTimeout?: typeof globalThis.setTimeout;
  onError?: (error: unknown) => void;
  afterDrain?: (signal: AbortSignal) => void | Promise<void>;
}

export class WorkerScheduler {
  readonly #concurrency: number;
  readonly #heartbeatMs: number;
  readonly #recoveryDelayMs: number;
  readonly #setInterval: typeof globalThis.setInterval;
  readonly #clearInterval: typeof globalThis.clearInterval;
  readonly #setTimeout: typeof globalThis.setTimeout;
  readonly #onError: (error: unknown) => void;
  readonly #afterDrain: (signal: AbortSignal) => void | Promise<void>;
  readonly #shutdownController = new AbortController();
  readonly #shutdownReason = new DOMException("Worker scheduler closed", "AbortError");
  readonly #activeControllers = new Set<AbortController>();
  #running: Promise<void> | undefined;
  #kickPending = false;
  #wakeDrain: (() => void) | undefined;
  #recoveryPending = 0;
  #closed = false;

  constructor(
    private readonly repository: SchedulerRepository,
    private readonly processClaim: ClaimedRunProcessor,
    options: WorkerSchedulerOptions = {},
  ) {
    const concurrency = options.concurrency ?? RUN_CLAIM_CAPACITY;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > RUN_CLAIM_CAPACITY) {
      throw new Error(`worker concurrency must be an integer between 1 and ${RUN_CLAIM_CAPACITY}`);
    }
    this.#concurrency = concurrency;
    this.#heartbeatMs = options.heartbeatMs ?? CLAIM_HEARTBEAT_MS;
    this.#recoveryDelayMs = options.recoveryDelayMs ?? CLAIM_TTL_MS;
    this.#setInterval = options.setInterval ?? globalThis.setInterval;
    this.#clearInterval = options.clearInterval ?? globalThis.clearInterval;
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.#onError = options.onError ?? (() => undefined);
    this.#afterDrain = options.afterDrain ?? (() => undefined);
  }

  kick(): void {
    if (this.#closed || this.#recoveryPending > 0) return;
    if (this.#running) {
      this.#kickPending = true;
      this.#wakeDrain?.();
      return;
    }
    const running = Promise.resolve().then(() => this.#drain()).finally(() => {
      this.#running = undefined;
      if (this.#kickPending && !this.#closed && this.#recoveryPending === 0) {
        this.#kickPending = false;
        this.kick();
      }
    });
    this.#running = running;
  }

  async waitForIdle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#shutdownController.abort(this.#shutdownReason);
    for (const controller of this.#activeControllers) controller.abort(this.#shutdownReason);
    this.#kickPending = false;
    this.#recoveryPending = 0;
    await this.waitForIdle();
  }

  async #drain(): Promise<void> {
    const active = new Set<Promise<boolean>>();
    let acquisitionFailed = false;
    let queueExhausted = false;

    while (!this.#closed && !acquisitionFailed) {
      while (
        !this.#closed
        && this.#recoveryPending === 0
        && !queueExhausted
        && active.size < this.#concurrency
      ) {
        let claim: RunClaim | null;
        try {
          claim = this.repository.acquire();
        } catch (error) {
          this.#onError(error);
          acquisitionFailed = true;
          break;
        }
        if (!claim) {
          queueExhausted = true;
          break;
        }
        let processing!: Promise<boolean>;
        processing = this.#processOne(claim).finally(() => {
          active.delete(processing);
        });
        active.add(processing);
      }

      if (this.#closed || acquisitionFailed) break;
      if (active.size === 0) {
        if (queueExhausted && this.#recoveryPending === 0) {
          try {
            await this.#afterDrain(this.#shutdownController.signal);
          } catch (error) {
            if (!this.#closed) this.#onError(error);
          }
        }
        return;
      }

      if (queueExhausted || this.#recoveryPending > 0) {
        const kicked = new Promise<undefined>((resolve) => {
          this.#wakeDrain = () => resolve(undefined);
        });
        const result = await Promise.race([...active, kicked]);
        this.#wakeDrain = undefined;
        if (result === undefined) {
          this.#kickPending = false;
          queueExhausted = false;
          continue;
        }
      } else {
        await Promise.race(active);
      }
      queueExhausted = false;
    }

    if (active.size > 0) await Promise.all(active);
  }

  async #processOne(claim: RunClaim): Promise<boolean> {
    const controller = new AbortController();
    this.#activeControllers.add(controller);
    let leaseLive = true;
    let recoveryRegistered = false;
    const registerRecovery = () => {
      if (recoveryRegistered || this.#closed) return;
      recoveryRegistered = true;
      this.#recoveryPending += 1;
      this.#kickPending = false;
    };
    let heartbeatRunning = false;
    const heartbeat = async () => {
      if (heartbeatRunning || controller.signal.aborted) return;
      heartbeatRunning = true;
      try {
        this.repository.heartbeat(claim);
      } catch (error) {
        leaseLive = false;
        registerRecovery();
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
          registerRecovery();
          controller.abort(error);
        }
      }
      if (recoveryRegistered && !this.#closed) this.#scheduleRecovery();
      this.#activeControllers.delete(controller);
    }
    return leaseLive;
  }

  #scheduleRecovery(): void {
    const recovery = this.#setTimeout(() => {
      if (this.#closed) return;
      this.#recoveryPending -= 1;
      if (this.#recoveryPending === 0) this.kick();
    }, this.#recoveryDelayMs);
    recovery.unref?.();
  }
}
