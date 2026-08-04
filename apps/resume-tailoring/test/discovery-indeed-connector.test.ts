import { describe, expect, test } from "bun:test";

import { createDiscoveryConnectorsFromEnvironment } from "../src/discovery/connectors";
import { createIndeedConnector } from "../src/discovery/connectors/indeed";
import { SafePublicHttpClient } from "../src/discovery/connectors/http";
import type { ConnectorFetch } from "../src/discovery/connectors/http";

const ENDPOINT = "https://mcp.indeed.com/claude/mcp";
const PUBLIC_ADDRESS = "93.184.216.34";
const SESSION_ID = "indeed-session-1";

type RecordedRequest = {
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers: Headers;
  readonly logicalUrl: string;
};

function jsonRpc(id: unknown, result: unknown, headers: Record<string, string> = {}): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers });
}

function testClient(
  respond: (request: RecordedRequest) => Response | Promise<Response>,
): { readonly client: SafePublicHttpClient; readonly requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: ConnectorFetch = async (input, init) => {
    const physical = new URL(String(input));
    const headers = new Headers(init?.headers);
    const logicalUrl = `https://${headers.get("host")}${physical.pathname}${physical.search}`;
    const body = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
    const request = { body, headers, logicalUrl };
    requests.push(request);
    return respond(request);
  };
  return {
    client: new SafePublicHttpClient({
      fetchImpl,
      resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    }),
    requests,
  };
}

function methodOf(request: RecordedRequest): string {
  return typeof request.body.method === "string" ? request.body.method : "";
}
const SEARCH_TOOL = {
  name: "discovered_job_search",
  description: "Search jobs using a query",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      location: { type: "string" },
      limit: { type: "integer" },
    },
    required: ["query"],
  },
} as const;

const INLINE_JOB = {
  id: "job-inline",
  url: "https://www.indeed.com/viewjob?jk=job-inline",
  title: "Platform Engineering Intern",
  company: "Example Labs",
  description: "Build reliable platform services with a thoughtful and collaborative engineering team.",
} as const;

function initializationResponse(request: RecordedRequest): Response {
  return jsonRpc(request.body.id, {
    protocolVersion: "2025-03-26",
    capabilities: { tools: {} },
    serverInfo: { name: "Indeed MCP", version: "beta" },
  }, { "mcp-session-id": SESSION_ID });
}

function connectorWith(
  client: SafePublicHttpClient,
  resolveAccessToken: (signal: AbortSignal) => Promise<string | undefined> = async () => "fixture-token",
) {
  return createIndeedConnector({
    id: "indeed-fixture",
    searches: [{ query: "intern" }],
    maxJobs: 5,
  }, resolveAccessToken, client);
}


