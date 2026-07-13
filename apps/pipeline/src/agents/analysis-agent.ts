import { Agent } from "@openai/agents-core";
import { JobAnalysisSchema, type JobAnalysis } from "../resume/types.ts";
import { MODEL_NAME } from "../models/oauth-codex-model.ts";
import {
  ANALYSIS_DEADLINE_MS,
  boundedJson,
  createAttemptRunner,
  runWithDeadline,
  type AgentRuntimeDependencies,
} from "./runner.ts";
import { createTerminalSubmission } from "./tools.ts";

export interface AnalysisAgentInput {
  readonly rawJobDescription: string;
  readonly evidence: unknown;
}

export interface AnalysisAgentAttempt {
  readonly attemptSessionId: string;
  readonly input: AnalysisAgentInput;
  readonly signal: AbortSignal;
  readonly runtime?: AgentRuntimeDependencies;
}

export async function runAnalysisAgent(attempt: AnalysisAgentAttempt): Promise<JobAnalysis> {
  const input = boundedJson({
    task: "Analyze the job description against the immutable evidence and submit the structured analysis.",
    rawJobDescription: attempt.input.rawJobDescription,
    evidence: attempt.input.evidence,
  }, "analysis input");
  const submission = createTerminalSubmission({
    name: "submit_job_analysis",
    description: "Submit the complete evidence-grounded job analysis. This terminal tool must be called exactly once.",
    schema: JobAnalysisSchema,
    assertActive: () => attempt.signal.throwIfAborted(),
  });
  const agent = new Agent({
    name: "resume-job-analysis",
    instructions: "Analyze only the supplied raw job description and immutable evidence. Quote the job description exactly where required, cite evidence IDs, add no resume prose or TeX, and call submit_job_analysis exactly once.",
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
  await runWithDeadline(runner, agent, input, 1, attempt.signal, ANALYSIS_DEADLINE_MS);
  return submission.requireExactlyOne();
}
