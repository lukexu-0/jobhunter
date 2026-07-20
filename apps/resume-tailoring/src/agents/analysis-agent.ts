import { createHash } from "node:crypto";
import { Agent } from "@openai/agents-core";
import { z } from "zod";
import {
  AtsKeywordExtractionSchema,
  JobAnalysisSchema,
  type AtsKeywordExtraction,
  type JobAnalysis,
} from "../resume/types.ts";
import {
  collectAnalysisSemanticIssues,
  validateAnalysisAgainstBaseline,
  type AnalysisSemanticIssue,
  type AnalysisSemanticIssueCategory,
} from "../resume/ledger.ts";
import { parseBaselineResume } from "../resume/parser.ts";
import { MODEL_NAME } from "../models/oauth-codex-model.ts";
import type { ContextSnapshot } from "../context/types.ts";
import {
  ATS_KEYWORD_EXTRACTION_WORKFLOW_SHA256,
  validateAtsKeywordExtractionAgainstJobDescription,
} from "./ats-keyword-extraction-agent.ts";
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
  "Identify evidence-backed JD keywords and exact replacements for existing resume bullets and skills. Use only the supplied job description, ATS keyword extraction, baseline inventory, and evidence. Use evidence-backed keywords and edit bullets for truthful JD alignment. Always preserve impact when performing edits. Avoid jargon and make the resume understandable by both a recruiter and technical staff member. Use conventional terminology, do not use unconventional terms such as \"Agentic workflow systems\". Make every project's first bullet a description. Return exact edits; use \"Accomplished [X] as measured by [Y] by doing [Z]\" only when evidence supports X, Y, and Z. Copy supplied hashes and call submit_job_analysis once.";
export const ANALYSIS_WORKFLOW_SHA256 = createHash("sha256")
  .update(`${ANALYSIS_TASK}\n${ANALYSIS_INSTRUCTIONS}`)
  .digest("hex");

export const ANALYSIS_VALIDATION_FEEDBACK_MAX_CHARS = 2_048;
const ANALYSIS_VALIDATION_MAX_ISSUES = 4;
const ANALYSIS_VALIDATION_MAX_PATH_CHARS = 96;
const ANALYSIS_VALIDATION_MAX_MESSAGE_CHARS = 160;

interface AnalysisValidationIssue {
  readonly path: string;
  readonly message: string;
}

type AnalysisSemanticFeedbackIssue = Pick<AnalysisSemanticIssue, "category" | "path" | "message">;

const ANALYSIS_SEMANTIC_CATEGORY_LABELS: Record<AnalysisSemanticIssueCategory, string> = {
  "hashes-and-snapshot": "Hashes and snapshot",
  "evidence-identifiers": "Evidence identifiers",
  "job-description-grounding": "Job-description grounding",
  "evidence-provenance": "Evidence provenance",
  "baseline-targets": "Baseline targets",
  "skill-replacements": "Skill replacements",
};

class AnalysisSemanticValidationError extends Error {
  readonly issues: readonly AnalysisSemanticFeedbackIssue[];

  constructor(issues: readonly AnalysisSemanticFeedbackIssue[]) {
    super("analysis semantic validation failed");
    this.name = "AnalysisSemanticValidationError";
    this.issues = issues;
  }
}

function collectAnalysisAgainstAtsKeywordExtractionIssues(
  analysis: JobAnalysis,
  extraction: AtsKeywordExtraction,
): readonly AnalysisSemanticFeedbackIssue[] {
  const extractedById = new Map(extraction.keywords.map((keyword) => [keyword.id, keyword]));
  const issues: AnalysisSemanticFeedbackIssue[] = [];
  for (const [keywordIndex, keyword] of analysis.jdKeywords.entries()) {
    const extracted = extractedById.get(keyword.id);
    if (!extracted) {
      issues.push({
        category: "job-description-grounding",
        path: ["jdKeywords", keywordIndex, "id"],
        message: "must match an extracted ATS keyword ID",
      });
      continue;
    }
    if (keyword.phrase !== extracted.phrase) {
      issues.push({
        category: "job-description-grounding",
        path: ["jdKeywords", keywordIndex, "phrase"],
        message: "must exactly match the extracted ATS keyword phrase",
      });
    }
    if (keyword.jdQuote !== extracted.jdQuote) {
      issues.push({
        category: "job-description-grounding",
        path: ["jdKeywords", keywordIndex, "jdQuote"],
        message: "must exactly match the extracted ATS keyword quote",
      });
    }
  }
  return issues;
}

export function validateAnalysisAgainstAtsKeywordExtraction(
  analysis: JobAnalysis,
  extraction: AtsKeywordExtraction,
): JobAnalysis {
  const parsedAnalysis = JobAnalysisSchema.parse(analysis);
  const parsedExtraction = AtsKeywordExtractionSchema.parse(extraction);
  if (parsedAnalysis.jobDescriptionSha256 !== parsedExtraction.jobDescriptionSha256) {
    throw new Error("job analysis and ATS keyword extraction job description hashes do not match");
  }
  if (
    parsedExtraction.keywordExtractionWorkflowSha256
    !== ATS_KEYWORD_EXTRACTION_WORKFLOW_SHA256
  ) {
    throw new Error("ATS keyword extraction does not match the configured workflow");
  }
  const issues = collectAnalysisAgainstAtsKeywordExtractionIssues(parsedAnalysis, parsedExtraction);
  if (issues.length > 0) throw new AnalysisSemanticValidationError(issues);
  return parsedAnalysis;
}

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

