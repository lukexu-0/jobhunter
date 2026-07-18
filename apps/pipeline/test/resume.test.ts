import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ContextSnapshot, EvidenceBlock, IndexedContextSource } from "../src/context/types.ts";
import {
  EditResultSchema, JobAnalysisSchema, TailoringResultSchema, TailoringSubmissionSchema, buildEvidenceLedger, hashJobAnalysis, immutableChunks,
  parseBaselineResume, plainTextToTex, renderEditedResume, renderTailoredResume, scanForbiddenPrimitives,
  validateAnalysisDirectives, validateRepairCandidate, type EditResult, type JobAnalysis, type TailoringPlan,
} from "../src/resume/index.ts";
import { jobAnalysisFixture } from "./job-analysis.fixture.ts";

const baseline = readFileSync(resolve(import.meta.dir, "../../user-info/resume-main/main.tex"), "utf8");
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
    mustIncludeDirectives: [],
    explicitEntityBindings: { "Sample Project": "SampleProject" },
  };
  const evidenceByEntity = new Map(parsedBaseline.entities.map((entity, index) => [entity.entityId, `evidence-${index}`]));
  const analysis = JobAnalysisSchema.parse(jobAnalysisFixture({
    jobDescriptionSha256: "b".repeat(64),
    evidenceId: "evidence-0",
  }));
  const plan = {
    id: "plan-1", analysisId: analysis.id, analysisSha256: hashJobAnalysis(analysis),
    tailoringWorkflowSha256: sha,
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

function directiveFixtures() {
  const fixture = fixtures();
  const source = fixture.snapshot.sources.find((candidate) => candidate.baselineEntityIds.includes("Example Company"))!;
  const supportingEvidence = fixture.snapshot.evidence.find((block) => block.entityId === source.entityId)!;
  const directiveEvidence: EvidenceBlock = {
    id: "directive-example",
    sourceVersionId: source.sourceVersionId,
    sourceId: source.id,
    entityId: source.entityId,
    ordinal: 100,
    headingPath: ["Sample Testing", "21. Must Include"],
    text: "- **Required framing:** Present Sample Testing/System A as an **agentic testing platform/workflow**, not generic automation.",
    caveats: [],
    sha256: "d".repeat(64),
  };
  const snapshot: ContextSnapshot = {
    ...fixture.snapshot,
    evidence: [...fixture.snapshot.evidence, directiveEvidence],
    mustIncludeDirectives: [Object.freeze({
      evidenceId: directiveEvidence.id,
      sourceId: directiveEvidence.sourceId,
      entityId: directiveEvidence.entityId,
      text: directiveEvidence.text,
    })],
  };
  const activatedAnalysis: JobAnalysis = {
    ...fixture.analysis,
    proposedCvContent: {
      ...fixture.analysis.proposedCvContent,
      selectedProjects: fixture.analysis.proposedCvContent.selectedProjects.map((project, index) =>
        index === 0 ? { ...project, evidenceIds: [supportingEvidence.id, directiveEvidence.id] } : project),
    },
  };
  const targetDecision = fixture.plan.decisions.find((decision) => decision.entityId === "Example Company")!;
  const activePlan: TailoringPlan = {
    ...fixture.plan,
    analysisSha256: hashJobAnalysis(activatedAnalysis),
    decisions: fixture.plan.decisions.map((decision) =>
      decision.id === targetDecision.id
        ? { ...decision, evidenceIds: [...decision.evidenceIds, directiveEvidence.id] }
        : decision),
  };
  return { ...fixture, snapshot, directiveEvidence, supportingEvidence, activatedAnalysis, activePlan, targetDecision };
}

describe("strict resume contracts", () => {
  test("tailoring submissions remain plan-only while trusted results carry the working copy", () => {
    const { plan } = fixtures();
    expect(TailoringSubmissionSchema.safeParse({ plan, tailoredTex: "\\input{/etc/passwd}" }).success).toBeFalse();
    expect(TailoringResultSchema.safeParse({ plan, tailoredTex: baseline, toolCount: 11 }).success).toBeTrue();
    expect(TailoringResultSchema.safeParse({ plan, tailoredTex: baseline, toolCount: 12 }).success).toBeFalse();
    expect(EditResultSchema.safeParse({ plan, commentDispositions: [], tailoredTex: "\\documentclass{article}" }).success).toBeFalse();
  });

  test("requires every prompt-defined analysis section", () => {
    const analysis = jobAnalysisFixture();
    const { customizationPlan: _omitted, ...incomplete } = analysis;
    expect(JobAnalysisSchema.safeParse(incomplete).success).toBeFalse();
  });

  test("analysis uses unique concrete placements and excludes removed outputs", () => {
    const analysis = jobAnalysisFixture();
    expect(JobAnalysisSchema.safeParse(analysis).success).toBeTrue();
    expect(analysis.keywordAlignment[0]?.placements).toEqual(["Experience", "Technical Skills"]);

    const keyword = analysis.keywordAlignment[0]!;
    expect(JobAnalysisSchema.safeParse({
      ...analysis,
      keywordAlignment: [{ ...keyword, placements: [] }],
    }).success).toBeFalse();
    expect(JobAnalysisSchema.safeParse({
      ...analysis,
      keywordAlignment: [{ ...keyword, placements: ["Experience", "Experience"] }],
    }).success).toBeFalse();
    expect(JobAnalysisSchema.safeParse({
      ...analysis,
      keywordAlignment: [{ ...keyword, placements: ["Summary"] }],
    }).success).toBeFalse();
    expect(JobAnalysisSchema.safeParse({
      ...analysis,
      keywordAlignment: [{ ...keyword, placements: ["Skills"] }],
    }).success).toBeFalse();

    const { placements: _placements, ...legacyKeyword } = keyword;
    expect(JobAnalysisSchema.safeParse({
      ...analysis,
      keywordAlignment: [{ ...legacyKeyword, placement: "Experience" }],
    }).success).toBeFalse();
    expect(JobAnalysisSchema.safeParse({
      ...analysis,
      proposedCvContent: {
        ...analysis.proposedCvContent,
        professionalSummary: { text: "Removed summary", evidenceIds: [] },
      },
    }).success).toBeFalse();
    expect(JobAnalysisSchema.safeParse({
      ...analysis,
      proposedCvContent: {
        ...analysis.proposedCvContent,
        coreCompetencies: [],
      },
    }).success).toBeFalse();
    expect(JobAnalysisSchema.safeParse({
      ...analysis,
      linkedInChanges: [],
    }).success).toBeFalse();
  });

  test("parses canonical sections, entities, bullets, and stable IDs", () => {
    const again = parseBaselineResume(baseline);
    expect(parsedBaseline.entities.map((item) => item.entityId)).toContain("Sample Project");
    const competition = parsedBaseline.entities.find((item) => item.section === "competitions-other");
    expect(competition?.entityId).toBe("Example Engineering Competition");
    expect(competition?.headingArguments).toEqual(["Semifinalist", "Jan 2020 -- Jun 2020", "Example Engineering Competition", ""]);
    expect(competition?.bullets.map((item) => item.text)).toEqual(["Completed a synthetic team exercise using a deterministic scoring model."]);
    expect(parsedBaseline.bullets.filter((item) => item.section === "competitions-other")).toEqual(competition ? [...competition.bullets] : []);
    expect(parsedBaseline.bullets.length).toBeGreaterThan(10);
    expect(parsedBaseline.skills.length).toBeGreaterThan(10);
    expect(again.bullets.map((item) => item.id)).toEqual(parsedBaseline.bullets.map((item) => item.id));
  });
});

describe("entity-scoped must-include directives", () => {
  test("activates only for proposed same-entity evidence and rejects missing, arbitrary, or misattributed citations", () => {
    const { snapshot, analysis, activatedAnalysis, directiveEvidence, supportingEvidence } = directiveFixtures();
    expect(() => validateAnalysisDirectives(analysis, snapshot)).toThrow(/omits must-include directive/i);
    expect(() => validateAnalysisDirectives(activatedAnalysis, snapshot)).not.toThrow();

    const unrelatedEvidence = snapshot.evidence.find((block) =>
      block.id !== supportingEvidence.id && block.id !== directiveEvidence.id)!;
    const unrelatedAnalysis = jobAnalysisFixture({
      jobDescriptionSha256: analysis.jobDescriptionSha256,
      evidenceId: unrelatedEvidence.id,
    });
    expect(() => validateAnalysisDirectives(unrelatedAnalysis, snapshot)).not.toThrow();

    const incorrectDirectiveAnalysis: JobAnalysis = {
      ...unrelatedAnalysis,
      proposedCvContent: {
        ...unrelatedAnalysis.proposedCvContent,
        selectedProjects: unrelatedAnalysis.proposedCvContent.selectedProjects.map((project, index) =>
          index === 0 ? { ...project, evidenceIds: [unrelatedEvidence.id, directiveEvidence.id] } : project),
      },
    };
    expect(() => validateAnalysisDirectives(incorrectDirectiveAnalysis, snapshot)).toThrow(/misattributes|inactive/i);

    const arbitraryEvidenceAnalysis: JobAnalysis = {
      ...unrelatedAnalysis,
      proposedCvContent: {
        ...unrelatedAnalysis.proposedCvContent,
        technicalSkills: unrelatedAnalysis.proposedCvContent.technicalSkills.map((skill, index) =>
          index === 0 ? { ...skill, evidenceIds: ["arbitrary-directive"] } : skill),
      },
    };
    expect(() => validateAnalysisDirectives(arbitraryEvidenceAnalysis, snapshot)).toThrow(/unknown evidence arbitrary-directive/i);
  });

  test("requires plan and edit retention for included equivalent entities and preserves directive ledger citations", () => {
    const { snapshot, activatedAnalysis, activePlan, directiveEvidence, plan } = directiveFixtures();
    expect(() => renderTailoredResume(activePlan, baseline, snapshot)).not.toThrow();
    const ledger = buildEvidenceLedger(activatedAnalysis, activePlan, snapshot);
    expect(ledger.citations.some((citation) => citation.evidenceId === directiveEvidence.id)).toBeTrue();

    const missingPlan: TailoringPlan = {
      ...plan,
      analysisSha256: hashJobAnalysis(activatedAnalysis),
    };
    expect(() => renderTailoredResume(missingPlan, baseline, snapshot)).toThrow(/omits must-include directive/i);
    expect(() => renderEditedResume(
      { plan: missingPlan, commentDispositions: [] },
      [],
      activatedAnalysis,
      baseline,
      snapshot,
    )).toThrow(/omits must-include directive/i);

    const unrelatedDecision = activePlan.decisions.find((decision) => decision.entityId !== "Example Company")!;
    const misattributedPlan: TailoringPlan = {
      ...activePlan,
      decisions: activePlan.decisions.map((decision) =>
        decision.id === unrelatedDecision.id
          ? { ...decision, evidenceIds: [...decision.evidenceIds, directiveEvidence.id] }
          : decision),
    };
    expect(() => renderTailoredResume(misattributedPlan, baseline, snapshot)).toThrow(/belongs to .* not/i);
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
    const protectedText = immutableChunks(parsedBaseline).join("\n");
    expect(protectedText).toContain("\\documentclass[letterpaper,11pt]{article}");
    expect(protectedText).toContain("\\textbf{\\Huge \\scshape Alex Example}");
    expect(protectedText).toContain("\\section{Education}");
    for (const heading of ["Experience", "Projects", "Competitions \\& Other", "Technical Skills"]) expect(protectedText).toContain(`\\section{${heading}}`);
    expect(output).toContain("R\\&D\\_100\\% \\#1 \\{safe\\} \\textbackslash{}input evil \\textasciitilde{} fast \\textasciicircum{} now");
    expect(plainTextToTex("A&B_#%${}\\~^")).toBe("A\\&B\\_\\#\\%\\$\\{\\}\\textbackslash{}\\textasciitilde{}\\textasciicircum{}");
  });

  test("rewrites or omits the Wharton entity without changing its heading, position, or project ordering", () => {
    const { snapshot, plan } = fixtures();
    const sourceEntity = parsedBaseline.entities.find((entity) => entity.section === "competitions-other")!;
    const target = plan.decisions.find((decision) => decision.section === "competitions-other")!;
    const rewrite = { ...target, action: "rewrite" as const, text: "Completed a synthetic team exercise using a deterministic scoring model." };
    const changed = {
      ...plan,
      decisions: plan.decisions.map((decision) => decision.id === target.id ? rewrite : decision),
      baselineOverrides: [{ baselineItemId: target.baselineItemId!, replacement: rewrite.text, evidenceIds: rewrite.evidenceIds, rationale: "Use supported Wharton wording" }],
    };
    const output = renderTailoredResume(changed, baseline, snapshot);
    const rendered = parseBaselineResume(output);
    const renderedEntity = rendered.entities.find((entity) => entity.section === "competitions-other")!;
    expect(renderedEntity.headingArguments).toEqual(sourceEntity.headingArguments);
    expect(renderedEntity.bullets.map((bullet) => bullet.text)).toEqual([rewrite.text]);
    expect(rendered.regions["competitions-other"].body).toContain("\\resumeSubheading");
    expect(output.indexOf("\\section{Experience}")).toBeLessThan(output.indexOf("\\section{Projects}"));
    expect(output.indexOf("\\section{Projects}")).toBeLessThan(output.indexOf("\\section{Competitions \\& Other}"));
    expect(output.indexOf("\\section{Competitions \\& Other}")).toBeLessThan(output.indexOf("\\section{Technical Skills}"));
    expect(plan.projectOrder).toEqual(parsedBaseline.entities.filter((entity) => entity.section === "projects").map((entity) => entity.entityId));
    expect(() => renderTailoredResume({ ...plan, projectOrder: [...plan.projectOrder, sourceEntity.entityId] }, baseline, snapshot)).toThrow(/project order/i);

    const omission = { ...target, action: "omit" as const, text: null };
    const omitted = {
      ...plan,
      decisions: plan.decisions.map((decision) => decision.id === target.id ? omission : decision),
      omissions: [{ baselineItemId: target.baselineItemId!, evidenceIds: target.evidenceIds, rationale: "Omit the competition when irrelevant" }],
    };
    expect(parseBaselineResume(renderTailoredResume(omitted, baseline, snapshot)).entities.some((entity) => entity.section === "competitions-other")).toBeFalse();
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

  test("allows canonical baseline-source evidence for any baseline entity or skill while preserving authoritative attribution", () => {
    const { snapshot, plan } = fixtures();
    const target = plan.decisions.find((decision) => decision.section === "competitions-other")!;
    const mismatchedAuthority = {
      ...plan,
      decisions: plan.decisions.map((decision) => decision.id === target.id ? { ...decision, evidenceIds: ["evidence-0"] } : decision),
    };
    expect(() => renderTailoredResume(mismatchedAuthority, baseline, snapshot)).toThrow(/attributed/i);

    const baselineSource: IndexedContextSource = {
      id: "canonical-baseline", relativePath: "apps/user-info/resume-main/main.tex", kind: "baseline", entityId: "candidate-resume",
      displayName: "Canonical resume", baselineEntityIds: [], sourceVersionId: "canonical-baseline-version",
      sha256: parsedBaseline.sha256, bytes: Buffer.byteLength(baseline), indexedAt: 1,
    };
    const baselineEvidence: EvidenceBlock = {
      id: "canonical-baseline-evidence", sourceVersionId: baselineSource.sourceVersionId, sourceId: baselineSource.id,
      entityId: baselineSource.entityId, ordinal: 0, headingPath: ["Canonical resume"], text: "Canonical baseline content",
      caveats: [], sha256: sha,
    };
    const baselineSnapshot: ContextSnapshot = {
      ...snapshot,
      sources: [...snapshot.sources, baselineSource],
      evidence: [...snapshot.evidence, baselineEvidence],
      sourceHashes: { ...snapshot.sourceHashes, [baselineSource.id]: baselineSource.sha256 },
    };
    const baselineSupportedPlan = {
      ...plan,
      decisions: plan.decisions.map((decision) => decision.id === target.id ? { ...decision, evidenceIds: [baselineEvidence.id] } : decision),
      skillDecisions: plan.skillDecisions.map((decision, index) => index === 0 ? { ...decision, evidenceIds: [baselineEvidence.id] } : decision),
    };
    expect(() => renderTailoredResume(baselineSupportedPlan, baseline, baselineSnapshot)).not.toThrow();
  });

  test("builds a provenance-preserving evidence ledger and rejects analysis mutation", () => {
    const { snapshot, analysis, plan } = fixtures();
    const ledger = buildEvidenceLedger(analysis, plan, snapshot);
    expect(ledger.entityBindings["Sample Project"]).toBe("SampleProject");
    expect(ledger.citations.some((citation) => citation.caveats.includes("Keep source caveat"))).toBeTrue();
    expect(() => buildEvidenceLedger({ ...analysis, roleSummary: { ...analysis.roleSummary, role: "Mutated target" } }, plan, snapshot)).toThrow(/immutable job analysis/i);
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

  test("accepts a syntax-only repair inside the competitions body", () => {
    const failed = baseline.replace("250 teams", "{250} teams");
    const validation = validateRepairCandidate(failed, baseline, baseline);
    expect(validation.valid).toBeTrue();
    expect(validation.normalizedVisibleContent["competitions-other"]).toContain("Example Engineering Competition");
    expect(validation.normalizedVisibleContent["competitions-other"]).toContain("250 teams");
  });

  test("rejects malicious, unparsable, content-changing, and command-reordering repairs before compile", () => {
    const injected = baseline.replace("\\resumeItem{Built a full-stack", "\\input{/etc/passwd}\\resumeItem{Built a full-stack");
    expect(() => validateRepairCandidate(baseline, injected, baseline)).toThrow(/forbidden/i);
    const unknown = baseline.replace("\\resumeItem{Built a full-stack", "\\evil{hidden}\\resumeItem{Built a full-stack");
    expect(() => validateRepairCandidate(baseline, unknown, baseline)).toThrow(/unknown body control sequence/i);
    const content = baseline.replace("Processed over \\$300,000", "Processed over \\$654,321");
    expect(() => validateRepairCandidate(baseline, content, baseline)).toThrow(/visible content/i);
    expect(() => validateRepairCandidate(baseline, baseline.replace("250 teams", "9,999 teams"), baseline)).toThrow(/visible content.*competitions-other/i);
    const unparsable = baseline.replace("\\resumeItem{Built a full-stack sample workflow", "\\resumeItem Built a full-stack sample workflow");
    expect(() => validateRepairCandidate(baseline, unparsable, baseline)).toThrow();
    expect(() => validateRepairCandidate(baseline, baseline.replace("Alex Example", "Mallory"), baseline)).toThrow(/immutable resume region/i);
    expect(() => validateRepairCandidate(baseline, baseline.replace("\\resumeItem{Built a full-stack", "}\\resumeItem{Built a full-stack"), baseline)).toThrow(/unmatched closing brace/i);
    const reordered = baseline.replace(/(\\resumeItem\{Built a full-stack[^\n]+\}\n)(\s*)(\\resumeItem\{Processed over[^\n]+\})/, "$3\n$2$1");
    expect(() => validateRepairCandidate(baseline, reordered, baseline)).toThrow(/visible content|control-sequence order/i);
    expect(() => validateRepairCandidate(baseline, baseline.replace("\\resumeItem{Built a full-stack", "\\textbf{Built a full-stack"), baseline)).toThrow(/control-sequence order/i);
  });
});
