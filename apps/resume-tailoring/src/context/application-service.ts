import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { ContextRouteService, ContextStatus } from "../api/context-routes.ts";
import type { RunContextSnapshotService } from "../api/run-service.ts";
import type { StageSourceContext } from "../stages/types.ts";
import { openContextDatabase } from "./database.ts";
import {
  loadContextManifest,
  resolveContextSource,
  type LoadedContextManifest,
} from "./manifest.ts";
import {
  checkContextFreshness,
  ContextStaleError,
  createContextSnapshot,
  syncContext as synchronizeContext,
  verifyContextSnapshot,
} from "./service.ts";
import { sha256 } from "./sha256.ts";
import type { ContextSnapshot } from "./types.ts";

export interface ContextApplicationServiceOptions {
  readonly database?: Database;
  readonly loadedManifest?: LoadedContextManifest;
}

export class ContextApplicationService implements ContextRouteService, RunContextSnapshotService {
  readonly #database: Database;
  readonly #loadedManifest: LoadedContextManifest;
  readonly #ownsDatabase: boolean;
  #closed = false;

  constructor(database: Database, loadedManifest: LoadedContextManifest, ownsDatabase = false) {
    this.#database = database;
    this.#loadedManifest = loadedManifest;
    this.#ownsDatabase = ownsDatabase;
  }

  getContext(): ContextStatus {
    this.#requireOpen();
    return checkContextFreshness(this.#database, this.#loadedManifest);
  }

  syncContext(): ContextStatus {
    this.#requireOpen();
    const synchronized = synchronizeContext(this.#database, this.#loadedManifest);
    const freshness = checkContextFreshness(this.#database, this.#loadedManifest);
    return Object.freeze({
      ...freshness,
      manifestSha256: synchronized.manifestSha256,
      indexedAt: synchronized.indexedAt,
      sourceCount: synchronized.sourceCount,
      blockCount: synchronized.blockCount,
      changedSources: synchronized.changedSources,
    });
  }

  createSnapshot(): ContextSnapshot {
    this.#requireOpen();
    const snapshot = createContextSnapshot(this.#database, this.#loadedManifest);
    this.#requireNoDrift(snapshot);
    return snapshot;
  }

  loadStageSourceContext(runId: string): StageSourceContext {
    this.#requireOpen();
    void runId;
    const snapshot = this.createSnapshot();
    const baselineDefinition = this.#loadedManifest.manifest.sources.find((source) => source.kind === "baseline");
    if (!baselineDefinition) throw new Error("Context manifest has no canonical baseline");
    const baselinePath = resolveContextSource(this.#loadedManifest.repositoryRoot, baselineDefinition);
    const baselineBytes = readFileSync(baselinePath);
    if (sha256(baselineBytes) !== snapshot.baselineSha256) {
      throw new Error("Context source drifted while loading the canonical baseline");
    }
    this.#requireNoDrift(snapshot);
    return Object.freeze({ snapshot, baseline: baselineBytes.toString("utf8") });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ownsDatabase) this.#database.close();
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error("Context application service is closed");
  }

  #requireNoDrift(snapshot: ContextSnapshot): void {
    if (!verifyContextSnapshot(snapshot, this.#loadedManifest).valid) {
      throw new ContextStaleError("Context source drift detected; synchronize before continuing");
    }
  }
}

export function createContextApplicationService(
  options: ContextApplicationServiceOptions = {},
): ContextApplicationService {
  const loadedManifest = options.loadedManifest ?? loadContextManifest();
  if (options.database) return new ContextApplicationService(options.database, loadedManifest);
  return new ContextApplicationService(openContextDatabase(), loadedManifest, true);
}
