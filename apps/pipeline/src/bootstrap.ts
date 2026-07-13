import type { Database } from "bun:sqlite";
import { createAuthRoutes, type AuthRouteService } from "./api/auth-routes.ts";
import { createContextRoutes, type ContextRouteService } from "./api/context-routes.ts";
import { createApiHandler } from "./api/handler.ts";
import { createRunRoutes } from "./api/run-routes.ts";
import { RunApplicationService } from "./api/run-service.ts";
import * as defaultAuthService from "./auth/service.ts";
import { createContextApplicationService, type ContextApplicationService } from "./context/application-service.ts";
import { openContextDatabase } from "./context/database.ts";
import { openPipelineDatabase } from "./db/database.ts";
import { PipelineRepository } from "./db/repository.ts";
import { ArtifactStore } from "./system/artifacts.ts";
import {
  createPipelineWorkerRuntime,
  type PipelineWorkerRuntimeOptions,
} from "./worker/runtime.ts";

const DEFAULT_WEB_ORIGIN = "http://127.0.0.1:3456";

type ClosableAuthRouteService = AuthRouteService & {
  close?(): void | Promise<void>;
};

type ClosableContextRouteService = ContextRouteService & {
  createSnapshot: ContextApplicationService["createSnapshot"];
  loadStageSourceContext: ContextApplicationService["loadStageSourceContext"];
  close?(): void | Promise<void>;
};

export interface PipelineWorkerHandle {
  kick(): void;
  close(): Promise<void>;
}

export interface PipelineApplicationOptions {
  readonly webOrigin?: string;
  readonly pipelineDatabase?: Database;
  readonly contextDatabase?: Database;
  readonly repository?: PipelineRepository;
  readonly artifacts?: ArtifactStore;
  readonly context?: ClosableContextRouteService;
  readonly worker?: PipelineWorkerHandle;
  readonly workerOptions?: Omit<PipelineWorkerRuntimeOptions, "repository" | "artifacts" | "loadSourceContext">;
  readonly runs?: RunApplicationService;
  readonly auth?: ClosableAuthRouteService;
  readonly closeAuth?: () => void | Promise<void>;
}

/** Internal handles are exposed for typed integration tests, not serialized by any route. */
export interface PipelineApplicationServices {
  readonly pipelineDatabase?: Database;
  readonly contextDatabase?: Database;
  readonly repository: PipelineRepository;
  readonly artifacts: ArtifactStore;
  readonly context: ClosableContextRouteService;
  readonly worker: PipelineWorkerHandle;
  readonly runs: RunApplicationService;
  readonly auth: ClosableAuthRouteService;
}

export interface PipelineApplication {
  fetch(request: Request): Promise<Response>;
  kick(): void;
  close(): Promise<void>;
  readonly services: Readonly<PipelineApplicationServices>;
}

async function closeAll(operations: readonly (() => void | Promise<void>)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Pipeline application close failed");
}

export function createPipelineApplication(options: PipelineApplicationOptions = {}): PipelineApplication {
  const pipelineDatabase = options.pipelineDatabase ?? (options.repository ? undefined : openPipelineDatabase());
  const repository = options.repository ?? new PipelineRepository(pipelineDatabase!);
  const artifacts = options.artifacts ?? new ArtifactStore();
  const contextDatabase = options.contextDatabase ?? (options.context ? undefined : openContextDatabase());
  const context = options.context ?? createContextApplicationService({ database: contextDatabase! });
  const worker = options.worker ?? createPipelineWorkerRuntime({
    ...options.workerOptions,
    repository,
    artifacts,
    loadSourceContext: (runId) => context.loadStageSourceContext(runId),
  });
  const runs = options.runs ?? new RunApplicationService({
    repository,
    context,
    artifacts,
    scheduler: worker,
  });
  const auth = options.auth ?? defaultAuthService;
  const closeAuth = options.closeAuth
    ?? (options.auth ? options.auth.close?.bind(options.auth) ?? (() => undefined) : defaultAuthService.closeAuth);

  const routeAuth = createAuthRoutes(auth);
  const routeContext = createContextRoutes(context);
  const routeRuns = createRunRoutes(runs);
  const fetch = createApiHandler({
    webOrigin: options.webOrigin ?? process.env.JOBHUNTER_WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN,
    route: async (request, url) =>
      (await routeAuth(request, url))
      ?? (await routeContext(request, url))
      ?? (await routeRuns(request, url)),
  });
  const services = Object.freeze({
    ...(pipelineDatabase === undefined ? {} : { pipelineDatabase }),
    ...(contextDatabase === undefined ? {} : { contextDatabase }),
    repository,
    artifacts,
    context,
    worker,
    runs,
    auth,
  });
  let closePromise: Promise<void> | undefined;

  return Object.freeze({
    fetch,
    kick: () => worker.kick(),
    close: () => {
      closePromise ??= closeAll([
        () => worker.close(),
        () => closeAuth(),
        () => context.close?.(),
        ...(pipelineDatabase ? [() => pipelineDatabase.close()] : []),
        ...(contextDatabase ? [() => contextDatabase.close()] : []),
      ]);
      return closePromise;
    },
    services,
  });
}
