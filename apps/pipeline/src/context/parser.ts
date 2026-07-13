import type { ContextSourceDefinition, EvidenceBlock } from "./types.ts";
import { sha256 } from "./sha256.ts";

const CAVEAT_PATTERN = /\b(user-reported|not independently|not documented|not supplied|not provided|unconfirmed|unknown|avoid representing|review note|inference|evidence policy|repository attribution|does not establish|cannot substantiate)\b|\[INFERENCE\]/i;

interface ParsedBlock {
  readonly headingPath: readonly string[];
  readonly text: string;
}

function parseMarkdownBlocks(markdown: string): readonly ParsedBlock[] {
  const normalized = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const headings: string[] = [];
  const blocks: ParsedBlock[] = [];
  let pending: string[] = [];

  const flush = (): void => {
    const text = pending.join("\n").trim();
    if (text.length > 0) blocks.push(Object.freeze({ headingPath: Object.freeze([...headings]), text }));
    pending = [];
  };

  for (const line of normalized.split("\n")) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      headings.length = level - 1;
      headings[level - 1] = heading[2]!.replace(/\s+#+\s*$/, "").trim();
      continue;
    }
    if (line.trim().length === 0) flush();
    else pending.push(line.trimEnd());
  }
  flush();
  return Object.freeze(blocks);
}

function caveatLines(text: string): readonly string[] {
  return Object.freeze(text.split("\n").map((line) => line.trim()).filter((line) => CAVEAT_PATTERN.test(line)));
}

export function parseEvidenceBlocks(
  source: ContextSourceDefinition,
  sourceVersionId: string,
  bytes: Uint8Array,
): readonly EvidenceBlock[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = source.kind === "authoritative-markdown"
    ? parseMarkdownBlocks(text)
    : Object.freeze([{ headingPath: Object.freeze([source.displayName]), text }]);
  const globalCaveats = source.kind === "authoritative-markdown"
    ? Object.freeze(parsed.flatMap((block) => caveatLines(block.text)).filter((line) => /evidence policy|repository attribution|not independently measurable/i.test(line)))
    : Object.freeze([] as string[]);

  return Object.freeze(parsed.map((block, ordinal) => {
    const localCaveats = caveatLines(block.text);
    const caveats = Object.freeze([...new Set([...globalCaveats, ...localCaveats])]);
    const blockSha256 = sha256(block.text);
    return Object.freeze({
      id: `evidence_${sha256(`${sourceVersionId}\0${ordinal}\0${block.headingPath.join("\0")}\0${block.text}`)}`,
      sourceVersionId,
      sourceId: source.id,
      entityId: source.entityId,
      ordinal,
      headingPath: block.headingPath,
      text: block.text,
      caveats,
      sha256: blockSha256,
    });
  }));
}
