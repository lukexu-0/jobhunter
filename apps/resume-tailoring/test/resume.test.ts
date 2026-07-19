import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildMechanicalTailoringPlan,
  TAILORING_WORKFLOW_SHA256,
} from "../src/agents/index.ts";
import type { ContextSnapshot, EvidenceBlock, IndexedContextSource } from "../src/context/types.ts";
import {
  EditResultSchema,
  JobAnalysisSchema,
  TailoringResultSchema,
  buildEvidenceLedger,
  hashJobAnalysis,
  immutableChunks,
  parseBaselineResume,
  plainTextToTex,
  renderEditedResume,
  renderTailoredResume,
  scanForbiddenPrimitives,
  validateAnalysisAgainstBaseline,
  validateRepairCandidate,
  type EditResult,
  type JobAnalysis,
  type TailoringPlan,
} from "../src/resume/index.ts";
import { jobAnalysisFixture } from "./job-analysis.fixture.ts";

const baseline = readFileSync(resolve(import.meta.dir, "../../user-info/resume-main/main.tex"), "utf8");
const parsedBaseline = parseBaselineResume(baseline);
const JOB_DESCRIPTION = "Build production TypeScript systems. Deliver reliable software.";
const JOB_DESCRIPTION_SHA256 = createHash("sha256").update(JOB_DESCRIPTION).digest("hex");
const sha = "a".repeat(64);

function fixtures(): { snapshot: ContextSnapshot; analysis: JobAnalysis; plan: TailoringPlan } {
  const authoritativeSources: IndexedContextSource[] = parsedBaseline.entities.map((entity, index) => {
    const entityId = entity.entityId === "Sample Project"
      ? "SampleProject"
      : `${entity.entityId} authority`;
    return {
      id: `source-${index}`,
      relativePath: `authoritative-${index}.md`,
      kind: "authoritative-markdown",
      entityId,
      displayName: entity.entityId,
      baselineEntityIds: [entity.entityId],
      sourceVersionId: `version-${index}`,
      sha256: sha,
      bytes: 10,
      indexedAt: 1,
    };
  });
  const authoritativeEvidence: EvidenceBlock[] = parsedBaseline.entities.map((entity, index) => ({
    id: `evidence-${index}`,
    sourceVersionId: `version-${index}`,
    sourceId: `source-${index}`,
    entityId: authoritativeSources[index]!.entityId,
    ordinal: 0,
    headingPath: [entity.entityId],
    text: `${entity.bullets.map((item) => item.text).join(" ")} TypeScript production delivery improved a synthetic workflow.`,
    caveats: ["Keep source caveat"],
    sha256: sha,
  }));
  const baselineSource: IndexedContextSource = {
    id: "canonical-baseline",
    relativePath: "apps/user-info/resume-main/main.tex",
    kind: "baseline",
    entityId: "candidate-resume",
    displayName: "Canonical resume",
    baselineEntityIds: [],
    sourceVersionId: "canonical-baseline-version",
    sha256: parsedBaseline.sha256,
    bytes: Buffer.byteLength(baseline),
    indexedAt: 1,
  };
  const baselineEvidence: EvidenceBlock = {
    id: "canonical-baseline-evidence",
    sourceVersionId: baselineSource.sourceVersionId,
    sourceId: baselineSource.id,
    entityId: baselineSource.entityId,
    ordinal: 0,
    headingPath: ["Canonical resume"],
    text: baseline,
    caveats: [],
    sha256: parsedBaseline.sha256,
  };
  const sources = [...authoritativeSources, baselineSource];
  const snapshot: ContextSnapshot = {
    manifestSha256: sha,
    baselineSha256: parsedBaseline.sha256,
    sourceHashes: Object.fromEntries(sources.map((source) => [source.id, source.sha256])),
    sources,
    evidence: [...authoritativeEvidence, baselineEvidence],
    explicitEntityBindings: { "Sample Project": "SampleProject" },
  };
  const analysis = JobAnalysisSchema.parse(jobAnalysisFixture({
    jobDescriptionSha256: JOB_DESCRIPTION_SHA256,
    evidenceId: "evidence-0",
  }));
  const plan = buildMechanicalTailoringPlan(analysis, baseline);
  return { snapshot, analysis, plan };
}

function replaceEvidence(analysis: JobAnalysis, evidenceIds: readonly string[]): JobAnalysis {
  return {
    ...analysis,
    jdKeywords: analysis.jdKeywords.map((keyword) => ({ ...keyword, evidenceIds })),
    exactEdits: analysis.exactEdits.map((edit) => ({ ...edit, evidenceIds })),
  };
}

