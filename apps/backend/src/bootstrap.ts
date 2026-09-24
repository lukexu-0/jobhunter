import type { Database } from "bun:sqlite";
import {
  createApplicationSubmissionRoutes,
} from "./api/application-submission-routes.ts";
import {
  createApplicationSessionRoutes,
  type ApplicationSessionRouteService,
} from "./api/application-session-routes.ts";
import {
  HttpApplicationHarnessClient,
  type ApplicationHarnessClient,
  type GmailAuthHarnessClient,
  type ModelAuthHarnessClient,
  type SourceCaptureHarnessClient,
} from "./api/application-harness-client.ts";
import { ApplicationSessionService } from "./api/application-session-service.ts";
import { createAuthRoutes, type AuthRouteService } from "./api/auth-routes.ts";
import { createContextRoutes, type ContextRouteService } from "./api/context-routes.ts";
import { createApiHandler, type ApiRequestContext } from "./api/handler.ts";
import { createRunRoutes } from "./api/run-routes.ts";
import {
  createSourceHandoffRoutes,
  type SourceHandoffRouteService,
} from "./api/source-handoff-routes.ts";
import { SourceHandoffService } from "./api/source-handoff-service.ts";
import { RunApplicationService } from "./api/run-service.ts";
import type { LoadJobSource } from "./api/job-source.ts";
import type { ExtractJobDescription } from "./models/luna-job-extractor.ts";
import {
  professionalizeApplicationAnswer,
  type ProfessionalizeApplicationAnswer,
} from "./models/application-answer-professionalizer.ts";
import { createGmailAuthProviderHooks } from "./auth/gmail-provider.ts";
import * as defaultAuthService from "./auth/service.ts";
import { createContextApplicationService, type ContextApplicationService } from "./context/application-service.ts";
import { openContextDatabase } from "./context/database.ts";
import { openPipelineDatabase } from "./db/database.ts";
import { PipelineRepository } from "./db/repository.ts";
import { ApplicationModelIdSchema } from "./contracts/index.ts";
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

export interface PipelineApplicationSessionService extends ApplicationSessionRouteService {
  startNextAutomaticApplication(signal: AbortSignal): Promise<boolean>;
  dispose?(): void | Promise<void>;
}

export interface PipelineSourceHandoffService extends SourceHandoffRouteService {
  close(): void | Promise<void>;
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
  readonly applicationHarnessOrigin?: string;
  readonly applicationHarness?: ApplicationHarnessClient;
  readonly applicationSessions?: PipelineApplicationSessionService;
  readonly professionalizeAnswer?: ProfessionalizeApplicationAnswer;
  readonly sourceCaptureHarness?: SourceCaptureHarnessClient;
  readonly sourceHandoffs?: PipelineSourceHandoffService;
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
  readonly applicationSessions: PipelineApplicationSessionService;
  readonly sourceHandoffs: PipelineSourceHandoffService;
}

export interface PipelineApplication {
  fetch(request: Request, context?: ApiRequestContext): Promise<Response>;
  kick(): void;
  close(): Promise<void>;
  readonly services: Readonly<PipelineApplicationServices>;
}

function validateWebOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("JOBHUNT_WEB_ORIGIN must be an exact HTTPS or loopback HTTP origin");
  }
  const loopbackHttp = url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (
    (url.protocol !== "https:" && !loopbackHttp)
    || (url.protocol === "https:" && url.hostname.includes("*"))
    || url.origin !== origin
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("JOBHUNT_WEB_ORIGIN must be an exact HTTPS or loopback HTTP origin");
  }
  return origin;
}

