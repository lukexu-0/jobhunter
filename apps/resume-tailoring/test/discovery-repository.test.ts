import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { DiscoveryListRequestSchema } from "../src/contracts/index.ts";
import { openPipelineDatabase } from "../src/db/database.ts";
import { classifyDiscoveryRole } from "../src/discovery/classification.ts";
import { parsePostedAt } from "../src/discovery/connectors/normalize.ts";
import { discoveryDedupeKeys, normalizeDiscoveryUrl } from "../src/discovery/normalize.ts";
import { DiscoveryRepository } from "../src/discovery/repository.ts";
import type { DiscoveredJobInput } from "../src/discovery/types.ts";

const databases: Database[] = [];
const DESCRIPTION = "Build reliable production software with careful testing, ownership, collaboration, and measurable customer impact.";

function item(overrides: Partial<DiscoveredJobInput> = {}): DiscoveredJobInput {
  return {
    sourceItemId: "item-1",
    sourceUrl: "https://board.example.test/jobs/123?utm_source=feed",
    canonicalUrl: "https://board.example.test/jobs/123?utm_source=feed",
    applyUrl: "https://board.example.test/jobs/123/apply?gclid=secret",
    title: "Software Engineering Intern",
    company: "Example, Inc.",
    location: "Toronto, ON",
    description: DESCRIPTION,
    ...overrides,
  };
}

