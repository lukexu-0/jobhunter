import type { Database } from "bun:sqlite";
import { constants, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmdirSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DEFAULT_ARTIFACT_ROOT, LEGACY_ARTIFACT_ROOT } from "./artifacts.ts";

const HISTORICAL_ARTIFACT_ROOT = resolve(import.meta.dir, "../../../pipeline/data/runs");
const ARTIFACT_UPDATE_TRIGGER = `
CREATE TRIGGER artifacts_no_update BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT, 'artifacts are immutable'); END;
`;

interface RunRow {
  readonly id: string;
  readonly queue_sequence: number;
}

interface ArtifactRow {
  readonly id: string;
  readonly run_id: string;
  readonly path: string;
}

export interface RunOutputMigrationOptions {
  readonly outputRoot?: string;
  readonly legacyRoots?: readonly string[];
}

export interface RunOutputMigrationResult {
  readonly movedRuns: number;
  readonly rewrittenArtifacts: number;
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function requireDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${path}`);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function removeEmptyLegacyRoots(roots: readonly string[]): void {
  for (const root of roots) {
    try {
      rmdirSync(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    }
  }
}

function artifactTarget(
  row: ArtifactRow,
  run: RunRow,
  outputRoot: string,
  legacyRoots: readonly string[],
): string {
  if (!isAbsolute(row.path)) throw new Error(`artifact ${row.id} path must be absolute`);
  const current = resolve(row.path);
  const destinationRunRoot = resolve(outputRoot, String(run.queue_sequence));
  if (contained(destinationRunRoot, current) && current !== destinationRunRoot) return current;

  for (const legacyRoot of legacyRoots) {
    const legacyRunRoot = resolve(legacyRoot, run.id);
    if (!contained(legacyRunRoot, current) || current === legacyRunRoot) continue;
    const suffix = relative(legacyRunRoot, current);
    const target = resolve(destinationRunRoot, suffix);
    if (!contained(destinationRunRoot, target) || target === destinationRunRoot) {
      throw new Error(`artifact ${row.id} path escapes its run output`);
    }
    return target;
  }
  throw new Error(`artifact ${row.id} path is outside known run output roots`);
}

export function migrateRunOutputLayout(
  database: Database,
  options: RunOutputMigrationOptions = {},
): RunOutputMigrationResult {
  const runs = database.query<RunRow, []>("SELECT id, queue_sequence FROM runs ORDER BY queue_sequence").all();
  if (runs.length === 0) return { movedRuns: 0, rewrittenArtifacts: 0 };

  const outputRoot = resolve(options.outputRoot ?? DEFAULT_ARTIFACT_ROOT);
  const legacyRoots = (options.legacyRoots ?? [LEGACY_ARTIFACT_ROOT, HISTORICAL_ARTIFACT_ROOT]).map((root) => resolve(root));
  const sequences = new Set<number>();
  for (const run of runs) {
    if (!Number.isSafeInteger(run.queue_sequence) || run.queue_sequence < 1 || sequences.has(run.queue_sequence)) {
      throw new Error(`run ${run.id} has an invalid output sequence`);
    }
    sequences.add(run.queue_sequence);
  }

  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  requireDirectory(outputRoot, "run output root");
  chmodSync(outputRoot, 0o700);

  let movedRuns = 0;
  for (const run of runs) {
    const destination = resolve(outputRoot, String(run.queue_sequence));
    const sources = legacyRoots
      .map((root) => resolve(root, run.id))
      .filter((source) => existsSync(source));
    if (sources.length > 1) throw new Error(`run ${run.id} exists in multiple legacy output roots`);
    if (sources.length === 0) {
      if (existsSync(destination)) requireDirectory(destination, `run ${run.id} output`);
      continue;
    }
    const source = sources[0]!;
    requireDirectory(source, `legacy run ${run.id} output`);
    if (existsSync(destination)) throw new Error(`run ${run.id} output destination already exists: ${destination}`);
    renameSync(source, destination);
    requireDirectory(destination, `run ${run.id} output`);
    chmodSync(destination, 0o700);
    movedRuns++;
  }
  fsyncDirectory(outputRoot);
  for (const legacyRoot of legacyRoots) {
    if (existsSync(legacyRoot)) {
      requireDirectory(legacyRoot, "legacy run output root");
      fsyncDirectory(legacyRoot);
    }
  }

  const runById = new Map(runs.map((run) => [run.id, run]));
  const rewrites = database.query<ArtifactRow, []>("SELECT id, run_id, path FROM artifacts ORDER BY created_at, id")
    .all()
    .map((artifact) => {
      const run = runById.get(artifact.run_id);
      if (!run) throw new Error(`artifact ${artifact.id} references an unknown run`);
      return { id: artifact.id, current: artifact.path, target: artifactTarget(artifact, run, outputRoot, legacyRoots) };
    })
    .filter((rewrite) => resolve(rewrite.current) !== rewrite.target);

  if (rewrites.length === 0) {
    removeEmptyLegacyRoots(legacyRoots);
    return { movedRuns, rewrittenArtifacts: 0 };
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DROP TRIGGER artifacts_no_update");
    const update = database.query("UPDATE artifacts SET path=? WHERE id=?");
    for (const rewrite of rewrites) update.run(rewrite.target, rewrite.id);
    database.exec(ARTIFACT_UPDATE_TRIGGER);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  removeEmptyLegacyRoots(legacyRoots);
  return { movedRuns, rewrittenArtifacts: rewrites.length };
}
