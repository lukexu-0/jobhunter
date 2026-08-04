import { describe, expect, test } from "bun:test";

import {
  createHtmlBoardConnector,
  type HtmlBoardConnectorConfig,
} from "../src/discovery/connectors/html-board";
import { SafePublicHttpClient, type ConnectorFetch } from "../src/discovery/connectors/http";

const fixtureRoot = new URL("fixtures/discovery/html-board/", import.meta.url);
const listPage1 = await Bun.file(new URL("list-page-1.html", fixtureRoot)).text();
const listPage2 = await Bun.file(new URL("list-page-2.html", fixtureRoot)).text();
const crossHostList = await Bun.file(new URL("list-cross-host.html", fixtureRoot)).text();
const crossHostPageList = await Bun.file(new URL("list-cross-host-page.html", fixtureRoot)).text();
const authWallList = await Bun.file(new URL("list-auth-wall.html", fixtureRoot)).text();
const platformDetail = await Bun.file(new URL("detail-platform.html", fixtureRoot)).text();
const mlDetail = await Bun.file(new URL("detail-ml.html", fixtureRoot)).text();
const securityDetail = await Bun.file(new URL("detail-security.html", fixtureRoot)).text();
const missingDescription = await Bun.file(new URL("detail-missing-description.html", fixtureRoot)).text();
const PUBLIC_ADDRESS = "93.184.216.34";

type FixtureResponse = string | { readonly body: string; readonly status: number };

function fixtureConfig(overrides: Partial<HtmlBoardConnectorConfig> = {}): HtmlBoardConnectorConfig {
  return {
    id: "fixture-board",
    name: "Fixture HTML board",
    listUrl: "https://board.example/openings",
    allowedHosts: ["apply.example"],
    maxPages: 4,
    maxJobs: 20,
    list: {
      rowSelector: "article.job-card",
      title: { selector: "h2.job-title" },
      company: { selector: "span.job-company", attribute: "aria-label" },
      detailUrl: { selector: "a.job-detail", attribute: "href" },
      applyUrl: { selector: "a.job-apply", attribute: "data-apply-url" },
      location: { selector: "span.job-location" },
      date: { selector: "time.job-date", attribute: "datetime" },
      id: { selector: "span.job-id", attribute: "data-id" },
      nextPage: { selector: "a.next-page", attribute: "href" },
    },
    detail: {
      descriptionSelector: "section.job-description",
      location: { selector: "span.detail-location" },
      date: { selector: "time.detail-date", attribute: "datetime" },
    },
    ...overrides,
  };
}

