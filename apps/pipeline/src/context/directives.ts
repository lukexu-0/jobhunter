import type {
  ContextMustIncludeDirective,
  EvidenceBlock,
  IndexedContextSource,
} from "./types.ts";

export function extractMustIncludeDirectives(
  sources: readonly IndexedContextSource[],
  evidence: readonly EvidenceBlock[],
): readonly ContextMustIncludeDirective[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return Object.freeze(evidence.flatMap((block) => {
    const source = sourceById.get(block.sourceId);
    const terminalHeading = block.headingPath.at(-1);
    if (source?.kind !== "authoritative-markdown"
      || terminalHeading === undefined
      || !/^(?:21\.\s+)?Must Include$/.test(terminalHeading)
      || block.text.normalize("NFC").replace(/\s+/gu, " ").trim() === "None specified") return [];
    return [Object.freeze({
      evidenceId: block.id,
      sourceId: block.sourceId,
      entityId: block.entityId,
      text: block.text,
    })];
  }));
}
