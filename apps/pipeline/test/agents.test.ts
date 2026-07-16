import { describe, expect, test } from "bun:test";
import { Agent, RunContext, type Model, type ModelProvider, type Tool } from "@openai/agents-core";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
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
import type { ContextSnapshot } from "../src/context/types.ts";
import { hashJobAnalysis } from "../src/resume/ledger.ts";
import type { TailoringPlan } from "../src/resume/types.ts";
import {
  ANALYSIS_WORKFLOW_PROMPT,
  ANALYSIS_WORKFLOW_SHA256,
  TAILORING_WORKFLOW_PROMPT,
  TAILORING_WORKFLOW_SHA256,
  jobAnalysisFixture,
} from "./job-analysis.fixture.ts";

const RAW_JOB_DESCRIPTION = "raw-jd";
const RAW_JOB_DESCRIPTION_SHA256 = createHash("sha256").update(RAW_JOB_DESCRIPTION).digest("hex");
const ANALYSIS = jobAnalysisFixture({ jobDescriptionSha256: RAW_JOB_DESCRIPTION_SHA256 });
const BASELINE = readFileSync(resolve(import.meta.dir, "../../../actual/resume-main/main.tex"), "utf8");
const CONTEXT: ContextSnapshot = {
  manifestSha256: "c".repeat(64),
  baselineSha256: "d".repeat(64),
  sourceHashes: { "past-project": "e".repeat(64) },
  sources: [{
    id: "past-project",
    relativePath: "actual/current-context/projects/past-project.md",
    kind: "authoritative-markdown",
    entityId: "project:past-project",
    displayName: "Past project",
    baselineEntityIds: ["Past Project"],
    sourceVersionId: "past-project-version",
    sha256: "e".repeat(64),
    bytes: 100,
    indexedAt: 1,
  }],
  evidence: [{
    id: "past-project-evidence",
    sourceVersionId: "past-project-version",
    sourceId: "past-project",
    entityId: "project:past-project",
    ordinal: 0,
    headingPath: ["Past Project"],
    text: "Built a production project with measurable outcomes.",
    caveats: [],
    sha256: "f".repeat(64),
  }],
  explicitEntityBindings: {},
};

