import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Briefcase, CalendarDays, Code2, Trophy } from "lucide-react";
import {
  OpportunityKindSchema,
  type RunDto,
} from "@jobhunter/pipeline/contracts";
import { RunIdentityLink } from "../app/components/run-dashboard";
import { RunIdentitySummary } from "../app/components/run-detail";
import {
  OPPORTUNITY_PRESENTATION,
  opportunityPresentation,
} from "../app/lib/opportunity-presentation";

const EXPECTED_ICONS = {
  job: Briefcase,
  hackathon: Code2,
  competition: Trophy,
  event: CalendarDays,
} as const;

function run(opportunityKind: RunDto["opportunityKind"]): RunDto {
  return {
    id: `${opportunityKind}-run`,
    opportunityKind,
    jobUrl: `https://example.test/${opportunityKind}`,
    status: "approved",
    applicationStatus: "pending",
    queueSequence: 1,
    generateKeywordMap: false,
    skipReview: false,
    autoSubmit: false,
    revision: 1,
    origin: "initial",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_060_000,
    visualAcknowledgementRequired: false,
    attempts: [],
    artifacts: [],
    timeline: [],
  };
}

describe("opportunity-kind presentation", () => {
  test("exhaustively defines opportunity presentation copy", () => {
    expect(Object.keys(OPPORTUNITY_PRESENTATION).sort()).toEqual(
      [...OpportunityKindSchema.options].sort(),
    );

    for (const kind of OpportunityKindSchema.options) {
      expect(opportunityPresentation(kind).icon).toBe(EXPECTED_ICONS[kind]);
    }

    const job = opportunityPresentation("job");
    expect(job).toMatchObject({
      detailKindLabel: "Job",
      visibleKindLabel: null,
      summaryLabel: "Application summary and keyword comparison",
      titleFallback: "Application",
      organizationFallback: "Organization unavailable",
      linkLabel: "View job posting",
      openNamedPrefix: "Open",
      openFallbackLabel: "Open application",
      dashboardTitleFallback: null,
      dashboardOrganizationFallback: null,
    });

    for (const kind of OpportunityKindSchema.options) {
      if (kind === "job") continue;
      const presentation = opportunityPresentation(kind);
      expect(presentation.visibleKindLabel).not.toBeNull();
      expect(presentation.summaryLabel).not.toBe(job.summaryLabel);
      expect(presentation.titleFallback).not.toBe(job.titleFallback);
      expect(presentation.organizationFallback).not.toBe(job.organizationFallback);
      expect(presentation.linkLabel).not.toBe(job.linkLabel);
      expect(presentation.openNamedPrefix).not.toBe(job.openNamedPrefix);
      expect(presentation.dashboardTitleFallback).not.toBeNull();
      expect(presentation.dashboardOrganizationFallback).not.toBeNull();
    }
  });

  test("renders one decorative mapped icon on both identity surfaces for every kind", () => {
    for (const kind of OpportunityKindSchema.options) {
      const kindRun = run(kind);
      const detailMarkup = renderToStaticMarkup(
        <RunIdentitySummary identity={null} run={kindRun} />,
      );
      const dashboardMarkup = renderToStaticMarkup(
        <RunIdentityLink identity={{}} run={kindRun} />,
      );

      for (const markup of [detailMarkup, dashboardMarkup]) {
        expect(markup.match(/<svg\b[^>]*aria-hidden="true"[^>]*>/g)).toHaveLength(1);
      }
    }
  });

  test("renders an event DTO distinctly in detail and dashboard identity views", () => {
    const eventRun = run("event");
    const detailMarkup = renderToStaticMarkup(
      <RunIdentitySummary identity={null} run={eventRun} />,
    );
    const dashboardMarkup = renderToStaticMarkup(
      <RunIdentityLink identity={{}} run={eventRun} />,
    );

    expect(opportunityPresentation(eventRun.opportunityKind).summaryLabel).toBe(
      "Event summary and keyword comparison",
    );
    expect(detailMarkup).toContain("Event</p>");
    expect(detailMarkup).toContain(">Event</h1>");
    expect(detailMarkup).toContain("Organizer unavailable");
    expect(detailMarkup).toContain("View event details");
    expect(detailMarkup).toContain('href="https://example.test/event"');
    expect(detailMarkup).toContain('target="_blank"');
    expect(detailMarkup).toContain('rel="noreferrer"');
    expect(detailMarkup).not.toContain("View job posting");

    expect(dashboardMarkup).toContain("Event · ");
    expect(dashboardMarkup).toContain("Details unavailable");
    expect(dashboardMarkup).toContain('aria-label="Open event Details unavailable event-run"');
    expect(dashboardMarkup).not.toContain("Open application");
  });

  test("preserves established job summary and dashboard identity copy", () => {
    const jobRun: RunDto = {
      ...run("job"),
      titleOverride: "Platform Engineer",
      organizationOverride: "Example Labs",
    };
    const detailMarkup = renderToStaticMarkup(
      <RunIdentitySummary identity={null} run={jobRun} />,
    );
    const dashboardMarkup = renderToStaticMarkup(
      <RunIdentityLink identity={{ title: "Platform Engineer" }} run={jobRun} />,
    );

    expect(detailMarkup).toContain("Platform Engineer");
    expect(detailMarkup).toContain("Example Labs");
    expect(detailMarkup).toContain("View job posting");
    expect(detailMarkup).toContain("Job</p>");
    expect(dashboardMarkup).toContain('aria-label="Open Platform Engineer job-run"');
    expect(dashboardMarkup).not.toContain("Job · ");
  });
});
