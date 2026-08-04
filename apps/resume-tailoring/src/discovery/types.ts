import type { DiscoveryHttpBudget } from "./connectors/http.ts";

export const DISCOVERY_ROLES = [
  "software_engineering",
  "machine_learning",
  "data",
  "security",
  "product",
  "hardware",
  "other",
] as const;

export type DiscoveryRole = (typeof DISCOVERY_ROLES)[number];

export const DISCOVERY_SOURCE_KINDS = [
  "simplify",
  "zapply",
  "speedyapply",
  "linkedin",
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workable",
  "recruitee",
  "personio",
  "workday",
  "job_board",
] as const;

export type DiscoverySourceKind = (typeof DISCOVERY_SOURCE_KINDS)[number];

export interface DiscoveredJobInput {
  readonly sourceItemId: string;
  readonly sourceUrl: string;
  readonly canonicalUrl: string;
  readonly applyUrl: string;
  readonly title: string;
  readonly company: string;
  readonly location?: string | null | undefined;
  readonly description: string;
  readonly postedAt?: number | null | undefined;
  readonly role?: DiscoveryRole | undefined;
  readonly requisitionId?: string | undefined;
}

export interface DiscoverySyncResult {
  readonly items: readonly DiscoveredJobInput[];
  readonly completeSnapshot: boolean;
  readonly provenance?: string;
}

export interface DiscoveryConnector {
  readonly id: string;
  readonly name: string;
  readonly kind: DiscoverySourceKind;
  sync(signal: AbortSignal, budget?: DiscoveryHttpBudget): Promise<DiscoverySyncResult>;
}
