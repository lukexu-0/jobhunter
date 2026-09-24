import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { buildMechanicalTailoringPlan } from "../src/agents/index.ts";
import type { ContextSnapshot, EvidenceBlock, IndexedContextSource } from "../src/context/types.ts";
import {
  AtsKeywordExtractionSchema,
  AtsKeywordSchema,
  EditResultSchema,
  JobAnalysisSchema,
  TailoringResultSchema,
  TailoringPlanSchema,
  buildResumeDiff,
  assertResumeDiffMatchesTailoredSource,
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
import { ARTIFACT_LIMITS } from "../src/system/artifacts.ts";
import { atsKeywordExtractionFixture, jobAnalysisFixture } from "./job-analysis.fixture.ts";
import { SYNTHETIC_RESUME } from "./private-context.fixture.ts";

const baseline = SYNTHETIC_RESUME;
const parsedBaseline = parseBaselineResume(baseline);
const JOB_DESCRIPTION = "Build production TypeScript systems. Deliver reliable software.";
const JOB_DESCRIPTION_SHA256 = createHash("sha256").update(JOB_DESCRIPTION).digest("hex");
const sha = "a".repeat(64);

function fixtures(): { snapshot: ContextSnapshot; analysis: JobAnalysis; plan: TailoringPlan } {
  const authoritativeSources: IndexedContextSource[] = parsedBaseline.entities.map((entity, index) => {
    const entityId = entity.entityId === "Sample Delivery Dashboard"
      ? "SampleDeliveryDashboard"
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
    text: `${entity.bullets.map((item) => item.text).join(" ")} TypeScript production delivery saved dozens of engineer-hours.`,
    caveats: ["Keep source caveat"],
    sha256: sha,
  }));
  const baselineSource: IndexedContextSource = {
    id: "canonical-baseline",
    relativePath: ".jobhunt-data/user-info/resume-main/resume.tex",
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
    mustIncludeDirectives: [],
    explicitEntityBindings: { "Sample Delivery Dashboard": "SampleDeliveryDashboard" },
  };
  const analysis = JobAnalysisSchema.parse(jobAnalysisFixture({
    jobDescriptionSha256: JOB_DESCRIPTION_SHA256,
  }));
  const plan = buildMechanicalTailoringPlan(analysis, baseline);
  return { snapshot, analysis, plan };
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

  test("accepts only strict, non-empty, unique ATS keyword extractions", () => {
    const extraction = atsKeywordExtractionFixture();
    expect(AtsKeywordSchema.safeParse(extraction.keywords[0]).success).toBeTrue();
    expect(AtsKeywordExtractionSchema.safeParse(extraction).success).toBeTrue();
    expect(AtsKeywordExtractionSchema.safeParse({ ...extraction, keywords: [] }).success).toBeFalse();
    expect(AtsKeywordExtractionSchema.safeParse({ ...extraction, extra: true }).success).toBeFalse();
    expect(AtsKeywordExtractionSchema.safeParse({
      ...extraction,
      keywords: [
        extraction.keywords[0],
        { ...extraction.keywords[1]!, id: extraction.keywords[0]!.id },
      ],
    }).error?.issues.some((issue) => issue.message.includes("keyword IDs must be unique"))).toBeTrue();
    expect(AtsKeywordExtractionSchema.safeParse({
      ...extraction,
      keywords: [
        extraction.keywords[0],
        { ...extraction.keywords[1]!, phrase: extraction.keywords[0]!.phrase.toLocaleUpperCase() },
      ],
    }).error?.issues.some((issue) => issue.message.includes("unique case-insensitively"))).toBeTrue();
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
      exactEdits: [bulletEdit, { ...skillEdit, after: "TypeScript, Bun" }],
    }).error?.issues.some((issue) => issue.message.includes("comma"))).toBeTrue();
    expect(JobAnalysisSchema.safeParse({
      ...analysis,
      exactEdits: [...analysis.exactEdits, { ...bulletEdit, id: "duplicate-target" }],
    }).error?.issues.some((issue) => issue.message.includes("baseline item targets"))).toBeTrue();
  });

  test("parses a resume without competitions while preserving other sections and provenance", () => {
    const competition = parsedBaseline.regions["competitions-other"]!;
    const withoutCompetition = baseline.slice(0, competition.headingStart) + baseline.slice(competition.bodyEnd);
    const parsed = parseBaselineResume(withoutCompetition);
    expect(parsed.entities).toEqual(parsedBaseline.entities.filter((entity) => entity.section !== "competitions-other"));
    expect(parsed.skills).toEqual(parsedBaseline.skills);
    const { analysis } = fixtures();
    const retainedPlan = buildMechanicalTailoringPlan(zeroEditAnalysis(analysis), baseline);
    expect(() => assertResumeDiffMatchesTailoredSource(buildResumeDiff(baseline, retainedPlan), withoutCompetition)).toThrow();
    for (const region of [parsed.regions.experience, parsed.regions.projects, parsed.regions["technical-skills"]]) {
      const missingRequired = withoutCompetition.slice(0, region.headingStart) + withoutCompetition.slice(region.bodyEnd);
      expect(() => parseBaselineResume(missingRequired)).toThrow();
    }
  });

  test("ignores long comments between canonical entity headings and items without shifting parser offsets", () => {
    const uncommented = String.raw`\begin{document}
\section{Experience}
\resumeSubheading
  {Senior Engineer}
  {Jan 2024 -- Present}
  {Acme Systems}
  {Remote}
\resumeItem{Raised service availability to 99.9\% across critical workflows.}
\resumeSubheading
  {Software Engineer}
  {Jan 2022 -- Dec 2023}
  {Beta Labs}
  {New York, NY}
\resumeItem{Reduced deployment time by 40\% through automated releases.}
\section{Projects}
\section{Competitions \& Other}
\section{Technical Skills}
\end{document}`;
    const commented = String.raw`\begin{document}
\section{Experience}
\resumeSubheading
  {Senior Engineer}
  {Jan 2024 -- Present}
  {Acme Systems}
  {Remote}
% This intentionally long canonical-source comment sits between a heading and its item and must not move parser boundaries, reassign bullets, alter public entity data, or change stable IDs merely because ignored TeX text occupies many source characters.
\resumeItem{Raised service availability to 99.9\% across critical workflows.}
\resumeSubheading
  {Software Engineer}
  {Jan 2022 -- Dec 2023}
  {Beta Labs}
  {New York, NY}
\resumeItem{Reduced deployment time by 40\% through automated releases.}
\section{Projects}
\section{Competitions \& Other}
\section{Technical Skills}
\end{document}`;

    const expected = parseBaselineResume(uncommented);
    const actual = parseBaselineResume(commented);

    expect(expected.entities.map((entity) => ({
      entityId: entity.entityId,
      bullets: entity.bullets.map((bullet) => bullet.text),
    }))).toEqual([
      {
        entityId: "Acme Systems",
        bullets: ["Raised service availability to 99.9% across critical workflows."],
      },
      {
        entityId: "Beta Labs",
        bullets: ["Reduced deployment time by 40% through automated releases."],
      },
    ]);
    expect(actual.entities).toEqual(expected.entities);
    expect(actual.bullets.map((bullet) => ({ id: bullet.id, text: bullet.text }))).toEqual(
      expected.bullets.map((bullet) => ({ id: bullet.id, text: bullet.text })),
    );
  });

  test("builds a complete canonical-to-current diff with aligned changes", () => {
    const { plan } = fixtures();
    const retained = plan.decisions.find((decision) => decision.section === "experience" && decision.action === "retain");
    const rewritten = plan.decisions.find((decision) => decision.action === "rewrite");
    const deleted = plan.decisions.find((decision) => (
      decision.section === "experience"
      && decision.action === "retain"
      && decision.id !== retained?.id
    ));
    if (!retained?.baselineItemId || !rewritten?.baselineItemId || !deleted?.baselineItemId) {
      throw new Error("diff test requires retained, rewritten, and deletable baseline bullets");
    }

    const addition = {
      id: "decision:diff-added",
      section: deleted.section,
      entityId: deleted.entityId,
      baselineItemId: null,
      action: "add" as const,
      text: "Added zero-downtime delivery checks.",
      rationale: "Add an evidence-backed delivery result.",
    };
    const diffPlan = TailoringPlanSchema.parse({
      ...plan,
      decisions: plan.decisions.flatMap((decision) => decision.id === deleted.id
        ? [
            {
              ...decision,
              action: "omit" as const,
              text: null,
              rationale: "Remove lower-priority content.",
            },
            addition,
          ]
        : [decision]),
      omissions: [
        ...plan.omissions,
        {
          baselineItemId: deleted.baselineItemId,
          rationale: "Remove lower-priority content.",
        },
      ],
    });

    const diff = buildResumeDiff(baseline, diffPlan);
    const rows = diff.sections.flatMap((section) => section.groups.flatMap((group) => group.rows));
    const baselineBullets = new Map(parsedBaseline.bullets.map((bullet) => [bullet.id, bullet.text]));

    expect(diff.sections.map((section) => section.id)).toEqual([
      "experience",
      "projects",
      "competitions-other",
      "technical-skills",
    ]);
    expect(rows).toHaveLength(parsedBaseline.bullets.length + parsedBaseline.skills.length + 1);
    expect(rows.find((row) => row.id === retained.baselineItemId)).toEqual({
      id: retained.baselineItemId,
      kind: "bullet",
      change: "unchanged",
      before: retained.text,
      after: retained.text,
    });
    expect(rows.find((row) => row.id === rewritten.baselineItemId)).toEqual({
      id: rewritten.baselineItemId,
      kind: "bullet",
      change: "edited",
      before: baselineBullets.get(rewritten.baselineItemId)!,
      after: rewritten.text,
    });
    expect(rows.find((row) => row.id === deleted.baselineItemId)).toEqual({
      id: deleted.baselineItemId,
      kind: "bullet",
      change: "deleted",
      before: baselineBullets.get(deleted.baselineItemId)!,
      after: null,
    });
    expect(rows.find((row) => row.id === addition.id)).toEqual({
      id: addition.id,
      kind: "bullet",
      change: "added",
      before: null,
      after: addition.text,
    });

    const omittedSkillIndex = plan.skillDecisions.findIndex((decision) => decision.action === "omit");
    const omittedSkill = plan.skillDecisions[omittedSkillIndex];
    const replacementSkill = plan.skillDecisions[omittedSkillIndex + 1];
    if (!omittedSkill || replacementSkill?.action !== "add") {
      throw new Error("diff test requires an adjacent skill replacement");
    }
    const baselineSkill = parsedBaseline.skills.find((skill) => (
      skill.category === omittedSkill.category && skill.skill === omittedSkill.skill
    ));
    if (!baselineSkill) throw new Error("diff test requires the omitted baseline skill");
    expect(rows.find((row) => row.id === baselineSkill.id)).toEqual({
      id: baselineSkill.id,
      kind: "skill",
      change: "edited",
      before: omittedSkill.skill,
      after: replacementSkill.skill,
    });
  });

  test("rejects a tailored source that would make its published diff stale", () => {
    const { snapshot, plan } = fixtures();
    const diff = buildResumeDiff(baseline, plan);
    const tailored = renderTailoredResume(plan, baseline, snapshot);
    const editedRow = diff.sections
      .flatMap((section) => section.groups)
      .flatMap((group) => group.rows)
      .find((row) => row.change === "edited" && row.after !== null);
    const editedText = editedRow?.after;
    if (!editedText) throw new Error("diff test requires an edited current line");

    expect(() => assertResumeDiffMatchesTailoredSource(diff, tailored)).not.toThrow();
    expect(() => assertResumeDiffMatchesTailoredSource(
      diff,
      tailored.replace(editedText, "Changed without updating the published diff."),
    )).toThrow("tailored resume content does not match the published resume diff");
  });
});

