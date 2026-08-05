import { describe, expect, test } from "bun:test";

import { createDiscoveryConnectors } from "../src/discovery/connectors";
import { SafePublicHttpClient } from "../src/discovery/connectors/http";

const inertClient = new SafePublicHttpClient({
  fetchImpl: async () => {
    throw new Error("network is not used while constructing connectors");
  },
  resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
});

describe("discovery connector factory", () => {
  test("constructs only the four approved repository feeds", () => {
    const connectors = createDiscoveryConnectors({
      env: { GITHUB_TOKEN: "github-token" },
      httpClient: inertClient,
    });

    expect(connectors.map(({ id, name, kind }) => ({ id, name, kind }))).toEqual([
      {
        id: "simplify-summer-2027",
        name: "Simplify Summer 2027 Internships",
        kind: "simplify",
      },
      {
        id: "zapply-underclassmen",
        name: "zapply 2027 Internships",
        kind: "zapply",
      },
      {
        id: "speedyapply-2027-swe",
        name: "speedyapply 2027 SWE College Jobs",
        kind: "speedyapply",
      },
      {
        id: "speedyapply-2027-ai",
        name: "speedyapply 2027 AI College Jobs",
        kind: "speedyapply",
      },
    ]);
  });

  test("targets the 2027 zapply repository", async () => {
    const requests: URL[] = [];
    const connectors = createDiscoveryConnectors({
      env: { GITHUB_TOKEN: undefined },
      fetchImpl: async (input) => {
        requests.push(new URL(input));
        return new Response("", { headers: { "content-type": "text/plain" } });
      },
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    await connectors.find(({ kind }) => kind === "zapply")!
      .sync(new AbortController().signal);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.pathname)
      .toBe("/repos/zapplyjobs/Internships-2027/contents/README.md");
    expect(requests[0]!.searchParams.get("ref")).toBe("main");
  });
});
