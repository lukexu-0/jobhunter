import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { SafePublicHttpClient, type ConnectorFetch } from "../src/discovery/connectors/http";
import { createWorkdayConnector } from "../src/discovery/connectors/workday";

const PUBLIC_ADDRESS = "93.184.216.34";
const HOST = "acme.wd5.myworkdayjobs.com";
const FIXTURE_ROOT = resolve(import.meta.dir, "fixtures/discovery/workday");

interface ObservedRequest {
  readonly method: string;
  readonly path: string;
  readonly host: string | null;
  readonly contentType: string | null;
  readonly body: string;
}

async function fixture(name: string): Promise<string> {
  return Bun.file(resolve(FIXTURE_ROOT, name)).text();
}

function fixtureClient(
  respond: (request: ObservedRequest, index: number) => Response | Promise<Response>,
  requests: ObservedRequest[],
): SafePublicHttpClient {
  const fetchImpl: ConnectorFetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const request = {
      method: init?.method ?? "GET",
      path: new URL(String(input)).pathname,
      host: headers.get("host"),
      contentType: headers.get("content-type"),
      body: typeof init?.body === "string" ? init.body : "",
    };
    requests.push(request);
    return respond(request, requests.length - 1);
  };
  return new SafePublicHttpClient({
    fetchImpl,
    resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
  });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("Workday discovery connector", () => {
  test("uses one configured bounded search and one bounded detail read to produce a normalized job", async () => {
    const search = await fixture("search-success.json");
    const detail = await fixture("detail-success.json");
    const requests: ObservedRequest[] = [];
    const client = fixtureClient((_request, index) => jsonResponse(index === 0 ? search : detail), requests);
    const connector = createWorkdayConnector({
      host: HOST,
      tenant: "acme",
      site: "External",
      searchText: "software engineer",
      id: "acme-workday",
      name: "Acme careers",
      maxJobs: 1,
    }, client);

    const result = await connector.sync(new AbortController().signal);

    expect(connector).toMatchObject({ id: "acme-workday", name: "Acme careers", kind: "workday" });
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/wday/cxs/acme/External/jobs",
        host: HOST,
        contentType: "application/json",
        body: JSON.stringify({
          appliedFacets: {},
          limit: 1,
          offset: 0,
          searchText: "software engineer",
        }),
      },
      {
        method: "GET",
        path: "/wday/cxs/acme/External/job/Toronto-ON/Software-Engineer-Platform_R-1042",
        host: HOST,
        contentType: null,
        body: "",
      },
    ]);
    expect(result.completeSnapshot).toBeTrue();
    expect(result.provenance).toBe("Workday acme/External; omitted unusable jobs: 0");
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.sourceItemId).toBe("2a590fb90f21ea2f3e049dd59e426069");
    expect(item).toMatchObject({
      sourceUrl: "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Toronto-ON/Software-Engineer-Platform_R-1042",
      canonicalUrl: "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Toronto-ON/Software-Engineer-Platform_R-1042",
      applyUrl: "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Toronto-ON/Software-Engineer-Platform_R-1042",
      title: "Software Engineer, Platform",
      company: "Acme Corporation",
      location: "Toronto, ON",
      postedAt: Date.parse("2026-07-31"),
      requisitionId: "R-1042",
    });
    expect(item.description.length).toBeGreaterThanOrEqual(40);
    expect(item.description).toContain("Build dependable platform software");
    expect(item.description).not.toContain("private fixture marker");
    expect(item.description).not.toContain("<p>");
  });

  test("paginates a capped search, deduplicates paths, and keeps an incomplete snapshot conservative", async () => {
    const firstPage = await fixture("search-paged-1.json");
    const secondPage = await fixture("search-paged-2.json");
    const firstDetail = await fixture("detail-success.json");
    const secondDetail = await fixture("detail-success-2.json");
    const requests: ObservedRequest[] = [];
    const client = fixtureClient((request) => {
      if (request.method === "POST") {
        const payload: unknown = JSON.parse(request.body);
        if (!payload || typeof payload !== "object" || !("offset" in payload) || typeof payload.offset !== "number") {
          throw new Error("expected a paginated Workday search request");
        }
        return jsonResponse(payload.offset === 0 ? firstPage : secondPage);
      }
      return jsonResponse(request.path.includes("Data-Engineer_R-2048") ? secondDetail : firstDetail);
    }, requests);
    const connector = createWorkdayConnector({
      host: HOST,
      tenant: "acme",
      site: "External",
      searchText: "engineer",
      maxJobs: 3,
    }, client);

    const result = await connector.sync(new AbortController().signal);

    expect(requests.map(({ method, body }) => ({ method, body }))).toEqual([
      {
        method: "POST",
        body: JSON.stringify({
          appliedFacets: {},
          limit: 3,
          offset: 0,
          searchText: "engineer",
        }),
      },
      {
        method: "POST",
        body: JSON.stringify({
          appliedFacets: {},
          limit: 2,
          offset: 1,
          searchText: "engineer",
        }),
      },
      { method: "GET", body: "" },
      { method: "GET", body: "" },
    ]);
    expect(result.items.map((item) => item.requisitionId)).toEqual(["R-1042", "R-2048"]);
    expect(result.completeSnapshot).toBeFalse();
    expect(result.provenance).toBe("Workday acme/External; omitted unusable jobs: 0");
  });

  test("omits loopback, off-origin, and alternate-port source or apply URLs", async () => {
    const search = await fixture("search-success.json");
    const maliciousDetails = [
      "detail-loopback-source.json",
      "detail-off-origin-source.json",
      "detail-alternate-port-apply.json",
    ] as const;

    for (const detailName of maliciousDetails) {
      const detail = await fixture(detailName);
      const requests: ObservedRequest[] = [];
      const client = fixtureClient((_request, index) => jsonResponse(index === 0 ? search : detail), requests);
      const connector = createWorkdayConnector({
        host: HOST,
        tenant: "acme",
        site: "External",
        searchText: "software engineer",
        maxJobs: 1,
      }, client);

      const result = await connector.sync(new AbortController().signal);

      expect(requests).toHaveLength(2);
      expect(result).toEqual({
        items: [],
        completeSnapshot: false,
        provenance: "Workday acme/External; omitted unusable jobs: 1",
      });
    }
  });

  test("fails an access denial once with a fixed error and does not expose the response body", async () => {
    const denied = await fixture("denied.json");
    const requests: ObservedRequest[] = [];
    const client = fixtureClient(() => jsonResponse(denied, 403), requests);
    const connector = createWorkdayConnector({
      host: HOST,
      tenant: "acme",
      site: "External",
      searchText: "engineer",
    }, client);

    try {
      await connector.sync(new AbortController().signal);
      throw new Error("expected Workday denial to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Workday public job source is unavailable");
      expect(String(error)).not.toContain("fixture-private-upstream-denial-marker");
      expect(String(error)).not.toContain("Authentication required");
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/wday/cxs/acme/External/jobs",
    });
  });

  test("omits a detail whose description is missing and reports the bounded omission", async () => {
    const search = await fixture("search-missing-description.json");
    const detail = await fixture("detail-missing-description.json");
    const requests: ObservedRequest[] = [];
    const client = fixtureClient((_request, index) => jsonResponse(index === 0 ? search : detail), requests);
    const connector = createWorkdayConnector({
      host: HOST,
      tenant: "acme",
      site: "External",
      searchText: "data engineer",
      maxJobs: 1,
    }, client);

    const result = await connector.sync(new AbortController().signal);

    expect(requests).toHaveLength(2);
    expect(result).toEqual({
      items: [],
      completeSnapshot: false,
      provenance: "Workday acme/External; omitted unusable jobs: 1",
    });
  });
});