function fixtureClient(
  routes: Readonly<Record<string, FixtureResponse>>,
  requests: string[] = [],
): SafePublicHttpClient {
  const fetchImpl: ConnectorFetch = async (input, init) => {
    const url = new URL(String(input));
    const host = new Headers(init.headers).get("host");
    const key = `${host}${url.pathname}${url.search}`;
    requests.push(key);
    const fixture = routes[key];
    if (fixture === undefined) {
      return new Response("fixture route missing", {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    }
    const response = typeof fixture === "string" ? { body: fixture, status: 200 } : fixture;
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
  return new SafePublicHttpClient({
    fetchImpl,
    resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
  });
}

function completeRoutes(): Readonly<Record<string, FixtureResponse>> {
  return {
    "board.example/openings": listPage1,
    "board.example/openings?page=2": listPage2,
    "board.example/jobs/platform-101": platformDetail,
    "board.example/jobs/ml-202": mlDetail,
    "board.example/jobs/security-303": securityDetail,
  };
}

describe("configured HTML board discovery", () => {
  test("parses reviewed selectors and attributes, follows paging, and fetches every detail", async () => {
    const requests: string[] = [];
    const connector = createHtmlBoardConnector(fixtureConfig(), fixtureClient(completeRoutes(), requests));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.provenance).toBeUndefined();
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({
      title: "Senior Platform Engineer",
      company: "Acme Systems",
      location: "Brooklyn, NY",
      postedAt: Date.parse("2026-07-31T12:00:00Z"),
      sourceUrl: "https://board.example/jobs/platform-101",
      canonicalUrl: "https://board.example/jobs/platform-101",
      applyUrl: "https://board.example/apply/platform-101",
    });
    expect(result.items[1]).toMatchObject({
      title: "Machine Learning Engineer",
      company: "Example Research",
      location: "Remote - US",
      postedAt: Date.parse("2026-07-29"),
      applyUrl: "https://apply.example/apply/ml-202",
    });
    expect(result.items[2]).toMatchObject({
      title: "Product Security Engineer",
      company: "Secure Example",
      location: "Austin, Texas",
      postedAt: Date.parse("2026-08-01"),
    });
    expect(result.items.map((item) => item.sourceItemId)).toEqual([
      expect.stringMatching(/^[a-f0-9]{32}$/),
      expect.stringMatching(/^[a-f0-9]{32}$/),
      expect.stringMatching(/^[a-f0-9]{32}$/),
    ]);
    expect(new Set(result.items.map((item) => item.sourceItemId)).size).toBe(3);
    expect(result.items[0]!.description).toContain("Build reliable distributed services");
    expect(result.items[0]!.description).not.toContain("window.secret");
    expect(result.items[0]!.description).not.toContain("private-token");
    expect(requests).toEqual([
      "board.example/openings",
      "board.example/jobs/platform-101",
      "board.example/jobs/ml-202",
      "board.example/openings?page=2",
      "board.example/jobs/security-303",
    ]);
  });

  test("keeps an empty selector result incomplete when reviewed markup no longer matches", async () => {
    const connector = createHtmlBoardConnector(
      fixtureConfig(),
      fixtureClient({
        "board.example/openings": "<!doctype html><main><p>Careers page changed</p></main>",
      }),
    );

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toEqual([]);
    expect(result.completeSnapshot).toBe(false);
    expect(result.provenance).toBe("html-board list selector matched no job rows");
  });

  test("keeps a later zero-row page incomplete after earlier valid rows", async () => {
    const connector = createHtmlBoardConnector(fixtureConfig(), fixtureClient({
      "board.example/openings": listPage1,
      "board.example/jobs/platform-101": platformDetail,
      "board.example/jobs/ml-202": mlDetail,
      "board.example/openings?page=2": authWallList,
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toHaveLength(2);
    expect(result.completeSnapshot).toBe(false);
    expect(result.provenance).toBe("html-board list selector matched no job rows");
  });

  test("blocks cross-host detail and paging reads unless the public hosts are explicit", async () => {
    const detailRequests: string[] = [];
    const detailConnector = createHtmlBoardConnector(
      fixtureConfig(),
      fixtureClient({ "board.example/openings": crossHostList }, detailRequests),
    );

    await expect(detailConnector.sync(new AbortController().signal)).rejects.toThrow(
      "HTML board discovery URL host is not allowed",
    );
    expect(detailRequests).toEqual(["board.example/openings"]);

    const allowedDetail = createHtmlBoardConnector(
      fixtureConfig({ allowedHosts: ["apply.example", "details.example"] }),
      fixtureClient({
        "board.example/openings": crossHostList,
        "details.example/jobs/external-404": platformDetail,
      }),
    );
    expect((await allowedDetail.sync(new AbortController().signal)).items).toHaveLength(1);

    const pagingRequests: string[] = [];
    const pagingConnector = createHtmlBoardConnector(
      fixtureConfig(),
      fixtureClient({
        "board.example/openings": crossHostPageList,
        "board.example/jobs/local-505": platformDetail,
      }, pagingRequests),
    );
    await expect(pagingConnector.sync(new AbortController().signal)).rejects.toThrow(
      "HTML board discovery URL host is not allowed",
    );
    expect(pagingRequests).toEqual(["board.example/openings", "board.example/jobs/local-505"]);

    const allowedPaging = createHtmlBoardConnector(
      fixtureConfig({ allowedHosts: ["pages.example"] }),
      fixtureClient({
        "board.example/openings": crossHostPageList,
        "board.example/jobs/local-505": platformDetail,
        "pages.example/openings?page=2": listPage2,
        "pages.example/jobs/security-303": securityDetail,
      }),
    );
    expect((await allowedPaging.sync(new AbortController().signal)).items).toHaveLength(2);
  });

  test("rejects non-default HTTPS ports before list, detail, or next-page requests", async () => {
    const configuredRequests: string[] = [];
    expect(() => createHtmlBoardConnector(
      fixtureConfig({ listUrl: "https://board.example:8443/openings" }),
      fixtureClient({}, configuredRequests),
    )).toThrow("Invalid HTML board connector configuration");
    expect(configuredRequests).toEqual([]);

    const detailRequests: string[] = [];
    const alternatePortDetailList = listPage1.replace(
      "/jobs/platform-101?utm_source=fixture",
      "https://board.example:444/jobs/platform-101",
    );
    const detailConnector = createHtmlBoardConnector(
      fixtureConfig(),
      fixtureClient({ "board.example/openings": alternatePortDetailList }, detailRequests),
    );
    await expect(detailConnector.sync(new AbortController().signal)).rejects.toThrow(
      "HTML board discovery URL host is not allowed",
    );
    expect(detailRequests).toEqual(["board.example/openings"]);

    const pageRequests: string[] = [];
    const alternatePortPageList = listPage1.replace(
      "/openings?page=2",
      "https://board.example:444/openings?page=2",
    );
    const pageConnector = createHtmlBoardConnector(
      fixtureConfig(),
      fixtureClient({
        "board.example/openings": alternatePortPageList,
        "board.example/jobs/platform-101": platformDetail,
        "board.example/jobs/ml-202": mlDetail,
      }, pageRequests),
    );
    await expect(pageConnector.sync(new AbortController().signal)).rejects.toThrow(
      "HTML board discovery URL host is not allowed",
    );
    expect(pageRequests).toEqual([
      "board.example/openings",
      "board.example/jobs/platform-101",
      "board.example/jobs/ml-202",
    ]);
  });

  test("accepts equivalent duplicate next links but marks conflicting or missing targets incomplete", async () => {
    const nextLink = '<a class="next-page" href="/openings?page=2">Next page</a>';
    const equivalentList = listPage1.replace(
      nextLink,
      `${nextLink}<a class="next-page" href="https://board.example/openings?page=2">Mobile next</a>`,
    );
    const equivalent = createHtmlBoardConnector(fixtureConfig(), fixtureClient({
      ...completeRoutes(),
      "board.example/openings": equivalentList,
    }));

    const equivalentResult = await equivalent.sync(new AbortController().signal);

    expect(equivalentResult.items).toHaveLength(3);
    expect(equivalentResult.completeSnapshot).toBe(true);

    const conflictingRequests: string[] = [];
    const conflictingList = listPage1.replace(
      nextLink,
      `${nextLink}<a class="next-page" href="/openings?page=3">Other next</a>`,
    );
    const conflicting = createHtmlBoardConnector(
      fixtureConfig(),
      fixtureClient({
        "board.example/openings": conflictingList,
        "board.example/jobs/platform-101": platformDetail,
        "board.example/jobs/ml-202": mlDetail,
      }, conflictingRequests),
    );

    const conflictingResult = await conflicting.sync(new AbortController().signal);

    expect(conflictingResult.items).toHaveLength(2);
    expect(conflictingResult.completeSnapshot).toBe(false);
    expect(conflictingRequests).toEqual([
      "board.example/openings",
      "board.example/jobs/platform-101",
      "board.example/jobs/ml-202",
    ]);

    const missingTargetList = listPage1.replace(nextLink, '<a class="next-page">Next page</a>');
    const missingTarget = createHtmlBoardConnector(fixtureConfig(), fixtureClient({
      "board.example/openings": missingTargetList,
      "board.example/jobs/platform-101": platformDetail,
      "board.example/jobs/ml-202": mlDetail,
    }));

    const missingTargetResult = await missingTarget.sync(new AbortController().signal);

    expect(missingTargetResult.items).toHaveLength(2);
    expect(missingTargetResult.completeSnapshot).toBe(false);
  });

  test("bounds list pages and detail jobs and marks cap-truncated snapshots incomplete", async () => {
    const pageRequests: string[] = [];
    const pageLimited = createHtmlBoardConnector(
      fixtureConfig({ maxPages: 1 }),
      fixtureClient(completeRoutes(), pageRequests),
    );
    const pageResult = await pageLimited.sync(new AbortController().signal);

    expect(pageResult.items).toHaveLength(2);
    expect(pageResult.completeSnapshot).toBe(false);
    expect(pageRequests).not.toContain("board.example/openings?page=2");

    const jobRequests: string[] = [];
    const jobLimited = createHtmlBoardConnector(
      fixtureConfig({ maxJobs: 1 }),
      fixtureClient(completeRoutes(), jobRequests),
    );
    const jobResult = await jobLimited.sync(new AbortController().signal);

    expect(jobResult.items).toHaveLength(1);
    expect(jobResult.completeSnapshot).toBe(false);
    expect(jobRequests).toEqual(["board.example/openings", "board.example/jobs/platform-101"]);
  });

  test("bounds nested over-cap row capture by maxJobs", async () => {
    const nestedRows = `${"<div class=\"job-card\">".repeat(5_000)}${"</div>".repeat(5_000)}`;
    const list = [
      "<!doctype html><main><div class=\"job-card\">",
      "<span class=\"job-id\" data-id=\"bounded-1\"></span>",
      "<h2 class=\"job-title\">Bounded Parser Engineer</h2>",
      "<span class=\"job-company\" aria-label=\"Acme Systems\"></span>",
      "<a class=\"job-detail\" href=\"/jobs/platform-101\"></a>",
      "<a class=\"job-apply\" data-apply-url=\"/apply/platform-101\"></a>",
      nestedRows,
      "</div></main>",
    ].join("");
    const requests: string[] = [];
    const base = fixtureConfig();
    const connector = createHtmlBoardConnector(
      fixtureConfig({
        maxJobs: 1,
        list: { ...base.list, rowSelector: "div.job-card" },
      }),
      fixtureClient({
        "board.example/openings": list,
        "board.example/jobs/platform-101": platformDetail,
      }, requests),
    );

    const result = await connector.sync(new AbortController().signal);

    expect(result.items.map((item) => item.title)).toEqual(["Bounded Parser Engineer"]);
    expect(result.completeSnapshot).toBe(false);
    expect(requests).toEqual(["board.example/openings", "board.example/jobs/platform-101"]);
  });

  test("treats a successful page with no structural job rows as incomplete", async () => {
    const connector = createHtmlBoardConnector(fixtureConfig(), fixtureClient({
      "board.example/openings": authWallList,
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toEqual([]);
    expect(result.completeSnapshot).toBe(false);
    expect(result.provenance).toBe("html-board list selector matched no job rows");
  });

  test("rejects unsafe, ambiguous, malformed, and oversized selectors or attributes", () => {
    const invalidConfigs: HtmlBoardConnectorConfig[] = [
      fixtureConfig({ list: { ...fixtureConfig().list, rowSelector: "script.job-card" } }),
      fixtureConfig({ list: { ...fixtureConfig().list, rowSelector: "article.job-card,script" } }),
      fixtureConfig({ list: { ...fixtureConfig().list, rowSelector: "article:has(script)" } }),
      fixtureConfig({ list: { ...fixtureConfig().list, rowSelector: "article[src]" } }),
      fixtureConfig({ list: { ...fixtureConfig().list, rowSelector: `article.${"x".repeat(260)}` } }),
      fixtureConfig({
        list: { ...fixtureConfig().list, detailUrl: { selector: "a.job-detail", attribute: "src" } },
      }),
      fixtureConfig({
        list: { ...fixtureConfig().list, company: { selector: "span.job-company", attribute: "onclick" } },
      }),
      fixtureConfig({
        list: { ...fixtureConfig().list, applyUrl: { selector: "a.job-apply", attribute: `data-${"x".repeat(70)}-url` } },
      }),
    ];

    for (const config of invalidConfigs) {
      expect(() => createHtmlBoardConnector(config)).toThrow("Invalid HTML board connector configuration");
    }
    expect(() => createHtmlBoardConnector({ ...fixtureConfig(), unexpected: true } as HtmlBoardConnectorConfig))
      .toThrow("Invalid HTML board connector configuration");
  });

  test("omits an unusable fetched description with bounded provenance", async () => {
    const requests: string[] = [];
    const connector = createHtmlBoardConnector(fixtureConfig(), fixtureClient({
      ...completeRoutes(),
      "board.example/jobs/ml-202": missingDescription,
    }, requests));

    const result = await connector.sync(new AbortController().signal);

    expect(result.items.map((item) => item.title)).toEqual([
      "Senior Platform Engineer",
      "Product Security Engineer",
    ]);
    expect(result.completeSnapshot).toBe(false);
    expect(result.provenance).toBe("html-board omitted unusable records: 1");
    expect(requests).toContain("board.example/jobs/ml-202");
  });

  test("uses a fixed sanitized error for non-success upstream responses", async () => {
    const connector = createHtmlBoardConnector(fixtureConfig(), fixtureClient({
      "board.example/openings": { body: "private upstream diagnostic", status: 503 },
    }));

    try {
      await connector.sync(new AbortController().signal);
      throw new Error("expected connector failure");
    } catch (error) {
      expect(error).toMatchObject({ message: "HTML board discovery source could not be loaded" });
      expect(String(error)).not.toContain("private upstream diagnostic");
    }
  });
});
