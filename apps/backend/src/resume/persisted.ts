import { createHash } from "node:crypto";
import { canonicalJson, hashJobAnalysis } from "./ledger.ts";
import { ResumeValidationError } from "./render.ts";
import { JobAnalysisSchema, TailoringPlanSchema, type JobAnalysis, type TailoringPlan } from "./types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withoutFields(value: unknown, fields: readonly string[]): unknown {
  if (!isObject(value)) return value;
  const result = { ...value };
  for (const field of fields) delete result[field];
  return result;
}

function withoutItemFields(value: unknown, fields: readonly string[]): unknown {
  return Array.isArray(value) ? value.map((item) => withoutFields(item, fields)) : value;
}

// Artifact readers only: new model submissions must use the strict canonical schemas directly.
export function parsePersistedJobAnalysis(value: unknown): { analysis: JobAnalysis; sourceSha256: string } {
  const normalized = isObject(value) ? {
    ...value,
    jdKeywords: withoutItemFields(value.jdKeywords, ["evidenceIds"]),
    exactEdits: Array.isArray(value.exactEdits) ? value.exactEdits.map((edit) => withoutFields(
      edit,
      isObject(edit) && edit.kind === "skill" ? ["evidenceIds", "evidenceEntityId"] : ["evidenceIds"],
    )) : value.exactEdits,
  } : value;
  const analysis = JobAnalysisSchema.parse(normalized);
  // Hash the original parsed artifact shape, not its bytes or its citation-free replacement.
  return { analysis, sourceSha256: createHash("sha256").update(canonicalJson(value)).digest("hex") };
}

export function parsePersistedTailoringPlan(
  value: unknown,
  storedAnalysis: { analysis: JobAnalysis; sourceSha256: string },
): TailoringPlan {
  const stripped = withoutFields(value, ["factWinners"]);
  const normalized = isObject(stripped) ? {
    ...stripped,
    decisions: withoutItemFields(stripped.decisions, ["factKeys", "evidenceIds"]),
    skillDecisions: withoutItemFields(stripped.skillDecisions, ["entityId", "evidenceIds"]),
    baselineOverrides: withoutItemFields(stripped.baselineOverrides, ["evidenceIds"]),
    omissions: withoutItemFields(stripped.omissions, ["evidenceIds"]),
  } : stripped;
  const plan = TailoringPlanSchema.parse(normalized);
  const analysisSha256 = hashJobAnalysis(storedAnalysis.analysis);
  if (plan.analysisId !== storedAnalysis.analysis.id
    || (plan.analysisSha256 !== storedAnalysis.sourceSha256 && plan.analysisSha256 !== analysisSha256)) {
    throw new ResumeValidationError("tailoring plan does not reference the immutable job analysis");
  }
  return { ...plan, analysisSha256 };
}
