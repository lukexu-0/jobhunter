import { describe, expect, test } from "bun:test";

import { createLinkedInConnector } from "../src/discovery/connectors/linkedin";
import {
  SafePublicHttpClient,
  type ConnectorFetch,
} from "../src/discovery/connectors/http";

const PUBLIC_ADDRESS = "93.184.216.34";
const CARD_SEARCH = "https://www.linkedin.com/jobs/search/?keywords=platform";
const JSON_LD_SEARCH = "https://www.linkedin.com/jobs/search/?keywords=machine%20learning";
const MISSING_SEARCH = "https://www.linkedin.com/jobs/search/?keywords=security";

type FixtureResponse = {
  readonly fixture: string;
  readonly status?: number;
} | {
  readonly body: string;
  readonly status?: number;
};

async function fixture(name: string): Promise<string> {
  return Bun.file(new URL(`fixtures/discovery/linkedin/${name}`, import.meta.url)).text();
}

async function fixtureClient(routes: Readonly<Record<string, FixtureResponse>>): Promise<{
  readonly client: SafePublicHttpClient;
  readonly requests: string[];
}> {
  const bodies = new Map<string, { body: string; status: number }>();
  await Promise.all(Object.entries(routes).map(async ([url, route]) => {
    const body = "body" in route ? route.body : await fixture(route.fixture);
    bodies.set(url, { body, status: route.status ?? 200 });
  }));
  const requests: string[] = [];
  const fetchImpl: ConnectorFetch = async (input, init) => {
    const physical = new URL(String(input));
    const host = new Headers(init?.headers).get("host");
    const logical = `https://${host}${physical.pathname}${physical.search}`;
    requests.push(logical);
    const route = bodies.get(logical);
    if (!route) {
      return new Response("fixture route missing", {
        status: 500,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response(route.body, {
      status: route.status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
  return {
    client: new SafePublicHttpClient({
      fetchImpl,
      resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    }),
    requests,
  };
}

describe("LinkedIn public discovery connector", () => {
  test("parses current public search cards and detail markup into a sanitized stable job", async () => {
    const { client, requests } = await fixtureClient({
      [CARD_SEARCH]: { fixture: "search-card.html" },
      "https://www.linkedin.com/jobs/view/1001": { fixture: "detail-card.html" },
    });
    const connector = createLinkedInConnector({
      searchUrls: [CARD_SEARCH],
      id: "linkedin-platform",
      name: "LinkedIn platform search",
      maxJobs: 1,
    }, client);

    const result = await connector.sync(new AbortController().signal);

    expect(connector).toMatchObject({
      id: "linkedin-platform",
      name: "LinkedIn platform search",
      kind: "linkedin",
    });
    expect(result.completeSnapshot).toBeFalse();
    expect(result.provenance).toBeUndefined();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceItemId: "1001",
      sourceUrl: "https://www.linkedin.com/jobs/view/1001",
      canonicalUrl: "https://www.linkedin.com/jobs/view/1001",
      applyUrl: "https://www.linkedin.com/jobs/view/1001",
      title: "Platform Engineer",
      company: "Northstar Labs",
      location: "Toronto, Ontario, Canada",
      postedAt: Date.parse("2026-07-28"),
    });
    expect(result.items[0]!.description.length).toBeGreaterThanOrEqual(40);
    expect(result.items[0]!.description.length).toBeLessThanOrEqual(50_000);
    expect(result.items[0]!.description).toContain("Build and operate reliable services");
    expect(result.items[0]!.description).toContain("Design maintainable TypeScript services");
    expect(result.items[0]!.description).not.toContain("<");
    expect(requests).toEqual([
      CARD_SEARCH,
      "https://www.linkedin.com/jobs/view/1001",
    ]);
  });

  test("falls back to schema.org JobPosting JSON-LD when visible public detail markup is unusable", async () => {
    const { client } = await fixtureClient({
      [JSON_LD_SEARCH]: { fixture: "search-jsonld.html" },
      "https://www.linkedin.com/jobs/view/1002": { fixture: "detail-jsonld.html" },
    });
    const connector = createLinkedInConnector({
      searchUrls: [JSON_LD_SEARCH],
      maxJobs: 1,
    }, client);

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceItemId: "1002",
      sourceUrl: "https://www.linkedin.com/jobs/view/1002",
      canonicalUrl: "https://www.linkedin.com/jobs/view/1002",
      applyUrl: "https://www.linkedin.com/jobs/view/machine-learning-engineer-1002",
      title: "Machine Learning Engineer",
      company: "Signal Works",
      location: "Vancouver, British Columbia, Canada",
      postedAt: Date.parse("2026-07-30"),
    });
    expect(result.items[0]!.description).toContain("Develop production machine learning systems");
    expect(result.items[0]!.description).not.toContain("discarded");
    expect(result.items[0]!.description).not.toContain("<p>");
  });

  test("skips an invalid first JobPosting and uses a later valid JSON-LD candidate", async () => {
    const { client } = await fixtureClient({
      [JSON_LD_SEARCH]: { fixture: "search-jsonld.html" },
      "https://www.linkedin.com/jobs/view/1002": { fixture: "detail-jsonld-multiple.html" },
    });
    const connector = createLinkedInConnector({
      searchUrls: [JSON_LD_SEARCH],
      maxJobs: 1,
    }, client);

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceItemId: "1002",
      title: "Machine Learning Engineer",
      company: "Signal Works",
      location: "Vancouver, British Columbia, Canada",
      postedAt: Date.parse("2026-07-30"),
      applyUrl: "https://www.linkedin.com/jobs/view/machine-learning-engineer-1002",
    });
    expect(result.items[0]!.description).toContain("Develop production machine learning systems");
    expect(result.items[0]!.description).not.toContain("Apply now.");
    expect(result.items[0]!.description).not.toContain("discarded");
  });

  test("rejects configured LinkedIn search URLs on non-default HTTPS ports", () => {
    expect(() => createLinkedInConnector({
      searchUrls: ["https://www.linkedin.com:8443/jobs/search/?keywords=intern"],
    })).toThrow("searchUrls must contain public LinkedIn search URLs");
  });

  test("omits explicit-port card and parsed detail URLs without requesting the alternate port", async () => {
    const card = await fixtureClient({
      [CARD_SEARCH]: { fixture: "search-explicit-port.html" },
    });
    const cardConnector = createLinkedInConnector({
      searchUrls: [CARD_SEARCH],
      maxJobs: 1,
    }, card.client);

    const cardResult = await cardConnector.sync(new AbortController().signal);

    expect(cardResult.items).toEqual([]);
    expect(cardResult.provenance).toBe("linkedin omitted unusable jobs: 1");
    expect(card.requests).toEqual([CARD_SEARCH]);

    const detail = await fixtureClient({
      [JSON_LD_SEARCH]: { fixture: "search-jsonld.html" },
      "https://www.linkedin.com/jobs/view/1002": { fixture: "detail-jsonld-explicit-port.html" },
    });
    const detailConnector = createLinkedInConnector({
      searchUrls: [JSON_LD_SEARCH],
      maxJobs: 1,
    }, detail.client);

    const detailResult = await detailConnector.sync(new AbortController().signal);

    expect(detailResult.items).toEqual([]);
    expect(detailResult.provenance).toBe("linkedin omitted unusable jobs: 1");
    expect(detail.requests).toEqual([
      JSON_LD_SEARCH,
      "https://www.linkedin.com/jobs/view/1002",
    ]);
  });

  test("bounds deeply nested search-card and detail captures", async () => {
    const nestedTitle = [
      '<h3 class="base-search-card__title">',
      '<span class="base-search-card__title">'.repeat(5_000),
      "Platform Engineer",
      "</span>".repeat(5_000),
      "</h3>",
    ].join("");
    const nestedSearchBody = [
      '<div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:1001">',
      '<a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/1001"></a>',
      nestedTitle,
      "</div>",
    ].join("");
    const search = await fixtureClient({
      [CARD_SEARCH]: { body: nestedSearchBody },
      "https://www.linkedin.com/jobs/view/1001": { fixture: "detail-card.html" },
    });
    const searchConnector = createLinkedInConnector({
      searchUrls: [CARD_SEARCH],
      maxJobs: 1,
    }, search.client);

    const searchResult = await searchConnector.sync(new AbortController().signal);

    expect(searchResult.items).toHaveLength(1);
    expect(searchResult.provenance).toBe("linkedin search page exceeded bounded card cap");
    expect(search.requests).toEqual([CARD_SEARCH, "https://www.linkedin.com/jobs/view/1001"]);

    const nestedDescription = [
      '<div class="description__text">',
      '<span class="description__text">'.repeat(5_000),
      "Build and operate reliable services with a collaborative product engineering team.",
      "</span>".repeat(5_000),
      "</div>",
    ].join("");
    const detail = await fixtureClient({
      [JSON_LD_SEARCH]: { fixture: "search-jsonld.html" },
      "https://www.linkedin.com/jobs/view/1002": { body: nestedDescription },
    });
    const detailConnector = createLinkedInConnector({
      searchUrls: [JSON_LD_SEARCH],
      maxJobs: 1,
    }, detail.client);

    const detailResult = await detailConnector.sync(new AbortController().signal);

    expect(detailResult.items).toEqual([]);
    expect(detailResult.provenance).toBe("linkedin omitted unusable jobs: 1");
    expect(detail.requests).toEqual([
      JSON_LD_SEARCH,
      "https://www.linkedin.com/jobs/view/1002",
    ]);
  });

  test("bounds both pagination and detail reads with configured caps", async () => {
    const firstPageRoutes = {
      [CARD_SEARCH]: { fixture: "search-card.html" },
      "https://www.linkedin.com/jobs/view/1001": { fixture: "detail-card.html" },
      "https://www.linkedin.com/jobs/view/1004": { fixture: "detail-card.html" },
      "https://www.linkedin.com/jobs/search/?keywords=platform&start=25": { fixture: "search-page-2.html" },
    } as const;
    const pageCapped = await fixtureClient(firstPageRoutes);
    const pageCappedConnector = createLinkedInConnector({
      searchUrls: [CARD_SEARCH],
      maxPages: 1,
      maxJobs: 10,
    }, pageCapped.client);

    await pageCappedConnector.sync(new AbortController().signal);

    expect(pageCapped.requests).toEqual([
      CARD_SEARCH,
      "https://www.linkedin.com/jobs/view/1001",
      "https://www.linkedin.com/jobs/view/1004",
    ]);

    const jobCapped = await fixtureClient(firstPageRoutes);
    const jobCappedConnector = createLinkedInConnector({
      searchUrls: [CARD_SEARCH],
      maxPages: 3,
      maxJobs: 1,
    }, jobCapped.client);

    const jobCappedResult = await jobCappedConnector.sync(new AbortController().signal);

    expect(jobCappedResult.items).toHaveLength(1);
    expect(jobCapped.requests).toEqual([
      CARD_SEARCH,
      "https://www.linkedin.com/jobs/view/1001",
    ]);
  });

  test("caps parsed search cards at one lookahead beyond the remaining job budget", async () => {
    const { client, requests } = await fixtureClient({
      [CARD_SEARCH]: { fixture: "search-over-cap.html" },
      "https://www.linkedin.com/jobs/view/1001": { fixture: "detail-card.html" },
    });
    const connector = createLinkedInConnector({
      searchUrls: [CARD_SEARCH],
      maxJobs: 1,
    }, client);

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toHaveLength(1);
    expect(result.provenance).toBe("linkedin search page exceeded bounded card cap");
    expect(requests).toEqual([
      CARD_SEARCH,
      "https://www.linkedin.com/jobs/view/1001",
    ]);
  });

  test("surfaces blocked responses with one fixed safe error and never retries", async () => {
    const upstreamBody = await fixture("blocked.html");
    let attempts = 0;
    const fetchImpl: ConnectorFetch = async () => {
      attempts += 1;
      return new Response(upstreamBody, {
        status: 429,
        headers: { "content-type": "text/html" },
      });
    };
    const client = new SafePublicHttpClient({
      fetchImpl,
      resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    });
    const connector = createLinkedInConnector({ searchUrls: [CARD_SEARCH] }, client);

    let failure: unknown;
    try {
      await connector.sync(new AbortController().signal);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("LinkedIn public discovery is blocked");
    expect((failure as Error).message).not.toContain("Security verification");
    expect(attempts).toBe(1);
  });

  test("detects a successful-status challenge wall before parsing jobs", async () => {
    const { client, requests } = await fixtureClient({
      [CARD_SEARCH]: { fixture: "blocked.html" },
    });
    const connector = createLinkedInConnector({ searchUrls: [CARD_SEARCH] }, client);

    await expect(connector.sync(new AbortController().signal))
      .rejects.toThrow("LinkedIn public discovery is blocked");
    expect(requests).toEqual([CARD_SEARCH]);
  });

  test("omits a posting without a real description and reports a bounded omission count", async () => {
    const { client } = await fixtureClient({
      [MISSING_SEARCH]: { fixture: "search-missing-description.html" },
      "https://www.linkedin.com/jobs/view/1003": { fixture: "detail-missing-description.html" },
    });
    const connector = createLinkedInConnector({
      searchUrls: [MISSING_SEARCH],
      maxJobs: 1,
    }, client);

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toEqual([]);
    expect(result.provenance).toBe("linkedin omitted unusable jobs: 1");
  });
});