function zeroEditAnalysis(analysis: JobAnalysis): JobAnalysis {
  return { ...analysis, jdKeywords: [], exactEdits: [] };
}

describe("strict resume contracts", () => {
  test("accepts only schema-v2 analysis and reduced tailoring results", () => {
    const { analysis, plan } = fixtures();
    expect(JobAnalysisSchema.safeParse(analysis).success).toBeTrue();
    expect(JobAnalysisSchema.safeParse({ ...analysis, schemaVersion: 1 }).success).toBeFalse();
    expect(JobAnalysisSchema.safeParse({ ...analysis, roleSummary: { role: "Legacy" } }).success).toBeFalse();
    expect(JobAnalysisSchema.safeParse(zeroEditAnalysis(analysis)).success).toBeTrue();
    expect(TailoringResultSchema.safeParse({ plan, toolCount: 4 }).success).toBeTrue();
    expect(TailoringResultSchema.safeParse({ plan, tailoredTex: baseline, toolCount: 4 }).success).toBeFalse();
    expect(TailoringResultSchema.safeParse({ plan, toolCount: 3 }).success).toBeFalse();
    expect(EditResultSchema.safeParse({ plan, commentDispositions: [], tailoredTex: "\\documentclass{article}" }).success).toBeFalse();
  });

  test("rejects invalid keyword links and exact-edit schema values", () => {
    const { analysis } = fixtures();
    const bulletEdit = analysis.exactEdits.find((edit) => edit.kind === "bullet")!;
    const skillEdit = analysis.exactEdits.find((edit) => edit.kind === "skill")!;
    expect(JobAnalysisSchema.safeParse({
      ...analysis,
      exactEdits: [{ ...bulletEdit, after: bulletEdit.before }, skillEdit],
    }).error?.issues.some((issue) => issue.message.includes("replacement must change"))).toBeTrue();
    expect(JobAnalysisSchema.safeParse({
      ...analysis,
      exactEdits: [{ ...bulletEdit, after: "Improved PR validation." }, skillEdit],
    }).error?.issues.some((issue) => issue.message.includes("does not contain linked keyword"))).toBeTrue();
    expect(JobAnalysisSchema.safeParse({
      ...analysis,
      exactEdits: [{ ...bulletEdit, keywordIds: ["unknown-keyword"] }, skillEdit],
    }).error?.issues.some((issue) => issue.message.includes("unknown keyword ID"))).toBeTrue();
    expect(JobAnalysisSchema.safeParse({
      ...analysis,
      jdKeywords: [{ ...analysis.jdKeywords[0]!, evidenceIds: ["evidence-0", "canonical-baseline-evidence"] }],
    }).error?.issues.some((issue) => issue.message.includes("omits keyword evidence"))).toBeTrue();
    expect(JobAnalysisSchema.safeParse({
      ...analysis,
      exactEdits: [bulletEdit, { ...skillEdit, after: "TypeScript, Bun" }],
    }).error?.issues.some((issue) => issue.message.includes("comma"))).toBeTrue();
    expect(JobAnalysisSchema.safeParse({
      ...analysis,
      exactEdits: [...analysis.exactEdits, { ...bulletEdit, id: "duplicate-target" }],
    }).error?.issues.some((issue) => issue.message.includes("baseline item targets"))).toBeTrue();
  });

  test("parses canonical sections, entities, bullets, and stable IDs", () => {
    const again = parseBaselineResume(baseline);
    expect(parsedBaseline.entities.map((item) => item.entityId)).toContain("Sample Project");
    const competition = parsedBaseline.entities.find((item) => item.section === "competitions-other");
    expect(competition?.entityId).toBe("Example Engineering Competition");
    expect(competition?.headingArguments).toEqual(["Semifinalist", "Jan 2020 -- Jun 2020", "Example Engineering Competition", ""]);
    expect(competition?.bullets.map((item) => item.text)).toEqual(["Completed a synthetic team exercise using a deterministic scoring model."]);
    expect(parsedBaseline.bullets.length).toBeGreaterThan(10);
    expect(parsedBaseline.skills.length).toBeGreaterThan(10);
    expect(again.bullets.map((item) => item.id)).toEqual(parsedBaseline.bullets.map((item) => item.id));
  });
});

