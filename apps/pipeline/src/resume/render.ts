import type { ContextSnapshot, EvidenceBlock } from "../context/types.ts";
import { parseBaselineResume, type BaselineEntity, type ParsedBaselineResume } from "./parser.ts";
import { TailoringPlanSchema, type ResumeSection, type TailoringDecision, type TailoringPlan } from "./types.ts";

export class ResumeValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ResumeValidationError"; }
}

export function plainTextToTex(input: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input)) throw new ResumeValidationError("plain text contains control characters");
  const escaped: Record<string, string> = {
    "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "$": "\\$", "&": "\\&", "#": "\\#",
    "%": "\\%", "_": "\\_", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
  };
  return input.normalize("NFC").replace(/[\\{}$&#%_~^]/g, (character) => escaped[character]!).replace(/\s+/g, " ").trim();
}

function equivalentEntities(left: string, right: string, snapshot: ContextSnapshot): boolean {
  if (left === right) return true;
  const graph = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    (graph.get(a) ?? (graph.set(a, new Set()), graph.get(a)!)).add(b);
    (graph.get(b) ?? (graph.set(b, new Set()), graph.get(b)!)).add(a);
  };
  for (const [a, b] of Object.entries(snapshot.explicitEntityBindings)) connect(a, b);
  for (const source of snapshot.sources) for (const baseline of source.baselineEntityIds) connect(source.entityId, baseline);
  const pending = [left];
  const seen = new Set<string>();
  while (pending.length) {
    const value = pending.pop()!;
    if (value === right) return true;
    if (seen.has(value)) continue;
    seen.add(value);
    pending.push(...(graph.get(value) ?? []));
  }
  return false;
}

function requireSampleProjectBinding(snapshot: ContextSnapshot): void {
  const sampleProject = "Sample Project";
  const matcher = "SampleProject";
  const explicitlyBound = snapshot.explicitEntityBindings[sampleProject] === matcher || snapshot.explicitEntityBindings[matcher] === sampleProject;
  if (!explicitlyBound) throw new ResumeValidationError("missing explicit Sample Project ↔ SampleProject binding");
}

function evidenceFor(ids: readonly string[], entityId: string, evidence: ReadonlyMap<string, EvidenceBlock>, snapshot: ContextSnapshot): readonly EvidenceBlock[] {
  return ids.map((id) => {
    const block = evidence.get(id);
    if (!block) throw new ResumeValidationError(`unknown evidence ID ${id}`);
    const source = snapshot.sources.find((candidate) => candidate.id === block.sourceId);
    if (source?.kind !== "baseline" && !equivalentEntities(entityId, block.entityId, snapshot)) throw new ResumeValidationError(`evidence ${id} is attributed to ${block.entityId}, not ${entityId}`);
    return block;
  });
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new ResumeValidationError(`duplicate ${label}`);
}

function validateSnapshot(snapshot: ContextSnapshot): void {
  assertUnique(snapshot.sources.map((source) => source.id), "context source ID");
  assertUnique(snapshot.sources.map((source) => source.sourceVersionId), "context source version");
  assertUnique(snapshot.evidence.map((block) => block.id), "evidence ID");
  const sourceHashes = Object.keys(snapshot.sourceHashes);
  if (sourceHashes.length !== snapshot.sources.length) throw new ResumeValidationError("context snapshot source hash set is incomplete");
  const sources = new Map(snapshot.sources.map((source) => [source.id, source]));
  for (const source of snapshot.sources) {
    if (snapshot.sourceHashes[source.id] !== source.sha256) throw new ResumeValidationError(`context source hash mismatch for ${source.id}`);
  }
  for (const block of snapshot.evidence) {
    const source = sources.get(block.sourceId);
    if (!source || source.sourceVersionId !== block.sourceVersionId) throw new ResumeValidationError(`evidence ${block.id} has invalid source provenance`);
  }
}

