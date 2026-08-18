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

class TerminalSubmissionValidationError extends Error {
  readonly validationCause: unknown;

  constructor(validationCause: unknown) {
    super("terminal submission validation failed");
    this.name = "TerminalSubmissionValidationError";
    this.validationCause = validationCause;
  }
}


export function createTerminalSubmission<S extends z.ZodObject>(options: {
  name: string;
  description: string;
  schema: S;
  sharedSubmitted?: { value: boolean };
  timeoutMs?: number | null;
  maxBytes?: number;
  assertActive?: () => void;
  validate?: (value: z.output<S>) => void | Promise<void>;
  formatValidationError?: (error: unknown) => string;
}): TerminalSubmission<z.output<S>> {
  let calls = 0;
  let submittedValue: z.output<S> | undefined;
  let validationInFlight = false;
  const shared = options.sharedSubmitted ?? { value: false };
  const maxBytes = options.maxBytes ?? MAX_SUBMISSION_BYTES;
  const parameters: z.ZodObject = options.schema;
  const formatValidationError = options.formatValidationError;
  const validate = options.validate;
  const submitTool = tool({
    name: options.name,
    description: options.description,
    parameters,
    strict: true,
    errorFunction: formatValidationError === undefined
      ? null
      : (_context, error): string => {
        const sdkInputValidationError = error && typeof error === "object" && "name" in error
          && error.name === "InvalidToolInputError";
        if (!(error instanceof TerminalSubmissionValidationError) && !sdkInputValidationError) throw error;
        return formatValidationError(error);
      },
    ...(options.timeoutMs === null
      ? {}
      : {
        timeoutMs: options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
        timeoutBehavior: "raise_exception" as const,
      }),
    execute: async (input: unknown): Promise<z.output<S>> => {
      options.assertActive?.();
      if (shared.value || calls !== 0 || validationInFlight) {
        throw new Error(`${options.name} may be called exactly once`);
      }
      // Zod's generic parse result is widened through the SDK-compatible object constraint.
      const parsed = options.schema.parse(input) as unknown as z.output<S>;
      const serialized = JSON.stringify(parsed);
      if (Buffer.byteLength(serialized) > maxBytes) {
        const sizeError = new Error(`${options.name} submission exceeds ${maxBytes} bytes`);
        if (formatValidationError === undefined) throw sizeError;
        throw new TerminalSubmissionValidationError(sizeError);
      }
      validationInFlight = true;
      try {
        await validate?.(parsed);
      } catch (error) {
        validationInFlight = false;
        if (formatValidationError === undefined) throw error;
        throw new TerminalSubmissionValidationError(error);
      }
      calls++;
      shared.value = true;
      submittedValue = parsed;
      validationInFlight = false;
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
  perToolCalls?: Readonly<Record<string, number>>;
  label?: string;
}): SequentialToolBudget {
  const counts = new Map<string, number>();
  let calls = 0;
  let bytes = 0;
  const label = options.label ?? "repair";
  return {
    counts,
    begin(toolName: string, input: unknown): void {
      if (options.sharedSubmitted.value) throw new Error(`${toolName} cannot be called after terminal submission`);
      if (calls >= options.maxCalls) throw new Error(`${label} tool call budget of ${options.maxCalls} exhausted`);
      const nextForTool = (counts.get(toolName) ?? 0) + 1;
      const limit = options.perToolCalls?.[toolName];
      if (limit !== undefined && nextForTool > limit) {
        throw new Error(`${toolName} call budget of ${limit} exhausted`);
      }
      const nextBytes = bytes + Buffer.byteLength(JSON.stringify(input));
      if (nextBytes > options.maxBytes) throw new Error(`${label} tool byte budget of ${options.maxBytes} exhausted`);
      calls++;
      bytes = nextBytes;
      counts.set(toolName, nextForTool);
    },
    finish(output: unknown): void {
      const nextBytes = bytes + Buffer.byteLength(JSON.stringify(output));
      if (nextBytes > options.maxBytes) throw new Error(`${label} tool byte budget of ${options.maxBytes} exhausted`);
      bytes = nextBytes;
    },
    totalCalls: () => calls,
    totalBytes: () => bytes,
  };
}