async function closeAll(operations: readonly (() => void | Promise<void>)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const operation of operations) {
    try {
      const pending = operation();
      if (pending !== undefined) await pending;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Pipeline application close failed");
}

function isSourceCaptureHarnessClient(
  client: ApplicationHarnessClient | undefined,
): client is ApplicationHarnessClient & SourceCaptureHarnessClient {
  if (client === undefined) return false;
  const candidate = client as Partial<SourceCaptureHarnessClient>;
  return typeof candidate.createSourceCapture === "function"
    && typeof candidate.completeSourceCapture === "function"
    && typeof candidate.deleteSourceCapture === "function";
}
function isGmailAuthHarnessClient(
  client: ApplicationHarnessClient | undefined,
): client is ApplicationHarnessClient & GmailAuthHarnessClient {
  if (client === undefined) return false;
  const candidate = client as Partial<GmailAuthHarnessClient>;
  return typeof candidate.getGmailAuth === "function"
    && typeof candidate.createGmailAuthSession === "function"
    && typeof candidate.getGmailAuthSession === "function"
    && typeof candidate.deleteGmailAuth === "function";
}
function isModelAuthHarnessClient(
  client: ApplicationHarnessClient | undefined,
): client is ApplicationHarnessClient & ModelAuthHarnessClient {
  if (client === undefined) return false;
  const candidate = client as Partial<ModelAuthHarnessClient>;
  return typeof candidate.setModelCredential === "function"
    && typeof candidate.deleteModelCredential === "function"
    && typeof candidate.setApplicationModel === "function";
}

export function createPipelineApplication(options: PipelineApplicationOptions = {}): PipelineApplication {
  const defaultApplicationModel = ApplicationModelIdSchema.parse(
    process.env.JOBHUNT_APPLICATION_MODEL ?? "gpt-5.6-sol",
  );
  const webOrigin = validateWebOrigin(
    options.webOrigin ?? process.env.JOBHUNT_WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN,
  );
  const browserHarnessToken = options.browserHarnessToken ?? process.env.JOBHUNT_HARNESS_TOKEN;
  if (browserHarnessToken !== undefined && browserHarnessToken.length < 32) {
    throw new Error("JOBHUNT_HARNESS_TOKEN must contain at least 32 characters");
  }
  const artifacts = options.artifacts ?? new ArtifactStore();
  const pipelineDatabase = options.pipelineDatabase ?? (options.repository ? undefined : openPipelineDatabase());
  const repository = options.repository ?? new PipelineRepository(pipelineDatabase!);
  repository.reconcileAttemptingApplicationSubmissions();
  const contextDatabase = options.contextDatabase ?? (options.context ? undefined : openContextDatabase());
  const context = options.context ?? createContextApplicationService({ database: contextDatabase! });
  const applicationHarnessOrigin = options.applicationHarnessOrigin ?? process.env.JOBHUNT_HARNESS_URL;
  const defaultHarness = browserHarnessToken === undefined
    ? undefined
    : new HttpApplicationHarnessClient({
        token: browserHarnessToken,
        ...(applicationHarnessOrigin ? { origin: applicationHarnessOrigin } : {}),
      });
  const applicationHarness = options.applicationHarness ?? defaultHarness;
  const sourceCaptureHarness = options.sourceCaptureHarness
    ?? (isSourceCaptureHarnessClient(applicationHarness)
      ? applicationHarness
      : undefined);
  const modelAuthHarness = isModelAuthHarnessClient(applicationHarness)
    ? applicationHarness
    : undefined;
  let worker = options.worker;
  const applicationSessions = options.applicationSessions ?? new ApplicationSessionService({
    repository,
    artifacts,
    onApplicationSessionReleased: () => worker?.kick(),
    professionalizeAnswer:
      options.professionalizeAnswer ?? professionalizeApplicationAnswer,
    ...(applicationHarness ? { harness: applicationHarness } : {}),
  });
  const schedulerOptions = options.workerOptions?.scheduler;
  worker ??= createPipelineWorkerRuntime({
    ...options.workerOptions,
    repository,
    artifacts,
    loadSourceContext: (runId) => context.loadStageSourceContext(runId),
    scheduler: {
      ...schedulerOptions,
      afterDrain: async (signal) => {
        await schedulerOptions?.afterDrain?.(signal);
        while (await applicationSessions.startNextAutomaticApplication(signal)) {
          signal.throwIfAborted();
        }
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
  const sourceHandoffs = options.sourceHandoffs ?? new SourceHandoffService({
    runs,
    ...(sourceCaptureHarness ? { harness: sourceCaptureHarness } : {}),
  });
  const gmailAuthHarness = isGmailAuthHarnessClient(applicationHarness)
    ? applicationHarness
    : undefined;
  const auth = options.auth ?? defaultAuthService.createManagedAuthService({
    ...(gmailAuthHarness
      ? { providerHooks: { gmail: createGmailAuthProviderHooks(gmailAuthHarness) } }
      : {}),
    ...(modelAuthHarness ? { modelCredentialMirror: modelAuthHarness } : {}),
  });
  const routeApplicationSubmissions = createApplicationSubmissionRoutes({
    markReviewReady: (sessionId) => repository.markAutomaticApplicationReviewReady(sessionId),
    claim: (sessionId) => repository.claimApplicationSubmission(sessionId),
    finalize: (sessionId, outcome) => repository.finalizeApplicationSubmission(sessionId, outcome),
  }, browserHarnessToken);
  const closeAuth = options.closeAuth
    ?? auth.close?.bind(auth)
    ?? (() => undefined);
  let harnessReady: Promise<void> | undefined;
  const ensureHarnessReady = (): Promise<void> => {
    if (modelAuthHarness === undefined) return Promise.resolve();
    harnessReady ??= Promise.all([
      auth.getAuthStatus(),
      modelAuthHarness.setApplicationModel(
        repository.getApplicationModel(defaultApplicationModel),
        AbortSignal.timeout(10_000),
      ),
    ]).then(() => undefined);
    return harnessReady;
  };

  const routeAuth = createAuthRoutes(auth, {
    getApplicationModel: () => ({
      model: repository.getApplicationModel(defaultApplicationModel),
    }),
    setApplicationModel: async (model) => {
      if (modelAuthHarness !== undefined) {
        await modelAuthHarness.setApplicationModel(model, AbortSignal.timeout(10_000));
      }
      return { model: repository.setApplicationModel(model) };
    },
  });
  const routeContext = createContextRoutes(context);
  const routeRuns = createRunRoutes(runs);
  const routeSourceHandoffs = createSourceHandoffRoutes(sourceHandoffs);
  const routeApplicationSessions = createApplicationSessionRoutes(applicationSessions);
  const fetch = createApiHandler({
    internalRoute: routeApplicationSubmissions,
    webOrigin,
    route: async (request, url, context) => {
      await ensureHarnessReady();
      return (await routeAuth(request, url))
      ?? (await routeContext(request, url))
      ?? (await routeApplicationSessions(request, url))
      ?? (await routeSourceHandoffs(request, url, context))
      ?? (await routeRuns(request, url, context));
    },
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
    sourceHandoffs,
  });
  let closePromise: Promise<void> | undefined;

  return Object.freeze({
    fetch,
    kick: () => worker.kick(),
    close: () => {
      closePromise ??= closeAll([
        () => sourceHandoffs.close(),
        () => worker.close(),
        () => applicationSessions.dispose?.(),
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
