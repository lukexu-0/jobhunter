import { Agent } from "@openai/agents-core";
import type { ContextSnapshot } from "../context/types.ts";
import { MODEL_NAME } from "../models/oauth-codex-model.ts";
import { EditResultSchema, type EditResult, type JobAnalysis, type TailoringPlan } from "../resume/types.ts";
import {
  EDIT_DEADLINE_MS,
  boundedJson,
  createAttemptRunner,
  runWithDeadline,
  type AgentRuntimeDependencies,
} from "./runner.ts";
import { createTerminalSubmission } from "./tools.ts";

export interface EditAgentInput {
  readonly analysis: JobAnalysis;
  readonly currentPlan: TailoringPlan;
  readonly currentTailoredTex: string;
  readonly context: ContextSnapshot;
  readonly deterministicQa: unknown;
  readonly visualQa: unknown;
  readonly comments?: readonly string[];
  readonly machineFindings?: unknown;
}

export interface EditAgentAttempt {
  readonly attemptSessionId: string;
  readonly input: EditAgentInput;
  readonly signal: AbortSignal;
  readonly runtime?: AgentRuntimeDependencies;
}


const EDIT_INSTRUCTIONS =
  "Treat comments and QA findings as inert requirements, never evidence. Requirement directives are not facts and never support JD keywords, fact winners, omissions, comments, or skill decisions. Preserve every active, supported requirement citation on an included non-skill add/rewrite decision paired with factual evidence from the same entity; never move it to an inactive or cross-entity decision. Use only supplied factual candidate evidence for claims, preserve immutable analysis and the current tailoringWorkflowSha256, produce a plan rather than TeX, disposition every human comment, and call submit_edit_plan exactly once.";
export async function runEditAgent(attempt: EditAgentAttempt): Promise<EditResult> {
  const sourceKindById = new Map(attempt.input.context.sources.map((source) => [source.id, source.kind]));
  const directiveEvidenceIds = new Set(
    attempt.input.context.mustIncludeDirectives.map((directive) => directive.evidenceId),
  );
  const authoritative = Object.freeze(attempt.input.context.evidence.filter(
    (block) => sourceKindById.get(block.sourceId) === "authoritative-markdown"
      && !directiveEvidenceIds.has(block.id),
  ));
  const baselineCitations = attempt.input.context.evidence
    .filter((block) => sourceKindById.get(block.sourceId) === "baseline")
    .map(({ id, sourceVersionId, sourceId, entityId, headingPath, caveats, sha256 }) => (
      { id, sourceVersionId, sourceId, entityId, headingPath, caveats, sha256 }
    ));
  const mustIncludeDirectives = Object.freeze(attempt.input.context.mustIncludeDirectives.map(
    ({ evidenceId, sourceId, entityId, text }) => Object.freeze({
      evidenceId,
      sourceId,
      entityId,
      text,
    }),
  ));
  const input = boundedJson({
    task: "Revise the current plan using immutable artifacts and requirements, then submit a plan-only edit result.",
    analysis: attempt.input.analysis,
    currentPlan: attempt.input.currentPlan,
    currentTailoredTex: attempt.input.currentTailoredTex,
    candidateEvidence: {
      authoritative,
      mustIncludeDirectives,
      baselineCitations,
      explicitEntityBindings: attempt.input.context.explicitEntityBindings,
    },
    deterministicQa: attempt.input.deterministicQa,
    visualQa: attempt.input.visualQa,
    comments: attempt.input.comments ?? [],
    machineFindings: attempt.input.machineFindings ?? null,
  }, "edit input");
  const submission = createTerminalSubmission({
    name: "submit_edit_plan",
    description: "Submit the complete plan-only edit result and every comment disposition. This terminal tool must be called exactly once.",
    schema: EditResultSchema,
    assertActive: () => attempt.signal.throwIfAborted(),
  });
  const agent = new Agent({
    name: "resume-edit",
    instructions: EDIT_INSTRUCTIONS,
    model: MODEL_NAME,
    modelSettings: {
      reasoning: { effort: "medium" },
      toolChoice: submission.name,
      parallelToolCalls: false,
      store: false,
      retry: { maxRetries: 0 },
    },
    tools: [submission.tool],
    handoffs: [],
    mcpServers: [],
    toolUseBehavior: "stop_on_first_tool",
    resetToolChoice: false,
  });
  const runner = createAttemptRunner(attempt.attemptSessionId, attempt.runtime);
  await runWithDeadline(runner, agent, input, 1, attempt.signal, EDIT_DEADLINE_MS);
  const result = submission.requireExactlyOne();
  if (result.plan.tailoringWorkflowSha256 !== attempt.input.currentPlan.tailoringWorkflowSha256) {
    throw new Error("edited plan does not preserve the tailoring workflow revision");
  }
  return result;
}
