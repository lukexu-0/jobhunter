import { createHash } from "node:crypto";
import { Agent } from "@openai/agents-core";
import { JobAnalysisSchema, type JobAnalysis } from "../resume/types.ts";
import { validateAnalysisAgainstBaseline } from "../resume/ledger.ts";
import { parseBaselineResume } from "../resume/parser.ts";
import { MODEL_NAME } from "../models/oauth-codex-model.ts";
import type { ContextSnapshot } from "../context/types.ts";
import {
  ANALYSIS_DEADLINE_MS,
  boundedJson,
  createAttemptRunner,
  runWithDeadline,
  type AgentRuntimeDependencies,
} from "./runner.ts";
import { createTerminalSubmission } from "./tools.ts";

export const ANALYSIS_TASK =
  "Identify evidence-backed JD keywords and exact replacements for existing resume bullets and skills.";
export const ANALYSIS_INSTRUCTIONS =
  "Analyze the role and improve the resume using only the supplied job description, baseline inventory, and evidence. Return exact edits to existing items; use \"Accomplished [X] as measured by [Y] by doing [Z]\" only when evidence supports X, Y, and Z, never invent facts, copy the supplied hashes, and call submit_job_analysis once.";
export const ANALYSIS_WORKFLOW_SHA256 = createHash("sha256")
  .update(`${ANALYSIS_TASK}\n${ANALYSIS_INSTRUCTIONS}`)
  .digest("hex");

export interface AnalysisAgentInput {
  readonly rawJobDescription: string;
  readonly canonicalCv: string;
  readonly context: ContextSnapshot;
}

export interface AnalysisAgentAttempt {
  readonly attemptSessionId: string;
  readonly input: AnalysisAgentInput;
  readonly signal: AbortSignal;
  readonly runtime?: AgentRuntimeDependencies;
}

export async function runAnalysisAgent(attempt: AnalysisAgentAttempt): Promise<JobAnalysis> {
  const jobDescriptionSha256 = createHash("sha256").update(attempt.input.rawJobDescription).digest("hex");
  const baselineInventory = parseBaselineResume(attempt.input.canonicalCv);
  const sourceKindById = new Map(attempt.input.context.sources.map((source) => [source.id, source.kind]));
  const authoritative = attempt.input.context.evidence.filter((block) => sourceKindById.get(block.sourceId) === "authoritative-markdown");
  const baselineCitations = attempt.input.context.evidence
    .filter((block) => sourceKindById.get(block.sourceId) === "baseline")
    .map(({ id, sourceVersionId, sourceId, entityId, headingPath, caveats, sha256 }) => (
      { id, sourceVersionId, sourceId, entityId, headingPath, caveats, sha256 }
    ));
  const input = boundedJson({
    task: ANALYSIS_TASK,
    rawJobDescription: attempt.input.rawJobDescription,
    jobDescriptionSha256,
    analysisWorkflowSha256: ANALYSIS_WORKFLOW_SHA256,
    baselineSha256: baselineInventory.sha256,
    baselineInventory: {
      sha256: baselineInventory.sha256,
      bullets: baselineInventory.bullets,
      skills: baselineInventory.skills,
    },
    candidateEvidence: {
      authoritative,
      baselineCitations,
      explicitEntityBindings: attempt.input.context.explicitEntityBindings,
    },
  }, "analysis input");
  const submission = createTerminalSubmission({
    name: "submit_job_analysis",
    description: "Submit the structured analysis once.",
    schema: JobAnalysisSchema,
    assertActive: () => attempt.signal.throwIfAborted(),
  });
  const agent = new Agent({
    name: "resume-job-analysis",
    instructions: ANALYSIS_INSTRUCTIONS,
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
  const result = submission.requireExactlyOne();
  if (result.analysisWorkflowSha256 !== ANALYSIS_WORKFLOW_SHA256) {
    throw new Error("job analysis does not match the configured analysis workflow");
  }
  return validateAnalysisAgainstBaseline(
    result,
    attempt.input.rawJobDescription,
    attempt.input.canonicalCv,
    attempt.input.context,
  );
}
