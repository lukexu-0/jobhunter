import { createHash } from "node:crypto";
import { Agent, tool } from "@openai/agents-core";
import { z } from "zod";
import { MODEL_NAME } from "../models/oauth-codex-model.ts";
import { hashJobAnalysis } from "../resume/ledger.ts";
import { parseBaselineResume } from "../resume/parser.ts";
import { ResumeValidationError } from "../resume/render.ts";
import {
  JobAnalysisSchema,
  TailoringPlanSchema,
  TailoringResultSchema,
  type JobAnalysis,
  type SkillDecision,
  type TailoringPlan,
  type TailoringResult,
} from "../resume/types.ts";
import {
  TAILORING_DEADLINE_MS,
  boundedJson,
  createAttemptRunner,
  runWithDeadline,
  type AgentRuntimeDependencies,
} from "./runner.ts";
import {
  createSequentialToolBudget,
  createTerminalSubmission,
  DEFAULT_TOOL_TIMEOUT_MS,
} from "./tools.ts";

export const MAX_TAILORING_TOOL_CALLS = 3;
export const MAX_TAILORING_TOOL_BYTES = 3 * 1024 * 1024;

export const TAILORING_TASK =
  "Apply the supplied exact edits and any required one-page correction to the canonical LaTeX.";
export const TAILORING_INSTRUCTIONS =
  "Mechanically apply analysis.exactEdits to matching baseline items. Retain all other content unless input.onePageCorrection requires bounded lower-priority omissions; then make those cuts while preserving truthfulness and readability. Call read_working_tex, apply_analysis_edits, read_working_tex, then submit_tailoring_result.";
export const TAILORING_WORKFLOW_SHA256 = createHash("sha256")
  .update(`${TAILORING_TASK}\n${TAILORING_INSTRUCTIONS}`)
  .digest("hex");

const EmptySchema = z.object({}).strict();

function stablePlanId(kind: string, ...parts: string[]): string {
  return `${kind}:${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 20)}`;
}

export interface OnePageCorrectionCandidate {
  readonly baselineItemId: string;
  readonly section: "experience" | "projects" | "competitions-other";
  readonly entityId: string;
  readonly text: string;
  readonly evidenceIds: readonly string[];
}

export interface OnePageCorrection {
  readonly note: string;
  readonly failureCount: number;
  readonly requiredOmissionCount: number;
  readonly candidates: readonly OnePageCorrectionCandidate[];
}