describe("analysis validation", () => {
  test("accepts globally valid baseline evidence and entity-equivalent authority", () => {
    const { snapshot, analysis } = fixtures();
    expect(validateAnalysisAgainstBaseline(analysis, JOB_DESCRIPTION, baseline, snapshot)).toEqual(analysis);
    const baselineSupported = replaceEvidence(analysis, ["canonical-baseline-evidence"]);
    expect(validateAnalysisAgainstBaseline(baselineSupported, JOB_DESCRIPTION, baseline, snapshot)).toEqual(baselineSupported);
  });

  test("rejects stale hashes, JD text, targets, evidence, and replacements", () => {
    const { snapshot, analysis } = fixtures();
    const bulletEdit = analysis.exactEdits.find((edit) => edit.kind === "bullet")!;
    const skillEdit = analysis.exactEdits.find((edit) => edit.kind === "skill")!;
    const keyword = analysis.jdKeywords[0]!;
    const otherSkill = parsedBaseline.skills.find((skill) => skill.category === skillEdit.category && skill.skill === "Python")!;

    expect(() => validateAnalysisAgainstBaseline({ ...analysis, jobDescriptionSha256: sha }, JOB_DESCRIPTION, baseline, snapshot)).toThrow(/job description hash/i);
    expect(() => validateAnalysisAgainstBaseline({ ...analysis, baselineSha256: sha }, JOB_DESCRIPTION, baseline, snapshot)).toThrow(/baseline hash/i);
    expect(() => validateAnalysisAgainstBaseline({ ...analysis, jdKeywords: [{ ...keyword, jdQuote: "Absent exact quote" }] }, JOB_DESCRIPTION, baseline, snapshot)).toThrow(/does not occur verbatim/i);

    const kubernetesEdits = analysis.exactEdits.map((edit) => ({ ...edit, after: edit.after.replace(/TypeScript/g, "Kubernetes") }));
    expect(() => validateAnalysisAgainstBaseline({
      ...analysis,
      jdKeywords: [{ ...keyword, phrase: "Kubernetes" }],
      exactEdits: kubernetesEdits,
    }, JOB_DESCRIPTION, baseline, snapshot)).toThrow(/phrase does not occur/i);

    expect(() => validateAnalysisAgainstBaseline({
      ...analysis,
      exactEdits: [{ ...bulletEdit, baselineItemId: "bullet:unknown" }, skillEdit],
    }, JOB_DESCRIPTION, baseline, snapshot)).toThrow(/unknown or mismatched baseline item/i);
    expect(() => validateAnalysisAgainstBaseline({
      ...analysis,
      exactEdits: [{ ...bulletEdit, before: `${bulletEdit.before} stale` }, skillEdit],
    }, JOB_DESCRIPTION, baseline, snapshot)).toThrow(/stale before/i);
    expect(() => validateAnalysisAgainstBaseline(replaceEvidence(analysis, ["unknown-evidence"]), JOB_DESCRIPTION, baseline, snapshot)).toThrow(/unknown evidence/i);
    expect(() => validateAnalysisAgainstBaseline(replaceEvidence(analysis, ["evidence-1"]), JOB_DESCRIPTION, baseline, snapshot)).toThrow(/attributed/i);
    expect(() => validateAnalysisAgainstBaseline({
      ...analysis,
      exactEdits: [bulletEdit, { ...skillEdit, after: "TypeScript" }],
    }, JOB_DESCRIPTION, baseline, snapshot)).toThrow(/already exists/i);
    expect(() => validateAnalysisAgainstBaseline({
      ...analysis,
      exactEdits: [
        ...analysis.exactEdits,
        {
          ...skillEdit,
          id: "edit-duplicate-replacement",
          baselineItemId: otherSkill.id,
          before: otherSkill.skill,
        },
      ],
    }, JOB_DESCRIPTION, baseline, snapshot)).toThrow(/duplicate replacement skill/i);
  });

  test("emits ledger version 2 with the exact reduced projection and all citations", () => {
    const { snapshot, analysis } = fixtures();
    const analysisWithEditCitation: JobAnalysis = {
      ...analysis,
      exactEdits: analysis.exactEdits.map((edit, index) => index === 0
        ? { ...edit, evidenceIds: [...edit.evidenceIds, "canonical-baseline-evidence"] }
        : edit),
    };
    const plan = buildMechanicalTailoringPlan(analysisWithEditCitation, baseline);
    const ledger = buildEvidenceLedger(analysisWithEditCitation, plan, snapshot);
    expect(ledger.version).toBe(2);
    expect(ledger.analysis).toEqual({
      id: analysisWithEditCitation.id,
      sha256: hashJobAnalysis(analysisWithEditCitation),
      jobDescriptionSha256: analysisWithEditCitation.jobDescriptionSha256,
      jdKeywords: analysisWithEditCitation.jdKeywords,
      exactEdits: analysisWithEditCitation.exactEdits,
    });
    expect(ledger.citations.map((citation) => citation.evidenceId)).toContain("evidence-0");
    expect(ledger.citations.map((citation) => citation.evidenceId)).toContain("canonical-baseline-evidence");
    expect(ledger.entityBindings["Sample Project"]).toBe("SampleProject");
  });
});

