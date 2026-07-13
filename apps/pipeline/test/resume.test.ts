import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ContextSnapshot, EvidenceBlock, IndexedContextSource } from "../src/context/types.ts";
import {
  EditResultSchema, JobAnalysisSchema, TailoringResultSchema, buildEvidenceLedger, hashJobAnalysis, immutableChunks,
  parseBaselineResume, plainTextToTex, renderEditedResume, renderTailoredResume, scanForbiddenPrimitives,
  validateRepairCandidate, type EditResult, type JobAnalysis, type TailoringPlan,
} from "../src/resume/index.ts";

const baseline = readFileSync(resolve(import.meta.dir, "../../../actual/resume-main/main.tex"), "utf8");
const parsedBaseline = parseBaselineResume(baseline);
const sha = "a".repeat(64);

function fixtures(): { snapshot: ContextSnapshot; analysis: JobAnalysis; plan: TailoringPlan } {
  const sources: IndexedContextSource[] = parsedBaseline.entities.map((entity, index) => ({
    id: `source-${index}`, relativePath: `authoritative-${index}.md`, kind: "authoritative-markdown", entityId: entity.entityId === "Sample Project" ? "SampleProject" : entity.entityId,
    displayName: entity.entityId, baselineEntityIds: [entity.entityId], sourceVersionId: `version-${index}`, sha256: sha, bytes: 10, indexedAt: 1,
  }));
  const evidence: EvidenceBlock[] = parsedBaseline.entities.map((entity, index) => ({
    id: `evidence-${index}`, sourceVersionId: `version-${index}`, sourceId: `source-${index}`,
    entityId: entity.entityId === "Sample Project" ? "SampleProject" : entity.entityId,
    ordinal: 0, headingPath: [entity.entityId], text: `${entity.bullets.map((item) => item.text).join(" ")} supported fact`, caveats: ["Keep source caveat"], sha256: sha,
  }));
  const snapshot: ContextSnapshot = {
    manifestSha256: sha, baselineSha256: parsedBaseline.sha256,
    sourceHashes: Object.fromEntries(sources.map((source) => [source.id, source.sha256])), sources, evidence,
    explicitEntityBindings: { "Sample Project": "SampleProject" },
  };
  const evidenceByEntity = new Map(parsedBaseline.entities.map((entity, index) => [entity.entityId, `evidence-${index}`]));
  const analysis = JobAnalysisSchema.parse({
    id: "analysis-1", jobDescriptionSha256: "b".repeat(64), target: { title: "Software Engineer" },
    prioritizedKeywords: [{ keyword: "TypeScript", priority: "required", jdQuote: "Strong TypeScript", evidenceIds: ["evidence-0"] }],
    guidance: [{ guidance: "Prefer relevant work", evidenceIds: ["evidence-0"] }],
  });
  const plan = {
    id: "plan-1", analysisId: analysis.id, analysisSha256: hashJobAnalysis(analysis),
    decisions: parsedBaseline.bullets.map((bullet, index) => ({
      id: `decision-${index}`, section: bullet.section, entityId: bullet.entityId, baselineItemId: bullet.id,
      action: "retain" as const, text: bullet.text, evidenceIds: [evidenceByEntity.get(bullet.entityId)!], factKeys: [], rationale: "Retain supported baseline claim",
    })),
    projectOrder: parsedBaseline.entities.filter((entity) => entity.section === "projects").map((entity) => entity.entityId),
    skillDecisions: parsedBaseline.skills.map((skill, index) => ({ id: `skill-${index}`, entityId: "Example Company", category: skill.category, skill: skill.skill, action: "retain" as const, evidenceIds: ["evidence-0"], rationale: "Retain supported baseline skill" })),
    factWinners: [], baselineOverrides: [], omissions: [],
  } satisfies TailoringPlan;
  return { snapshot, analysis, plan };
}

describe("strict resume contracts", () => {
  test("tailoring and edit outputs cannot carry agent-produced full TeX", () => {
    const { plan } = fixtures();
    expect(TailoringResultSchema.safeParse({ plan, tailoredTex: "\\input{/etc/passwd}" }).success).toBeFalse();
    expect(EditResultSchema.safeParse({ plan, commentDispositions: [], tailoredTex: "\\documentclass{article}" }).success).toBeFalse();
  });

  test("parses canonical sections, entities, bullets, and stable IDs", () => {
    const again = parseBaselineResume(baseline);
    expect(parsedBaseline.entities.map((item) => item.entityId)).toContain("Sample Project");
    expect(parsedBaseline.bullets.length).toBeGreaterThan(10);
    expect(parsedBaseline.skills.length).toBeGreaterThan(10);
    expect(again.bullets.map((item) => item.id)).toEqual(parsedBaseline.bullets.map((item) => item.id));
  });
});

