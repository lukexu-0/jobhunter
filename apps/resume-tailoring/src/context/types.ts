export type ContextSourceKind = "baseline" | "authoritative-markdown";

export interface ContextSourceDefinition {
  readonly id: string;
  readonly relativePath: string;
  readonly kind: ContextSourceKind;
  readonly entityId: string;
  readonly displayName: string;
  readonly baselineEntityIds: readonly string[];
}

export interface ContextManifest {
  readonly version: 1;
  readonly sources: readonly ContextSourceDefinition[];
  readonly explicitEntityBindings: Readonly<Record<string, string>>;
}

export interface IndexedContextSource extends ContextSourceDefinition {
  readonly sourceVersionId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly indexedAt: number;
}

export interface EvidenceBlock {
  readonly id: string;
  readonly sourceVersionId: string;
  readonly sourceId: string;
  readonly entityId: string;
  readonly ordinal: number;
  readonly headingPath: readonly string[];
  readonly text: string;
  readonly caveats: readonly string[];
  readonly sha256: string;
}


export interface ContextSnapshot {
  readonly manifestSha256: string;
  readonly baselineSha256: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly sources: readonly IndexedContextSource[];
  readonly evidence: readonly EvidenceBlock[];
  readonly explicitEntityBindings: Readonly<Record<string, string>>;
}

export interface ContextSyncReport {
  readonly manifestSha256: string;
  readonly indexedAt: number;
  readonly changedSources: readonly string[];
  readonly sourceCount: number;
  readonly blockCount: number;
  readonly fresh: boolean;
}
