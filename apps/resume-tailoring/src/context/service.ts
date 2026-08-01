import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type {
  ContextSnapshot,
  ContextSyncReport,
  EvidenceBlock,
  IndexedContextSource,
} from "./types.ts";
import {
  loadContextManifest,
  resolveContextSource,
  type LoadedContextManifest,
} from "./manifest.ts";
import { parseEvidenceBlocks } from "./parser.ts";
import { extractMustIncludeDirectives } from "./directives.ts";
import { sha256 } from "./sha256.ts";

interface VersionRow {
  readonly id: string;
  readonly indexed_at: number;
}

interface HeadRow {
  readonly source_version_id: string;
  readonly sha256: string;
}

interface SourceRow {
  readonly id: string;
  readonly source_id: string;
  readonly relative_path: string;
  readonly kind: "baseline" | "authoritative-markdown";
  readonly entity_id: string;
  readonly display_name: string;
  readonly sha256: string;
  readonly byte_count: number;
  readonly indexed_at: number;
}

interface EvidenceRow {
  readonly id: string;
  readonly source_version_id: string;
  readonly source_id: string;
  readonly entity_id: string;
  readonly ordinal: number;
  readonly heading_path_json: string;
  readonly text: string;
  readonly caveats_json: string;
  readonly sha256: string;
}

interface MetadataRow { readonly value: string }
interface FtsRow { readonly evidence_id: string }

export interface ContextFreshnessReport {
  readonly fresh: boolean;
  readonly manifestMatches: boolean;
  readonly staleSources: readonly string[];
  readonly missingSources: readonly string[];
}

export interface ContextDriftReport {
  readonly valid: boolean;
  readonly manifestChanged: boolean;
  readonly changedSources: readonly string[];
}

