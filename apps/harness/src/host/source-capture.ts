import type { z } from "zod";

import { HarnessServiceError } from "./artifacts.ts";
import {
  SourceCaptureCreateRequestSchema,
  SourceCaptureCreateResponseSchema,
  SourceCaptureResultSchema,
} from "../contracts/models.ts";

export type SourceCaptureCreateRequest = z.infer<typeof SourceCaptureCreateRequestSchema>;
export type SourceCaptureCreateResponse = z.infer<typeof SourceCaptureCreateResponseSchema>;
export type SourceCaptureResult = z.infer<typeof SourceCaptureResultSchema>;

export interface SourceCaptureRuntime {
  start(jobUrl: string): Promise<void>;
  openBrowser(): Promise<void>;
  captureSourceSnapshot(): Promise<readonly [string, string] | null>;
  close(): Promise<void>;
}

export interface SourceCaptureManagerOptions {
  applicationActive(): boolean;
  runtimeFactory(captureId: string): SourceCaptureRuntime | Promise<SourceCaptureRuntime>;
}

interface ActiveCapture {
  request: SourceCaptureCreateRequest;
  runtime?: SourceCaptureRuntime;
  setup: Promise<void>;
  completion?: Promise<SourceCaptureResult>;
}

export class SourceCaptureManager {
  readonly #applicationActive: () => boolean;
  readonly #runtimeFactory: (captureId: string) => SourceCaptureRuntime | Promise<SourceCaptureRuntime>;
  #active: ActiveCapture | null = null;
  #replay: SourceCaptureResult | null = null;
  readonly #tombstones = new Map<string, true>();

  constructor(options: SourceCaptureManagerOptions) {
    this.#applicationActive = options.applicationActive;
    this.#runtimeFactory = options.runtimeFactory;
  }

  get activeCaptureId(): string | null {
    return this.#active?.request.capture_id ?? null;
  }

  async create(input: SourceCaptureCreateRequest): Promise<SourceCaptureCreateResponse> {
    const parsed = SourceCaptureCreateRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new HarnessServiceError(422, "invalid_request", "Request is invalid");
    }
    if (this.#applicationActive()) {
      throw new HarnessServiceError(
        409,
        "source_capture_active",
        "A source capture is already active",
      );
    }
    if (this.#active !== null) {
      if (this.#active.request.capture_id === parsed.data.capture_id) {
        await this.#active.setup;
        return SourceCaptureCreateResponseSchema.parse({
          capture_id: parsed.data.capture_id,
          state: "awaiting_human_verification",
        });
      }
      throw new HarnessServiceError(
        409,
        "source_capture_active",
        "A source capture is already active",
      );
    }
    if (this.#tombstones.has(parsed.data.capture_id)) {
      throw new HarnessServiceError(
        409,
        "source_capture_not_ready",
        "Source capture is not ready",
      );
    }

    this.#replay = null;
    const record: ActiveCapture = { request: parsed.data, setup: Promise.resolve() };
    this.#active = record;
    record.setup = this.#setupRecord(record);
    await record.setup;

    return SourceCaptureCreateResponseSchema.parse({
      capture_id: parsed.data.capture_id,
      state: "awaiting_human_verification",
    });
  }

  async complete(captureId: string): Promise<SourceCaptureResult> {
    if (this.#active?.request.capture_id !== captureId) {
      if (this.#replay?.capture_id === captureId) return this.#replay;
      if (this.#tombstones.has(captureId)) {
        throw new HarnessServiceError(
          409,
          "source_capture_not_ready",
          "Source capture is not ready",
        );
      }
      throw new HarnessServiceError(
        404,
        "source_capture_not_found",
        "Source capture was not found",
      );
    }

    const record = this.#active;
    await record.setup;
    record.completion ??= this.#completeRecord(record);
    return record.completion;
  }

  async delete(captureId: string): Promise<void> {
    const record = this.#active;
    if (record?.request.capture_id === captureId) {
      await record.setup.catch(() => undefined);
      await record.runtime?.close();
      if (this.#active === record) this.#active = null;
      this.#replay = null;
      this.#remember(captureId);
      return;
    }
    if (this.#replay?.capture_id === captureId) {
      this.#replay = null;
      this.#remember(captureId);
      return;
    }
    if (this.#tombstones.has(captureId)) return;
    throw new HarnessServiceError(
      404,
      "source_capture_not_found",
      "Source capture was not found",
    );
  }

  async shutdown(): Promise<void> {
    const record = this.#active;
    if (record) {
      await record.setup.catch(() => undefined);
      await record.runtime?.close();
      if (this.#active === record) this.#active = null;
      this.#remember(record.request.capture_id);
    }
    this.#replay = null;
  }

  async #setupRecord(record: ActiveCapture): Promise<void> {
    try {
      const runtime = await this.#runtimeFactory(record.request.capture_id);
      record.runtime = runtime;
      await runtime.start(record.request.job_url);
      await runtime.openBrowser();
    } catch {
      try { await record.runtime?.close(); } catch {
        throw new HarnessServiceError(503, "unavailable", "Source capture is unavailable");
      }
      if (this.#active === record) this.#active = null;
      this.#remember(record.request.capture_id);
      throw new HarnessServiceError(503, "unavailable", "Source capture is unavailable");
    }
  }

  async #completeRecord(record: ActiveCapture): Promise<SourceCaptureResult> {
    let result: SourceCaptureResult | undefined;
    let failure: HarnessServiceError | undefined;
    try {
      const capture = await record.runtime!.captureSourceSnapshot();
      if (capture === null) throw new Error("source capture is empty");
      result = SourceCaptureResultSchema.parse({
        capture_id: record.request.capture_id,
        final_url: capture[0],
        source: capture[1],
      });
      this.#replay = result;
    } catch (error) {
      failure = error instanceof HarnessServiceError ? error : new HarnessServiceError(
        409, "source_capture_not_ready", "Source capture is not ready",
      );
    }
    await record.runtime!.close();
    if (this.#active === record) this.#active = null;
    this.#remember(record.request.capture_id);
    if (failure !== undefined) throw failure;
    return result!;
  }

  #remember(captureId: string): void {
    this.#tombstones.delete(captureId);
    this.#tombstones.set(captureId, true);
    while (this.#tombstones.size > 32) {
      const oldest = this.#tombstones.keys().next().value;
      if (oldest === undefined) return;
      this.#tombstones.delete(oldest);
    }
  }
}
