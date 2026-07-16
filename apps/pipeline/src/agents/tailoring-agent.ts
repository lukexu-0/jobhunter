import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent, tool } from "@openai/agents-core";
import { z } from "zod";
import { REPOSITORY_ROOT } from "../context/manifest.ts";
import type { ContextSnapshot } from "../context/types.ts";
import { MODEL_NAME } from "../models/oauth-codex-model.ts";
import { hashJobAnalysis, validateAnalysisImmutability } from "../resume/ledger.ts";
import { parseBaselineResume } from "../resume/parser.ts";
import {
  TailoringPlanSchema,
  TailoringResultSchema,
  TailoringSubmissionSchema,
  type JobAnalysis,
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

export const MAX_TAILORING_TOOL_CALLS = 7;
export const MAX_TAILORING_TOOL_BYTES = 3 * 1024 * 1024;

const rawWorkflow = readFileSync(resolve(REPOSITORY_ROOT, "actual/pipeline/tailoring.md"), "utf8");
const step15 = rawWorkflow.indexOf("\n## Step 15");
if (step15 < 0) throw new Error("tailoring workflow is missing the Step 15 boundary");
const TAILORING_WORKFLOW_PROMPT = rawWorkflow.slice(0, step15).trimEnd();
const TAILORING_WORKFLOW_SHA256 = createHash("sha256").update(TAILORING_WORKFLOW_PROMPT).digest("hex");

const EmptySchema = z.object({}).strict();
const ApplyPlanSchema = z.object({ plan: TailoringPlanSchema }).strict();

export interface TailoringAgentOperations {
  readonly renderPlan: (plan: TailoringPlan, signal: AbortSignal) => string | Promise<string>;
}

export interface TailoringAgentInput {
  readonly analysis: JobAnalysis;
  readonly baseline: string;
  readonly context: ContextSnapshot;
  readonly operations: TailoringAgentOperations;
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
  const parsedBaseline = parseBaselineResume(attempt.input.baseline);
  const analysisSha256 = hashJobAnalysis(attempt.input.analysis);
  const input = boundedJson({
    task: "Execute the trusted tailoring workflow through Step 14 against an isolated working copy. Copy analysisId, analysisSha256, and tailoringWorkflowSha256 exactly into the plan. Use the complete analysis and candidate context. Plan invariants: when factWinners is empty every decision factKeys array must also be empty; every rewrite decision requires one baselineOverride with identical replacement text and supporting evidence; every skillDecision entityId identifies the cited evidence owner, never the stable skill ID. Set factWinners to an empty array unless supplied sources contain genuinely conflicting values for the same fact key; dates and LaTeX escaping are not conflicts. Apply a complete plan to the copy, inspect the edited copy, then submit that exact applied plan. The trusted pipeline performs compilation and later QA after submission.",
    analysisId: attempt.input.analysis.id,
    analysisSha256,
    tailoringWorkflowSha256: TAILORING_WORKFLOW_SHA256,
    analysis: attempt.input.analysis,
    candidateContext: attempt.input.context,
    baselineInventory: {
      sha256: parsedBaseline.sha256,
      entities: parsedBaseline.entities,
      skills: parsedBaseline.skills,
    },
  }, "tailoring input");

  const sharedSubmitted = { value: false };
  const budget = createSequentialToolBudget({
    sharedSubmitted,
    maxCalls: MAX_TAILORING_TOOL_CALLS,
    maxBytes: MAX_TAILORING_TOOL_BYTES,
    perToolCalls: { read_working_tex: 3, apply_tailoring_plan: 5 },
    label: "tailoring",
  });
  let workingTex = attempt.input.baseline;
  let applied: { readonly plan: TailoringPlan; readonly tailoredTex: string } | undefined;
  let baselineRead = false;
  let appliedRead = false;

  const readWorkingTex = tool({
    name: "read_working_tex",
    description: "Read the current isolated LaTeX working copy. Read once before planning and again after every applied plan.",
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

  const applyTailoringPlan = tool({
    name: "apply_tailoring_plan",
    description: "Validate and apply a complete evidence-grounded tailoring plan to the isolated working copy. Every rewrite needs a matching baselineOverride, decision factKeys must reference supplied factWinners, and each skillDecision entityId must identify its cited evidence owner rather than a stable skill ID. This never changes the canonical baseline and does not compile.",
    parameters: ApplyPlanSchema,
    strict: true,
    errorFunction: (_context, error): string => {
      const message = error instanceof Error ? error.message : "unknown validation error";
      return `Plan rejected: ${message}. Correct the complete plan, then call apply_tailoring_plan once more.`;
    },
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    timeoutBehavior: "raise_exception",
    execute: async ({ plan }): Promise<{ ok: true; bytes: number; sha256: string }> => {
      budget.begin("apply_tailoring_plan", { plan });
      if (!baselineRead) throw new Error("apply_tailoring_plan requires reading the baseline working copy first");
      assertActive(attempt.signal);
      if (plan.tailoringWorkflowSha256 !== TAILORING_WORKFLOW_SHA256) {
        throw new Error("tailoring plan does not match the configured tailoring workflow");
      }
      validateAnalysisImmutability(plan, attempt.input.analysis);
      const toolSignal = AbortSignal.any([attempt.signal, AbortSignal.timeout(DEFAULT_TOOL_TIMEOUT_MS)]);
      const tailoredTex = await attempt.input.operations.renderPlan(plan, toolSignal);
      assertActive(toolSignal);
      if (Buffer.byteLength(tailoredTex) > 256 * 1024) throw new Error("tailored TeX exceeds 256 KiB");
      workingTex = tailoredTex;
      applied = { plan, tailoredTex };
      appliedRead = false;
      const result = {
        ok: true as const,
        bytes: Buffer.byteLength(tailoredTex),
        sha256: createHash("sha256").update(tailoredTex).digest("hex"),
      };
      budget.finish(result);
      return result;
    },
  });

  const submission = createTerminalSubmission({
    name: "submit_tailoring_plan",
    description: "Submit the exact complete plan most recently applied to and inspected in the isolated working copy.",
    schema: TailoringSubmissionSchema,
    sharedSubmitted,
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    assertActive: () => assertActive(attempt.signal),
    validate: ({ plan }) => {
      if (!applied) throw new Error("submit_tailoring_plan requires an applied tailoring plan");
      if (!appliedRead) throw new Error("submit_tailoring_plan requires reading the applied working copy");
      if (JSON.stringify(plan) !== JSON.stringify(applied.plan)) {
        throw new Error("submitted tailoring plan must exactly match the latest applied plan");
      }
    },
  });

  const agent = new Agent({
    name: "resume-tailoring",
    instructions: `Execute the trusted workflow below through Step 14. The canonical source is read-only: every reference to editing actual/resume-main/main.tex means editing the isolated working copy with read_working_tex and apply_tailoring_plan. Copy the supplied analysisId, analysisSha256, and tailoringWorkflowSha256 exactly into the plan. Use baselineInventory for exact stable IDs and cover every baseline bullet and skill in the plan. Use all relevant candidate context, cite evidence for every decision, and preserve analysis immutability. When factWinners is [], every decision factKeys array must also be []; every rewrite decision requires exactly one baselineOverride whose replacement equals the decision text and whose evidence supports it; every decision and skillDecision entityId identifies the owner of its cited evidence, never a stable skill ID. Set factWinners to [] unless the supplied sources contain genuinely conflicting values for the same fact key; project dates and TeX-escaped forms of the same value are not conflicts. Read the baseline copy, apply a complete plan, read the resulting copy, and call submit_tailoring_plan with that exact plan. Step 14 is a handoff requirement only: never invoke a shell or compiler; the trusted pipeline compiles after submission.\n\n${TAILORING_WORKFLOW_PROMPT}`,
    model: MODEL_NAME,
    modelSettings: {
      reasoning: { effort: "medium" },
      parallelToolCalls: false,
      store: false,
      retry: { maxRetries: 0 },
    },
    tools: [readWorkingTex, applyTailoringPlan, submission.tool],
    handoffs: [],
    mcpServers: [],
    toolUseBehavior: { stopAtToolNames: [submission.name] },
    resetToolChoice: false,
  });
  const runner = createAttemptRunner(attempt.attemptSessionId, attempt.runtime);
  await runWithDeadline(runner, agent, input, 9, attempt.signal, TAILORING_DEADLINE_MS);
  const submitted = submission.requireExactlyOne();
  if (!applied) throw new Error("tailoring agent completed without an applied working copy");
  return TailoringResultSchema.parse({
    plan: submitted.plan,
    tailoredTex: applied.tailoredTex,
    toolCount: budget.totalCalls() + 1,
  });
}
