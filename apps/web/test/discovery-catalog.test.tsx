import { describe, expect, setSystemTime, test } from "bun:test";
import {
  DISCOVERY_LIST_MAX_OFFSET,
  type DiscoveryJob,
  type DiscoverySyncResponse,
} from "@jobhunter/pipeline/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DiscoveryCatalog,
  DiscoveryJobRow,
  DiscoverySyncNotice,
  boundedDiscoveryListOffset,
  discoveryPageWindow,
  discoveryQueueSkipLabel,
  discoveryRoleLabel,
  discoverySelectionAfterTransition,
  orderedSelectedDiscoveryJobIds,
  pruneDiscoverySelection,
  toggleAllDiscoverySelection,
} from "../app/components/discovery-catalog";

function job(
  id: string,
  roles: DiscoveryJob["roles"],
  overrides: Partial<DiscoveryJob> = {},
): DiscoveryJob {
  return {
    id,
    title: `${roles.join(" ")} intern`,
    company: "Example Labs",
    location: "Remote",
    roles,
    season: "unspecified",
    suitable: true,
    canonicalUrl: `https://example.com/jobs/${id}`,
    applyUrl: `https://example.com/jobs/${id}/apply`,
    descriptionPreview: "Work with a small engineering team on production systems.",
    queueable: true,
    postedAt: null,
    firstSeenAt: 1_775_174_400_000,
    lastSeenAt: 1_775_174_460_000,
    status: "open",
    sourceNames: ["Simplify"],
    ...overrides,
  };
}

const softwareJobs = [
  job("swe-1", ["software_engineering"]),
  job("swe-2", ["software_engineering"]),
];

