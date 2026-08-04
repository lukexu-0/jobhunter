import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migratePipelineDatabase, PIPELINE_SCHEMA_VERSION } from "../src/db/migrations.ts";
import { ApplicationSessionSnapshotDtoSchema } from "../src/contracts/index.ts";

const databases: Database[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function addLegacyRunClaimTable(db: Database): void {
  db.exec(`
    CREATE TABLE run_claim (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
      claim_token TEXT,
      expires_at INTEGER,
      CHECK ((run_id IS NULL AND claim_token IS NULL AND expires_at IS NULL) OR
             (run_id IS NOT NULL AND claim_token IS NOT NULL AND expires_at IS NOT NULL))
    ) STRICT;
    INSERT INTO run_claim(id, run_id, claim_token, expires_at)
      VALUES (1, NULL, NULL, NULL);
  `);
}

function versionOneDatabase(options: { readonly includesApplicationStatus?: boolean } = {}): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY${options.includesApplicationStatus ? ",\n      application_status TEXT NOT NULL DEFAULT 'applied'" : ""}
    ) STRICT;
    INSERT INTO runs(id) VALUES ('run-1');
    INSERT INTO schema_migrations(version, applied_at) VALUES (1, 1000);
    PRAGMA user_version = 1;
  `);
  addLegacyRunClaimTable(db);
  return db;
}

function versionTwoDatabase(options: { readonly includesRetentionTable?: boolean } = {}): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      application_status TEXT NOT NULL DEFAULT 'applied'
        CHECK (application_status IN ('applied','rejected','interview','accepted','failed'))
    ) STRICT;
    CREATE TABLE attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE run_source_snapshots (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
      manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
      baseline_sha256 TEXT NOT NULL CHECK (length(baseline_sha256) = 64),
      source_hashes_json TEXT NOT NULL CHECK (json_valid(source_hashes_json)),
      created_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO runs(id) VALUES ('run-1');
    INSERT INTO attempts(id, run_id) VALUES ('attempt-1', 'run-1');
    INSERT INTO events(id, run_id) VALUES (1, 'run-1');
    INSERT INTO artifacts(id, run_id) VALUES ('artifact-1', 'run-1');
    INSERT INTO run_source_snapshots(run_id, manifest_sha256, baseline_sha256, source_hashes_json, created_at)
    VALUES ('run-1', '${"1".repeat(64)}', '${"2".repeat(64)}', '{"source":"${"3".repeat(64)}"}', 1000);
    INSERT INTO schema_migrations(version, applied_at) VALUES (1, 1000), (2, 1500);
    PRAGMA user_version = 2;
  `);
  if (options.includesRetentionTable) {
    db.exec("CREATE TABLE run_artifact_retention (run_id TEXT PRIMARY KEY) STRICT");
  }
  addLegacyRunClaimTable(db);
  return db;
}

function versionSixDatabase(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      job_description TEXT NOT NULL,
      status TEXT NOT NULL,
      current_revision INTEGER NOT NULL DEFAULT 1,
      failed_stage TEXT,
      visual_ack_required INTEGER NOT NULL DEFAULT 0,
      approved_pdf_sha256 TEXT,
      queue_sequence INTEGER NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      application_status TEXT NOT NULL DEFAULT 'applied'
        CHECK (application_status IN ('applied','rejected','interview','accepted','failed')),
      generate_keyword_map INTEGER NOT NULL DEFAULT 0 CHECK (generate_keyword_map IN (0,1))
    ) STRICT;
    CREATE TABLE revisions (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL,
      PRIMARY KEY (run_id, revision)
    ) STRICT;
    CREATE TABLE attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      FOREIGN KEY (run_id, revision) REFERENCES revisions(run_id, revision) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE run_artifact_retention (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
      state TEXT NOT NULL,
      selected_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX runs_fifo ON runs(queue_sequence);
    CREATE INDEX run_artifact_retention_state ON run_artifact_retention(state, selected_at);
    INSERT INTO runs(
      id, job_description, status, queue_sequence, created_at, updated_at,
      application_status, generate_keyword_map
    ) VALUES ('run-6', 'preserved job description', 'review', 9, 1000, 1500, 'interview', 1);
    INSERT INTO revisions(run_id, revision) VALUES ('run-6', 1);
    INSERT INTO attempts(id, run_id, revision) VALUES ('attempt-6', 'run-6', 1);
    INSERT INTO run_artifact_retention(run_id, state, selected_at) VALUES ('run-6', 'pruning', 1750);
    INSERT INTO schema_migrations(version, applied_at)
      VALUES (1, 1000), (2, 1100), (3, 1200), (6, 1300);
    PRAGMA user_version = 6;
  `);
  addLegacyRunClaimTable(db);
  return db;
}
function versionSevenDatabase(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      application_status TEXT NOT NULL DEFAULT 'applied'
        CHECK (application_status IN ('pending','applied','rejected','interview','accepted','failed'))
    ) STRICT;
    INSERT INTO runs(id) VALUES ('existing-run');
    INSERT INTO schema_migrations(version, applied_at)
      VALUES (1, 1000), (2, 1100), (3, 1200), (6, 1300), (7, 1400);
    PRAGMA user_version = 7;
  `);
  addLegacyRunClaimTable(db);
  return db;
}




function versionNineDatabase(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      job_description TEXT NOT NULL,
      status TEXT NOT NULL,
      current_revision INTEGER NOT NULL,
      approved_pdf_sha256 TEXT,
      queue_sequence INTEGER NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      application_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (application_status IN ('pending','applied','rejected','interview','accepted','failed')),
      generate_keyword_map INTEGER NOT NULL DEFAULT 0,
      title_override TEXT,
      organization_override TEXT,
      deleted_at INTEGER
    ) STRICT;
    CREATE TABLE revisions (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL,
      PRIMARY KEY (run_id, revision)
    ) STRICT;
    INSERT INTO runs(
      id, job_description, status, current_revision, approved_pdf_sha256,
      queue_sequence, created_at, updated_at
    ) VALUES (
      'existing-run', 'preserved private description', 'approved', 2,
      '${"a".repeat(64)}', 1, 1000, 1500
    );
    INSERT INTO revisions(run_id, revision) VALUES ('existing-run', 2);
    INSERT INTO schema_migrations(version, applied_at)
      VALUES (1, 1000), (2, 1100), (3, 1200), (6, 1300), (7, 1400), (8, 1500), (9, 1600);
    PRAGMA user_version = 9;
  `);
  addLegacyRunClaimTable(db);
  return db;
}

function versionFourteenDatabase(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      application_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (application_status IN ('pending','applied','rejected','interview','accepted','failed')),
      auto_apply INTEGER NOT NULL DEFAULT 0 CHECK (auto_apply IN (0,1))
    ) STRICT;
    CREATE TABLE run_application_sessions (
      bridge_state TEXT NOT NULL
    ) STRICT;
    INSERT INTO runs(id, auto_apply) VALUES ('automatic-run', 1);
    INSERT INTO schema_migrations(version, applied_at) VALUES (14, 1400);
    PRAGMA user_version = 14;
  `);
  return db;
}

