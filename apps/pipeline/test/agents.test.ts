import { describe, expect, test } from "bun:test";
import { Agent, RunContext, type Model, type ModelProvider, type Tool } from "@openai/agents-core";
import { z } from "zod";
import {
  AgentDeadlineError,
  createTerminalSubmission,
  runAnalysisAgent,
  runEditAgent,
  runRepairAgent,
  runTailoringAgent,
  runWithDeadline,
  type AgentRunner,
  type AgentRuntimeDependencies,
} from "../src/agents/index.ts";
import type { JobAnalysis, TailoringPlan } from "../src/resume/types.ts";

const ANALYSIS: JobAnalysis = {
  id: "analysis-1",
  jobDescriptionSha256: "a".repeat(64),
  target: { title: "Engineer" },
  prioritizedKeywords: [],
  guidance: [],
};

const PLAN: TailoringPlan = {
  id: "plan-1",
  analysisId: ANALYSIS.id,
  analysisSha256: "b".repeat(64),
  decisions: [],
  projectOrder: [],
  skillDecisions: [],
  factWinners: [],
  baselineOverrides: [],
  omissions: [],
};

const VALID_REPAIR_TEX = String.raw`\begin{document}
\section{Experience}
\resumeSubheading{Role}{Dates}{Entity}{Place}
\resumeItem{Did work}
\section{Projects}
\section{Technical Skills}
\textbf{Languages}{: TypeScript}
\end{document}`;

function functionTool(agent: Agent<unknown, "text">, name: string) {
  const candidate: Tool<unknown> | undefined = agent.tools.find((item) => item.type === "function" && item.name === name);
  if (!candidate || candidate.type !== "function") throw new Error(`missing function tool ${name}`);
  return candidate;
}

async function invoke(agent: Agent<unknown, "text">, name: string, input: unknown): Promise<unknown> {
  return functionTool(agent, name).invoke(new RunContext(), JSON.stringify(input));
}

function fakeProvider(): ModelProvider {
  return { getModel(): Model { throw new Error("fake runner must not resolve a live model"); } };
}

function runtimeWith(run: AgentRunner["run"], providerIds: string[] = []): AgentRuntimeDependencies {
  return {
    providerFactory(attemptSessionId): ModelProvider {
      providerIds.push(attemptSessionId);
      return fakeProvider();
    },
    runnerFactory(config): AgentRunner {
      expect(config.tracingDisabled).toBe(true);
      expect(config.toolExecution.maxFunctionToolConcurrency).toBe(1);
      return { run };
    },
  };
}

function runOptionsAreFresh(options: { maxTurns: number; signal: AbortSignal }, maxTurns: number): void {
  expect(options.maxTurns).toBe(maxTurns);
  expect(options.signal).toBeInstanceOf(AbortSignal);
  expect(Object.keys(options).sort()).toEqual(["maxTurns", "signal"]);
}

