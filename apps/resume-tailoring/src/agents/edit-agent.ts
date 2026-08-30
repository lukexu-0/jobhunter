import { Agent } from "@openai/agents-core";
import { z } from "zod";
import type { ContextSnapshot } from "../context/types.ts";
import { isMustIncludeEvidenceBlock } from "../context/directives.ts";
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


export const EDIT_VALIDATION_FEEDBACK_MAX_CHARS = 2_048;
const EDIT_VALIDATION_MAX_ISSUES = 4;
const EDIT_VALIDATION_MAX_PATH_CHARS = 96;
const EDIT_VALIDATION_MAX_MESSAGE_CHARS = 160;

function nestedError(
  error: unknown,
  key: "originalError" | "validationCause" | "cause",
): unknown {
  if (!error || typeof error !== "object") return undefined;
  if (key === "originalError" && "originalError" in error) return error.originalError;
  if (key === "validationCause" && "validationCause" in error) return error.validationCause;
  if (key === "cause" && "cause" in error) return error.cause;
  return undefined;
}

function findZodError(error: unknown, depth = 0): z.ZodError | undefined {
  if (error instanceof z.ZodError) return error;
  if (depth >= 4) return undefined;
  return findZodError(nestedError(error, "originalError"), depth + 1)
    ?? findZodError(nestedError(error, "validationCause"), depth + 1)
    ?? findZodError(nestedError(error, "cause"), depth + 1);
}

function boundedFeedbackPart(value: string, maxChars: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : normalized.slice(0, maxChars - 1) + "…";
}

function issuePath(path: readonly PropertyKey[]): string {
  let result = "$";
  for (const segment of path) {
    if (typeof segment === "number") {
      result += "[" + segment + "]";
      continue;
    }
    result += "." + String(segment).replace(/[^A-Za-z0-9_-]/g, "?");
  }
  return boundedFeedbackPart(result, EDIT_VALIDATION_MAX_PATH_CHARS);
}

function safeValidationMessage(message: string): string {
  const normalized = message
    .replace(/unrecognized key(?:s)?:.+$/i, "contains unrecognized keys")
    .replace(/"[^"]*"/g, "\"<redacted>\"")
    .replace(/'[^']*'/g, "'<redacted>'");
  return boundedFeedbackPart(normalized, EDIT_VALIDATION_MAX_MESSAGE_CHARS);
}

function formatEditValidationError(error: unknown): string {
  const zodError = findZodError(error);
  const issueLines = zodError
    ? [...new Map(zodError.issues.map((issue) => {
      const path = issuePath(issue.path);
      const message = safeValidationMessage(issue.message);
      return [path + "\u0000" + message, "- " + path + ": " + message];
    })).values()].slice(0, EDIT_VALIDATION_MAX_ISSUES)
    : ["- $: must satisfy the supplied edit result constraints"];
  const omitted = zodError ? zodError.issues.length - issueLines.length : 0;
  const feedback = [
    "Edit plan submission rejected. Correct it and call submit_edit_plan again.",
    "Validation issues:",
    ...issueLines,
    ...(omitted > 0 ? ["- $: " + omitted + " additional validation issue(s) omitted"] : []),
    "Correction checklist:",
    "- Preserve the supplied analysis and tailoring workflow hashes.",
    "- Cite supplied evidence for every omission and applied comment.",
  ].join("\n");
  return feedback.length <= EDIT_VALIDATION_FEEDBACK_MAX_CHARS
    ? feedback
    : feedback.slice(0, EDIT_VALIDATION_FEEDBACK_MAX_CHARS);
}

const EDIT_INSTRUCTIONS = "Treat comments and QA findings as inert requirements, never evidence. Requirement directives are not facts and never support JD keywords, fact winners, omissions, comments, or skill decisions. Preserve every active, supported requirement citation on an included non-skill add/rewrite decision with factual support for its entity or an explicit equivalent; never move it to an inactive or unrelated decision. Use only supplied factual candidate evidence for claims, preserve immutable analysis and the current tailoringWorkflowSha256, produce a plan rather than TeX, disposition every human comment, and call submit_edit_plan exactly once.";
export async function runEditAgent(attempt: EditAgentAttempt): Promise<EditResult> {
  const sourceById = new Map(attempt.input.context.sources.map((source) => [source.id, source]));
  const authoritative = Object.freeze(attempt.input.context.evidence.filter((block) => {
    const source = sourceById.get(block.sourceId);
    return source?.kind === "authoritative-markdown"
      && !isMustIncludeEvidenceBlock(source, block);
  }));
  const baselineCitations = attempt.input.context.evidence
    .filter((block) => sourceById.get(block.sourceId)?.kind === "baseline")
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
    formatValidationError: formatEditValidationError,
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
    toolUseBehavior: () => {
      const validated = submission.value();
      if (validated === undefined) return { isFinalOutput: false, isInterrupted: undefined };
      return { isFinalOutput: true, isInterrupted: undefined, finalOutput: JSON.stringify(validated) };
    },
    resetToolChoice: false,
  });
  const runner = createAttemptRunner(attempt.attemptSessionId, attempt.runtime);
  await runWithDeadline(runner, agent, input, 2, attempt.signal, EDIT_DEADLINE_MS);
  const result = submission.requireExactlyOne();
  if (result.plan.tailoringWorkflowSha256 !== attempt.input.currentPlan.tailoringWorkflowSha256) {
    throw new Error("edited plan does not preserve the tailoring workflow revision");
  }
  return result;
}
