import { describe, expect, test } from "bun:test";

import {
  createGitHubTableConnector,
  parseGitHubInternshipTable,
  parseGitHubRepositoryTables,
} from "../src/discovery/connectors/github";
import { SafePublicHttpClient, type ConnectorFetch } from "../src/discovery/connectors/http";
import { captureHtmlElements } from "../src/discovery/connectors/normalize";
import type {
  DiscoveryConnectorSyncContext,
  DiscoveryKnownItem,
} from "../src/discovery/types";

const table = await Bun.file(new URL("fixtures/discovery/github/table.md", import.meta.url)).text();
const detail = await Bun.file(new URL("fixtures/discovery/github/detail.html", import.meta.url)).text();
const simplifyHtml = await Bun.file(new URL("fixtures/discovery/github/simplify-html.md", import.meta.url)).text();
const zapply = await Bun.file(new URL("fixtures/discovery/github/zapply.md", import.meta.url)).text();
const PUBLIC_ADDRESS = "93.184.216.34";

function clientFor(fetchImpl: ConnectorFetch): SafePublicHttpClient {
  return new SafePublicHttpClient({
    fetchImpl,
    resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
  });
}

function syncContext(
  knownItems: readonly DiscoveryKnownItem[] = [],
): DiscoveryConnectorSyncContext {
  return {
    findKnownItems: (candidates) => knownItems.filter((item) =>
      candidates.some((candidate) =>
        candidate.sourceItemId === item.sourceItemId
        || candidate.canonicalUrl === item.canonicalUrl)),
    loadKnownItems: (candidates) => knownItems.filter((item) =>
      candidates.some((candidate) =>
        candidate.sourceItemId === item.sourceItemId
        || candidate.canonicalUrl === item.canonicalUrl)),
  };
}

