import "./auth/service.ts";
import { bootstrapAgentRuntime } from "./agents/runner.ts";
import { createPipelineApplication } from "./bootstrap.ts";

const hostname = "127.0.0.1";
const port = 3457;

export async function main(): Promise<void> {
  bootstrapAgentRuntime();
  const app = createPipelineApplication();
  const server = Bun.serve({ hostname, port, fetch: app.fetch });
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
