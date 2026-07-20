import { ResumeDiffSchema, type ResumeDiff, type ResumeDiffRow } from "../contracts/index.ts";
import { parseBaselineResume, type BaselineBullet, type BaselineSkill } from "./parser.ts";
import type { SkillDecision, TailoringDecision, TailoringPlan } from "./types.ts";

const SECTION_LABELS = {
  experience: "Experience",
  projects: "Projects",
  "competitions-other": "Competitions & Other",
  "technical-skills": "Technical Skills",
} as const;

function row(
  id: string,
  kind: ResumeDiffRow["kind"],
  before: string | null,
  after: string | null,
): ResumeDiffRow {
  const change = before === null
    ? "added"
    : after === null
      ? "deleted"
      : before === after
        ? "unchanged"
        : "edited";
  return { id, kind, change, before, after };
}

function bulletRow(
  decision: TailoringDecision,
  baselineBullets: ReadonlyMap<string, BaselineBullet>,
): ResumeDiffRow {
  if (decision.action === "add") {
    return row(decision.id, "bullet", null, decision.text);
  }
  const bullet = baselineBullets.get(decision.baselineItemId ?? "");
  if (!bullet) throw new Error(`resume diff references unknown baseline bullet ${decision.baselineItemId}`);
  return row(bullet.id, "bullet", bullet.text, decision.action === "omit" ? null : decision.text);
}


function isSkillReplacement(omission: SkillDecision, addition: SkillDecision | undefined): addition is SkillDecision {
  return addition?.action === "add"
    && omission.category === addition.category
    && omission.entityId === addition.entityId
    && omission.rationale === addition.rationale
    && omission.evidenceIds.length === addition.evidenceIds.length
    && omission.evidenceIds.every((value, index) => value === addition.evidenceIds[index]);
}

function skillRows(
  decisions: readonly SkillDecision[],
  baselineSkills: ReadonlyMap<string, BaselineSkill>,
): ResumeDiffRow[] {
  const rows: ResumeDiffRow[] = [];
  for (let index = 0; index < decisions.length; index++) {
    const decision = decisions[index]!;
    const key = `${decision.category}\u0000${decision.skill}`;
    if (decision.action === "add") {
      rows.push(row(decision.id, "skill", null, decision.skill));
      continue;
    }

    const baselineSkill = baselineSkills.get(key);
    if (!baselineSkill) throw new Error(`resume diff references unknown baseline skill ${decision.category}: ${decision.skill}`);
    const addition = decisions[index + 1];
    if (decision.action === "omit" && isSkillReplacement(decision, addition)) {
      rows.push(row(baselineSkill.id, "skill", decision.skill, addition.skill));
      index += 1;
      continue;
    }
    rows.push(row(baselineSkill.id, "skill", decision.skill, decision.action === "omit" ? null : decision.skill));
  }
  return rows;
}

export function buildResumeDiff(baselineSource: string, plan: TailoringPlan): ResumeDiff {
  const baseline = parseBaselineResume(baselineSource);
  const baselineBullets = new Map(baseline.bullets.map((bullet) => [bullet.id, bullet]));
  const decisionsByEntity = new Map<string, TailoringDecision[]>();
  for (const decision of plan.decisions) {
    const decisions = decisionsByEntity.get(decision.entityId);
    if (decisions) decisions.push(decision);
    else decisionsByEntity.set(decision.entityId, [decision]);
  }

  const entitySections = (["experience", "projects", "competitions-other"] as const).map((section) => ({
    id: section,
    label: SECTION_LABELS[section],
    groups: baseline.entities
      .filter((entity) => entity.section === section)
      .map((entity) => ({
        id: entity.id,
        label: entity.entityId,
        rows: (decisionsByEntity.get(entity.entityId) ?? [])
          .map((decision) => bulletRow(decision, baselineBullets)),
      })),
  }));

  const baselineSkills = new Map(baseline.skills.map((skill) => [`${skill.category}\u0000${skill.skill}`, skill]));
  const skillDecisionsByCategory = new Map<string, SkillDecision[]>();
  for (const decision of plan.skillDecisions) {
    const decisions = skillDecisionsByCategory.get(decision.category);
    if (decisions) decisions.push(decision);
    else skillDecisionsByCategory.set(decision.category, [decision]);
  }
  const skillCategories = [...new Set([
    ...baseline.skills.map((skill) => skill.category),
    ...plan.skillDecisions.map((decision) => decision.category),
  ])];
  const skillSection = {
    id: "technical-skills" as const,
    label: SECTION_LABELS["technical-skills"],
    groups: skillCategories.map((category, index) => ({
      id: `skill-group:${index}`,
      label: category,
      rows: skillRows(skillDecisionsByCategory.get(category) ?? [], baselineSkills),
    })),
  };

  return ResumeDiffSchema.parse({
    schemaVersion: 1,
    baselineSha256: baseline.sha256,
    planId: plan.id,
    sections: [...entitySections, skillSection],
  });
}

export function assertResumeDiffMatchesTailoredSource(diffValue: ResumeDiff, tailoredSource: string): void {
  const diff = ResumeDiffSchema.parse(diffValue);
  const tailored = parseBaselineResume(tailoredSource);
  let matches = true;

  for (const section of diff.sections) {
    if (section.id === "technical-skills") continue;
    const expectedGroups = section.groups
      .map((group) => ({
        label: group.label,
        lines: group.rows.flatMap((item) => item.after === null ? [] : [item.after]),
      }))
      .filter((group) => group.lines.length > 0);
    const actualGroups = tailored.entities
      .filter((entity) => entity.section === section.id)
      .map((entity) => ({ label: entity.entityId, lines: entity.bullets.map((bullet) => bullet.text) }));
    if (expectedGroups.length !== actualGroups.length) {
      matches = false;
      break;
    }
    for (const expected of expectedGroups) {
      const actual = actualGroups.find((group) => group.label === expected.label);
      if (
        !actual
        || actual.lines.length !== expected.lines.length
        || expected.lines.some((line, index) => line !== actual.lines[index])
      ) {
        matches = false;
        break;
      }
    }
    if (!matches) break;
  }

  if (matches) {
    const skillSection = diff.sections.find((section) => section.id === "technical-skills");
    const expectedGroups = (skillSection?.groups ?? [])
      .map((group) => ({
        label: group.label,
        lines: group.rows.flatMap((item) => item.after === null ? [] : [item.after]),
      }))
      .filter((group) => group.lines.length > 0);
    const actualCategories = [...new Set(tailored.skills.map((skill) => skill.category))];
    const actualGroups = actualCategories.map((category) => ({
      label: category,
      lines: tailored.skills.filter((skill) => skill.category === category).map((skill) => skill.skill),
    }));
    matches = expectedGroups.length === actualGroups.length
      && expectedGroups.every((expected) => {
        const actual = actualGroups.find((group) => group.label === expected.label);
        return actual !== undefined
          && actual.lines.length === expected.lines.length
          && expected.lines.every((line, index) => line === actual.lines[index]);
      });
  }

  if (!matches) throw new Error("tailored resume content does not match the published resume diff");
}
