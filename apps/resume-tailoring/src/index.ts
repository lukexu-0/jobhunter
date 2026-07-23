import "./auth/service.ts";
import { bootstrapAgentRuntime } from "./agents/runner.ts";
import { createPipelineApplication, type PipelineApplication } from "./bootstrap.ts";
import { APPLICATION_AGENT_PATH } from "./api/application-agent-routes.ts";
import { APPLICATION_EVENT_STREAM_PATH } from "./api/application-session-routes.ts";

const hostname = "127.0.0.1";
const port = 3457;

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
    port: options.port ?? port,
    fetch(request, server) {
      const url = new URL(request.url);
      if (
        (
          request.method === "POST"
          && url.pathname === APPLICATION_AGENT_PATH
        )
        || (
          request.method === "GET"
          && APPLICATION_EVENT_STREAM_PATH.test(url.pathname)
        )
      ) {
        server.timeout(request, 0);
      }
      return app.fetch(request);
    },
  });
}

export async function main(): Promise<void> {
  bootstrapAgentRuntime();
  const app = createPipelineApplication();
  const server = startPipelineHttpServer(app);
  app.kick();
  console.log(`Resume pipeline listening on http://${hostname}:${port}`);

  let stopPromise: Promise<void> | undefined;
  const stop = (signal: NodeJS.Signals): Promise<void> => {
    stopPromise ??= (async () => {
      console.log(`Stopping resume pipeline after ${signal}`);
      try {
        await server.stop();
      } finally {
        await app.close();
      }
    })();
    return stopPromise;
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

if (import.meta.main) void main();