export function buildMechanicalTailoringPlan(
  analysisInput: JobAnalysis,
  baselineSource: string,
  onePageCorrection?: OnePageCorrection,
  mustIncludeEvidenceIds: readonly string[] = [],
): TailoringPlan {
  const analysis = JobAnalysisSchema.parse(analysisInput);
  const baseline = parseBaselineResume(baselineSource);
  if (analysis.baselineSha256 !== baseline.sha256) throw new ResumeValidationError("job analysis baseline hash does not match the source");
  const mustIncludeEvidenceIdSet = new Set(mustIncludeEvidenceIds);
  if (onePageCorrection) {
    if (!onePageCorrection.note.trim() || Buffer.byteLength(onePageCorrection.note) > 512) {
      throw new ResumeValidationError("one-page correction note must contain at most 512 bytes");
    }
    if (!Number.isSafeInteger(onePageCorrection.failureCount) || onePageCorrection.failureCount < 1) {
      throw new ResumeValidationError("one-page correction failure count is invalid");
    }
    if (!Number.isSafeInteger(onePageCorrection.requiredOmissionCount)
      || onePageCorrection.requiredOmissionCount < 1
      || onePageCorrection.requiredOmissionCount > onePageCorrection.candidates.length) {
      throw new ResumeValidationError("one-page correction omission count is invalid");
    }
  }

  const editsByTarget = new Map(analysis.exactEdits.map((edit) => [edit.baselineItemId, edit]));
  const bulletsById = new Map(baseline.bullets.map((bullet) => [bullet.id, bullet]));
  const omissionCandidates = new Map<string, OnePageCorrectionCandidate>();
  for (const candidate of onePageCorrection?.candidates ?? []) {
    const bullet = bulletsById.get(candidate.baselineItemId);
    if (!bullet
      || bullet.section !== candidate.section
      || bullet.entityId !== candidate.entityId
      || bullet.text !== candidate.text
      || candidate.evidenceIds.length === 0
      || candidate.evidenceIds.some((evidenceId) => mustIncludeEvidenceIdSet.has(evidenceId))) {
      throw new ResumeValidationError(`invalid one-page omission candidate ${candidate.baselineItemId}`);
    }
    if (omissionCandidates.has(candidate.baselineItemId)) {
      throw new ResumeValidationError(`duplicate one-page omission candidate ${candidate.baselineItemId}`);
    }
    omissionCandidates.set(candidate.baselineItemId, candidate);
  }
  const selectedOmissions = new Map<string, OnePageCorrectionCandidate>(
    (onePageCorrection?.candidates.slice(0, onePageCorrection.requiredOmissionCount) ?? [])
      .map((candidate) => [candidate.baselineItemId, candidate] as const),
  );
  const baselineItemIds = new Set([...baseline.bullets.map((bullet) => bullet.id), ...baseline.skills.map((skill) => skill.id)]);
  for (const edit of analysis.exactEdits) {
    if (!baselineItemIds.has(edit.baselineItemId)) throw new ResumeValidationError(`exact edit ${edit.id} targets an unknown baseline item`);
  }

  const existingSkills = new Set(baseline.skills.map((skill) => `${skill.category}\u0000${skill.skill}`));
  const replacementSkills = new Set<string>();
  for (const skill of baseline.skills) {
    const edit = editsByTarget.get(skill.id);
    if (!edit) continue;
    if (edit.kind !== "skill" || edit.category !== skill.category) throw new ResumeValidationError(`exact edit ${edit.id} does not match baseline skill ${skill.id}`);
    if (edit.before !== skill.skill) throw new ResumeValidationError(`exact edit ${edit.id} has stale before text`);
    const replacementKey = `${edit.category}\u0000${edit.after}`;
    if (existingSkills.has(replacementKey)) throw new ResumeValidationError(`replacement skill ${edit.after} already exists`);
    if (replacementSkills.has(replacementKey)) throw new ResumeValidationError(`duplicate replacement skill ${edit.after}`);
    replacementSkills.add(replacementKey);
  }

  const analysisSha256 = hashJobAnalysis(analysis);
  const decisions = baseline.bullets.map((bullet) => {
    const edit = editsByTarget.get(bullet.id);
    const omission = selectedOmissions.get(bullet.id);
    if (omission) {
      return {
        id: stablePlanId("decision", bullet.id, "omit", String(onePageCorrection!.failureCount)),
        section: bullet.section,
        entityId: bullet.entityId,
        baselineItemId: bullet.id,
        action: "omit" as const,
        text: null,
        evidenceIds: omission.evidenceIds,
        factKeys: [],
        rationale: "Lower-priority content omitted to enforce the one-page resume requirement.",
      };
    }
    if (!edit) {
      return {
        id: stablePlanId("decision", bullet.id, "retain"),
        section: bullet.section,
        entityId: bullet.entityId,
        baselineItemId: bullet.id,
        action: "retain" as const,
        text: bullet.text,
        evidenceIds: [],
        factKeys: [],
        rationale: "Retain unmentioned baseline bullet.",
      };
    }
    if (edit.kind !== "bullet" || edit.section !== bullet.section || edit.entityId !== bullet.entityId) {
      throw new ResumeValidationError(`exact edit ${edit.id} does not match baseline bullet ${bullet.id}`);
    }
    if (edit.before !== bullet.text) throw new ResumeValidationError(`exact edit ${edit.id} has stale before text`);
    return {
      id: stablePlanId("decision", bullet.id, "rewrite", edit.id),
      section: bullet.section,
      entityId: bullet.entityId,
      baselineItemId: bullet.id,
      action: "rewrite" as const,
      text: edit.after,
      evidenceIds: edit.evidenceIds,
      factKeys: [],
      rationale: `Apply exact analysis edit ${edit.id}.`,
    };
  });

  const baselineOverrides = baseline.bullets.flatMap((bullet) => {
    if (selectedOmissions.has(bullet.id)) return [];
    const edit = editsByTarget.get(bullet.id);
    if (!edit || edit.kind !== "bullet") return [];
    return [{
      baselineItemId: bullet.id,
      replacement: edit.after,
      evidenceIds: edit.evidenceIds,
      rationale: `Apply exact analysis edit ${edit.id}.`,
    }];
  });

  const skillDecisions = baseline.skills.flatMap<SkillDecision>((skill) => {
    const edit = editsByTarget.get(skill.id);
    if (!edit) {
      return [{
        id: stablePlanId("skill", skill.id, "retain"),
        entityId: null,
        category: skill.category,
        skill: skill.skill,
        action: "retain" as const,
        evidenceIds: [],
        rationale: "Retain unmentioned baseline skill.",
      }];
    }
    if (edit.kind !== "skill") throw new ResumeValidationError(`exact edit ${edit.id} does not match baseline skill ${skill.id}`);
    const rationale = `Replace baseline skill via exact analysis edit ${edit.id}.`;
    const skillEvidenceIds = edit.evidenceIds.filter((evidenceId) =>
      !mustIncludeEvidenceIdSet.has(evidenceId));
    return [
      {
        id: stablePlanId("skill", skill.id, "omit", edit.id),
        entityId: edit.evidenceEntityId,
        category: skill.category,
        skill: edit.before,
        action: "omit" as const,
        evidenceIds: skillEvidenceIds,
        rationale,
      },
      {
        id: stablePlanId("skill", skill.id, "add", edit.id),
        entityId: edit.evidenceEntityId,
        category: skill.category,
        skill: edit.after,
        action: "add" as const,
        evidenceIds: skillEvidenceIds,
        rationale,
      },
    ];
  });

  return TailoringPlanSchema.parse({
    id: stablePlanId(
      "plan",
      analysis.id,
      analysisSha256,
      TAILORING_WORKFLOW_SHA256,
      ...selectedOmissions.keys(),
    ),
    analysisId: analysis.id,
    analysisSha256,
    tailoringWorkflowSha256: TAILORING_WORKFLOW_SHA256,
    decisions,
    projectOrder: baseline.entities
      .filter((entity) => entity.section === "projects"
        && entity.bullets.some((bullet) => !selectedOmissions.has(bullet.id)))
      .map((entity) => entity.entityId),
    skillDecisions,
    factWinners: [],
    baselineOverrides,
    omissions: [...selectedOmissions.values()].map((candidate) => ({
      baselineItemId: candidate.baselineItemId,
      rationale: "Lower-priority content omitted to enforce the one-page resume requirement.",
      evidenceIds: candidate.evidenceIds,
    })),
  });
}

