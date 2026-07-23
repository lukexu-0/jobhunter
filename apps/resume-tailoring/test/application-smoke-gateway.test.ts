import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createApplicationSmokeSubmissionGuardFactory,
  resolveApplicationSmokeDatabasePath,
} from "../scripts/application-smoke-gateway.ts";
import { openPipelineDatabase } from "../src/db/database.ts";
import { PipelineRepository } from "../src/db/repository.ts";

const databases: Database[] = [];
const temporaryDirectories: string[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { force: true, recursive: true });
  }
});

describe("application smoke submission ledger", () => {
  test("uses the production repository claim and finalization invariants", async () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    const repository = new PipelineRepository(database);
    const createGuard = createApplicationSmokeSubmissionGuardFactory(repository);
    const sessionId = "11111111-1111-4111-8111-111111111111";

    const firstGuard = createGuard(sessionId);
    expect(database.query<{
      bridge_state: string;
      submission_phase: string;
    }, [string]>(`
      SELECT bridge_state, submission_phase
      FROM run_application_sessions
      WHERE session_id = ?
    `).get(sessionId)).toEqual({
      bridge_state: "awaiting_human_review",
      submission_phase: "not_attempted",
    });
    await firstGuard.claim();
    expect(database.query<{
      bridge_state: string;
      submission_phase: string;
    }, [string]>(`
      SELECT bridge_state, submission_phase
      FROM run_application_sessions
      WHERE session_id = ?
    `).get(sessionId)).toEqual({
      bridge_state: "awaiting_human_review",
      submission_phase: "attempting",
    });

    await expect(createGuard(sessionId).claim()).rejects.toThrow("already claimed");
    await firstGuard.finalize("submitted");

    expect(database.query<{
      submission_phase: string;
      application_status: string;
    }, [string]>(`
      SELECT s.submission_phase, r.application_status
      FROM run_application_sessions AS s
      JOIN runs AS r ON r.id = s.run_id
      WHERE s.session_id = ?
    `).get(sessionId)).toEqual({
      submission_phase: "submitted",
      application_status: "applied",
    });
  });

  test("requires a real database file inside the system temporary directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "jobhunter-application-smoke-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "pipeline.sqlite");

    expect(resolveApplicationSmokeDatabasePath(databasePath)).toBe(resolve(databasePath));
    expect(() => resolveApplicationSmokeDatabasePath(":memory:"))
      .toThrow("temporary SQLite file");
    expect(() => resolveApplicationSmokeDatabasePath(
      resolve(import.meta.dir, "../data/state/pipeline.sqlite"),
    )).toThrow("system temporary directory");

    const target = join(directory, "target.sqlite");
    const link = join(directory, "linked.sqlite");
    writeFileSync(target, "");
    symlinkSync(target, link);
    expect(() => resolveApplicationSmokeDatabasePath(link))
      .toThrow("symbolic link");

    const danglingLink = join(directory, "dangling.sqlite");
    symlinkSync(join(directory, "missing.sqlite"), danglingLink);
    expect(() => resolveApplicationSmokeDatabasePath(danglingLink))
      .toThrow("symbolic link");
  });
});
