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
  readonly description: string | null;
  readonly postedAt?: number | null | undefined;
  readonly requisitionId?: string | undefined;
}

export interface DiscoveryKnownItemKey {
  readonly sourceItemId: string;
  readonly canonicalUrl: string;
}

export interface DiscoveryKnownItem extends DiscoveryKnownItemKey {
  readonly description: string | null;
}

export interface DiscoveryConnectorSyncContext {
  readonly findKnownItems: (
    candidates: readonly DiscoveryKnownItemKey[],
  ) => readonly DiscoveryKnownItemKey[];
  readonly loadKnownItems: (
    candidates: readonly DiscoveryKnownItemKey[],
  ) => readonly DiscoveryKnownItem[];
}

export interface ClassifiedDiscoveredJobInput extends DiscoveredJobInput {
  readonly roles: readonly DiscoveryRole[];
  readonly suitable: boolean;
}

export interface DiscoverySyncResult {
  readonly items: readonly DiscoveredJobInput[];
  readonly completeSnapshot: boolean;
  readonly descriptionUnavailable: number;
  readonly provenance?: string;
}

export interface DiscoveryConnector {
  readonly id: string;
  readonly name: string;
  readonly kind: DiscoverySourceKind;
  sync(
    signal: AbortSignal,
    context?: DiscoveryConnectorSyncContext,
    budget?: DiscoveryHttpBudget,
  ): Promise<DiscoverySyncResult>;
}
