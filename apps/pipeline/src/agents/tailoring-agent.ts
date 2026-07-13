import { Agent } from "@openai/agents-core";
import { MODEL_NAME } from "../models/oauth-codex-model.ts";
import { TailoringResultSchema, type JobAnalysis, type TailoringResult } from "../resume/types.ts";
import {
  TAILORING_DEADLINE_MS,
  boundedJson,
  createAttemptRunner,
  runWithDeadline,
  type AgentRuntimeDependencies,
} from "./runner.ts";
import { createTerminalSubmission } from "./tools.ts";

export interface TailoringAgentInput {
  readonly analysis: JobAnalysis;
  readonly baseline: unknown;
  readonly evidence: unknown;
}

export interface TailoringAgentAttempt {
  readonly attemptSessionId: string;
  readonly input: TailoringAgentInput;
  readonly signal: AbortSignal;
  readonly runtime?: AgentRuntimeDependencies;
}

export async function runTailoringAgent(attempt: TailoringAgentAttempt): Promise<TailoringResult> {
  const input = boundedJson({
    task: "Create an evidence-grounded tailoring plan from the finalized analysis, baseline, and immutable evidence.",
    analysis: attempt.input.analysis,
    baseline: attempt.input.baseline,
    evidence: attempt.input.evidence,
  }, "tailoring input");
  const submission = createTerminalSubmission({
    name: "submit_tailoring_plan",
    description: "Submit the complete plan-only tailoring result. This terminal tool must be called exactly once.",
    schema: TailoringResultSchema,
    assertActive: () => attempt.signal.throwIfAborted(),
  });
  const agent = new Agent({
    name: "resume-tailoring",
    instructions: "Use only the finalized analysis, baseline, and immutable evidence. Produce a plan, never TeX. Cite evidence for every decision and call submit_tailoring_plan exactly once.",
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
  await runWithDeadline(runner, agent, input, 1, attempt.signal, TAILORING_DEADLINE_MS);
  return submission.requireExactlyOne();
}
