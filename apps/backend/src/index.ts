import "./auth/service.ts";
import { bootstrapAgentRuntime } from "./agents/runner.ts";
import { createPipelineApplication, type PipelineApplication } from "./bootstrap.ts";
import {
  APPLICATION_COMMAND_PATH,
  APPLICATION_EVENT_STREAM_PATH,
} from "./api/application-session-routes.ts";
import { resolveBrowserHarnessToken } from "./system/harness-token.ts";

const hostname = "127.0.0.1";
const DEFAULT_PIPELINE_PORT = 3457;
const RUN_CREATION_PATH = "/v1/runs";
const SOURCE_HANDOFF_CREATION_PATH = "/v1/source-handoffs";
const SOURCE_HANDOFF_COMPLETION_PATH =
  /^\/v1\/source-handoffs\/[^/]+\/complete$/;

export function resolvePipelinePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PIPELINE_PORT;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("JOBHUNT_PIPELINE_PORT must be an integer from 1 through 65535");
  }
  const resolved = Number(value);
  if (resolved > 65_535) {
    throw new Error("JOBHUNT_PIPELINE_PORT must be an integer from 1 through 65535");
  }
  return resolved;
}

export interface PipelineHttpServerOptions {
  readonly hostname?: string;
  readonly port?: number;
}

export function startPipelineHttpServer(
  app: Pick<PipelineApplication, "fetch">,
  options: PipelineHttpServerOptions = {},
) {
  return Bun.serve({
    hostname: options.hostname ?? hostname,
    port: options.port ?? DEFAULT_PIPELINE_PORT,
    fetch(request, server) {
      const url = new URL(request.url);
      const isRunCreation =
        request.method === "POST"
        && url.pathname === RUN_CREATION_PATH;
      const isSourceHandoffCreation =
        request.method === "POST"
        && url.pathname === SOURCE_HANDOFF_CREATION_PATH;
      const isSourceHandoffCompletion =
        request.method === "POST"
        && SOURCE_HANDOFF_COMPLETION_PATH.test(url.pathname);
      if (
        (
          request.method === "POST"
          && APPLICATION_COMMAND_PATH.test(url.pathname)
        )
        || (
          request.method === "GET"
          && APPLICATION_EVENT_STREAM_PATH.test(url.pathname)
        )
      ) {
        server.timeout(request, 0);
      }
      return app.fetch(
        request,
        isRunCreation || isSourceHandoffCreation || isSourceHandoffCompletion
          ? {
              ...(isRunCreation
                ? {
                    onRunCreationValidated: () => {
                      server.timeout(request, 0);
                    },
                  }
                : {}),
              ...(isSourceHandoffCreation
                ? {
                    onSourceHandoffCreationValidated: () => {
                      server.timeout(request, 0);
                    },
                  }
                : {}),
              ...(isSourceHandoffCompletion
                ? {
                    onSourceHandoffCompletionValidated: () => {
                      server.timeout(request, 0);
                    },
                  }
                : {}),
            }
          : undefined,
      );
    },
  });
}

export async function main(): Promise<void> {
  bootstrapAgentRuntime();
  const browserHarnessToken = resolveBrowserHarnessToken();
  const port = resolvePipelinePort(process.env.JOBHUNT_PIPELINE_PORT);
  const app = createPipelineApplication(
    browserHarnessToken === undefined ? {} : { browserHarnessToken },
  );
  const server = startPipelineHttpServer(app, { port });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      try {
        await server.stop();
      } finally {
        await app.close();
      }
    })();
    return closePromise;
  };

  try {
    app.kick();
  } catch (startupError) {
    await close().catch(() => undefined);
    throw startupError;
  }
  console.log(`Resume pipeline listening on http://${hostname}:${port}`);

  const stop = (signal: NodeJS.Signals): Promise<void> => {
    console.log(`Stopping resume pipeline after ${signal}`);
    return close();
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

if (import.meta.main) void main();