describe("analysis validation", () => {
  test("rejects stale hashes, JD text, targets, and replacements", () => {
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

});

describe("mechanical tailoring and canonical rendering", () => {
  test("omits the competitions heading and list when its last entry is omitted", () => {
    const { snapshot, analysis } = fixtures();
    const candidates = parsedBaseline.bullets.filter((bullet) => bullet.section === "competitions-other").map((bullet) => ({
      baselineItemId: bullet.id, section: bullet.section, entityId: bullet.entityId, text: bullet.text,
    }));
    const plan = buildMechanicalTailoringPlan(analysis, baseline, {
      failureCount: 1, pageCount: 2, pagesOverLimit: 1, overflowLineCount: 6,
      note: "Remove lower-priority competitions to meet the one-page requirement.",
      requiredOmissionCount: candidates.length, candidates,
    });
    const output = renderTailoredResume(plan, baseline, snapshot);
    expect(output.includes("\\section{Competitions \\& Other}")).toBeFalse();
    expect(/\\resumeSubHeadingListStart\s*\\resumeSubHeadingListEnd/.test(output)).toBeFalse();
    expect(parseBaselineResume(output).entities.filter((entity) => entity.section === "competitions-other")).toEqual([]);
    expect(validateRepairCandidate(output, baseline).valid).toBeTrue();
    assertResumeDiffMatchesTailoredSource(buildResumeDiff(baseline, plan), output);
  });

  test("renders citation-free analysis as edited bullet and skill", () => {
    const { snapshot, analysis } = fixtures();
    validateAnalysisAgainstBaseline(analysis, JOB_DESCRIPTION, baseline, snapshot);
    const plan = buildMechanicalTailoringPlan(analysis, baseline);
    const output = renderEditedResume({
      plan,
      commentDispositions: [{ commentIndex: 0, status: "applied", rationale: "Use the source-supported TypeScript edits." }],
    }, ["Emphasize TypeScript delivery"], analysis, baseline, snapshot);
    const rendered = parseBaselineResume(output);
    expect(rendered.bullets[0]?.text).toBe("Built TypeScript tooling for Example Co to review sample pull requests and verify changes.");
    expect(rendered.skills.some((skill) => skill.skill === "TypeScript services")).toBeTrue();
    expect(rendered.skills.some((skill) => skill.skill === "JavaScript")).toBeFalse();
    expect(immutableChunks(rendered)).toEqual(immutableChunks(parsedBaseline));
    const diff = buildResumeDiff(baseline, plan);
    assertResumeDiffMatchesTailoredSource(diff, output);
  });
  test("renders exact escaped replacements without changing immutable structure or counts", () => {
    const { snapshot, analysis, plan } = fixtures();
    const output = renderTailoredResume(plan, baseline, snapshot);
    const rendered = parseBaselineResume(output);
    const bulletEdit = analysis.exactEdits.find((edit) => edit.kind === "bullet")!;
    const skillEdit = analysis.exactEdits.find((edit) => edit.kind === "skill")!;
    expect(output).toContain(plainTextToTex(bulletEdit.after));
    const experience = parsedBaseline.entities.find((entity) => entity.section === "experience")!;
    const project = parsedBaseline.entities.find((entity) => entity.section === "projects")!;
    expect(output).toContain(`\\resumeSubheading\n${experience.headingArguments.map((argument) => `      {${argument}}`).join("\n")}\n      \\resumeItemListStart[0.35in]`);
    expect(output).toContain(`\\resumeProjectHeading\n${project.headingArguments.map((argument) => `      {${argument}}`).join("\n")}\n      \\resumeItemListStart\n`);
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
    expect(rendered.bullets.map((bullet) => bullet.text)).toEqual(parsedBaseline.bullets.map((bullet) => bullet.text));
    expect(rendered.skills.map((skill) => `${skill.category}\0${skill.skill}`)).toEqual(parsedBaseline.skills.map((skill) => `${skill.category}\0${skill.skill}`));
    expect(rendered.entities.filter((entity) => entity.section === "projects").map((entity) => entity.entityId)).toEqual(parsedBaseline.entities.filter((entity) => entity.section === "projects").map((entity) => entity.entityId));
  });

  test("preserves edit-plan validation for human revisions", () => {
    const { snapshot, analysis, plan } = fixtures();
    const edit: EditResult = { plan, commentDispositions: [{ commentIndex: 0, status: "applied", rationale: "Apply request" }] };
    expect(renderEditedResume(edit, ["Use the validated edit"], analysis, baseline, snapshot)).toContain("TypeScript services");
    expect(() => renderEditedResume({ ...edit, commentDispositions: [] }, ["Do something"], analysis, baseline, snapshot)).toThrow(/every comment/i);
    expect(() => renderEditedResume({ ...edit, plan: { ...plan, analysisSha256: sha } }, ["Do something"], analysis, baseline, snapshot)).toThrow(/immutable job analysis/i);
    expect(() => renderEditedResume(edit, [" "], analysis, baseline, snapshot)).toThrow(/empty/i);
    expect(() => renderEditedResume({ ...edit, commentDispositions: [{ ...edit.commentDispositions[0]!, commentIndex: 1 }] }, ["Do something"], analysis, baseline, snapshot)).toThrow(/indexes/i);
  });
});

describe("TeX repair validation", () => {
  test("allows an absent competitions section without weakening repair structure checks", () => {
    const competition = parsedBaseline.regions["competitions-other"]!;
    const withoutCompetition = baseline.slice(0, competition.headingStart) + baseline.slice(competition.bodyEnd);
    expect(validateRepairCandidate(withoutCompetition, baseline).valid).toBeTrue();
    expect(validateRepairCandidate(withoutCompetition, withoutCompetition).valid).toBeTrue();
    expect(() => validateRepairCandidate(withoutCompetition.replace("Test Candidate", "Mallory"), baseline)).toThrow();
    expect(() => validateRepairCandidate(withoutCompetition.replace("\\section{Projects}", ""), baseline)).toThrow();
    const duplicated = baseline.slice(0, competition.headingStart) + competition.heading + "\n" + baseline.slice(competition.headingStart);
    expect(() => validateRepairCandidate(duplicated, baseline)).toThrow();
    const reordered = withoutCompetition.replace("\\section{Technical Skills}", "\\section{Technical Skills}\n" + competition.heading);
    expect(() => validateRepairCandidate(reordered, baseline)).toThrow();
    const injected = baseline.slice(0, competition.bodyStart) + "\\input{secret}" + baseline.slice(competition.bodyStart);
    expect(() => validateRepairCandidate(injected, baseline)).toThrow();
  });

  test("detects every forbidden file, process, and metaprogramming primitive", () => {
    const forbidden = ["input", "include", "openin", "openout", "read", "write", "immediate", "special", "usepackage", "RequirePackage", "includegraphics", "pdfobj", "pdfxform", "pdfliteral", "catcode", "csname", "newcommand", "def", "loop", "directlua", "write18"];
    for (const primitive of forbidden) expect(scanForbiddenPrimitives(`\\${primitive}{evil}`), primitive).not.toHaveLength(0);
    expect(scanForbiddenPrimitives("--shell-escape")).not.toHaveLength(0);
  });

  test("accepts safe edits within editable section bodies", () => {
    expect(baseline).toContain("Processed over \\$500,000");
    const reordered = baseline.replace(/(\\resumeItem\{Built a full-stack[^\n]+\}\n)(\s*)(\\resumeItem\{Processed over[^\n]+\})/, "$3\n$2$1");
    expect(validateRepairCandidate(baseline, baseline).valid).toBeTrue();
    const candidates = [
      baseline.replace("Processed over \\$500,000", "Processed over \\$900,000"),
      baseline.replace("\\section{Projects}", "\\section{Projects}\n% repaired body comment"),
      baseline.replace("Gmail API,", "\\textbf{Gmail API},"),
      reordered,
    ];
    for (const candidate of candidates) expect(validateRepairCandidate(candidate, baseline).valid).toBeTrue();
  });

  test("retains size, immutable-region, primitive, command, brace, and macro safety checks", () => {
    const injected = baseline.replace("\\resumeItem{Built a full-stack", "\\input{/etc/passwd}\\resumeItem{Built a full-stack");
    expect(() => validateRepairCandidate(injected, baseline)).toThrow(/forbidden/i);
    const misplacedGlyphInput = baseline.replace("\\resumeItem{Built a full-stack", "\\input{glyphtounicode}\\resumeItem{Built a full-stack");
    expect(() => validateRepairCandidate(misplacedGlyphInput, baseline)).toThrow(/forbidden/i);
    const unknown = baseline.replace("\\resumeItem{Built a full-stack", "\\evil{hidden}\\resumeItem{Built a full-stack");
    expect(() => validateRepairCandidate(unknown, baseline)).toThrow(/unknown body control sequence/i);
    const malformedMacro = baseline.replace("\\resumeItem{Built a full-stack dashboard", "\\resumeItem Built a full-stack dashboard");
    expect(() => validateRepairCandidate(malformedMacro, baseline)).toThrow();
    expect(() => validateRepairCandidate(baseline.replace("Test Candidate", "Mallory"), baseline)).toThrow(/immutable resume region/i);
    expect(() => validateRepairCandidate(baseline.replace("\\resumeItem{Built a full-stack", "}\\resumeItem{Built a full-stack"), baseline)).toThrow(/unmatched closing brace/i);
    expect(() => validateRepairCandidate("x".repeat(ARTIFACT_LIMITS.tex + 1), baseline)).toThrow(/524288 byte limit/i);
  });
});
