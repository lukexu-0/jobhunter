import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  ApplicationAgentService,
  type ApplicationSubmissionGuardFactory,
} from "../src/agents/application-agent-service.ts";
import { ApplicationAgentTraceStore } from "../src/agents/application-agent-traces.ts";
import { bootstrapAgentRuntime } from "../src/agents/runner.ts";
import { createApplicationAgentRoutes } from "../src/api/application-agent-routes.ts";
import { createApiHandler } from "../src/api/handler.ts";
import { closeAuth, getAuthStatus } from "../src/auth/service.ts";
import { openPipelineDatabase } from "../src/db/database.ts";
import { PipelineRepository } from "../src/db/repository.ts";
import { startPipelineHttpServer } from "../src/index.ts";

const DEFAULT_PORT = 3457;
const SMOKE_PDF_SHA256 = "a".repeat(64);
const TEMPORARY_DATABASE_ERROR =
  "JOBHUNTER_APPLICATION_SMOKE_DATABASE must name a temporary SQLite file inside the system temporary directory";

export function resolveApplicationSmokeDatabasePath(setting: string): string {
  if (setting === ":memory:") throw new Error(TEMPORARY_DATABASE_ERROR);
  const configuredPath = resolve(setting);
  let temporaryRoot: string;
  let parent: string;
  try {
    temporaryRoot = realpathSync(tmpdir());
    parent = realpathSync(dirname(configuredPath));
  } catch {
    throw new Error(`${TEMPORARY_DATABASE_ERROR}; its parent directory must already exist`);
  }

  let databasePath = resolve(parent, basename(configuredPath));
  let status: Stats | undefined;
  try {
    status = lstatSync(configuredPath);
  } catch (error) {
    if (
      !error
      || typeof error !== "object"
      || !("code" in error)
      || error.code !== "ENOENT"
    ) {
      throw new Error(`${TEMPORARY_DATABASE_ERROR}; the configured path could not be inspected`);
    }
  }
  if (status?.isSymbolicLink()) {
    throw new Error("JOBHUNTER_APPLICATION_SMOKE_DATABASE must not be a symbolic link");
  }
  if (status !== undefined) {
    if (!status.isFile() || status.nlink !== 1) {
      throw new Error("JOBHUNTER_APPLICATION_SMOKE_DATABASE must be a singly linked regular file");
    }
    databasePath = realpathSync(configuredPath);
  }

  const relation = relative(temporaryRoot, databasePath);
  if (
    relation.length === 0
    || relation === ".."
    || relation.startsWith(`..${sep}`)
    || isAbsolute(relation)
  ) {
    throw new Error(TEMPORARY_DATABASE_ERROR);
  }
  return databasePath;
}
const SMOKE_JOB_DESCRIPTION = "Synthetic Browser Harness application smoke";

interface SmokeReservation {
  readonly runId: string;
  readonly generation: number;
}

function reserveSmokeSession(
  repository: PipelineRepository,
  sessionId: string,
): SmokeReservation {
  const run = repository.createRun(
    SMOKE_JOB_DESCRIPTION,
    randomUUID(),
    false,
  );
  const claim = repository.acquire();
  if (!claim || claim.runId !== run.id) {
    throw new Error("application smoke could not acquire its synthetic run");
  }
  try {
    for (const stage of [
      "analyzing",
      "tailoring",
      "compiling",
      "deterministic_qa",
      "visual_qa",
    ] as const) {
      repository.transition(claim, stage);
    }
    const attempt = repository.startAttempt(claim, "visual_qa");
    repository.finalizeArtifact(claim, {
      attemptId: attempt.id,
      stage: "visual_qa",
      kind: "compiled-pdf",
      sha256: SMOKE_PDF_SHA256,
      path: `/application-smoke/${run.id}.pdf`,
      byteSize: 10,
    });
    repository.finishAttempt(claim, attempt.id, "succeeded");
    repository.transition(claim, "review");
  } finally {
    repository.release(claim);
  }
  repository.approve(run.id, SMOKE_PDF_SHA256);
  const reserved = repository.reserveApplicationSession(
    run.id,
    null,
    sessionId,
    SMOKE_PDF_SHA256,
  );
  return repository.recordApplicationSnapshot(run.id, {
    slotReleased: false,
    generation: reserved.generation,
    sessionId,
    bridgeState: "awaiting_human_review",
    publicSnapshot: { state: "awaiting_human_review" },
  });
}

/**
 * Gives the live direct-harness smoke a private durable submission ledger.
 * Production requests continue to use the run reservation created by the
 * application-session service; only this standalone smoke gateway synthesizes it.
 */
export function createApplicationSmokeSubmissionGuardFactory(
  repository: PipelineRepository,
): ApplicationSubmissionGuardFactory {
  const reservations = new Set<string>();
  return (sessionId) => {
    if (!reservations.has(sessionId)) {
      reserveSmokeSession(repository, sessionId);
      reservations.add(sessionId);
    }
    return Object.freeze({
      markReviewReady: async () => {
        repository.markAutomaticApplicationReviewReady(sessionId);
      },
      claim: async () => {
        repository.claimApplicationSubmission(sessionId);
      },
      finalize: async (outcome: "submitted" | "uncertain") => {
        repository.finalizeApplicationSubmission(sessionId, outcome);
      },
    });
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function configuredPort(): number {
  const raw = process.env.JOBHUNTER_APPLICATION_SMOKE_PORT;
  if (raw === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(raw)) {
    throw new Error("JOBHUNTER_APPLICATION_SMOKE_PORT must be an integer from 1 through 65535");
  }
  const port = Number(raw);
  if (port < 1 || port > 65_535) {
    throw new Error("JOBHUNTER_APPLICATION_SMOKE_PORT must be an integer from 1 through 65535");
  }
  return port;
}

export async function main(): Promise<void> {
  const token = requiredEnvironment("JOBHUNTER_HARNESS_TOKEN");
  if (token.length < 32) {
    throw new Error("JOBHUNTER_HARNESS_TOKEN must contain at least 32 characters");
  }
  const databasePath = resolveApplicationSmokeDatabasePath(
    requiredEnvironment("JOBHUNTER_APPLICATION_SMOKE_DATABASE"),
  );
  const port = configuredPort();
  const database = openPipelineDatabase(databasePath);
  const repository = new PipelineRepository(database);
  repository.reconcileAttemptingApplicationSubmissions();
  const service = new ApplicationAgentService(token, {
    authStatusReader: getAuthStatus,
    submissionGuardFactory:
      createApplicationSmokeSubmissionGuardFactory(repository),
    traceStore: new ApplicationAgentTraceStore(
      resolve(dirname(databasePath), `${basename(databasePath)}.application-agent-traces`),
    ),
  });
  const internalRoute = createApplicationAgentRoutes(service, token);
  const fetch = createApiHandler({
    internalRoute,
    webOrigin: "http://127.0.0.1:3456",
  });

  bootstrapAgentRuntime();
  const server = startPipelineHttpServer({ fetch }, { port });
  console.log(`Application smoke gateway listening on http://127.0.0.1:${port}`);

  let stopPromise: Promise<void> | undefined;
  const stop = (signal: NodeJS.Signals): Promise<void> => {
    stopPromise ??= (async () => {
      console.log(`Stopping application smoke gateway after ${signal}`);
      try {
        await server.stop();
      } finally {
        try {
          await closeAuth();
        } finally {
          database.close();
        }
      }
    })();
    return stopPromise;
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

if (import.meta.main) void main();