describe("one-turn agents", () => {
  test("uses one explicit run, exact locked configuration, and a fresh provider per attempt", async () => {
    const providerIds: string[] = [];
    let calls = 0;
    const runtime = runtimeWith(async (agent, input, options) => {
      calls++;
      runOptionsAreFresh(options, 1);
      expect(agent.model).toBe("gpt-5.6-sol");
      expect(agent.handoffs).toEqual([]);
      expect(agent.mcpServers).toEqual([]);
      expect(agent.toolUseBehavior).toBe("stop_on_first_tool");
      expect(agent.resetToolChoice).toBe(false);
      expect(agent.modelSettings).toMatchObject({
        reasoning: { effort: "medium" }, toolChoice: "submit_job_analysis", parallelToolCalls: false, store: false,
        retry: { maxRetries: 0 },
      });
      expect(JSON.parse(input).rawJobDescription).toBe("raw-jd");
      await invoke(agent, "submit_job_analysis", ANALYSIS);
      return { finalOutput: ANALYSIS };
    }, providerIds);
    const signal = new AbortController().signal;
    await runAnalysisAgent({ attemptSessionId: "attempt-a", input: { rawJobDescription: "raw-jd", evidence: [] }, signal, runtime });
    await runAnalysisAgent({ attemptSessionId: "attempt-b", input: { rawJobDescription: "raw-jd", evidence: [] }, signal, runtime });
    expect(calls).toBe(2);
    expect(providerIds).toEqual(["attempt-a", "attempt-b"]);
  });

  test("rejects plain text or absent submission", async () => {
    const runtime = runtimeWith(async () => ({ finalOutput: "plain text" }));
    await expect(runAnalysisAgent({
      attemptSessionId: "plain", input: { rawJobDescription: "jd", evidence: [] }, signal: new AbortController().signal, runtime,
    })).rejects.toThrow("requires exactly one validated terminal call");
  });

  test("rejects duplicate submission and strict-schema extras", async () => {
    const duplicateRuntime = runtimeWith(async (agent) => {
      await invoke(agent, "submit_job_analysis", ANALYSIS);
      await invoke(agent, "submit_job_analysis", ANALYSIS);
      return {};
    });
    await expect(runAnalysisAgent({
      attemptSessionId: "duplicate", input: { rawJobDescription: "jd", evidence: [] }, signal: new AbortController().signal, runtime: duplicateRuntime,
    })).rejects.toThrow("exactly once");

    const submission = createTerminalSubmission({
      name: "strict_result", description: "strict", schema: z.object({ value: z.string() }).strict(),
    });
    await expect(submission.tool.type === "function"
      ? submission.tool.invoke(new RunContext(), JSON.stringify({ value: "ok", extra: true }))
      : Promise.reject(new Error("not a function tool"))).rejects.toThrow();
    expect(submission.count()).toBe(0);
  });

  test("tailoring input cannot carry the raw job description", async () => {
    const runtime = runtimeWith(async (agent, input, options) => {
      runOptionsAreFresh(options, 1);
      expect(agent.modelSettings).toMatchObject({
        reasoning: { effort: "medium" }, toolChoice: "submit_tailoring_plan", parallelToolCalls: false, store: false,
        retry: { maxRetries: 0 },
      });
      expect(agent.handoffs).toEqual([]);
      expect(agent.mcpServers).toEqual([]);
      expect(agent.toolUseBehavior).toBe("stop_on_first_tool");
      expect(input).not.toContain("SECRET RAW JD");
      expect(Object.keys(JSON.parse(input))).toEqual(["task", "analysis", "baseline", "evidence"]);
      return {};
    });
    await expect(runTailoringAgent({
      attemptSessionId: "tailor", input: { analysis: ANALYSIS, baseline: {}, evidence: [] }, signal: new AbortController().signal, runtime,
    })).rejects.toThrow("requires exactly one validated terminal call");
  });

  test("edit is one isolated plan-only run over current immutable artifacts and requirements", async () => {
    const runtime = runtimeWith(async (agent, input, options) => {
      runOptionsAreFresh(options, 1);
      expect(agent.modelSettings).toMatchObject({
        reasoning: { effort: "medium" }, toolChoice: "submit_edit_plan", parallelToolCalls: false, store: false,
        retry: { maxRetries: 0 },
      });
      expect(agent.handoffs).toEqual([]);
      expect(agent.mcpServers).toEqual([]);
      expect(agent.toolUseBehavior).toBe("stop_on_first_tool");
      const parsed = JSON.parse(input);
      expect(parsed).toMatchObject({
        analysis: ANALYSIS,
        currentPlan: PLAN,
        currentTailoredTex: "immutable tex",
        comments: ["shorten bullet"],
        machineFindings: { issue: "crowding" },
      });
      return {};
    });
    await expect(runEditAgent({
      attemptSessionId: "edit",
      signal: new AbortController().signal,
      runtime,
      input: {
        analysis: ANALYSIS,
        currentPlan: PLAN,
        currentTailoredTex: "immutable tex",
        evidence: [],
        deterministicQa: { ok: true },
        visualQa: { status: "issue" },
        comments: ["shorten bullet"],
        machineFindings: { issue: "crowding" },
      },
    })).rejects.toThrow("requires exactly one validated terminal call");
  });

  test("deadline aborts the exact run signal", async () => {
    let observedAbort = false;
    const runner: AgentRunner = {
      async run(_agent, _input, options): Promise<unknown> {
        const deferred = Promise.withResolvers<unknown>();
        options.signal.addEventListener("abort", () => {
          observedAbort = true;
          deferred.reject(options.signal.reason);
        }, { once: true });
        return deferred.promise;
      },
    };
    const inertAgent = new Agent({ name: "deadline", model: "unused" });
    await expect(runWithDeadline(runner, inertAgent, "{}", 1, new AbortController().signal, 1)).rejects.toBeInstanceOf(AgentDeadlineError);
    expect(observedAbort).toBe(true);
  });
});

