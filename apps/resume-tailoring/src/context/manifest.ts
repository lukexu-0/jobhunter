import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ContextManifest, ContextSourceDefinition } from "./types.ts";
import { sha256 } from "./sha256.ts";

export const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../..");
export const DEFAULT_CONTEXT_MANIFEST_PATH = resolve(REPOSITORY_ROOT, "apps/resume-tailoring/context-sources.json");

export const CONTEXT_SOURCE_ALLOWLIST = Object.freeze([
  "apps/user-info/resume-main/Alex_Example_Resume.tex",
  "apps/user-info/current-context/jobs/Example-Company/automated-testing-resume-info.md",
  "apps/user-info/current-context/projects/sample-project-archive.md",
  "apps/user-info/current-context/projects/sample-project.md",
] as const);

const ALLOWED: Readonly<Record<string, true>> = Object.freeze({
  "apps/user-info/resume-main/Alex_Example_Resume.tex": true,
  "apps/user-info/current-context/jobs/Example-Company/automated-testing-resume-info.md": true,
  "apps/user-info/current-context/projects/sample-project-archive.md": true,
  "apps/user-info/current-context/projects/sample-project.md": true,
});
const SOURCE_KEYS: Readonly<Record<string, true>> = Object.freeze({
  id: true,
  relativePath: true,
  kind: true,
  entityId: true,
  displayName: true,
  baselineEntityIds: true,
});
const MANIFEST_KEYS: Readonly<Record<string, true>> = Object.freeze({
  version: true,
  sources: true,
  explicitEntityBindings: true,
});

export interface LoadedContextManifest {
  readonly manifest: ContextManifest;
  readonly manifestSha256: string;
  readonly manifestPath: string;
  readonly repositoryRoot: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(value: Record<string, unknown>, allowed: Readonly<Record<string, true>>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed[key]) throw new Error(`${label} contains unknown key: ${key}`);
  for (const key of Object.keys(allowed)) if (!(key in value)) throw new Error(`${label} is missing key: ${key}`);
}

function parseSource(value: unknown, index: number): ContextSourceDefinition {
  if (!isRecord(value)) throw new Error(`sources[${index}] must be an object`);
  requireExactKeys(value, SOURCE_KEYS, `sources[${index}]`);
  const { id, relativePath, entityId, displayName, baselineEntityIds } = value;
  if (typeof id !== "string" || id.length === 0) throw new Error(`sources[${index}].id must be a non-empty string`);
  if (typeof relativePath !== "string" || relativePath.length === 0) throw new Error(`sources[${index}].relativePath must be a non-empty string`);
  if (typeof entityId !== "string" || entityId.length === 0) throw new Error(`sources[${index}].entityId must be a non-empty string`);
  if (typeof displayName !== "string" || displayName.length === 0) throw new Error(`sources[${index}].displayName must be a non-empty string`);
  if (value.kind !== "baseline" && value.kind !== "authoritative-markdown") throw new Error(`sources[${index}].kind is invalid`);
  if (!Array.isArray(baselineEntityIds) || baselineEntityIds.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`sources[${index}].baselineEntityIds must contain strings`);
  }
  const validatedBaselineEntityIds: string[] = [];
  for (const item of baselineEntityIds) {
    if (typeof item !== "string") throw new Error(`sources[${index}].baselineEntityIds must contain strings`);
    validatedBaselineEntityIds.push(item);
  }
  return Object.freeze({
    id,
    relativePath,
    kind: value.kind,
    entityId,
    displayName,
    baselineEntityIds: Object.freeze(validatedBaselineEntityIds),
  });
}

export function loadContextManifest(
  manifestPath = DEFAULT_CONTEXT_MANIFEST_PATH,
  repositoryRoot = REPOSITORY_ROOT,
): LoadedContextManifest {
  const root = realpathSync(repositoryRoot);
  const safeManifestPath = resolveContainedFile(root, manifestPath, "context manifest");
  const raw = readFileSync(safeManifestPath);
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch (error) { throw new Error(`Invalid context manifest JSON: ${String(error)}`); }
  if (!isRecord(parsed)) throw new Error("Context manifest must be an object");
  requireExactKeys(parsed, MANIFEST_KEYS, "context manifest");
  if (parsed.version !== 1) throw new Error("Context manifest version must be 1");
  if (!Array.isArray(parsed.sources)) throw new Error("Context manifest sources must be an array");
  const sources = parsed.sources.map(parseSource);
  if (sources.length !== CONTEXT_SOURCE_ALLOWLIST.length) throw new Error("Context manifest must contain exactly four sources");
  const paths = sources.map((source) => source.relativePath);
  if (new Set(paths).size !== paths.length || paths.some((path) => !ALLOWED[path]) || CONTEXT_SOURCE_ALLOWLIST.some((path) => !paths.includes(path))) {
    throw new Error("Context manifest sources do not match the literal four-file allowlist");
  }
  if (sources.filter((source) => source.kind === "baseline").length !== 1 || sources.find((source) => source.kind === "baseline")?.relativePath !== CONTEXT_SOURCE_ALLOWLIST[0]) {
    throw new Error("Context manifest must identify the canonical resume as its sole baseline");
  }
  const ids = sources.map((source) => source.id);
  if (new Set(ids).size !== ids.length) throw new Error("Context source IDs must be unique");
  if (!isRecord(parsed.explicitEntityBindings)) throw new Error("explicitEntityBindings must map strings to strings");
  const explicitEntityBindings: Record<string, string> = {};
  for (const [key, binding] of Object.entries(parsed.explicitEntityBindings)) {
    if (typeof binding !== "string") throw new Error("explicitEntityBindings must map strings to strings");
    explicitEntityBindings[key] = binding;
  }
  if (explicitEntityBindings["Sample Project"] !== "SampleProject") {
    throw new Error("The Sample Project binding to SampleProject is required");
  }
  const manifest: ContextManifest = Object.freeze({
    version: 1,
    sources: Object.freeze(sources),
    explicitEntityBindings: Object.freeze(explicitEntityBindings),
  });
  return Object.freeze({ manifest, manifestSha256: sha256(raw), manifestPath: safeManifestPath, repositoryRoot: root });
}

export function resolveContextSource(repositoryRoot: string, source: ContextSourceDefinition): string {
  if (!ALLOWED[source.relativePath]) throw new Error(`Context source is not allowlisted: ${source.relativePath}`);
  return resolveContainedFile(realpathSync(repositoryRoot), resolve(repositoryRoot, source.relativePath), `context source ${source.id}`);
}

function resolveContainedFile(root: string, candidate: string, label: string): string {
  if (!isAbsolute(candidate)) candidate = resolve(root, candidate);
  const lexical = resolve(candidate);
  const lexicalRelative = relative(root, lexical);
  if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) throw new Error(`${label} escapes repository root`);
  let cursor = lexical;
  while (cursor !== root) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link`);
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`${label} is outside repository root`);
    cursor = parent;
  }
  const canonical = realpathSync(lexical);
  const canonicalRelative = relative(root, canonical);
  if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) throw new Error(`${label} resolves outside repository root`);
  if (!lstatSync(canonical).isFile()) throw new Error(`${label} must be a regular file`);
  return canonical;
}
