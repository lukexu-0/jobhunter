import type { Database } from "bun:sqlite";
import type {
  ActiveStage,
  AttemptArtifactInput,
  PublicArtifact,
  QueuedInputArtifact,
  RevisionOrigin,
} from "./repository.ts";

interface ArtifactRow {
  id: string; run_id: string; revision: number; attempt_id: string; stage: string; kind: string; sha256: string;
  path: string; byte_size: number; source_artifact_id: string | null; created_at: number;
}

interface AttemptRow {
  id: string;
  run_id: string;
  revision: number;
  stage: ActiveStage;
}

interface RevisionRow {
  origin: RevisionOrigin;
  source_revision: number | null;
  retry_stage: ActiveStage | null;
}

const stageRank: Readonly<Record<ActiveStage, number>> = { analyzing: 1, tailoring: 2, editing: 2, compiling: 3, repairing: 3, deterministic_qa: 4, visual_qa: 5 };

function artifactStageRank(stage: string): number | undefined {
  switch (stage) {
    case "input": return 0;
    case "analyzing": return 1;
    case "tailoring":
    case "editing": return 2;
    case "compiling":
    case "repairing": return 3;
    case "deterministic_qa": return 4;
    case "visual_qa":
    case "review": return 5;
    default: return undefined;
  }
}

function publicArtifact(row: ArtifactRow): PublicArtifact {
  return { id: row.id, revision: row.revision, attemptId: row.attempt_id || null, stage: row.stage, kind: row.kind,
    sha256: row.sha256, path: row.path, byteSize: row.byte_size, createdAt: row.created_at };
}

export class ArtifactPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactPublicationError";
  }
}

export class ArtifactRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  insertInput(runId: string, input: QueuedInputArtifact, id: string, now: number): void {
    this.#db.query("INSERT INTO artifacts(id,run_id,revision,attempt_id,stage,kind,sha256,path,byte_size,created_at) VALUES (?, ?, 1, '', 'input', 'job-description', ?, ?, ?, ?)")
      .run(id, runId, input.sha256, input.path, input.byteSize, now);
  }

  // The caller owns the transaction, claim fencing, IDs, clock, and publication events.
  publish(attempt: AttemptRow, input: AttemptArtifactInput, id: string, now: number): void {
    if (input.stage !== attempt.stage) {
      throw new ArtifactPublicationError("artifact stage does not match its attempt");
    }
    if (input.sourceArtifactId !== undefined) {
      const source = this.#db.query<ArtifactRow, [string]>("SELECT * FROM artifacts WHERE id=?").get(input.sourceArtifactId);
      if (!source) throw new ArtifactPublicationError("artifact not found");
      if (source.run_id !== attempt.run_id) {
        throw new ArtifactPublicationError("artifact source belongs to another run");
      }
    }
    this.#db.query("INSERT INTO artifacts(id,run_id,revision,attempt_id,stage,kind,sha256,path,byte_size,source_artifact_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, attempt.run_id, attempt.revision, attempt.id, attempt.stage, input.kind, input.sha256, input.path, input.byteSize, input.sourceArtifactId ?? null, now);
  }

  getById(runId: string, artifactId: string): PublicArtifact | null {
    const row = this.#db.query<ArtifactRow, [string, string]>(`
      SELECT artifacts.*
      FROM artifacts
      JOIN runs ON runs.id = artifacts.run_id
      WHERE artifacts.run_id=? AND artifacts.id=? AND runs.deleted_at IS NULL
    `).get(runId, artifactId);
    return row ? publicArtifact(row) : null;
  }

  resolve(runId: string, kind: string, revision: number): PublicArtifact | null {
    let current = revision;
    let retryStage: ActiveStage | null = null;
    let retryCutoff: number | null = null;
    const seen = new Set<number>();
    while (!seen.has(current)) {
      seen.add(current);
      const row = this.#db.query<ArtifactRow, [string, number, string]>(`
        SELECT *
        FROM artifacts
        WHERE run_id=? AND revision=? AND kind=?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `).get(runId, current, kind);
      if (row) {
        if (retryCutoff === null) return publicArtifact(row);
        const artifactRank = artifactStageRank(row.stage);
        // Compile/repair outputs can also be the failed stage's next inputs.
        const isRetryInput = (kind === "tailored-tex" && (retryStage === "compiling" || retryStage === "repairing"))
          || (kind === "latex-log" && retryStage === "repairing");
        return artifactRank !== undefined && (artifactRank < retryCutoff || (artifactRank === retryCutoff && isRetryInput))
          ? publicArtifact(row) : null;
      }
      const rev = this.#db.query<RevisionRow, [string, number]>("SELECT * FROM revisions WHERE run_id=? AND revision=?").get(runId, current);
      if (rev?.source_revision == null) break;
      // Each retry fences its ancestors, even when a later retry resumes a later stage.
      if (rev.origin === "retry" && rev.retry_stage !== null) {
        const cutoff = stageRank[rev.retry_stage];
        if (retryCutoff === null || cutoff < retryCutoff) {
          retryStage = rev.retry_stage;
          retryCutoff = cutoff;
        }
      }
      current = rev.source_revision;
    }
    return null;
  }

  list(runId: string, revision: number): PublicArtifact[] {
    return this.#db.query<ArtifactRow, [string, number]>("SELECT * FROM artifacts WHERE run_id=? AND revision=? ORDER BY created_at,id")
      .all(runId, revision).map(publicArtifact);
  }

  listResolved(runId: string, revision: number): PublicArtifact[] {
    const kinds = this.#db.query<{ kind: string }, [string]>(
      "SELECT DISTINCT kind FROM artifacts WHERE run_id=? ORDER BY kind",
    ).all(runId);
    return kinds
      .map(({ kind }) => this.resolve(runId, kind, revision))
      .filter((artifact): artifact is PublicArtifact => artifact !== null);
  }
}
