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
        name: "zapply Underclassmen Internships",
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
});