function versionFifteenApplicationDatabase(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      application_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (application_status IN ('pending','applied','rejected','interview','accepted','failed'))
    ) STRICT;
    CREATE TABLE run_application_sessions (
      run_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      resume_revision INTEGER NOT NULL,
      pdf_sha256 TEXT NOT NULL,
      bridge_state TEXT NOT NULL,
      submission_phase TEXT NOT NULL DEFAULT 'not_attempted',
      automatic_review_ready INTEGER NOT NULL DEFAULT 0,
      submission_attempted_at INTEGER,
      submission_confirmed_at INTEGER,
      public_snapshot_json TEXT,
      last_upstream_event_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      terminal_at INTEGER,
      PRIMARY KEY (run_id, generation)
    ) STRICT;
    INSERT INTO run_application_sessions(
      run_id, generation, session_id, resume_revision, pdf_sha256, bridge_state,
      created_at, updated_at, terminal_at
    ) VALUES
      ('active-run', 1, '11111111-1111-4111-8111-111111111111', 1, '${"a".repeat(64)}', 'running', 1000, 1100, NULL),
      ('terminal-run', 1, '22222222-2222-4222-8222-222222222222', 1, '${"b".repeat(64)}', 'failed', 1000, 1200, 1200);
    INSERT INTO schema_migrations(version, applied_at) VALUES (15, 1500);
    PRAGMA user_version = 15;
  `);
  return db;
}

function versionSixteenDatabase(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      application_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (application_status IN ('pending','applied','rejected','interview','accepted','failed'))
    ) STRICT;
    INSERT INTO runs(id) VALUES ('legacy-job');
    INSERT INTO schema_migrations(version, applied_at) VALUES (16, 1600);
    PRAGMA user_version = 16;
  `);
  return db;
}