describe("Indeed Streamable HTTP MCP discovery connector", () => {
  test("discovers realistic search/detail tools and normalizes authenticated JSON/SSE results", async () => {
    const { client, requests } = testClient((request) => {
      const id = request.body.id;
      switch (methodOf(request)) {
        case "initialize":
          return jsonRpc(id, {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "Indeed MCP", version: "beta" },
          }, { "mcp-session-id": SESSION_ID });
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return new Response([
            "event: message",
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                tools: [
                  {
                    name: "search_open_roles",
                    description: "Search Indeed jobs by keyword and location",
                    inputSchema: {
                      type: "object",
                      properties: {
                        what: { type: "string", description: "Job search query" },
                        where: { type: "string", description: "Search location" },
                        resultsLimit: { type: "integer", minimum: 1, maximum: 100 },
                      },
                      required: ["what"],
                    },
                  },
                  {
                    name: "fetch_job_posting",
                    description: "Fetch full details for one job posting",
                    inputSchema: {
                      type: "object",
                      properties: { jobId: { type: "string" } },
                      required: ["jobId"],
                    },
                  },
                ],
              },
            })}`,
            "",
          ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        case "tools/call": {
          const params = request.body.params as { name: string; arguments: Record<string, unknown> };
          if (params.name === "search_open_roles") {
            expect(params.arguments).toEqual({ what: "software intern", where: "Remote", resultsLimit: 2 });
            return jsonRpc(id, {
              content: [],
              structuredContent: {
                jobs: [{
                  id: "job-123",
                  url: "https://www.indeed.com/viewjob?jk=job-123&utm_source=fixture",
                  title: "  Software Engineer Intern  ",
                  location: "Remote",
                  datePosted: "2026-08-01",
                }],
              },
            });
          }
          expect(params).toEqual({ name: "fetch_job_posting", arguments: { jobId: "job-123" } });
          return jsonRpc(id, {
            content: [{
              type: "text",
              text: JSON.stringify({
                id: "job-123",
                companyName: "Example Labs",
                description: "<p>Build dependable product features with a collaborative engineering team.</p>",
                applyUrl: "https://www.indeed.com/viewjob?jk=job-123&utm_campaign=fixture",
              }),
            }],
          });
        }
        default:
          throw new Error(`unexpected MCP method ${methodOf(request)}`);
      }
    });
    const tokenSignals: AbortSignal[] = [];
    const connector = createDiscoveryConnectorsFromEnvironment({
      env: {
        JOBHUNTER_DISCOVERY_SOURCES: JSON.stringify([{
          kind: "indeed",
          id: "indeed-internships",
          name: "Indeed internships",
          searches: [{ query: "  software intern  ", location: "  Remote  " }],
          maxJobs: 2,
        }]),
      },
      httpClient: client,
      indeedAccessTokenResolver: async (signal) => {
        tokenSignals.push(signal);
        return "current-access-token";
      },
    }).find(({ id }) => id === "indeed-internships");
    expect(connector).toBeDefined();
    const signal = new AbortController().signal;

    const result = await connector!.sync(signal);

    expect(connector).toMatchObject({ id: "indeed-internships", name: "Indeed internships", kind: "indeed" });
    expect(tokenSignals).toEqual([signal]);
    expect(result.completeSnapshot).toBeFalse();
    expect(result.provenance).toBeUndefined();
    expect(result.items).toEqual([{
      sourceItemId: "job-123",
      sourceUrl: "https://www.indeed.com/viewjob?jk=job-123",
      canonicalUrl: "https://www.indeed.com/viewjob?jk=job-123",
      applyUrl: "https://www.indeed.com/viewjob?jk=job-123",
      title: "Software Engineer Intern",
      company: "Example Labs",
      location: "Remote",
      description: "Build dependable product features with a collaborative engineering team.",
      postedAt: Date.parse("2026-08-01"),
    }]);
    expect(requests).toHaveLength(5);
    for (const request of requests) {
      expect(request.logicalUrl).toBe(ENDPOINT);
      expect(request.headers.get("authorization")).toBe("Bearer current-access-token");
      expect(request.headers.get("accept")).toBe("application/json, text/event-stream");
      expect(request.headers.get("content-type")).toBe("application/json");
    }
    expect(requests[0]!.headers.get("mcp-session-id")).toBeNull();
    expect(requests[0]!.headers.get("mcp-protocol-version")).toBeNull();
    for (const request of requests.slice(1)) {
      expect(request.headers.get("mcp-session-id")).toBe(SESSION_ID);
      expect(request.headers.get("mcp-protocol-version")).toBe("2025-03-26");
    }
  });

  test("flattens bounded JSON-RPC SSE batches and rejects nested or oversized batches", async () => {
    const batched = testClient((request) => {
      switch (methodOf(request)) {
        case "initialize":
          return initializationResponse(request);
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return new Response(`data: ${JSON.stringify([
            { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
            { jsonrpc: "2.0", id: request.body.id, result: { tools: [SEARCH_TOOL] } },
          ])}\n\n`, { headers: { "content-type": "text/event-stream" } });
        case "tools/call":
          return jsonRpc(request.body.id, { structuredContent: { jobs: [INLINE_JOB] }, content: [] });
        default:
          throw new Error("unexpected method");
      }
    });

    const result = await connectorWith(batched.client).sync(new AbortController().signal);
    expect(result.items.map(({ sourceItemId }) => sourceItemId)).toEqual(["job-inline"]);

    for (const batch of [
      [[{ jsonrpc: "2.0", id: 3, result: { tools: [] } }]],
      Array.from({ length: 101 }, () => ({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })),
    ]) {
      const invalid = testClient((request) => {
        switch (methodOf(request)) {
          case "initialize":
            return initializationResponse(request);
          case "notifications/initialized":
            return new Response(null, { status: 202 });
          case "tools/list":
            return new Response(`data: ${JSON.stringify(batch)}\n\n`, {
              headers: { "content-type": "text/event-stream" },
            });
          default:
            throw new Error("tools must not be called");
        }
      });
      await expect(connectorWith(invalid.client).sync(new AbortController().signal))
        .rejects.toThrow("The Indeed job source is unavailable");
    }
  });
  test("follows bounded opaque tools/list pagination before calling the discovered tool", async () => {
    let toolsPage = 0;
    const { client, requests } = testClient((request) => {
      const id = request.body.id;
      switch (methodOf(request)) {
        case "initialize":
          return initializationResponse(request);
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list": {
          toolsPage += 1;
          const params = request.body.params as Record<string, unknown>;
          if (toolsPage === 1) {
            expect(params).toEqual({});
            return jsonRpc(id, { tools: [], nextCursor: "opaque-page-token" });
          }
          expect(params).toEqual({ cursor: "opaque-page-token" });
          return jsonRpc(id, { tools: [SEARCH_TOOL] });
        }
        case "tools/call":
          return jsonRpc(id, { structuredContent: { jobs: [INLINE_JOB] }, content: [] });
        default:
          throw new Error("unexpected method");
      }
    });

    const result = await connectorWith(client).sync(new AbortController().signal);

    expect(result.items.map(({ sourceItemId }) => sourceItemId)).toEqual(["job-inline"]);
    expect(result.completeSnapshot).toBeFalse();
    expect(requests.filter((request) => methodOf(request) === "tools/list")).toHaveLength(2);
  });

  test("reinitializes once after a session-bound 404 and retries only the read-only tool call", async () => {
    let initializeCount = 0;
    let searchCallCount = 0;
    const { client, requests } = testClient((request) => {
      switch (methodOf(request)) {
        case "initialize":
          initializeCount += 1;
          expect(request.headers.get("mcp-session-id")).toBeNull();
          return jsonRpc(request.body.id, {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "Indeed MCP", version: "beta" },
          }, { "mcp-session-id": `indeed-session-${initializeCount}` });
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return jsonRpc(request.body.id, { tools: [SEARCH_TOOL] });
        case "tools/call":
          searchCallCount += 1;
          if (searchCallCount === 1) {
            expect(request.headers.get("mcp-session-id")).toBe("indeed-session-1");
            return new Response(null, { status: 404 });
          }
          expect(request.headers.get("mcp-session-id")).toBe("indeed-session-2");
          return jsonRpc(request.body.id, { structuredContent: { jobs: [INLINE_JOB] }, content: [] });
        default:
          throw new Error("unexpected method");
      }
    });

    const result = await connectorWith(client).sync(new AbortController().signal);

    expect(result.items.map(({ sourceItemId }) => sourceItemId)).toEqual(["job-inline"]);
    expect(initializeCount).toBe(2);
    expect(searchCallCount).toBe(2);
    expect(requests.filter((request) => methodOf(request) === "tools/call")).toHaveLength(2);
  });

  test("resolves the current bearer again for every synchronization", async () => {
    const { client, requests } = testClient((request) => {
      switch (methodOf(request)) {
        case "initialize":
          return initializationResponse(request);
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return jsonRpc(request.body.id, { tools: [SEARCH_TOOL] });
        case "tools/call":
          return jsonRpc(request.body.id, { structuredContent: { jobs: [INLINE_JOB] }, content: [] });
        default:
          throw new Error("unexpected method");
      }
    });
    let resolution = 0;
    const connector = connectorWith(client, async () => {
      resolution += 1;
      return `fresh-token-${resolution}`;
    });

    await connector.sync(new AbortController().signal);
    await connector.sync(new AbortController().signal);

    expect(resolution).toBe(2);
    expect(requests.filter((request) => methodOf(request) === "initialize")
      .map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer fresh-token-1",
      "Bearer fresh-token-2",
    ]);
  });

  test("caps configured results and records bounded provenance for the omission", async () => {
    const jobs = Array.from({ length: 6 }, (_, index) => ({
      ...INLINE_JOB,
      id: `job-${index}`,
      url: `https://www.indeed.com/viewjob?jk=job-${index}`,
    }));
    const { client } = testClient((request) => {
      switch (methodOf(request)) {
        case "initialize":
          return initializationResponse(request);
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return jsonRpc(request.body.id, { tools: [SEARCH_TOOL] });
        case "tools/call":
          return jsonRpc(request.body.id, { structuredContent: { jobs }, content: [] });
        default:
          throw new Error("unexpected method");
      }
    });

    const result = await connectorWith(client).sync(new AbortController().signal);

    expect(result.items).toHaveLength(5);
    expect(result.completeSnapshot).toBeFalse();
    expect(result.provenance).toBe("indeed result cap reached");
  });

  test("rejects wrong media, malformed JSON/SSE, mismatched IDs, and oversized finite bodies safely", async () => {
    const scenarios = [
      (request: RecordedRequest) => new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: request.body.id,
        result: {},
      }), { headers: { "content-type": "text/plain" } }),
      () => new Response("{", { headers: { "content-type": "application/json" } }),
      () => new Response("event: message\ndata: {\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
      (request: RecordedRequest) => jsonRpc(Number(request.body.id) + 1, {
        protocolVersion: "2025-03-26",
        capabilities: {},
        serverInfo: {},
      }),
      () => new Response("x".repeat(1024 * 1024 + 1), {
        headers: { "content-type": "application/json" },
      }),
      () => new Response(null, {
        status: 302,
        headers: { location: "https://mcp.indeed.com/other-path" },
      }),
    ] as const;

    for (const response of scenarios) {
      const { client, requests } = testClient(response);
      let caught: unknown;
      try {
        await connectorWith(client, async () => "secret-fixture-token").sync(new AbortController().signal);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(String(caught)).not.toContain("secret-fixture-token");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.logicalUrl).toBe(ENDPOINT);
    }
  });

  test("surfaces bounded authorization and unsupported-client failures without response data", async () => {
    const scenarios = [
      { status: 401, message: "Indeed MCP rejected the current authorization" },
      { status: 405, message: "Indeed MCP did not accept this standards-based client" },
    ] as const;
    for (const scenario of scenarios) {
      const { client } = testClient((request) => Response.json({
        jsonrpc: "2.0",
        id: request.body.id,
        error: { code: -32_000, message: "private upstream detail" },
      }, { status: scenario.status }));

      await expect(connectorWith(client).sync(new AbortController().signal))
        .rejects.toThrow(scenario.message);
    }
  });

  test("rejects tools/call isError and non-JSON text content", async () => {
    for (const callResult of [
      { isError: true, content: [{ type: "text", text: "private upstream failure" }] },
      { content: [{ type: "text", text: "not JSON" }] },
    ]) {
      const { client } = testClient((request) => {
        switch (methodOf(request)) {
          case "initialize":
            return initializationResponse(request);
          case "notifications/initialized":
            return new Response(null, { status: 202 });
          case "tools/list":
            return jsonRpc(request.body.id, { tools: [SEARCH_TOOL] });
          case "tools/call":
            return jsonRpc(request.body.id, callResult);
          default:
            throw new Error("unexpected method");
        }
      });

      await expect(connectorWith(client).sync(new AbortController().signal))
        .rejects.toThrow("The Indeed job source is unavailable");
    }
  });

  test("returns bounded incomplete provenance for missing, ambiguous, and unmappable search tools", async () => {
    const unknownRequired = {
      ...SEARCH_TOOL,
      name: "account_scoped_job_search",
      inputSchema: {
        ...SEARCH_TOOL.inputSchema,
        properties: {
          ...SEARCH_TOOL.inputSchema.properties,
          account: { type: "string" },
        },
        required: ["query", "account"],
      },
    } as const;
    const scenarios = [
      {
        tools: [],
        provenance: "indeed search tool was not available",
      },
      {
        tools: [
          SEARCH_TOOL,
          { ...SEARCH_TOOL, name: "other_job_search", description: "Find jobs by query" },
        ],
        provenance: "indeed search tool discovery was ambiguous",
      },
      {
        tools: [unknownRequired],
        provenance: "indeed search tool has unsupported required arguments",
      },
      {
        tools: [{
          name: "prototype_job_search",
          description: "Search jobs",
          inputSchema: {
            type: "object",
            properties: { constructor: { type: "string" } },
            required: ["constructor"],
          },
        }],
        provenance: "indeed search tool was not available",
      },
    ] as const;
    for (const scenario of scenarios) {
      const { client, requests } = testClient((request) => {
        switch (methodOf(request)) {
          case "initialize":
            return initializationResponse(request);
          case "notifications/initialized":
            return new Response(null, { status: 202 });
          case "tools/list":
            return jsonRpc(request.body.id, { tools: scenario.tools });
          default:
            throw new Error("tools must not be called");
        }
      });

      const result = await connectorWith(client).sync(new AbortController().signal);

      expect(result).toEqual({
        items: [],
        completeSnapshot: false,
        provenance: scenario.provenance,
      });
      expect(requests.some((request) => methodOf(request) === "tools/call")).toBeFalse();
    }
  });

  test("rejects tool mappings whose selected fields have unsupported schema constraints", async () => {
    const constrainedSchemas = [
      {
        ...SEARCH_TOOL.inputSchema,
        properties: {
          ...SEARCH_TOOL.inputSchema.properties,
          query: { type: "string", enum: ["intern"] },
        },
      },
      {
        ...SEARCH_TOOL.inputSchema,
        properties: {
          ...SEARCH_TOOL.inputSchema.properties,
          location: { type: "string", pattern: "^Remote$" },
        },
      },
      {
        ...SEARCH_TOOL.inputSchema,
        properties: {
          ...SEARCH_TOOL.inputSchema.properties,
          limit: { type: "integer", multipleOf: 5 },
        },
      },
      {
        ...SEARCH_TOOL.inputSchema,
        properties: {
          ...SEARCH_TOOL.inputSchema.properties,
          limit: { type: "integer", exclusiveMaximum: 10 },
        },
      },
    ] as const;

    for (const inputSchema of constrainedSchemas) {
      const { client, requests } = testClient((request) => {
        switch (methodOf(request)) {
          case "initialize":
            return initializationResponse(request);
          case "notifications/initialized":
            return new Response(null, { status: 202 });
          case "tools/list":
            return jsonRpc(request.body.id, { tools: [{ ...SEARCH_TOOL, inputSchema }] });
          default:
            throw new Error("tools must not be called");
        }
      });

      const result = await connectorWith(client).sync(new AbortController().signal);

      expect(result).toEqual({
        items: [],
        completeSnapshot: false,
        provenance: "indeed search tool has unsupported schema constraints",
      });
      expect(requests.some((request) => methodOf(request) === "tools/call")).toBeFalse();
    }

    const detailConstrained = testClient((request) => {
      switch (methodOf(request)) {
        case "initialize":
          return initializationResponse(request);
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return jsonRpc(request.body.id, {
            tools: [
              SEARCH_TOOL,
              {
                name: "fetch_job_details",
                description: "Fetch details for a job posting",
                inputSchema: {
                  type: "object",
                  properties: { jobId: { type: "string", pattern: "^[a-z]+$" } },
                  required: ["jobId"],
                },
              },
            ],
          });
        case "tools/call":
          return jsonRpc(request.body.id, {
            structuredContent: {
              jobs: [{
                id: "needs-detail",
                url: "https://www.indeed.com/viewjob?jk=needs-detail",
                title: "Software Intern",
              }],
            },
            content: [],
          });
        default:
          throw new Error("unexpected method");
      }
    });

    const result = await connectorWith(detailConstrained.client).sync(new AbortController().signal);
    expect(result.items).toEqual([]);
    expect(result.provenance).toContain("indeed detail tool has unsupported schema constraints");
    expect(detailConstrained.requests.filter((request) => methodOf(request) === "tools/call"))
      .toHaveLength(1);
  });

  test("keeps job and requisition identities distinct, merges detail requisitions, and bounds locations", async () => {
    const detailTool = {
      name: "fetch_job_details",
      description: "Fetch details for one job posting",
      inputSchema: {
        type: "object",
        properties: { requisitionId: { type: "string" } },
        required: ["requisitionId"],
      },
    } as const;
    const { client } = testClient((request) => {
      switch (methodOf(request)) {
        case "initialize":
          return initializationResponse(request);
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return jsonRpc(request.body.id, { tools: [SEARCH_TOOL, detailTool] });
        case "tools/call": {
          const params = request.body.params as { name: string; arguments: Record<string, unknown> };
          if (params.name === SEARCH_TOOL.name) {
            return jsonRpc(request.body.id, {
              structuredContent: {
                jobs: [
                  {
                    id: "job-123",
                    requisitionId: "REQ-77",
                    url: "https://www.indeed.com/viewjob?jk=job-123",
                    title: "Software Intern",
                  },
                  {
                    id: "job-mismatch",
                    requisitionId: "REQ-88",
                    url: "https://www.indeed.com/viewjob?jk=job-mismatch",
                    title: "Platform Intern",
                  },
                ],
              },
              content: [],
            });
          }
          const requisitionId = String(params.arguments.requisitionId);
          expect(params.arguments).toEqual({ requisitionId });
          return jsonRpc(request.body.id, {
            structuredContent: requisitionId === "REQ-77"
              ? {
                requisitionId,
                company: "Example Labs",
                description: INLINE_JOB.description,
                location: "x".repeat(501),
              }
              : {
                id: "different-job",
                requisitionId,
                company: "Example Labs",
                description: INLINE_JOB.description,
              },
            content: [],
          });
        }
        default:
          throw new Error("unexpected method");
      }
    });

    const result = await connectorWith(client).sync(new AbortController().signal);

    expect(result.items).toEqual([{
      sourceItemId: "job-123",
      sourceUrl: "https://www.indeed.com/viewjob?jk=job-123",
      canonicalUrl: "https://www.indeed.com/viewjob?jk=job-123",
      applyUrl: "https://www.indeed.com/viewjob?jk=job-123",
      title: "Software Intern",
      company: "Example Labs",
      description: INLINE_JOB.description,
      requisitionId: "REQ-77",
    }]);
    expect(result.provenance).toContain("indeed omitted unusable jobs: 1");
  });

  test("omits jobs that need unavailable details and reports schema omissions", async () => {
    const jobs = [
      null,
      {
        id: "needs-detail",
        url: "https://www.indeed.com/viewjob?jk=needs-detail",
        title: "Software Intern",
        company: "Example",
      },
      {
        url: "https://www.indeed.com/viewjob?jk=missing-id",
        title: "Missing ID",
        company: "Example",
        description: INLINE_JOB.description,
      },
      {
        id: "insecure-url",
        url: "http://www.indeed.com/viewjob?jk=insecure-url",
        title: "Insecure URL",
        company: "Example",
        description: INLINE_JOB.description,
      },
      INLINE_JOB,
    ];
    const { client } = testClient((request) => {
      switch (methodOf(request)) {
        case "initialize":
          return initializationResponse(request);
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return jsonRpc(request.body.id, { tools: [SEARCH_TOOL] });
        case "tools/call":
          return jsonRpc(request.body.id, { structuredContent: { jobs }, content: [] });
        default:
          throw new Error("unexpected method");
      }
    });
    const result = await connectorWith(client).sync(new AbortController().signal);

    expect(result.items.map(({ sourceItemId }) => sourceItemId)).toEqual(["job-inline"]);
    expect(result.completeSnapshot).toBeFalse();
    expect(result.provenance).toContain("indeed detail tool was not available");
    expect(result.provenance).toContain("indeed omitted unusable jobs: 4");
  });

  test("enforces JSON shape, job-array, and tools-page bounds", async () => {
    const tooDeep: Record<string, unknown> = {};
    let nested = tooDeep;
    for (let depth = 0; depth < 20; depth += 1) {
      const child: Record<string, unknown> = {};
      nested.child = child;
      nested = child;
    }
    const boundedScenarios = [
      (request: RecordedRequest) => jsonRpc(request.body.id, {
        protocolVersion: "2025-03-26",
        capabilities: {},
        serverInfo: {},
        tooDeep,
      }),
      (request: RecordedRequest) => jsonRpc(request.body.id, {
        protocolVersion: "2025-03-26",
        capabilities: {},
        serverInfo: { name: "x".repeat(100_001) },
      }),
    ] as const;
    for (const response of boundedScenarios) {
      const { client } = testClient(response);
      await expect(connectorWith(client).sync(new AbortController().signal))
        .rejects.toThrow("The Indeed job source is unavailable");
    }

    const tooManyJobs = await (async () => {
      const { client } = testClient((request) => {
        switch (methodOf(request)) {
          case "initialize":
            return initializationResponse(request);
          case "notifications/initialized":
            return new Response(null, { status: 202 });
          case "tools/list":
            return jsonRpc(request.body.id, { tools: [SEARCH_TOOL] });
          case "tools/call":
            return jsonRpc(request.body.id, {
              structuredContent: { jobs: Array.from({ length: 501 }, () => INLINE_JOB) },
              content: [],
            });
          default:
            throw new Error("unexpected method");
        }
      });
      return connectorWith(client);
    })();
    await expect(tooManyJobs.sync(new AbortController().signal))
      .rejects.toThrow("The Indeed job source is unavailable");

    let pages = 0;
    const paged = testClient((request) => {
      switch (methodOf(request)) {
        case "initialize":
          return initializationResponse(request);
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          pages += 1;
          return jsonRpc(request.body.id, { tools: [], nextCursor: `opaque-${pages}` });
        default:
          throw new Error("unexpected method");
      }
    });
    await expect(connectorWith(paged.client).sync(new AbortController().signal))
      .rejects.toThrow("The Indeed job source is unavailable");
    expect(pages).toBe(10);
  });

  test("does not access the network without a token and preserves caller abort", async () => {
    const noToken = testClient(() => {
      throw new Error("network must not run");
    });
    await expect(connectorWith(noToken.client, async () => undefined).sync(new AbortController().signal))
      .rejects.toThrow("Indeed sign-in is required");
    expect(noToken.requests).toEqual([]);

    const controller = new AbortController();
    const reason = new DOMException("caller stopped", "AbortError");
    controller.abort(reason);
    let resolvedToken = false;
    await expect(connectorWith(noToken.client, async () => {
      resolvedToken = true;
      return "unused";
    }).sync(controller.signal)).rejects.toBe(reason);
    expect(resolvedToken).toBeFalse();
    expect(noToken.requests).toEqual([]);

    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let networkSignal: AbortSignal | undefined;
    const pendingClient = new SafePublicHttpClient({
      fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        networkSignal = init.signal ?? undefined;
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        markStarted?.();
      }),
      resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    });
    const duringRequest = new AbortController();
    const pending = connectorWith(pendingClient).sync(duringRequest.signal);
    await started;
    const networkReason = new DOMException("stopped during MCP request", "AbortError");
    duringRequest.abort(networkReason);
    await expect(pending).rejects.toBe(networkReason);
    expect(networkSignal?.aborted).toBeTrue();
  });

  test("stops post-response processing when the caller aborts during a tool response", async () => {
    const controller = new AbortController();
    const reason = new DOMException("stopped while processing results", "AbortError");
    const { client, requests } = testClient((request) => {
      switch (methodOf(request)) {
        case "initialize":
          return initializationResponse(request);
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return jsonRpc(request.body.id, { tools: [SEARCH_TOOL] });
        case "tools/call":
          controller.abort(reason);
          return jsonRpc(request.body.id, {
            structuredContent: {
              jobs: Array.from({ length: 100 }, (_, index) => ({
                ...INLINE_JOB,
                id: `job-${index}`,
                url: `https://www.indeed.com/viewjob?jk=job-${index}`,
              })),
            },
            content: [],
          });
        default:
          throw new Error("unexpected method");
      }
    });

    await expect(connectorWith(client).sync(controller.signal)).rejects.toBe(reason);
    expect(requests.filter((request) => methodOf(request) === "tools/call")).toHaveLength(1);
  });
});
