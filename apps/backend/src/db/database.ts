import { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { migratePipelineDatabase } from "./migrations.ts";

export interface PipelineDatabaseOptions {
  readonly now?: () => number;
  readonly createParent?: boolean;
}

export function openPipelineDatabase(
  path = process.env.JOBHUNT_PIPELINE_DATABASE ?? resolve(import.meta.dir, "../../data/state/pipeline.sqlite"),
  options: PipelineDatabaseOptions = {},
): Database {
  if (path !== ":memory:" && (options.createParent ?? true)) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migratePipelineDatabase(db, (options.now ?? Date.now)());
  return db;
}

export const createPipelineDatabase = openPipelineDatabase;
