import { Agent, tool } from "@openai/agents-core";
import { z } from "zod";
import { MODEL_NAME } from "../models/oauth-codex-model.ts";
import { validateRepairResult } from "../resume/repair.ts";
import { RepairResultSchema, type RepairResult } from "../resume/types.ts";
import {
  REPAIR_DEADLINE_MS,
  boundedJson,
  createAttemptRunner,
  runWithDeadline,
  type AgentRuntimeDependencies,
} from "./runner.ts";
import { createSequentialToolBudget, createTerminalSubmission, DEFAULT_TOOL_TIMEOUT_MS } from "./tools.ts";

export const MAX_REPAIR_TOOL_CALLS = 8;
export const MAX_REPAIR_TOOL_BYTES = 2 * 1024 * 1024;

const ArtifactRequestSchema = z.object({ artifactId: z.string().min(1).max(200) }).strict();
const CandidateSchema = z.object({ tailoredTex: z.string().max(256 * 1024) }).strict();

export interface RepairToolResult {
  readonly ok: boolean;
  readonly diagnostics: readonly string[];
  readonly output?: unknown;
}

export interface RepairToolOperations {
  readonly validateCandidate: (tailoredTex: string, signal: AbortSignal) => Promise<RepairToolResult>;
  readonly compileCandidate: (tailoredTex: string, signal: AbortSignal) => Promise<RepairToolResult>;
}

export interface RepairAgentInput {
  readonly failedTexArtifactId: string;
  readonly latexLogArtifactId: string;
  readonly failedTex: string;
  readonly latexLog: string;
  readonly canonicalBaseline: string;
  readonly operations: RepairToolOperations;
}

