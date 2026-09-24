import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import {
  Agent,
  RunContext,
  Usage,
  ToolCallError,
  type AgentInputItem,
  type Model,
  type ModelProvider,
  type Tool,
} from "@openai/agents-core";
import { ApplicationAgentFailure, ApplicationAgentRunInputSchema, MAX_APPLICATION_TASK_BYTES, type ApplicationAgentRunInput, type ApplicationAgentDependencies, type BrowserApplicationContext } from "../src/application/agent-runtime/contracts/application.ts";
import { ApplicationRunResultSchema } from "../src/application/application-runtime-client.ts";
import { runApplicationAgent } from "../src/application/agent-runtime/run.ts";
import {
  MAX_APPLICATION_MODEL_INPUT_BYTES,
} from "../src/application/agent-runtime/application-history.ts";
import {
  APPLICATION_AGENT_STEERING_PREFIX,
  ApplicationAgentSteeringInbox,
} from "../src/application/agent-runtime/application-agent-steering.ts";
import {
  GEMINI_LOCAL_COMPACTION_THRESHOLD_TOKENS,
  GeminiHistoryCompactor,
} from "../src/application/agent-runtime/application-compaction.ts";
import {
  ApplicationRuntimeError,
  type RuntimeActionRequest,
} from "../src/application/application-runtime-client.ts";
import {
  type AgentRunner,
  type AgentRunOptions,
} from "../src/application/agent-runtime/runner.ts";

const VALID_RESULT = {
  status: "ready_for_submission" as const,
  company: "Example Co",
  role: "Engineer",
  job_url: "https://jobs.example.test/role",
  final_url: "https://apply.example.test/form",
  fields_filled: [{
    label: "Name",
    field_type: "text" as const,
    value_present: true as const,
    note: "Filled",
  }],
  fields_needing_human: [],
  files_attached: ["resume.pdf"],
  warnings: [],
  revision_count: 0,
  submit_attempted: false as const,
};

const CANCELLED_RESULT = {
  ...VALID_RESULT,
  status: "cancelled" as const,
  warnings: ["Cancelled by the candidate"],
};
const PRE_SUBMISSION_EXECUTION_RESULT = {
  type: "playwright_cli_result" as const,
  exit_code: 0,
  stdout: "form inspected",
  stderr: "",
  stdout_truncated: false,
  stderr_truncated: false,
  cli_error_category: null,
  observation: {
    url: "https://apply.example.test/form",
    title: "Application",
    tabs: [],
    dom: "button Final submit",
    page_info: null,
    screenshot: { media_type: "image/png" as const, data: "cHJl" },
  },
};


const SUBMIT_EXECUTION_RESULT = {
  type: "playwright_cli_result" as const,
  exit_code: 0,
  stdout: "clicked submit",
  stderr: "",
  stdout_truncated: false,
  stderr_truncated: false,
  cli_error_category: null,
  observation: {
    url: "https://apply.example.test/confirmation",
    title: "Application received",
    tabs: [],
    dom: "main Application received",
    page_info: null,
    screenshot: { media_type: "image/png" as const, data: "cG9zdA==" },
  },
};

const VALID_SUBMITTED_RESULT = {
  ...VALID_RESULT,
  status: "submitted" as const,
  final_url: SUBMIT_EXECUTION_RESULT.observation.url,
  submit_attempted: true as const,
};


const RUN_INPUT: ApplicationAgentRunInput = {
  opportunityKind: "job",
  sessionId: "123e4567-e89b-42d3-a456-426614174000",
  runtimeUrl: "http://127.0.0.1:8765",
  task: "Fill the supplied application with direct candidate data.",
  deadlineMs: 60_000,
  autoSubmit: false,
};

const AUTHORITATIVE_TASK_ITEM = {
  role: "user",
  content: [{ type: "input_text", text: RUN_INPUT.task }],
} satisfies AgentInputItem;

const AUTO_SUBMIT_RUN_INPUT = {
  ...RUN_INPUT,
  autoSubmit: true,
};

function functionTool(agent: Agent<BrowserApplicationContext, "text">, name: string) {
  const candidate: Tool<BrowserApplicationContext> | undefined = agent.tools.find(
    (item) => item.type === "function" && item.name === name,
  );
  if (!candidate || candidate.type !== "function") throw new Error(`missing function tool ${name}`);
  return candidate;
}

function inspectedRunContext(
  context: BrowserApplicationContext | undefined,
): RunContext<BrowserApplicationContext> {
  if (!context) throw new Error("application context is required");
  context.playwrightCliCompleted = true;
  return new RunContext(context);
}

function fakeProvider(): ModelProvider {
  return { getModel(): Model { throw new Error("fake runner must not resolve a live model"); } };
}
type ApplicationAgentRun = (
  agent: Agent<BrowserApplicationContext, "text">,
  input: string | AgentInputItem[],
  options: AgentRunOptions<BrowserApplicationContext>,
) => Promise<unknown>;


function dependenciesWith(
  action: ApplicationAgentDependencies["runtimeClient"]["action"],
  run: ApplicationAgentRun,
  submissionGuard: ApplicationAgentDependencies["submissionGuard"] = {
    async markReviewReady(): Promise<void> {},
    async claim(): Promise<void> {},
    async finalize(): Promise<void> {},
  },
  steeringInbox?: ApplicationAgentDependencies["steeringInbox"],
): ApplicationAgentDependencies {
  return {
    runtimeClient: { action },
    submissionGuard,
    ...(steeringInbox === undefined ? {} : { steeringInbox }),
    providerFactory(attemptSessionId): ModelProvider {
      expect(attemptSessionId).toBe(RUN_INPUT.sessionId);
      return fakeProvider();
    },
    runnerFactory(config): AgentRunner {
      expect(config.tracingDisabled).toBe(true);
      expect(config.toolExecution.maxFunctionToolConcurrency).toBe(1);
      return {
        run<TContext>(
          agent: Agent<TContext, "text">,
          input: string | AgentInputItem[],
          options: AgentRunOptions<TContext>,
        ): Promise<unknown> {
          // This fake is installed only for runApplicationAgent, whose runner context is fixed.
          return run(
            agent as unknown as Agent<BrowserApplicationContext, "text">,
            input,
            options as unknown as AgentRunOptions<BrowserApplicationContext>,
          );
        },
      };
    },
  };
}

