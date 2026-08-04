import { describe, expect, test } from "bun:test";

import {
  createGitHubTableConnector,
  parseGitHubInternshipTable,
  parseGitHubRepositoryTables,
} from "../src/discovery/connectors/github";
import { SafePublicHttpClient, type ConnectorFetch } from "../src/discovery/connectors/http";
import { captureHtmlElements } from "../src/discovery/connectors/normalize";

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

describe("GitHub internship table ingestion", () => {
  test("parses escaped pipes, inline links, dates, closed rows, and internship rows", () => {
    const parsed = parseGitHubInternshipTable(table);

    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      company: "Acme | Labs",
      title: "Software Engineering Intern",
      location: "New York, NY",
      applyUrl: "https://jobs.acme.example/roles/eng-123?utm_source=github",
      postedAt: Date.parse("2026-07-28T00:00:00Z"),
    });
    expect(parsed.closedCount).toBe(1);
    expect(parsed.nonInternshipCount).toBe(1);
  });

  test("does not infer an internship from the application URL alone", () => {
    const parsed = parseGitHubInternshipTable(`
| Company | Role | Application |
| --- | --- | --- |
| Retail Co | Store Associate | [Apply](https://retail.example/internships/7) |
`);

    expect(parsed.rows).toEqual([]);
    expect(parsed.nonInternshipCount).toBe(1);
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
    expect(result.items).toHaveLength(2);
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

  test("uses ETag/304 without refetching details", async () => {
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
    const second = await connector.sync(new AbortController().signal);

    expect(second).toEqual(first);
    expect(detailRequests).toBe(2);
  });

  test("retries details from cached source text after an incomplete ETag result", async () => {
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
    const second = await connector.sync(new AbortController().signal);

    expect(first.completeSnapshot).toBe(false);
    expect(first.items).toEqual([]);
    expect(second.completeSnapshot).toBe(true);
    expect(second.items).toHaveLength(1);
    expect(detailRequests).toBe(2);
  });

  test("omits rows without a usable fetched description and marks the snapshot partial", async () => {
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

    expect(result.items).toHaveLength(1);
    expect(result.completeSnapshot).toBe(false);
    expect(result.provenance).toContain("omitted descriptions: 1");
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