describe("mechanical tailoring and canonical rendering", () => {
  test("rewrites only selected items and retains baseline order and text", () => {
    const { snapshot, analysis, plan } = fixtures();
    const bulletEdit = analysis.exactEdits.find((edit) => edit.kind === "bullet")!;
    const skillEdit = analysis.exactEdits.find((edit) => edit.kind === "skill")!;
    expect(plan).toEqual(buildMechanicalTailoringPlan(analysis, baseline));
    expect(plan.decisions).toHaveLength(parsedBaseline.bullets.length);
    expect(plan.decisions.filter((decision) => decision.action === "rewrite")).toEqual([
      expect.objectContaining({ baselineItemId: bulletEdit.baselineItemId, text: bulletEdit.after, factKeys: [], rationale: `Apply exact analysis edit ${bulletEdit.id}.` }),
    ]);
    for (const bullet of parsedBaseline.bullets.filter((item) => item.id !== bulletEdit.baselineItemId)) {
      expect(plan.decisions.find((decision) => decision.baselineItemId === bullet.id)).toMatchObject({
        action: "retain",
        text: bullet.text,
        evidenceIds: [],
        rationale: "Retain unmentioned baseline bullet.",
      });
    }
    expect(plan.baselineOverrides).toEqual([{
      baselineItemId: bulletEdit.baselineItemId,
      replacement: bulletEdit.after,
      evidenceIds: bulletEdit.evidenceIds,
      rationale: `Apply exact analysis edit ${bulletEdit.id}.`,
    }]);
    expect(plan.factWinners).toEqual([]);
    expect(plan.omissions).toEqual([]);
    expect(plan.projectOrder).toEqual(parsedBaseline.entities.filter((entity) => entity.section === "projects").map((entity) => entity.entityId));

    const skillIndex = plan.skillDecisions.findIndex((decision) => decision.action === "omit" && decision.skill === skillEdit.before);
    expect(plan.skillDecisions.slice(skillIndex, skillIndex + 2)).toEqual([
      expect.objectContaining({ action: "omit", skill: skillEdit.before, entityId: skillEdit.evidenceEntityId }),
      expect.objectContaining({ action: "add", skill: skillEdit.after, entityId: skillEdit.evidenceEntityId }),
    ]);
    expect(() => renderTailoredResume(plan, baseline, snapshot)).not.toThrow();
  });

  test("renders exact escaped replacements without changing immutable structure or counts", () => {
    const { snapshot, analysis, plan } = fixtures();
    const output = renderTailoredResume(plan, baseline, snapshot);
    const rendered = parseBaselineResume(output);
    const bulletEdit = analysis.exactEdits.find((edit) => edit.kind === "bullet")!;
    const skillEdit = analysis.exactEdits.find((edit) => edit.kind === "skill")!;
    expect(output).toContain(plainTextToTex(bulletEdit.after));
    expect(output).toContain(plainTextToTex(skillEdit.after));
    expect(immutableChunks(rendered)).toEqual(immutableChunks(parsedBaseline));
    expect(rendered.bullets).toHaveLength(parsedBaseline.bullets.length);
    expect(rendered.skills).toHaveLength(parsedBaseline.skills.length);
    expect(rendered.entities.filter((entity) => entity.section === "projects").map((entity) => entity.entityId)).toEqual([...plan.projectOrder]);
    expect(rendered.bullets.map((bullet) => bullet.text)).toEqual(parsedBaseline.bullets.map((bullet) => bullet.id === bulletEdit.baselineItemId ? bulletEdit.after : bullet.text));
    expect(rendered.skills.map((skill) => skill.skill)).toEqual(parsedBaseline.skills.map((skill) => skill.id === skillEdit.baselineItemId ? skillEdit.after : skill.skill));
  });

  test("zero edits produce complete retain decisions and unchanged editable content", () => {
    const { snapshot, analysis } = fixtures();
    const plan = buildMechanicalTailoringPlan(zeroEditAnalysis(analysis), baseline);
    const rendered = parseBaselineResume(renderTailoredResume(plan, baseline, snapshot));
    expect(plan.decisions.every((decision) => decision.action === "retain" && decision.evidenceIds.length === 0)).toBeTrue();
    expect(plan.skillDecisions.every((decision) => decision.action === "retain" && decision.entityId === null && decision.evidenceIds.length === 0)).toBeTrue();
    expect(rendered.bullets.map((bullet) => bullet.text)).toEqual(parsedBaseline.bullets.map((bullet) => bullet.text));
    expect(rendered.skills.map((skill) => `${skill.category}\0${skill.skill}`)).toEqual(parsedBaseline.skills.map((skill) => `${skill.category}\0${skill.skill}`));
    expect(rendered.entities.filter((entity) => entity.section === "projects").map((entity) => entity.entityId)).toEqual(parsedBaseline.entities.filter((entity) => entity.section === "projects").map((entity) => entity.entityId));
  });

  test("preserves edit-plan validation for human revisions", () => {
    const { snapshot, analysis, plan } = fixtures();
    const edit = { plan, commentDispositions: [{ commentIndex: 0, status: "applied", rationale: "Apply request", evidenceIds: ["evidence-0"] }] } as EditResult;
    expect(() => renderEditedResume(edit, ["Use the validated edit"], analysis, baseline, snapshot)).not.toThrow();
    expect(() => renderEditedResume({ ...edit, commentDispositions: [] }, ["Do something"], analysis, baseline, snapshot)).toThrow(/every comment/i);
    expect(() => renderEditedResume({ ...edit, commentDispositions: [{ ...edit.commentDispositions[0]!, evidenceIds: ["missing"] }] }, ["Do something"], analysis, baseline, snapshot)).toThrow(/unknown evidence/i);
  });
});