const PLAN: TailoringPlan = {
  id: "plan-1",
  analysisId: ANALYSIS.id,
  analysisSha256: hashJobAnalysis(ANALYSIS),
  tailoringWorkflowSha256: TAILORING_WORKFLOW_SHA256,
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
\section{Competitions \& Other}
\resumeSubheading{Result}{Dates}{Competition}{Place}
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
      const parsedInput = JSON.parse(input);
      expect(parsedInput).toMatchObject({
        analysisWorkflowSha256: ANALYSIS_WORKFLOW_SHA256,
        jobDescriptionSha256: RAW_JOB_DESCRIPTION_SHA256,
        rawJobDescription: "raw-jd",
        canonicalCv: "canonical-cv",
        candidateContext: CONTEXT,
      });
      expect(agent.instructions).toContain(ANALYSIS_WORKFLOW_PROMPT);
      await invoke(agent, "submit_job_analysis", ANALYSIS);
      return { finalOutput: ANALYSIS };
    }, providerIds);
    const signal = new AbortController().signal;
    await runAnalysisAgent({ attemptSessionId: "attempt-a", input: { rawJobDescription: "raw-jd", canonicalCv: "canonical-cv", context: CONTEXT }, signal, runtime });
    await runAnalysisAgent({ attemptSessionId: "attempt-b", input: { rawJobDescription: "raw-jd", canonicalCv: "canonical-cv", context: CONTEXT }, signal, runtime });
    expect(calls).toBe(2);
    expect(providerIds).toEqual(["attempt-a", "attempt-b"]);
  });

  test("rejects analysis produced for a different workflow revision", async () => {
    const runtime = runtimeWith(async (agent) => {
      await invoke(agent, "submit_job_analysis", {
        ...ANALYSIS,
        analysisWorkflowSha256: "f".repeat(64),
      });
      return {};
    });
    await expect(runAnalysisAgent({
      attemptSessionId: "stale-workflow",
      input: { rawJobDescription: "jd", canonicalCv: "cv", context: CONTEXT },
      signal: new AbortController().signal,
      runtime,
    })).rejects.toThrow("configured analysis workflow");
  });

  test("rejects analysis produced for a different job description", async () => {
    const runtime = runtimeWith(async (agent) => {
      await invoke(agent, "submit_job_analysis", ANALYSIS);
      return {};
    });
    await expect(runAnalysisAgent({
      attemptSessionId: "stale-job",
      input: { rawJobDescription: "different-jd", canonicalCv: "cv", context: CONTEXT },
      signal: new AbortController().signal,
      runtime,
    })).rejects.toThrow("supplied job description");
  });

  test("rejects plain text or absent submission", async () => {
    const runtime = runtimeWith(async () => ({ finalOutput: "plain text" }));
    await expect(runAnalysisAgent({
      attemptSessionId: "plain", input: { rawJobDescription: "jd", canonicalCv: "cv", context: CONTEXT }, signal: new AbortController().signal, runtime,
    })).rejects.toThrow("requires exactly one validated terminal call");
  });

  test("rejects duplicate submission and strict-schema extras", async () => {
    const duplicateRuntime = runtimeWith(async (agent) => {
      await invoke(agent, "submit_job_analysis", ANALYSIS);
      await invoke(agent, "submit_job_analysis", ANALYSIS);
      return {};
    });
    await expect(runAnalysisAgent({
      attemptSessionId: "duplicate", input: { rawJobDescription: "jd", canonicalCv: "cv", context: CONTEXT }, signal: new AbortController().signal, runtime: duplicateRuntime,
    })).rejects.toThrow("exactly once");

    const submission = createTerminalSubmission({
      name: "strict_result", description: "strict", schema: z.object({ value: z.string() }).strict(),
    });
    await expect(submission.tool.type === "function"
      ? submission.tool.invoke(new RunContext(), JSON.stringify({ value: "ok", extra: true }))
      : Promise.reject(new Error("not a function tool"))).rejects.toThrow();
    expect(submission.count()).toBe(0);
  });

  test("tailoring edits and inspects an isolated working copy before terminal submission", async () => {
    const tailoredTex = `${BASELINE}\n% isolated tailored copy`;
    let renderCalls = 0;
    const runtime = runtimeWith(async (agent, input, options) => {
      runOptionsAreFresh(options, 9);
      expect(agent.modelSettings).toMatchObject({
        reasoning: { effort: "medium" }, parallelToolCalls: false, store: false,
        retry: { maxRetries: 0 },
      });
      expect(agent.modelSettings.toolChoice).toBeUndefined();
      expect(agent.handoffs).toEqual([]);
      expect(agent.mcpServers).toEqual([]);
      expect(agent.toolUseBehavior).toEqual({ stopAtToolNames: ["submit_tailoring_plan"] });
      expect(agent.tools.map((item) => item.name)).toEqual([
        "read_working_tex", "apply_tailoring_plan", "submit_tailoring_plan",
      ]);
      expect(agent.instructions).toContain(TAILORING_WORKFLOW_PROMPT);
      expect(agent.instructions).not.toContain("## Step 15");
      expect(input).not.toContain("SECRET RAW JD");
      expect(input).not.toContain("\\documentclass");
      const parsedInput = JSON.parse(input);
      expect(Object.keys(parsedInput)).toEqual([
        "task", "analysisId", "analysisSha256", "tailoringWorkflowSha256", "analysis", "candidateContext", "baselineInventory",
      ]);
      expect(parsedInput).toMatchObject({
        analysisId: ANALYSIS.id,
        analysisSha256: hashJobAnalysis(ANALYSIS),
        tailoringWorkflowSha256: TAILORING_WORKFLOW_SHA256,
        analysis: ANALYSIS,
        candidateContext: CONTEXT,
      });
      expect(parsedInput.baselineInventory.entities.some(
        (entity: { section: string }) => entity.section === "competitions-other",
      )).toBeTrue();
      expect(await invoke(agent, "read_working_tex", {})).toBe(BASELINE);
      expect(await invoke(agent, "apply_tailoring_plan", {
        plan: { ...PLAN, tailoringWorkflowSha256: "f".repeat(64) },
      })).toContain("Plan rejected");
      expect(await invoke(agent, "apply_tailoring_plan", {
        plan: { ...PLAN, analysisSha256: "f".repeat(64) },
      })).toContain("Plan rejected");
      expect(await invoke(agent, "apply_tailoring_plan", { plan: PLAN })).toMatchObject({ ok: true });
      expect(await invoke(agent, "read_working_tex", {})).toBe(tailoredTex);
      await invoke(agent, "submit_tailoring_plan", { plan: PLAN });
      return {};
    });
    const result = await runTailoringAgent({
      attemptSessionId: "tailor",
      input: {
        analysis: ANALYSIS,
        baseline: BASELINE,
        context: CONTEXT,
        operations: {
          renderPlan(plan, signal) {
            renderCalls++;
            signal.throwIfAborted();
            expect(plan).toEqual(PLAN);
            return tailoredTex;
          },
        },
      },
      signal: new AbortController().signal,
      runtime,
    });
    expect(renderCalls).toBe(1);
    expect(result).toEqual({ plan: PLAN, tailoredTex, toolCount: 6 });
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
