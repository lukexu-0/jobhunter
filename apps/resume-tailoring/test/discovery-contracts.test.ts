import { describe, expect, test } from "bun:test";
import {
  DISCOVERY_LIST_MAX_OFFSET,
  DiscoveryListRequestSchema,
  DiscoveryListResponseSchema,
  DiscoveryQueueRequestSchema,
  DiscoveryQueueResponseSchema,
  DiscoverySyncRequestSchema,
  DiscoverySyncResponseSchema,
  type DiscoveryJob,
} from "../src/contracts/index.ts";

const job = {
  id: "job-1",
  title: "Software Engineering Intern",
  company: "Example",
  location: "Toronto, ON",
  roles: ["software_engineering", "machine_learning"],
  suitable: true,
  season: "summer",
  canonicalUrl: "https://jobs.example.test/roles/123",
  applyUrl: "https://jobs.example.test/roles/123/apply",
  descriptionPreview: "Build production software with the platform team.",
  queueable: true,
  postedAt: 1_700_000_000_000,
  firstSeenAt: 1_700_000_100_000,
  lastSeenAt: 1_700_000_200_000,
  status: "open",
  sourceNames: ["Example careers", "Simplify"],
} satisfies DiscoveryJob;

describe("discovery HTTP contracts", () => {
  test("returns a strict, bounded catalog view without transferring the saved full description", () => {
    expect(DiscoveryListResponseSchema.parse({
      jobs: [job],
      total: 1,
      lastSyncAt: 1_700_000_200_000,
    })).toEqual({
      jobs: [job],
      total: 1,
      lastSyncAt: 1_700_000_200_000,
    });
    expect(DiscoveryListResponseSchema.safeParse({
      jobs: [{ ...job, description: "full saved description" }],
      total: 1,
      lastSyncAt: null,
    }).success).toBeFalse();
    expect(DiscoveryListResponseSchema.safeParse({
      jobs: [{ ...job, roles: ["other", "software_engineering"] }],
      total: 1,
      lastSyncAt: null,
    }).success).toBeFalse();
  });

  test("bounds list offsets and applies shared request defaults", () => {
    expect(DiscoveryListRequestSchema.parse({
      offset: DISCOVERY_LIST_MAX_OFFSET,
    })).toEqual({
      maxAgeDays: 7,
      status: "open",
      hideQueued: false,
      search: "",
      sort: "recency",
      limit: 100,
      offset: DISCOVERY_LIST_MAX_OFFSET,
    });
    expect(DiscoveryListRequestSchema.safeParse({
      offset: DISCOVERY_LIST_MAX_OFFSET + 1,
    }).success).toBeFalse();
  });

  test("accepts at most 1,000 distinct jobs and defaults tailoring modes", () => {
    expect(DiscoveryQueueRequestSchema.parse({ jobIds: ["job-1", "job-2"] })).toEqual({
      jobIds: ["job-1", "job-2"],
      generateKeywordMap: true,
      skipReview: false,
      autoSubmit: false,
    });
    expect(DiscoveryQueueRequestSchema.safeParse({ jobIds: ["job-1", "job-1"] }).success).toBeFalse();
    expect(DiscoveryQueueRequestSchema.safeParse({
      jobIds: Array.from({ length: 1_001 }, (_, index) => `job-${index}`),
    }).success).toBeFalse();
    expect(DiscoverySyncRequestSchema.parse({})).toEqual({});
    expect(DiscoverySyncRequestSchema.safeParse({ unexpected: true }).success).toBeFalse();
  });
  test("accepts description-unavailable as a queue skip reason", () => {
    expect(DiscoveryQueueResponseSchema.parse({
      queued: [],
      skipped: [{ jobId: "job-1", reason: "description_unavailable" }],
    }).skipped).toEqual([{ jobId: "job-1", reason: "description_unavailable" }]);
  });


  test("requires per-source and aggregate description-unavailable counts", () => {
    const response = {
      sources: [{
        sourceId: "simplify",
        sourceName: "Simplify",
        status: "succeeded" as const,
        completeSnapshot: true,
        received: 12,
        created: 10,
        updated: 2,
        closed: 0,
        descriptionUnavailable: 3,
      }],
      totals: {
        sources: 1,
        succeeded: 1,
        failed: 0,
        received: 12,
        created: 10,
        updated: 2,
        closed: 0,
        descriptionUnavailable: 3,
      },
      completedAt: 1_700_000_000_000,
    };
    expect(DiscoverySyncResponseSchema.parse(response)).toEqual(response);
    const { descriptionUnavailable: _descriptionUnavailable, ...incompleteSource } =
      response.sources[0]!;
    expect(DiscoverySyncResponseSchema.safeParse({
      ...response,
      sources: [incompleteSource],
    }).success).toBeFalse();
  });

  test("projects unavailable descriptions and queue eligibility explicitly", () => {
    expect(DiscoveryListResponseSchema.parse({
      jobs: [{
        ...job,
        descriptionPreview: null,
        queueable: false,
      }],
      total: 1,
      lastSyncAt: null,
    }).jobs[0]).toMatchObject({
      descriptionPreview: null,
      queueable: false,
    });
  });
});
