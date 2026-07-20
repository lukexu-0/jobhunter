import { Runner, setTracingDisabled, type Agent, type ModelProvider } from "@openai/agents-core";
import { OAuthCodexModelProvider } from "../models/oauth-codex-provider.ts";

export const ATS_KEYWORD_EXTRACTION_DEADLINE_MS = 120_000;
export const ANALYSIS_DEADLINE_MS = 10 * 60 * 1_000;
export const REPAIR_DEADLINE_MS = 10 * 60 * 1_000;
export const TAILORING_DEADLINE_MS = 15 * 60 * 1_000;
export const EDIT_DEADLINE_MS = 15 * 60 * 1_000;
export const MAX_AGENT_INPUT_BYTES = 1024 * 1024;
export const MAX_AGENT_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

let tracingBootstrapped = false;

export function bootstrapAgentRuntime(): void {
  if (tracingBootstrapped) return;
  setTracingDisabled(true);
  tracingBootstrapped = true;
}

export interface AgentRunner {
  run(agent: Agent<unknown, "text">, input: string, options: { maxTurns: number; signal: AbortSignal }): Promise<unknown>;
}

export type ModelProviderFactory = (attemptSessionId: string) => ModelProvider;
export type AgentRunnerFactory = (config: {
  modelProvider: ModelProvider;
  tracingDisabled: true;
  toolExecution: { maxFunctionToolConcurrency: 1 };
}) => AgentRunner;

export interface AgentRuntimeDependencies {
  readonly providerFactory?: ModelProviderFactory;
  readonly runnerFactory?: AgentRunnerFactory;
}

function defaultProviderFactory(attemptSessionId: string): ModelProvider {
  return new OAuthCodexModelProvider(attemptSessionId);
}

function defaultRunnerFactory(config: {
  modelProvider: ModelProvider;
  tracingDisabled: true;
  toolExecution: { maxFunctionToolConcurrency: 1 };
}): AgentRunner {
  return new Runner(config);
}

export function createAttemptRunner(
  attemptSessionId: string,
  dependencies: AgentRuntimeDependencies = {},
): AgentRunner {
  bootstrapAgentRuntime();
  const provider = (dependencies.providerFactory ?? defaultProviderFactory)(attemptSessionId);
  return (dependencies.runnerFactory ?? defaultRunnerFactory)({
    modelProvider: provider,
    tracingDisabled: true,
    toolExecution: { maxFunctionToolConcurrency: 1 },
  });
}

export function boundedJson(value: unknown, label: string, maxBytes = MAX_AGENT_INPUT_BYTES): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} must be JSON serializable`, { cause: error });
  }
  if (serialized === undefined) throw new Error(`${label} must be JSON serializable`);
  if (Buffer.byteLength(serialized) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return serialized;
}

export function assertBoundedTranscript(result: unknown): void {
  if (result !== null && typeof result === "object") {
    const transcript = {
      rawResponses: "rawResponses" in result ? result.rawResponses : undefined,
      newItems: "newItems" in result ? result.newItems : undefined,
      finalOutput: "finalOutput" in result ? result.finalOutput : undefined,
    };
    boundedJson(transcript, "agent transcript", MAX_AGENT_TRANSCRIPT_BYTES);
    return;
  }
  boundedJson(result, "agent transcript", MAX_AGENT_TRANSCRIPT_BYTES);
}

export class AgentDeadlineError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`agent attempt exceeded ${deadlineMs}ms deadline`);
    this.name = "AgentDeadlineError";
  }
}

export async function runWithDeadline(
  runner: AgentRunner,
  agent: Agent<unknown, "text">,
  input: string,
  maxTurns: number,
  outerSignal: AbortSignal,
  deadlineMs: number,
): Promise<unknown> {
  if (outerSignal.aborted) throw outerSignal.reason ?? new DOMException("Aborted", "AbortError");
  const controller = new AbortController();
  const deadlineError = new AgentDeadlineError(deadlineMs);
  const gate = Promise.withResolvers<never>();
  const abortFromOuter = (): void => {
    const reason = outerSignal.reason ?? new DOMException("Aborted", "AbortError");
    controller.abort(reason);
    gate.reject(reason);
  };
  outerSignal.addEventListener("abort", abortFromOuter, { once: true });
  const timeout = globalThis.setTimeout(() => {
    controller.abort(deadlineError);
    gate.reject(deadlineError);
  }, deadlineMs);
  const runPromise = runner.run(agent, input, { maxTurns, signal: controller.signal });
  try {
    const result = await Promise.race([runPromise, gate.promise]);
    assertBoundedTranscript(result);
    return result;
  } catch (error) {
    if (controller.signal.aborted) await runPromise.then(() => undefined, () => undefined);
    if (controller.signal.reason === deadlineError) throw deadlineError;
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    outerSignal.removeEventListener("abort", abortFromOuter);
  }
}