describe("repair agent", () => {
  test("exposes five sequential tools, enforces compile budget, fixed IDs, post-submit rejection, and terminal result", async () => {
    let compileCalls = 0;
    const runtime = runtimeWith(async (agent, _input, options) => {
      runOptionsAreFresh(options, 9);
      expect(agent.tools.map((item) => item.name)).toEqual([
        "read_failed_tex", "read_latex_log", "validate_candidate", "compile_candidate", "submit_repair",
      ]);
      await expect(invoke(agent, "read_failed_tex", { artifactId: "wrong" })).rejects.toThrow("unexpected artifact ID");
      expect(await invoke(agent, "read_latex_log", { artifactId: "log-1" })).toBe("bounded log");
      for (let index = 0; index < 3; index++) {
        await invoke(agent, "validate_candidate", { tailoredTex: `candidate-${index}` });
        await invoke(agent, "compile_candidate", { tailoredTex: `candidate-${index}` });
      }
      await expect(invoke(agent, "compile_candidate", { tailoredTex: "candidate-4" })).rejects.toThrow("budget");
      await invoke(agent, "submit_repair", { status: "unrepaired", tailoredTex: null, changes: [], remainingDiagnostics: ["still broken"] });
      await expect(invoke(agent, "read_failed_tex", { artifactId: "failed-1" })).rejects.toThrow("after terminal submission");
      return { finalOutput: "terminal tool result" };
    });
    const result = await runRepairAgent({
      attemptSessionId: "repair-1",
      signal: new AbortController().signal,
      runtime,
      input: {
        failedTexArtifactId: "failed-1", latexLogArtifactId: "log-1", failedTex: "failed tex", latexLog: "bounded log", canonicalBaseline: "unused",
        operations: {
          async validateCandidate(): Promise<{ ok: boolean; diagnostics: readonly string[] }> { return { ok: true, diagnostics: [] }; },
          async compileCandidate(): Promise<{ ok: boolean; diagnostics: readonly string[] }> {
            compileCalls++;
            return { ok: false, diagnostics: ["broken"] };
          },
        },
      },
    });
    expect(compileCalls).toBe(3);
    expect(result.status).toBe("unrepaired");
  });

  test("rejects repaired terminal output that did not exactly pass validation and compilation", async () => {
    const runtime = runtimeWith(async (agent) => {
      await expect(invoke(agent, "compile_candidate", { tailoredTex: "candidate" }))
        .rejects.toThrow("requires successful validation");
      await expect(invoke(agent, "submit_repair", {
        status: "repaired", tailoredTex: "candidate", changes: [], remainingDiagnostics: [],
      })).rejects.toThrow("successfully validated and compiled candidate");
      await invoke(agent, "submit_repair", {
        status: "unrepaired", tailoredTex: null, changes: [], remainingDiagnostics: ["not repaired"],
      });
      return {};
    });
    const result = await runRepairAgent({
      attemptSessionId: "repair-bypass",
      signal: new AbortController().signal,
      runtime,
      input: {
        failedTexArtifactId: "failed",
        latexLogArtifactId: "log",
        failedTex: "x",
        latexLog: "y",
        canonicalBaseline: "unused",
        operations: {
          async validateCandidate(): Promise<{ ok: boolean; diagnostics: readonly string[] }> {
            return { ok: true, diagnostics: [] };
          },
          async compileCandidate(): Promise<{ ok: boolean; diagnostics: readonly string[] }> {
            return { ok: true, diagnostics: [] };
          },
        },
      },
    });
    expect(result.status).toBe("unrepaired");
  });

  test("accepts the exact candidate after successful validation and compilation", async () => {
    const runtime = runtimeWith(async (agent) => {
      await invoke(agent, "validate_candidate", { tailoredTex: VALID_REPAIR_TEX });
      await invoke(agent, "compile_candidate", { tailoredTex: VALID_REPAIR_TEX });
      await invoke(agent, "submit_repair", {
        status: "repaired",
        tailoredTex: VALID_REPAIR_TEX,
        changes: [{ category: "syntax", summary: "Balanced existing syntax" }],
        remainingDiagnostics: [],
      });
      return {};
    });
    const result = await runRepairAgent({
      attemptSessionId: "repair-success",
      signal: new AbortController().signal,
      runtime,
      input: {
        failedTexArtifactId: "failed",
        latexLogArtifactId: "log",
        failedTex: VALID_REPAIR_TEX,
        latexLog: "log",
        canonicalBaseline: VALID_REPAIR_TEX,
        operations: {
          async validateCandidate(): Promise<{ ok: boolean; diagnostics: readonly string[] }> {
            return { ok: true, diagnostics: [] };
          },
          async compileCandidate(): Promise<{ ok: boolean; diagnostics: readonly string[] }> {
            return { ok: true, diagnostics: [] };
          },
        },
      },
    });
    expect(result.status).toBe("repaired");
    expect(result.tailoredTex).toBe(VALID_REPAIR_TEX);
  });

  test("requires a terminal repair submission", async () => {
    const runtime = runtimeWith(async () => ({}));
    await expect(runRepairAgent({
      attemptSessionId: "repair-absent", signal: new AbortController().signal, runtime,
      input: {
        failedTexArtifactId: "failed", latexLogArtifactId: "log", failedTex: "x", latexLog: "y", canonicalBaseline: "z",
        operations: {
          async validateCandidate(): Promise<{ ok: boolean; diagnostics: readonly string[] }> { return { ok: false, diagnostics: [] }; },
          async compileCandidate(): Promise<{ ok: boolean; diagnostics: readonly string[] }> { return { ok: false, diagnostics: [] }; },
        },
      },
    })).rejects.toThrow("requires exactly one validated terminal call");
  });
});