describe("GitHub internship table ingestion", () => {
  test("parses every structurally valid standard row without title filtering", () => {
    const parsed = parseGitHubInternshipTable(table);

    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0]).toMatchObject({
      company: "Acme | Labs",
      title: "Software Engineering Intern",
      location: "New York, NY",
      applyUrl: "https://jobs.acme.example/roles/eng-123?utm_source=github",
      postedAt: Date.parse("2026-07-28T00:00:00Z"),
    });
    expect(parsed.rows[2]).toMatchObject({
      company: "Retail Co",
      title: "Store Associate",
      applyUrl: "https://retail.example/jobs/7",
    });
    expect(parsed.closedCount).toBe(1);
    expect(parsed.nonInternshipCount).toBe(0);
  });

  test("accepts a standard row regardless of application URL or title terms", () => {
    const parsed = parseGitHubInternshipTable(`
| Company | Role | Application |
| --- | --- | --- |
| Retail Co | Store Associate | [Apply](https://retail.example/internships/7) |
`);

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      company: "Retail Co",
      title: "Store Associate",
    });
    expect(parsed.nonInternshipCount).toBe(0);
  });

  test("parses current Simplify HTML and zapply section table shapes", async () => {
    const before = Date.now();
    const simplify = await parseGitHubRepositoryTables(simplifyHtml);
    const after = Date.now();
    expect(simplify.rows).toHaveLength(1);
    expect(simplify.rows[0]).toMatchObject({
      company: "SpaceX",
      title: "Software Engineering Intern/Co-op",
      applyUrl: "https://boards.greenhouse.io/spacex/jobs/8621757002?utm_source=Simplify&ref=Simplify",
    });
    expect(simplify.rows[0]!.location).toContain("Palo Alto, CA");
    expect(simplify.rows[0]!.postedAt).toBeGreaterThanOrEqual(before - 2 * 86_400_000);
    expect(simplify.rows[0]!.postedAt).toBeLessThanOrEqual(after - 2 * 86_400_000);

    const programs = parseGitHubInternshipTable(zapply);
    expect(programs.rows.map(({ company, title }) => ({ company, title }))).toEqual([
      { company: "Dropbox", title: "Dropbox SWE intern" },
      { company: "Microsoft", title: "Microsoft Explore (Freshman)" },
    ]);
    expect(programs.unusableCount).toBe(1);
    expect(programs.nonInternshipCount).toBe(1);
  });

  test("inherits Simplify continuation companies only within one HTML table", async () => {
    const parsed = await parseGitHubRepositoryTables(`
<table>
<tr><th>Company</th><th>Role</th><th>Application</th></tr>
<tr><td>Acme</td><td>Software Engineering Intern</td><td><a href="https://jobs.example.com/1">Apply</a></td></tr>
<tr><td>↳</td><td>Data Engineering Intern</td><td><a href="https://jobs.example.com/2">Apply</a></td></tr>
</table>
<table>
<tr><th>Company</th><th>Role</th><th>Application</th></tr>
<tr><td>↳</td><td>Hardware Engineering Intern</td><td><a href="https://jobs.example.com/3">Apply</a></td></tr>
</table>
`);

    expect(parsed.rows.map(({ company, title }) => ({ company, title }))).toEqual([
      { company: "Acme", title: "Software Engineering Intern" },
      { company: "Acme", title: "Data Engineering Intern" },
    ]);
    expect(parsed.unusableCount).toBe(1);
  });

  test("resets continuation inheritance after malformed GFM and HTML rows", async () => {
    const parsed = await parseGitHubRepositoryTables(`
| Company | Role | Application |
| --- | --- | --- |
| Acme | Software Engineering Intern | [Apply](https://jobs.example.com/1) |
| malformed | row |
| ↳ | Data Engineering Intern | [Apply](https://jobs.example.com/2) |

<table>
<tr><th>Company</th><th>Role</th><th>Application</th></tr>
<tr><td>Beta</td><td>Hardware Engineering Intern</td><td><a href="https://jobs.example.com/3">Apply</a></td></tr>
<tr></tr>
<tr><td>↳</td><td>Firmware Engineering Intern</td><td><a href="https://jobs.example.com/4">Apply</a></td></tr>
</table>
`);

    expect(parsed.rows.map(({ company, title }) => ({ company, title }))).toEqual([
      { company: "Acme", title: "Software Engineering Intern" },
      { company: "Beta", title: "Hardware Engineering Intern" },
    ]);
    expect(parsed.unusableCount).toBe(3);
  });

  test("keeps the original application URL when a Simplify mirror appears first", async () => {
    const parsed = await parseGitHubRepositoryTables(`
| Company | Role | Application |
| --- | --- | --- |
| Acme | Software Engineering Intern | [Simplify](https://simplify.jobs/p/6454b1b2-6daf-4a13-9e9f-47209a333d39) [Apply](https://jobs.example.com/internship) |
`);

    expect(parsed.rows[0]).toMatchObject({
      applyUrl: "https://jobs.example.com/internship",
      descriptionUrl: "https://simplify.jobs/p/6454b1b2-6daf-4a13-9e9f-47209a333d39",
    });
  });

  test("upgrades source application links to HTTPS", async () => {
    const parsed = await parseGitHubRepositoryTables(`
| Company | Role | Application |
| --- | --- | --- |
| FocusKPI | AI Business Operations Intern | [Apply](http://focuskpi.applytojob.com/apply/udj57Jky8L/AI-Business-Operations-Intern-Remote-Paid) |
| Block | Applied Research Intern | [Apply](http://block.xyz/careers/jobs/5108007008?gh_jid=5108007008) |
`);

    expect(parsed.rows.map(({ applyUrl }) => applyUrl)).toEqual([
      "https://focuskpi.applytojob.com/apply/udj57Jky8L/AI-Business-Operations-Intern-Remote-Paid",
      "https://block.xyz/careers/jobs/5108007008?gh_jid=5108007008",
    ]);
    expect(parsed.unusableCount).toBe(0);
  });

  test("excludes zapply-shaped rows outside an internship section even when the title says intern", async () => {
    const parsed = await parseGitHubRepositoryTables(`
## Non-Internships
| Name | Year | Note |
| --- | --- | --- |
| [Acme Software Intern](https://jobs.example.com/acme) | 2027 | New graduate |
`);

    expect(parsed.rows).toEqual([]);
    expect(parsed.nonInternshipCount).toBe(1);
  });

  test("rejects malformed base64 GitHub contents", async () => {
    const connector = createGitHubTableConnector({
      id: "malformed-github-base64",
      name: "Malformed GitHub fixture",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async () => new Response(JSON.stringify({
      content: `${Buffer.from(table).toString("base64")}!`,
      encoding: "base64",
    }), { headers: { "content-type": "application/json" } })));

    await expect(connector.sync(new AbortController().signal)).rejects.toThrow(
      "GitHub discovery source is unavailable",
    );
  });

  test("bounds parser records before processing an oversized repository table", async () => {
    const rows = Array.from({ length: 1_000 }, (_, index) =>
      `<tr><td>Company ${index}</td><td>Software Engineering Intern</td><td><a href="https://jobs.example.com/${index}">Apply</a></td></tr>`,
    ).join("\n");
    const oversized = `<table>
<tr><th>Company</th><th>Role</th><th>Application</th></tr>
${rows}
</table>`;

    const parsed = await parseGitHubRepositoryTables(oversized, 3);

    expect(parsed.truncated).toBe(true);
    expect(parsed.rows.length).toBeLessThanOrEqual(3);
  });

  test("caps malformed HTML rows before parsing a later header", async () => {
    const malformed = `<table>
<tr>missing cells</tr>
<tr><td>pre-header cell</td></tr>
<tr><th>Company</th><th>Role</th><th>Application</th></tr>
<tr><td>Acme</td><td>Software Engineering Intern</td><td><a href="https://jobs.example.com/1">Apply</a></td></tr>
</table>`;

    const parsed = await parseGitHubRepositoryTables(malformed, 2);

    expect(parsed.truncated).toBe(true);
    expect(parsed.tableCount).toBe(0);
    expect(parsed.rows).toEqual([]);
  });

  test("caps cells within one HTML row before converting them", async () => {
    const manyCells = `<table><tr>${"<td>x</td>".repeat(101)}</tr></table>`;

    const parsed = await parseGitHubRepositoryTables(manyCells);

    expect(parsed.truncated).toBe(true);
    expect(parsed.rows).toEqual([]);
  });

  test("caps recognized empty GFM tables", () => {
    const emptyTables = Array.from({ length: 101 }, () => `
| Company | Role | Application |
| --- | --- | --- |
`).join("\n");

    const parsed = parseGitHubInternshipTable(emptyTables);

    expect(parsed.tableCount).toBe(100);
    expect(parsed.truncated).toBe(true);
  });

  test("caps empty HTML tables even when they contain no rows", async () => {
    const parsed = await parseGitHubRepositoryTables("<table></table>".repeat(101));

    expect(parsed.tableCount).toBe(0);
    expect(parsed.truncated).toBe(true);
  });

  test("loads every public detail before emitting and keeps bounded row provenance", async () => {
    const seen: Array<{ host: string | null; authorization: string | null }> = [];
    const fetchImpl: ConnectorFetch = async (_input, init) => {
      const headers = new Headers(init.headers);
      seen.push({ host: headers.get("host"), authorization: headers.get("authorization") });
      if (headers.get("host") === "api.github.com") {
        return new Response(table, {
          headers: { "content-type": "text/plain; charset=utf-8", etag: '"table-v1"' },
        });
      }
      return new Response(detail, { headers: { "content-type": "text/html" } });
    };
    const connector = createGitHubTableConnector({
      id: "fixture",
      name: "Fixture internships",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
      githubToken: "private-token",
      detailConcurrency: 2,
    }, clientFor(fetchImpl));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({
      company: "Acme | Labs",
      title: "Software Engineering Intern",
      canonicalUrl: "https://jobs.acme.example/roles/eng-123",
      applyUrl: "https://jobs.acme.example/roles/eng-123",
      sourceUrl: "https://github.com/example/internships/blob/main/README.md#L5",
    });
    expect(result.items[0]!.description).toContain("Responsibilities");
    expect(result.items[0]!.description).not.toContain("window.secret");
    expect(result.provenance).toContain("example/internships@main:README.md");
    expect(seen.filter((request) => request.host === "api.github.com").map((request) => request.authorization))
      .toEqual(["Bearer private-token"]);
    expect(seen.filter((request) => request.host !== "api.github.com").every((request) => request.authorization === null))
      .toBe(true);
  });

  test("fetches unknown details at every age and reuses non-null remembered descriptions", async () => {
    const source = `
| Company | Role | Location | Application | Date |
| --- | --- | --- | --- | --- |
| Recent Co | Software Engineering Intern | Remote | [Apply](https://jobs.example.com/recent) | 2026-07-05 |
| Old Co | Software Engineering Intern | Remote | [Apply](https://jobs.example.com/old) | 2025-01-01 |
| Undated Co | Software Engineering Intern | Remote | [Apply](https://jobs.example.com/undated) | |
| Remembered Co | Software Engineering Intern | Remote | [Apply](https://jobs.example.com/remembered) | 2024-01-01 |
`;
    const detailPaths: string[] = [];
    const client = clientFor(async (input, init) => {
      if (new Headers(init.headers).get("host") === "api.github.com") {
        return new Response(source, { headers: { "content-type": "text/plain" } });
      }
      detailPaths.push(new URL(input).pathname);
      return new Response(detail, { headers: { "content-type": "text/html" } });
    });
    const connector = createGitHubTableConnector({
      id: "incremental",
      name: "Incremental internships",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, client);
    const rememberedDescription = "Previously saved description with enough role detail to remain reusable.";

    const result = await connector.sync(
      new AbortController().signal,
      syncContext([{
        sourceItemId: "remembered",
        canonicalUrl: "https://jobs.example.com/remembered",
        description: rememberedDescription,
      }]),
    );

    expect(result.items.map(({ canonicalUrl }) => canonicalUrl)).toEqual([
      "https://jobs.example.com/recent",
      "https://jobs.example.com/old",
      "https://jobs.example.com/undated",
      "https://jobs.example.com/remembered",
    ]);
    expect(result.items.at(-1)?.description).toBe(rememberedDescription);
    expect(detailPaths).toEqual(["/recent", "/old", "/undated"]);
    expect(result).toMatchObject({ completeSnapshot: true, descriptionUnavailable: 0 });
    expect(result.provenance).toContain("descriptions reused: 1");
  });

  test("limits detail enrichment without omitting rows or preferring newer postings", async () => {
    const source = `
| Company | Role | Application | Date |
| --- | --- | --- | --- |
| Old One | Software Engineering Intern | [Apply](https://jobs.example.com/old-one) | 2025-01-01 |
| Recent Co | Software Engineering Intern | [Apply](https://jobs.example.com/recent) | 2026-07-05 |
`;
    const detailPaths: string[] = [];
    const connector = createGitHubTableConnector({
      id: "age-neutral-cap",
      name: "Age-neutral cap",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
      maxRows: 1,
    }, clientFor(async (input, init) => {
      if (new Headers(init.headers).get("host") === "api.github.com") {
        return new Response(source, { headers: { "content-type": "text/plain" } });
      }
      detailPaths.push(new URL(input).pathname);
      return new Response(detail, { headers: { "content-type": "text/html" } });
    }));

    const result = await connector.sync(
      new AbortController().signal,
      syncContext(),
    );

    expect(result.items.map(({ canonicalUrl }) => canonicalUrl)).toEqual([
      "https://jobs.example.com/old-one",
      "https://jobs.example.com/recent",
    ]);
    expect(result.items[0]?.description).not.toBeNull();
    expect(result.items[1]?.description).toBeNull();
    expect(detailPaths).toEqual(["/old-one"]);
    expect(result).toMatchObject({ completeSnapshot: true, descriptionUnavailable: 1 });
    expect(result.provenance).toContain("detail deferred: 1");
  });

  test("emits every valid row beyond the default 1,000-row detail cap", async () => {
    const rows = Array.from({ length: 1_001 }, (_, index) =>
      `| Company ${index} | Software Engineering Intern | [Apply](https://jobs.example.com/${index}) | 2026-07-05 |`,
    ).join("\n");
    const source = `| Company | Role | Application | Date |
| --- | --- | --- | --- |
${rows}`;
    let detailRequests = 0;
    const connector = createGitHubTableConnector({
      id: "detail-capped",
      name: "Detail-capped source",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (_input, init) => {
      if (new Headers(init.headers).get("host") === "api.github.com") {
        return new Response(source, { headers: { "content-type": "text/plain" } });
      }
      detailRequests += 1;
      return new Response(detail, { headers: { "content-type": "text/html" } });
    }));

    const result = await connector.sync(
      new AbortController().signal,
      syncContext(),
    );

    expect(result.items).toHaveLength(1_001);
    expect(detailRequests).toBe(1_000);
    expect(result).toMatchObject({ completeSnapshot: true, descriptionUnavailable: 1 });
  });

  test("loads remembered descriptions in bounded batches and reuses all of them", async () => {
    const rows = Array.from({ length: 1_001 }, (_, index) =>
      `| Company ${index} | Software Engineering Intern | [Apply](https://jobs.example.com/${index}) | 2026-07-05 |`,
    ).join("\n");
    const source = `| Company | Role | Application | Date |
| --- | --- | --- | --- |
${rows}`;
    const knownByCanonicalUrl = new Map(Array.from({ length: 1_001 }, (_, index) => {
      const canonicalUrl = `https://jobs.example.com/${index}`;
      return [canonicalUrl, {
        sourceItemId: `known-${index}`,
        canonicalUrl,
        description: `Saved description ${index} with enough role details for reuse without enrichment.`,
      }] as const;
    }));
    const loadedBatchSizes: number[] = [];
    const connector = createGitHubTableConnector({
      id: "remembered-batches",
      name: "Remembered description batches",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (_input, init) => {
      if (new Headers(init.headers).get("host") === "api.github.com") {
        return new Response(source, { headers: { "content-type": "text/plain" } });
      }
      throw new Error("Remembered descriptions must not be enriched again");
    }));

    const result = await connector.sync(new AbortController().signal, {
      findKnownItems: (candidates) => candidates.flatMap((candidate) => {
        const item = knownByCanonicalUrl.get(candidate.canonicalUrl);
        return item ? [item] : [];
      }),
      loadKnownItems: (candidates) => {
        loadedBatchSizes.push(candidates.length);
        return candidates.flatMap((candidate) => {
          const item = knownByCanonicalUrl.get(candidate.canonicalUrl);
          return item ? [item] : [];
        });
      },
    });

    expect(result.items).toHaveLength(1_001);
    expect(result.items.every(({ description }) => description !== null)).toBe(true);
    expect(result).toMatchObject({ completeSnapshot: true, descriptionUnavailable: 0 });
    expect(loadedBatchSizes).toEqual([1_000, 1]);
  });

  test("emits every scanned row and marks an over-limit repository incomplete", async () => {
    const rows = Array.from({ length: 10_001 }, (_, index) =>
      `| Company ${index} | Software Engineering Intern | [Apply](https://jobs.example.com/${index}) | 2026-07-05 |`,
    ).join("\n");
    const source = `| Company | Role | Application | Date |
| --- | --- | --- | --- |
${rows}`;
    let lookupCandidates = 0;
    let detailRequests = 0;
    const connector = createGitHubTableConnector({
      id: "bounded-lookup",
      name: "Bounded lookup",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
      maxRows: 1,
    }, clientFor(async (_input, init) => {
      if (new Headers(init.headers).get("host") === "api.github.com") {
        return new Response(source, { headers: { "content-type": "text/plain" } });
      }
      detailRequests += 1;
      return new Response(detail, { headers: { "content-type": "text/html" } });
    }));

    const result = await connector.sync(new AbortController().signal, {
      ...syncContext(),
      findKnownItems: (candidates) => {
        lookupCandidates = candidates.length;
        return [];
      },
    });

    expect(lookupCandidates).toBe(10_000);
    expect(result.items).toHaveLength(10_000);
    expect(detailRequests).toBe(1);
    expect(result).toMatchObject({ completeSnapshot: false, descriptionUnavailable: 9_999 });
  });

  test("reuses remembered descriptions without spending the detail cap", async () => {
    const source = `
| Company | Role | Application | Date |
| --- | --- | --- | --- |
| Remembered Co | Software Engineering Intern | [Apply](https://jobs.example.com/remembered) | 2026-07-05 |
| Unknown Co | Software Engineering Intern | [Apply](https://jobs.example.com/unknown) | 2026-07-06 |
`;
    const detailPaths: string[] = [];
    const connector = createGitHubTableConnector({
      id: "remembered-reuse",
      name: "Remembered description reuse",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
      maxRows: 1,
    }, clientFor(async (input, init) => {
      if (new Headers(init.headers).get("host") === "api.github.com") {
        return new Response(source, { headers: { "content-type": "text/plain" } });
      }
      detailPaths.push(new URL(input).pathname);
      return new Response(detail, { headers: { "content-type": "text/html" } });
    }));

    const knownItem = {
      sourceItemId: "remembered",
      canonicalUrl: "https://jobs.example.com/remembered",
      description: "Previously saved internship description with enough detail to remain valid.",
    };
    let loadedKnownItems = 0;
    const context = syncContext([knownItem]);
    const result = await connector.sync(new AbortController().signal, {
      ...context,
      loadKnownItems: (candidates) => {
        loadedKnownItems += candidates.length;
        return context.loadKnownItems(candidates);
      },
    });

    expect(result.items.map(({ canonicalUrl }) => canonicalUrl)).toEqual([
      "https://jobs.example.com/remembered",
      "https://jobs.example.com/unknown",
    ]);
    expect(result.items[0]?.description).toBe(knownItem.description);
    expect(detailPaths).toEqual(["/unknown"]);
    expect(result).toMatchObject({ completeSnapshot: true, descriptionUnavailable: 0 });
    expect(loadedKnownItems).toBe(1);
  });

  test("never follows a contents API redirect off api.github.com", async () => {
    const seen: Array<{ host: string | null; authorization: string | null }> = [];
    const connector = createGitHubTableConnector({
      id: "redirecting",
      name: "Redirecting internships",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
      githubToken: "private-token",
    }, clientFor(async (_input, init) => {
      const headers = new Headers(init.headers);
      seen.push({
        host: headers.get("host"),
        authorization: headers.get("authorization"),
      });
      return new Response(null, {
        status: 302,
        headers: { location: "https://raw.githubusercontent.com/example/internships/main/README.md" },
      });
    }));

    await expect(connector.sync(new AbortController().signal)).rejects.toMatchObject({
      message: "GitHub discovery source is unavailable",
    });
    expect(seen).toEqual([{
      host: "api.github.com",
      authorization: "Bearer private-token",
    }]);
  });

  test("keeps stable distinct identities for separate URLs sharing a requisition ID", async () => {
    const duplicateIdTable = `
| Company | Role | Location | Application |
| --- | --- | --- | --- |
| Alpha | Software Engineering Intern | Remote | [Apply](https://jobs.alpha.example/openings?gh_jid=123456) |
| Beta | Platform Engineering Intern | Remote | [Apply](https://careers.beta.example/openings?gh_jid=123456) |
`;
    const fetchImpl: ConnectorFetch = async (_input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") {
        return new Response(duplicateIdTable, { headers: { "content-type": "text/plain" } });
      }
      return new Response(detail, { headers: { "content-type": "text/html" } });
    };
    const connector = createGitHubTableConnector({
      id: "duplicate",
      name: "Duplicate requisition fixture",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(fetchImpl));

    const first = await connector.sync(new AbortController().signal);
    const second = await connector.sync(new AbortController().signal);
    const firstIds = first.items.map((item) => item.sourceItemId);

    expect(first.completeSnapshot).toBe(true);
    expect(first.items).toHaveLength(2);
    expect(first.items.map((item) => item.requisitionId)).toEqual(["123456", "123456"]);
    expect(firstIds.every((id) => id.startsWith("duplicate:123456:"))).toBe(true);
    expect(new Set(firstIds).size).toBe(2);
    expect(second.items.map((item) => item.sourceItemId)).toEqual(firstIds);
  });

  test("tries later valid descriptions in HTML JSON-LD and JSON responses", async () => {
    const twoRowTable = `
| Company | Role | Application |
| --- | --- | --- |
| Alpha | Software Engineering Intern | [Apply](https://html-metadata.example/jobs/123) |
| Beta | Platform Engineering Intern | [Apply](https://json-metadata.example/jobs/456) |
`;
    const htmlDescription = "This later HTML metadata description contains enough useful internship detail.";
    const jsonDescription = "This later JSON response description contains enough useful internship detail.";
    const metadata = (validDescription: string) => ({
      "@graph": [
        { "@type": "JobPosting", description: "Too short" },
        { "@type": "JobPosting", description: `<p>${validDescription}</p>` },
      ],
    });
    const fetchImpl: ConnectorFetch = async (_input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") {
        return new Response(twoRowTable, { headers: { "content-type": "text/plain" } });
      }
      if (host === "html-metadata.example") {
        return new Response(
          `<script type="application/ld+json">${JSON.stringify(metadata(htmlDescription))}</script>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response(JSON.stringify(metadata(jsonDescription)), {
        headers: { "content-type": "application/json" },
      });
    };
    const connector = createGitHubTableConnector({
      id: "metadata-descriptions",
      name: "Metadata descriptions fixture",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(fetchImpl));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items.map((item) => item.description)).toEqual([htmlDescription, jsonDescription]);
  });

  test("loads Greenhouse URL variants through the public job-board API", async () => {
    const greenhouseTable = `
| Company | Role | Application |
| --- | --- | --- |
| Five Rings | Quantitative Trader Intern | [Apply](https://job-boards.greenhouse.io/fiveringsllc/jobs/5139668008) |
| Gemini | Software Engineering Intern | [Apply](https://boards.greenhouse.io/embed/job_app?for=gemini&gh_jid=7875125) |
`;
    const requestedPaths: string[] = [];
    const connector = createGitHubTableConnector({
      id: "greenhouse-api",
      name: "Greenhouse API fixture",
      kind: "speedyapply",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") {
        return new Response(greenhouseTable, { headers: { "content-type": "text/plain" } });
      }
      if (host !== "boards-api.greenhouse.io") {
        throw new Error("Greenhouse HTML shell should not be requested");
      }
      const path = new URL(input).pathname;
      requestedPaths.push(path);
      const id = Number(path.split("/").at(-1));
      return new Response(JSON.stringify({
        id,
        content: `<p>Build production systems during internship ${id} with an experienced engineering team.</p>`,
      }), { headers: { "content-type": "application/json" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(requestedPaths).toEqual([
      "/v1/boards/fiveringsllc/jobs/5139668008",
      "/v1/boards/gemini/jobs/7875125",
    ]);
  });

  test("loads regional Oracle Candidate Experience descriptions through the public REST endpoint", async () => {
    const oracleTable = `
| Company | Role | Application |
| --- | --- | --- |
| American Express | Software Engineering Intern | [Apply](https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26012174) |
`;
    const oracleDescription = "Develop production payment systems and collaborate with engineers throughout this internship.";
    const requested: string[] = [];
    const connector = createGitHubTableConnector({
      id: "oracle-candidate-api",
      name: "Oracle Candidate API fixture",
      kind: "zapply",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (input, init) => {
      if (new Headers(init.headers).get("host") === "api.github.com") {
        return new Response(oracleTable, { headers: { "content-type": "text/plain" } });
      }
      const url = new URL(input);
      requested.push(`${url.pathname}${url.search}`);
      if (url.pathname !== "/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails") {
        throw new Error("Oracle Candidate Experience shell should not be requested");
      }
      return new Response(JSON.stringify({
        items: [{
          Id: 26012174,
          Title: "Software Engineering Intern",
          ExternalDescriptionStr: `<p>${oracleDescription}</p>`,
        }],
      }), { headers: { "content-type": "application/vnd.oracle.adf.resourcecollection+json" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items[0]?.description).toBe(oracleDescription);
    expect(requested).toEqual([
      "/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%2226012174%22,siteNumber=CX_1",
    ]);
  });

  test("loads TikTok and ByteDance descriptions through their public supplier APIs", async () => {
    const tiktokTable = `
| Company | Role | Application |
| --- | --- | --- |
| TikTok | Backend Software Engineer Intern | [Apply](https://lifeattiktok.com/search/7668827379083823413) |
| ByteDance | AI Application Engineer Intern | [Apply](https://joinbytedance.com/search/7668334624594479413) |
| ByteDance | Platform Engineer Intern | [Apply](https://jobs.bytedance.com/en/position/7668334624594479414/detail) |
`;
    const requested: Array<{ host: string | null; path: string; method: string; body: string }> = [];
    const connector = createGitHubTableConnector({
      id: "tiktok-supplier-api",
      name: "TikTok supplier API fixture",
      kind: "speedyapply",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (input, init) => {
      const headers = new Headers(init.headers);
      const host = headers.get("host");
      if (host === "api.github.com") {
        return new Response(tiktokTable, { headers: { "content-type": "text/plain" } });
      }
      const path = new URL(input).pathname;
      const body = String(init.body ?? "");
      requested.push({ host, path, method: init.method ?? "GET", body });
      if (!path.startsWith("/api/v1/public/supplier/job/posts/")) {
        throw new Error("Career-site shell should not be requested");
      }
      const id = path.split("/").at(-1)!;
      return new Response(JSON.stringify({
        code: 0,
        data: {
          job_post_detail: {
            id,
            title: `Internship ${id}`,
            description: `Build production services for posting ${id} with a global engineering team.`,
            requirement: "Qualifications include software engineering experience and strong collaboration skills.",
          },
        },
      }), { headers: { "content-type": "application/json" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items).toHaveLength(3);
    expect(result.items.every((item) => item.description?.includes("Qualifications") === true)).toBe(true);
    expect(requested.map(({ host, method }) => ({ host, method }))).toEqual([
      { host: "api.lifeattiktok.com", method: "POST" },
      { host: "jobs.bytedance.com", method: "POST" },
      { host: "jobs.bytedance.com", method: "POST" },
    ]);
    expect(requested.every(({ body, path }) =>
      JSON.parse(body).job_post_id === path.split("/").at(-1))).toBe(true);
  });

  test("loads SmartRecruiters descriptions through the public posting API", async () => {
    const smartTable = `
| Company | Role | Application |
| --- | --- | --- |
| Western Digital | Software Engineering Intern | [Apply](https://jobs.smartrecruiters.com/WesternDigital/744000138727213-summer-2027-software-engineering-internship) |
`;
    const requestedPaths: string[] = [];
    const connector = createGitHubTableConnector({
      id: "smartrecruiters-api",
      name: "SmartRecruiters API fixture",
      kind: "speedyapply",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") {
        return new Response(smartTable, { headers: { "content-type": "text/plain" } });
      }
      if (host !== "api.smartrecruiters.com") {
        throw new Error("SmartRecruiters shell should not be requested");
      }
      requestedPaths.push(new URL(input).pathname);
      return new Response(JSON.stringify({
        id: "744000138727213",
        jobAd: {
          sections: {
            companyDescription: { text: "<p>Do not include generic company copy.</p>" },
            jobDescription: { text: "<p>Build storage software with an engineering team.</p>" },
            qualifications: { text: "<p>Experience with algorithms and a systems language.</p>" },
            additionalInformation: { text: "<p>Collaborate in San Jose throughout the internship.</p>" },
          },
        },
      }), { headers: { "content-type": "application/json" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items[0]?.description).not.toContain("generic company copy");
    expect(result.items[0]?.description).toContain("Experience with algorithms");
    expect(requestedPaths).toEqual([
      "/v1/companies/WesternDigital/postings/744000138727213",
    ]);
  });

  test("loads Workable descriptions through the public account API", async () => {
    const workableTable = `
| Company | Role | Application |
| --- | --- | --- |
| Veeam | Software Developer Intern | [Apply](https://apply.workable.com/veeam-software/j/42A7BC19DE/) |
`;
    const requestedPaths: string[] = [];
    const connector = createGitHubTableConnector({
      id: "workable-api",
      name: "Workable API fixture",
      kind: "speedyapply",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") {
        return new Response(workableTable, { headers: { "content-type": "text/plain" } });
      }
      if (host !== "apply.workable.com") {
        throw new Error("Workable shell should not be requested");
      }
      requestedPaths.push(new URL(input).pathname);
      return new Response(JSON.stringify({
        shortcode: "42A7BC19DE",
        state: "published",
        description: "<p>Build and test production backup software with the engineering team.</p>",
        requirements: "<ul><li>Experience with typed programming languages.</li></ul>",
        benefits: "<p>Work with an experienced mentor throughout the internship.</p>",
      }), { headers: { "content-type": "application/json" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items[0]?.description).toContain("typed programming languages");
    expect(result.items[0]?.description).toContain("experienced mentor");
    expect(requestedPaths).toEqual([
      "/api/v2/accounts/veeam-software/jobs/42A7BC19DE",
    ]);
  });

  test("loads Lever regional URL variants through the public postings API", async () => {
    const leverTable = `
| Company | Role | Application |
| --- | --- | --- |
| Highspot | Software Engineer Intern | [Apply](https://jobs.lever.co/highspot/01234567-89ab-cdef-0123-456789abcdef) |
| Alma | Backend Engineer Intern | [Apply](https://jobs.eu.lever.co/alma/11111111-2222-4333-8444-555555555555/apply) |
`;
    const requestedEndpoints: string[] = [];
    const connector = createGitHubTableConnector({
      id: "lever-api",
      name: "Lever API fixture",
      kind: "speedyapply",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") {
        return new Response(leverTable, { headers: { "content-type": "text/plain" } });
      }
      if (host !== "api.lever.co" && host !== "api.eu.lever.co") {
        throw new Error("Lever shell should not be requested");
      }
      const parsed = new URL(input);
      requestedEndpoints.push(`${host}${parsed.pathname}${parsed.search}`);
      const id = parsed.pathname.split("/").at(-1)!;
      return new Response(JSON.stringify({
        id,
        descriptionPlain: "Build reliable software for customers with a product engineering team. This internship provides ownership of a production feature.",
        openingPlain: "Build reliable software for customers with a product engineering team.",
        descriptionBodyPlain: "This internship provides ownership of a production feature.",
        lists: [{ text: "Qualifications", content: "Programming experience and strong collaboration skills." }],
        additionalPlain: "Work with a dedicated engineering mentor.",
      }), { headers: { "content-type": "application/json" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) =>
      item.description?.includes("dedicated engineering mentor") === true)).toBe(true);
    expect(result.items.every((item) =>
      item.description?.match(/Build reliable software/g)?.length === 1)).toBe(true);
    expect(requestedEndpoints).toEqual([
      "api.lever.co/v0/postings/highspot/01234567-89ab-cdef-0123-456789abcdef?mode=json",
      "api.eu.lever.co/v0/postings/alma/11111111-2222-4333-8444-555555555555?mode=json",
    ]);
  });

  test("falls back to Lever page JSON-LD when the postings API is stale", async () => {
    const leverTable = `
| Company | Role | Application |
| --- | --- | --- |
| Cirrus Logic | AI Business Analytics Intern | [Apply](https://jobs.eu.lever.co/cirrus/f85c944c-d437-4685-9f04-c7b79ae65ecb) |
`;
    const requestedHosts: string[] = [];
    const connector = createGitHubTableConnector({
      id: "lever-page-fallback",
      name: "Lever page fallback fixture",
      kind: "speedyapply",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (_input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") {
        return new Response(leverTable, { headers: { "content-type": "text/plain" } });
      }
      requestedHosts.push(host ?? "");
      if (host === "api.eu.lever.co") {
        return new Response('{"message":"Document not found"}', {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(`<script type="application/ld+json">${JSON.stringify({
        "@type": "JobPosting",
        title: "Fall 2026 Co-Op AI Business Analytics Intern",
        hiringOrganization: { "@type": "Organization", name: "Cirrus Logic" },
        description: "<p>Analyze business and product data with engineering partners during the internship.</p>",
      })}</script>`, { headers: { "content-type": "text/html" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items[0]?.description).toContain("Analyze business and product data");
    expect(requestedHosts).toEqual(["api.eu.lever.co", "jobs.eu.lever.co"]);
  });

  test("rejects mismatched Lever page JSON-LD after an API miss", async () => {
    const leverTable = `
| Company | Role | Application |
| --- | --- | --- |
| Cirrus Logic | AI Business Analytics Intern | [Apply](https://jobs.eu.lever.co/cirrus/f85c944c-d437-4685-9f04-c7b79ae65ecb) |
`;
    const connector = createGitHubTableConnector({
      id: "lever-page-mismatch",
      name: "Lever mismatch fixture",
      kind: "speedyapply",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (_input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") {
        return new Response(leverTable, { headers: { "content-type": "text/plain" } });
      }
      if (host === "api.eu.lever.co") {
        return new Response('{"message":"Document not found"}', {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(`<script type="application/ld+json">${JSON.stringify({
        "@type": "JobPosting",
        title: "Intern",
        hiringOrganization: { "@type": "Organization", name: "Cirrus Logic" },
        description: "<p>This unrelated frontend description is long enough to pass sanitization.</p>",
      })}</script>`, { headers: { "content-type": "text/html" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.description).toBeNull();
    expect(result).toMatchObject({ completeSnapshot: true, descriptionUnavailable: 1 });
  });

  test("loads and caches Ashby public job-board descriptions", async () => {
    const ashbyTable = `
| Company | Role | Application |
| --- | --- | --- |
| Ramp | Software Engineer Intern | [Apply](https://jobs.ashbyhq.com/ramp/01234567-89ab-cdef-0123-456789abcdef) |
| Ramp | Product Engineer Intern | [Apply](https://jobs.ashbyhq.com/ramp/11111111-2222-3333-4444-555555555555/application) |
`;
    let boardRequests = 0;
    const connector = createGitHubTableConnector({
      id: "ashby-api",
      name: "Ashby API fixture",
      kind: "speedyapply",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") {
        return new Response(ashbyTable, { headers: { "content-type": "text/plain" } });
      }
      if (host !== "api.ashbyhq.com") {
        throw new Error("Ashby job shell should not be requested");
      }
      expect(new URL(input).pathname).toBe("/posting-api/job-board/ramp");
      boardRequests += 1;
      return new Response(JSON.stringify({
        metadataPadding: "x".repeat(1024 * 1024),
        jobs: [
          {
            id: "01234567-89ab-cdef-0123-456789abcdef",
            descriptionHtml: "<p>Build financial infrastructure with a production engineering team.</p>",
          },
          {
            id: "11111111-2222-3333-4444-555555555555",
            descriptionPlain: "Ship product improvements with designers, engineers, and customer teams.",
          },
        ],
      }), { headers: { "content-type": "application/json" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.description).toContain("financial infrastructure");
    expect(result.items[1]?.description).toContain("product improvements");
    expect(boardRequests).toBe(1);
  });

  test("loads Jump Trading wrappers through its Greenhouse board", async () => {
    const jumpTable = `
| Company | Role | Application |
| --- | --- | --- |
| Jump Trading | Software Engineer Intern | [Apply](https://www.jumptrading.com/hr/job?gh_jid=7220680) |
`;
    const requested: string[] = [];
    const connector = createGitHubTableConnector({
      id: "jump-greenhouse-api",
      name: "Jump Greenhouse API fixture",
      kind: "speedyapply",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") {
        return new Response(jumpTable, { headers: { "content-type": "text/plain" } });
      }
      if (host !== "boards-api.greenhouse.io") {
        throw new Error("Jump Trading wrapper should not be requested");
      }
      requested.push(new URL(input).pathname);
      return new Response(JSON.stringify({
        id: 7220680,
        content: "<p>Design and build low-latency trading systems with experienced engineers.</p>",
      }), { headers: { "content-type": "application/json" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items[0]?.description).toContain("low-latency trading systems");
    expect(requested).toEqual(["/v1/boards/jumptrading/jobs/7220680"]);
  });

  test("loads Hudson River Trading wrappers through its Greenhouse board", async () => {
    const hrtTable = `
| Company | Role | Application |
| --- | --- | --- |
| HRT | Software Engineer Intern - C++ or Python | [Apply](https://www.hudsonrivertrading.com/careers/job/?gh_jid=8052083&utm_source=Simplify) |
`;
    const requested: string[] = [];
    const connector = createGitHubTableConnector({
      id: "hrt-greenhouse-api",
      name: "HRT Greenhouse API fixture",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") {
        return new Response(hrtTable, { headers: { "content-type": "text/plain" } });
      }
      if (host !== "boards-api.greenhouse.io") {
        throw new Error("HRT wrapper should not be requested");
      }
      requested.push(new URL(input).pathname);
      return new Response(JSON.stringify({
        id: 8052083,
        content: "<p>Build high-performance trading systems in C++ or Python with quantitative engineers.</p>",
      }), { headers: { "content-type": "application/json" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items[0]?.description).toContain("high-performance trading systems");
    expect(requested).toEqual(["/v1/boards/wehrtyou/jobs/8052083"]);
  });

  test("loads fixed company career wrappers through their Greenhouse boards", async () => {
    const wrapperTable = `
| Company | Role | Application |
| --- | --- | --- |
| Jane Street | Software Engineer Summer Internship | [Apply](https://www.janestreet.com/join-jane-street/position/8599644002) |
| Tower Research Capital | Quantitative Research Intern | [Apply](https://www.tower-research.com/open-positions/?gh_jid=8024128) |
| TIFIN | AI Engineering Intern | [Apply](https://tifin.com/careers/apply/?gh_jid=5981740004) |
| Old Mission Capital | Software Engineer Internship | [Apply](https://www.oldmissioncapital.com/careers/?gh_jid=7796180003) |
| Samsara | Software Engineer Intern | [Apply](https://www.samsara.com/company/careers/roles/8082091?gh_jid=8082091) |
`;
    const requested: string[] = [];
    const connector = createGitHubTableConnector({
      id: "career-greenhouse-api",
      name: "Career wrapper Greenhouse fixture",
      kind: "speedyapply",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") {
        return new Response(wrapperTable, { headers: { "content-type": "text/plain" } });
      }
      if (host !== "boards-api.greenhouse.io") {
        throw new Error("Career wrapper should not be requested");
      }
      const path = new URL(input).pathname;
      requested.push(path);
      const id = path.split("/").at(-1)!;
      return new Response(JSON.stringify({
        id,
        content: `<p>Build production software for official posting ${id} with an experienced team.</p>`,
      }), { headers: { "content-type": "application/json" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items).toHaveLength(5);
    expect(requested).toEqual([
      "/v1/boards/janestreet/jobs/8599644002",
      "/v1/boards/towerresearchcapital/jobs/8024128",
      "/v1/boards/tifin/jobs/5981740004",
      "/v1/boards/oldmissioncapital/jobs/7796180003",
      "/v1/boards/samsara/jobs/8082091",
    ]);
  });

  test("extracts Amazon job detail bodies from official pages", async () => {
    const amazonTable = `
| Company | Role | Application |
| --- | --- | --- |
| Amazon | Software Development Engineer Intern | [Apply](https://www.amazon.jobs/en/jobs/10412530/software-development-engineer-intern) |
`;
    const connector = createGitHubTableConnector({
      id: "amazon-job-body",
      name: "Amazon job body fixture",
      kind: "zapply",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (_input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") {
        return new Response(amazonTable, { headers: { "content-type": "text/plain" } });
      }
      return new Response(`
        <nav>Amazon Jobs navigation content that must not become the description.</nav>
        <div id="job-detail-body">
          <h2>DESCRIPTION</h2>
          <p>Design, implement, and test distributed services with an AWS engineering team.</p>
          <h2>BASIC QUALIFICATIONS</h2>
          <p>Experience programming in a modern language and studying computer science.</p>
        </div>
      `, { headers: { "content-type": "text/html" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items[0]?.description).toContain("distributed services");
    expect(result.items[0]?.description).not.toContain("navigation content");
  });

  test("loads Apple job descriptions through the official details API", async () => {
    const appleTable = `
| Company | Role | Application |
| --- | --- | --- |
| Apple | Hardware Undergrad Engineering Internships | [Apply](https://jobs.apple.com/en-us/details/200663981/hardware-undergrad-engineering-internships) |
| Apple | iOS API Developer Internship | [Apply](https://jobs.apple.com/en-us/details/200654858-0240/ios-api-developer) |
`;
    const requested: string[] = [];
    const connector = createGitHubTableConnector({
      id: "apple-job-api",
      name: "Apple details API fixture",
      kind: "zapply",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") {
        return new Response(appleTable, { headers: { "content-type": "text/plain" } });
      }
      if (host !== "jobs.apple.com") {
        throw new Error("Apple job shell should not be requested");
      }
      const parsed = new URL(input);
      requested.push(`${parsed.pathname}${parsed.search}`);
      const apiId = parsed.pathname.split("/").at(-1)!;
      const jobNumber = apiId.startsWith("PIPE-") ? apiId.slice(5) : apiId;
      const baseId = jobNumber.split("-", 1)[0]!;
      return new Response(JSON.stringify({
        res: {
          id: `PIPE-${baseId}`,
          reqId: `PIPE-${baseId}`,
          jobNumber,
          positionId: baseId,
          postingTitle: "Hardware Engineering Internship",
          description: "<p>Design, prototype, and validate hardware systems with experienced Apple engineers.</p>",
          minimumQualifications: "Currently pursuing an engineering degree.",
          preferredQualifications: "Experience with hardware design, testing, and data analysis.",
        },
      }), { headers: { "content-type": "application/json" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.description).toContain("Design, prototype, and validate");
    expect(result.items[0]?.description).toContain("hardware design, testing");
    expect(requested).toEqual([
      "/api/v1/jobDetails/200663981?locale=en-us",
      "/api/v1/jobDetails/200654858-0240?locale=en-us",
    ]);
  });
  test("uses a matching Simplify mirror when the primary detail has no description", async () => {
    const primaryUrl = "https://lifeattiktok.com/search/7667935150530840837";

    const mirrorTable = `
| Company | Role | Application |
| --- | --- | --- |
| TikTok | Backend Software Engineer Intern - LIVE Foundation Governance Engineering | [Apply](${primaryUrl}) [Simplify](https://simplify.jobs/p/6454b1b2-6daf-4a13-9e9f-47209a333d39?utm_source=GHList) |
`;
    const mirrorDescription = "Build backend systems for live-streaming governance with engineers and data scientists.";
    const connector = createGitHubTableConnector({
      id: "simplify-mirror",
      name: "Simplify mirror fixture",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (_input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") {
        return new Response(mirrorTable, { headers: { "content-type": "text/plain" } });
      }
      if (host === "simplify.jobs") {
        return new Response(`<script type="application/ld+json">${JSON.stringify({
          "@type": "JobPosting",
          title: "Backend Software Engineer Intern, LIVE Foundation Governance Engineering",
          hiringOrganization: { "@type": "Organization", name: "TikTok" },
          description: `<p>${mirrorDescription}</p>`,
        })}</script>`, { headers: { "content-type": "text/html" } });
      }
      return new Response("<main>Sign in</main>", { headers: { "content-type": "text/html" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      canonicalUrl: primaryUrl,
      applyUrl: primaryUrl,
      company: "TikTok",
      description: mirrorDescription,
    });
  });

  test("rejects a Simplify mirror for a different job identity", async () => {
    const mirrorTable = `
| Company | Role | Application |
| --- | --- | --- |
| TikTok | Backend Software Engineer Intern | [Apply](https://lifeattiktok.com/search/123) [Simplify](https://simplify.jobs/p/6454b1b2-6daf-4a13-9e9f-47209a333d39) |
`;
    const connector = createGitHubTableConnector({
      id: "mismatched-simplify-mirror",
      name: "Mismatched Simplify mirror fixture",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (_input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") {
        return new Response(mirrorTable, { headers: { "content-type": "text/plain" } });
      }
      if (host === "simplify.jobs") {
        return new Response(`<script type="application/ld+json">${JSON.stringify({
          "@type": "JobPosting",
          title: "Frontend Engineer Intern",
          hiringOrganization: { "@type": "Organization", name: "Different Company" },
          description: "This unrelated description is long enough but belongs to a different job posting.",
        })}</script>`, { headers: { "content-type": "text/html" } });
      }
      return new Response("<main>Sign in</main>", { headers: { "content-type": "text/html" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.description).toBeNull();
    expect(result).toMatchObject({ completeSnapshot: true, descriptionUnavailable: 1 });
  });

  test("loads Workday external SPA descriptions from the public CXS endpoint", async () => {
    const workdayTable = `
| Company | Role | Application |
| --- | --- | --- |
| Capital One | Technology Intern | [Apply](https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/McLean-VA/Technology-Internship-Program---Summer-2027_R244387-1?utm_source=Simplify) |
| Capital One | Data Intern | [Apply](https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/McLean-VA/Data-Internship---Summer-2027_R999999) |
`;

    const workdayDescription = "Build cloud software and production services during this ten-week technology internship.";
    const requestedPaths: string[] = [];
    const fetchImpl: ConnectorFetch = async (input, init) => {
      const headers = new Headers(init.headers);
      if (headers.get("host") === "api.github.com") {
        return new Response(workdayTable, { headers: { "content-type": "text/plain" } });
      }
      const path = new URL(input).pathname;
      requestedPaths.push(path);
      if (!path.startsWith("/wday/cxs/")) {
        throw new Error("Workday shell should not be requested");
      }
      return new Response(JSON.stringify({
        jobDescription: "This unrelated response description must not replace the nested posting description.",
        jobPostingInfo: {
          externalUrl: "https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/McLean-VA/Technology-Internship-Program---Summer-2027_R244387-1",
          jobDescription: `<p>${workdayDescription}</p>`,
        },
      }), { headers: { "content-type": "application/json" } });
    };
    const connector = createGitHubTableConnector({
      id: "workday-external-spa",
      name: "Workday external SPA fixture",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(fetchImpl));

    const result = await connector.sync(new AbortController().signal);

    expect(result).toMatchObject({ completeSnapshot: true, descriptionUnavailable: 1 });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      company: "Capital One",
      title: "Technology Intern",
      description: workdayDescription,
    });
    expect(result.items[1]?.description).toBeNull();
    expect(requestedPaths).toEqual([
      "/wday/cxs/capitalone/Capital_One/job/McLean-VA/Technology-Internship-Program---Summer-2027_R244387-1",
      "/wday/cxs/capitalone/Capital_One/job/McLean-VA/Data-Internship---Summer-2027_R999999",
    ]);
  });
  test("uses the Workday site tenant config once when the host tenant is rejected", async () => {
    const workdayTable = `
| Company | Role | Application |
| --- | --- | --- |
| CCI | Software Engineering Intern | [Apply](https://osv-cci.wd1.myworkdayjobs.com/CCICareers/job/London-UK/Software-Engineering-Intern_R1347) |
| CCI | Data Engineering Intern | [Apply](https://osv-cci.wd1.myworkdayjobs.com/CCICareers/job/London-UK/Data-Engineering-Intern_R1348) |
`;
    const requestedPaths: string[] = [];
    const connector = createGitHubTableConnector({
      id: "workday-site-tenant",
      name: "Workday site tenant fixture",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
      detailConcurrency: 2,
    }, clientFor(async (input, init) => {
      if (new Headers(init.headers).get("host") === "api.github.com") {
        return new Response(workdayTable, { headers: { "content-type": "text/plain" } });
      }
      const path = new URL(input).pathname;
      requestedPaths.push(path);
      if (path === "/CCICareers") {
        return new Response(`window.workday = window.workday || {
          tenant: "osv_cci",
          siteId: "CCICareers",
        };`, { headers: { "content-type": "text/html" } });
      }
      if (path.includes("/wday/cxs/osv_cci/")) {
        return new Response(JSON.stringify({
          jobPostingInfo: {
            externalUrl: `https://osv-cci.wd1.myworkdayjobs.com/${path.split("/wday/cxs/osv_cci/")[1]}`,
            jobDescription: "Build production commodity-trading software with engineers during this summer internship.",
          },
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ errorCode: "HTTP_422", httpStatus: 422 }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(requestedPaths.filter((path) => path === "/CCICareers")).toHaveLength(1);
    expect(requestedPaths.filter((path) => path.includes("/wday/cxs/osv_cci/"))).toHaveLength(2);
    expect(result.completeSnapshot).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.requisitionId)).toEqual(["R1347", "R1348"]);
    expect(new Set(result.items.map((item) => item.sourceItemId)).size).toBe(2);
  });

  test("loads Workday recruiting-site descriptions from the public CXS endpoint", async () => {
    const workdayTable = `
| Company | Role | Application |
| --- | --- | --- |
| Wells Fargo | Risk Development Intern | [Apply](https://wd1.myworkdaysite.com/recruiting/wf/WellsFargoJobs/job/CHARLOTTE-NC/Risk-Development-Intern_R-556123) |
`;
    const workdayDescription = "Evaluate core risk programs and build analytical tools during this summer internship.";
    const requestedPaths: string[] = [];
    const connector = createGitHubTableConnector({
      id: "workday-recruiting-site",
      name: "Workday recruiting-site fixture",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (input, init) => {
      const headers = new Headers(init.headers);
      if (headers.get("host") === "api.github.com") {
        return new Response(workdayTable, { headers: { "content-type": "text/plain" } });
      }
      const path = new URL(input).pathname;
      requestedPaths.push(path);
      if (!path.startsWith("/wday/cxs/")) {
        throw new Error("Workday shell should not be requested");
      }
      return new Response(JSON.stringify({
        jobPostingInfo: {
          externalUrl: "https://wd1.myworkdaysite.com/recruiting/wf/WellsFargoJobs/job/CHARLOTTE-NC/Risk-Development-Intern_R-556123",
          jobDescription: `<p>${workdayDescription}</p>`,
        },
      }), { headers: { "content-type": "application/json" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.description).toBe(workdayDescription);
    expect(requestedPaths).toEqual([
      "/wday/cxs/wf/WellsFargoJobs/job/CHARLOTTE-NC/Risk-Development-Intern_R-556123",
    ]);
  });


  test("accepts a matching Workday recruiting-host external URL", async () => {
    const workdayTable = `
| Company | Role | Application |
| --- | --- | --- |
| Magna | Computer Vision Engineering Intern | [Apply](https://magna.wd3.myworkdayjobs.com/en-US/magna/job/Troy-Michigan-US/R-D--Computer-Vision-Engineering-Intern_R00253444-1) |
`;
    const connector = createGitHubTableConnector({
      id: "workday-recruiting-alias",
      name: "Workday recruiting alias fixture",
      kind: "speedyapply",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (_input, init) => {
      if (new Headers(init.headers).get("host") === "api.github.com") {
        return new Response(workdayTable, { headers: { "content-type": "text/plain" } });
      }
      return new Response(JSON.stringify({
        jobPostingInfo: {
          externalUrl: "https://wd3.myworkdaysite.com/recruiting/magna/Magna/job/Troy-Michigan-US/R-D--Computer-Vision-Engineering-Intern_R00253444-1",
          jobDescription: "Develop and validate computer-vision systems with an automotive research engineering team.",
        },
      }), { headers: { "content-type": "application/json" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.completeSnapshot).toBe(true);
    expect(result.items[0]?.description).toContain("computer-vision systems");
  });
  test("keeps encoded Workday posting segments inside the CXS path", async () => {
    const workdayTable = `
| Company | Role | Application |
| --- | --- | --- |
| Acme | Technology Intern | [Apply](https://acme.wd1.myworkdayjobs.com/External/job/%252e%252e/%252e%252e/Technology-Intern_R123) |
`;
    const expectedPath = "/wday/cxs/acme/External/job/%252e%252e/%252e%252e/Technology-Intern_R123";
    const requestedPaths: string[] = [];
    const connector = createGitHubTableConnector({
      id: "workday-encoded-path",
      name: "Workday encoded-path fixture",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(async (input, init) => {
      if (new Headers(init.headers).get("host") === "api.github.com") {
        return new Response(workdayTable, { headers: { "content-type": "text/plain" } });
      }
      const path = new URL(input).pathname;
      requestedPaths.push(path);
      if (path !== expectedPath) throw new Error("Workday path escaped its validated segments");
      return new Response(JSON.stringify({
        jobPostingInfo: {
          externalUrl: "https://acme.wd1.myworkdayjobs.com/External/job/%252e%252e/%252e%252e/Technology-Intern_R123",
          jobDescription: "Develop production software during this bounded technology internship program.",
        },
      }), { headers: { "content-type": "application/json" } });
    }));

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toHaveLength(1);
    expect(requestedPaths).toEqual([expectedPath]);
  });

  test("uses ETag/304 while reusing remembered non-null descriptions", async () => {
    let listRequests = 0;
    let detailRequests = 0;
    const fetchImpl: ConnectorFetch = async (_input, init) => {
      const headers = new Headers(init.headers);
      if (headers.get("host") === "api.github.com") {
        listRequests += 1;
        if (listRequests === 2) {
          expect(headers.get("if-none-match")).toBe('"table-v1"');
          return new Response(null, { status: 304 });
        }
        return new Response(table, { headers: { "content-type": "text/plain", etag: '"table-v1"' } });
      }
      detailRequests += 1;
      return new Response(detail, { headers: { "content-type": "text/html" } });
    };
    const connector = createGitHubTableConnector({
      id: "etag",
      name: "ETag fixture",
      kind: "zapply",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(fetchImpl));

    const first = await connector.sync(new AbortController().signal);
    const second = await connector.sync(
      new AbortController().signal,
      syncContext(first.items),
    );

    expect(second.items).toEqual(first.items);
    expect(detailRequests).toBe(3);
  });

  test("retries a remembered null description from cached source text after ETag/304", async () => {
    const oneRowTable = `
| Company | Role | Application |
| --- | --- | --- |
| Acme | Software Engineering Intern | [Apply](https://jobs.acme.example/openings?gh_jid=789) |
`;
    let listRequests = 0;
    let detailRequests = 0;
    const fetchImpl: ConnectorFetch = async (_input, init) => {
      const headers = new Headers(init.headers);
      if (headers.get("host") === "api.github.com") {
        listRequests += 1;
        if (listRequests === 2) {
          expect(headers.get("if-none-match")).toBe('"incomplete-v1"');
          return new Response(null, { status: 304 });
        }
        return new Response(oneRowTable, {
          headers: { "content-type": "text/plain", etag: '"incomplete-v1"' },
        });
      }
      detailRequests += 1;
      return detailRequests === 1
        ? new Response("", { headers: { "content-type": "text/html" } })
        : new Response(detail, { headers: { "content-type": "text/html" } });
    };
    const connector = createGitHubTableConnector({
      id: "incomplete-etag",
      name: "Incomplete ETag fixture",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(fetchImpl));

    const first = await connector.sync(new AbortController().signal);
    const second = await connector.sync(
      new AbortController().signal,
      syncContext(first.items),
    );

    expect(first).toMatchObject({
      completeSnapshot: true,
      descriptionUnavailable: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.description).toBeNull();
    expect(second).toMatchObject({
      completeSnapshot: true,
      descriptionUnavailable: 0,
    });
    expect(second.items[0]?.description).toContain("Responsibilities");
    expect(detailRequests).toBe(2);
  });

  test("keeps rows with unavailable descriptions in a complete snapshot", async () => {
    const fetchImpl: ConnectorFetch = async (_input, init) => {
      const host = new Headers(init.headers).get("host");
      if (host === "api.github.com") return new Response(table, { headers: { "content-type": "text/plain" } });
      if (host === "vision.example") return new Response("<main>Sign in</main>", { headers: { "content-type": "text/html" } });
      return new Response(detail, { headers: { "content-type": "text/html" } });
    };
    const connector = createGitHubTableConnector({
      id: "missing-description",
      name: "Missing description fixture",
      kind: "speedyapply",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(fetchImpl));

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toHaveLength(3);
    expect(result.items.find(({ company }) => company === "Vision Co")?.description).toBeNull();
    expect(result).toMatchObject({ completeSnapshot: true, descriptionUnavailable: 1 });
    expect(result.provenance).toContain("descriptions unavailable: 1");
  });

  test("treats a header-only table as partial instead of closing prior jobs", async () => {
    const fetchImpl: ConnectorFetch = async () => new Response(`
| Company | Role | Application |
| --- | --- | --- |
`, { headers: { "content-type": "text/plain" } });
    const connector = createGitHubTableConnector({
      id: "header-only",
      name: "Header-only fixture",
      kind: "simplify",
      owner: "example",
      repo: "internships",
      branch: "main",
      path: "README.md",
    }, clientFor(fetchImpl));

    const result = await connector.sync(new AbortController().signal);

    expect(result.items).toEqual([]);
    expect(result.completeSnapshot).toBe(false);
  });
});

describe("HTML capture bounds", () => {
  test("bounds captures, active nesting, and text retained per capture", async () => {
    const deeplyNested = `${'<div class="capture">'.repeat(40)}${"x".repeat(60_000)}${"</div>".repeat(40)}`;

    const nestedCaptures = await captureHtmlElements(deeplyNested, ".capture");
    const siblingCaptures = await captureHtmlElements(
      '<p class="capture">x</p>'.repeat(1_001),
      ".capture",
    );

    expect(nestedCaptures).toHaveLength(32);
    expect(nestedCaptures.every((capture) => capture.text.length === 50_001)).toBe(true);
    expect(siblingCaptures).toHaveLength(1_000);
  });
});