export interface TailoringAgentOperations {
  readonly renderPlan: (plan: TailoringPlan, signal: AbortSignal) => string | Promise<string>;
}

export interface TailoringAgentInput {
  readonly analysis: JobAnalysis;
  readonly baseline: string;
  readonly operations: TailoringAgentOperations;
  readonly onePageCorrection?: OnePageCorrection;
  readonly mustIncludeEvidenceIds?: readonly string[];
}

export interface TailoringAgentAttempt {
  readonly attemptSessionId: string;
  readonly input: TailoringAgentInput;
  readonly signal: AbortSignal;
  readonly runtime?: AgentRuntimeDependencies;
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

export async function runTailoringAgent(attempt: TailoringAgentAttempt): Promise<TailoringResult> {
  if (Buffer.byteLength(attempt.input.baseline) > 256 * 1024) throw new Error("baseline exceeds 256 KiB");
  const analysisSha256 = hashJobAnalysis(attempt.input.analysis);
  const input = boundedJson({
    task: TAILORING_TASK,
    analysis: attempt.input.analysis,
    analysisSha256,
    tailoringWorkflowSha256: TAILORING_WORKFLOW_SHA256,
    ...(attempt.input.onePageCorrection
      ? { onePageCorrection: attempt.input.onePageCorrection }
      : {}),
  }, "tailoring input");

  const sharedSubmitted = { value: false };
  const budget = createSequentialToolBudget({
    sharedSubmitted,
    maxCalls: MAX_TAILORING_TOOL_CALLS,
    maxBytes: MAX_TAILORING_TOOL_BYTES,
    perToolCalls: { read_working_tex: 2, apply_analysis_edits: 1 },
    label: "tailoring",
  });
  let workingTex = attempt.input.baseline;
  let applied: { readonly plan: TailoringPlan; readonly preview: string } | undefined;
  let baselineRead = false;
  let appliedRead = false;

  const readWorkingTex = tool({
    name: "read_working_tex",
    description: "Read the current LaTeX.",
    parameters: EmptySchema,
    strict: true,
    errorFunction: null,
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    timeoutBehavior: "raise_exception",
    execute: (): string => {
      budget.begin("read_working_tex", {});
      assertActive(attempt.signal);
      if (applied) appliedRead = true;
      else baselineRead = true;
      budget.finish(workingTex);
      return workingTex;
    },
  });

  const applyAnalysisEdits = tool({
    name: "apply_analysis_edits",
    description: "Apply analysis.exactEdits and any required one-page omissions to the working copy.",
    parameters: EmptySchema,
    strict: true,
    errorFunction: (_context, error): string => {
      const message = error instanceof Error ? error.message : "unknown validation error";
      return `Analysis edits rejected: ${message}.`;
    },
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    timeoutBehavior: "raise_exception",
    execute: async (): Promise<{ ok: true; bytes: number; sha256: string }> => {
      budget.begin("apply_analysis_edits", {});
      if (!baselineRead) throw new Error("apply_analysis_edits requires reading the baseline working copy first");
      assertActive(attempt.signal);
      const plan = buildMechanicalTailoringPlan(
        attempt.input.analysis,
        attempt.input.baseline,
        attempt.input.onePageCorrection,
        attempt.input.mustIncludeEvidenceIds,
      );
      const toolSignal = AbortSignal.any([attempt.signal, AbortSignal.timeout(DEFAULT_TOOL_TIMEOUT_MS)]);
      const preview = await attempt.input.operations.renderPlan(plan, toolSignal);
      assertActive(toolSignal);
      if (Buffer.byteLength(preview) > 256 * 1024) throw new Error("tailored TeX exceeds 256 KiB");
      workingTex = preview;
      applied = { plan, preview };
      appliedRead = false;
      const result = {
        ok: true as const,
        bytes: Buffer.byteLength(preview),
        sha256: createHash("sha256").update(preview).digest("hex"),
      };
      budget.finish(result);
      return result;
    },
  });

  const submission = createTerminalSubmission({
    name: "submit_tailoring_result",
    description: "Submit the inspected mechanical result.",
    schema: EmptySchema,
    sharedSubmitted,
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    assertActive: () => assertActive(attempt.signal),
    validate: () => {
      if (!applied) throw new Error("submit_tailoring_result requires applied analysis edits");
      if (!appliedRead) throw new Error("submit_tailoring_result requires reading the applied working copy");
    },
  });

  const agent = new Agent({
    name: "resume-tailoring",
    instructions: TAILORING_INSTRUCTIONS,
    model: MODEL_NAME,
    modelSettings: {
      reasoning: { effort: "high" },
      parallelToolCalls: false,
      store: false,
      retry: { maxRetries: 0 },
    },
    tools: [readWorkingTex, applyAnalysisEdits, submission.tool],
    handoffs: [],
    mcpServers: [],
    toolUseBehavior: { stopAtToolNames: [submission.name] },
    resetToolChoice: false,
  });
  const runner = createAttemptRunner(attempt.attemptSessionId, attempt.runtime);
  await runWithDeadline(runner, agent, input, 5, attempt.signal, TAILORING_DEADLINE_MS);
  submission.requireExactlyOne();
  if (!applied) throw new Error("tailoring agent completed without applied analysis edits");
  return TailoringResultSchema.parse({
    plan: applied.plan,
    toolCount: budget.totalCalls() + submission.count(),
  });
}
