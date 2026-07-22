import type { Database } from "bun:sqlite";
import {
  createApplicationAgentRoutes,
  type ApplicationAgentRouteService,
} from "./api/application-agent-routes.ts";
import {
  createApplicationSessionRoutes,
  type ApplicationSessionRouteService,
} from "./api/application-session-routes.ts";
import type { ApplicationHarnessClient } from "./api/application-harness-client.ts";
import { HttpApplicationHarnessClient } from "./api/application-harness-client.ts";
import { ApplicationSessionService } from "./api/application-session-service.ts";
import { createAuthRoutes, type AuthRouteService } from "./api/auth-routes.ts";
import { createContextRoutes, type ContextRouteService } from "./api/context-routes.ts";
import { createApiHandler } from "./api/handler.ts";
import { createRunRoutes } from "./api/run-routes.ts";
import { RunApplicationService } from "./api/run-service.ts";
import type { LoadJobSource } from "./api/job-source.ts";
import type { ExtractJobDescription } from "./models/luna-job-extractor.ts";
import * as defaultAuthService from "./auth/service.ts";
import { createContextApplicationService, type ContextApplicationService } from "./context/application-service.ts";
import { openContextDatabase } from "./context/database.ts";
import { openPipelineDatabase } from "./db/database.ts";
import { PipelineRepository } from "./db/repository.ts";
import { ArtifactStore, DEFAULT_ARTIFACT_ROOT } from "./system/artifacts.ts";
import { migrateRunOutputLayout } from "./system/run-output-migration.ts";
import { enforceRunArtifactRetention } from "./system/run-retention.ts";
import { ApplicationAgentService } from "./agents/application-agent-service.ts";
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
  readonly loadJobSource?: LoadJobSource;
  readonly extractJobDescription?: ExtractJobDescription;
  readonly auth?: ClosableAuthRouteService;
  readonly closeAuth?: () => void | Promise<void>;
  readonly browserHarnessToken?: string;
  readonly applicationAgent?: ApplicationAgentRouteService;
  readonly applicationHarnessOrigin?: string;
  readonly applicationHarness?: ApplicationHarnessClient;
  readonly applicationSessions?: ApplicationSessionRouteService;
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
  readonly applicationSessions: ApplicationSessionRouteService;
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
  const browserHarnessToken = options.browserHarnessToken ?? process.env.JOBHUNTER_HARNESS_TOKEN;
  if (browserHarnessToken !== undefined && browserHarnessToken.length < 32) {
    throw new Error("JOBHUNTER_HARNESS_TOKEN must contain at least 32 characters");
  }
  const pipelineDatabase = options.pipelineDatabase ?? (options.repository ? undefined : openPipelineDatabase());
  const artifacts = options.artifacts ?? new ArtifactStore();
  if (pipelineDatabase && artifacts.root === DEFAULT_ARTIFACT_ROOT) {
    migrateRunOutputLayout(pipelineDatabase, { outputRoot: artifacts.root });
  }
  const repository = options.repository ?? new PipelineRepository(pipelineDatabase!);
  repository.reconcileAttemptingApplicationSubmissions();
  const contextDatabase = options.contextDatabase ?? (options.context ? undefined : openContextDatabase());
  const context = options.context ?? createContextApplicationService({ database: contextDatabase! });
  const schedulerOptions = options.workerOptions?.scheduler;
  const worker = options.worker ?? createPipelineWorkerRuntime({
    ...options.workerOptions,
    repository,
    artifacts,
    loadSourceContext: (runId) => context.loadStageSourceContext(runId),
    scheduler: {
      ...schedulerOptions,
      afterDrain: async () => {
        await schedulerOptions?.afterDrain?.();
        await enforceRunArtifactRetention(repository, artifacts);
      },
    },
  });
  const runs = options.runs ?? new RunApplicationService({
    repository,
    context,
    artifacts,
    scheduler: worker,
    ...(options.loadJobSource ? { loadJobSource: options.loadJobSource } : {}),
    ...(options.extractJobDescription ? { extractJobDescription: options.extractJobDescription } : {}),
  });
  const auth = options.auth ?? defaultAuthService;
  const applicationAgent = options.applicationAgent
    ?? (browserHarnessToken === undefined
      ? undefined
      : new ApplicationAgentService(browserHarnessToken, {
          authStatusReader: () => auth.getAuthStatus(),
          submissionGuardFactory: (sessionId) => ({
            claim: async () => repository.claimApplicationSubmission(sessionId),
            finalize: async (outcome) =>
              repository.finalizeApplicationSubmission(sessionId, outcome),
          }),
        }));
  const applicationHarnessOrigin = options.applicationHarnessOrigin ?? process.env.JOBHUNTER_HARNESS_URL;
  const applicationSessions = options.applicationSessions ?? new ApplicationSessionService({
    repository,
    artifacts,
    ...(
      options.applicationHarness
        ? { harness: options.applicationHarness }
        : browserHarnessToken === undefined
          ? {}
          : {
              harness: new HttpApplicationHarnessClient({
                token: browserHarnessToken,
                ...(applicationHarnessOrigin ? { origin: applicationHarnessOrigin } : {}),
              }),
            }
    ),
  });
  const routeApplicationAgent = createApplicationAgentRoutes(
    applicationAgent,
    browserHarnessToken,
  );
  const closeAuth = options.closeAuth
    ?? (options.auth ? options.auth.close?.bind(options.auth) ?? (() => undefined) : defaultAuthService.closeAuth);

  const routeAuth = createAuthRoutes(auth);
  const routeContext = createContextRoutes(context);
  const routeRuns = createRunRoutes(runs);
  const routeApplicationSessions = createApplicationSessionRoutes(applicationSessions);
  const fetch = createApiHandler({
    internalRoute: routeApplicationAgent,
    webOrigin: options.webOrigin ?? process.env.JOBHUNTER_WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN,
    route: async (request, url) =>
      (await routeAuth(request, url))
      ?? (await routeContext(request, url))
      ?? (await routeApplicationSessions(request, url))
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
    applicationSessions,
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
