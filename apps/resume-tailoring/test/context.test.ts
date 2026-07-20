import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  CONTEXT_SOURCE_ALLOWLIST,
  REPOSITORY_ROOT,
  checkContextFreshness,
  createContextSnapshot,
  loadContextManifest,
  openContextDatabase,
  resolveContextSource,
  searchEvidence,
  sha256,
  syncContext,
  verifyContextSnapshot,
} from "../src/context/index.ts";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function createRepositoryFixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "context-index-")));
  fixtures.push(root);
  const manifestRelative = "apps/resume-tailoring/context-sources.json";
  mkdirSync(dirname(join(root, manifestRelative)), { recursive: true });
  copyFileSync(join(REPOSITORY_ROOT, manifestRelative), join(root, manifestRelative));
  for (const relativePath of CONTEXT_SOURCE_ALLOWLIST) {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true });
    copyFileSync(join(REPOSITORY_ROOT, relativePath), join(root, relativePath));
  }
  return root;
}

function loadFixture(root: string) {
  return loadContextManifest(join(root, "apps/resume-tailoring/context-sources.json"), root);
}

describe("allowlisted context ingestion", () => {
  test("accepts exactly the literal four sources and rejects additions or traversal", () => {
    const root = createRepositoryFixture();
    const loaded = loadFixture(root);
    expect(loaded.manifest.sources.map((source) => source.relativePath)).toEqual([...CONTEXT_SOURCE_ALLOWLIST]);

    const manifestPath = join(root, "apps/resume-tailoring/context-sources.json");
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    parsed.sources.push({ ...parsed.sources[1], id: "untrusted", relativePath: "actual/other.md" });
    writeFileSync(manifestPath, JSON.stringify(parsed));
    expect(() => loadFixture(root)).toThrow("exactly four sources");

    parsed.sources.pop();
    parsed.sources[1].relativePath = "../outside.md";
    writeFileSync(manifestPath, JSON.stringify(parsed));
    expect(() => loadFixture(root)).toThrow("literal four-file allowlist");
  });

  test("rejects a symbolic link at any source path", () => {
    const root = createRepositoryFixture();
    const loaded = loadFixture(root);
    const source = loaded.manifest.sources[1]!;
    const sourcePath = join(root, source.relativePath);
    const outside = join(root, "outside.md");
    writeFileSync(outside, "untrusted");
    rmSync(sourcePath);
    symlinkSync(outside, sourcePath);
    expect(() => resolveContextSource(root, source)).toThrow("symbolic link");
  });

  test("synchronizes immutable versions and deterministic evidence IDs without changing source bytes", () => {
    const root = createRepositoryFixture();
    const loaded = loadFixture(root);
    const before = Object.fromEntries(CONTEXT_SOURCE_ALLOWLIST.map((path) => [path, sha256(readFileSync(join(root, path)))]));
    const database = openContextDatabase(":memory:");
    try {
      const first = syncContext(database, loaded, 100);
      const firstSnapshot = createContextSnapshot(database, loaded);
      syncContext(database, loaded, 200);
      const secondSnapshot = createContextSnapshot(database, loaded);
      expect(first.sourceCount).toBe(4);
      expect(firstSnapshot.evidence.map((block) => block.id)).toEqual(secondSnapshot.evidence.map((block) => block.id));
      expect(Object.fromEntries(CONTEXT_SOURCE_ALLOWLIST.map((path) => [path, sha256(readFileSync(join(root, path)))]))).toEqual(before);
      expect(() => database.query("UPDATE source_versions SET indexed_at = 9").run()).toThrow("immutable");
      expect(() => database.query("DELETE FROM evidence_blocks").run()).toThrow("immutable");

      const changedPath = join(root, CONTEXT_SOURCE_ALLOWLIST[2]);
      writeFileSync(changedPath, `${readFileSync(changedPath, "utf8")}\nAdditional bounded fact.\n`);
      expect(checkContextFreshness(database, loaded).staleSources).toEqual(["sample-project-archive"]);
      syncContext(database, loaded, 300);
      const versions = database.query<{ count: number }, []>("SELECT count(*) AS count FROM source_versions WHERE source_id = 'sample-project-archive'").get();
      expect(versions?.count).toBe(2);
    } finally {
      database.close();
    }
  });

  test("indexes FTS, retains caveats with claims, and binds the sampleProject title explicitly", () => {
    const root = createRepositoryFixture();
    const loaded = loadFixture(root);
    const database = openContextDatabase(":memory:");
    try {
      syncContext(database, loaded);
      const matches = searchEvidence(database, "sample reconciliation exceptions");
      expect(matches.length).toBeGreaterThan(0);
      const claim = matches.find((block) => block.text.includes("$5,000"));
      expect(claim?.text).toContain("User-reported");
      expect(claim?.caveats.join(" ")).toMatch(/User-reported|not independently/i);
      const snapshot = createContextSnapshot(database, loaded);
      expect(snapshot.explicitEntityBindings["Sample Project"]).toBe("SampleProject");
      expect(snapshot.sources.find((source) => source.id === "sample-project")?.baselineEntityIds).toContain("Sample Project");
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.evidence)).toBe(true);
    } finally {
      database.close();
    }
  });

  test("detects source drift against an immutable per-run snapshot", () => {
    const root = createRepositoryFixture();
    const loaded = loadFixture(root);
    const database = openContextDatabase(":memory:");
    try {
      syncContext(database, loaded);
      const snapshot = createContextSnapshot(database, loaded);
      expect(verifyContextSnapshot(snapshot, loaded)).toEqual({ valid: true, manifestChanged: false, changedSources: [] });
      const sourcePath = join(root, CONTEXT_SOURCE_ALLOWLIST[3]);
      writeFileSync(sourcePath, `${readFileSync(sourcePath, "utf8")}\nDrift\n`);
      expect(verifyContextSnapshot(snapshot, loaded)).toEqual({
        valid: false,
        manifestChanged: false,
        changedSources: ["sample-project"],
      });
      expect(snapshot.sourceHashes["sample-project"]).not.toBe(sha256(readFileSync(sourcePath)));
    } finally {
      database.close();
    }
  });
});
