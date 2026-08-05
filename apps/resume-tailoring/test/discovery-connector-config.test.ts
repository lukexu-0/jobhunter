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
  test("constructs only the five approved repository feeds", () => {
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
        id: "simplify-summer-2027-off-season",
        name: "Simplify Summer 2027 Off-Season Internships",
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

  test("targets the approved alternate repository files", async () => {
    const requests: URL[] = [];
    const connectors = createDiscoveryConnectors({
      env: { GITHUB_TOKEN: undefined },
      fetchImpl: async (input) => {
        requests.push(new URL(input));
        return new Response("", { headers: { "content-type": "text/plain" } });
      },
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    for (const id of ["simplify-summer-2027-off-season", "zapply-underclassmen"]) {
      await connectors.find((connector) => connector.id === id)!
        .sync(new AbortController().signal);
    }

    expect(requests.map(({ pathname }) => pathname)).toEqual([
      "/repos/SimplifyJobs/Summer2027-Internships/contents/README-Off-Season.md",
      "/repos/zapplyjobs/Internships-2027/contents/README.md",
    ]);
    expect(requests.map((request) => request.searchParams.get("ref")))
      .toEqual(["dev", "main"]);
  });
});
