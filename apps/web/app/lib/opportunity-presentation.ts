import type { OpportunityKind } from "@jobhunter/pipeline/contracts";

export interface OpportunityPresentation {
  readonly visibleKindLabel: string | null;
  readonly summaryLabel: string;
  readonly titleFallback: string;
  readonly organizationFallback: string;
  readonly linkLabel: string;
  readonly openNamedPrefix: string;
  readonly openFallbackLabel: string;
  readonly dashboardTitleFallback: string | null;
  readonly dashboardOrganizationFallback: string | null;
}

export const OPPORTUNITY_PRESENTATION = {
  job: {
    visibleKindLabel: null,
    summaryLabel: "Application summary and keyword comparison",
    titleFallback: "Application",
    organizationFallback: "Organization unavailable",
    linkLabel: "View job posting",
    openNamedPrefix: "Open",
    openFallbackLabel: "Open application",
    dashboardTitleFallback: null,
    dashboardOrganizationFallback: null,
  },
  hackathon: {
    visibleKindLabel: "Hackathon",
    summaryLabel: "Hackathon summary and keyword comparison",
    titleFallback: "Hackathon",
    organizationFallback: "Organizer unavailable",
    linkLabel: "View hackathon details",
    openNamedPrefix: "Open hackathon",
    openFallbackLabel: "Open hackathon",
    dashboardTitleFallback: "Details unavailable",
    dashboardOrganizationFallback: "Organizer unavailable",
  },
  competition: {
    visibleKindLabel: "Competition",
    summaryLabel: "Competition summary and keyword comparison",
    titleFallback: "Competition",
    organizationFallback: "Organizer unavailable",
    linkLabel: "View competition details",
    openNamedPrefix: "Open competition",
    openFallbackLabel: "Open competition",
    dashboardTitleFallback: "Details unavailable",
    dashboardOrganizationFallback: "Organizer unavailable",
  },
  event: {
    visibleKindLabel: "Event",
    summaryLabel: "Event summary and keyword comparison",
    titleFallback: "Event",
    organizationFallback: "Organizer unavailable",
    linkLabel: "View event details",
    openNamedPrefix: "Open event",
    openFallbackLabel: "Open event",
    dashboardTitleFallback: "Details unavailable",
    dashboardOrganizationFallback: "Organizer unavailable",
  },
} as const satisfies Record<OpportunityKind, OpportunityPresentation>;

export function opportunityPresentation(kind: OpportunityKind): OpportunityPresentation {
  return OPPORTUNITY_PRESENTATION[kind];
}
