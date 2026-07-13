import { resolve } from "node:path";

const appsRoot = resolve(import.meta.dir, "..");
const pipeline = Bun.spawn(["bun", "run", "--cwd", "pipeline", "dev"], {
  cwd: appsRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

let web: Bun.Subprocess | undefined;
let stopping = false;

async function terminate(signal: NodeJS.Signals, exitCode: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    pipeline.kill(signal);
    web?.kill(signal);
    await Promise.allSettled([pipeline.exited, web?.exited]);
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => void terminate("SIGINT", 0));
process.on("SIGTERM", () => void terminate("SIGTERM", 0));

const healthDeadline = Date.now() + 30_000;
while (true) {
  if (pipeline.exitCode !== null) {
    throw new Error(`Pipeline exited before it became healthy (${pipeline.exitCode})`);
  }
  try {
    const response = await fetch("http://127.0.0.1:3457/v1/health", {
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok) break;
  } catch {
    // The service is still starting.
  }
  if (Date.now() >= healthDeadline) {
    await terminate("SIGTERM", 1);
  }
  await Bun.sleep(200);
}

web = Bun.spawn(["bun", "run", "--cwd", "web", "dev"], {
  cwd: appsRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

const [name, exitCode] = await Promise.race([
  pipeline.exited.then((code) => ["pipeline", code] as const),
  web.exited.then((code) => ["web", code] as const),
]);
console.error(`${name} exited with code ${exitCode}; stopping workspace`);
await terminate("SIGTERM", exitCode);