function validatePlan(planInput: TailoringPlan, baseline: ParsedBaselineResume, snapshot: ContextSnapshot): TailoringPlan {
  const parsed = TailoringPlanSchema.safeParse(planInput);
  if (!parsed.success) throw new ResumeValidationError(`invalid tailoring plan: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  const plan = parsed.data;
  if (snapshot.baselineSha256 !== baseline.sha256) throw new ResumeValidationError("baseline hash does not match immutable context snapshot");
  validateSnapshot(snapshot);
  requireSampleProjectBinding(snapshot);
  assertUnique(plan.decisions.map((decision) => decision.id), "decision ID");
  assertUnique(plan.factWinners.map((winner) => winner.factKey), "fact winner");
  const evidence = new Map(snapshot.evidence.map((block) => [block.id, block]));
  const bullets = new Map(baseline.bullets.map((bullet) => [bullet.id, bullet]));
  const entities = new Map(baseline.entities.map((entity) => [entity.entityId, entity]));
  const covered = new Map<string, TailoringDecision>();
  for (const decision of plan.decisions) {
    const entity = entities.get(decision.entityId);
    if (!entity || entity.section !== decision.section) throw new ResumeValidationError(`unknown or mismatched entity ${decision.entityId}`);
    evidenceFor(decision.evidenceIds, decision.entityId, evidence, snapshot);
    if (decision.baselineItemId !== null) {
      const bullet = bullets.get(decision.baselineItemId);
      if (!bullet || bullet.entityId !== decision.entityId || bullet.section !== decision.section) throw new ResumeValidationError(`decision ${decision.id} targets an unsupported baseline item`);
      if (covered.has(bullet.id)) throw new ResumeValidationError(`baseline item ${bullet.id} has multiple decisions`);
      covered.set(bullet.id, decision);
      if (decision.action === "retain" && decision.text !== bullet.text) throw new ResumeValidationError(`retain decision ${decision.id} changed baseline text`);
    }
  }
  for (const bullet of baseline.bullets) if (!covered.has(bullet.id)) throw new ResumeValidationError(`plan does not cover baseline item ${bullet.id}`);

  const winners = new Map(plan.factWinners.map((winner) => [winner.factKey, winner]));
  for (const winner of plan.factWinners) {
    const block = evidenceFor([winner.evidenceId], winner.entityId, evidence, snapshot)[0]!;
    if (!block.text.toLocaleLowerCase().includes(winner.value.toLocaleLowerCase())) throw new ResumeValidationError(`fact winner ${winner.factKey} is not supported verbatim by its evidence`);
  }
  for (const decision of plan.decisions) for (const factKey of decision.factKeys) {
    const winner = winners.get(factKey);
    if (!winner) throw new ResumeValidationError(`decision ${decision.id} references missing fact winner ${factKey}`);
    if (!equivalentEntities(decision.entityId, winner.entityId, snapshot)) throw new ResumeValidationError(`fact winner ${factKey} belongs to another entity`);
    if (!decision.evidenceIds.includes(winner.evidenceId)) throw new ResumeValidationError(`decision ${decision.id} omits winning evidence ${winner.evidenceId}`);
  }

  const omitted = new Map(plan.omissions.map((item) => [item.baselineItemId, item]));
  assertUnique(plan.omissions.map((item) => item.baselineItemId), "omission");
  for (const decision of plan.decisions) {
    const record = decision.baselineItemId === null ? undefined : omitted.get(decision.baselineItemId);
    if ((decision.action === "omit") !== Boolean(record)) throw new ResumeValidationError(`omission ledger mismatch for ${decision.id}`);
    if (record) evidenceFor(record.evidenceIds, decision.entityId, evidence, snapshot);
  }
  const overrides = new Map(plan.baselineOverrides.map((override) => [override.baselineItemId, override]));
  assertUnique(plan.baselineOverrides.map((item) => item.baselineItemId), "baseline override");
  for (const [itemId, override] of overrides) {
    const decision = covered.get(itemId);
    if (!decision || decision.action !== "rewrite" || decision.text !== override.replacement) throw new ResumeValidationError(`baseline override ${itemId} does not match a rewrite decision`);
    evidenceFor(override.evidenceIds, decision.entityId, evidence, snapshot);
  }
  for (const decision of plan.decisions) if ((decision.action === "rewrite") !== overrides.has(decision.baselineItemId ?? "")) throw new ResumeValidationError(`rewrite override mismatch for ${decision.id}`);

  assertUnique(plan.projectOrder, "project order entity");
  const includedProjects = baseline.entities.filter((entity) => entity.section === "projects" && plan.decisions.some((decision) => decision.entityId === entity.entityId && decision.action !== "omit"));
  if (plan.projectOrder.length !== includedProjects.length || plan.projectOrder.some((id) => !includedProjects.some((entity) => entity.entityId === id))) throw new ResumeValidationError("project order must contain every and only included project exactly once");

  const baselineSkills = new Map(baseline.skills.map((skill) => [`${skill.category}\u0000${skill.skill}`, skill]));
  const skillCoverage = new Map<string, number>();
  assertUnique(plan.skillDecisions.map((decision) => decision.id), "skill decision ID");
  assertUnique(plan.skillDecisions.map((decision) => `${decision.category}\u0000${decision.skill}`), "skill selection");
  for (const decision of plan.skillDecisions) {
    const key = `${decision.category}\u0000${decision.skill}`;
    const existing = baselineSkills.has(key);
    if (decision.action === "add" && existing) throw new ResumeValidationError(`skill ${decision.skill} already exists and cannot be added`);
    if (decision.action !== "add" && !existing) throw new ResumeValidationError(`unknown baseline skill ${decision.skill}`);
    skillCoverage.set(key, (skillCoverage.get(key) ?? 0) + 1);
    evidenceFor(decision.evidenceIds, decision.entityId, evidence, snapshot);
  }
  for (const key of baselineSkills.keys()) if (skillCoverage.get(key) !== 1) throw new ResumeValidationError(`plan does not cover baseline skill ${key.replace("\u0000", ": ")}`);
  return plan;
}

function decisionsByEntity(plan: TailoringPlan, section: BaselineEntity["section"]): Map<string, TailoringDecision[]> {
  const result = new Map<string, TailoringDecision[]>();
  for (const decision of plan.decisions) if (decision.section === section) (result.get(decision.entityId) ?? (result.set(decision.entityId, []), result.get(decision.entityId)!)).push(decision);
  return result;
}

function renderEntity(entity: BaselineEntity, decisions: readonly TailoringDecision[]): string {
  const macro = entity.section === "projects" ? "resumeProjectHeading" : "resumeSubheading";
  const heading = `    \\${macro}\n${entity.headingArguments.map((argument) => `      {${argument}}`).join("\n")}`;
  const bullets = decisions.filter((decision) => decision.action !== "omit").map((decision) => `        \\resumeItem{${plainTextToTex(decision.text!)}}`).join("\n");
  return `${heading}\n      \\resumeItemListStart\n${bullets}\n      \\resumeItemListEnd`;
}

function renderEntitySection(section: BaselineEntity["section"], parsed: ParsedBaselineResume, plan: TailoringPlan): string {
  const grouped = decisionsByEntity(plan, section);
  const entities = section === "projects"
    ? plan.projectOrder.map((entityId) => parsed.entities.find((entity) => entity.section === section && entity.entityId === entityId)!)
    : parsed.entities.filter((entity) => entity.section === section);
  const rendered = entities.filter((entity) => (grouped.get(entity.entityId) ?? []).some((decision) => decision.action !== "omit"))
    .map((entity) => renderEntity(entity, grouped.get(entity.entityId) ?? []));
  return `\n  \\resumeSubHeadingListStart\n\n${rendered.join("\n\n")}\n\n  \\resumeSubHeadingListEnd\n\n`;
}

function renderSkills(parsed: ParsedBaselineResume, plan: TailoringPlan): string {
  const categories = [...new Set([...parsed.skills.map((skill) => skill.category), ...plan.skillDecisions.map((decision) => decision.category)])];
  const rows = categories.map((category) => {
    const skills = plan.skillDecisions.filter((decision) => decision.category === category && decision.action !== "omit").map((decision) => plainTextToTex(decision.skill));
    return skills.length ? `     \\textbf{${plainTextToTex(category)}}{: ${skills.join(", ")}} \\\\` : null;
  }).filter((row): row is string => row !== null);
  if (rows.length) rows[rows.length - 1] = rows[rows.length - 1]!.replace(/ \\\\$/, "");
  return `\n \\begin{itemize}[leftmargin=0.15in, label={}]\n    \\small{\\item{\n${rows.join("\n")}\n    }}\n \\end{itemize}\n\n\n%-------------------------------------------\n`;
}

export function renderTailoredResume(planInput: TailoringPlan, baselineSource: string, snapshot: ContextSnapshot): string {
  const parsed = parseBaselineResume(baselineSource);
  const plan = validatePlan(planInput, parsed, snapshot);
  const replacements = new Map<ResumeSection, string>([
    ["experience", renderEntitySection("experience", parsed, plan)],
    ["projects", renderEntitySection("projects", parsed, plan)],
    ["competitions-other", renderEntitySection("competitions-other", parsed, plan)],
    ["technical-skills", renderSkills(parsed, plan)],
  ]);
  const regions = Object.values(parsed.regions).sort((a, b) => a.bodyStart - b.bodyStart);
  let output = "";
  let cursor = 0;
  for (const region of regions) { output += baselineSource.slice(cursor, region.bodyStart) + replacements.get(region.section)!; cursor = region.bodyEnd; }
  return output + baselineSource.slice(cursor);
}