describe("DiscoveryCatalog selection", () => {
  test("selects and clears only queueable jobs in the current result", () => {
    const unavailable = job("missing-description", ["software_engineering"], {
      descriptionPreview: null,
      queueable: false,
    });
    const closed = job("closed", ["software_engineering"], {
      queueable: false,
      status: "closed",
    });
    const queued = job("queued", ["software_engineering"], {
      queueable: false,
      queuedRunId: "run-queued",
      status: "queued",
    });
    const jobs = [...softwareJobs, unavailable, closed, queued];
    const selected = toggleAllDiscoverySelection(new Set(), jobs);

    expect([...selected]).toEqual(["swe-1", "swe-2"]);
    expect([...toggleAllDiscoverySelection(selected, jobs)]).toEqual([]);
  });

  test("prunes newly unqueueable jobs after refresh and queues queueable jobs in result order", () => {
    const refreshed = [
      softwareJobs[1]!,
      job("swe-1", ["software_engineering"], {
        descriptionPreview: null,
        queueable: false,
      }),
      job("ml-1", ["machine_learning"]),
    ];
    const selected = pruneDiscoverySelection(
      new Set(["swe-1", "swe-2", "ml-1", "missing"]),
      refreshed,
    );

    expect([...selected]).toEqual(["swe-2", "ml-1"]);
    expect(orderedSelectedDiscoveryJobIds(
      refreshed,
      new Set(["ml-1", "swe-1", "swe-2"]),
    )).toEqual(["swe-2", "ml-1"]);
  });

  test("keeps selection only for refreshes of the same page", () => {
    const selected = new Set(["swe-1", "swe-2"]);

    expect([...discoverySelectionAfterTransition(selected, "refresh")])
      .toEqual(["swe-1", "swe-2"]);
    for (const transition of ["page", "role", "recency", "status", "search"] as const) {
      expect([...discoverySelectionAfterTransition(selected, transition)]).toEqual([]);
    }
  });

  test("uses safe public labels for queue skips", () => {
    expect(discoveryQueueSkipLabel("description_unavailable")).toBe("Description unavailable");
    expect(discoveryQueueSkipLabel("queue_failed")).toBe("Could not be queued");
  });

  test("labels every role assigned to a job", () => {
    expect(discoveryRoleLabel(["software_engineering", "machine_learning"]))
      .toBe("Software engineering · Machine learning");
  });

  test("renders backend season and suitability through the canonical title link without a View job action", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <DiscoveryJobRow
          busy={false}
          job={job("summer-role", ["software_engineering"], {
            season: "summer",
            suitable: false,
            title: "Platform Engineering Intern",
          })}
          onToggle={() => undefined}
          selected={false}
        />
      </ul>,
    );

    expect(markup).toContain(">Summer<");
    expect(markup).toContain(">Unsuitable<");
    expect(markup).toMatch(
      /<a(?=[^>]*href="https:\/\/example\.com\/jobs\/summer-role")(?=[^>]*rel="noopener noreferrer")(?=[^>]*target="_blank")[^>]*>[\s\S]*?Platform Engineering Intern[\s\S]*?<\/a>/,
    );
    expect(markup).not.toContain("View job");
  });

  test("renders posted dates as whole UTC calendar-day distances with the ISO datetime preserved", () => {
    setSystemTime(new Date("2026-08-13T00:15:00.000Z"));
    try {
      const markup = renderToStaticMarkup(
        <ul>
          <DiscoveryJobRow
            busy={false}
            job={job("relative-posted-date", ["software_engineering"], {
              postedAt: Date.parse("2026-08-10T23:45:00.000Z"),
            })}
            onToggle={() => undefined}
            selected={false}
          />
        </ul>,
      );

      expect(markup).toMatch(
        /<time datetime="2026-08-10T23:45:00\.000Z">Posted 3 days ago<\/time>/i,
      );
    } finally {
      setSystemTime();
    }
  });

  test("renders accessible loading controls with the seven-day filter selected by default", () => {
    const markup = renderToStaticMarkup(<DiscoveryCatalog />);

    expect(markup).toContain("Search internships");
    expect(markup).toContain("Select all 0 queueable jobs");
    expect(markup).toContain('<option value="7" selected="">7 days</option>');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-busy="true"');
  });

  test("renders sort and queued-visibility controls with their public defaults", () => {
    const markup = renderToStaticMarkup(<DiscoveryCatalog />);

    expect(markup).toContain('aria-label="Sort internships"');
    expect(markup).toContain(
      '<option value="recency" selected="">Newest first</option>',
    );
    expect(markup).toContain(
      '<option value="source">Source A–Z</option>',
    );
    expect(markup).toMatch(
      /<label[^>]*>\s*<input(?=[^>]*type="checkbox")(?=[^>]*checked="")[^>]*\/?>\s*(?:<span>)?Hide queued jobs(?:<\/span>)?\s*<\/label>/,
    );
  });

  test("keeps the public discovery header to its title while leaving sync available outside it", () => {
    const markup = renderToStaticMarkup(<DiscoveryCatalog />);
    const header = markup.match(/<header class="discovery-header">[\s\S]*?<\/header>/)?.[0];

    expect(header).toMatch(
      /^<header class="discovery-header"><h1[^>]*>Discover<\/h1><\/header>$/,
    );
    expect(markup).not.toContain("Internship catalog");
    expect(markup).not.toContain(
      "Search fresh roles from trusted public sources, then send a selected set into the application pipeline.",
    );
    expect(markup).toMatch(/<\/header>[\s\S]*>Sync jobs<\/button>/);
  });

  test("renders unqueueable rows with disabled selection reasons and an honest unavailable preview", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <DiscoveryJobRow
          busy={false}
          job={job("missing-description", ["software_engineering"], {
            descriptionPreview: null,
            queueable: false,
          })}
          onToggle={() => undefined}
          selected={false}
        />
        <DiscoveryJobRow
          busy={false}
          job={job("closed", ["software_engineering"], {
            queueable: false,
            status: "closed",
          })}
          onToggle={() => undefined}
          selected={false}
        />
        <DiscoveryJobRow
          busy={false}
          job={job("queued", ["software_engineering"], {
            queueable: false,
            queuedRunId: "run-queued",
            status: "queued",
          })}
          onToggle={() => undefined}
          selected={false}
        />
      </ul>,
    );

    expect((markup.match(/disabled=""/g) ?? []).length).toBe(3);
    expect(markup).toContain("Job description unavailable; this role cannot be queued yet.");
    expect(markup).toContain("Description unavailable. Sync again later to retry job details.");
    expect(markup).toContain("Closed jobs cannot be queued.");
    expect(markup).toContain("This job is already queued.");
    expect(markup).toContain('aria-describedby="discovery-selection-missing-description-reason"');
  });

  test("exposes bounded previous and next windows for catalogs over one response page", () => {
    expect(boundedDiscoveryListOffset(-1)).toBe(0);
    expect(boundedDiscoveryListOffset(DISCOVERY_LIST_MAX_OFFSET + 1_000))
      .toBe(DISCOVERY_LIST_MAX_OFFSET);
    expect(discoveryPageWindow(0, 1_000, 2_501)).toEqual({
      first: 1,
      last: 1_000,
      hasPrevious: false,
      hasNext: true,
    });
    expect(discoveryPageWindow(2_000, 1_000, 2_501)).toEqual({
      first: 2_001,
      last: 2_501,
      hasPrevious: true,
      hasNext: false,
    });
    expect(discoveryPageWindow(
      DISCOVERY_LIST_MAX_OFFSET,
      1_000,
      DISCOVERY_LIST_MAX_OFFSET + 5_000,
    )).toEqual({
      first: DISCOVERY_LIST_MAX_OFFSET + 1,
      last: DISCOVERY_LIST_MAX_OFFSET + 1_000,
      hasPrevious: true,
      hasNext: false,
    });
    expect(discoveryPageWindow(
      DISCOVERY_LIST_MAX_OFFSET + 10_000,
      1_000,
      DISCOVERY_LIST_MAX_OFFSET + 5_000,
    )).toEqual({
      first: DISCOVERY_LIST_MAX_OFFSET + 1,
      last: DISCOVERY_LIST_MAX_OFFSET + 1_000,
      hasPrevious: true,
      hasNext: false,
    });
  });

  test("reports unavailable descriptions by source without implying roles were omitted", () => {
    const result = {
      sources: [
        {
          sourceId: "simplify",
          sourceName: "Simplify",
          status: "succeeded",
          completeSnapshot: true,
          received: 10,
          created: 8,
          updated: 2,
          closed: 0,
          descriptionUnavailable: 2,
        },
        {
          sourceId: "zapply",
          sourceName: "zapply",
          status: "succeeded",
          completeSnapshot: true,
          received: 4,
          created: 4,
          updated: 0,
          closed: 0,
          descriptionUnavailable: 0,
        },
      ],
      totals: {
        sources: 2,
        succeeded: 2,
        failed: 0,
        received: 14,
        created: 12,
        updated: 2,
        closed: 0,
        descriptionUnavailable: 2,
      },
      completedAt: 1_700_000_000_000,
    } satisfies DiscoverySyncResponse;

    const markup = renderToStaticMarkup(<DiscoverySyncNotice result={result} />);

    expect(markup).toContain("2 descriptions unavailable");
    expect(markup).toContain("Descriptions unavailable: Simplify (2).");
    expect(markup).not.toContain("omitted");
    expect(markup).not.toContain("zapply (0)");
  });
});
