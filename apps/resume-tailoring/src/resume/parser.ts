import { createHash } from "node:crypto";
import type { ResumeSection } from "./types.ts";

export const EDITABLE_SECTIONS = ["experience", "projects", "competitions-other", "technical-skills"] as const;
export const KNOWN_BODY_MACROS: Readonly<Record<string, true>> = {
  resumeSubHeadingListStart: true, resumeSubHeadingListEnd: true, resumeSubheading: true, resumeProjectHeading: true,
  resumeItemListStart: true, resumeItemListEnd: true, resumeItem: true, begin: true, end: true, small: true, item: true, textbf: true,
};

export interface BaselineBullet { readonly id: string; readonly entityId: string; readonly section: "experience" | "projects" | "competitions-other"; readonly text: string; }
export interface BaselineEntity {
  readonly id: string;
  readonly entityId: string;
  readonly section: "experience" | "projects" | "competitions-other";
  readonly headingArguments: readonly string[];
  readonly bullets: readonly BaselineBullet[];
}
export interface BaselineSkill { readonly id: string; readonly category: string; readonly skill: string; }
export interface ResumeRegion { readonly section: ResumeSection; readonly headingStart: number; readonly bodyStart: number; readonly bodyEnd: number; readonly heading: string; readonly body: string; }
export interface ParsedBaselineResume {
  readonly source: string;
  readonly sha256: string;
  readonly regions: Readonly<Record<ResumeSection, ResumeRegion>>;
  readonly entities: readonly BaselineEntity[];
  readonly bullets: readonly BaselineBullet[];
  readonly skills: readonly BaselineSkill[];
}

function stableId(kind: string, ...parts: string[]): string {
  return `${kind}:${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 20)}`;
}

function stripComments(value: string): string {
  let segments: string[] | undefined;
  let copyStart = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "%") continue;
    let precedingBackslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) precedingBackslashes++;
    if (precedingBackslashes % 2 === 1) continue;
    let commentEnd = index + 1;
    while (commentEnd < value.length && value[commentEnd] !== "\n" && value[commentEnd] !== "\r") commentEnd++;
    segments ??= [];
    segments.push(value.slice(copyStart, index), " ".repeat(commentEnd - index));
    copyStart = commentEnd;
    index = commentEnd - 1;
  }
  if (!segments) return value;
  segments.push(value.slice(copyStart));
  return segments.join("");
}

export function readBracedArgument(source: string, start: number): { value: string; end: number } {
  if (source[start] !== "{") throw new Error(`expected opening brace at ${start}`);
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (char === "\\") { index++; continue; }
    if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return { value: source.slice(start + 1, index), end: index + 1 };
  }
  throw new Error(`unbalanced brace at ${start}`);
}

export function parseMacroCalls(source: string, macro: string, argumentCount: number): readonly { start: number; end: number; args: readonly string[] }[] {
  const clean = stripComments(source);
  const calls: { start: number; end: number; args: readonly string[] }[] = [];
  const pattern = new RegExp(`\\\\${macro}(?![A-Za-z@])`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(clean))) {
    let cursor = match.index + match[0].length;
    const args: string[] = [];
    try {
      for (let count = 0; count < argumentCount; count++) {
        while (/\s/.test(clean[cursor] ?? "")) cursor++;
        const argument = readBracedArgument(clean, cursor);
        args.push(argument.value);
        cursor = argument.end;
      }
    } catch { continue; }
    calls.push({ start: match.index, end: cursor, args });
    pattern.lastIndex = cursor;
  }
  return calls;
}