function source(id: string, name: string, items: readonly DiscoveredJobInput[], completeSnapshot = true) {
  return { id, name, kind: "simplify" as const, items, completeSnapshot };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("discovery normalization and role classification", () => {
  test("removes tracking parameters, fragments, and unstable parameter order", () => {
    expect(normalizeDiscoveryUrl(
      "https://Jobs.Example.test/opening/?z=2&utm_medium=email&a=1&gclid=x#apply",
    )).toBe("https://jobs.example.test/opening?a=1&z=2");
  });

  test("canonicalizes a trailing DNS dot without changing query normalization", () => {
    const dotted = "https://Jobs.Example.test./opening/?z=2&utm_medium=email&a=1#apply";
    const plain = "https://jobs.example.test/opening?a=1&z=2";
    expect(normalizeDiscoveryUrl(dotted)).toBe(plain);
    expect(discoveryDedupeKeys(item({ canonicalUrl: dotted, applyUrl: dotted })))
      .toEqual(discoveryDedupeKeys(item({ canonicalUrl: plain, applyUrl: plain })));
  });

  test("does not infer ATS identities from lookalike hostnames", () => {
    const lookalikes = [
      ["lever", "https://evillever.co/acme/job-1"],
      ["ashby", "https://evilashbyhq.com/acme/job-1"],
      ["smartrecruiters", "https://evilsmartrecruiters.com/acme/job-1"],
      ["workday", "https://evilmyworkdayjobs.com/acme/job-1"],
    ] as const;

    for (const [kind, url] of lookalikes) {
      const keys = discoveryDedupeKeys(item({ canonicalUrl: url, applyUrl: url }));
      expect(keys.some((key) => key.startsWith(`${kind}:`))).toBe(false);
    }
  });

  test("keeps safe dedupe keys when an ATS path has malformed percent encoding", () => {
    const keys = discoveryDedupeKeys(item({
      canonicalUrl: "https://jobs.lever.co/acme/%E0%A4%A",
      applyUrl: "https://jobs.lever.co/acme/%E0%A4%A",
      postedAt: Date.parse("2026-08-03T00:00:00Z"),
    }));

    expect(keys.some((key) => key.startsWith("url:"))).toBe(true);
    expect(keys.some((key) => key.startsWith("fallback:"))).toBe(true);
    expect(keys.some((key) => key.startsWith("lever:"))).toBe(false);
  });

  test("rejects absolute and relative dates before the Unix epoch", () => {
    expect(parsePostedAt("1960-01-01T00:00:00Z")).toBeNull();
    expect(parsePostedAt("999999999 months ago")).toBeNull();
  });

  test("prioritizes machine learning over generic software and classifies role families", () => {
    expect(classifyDiscoveryRole("Machine Learning Software Engineer Intern")).toBe("machine_learning");
    expect(classifyDiscoveryRole("Cybersecurity Analyst Intern")).toBe("security");
    expect(classifyDiscoveryRole("Data Science Intern")).toBe("data");
    expect(classifyDiscoveryRole("Technical Product Manager Intern")).toBe("product");
    expect(classifyDiscoveryRole("Embedded Hardware Intern")).toBe("hardware");
    expect(classifyDiscoveryRole("Backend Developer Intern")).toBe("software_engineering");
    expect(classifyDiscoveryRole("Legal Intern")).toBe("other");
  });
});

describe("discovery source reconciliation", () => {
  test("deduplicates cross-source observations and retains every source name", () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    let nextId = 0;
    const repository = new DiscoveryRepository(database, {
      now: () => 1_000,
      idFactory: () => `job-${++nextId}`,
    });

    repository.reconcileSource(source("source-a", "Alpha", [item()]));
    repository.reconcileSource(source("source-b", "Beta", [item({
      sourceItemId: "different-id",
      canonicalUrl: "https://board.example.test/jobs/123?utm_campaign=other",
      applyUrl: "https://board.example.test/jobs/123/apply?source=other",
    })]));

    const listed = repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null }));
    expect(listed.total).toBe(1);
    expect(listed.jobs[0]?.sourceNames).toEqual(["Alpha", "Beta"]);
    expect(database.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM discovery_observations",
    ).get()?.count).toBe(2);
    repository.reconcileSource(source("source-a", "Alpha", []));
    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null })).jobs[0]?.status)
      .toBe("open");
  });

  test("does not treat gh_jid on unrelated custom hosts as a shared Greenhouse tenant", () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    let nextId = 0;
    const repository = new DiscoveryRepository(database, {
      now: () => 1_000,
      idFactory: () => `job-${++nextId}`,
    });

    repository.reconcileSource(source("source-a", "Alpha", [item({
      canonicalUrl: "https://careers.alpha.test/jobs/opening?gh_jid=123",
      applyUrl: "https://careers.alpha.test/jobs/opening?gh_jid=123",
    })]));
    repository.reconcileSource(source("source-b", "Beta", [item({
      sourceItemId: "item-2",
      canonicalUrl: "https://careers.beta.test/jobs/opening?gh_jid=123",
      applyUrl: "https://careers.beta.test/jobs/opening?gh_jid=123",
    })]));

    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null })).total).toBe(2);
  });

  test("replaces changed observation aliases while preserving source identity and active dedupe", () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    let now = 1_000;
    let nextId = 0;
    const repository = new DiscoveryRepository(database, {
      now: () => now,
      idFactory: () => `job-${++nextId}`,
    });
    const oldPosting = {
      canonicalUrl: "https://old.example.test/jobs/intern-1",
      applyUrl: "https://old.example.test/jobs/intern-1/apply",
      requisitionId: "OLD-1",
    } as const;
    const newPosting = {
      canonicalUrl: "https://new.example.test/jobs/intern-2",
      applyUrl: "https://new.example.test/jobs/intern-2/apply",
      requisitionId: "NEW-2",
    } as const;

    repository.reconcileSource(source("source-a", "Alpha", [item({
      sourceItemId: "alpha-item",
      ...oldPosting,
    })]));
    const alphaJobId = database.query<{ job_id: string }, []>(`
      SELECT job_id FROM discovery_observations
      WHERE source_id = 'source-a' AND source_item_id = 'alpha-item'
    `).get()!.job_id;

    now = 2_000;
    repository.reconcileSource(source("source-a", "Alpha", [item({
      sourceItemId: "alpha-item",
      ...newPosting,
    })]));
    const alphaKeys = database.query<{ dedupe_key: string }, []>(`
      SELECT dedupe_key FROM discovery_dedupe_keys
      WHERE source_id = 'source-a' AND source_item_id = 'alpha-item'
    `).all().map((row) => row.dedupe_key);
    expect(alphaKeys.some((key) => key.includes("old.example.test") || key.includes("old1")))
      .toBe(false);

    now = 3_000;
    repository.reconcileSource(source("source-b", "Beta", [item({
      sourceItemId: "beta-item",
      ...oldPosting,
    })]));
    const betaJobId = database.query<{ job_id: string }, []>(`
      SELECT job_id FROM discovery_observations
      WHERE source_id = 'source-b' AND source_item_id = 'beta-item'
    `).get()!.job_id;
    expect(betaJobId).not.toBe(alphaJobId);
    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null })).total).toBe(2);

    now = 4_000;
    repository.reconcileSource(source("source-a", "Alpha", []));
    now = 4_500;
    repository.reconcileSource(source("source-d", "Delta", [item({
      sourceItemId: "delta-item",
      ...newPosting,
    })]));
    const deltaJobId = database.query<{ job_id: string }, []>(`
      SELECT job_id FROM discovery_observations
      WHERE source_id = 'source-d' AND source_item_id = 'delta-item'
    `).get()!.job_id;
    expect(deltaJobId).not.toBe(alphaJobId);
    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null, status: "all" })).total).toBe(3);
    now = 5_000;
    repository.reconcileSource(source("source-a", "Alpha", [item({
      sourceItemId: "alpha-item",
      title: "Reopened Software Engineering Intern",
      ...newPosting,
    })]));
    expect(database.query<{ job_id: string }, []>(`
      SELECT job_id FROM discovery_observations
      WHERE source_id = 'source-a' AND source_item_id = 'alpha-item'
    `).get()?.job_id).toBe(alphaJobId);
    expect(database.query<{ job_id: string }, []>(`
      SELECT job_id FROM discovery_observations
      WHERE source_id = 'source-d' AND source_item_id = 'delta-item'
    `).get()?.job_id).toBe(alphaJobId);

    now = 6_000;
    repository.reconcileSource(source("source-c", "Gamma", [item({
      sourceItemId: "gamma-item",
      title: "Secondary Source Title",
      ...newPosting,
    })]));
    expect(database.query<{ job_id: string }, []>(`
      SELECT job_id FROM discovery_observations
      WHERE source_id = 'source-c' AND source_item_id = 'gamma-item'
    `).get()?.job_id).toBe(alphaJobId);
    const listed = repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null }));
    expect(listed.total).toBe(2);
    expect(listed.jobs.find((job) => job.id === alphaJobId)?.title)
      .toBe("Reopened Software Engineering Intern");
    expect(listed.jobs.find((job) => job.id === alphaJobId)?.status).toBe("open");
  });

  test("keeps an exact queued observation when converging keys cannot merge linked jobs", () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    let now = 1_000;
    let nextId = 0;
    const repository = new DiscoveryRepository(database, {
      now: () => now,
      idFactory: () => `job-${++nextId}`,
    });
    const betaPosting = {
      canonicalUrl: "https://converged.example.test/jobs/intern",
      applyUrl: "https://converged.example.test/jobs/intern/apply",
    } as const;

    repository.reconcileSource(source("source-b", "Beta", [item({
      sourceItemId: "beta-item",
      ...betaPosting,
    })]));
    now = 2_000;
    repository.reconcileSource(source("source-a", "Alpha", [item({
      sourceItemId: "alpha-item",
      canonicalUrl: "https://alpha.example.test/jobs/original",
      applyUrl: "https://alpha.example.test/jobs/original/apply",
    })]));
    const observations = database.query<{
      source_id: string;
      job_id: string;
    }, []>(`
      SELECT source_id, job_id FROM discovery_observations ORDER BY source_id
    `).all();
    const alphaJobId = observations.find((row) => row.source_id === "source-a")!.job_id;
    const betaJobId = observations.find((row) => row.source_id === "source-b")!.job_id;
    database.query(`
      INSERT INTO runs(id, job_description, status, queue_sequence, created_at, updated_at)
      VALUES (?, ?, 'queued', ?, ?, ?)
    `).run("run-alpha", DESCRIPTION, 1, now, now);
    database.query(`
      INSERT INTO runs(id, job_description, status, queue_sequence, created_at, updated_at)
      VALUES (?, ?, 'queued', ?, ?, ?)
    `).run("run-beta", DESCRIPTION, 2, now, now);
    database.query(`
      INSERT INTO discovery_run_links(job_id, run_id, created_at) VALUES (?, ?, ?)
    `).run(alphaJobId, "run-alpha", now);
    database.query(`
      INSERT INTO discovery_run_links(job_id, run_id, created_at) VALUES (?, ?, ?)
    `).run(betaJobId, "run-beta", now);

    now = 3_000;
    repository.reconcileSource(source("source-a", "Alpha", [item({
      sourceItemId: "alpha-item",
      ...betaPosting,
    })]));

    const owners = database.query<{ source_id: string; job_id: string }, []>(`
      SELECT source_id, job_id FROM discovery_observations ORDER BY source_id
    `).all();
    expect(owners.find((row) => row.source_id === "source-a")?.job_id).toBe(alphaJobId);
    expect(owners.find((row) => row.source_id === "source-b")?.job_id).toBe(betaJobId);
    expect(database.query<{ job_id: string; run_id: string }, []>(`
      SELECT job_id, run_id FROM discovery_run_links ORDER BY run_id
    `).all()).toEqual([
      { job_id: alphaJobId, run_id: "run-alpha" },
      { job_id: betaJobId, run_id: "run-beta" },
    ]);
    expect(database.query<{ job_id: string }, [string]>(`
      SELECT job_id FROM discovery_dedupe_keys
      WHERE dedupe_key = ? ORDER BY job_id
    `).all(`url:${normalizeDiscoveryUrl(betaPosting.canonicalUrl)}`).map((row) => row.job_id))
      .toEqual([alphaJobId, betaJobId].sort());
    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null, status: "queued" })).total).toBe(2);
  });

  test("uses posting date in fallback dedupe without merging recurring roles", () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    let nextId = 0;
    const repository = new DiscoveryRepository(database, {
      now: () => Date.parse("2026-08-03T00:00:00Z"),
      idFactory: () => `job-${++nextId}`,
    });
    repository.reconcileSource(source("source-a", "Alpha", [
      item({
        sourceItemId: "first",
        canonicalUrl: "https://alpha.example.test/jobs/first",
        applyUrl: "https://alpha.example.test/apply/first",
        postedAt: Date.parse("2026-08-01T01:00:00Z"),
      }),
      item({
        sourceItemId: "same-posting",
        canonicalUrl: "https://mirror.example.test/jobs/same",
        applyUrl: "https://mirror.example.test/apply/same",
        postedAt: Date.parse("2026-08-01T18:00:00Z"),
      }),
      item({
        sourceItemId: "recurring",
        canonicalUrl: "https://alpha.example.test/jobs/recurring",
        applyUrl: "https://alpha.example.test/apply/recurring",
        postedAt: Date.parse("2026-08-02T01:00:00Z"),
      }),
    ]));

    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null })).total).toBe(2);
  });

  test("fallback dedupe fingerprints descriptions for same-day roles", () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    let nextId = 0;
    const repository = new DiscoveryRepository(database, {
      now: () => Date.parse("2026-08-03T00:00:00Z"),
      idFactory: () => `job-${++nextId}`,
    });
    const postedAt = Date.parse("2026-08-01T12:00:00Z");
    const distinctDescription = `${DESCRIPTION} This role owns a materially different data platform.`;

    repository.reconcileSource(source("source-a", "Alpha", [item({
      sourceItemId: "alpha-item",
      canonicalUrl: "https://alpha.example.test/jobs/role",
      applyUrl: "https://alpha.example.test/jobs/role/apply",
      postedAt,
    })]));
    repository.reconcileSource(source("source-b", "Beta", [item({
      sourceItemId: "beta-item",
      canonicalUrl: "https://beta.example.test/jobs/role",
      applyUrl: "https://beta.example.test/jobs/role/apply",
      description: distinctDescription,
      postedAt,
    })]));
    repository.reconcileSource(source("source-c", "Gamma", [item({
      sourceItemId: "gamma-item",
      canonicalUrl: "https://mirror.example.test/jobs/role",
      applyUrl: "https://mirror.example.test/jobs/role/apply",
      postedAt,
    })]));

    const owners = database.query<{ source_id: string; job_id: string }, []>(`
      SELECT source_id, job_id FROM discovery_observations ORDER BY source_id
    `).all();
    expect(owners[0]?.job_id).toBe(owners[2]?.job_id);
    expect(owners[1]?.job_id).not.toBe(owners[0]?.job_id);
    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null })).total).toBe(2);
  });

  test("bounds historical source names to the public response contract", () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    const repository = new DiscoveryRepository(database, {
      now: () => 1_000,
      idFactory: () => "shared-job",
    });
    for (let index = 0; index < 105; index += 1) {
      repository.reconcileSource(source(
        `source-${String(index).padStart(3, "0")}`,
        `Source ${String(index).padStart(3, "0")}`,
        [item({ sourceItemId: `item-${index}` })],
      ));
    }

    const listed = repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null }));

    expect(listed.jobs[0]?.sourceNames).toHaveLength(100);
    expect(listed.jobs[0]?.sourceNames.at(-1)).toBe("Source 099");
  });

  test("only complete successful snapshots close missing observations and active sources reopen", () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    let now = 1_000;
    const repository = new DiscoveryRepository(database, { now: () => now, idFactory: () => "job-1" });
    repository.reconcileSource(source("source-a", "Alpha", [item()]));

    now = 2_000;
    repository.reconcileSource(source("source-a", "Alpha", [], false));
    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null })).jobs[0]?.status)
      .toBe("open");

    now = 3_000;
    repository.recordSourceFailure(
      { id: "source-a", name: "Alpha", kind: "simplify" },
      new Error("upstream unavailable"),
    );
    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null })).jobs[0]?.status)
      .toBe("open");

    now = 4_000;
    const closed = repository.reconcileSource(source("source-a", "Alpha", []));
    expect(closed.closed).toBe(1);
    expect(repository.list(DiscoveryListRequestSchema.parse({
      maxAgeDays: null,
      status: "closed",
    })).jobs[0]?.status).toBe("closed");

    now = 5_000;
    repository.reconcileSource(source("source-a", "Alpha", [item()]));
    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null })).jobs[0]?.status)
      .toBe("open");
  });

  test("uses first-seen recency only when the source posting date is unknown", () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    let now = 40 * 86_400_000;
    let nextId = 0;
    const repository = new DiscoveryRepository(database, {
      now: () => now,
      idFactory: () => `job-${++nextId}`,
    });
    repository.reconcileSource(source("source-a", "Alpha", [
      item({ sourceItemId: "unknown-date", postedAt: null }),
      item({
        sourceItemId: "old-date",
        canonicalUrl: "https://board.example.test/jobs/old",
        applyUrl: "https://board.example.test/jobs/old/apply",
        title: "Data Science Intern",
        postedAt: now - 30 * 86_400_000,
      }),
    ]));

    const recent = repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: 7 }));
    expect(recent.jobs.map((job) => job.title)).toEqual(["Software Engineering Intern"]);

    now += 8 * 86_400_000;
    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: 7 })).total).toBe(0);
    expect(repository.list(DiscoveryListRequestSchema.parse({ maxAgeDays: null })).total).toBe(2);
  });

  test("returns a bounded Unicode-safe preview while retaining the full description", () => {
    const database = openPipelineDatabase(":memory:");
    databases.push(database);
    const repository = new DiscoveryRepository(database, {
      now: () => 1_000,
      idFactory: () => "job-1",
    });
    const description = `Build ${"😀".repeat(300)}`;
    repository.reconcileSource(source("source-a", "Alpha", [item({ description })]));

    const preview = repository.list(
      DiscoveryListRequestSchema.parse({ maxAgeDays: null }),
    ).jobs[0]!.descriptionPreview;
    expect(preview.length).toBeLessThanOrEqual(500);
    expect(preview.endsWith("…")).toBeTrue();
    const beforeEllipsis = preview.charCodeAt(preview.length - 2);
    expect(beforeEllipsis >= 0xD800 && beforeEllipsis <= 0xDBFF).toBeFalse();
    expect(database.query<{ description: string }, []>(
      "SELECT description FROM discovery_jobs",
    ).get()?.description).toBe(description);
  });
});
