import { describe, expect, test } from "bun:test";

import {
  createAtsConnector,
  type AtsConnectorConfig,
} from "../src/discovery/connectors/ats";
import {
  SafePublicHttpClient,
  type ConnectorFetch,
} from "../src/discovery/connectors/http";

const PUBLIC_ADDRESS = "93.184.216.34";
const FIXTURE_ROOT = new URL("./fixtures/discovery/ats/", import.meta.url);

interface FixtureRoute {
  readonly fixture: string;
  readonly contentType?: string;
  readonly status?: number;
}


function fixtureClient(
  routes: Readonly<Record<string, FixtureRoute>>,
  requested: string[] = [],
): SafePublicHttpClient {
  const fetchImpl: ConnectorFetch = async (input) => {
    const url = new URL(String(input));
    const key = `${url.pathname}${url.search}`;
    requested.push(key);
    const route = routes[key];
    if (!route) {
      return new Response("route missing", {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response(await Bun.file(new URL(route.fixture, FIXTURE_ROOT)).text(), {
      status: route.status ?? 200,
      headers: { "content-type": route.contentType ?? "application/json" },
    });
  };
  return new SafePublicHttpClient({
    fetchImpl,
    resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
  });
}

interface AtsCase {
  readonly label: string;
  readonly config: AtsConnectorConfig;
  readonly routes: Readonly<Record<string, FixtureRoute>>;
  readonly expected: {
    readonly title: string;
    readonly company: string;
    readonly location: string;
    readonly requisitionId: string;
    readonly requested: readonly string[];
  };
}

const cases: readonly AtsCase[] = [
  {
    label: "Greenhouse",
    config: { kind: "greenhouse", boardToken: "acme", company: "Configured Acme" },
    routes: {
      "/v1/boards/acme/jobs": { fixture: "greenhouse.json" },
      "/v1/boards/acme/jobs/101": { fixture: "greenhouse-detail.json" },
      "/v1/boards/acme/jobs/102": { fixture: "greenhouse-detail-missing.json" },
    },
    expected: {
      title: "Platform Engineer",
      company: "Acme Systems",
      location: "Toronto, ON",
      requisitionId: "GH-5001",
      requested: [
        "/v1/boards/acme/jobs",
        "/v1/boards/acme/jobs/101",
        "/v1/boards/acme/jobs/102",
      ],
    },
  },
  {
    label: "Lever",
    config: { kind: "lever", site: "acme", company: "Acme Systems" },
    routes: {
      "/v0/postings/acme?mode=json&limit=100": { fixture: "lever.json" },
    },
    expected: {
      title: "Backend Engineer",
      company: "Acme Systems",
      location: "New York, NY",
      requisitionId: "",
      requested: ["/v0/postings/acme?mode=json&limit=100"],
    },
  },
  {
    label: "Ashby",
    config: { kind: "ashby", boardName: "acme", company: "Acme Systems" },
    routes: {
      "/posting-api/job-board/acme?includeCompensation=true": { fixture: "ashby.json" },
    },
    expected: {
      title: "Machine Learning Engineer",
      company: "Acme Systems",
      location: "San Francisco, CA",
      requisitionId: "",
      requested: ["/posting-api/job-board/acme?includeCompensation=true"],
    },
  },
  {
    label: "SmartRecruiters",
    config: { kind: "smartrecruiters", companyIdentifier: "acme", company: "Configured Acme" },
    routes: {
      "/v1/companies/acme/postings?limit=100&offset=0": { fixture: "smartrecruiters-list.json" },
      "/v1/companies/acme/postings/sr-401": { fixture: "smartrecruiters-detail.json" },
      "/v1/companies/acme/postings/sr-402": { fixture: "smartrecruiters-detail-missing.json" },
    },
    expected: {
      title: "Security Engineer",
      company: "Acme Systems",
      location: "Austin, TX, United States",
      requisitionId: "SR-401",
      requested: [
        "/v1/companies/acme/postings?limit=100&offset=0",
        "/v1/companies/acme/postings/sr-401",
        "/v1/companies/acme/postings/sr-402",
      ],
    },
  },
  {
    label: "Workable",
    config: { kind: "workable", account: "acme", company: "Configured Acme" },
    routes: {
      "/api/v1/widget/accounts/acme?details=true": { fixture: "workable.json" },
    },
    expected: {
      title: "Data Engineer",
      company: "Acme Systems",
      location: "Toronto, Ontario, Canada",
      requisitionId: "REQ-501",
      requested: ["/api/v1/widget/accounts/acme?details=true"],
    },
  },
  {
    label: "Recruitee",
    config: { kind: "recruitee", subdomain: "acme", company: "Configured Acme" },
    routes: {
      "/api/offers/": { fixture: "recruitee.json" },
    },
    expected: {
      title: "Frontend Engineer",
      company: "Acme Systems",
      location: "Amsterdam, Netherlands",
      requisitionId: "REC-601",
      requested: ["/api/offers/"],
    },
  },
  {
    label: "Personio",
    config: { kind: "personio", account: "acme", company: "Configured Acme", language: "en" },
    routes: {
      "/xml?language=en": { fixture: "personio.xml", contentType: "text/xml" },
    },
    expected: {
      title: "Site Reliability Engineer",
      company: "Acme Systems & Labs",
      location: "Berlin, Munich",
      requisitionId: "701",
      requested: ["/xml?language=en"],
    },
  },
];

describe("public ATS discovery connectors", () => {
  for (const fixtureCase of cases) {
    test(`${fixtureCase.label} parses its public feed and omits postings without a usable description`, async () => {
      const requested: string[] = [];
      const connector = createAtsConnector(fixtureCase.config, fixtureClient(fixtureCase.routes, requested));

      const first = await connector.sync(new AbortController().signal);
      const second = await connector.sync(new AbortController().signal);

      expect(first.completeSnapshot).toBeFalse();
      expect(first.provenance).toBe("omitted=1");
      expect(first.items).toHaveLength(1);
      const job = first.items[0]!;
      expect(job.title).toBe(fixtureCase.expected.title);
      expect(job.company).toBe(fixtureCase.expected.company);
      expect(job.location).toBe(fixtureCase.expected.location);
      if (fixtureCase.expected.requisitionId) {
        expect(job.requisitionId).toBe(fixtureCase.expected.requisitionId);
      } else {
        expect(job.requisitionId).toBeUndefined();
      }
      expect(job.sourceItemId).toHaveLength(32);
      expect(second.items[0]?.sourceItemId).toBe(job.sourceItemId);
      expect(job.description.length).toBeGreaterThanOrEqual(40);
      expect(job.description).not.toContain("<script");
      expect(job.description).not.toContain("secret()");
      expect(job.canonicalUrl).not.toContain("utm_");
      expect(job.sourceUrl).not.toContain("utm_");
      expect(job.applyUrl).toMatch(/^https:\/\//);
      expect(job.applyUrl).not.toContain("utm_");
      expect(requested).toEqual([
        ...fixtureCase.expected.requested,
        ...fixtureCase.expected.requested,
      ]);
    });
  }

  test("marks a maxJobs-truncated feed as incomplete without counting unvisited jobs as malformed", async () => {
    const connector = createAtsConnector(
      { kind: "greenhouse", boardToken: "acme", company: "Acme Systems", maxJobs: 1 },
      fixtureClient({
        "/v1/boards/acme/jobs": { fixture: "greenhouse.json" },
        "/v1/boards/acme/jobs/101": { fixture: "greenhouse-detail.json" },
      }),
    );

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toHaveLength(1);
    expect(result.completeSnapshot).toBeFalse();
    expect(result.provenance).toBe("omitted=0");
  });

  test("marks a Lever response that exactly fills its requested cap as incomplete", async () => {
    const connector = createAtsConnector(
      { kind: "lever", site: "acme", company: "Acme Systems", maxJobs: 1 },
      fixtureClient({
        "/v0/postings/acme?mode=json&limit=1": { fixture: "lever-exact-cap.json" },
      }),
    );

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toHaveLength(1);
    expect(result.completeSnapshot).toBeFalse();
    expect(result.provenance).toBe("omitted=0");
  });

  test("marks exact-cap unpaginated JSON feeds incomplete while allowing below-cap completeness", async () => {
    const routes = {
      "/posting-api/job-board/acme?includeCompensation=true": { fixture: "ashby-single.json" },
    } as const;
    const capped = createAtsConnector(
      { kind: "ashby", boardName: "acme", company: "Acme Systems", maxJobs: 1 },
      fixtureClient(routes),
    );
    const belowCap = createAtsConnector(
      { kind: "ashby", boardName: "acme", company: "Acme Systems", maxJobs: 2 },
      fixtureClient(routes),
    );

    const cappedResult = await capped.sync(new AbortController().signal);
    const belowCapResult = await belowCap.sync(new AbortController().signal);

    expect(cappedResult.items).toHaveLength(1);
    expect(cappedResult.completeSnapshot).toBeFalse();
    expect(cappedResult.provenance).toBe("omitted=0");
    expect(belowCapResult.items).toHaveLength(1);
    expect(belowCapResult.completeSnapshot).toBeTrue();
    expect(belowCapResult.provenance).toBe("omitted=0");
  });

  test("marks exact-cap Personio XML incomplete while allowing below-cap completeness", async () => {
    const routes = {
      "/xml?language=en": { fixture: "personio-single.xml", contentType: "text/xml" },
    } as const;
    const capped = createAtsConnector(
      { kind: "personio", account: "acme", company: "Acme Systems", maxJobs: 1 },
      fixtureClient(routes),
    );
    const belowCap = createAtsConnector(
      { kind: "personio", account: "acme", company: "Acme Systems", maxJobs: 2 },
      fixtureClient(routes),
    );

    const cappedResult = await capped.sync(new AbortController().signal);
    const belowCapResult = await belowCap.sync(new AbortController().signal);

    expect(cappedResult.items).toHaveLength(1);
    expect(cappedResult.completeSnapshot).toBeFalse();
    expect(cappedResult.provenance).toBe("omitted=0");
    expect(belowCapResult.items).toHaveLength(1);
    expect(belowCapResult.completeSnapshot).toBeTrue();
    expect(belowCapResult.provenance).toBe("omitted=0");
  });

  test("omits Personio positions whose child collections exceed the parsing cap", async () => {
    const connector = createAtsConnector(
      { kind: "personio", account: "acme", company: "Acme Systems", maxJobs: 10 },
      fixtureClient({
        "/xml?language=en": { fixture: "personio-child-overflow.xml", contentType: "text/xml" },
      }),
    );

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toEqual([]);
    expect(result.completeSnapshot).toBeFalse();
    expect(result.provenance).toBe("omitted=2");
  });

  test("rejects unclosed Personio position structures instead of returning a complete empty snapshot", async () => {
    const connector = createAtsConnector(
      { kind: "personio", account: "acme", company: "Acme Systems" },
      fixtureClient({
        "/xml?language=en": { fixture: "personio-malformed.xml", contentType: "text/xml" },
      }),
    );

    const error = await connector.sync(new AbortController().signal).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("The ATS job source is unavailable");
  });

  test("deduplicates unpaginated feed rows by sourceItemId and marks the result incomplete", async () => {
    const connector = createAtsConnector(
      { kind: "lever", site: "acme", company: "Acme Systems" },
      fixtureClient({
        "/v0/postings/acme?mode=json&limit=100": { fixture: "lever-duplicate.json" },
      }),
    );

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toHaveLength(1);
    expect(new Set(result.items.map((item) => item.sourceItemId)).size).toBe(1);
    expect(result.completeSnapshot).toBeFalse();
    expect(result.provenance).toBe("omitted=1");
  });

  test("deduplicates SmartRecruiters detail results and counts the duplicate as omitted", async () => {
    const requested: string[] = [];
    const connector = createAtsConnector(
      { kind: "smartrecruiters", companyIdentifier: "acme", company: "Acme Systems" },
      fixtureClient({
        "/v1/companies/acme/postings?limit=100&offset=0": {
          fixture: "smartrecruiters-list-duplicate.json",
        },
        "/v1/companies/acme/postings/sr-401": { fixture: "smartrecruiters-detail.json" },
      }, requested),
    );

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toHaveLength(1);
    expect(new Set(result.items.map((item) => item.sourceItemId)).size).toBe(1);
    expect(result.completeSnapshot).toBeFalse();
    expect(result.provenance).toBe("omitted=1");
    expect(requested).toEqual([
      "/v1/companies/acme/postings?limit=100&offset=0",
      "/v1/companies/acme/postings/sr-401",
      "/v1/companies/acme/postings/sr-401",
    ]);
  });

  test("keeps a valid Workable widget response incomplete without paging metadata", async () => {
    const connector = createAtsConnector(
      { kind: "workable", account: "acme", company: "Acme Systems" },
      fixtureClient({
        "/api/v1/widget/accounts/acme?details=true": { fixture: "workable-single.json" },
      }),
    );

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toHaveLength(1);
    expect(result.completeSnapshot).toBeFalse();
    expect(result.provenance).toBe("omitted=0");
  });

  test("omits postings with loopback source URLs or off-vendor apply URLs", async () => {
    const connector = createAtsConnector(
      { kind: "lever", site: "acme", company: "Acme Systems" },
      fixtureClient({
        "/v0/postings/acme?mode=json&limit=100": { fixture: "lever-malicious-urls.json" },
      }),
    );

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toEqual([]);
    expect(result.completeSnapshot).toBeFalse();
    expect(result.provenance).toBe("omitted=2");
  });

  test("maps non-success upstream responses to one fixed error without exposing the response body", async () => {
    const connector = createAtsConnector(
      { kind: "greenhouse", boardToken: "acme", company: "Acme Systems" },
      fixtureClient({
        "/v1/boards/acme/jobs": {
          fixture: "upstream-error.json",
          status: 503,
        },
      }),
    );

    const error = await connector.sync(new AbortController().signal).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("The ATS job source is unavailable");
    expect((error as Error).message).not.toContain("upstream-secret");
  });

  test("fails with the fixed connector error when a required detail request is non-successful", async () => {
    const connector = createAtsConnector(
      { kind: "greenhouse", boardToken: "acme", company: "Acme Systems" },
      fixtureClient({
        "/v1/boards/acme/jobs": { fixture: "greenhouse.json" },
        "/v1/boards/acme/jobs/101": {
          fixture: "upstream-error.json",
          status: 503,
        },
      }),
    );

    const error = await connector.sync(new AbortController().signal).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("The ATS job source is unavailable");
    expect((error as Error).message).not.toContain("upstream-secret");
  });
});
