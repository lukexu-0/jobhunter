import { describe, expect, test } from "bun:test";
import {
  DISCOVERY_LIST_MAX_OFFSET,
  type DiscoveryJob,
} from "@jobhunter/pipeline/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DiscoveryCatalog,
  boundedDiscoveryListOffset,
  discoveryPageWindow,
  discoveryQueueSkipLabel,
  discoveryRoleLabel,
  discoverySelectionAfterTransition,
  orderedSelectedDiscoveryJobIds,
  pruneDiscoverySelection,
  toggleAllDiscoverySelection,
} from "../app/components/discovery-catalog";

function job(id: string, roles: DiscoveryJob["roles"]): DiscoveryJob {
  return {
    id,
    title: `${roles.join(" ")} intern`,
    company: "Example Labs",
    location: "Remote",
    roles,
    canonicalUrl: `https://example.com/jobs/${id}`,
    applyUrl: `https://example.com/jobs/${id}/apply`,
    descriptionPreview: "Work with a small engineering team on production systems.",
    postedAt: null,
    firstSeenAt: 1_775_174_400_000,
    lastSeenAt: 1_775_174_460_000,
    status: "open",
    sourceNames: ["Simplify"],
  };
}

const softwareJobs = [
  job("swe-1", ["software_engineering"]),
  job("swe-2", ["software_engineering"]),
];

describe("DiscoveryCatalog selection", () => {
  test("selects every loaded job in the current role result and clears them together", () => {
    const selected = toggleAllDiscoverySelection(new Set(), softwareJobs);

    expect([...selected]).toEqual(["swe-1", "swe-2"]);
    expect([...toggleAllDiscoverySelection(selected, softwareJobs)]).toEqual([]);
  });

  test("preserves still-visible selections after refresh and queues them in result order", () => {
    const refreshed = [softwareJobs[1]!, job("ml-1", ["machine_learning"])];
    const selected = pruneDiscoverySelection(new Set(["swe-1", "swe-2", "missing"]), refreshed);

    expect([...selected]).toEqual(["swe-2"]);
    expect(orderedSelectedDiscoveryJobIds(refreshed, new Set(["ml-1", "swe-2"]))).toEqual([
      "swe-2",
      "ml-1",
    ]);
  });

  test("keeps selection only for refreshes of the same page", () => {
    const selected = new Set(["swe-1", "swe-2"]);

    expect([...discoverySelectionAfterTransition(selected, "refresh")])
      .toEqual(["swe-1", "swe-2"]);
    for (const transition of ["page", "role", "recency", "status", "search"] as const) {
      expect([...discoverySelectionAfterTransition(selected, transition)]).toEqual([]);
    }
  });

  test("uses a safe public label for unexpected queue failures", () => {
    expect(discoveryQueueSkipLabel("queue_failed")).toBe("Could not be queued");
  });

  test("labels every role assigned to a job", () => {
    expect(discoveryRoleLabel(["software_engineering", "machine_learning"]))
      .toBe("Software engineering · Machine learning");
  });

  test("renders accessible loading controls with the seven-day filter selected by default", () => {
    const markup = renderToStaticMarkup(<DiscoveryCatalog />);

    expect(markup).toContain("Search internships");
    expect(markup).toContain("Select all visible jobs");
    expect(markup).toContain('<option value="7" selected="">7 days</option>');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-busy="true"');
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
});
