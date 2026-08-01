import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ContextApplicationService,
  createContextApplicationService,
} from "../src/context/application-service.ts";
import { openContextDatabase } from "../src/context/database.ts";
import {
  CONTEXT_SOURCE_ALLOWLIST,
  REPOSITORY_ROOT,
  loadContextManifest,
} from "../src/context/manifest.ts";
import { ContextStaleError } from "../src/context/index.ts";

const fixtures: string[] = [];

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createRepositoryFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "context-application-")));
  fixtures.push(root);
  const manifestRelativePath = "apps/resume-tailoring/context-sources.json";
  mkdirSync(dirname(join(root, manifestRelativePath)), { recursive: true });
  copyFileSync(join(REPOSITORY_ROOT, manifestRelativePath), join(root, manifestRelativePath));
  for (const relativePath of CONTEXT_SOURCE_ALLOWLIST) {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true });
    copyFileSync(join(REPOSITORY_ROOT, relativePath), join(root, relativePath));
  }
  return {
    root,
    loadedManifest: loadContextManifest(join(root, manifestRelativePath), root),
  };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe("ContextApplicationService", () => {
  test("moves public context status from stale through synchronization to fresh", () => {
    const { loadedManifest } = createRepositoryFixture();
    const database = openContextDatabase(":memory:");
    const service = createContextApplicationService({ database, loadedManifest });
    try {
      expect(service.getContext()).toEqual({
        fresh: false,
        manifestMatches: false,
        staleSources: [],
        missingSources: loadedManifest.manifest.sources.map((source) => source.id),
      });
      expect(() => service.createSnapshot()).toThrow(ContextStaleError);

      const synchronized = service.syncContext();
      expect(synchronized).toMatchObject({
        fresh: true,
        manifestMatches: true,
        staleSources: [],
        missingSources: [],
        sourceCount: 4,
        changedSources: loadedManifest.manifest.sources.map((source) => source.id),
      });
      expect(service.getContext()).toEqual({
        fresh: true,
        manifestMatches: true,
        staleSources: [],
        missingSources: [],
      });
    } finally {
      service.close();
      database.close();
    }
  });

  test("creates a fresh snapshot containing exactly the four indexed source hashes", () => {
    const { root, loadedManifest } = createRepositoryFixture();
    const expectedHashes = Object.fromEntries(loadedManifest.manifest.sources.map((source) => [
      source.id,
      digest(readFileSync(join(root, source.relativePath))),
    ]));
    const database = openContextDatabase(":memory:");
    const service = createContextApplicationService({ database, loadedManifest });
    try {
      service.syncContext();
      const snapshot = service.createSnapshot();
      expect(snapshot.sourceHashes).toEqual(expectedHashes);
      expect(Object.keys(snapshot.sourceHashes)).toHaveLength(4);
      expect(snapshot.sources.map((source) => source.id)).toEqual(loadedManifest.manifest.sources.map((source) => source.id));
    } finally {
      service.close();
      database.close();
    }
  });

  test("loads the canonical baseline content and matching hash without exposing resolved paths or changing sources", () => {
    const { root, loadedManifest } = createRepositoryFixture();
    const baselineDefinition = loadedManifest.manifest.sources.find((source) => source.kind === "baseline")!;
    const baselineBytes = readFileSync(join(root, baselineDefinition.relativePath));
    const expectedBaseline = baselineBytes.toString("utf8");
    const before = Object.fromEntries(CONTEXT_SOURCE_ALLOWLIST.map((relativePath) => [
      relativePath,
      digest(readFileSync(join(root, relativePath))),
    ]));
    const database = openContextDatabase(":memory:");
    const service = createContextApplicationService({ database, loadedManifest });
    try {
      service.syncContext();
      const loaded = service.loadStageSourceContext("run-1");
      expect(Object.keys(loaded)).toEqual(["snapshot", "baseline"]);
      expect(loaded.baseline).toBe(expectedBaseline);
      expect(loaded.snapshot.baselineSha256).toBe(digest(baselineBytes));
      expect(JSON.stringify(loaded)).not.toContain(root);
      expect(Object.fromEntries(CONTEXT_SOURCE_ALLOWLIST.map((relativePath) => [
        relativePath,
        digest(readFileSync(join(root, relativePath))),
      ]))).toEqual(before);
    } finally {
      service.close();
      database.close();
    }
  });

  test("refuses snapshot and stage loads after allowlisted source drift", () => {
    const { root, loadedManifest } = createRepositoryFixture();
    const database = openContextDatabase(":memory:");
    const service = createContextApplicationService({ database, loadedManifest });
    try {
      service.syncContext();
      const changedSource = loadedManifest.manifest.sources[1]!;
      const changedPath = join(root, changedSource.relativePath);
      writeFileSync(changedPath, `${readFileSync(changedPath, "utf8")}\nDrifted after synchronization.\n`);

      expect(service.getContext()).toMatchObject({ fresh: false, staleSources: [changedSource.id] });
      expect(() => service.createSnapshot()).toThrow(ContextStaleError);
      expect(() => service.loadStageSourceContext("run-2")).toThrow(ContextStaleError);
    } finally {
      service.close();
      database.close();
    }
  });

  test("close is idempotent and never closes an injected database", () => {
    const { loadedManifest } = createRepositoryFixture();
    const injectedDatabase = openContextDatabase(":memory:");
    const injected = createContextApplicationService({ database: injectedDatabase, loadedManifest });
    injected.close();
    expect(() => injected.close()).not.toThrow();
    expect(injectedDatabase.query<{ value: number }, []>("SELECT 1 AS value").get()?.value).toBe(1);
    injectedDatabase.close();

    const ownedDatabase = openContextDatabase(":memory:");
    const owned = new ContextApplicationService(ownedDatabase, loadedManifest, true);
    owned.close();
    expect(() => owned.close()).not.toThrow();
    expect(() => ownedDatabase.query("SELECT 1").get()).toThrow();
  });
});
