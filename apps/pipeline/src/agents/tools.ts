import { tool, type Tool } from "@openai/agents-core";
import { z } from "zod";

export const MAX_SUBMISSION_BYTES = 512 * 1024;
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export interface TerminalSubmission<T> {
  readonly tool: Tool<unknown>;
  readonly name: string;
  readonly count: () => number;
  readonly value: () => T | undefined;
  readonly requireExactlyOne: () => T;
}

export function createTerminalSubmission<S extends z.ZodObject>(options: {
  name: string;
  description: string;
  schema: S;
  sharedSubmitted?: { value: boolean };
  timeoutMs?: number;
  maxBytes?: number;
  assertActive?: () => void;
  validate?: (value: z.output<S>) => void;
}): TerminalSubmission<z.output<S>> {
  let calls = 0;
  let submittedValue: z.output<S> | undefined;
  const shared = options.sharedSubmitted ?? { value: false };
  const maxBytes = options.maxBytes ?? MAX_SUBMISSION_BYTES;
  const parameters: z.ZodObject = options.schema;
  const submitTool = tool({
    name: options.name,
    description: options.description,
    parameters,
    strict: true,
    errorFunction: null,
    timeoutMs: options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    timeoutBehavior: "raise_exception",
    execute: (input: unknown): z.output<S> => {
      options.assertActive?.();
      if (shared.value || calls !== 0) throw new Error(`${options.name} may be called exactly once`);
      // Zod's generic parse result is widened through the SDK-compatible object constraint.
      const parsed = options.schema.parse(input) as unknown as z.output<S>;
      const serialized = JSON.stringify(parsed);
      if (Buffer.byteLength(serialized) > maxBytes) throw new Error(`${options.name} submission exceeds ${maxBytes} bytes`);
      options.validate?.(parsed);
      calls++;
      shared.value = true;
      submittedValue = parsed;
      return parsed;
    },
  });
  return {
    tool: submitTool,
    name: options.name,
    count: () => calls,
    value: () => submittedValue,
    requireExactlyOne: (): z.output<S> => {
      if (calls !== 1 || submittedValue === undefined) throw new Error(`${options.name} requires exactly one validated terminal call`);
      return submittedValue;
    },
  };
}

export interface SequentialToolBudget {
  readonly begin: (toolName: string, input: unknown) => void;
  readonly finish: (output: unknown) => void;
  readonly counts: ReadonlyMap<string, number>;
  readonly totalCalls: () => number;
  readonly totalBytes: () => number;
}

export function createSequentialToolBudget(options: {
  sharedSubmitted: { value: boolean };
  maxCalls: number;
  maxBytes: number;
  perToolCalls: Readonly<Record<string, number>>;
}): SequentialToolBudget {
  const counts = new Map<string, number>();
  let calls = 0;
  let bytes = 0;
  return {
    counts,
    begin(toolName: string, input: unknown): void {
      if (options.sharedSubmitted.value) throw new Error(`${toolName} cannot be called after terminal submission`);
      if (calls >= options.maxCalls) throw new Error(`repair tool call budget of ${options.maxCalls} exhausted`);
      const nextForTool = (counts.get(toolName) ?? 0) + 1;
      const limit = options.perToolCalls[toolName];
      if (limit === undefined) throw new Error(`unknown repair tool ${toolName}`);
      if (nextForTool > limit) throw new Error(`${toolName} call budget of ${limit} exhausted`);
      const nextBytes = bytes + Buffer.byteLength(JSON.stringify(input));
      if (nextBytes > options.maxBytes) throw new Error(`repair tool byte budget of ${options.maxBytes} exhausted`);
      calls++;
      bytes = nextBytes;
      counts.set(toolName, nextForTool);
    },
    finish(output: unknown): void {
      const nextBytes = bytes + Buffer.byteLength(JSON.stringify(output));
      if (nextBytes > options.maxBytes) throw new Error(`repair tool byte budget of ${options.maxBytes} exhausted`);
      bytes = nextBytes;
    },
    totalCalls: () => calls,
    totalBytes: () => bytes,
  };
}
