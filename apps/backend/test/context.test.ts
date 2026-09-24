import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createContextRoutes } from "../src/api/context-routes.ts";
import { createContextApplicationService } from "../src/context/application-service.ts";
import { openContextDatabase } from "../src/context/database.ts";
import { loadContextManifest, REPOSITORY_ROOT } from "../src/context/manifest.ts";

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "context-generic-")));
  roots.push(root);
  const manifestPath = join(root, "apps/backend/context-sources.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  copyFileSync(join(REPOSITORY_ROOT, "apps/backend/context-sources.json"), manifestPath);
  return { root, manifestPath };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("empty checkout reports the missing generic resume and sync guides setup instead of failing internally", async () => {
  const { root, manifestPath } = fixture();
  const database = openContextDatabase(":memory:");
  const service = createContextApplicationService({ database, loadedManifest: loadContextManifest(manifestPath, root) });
  const route = createContextRoutes(service);
  const base = "http://localhost:3457";
  try {
    const status = await route(new Request(`${base}/v1/context`), new URL(`${base}/v1/context`));
    expect(status?.status).toBe(200);
    expect(await status?.json()).toEqual({ fresh: false, manifestMatches: false, staleSources: [], missingSources: ["resume-baseline"] });
    const url = new URL(`${base}/v1/context/sync`);
    const response = await route(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), url);
    expect(response?.status).toBe(409);
    const body = await response?.json();
    expect(body?.error?.code).toBe("CONTEXT_SOURCES_MISSING");
    expect(body?.error?.message).toContain(".jobhunt-data/user-info/resume-main/resume.tex");
    const baselinePath = join(root, ".jobhunt-data/user-info/resume-main/resume.tex");
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, "Synthetic candidate resume.");
    const ready = await route(new Request(`${base}/v1/context`), new URL(`${base}/v1/context`));
    expect(await ready?.json()).toMatchObject({ fresh: false, staleSources: ["resume-baseline"], missingSources: [] });
    const synchronized = await route(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), url);
    expect(synchronized?.status).toBe(200);
  } finally { service.close(); database.close(); }
});

test("user-editable additional sources index with their declared entity and do not reuse evidence after metadata changes", () => {
  const { root, manifestPath } = fixture();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.sources.push({ id: "portfolio-notes", relativePath: ".jobhunt-data/user-info/notes/portfolio.md", kind: "authoritative-markdown", entityId: "project:portfolio", displayName: "Portfolio", baselineEntityIds: ["Portfolio"] });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  for (const [relativePath, text] of [[".jobhunt-data/user-info/resume-main/resume.tex", "Synthetic resume."], [".jobhunt-data/user-info/notes/portfolio.md", "# Portfolio\nImplemented a sample project."]] as const) {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true });
    writeFileSync(join(root, relativePath), text);
  }
  const database = openContextDatabase(":memory:");
  try {
    const first = createContextApplicationService({ database, loadedManifest: loadContextManifest(manifestPath, root) });
    first.syncContext();
    expect(first.createSnapshot().evidence.find((block) => block.sourceId === "portfolio-notes")?.entityId).toBe("project:portfolio");
    manifest.sources[1].entityId = "project:revised";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(first.getContext().fresh).toBe(false);
    first.syncContext();
    expect(first.createSnapshot().evidence.find((block) => block.sourceId === "portfolio-notes")?.entityId).toBe("project:revised");
  } finally { database.close(); }
});

test("rejects escaping manifest paths and symlinked user sources", () => {
  const { root, manifestPath } = fixture();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.sources.push({ id: "outside", relativePath: ".jobhunt-data/user-info/../outside.md", kind: "authoritative-markdown", entityId: "project:outside", displayName: "Outside", baselineEntityIds: [] });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  expect(() => loadContextManifest(manifestPath, root)).toThrow(/relativePath/);
  manifest.sources.pop();
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const source = join(root, ".jobhunt-data/user-info/resume-main/resume.tex");
  mkdirSync(dirname(source), { recursive: true });
  symlinkSync(manifestPath, source);
  const database = openContextDatabase(":memory:");
  const service = createContextApplicationService({ database, loadedManifest: loadContextManifest(manifestPath, root) });
  try {
    expect(() => service.getContext()).toThrow(/symbolic link/);
    expect(() => service.syncContext()).toThrow(/symbolic link/);
    rmSync(source);
    rmSync(dirname(source), { recursive: true });
    symlinkSync(join(root, "apps/backend"), dirname(source));
    expect(() => service.getContext()).toThrow(/symbolic link/);
  } finally { service.close(); database.close(); }
});

test("upgrades a prior context index without losing referenced source versions", () => {
  const { root, manifestPath } = fixture();
  const source = join(root, ".jobhunt-data/user-info/resume-main/resume.tex");
  mkdirSync(dirname(source), { recursive: true });
  const text = "Example candidate resume.";
  writeFileSync(source, text);
  const hash = createHash("sha256").update(text).digest("hex");
  const path = join(root, "context.sqlite");
  const previous = new Database(path);
  previous.exec(`CREATE TABLE source_versions (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, relative_path TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, display_name TEXT NOT NULL, baseline_entity_ids_json TEXT NOT NULL, sha256 TEXT NOT NULL, byte_count INTEGER NOT NULL, indexed_at INTEGER NOT NULL, UNIQUE(source_id, sha256)) STRICT; CREATE TABLE source_heads (source_id TEXT PRIMARY KEY, source_version_id TEXT NOT NULL REFERENCES source_versions(id)) STRICT; CREATE TRIGGER source_versions_no_delete BEFORE DELETE ON source_versions BEGIN SELECT RAISE(ABORT, 'source_versions are immutable'); END;`);
  previous.query("INSERT INTO source_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("old", "resume-baseline", ".jobhunt-data/user-info/resume-main/resume.tex", "baseline", "candidate-resume", "Old label", "[]", hash, Buffer.byteLength(text), 1);
  previous.query("INSERT INTO source_heads VALUES (?, ?)").run("resume-baseline", "old");
  previous.close();
  const database = openContextDatabase(path);
  try {
    const service = createContextApplicationService({ database, loadedManifest: loadContextManifest(manifestPath, root) });
    service.syncContext();
    expect(service.createSnapshot().sources[0]?.displayName).toBe("Resume baseline");
    expect(database.query<{ id: string }, []>("SELECT id FROM source_versions WHERE id = 'old'").get()?.id).toBe("old");
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => database.query("DELETE FROM source_versions WHERE id = 'old'").run()).toThrow(/immutable/);
  } finally { database.close(); }
});
