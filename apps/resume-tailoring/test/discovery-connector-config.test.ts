import { describe, expect, test } from "bun:test";

import { createDiscoveryConnectorsFromEnvironment } from "../src/discovery/connectors";
import { SafePublicHttpClient } from "../src/discovery/connectors/http";

const inertClient = new SafePublicHttpClient({
  fetchImpl: async () => {
    throw new Error("network is not used while constructing connectors");
  },
  resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
});

describe("discovery connector environment factory", () => {
  test("always constructs four distinct built-in repository feeds", () => {
    const connectors = createDiscoveryConnectorsFromEnvironment({ env: {}, httpClient: inertClient });

    expect(connectors.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "simplify-summer-2027", kind: "simplify" },
      { id: "zapply-underclassmen", kind: "zapply" },
      { id: "speedyapply-2027-swe", kind: "speedyapply" },
      { id: "speedyapply-2027-ai", kind: "speedyapply" },
    ]);
    expect(new Set(connectors.map(({ id }) => id)).size).toBe(4);
  });

  test("strictly constructs configured public connector kinds", () => {
    const configured = [
      { kind: "greenhouse", id: "greenhouse-acme", boardToken: "acme", company: "Acme" },
      { kind: "lever", id: "lever-acme", site: "acme", company: "Acme" },
      { kind: "ashby", id: "ashby-acme", boardName: "acme", company: "Acme" },
      { kind: "smartrecruiters", id: "smart-acme", companyIdentifier: "Acme", company: "Acme" },
      { kind: "workable", id: "workable-acme", account: "acme", company: "Acme" },
      { kind: "recruitee", id: "recruitee-acme", subdomain: "acme", company: "Acme" },
      { kind: "personio", id: "personio-acme", account: "acme", company: "Acme" },
      {
        kind: "workday",
        id: "workday-acme",
        host: "acme.wd5.myworkdayjobs.com",
        tenant: "acme",
        site: "External",
        searchText: "intern",
      },
      {
        kind: "linkedin",
        id: "linkedin-internships",
        searchUrls: ["https://www.linkedin.com/jobs/search/?keywords=software%20intern"],
        maxPages: 1,
        maxJobs: 20,
      },
      {
        kind: "job_board",
        id: "board-acme",
        name: "Acme careers",
        listUrl: "https://careers.acme.example/internships",
        maxPages: 2,
        maxJobs: 50,
        list: {
          rowSelector: ".job",
          title: { selector: ".title" },
          company: { selector: ".company" },
          detailUrl: { selector: "a.detail", attribute: "href" },
          applyUrl: { selector: "a.apply", attribute: "href" },
          nextPage: { selector: "a.next", attribute: "href" },
        },
        detail: { descriptionSelector: ".description" },
      },
      {
        kind: "indeed",
        id: "indeed-internships",
        name: "Indeed internships",
        searches: [
          { query: "software intern", location: "Remote" },
          { query: "machine learning intern" },
        ],
        maxJobs: 50,
      },
    ] as const;

    const connectors = createDiscoveryConnectorsFromEnvironment({
      env: { JOBHUNTER_DISCOVERY_SOURCES: JSON.stringify(configured) },
      httpClient: inertClient,
    });

    expect(connectors.slice(4).map(({ id, kind }) => ({ id, kind }))).toEqual(configured.map(({ id, kind }) => ({ id, kind })));
  });

  test("keeps four built-ins while accepting at most 96 configured sources", () => {
    const configured = [
      ...Array.from({ length: 95 }, (_, index) => ({
        kind: "lever",
        id: `bounded-${index}`,
        site: `account-${index}`,
        company: `Company ${index}`,
      })),
      {
        kind: "indeed",
        id: "indeed-bounded",
        searches: [{ query: "intern" }],
      },
    ];

    const connectors = createDiscoveryConnectorsFromEnvironment({
      env: { JOBHUNTER_DISCOVERY_SOURCES: JSON.stringify(configured) },
      httpClient: inertClient,
    });

    expect(connectors).toHaveLength(100);
    expect(connectors.slice(0, 4).map(({ kind }) => kind)).toEqual([
      "simplify",
      "zapply",
      "speedyapply",
      "speedyapply",
    ]);
    expect(connectors.at(-1)).toMatchObject({ id: "indeed-bounded", kind: "indeed" });
  });

  test("rejects malformed, unknown, extra-key, duplicate, and unsafe configuration with redacted errors", () => {
    const invalidValues = [
      "not json: super-secret",
      JSON.stringify({ kind: "lever", site: "secret" }),
      JSON.stringify([{ kind: "unknown", id: "x", token: "super-secret" }]),
      JSON.stringify([{ kind: "lever", id: "x", site: "acme", company: "Acme", token: "super-secret" }]),
      JSON.stringify([
        { kind: "lever", id: "duplicate", site: "one", company: "One" },
        { kind: "ashby", id: "duplicate", boardName: "two", company: "Two" },
      ]),
      JSON.stringify([{ kind: "linkedin", id: "private", searchUrls: ["http://127.0.0.1/jobs"] }]),
      JSON.stringify([{
        kind: "linkedin",
        id: "alternate-port",
        searchUrls: ["https://www.linkedin.com:8443/jobs/search/?keywords=intern"],
      }]),
      JSON.stringify(Array.from({ length: 97 }, (_, index) => ({
        kind: "lever",
        id: `too-many-${index}`,
        site: `account-${index}`,
        company: `Company ${index}`,
      }))),
      JSON.stringify([{
        kind: "job_board",
        id: "unsafe-selector",
        name: "Unsafe",
        listUrl: "https://example.com/jobs",
        list: {
          rowSelector: "script",
          title: { selector: ".title" },
          company: { selector: ".company" },
          detailUrl: { selector: "a", attribute: "onclick" },
          applyUrl: { selector: "a", attribute: "href" },
        },
        detail: { descriptionSelector: ".description" },
      }]),
      JSON.stringify([{ kind: "indeed", id: "indeed-empty", searches: [] }]),
      JSON.stringify([{
        kind: "indeed",
        id: "indeed-unknown",
        searches: [{ query: "intern", radius: 25 }],
      }]),
      JSON.stringify([{
        kind: "indeed",
        id: "indeed-too-many",
        searches: Array.from({ length: 11 }, (_, index) => ({ query: `intern ${index}` })),
      }]),
      JSON.stringify([{
        kind: "indeed",
        id: "indeed-too-large",
        searches: [{ query: "intern" }],
        maxJobs: 101,
      }]),
      JSON.stringify([{
        kind: "indeed",
        id: "indeed-blank-query",
        searches: [{ query: "   " }],
      }]),
      JSON.stringify([{
        kind: "indeed",
        id: "indeed-long-location",
        searches: [{ query: "intern", location: "x".repeat(201) }],
      }]),
    ];

    for (const value of invalidValues) {
      try {
        createDiscoveryConnectorsFromEnvironment({
          env: { JOBHUNTER_DISCOVERY_SOURCES: value },
          httpClient: inertClient,
        });
        throw new Error("expected configuration to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Invalid JOBHUNTER_DISCOVERY_SOURCES configuration");
        expect(String(error)).not.toContain("super-secret");
      }
    }
  });
});
