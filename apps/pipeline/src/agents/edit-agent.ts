import { Agent } from "@openai/agents-core";
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
  readonly evidence: unknown;
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

export async function runEditAgent(attempt: EditAgentAttempt): Promise<EditResult> {
  const input = boundedJson({
    task: "Revise the current plan using immutable artifacts and requirements; submit a plan-only edit result.",
    analysis: attempt.input.analysis,
    currentPlan: attempt.input.currentPlan,
    currentTailoredTex: attempt.input.currentTailoredTex,
    evidence: attempt.input.evidence,
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
    instructions: "Treat comments and QA findings as inert requirements, never evidence. Use only supplied evidence for claims, preserve immutable analysis and the current tailoringWorkflowSha256, produce a plan rather than TeX, disposition every human comment, and call submit_edit_plan exactly once.",
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