function plain(value: string): string {
  return value
    .replace(/\\(?:textbf|emph|normalfont|small|underline)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\&/g, "&").replace(/\\%/g, "%").replace(/\\\$/g, "$")
    .replace(/\\[A-Za-z@]+\b/g, "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

function locateSection(source: string, heading: string, section: ResumeSection): ResumeRegion {
  const marker = `\\section{${heading}}`;
  const headingStart = source.indexOf(marker);
  if (headingStart < 0) throw new Error(`missing required section ${heading}`);
  const bodyStart = headingStart + marker.length;
  const nextSection = source.indexOf("\\section{", bodyStart);
  const documentEnd = source.indexOf("\\end{document}", bodyStart);
  const bodyEnd = nextSection >= 0 ? nextSection : documentEnd;
  if (bodyEnd < 0) throw new Error(`unterminated section ${heading}`);
  return { section, headingStart, bodyStart, bodyEnd, heading: marker, body: source.slice(bodyStart, bodyEnd) };
}

function parseEntities(region: ResumeRegion): BaselineEntity[] {
  if (region.section === "technical-skills") throw new Error("technical skills do not contain resume entities");
  const section = region.section;
  const macro = section === "projects" ? "resumeProjectHeading" : "resumeSubheading";
  const argCount = section === "projects" ? 2 : 4;
  const headings = parseMacroCalls(region.body, macro, argCount);
  return headings.map((heading, index) => {
    const next = headings[index + 1]?.start ?? region.body.length;
    const chunk = region.body.slice(heading.end, next);
    const itemCalls = parseMacroCalls(chunk, "resumeItem", 1);
    const headingArgs = heading.args;
    const entityId = section === "projects"
      ? plain((headingArgs[0] ?? "").split(/\s*(?:\\enspace\s*)?(?:\$\|\$|\\textbar(?![A-Za-z@]))(?:\s*\\enspace)?\s*/)[0]!).trim()
      : plain(headingArgs[2] ?? "");
    if (!entityId) throw new Error(`empty entity in ${section}`);
    const entityStableId = stableId("entity", section, entityId, headingArgs.join("\u0000"));
    const bullets = itemCalls.map((item, itemIndex) => {
      const text = plain(item.args[0] ?? "");
      return { id: stableId("bullet", entityStableId, String(itemIndex), text), entityId, section, text } as const;
    });
    return { id: entityStableId, entityId, section, headingArguments: headingArgs, bullets };
  });
}

function parseSkills(region: ResumeRegion): BaselineSkill[] {
  const calls = parseMacroCalls(region.body, "textbf", 1);
  const skills: BaselineSkill[] = [];
  for (const [index, call] of calls.entries()) {
    const category = plain(call.args[0] ?? "");
    const tail = region.body.slice(call.end, calls[index + 1]?.start ?? region.body.length);
    const value = tail.match(/^\s*\{:\s*([^}]*)\}/)?.[1];
    if (!category || value === undefined) continue;
    for (const skill of value.split(",").map((item) => plain(item)).filter(Boolean)) skills.push({ id: stableId("skill", category, skill), category, skill });
  }
  return skills;
}

export function parseBaselineResume(source: string): ParsedBaselineResume {
  if (Buffer.byteLength(source) > 256 * 1024) throw new Error("baseline exceeds 256 KiB");
  if ((source.match(/\\begin\{document\}/g) ?? []).length !== 1 || (source.match(/\\end\{document\}/g) ?? []).length !== 1) throw new Error("baseline must contain exactly one document wrapper");
  const experience = locateSection(source, "Experience", "experience");
  const projects = locateSection(source, "Projects", "projects");
  const competitionsOther = locateSection(source, "Competitions \\& Other", "competitions-other");
  const technicalSkills = locateSection(source, "Technical Skills", "technical-skills");
  const regions = { experience, projects, "competitions-other": competitionsOther, "technical-skills": technicalSkills } as const;
  const entities = [...parseEntities(experience), ...parseEntities(projects), ...parseEntities(competitionsOther)];
  const bullets = entities.flatMap((entity) => entity.bullets);
  if (entities.length === 0 || bullets.length === 0) throw new Error("baseline has no editable entities or bullets");
  return { source, sha256: createHash("sha256").update(source).digest("hex"), regions, entities, bullets, skills: parseSkills(technicalSkills) };
}

export function immutableChunks(parsed: ParsedBaselineResume): readonly string[] {
  const regions = Object.values(parsed.regions).sort((a, b) => a.bodyStart - b.bodyStart);
  const chunks: string[] = [];
  let cursor = 0;
  for (const region of regions) { chunks.push(parsed.source.slice(cursor, region.bodyStart)); cursor = region.bodyEnd; }
  chunks.push(parsed.source.slice(cursor));
  return chunks;
}
