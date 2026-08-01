import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  CONTEXT_SOURCE_ALLOWLIST,
  REPOSITORY_ROOT,
  checkContextFreshness,
  createContextSnapshot,
  extractMustIncludeDirectives,
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
  test("accepts exactly the literal five sources and rejects additions, omissions, duplicates, substitution, or traversal", () => {
    const root = createRepositoryFixture();
    const loaded = loadFixture(root);
    expect(loaded.manifest.sources.map((source) => source.relativePath)).toEqual([...CONTEXT_SOURCE_ALLOWLIST]);

    const manifestPath = join(root, "apps/resume-tailoring/context-sources.json");
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    parsed.sources.push({ ...parsed.sources[1], id: "untrusted", relativePath: "actual/other.md" });
    writeFileSync(manifestPath, JSON.stringify(parsed));
    expect(() => loadFixture(root)).toThrow("exactly five sources");

    parsed.sources.pop();
    const missing = parsed.sources.pop();
    writeFileSync(manifestPath, JSON.stringify(parsed));
    expect(() => loadFixture(root)).toThrow("exactly five sources");

    parsed.sources.push(missing);
    const originalSecondId = parsed.sources[1].id;
    parsed.sources[1].id = parsed.sources[0].id;
    writeFileSync(manifestPath, JSON.stringify(parsed));
    expect(() => loadFixture(root)).toThrow("Context source IDs must be unique");

    parsed.sources[1].id = originalSecondId;
    parsed.sources[1].relativePath = parsed.sources[0].relativePath;
    writeFileSync(manifestPath, JSON.stringify(parsed));
    expect(() => loadFixture(root)).toThrow("literal five-file allowlist");

    parsed.sources[1].relativePath = "actual/other.md";
    writeFileSync(manifestPath, JSON.stringify(parsed));
    expect(() => loadFixture(root)).toThrow("literal five-file allowlist");

    parsed.sources[1].relativePath = "../outside.md";
    writeFileSync(manifestPath, JSON.stringify(parsed));
    expect(() => loadFixture(root)).toThrow("literal five-file allowlist");
  });

  test("preserves source order flexibility while rejecting literal source metadata aliases", () => {
    const root = createRepositoryFixture();
    const manifestPath = join(root, "apps/resume-tailoring/context-sources.json");
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    parsed.sources.reverse();
    writeFileSync(manifestPath, JSON.stringify(parsed));
    expect(loadFixture(root).manifest.sources.map((source) => source.relativePath))
      .toEqual([...CONTEXT_SOURCE_ALLOWLIST].reverse());

    for (const mutation of [
      { id: "jobhunter-resume-info-alias" },
      { entityId: "project:wrong" },
      { displayName: "Aliased Jobhunter resume information" },
      { baselineEntityIds: ["Jobhunter"] },
    ]) {
      const candidate = JSON.parse(JSON.stringify(parsed));
      const jobhunter = candidate.sources.find((source: { relativePath: string }) =>
        source.relativePath === "jobhunter-resume-info.md");
      Object.assign(jobhunter, mutation);
      writeFileSync(manifestPath, JSON.stringify(candidate));
      expect(() => loadFixture(root)).toThrow("does not match the literal contract");
    }

    const reorderedBindingCandidate = JSON.parse(JSON.stringify(parsed));
    const sampleProject = reorderedBindingCandidate.sources.find((source: { relativePath: string }) =>
      source.relativePath === "apps/user-info/current-context/projects/sample-project.md");
    sampleProject.baselineEntityIds.reverse();
    writeFileSync(manifestPath, JSON.stringify(reorderedBindingCandidate));
    expect(() => loadFixture(root)).toThrow("does not match the literal contract");
  });

  test("rejects an extra Jobhunter binding that could activate its directives", () => {
    const root = createRepositoryFixture();
    const manifestPath = join(root, "apps/resume-tailoring/context-sources.json");
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    parsed.explicitEntityBindings["project:jobhunter"] = "Example Company";
    writeFileSync(manifestPath, JSON.stringify(parsed));
    expect(() => loadFixture(root)).toThrow(
      "explicitEntityBindings must contain only the Sample Project binding",
    );
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
      expect(first.sourceCount).toBe(5);
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

  test("refreshes manifest metadata without reindexing unchanged source bytes", () => {
    const root = createRepositoryFixture();
    const loaded = loadFixture(root);
    const legacyLoaded = {
      ...loaded,
      manifest: {
        ...loaded.manifest,
        sources: loaded.manifest.sources.map((source) => source.id === "jobhunter-resume-info"
          ? { ...source, baselineEntityIds: ["Jobhunter"] }
          : source),
      },
      manifestSha256: sha256("legacy Jobhunter alias"),
    };
    const database = openContextDatabase(":memory:");
    try {
      syncContext(database, legacyLoaded, 100);
      const legacySource = createContextSnapshot(database, legacyLoaded).sources
        .find((source) => source.id === "jobhunter-resume-info")!;
      expect(checkContextFreshness(database, loaded)).toEqual({
        fresh: false,
        manifestMatches: false,
        staleSources: [],
        missingSources: [],
      });

      const report = syncContext(database, loaded, 200);
      const currentSource = createContextSnapshot(database, loaded).sources
        .find((source) => source.id === "jobhunter-resume-info")!;
      const versions = database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM source_versions WHERE source_id = 'jobhunter-resume-info'",
      ).get();

      expect(legacySource.baselineEntityIds).toEqual(["Jobhunter"]);
      expect(report.changedSources).not.toContain("jobhunter-resume-info");
      expect(currentSource.baselineEntityIds).toEqual(["Resume Tailoring and Application Agent"]);
      expect(currentSource.sourceVersionId).toBe(legacySource.sourceVersionId);
      expect(currentSource.sha256).toBe(legacySource.sha256);
      expect(versions?.count).toBe(1);
    } finally {
      database.close();
    }
  });

  test("synchronizes the Jobhunter source and exposes its three directives alongside Sample Testing", () => {
    const loaded = loadContextManifest();
    const database = openContextDatabase(":memory:");
    try {
      syncContext(database, loaded);
      const snapshot = createContextSnapshot(database, loaded);
      expect(Object.keys(snapshot.sourceHashes)).toHaveLength(5);
      expect(snapshot.sources.find((source) => source.id === "jobhunter-resume-info")).toMatchObject({
        relativePath: "jobhunter-resume-info.md",
        kind: "authoritative-markdown",
        entityId: "project:jobhunter",
        displayName: "Jobhunter resume information",
        baselineEntityIds: ["Resume Tailoring and Application Agent"],
      });
      expect(snapshot.mustIncludeDirectives
        .filter((directive) => directive.sourceId === "jobhunter-resume-info")
        .map((directive) => directive.text)).toEqual([
        "- Include the **Browser Use** harness.",
        "- Include the **OpenAI Agents SDK**.",
        "- Include the user-reported impact: **saved over 100 hours rewriting resumes and applying to jobs**.",
      ]);
      expect(snapshot.mustIncludeDirectives
        .filter((directive) => directive.sourceId === "automated-testing-resume-info")
        .map((directive) => directive.text)).toEqual([
        "- **Required framing:** Present Sample Testing/System A as an **agentic testing platform/workflow**, not as generic automation.",
      ]);
    } finally {
      database.close();
    }
  });

  test("projects trusted Must Include directives from active authoritative evidence", () => {
    const root = createRepositoryFixture();
    const loaded = loadFixture(root);
    const [baseline, requiredSource, nonmatchingSource, sentinelSource, neutralizedSource] = loaded.manifest.sources;
    const requiredText = "Keep the Jobhunter framing.\n- Preserve exact directive provenance.";
    writeFileSync(join(root, baseline!.relativePath), "## 21. Must Include\nBaseline content is not a directive.\n");
    writeFileSync(join(root, requiredSource!.relativePath), `# Required\n## 21. Must Include\n${requiredText}\n`);
    writeFileSync(join(root, nonmatchingSource!.relativePath), "# Context\n## 22. Must Include\nA nonmatching heading is not a directive.\n");
    writeFileSync(join(root, sentinelSource!.relativePath), "# Context\n## 21. Must Include\nNone specified\n");
    writeFileSync(join(root, neutralizedSource!.relativePath), "# Context\n## 21. Must Include\nNone specified\n");
    const database = openContextDatabase(":memory:");
    try {
      syncContext(database, loaded);
      const snapshot = createContextSnapshot(database, loaded);
      const requiredEvidence = snapshot.evidence.find((block) => block.text === requiredText);
      expect(requiredEvidence).toBeDefined();
      expect(snapshot.mustIncludeDirectives).toEqual([{
        evidenceId: requiredEvidence!.id,
        sourceId: requiredSource!.id,
        entityId: requiredSource!.entityId,
        text: requiredText,
      }]);
      expect(Object.isFrozen(snapshot.mustIncludeDirectives)).toBe(true);
      expect(Object.isFrozen(snapshot.mustIncludeDirectives[0])).toBe(true);
    } finally {
      database.close();
    }
  });

  test("ignores retired source heads outside the current manifest", () => {
    const root = createRepositoryFixture();
    const loaded = loadFixture(root);
    const database = openContextDatabase(":memory:");
    try {
      syncContext(database, loaded);
      database.query(`
        INSERT INTO source_versions
          (id, source_id, relative_path, kind, entity_id, display_name, baseline_entity_ids_json, sha256, byte_count, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "retired-version",
        "retired-source",
        "retired/context.md",
        "authoritative-markdown",
        "project:retired",
        "Retired source",
        "[]",
        sha256("retired source"),
        14,
        1,
      );
      database.query(`
        INSERT INTO evidence_blocks
          (id, source_version_id, source_id, entity_id, ordinal, heading_path_json, text, caveats_json, sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "retired-evidence",
        "retired-version",
        "retired-source",
        "project:retired",
        0,
        JSON.stringify(["21. Must Include"]),
        "Retired requirement.",
        "[]",
        sha256("retired requirement"),
      );
      database.query("INSERT INTO source_heads (source_id, source_version_id) VALUES (?, ?)")
        .run("retired-source", "retired-version");

      const snapshot = createContextSnapshot(database, loaded);
      const manifestSourceIds = loaded.manifest.sources.map((source) => source.id);
      expect(snapshot.sources.map((source) => source.id)).toEqual(manifestSourceIds);
      expect(snapshot.evidence.every((block) => manifestSourceIds.includes(block.sourceId))).toBe(true);
      expect(snapshot.evidence.some((block) => block.id === "retired-evidence")).toBe(false);
      expect(snapshot.mustIncludeDirectives.some((directive) => directive.sourceId === "retired-source")).toBe(false);
    } finally {
      database.close();
    }
  });

  test("keeps directive heading and sentinel matching exact", () => {
    const root = createRepositoryFixture();
    const loaded = loadFixture(root);
    const [, requiredSource, nonmatchingSource, sentinelSource, neutralizedSource] = loaded.manifest.sources;
    writeFileSync(join(root, requiredSource!.relativePath), "# Context\n## Must Include\nUnnumbered requirement.\n## 21. Must Include\nnone specified\n");
    writeFileSync(join(root, nonmatchingSource!.relativePath), "# Context\n## 21. Must Include Extra\nNot a matching heading.\n");
    writeFileSync(join(root, sentinelSource!.relativePath), "# Context\n## Must Include\nNone   specified\n");
    writeFileSync(join(root, neutralizedSource!.relativePath), "# Context\n## 21. Must Include\nNone specified\n");
    const database = openContextDatabase(":memory:");
    try {
      syncContext(database, loaded);
      const snapshot = createContextSnapshot(database, loaded);
      expect(snapshot.mustIncludeDirectives.map(({ sourceId, text }) => ({ sourceId, text }))).toEqual([
        { sourceId: requiredSource!.id, text: "Unnumbered requirement." },
        { sourceId: requiredSource!.id, text: "none specified" },
      ]);
    } finally {
      database.close();
    }
  });

  test("rejects evidence that is not associated with its indexed manifest source", () => {
    const root = createRepositoryFixture();
    const loaded = loadFixture(root);
    const requiredSource = loaded.manifest.sources[1]!;
    writeFileSync(join(root, requiredSource.relativePath), "# Context\n## Must Include\nRequired association.\n");
    const database = openContextDatabase(":memory:");
    try {
      syncContext(database, loaded);
      const snapshot = createContextSnapshot(database, loaded);
      const evidence = snapshot.evidence.find((block) => block.text === "Required association.")!;
      expect(() => extractMustIncludeDirectives(snapshot.sources, [{
        ...evidence,
        sourceVersionId: snapshot.sources[0]!.sourceVersionId,
      }])).toThrow("does not match its indexed source");
      expect(() => extractMustIncludeDirectives(snapshot.sources, [{
        ...evidence,
        sourceId: "not-in-manifest",
      }])).toThrow("does not match its indexed source");
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
