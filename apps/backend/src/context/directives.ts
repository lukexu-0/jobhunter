import type {
  ContextMustIncludeDirective,
  EvidenceBlock,
  IndexedContextSource,
} from "./types.ts";

const MUST_INCLUDE_HEADING = /^(?:21\.\s+)?Must Include$/;

export function isMustIncludeEvidenceBlock(
  source: IndexedContextSource | undefined,
  block: EvidenceBlock,
): boolean {
  return source?.kind === "authoritative-markdown"
    && source.id === block.sourceId
    && source.sourceVersionId === block.sourceVersionId
    && source.entityId === block.entityId
    && MUST_INCLUDE_HEADING.test(block.headingPath.at(-1) ?? "");
}

export function extractMustIncludeDirectives(
  sources: readonly IndexedContextSource[],
  evidence: readonly EvidenceBlock[],
): readonly ContextMustIncludeDirective[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const directives: ContextMustIncludeDirective[] = [];

  for (const block of evidence) {
    const source = sourceById.get(block.sourceId);
    if (!source || source.sourceVersionId !== block.sourceVersionId || source.entityId !== block.entityId) {
      throw new Error(`Evidence block ${block.id} does not match its indexed source`);
    }
    if (
      !isMustIncludeEvidenceBlock(source, block)
      || block.text.normalize("NFC").replace(/\s+/gu, " ").trim() === "None specified"
    ) continue;
    directives.push(Object.freeze({
      sourceId: block.sourceId,
      entityId: block.entityId,
      text: block.text,
    }));
  }

  return Object.freeze(directives);
}