describe("application agent", () => {
  test("provides shared application guidance in every job mode", async () => {
    const stopMessage = "stop after inspecting standing answers";
    const instructionSets: string[] = [];

    for (const input of [RUN_INPUT, AUTO_SUBMIT_RUN_INPUT]) {
      const dependencies = dependenciesWith(
        async () => { throw new Error("unexpected runtime action"); },
        async (agent) => {
          instructionSets.push(String(agent.instructions));
          throw new Error(stopMessage);
        },
      );

      await expect(runApplicationAgent(
        input,
        new AbortController().signal,
        dependencies,
      )).rejects.toThrow(stopMessage);
    }

    expect(instructionSets).toHaveLength(2);
    for (const instructions of instructionSets) {
      expect(instructions).toContain("For date fields, use the exact date from supplied or saved answers and format it to match the form's required date format.");
      expect(instructions).toContain("relative or family member works for or is affiliated with the company, answer No");
      expect(instructions).toContain("previously interviewed with the company, answer No");
      expect(instructions).toContain("willing or able to relocate to the job location, answer Yes");
      expect(instructions).toContain("has or can secure housing near the job location, answer Yes");
      expect(instructions).toContain("has reliable transportation to the job location, answer Yes");
      expect(instructions).toContain("current or former employee, official, representative, contractor, or agent of any government or government entity, answer No");
      expect(instructions).toContain("other personal, professional, or family relationship or affiliation with any government or government official, answer No");
    }
  });
  test("retries a failed browser inspection inside the same agent run", async () => {
    let step = 0;
    let snapshots = 0;
    const model: Model = {
      async getResponse(request) {
        step += 1;
        if (step === 2) {
          expect(JSON.stringify(request.input)).toContain("browser_failed");
        }
        const call = step <= 2
          ? ["playwright_cli", { command: "snapshot", args: [] }] as const
          : ["request_human_review", { result: VALID_RESULT }] as const;
        if (step > 3) throw new Error("Runner continued after cancellation");
        return {
          usage: new Usage(),
          output: [{
            type: "function_call",
            callId: "call_" + step,
            name: call[0],
            arguments: JSON.stringify(call[1]),
            status: "completed",
          }],
          responseId: "response_" + step,
        };
      },
      async *getStreamedResponse() { throw new Error("Unexpected streaming"); },
    };

    const result = await runApplicationAgent(RUN_INPUT, new AbortController().signal, {
      providerFactory: () => ({ getModel: () => model }),
      runtimeClient: {
        async action(request) {
          if (request.type === "request_human_review") {
            return { type: "cancel", result: CANCELLED_RESULT };
          }
          if (request.type !== "playwright_cli" || request.command !== "snapshot") {
            throw new Error("Unexpected runtime action");
          }
          snapshots += 1;
          if (snapshots === 1) throw new ApplicationRuntimeError("browser_failed");
          return PRE_SUBMISSION_EXECUTION_RESULT;
        },
      },
      submissionGuard: {
        async markReviewReady() {},
        async claim() {},
        async finalize() {},
      },
    });

    expect(result).toEqual(CANCELLED_RESULT);
    expect(snapshots).toBe(2);
  });


  test("uses the matching handler to clear a persistent browser modal", async () => {
    const runtimeRequests: Array<Record<string, unknown>> = [];
    let step = 0;
    const calls = [
      ["playwright_cli", { command: "snapshot", args: [] }],
      ["playwright_cli", { command: "fill", args: ["e4", "value"] }],
      ["playwright_cli", { command: "upload", args: ["/private/session/resume.pdf"] }],
      ["playwright_cli", { command: "dialog-dismiss", args: [] }],
      ["playwright_cli", { command: "snapshot", args: [] }],
      ["request_human_review", { result: VALID_RESULT }],
    ] as const;
    const model: Model = {
      async getResponse(request) {
        if (step === 3) {
          expect(JSON.stringify(request.input)).toContain("modal_recovery_required");
        }
        const call = calls[step++];
        if (!call) throw new Error("Runner did not recover the pending file chooser");
        return {
          usage: new Usage(),
          output: [{
            type: "function_call",
            callId: "call_" + step,
            name: call[0],
            arguments: JSON.stringify(call[1]),
            status: "completed",
          }],
          responseId: "response_" + step,
        };
      },
      async *getStreamedResponse() { throw new Error("Unexpected streaming"); },
    };

    const result = await runApplicationAgent(RUN_INPUT, new AbortController().signal, {
      providerFactory: () => ({ getModel: () => model }),
      runtimeClient: {
        async action(request) {
          runtimeRequests.push(request);
          if (request.type === "request_human_review") {
            return { type: "cancel", result: CANCELLED_RESULT };
          }
          if (request.type !== "playwright_cli") throw new Error("Unexpected runtime action");
          if (
            request.command === "fill"
            || (request.command === "snapshot" && runtimeRequests.length === 1)
          ) {
            return {
              ...PRE_SUBMISSION_EXECUTION_RESULT,
              exit_code: 1,
              cli_error_category: "modal_blocked",
            };
          }
          if (request.command === "upload") {
            return {
              ...PRE_SUBMISSION_EXECUTION_RESULT,
              exit_code: 1,
              cli_error_category: "modal_handler_mismatch",
            };
          }
          return PRE_SUBMISSION_EXECUTION_RESULT;
        },
      },
      submissionGuard: {
        async markReviewReady() {},
        async claim() {},
        async finalize() {},
      },
    });

    expect(result).toEqual(CANCELLED_RESULT);
    expect(runtimeRequests).toEqual([
      { type: "playwright_cli", command: "snapshot", args: [] },
      { type: "playwright_cli", command: "fill", args: ["e4", "value"] },
      {
        type: "playwright_cli",
        command: "upload",
        args: ["/private/session/resume.pdf"],
      },
      { type: "playwright_cli", command: "dialog-dismiss", args: [] },
      { type: "playwright_cli", command: "snapshot", args: [] },
      { type: "request_human_review", result: VALID_RESULT },
    ]);
  });
  test("requires fresh inspection after a failed pre-submission browser command", async () => {
    const actions: string[] = [];
    let step = 0;
    const calls = [
      ["playwright_cli", { command: "snapshot", args: [] }],
      ["playwright_cli", { command: "upload", args: ["/tmp/resume.pdf"] }],
      ["playwright_cli", { command: "drop", args: ["e4", "--path=/tmp/resume.pdf"] }],
      ["playwright_cli", { command: "snapshot", args: [] }],
      ["request_human_review", { result: VALID_RESULT }],
    ] as const;
    const model: Model = {
      async getResponse(request) {
        if (step === 3) {
          expect(JSON.stringify(request.input)).toContain("inspection_required");
        }
        const call = calls[step++];
        if (!call) throw new Error("Runner continued after cancellation");
        return {
          usage: new Usage(),
          output: [{
            type: "function_call",
            callId: "call_" + step,
            name: call[0],
            arguments: JSON.stringify(call[1]),
            status: "completed",
          }],
          responseId: "response_" + step,
        };
      },
      async *getStreamedResponse() { throw new Error("Unexpected streaming"); },
    };

    const result = await runApplicationAgent(RUN_INPUT, new AbortController().signal, {
      providerFactory: () => ({ getModel: () => model }),
      runtimeClient: {
        async action(request) {
          if (request.type === "request_human_review") {
            return { type: "cancel", result: CANCELLED_RESULT };
          }
          if (request.type !== "playwright_cli") throw new Error("Unexpected runtime action");
          actions.push(request.command);
          if (request.command === "drop") throw new Error("Stale drop reached the runtime");
          if (request.command === "upload") {
            return {
              ...PRE_SUBMISSION_EXECUTION_RESULT,
              exit_code: 1,
              stderr: "Open a file chooser before uploading",
            };
          }
          return PRE_SUBMISSION_EXECUTION_RESULT;
        },
      },
      submissionGuard: {
        async markReviewReady() {},
        async claim() {},
        async finalize() {},
      },
    });

    expect(result).toEqual(CANCELLED_RESULT);
    expect(actions).toEqual(["snapshot", "upload", "snapshot"]);
  });
  test("recovers from a timed-out submit through snapshot, No, correction, and retry in one approved run", async () => {
    const ledger: string[] = [];
    const actions: string[] = [];
    const calls = [
      ["playwright_cli", { command: "snapshot", args: [] }],
      ["request_human_review", { result: VALID_RESULT }],
      ["playwright_cli", { command: "click", args: ["e9"] }],
      ["playwright_cli", { command: "snapshot", args: [] }],
      ["report_submission_outcome", { submitted: false }],
      ["playwright_cli", { command: "fill", args: ["e8", "corrected"] }],
      ["playwright_cli", { command: "click", args: ["e9"] }],
      ["report_submission_outcome", { submitted: true }],
    ] as const;
    let step = 0;
    let clicks = 0;
    const model: Model = {
      async getResponse(request) {
        if (step === 3) {
          expect(JSON.stringify(request.input)).toContain("tool_error");
          expect(JSON.stringify(request.input)).not.toContain("input_image");
          expect(ledger).toEqual(["approval", "claim"]);
        }
        if (step === 5) expect(ledger).toEqual(["approval", "claim"]);
        const call = calls[step++];
        if (!call) throw new Error("Runner continued after Yes");
        return {
          usage: new Usage(),
          output: [{ type: "function_call", callId: "call_" + step, name: call[0], arguments: JSON.stringify(call[1]), status: "completed" }],
          responseId: "response_" + step,
        };
      },
      async *getStreamedResponse() { throw new Error("Unexpected streaming"); },
    };
    const result = await runApplicationAgent(RUN_INPUT, new AbortController().signal, {
      providerFactory: () => ({ getModel: () => model }),
      runtimeClient: {
        async action(request) {
          if (request.type === "request_human_review") {
            ledger.push("approval");
            return { type: "submit", instruction: "You're good to submit.", result: VALID_RESULT };
          }
          if (request.type !== "playwright_cli") throw new Error("Unexpected runtime action");
          actions.push(request.command);
          if (request.command === "click" && ++clicks === 1) {
            throw new ApplicationRuntimeError("browser_failed");
          }
          return clicks < 2 ? PRE_SUBMISSION_EXECUTION_RESULT : SUBMIT_EXECUTION_RESULT;
        },
      },
      submissionGuard: {
        async markReviewReady() {},
        async claim() { ledger.push("claim"); },
        async finalize(outcome) { ledger.push("finalize:" + outcome); },
      },
    });
    expect(result).toEqual(VALID_SUBMITTED_RESULT);
    expect(actions).toEqual(["snapshot", "click", "snapshot", "fill", "click"]);
    expect(ledger).toEqual(["approval", "claim", "finalize:submitted"]);
  });

  test.each(["browser_failed", "invalid_response", "nonzero"] as const)("requires a successful snapshot after %s before actions or outcomes, without replaying an accepted submit", async (failure) => {
    const actions: string[] = [];
    const ledger: string[] = [];
    let snapshots = 0;
    const dependencies = dependenciesWith(
      async (request) => {
        if (request.type === "request_human_review") {
          return { type: "submit", instruction: "You're good to submit.", result: VALID_RESULT };
        }
        if (request.type !== "playwright_cli") throw new Error("Unexpected runtime action");
        actions.push(request.command);
        if (request.command === "click" && failure !== "nonzero") {
          throw new ApplicationRuntimeError(failure);
        }
        if (request.command === "snapshot" && ++snapshots === 2) return SUBMIT_EXECUTION_RESULT;
        return { ...PRE_SUBMISSION_EXECUTION_RESULT, exit_code: 1, stderr: "Timed out" };
      },
      async (agent, _input, options) => {
        const context = inspectedRunContext(options.context);
        const browser = functionTool(agent, "playwright_cli");
        const outcome = functionTool(agent, "report_submission_outcome");
        await functionTool(agent, "request_human_review").invoke(context, JSON.stringify({ result: VALID_RESULT }));
        await browser.invoke(context, JSON.stringify({ command: "click", args: ["e9"] }));
        for (const command of ["fill", "screenshot"]) {
          const rejected = await browser.invoke(context, JSON.stringify({ command, args: [] }));
          expect(JSON.parse(String(rejected))).toMatchObject({ type: "tool_error", code: "inspection_required" });
        }
        await outcome.invoke(context, JSON.stringify({ submitted: false }));
        await outcome.invoke(context, JSON.stringify({ submitted: true }));
        expect(ledger).toEqual(["claim"]);
        await browser.invoke(context, JSON.stringify({ command: "snapshot", args: [] }));
        const rejected = await browser.invoke(context, JSON.stringify({ command: "click", args: ["e9"] }));
        expect(JSON.parse(String(rejected))).toMatchObject({ type: "tool_error", code: "inspection_required" });
        await outcome.invoke(context, JSON.stringify({ submitted: true }));
        expect(ledger).toEqual(["claim"]);
        await browser.invoke(context, JSON.stringify({ command: "snapshot", args: [] }));
        await outcome.invoke(context, JSON.stringify({ submitted: true }));
        return { history: [] };
      },
      {
        async markReviewReady() {},
        async claim() { ledger.push("claim"); },
        async finalize(outcome) { ledger.push("finalize:" + outcome); },
      },
    );
    expect(await runApplicationAgent(RUN_INPUT, new AbortController().signal, dependencies)).toEqual(VALID_SUBMITTED_RESULT);
    expect(actions).toEqual(["click", "snapshot", "snapshot"]);
    expect(ledger).toEqual(["claim", "finalize:submitted"]);
  });

  test("keeps model tool definitions stable while early outcomes wait and No retries", async () => {
    const ledger: string[] = [];
    const actions: string[] = [];
    let clicks = 0;
    let step = 0;
    let toolDefinitions: string | undefined;
    const model: Model = {
      async getResponse(request) {
        const serialized = JSON.stringify(request.tools);
        if (toolDefinitions === undefined) {
          toolDefinitions = serialized;
          expect(request.tools.map((tool) => tool.name)).toEqual([
            "playwright_cli", "get_current_time", "read_user_info", "read_inbox", "read_email",
            "get_credentials", "request_human_navigation", "request_additional_info",
            "request_human_review", "report_application_mismatch", "report_submission_outcome",
          ]);
        } else {
          expect(serialized).toBe(toolDefinitions);
        }
        step++;
        let name: string;
        let args: object;
        switch (step) {
          case 1: case 4: case 7: case 10:
            name = "report_submission_outcome"; args = { submitted: true }; break;
          case 2:
            expect(ledger).toEqual([]);
            name = "playwright_cli"; args = { command: "snapshot", args: [] }; break;
          case 3:
            name = "request_human_review"; args = { result: VALID_RESULT }; break;
          case 5:
            expect(ledger).toEqual([]);
            name = "playwright_cli"; args = { command: "click", args: ["e9"] }; break;
          case 6:
            name = "report_submission_outcome"; args = { submitted: false }; break;
          case 8:
            expect(ledger).toEqual(["claim"]);
            name = "playwright_cli"; args = { command: "fill", args: ["e8", "corrected"] }; break;
          case 9:
            name = "playwright_cli"; args = { command: "click", args: ["e9"] }; break;
          default: throw new Error("Runner continued after Yes");
        }
        return {
          usage: new Usage(),
          output: [{ type: "function_call", callId: `call_${step}`, name, arguments: JSON.stringify(args), status: "completed" }],
          responseId: `response_${step}`,
        };
      },
      async *getStreamedResponse() { throw new Error("Unexpected streaming"); },
    };
    const result = await runApplicationAgent(RUN_INPUT, new AbortController().signal, {
      providerFactory: () => ({ getModel: () => model }),
      runtimeClient: {
        async action(request) {
          if (request.type === "request_human_review") {
            return { type: "submit", instruction: "You're good to submit.", result: VALID_RESULT };
          }
          if (request.type !== "playwright_cli") throw new Error("Unexpected runtime action");
          actions.push(request.command);
          if (request.command === "click") clicks++;
          return clicks < 2 ? PRE_SUBMISSION_EXECUTION_RESULT : {
            ...SUBMIT_EXECUTION_RESULT,
            observation: { ...SUBMIT_EXECUTION_RESULT.observation, dom: "main Applications dashboard" },
          };
        },
      },
      submissionGuard: {
        async markReviewReady() {},
        async claim() { ledger.push("claim"); },
        async finalize(outcome) { ledger.push(`finalize:${outcome}`); },
      },
    });
    expect(result).toEqual(VALID_SUBMITTED_RESULT);
    expect(actions).toEqual(["snapshot", "click", "fill", "click"]);
    expect(ledger).toEqual(["claim", "finalize:submitted"]);
    expect(step).toBe(10);
  });

  test("keeps the human-review tool compatible with Google string enums and strict at runtime", async () => {
    let runtimeCalls = 0;
    const result = await runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependenciesWith(
        async (request) => {
          runtimeCalls += 1;
          if (request.type !== "request_human_review") throw new Error("Unexpected runtime action");
          return { type: "cancel", result: CANCELLED_RESULT };
        },
        async (agent, _input, options) => {
          const review = functionTool(agent, "request_human_review");
          const incompatibleLiterals: string[] = [];
          const inspectSchema = (value: unknown, path: string): void => {
            if (Array.isArray(value)) {
              value.forEach((item, index) => inspectSchema(item, path + "[" + index + "]"));
              return;
            }
            if (value === null || typeof value !== "object") return;
            const record = value as Record<string, unknown>;
            if ("const" in record && typeof record.const !== "string") {
              incompatibleLiterals.push(path + ".const");
            }
            if (Array.isArray(record.enum) && record.enum.some((item) => typeof item !== "string")) {
              incompatibleLiterals.push(path + ".enum");
            }
            for (const [key, child] of Object.entries(record)) {
              if (key !== "const" && key !== "enum") inspectSchema(child, path + "." + key);
            }
          };
          inspectSchema(review.parameters, "$");
          expect(incompatibleLiterals).toEqual([]);

          const context = inspectedRunContext(options.context);
          const invalidResults = [
            {
              ...VALID_RESULT,
              fields_filled: [{ ...VALID_RESULT.fields_filled[0], value_present: false }],
            },
            {
              ...VALID_RESULT,
              fields_needing_human: [{ ...VALID_RESULT.fields_filled[0], value_present: true }],
            },
            { ...VALID_RESULT, submit_attempted: true },
          ];
          for (const invalidResult of invalidResults) {
            const rejected = await review.invoke(context, JSON.stringify({ result: invalidResult }));
            expect(JSON.parse(String(rejected))).toMatchObject({
              type: "tool_error",
              code: "invalid_request",
            });
          }
          return review.invoke(context, JSON.stringify({ result: VALID_RESULT }));
        },
      ),
    );
    expect(result).toEqual(CANCELLED_RESULT);
    expect(runtimeCalls).toBe(1);
  });

  test("accepts only the strict bounded run and result contracts", () => {
    const input: ApplicationAgentRunInput = {
      opportunityKind: "job",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      runtimeUrl: "http://127.0.0.1:8765",
      task: "Fill the supplied application.",
      deadlineMs: 60_000,
      autoSubmit: false,
    };
    expect(ApplicationAgentRunInputSchema.parse(input)).toEqual(input);
    expect(ApplicationAgentRunInputSchema.parse({ ...input, deadlineMs: null }))
      .toEqual({ ...input, deadlineMs: null });
    expect(ApplicationRunResultSchema.parse(VALID_SUBMITTED_RESULT)).toEqual(VALID_SUBMITTED_RESULT);
    expect(() => ApplicationAgentRunInputSchema.parse({ ...input, extra: true })).toThrow();
    const { autoSubmit: _autoSubmit, ...missingMode } = input;
    expect(() => ApplicationAgentRunInputSchema.parse(missingMode)).toThrow();
    expect(() => ApplicationAgentRunInputSchema.parse({ ...input, runtimeUrl: "https://example.test" })).toThrow();
    expect(ApplicationAgentRunInputSchema.parse({
      ...input,
      task: "x".repeat(MAX_APPLICATION_TASK_BYTES),
    }).task).toHaveLength(MAX_APPLICATION_TASK_BYTES);
    expect(() => ApplicationAgentRunInputSchema.parse({
      ...input,
      task: "x".repeat(MAX_APPLICATION_TASK_BYTES + 1),
    })).toThrow();
    expect(() => ApplicationAgentRunInputSchema.parse({
      ...input,
      task: "é".repeat(MAX_APPLICATION_TASK_BYTES / 2 + 1),
    })).toThrow();
    expect(() => ApplicationRunResultSchema.parse(VALID_RESULT)).toThrow();
    expect(() => ApplicationRunResultSchema.parse({
      ...VALID_SUBMITTED_RESULT,
      submit_attempted: false,
    })).toThrow();
    expect(() => ApplicationRunResultSchema.parse({ ...VALID_SUBMITTED_RESULT, extra: true })).toThrow();
  });

  test("reads the complete current user info without browser inspection", async () => {
    const firstUserInfo = JSON.stringify({
      version: 1,
      facts: [{ key: "location", value: "First city" }],
    });
    const secondUserInfo = JSON.stringify({
      version: 1,
      facts: [{ key: "location", value: "Second city" }],
    });
    const runtimeRequests: RuntimeActionRequest[] = [];
    let currentUserInfo = firstUserInfo;
    const stopMessage = "stop after user info reads";
    const dependencies = dependenciesWith(
      async (request) => {
        runtimeRequests.push(request);
        if (request.type !== "read_user_info") {
          throw new Error(`unexpected runtime action ${request.type}`);
        }
        return {
          type: "read_user_info_result",
          content: currentUserInfo,
        };
      },
      async (agent, _input, options) => {
        if (!options.context) throw new Error("application context is required");
        const readUserInfo = functionTool(agent, "read_user_info");
        const runContext = new RunContext(options.context);

        expect(await readUserInfo.invoke(runContext, "{}"))
          .toBe(firstUserInfo);
        currentUserInfo = secondUserInfo;
        expect(await readUserInfo.invoke(runContext, "{}"))
          .toBe(secondUserInfo);
        expect(options.context.playwrightCliCompleted).toBe(false);
        throw new Error(stopMessage);
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toThrow(stopMessage);
    expect(runtimeRequests).toEqual([
      { type: "read_user_info" },
      { type: "read_user_info" },
    ]);
  });

  test("exposes inbox search and MIME email reads without browser inspection", async () => {
    const runtimeRequests: RuntimeActionRequest[] = [];
    const stopMessage = "stop after inbox tools";
    const dependencies = dependenciesWith(
      async (request) => {
        runtimeRequests.push(request);
        if (request.type === "read_inbox") {
          if (request.query === "missing") {
            return { type: "read_inbox_result", messages: [], truncated: true };
          }
          return {
            type: "read_inbox_result",
            messages: [{
              email_id: "message_1-abc",
              subject: "Your verification code",
              sent_at: "2026-08-30T14:22:03Z",
            }],
            truncated: true,
          };
        }
        if (request.type === "read_email") {
          return request.offset === 51_000
            ? { type: "read_email_result", content: "continued MIME content" }
            : {
                type: "read_email_result",
                content: [
                  "first MIME chunk",
                  '[Output limited to 50 KB. Call read_email again with email_id "message_1-abc" and offset 51000 to continue.]',
                ].join("\n"),
              };
        }
        throw new Error(`unexpected runtime action ${request.type}`);
      },
      async (agent, _input, options) => {
        if (!options.context) throw new Error("application context is required");
        const runContext = new RunContext(options.context);
        const readInbox = functionTool(agent, "read_inbox");
        const readEmail = functionTool(agent, "read_email");
        const getCurrentTime = functionTool(agent, "get_current_time");
        expect(options.context.playwrightCliCompleted).toBe(false);
        expect(await readInbox.invoke(
          runContext,
          JSON.stringify({
            query: "   ",
            received_within_minutes: 30,
            received_before_minutes_ago: 15,
          }),
        )).toBe([
          JSON.stringify({
            sent_time: "2026-08-30T14:22:03Z",
            email_id: "message_1-abc",
            subject: "Your verification code",
          }),
          "[Output limited to 50 emails. Refine date, time, received_within_minutes, received_before_minutes_ago, or query and call read_inbox again.]",
        ].join("\n"));
        expect(await readInbox.invoke(
          runContext,
          JSON.stringify({ query: "missing" }),
        )).toBe([
          "No matching emails. If you expect a new email, it may take up to one minute to arrive. Wait and retry read_inbox with filters that include newly arrived messages for up to one minute before requesting human navigation.",
          "[Output limited to 50 emails. Refine date, time, received_within_minutes, received_before_minutes_ago, or query and call read_inbox again.]",
        ].join("\n"));
        expect(await readEmail.invoke(
          runContext,
          JSON.stringify({ email_id: "message_1-abc" }),
        )).toBe([
          "first MIME chunk",
          '[Output limited to 50 KB. Call read_email again with email_id "message_1-abc" and offset 51000 to continue.]',
        ].join("\n"));
        expect(await readEmail.invoke(
          runContext,
          JSON.stringify({ email_id: "message_1-abc", offset: 51_000 }),
        )).toBe("continued MIME content");
        setSystemTime(new Date("2026-08-30T15:04:05.678Z"));
        try {
          expect(await getCurrentTime.invoke(runContext, "{}"))
            .toBe('{"utc_time":"2026-08-30T15:04:05.678Z"}');
        } finally {
          setSystemTime();
        }
        throw new Error(stopMessage);
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toThrow(stopMessage);
    expect(runtimeRequests).toEqual([
      {
        type: "read_inbox",
        query: "code",
        received_within_minutes: 30,
        received_before_minutes_ago: 15,
      },
      { type: "read_inbox", query: "missing" },
      { type: "read_email", email_id: "message_1-abc", offset: 0 },
      { type: "read_email", email_id: "message_1-abc", offset: 51_000 },
    ]);
  });

  test("keeps the agent running when Gmail verification is unavailable", async () => {
    const warning = "Gmail verification is unavailable. Complete the verification in the headed browser manually, or connect Gmail in Credentials and retry the inbox action.";
    const runtimeRequests: RuntimeActionRequest[] = [];
    const stopMessage = "stop after recoverable Gmail results";
    const dependencies = dependenciesWith(
      async (request) => {
        runtimeRequests.push(request);
        if (request.type === "read_inbox" || request.type === "read_email") {
          return { type: "gmail_unavailable", message: warning };
        }
        throw new Error("unexpected runtime action " + request.type);
      },
      async (agent, _input, options) => {
        if (!options.context) throw new Error("application context is required");
        const runContext = new RunContext(options.context);
        const readInbox = functionTool(agent, "read_inbox");
        const readEmail = functionTool(agent, "read_email");

        expect(await readInbox.invoke(
          runContext,
          JSON.stringify({ query: "verification code" }),
        )).toBe(warning);
        expect(await readEmail.invoke(
          runContext,
          JSON.stringify({ email_id: "message_1-abc" }),
        )).toBe(warning);
        throw new Error(stopMessage);
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toThrow(stopMessage);
    expect(runtimeRequests).toEqual([
      { type: "read_inbox", query: "verification code" },
      { type: "read_email", email_id: "message_1-abc", offset: 0 },
    ]);
  });

  test("treats every interrupted human gate as a normal tool result", async () => {
    const interruptionMessage =
      "Operator guidance interrupted the pending action. Follow the latest operator guidance before continuing.";
    const cases = [
      {
        toolName: "request_human_navigation",
        actionType: "request_human_navigation",
        input: { instruction: "Complete the public checkpoint." },
      },
      {
        toolName: "request_additional_info",
        actionType: "request_additional_info",
        input: {
          questions: [{
            id: "availability",
            key: "availability.start_date",
            scope: "global",
            question: "When can you start?",
            answer_type: "text",
          }],
        },
      },
      {
        toolName: "request_human_review",
        actionType: "request_human_review",
        input: { result: VALID_RESULT },
      },
    ] as const;

    for (const gateCase of cases) {
      const runtimeRequests: RuntimeActionRequest[] = [];
      const stopMessage = `stop after ${gateCase.toolName}`;
      const dependencies = dependenciesWith(
        async (request) => {
          runtimeRequests.push(request);
          return { type: "interrupted" };
        },
        async (agent, _input, options) => {
          const context = options.context;
          if (!context) throw new Error("application context is required");
          const output = await functionTool(agent, gateCase.toolName).invoke(
            inspectedRunContext(context),
            JSON.stringify(gateCase.input),
          );
          expect(output).toBe(interruptionMessage);
          throw new Error(stopMessage);
        },
      );

      await expect(runApplicationAgent(
        RUN_INPUT,
        new AbortController().signal,
        dependencies,
      )).rejects.toThrow(stopMessage);
      expect(runtimeRequests).toHaveLength(1);
      expect(runtimeRequests[0]?.type).toBe(gateCase.actionType);
    }
  });


  test("drops non-serializable prior transcript content without masking the outcome", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const dependencies = dependenciesWith(
      async (request) => {
        expect(request).toEqual({ type: "report_application_mismatch" });
        return { type: "application_mismatch" };
      },
      async (agent, _input, options) => {
        await functionTool(agent, "report_application_mismatch").invoke(
          inspectedRunContext(options.context),
          "{}",
        );
        return {
          history: [],
          rawResponses: [circular],
          newItems: [],
          finalOutput: "Application mismatch.",
        };
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("APPLICATION_MISMATCH"));
  });

  test("rebuilds invalid model history from the task and recent messages", async () => {
    const malformed = {
      role: "assistant",
      content: [{ type: "output_text", text: "stale response" }],
      providerData: { unexpected: true },
    } as unknown as AgentInputItem;
    const dependencies = dependenciesWith(
      async (request) => {
        expect(request).toEqual({ type: "report_application_mismatch" });
        return { type: "application_mismatch" };
      },
      async (agent, _input, options) => {
        const context = options.context;
        const filter = options.callModelInputFilter;
        if (context === undefined || filter === undefined) {
          throw new Error("application model filter context is required");
        }
        const filtered = await filter({
          agent: agent as unknown as Parameters<typeof filter>[0]["agent"],
          context,
          modelData: {
            input: [
              { role: "user", content: [{ type: "input_text", text: "obsolete" }] },
              malformed,
              { role: "user", content: [{ type: "input_text", text: "The modal is closed." }] },
            ],
          },
        });
        const serialized = JSON.stringify(filtered.input);
        expect(serialized).toContain(RUN_INPUT.task);
        expect(serialized).toContain("The modal is closed.");
        expect(serialized).toContain("Earlier application history could not be reused");
        expect(serialized).not.toContain("stale response");
        await functionTool(agent, "report_application_mismatch").invoke(
          inspectedRunContext(context),
          "{}",
        );
        return {
          history: filtered.input,
          rawResponses: [],
          newItems: [],
          finalOutput: "Application mismatch.",
        };
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("APPLICATION_MISMATCH"));
  });

  test("continues from durable history when Gemini compaction fails", async () => {
    let compactionCalls = 0;
    class FailingCompactor extends GeminiHistoryCompactor {
      override async project(): Promise<AgentInputItem[]> {
        compactionCalls += 1;
        throw new Error("compaction unavailable");
      }
    }
    const baseDependencies = dependenciesWith(
      async (request) => {
        expect(request).toEqual({ type: "report_application_mismatch" });
        return { type: "application_mismatch" };
      },
      async (agent, _input, options) => {
        const context = options.context;
        const filter = options.callModelInputFilter;
        if (context === undefined || filter === undefined) {
          throw new Error("application model filter context is required");
        }
        const filtered = await filter({
          agent: agent as unknown as Parameters<typeof filter>[0]["agent"],
          context,
          modelData: {
            input: [{
              role: "user",
              content: [{ type: "input_text", text: "The browser is still on the application." }],
            }],
          },
        });
        const serialized = JSON.stringify(filtered.input);
        expect(serialized).toContain(RUN_INPUT.task);
        expect(serialized).toContain("The browser is still on the application.");
        expect(serialized).toContain("Earlier application history could not be reused");
        await functionTool(agent, "report_application_mismatch").invoke(
          inspectedRunContext(context),
          "{}",
        );
        return {
          history: filtered.input,
          rawResponses: [],
          newItems: [],
          finalOutput: "Application mismatch.",
        };
      },
    );
    const dependencies: ApplicationAgentDependencies = {
      ...baseDependencies,
      applicationModel: {
        modelProvider: "google-antigravity",
        model: "gemini-3.8-flash",
        reasoning: "high",
      },
      historyCompactorFactory: (sessionId) => new FailingCompactor(sessionId),
    };

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("APPLICATION_MISMATCH"));
    expect(compactionCalls).toBe(1);
  });

  test("omits an oversized transient screenshot but still appends a small screenshot", async () => {
    const projectedInput = [{
      role: "user",
      content: [{
        type: "input_text",
        text: "The application form has a name field and a résumé upload.",
      }],
    }] satisfies AgentInputItem[];
    const smallScreenshotDataUrl = "data:image/png;base64,cHJl";
    const dependencies = dependenciesWith(
      async () => {
        throw new Error("runtime actions must not run");
      },
      async (agent, _input, options) => {
        const context = options.context;
        if (context === undefined) {
          throw new Error("application context is required");
        }
        const callModelInputFilter = options.callModelInputFilter;
        if (callModelInputFilter === undefined) {
          throw new Error("application input filter is required");
        }
        context.latestScreenshotDataUrl =
          `data:image/png;base64,${"A".repeat(MAX_APPLICATION_MODEL_INPUT_BYTES)}`;
        const oversizedFiltered = await callModelInputFilter({
          agent: agent as unknown as Parameters<typeof callModelInputFilter>[0]["agent"],
          context,
          modelData: { input: projectedInput },
        });
        expect(oversizedFiltered.input).toEqual([AUTHORITATIVE_TASK_ITEM, ...projectedInput]);
        expect(oversizedFiltered.input).not.toContainEqual({
          role: "user",
          content: [expect.objectContaining({ type: "input_image" })],
        });
        expect(Buffer.byteLength(JSON.stringify(oversizedFiltered.input))).toBeLessThanOrEqual(
          MAX_APPLICATION_MODEL_INPUT_BYTES,
        );

        context.latestScreenshotDataUrl = smallScreenshotDataUrl;
        const smallFiltered = await callModelInputFilter({
          agent: agent as unknown as Parameters<typeof callModelInputFilter>[0]["agent"],
          context,
          modelData: { input: projectedInput },
        });
        expect(smallFiltered.input).toEqual([
          AUTHORITATIVE_TASK_ITEM,
          ...projectedInput,
          {
            role: "user",
            content: [{ type: "input_image", image: smallScreenshotDataUrl }],
          },
        ]);
        expect(smallFiltered.input.at(-1)).toEqual({
          role: "user",
          content: [{ type: "input_image", image: smallScreenshotDataUrl }],
        });
        throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("MODEL_PROVIDER_FAILED"));
  });
  test("bounds Gemini screenshots and counts function schemas at 252k", async () => {
    const compactionContexts: number[] = [];
    class RecordingCompactor extends GeminiHistoryCompactor {
      override async project(
        input: AgentInputItem[],
        contextTokens?: number,
        _signal?: AbortSignal,
      ): Promise<AgentInputItem[]> {
        if (contextTokens !== undefined) compactionContexts.push(contextTokens);
        return input;
      }
    }
    const compactor = new RecordingCompactor("screenshot-threshold");
    const projectedInput = [{
      role: "user",
      content: [{ type: "input_text", text: "Inspect the visible application form." }],
    }] satisfies AgentInputItem[];
    const baseDependencies = dependenciesWith(
      async () => {
        throw new Error("runtime actions must not run");
      },
      async (agent, _input, options) => {
        const context = options.context;
        const filter = options.callModelInputFilter;
        if (context === undefined || filter === undefined) {
          throw new Error("application model filter context is required");
        }
        context.latestScreenshotDataUrl = `data:image/png;base64,${"A".repeat(3_000_000)}`;
        const filtered = await filter({
          agent: agent as unknown as Parameters<typeof filter>[0]["agent"],
          context,
          modelData: { input: projectedInput },
        });
        expect(filtered.input).toEqual([AUTHORITATIVE_TASK_ITEM, ...projectedInput]);
        expect(compactionContexts).toHaveLength(1);
        expect(compactionContexts[0]).toBeGreaterThan(GEMINI_LOCAL_COMPACTION_THRESHOLD_TOKENS);
        delete context.latestScreenshotDataUrl;
        agent.tools.push({
          type: "function",
          name: "large_schema",
          description: "x".repeat(3_000_000),
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: true,
        } as unknown as Tool<BrowserApplicationContext>);
        const toolFiltered = await filter({
          agent: agent as unknown as Parameters<typeof filter>[0]["agent"],
          context,
          modelData: { input: projectedInput },
        });
        expect(toolFiltered.input).toEqual([AUTHORITATIVE_TASK_ITEM, ...projectedInput]);
        expect(compactionContexts).toHaveLength(2);
        expect(compactionContexts[1]).toBeGreaterThan(GEMINI_LOCAL_COMPACTION_THRESHOLD_TOKENS);
        throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
      },
    );
    const dependencies: ApplicationAgentDependencies = {
      ...baseDependencies,
      applicationModel: {
        modelProvider: "google-antigravity",
        model: "gemini-3.8-flash",
        reasoning: "high",
      },
      historyCompactorFactory: () => compactor,
    };

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("MODEL_PROVIDER_FAILED"));
  });
  test("evaluates Gemini compaction after pruning browser history", async () => {
    let summaryCalls = 0;
    const compactionInputs: AgentInputItem[][] = [];
    class RecordingCompactor extends GeminiHistoryCompactor {
      override async project(
        input: AgentInputItem[],
        contextTokens?: number,
        signal?: AbortSignal,
      ): Promise<AgentInputItem[]> {
        compactionInputs.push(input);
        return super.project(input, contextTokens, signal);
      }
    }
    const rawInput: AgentInputItem[] = [];
    for (let index = 0; index < 17; index += 1) {
      const callId = `browser-${index}`;
      rawInput.push(
        {
          type: "function_call",
          name: "playwright_cli",
          callId,
          arguments: "{}",
          status: "completed",
          providerData: { thoughtSignature: `signature-${index}` },
        },
        {
          type: "function_call_result",
          name: "playwright_cli",
          callId,
          output: index === 0 ? "x".repeat(3_000_000) : "ok",
          status: "completed",
        },
      );
    }
    const baseDependencies = dependenciesWith(
      async () => {
        throw new Error("runtime actions must not run");
      },
      async (agent, _input, options) => {
        const context = options.context;
        const filter = options.callModelInputFilter;
        if (context === undefined || filter === undefined) {
          throw new Error("application model filter context is required");
        }
        const filtered = await filter({
          agent: agent as unknown as Parameters<typeof filter>[0]["agent"],
          context,
          modelData: { input: rawInput },
        });
        expect(compactionInputs).toHaveLength(1);
        expect(compactionInputs[0]).toHaveLength(34);
        expect(compactionInputs[0]).not.toContainEqual(expect.objectContaining({
          type: "function_call_result",
          callId: "browser-0",
        }));
        expect(summaryCalls).toBe(0);
        expect(filtered.input).toHaveLength(34);
        expect(filtered.input).not.toContainEqual(expect.objectContaining({
          type: "function_call_result",
          callId: "browser-0",
        }));
        throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
      },
    );
    const dependencies: ApplicationAgentDependencies = {
      ...baseDependencies,
      applicationModel: {
        modelProvider: "google-antigravity",
        model: "gemini-3.8-flash",
        reasoning: "high",
      },
      historyCompactorFactory: (sessionId) => new RecordingCompactor(sessionId, {
        apiKey: "test-key",
        completeImpl: async () => {
          summaryCalls += 1;
          throw new Error("pruned history must not trigger compaction");
        },
      }),
    };

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("MODEL_PROVIDER_FAILED"));
    expect(summaryCalls).toBe(0);
  });

  test("appends queued guidance in FIFO order before the screenshot and consumes each batch once", async () => {
    const inbox = new ApplicationAgentSteeringInbox();
    expect(inbox.enqueue("Use the distributed-systems example.")).toBeTrue();
    expect(inbox.enqueue("Keep the answer under 100 words.")).toBeTrue();
    const projectedInput = [{
      role: "user",
      content: [{ type: "input_text", text: "Projected application history." }],
    }] satisfies AgentInputItem[];
    const immutableProjectedInput = structuredClone(projectedInput);
    const screenshot = "data:image/png;base64,cHJl";
    const dependencies = dependenciesWith(
      async () => {
        throw new Error("runtime actions must not run");
      },
      async (agent, _input, options) => {
        const context = options.context;
        const filter = options.callModelInputFilter;
        if (context === undefined || filter === undefined) {
          throw new Error("application model filter context is required");
        }
        context.latestScreenshotDataUrl = screenshot;
        const first = await filter({
          agent: agent as unknown as Parameters<typeof filter>[0]["agent"],
          context,
          modelData: { input: projectedInput },
        });
        expect(first.input).toEqual([
          AUTHORITATIVE_TASK_ITEM,
          ...projectedInput,
          {
            role: "user",
            content: [{
              type: "input_text",
              text: APPLICATION_AGENT_STEERING_PREFIX + "Use the distributed-systems example.",
            }],
          },
          {
            role: "user",
            content: [{
              type: "input_text",
              text: APPLICATION_AGENT_STEERING_PREFIX + "Keep the answer under 100 words.",
            }],
          },
          {
            role: "user",
            content: [{ type: "input_image", image: screenshot }],
          },
        ]);
        expect(projectedInput).toEqual(immutableProjectedInput);
        expect(inbox.snapshot()).toBeUndefined();

        expect(inbox.enqueue("Use a neutral tone.")).toBeTrue();
        delete context.latestScreenshotDataUrl;
        const second = await filter({
          agent: agent as unknown as Parameters<typeof filter>[0]["agent"],
          context,
          modelData: { input: projectedInput },
        });
        expect(second.input).toEqual([
          AUTHORITATIVE_TASK_ITEM,
          ...projectedInput,
          {
            role: "user",
            content: [{
              type: "input_text",
              text: APPLICATION_AGENT_STEERING_PREFIX + "Use a neutral tone.",
            }],
          },
        ]);
        expect(inbox.snapshot()).toBeUndefined();
        throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
      },
      undefined,
      inbox,
    );

    const failure = await runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    ).catch((error: unknown) => error);
    expect(failure).toEqual(new ApplicationAgentFailure("MODEL_PROVIDER_FAILED"));
    expect(String(failure)).not.toContain("distributed-systems");
    expect(JSON.stringify(RUN_INPUT)).not.toContain("distributed-systems");
  });

  test("fails closed on guidance transcript overflow without consuming the pending batch", async () => {
    const privateMessage = "PRIVATE OPERATOR GUIDANCE";
    const inbox = new ApplicationAgentSteeringInbox();
    expect(inbox.enqueue(privateMessage)).toBeTrue();
    const emptyProjectedInput = [
      AUTHORITATIVE_TASK_ITEM,
      {
        role: "user",
        content: [{ type: "input_text", text: "" }],
      },
    ] satisfies AgentInputItem[];
    const fixedBytes = Buffer.byteLength(JSON.stringify(emptyProjectedInput), "utf8");
    const projectedInput = [
      AUTHORITATIVE_TASK_ITEM,
      {
        role: "user",
        content: [{
          type: "input_text",
          text: "x".repeat(MAX_APPLICATION_MODEL_INPUT_BYTES - fixedBytes),
        }],
      },
    ] satisfies AgentInputItem[];
    expect(Buffer.byteLength(JSON.stringify(projectedInput), "utf8"))
      .toBe(MAX_APPLICATION_MODEL_INPUT_BYTES);
    const dependencies = dependenciesWith(
      async () => {
        throw new Error("runtime actions must not run");
      },
      async (agent, _input, options) => {
        const context = options.context;
        const filter = options.callModelInputFilter;
        if (context === undefined || filter === undefined) {
          throw new Error("application model filter context is required");
        }
        let filterFailure: unknown;
        try {
          await filter({
            agent: agent as unknown as Parameters<typeof filter>[0]["agent"],
            context,
            modelData: { input: projectedInput },
          });
        } catch (error) {
          filterFailure = error;
        }
        expect(filterFailure).toEqual(
          new ApplicationAgentFailure("MODEL_PROVIDER_FAILED"),
        );
        expect(String(filterFailure)).not.toContain(privateMessage);
        expect(inbox.snapshot()?.messages).toEqual([privateMessage]);
        throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
      },
      undefined,
      inbox,
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("MODEL_PROVIDER_FAILED"));
    expect(inbox.snapshot()?.messages).toEqual([privateMessage]);
  });

  test("closes and drops steering synchronously when the first submission action starts", async () => {
    const privateMessage = "PRIVATE GUIDANCE QUEUED DURING THE PRIOR MODEL TURN";
    const inbox = new ApplicationAgentSteeringInbox();
    const claimStarted = Promise.withResolvers<void>();
    const releaseClaim = Promise.withResolvers<void>();
    const projectedInput = [{
      role: "user",
      content: [{ type: "input_text", text: "Projected pre-submission history." }],
    }] satisfies AgentInputItem[];
    const dependencies = dependenciesWith(
      async (request) => {
        if (request.type === "request_human_review") {
          return {
            type: "submit",
            instruction: "You're good to submit.",
            result: VALID_RESULT,
          };
        }
        if (request.type === "playwright_cli" && request.command === "click") {
          return SUBMIT_EXECUTION_RESULT;
        }
        throw new Error(`unexpected runtime action ${request.type}`);
      },
      async (agent, _input, options) => {
        const context = options.context;
        const filter = options.callModelInputFilter;
        if (context === undefined || filter === undefined) {
          throw new Error("application model filter context is required");
        }
        const preClaim = await filter({
          agent: agent as unknown as Parameters<typeof filter>[0]["agent"],
          context,
          modelData: { input: projectedInput },
        });
        expect(preClaim.input).toEqual([AUTHORITATIVE_TASK_ITEM, ...projectedInput]);
        expect(inbox.enqueue(privateMessage)).toBeTrue();
        expect(inbox.snapshot()?.messages).toEqual([privateMessage]);

        const runContext = inspectedRunContext(context);
        await functionTool(agent, "request_human_review").invoke(
          runContext,
          JSON.stringify({ result: VALID_RESULT }),
        );
        const submissionAction = functionTool(agent, "playwright_cli").invoke(
          runContext,
          JSON.stringify({ command: "click", args: ["e9"] }),
        );
        await claimStarted.promise;

        expect(context.submissionActionStarted).toBeTrue();
        expect(context.submissionClaimed).toBeFalse();
        expect(inbox.snapshot()).toBeUndefined();
        expect(inbox.enqueue("late guidance")).toBeFalse();

        releaseClaim.resolve();
        await submissionAction;
        const postClaim = await filter({
          agent: agent as unknown as Parameters<typeof filter>[0]["agent"],
          context,
          modelData: { input: projectedInput },
        });
        expect(JSON.stringify(postClaim.input)).not.toContain(privateMessage);
        expect(JSON.stringify(postClaim.input)).not.toContain("late guidance");
        throw new Error("stop after observing the post-claim model input");
      },
      {
        async markReviewReady(): Promise<void> {},
        async claim(): Promise<void> {
          claimStarted.resolve();
          await releaseClaim.promise;
        },
        async finalize(): Promise<void> {},
      },
      inbox,
    );

    await expect(runApplicationAgent(
      AUTO_SUBMIT_RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toThrow("stop after observing the post-claim model input");
    expect(inbox.enqueue("after run")).toBeFalse();
  });

  test("rebuilds malformed final history and continues the model", async () => {
    let runnerCalls = 0;
    const dependencies = dependenciesWith(
      async (request) => {
        expect(request).toEqual({ type: "report_application_mismatch" });
        return { type: "application_mismatch" };
      },
      async (agent, runInput, options) => {
        runnerCalls += 1;
        if (runnerCalls === 1) return { history: [null] };
        expect(JSON.stringify(runInput)).toContain(RUN_INPUT.task);
        expect(JSON.stringify(runInput)).toContain("Earlier application history could not be reused");
        const context = options.context;
        if (context === undefined) throw new Error("application context is required");
        await functionTool(agent, "report_application_mismatch").invoke(
          inspectedRunContext(context),
          "{}",
        );
        return {
          history: runInput,
          rawResponses: [],
          newItems: [],
          finalOutput: "Application mismatch.",
        };
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("APPLICATION_MISMATCH"));
    expect(runnerCalls).toBe(2);
  });

  test("enables structured additional information only after a completed browser action", async () => {
    const acceptedAnswers = [
      {
        id: "summer_availability",
        key: "availability.summer_2027",
        scope: "global" as const,
        answer_type: "text" as const,
        status: "answered" as const,
        value: "June through August 2027",
      },
      {
        id: "referral",
        key: "referral.source",
        scope: "application" as const,
        answer_type: "single_select" as const,
        status: "declined" as const,
      },
    ];
    const runtimeRequests: unknown[] = [];
    const dependencies = dependenciesWith(
      async (request) => {
        runtimeRequests.push(request);
        if (request.type === "playwright_cli") {
          return {
            type: "playwright_cli_result",
            exit_code: 0,
            stdout: "",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            cli_error_category: null,
            observation: {
              url: "https://apply.example.test/form",
              title: "Application",
              tabs: [],
              dom: "input Summer availability",
              page_info: null,
              screenshot: null,
            },
          };
        }
        if (request.type === "request_additional_info") {
          return { type: "additional_info", answers: acceptedAnswers };
        }
        if (request.type === "request_human_review") {
          return { type: "cancel", result: CANCELLED_RESULT };
        }
        throw new Error(`unexpected runtime action ${request.type}`);
      },
      async (agent, _input, options) => {
        const context = options.context;
        if (!context) throw new Error("application context is required");
        const runContext = new RunContext(context);
        const additionalInfo = functionTool(agent, "request_additional_info");
        expect(context.playwrightCliCompleted).toBe(false);
        await expect(additionalInfo.invoke(
          runContext,
          JSON.stringify({
            questions: [{
              id: "premature_question",
              key: "application.premature_question",
              scope: "application",
              question: "This gate is not available yet.",
              answer_type: "text",
            }],
          }),
        )).resolves.toContain('"code":"inspection_required"');
        expect(runtimeRequests).toEqual([]);

        const playwrightCli = functionTool(agent, "playwright_cli");
        for (const invalidInvocation of [
          { command: "open", args: [] },
          { command: "snapshot", args: ["--session=other"] },
          { command: "snapshot", args: ["-s", "other"] },
          { command: "snapshot", args: ["-s"] },
          { command: "snapshot", args: ["-s=other"] },
          { command: "snapshot", args: ["--s"] },
          { command: "snapshot", args: ["--s=other"] },
          { command: "snapshot", args: ["-h"] },
          { command: "snapshot", args: ["-h=true"] },
          { command: "snapshot", args: ["--help"] },
          { command: "snapshot", args: ["--help=true"] },
          { command: "snapshot", args: ["-v"] },
          { command: "snapshot", args: ["-v=true"] },
          { command: "snapshot", args: ["--version"] },
          { command: "snapshot", args: ["--version=true"] },
          { command: "snapshot", args: ["--json"] },
          { command: "snapshot", args: ["--raw=true"] },
          { command: "snapshot", args: ["--config=other.json"] },
          { command: "snapshot", args: ["--profile", "/tmp/profile"] },
          { command: "snapshot", args: ["--browser=firefox"] },
          { command: "snapshot", args: [], extra: true },
          { command: "snapshot", args: Array.from({ length: 65 }, () => "x") },
          { command: "snapshot", args: ["é".repeat(4_097)] },
        ]) {
          await expect(playwrightCli.invoke(
            runContext,
            JSON.stringify(invalidInvocation),
          )).resolves.toContain('"code":"invalid_request"');
        }
        expect(runtimeRequests).toEqual([]);

        await playwrightCli.invoke(
          runContext,
          JSON.stringify({ command: "snapshot" }),
        );
        expect(context.playwrightCliCompleted).toBe(true);

        const questions = [
          {
            id: "summer_availability",
            key: "availability.summer_2027",
            scope: "global",
            question: "What dates are you available in Summer 2027?",
            answer_type: "text",
          },
          {
            id: "referral",
            key: "referral.source",
            scope: "application",
            question: "How did you hear about this position?",
            answer_type: "single_select",
            options: [
              { id: "company_site", label: "Company website" },
              { id: "other", label: "Other" },
            ],
          },
        ];
        await expect(additionalInfo.invoke(
          runContext,
          JSON.stringify({ questions, unexpected: true }),
        )).resolves.toContain('"code":"invalid_request"');
        expect(await additionalInfo.invoke(
          runContext,
          JSON.stringify({ questions }),
        )).toBe(JSON.stringify({ type: "additional_info", answers: acceptedAnswers }));
        expect(context.submissionApproved).toBe(false);

        await functionTool(agent, "request_human_review").invoke(
          runContext,
          JSON.stringify({ result: VALID_RESULT }),
        );
        throw new Error("review cancellation must terminate the run");
      },
    );

    expect(await runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).toEqual(CANCELLED_RESULT);
    expect(runtimeRequests).toEqual([
      { type: "playwright_cli", command: "snapshot", args: [] },
      {
        type: "request_additional_info",
        questions: [
          {
            id: "summer_availability",
            key: "availability.summer_2027",
            scope: "global",
            question: "What dates are you available in Summer 2027?",
            answer_type: "text",
          },
          {
            id: "referral",
            key: "referral.source",
            scope: "application",
            question: "How did you hear about this position?",
            answer_type: "single_select",
            options: [
              { id: "company_site", label: "Company website" },
              { id: "other", label: "Other" },
            ],
          },
        ],
      },
      { type: "request_human_review", result: VALID_RESULT },
    ]);
  });

  test("returns default credentials without invalidating inspected browser state", async () => {
    const runtimeRequests: RuntimeActionRequest[] = [];
    const stopMessage = "stop after reading default credentials";
    const dependencies = dependenciesWith(
      async (request) => {
        runtimeRequests.push(request);
        if (request.type === "get_credentials") {
          return {
            type: "credentials",
            username: "candidate@example.test",
            password: "private-password",
          };
        }
        throw new Error(`unexpected runtime action ${request.type}`);
      },
      async (agent, _input, options) => {
        const context = options.context;
        const runContext = inspectedRunContext(context);
        const getCredentials = functionTool(agent, "get_credentials");
        expect(getCredentials.description.toLowerCase()).toContain("default credentials");
        const inspectionState = {
          playwrightCliCompleted: context?.playwrightCliCompleted,
          browserSnapshotRequired: context?.browserSnapshotRequired,
          postNavigationInspectionRequired: context?.postNavigationInspectionRequired,
        };

        const output = await getCredentials.invoke(runContext, "{}");

        expect(JSON.parse(String(output))).toEqual({
          username: "candidate@example.test",
          password: "private-password",
        });
        expect({
          playwrightCliCompleted: context?.playwrightCliCompleted,
          browserSnapshotRequired: context?.browserSnapshotRequired,
          postNavigationInspectionRequired: context?.postNavigationInspectionRequired,
        }).toEqual(inspectionState);
        throw new Error(stopMessage);
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toThrow(stopMessage);
    expect(runtimeRequests).toEqual([{ type: "get_credentials" }]);
  });


  test("returns malformed credential responses to the model", async () => {
    let credentialCalls = 0;
    const stopMessage = "stop after credential recovery";
    const dependencies = dependenciesWith(
      async (request) => {
        expect(request).toEqual({ type: "get_credentials" });
        credentialCalls += 1;
        return credentialCalls === 1
          ? ({ type: "continue" } as never)
          : {
              type: "credentials",
              username: "candidate@example.test",
              password: "private-password",
            };
      },
      async (agent, _input, options) => {
        const context = options.context;
        const runContext = inspectedRunContext(context);
        const getCredentials = functionTool(agent, "get_credentials");
        const inspectionState = {
          playwrightCliCompleted: context?.playwrightCliCompleted,
          browserSnapshotRequired: context?.browserSnapshotRequired,
          postNavigationInspectionRequired: context?.postNavigationInspectionRequired,
        };

        const malformed = await getCredentials.invoke(runContext, "{}");
        expect(JSON.parse(String(malformed))).toMatchObject({ code: "invalid_response" });
        expect({
          playwrightCliCompleted: context?.playwrightCliCompleted,
          browserSnapshotRequired: context?.browserSnapshotRequired,
          postNavigationInspectionRequired: context?.postNavigationInspectionRequired,
        }).toEqual(inspectionState);

        expect(JSON.parse(String(await getCredentials.invoke(runContext, "{}")))).toEqual({
          username: "candidate@example.test",
          password: "private-password",
        });
        throw new Error(stopMessage);
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toThrow(stopMessage);
    expect(credentialCalls).toBe(2);
  });

  test("returns cancellation and exposes malformed additional-information responses", async () => {
    const questions = [{
      id: "summer_availability",
      key: "availability.summer_2027",
      scope: "global",
      question: "What dates are you available in Summer 2027?",
      answer_type: "text",
    }];
    const browserResult = {
      type: "playwright_cli_result" as const,
      exit_code: 0,
      stdout: "",
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
      cli_error_category: null,
      observation: {
        url: "https://apply.example.test/form",
        title: "Application",
        tabs: [],
        dom: "input Summer availability",
        page_info: null,
        screenshot: null,
      },
    };
    const cancelledDependencies = dependenciesWith(
      async (request) => request.type === "playwright_cli"
        ? browserResult
        : { type: "cancel", result: CANCELLED_RESULT },
      async (agent, _input, options) => {
        const runContext = new RunContext(options.context);
        await functionTool(agent, "playwright_cli").invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        await functionTool(agent, "request_additional_info").invoke(
          runContext,
          JSON.stringify({ questions }),
        );
        throw new Error("additional-information cancellation must terminate the run");
      },
    );
    expect(await runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      cancelledDependencies,
    )).toEqual(CANCELLED_RESULT);

    const malformedDependencies = dependenciesWith(
      async (request) => request.type === "playwright_cli"
        ? browserResult
        : { type: "continue" },
      async (agent, _input, options) => {
        const runContext = new RunContext(options.context);
        await functionTool(agent, "playwright_cli").invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        const malformed = await functionTool(agent, "request_additional_info").invoke(
          runContext,
          JSON.stringify({ questions }),
        );
        expect(JSON.parse(String(malformed))).toMatchObject({ code: "invalid_response" });
        throw new ApplicationAgentFailure("MODEL_PROVIDER_FAILED");
      },
    );
    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      malformedDependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("MODEL_PROVIDER_FAILED"));
  });

  test("resumes after additional information is skipped without validating or fabricating answers", async () => {
    const questions: Extract<
      RuntimeActionRequest,
      { type: "request_additional_info" }
    >["questions"] = [{
      id: "job_location",
      key: "preferences.job_location",
      scope: "global",
      question: "Which listed job locations can you accept?",
      answer_type: "multi_select",
      options: [
        { id: "nyc", label: "NYC" },
        { id: "nearby_nj", label: "Nearby NJ" },
      ],
    }];
    const runtimeRequests: RuntimeActionRequest[] = [];
    let browserCalls = 0;
    const dependencies = dependenciesWith(
      async (request) => {
        runtimeRequests.push(request);
        if (request.type === "playwright_cli") {
          browserCalls += 1;
          return {
            type: "playwright_cli_result",
            exit_code: 0,
            stdout: "",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            cli_error_category: null,
            observation: {
              url: "https://apply.example.test/form",
              title: "Application",
              tabs: [],
              dom: browserCalls === 1
                ? "select Job location"
                : "select Job location; button Review",
              page_info: null,
              screenshot: null,
            },
          };
        }
        if (request.type === "request_additional_info") {
          return { type: "continue_without_additional_info" };
        }
        throw new Error(`unexpected runtime action ${request.type}`);
      },
      async (agent, _input, options) => {
        const runContext = new RunContext(options.context);
        const browser = functionTool(agent, "playwright_cli");
        await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        expect(await functionTool(agent, "request_additional_info").invoke(
          runContext,
          JSON.stringify({ questions }),
        )).toBe(
          "The human chose Continue without providing answers. Re-inspect the current application step and attempt to continue without inferring or fabricating information. Re-ask only if the site still requires the information.",
        );
        await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        throw new Error("stop after the resumed agent branch");
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toThrow("stop after the resumed agent branch");
    expect(runtimeRequests).toEqual([
      { type: "playwright_cli", command: "snapshot", args: [] },
      { type: "request_additional_info", questions },
      { type: "playwright_cli", command: "snapshot", args: [] },
    ]);
  });

  test("returns malformed browser responses to the model and recovers with a snapshot", async () => {
    let runtimeCalls = 0;
    const dependencies = dependenciesWith(
      async (request) => {
        expect(request).toEqual({ type: "playwright_cli", command: "snapshot", args: [] });
        runtimeCalls += 1;
        return runtimeCalls === 1 ? { type: "continue" } : PRE_SUBMISSION_EXECUTION_RESULT;
      },
      async (agent, _input, options) => {
        const context = options.context;
        if (!context) throw new Error("application context is required");
        const runContext = new RunContext(context);
        const browser = functionTool(agent, "playwright_cli");
        const malformed = await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        expect(JSON.parse(String(malformed))).toMatchObject({
          type: "tool_error",
          code: "invalid_response",
        });
        expect(context.playwrightCliCompleted).toBe(false);
        expect(context.browserSnapshotRequired).toBe(true);
        const recovered = await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        expect(JSON.parse(String(recovered))).toMatchObject({ type: "playwright_cli_result" });
        expect(context.playwrightCliCompleted).toBe(true);
        expect(context.browserSnapshotRequired).toBe(false);
        throw new Error("stop after malformed response recovery");
      },
    );
    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toThrow("stop after malformed response recovery");
    expect(runtimeCalls).toBe(2);
  });

  test("continues after a recoverable turn ends without a terminal tool", async () => {
    let browserCalls = 0;
    let runnerCalls = 0;
    const dependencies = dependenciesWith(
      async (request) => {
        if (request.type === "playwright_cli") {
          browserCalls += 1;
          return browserCalls === 1 ? { type: "continue" } : PRE_SUBMISSION_EXECUTION_RESULT;
        }
        if (request.type === "report_application_mismatch") {
          return { type: "application_mismatch" };
        }
        throw new Error("unexpected runtime action " + request.type);
      },
      async (agent, runInput, options) => {
        runnerCalls += 1;
        const context = options.context;
        if (!context) throw new Error("application context is required");
        const runContext = new RunContext(context);
        if (runnerCalls === 1) {
          const failure = await functionTool(agent, "playwright_cli").invoke(
            runContext,
            JSON.stringify({ command: "snapshot", args: [] }),
          );
          expect(JSON.parse(String(failure))).toMatchObject({ code: "invalid_response" });
          return {
            history: [{
              role: "assistant",
              content: [{ type: "output_text", text: "Please dismiss the browser dialog." }],
            }],
            rawResponses: [],
            newItems: [],
            finalOutput: "Please dismiss the browser dialog.",
          };
        }
        expect(Array.isArray(runInput)).toBe(true);
        const serializedInput = JSON.stringify(runInput);
        expect(serializedInput).toContain(RUN_INPUT.task);
        expect(serializedInput).toContain("Continue the application after the recoverable failure");
        await functionTool(agent, "playwright_cli").invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        await functionTool(agent, "report_application_mismatch").invoke(runContext, "{}");
        return {
          history: runInput,
          rawResponses: [],
          newItems: [],
          finalOutput: "Application mismatch.",
        };
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("APPLICATION_MISMATCH"));
    expect(runnerCalls).toBe(2);
    expect(browserCalls).toBe(2);
  });

  test("does not restart after a recoverable failure once submission may have occurred", async () => {
    let runnerCalls = 0;
    const guardOperations: string[] = [];
    const dependencies = dependenciesWith(
      async (request) => {
        if (request.type === "playwright_cli" && request.command === "snapshot") {
          return PRE_SUBMISSION_EXECUTION_RESULT;
        }
        if (request.type === "request_human_review") {
          return { type: "submit", instruction: "You're good to submit.", result: VALID_RESULT };
        }
        if (request.type === "playwright_cli" && request.command === "click") {
          throw new ApplicationRuntimeError("browser_failed");
        }
        throw new Error("unexpected runtime action " + request.type);
      },
      async (agent, _input, options) => {
        runnerCalls += 1;
        const context = options.context;
        if (!context) throw new Error("application context is required");
        const runContext = new RunContext(context);
        const browser = functionTool(agent, "playwright_cli");
        await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        await functionTool(agent, "request_human_review").invoke(
          runContext,
          JSON.stringify({ result: VALID_RESULT }),
        );
        await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        const failure = await browser.invoke(
          runContext,
          JSON.stringify({ command: "click", args: ["e9"] }),
        );
        expect(JSON.parse(String(failure))).toMatchObject({ code: "browser_failed" });
        return {
          history: [],
          rawResponses: [],
          newItems: [],
          finalOutput: "The browser state is uncertain.",
        };
      },
      {
        async markReviewReady(): Promise<void> {},
        async claim(): Promise<void> {
          guardOperations.push("claim");
        },
        async finalize(outcome): Promise<void> {
          guardOperations.push("finalize:" + outcome);
        },
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("INVALID_MODEL_OUTPUT"));
    expect(runnerCalls).toBe(1);
    expect(guardOperations).toEqual(["claim", "finalize:uncertain"]);
  });

  test("recovers a premature review after a timed-out browser action", async () => {
    const runtimeRequests: RuntimeActionRequest[] = [];
    const dependencies = dependenciesWith(
      async (request) => {
        runtimeRequests.push(request);
        if (request.type === "playwright_cli") {
          return request.command === "click"
            ? { ...PRE_SUBMISSION_EXECUTION_RESULT, exit_code: 124, stderr: "Navigation timed out" }
            : PRE_SUBMISSION_EXECUTION_RESULT;
        }
        if (request.type === "request_human_review") {
          return { type: "cancel", result: CANCELLED_RESULT };
        }
        throw new Error("Unexpected runtime action");
      },
      async (agent, _input, options) => {
        const context = new RunContext(options.context);
        const browser = functionTool(agent, "playwright_cli");
        const review = functionTool(agent, "request_human_review");
        await browser.invoke(context, JSON.stringify({ command: "click", args: ["e9"] }));
        const rejection = await review.invoke(context, JSON.stringify({ result: VALID_RESULT }));
        expect(JSON.parse(String(rejection))).toMatchObject({
          type: "tool_error", code: "inspection_required",
        });
        expect(runtimeRequests).toHaveLength(1);
        await browser.invoke(context, JSON.stringify({ command: "snapshot", args: [] }));
        return await review.invoke(context, JSON.stringify({ result: VALID_RESULT }));
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT, new AbortController().signal, dependencies,
    )).resolves.toEqual(CANCELLED_RESULT);
    expect(runtimeRequests.map((request) => request.type)).toEqual([
      "playwright_cli", "playwright_cli", "request_human_review",
    ]);
  });

  test("returns malformed same-type browser responses and recovers with a snapshot", async () => {
    let browserCalls = 0;
    const dependencies = dependenciesWith(
      async (request) => {
        if (request.type === "report_application_mismatch") {
          return { type: "application_mismatch" };
        }
        expect(request.type).toBe("playwright_cli");
        browserCalls += 1;
        return browserCalls === 1
          ? ({ type: "playwright_cli_result" } as never)
          : PRE_SUBMISSION_EXECUTION_RESULT;
      },
      async (agent, _input, options) => {
        const context = options.context;
        if (context === undefined) throw new Error("application context is required");
        const runContext = new RunContext(context);
        const browser = functionTool(agent, "playwright_cli");
        const malformed = await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        expect(JSON.parse(String(malformed))).toMatchObject({ code: "invalid_response" });
        await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        await functionTool(agent, "report_application_mismatch").invoke(runContext, "{}");
        return {
          history: [],
          rawResponses: [],
          newItems: [],
          finalOutput: "Application mismatch.",
        };
      },
    );
    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("APPLICATION_MISMATCH"));
    expect(browserCalls).toBe(2);
  });

  test("does not swallow an abort when the runtime resolves concurrently", async () => {
    const controller = new AbortController();
    const abortReason = new DOMException("request deleted", "AbortError");
    const dependencies = dependenciesWith(
      async () => {
        controller.abort(abortReason);
        return { type: "cancel", result: CANCELLED_RESULT };
      },
      async (agent, _input, options) => {
        await functionTool(agent, "request_human_review").invoke(
          inspectedRunContext(options.context),
          JSON.stringify({ result: VALID_RESULT }),
        );
        throw new Error("abort must win over the resolved runtime response");
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      controller.signal,
      dependencies,
    )).rejects.toBe(abortReason);
  });

  test("runs one fixed serial agent and returns the runtime cancellation result", async () => {
    const controller = new AbortController();
    let runnerCalls = 0;
    const runtimeRequests: unknown[] = [];
    const dependencies = dependenciesWith(
      async (request, signal) => {
        runtimeRequests.push(request);
        expect(signal).toBe(controller.signal);
        return { type: "cancel", result: CANCELLED_RESULT };
      },
      async (agent, input, options) => {
        runnerCalls++;
        await functionTool(agent, "request_human_review").invoke(
          inspectedRunContext(options.context),
          JSON.stringify({ result: VALID_RESULT }),
        );
        throw new Error("cancel must terminate tool execution");
      },
    );

    const result = await runApplicationAgent(RUN_INPUT, controller.signal, dependencies);
    expect(result).toEqual(CANCELLED_RESULT);
    expect(runnerCalls).toBe(1);
    expect(runtimeRequests).toEqual([{ type: "request_human_review", result: VALID_RESULT }]);
  });

  test("passes only the authoritative application signal to Playwright runtime actions", async () => {
    const controller = new AbortController();
    let runtimeArguments: unknown[] = [];
    const dependencies = dependenciesWith(
      (...args) => {
        runtimeArguments = args;
        expect(args[0]).toEqual({ type: "playwright_cli", command: "snapshot", args: [] });
        return Promise.resolve(PRE_SUBMISSION_EXECUTION_RESULT);
      },
      async (agent, _input, options) => {
        await functionTool(agent, "playwright_cli").invoke(
          new RunContext(options.context),
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        throw new Error("stop after observing the runtime signal");
      },
    );

    await expect(runApplicationAgent(
      { ...RUN_INPUT, deadlineMs: 500_000 },
      controller.signal,
      dependencies,
    )).rejects.toThrow("stop after observing the runtime signal");
    expect(runtimeArguments).toEqual([
      { type: "playwright_cli", command: "snapshot", args: [] },
      controller.signal,
    ]);
  });

  test("skips approved read-only claims and records the latest successful post-approval observation after one mutation claim", async () => {
    const runtimeRequests: RuntimeActionRequest[] = [];
    const guardOperations: string[] = [];
    const reviewResult = VALID_RESULT;
    const unresolvedResult = {
      ...reviewResult,
      fields_needing_human: [{
        label: "Work authorization",
        field_type: "checkbox" as const,
        value_present: false as const,
        note: "Required fact is unavailable",
      }],
    };
    const postSubmissionInspection = {
      ...SUBMIT_EXECUTION_RESULT,
      stdout: "status inspected",
      observation: {
        ...SUBMIT_EXECUTION_RESULT.observation,
        url: "https://apply.example.test/status",
        title: "Application status",
        dom: "main Thank you for applying",
        screenshot: null,
      },
    };
    const inspectedSubmittedResult = {
      ...VALID_SUBMITTED_RESULT,
      final_url: postSubmissionInspection.observation.url,
    };
    let snapshotCalls = 0;
    const dependencies = dependenciesWith(
      async (request) => {
        runtimeRequests.push(request);
        if (request.type === "playwright_cli") {
          guardOperations.push(`runtime:${request.command}:${request.args.join("|")}`);
          if (request.command === "fill") {
            return PRE_SUBMISSION_EXECUTION_RESULT;
          }
          if (request.command === "click") {
            return SUBMIT_EXECUTION_RESULT;
          }
          if (request.command === "snapshot") {
            snapshotCalls += 1;
            return snapshotCalls === 1
              ? PRE_SUBMISSION_EXECUTION_RESULT
              : postSubmissionInspection;
          }
        }
        if (request.type === "request_human_review") {
          return {
            type: "submit",
            instruction: "You're good to submit.",
            result: reviewResult,
          };
        }
        throw new Error(`unexpected runtime action ${request.type}`);
      },
      async (agent, _input, options) => {
        const context = options.context;
        if (!context) throw new Error("application context is required");
        const runContext = new RunContext(context);
        const browser = functionTool(agent, "playwright_cli");
        const terminal = functionTool(agent, "report_submission_outcome");

        const browserOutput = String(await browser.invoke(
          runContext,
          JSON.stringify({ command: "fill", args: ["#name", "Test Candidate"] }),
        ));
        expect(browserOutput).toContain("button Final submit");
        expect(browserOutput).not.toContain("cHJl");
        expect(context.latestScreenshotDataUrl).toBe("data:image/png;base64,cHJl");
        expect(context.playwrightCliCompleted).toBe(true);
        expect(guardOperations).toEqual(["runtime:fill:#name|Test Candidate"]);

        const review = functionTool(agent, "request_human_review");
        await expect(review.invoke(
          runContext,
          JSON.stringify({ result: unresolvedResult }),
        )).resolves.toContain('"code":"additional_info_required"');
        expect(guardOperations).toEqual(["runtime:fill:#name|Test Candidate"]);
        await review.invoke(
          runContext,
          JSON.stringify({ result: reviewResult }),
        );
        expect(guardOperations).toEqual([
          "runtime:fill:#name|Test Candidate",
          "review-ready",
        ]);
        expect(context.submissionApproved).toBe(true);
        expect(context.lastReviewResult).toEqual(reviewResult);


        const approvedInspection = String(await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        ));
        expect(approvedInspection).toContain("button Final submit");
        expect(guardOperations).toEqual([
          "runtime:fill:#name|Test Candidate",
          "review-ready",
          "runtime:snapshot:",
        ]);
        expect(context.submissionClaimed).toBe(false);
        expect(context.latestSubmissionExecution).toEqual(PRE_SUBMISSION_EXECUTION_RESULT);

        const submittingOutput = String(await functionTool(agent, "playwright_cli").invoke(
          runContext,
          JSON.stringify({ command: "click", args: ["e9"] }),
        ));
        expect(submittingOutput).toContain("Application received");
        expect(guardOperations).toEqual([
          "runtime:fill:#name|Test Candidate",
          "review-ready",
          "runtime:snapshot:",
          "claim",
          "runtime:click:e9",
        ]);
        expect(context.latestSubmissionExecution).toEqual(SUBMIT_EXECUTION_RESULT);

        const confirmationOutput = String(await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        ));
        expect(confirmationOutput).toContain("Thank you for applying");
        expect(context.latestScreenshotDataUrl).toBeUndefined();
        expect(context.latestSubmissionExecution).toEqual(postSubmissionInspection);
        expect(guardOperations.filter((operation) => operation === "claim")).toHaveLength(1);

        await terminal.invoke(runContext, JSON.stringify({ submitted: true }));
        expect(guardOperations.at(-1)).toBe("finalize:submitted");
        return { history: [] };
      },
      {
        async markReviewReady(): Promise<void> {
          guardOperations.push("review-ready");
        },
        async claim(): Promise<void> {
          guardOperations.push("claim");
        },
        async finalize(outcome): Promise<void> {
          guardOperations.push(`finalize:${outcome}`);
        },
      },
    );

    expect(await runApplicationAgent(
      AUTO_SUBMIT_RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).toEqual(inspectedSubmittedResult);
    expect(runtimeRequests).toEqual([
      { type: "playwright_cli", command: "fill", args: ["#name", "Test Candidate"] },
      { type: "request_human_review", result: reviewResult },
      { type: "playwright_cli", command: "snapshot", args: [] },
      { type: "playwright_cli", command: "click", args: ["e9"] },
      { type: "playwright_cli", command: "snapshot", args: [] },
    ]);
  });

  test("defers a binary outcome after a failed latest inspection and preserves crash uncertainty", async () => {
    const guardOperations: string[] = [];
    const failedObservation = {
      ...SUBMIT_EXECUTION_RESULT,
      exit_code: 2,
      stderr: "snapshot failed",
      observation: {
        ...SUBMIT_EXECUTION_RESULT.observation,
        url: "https://apply.example.test/error",
        title: "Application error",
        dom: "main Browser command failed",
        screenshot: null,
      },
    };
    const timedOutObservation = {
      ...failedObservation,
      exit_code: 124,
      stderr: "snapshot timed out",
      observation: {
        ...failedObservation.observation,
        url: "https://apply.example.test/still-loading",
        title: "Application pending",
        dom: "main Submission status unavailable",
      },
    };
    let snapshotCalls = 0;
    const dependencies = dependenciesWith(
      async (request) => {
        if (request.type === "playwright_cli") {
          if (request.command === "click") return SUBMIT_EXECUTION_RESULT;
          if (request.command === "snapshot") {
            snapshotCalls += 1;
            if (snapshotCalls === 1) return PRE_SUBMISSION_EXECUTION_RESULT;
            if (snapshotCalls === 2) return failedObservation;
            return timedOutObservation;
          }
        }
        if (request.type === "request_human_review") {
          return {
            type: "submit",
            instruction: "You're good to submit.",
            result: VALID_RESULT,
          };
        }
        throw new Error(`unexpected runtime action ${request.type}`);
      },
      async (agent, _input, options) => {
        const context = options.context;
        if (!context) throw new Error("application context is required");
        const runContext = new RunContext(context);
        const browser = functionTool(agent, "playwright_cli");
        await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        await functionTool(agent, "request_human_review").invoke(
          runContext,
          JSON.stringify({ result: VALID_RESULT }),
        );
        await functionTool(agent, "playwright_cli").invoke(
          runContext,
          JSON.stringify({ command: "click", args: ["e9"] }),
        );

        await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );

        await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );

        const terminal = functionTool(agent, "report_submission_outcome");
        await terminal.invoke(
          runContext,
          JSON.stringify({ submitted: true }),
        );
        expect(guardOperations).toEqual(["claim"]);
        return { history: [] };
      },
      {
        async markReviewReady(): Promise<void> {},
        async claim(): Promise<void> {
          guardOperations.push("claim");
        },
        async finalize(outcome): Promise<void> {
          guardOperations.push(`finalize:${outcome}`);
        },
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
    expect(guardOperations).toEqual(["claim", "finalize:uncertain"]);
  });

  test("manual mode preserves revision and returns exact explicit permission unchanged", async () => {
    const runtimeRequests: RuntimeActionRequest[] = [];
    const guardOperations: string[] = [];
    let reviewCalls = 0;
    let browserCalls = 0;
    const dependencies = dependenciesWith(
      async (request) => {
        runtimeRequests.push(request);
        if (request.type === "playwright_cli") {
          browserCalls++;
          return browserCalls === 1
            ? PRE_SUBMISSION_EXECUTION_RESULT
            : SUBMIT_EXECUTION_RESULT;
        }
        if (request.type === "request_human_review") {
          reviewCalls++;
          return reviewCalls === 1
            ? { type: "revise", context: "Correct the role title.", revision_count: 1 }
            : {
                type: "submit",
                instruction: "You're good to submit.",
                result: VALID_RESULT,
              };
        }
        throw new Error(`unexpected runtime request ${request.type}`);
      },
      async (agent, _input, options) => {
        const context = options.context;
        if (!context) throw new Error("application context is required");
        const runContext = new RunContext(context);
        const browser = functionTool(agent, "playwright_cli");
        const terminal = functionTool(agent, "report_submission_outcome");
        await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        expect(guardOperations).toEqual([]);
        const review = functionTool(agent, "request_human_review");
        await review.invoke(
          runContext,
          JSON.stringify({ result: VALID_RESULT }),
        );
        expect(context.submissionApproved).toBe(false);
        await review.invoke(
          runContext,
          JSON.stringify({ result: VALID_RESULT }),
        );
        expect(context.submissionApproved).toBe(true);
        expect(guardOperations).toEqual([]);

        await functionTool(agent, "playwright_cli").invoke(
          runContext,
          JSON.stringify({ command: "click", args: ["e9"] }),
        );
        expect(guardOperations).toEqual(["claim"]);
        await terminal.invoke(
          runContext,
          JSON.stringify({ submitted: true }),
        );
        return { history: [] };
      },
      {
        async markReviewReady(): Promise<void> {
          guardOperations.push("review-ready");
        },
        async claim(): Promise<void> {
          guardOperations.push("claim");
        },
        async finalize(outcome): Promise<void> {
          guardOperations.push(`finalize:${outcome}`);
        },
      },
    );

    expect(await runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).toEqual(VALID_SUBMITTED_RESULT);
    expect(runtimeRequests.map((request) => request.type)).toEqual([
      "playwright_cli",
      "request_human_review",
      "request_human_review",
      "playwright_cli",
    ]);
    expect(guardOperations).toEqual(["claim", "finalize:submitted"]);
  });


  test("claims before approved human navigation and parks cancellation as uncertain", async () => {
    const operations: string[] = [];
    const dependencies = dependenciesWith(
      async (request) => {
        operations.push(`runtime:${request.type}`);
        if (request.type === "request_human_review") {
          return {
            type: "submit",
            instruction: "You're good to submit.",
            result: VALID_RESULT,
          };
        }
        if (request.type === "request_human_navigation") {
          return { type: "cancel", result: CANCELLED_RESULT };
        }
        throw new Error(`unexpected runtime action ${request.type}`);
      },
      async (agent, _input, options) => {
        const runContext = inspectedRunContext(options.context);
        await functionTool(agent, "request_human_review").invoke(
          runContext,
          JSON.stringify({ result: VALID_RESULT }),
        );
        await functionTool(agent, "request_human_navigation").invoke(
          runContext,
          JSON.stringify({ instruction: "Complete the final manual control" }),
        );
        throw new Error("cancellation must stop the run");
      },
      {
        async markReviewReady(): Promise<void> {},
        async claim(): Promise<void> {
          operations.push("claim");
        },
        async finalize(outcome): Promise<void> {
          operations.push(`finalize:${outcome}`);
        },
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("INVALID_MODEL_OUTPUT"));
    expect(operations).toEqual([
      "runtime:request_human_review",
      "claim",
      "runtime:request_human_navigation",
      "finalize:uncertain",
    ]);
  });

  test("non-abortably finalizes an interrupted approved browser action as uncertain", async () => {
    const controller = new AbortController();
    const abortReason = new DOMException("candidate closed the run", "AbortError");
    const guardOperations: string[] = [];
    const dependencies = dependenciesWith(
      async (request) => {
        if (request.type === "request_human_review") {
          return {
            type: "submit",
            instruction: "You're good to submit.",
            result: VALID_RESULT,
          };
        }
        if (request.type === "playwright_cli") {
          controller.abort(abortReason);
          throw abortReason;
        }
        throw new Error(`unexpected runtime action ${request.type}`);
      },
      async (agent, _input, options) => {
        const runContext = inspectedRunContext(options.context);
        await functionTool(agent, "request_human_review").invoke(
          runContext,
          JSON.stringify({ result: VALID_RESULT }),
        );
        await functionTool(agent, "playwright_cli").invoke(
          runContext,
          JSON.stringify({ command: "click", args: ["e9"] }),
        );
        throw new Error("interrupted submission must stop the run");
      },
      {
        async markReviewReady(): Promise<void> {},
        async claim(): Promise<void> {
          guardOperations.push("claim");
        },
        async finalize(outcome): Promise<void> {
          await Promise.resolve();
          guardOperations.push(`finalize:${outcome}`);
        },
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      controller.signal,
      dependencies,
    )).rejects.toBe(abortReason);
    expect(guardOperations).toEqual(["claim", "finalize:uncertain"]);
  });

  test("serializes submitted finalization with an overlapping abort", async () => {
    const controller = new AbortController();
    const abortReason = new DOMException("request deleted", "AbortError");
    const finalizeStarted = Promise.withResolvers<void>();
    const releaseFinalize = Promise.withResolvers<void>();
    const guardOperations: string[] = [];
    let browserCalls = 0;
    const dependencies = dependenciesWith(
      async (request) => {
        if (request.type === "playwright_cli") {
          browserCalls++;
          return browserCalls === 1
            ? PRE_SUBMISSION_EXECUTION_RESULT
            : SUBMIT_EXECUTION_RESULT;
        }
        if (request.type === "request_human_review") {
          return {
            type: "submit",
            instruction: "You're good to submit.",
            result: VALID_RESULT,
          };
        }
        throw new Error(`unexpected runtime action ${request.type}`);
      },
      async (agent, _input, options) => {
        const context = options.context;
        if (!context) throw new Error("application context is required");
        const runContext = new RunContext(context);
        const browser = functionTool(agent, "playwright_cli");
        await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        await functionTool(agent, "request_human_review").invoke(
          runContext,
          JSON.stringify({ result: VALID_RESULT }),
        );
        await functionTool(agent, "playwright_cli").invoke(
          runContext,
          JSON.stringify({ command: "click", args: ["e9"] }),
        );
        await functionTool(agent, "report_submission_outcome").invoke(
          runContext,
          JSON.stringify({ submitted: true }),
        );
        return { history: [] };
      },
      {
        async markReviewReady(): Promise<void> {},
        async claim(): Promise<void> {
          guardOperations.push("claim");
        },
        async finalize(outcome): Promise<void> {
          guardOperations.push(`finalize:${outcome}`);
          finalizeStarted.resolve();
          await releaseFinalize.promise;
        },
      },
    );

    const runPromise = runApplicationAgent(RUN_INPUT, controller.signal, dependencies);
    await finalizeStarted.promise;
    controller.abort(abortReason);
    await Promise.resolve();
    expect(guardOperations).toEqual(["claim", "finalize:submitted"]);
    releaseFinalize.resolve();

    expect(await runPromise).toEqual(VALID_SUBMITTED_RESULT);
    expect(guardOperations).toEqual(["claim", "finalize:submitted"]);
  });

  test("falls back to uncertainty when submitted finalization fails", async () => {
    const guardOperations: string[] = [];
    let browserCalls = 0;
    const dependencies = dependenciesWith(
      async (request) => {
        if (request.type === "playwright_cli") {
          browserCalls++;
          return browserCalls === 1
            ? PRE_SUBMISSION_EXECUTION_RESULT
            : SUBMIT_EXECUTION_RESULT;
        }
        if (request.type === "request_human_review") {
          return {
            type: "submit",
            instruction: "You're good to submit.",
            result: VALID_RESULT,
          };
        }
        throw new Error(`unexpected runtime action ${request.type}`);
      },
      async (agent, _input, options) => {
        const context = options.context;
        if (!context) throw new Error("application context is required");
        const runContext = new RunContext(context);
        const browser = functionTool(agent, "playwright_cli");
        await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        await functionTool(agent, "request_human_review").invoke(
          runContext,
          JSON.stringify({ result: VALID_RESULT }),
        );
        await functionTool(agent, "playwright_cli").invoke(
          runContext,
          JSON.stringify({ command: "click", args: ["e9"] }),
        );
        await functionTool(agent, "report_submission_outcome").invoke(
          runContext,
          JSON.stringify({ submitted: true }),
        );
        throw new Error("failed terminal commit must stop the run");
      },
      {
        async markReviewReady(): Promise<void> {},
        async claim(): Promise<void> {
          guardOperations.push("claim");
        },
        finalize(outcome): Promise<void> {
          guardOperations.push(`finalize:${outcome}`);
          if (outcome === "submitted") throw new Error("database commit failed");
          return Promise.resolve();
        },
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("MODEL_PROVIDER_FAILED"));
    expect(guardOperations).toEqual([
      "claim",
      "finalize:submitted",
      "finalize:uncertain",
    ]);
  });

  test("leaves a failed first post-approval claim retryable", async () => {
    const runtimeRequests: string[] = [];
    const guardOperations: string[] = [];
    const dependencies = dependenciesWith(
      async (request) => {
        runtimeRequests.push(request.type);
        if (request.type === "request_human_review") {
          return {
            type: "submit",
            instruction: "You're good to submit.",
            result: VALID_RESULT,
          };
        }
        throw new Error("browser submission must not run before a durable claim");
      },
      async (agent, _input, options) => {
        const runContext = inspectedRunContext(options.context);
        await functionTool(agent, "request_human_review").invoke(
          runContext,
          JSON.stringify({ result: VALID_RESULT }),
        );
        await functionTool(agent, "playwright_cli").invoke(
          runContext,
          JSON.stringify({ command: "click", args: ["e9"] }),
        );
        throw new Error("claim failure must stop the run");
      },
      {
        async markReviewReady(): Promise<void> {},
        async claim(): Promise<void> {
          guardOperations.push("claim");
          throw new Error("database unavailable");
        },
        async finalize(outcome): Promise<void> {
          guardOperations.push(`finalize:${outcome}`);
        },
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("MODEL_PROVIDER_FAILED"));
    expect(runtimeRequests).toEqual(["request_human_review"]);
    expect(guardOperations).toEqual(["claim"]);
  });

  test("does not claim when the first approved browser tool signal is already aborted", async () => {
    const toolController = new AbortController();
    const abortReason = new DOMException("tool deadline", "AbortError");
    const guardOperations: string[] = [];
    const dependencies = dependenciesWith(
      async (request) => {
        if (request.type === "request_human_review") {
          return {
            type: "submit",
            instruction: "You're good to submit.",
            result: VALID_RESULT,
          };
        }
        throw new Error("aborted browser action must not reach the runtime");
      },
      async (agent, _input, options) => {
        const runContext = inspectedRunContext(options.context);
        await functionTool(agent, "request_human_review").invoke(
          runContext,
          JSON.stringify({ result: VALID_RESULT }),
        );
        toolController.abort(abortReason);
        await functionTool(agent, "playwright_cli").invoke(
          runContext,
          JSON.stringify({ command: "click", args: ["e9"] }),
          { signal: toolController.signal },
        );
        throw new Error("aborted browser action must stop the run");
      },
      {
        async markReviewReady(): Promise<void> {},
        async claim(): Promise<void> {
          guardOperations.push("claim");
        },
        async finalize(outcome): Promise<void> {
          guardOperations.push(`finalize:${outcome}`);
        },
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toBe(abortReason);
    expect(guardOperations).toEqual([]);
  });

  test("awaits a late first browser claim and finalizes it uncertain after abort", async () => {
    const controller = new AbortController();
    const abortReason = new DOMException("request deleted", "AbortError");
    const claimStarted = Promise.withResolvers<void>();
    const releaseClaim = Promise.withResolvers<void>();
    const runtimeRequests: string[] = [];
    const guardOperations: string[] = [];
    const dependencies = dependenciesWith(
      async (request) => {
        runtimeRequests.push(request.type);
        if (request.type === "request_human_review") {
          return {
            type: "submit",
            instruction: "You're good to submit.",
            result: VALID_RESULT,
          };
        }
        throw new Error("aborted post-claim browser action must not reach the runtime");
      },
      async (agent, _input, options) => {
        const runContext = inspectedRunContext(options.context);
        await functionTool(agent, "request_human_review").invoke(
          runContext,
          JSON.stringify({ result: VALID_RESULT }),
        );
        await functionTool(agent, "playwright_cli").invoke(
          runContext,
          JSON.stringify({ command: "click", args: ["e9"] }),
        );
        throw new Error("aborted claim must stop the run");
      },
      {
        async markReviewReady(): Promise<void> {},
        async claim(): Promise<void> {
          guardOperations.push("claim");
          claimStarted.resolve();
          await releaseClaim.promise;
          guardOperations.push("claim:resolved");
        },
        async finalize(outcome): Promise<void> {
          guardOperations.push(`finalize:${outcome}`);
        },
      },
    );

    let settled = false;
    const runPromise = runApplicationAgent(RUN_INPUT, controller.signal, dependencies);
    void runPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await claimStarted.promise;
    controller.abort(abortReason);
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseClaim.resolve();

    await expect(runPromise).rejects.toBe(abortReason);
    expect(runtimeRequests).toEqual(["request_human_review"]);
    expect(guardOperations).toEqual([
      "claim",
      "claim:resolved",
      "finalize:uncertain",
    ]);
  });

  test("recovers from malformed input and runtime request rejection before continuing", async () => {
    let browserCalls = 0;
    const dependencies = dependenciesWith(
      async (request) => {
        if (request.type === "playwright_cli") {
          if (browserCalls++ === 0) throw new ApplicationRuntimeError("invalid_request");
          return SUBMIT_EXECUTION_RESULT;
        }
        if (request.type === "request_human_review") {
          return { type: "cancel", result: CANCELLED_RESULT };
        }
        throw new Error(`unexpected action ${request.type}`);
      },
      async (agent, _input, options) => {
        const runContext = new RunContext(options.context);
        const browser = functionTool(agent, "playwright_cli");
        for (const input of ["{private malformed input", JSON.stringify({ command: "snapshot" })]) {
          const rejected = JSON.parse(await browser.invoke(runContext, input) as string);
          expect(rejected.code).toBe("invalid_request");
          expect(JSON.stringify(rejected)).not.toContain("private malformed input");
        }
        const inspected = JSON.parse(await browser.invoke(
          runContext, JSON.stringify({ command: "snapshot" }),
        ) as string);
        expect(inspected.exit_code).toBe(0);
        await functionTool(agent, "request_human_review").invoke(
          runContext, JSON.stringify({ result: VALID_RESULT }),
        );
        throw new Error("review cancellation must terminate the run");
      },
    );
    expect(await runApplicationAgent(
      RUN_INPUT, new AbortController().signal, dependencies,
    )).toEqual(CANCELLED_RESULT);
    expect(browserCalls).toBe(2);
  });

  test("maps mismatch and terminal runtime failures without exposing provider errors", async () => {
    const mismatchDependencies = dependenciesWith(
      async (request) => {
        expect(request).toEqual({ type: "report_application_mismatch" });
        return { type: "application_mismatch" };
      },
      async (agent, _input, options) => {
        await functionTool(agent, "report_application_mismatch").invoke(
          inspectedRunContext(options.context),
          "{}",
        );
        return { history: [] };
      },
    );
    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      mismatchDependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("APPLICATION_MISMATCH"));

    for (const [runtimeError, expectedCode] of [
      [new ApplicationRuntimeError("model_failed"), "MODEL_PROVIDER_FAILED"],
      [new Error("private provider response"), "MODEL_PROVIDER_FAILED"],
    ] as const) {
      const dependencies = dependenciesWith(
        async () => {
          throw runtimeError;
        },
        async (agent, _input, options) => {
          await functionTool(agent, "playwright_cli").invoke(
            new RunContext(options.context),
            JSON.stringify({ command: "snapshot", args: [] }),
          );
          throw new Error("runtime failure must terminate the run");
        },
      );
      try {
        await runApplicationAgent(RUN_INPUT, new AbortController().signal, dependencies);
        throw new Error("expected application agent failure");
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationAgentFailure);
        if (!(error instanceof ApplicationAgentFailure)) throw error;
        expect(error.code).toBe(expectedCode);
        expect(error.cause).toBe(runtimeError);
        expect(error.message).not.toContain("private provider response");
      }
    }

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
    )).rejects.toEqual(new ApplicationAgentFailure("MODEL_PROVIDER_FAILED"));
  });

  test("unwraps an Agents SDK tool-call failure at the public error boundary", async () => {
    const dependencies = dependenciesWith(
      async () => {
        throw new ApplicationAgentFailure("BROWSER_FAILED");
      },
      async (agent, _input, options) => {
        try {
          await functionTool(agent, "playwright_cli").invoke(
            new RunContext(options.context),
            JSON.stringify({ command: "snapshot", args: [] }),
          );
        } catch (error) {
          if (!(error instanceof ApplicationAgentFailure)) throw error;
          throw new ToolCallError(`Failed to run function tools: ${error}`, error);
        }
        throw new Error("runtime failure must terminate the run");
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toMatchObject({
      code: "BROWSER_FAILED",
      message: "The browser session failed",
    });
  });

  test("returns cancellation from navigation and maps review mismatch", async () => {
    const navigationDependencies = dependenciesWith(
      async (request) => {
        expect(request.type).toBe("request_human_navigation");
        return { type: "cancel", result: CANCELLED_RESULT };
      },
      async (agent, _input, options) => {
        await functionTool(agent, "request_human_navigation").invoke(
          inspectedRunContext(options.context),
          JSON.stringify({ instruction: "Complete login" }),
        );
        throw new Error("gate cancellation must terminate the run");
      },
    );
    expect(await runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      navigationDependencies,
    )).toEqual(CANCELLED_RESULT);

    const mismatchDependencies = dependenciesWith(
      async (request) => {
        expect(request.type).toBe("request_human_review");
        return { type: "application_mismatch" };
      },
      async (agent, _input, options) => {
        await functionTool(agent, "request_human_review").invoke(
          inspectedRunContext(options.context),
          JSON.stringify({ result: VALID_RESULT }),
        );
        throw new Error("review mismatch must terminate the run");
      },
    );
    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      mismatchDependencies,
    )).rejects.toEqual(new ApplicationAgentFailure("APPLICATION_MISMATCH"));
  });


  test("drops oversized browser output and lets the model recover with a snapshot", async () => {
    let runtimeCalls = 0;
    const dependencies = dependenciesWith(
      async () => {
        runtimeCalls += 1;
        return runtimeCalls === 1
          ? {
              type: "playwright_cli_result" as const,
              exit_code: 0,
              stdout: "",
              stderr: "",
              stdout_truncated: false,
              stderr_truncated: false,
              cli_error_category: null,
              observation: {
                url: "https://apply.example.test/form",
                title: "Application",
                tabs: [],
                dom: "",
                page_info: { private_payload: "x".repeat(600 * 1024) },
                screenshot: null,
              },
            }
          : PRE_SUBMISSION_EXECUTION_RESULT;
      },
      async (agent, _input, options) => {
        const context = options.context;
        if (!context) throw new Error("application context is required");
        const browser = functionTool(agent, "playwright_cli");
        const runContext = new RunContext(context);
        const oversized = await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        expect(JSON.parse(String(oversized))).toMatchObject({
          type: "tool_error",
          code: "invalid_response",
        });
        expect(context.browserSnapshotRequired).toBe(true);
        const recovered = await browser.invoke(
          runContext,
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        expect(JSON.parse(String(recovered))).toMatchObject({ type: "playwright_cli_result" });
        expect(context.browserSnapshotRequired).toBe(false);
        throw new Error("stop after oversized output recovery");
      },
    );
    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toThrow("stop after oversized output recovery");
    expect(runtimeCalls).toBe(2);
  });
  test("preserves an active tool-call cancellation reason without deadline mapping", async () => {
    const toolController = new AbortController();
    const cancellationReason = new DOMException("tool cancelled", "TimeoutError");
    const dependencies = dependenciesWith(
      async (_request, signal) => {
        toolController.abort(cancellationReason);
        signal.throwIfAborted();
        throw new Error("runtime client did not receive the tool cancellation");
      },
      async (agent, _input, options) => {
        await functionTool(agent, "playwright_cli").invoke(
          new RunContext(options.context),
          JSON.stringify({ command: "snapshot", args: [] }),
          { signal: toolController.signal },
        );
        throw new Error("tool cancellation must terminate the run");
      },
    );

    await expect(runApplicationAgent(
      RUN_INPUT,
      new AbortController().signal,
      dependencies,
    )).rejects.toBe(cancellationReason);
  });
  test("preserves cancellation when malformed tool input is rejected", async () => {
    const toolController = new AbortController();
    const reason = new DOMException("cancelled tool", "AbortError");
    const dependencies = dependenciesWith(
      async () => { throw new Error("invalid input must not reach the runtime"); },
      async (agent, _input, options) => {
        toolController.abort(reason);
        await functionTool(agent, "playwright_cli").invoke(
          new RunContext(options.context), "{", { signal: toolController.signal },
        );
        throw new Error("cancellation must not become a tool result");
      },
    );
    await expect(runApplicationAgent(
      RUN_INPUT, new AbortController().signal, dependencies,
    )).rejects.toBe(reason);
  });
  test("propagates the active tool-call abort signal to runtime HTTP", async () => {
    const outerController = new AbortController();
    const toolController = new AbortController();
    const abortReason = new DOMException("tool deadline", "AbortError");
    const dependencies = dependenciesWith(
      async (_request, signal) => {
        toolController.abort(abortReason);
        signal.throwIfAborted();
        throw new Error("runtime client did not receive the tool signal");
      },
      async (agent, _input, options) => {
        await functionTool(agent, "playwright_cli").invoke(
          new RunContext(options.context),
          JSON.stringify({ command: "snapshot", args: [] }),
          { signal: toolController.signal },
        );
        throw new Error("tool abort must terminate the run");
      },
    );
    try {
      await runApplicationAgent(RUN_INPUT, outerController.signal, dependencies);
      throw new Error("expected tool abort");
    } catch (error) {
      expect(error).toBe(abortReason);
      expect(outerController.signal.aborted).toBe(false);
    }
  });
  test("propagates request abort reasons unchanged", async () => {
    const controller = new AbortController();
    const abortReason = new DOMException("request deleted", "AbortError");
    const dependencies = dependenciesWith(
      async () => {
        controller.abort(abortReason);
        throw abortReason;
      },
      async (agent, _input, options) => {
        await functionTool(agent, "playwright_cli").invoke(
          new RunContext(options.context),
          JSON.stringify({ command: "snapshot", args: [] }),
        );
        throw new Error("abort must terminate the run");
      },
    );
    try {
      await runApplicationAgent(RUN_INPUT, controller.signal, dependencies);
      throw new Error("expected abort");
    } catch (error) {
      expect(error).toBe(abortReason);
    }
  });
});