function findSemanticValidationIssues(
  error: unknown,
  depth = 0,
): readonly AnalysisSemanticFeedbackIssue[] | undefined {
  if (error instanceof AnalysisSemanticValidationError) return error.issues;
  if (depth >= 4) return undefined;
  return findSemanticValidationIssues(nestedError(error, "originalError"), depth + 1)
    ?? findSemanticValidationIssues(nestedError(error, "validationCause"), depth + 1)
    ?? findSemanticValidationIssues(nestedError(error, "cause"), depth + 1);
}

function findErrorMessage(error: unknown, depth = 0): string {
  if (depth >= 4) return "";
  const validationCause = nestedError(error, "validationCause");
  if (validationCause !== undefined) return findErrorMessage(validationCause, depth + 1);
  const originalError = nestedError(error, "originalError");
  if (originalError !== undefined) return findErrorMessage(originalError, depth + 1);
  if (error instanceof Error) return error.message;
  return "";
}

function boundedFeedbackPart(value: string, maxChars: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function issuePath(path: readonly PropertyKey[]): string {
  let result = "$";
  for (const segment of path) {
    if (typeof segment === "number") {
      result += `[${segment}]`;
      continue;
    }
    const safe = String(segment).replace(/[^A-Za-z0-9_-]/g, "?");
    result += `.${safe}`;
  }
  return boundedFeedbackPart(result, ANALYSIS_VALIDATION_MAX_PATH_CHARS);
}

function safeZodMessage(message: string): string {
  const normalized = message
    .replace(/unknown keyword ID .+$/i, "references an unknown keyword ID")
    .replace(/replacement does not contain linked keyword .+$/i, "replacement does not contain a linked keyword phrase")
    .replace(/replacement omits keyword evidence .+$/i, "replacement omits linked keyword evidence")
    .replace(/unrecognized key(?:s)?:.+$/i, "contains unrecognized keys")
    .replace(/"[^"]*"/g, "\"<redacted>\"");
  return boundedFeedbackPart(normalized, ANALYSIS_VALIDATION_MAX_MESSAGE_CHARS);
}

function semanticValidationIssue(error: unknown): AnalysisValidationIssue {
  const message = findErrorMessage(error);
  if (message.includes("configured analysis workflow")) {
    return { path: "$.analysisWorkflowSha256", message: "must match the supplied analysis workflow hash" };
  }
  if (message.includes("job description hash")) {
    return { path: "$.jobDescriptionSha256", message: "must match the supplied job description hash" };
  }
  if (message.includes("baseline hash")) {
    return { path: "$.baselineSha256", message: "must match the supplied baseline hash" };
  }
  if (message.includes("quote does not occur verbatim")) {
    return { path: "$.jdKeywords[].jdQuote", message: "must occur verbatim in the supplied job description" };
  }
  if (message.includes("phrase does not occur in its JD quote")) {
    return { path: "$.jdKeywords[].phrase", message: "must occur case-insensitively in its exact JD quote" };
  }
  if (message.includes("cites unknown evidence")) {
    return { path: "$..evidenceIds", message: "must contain only supplied evidence IDs" };
  }
  if (message.includes("is attributed to")) {
    return { path: "$.exactEdits[].evidenceIds", message: "must have valid baseline or entity-equivalent provenance" };
  }
  if (message.includes("targets an unknown or mismatched baseline item")) {
    return { path: "$.exactEdits[].baselineItemId", message: "must identify the matching supplied baseline item and metadata" };
  }
  if (message.includes("has stale before text")) {
    return { path: "$.exactEdits[].before", message: "must exactly match the supplied baseline item text" };
  }
  if (message.includes("replacement skill") || message.includes("duplicate replacement skill")) {
    return { path: "$.exactEdits[].after", message: "must be a new, non-duplicate skill in its category" };
  }
  return { path: "$", message: "must satisfy the supplied hashes, baseline, JD, and evidence constraints" };
}

function finishAnalysisValidationFeedback(issueLines: readonly string[]): string {
  const feedback = [
    "Analysis submission rejected. Correct it and call submit_job_analysis again.",
    ...issueLines,
    "Correction checklist:",
    "- Every linked keyword phrase must appear case-insensitively in edit.after.",
    "- Every linked keyword evidence ID must be included by the edit.",
    "- Workflow, JD, and baseline hashes, baseline targets, and before text must match the supplied input.",
    "- JD quotes must be verbatim and all evidence IDs and provenance must validate.",
  ].join("\n");
  return feedback.length <= ANALYSIS_VALIDATION_FEEDBACK_MAX_CHARS
    ? feedback
    : feedback.slice(0, ANALYSIS_VALIDATION_FEEDBACK_MAX_CHARS);
}

