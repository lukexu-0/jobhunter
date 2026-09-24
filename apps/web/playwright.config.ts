import { defineConfig } from "@playwright/test";

const webPort = Number(process.env.JOBHUNT_E2E_WEB_PORT ?? "3466");
const pipelinePort = Number(process.env.JOBHUNT_E2E_PIPELINE_PORT ?? "3467");

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/*.pw.ts",
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
  },
  webServer: {
    command: `bunx next dev --hostname 127.0.0.1 --port ${webPort}`,
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: false,
    env: {
      JOBHUNT_PIPELINE_ORIGIN: `http://127.0.0.1:${pipelinePort}`,
    },
  },
});