describe("trusted rendering", () => {
  test("preserves every immutable region byte-for-byte and safely encodes text", () => {
    const { snapshot, plan } = fixtures();
    const target = plan.decisions.find((decision) => decision.section === "experience")!;
    const rewrite = { ...target, action: "rewrite" as const, text: "Built R&D_100% #1 {safe} \\input evil ~ fast ^ now", evidenceIds: target.evidenceIds };
    const changed = { ...plan, decisions: plan.decisions.map((item) => item.id === target.id ? rewrite : item), baselineOverrides: [{ baselineItemId: target.baselineItemId!, replacement: rewrite.text, evidenceIds: rewrite.evidenceIds, rationale: "Use supported safe wording" }] };
    const output = renderTailoredResume(changed, baseline, snapshot);
    expect(immutableChunks(parseBaselineResume(output))).toEqual(immutableChunks(parsedBaseline));
    expect(output).toContain("R\\&D\\_100\\% \\#1 \\{safe\\} \\textbackslash{}input evil \\textasciitilde{} fast \\textasciicircum{} now");
    expect(plainTextToTex("A&B_#%${}\\~^")).toBe("A\\&B\\_\\#\\%\\$\\{\\}\\textbackslash{}\\textasciitilde{}\\textasciicircum{}");
  });

  test("rejects unsupported evidence, entities, hashes, and comments", () => {
    const { snapshot, analysis, plan } = fixtures();
    expect(() => renderTailoredResume({ ...plan, decisions: plan.decisions.map((item, index) => index ? item : { ...item, evidenceIds: ["missing"] }) }, baseline, snapshot)).toThrow(/unknown evidence/i);
    expect(() => renderTailoredResume({ ...plan, decisions: plan.decisions.map((item, index) => index ? item : { ...item, entityId: "Other Person" }) }, baseline, snapshot)).toThrow(/entity/i);
    expect(() => renderTailoredResume(plan, baseline, { ...snapshot, baselineSha256: "f".repeat(64) })).toThrow(/baseline hash/i);
    expect(() => renderTailoredResume(plan, baseline, { ...snapshot, explicitEntityBindings: {} })).toThrow(/explicit Sample Project/i);
    expect(() => renderTailoredResume({ ...plan, decisions: plan.decisions.slice(1) }, baseline, snapshot)).toThrow(/does not cover baseline item/i);
    const edit = { plan, commentDispositions: [{ commentIndex: 0, status: "applied", rationale: "Apply request", evidenceIds: ["missing"] }] } as EditResult;
    expect(() => renderEditedResume(edit, ["Add unsupported claim"], analysis, baseline, snapshot)).toThrow(/unknown evidence/i);
    expect(() => renderEditedResume({ ...edit, commentDispositions: [] }, ["Do something"], analysis, baseline, snapshot)).toThrow(/every comment/i);
  });

  test("builds a provenance-preserving evidence ledger and rejects analysis mutation", () => {
    const { snapshot, analysis, plan } = fixtures();
    const ledger = buildEvidenceLedger(analysis, plan, snapshot);
    expect(ledger.entityBindings["Sample Project"]).toBe("SampleProject");
    expect(ledger.citations.some((citation) => citation.caveats.includes("Keep source caveat"))).toBeTrue();
    expect(() => buildEvidenceLedger({ ...analysis, target: { title: "Mutated target" } }, plan, snapshot)).toThrow(/immutable job analysis/i);
  });
});

describe("closed TeX repair validation", () => {
  test("detects every forbidden file, process, and metaprogramming primitive", () => {
    const forbidden = ["input", "include", "openin", "openout", "read", "write", "immediate", "special", "usepackage", "RequirePackage", "includegraphics", "pdfobj", "pdfxform", "pdfliteral", "catcode", "csname", "newcommand", "def", "loop", "directlua", "write18"];
    for (const primitive of forbidden) expect(scanForbiddenPrimitives(`\\${primitive}{evil}`), primitive).not.toHaveLength(0);
    expect(scanForbiddenPrimitives("--shell-escape")).not.toHaveLength(0);
  });

  test("accepts a narrow escaping repair while preserving visible content and command order", () => {
    const failed = baseline.replace("99\\%", "99%");
    const validation = validateRepairCandidate(failed, baseline, baseline);
    expect(validation.valid).toBeTrue();
    expect(validation.normalizedVisibleContent.projects).toContain("99%");
  });

  test("rejects malicious, unparsable, content-changing, and command-reordering repairs before compile", () => {
    const injected = baseline.replace("\\resumeItem{Built a full-stack", "\\input{/etc/passwd}\\resumeItem{Built a full-stack");
    expect(() => validateRepairCandidate(baseline, injected, baseline)).toThrow(/forbidden/i);
    const unknown = baseline.replace("\\resumeItem{Built a full-stack", "\\evil{hidden}\\resumeItem{Built a full-stack");
    expect(() => validateRepairCandidate(baseline, unknown, baseline)).toThrow(/unknown body control sequence/i);
    const content = baseline.replace("Processed over \\$300,000", "Processed over \\$654,321");
    expect(() => validateRepairCandidate(baseline, content, baseline)).toThrow(/visible content/i);
    const unparsable = baseline.replace("\\resumeItem{Built a full-stack sample workflow", "\\resumeItem Built a full-stack sample workflow");
    expect(() => validateRepairCandidate(baseline, unparsable, baseline)).toThrow();
    expect(() => validateRepairCandidate(baseline, baseline.replace("Alex Example", "Mallory"), baseline)).toThrow(/immutable resume region/i);
    expect(() => validateRepairCandidate(baseline, baseline.replace("\\resumeItem{Built a full-stack", "}\\resumeItem{Built a full-stack"), baseline)).toThrow(/unmatched closing brace/i);
    const reordered = baseline.replace(/(\\resumeItem\{Built a full-stack[^\n]+\}\n)(\s*)(\\resumeItem\{Processed over[^\n]+\})/, "$3\n$2$1");
    expect(() => validateRepairCandidate(baseline, reordered, baseline)).toThrow(/visible content|control-sequence order/i);
    expect(() => validateRepairCandidate(baseline, baseline.replace("\\resumeItem{Built a full-stack", "\\textbf{Built a full-stack"), baseline)).toThrow(/control-sequence order/i);
  });
});