function parseStringArray(json: string, label: string): readonly string[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} is corrupt`);
  return Object.freeze([...value]);
}

function evidenceFromRow(row: EvidenceRow): EvidenceBlock {
  return Object.freeze({
    id: row.id,
    sourceVersionId: row.source_version_id,
    sourceId: row.source_id,
    entityId: row.entity_id,
    ordinal: row.ordinal,
    headingPath: parseStringArray(row.heading_path_json, "evidence heading path"),
    text: row.text,
    caveats: parseStringArray(row.caveats_json, "evidence caveats"),
    sha256: row.sha256,
  });
}

export function syncContext(
  database: Database,
  loaded: LoadedContextManifest = loadContextManifest(),
  now = Date.now(),
): ContextSyncReport {
  const changedSources: string[] = [];
  let blockCount = 0;
  const sync = database.transaction(() => {
    for (const source of loaded.manifest.sources) {
      const path = resolveContextSource(loaded.repositoryRoot, source);
      const bytes = readFileSync(path);
      const hash = sha256(bytes);
      const sourceVersionId = `source_${sha256(`${source.id}\0${hash}`)}`;
      const head = database.query<HeadRow, [string]>(`
        SELECT h.source_version_id, v.sha256
        FROM source_heads h JOIN source_versions v ON v.id = h.source_version_id
        WHERE h.source_id = ?
      `).get(source.id);
      if (head?.sha256 !== hash) changedSources.push(source.id);

      const existing = database.query<VersionRow, [string]>("SELECT id, indexed_at FROM source_versions WHERE id = ?").get(sourceVersionId);
      if (!existing) {
        database.query(`
          INSERT INTO source_versions
            (id, source_id, relative_path, kind, entity_id, display_name, baseline_entity_ids_json, sha256, byte_count, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(sourceVersionId, source.id, source.relativePath, source.kind, source.entityId, source.displayName,
          JSON.stringify(source.baselineEntityIds), hash, bytes.byteLength, now);
        const blocks = parseEvidenceBlocks(source, sourceVersionId, bytes);
        for (const block of blocks) {
          database.query(`
            INSERT INTO evidence_blocks
              (id, source_version_id, source_id, entity_id, ordinal, heading_path_json, text, caveats_json, sha256)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(block.id, block.sourceVersionId, block.sourceId, block.entityId, block.ordinal,
            JSON.stringify(block.headingPath), block.text, JSON.stringify(block.caveats), block.sha256);
          database.query(`
            INSERT INTO evidence_fts (evidence_id, source_id, entity_id, heading_path, text, caveats)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(block.id, block.sourceId, block.entityId, block.headingPath.join(" > "), block.text, block.caveats.join("\n"));
        }
      }
      database.query(`
        INSERT INTO source_heads (source_id, source_version_id) VALUES (?, ?)
        ON CONFLICT(source_id) DO UPDATE SET source_version_id = excluded.source_version_id
      `).run(source.id, sourceVersionId);
    }
    database.query(`
      INSERT INTO context_metadata (key, value) VALUES ('manifest_sha256', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(loaded.manifestSha256);
  });
  sync();
  const count = database.query<{ count: number }, []>(`
    SELECT count(*) AS count FROM evidence_blocks b
    JOIN source_heads h ON h.source_version_id = b.source_version_id
  `).get();
  blockCount = count?.count ?? 0;
  return Object.freeze({
    manifestSha256: loaded.manifestSha256,
    indexedAt: now,
    changedSources: Object.freeze(changedSources),
    sourceCount: loaded.manifest.sources.length,
    blockCount,
    fresh: true,
  });
}

export function checkContextFreshness(
  database: Database,
  loaded: LoadedContextManifest = loadContextManifest(),
): ContextFreshnessReport {
  const staleSources: string[] = [];
  const missingSources: string[] = [];
  for (const source of loaded.manifest.sources) {
    const bytes = readFileSync(resolveContextSource(loaded.repositoryRoot, source));
    const currentHash = sha256(bytes);
    const head = database.query<HeadRow, [string]>(`
      SELECT h.source_version_id, v.sha256 FROM source_heads h
      JOIN source_versions v ON v.id = h.source_version_id WHERE h.source_id = ?
    `).get(source.id);
    if (!head) missingSources.push(source.id);
    else if (head.sha256 !== currentHash) staleSources.push(source.id);
  }
  const storedManifest = database.query<MetadataRow, []>("SELECT value FROM context_metadata WHERE key = 'manifest_sha256'").get();
  const manifestMatches = storedManifest?.value === loaded.manifestSha256;
  return Object.freeze({
    fresh: manifestMatches && staleSources.length === 0 && missingSources.length === 0,
    manifestMatches,
    staleSources: Object.freeze(staleSources),
    missingSources: Object.freeze(missingSources),
  });
}

export function createContextSnapshot(
  database: Database,
  loaded: LoadedContextManifest = loadContextManifest(),
): ContextSnapshot {
  const freshness = checkContextFreshness(database, loaded);
  if (!freshness.fresh) throw new Error("Context index is stale; synchronize before creating a snapshot");
  const manifestSourceIds = new Set(loaded.manifest.sources.map((source) => source.id));
  const rows = database.query<SourceRow, []>(`
    SELECT v.* FROM source_versions v JOIN source_heads h ON h.source_version_id = v.id
  `).all();
  const sourceById = new Map(rows.map((row) => [row.source_id, row]));
  const sources: IndexedContextSource[] = loaded.manifest.sources.map((definition) => {
    const row = sourceById.get(definition.id);
    if (!row) throw new Error(`Missing indexed source: ${definition.id}`);
    return Object.freeze({
      ...definition,
      sourceVersionId: row.id,
      sha256: row.sha256,
      bytes: row.byte_count,
      indexedAt: row.indexed_at,
    });
  });
  const evidenceRows = database.query<EvidenceRow, []>(`
    SELECT b.* FROM evidence_blocks b JOIN source_heads h ON h.source_version_id = b.source_version_id
    ORDER BY b.source_id, b.ordinal
  `).all();
  const evidence = Object.freeze(evidenceRows.filter((row) => manifestSourceIds.has(row.source_id)).map(evidenceFromRow));
  const sourceHashes = Object.freeze(Object.fromEntries(sources.map((source) => [source.id, source.sha256])));
  const baseline = sources.find((source) => source.kind === "baseline");
  if (!baseline) throw new Error("Indexed context has no baseline");
  return Object.freeze({
    manifestSha256: loaded.manifestSha256,
    baselineSha256: baseline.sha256,
    sourceHashes,
    sources: Object.freeze(sources),
    evidence,
    mustIncludeDirectives: extractMustIncludeDirectives(sources, evidence),
    explicitEntityBindings: Object.freeze({ ...loaded.manifest.explicitEntityBindings }),
  });
}

export function verifyContextSnapshot(
  snapshot: ContextSnapshot,
  loaded: LoadedContextManifest = loadContextManifest(),
): ContextDriftReport {
  const changedSources: string[] = [];
  for (const source of loaded.manifest.sources) {
    const currentHash = sha256(readFileSync(resolveContextSource(loaded.repositoryRoot, source)));
    if (snapshot.sourceHashes[source.id] !== currentHash) changedSources.push(source.id);
  }
  const manifestChanged = snapshot.manifestSha256 !== loaded.manifestSha256;
  return Object.freeze({ valid: !manifestChanged && changedSources.length === 0, manifestChanged, changedSources: Object.freeze(changedSources) });
}

export function searchEvidence(database: Database, query: string, limit = 20): readonly EvidenceBlock[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Search limit must be an integer from 1 to 100");
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return Object.freeze([]);
  const safeQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
  const matches = database.query<FtsRow, [string, number]>(`
    SELECT f.evidence_id FROM evidence_fts f
    JOIN evidence_blocks b ON b.id = f.evidence_id
    JOIN source_heads h ON h.source_version_id = b.source_version_id
    WHERE evidence_fts MATCH ? ORDER BY bm25(evidence_fts), b.id LIMIT ?
  `).all(safeQuery, limit);
  const byId = database.query<EvidenceRow, []>(`
    SELECT b.* FROM evidence_blocks b JOIN source_heads h ON h.source_version_id = b.source_version_id
  `).all();
  const rows = new Map(byId.map((row) => [row.id, row]));
  return Object.freeze(matches.map((match) => rows.get(match.evidence_id)).filter((row): row is EvidenceRow => row !== undefined).map(evidenceFromRow));
}
