import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const buildDirectories: string[] = [];

afterEach(() => {
  for (const directory of buildDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bundled application agent loads the repository Playwright CLI reference", async () => {
  const buildDirectory = mkdtempSync(resolve(PACKAGE_ROOT, ".application-agent-build-"));
  buildDirectories.push(buildDirectory);

  const build = await Bun.build({
    entrypoints: [resolve(PACKAGE_ROOT, "src/agents/application-agent.ts")],
    packages: "external",
    outdir: buildDirectory,
    target: "bun",
  });

  expect(build.logs).toEqual([]);
  expect(build.success).toBe(true);

  const artifactUrl = pathToFileURL(resolve(buildDirectory, "application-agent.js"));
  // This test intentionally imports the runtime-selected artifact emitted above.
  const applicationAgent = await import(artifactUrl.href);

  expect(applicationAgent.runApplicationAgent).toBeFunction();
});
