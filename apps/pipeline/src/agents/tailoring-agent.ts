import { createHash } from "node:crypto";
import { Agent, tool } from "@openai/agents-core";
import { z } from "zod";
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

export const MAX_TAILORING_TOOL_CALLS = 10;
export const MAX_TAILORING_TOOL_BYTES = 3 * 1024 * 1024;

const TAILORING_WORKFLOW_PROMPT = `# Resume Tailoring Workflow

Tailor the resume to a specific job while preserving truthful evidence and a strict one-page limit.
Treat the steps as guidance rather than a mechanical checklist; adapt them to the role, evidence, readability, and page balance.

## Step 1 — Map requirements to existing evidence

Use judgment to focus on requirements that materially affect fit:

- Favor the strongest exact evidence already present in the resume or another verified source.
- Distinguish direct experience from adjacent experience.
- Place evidence where it communicates fit most naturally.
- Leave unsupported requirements as gaps; never create evidence to make them appear covered.

## Step 2 — Rank proof and decide what to keep

Use judgment to rank entries and bullets by role relevance and evidence strength. Generally favor:

- Direct technical evidence for high-priority requirements
- Verified production, user, operational, or business impact
- Ownership, system scope, trade-offs, reliability, or security
- Adjacent technical evidence
- Communication, leadership, or high-pressure work when it supports the role
- Unrelated experience only when it adds useful context or space allows

## Step 3 — Align vocabulary truthfully

Use \`analysis.keywordAlignment\` as the authoritative shortlist. Prioritize its supported exact job-description terms naturally where they describe real experience; do not re-extract or add terms outside the shortlist.
Exclude screening filters, unsupported terms, and subjective culture language unless it names a concrete searchable competency.

Place supported terms where they read naturally and their evidence appears:

- Experience bullets for work performed in a role
- Project headings or bullets for project-specific tools and outcomes
- Technical Skills for verified technologies
- Competitions & Other when the activity genuinely demonstrates the competency

Avoid keyword stuffing, hidden text, unsupported synonyms, or repeated phrases that make the CV unnatural.

## Step 4 — Tailor Experience

When rewriting Experience bullets, apply the principles that improve clarity and relevance:

- Aim for one distinct evidence-backed claim, combining a specific action or verified outcome with concrete scope, relevant methods or technologies, and a verified effect when those elements strengthen the bullet.
- Include metrics only when supported and meaningful; never force or invent a number.
- Prefer concrete nouns and verbs over adjectives, responsibility phrases, or implementation details that do not show relevance, difficulty, ownership, or impact.
- Preserve verified tense and completion status, and order bullets by the strength of their matching evidence.

## Step 5 — Tailor Projects

Projects may be reordered, rewritten, shortened, or replaced based on role fit, evidence strength, and page balance.

- Usually place the strongest-matching project first unless another order improves the narrative.
- Prefer bullets that add distinct evidence and fit within the page limit.
- Cut technology repetition that adds no proof.
- Emphasize the outcomes, architecture, security, reliability, scale, or user value most relevant to the role.
- Keep every fact and date accurate.

## Step 6 — Tailor Competitions & Other

Keep, shorten, or replace an entry based on its relevance; any replacement must be a verified competition or activity.

## Step 7 — Tailor Technical Skills

Technical Skills should confirm demonstrated evidence rather than compensate for gaps. Use judgment to:

- Keep only technologies supported by verified work, projects, coursework, or demonstrated use.
- Emphasize relevant terms and remove low-value noise.
- Add a requested technology only when verified; never list it solely because it appears in the job description.
- Keep terminology consistent with Experience and Projects, avoiding labels that cannot be defended in an interview.

## Step 8 — Enforce the one-page budget

Use judgment to fit one page. Generally protect:

- the strongest Experience evidence
- the most relevant Projects and distinct project bullets
- verified Technical Skills that support the role
- concise Competitions & Other evidence when it adds value

Before shortening high-value proof, first cut duplicated or low-value bullets, repeated heading or technology labels, lower-priority project detail, and unrelated non-technical Experience.`;
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
    task: "Tailor the resume.",
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
    perToolCalls: { read_working_tex: 4, apply_tailoring_plan: 6 },
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
    instructions: `Tailor the resume using the workflow below, applying writing and prioritization guidance with judgment rather than mechanically. The runtime input provides immutable identifiers, the complete analysis, candidateContext, and baselineInventory.\nMandatory: Keep content evidence-grounded and factually accurate; never invent claims, technologies, metrics, dates, tense, or completion status, and use only candidateContext.mustIncludeDirectives on non-omitted equivalent entities with both directive and same-entity supporting evidence, surfacing unsupported or conflicting directives as limitations.\nMandatory: Preserve exact IDs and hashes, cover every baseline bullet and skill, obey plan invariants (matching overrides for rewrites, factKeys only for genuine conflicting factWinners, and evidence-owner entityIds), follow read_working_tex → apply_tailoring_plan → read_working_tex → submit_tailoring_plan, and fit one page.\n\n${TAILORING_WORKFLOW_PROMPT}`,
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
  await runWithDeadline(runner, agent, input, 12, attempt.signal, TAILORING_DEADLINE_MS);
  const submitted = submission.requireExactlyOne();
  if (!applied) throw new Error("tailoring agent completed without an applied working copy");
  return TailoringResultSchema.parse({
    plan: submitted.plan,
    tailoredTex: applied.tailoredTex,
    toolCount: budget.totalCalls() + 1,
  });
}
