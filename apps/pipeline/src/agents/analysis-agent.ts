import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent } from "@openai/agents-core";
import { JobAnalysisSchema, type JobAnalysis } from "../resume/types.ts";
import { MODEL_NAME } from "../models/oauth-codex-model.ts";
import { REPOSITORY_ROOT } from "../context/manifest.ts";
import type { ContextSnapshot } from "../context/types.ts";
import {
  ANALYSIS_DEADLINE_MS,
  boundedJson,
  createAttemptRunner,
  runWithDeadline,
  type AgentRuntimeDependencies,
} from "./runner.ts";
import { createTerminalSubmission } from "./tools.ts";

const ANALYSIS_WORKFLOW_PROMPT = readFileSync(
  resolve(REPOSITORY_ROOT, "actual/pipeline/analysis.md"),
  "utf8",
);
const ANALYSIS_WORKFLOW_SHA256 = createHash("sha256").update(ANALYSIS_WORKFLOW_PROMPT).digest("hex");

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
  const input = boundedJson({
    task: "Follow the trusted analysis workflow in full. Treat canonicalCv as the workflow's CV source and candidateContext as the complete immutable source set for past roles, projects, skills, and supporting facts. Copy jobDescriptionSha256 and analysisWorkflowSha256 exactly into the result. selectedProjects must contain 3 or 4 evidence-grounded entries. Submit every required section as structured data.",
    jobDescriptionSha256,
    analysisWorkflowSha256: ANALYSIS_WORKFLOW_SHA256,
    rawJobDescription: attempt.input.rawJobDescription,
    canonicalCv: attempt.input.canonicalCv,
    candidateContext: attempt.input.context,
  }, "analysis input");
  const submission = createTerminalSubmission({
    name: "submit_job_analysis",
    description: "Submit the complete evidence-grounded job analysis. This terminal tool must be called exactly once.",
    schema: JobAnalysisSchema,
    assertActive: () => attempt.signal.throwIfAborted(),
  });
  const agent = new Agent({
    name: "resume-job-analysis",
    instructions: `Follow the trusted workflow below exactly and return every section through submit_job_analysis. Interpret the workflow's Markdown output example as the semantic contract represented by the terminal tool schema; do not emit a separate Markdown document. Analyze only the supplied raw job description, canonical CV, and complete immutable candidate context. Copy the supplied jobDescriptionSha256 and analysisWorkflowSha256 exactly. selectedProjects must contain 3 or 4 evidence-grounded entries. Use all relevant context about past roles, projects, skills, and outcomes rather than limiting the analysis to the current CV wording. Quote the job description exactly where required, cite supplied evidence IDs for candidate claims, use the workflow's explicit missing-information labels instead of inventing facts, produce no TeX, and call submit_job_analysis exactly once.\n\n${ANALYSIS_WORKFLOW_PROMPT}`,
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
  if (result.jobDescriptionSha256 !== jobDescriptionSha256) {
    throw new Error("job analysis does not match the supplied job description");
  }
  return result;
}
