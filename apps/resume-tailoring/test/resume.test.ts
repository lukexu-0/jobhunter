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
  AtsKeywordExtractionSchema,
  AtsKeywordSchema,
  EditResultSchema,
  JobAnalysisSchema,
  TailoringResultSchema,
  TailoringPlanSchema,
  buildEvidenceLedger,
  buildResumeDiff,
  assertResumeDiffMatchesTailoredSource,
  collectAnalysisSemanticIssues,
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
import { atsKeywordExtractionFixture, jobAnalysisFixture } from "./job-analysis.fixture.ts";

const baseline = readFileSync(resolve(import.meta.dir, "../../user-info/resume-main/Alex_Example_Resume.tex"), "utf8");
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
    relativePath: "apps/user-info/resume-main/Alex_Example_Resume.tex",
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

function withMustIncludeDirective(
  snapshot: ContextSnapshot,
  evidenceIndex = 0,
): { readonly snapshot: ContextSnapshot; readonly evidence: EvidenceBlock } {
  const factualEvidence = snapshot.evidence[evidenceIndex]!;
  const directiveEvidence: EvidenceBlock = {
    ...factualEvidence,
    id: `directive-${evidenceIndex}`,
    ordinal: factualEvidence.ordinal + 1,
    headingPath: [...factualEvidence.headingPath, "21. Must Include"],
    text: "The resume must include the candidate's testing impact.",
  };
  return {
    evidence: directiveEvidence,
    snapshot: {
      ...snapshot,
      evidence: [...snapshot.evidence, directiveEvidence],
      mustIncludeDirectives: [{
        evidenceId: directiveEvidence.id,
        sourceId: directiveEvidence.sourceId,
        entityId: directiveEvidence.entityId,
        text: directiveEvidence.text,
      }],
    },
  };
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
    const projects = parsedBaseline.entities.filter((item) => item.section === "projects");
    const projectTitles = projects.map((item) => item.entityId);
    expect(projectTitles).toEqual([
      "Resume Tailoring and Application Agent",
      "Sample Project",
    ]);
    expect(projectTitles).not.toContain("Sample Project Archive");
    const legacyBaseline = baseline.replaceAll("\\enspace\\textbar\\enspace", () => "$|$");
    expect(parseBaselineResume(legacyBaseline).entities.filter((item) => item.section === "projects").map((item) => item.entityId)).toEqual([
      "Resume Tailoring and Application Agent",
      "Sample Project",
    ]);
    const jobhunter = projects.find((item) => item.entityId === "Resume Tailoring and Application Agent");
    expect(jobhunter?.headingArguments[1]).toBe("Jan 2020 -- Present");
    expect(jobhunter?.bullets).toHaveLength(3);
    expect(jobhunter?.bullets[0]?.text).toBe(
      "Built a local resume-tailoring and application agent that turns job postings into evidence-backed, ATS-aligned one-page resumes and human-reviewed application workflows.",
    );
    const jobhunterContent = [
      ...(jobhunter?.headingArguments ?? []),
      ...(jobhunter?.bullets.map((item) => item.text) ?? []),
    ].join(" ");
    expect(jobhunterContent).toContain("OpenAI Agents SDK");
    expect(jobhunterContent).toContain("Browser Use");
    const competition = parsedBaseline.entities.find((item) => item.section === "competitions-other");
    expect(competition?.entityId).toBe("Example Engineering Competition");
    expect(competition?.headingArguments).toEqual(["Semifinalist", "Jan 2020 -- Jun 2020", "Example Engineering Competition", ""]);
    expect(competition?.bullets.map((item) => item.text)).toEqual(["Completed a synthetic team exercise using a deterministic scoring model."]);
    expect(parsedBaseline.bullets.length).toBeGreaterThan(10);
    expect(parsedBaseline.skills.length).toBeGreaterThan(10);
    expect(again.bullets.map((item) => item.id)).toEqual(parsedBaseline.bullets.map((item) => item.id));
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
      evidenceIds: ["evidence-0"],
      factKeys: [],
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
              evidenceIds: ["evidence-0"],
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
          evidenceIds: ["evidence-0"],
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
  test("accepts globally valid baseline evidence and entity-equivalent authority", () => {
    const { snapshot, analysis } = fixtures();
    expect(validateAnalysisAgainstBaseline(analysis, JOB_DESCRIPTION, baseline, snapshot)).toEqual(analysis);
    const baselineSupported = replaceEvidence(analysis, ["canonical-baseline-evidence"]);
    expect(validateAnalysisAgainstBaseline(baselineSupported, JOB_DESCRIPTION, baseline, snapshot)).toEqual(baselineSupported);
  });

  test("requires an active must-include directive on a fact-supported bullet edit", () => {
    const { snapshot, analysis } = fixtures();
    const directive = withMustIncludeDirective(snapshot);

    expect(() => validateAnalysisAgainstBaseline(
      analysis,
      JOB_DESCRIPTION,
      baseline,
      directive.snapshot,
    )).toThrow("active must-include directive directive-0 is missing from a supported bullet edit");
  });

  test("rejects directive-only, baseline-only, cross-entity, JD-keyword, and skill citations", () => {
    const { snapshot, analysis } = fixtures();
    const directive = withMustIncludeDirective(snapshot);
    const directiveOnly = replaceEvidence(analysis, [directive.evidence.id]);
    expect(() => validateAnalysisAgainstBaseline(
      directiveOnly,
      JOB_DESCRIPTION,
      baseline,
      directive.snapshot,
    )).toThrow("requirement evidence directive-0 cannot be used by a JD keyword");

    const sentinelEvidence: EvidenceBlock = {
      ...directive.evidence,
      id: "no-requirement",
      text: "None specified",
    };
    const sentinelSnapshot: ContextSnapshot = {
      ...snapshot,
      evidence: [...snapshot.evidence, sentinelEvidence],
      mustIncludeDirectives: [],
    };
    expect(() => validateAnalysisAgainstBaseline(
      replaceEvidence(analysis, [sentinelEvidence.id]),
      JOB_DESCRIPTION,
      baseline,
      sentinelSnapshot,
    )).toThrow("requirement evidence no-requirement cannot be used by a JD keyword");

    const baselineOnly: JobAnalysis = {
      ...replaceEvidence(analysis, ["canonical-baseline-evidence"]),
      exactEdits: replaceEvidence(analysis, ["canonical-baseline-evidence"]).exactEdits
        .map((edit) => edit.kind === "bullet"
          ? { ...edit, evidenceIds: [...edit.evidenceIds, directive.evidence.id] }
          : edit),
    };
    expect(() => validateAnalysisAgainstBaseline(
      baselineOnly,
      JOB_DESCRIPTION,
      baseline,
      directive.snapshot,
    )).toThrow("requirement evidence directive-0 lacks non-directive same-entity factual support");

    const skillCitation: JobAnalysis = {
      ...analysis,
      exactEdits: analysis.exactEdits.map((edit) => edit.kind === "skill"
        ? { ...edit, evidenceIds: [...edit.evidenceIds, directive.evidence.id] }
        : edit),
    };
    expect(() => validateAnalysisAgainstBaseline(
      skillCitation,
      JOB_DESCRIPTION,
      baseline,
      directive.snapshot,
    )).toThrow("requirement evidence directive-0 cannot be used by a skill edit");

    const keywordCitation = replaceEvidence(
      analysis,
      ["evidence-0", directive.evidence.id],
    );
    expect(() => validateAnalysisAgainstBaseline(
      keywordCitation,
      JOB_DESCRIPTION,
      baseline,
      directive.snapshot,
    )).toThrow("requirement evidence directive-0 cannot be used by a JD keyword");

    const otherDirective = withMustIncludeDirective(snapshot, 1);
    const crossEntity: JobAnalysis = {
      ...analysis,
      exactEdits: analysis.exactEdits.map((edit) => edit.kind === "bullet"
        ? { ...edit, evidenceIds: [...edit.evidenceIds, otherDirective.evidence.id] }
        : edit),
    };
    expect(() => validateAnalysisAgainstBaseline(
      crossEntity,
      JOB_DESCRIPTION,
      baseline,
      otherDirective.snapshot,
    )).toThrow(/attributed/i);
  });

  test("renders and ledgers only plans that keep an active directive on its fact-supported rewrite", () => {
    const { snapshot, analysis } = fixtures();
    const directive = withMustIncludeDirective(snapshot);
    const supportedAnalysis: JobAnalysis = {
      ...analysis,
      exactEdits: analysis.exactEdits.map((edit) => edit.kind === "bullet"
        ? { ...edit, evidenceIds: [...edit.evidenceIds, directive.evidence.id] }
        : edit),
    };
    expect(() => validateAnalysisAgainstBaseline(
      supportedAnalysis,
      JOB_DESCRIPTION,
      baseline,
      directive.snapshot,
    )).not.toThrow();
    const plan = buildMechanicalTailoringPlan(supportedAnalysis, baseline);
    expect(() => renderTailoredResume(plan, baseline, directive.snapshot)).not.toThrow();
    expect(buildEvidenceLedger(
      supportedAnalysis,
      plan,
      directive.snapshot,
    ).citations.map((citation) => citation.evidenceId)).toContain(directive.evidence.id);

    const dropped = TailoringPlanSchema.parse({
      ...plan,
      decisions: plan.decisions.map((decision) => decision.action === "rewrite"
        ? {
            ...decision,
            evidenceIds: decision.evidenceIds.filter((id) => id !== directive.evidence.id),
          }
        : decision),
    });
    expect(() => renderTailoredResume(
      dropped,
      baseline,
      directive.snapshot,
    )).toThrow("requirement evidence directive-0 cannot be relocated to baseline override metadata");
    expect(() => buildEvidenceLedger(
      supportedAnalysis,
      dropped,
      directive.snapshot,
    )).toThrow("requirement evidence directive-0 cannot be relocated to baseline override metadata");
  });

  test("direct ledger validation preserves analysis-active directives when a plan drops all support", () => {
    const { snapshot, analysis } = fixtures();
    const directive = withMustIncludeDirective(snapshot);
    const supportedAnalysis: JobAnalysis = {
      ...analysis,
      exactEdits: analysis.exactEdits.map((edit) => edit.kind === "bullet"
        ? { ...edit, evidenceIds: [...edit.evidenceIds, directive.evidence.id] }
        : edit),
    };
    const plan = buildMechanicalTailoringPlan(supportedAnalysis, baseline);
    const rewrite = plan.decisions.find((decision) => decision.action === "rewrite")!;
    const originalBullet = parsedBaseline.bullets.find((bullet) =>
      bullet.id === rewrite.baselineItemId)!;
    const dropped = TailoringPlanSchema.parse({
      ...plan,
      decisions: plan.decisions.map((decision) => decision.id === rewrite.id
        ? {
            ...decision,
            action: "retain",
            text: originalBullet.text,
            evidenceIds: [],
            factKeys: [],
            rationale: "Drop the analyzed rewrite.",
          }
        : decision),
      baselineOverrides: plan.baselineOverrides.filter((override) =>
        override.baselineItemId !== rewrite.baselineItemId),
    });

    expect(() => renderTailoredResume(dropped, baseline, directive.snapshot)).not.toThrow();
    expect(() => buildEvidenceLedger(
      supportedAnalysis,
      dropped,
      directive.snapshot,
    )).toThrow("analysis-active must-include directive directive-0 is missing from a supported decision");
  });

  test("rejects directives on retained or omitted content, skills, fact winners, omissions, and comments", () => {
    const { snapshot, analysis } = fixtures();
    const directive = withMustIncludeDirective(snapshot);
    const supportedAnalysis: JobAnalysis = {
      ...analysis,
      exactEdits: analysis.exactEdits.map((edit) => edit.kind === "bullet"
        ? { ...edit, evidenceIds: [...edit.evidenceIds, directive.evidence.id] }
        : edit),
    };
    const plan = buildMechanicalTailoringPlan(supportedAnalysis, baseline);
    const retained = plan.decisions.find((decision) => decision.action === "retain")!;
    const nonRetainSkill = plan.skillDecisions.find((decision) =>
      decision.action !== "retain")!;
    const withDecision = (action: "retain" | "omit"): TailoringPlan =>
      TailoringPlanSchema.parse({
        ...plan,
        decisions: plan.decisions.map((decision) => decision.id === retained.id
          ? {
              ...decision,
              action,
              text: action === "omit" ? null : decision.text,
              evidenceIds: [directive.evidence.id],
            }
          : decision),
      });
    expect(() => buildEvidenceLedger(
      supportedAnalysis,
      withDecision("retain"),
      directive.snapshot,
    )).toThrow("requirement evidence directive-0 cannot be used on retain decision content");
    expect(() => buildEvidenceLedger(
      supportedAnalysis,
      withDecision("omit"),
      directive.snapshot,
    )).toThrow("requirement evidence directive-0 cannot be used on omit decision content");

    const skillPlan = TailoringPlanSchema.parse({
      ...plan,
      skillDecisions: plan.skillDecisions.map((decision) =>
        decision.id === nonRetainSkill.id
          ? { ...decision, evidenceIds: [...decision.evidenceIds, directive.evidence.id] }
          : decision),
    });
    expect(() => buildEvidenceLedger(
      supportedAnalysis,
      skillPlan,
      directive.snapshot,
    )).toThrow("requirement evidence directive-0 cannot be used on a skill decision");

    const factWinnerPlan = TailoringPlanSchema.parse({
      ...plan,
      factWinners: [{
        factKey: "requirement-as-fact",
        value: "resume",
        entityId: directive.evidence.entityId,
        evidenceId: directive.evidence.id,
      }],
    });
    expect(() => buildEvidenceLedger(
      supportedAnalysis,
      factWinnerPlan,
      directive.snapshot,
    )).toThrow("requirement evidence directive-0 cannot support a fact winner");

    const omissionPlan = TailoringPlanSchema.parse({
      ...plan,
      omissions: [{
        baselineItemId: retained.baselineItemId!,
        rationale: "Metadata-only misuse.",
        evidenceIds: [directive.evidence.id],
      }],
    });
    expect(() => buildEvidenceLedger(
      supportedAnalysis,
      omissionPlan,
      directive.snapshot,
    )).toThrow("requirement evidence directive-0 cannot support omission metadata");

    const directiveOnlyBase = buildMechanicalTailoringPlan(analysis, baseline);
    const directiveOnlyPlan = TailoringPlanSchema.parse({
      ...directiveOnlyBase,
      decisions: directiveOnlyBase.decisions.map((decision) =>
        decision.action === "rewrite"
          ? { ...decision, evidenceIds: [directive.evidence.id] }
          : decision),
      baselineOverrides: directiveOnlyBase.baselineOverrides.map((override) =>
        ({ ...override, evidenceIds: [directive.evidence.id] })),
    });
    expect(() => buildEvidenceLedger(
      analysis,
      directiveOnlyPlan,
      directive.snapshot,
    )).toThrow("requirement evidence directive-0 lacks non-directive same-entity factual support");

    const inactiveDirective = withMustIncludeDirective(snapshot, 1);
    const inactivePlan = buildMechanicalTailoringPlan(analysis, baseline);
    const inactiveRewrite = inactivePlan.decisions.find((decision) =>
      decision.action === "rewrite")!;
    const crossEntityPlan = TailoringPlanSchema.parse({
      ...inactivePlan,
      decisions: inactivePlan.decisions.map((decision) =>
        decision.id === inactiveRewrite.id
          ? {
              ...decision,
              evidenceIds: [...decision.evidenceIds, inactiveDirective.evidence.id],
            }
          : decision),
      baselineOverrides: inactivePlan.baselineOverrides.map((override) =>
        override.baselineItemId === inactiveRewrite.baselineItemId
          ? {
              ...override,
              evidenceIds: [...override.evidenceIds, inactiveDirective.evidence.id],
            }
          : override),
    });
    expect(() => buildEvidenceLedger(
      analysis,
      crossEntityPlan,
      inactiveDirective.snapshot,
    )).toThrow("requirement evidence directive-1 lacks non-directive same-entity factual support");

    expect(() => buildEvidenceLedger(
      supportedAnalysis,
      plan,
      directive.snapshot,
      {
        comments: ["Keep the impact."],
        commentDispositions: [{
          commentIndex: 0,
          status: "applied",
          rationale: "Misuse requirement metadata as comment support.",
          evidenceIds: [directive.evidence.id],
        }],
      },
    )).toThrow("requirement evidence directive-0 cannot support a comment disposition");
  });

  test("collects structured safe semantic issues without changing fail-fast validation", () => {
    const { snapshot, analysis } = fixtures();
    const invalid: JobAnalysis = {
      ...analysis,
      jobDescriptionSha256: sha,
      baselineSha256: sha,
      jdKeywords: analysis.jdKeywords.map((keyword) => ({
        ...keyword,
        jdQuote: "Absent TypeScript quote",
        evidenceIds: ["unknown-evidence", "evidence-1"],
      })),
      exactEdits: analysis.exactEdits.map((edit) => ({
        ...edit,
        before: edit.kind === "bullet" ? `${edit.before} stale` : edit.before,
        after: edit.kind === "skill" ? "TypeScript" : edit.after,
        evidenceIds: ["unknown-evidence", "evidence-1"],
      })),
    };
    const issues = collectAnalysisSemanticIssues(
      invalid,
      JOB_DESCRIPTION,
      baseline,
      { ...snapshot, baselineSha256: sha },
    );

    expect(new Set(issues.map((issue) => issue.category))).toEqual(new Set([
      "hashes-and-snapshot",
      "evidence-identifiers",
      "job-description-grounding",
      "evidence-provenance",
      "baseline-targets",
      "skill-replacements",
    ]));
    expect(issues).toContainEqual({
      code: "unknown-evidence",
      category: "evidence-identifiers",
      path: ["jdKeywords", 0, "evidenceIds", 0],
      message: "must contain only supplied evidence IDs",
    });
    expect(issues).toContainEqual({
      code: "bullet-before",
      category: "baseline-targets",
      path: ["exactEdits", 0, "before"],
      message: "must exactly match the supplied baseline bullet text",
    });
    expect(issues).toContainEqual({
      code: "skill-existing",
      category: "skill-replacements",
      path: ["exactEdits", 1, "after"],
      message: "must not duplicate an existing baseline skill in its category",
    });
    expect(issues.map((issue) => issue.message).join("\n")).not.toContain("unknown-evidence");
    expect(() => validateAnalysisAgainstBaseline(
      invalid,
      JOB_DESCRIPTION,
      baseline,
      { ...snapshot, baselineSha256: sha },
    )).toThrow("job analysis job description hash does not match the source");
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

  test("does not copy must-include directive IDs onto mechanical skill replacement halves", () => {
    const { snapshot, analysis } = fixtures();
    const directive = withMustIncludeDirective(snapshot);
    const analysisWithDirective: JobAnalysis = {
      ...analysis,
      exactEdits: analysis.exactEdits.map((edit) => ({
        ...edit,
        evidenceIds: [...edit.evidenceIds, directive.evidence.id],
      })),
    };

    const plan = buildMechanicalTailoringPlan(
      analysisWithDirective,
      baseline,
      undefined,
      [directive.evidence.id],
    );

    expect(plan.decisions.find((decision) => decision.action === "rewrite")?.evidenceIds)
      .toContain(directive.evidence.id);
    expect(plan.skillDecisions.flatMap((decision) => decision.evidenceIds))
      .not.toContain(directive.evidence.id);
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
    expect(validateRepairCandidate(baseline, baseline).valid).toBeTrue();
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
    const misplacedGlyphInput = baseline.replace("\\resumeItem{Built a full-stack", "\\input{glyphtounicode}\\resumeItem{Built a full-stack");
    expect(() => validateRepairCandidate(misplacedGlyphInput, baseline)).toThrow(/forbidden/i);
    const unknown = baseline.replace("\\resumeItem{Built a full-stack", "\\evil{hidden}\\resumeItem{Built a full-stack");
    expect(() => validateRepairCandidate(unknown, baseline)).toThrow(/unknown body control sequence/i);
    const malformedMacro = baseline.replace("\\resumeItem{Built a full-stack sample workflow", "\\resumeItem Built a full-stack sample workflow");
    expect(() => validateRepairCandidate(malformedMacro, baseline)).toThrow();
    expect(() => validateRepairCandidate(baseline.replace("Alex Example", "Mallory"), baseline)).toThrow(/immutable resume region/i);
    expect(() => validateRepairCandidate(baseline.replace("\\resumeItem{Built a full-stack", "}\\resumeItem{Built a full-stack"), baseline)).toThrow(/unmatched closing brace/i);
    expect(() => validateRepairCandidate("x".repeat(256 * 1024 + 1), baseline)).toThrow(/256 KiB/i);
  });
});
