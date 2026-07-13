import { parseBaselineResume, readBracedArgument } from "./parser.ts";
import { RepairResultSchema, type RepairResult, type ResumeSection } from "./types.ts";
import { ResumeValidationError } from "./render.ts";

const FORBIDDEN_PRIMITIVES = [
  "input", "include", "openin", "openout", "read", "write", "immediate", "special", "usepackage", "RequirePackage",
  "includegraphics", "pdfobj", "pdfxform", "pdfliteral", "catcode", "csname", "newcommand", "renewcommand", "providecommand",
  "def", "edef", "gdef", "xdef", "loop", "directlua", "write18",
] as const;
const FORBIDDEN_PATTERN = new RegExp(`\\\\(?:${FORBIDDEN_PRIMITIVES.join("|")})(?![A-Za-z@])`, "i");
const SHELL_PATTERN = /(?:--shell-escape|enable-write18|\\(?:pdf)?shellescape\b)/i;
const ALLOWED_BODY_COMMANDS: Record<string, true> = {
  resumeSubHeadingListStart: true, resumeSubHeadingListEnd: true, resumeSubheading: true, resumeProjectHeading: true,
  resumeItemListStart: true, resumeItemListEnd: true, resumeItem: true, begin: true, end: true, small: true, item: true,
  textbf: true, emph: true, textbackslash: true, textasciitilde: true, textasciicircum: true, "\\": true,
};

export interface RepairValidation {
  readonly valid: true;
  readonly normalizedVisibleContent: Readonly<Record<ResumeSection, string>>;
  readonly controlSequenceOrder: readonly string[];
}

interface BodySplit { readonly bodies: Readonly<Record<ResumeSection, string>>; readonly immutableSkeleton: string; }

function splitBodies(source: string): BodySplit {
  const definitions = [
    { section: "experience" as const, marker: "\\section{Experience}" },
    { section: "projects" as const, marker: "\\section{Projects}" },
    { section: "technical-skills" as const, marker: "\\section{Technical Skills}" },
  ];
  const positions = definitions.map(({ section, marker }) => {
    const headingStart = source.indexOf(marker);
    if (headingStart < 0 || source.indexOf(marker, headingStart + marker.length) >= 0) throw new ResumeValidationError(`candidate must contain exactly one ${section} section`);
    const bodyStart = headingStart + marker.length;
    const next = source.indexOf("\\section{", bodyStart);
    const documentEnd = source.indexOf("\\end{document}", bodyStart);
    const bodyEnd = next >= 0 ? next : documentEnd;
    if (bodyEnd < 0) throw new ResumeValidationError(`candidate has unterminated ${section} section`);
    return { section, bodyStart, bodyEnd };
  }).sort((a, b) => a.bodyStart - b.bodyStart);
  if (positions.map((item) => item.section).join(",") !== "experience,projects,technical-skills") throw new ResumeValidationError("editable sections were reordered");
  const bodies = {} as Record<ResumeSection, string>;
  let immutableSkeleton = "";
  let cursor = 0;
  for (const position of positions) {
    immutableSkeleton += source.slice(cursor, position.bodyStart) + `\u0000${position.section}\u0000`;
    bodies[position.section] = source.slice(position.bodyStart, position.bodyEnd);
    cursor = position.bodyEnd;
  }
  immutableSkeleton += source.slice(cursor);
  return { bodies, immutableSkeleton };
}

export function scanForbiddenPrimitives(tex: string): readonly string[] {
  const matches = new Set<string>();
  const commandPattern = new RegExp(FORBIDDEN_PATTERN.source, "gi");
  for (const match of tex.matchAll(commandPattern)) matches.add(match[0]);
  if (SHELL_PATTERN.test(tex)) matches.add("shell-escape");
  return [...matches];
}

function withoutFullLineComments(body: string): string {
  return body.split("\n").filter((line) => !/^\s*%/.test(line)).join("\n");
}

function controlSequenceOrder(body: string): string[] {
  const commands: string[] = [];
  const pattern = /\\([A-Za-z@]+|.)/g;
  for (const match of withoutFullLineComments(body).matchAll(pattern)) {
    const command = match[1]!;
    if (command.length === 1 && "#$%&_{}".includes(command)) continue;
    commands.push(command);
  }
  return commands;
}

function assertKnownCommands(body: string): void {
  const unknown = controlSequenceOrder(body).filter((command) => !ALLOWED_BODY_COMMANDS[command]);
  if (unknown.length) throw new ResumeValidationError(`unknown body control sequence \\${unknown[0]}`);
}