describe("TeX repair validation", () => {
  test("detects every forbidden file, process, and metaprogramming primitive", () => {
    const forbidden = ["input", "include", "openin", "openout", "read", "write", "immediate", "special", "usepackage", "RequirePackage", "includegraphics", "pdfobj", "pdfxform", "pdfliteral", "catcode", "csname", "newcommand", "def", "loop", "directlua", "write18"];
    for (const primitive of forbidden) expect(scanForbiddenPrimitives(`\\${primitive}{evil}`), primitive).not.toHaveLength(0);
    expect(scanForbiddenPrimitives("--shell-escape")).not.toHaveLength(0);
  });

  test("accepts safe edits within editable section bodies", () => {
    const reordered = baseline.replace(/(\\resumeItem\{Built a full-stack[^\n]+\}\n)(\s*)(\\resumeItem\{Processed over[^\n]+\})/, "$3\n$2$1");
    const candidates = [
      baseline.replace("Processed over \\$300,000", "Processed over \\$654,321"),
      baseline.replace("\\section{Projects}", "\\section{Projects}\n% repaired body comment"),
      baseline.replace("Gmail API,", "\\textbf{Gmail API},"),
      reordered,
    ];
    for (const candidate of candidates) expect(validateRepairCandidate(candidate, baseline).valid).toBeTrue();
  });

  test("retains size, immutable-region, primitive, command, brace, and macro safety checks", () => {
    const injected = baseline.replace("\\resumeItem{Built a full-stack", "\\input{/etc/passwd}\\resumeItem{Built a full-stack");
    expect(() => validateRepairCandidate(injected, baseline)).toThrow(/forbidden/i);
    const unknown = baseline.replace("\\resumeItem{Built a full-stack", "\\evil{hidden}\\resumeItem{Built a full-stack");
    expect(() => validateRepairCandidate(unknown, baseline)).toThrow(/unknown body control sequence/i);
    const malformedMacro = baseline.replace("\\resumeItem{Built a full-stack sample workflow", "\\resumeItem Built a full-stack sample workflow");
    expect(() => validateRepairCandidate(malformedMacro, baseline)).toThrow();
    expect(() => validateRepairCandidate(baseline.replace("Alex Example", "Mallory"), baseline)).toThrow(/immutable resume region/i);
    expect(() => validateRepairCandidate(baseline.replace("\\resumeItem{Built a full-stack", "}\\resumeItem{Built a full-stack"), baseline)).toThrow(/unmatched closing brace/i);
    expect(() => validateRepairCandidate("x".repeat(256 * 1024 + 1), baseline)).toThrow(/256 KiB/i);
  });
});
