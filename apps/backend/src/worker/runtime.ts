import { PipelineStageProcessor, type PipelineStageDependencies } from "../stages/processor.ts";
import type { StageRepository } from "../stages/types.ts";
import { WorkerScheduler, type SchedulerRepository, type WorkerSchedulerOptions } from "./scheduler.ts";

export interface PipelineWorkerRepository extends StageRepository, SchedulerRepository {}

export interface PipelineWorkerRuntimeOptions extends Omit<PipelineStageDependencies, "repository"> {
  readonly repository: PipelineWorkerRepository;
  readonly scheduler?: WorkerSchedulerOptions;
}

export interface PipelineWorkerRuntime {
  readonly processor: PipelineStageProcessor;
  readonly scheduler: WorkerScheduler;
  kick(): void;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}

export function createPipelineWorkerRuntime(options: PipelineWorkerRuntimeOptions): PipelineWorkerRuntime {
  const processor = new PipelineStageProcessor(options);
  const scheduler = new WorkerScheduler(
    options.repository,
    (claim, signal) => processor.processClaim(claim, signal),
    options.scheduler,
  );
  return Object.freeze({
    processor,
    scheduler,
    kick: () => scheduler.kick(),
    waitForIdle: () => scheduler.waitForIdle(),
    close: () => scheduler.close(),
  });
}
