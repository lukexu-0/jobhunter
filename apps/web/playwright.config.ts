import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/*.pw.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3456",
  },
  webServer: {
    command: "bun run dev",
    url: "http://127.0.0.1:3456",
    reuseExistingServer: true,
  },
});