function versionSeventeenDiscoveryDatabase(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      application_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (application_status IN ('pending','applied','rejected','interview','accepted','failed'))
    ) STRICT;
    INSERT INTO runs(id) VALUES ('legacy-job');
    CREATE TABLE discovery_jobs (
      id TEXT PRIMARY KEY
    ) STRICT;
    CREATE TABLE discovery_sources (
      id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
      kind TEXT NOT NULL CHECK (
        kind IN (
          'simplify','zapply','speedyapply','linkedin','greenhouse','lever','ashby',
          'smartrecruiters','workable','recruitee','personio','workday','job_board'
        )
      ),
      last_sync_at INTEGER,
      last_success_at INTEGER,
      last_sync_status TEXT CHECK (
        last_sync_status IS NULL OR last_sync_status IN ('succeeded','failed')
      ),
      last_error TEXT,
      provenance TEXT
    ) STRICT;
    CREATE TABLE discovery_observations (
      source_id TEXT NOT NULL REFERENCES discovery_sources(id) ON DELETE RESTRICT,
      source_item_id TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES discovery_jobs(id) ON DELETE RESTRICT,
      PRIMARY KEY (source_id, source_item_id)
    ) STRICT;
    CREATE TABLE discovery_dedupe_keys (
      source_id TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES discovery_jobs(id) ON DELETE RESTRICT,
      PRIMARY KEY (source_id, source_item_id, dedupe_key),
      FOREIGN KEY (source_id, source_item_id)
        REFERENCES discovery_observations(source_id, source_item_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE discovery_run_links (
      job_id TEXT PRIMARY KEY REFERENCES discovery_jobs(id) ON DELETE RESTRICT,
      run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
      created_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO discovery_jobs(id) VALUES ('existing-job');
    INSERT INTO discovery_sources(
      id, name, kind, last_sync_at, last_success_at, last_sync_status, last_error, provenance
    ) VALUES (
      'existing-source', 'Existing source', 'greenhouse', 1000, 900, 'failed',
      'bounded failure', 'existing provenance'
    );
    INSERT INTO discovery_observations(source_id, source_item_id, job_id)
    VALUES ('existing-source', 'existing-item', 'existing-job');
    INSERT INTO schema_migrations(version, applied_at) VALUES (17, 1700);
    PRAGMA user_version = 17;
  `);
  return db;
}

function versionEighteenDiscoveryDatabase(): Database {
  const db = versionSeventeenDiscoveryDatabase();
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE discovery_sources_v18 (
      id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
      kind TEXT NOT NULL CHECK (
        kind IN (
          'simplify','zapply','speedyapply','linkedin','indeed','greenhouse','lever','ashby',
          'smartrecruiters','workable','recruitee','personio','workday','job_board'
        )
      ),
      last_sync_at INTEGER,
      last_success_at INTEGER,
      last_sync_status TEXT CHECK (
        last_sync_status IS NULL OR last_sync_status IN ('succeeded','failed')
      ),
      last_error TEXT,
      provenance TEXT
    ) STRICT;
    INSERT INTO discovery_sources_v18(
      id, name, kind, last_sync_at, last_success_at, last_sync_status, last_error, provenance
    )
    SELECT id, name, kind, last_sync_at, last_success_at, last_sync_status, last_error, provenance
    FROM discovery_sources;
    DROP TABLE discovery_sources;
    ALTER TABLE discovery_sources_v18 RENAME TO discovery_sources;
    INSERT INTO discovery_sources(
      id, name, kind, last_sync_at, last_success_at, last_sync_status, provenance
    ) VALUES (
      'indeed-existing', 'Indeed existing', 'indeed', 1800, 1750, 'succeeded',
      'indeed oauth fixture'
    );
    INSERT INTO discovery_observations(source_id, source_item_id, job_id)
    VALUES ('indeed-existing', 'indeed-item', 'existing-job');
    INSERT INTO schema_migrations(version, applied_at) VALUES (18, 1800);
    PRAGMA user_version = 18;
  `);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function versionSeventeenRecruitingEventDatabase(): Database {
  const db = versionSixteenDatabase();
  db.exec(`
    CREATE TABLE recruiting_event_preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      school TEXT,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE recruiting_event_scrape_runs (
      id TEXT PRIMARY KEY,
      trigger TEXT NOT NULL CHECK (trigger IN ('startup','scheduled','manual')),
      state TEXT NOT NULL CHECK (state IN ('running','completed','partial','failed')),
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      preferences_json TEXT NOT NULL CHECK (json_valid(preferences_json)),
      source_count INTEGER NOT NULL CHECK (source_count >= 0),
      succeeded_source_count INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_source_count >= 0),
      failed_source_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_source_count >= 0),
      event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
      CHECK (
        (state = 'running' AND completed_at IS NULL)
        OR (state <> 'running' AND completed_at IS NOT NULL)
      )
    ) STRICT;
    CREATE UNIQUE INDEX recruiting_event_one_running_scrape
      ON recruiting_event_scrape_runs(state)
      WHERE state = 'running';
    CREATE INDEX recruiting_event_scrape_runs_started
      ON recruiting_event_scrape_runs(started_at DESC);
    CREATE TABLE recruiting_event_source_attempts (
      run_id TEXT NOT NULL REFERENCES recruiting_event_scrape_runs(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_url TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('succeeded','failed')),
      parser TEXT NOT NULL CHECK (parser IN ('deterministic','llm','none')),
      event_count INTEGER NOT NULL CHECK (event_count >= 0),
      issue_code TEXT,
      issue_message TEXT,
      completed_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, source_id),
      CHECK (
        (state = 'succeeded' AND issue_code IS NULL AND issue_message IS NULL)
        OR (state = 'failed' AND parser = 'none' AND issue_code IS NOT NULL AND issue_message IS NOT NULL)
      )
    ) STRICT;
    CREATE TABLE recruiting_events (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      organizer TEXT NOT NULL,
      start_at INTEGER NOT NULL,
      end_at INTEGER,
      timezone TEXT,
      location TEXT,
      attendance TEXT NOT NULL CHECK (attendance IN ('virtual','in_person','hybrid','unknown')),
      registration_url TEXT NOT NULL,
      description TEXT,
      eligibility_summary TEXT,
      matched_for_applicant INTEGER NOT NULL CHECK (matched_for_applicant IN (0,1)),
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_scrape_run_id TEXT NOT NULL REFERENCES recruiting_event_scrape_runs(id) ON DELETE RESTRICT
    ) STRICT;
    CREATE INDEX recruiting_events_upcoming
      ON recruiting_events(start_at, title);
    CREATE TABLE recruiting_event_sources (
      event_id TEXT NOT NULL REFERENCES recruiting_events(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (event_id, source_id)
    ) STRICT;
    INSERT INTO recruiting_event_preferences(id, school, updated_at)
    VALUES (1, 'State University', 1100);
    INSERT INTO recruiting_event_scrape_runs(
      id, trigger, state, started_at, completed_at, preferences_json, source_count,
      succeeded_source_count, failed_source_count, event_count
    ) VALUES (
      'scrape-17', 'manual', 'completed', 1200, 1300, '{"school":"State University"}',
      1, 1, 0, 1
    );
    INSERT INTO recruiting_event_source_attempts(
      run_id, source_id, source_name, source_url, state, parser, event_count,
      issue_code, issue_message, completed_at
    ) VALUES (
      'scrape-17', 'source-17', 'Career fair source', 'https://events.example/source',
      'succeeded', 'deterministic', 1, NULL, NULL, 1280
    );
    INSERT INTO recruiting_events(
      id, fingerprint, title, organizer, start_at, end_at, timezone, location,
      attendance, registration_url, description, eligibility_summary,
      matched_for_applicant, first_seen_at, last_seen_at, last_scrape_run_id
    ) VALUES (
      'event-17', 'fingerprint-17', 'Engineering Career Fair', 'State University',
      3000, 3600, 'America/New_York', 'Student Center', 'hybrid',
      'https://events.example/register', 'Meet engineering employers.',
      'Open to enrolled students', 1, 1250, 1280, 'scrape-17'
    );
    INSERT INTO recruiting_event_sources(
      event_id, source_id, source_url, first_seen_at, last_seen_at
    ) VALUES (
      'event-17', 'source-17', 'https://events.example/source', 1250, 1280
    );
    INSERT INTO schema_migrations(version, applied_at) VALUES (17, 1700);
    PRAGMA user_version = 17;
    PRAGMA foreign_keys = ON;
  `);
  return db;
}

function versionSeventeenOpportunityDatabase(): Database {
  const db = versionSixteenDatabase();
  db.exec(`
    ALTER TABLE runs
    ADD COLUMN opportunity_kind TEXT NOT NULL DEFAULT 'job'
      CHECK (opportunity_kind IN ('job','hackathon','competition','event'));
    UPDATE runs SET opportunity_kind = 'hackathon' WHERE id = 'legacy-job';
    INSERT INTO schema_migrations(version, applied_at) VALUES (17, 1700);
    PRAGMA user_version = 17;
  `);
  return db;
}
const SUBMISSION_UNCERTAIN_WARNING =
  "The application submission could not be verified. Check the headed browser if it is still available, then close this session.";

function versionTenDatabase(): Database {
  const db = versionNineDatabase();
  db.exec(`
    ALTER TABLE runs ADD COLUMN job_url TEXT
      CHECK (job_url IS NULL OR length(job_url) BETWEEN 1 AND 2048);
    CREATE TABLE run_application_sessions (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
      generation INTEGER NOT NULL CHECK (generation > 0),
      session_id TEXT NOT NULL UNIQUE,
      resume_revision INTEGER NOT NULL CHECK (resume_revision > 0),
      pdf_sha256 TEXT NOT NULL CHECK (length(pdf_sha256) = 64),
      bridge_state TEXT NOT NULL CHECK (
        bridge_state IN (
          'reserved','starting','running','awaiting_human_navigation',
          'awaiting_origin_approval','awaiting_additional_info',
          'awaiting_human_review','ready_for_human_submit',
          'cancelled','failed','closed','lost'
        )
      ),
      public_snapshot_json TEXT CHECK (
        public_snapshot_json IS NULL OR json_valid(public_snapshot_json)
      ),
      last_upstream_event_id INTEGER CHECK (
        last_upstream_event_id IS NULL OR last_upstream_event_id >= 0
      ),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      terminal_at INTEGER,
      PRIMARY KEY (run_id, generation),
      FOREIGN KEY (run_id, resume_revision)
        REFERENCES revisions(run_id, revision) ON DELETE RESTRICT,
      CHECK (
        (bridge_state IN ('cancelled','failed','closed','lost') AND terminal_at IS NOT NULL)
        OR
        (bridge_state NOT IN ('cancelled','failed','closed','lost') AND terminal_at IS NULL)
      )
    ) STRICT;
    CREATE INDEX run_application_sessions_latest
      ON run_application_sessions(run_id, generation DESC);
    CREATE TRIGGER run_application_sessions_no_delete
    BEFORE DELETE ON run_application_sessions
    BEGIN
      SELECT RAISE(ABORT, 'application session history cannot be deleted');
    END;
    INSERT INTO schema_migrations(version, applied_at) VALUES (10, 2000);
    PRAGMA user_version = 10;
  `);
  return db;
}

function versionElevenDatabase(): Database {
  const db = versionTenDatabase();
  db.exec(`
    INSERT INTO schema_migrations(version, applied_at) VALUES (11, 2500);
    PRAGMA user_version = 11;
  `);
  return db;
}

test("migration twelve preserves the live claim and adds four unique empty claim slots", () => {
  const db = versionElevenDatabase();
  const token = "a".repeat(43);
  db.query(
    "UPDATE run_claim SET run_id='existing-run', claim_token=?, expires_at=90000 WHERE id=1",
  ).run(token);

  migratePipelineDatabase(db, 3_000);

  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(PIPELINE_SCHEMA_VERSION);
  expect(db.query<{ version: number }, []>(
    "SELECT version FROM schema_migrations ORDER BY version",
  ).all().map(({ version }) => version)).toEqual([1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  expect(db.query<{
    id: number;
    run_id: string | null;
    claim_token: string | null;
    expires_at: number | null;
  }, []>("SELECT id,run_id,claim_token,expires_at FROM run_claim ORDER BY id").all()).toEqual([
    { id: 1, run_id: "existing-run", claim_token: token, expires_at: 90_000 },
    { id: 2, run_id: null, claim_token: null, expires_at: null },
    { id: 3, run_id: null, claim_token: null, expires_at: null },
    { id: 4, run_id: null, claim_token: null, expires_at: null },
    { id: 5, run_id: null, claim_token: null, expires_at: null },
  ]);

  expect(() => db.query(
    "UPDATE run_claim SET run_id='existing-run', claim_token=?, expires_at=90001 WHERE id=2",
  ).run("b".repeat(43))).toThrow(/unique/i);
  db.query(`
    INSERT INTO runs(
      id, job_description, status, current_revision, queue_sequence, created_at, updated_at
    ) VALUES ('second-run', 'second', 'queued', 1, 2, 3000, 3000)
  `).run();
  expect(() => db.query(
    "UPDATE run_claim SET run_id='second-run', claim_token=?, expires_at=90002 WHERE id=2",
  ).run(token)).toThrow(/unique/i);
  expect(() => db.query(
    "INSERT INTO run_claim(id, run_id, claim_token, expires_at) VALUES (6, NULL, NULL, NULL)",
  ).run()).toThrow(/check/i);
});

function legacySnapshot(
  generation: number,
  bridgeState: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    generation,
    bridgeState,
    harnessState: bridgeState === "lost" || bridgeState === "reserved" ? null : bridgeState,
    createdAt: 1_000,
    updatedAt: 1_500,
    terminalAt: ["cancelled", "failed", "closed", "lost"].includes(bridgeState) ? 1_500 : null,
    expiresAt: bridgeState === "reserved" ? null : 9_000,
    company: "Example",
    role: "Engineer",
    fieldsFilled: [],
    fieldsNeedingHuman: [],
    filesAttached: ["resume.pdf"],
    warnings: [],
    revisionCount: 1,
    pendingAction: null,
    error: bridgeState === "failed"
      ? { code: "browser_failed", message: "The browser session failed" }
      : null,
    ...overrides,
  };
}

test("migration eleven rewrites every legacy application snapshot into a strict durable projection", () => {
  const db = versionTenDatabase();
  const insert = db.query(`
    INSERT INTO run_application_sessions(
      run_id, generation, session_id, resume_revision, pdf_sha256, bridge_state,
      public_snapshot_json, last_upstream_event_id, created_at, updated_at, terminal_at
    ) VALUES ('existing-run', ?, ?, 2, ?, ?, ?, ?, 1000, ?, ?)
  `);
  insert.run(
    1,
    "11111111-1111-4111-8111-111111111111",
    "a".repeat(64),
    "running",
    JSON.stringify(legacySnapshot(1, "running")),
    1,
    1_500,
    null,
  );
  const warningInputs = [
    ...Array.from({ length: 101 }, (_, index) => `warning ${index + 1}`),
    SUBMISSION_UNCERTAIN_WARNING,
    SUBMISSION_UNCERTAIN_WARNING,
  ];
  insert.run(
    2,
    "22222222-2222-4222-8222-222222222222",
    "a".repeat(64),
    "ready_for_human_submit",
    JSON.stringify(legacySnapshot(2, "ready_for_human_submit", {
      warnings: warningInputs,
      pendingAction: { type: "human_review" },
      error: { code: "browser_failed", message: "The browser session failed" },
    })),
    2,
    1_500,
    null,
  );
  insert.run(
    3,
    "33333333-3333-4333-8333-333333333333",
    "a".repeat(64),
    "failed",
    JSON.stringify(legacySnapshot(3, "failed")),
    3,
    1_500,
    1_500,
  );
  insert.run(
    4,
    "44444444-4444-4444-8444-444444444444",
    "a".repeat(64),
    "closed",
    null,
    4,
    1_500,
    1_500,
  );

  migratePipelineDatabase(db, 5_000);

  const rows = db.query<{
    generation: number;
    bridge_state: string;
    submission_phase: string;
    submission_attempted_at: number | null;
    submission_confirmed_at: number | null;
    public_snapshot_json: string | null;
    updated_at: number;
  }, []>(`
    SELECT generation, bridge_state, submission_phase, submission_attempted_at,
           submission_confirmed_at, public_snapshot_json, updated_at
    FROM run_application_sessions
    ORDER BY generation
  `).all();
  expect(rows.map((row) => ({
    generation: row.generation,
    bridgeState: row.bridge_state,
    phase: row.submission_phase,
    attemptedAt: row.submission_attempted_at,
    confirmedAt: row.submission_confirmed_at,
  }))).toEqual([
    { generation: 1, bridgeState: "running", phase: "not_attempted", attemptedAt: null, confirmedAt: null },
    { generation: 2, bridgeState: "submission_uncertain", phase: "uncertain", attemptedAt: 1_500, confirmedAt: null },
    { generation: 3, bridgeState: "failed", phase: "not_attempted", attemptedAt: null, confirmedAt: null },
    { generation: 4, bridgeState: "closed", phase: "not_attempted", attemptedAt: null, confirmedAt: null },
  ]);
  const projections = rows.map((row) => row.public_snapshot_json === null
    ? null
    : ApplicationSessionSnapshotDtoSchema.parse(JSON.parse(row.public_snapshot_json)));
  expect(projections[0]?.submissionPhase).toBe("not_attempted");
  expect(projections[2]?.submissionPhase).toBe("not_attempted");
  expect(projections[3]).toBeNull();
  expect(projections[1]).toMatchObject({
    bridgeState: "submission_uncertain",
    harnessState: "submission_uncertain",
    submissionPhase: "uncertain",
    pendingAction: null,
    terminalAt: null,
    error: null,
    expiresAt: 9_000,
    company: "Example",
    role: "Engineer",
  });
  expect(projections[1]?.updatedAt).toBeGreaterThan(1_500);
  expect(rows[1]?.updated_at).toBe(projections[1]?.updatedAt);
  expect(projections[1]?.warnings).toHaveLength(100);
  expect(projections[1]?.warnings.slice(0, 99)).toEqual(warningInputs.slice(0, 99));
  expect(projections[1]?.warnings.at(-1)).toBe(SUBMISSION_UNCERTAIN_WARNING);
  expect(projections[1]?.warnings.filter((warning) => warning === SUBMISSION_UNCERTAIN_WARNING)).toHaveLength(1);
});

test("migration eleven enforces phase timestamps and recreates ledger schema objects", () => {
  const db = versionTenDatabase();
  migratePipelineDatabase(db, 5_000);
  const tableSql = db.query<{ sql: string }, []>(`
    SELECT sql FROM sqlite_schema
    WHERE type = 'table' AND name = 'run_application_sessions'
  `).get()?.sql ?? "";
  expect(tableSql).toContain("'not_attempted','attempting','submitted','uncertain'");
  expect(tableSql).toContain("'submitting'");
  expect(tableSql).toContain("'submitted'");
  expect(tableSql).toContain("'submission_uncertain'");
  expect(tableSql).not.toContain("'ready_for_human_submit'");
  expect(db.query<{ type: string; tbl_name: string; sql: string }, []>(`
    SELECT type, tbl_name, sql
    FROM sqlite_schema
    WHERE name = 'run_application_sessions_latest'
  `).get()).toMatchObject({
    type: "index",
    tbl_name: "run_application_sessions",
    sql: expect.stringContaining("generation DESC"),
  });
  expect(db.query<{ type: string; tbl_name: string; sql: string }, []>(`
    SELECT type, tbl_name, sql
    FROM sqlite_schema
    WHERE name = 'run_application_sessions_no_delete'
  `).get()).toMatchObject({
    type: "trigger",
    tbl_name: "run_application_sessions",
    sql: expect.stringContaining("application session history cannot be deleted"),
  });

  const insert = db.query(`
    INSERT INTO run_application_sessions(
      run_id, generation, session_id, resume_revision, pdf_sha256, bridge_state,
      submission_phase, submission_attempted_at, submission_confirmed_at,
      public_snapshot_json, last_upstream_event_id, created_at, updated_at, terminal_at
    ) VALUES ('existing-run', ?, ?, 2, ?, ?, ?, ?, ?, NULL, NULL, 5000, 5000, NULL)
  `);
  const sessionId = (generation: number) =>
    `00000000-0000-4000-8000-${String(generation).padStart(12, "0")}`;
  for (const [generation, phase, attemptedAt, confirmedAt] of [
    [1, "not_attempted", 5_000, null],
    [2, "attempting", null, null],
    [3, "submitted", 5_000, null],
    [4, "uncertain", 5_000, 5_000],
  ] as const) {
    expect(() => insert.run(
      generation,
      sessionId(generation),
      "a".repeat(64),
      "running",
      phase,
      attemptedAt,
      confirmedAt,
    )).toThrow();
  }
  expect(() => insert.run(
    5,
    sessionId(5),
    "a".repeat(64),
    "ready_for_human_submit",
    "not_attempted",
    null,
    null,
  )).toThrow();
  for (const [generation, bridgeState, phase, attemptedAt, confirmedAt] of [
    [6, "submitting", "attempting", 5_000, null],
    [7, "submitted", "submitted", 5_000, 5_001],
    [8, "submission_uncertain", "uncertain", 5_000, null],
  ] as const) {
    insert.run(
      generation,
      sessionId(generation),
      "a".repeat(64),
      bridgeState,
      phase,
      attemptedAt,
      confirmedAt,
    );
  }
  expect(() => db.query(
    "DELETE FROM run_application_sessions WHERE generation = 6",
  ).run()).toThrow(/history/i);
});

test("migration ten preserves version nine runs and creates the durable application ledger", () => {
  const db = versionNineDatabase();

  migratePipelineDatabase(db, 2_000);

  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(PIPELINE_SCHEMA_VERSION);
  expect(db.query<{ name: string; required: number; dflt_value: string }, []>(
    "SELECT name, \"notnull\" AS required, dflt_value FROM pragma_table_info('run_application_sessions') WHERE name = 'automatic_review_ready'",
  ).get()).toEqual({
    name: "automatic_review_ready",
    required: 1,
    dflt_value: "0",
  });
  expect(db.query<{ job_url: string | null }, []>(
    "SELECT job_url FROM runs WHERE id = 'existing-run'",
  ).get()).toEqual({ job_url: null });
  expect(db.query<{ version: number; applied_at: number }, []>(
    "SELECT version, applied_at FROM schema_migrations WHERE version = 10",
  ).get()).toEqual({ version: 10, applied_at: 2_000 });
  expect(db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'run_application_sessions_latest'",
  ).get()?.name).toBe("run_application_sessions_latest");

  db.query(`
    INSERT INTO run_application_sessions(
      run_id, generation, session_id, resume_revision, pdf_sha256, bridge_state,
      public_snapshot_json, last_upstream_event_id, created_at, updated_at, terminal_at
    ) VALUES (?, 1, ?, 2, ?, 'reserved', NULL, NULL, 2000, 2000, NULL)
  `).run("existing-run", "11111111-1111-4111-8111-111111111111", "a".repeat(64));

  const insertSession = db.query(`
    INSERT INTO run_application_sessions(
      run_id, generation, session_id, resume_revision, pdf_sha256, bridge_state,
      public_snapshot_json, last_upstream_event_id, created_at, updated_at, terminal_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  expect(() => insertSession.run(
    "existing-run", 2, "11111111-1111-4111-8111-111111111111", 2,
    "a".repeat(64), "running", "{}", 0, 2000, 2000, null,
  )).toThrow();
  expect(() => insertSession.run(
    "existing-run", 2, "not-a-uuid", 2,
    "a".repeat(64), "running", "{}", 0, 2000, 2000, null,
  )).toThrow();
  expect(() => insertSession.run(
    "existing-run", 2, "22222222-2222-4222-8222-222222222222", 3,
    "a".repeat(64), "running", "{}", 0, 2000, 2000, null,
  )).toThrow();
  expect(() => insertSession.run(
    "existing-run", 2, "22222222-2222-4222-8222-222222222222", 2,
    "short", "running", "{}", 0, 2000, 2000, null,
  )).toThrow();
  expect(() => insertSession.run(
    "existing-run", 2, "22222222-2222-4222-8222-222222222222", 2,
    "a".repeat(64), "running", "{", 0, 2000, 2000, null,
  )).toThrow();
  expect(() => insertSession.run(
    "existing-run", 2, "22222222-2222-4222-8222-222222222222", 2,
    "a".repeat(64), "running", "{}", -1, 2000, 2000, null,
  )).toThrow();
  expect(() => insertSession.run(
    "existing-run", 2, "22222222-2222-4222-8222-222222222222", 2,
    "a".repeat(64), "running", "{}", 0, 2000, 2000, 2000,
  )).toThrow();
  expect(() => insertSession.run(
    "existing-run", 2, "22222222-2222-4222-8222-222222222222", 2,
    "a".repeat(64), "failed", "{}", 0, 2000, 2000, null,
  )).toThrow();
  expect(() => db.query(
    "DELETE FROM run_application_sessions WHERE run_id = 'existing-run' AND generation = 1",
  ).run()).toThrow(/history/i);
  expect(db.query<{ table: string }, []>("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("fresh databases default to pending while accepting lifecycle statuses", () => {
  const db = new Database(":memory:");
  databases.push(db);

  migratePipelineDatabase(db, 2_000);
  db.exec(`
    INSERT INTO runs(
      id, job_description, status, application_status, queue_sequence, created_at, updated_at
    ) VALUES ('applied-run', 'applied job description', 'queued', 'applied', 1, 2000, 2000);
    INSERT INTO runs(
      id, job_description, status, queue_sequence, created_at, updated_at
    ) VALUES ('default-run', 'default job description', 'queued', 2, 2000, 2000);
    INSERT INTO runs(
      id, job_description, status, application_status, queue_sequence, created_at, updated_at
    ) VALUES ('did-not-apply-run', 'did not apply job description', 'queued', 'did_not_apply', 3, 2000, 2000);
    INSERT INTO runs(
      id, job_description, status, application_status, queue_sequence, created_at, updated_at
    ) VALUES ('waiting-for-review-run', 'waiting for review job description', 'queued', 'waiting_for_review', 4, 2000, 2000);
    INSERT INTO runs(
      id, job_description, status, application_status, queue_sequence, created_at, updated_at
    ) VALUES ('oa-received-run', 'OA received job description', 'queued', 'oa_received', 5, 2000, 2000);
    INSERT INTO runs(
      id, job_description, status, application_status, queue_sequence, created_at, updated_at
    ) VALUES ('oa-completed-run', 'OA completed job description', 'queued', 'oa_completed', 6, 2000, 2000);
  `);

  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(PIPELINE_SCHEMA_VERSION);
  expect(db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'discovery_jobs'",
  ).get()).toEqual({ name: "discovery_jobs" });
  expect(db.query<{ application_status: string }, []>(
    "SELECT application_status FROM runs ORDER BY queue_sequence",
  ).all()).toEqual([
    { application_status: "applied" },
    { application_status: "pending" },
    { application_status: "did_not_apply" },
    { application_status: "waiting_for_review" },
    { application_status: "oa_received" },
    { application_status: "oa_completed" },
  ]);
  expect(db.query<{
    title_override: string | null;
    organization_override: string | null;
    deleted_at: number | null;
    auto_submit: number;
    skip_review: number;
  }, []>(
    "SELECT title_override, organization_override, deleted_at, auto_submit, skip_review FROM runs WHERE id = 'default-run'",
  ).get()).toEqual({
    title_override: null,
    organization_override: null,
    deleted_at: null,
    auto_submit: 0,
    skip_review: 0,
  });
  expect(() => db.query(
    "UPDATE runs SET application_status = 'queued' WHERE id = 'default-run'",
  ).run()).toThrow();
  expect(() => db.query(
    "UPDATE runs SET auto_submit = 2 WHERE id = 'default-run'",
  ).run()).toThrow();
  expect(() => db.query(
    "UPDATE runs SET skip_review = 2 WHERE id = 'default-run'",
  ).run()).toThrow();
});

test("migration fifteen preserves automatic submission values and defaults skip review", () => {
  const db = versionFourteenDatabase();

  migratePipelineDatabase(db, 2_000);
  db.exec("INSERT INTO runs(id) VALUES ('default-run')");

  expect(db.query<{
    id: string;
    auto_submit: number;
    skip_review: number;
  }, []>(
    "SELECT id, auto_submit, skip_review FROM runs ORDER BY id",
  ).all()).toEqual([
    { id: "automatic-run", auto_submit: 1, skip_review: 0 },
    { id: "default-run", auto_submit: 0, skip_review: 0 },
  ]);
  expect(db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('runs') WHERE name = 'auto_apply'",
  ).get()).toBeNull();
  expect(db.query<{ version: number; applied_at: number }, []>(
    "SELECT version, applied_at FROM schema_migrations WHERE version = 15",
  ).get()).toEqual({ version: 15, applied_at: 2_000 });
});

test("migration sixteen preserves physical application slot ownership", () => {
  const db = versionFifteenApplicationDatabase();

  migratePipelineDatabase(db, 2_000);

  expect(db.query<{
    run_id: string;
    slot_released: number;
  }, []>(
    "SELECT run_id, slot_released FROM run_application_sessions ORDER BY run_id",
  ).all()).toEqual([
    { run_id: "active-run", slot_released: 0 },
    { run_id: "terminal-run", slot_released: 1 },
  ]);
  expect(db.query<{ version: number; applied_at: number }, []>(
    "SELECT version, applied_at FROM schema_migrations WHERE version = 16",
  ).get()).toEqual({ version: 16, applied_at: 2_000 });
  expect(db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'run_application_sessions_unreleased_slot'",
  ).get()).toEqual({ name: "run_application_sessions_unreleased_slot" });
  expect(() => db.query(
    "UPDATE run_application_sessions SET slot_released = 2 WHERE run_id = 'active-run'",
  ).run()).toThrow();
});

test("migration seventeen adds the normalized discovery catalog to version sixteen databases", () => {
  const db = versionSixteenDatabase();

  migratePipelineDatabase(db, 2_000);

  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version)
    .toBe(PIPELINE_SCHEMA_VERSION);
  expect(db.query<{ version: number; applied_at: number }, []>(
    "SELECT version, applied_at FROM schema_migrations WHERE version = 17",
  ).get()).toEqual({ version: 17, applied_at: 2_000 });
  expect(db.query<{ name: string }, []>(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name LIKE 'discovery_%'
    ORDER BY name
  `).all().map((row) => row.name)).toEqual([
    "discovery_dedupe_keys",
    "discovery_jobs",
    "discovery_observations",
    "discovery_run_links",
    "discovery_sources",
  ]);
  expect(() => db.query(
    "INSERT INTO discovery_sources(id, name, kind) VALUES ('unknown', 'Unknown', 'unknown')",
  ).run()).toThrow();
});

test("migration eighteen adds Indeed while preserving version seventeen sources and foreign keys", () => {
  const db = versionSeventeenDiscoveryDatabase();

  migratePipelineDatabase(db, 2_000);

  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version)
    .toBe(PIPELINE_SCHEMA_VERSION);
  expect(db.query<{ version: number; applied_at: number }, []>(
    "SELECT version, applied_at FROM schema_migrations ORDER BY version",
  ).all()).toEqual([
    { version: 17, applied_at: 1_700 },
    { version: 18, applied_at: 2_000 },
    { version: 19, applied_at: 2_000 },
    { version: 20, applied_at: 2_000 },
    { version: 21, applied_at: 2_000 },
  ]);
  expect(db.query<{
    id: string;
    name: string;
    kind: string;
    last_sync_at: number;
    last_success_at: number;
    last_sync_status: string;
    last_error: string;
    provenance: string;
  }, []>("SELECT * FROM discovery_sources WHERE id = 'existing-source'").get()).toEqual({
    id: "existing-source",
    name: "Existing source",
    kind: "greenhouse",
    last_sync_at: 1_000,
    last_success_at: 900,
    last_sync_status: "failed",
    last_error: "bounded failure",
    provenance: "existing provenance",
  });
  expect(db.query<{ source_id: string; source_item_id: string; job_id: string }, []>(
    "SELECT * FROM discovery_observations",
  ).all()).toEqual([{
    source_id: "existing-source",
    source_item_id: "existing-item",
    job_id: "existing-job",
  }]);
  expect(db.query<{ table: string }, []>("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() => db.query("DELETE FROM discovery_sources WHERE id = 'existing-source'").run()).toThrow();
  db.query("INSERT INTO discovery_sources(id, name, kind) VALUES (?, ?, ?)")
    .run("indeed-internships", "Indeed internships", "indeed");
  expect(db.query<{ kind: string }, [string]>(
    "SELECT kind FROM discovery_sources WHERE id = ?",
  ).get("indeed-internships")).toEqual({ kind: "indeed" });
  expect(() => db.query(
    "INSERT INTO discovery_sources(id, name, kind) VALUES ('unknown', 'Unknown', 'unknown')",
  ).run()).toThrow();
});

test("combined migrations preserve a populated recruiting-event version seventeen database", () => {
  const db = versionSeventeenRecruitingEventDatabase();

  migratePipelineDatabase(db, 2_000);

  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version)
    .toBe(PIPELINE_SCHEMA_VERSION);
  expect(db.query<{ version: number; applied_at: number }, []>(
    "SELECT version, applied_at FROM schema_migrations ORDER BY version",
  ).all()).toEqual([
    { version: 16, applied_at: 1_600 },
    { version: 17, applied_at: 1_700 },
    { version: 18, applied_at: 2_000 },
    { version: 19, applied_at: 2_000 },
    { version: 20, applied_at: 2_000 },
    { version: 21, applied_at: 2_000 },
  ]);
  expect(db.query<{ id: number; school: string; updated_at: number }, []>(
    "SELECT id, school, updated_at FROM recruiting_event_preferences",
  ).all()).toEqual([{ id: 1, school: "State University", updated_at: 1_100 }]);
  expect(db.query<{
    id: string;
    trigger: string;
    state: string;
    started_at: number;
    completed_at: number;
    preferences_json: string;
    source_count: number;
    succeeded_source_count: number;
    failed_source_count: number;
    event_count: number;
  }, []>("SELECT * FROM recruiting_event_scrape_runs").all()).toEqual([{
    id: "scrape-17",
    trigger: "manual",
    state: "completed",
    started_at: 1_200,
    completed_at: 1_300,
    preferences_json: '{"school":"State University"}',
    source_count: 1,
    succeeded_source_count: 1,
    failed_source_count: 0,
    event_count: 1,
  }]);
  expect(db.query<{
    run_id: string;
    source_id: string;
    source_name: string;
    source_url: string;
    state: string;
    parser: string;
    event_count: number;
    issue_code: null;
    issue_message: null;
    completed_at: number;
  }, []>("SELECT * FROM recruiting_event_source_attempts").all()).toEqual([{
    run_id: "scrape-17",
    source_id: "source-17",
    source_name: "Career fair source",
    source_url: "https://events.example/source",
    state: "succeeded",
    parser: "deterministic",
    event_count: 1,
    issue_code: null,
    issue_message: null,
    completed_at: 1_280,
  }]);
  expect(db.query<{
    id: string;
    fingerprint: string;
    title: string;
    organizer: string;
    start_at: number;
    end_at: number;
    timezone: string;
    location: string;
    attendance: string;
    registration_url: string;
    description: string;
    eligibility_summary: string;
    matched_for_applicant: number;
    first_seen_at: number;
    last_seen_at: number;
    last_scrape_run_id: string;
  }, []>("SELECT * FROM recruiting_events").all()).toEqual([{
    id: "event-17",
    fingerprint: "fingerprint-17",
    title: "Engineering Career Fair",
    organizer: "State University",
    start_at: 3_000,
    end_at: 3_600,
    timezone: "America/New_York",
    location: "Student Center",
    attendance: "hybrid",
    registration_url: "https://events.example/register",
    description: "Meet engineering employers.",
    eligibility_summary: "Open to enrolled students",
    matched_for_applicant: 1,
    first_seen_at: 1_250,
    last_seen_at: 1_280,
    last_scrape_run_id: "scrape-17",
  }]);
  expect(db.query<{
    event_id: string;
    source_id: string;
    source_url: string;
    first_seen_at: number;
    last_seen_at: number;
  }, []>("SELECT * FROM recruiting_event_sources").all()).toEqual([{
    event_id: "event-17",
    source_id: "source-17",
    source_url: "https://events.example/source",
    first_seen_at: 1_250,
    last_seen_at: 1_280,
  }]);
  expect(db.query<{ name: string }, []>(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'index'
      AND name IN (
        'recruiting_event_one_running_scrape',
        'recruiting_event_scrape_runs_started',
        'recruiting_events_upcoming'
      )
    ORDER BY name
  `).all().map(({ name }) => name)).toEqual([
    "recruiting_event_one_running_scrape",
    "recruiting_event_scrape_runs_started",
    "recruiting_events_upcoming",
  ]);
  expect(db.query<{ table: string }, []>("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() => db.query(
    "DELETE FROM recruiting_event_scrape_runs WHERE id = 'scrape-17'",
  ).run()).toThrow();

  expect(db.query<{ name: string }, []>(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table'
      AND name IN (
        'discovery_jobs',
        'discovery_sources',
        'discovery_observations',
        'discovery_dedupe_keys',
        'discovery_run_links'
      )
    ORDER BY name
  `).all().map(({ name }) => name)).toEqual([
    "discovery_dedupe_keys",
    "discovery_jobs",
    "discovery_observations",
    "discovery_run_links",
    "discovery_sources",
  ]);
  expect(db.query<{ name: string }, []>(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'index'
      AND name IN (
        'discovery_jobs_recency',
        'discovery_jobs_role_recency',
        'discovery_observations_job',
        'discovery_dedupe_keys_key',
        'discovery_dedupe_keys_job'
      )
    ORDER BY name
  `).all().map(({ name }) => name)).toEqual([
    "discovery_dedupe_keys_job",
    "discovery_dedupe_keys_key",
    "discovery_jobs_recency",
    "discovery_jobs_role_recency",
    "discovery_observations_job",
  ]);
  db.query("INSERT INTO discovery_sources(id, name, kind) VALUES (?, ?, ?)")
    .run("indeed-after-events", "Indeed after events", "indeed");
  expect(() => db.query(
    "INSERT INTO discovery_sources(id, name, kind) VALUES ('unknown', 'Unknown', 'unknown')",
  ).run()).toThrow();

  expect(db.query<{ opportunity_kind: string }, []>(
    "SELECT opportunity_kind FROM runs WHERE id = 'legacy-job'",
  ).get()).toEqual({ opportunity_kind: "job" });
  db.exec("INSERT INTO runs(id, opportunity_kind) VALUES ('event-run', 'event')");
  expect(() => db.query(
    "UPDATE runs SET opportunity_kind = 'grant' WHERE id = 'event-run'",
  ).run()).toThrow();
});

test("combined migrations preserve a populated Indeed discovery version eighteen database", () => {
  const db = versionEighteenDiscoveryDatabase();

  migratePipelineDatabase(db, 2_000);

  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version)
    .toBe(PIPELINE_SCHEMA_VERSION);
  expect(db.query<{ version: number; applied_at: number }, []>(
    "SELECT version, applied_at FROM schema_migrations ORDER BY version",
  ).all()).toEqual([
    { version: 17, applied_at: 1_700 },
    { version: 18, applied_at: 1_800 },
    { version: 19, applied_at: 2_000 },
    { version: 20, applied_at: 2_000 },
    { version: 21, applied_at: 2_000 },
  ]);
  expect(db.query<{
    id: string;
    name: string;
    kind: string;
    last_sync_at: number;
    last_success_at: number;
    last_sync_status: string;
    last_error: string | null;
    provenance: string;
  }, []>("SELECT * FROM discovery_sources ORDER BY id").all()).toEqual([
    {
      id: "existing-source",
      name: "Existing source",
      kind: "greenhouse",
      last_sync_at: 1_000,
      last_success_at: 900,
      last_sync_status: "failed",
      last_error: "bounded failure",
      provenance: "existing provenance",
    },
    {
      id: "indeed-existing",
      name: "Indeed existing",
      kind: "indeed",
      last_sync_at: 1_800,
      last_success_at: 1_750,
      last_sync_status: "succeeded",
      last_error: null,
      provenance: "indeed oauth fixture",
    },
  ]);
  expect(db.query<{ source_id: string; source_item_id: string; job_id: string }, []>(
    "SELECT source_id, source_item_id, job_id FROM discovery_observations ORDER BY source_id",
  ).all()).toEqual([
    {
      source_id: "existing-source",
      source_item_id: "existing-item",
      job_id: "existing-job",
    },
    {
      source_id: "indeed-existing",
      source_item_id: "indeed-item",
      job_id: "existing-job",
    },
  ]);
  expect(db.query<{ table: string }, []>("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() => db.query(
    "DELETE FROM discovery_sources WHERE id = 'indeed-existing'",
  ).run()).toThrow();
  db.query("INSERT INTO discovery_sources(id, name, kind) VALUES (?, ?, ?)")
    .run("indeed-after-v18", "Indeed after v18", "indeed");
  expect(() => db.query(
    "INSERT INTO discovery_sources(id, name, kind) VALUES ('unknown', 'Unknown', 'unknown')",
  ).run()).toThrow();

  expect(db.query<{ name: string }, []>(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table'
      AND name IN (
        'recruiting_event_preferences',
        'recruiting_event_scrape_runs',
        'recruiting_event_source_attempts',
        'recruiting_events',
        'recruiting_event_sources'
      )
    ORDER BY name
  `).all().map(({ name }) => name)).toEqual([
    "recruiting_event_preferences",
    "recruiting_event_scrape_runs",
    "recruiting_event_source_attempts",
    "recruiting_event_sources",
    "recruiting_events",
  ]);
  expect(db.query<{ id: number; school: null; updated_at: number }, []>(
    "SELECT id, school, updated_at FROM recruiting_event_preferences",
  ).all()).toEqual([{ id: 1, school: null, updated_at: 0 }]);
  expect(db.query<{ name: string }, []>(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'index'
      AND name IN (
        'recruiting_event_one_running_scrape',
        'recruiting_event_scrape_runs_started',
        'recruiting_events_upcoming'
      )
    ORDER BY name
  `).all().map(({ name }) => name)).toEqual([
    "recruiting_event_one_running_scrape",
    "recruiting_event_scrape_runs_started",
    "recruiting_events_upcoming",
  ]);

  expect(db.query<{ opportunity_kind: string }, []>(
    "SELECT opportunity_kind FROM runs WHERE id = 'legacy-job'",
  ).get()).toEqual({ opportunity_kind: "job" });
  db.exec("INSERT INTO runs(id, opportunity_kind) VALUES ('competition-run', 'competition')");
  expect(() => db.query(
    "UPDATE runs SET opportunity_kind = 'grant' WHERE id = 'competition-run'",
  ).run()).toThrow();
});

test("migration twenty classifies legacy runs as jobs and constrains opportunity kinds", () => {
  const db = versionSixteenDatabase();

  migratePipelineDatabase(db, 2_000);
  db.exec("INSERT INTO runs(id, opportunity_kind) VALUES ('new-event', 'event')");

  expect(db.query<{ id: string; opportunity_kind: string }, []>(
    "SELECT id, opportunity_kind FROM runs ORDER BY id",
  ).all()).toEqual([
    { id: "legacy-job", opportunity_kind: "job" },
    { id: "new-event", opportunity_kind: "event" },
  ]);
  expect(db.query<{ version: number; applied_at: number }, []>(
    "SELECT version, applied_at FROM schema_migrations WHERE version = 20",
  ).get()).toEqual({ version: 20, applied_at: 2_000 });
  expect(() => db.query(
    "UPDATE runs SET opportunity_kind = 'grant' WHERE id = 'legacy-job'",
  ).run()).toThrow();
});

test("combined migrations preserve a version seventeen opportunity database", () => {
  const db = versionSeventeenOpportunityDatabase();

  migratePipelineDatabase(db, 2_000);

  expect(db.query<{ opportunity_kind: string }, []>(
    "SELECT opportunity_kind FROM runs WHERE id = 'legacy-job'",
  ).get()).toEqual({ opportunity_kind: "hackathon" });
  expect(db.query<{ count: number }, []>(`
    SELECT count(*) AS count
    FROM sqlite_schema
    WHERE type = 'table' AND name LIKE 'discovery_%'
  `).get()).toEqual({ count: 5 });
  expect(db.query<{ count: number }, []>(`
    SELECT count(*) AS count
    FROM sqlite_schema
    WHERE type = 'table' AND name LIKE 'recruiting_event_%'
  `).get()).toEqual({ count: 5 });
  expect(db.query<{ version: number; applied_at: number }, []>(
    "SELECT version, applied_at FROM schema_migrations ORDER BY version",
  ).all()).toEqual([
    { version: 16, applied_at: 1_600 },
    { version: 17, applied_at: 1_700 },
    { version: 18, applied_at: 2_000 },
    { version: 19, applied_at: 2_000 },
    { version: 20, applied_at: 2_000 },
    { version: 21, applied_at: 2_000 },
  ]);
});

test("migrates version seven defaults without changing existing statuses", () => {
  const db = versionSevenDatabase();

  migratePipelineDatabase(db, 2_000);
  db.exec("INSERT INTO runs(id) VALUES ('new-run')");

  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(PIPELINE_SCHEMA_VERSION);
  expect(db.query<{ version: number }, []>(
    "SELECT version FROM schema_migrations ORDER BY version",
  ).all().map(({ version }) => version)).toEqual([1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  expect(db.query<{ id: string; application_status: string }, []>(
    "SELECT id, application_status FROM runs ORDER BY id",
  ).all()).toEqual([
    { id: "existing-run", application_status: "applied" },
    { id: "new-run", application_status: "pending" },
  ]);
});

test("migrates version six runs without breaking data, foreign keys, indexes, or history", () => {
  const db = versionSixDatabase();

  migratePipelineDatabase(db, 2_000);

  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(PIPELINE_SCHEMA_VERSION);
  expect(db.query<{ version: number; applied_at: number }, []>(
    "SELECT version, applied_at FROM schema_migrations ORDER BY version",
  ).all()).toEqual([
    { version: 1, applied_at: 1000 },
    { version: 2, applied_at: 1100 },
    { version: 3, applied_at: 1200 },
    { version: 6, applied_at: 1300 },
    { version: 7, applied_at: 2000 },
    { version: 8, applied_at: 2000 },
    { version: 9, applied_at: 2000 },
    { version: 10, applied_at: 2000 },
    { version: 11, applied_at: 2000 },
    { version: 12, applied_at: 2000 },
    { version: 13, applied_at: 2000 },
    { version: 14, applied_at: 2000 },
    { version: 15, applied_at: 2000 },
    { version: 16, applied_at: 2000 },
    { version: 17, applied_at: 2000 },
    { version: 18, applied_at: 2000 },
    { version: 19, applied_at: 2000 },
    { version: 20, applied_at: 2000 },
    { version: 21, applied_at: 2000 },
  ]);
  expect(db.query<{
    id: string;
    application_status: string;
    generate_keyword_map: number;
  }, []>(
    "SELECT id, application_status, generate_keyword_map FROM runs",
  ).get()).toEqual({
    id: "run-6",
    application_status: "interview",
    generate_keyword_map: 1,
  });
  expect(db.query<{ id: string }, []>("SELECT id FROM attempts").all()).toEqual([{ id: "attempt-6" }]);
  expect(db.query<{ run_id: string }, []>("SELECT run_id FROM run_artifact_retention").all()).toEqual([
    { run_id: "run-6" },
  ]);
  expect(db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'runs_fifo'",
  ).get()?.name).toBe("runs_fifo");
  expect(db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'run_artifact_retention_state'",
  ).get()?.name).toBe("run_artifact_retention_state");
  expect(db.query<{ table: string }, []>("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);

  db.query("UPDATE runs SET application_status = 'pending' WHERE id = 'run-6'").run();
  expect(db.query<{ application_status: string }, []>(
    "SELECT application_status FROM runs WHERE id = 'run-6'",
  ).get()?.application_status).toBe("pending");
  expect(() => db.query(
    "UPDATE runs SET application_status = 'queued' WHERE id = 'run-6'",
  ).run()).toThrow();
});


test("migrates existing runs to application status applied atomically", () => {
  const migrated = versionOneDatabase();

  migratePipelineDatabase(migrated, 2_000);

  expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(PIPELINE_SCHEMA_VERSION);
  expect(migrated.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version)).toEqual([1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  expect(migrated.query<{
    application_status: string;
    generate_keyword_map: number;
    auto_submit: number;
    skip_review: number;
    title_override: string | null;
    organization_override: string | null;
    deleted_at: number | null;
  }, []>(
    "SELECT application_status, generate_keyword_map, auto_submit, skip_review, title_override, organization_override, deleted_at FROM runs WHERE id = 'run-1'",
  ).get()).toEqual({
    application_status: "applied",
    generate_keyword_map: 0,
    auto_submit: 0,
    skip_review: 0,
    title_override: null,
    organization_override: null,
    deleted_at: null,
  });

  const rolledBack = versionOneDatabase({ includesApplicationStatus: true });

  expect(() => migratePipelineDatabase(rolledBack, 2_000)).toThrow(/duplicate column name: application_status/i);
  expect(rolledBack.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(1);
  expect(rolledBack.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version)).toEqual([1]);
});

test("migrates version two retention state atomically without changing history", () => {
  const migrated = versionTwoDatabase();

  migratePipelineDatabase(migrated, 2_000);

  expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(PIPELINE_SCHEMA_VERSION);
  expect(migrated.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version)).toEqual([1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  expect(migrated.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_artifact_retention'").get()?.name).toBe("run_artifact_retention");
  expect(migrated.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'run_artifact_retention_state'").get()?.name).toBe("run_artifact_retention_state");
  expect(migrated.query<{ id: string }, []>("SELECT id FROM runs").all()).toEqual([{ id: "run-1" }]);
  expect(migrated.query<{ id: string }, []>("SELECT id FROM attempts").all()).toEqual([{ id: "attempt-1" }]);
  expect(migrated.query<{ id: number }, []>("SELECT id FROM events").all()).toEqual([{ id: 1 }]);
  expect(migrated.query<{ id: string }, []>("SELECT id FROM artifacts").all()).toEqual([{ id: "artifact-1" }]);
  expect(migrated.query<{ run_id: string }, []>("SELECT run_id FROM run_source_snapshots").all()).toEqual([{ run_id: "run-1" }]);

  const rolledBack = versionTwoDatabase({ includesRetentionTable: true });

  expect(() => migratePipelineDatabase(rolledBack, 2_000)).toThrow(/run_artifact_retention/i);
  expect(rolledBack.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
  expect(rolledBack.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map(({ version }) => version)).toEqual([1, 2]);
  expect(rolledBack.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'run_artifact_retention_state'").get()).toBeNull();
  expect(rolledBack.query<{ id: string }, []>("SELECT id FROM runs").all()).toEqual([{ id: "run-1" }]);
});