export interface RepairAgentAttempt {
  readonly attemptSessionId: string;
  readonly input: RepairAgentInput;
  readonly signal: AbortSignal;
  readonly runtime?: AgentRuntimeDependencies;
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

export async function runRepairAgent(attempt: RepairAgentAttempt): Promise<RepairResult> {
  if (Buffer.byteLength(attempt.input.failedTex) > 256 * 1024) throw new Error("failed TeX artifact exceeds 256 KiB");
  if (Buffer.byteLength(attempt.input.latexLog) > 1024 * 1024) throw new Error("LaTeX log artifact exceeds 1 MiB");
  const modelInput = boundedJson({
    task: "Repair the supplied TeX using the fixed failed artifact and LaTeX log.",
    failedTexArtifactId: attempt.input.failedTexArtifactId,
    latexLogArtifactId: attempt.input.latexLogArtifactId,
  }, "repair input");
  const submitted = { value: false };
  const budget = createSequentialToolBudget({
    sharedSubmitted: submitted,
    maxCalls: MAX_REPAIR_TOOL_CALLS,
    maxBytes: MAX_REPAIR_TOOL_BYTES,
    perToolCalls: {
      read_failed_tex: 1,
      read_latex_log: 1,
      validate_candidate: 3,
      compile_candidate: 3,
    },
  });
  const validatedCandidates = new Set<string>();
  const compiledCandidates = new Set<string>();
  const readFailedTex = tool({
    name: "read_failed_tex",
    description: "Read the fixed failed TeX artifact.",
    parameters: ArtifactRequestSchema,
    strict: true,
    errorFunction: null,
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    timeoutBehavior: "raise_exception",
    execute: ({ artifactId }): string => {
      budget.begin("read_failed_tex", { artifactId });
      assertActive(attempt.signal);
      if (artifactId !== attempt.input.failedTexArtifactId) throw new Error("read_failed_tex received an unexpected artifact ID");
      budget.finish(attempt.input.failedTex);
      return attempt.input.failedTex;
    },
  });
  const readLatexLog = tool({
    name: "read_latex_log",
    description: "Read the fixed bounded LaTeX log artifact.",
    parameters: ArtifactRequestSchema,
    strict: true,
    errorFunction: null,
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    timeoutBehavior: "raise_exception",
    execute: ({ artifactId }): string => {
      budget.begin("read_latex_log", { artifactId });
      assertActive(attempt.signal);
      if (artifactId !== attempt.input.latexLogArtifactId) throw new Error("read_latex_log received an unexpected artifact ID");
      budget.finish(attempt.input.latexLog);
      return attempt.input.latexLog;
    },
  });
  const validateCandidate = tool({
    name: "validate_candidate",
    description: "Mechanically validate a repair candidate before compilation.",
    parameters: CandidateSchema,
    strict: true,
    errorFunction: null,
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    timeoutBehavior: "raise_exception",
    execute: async ({ tailoredTex }): Promise<RepairToolResult> => {
      if (Buffer.byteLength(tailoredTex) > 256 * 1024) throw new Error("repair candidate exceeds 256 KiB");
      budget.begin("validate_candidate", { tailoredTex });
      const toolSignal = AbortSignal.any([attempt.signal, AbortSignal.timeout(DEFAULT_TOOL_TIMEOUT_MS)]);
      assertActive(toolSignal);
      const result = await attempt.input.operations.validateCandidate(tailoredTex, toolSignal);
      assertActive(toolSignal);
      budget.finish(result);
      if (result.ok) validatedCandidates.add(tailoredTex);
      return result;
    },
  });
  const compileCandidate = tool({
    name: "compile_candidate",
    description: "Validate and compile a bounded repair candidate under the trusted compile policy.",
    parameters: CandidateSchema,
    strict: true,
    errorFunction: null,
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    timeoutBehavior: "raise_exception",
    execute: async ({ tailoredTex }): Promise<RepairToolResult> => {
      if (Buffer.byteLength(tailoredTex) > 256 * 1024) throw new Error("repair candidate exceeds 256 KiB");
      budget.begin("compile_candidate", { tailoredTex });
      if (!validatedCandidates.has(tailoredTex)) throw new Error("compile_candidate requires successful validation of the exact candidate");
      const toolSignal = AbortSignal.any([attempt.signal, AbortSignal.timeout(DEFAULT_TOOL_TIMEOUT_MS)]);
      assertActive(toolSignal);
      const result = await attempt.input.operations.compileCandidate(tailoredTex, toolSignal);
      assertActive(toolSignal);
      budget.finish(result);
      if (result.ok) compiledCandidates.add(tailoredTex);
      return result;
    },
  });
  const submission = createTerminalSubmission({
    name: "submit_repair",
    description: "Submit the terminal repair result exactly once after validation and candidate compilation.",
    schema: RepairResultSchema,
    sharedSubmitted: submitted,
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    assertActive: () => assertActive(attempt.signal),
    validate: (result) => {
      if (result.status === "repaired" && (result.tailoredTex === null || !compiledCandidates.has(result.tailoredTex))) {
        throw new Error("repaired submission must exactly match a successfully validated and compiled candidate");
      }
    },
  });
  const agent = new Agent({
    name: "resume-tex-repair",
    instructions: "Use only the fixed failed TeX, LaTeX log, and canonical baseline artifacts. Validate before compiling, remain within three candidate compiles, and call submit_repair exactly once.",
    model: MODEL_NAME,
    modelSettings: {
      reasoning: { effort: "medium" },
      parallelToolCalls: false,
      store: false,
      retry: { maxRetries: 0 },
    },
    tools: [readFailedTex, readLatexLog, validateCandidate, compileCandidate, submission.tool],
    handoffs: [],
    mcpServers: [],
    toolUseBehavior: { stopAtToolNames: [submission.name] },
    resetToolChoice: false,
  });
  const runner = createAttemptRunner(attempt.attemptSessionId, attempt.runtime);
  await runWithDeadline(runner, agent, modelInput, 9, attempt.signal, REPAIR_DEADLINE_MS);
  const result = submission.requireExactlyOne();
  return validateRepairResult(result, attempt.input.canonicalBaseline);
}