function formatGroupedSemanticIssues(issues: readonly AnalysisSemanticFeedbackIssue[]): string {
  const distinctIssues = [...new Map(issues.map((issue) => {
    const path = issuePath(issue.path);
    const message = safeZodMessage(issue.message);
    return [`${issue.category}\u0000${path}\u0000${message}`, { ...issue, path, message }];
  })).values()];
  const grouped = new Map<AnalysisSemanticIssueCategory, AnalysisValidationIssue[]>();
  for (const issue of distinctIssues) {
    const group = grouped.get(issue.category) ?? [];
    group.push({ path: issue.path, message: issue.message });
    grouped.set(issue.category, group);
  }
  const lines = ["Validation issues grouped by category:"];
  for (const [category, categoryIssues] of grouped) {
    const firstIssue = categoryIssues[0]!;
    lines.push(`${ANALYSIS_SEMANTIC_CATEGORY_LABELS[category]}:`);
    lines.push(`- ${firstIssue.path}: ${firstIssue.message}`);
    if (categoryIssues.length > 1) {
      lines.push(`- ${categoryIssues.length - 1} additional path(s) in this category omitted`);
    }
  }
  return finishAnalysisValidationFeedback(lines);
}

function formatAnalysisValidationError(error: unknown): string {
  const zodError = findZodError(error);
  if (zodError) {
    const issues: AnalysisValidationIssue[] = zodError.issues.map((issue) => ({
      path: issuePath(issue.path),
      message: safeZodMessage(issue.message),
    }));
    const distinctIssues = [...new Map(
      issues
        .sort((left, right) => left.path.localeCompare(right.path) || left.message.localeCompare(right.message))
        .map((issue) => [`${issue.path}\u0000${issue.message}`, issue]),
    ).values()].slice(0, ANALYSIS_VALIDATION_MAX_ISSUES);
    const omitted = issues.length - distinctIssues.length;
    return finishAnalysisValidationFeedback([
      "Validation issues:",
      ...distinctIssues.map((issue) => `- ${issue.path}: ${issue.message}`),
      ...(omitted > 0 ? [`- $: ${omitted} additional validation issue(s) omitted`] : []),
    ]);
  }
  const semanticIssues = findSemanticValidationIssues(error);
  if (semanticIssues) return formatGroupedSemanticIssues(semanticIssues);
  const fallback = semanticValidationIssue(error);
  return finishAnalysisValidationFeedback(["Validation issues:", `- ${fallback.path}: ${fallback.message}`]);
}

export interface AnalysisAgentInput {
  readonly rawJobDescription: string;
  readonly atsKeywordExtraction: AtsKeywordExtraction;
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
  validateAtsKeywordExtractionAgainstJobDescription(
    attempt.input.atsKeywordExtraction,
    attempt.input.rawJobDescription,
  );
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
    atsKeywordExtraction: attempt.input.atsKeywordExtraction,
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
    validate: (analysis) => {
      const issues: AnalysisSemanticFeedbackIssue[] = [];
      if (analysis.analysisWorkflowSha256 !== ANALYSIS_WORKFLOW_SHA256) {
        issues.push({
          category: "hashes-and-snapshot",
          path: ["analysisWorkflowSha256"],
          message: "must match the supplied analysis workflow hash",
        });
      }
      issues.push(...collectAnalysisSemanticIssues(
        analysis,
        attempt.input.rawJobDescription,
        attempt.input.canonicalCv,
        attempt.input.context,
      ));
      issues.push(...collectAnalysisAgainstAtsKeywordExtractionIssues(
        analysis,
        attempt.input.atsKeywordExtraction,
      ));
      if (issues.length > 0) throw new AnalysisSemanticValidationError(issues);
      validateAnalysisAgainstBaseline(
        analysis,
        attempt.input.rawJobDescription,
        attempt.input.canonicalCv,
        attempt.input.context,
      );
    },
    formatValidationError: formatAnalysisValidationError,
  });
  const agent = new Agent({
    name: "resume-job-analysis",
    instructions: ANALYSIS_INSTRUCTIONS,
    model: MODEL_NAME,
    modelSettings: {
      reasoning: { effort: "xhigh" },
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
  await runWithDeadline(runner, agent, input, 4, attempt.signal, ANALYSIS_DEADLINE_MS);
  const result = submission.requireExactlyOne();
  if (result.analysisWorkflowSha256 !== ANALYSIS_WORKFLOW_SHA256) {
    throw new Error("job analysis does not match the configured analysis workflow");
  }
  const extractionValidated = validateAnalysisAgainstAtsKeywordExtraction(
    result,
    attempt.input.atsKeywordExtraction,
  );
  return validateAnalysisAgainstBaseline(
    extractionValidated,
    attempt.input.rawJobDescription,
    attempt.input.canonicalCv,
    attempt.input.context,
  );
}
