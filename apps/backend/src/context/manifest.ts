import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextManifest, ContextSourceDefinition } from "./types.ts";
import { sha256 } from "./sha256.ts";

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.resolve("@jobhunt/backend/package.json")));
export const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "../..");
export const DEFAULT_CONTEXT_MANIFEST_PATH = resolve(REPOSITORY_ROOT, "apps/backend/context-sources.json");
export const BASELINE_CONTEXT_SOURCE_PATH = ".jobhunt-data/user-info/resume-main/resume.tex";
const USER_INFO_PREFIX = ".jobhunt-data/user-info/";
const MAX_SOURCES = 20;
const MAX_BINDINGS = 40;
const SOURCE_KEYS = Object.freeze({ id: true, relativePath: true, kind: true, entityId: true, displayName: true, baselineEntityIds: true });
const MANIFEST_KEYS = Object.freeze({ version: true, sources: true, explicitEntityBindings: true });

export interface LoadedContextManifest {
  readonly manifest: ContextManifest;
  readonly manifestSha256: string;
  readonly manifestPath: string;
  readonly repositoryRoot: string;
}

function requireExactKeys(value: Record<string, unknown>, allowed: Readonly<Record<string, true>>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed[key]) throw new Error(`${label} contains unknown key: ${key}`);
  for (const key of Object.keys(allowed)) if (!(key in value)) throw new Error(`${label} is missing key: ${key}`);
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maxLength || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} printable characters`);
  }
  return value;
}

function parseSource(value: unknown, index: number): ContextSourceDefinition {
  const label = `sources[${index}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const source = value as Record<string, unknown>;
  requireExactKeys(source, SOURCE_KEYS, label);
  const id = boundedString(source.id, `${label}.id`, 80);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`${label}.id must be a lowercase source ID`);
  const relativePath = boundedString(source.relativePath, `${label}.relativePath`, 256);
  if (!relativePath.startsWith(USER_INFO_PREFIX) || relativePath.includes("\\") || relativePath.split("/").some((part) => part === "" || part === "." || part === "..") || isAbsolute(relativePath)) {
    throw new Error(`${label}.relativePath must remain under ${USER_INFO_PREFIX}`);
  }
  if (source.kind !== "baseline" && source.kind !== "authoritative-markdown") throw new Error(`${label}.kind is invalid`);
  if (source.kind === "baseline" ? relativePath !== BASELINE_CONTEXT_SOURCE_PATH : !relativePath.endsWith(".md")) {
    throw new Error(`${label}.relativePath must be the generic resume baseline or an additional Markdown source`);
  }
  const entityId = boundedString(source.entityId, `${label}.entityId`, 120);
  const displayName = boundedString(source.displayName, `${label}.displayName`, 120);
  if (!Array.isArray(source.baselineEntityIds) || source.baselineEntityIds.length > 20) throw new Error(`${label}.baselineEntityIds must be a bounded array`);
  const baselineEntityIds = source.baselineEntityIds.map((item) => boundedString(item, `${label}.baselineEntityIds item`, 120));
  if (new Set(baselineEntityIds).size !== baselineEntityIds.length) throw new Error(`${label}.baselineEntityIds must be unique`);
  return Object.freeze({ id, relativePath, kind: source.kind, entityId, displayName, baselineEntityIds: Object.freeze(baselineEntityIds) });
}

export function loadContextManifest(
  manifestPath = DEFAULT_CONTEXT_MANIFEST_PATH,
  repositoryRoot = REPOSITORY_ROOT,
): LoadedContextManifest {
  const root = realpathSync(repositoryRoot);
  const safeManifestPath = resolveContainedFile(root, manifestPath, "context manifest");
  if (!safeManifestPath) throw new Error("Context manifest is missing");
  const raw = readFileSync(safeManifestPath);
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch (error) { throw new Error(`Invalid context manifest JSON: ${String(error)}`); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Context manifest must be an object");
  const manifestData = parsed as Record<string, unknown>;
  requireExactKeys(manifestData, MANIFEST_KEYS, "context manifest");
  if (manifestData.version !== 1) throw new Error("Context manifest version must be 1");
  if (!Array.isArray(manifestData.sources) || manifestData.sources.length < 1 || manifestData.sources.length > MAX_SOURCES) throw new Error(`Context manifest must contain 1 to ${MAX_SOURCES} sources`);
  const sources = manifestData.sources.map(parseSource);
  const baseline = sources.filter((source) => source.kind === "baseline");
  if (baseline.length !== 1 || baseline[0]?.id !== "resume-baseline" || baseline[0].entityId !== "candidate-resume" || baseline[0].baselineEntityIds.length !== 0) {
    throw new Error("Context manifest must contain one generic resume-baseline source");
  }
  if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new Error("Context source IDs must be unique");
  if (new Set(sources.map((source) => source.relativePath)).size !== sources.length) throw new Error("Context source paths must be unique");
  if (typeof manifestData.explicitEntityBindings !== "object" || manifestData.explicitEntityBindings === null || Array.isArray(manifestData.explicitEntityBindings) || Object.keys(manifestData.explicitEntityBindings).length > MAX_BINDINGS) throw new Error("explicitEntityBindings must be a bounded map");
  const explicitEntityBindings: Record<string, string> = Object.create(null);
  for (const [key, binding] of Object.entries(manifestData.explicitEntityBindings)) {
    explicitEntityBindings[boundedString(key, "binding key", 120)] = boundedString(binding, "binding value", 120);
  }
  const manifest: ContextManifest = Object.freeze({ version: 1, sources: Object.freeze(sources), explicitEntityBindings: Object.freeze(explicitEntityBindings) });
  return Object.freeze({ manifest, manifestSha256: sha256(raw), manifestPath: safeManifestPath, repositoryRoot: root });
}

export function resolveContextSourceIfPresent(repositoryRoot: string, source: ContextSourceDefinition): string | undefined {
  if (!source.relativePath.startsWith(USER_INFO_PREFIX) || source.relativePath.includes("\\") || source.relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Context source path is invalid: ${source.id}`);
  }
  return resolveContainedFile(realpathSync(repositoryRoot), resolve(repositoryRoot, source.relativePath), `context source ${source.id}`, true);
}

export function resolveContextSource(repositoryRoot: string, source: ContextSourceDefinition): string {
  const path = resolveContextSourceIfPresent(repositoryRoot, source);
  if (!path) throw new Error(`Context source ${source.id} is missing`);
  return path;
}

function resolveContainedFile(root: string, candidate: string, label: string, allowMissing = false): string | undefined {
  const lexical = resolve(isAbsolute(candidate) ? candidate : resolve(root, candidate));
  const lexicalRelative = relative(root, lexical);
  if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) throw new Error(`${label} escapes repository root`);
  let cursor = lexical;
  let missing = false;
  while (cursor !== root) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link`);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") missing = true;
      else throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`${label} is outside repository root`);
    cursor = parent;
  }
  if (missing) return undefined;
  const canonical = realpathSync(lexical);
  const canonicalRelative = relative(root, canonical);
  if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) throw new Error(`${label} resolves outside repository root`);
  if (!lstatSync(canonical).isFile()) throw new Error(`${label} must be a regular file`);
  return canonical;
}