function normalizeVisible(body: string): string {
  let value = withoutFullLineComments(body)
    .replace(/\\([#$%&_{}])/g, "$1")
    .replace(/\\textbackslash\s*\{\}/g, "\\")
    .replace(/\\textasciitilde\s*\{\}/g, "~")
    .replace(/\\textasciicircum\s*\{\}/g, "^")
    .replace(/\\(?:begin|end)\s*\{[^{}]*\}/g, " ")
    .replace(/\\(?:resumeSubHeadingListStart|resumeSubHeadingListEnd|resumeItemListStart|resumeItemListEnd|small|item)(?![A-Za-z@])/g, " ")
    .replace(/\\(?:resumeSubheading|resumeProjectHeading|resumeItem|textbf|emph)(?![A-Za-z@])/g, " ")
    .replace(/[{}]/g, " ")
    .replace(/\$\|\$/g, " | ")
    .replace(/\\\\/g, " ");
  value = value.replace(/\s+/g, " ").trim();
  return value;
}

function links(body: string): readonly string[] {
  const clean = withoutFullLineComments(body);
  const result: string[] = [];
  const pattern = /\\href(?![A-Za-z@])/g;
  for (const match of clean.matchAll(pattern)) {
    let cursor = match.index + match[0].length;
    while (/\s/.test(clean[cursor] ?? "")) cursor++;
    try { result.push(readBracedArgument(clean, cursor).value); } catch { throw new ResumeValidationError("unparsable link in repair candidate"); }
  }
  return result;
}

function repairSkeleton(body: string): string {
  return withoutFullLineComments(body).replace(/\\([#$%&_{}])/g, "$1").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

function fullLineComments(body: string): readonly string[] {
  return body.split("\n").filter((line) => /^\s*%/.test(line));
}

function assertBalancedBody(body: string): void {
  const clean = withoutFullLineComments(body);
  let depth = 0;
  for (let index = 0; index < clean.length; index++) {
    if (clean[index] === "\\") { index++; continue; }
    if (clean[index] === "{") depth++;
    if (clean[index] === "}" && --depth < 0) throw new ResumeValidationError("repair candidate has an unmatched closing brace");
  }
  if (depth !== 0) throw new ResumeValidationError("repair candidate has unbalanced braces");
}

function validateMacroArguments(body: string): void {
  const clean = withoutFullLineComments(body);
  const arities: Record<string, number> = { resumeSubheading: 4, resumeProjectHeading: 2, resumeItem: 1, textbf: 1, emph: 1 };
  const pattern = /\\(resumeSubheading|resumeProjectHeading|resumeItem|textbf|emph)(?![A-Za-z@])/g;
  for (const match of clean.matchAll(pattern)) {
    let cursor = match.index + match[0].length;
    for (let count = 0; count < arities[match[1]!]!; count++) {
      while (/\s/.test(clean[cursor] ?? "")) cursor++;
      const argument = readBracedArgument(clean, cursor);
      cursor = argument.end;
    }
  }
}

export function validateRepairCandidate(failedTex: string, proposedTex: string, canonicalBaseline: string): RepairValidation {
  if (Buffer.byteLength(proposedTex) > 256 * 1024) throw new ResumeValidationError("repair candidate exceeds 256 KiB");
  parseBaselineResume(canonicalBaseline);
  const baseline = splitBodies(canonicalBaseline);
  const failed = splitBodies(failedTex);
  const proposed = splitBodies(proposedTex);
  if (failed.immutableSkeleton !== baseline.immutableSkeleton || proposed.immutableSkeleton !== baseline.immutableSkeleton) throw new ResumeValidationError("repair changed an immutable resume region");
  const forbidden = scanForbiddenPrimitives(Object.values(proposed.bodies).join("\n"));
  if (forbidden.length) throw new ResumeValidationError(`forbidden TeX primitive ${forbidden[0]}`);
  const normalized = {} as Record<ResumeSection, string>;
  const allCommands: string[] = [];
  for (const section of ["experience", "projects", "technical-skills"] as const) {
    const before = failed.bodies[section];
    const after = proposed.bodies[section];
    if (fullLineComments(before).join("\n") !== fullLineComments(after).join("\n")) throw new ResumeValidationError(`repair changed inert comments in ${section}`);
    assertKnownCommands(after);
    assertBalancedBody(after);
    validateMacroArguments(after);
    const beforeCommands = controlSequenceOrder(before);
    const afterCommands = controlSequenceOrder(after);
    if (beforeCommands.join("\u0000") !== afterCommands.join("\u0000")) throw new ResumeValidationError(`control-sequence order changed in ${section}`);
    const beforeVisible = normalizeVisible(before);
    const afterVisible = normalizeVisible(after);
    if (beforeVisible !== afterVisible) throw new ResumeValidationError(`visible content or order changed in ${section}`);
    if (links(before).join("\u0000") !== links(after).join("\u0000")) throw new ResumeValidationError(`links changed in ${section}`);
    if (repairSkeleton(before) !== repairSkeleton(after)) throw new ResumeValidationError(`repair diff exceeds brace, escaping, or macro argument syntax in ${section}`);
    normalized[section] = afterVisible;
    allCommands.push(...afterCommands);
  }
  return { valid: true, normalizedVisibleContent: normalized, controlSequenceOrder: allCommands };
}

export function validateRepairResult(resultInput: RepairResult, failedTex: string, canonicalBaseline: string): RepairResult {
  const parsed = RepairResultSchema.safeParse(resultInput);
  if (!parsed.success) throw new ResumeValidationError(`invalid repair result: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  if (parsed.data.status === "repaired") validateRepairCandidate(failedTex, parsed.data.tailoredTex!, canonicalBaseline);
  return parsed.data;
}
