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
import { parseBaselineResume } from "../src/resume/parser.ts";
import type { TailoringPlan } from "../src/resume/types.ts";
import {
  ANALYSIS_INSTRUCTIONS,
  ANALYSIS_TASK,
  ANALYSIS_WORKFLOW_SHA256,
} from "../src/agents/analysis-agent.ts";
import {
  buildMechanicalTailoringPlan,
  type OnePageCorrection,
  TAILORING_INSTRUCTIONS,
  TAILORING_TASK,
  TAILORING_WORKFLOW_SHA256,
} from "../src/agents/tailoring-agent.ts";
import { jobAnalysisFixture } from "./job-analysis.fixture.ts";

const RAW_JOB_DESCRIPTION = "Build production TypeScript systems";
const RAW_JOB_DESCRIPTION_SHA256 = createHash("sha256").update(RAW_JOB_DESCRIPTION).digest("hex");
const BASELINE = readFileSync(resolve(import.meta.dir, "../../user-info/resume-main/main.tex"), "utf8");
const BASELINE_INVENTORY = parseBaselineResume(BASELINE);
const ANALYSIS = jobAnalysisFixture({
  jobDescriptionSha256: RAW_JOB_DESCRIPTION_SHA256,
  baselineSource: BASELINE,
  evidenceId: "baseline-evidence",
});
const CONTEXT: ContextSnapshot = {
  manifestSha256: "c".repeat(64),
  baselineSha256: BASELINE_INVENTORY.sha256,
  sourceHashes: {
    "canonical-baseline": BASELINE_INVENTORY.sha256,
    "past-project": "e".repeat(64),
  },
  sources: [
    {
      id: "canonical-baseline",
      relativePath: "actual/resume-main/main.tex",
      kind: "baseline",
      entityId: "resume:baseline",
      displayName: "Canonical baseline",
      baselineEntityIds: [],
      sourceVersionId: "canonical-baseline-version",
      sha256: BASELINE_INVENTORY.sha256,
      bytes: Buffer.byteLength(BASELINE),
      indexedAt: 1,
    },
    {
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
    },
  ],
  evidence: [
    {
      id: "baseline-evidence",
      sourceVersionId: "canonical-baseline-version",
      sourceId: "canonical-baseline",
      entityId: "resume:baseline",
      ordinal: 0,
      headingPath: ["Canonical baseline"],
      text: "Canonical resume baseline evidence.",
      caveats: [],
      sha256: createHash("sha256").update("Canonical resume baseline evidence.").digest("hex"),
    },
    {
      id: "past-project-evidence",
      sourceVersionId: "past-project-version",
      sourceId: "past-project",
      entityId: "project:past-project",
      ordinal: 0,
      headingPath: ["Past Project"],
      text: "Built a production project with measurable outcomes.",
      caveats: [],
      sha256: "f".repeat(64),
    },
  ],
  explicitEntityBindings: { "Past Project": "project:past-project" },
};

const PLAN: TailoringPlan = buildMechanicalTailoringPlan(ANALYSIS, BASELINE);

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
  test("owns short, hash-locked prompts without legacy workflow sections", () => {
    expect(ANALYSIS_TASK).toBe(
      "Identify evidence-backed JD keywords and exact replacements for existing resume bullets and skills.",
    );
    expect(ANALYSIS_INSTRUCTIONS).toBe(
      "Analyze the role and improve the resume using only the supplied job description, baseline inventory, and evidence. Return exact edits to existing items; use \"Accomplished [X] as measured by [Y] by doing [Z]\" only when evidence supports X, Y, and Z, never invent facts, copy the supplied hashes, and call submit_job_analysis once.",
    );
    expect(TAILORING_TASK).toBe(
      "Apply the supplied exact edits and any required one-page correction to the canonical LaTeX.",
    );
    expect(TAILORING_INSTRUCTIONS).toBe(
      "Mechanically apply analysis.exactEdits to matching baseline items. Retain all other content unless input.onePageCorrection requires bounded lower-priority omissions; then make those cuts while preserving truthfulness and readability. Call read_working_tex, apply_analysis_edits, read_working_tex, then submit_tailoring_result.",
    );
    expect(ANALYSIS_WORKFLOW_SHA256).toBe(
      createHash("sha256").update(`${ANALYSIS_TASK}\n${ANALYSIS_INSTRUCTIONS}`).digest("hex"),
    );
    expect(TAILORING_WORKFLOW_SHA256).toBe(
      createHash("sha256").update(`${TAILORING_TASK}\n${TAILORING_INSTRUCTIONS}`).digest("hex"),
    );
    expect(`${ANALYSIS_TASK} ${ANALYSIS_INSTRUCTIONS}`.trim().split(/\s+/).length)
      .toBeLessThanOrEqual(67);
    expect(`${TAILORING_TASK} ${TAILORING_INSTRUCTIONS}`.trim().split(/\s+/).length)
      .toBeLessThanOrEqual(50);
    const prompts = `${ANALYSIS_TASK}\n${ANALYSIS_INSTRUCTIONS}\n${TAILORING_TASK}\n${TAILORING_INSTRUCTIONS}`;
    for (const legacySection of [
      "Role-market analysis",
      "Requirement Evidence Matrix",
      "Recruiter Risks",
      "Gaps and Mitigations",
      "Keyword Alignment",
      "Proposed CV Content",
      "Business Value Bullet Review",
      "Truthful Keyword Use",
      "Customization Plan",
      "screening filters",
      "subjective culture language",
    ]) {
      expect(prompts).not.toContain(legacySection);
    }
  });

  test("projects validated analysis input and uses one strict submission per fresh attempt", async () => {
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
      expect(agent.instructions).toBe(ANALYSIS_INSTRUCTIONS);
      expect(agent.tools.map((item) => item.name)).toEqual(["submit_job_analysis"]);
      expect(functionTool(agent, "submit_job_analysis")).toMatchObject({
        name: "submit_job_analysis",
        description: "Submit the structured analysis once.",
        strict: true,
      });

      const parsedInput = JSON.parse(input);
      expect(Object.keys(parsedInput).sort()).toEqual([
        "analysisWorkflowSha256",
        "baselineInventory",
        "baselineSha256",
        "candidateEvidence",
        "jobDescriptionSha256",
        "rawJobDescription",
        "task",
      ]);
      expect(parsedInput).toMatchObject({
        task: ANALYSIS_TASK,
        analysisWorkflowSha256: ANALYSIS_WORKFLOW_SHA256,
        jobDescriptionSha256: RAW_JOB_DESCRIPTION_SHA256,
        baselineSha256: BASELINE_INVENTORY.sha256,
        rawJobDescription: RAW_JOB_DESCRIPTION,
        baselineInventory: {
          sha256: BASELINE_INVENTORY.sha256,
          bullets: BASELINE_INVENTORY.bullets,
          skills: BASELINE_INVENTORY.skills,
        },
        candidateEvidence: {
          authoritative: [CONTEXT.evidence[1]],
          baselineCitations: [{
            id: "baseline-evidence",
            sourceVersionId: "canonical-baseline-version",
            sourceId: "canonical-baseline",
            entityId: "resume:baseline",
            headingPath: ["Canonical baseline"],
            caveats: [],
            sha256: CONTEXT.evidence[0]?.sha256,
          }],
          explicitEntityBindings: CONTEXT.explicitEntityBindings,
        },
      });
      expect(Object.keys(parsedInput.baselineInventory)).toEqual(["sha256", "bullets", "skills"]);
      expect(Object.keys(parsedInput.candidateEvidence)).toEqual([
        "authoritative", "baselineCitations", "explicitEntityBindings",
      ]);
      expect(parsedInput.candidateEvidence.authoritative[0].text)
        .toBe("Built a production project with measurable outcomes.");
      expect(parsedInput).not.toHaveProperty("canonicalCv");
      expect(parsedInput).not.toHaveProperty("context");
      expect(parsedInput).not.toHaveProperty("candidateContext");
      expect(parsedInput).not.toHaveProperty("manifestSha256");
      expect(parsedInput).not.toHaveProperty("sources");
      expect(parsedInput.candidateEvidence.baselineCitations[0]).not.toHaveProperty("text");
      expect(parsedInput.candidateEvidence.baselineCitations[0]).not.toHaveProperty("ordinal");
      expect(input).not.toContain("\\documentclass");
      expect(input).not.toContain("\"manifestSha256\"");
      expect(input).not.toContain("\"sourceHashes\"");

      let submissions = 0;
      await invoke(agent, "submit_job_analysis", ANALYSIS);
      submissions++;
      expect(submissions).toBe(1);
      return { finalOutput: ANALYSIS };
    }, providerIds);
    const signal = new AbortController().signal;
    const input = { rawJobDescription: RAW_JOB_DESCRIPTION, canonicalCv: BASELINE, context: CONTEXT };
    await runAnalysisAgent({ attemptSessionId: "attempt-a", input, signal, runtime });
    await runAnalysisAgent({ attemptSessionId: "attempt-b", input, signal, runtime });
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
      input: { rawJobDescription: RAW_JOB_DESCRIPTION, canonicalCv: BASELINE, context: CONTEXT },
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
      input: { rawJobDescription: "different-jd", canonicalCv: BASELINE, context: CONTEXT },
      signal: new AbortController().signal,
      runtime,
    })).rejects.toThrow("job description hash");
  });

  test("rejects plain text or absent submission", async () => {
    const runtime = runtimeWith(async () => ({ finalOutput: "plain text" }));
    await expect(runAnalysisAgent({
      attemptSessionId: "plain",
      input: { rawJobDescription: RAW_JOB_DESCRIPTION, canonicalCv: BASELINE, context: CONTEXT },
      signal: new AbortController().signal,
      runtime,
    })).rejects.toThrow("requires exactly one validated terminal call");
  });

  test("rejects duplicate submission and strict-schema extras", async () => {
    const duplicateRuntime = runtimeWith(async (agent) => {
      await invoke(agent, "submit_job_analysis", ANALYSIS);
      await invoke(agent, "submit_job_analysis", ANALYSIS);
      return {};
    });
    await expect(runAnalysisAgent({
      attemptSessionId: "duplicate",
      input: { rawJobDescription: RAW_JOB_DESCRIPTION, canonicalCv: BASELINE, context: CONTEXT },
      signal: new AbortController().signal,
      runtime: duplicateRuntime,
    })).rejects.toThrow("exactly once");

    const submission = createTerminalSubmission({
      name: "strict_result", description: "strict", schema: z.object({ value: z.string() }).strict(),
    });
    await expect(submission.tool.type === "function"
      ? submission.tool.invoke(new RunContext(), JSON.stringify({ value: "ok", extra: true }))
      : Promise.reject(new Error("not a function tool"))).rejects.toThrow();
    expect(submission.count()).toBe(0);
  });

  test("tailoring performs the exact four-call mechanical sequence", async () => {
    const tailoredTex = `${BASELINE}\n% isolated tailored copy`;
    const sequence: string[] = [];
    let renderCalls = 0;
    const runtime = runtimeWith(async (agent, input, options) => {
      runOptionsAreFresh(options, 5);
      expect(agent.modelSettings).toMatchObject({
        reasoning: { effort: "medium" }, parallelToolCalls: false, store: false,
        retry: { maxRetries: 0 },
      });
      expect(agent.modelSettings.toolChoice).toBeUndefined();
      expect(agent.handoffs).toEqual([]);
      expect(agent.mcpServers).toEqual([]);
      expect(agent.toolUseBehavior).toEqual({ stopAtToolNames: ["submit_tailoring_result"] });
      expect(agent.tools.map((item) => item.name)).toEqual([
        "read_working_tex", "apply_analysis_edits", "submit_tailoring_result",
      ]);
      expect(agent.instructions).toBe(TAILORING_INSTRUCTIONS);
      expect(functionTool(agent, "read_working_tex")).toMatchObject({
        description: "Read the current LaTeX.", strict: true,
      });
      expect(functionTool(agent, "apply_analysis_edits")).toMatchObject({
        description: "Apply analysis.exactEdits and any required one-page omissions to the working copy.", strict: true,
      });
      expect(functionTool(agent, "submit_tailoring_result")).toMatchObject({
        description: "Submit the inspected mechanical result.", strict: true,
      });

      const parsedInput = JSON.parse(input);
      expect(Object.keys(parsedInput)).toEqual([
        "task", "analysis", "analysisSha256", "tailoringWorkflowSha256",
      ]);
      expect(parsedInput).toEqual({
        task: TAILORING_TASK,
        analysis: ANALYSIS,
        analysisSha256: hashJobAnalysis(ANALYSIS),
        tailoringWorkflowSha256: TAILORING_WORKFLOW_SHA256,
      });
      expect(parsedInput).not.toHaveProperty("context");
      expect(parsedInput).not.toHaveProperty("candidateContext");
      expect(parsedInput).not.toHaveProperty("baselineInventory");
      expect(input).not.toContain("\\documentclass");

      sequence.push("read_working_tex");
      expect(await invoke(agent, "read_working_tex", {})).toBe(BASELINE);
      sequence.push("apply_analysis_edits");
      expect(await invoke(agent, "apply_analysis_edits", {})).toMatchObject({ ok: true });
      sequence.push("read_working_tex");
      expect(await invoke(agent, "read_working_tex", {})).toBe(tailoredTex);
      sequence.push("submit_tailoring_result");
      await invoke(agent, "submit_tailoring_result", {});
      return {};
    });
    const result = await runTailoringAgent({
      attemptSessionId: "tailor",
      input: {
        analysis: ANALYSIS,
        baseline: BASELINE,
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
    expect(sequence).toEqual([
      "read_working_tex", "apply_analysis_edits", "read_working_tex", "submit_tailoring_result",
    ]);
    expect(renderCalls).toBe(1);
    expect(result).toEqual({ plan: PLAN, toolCount: 4 });
  });

  test("propagates the bounded one-page correction note into model input and applies its cut", async () => {
    const bullet = BASELINE_INVENTORY.bullets.at(-1);
    expect(bullet).toBeDefined();
    const onePageCorrection: OnePageCorrection = {
      note: "The compiled resume MUST be exactly one page. Cut lower-priority content as needed while preserving truthfulness and readability.",
      failureCount: 1,
      requiredOmissionCount: 1,
      candidates: [{
        baselineItemId: bullet!.id,
        section: bullet!.section,
        entityId: bullet!.entityId,
        text: bullet!.text,
        evidenceIds: ["baseline-evidence"],
      }],
    };
    const correctedPlan = buildMechanicalTailoringPlan(ANALYSIS, BASELINE, onePageCorrection);
    const correctedTex = `${BASELINE}\n% one-page corrected copy`;
    const runtime = runtimeWith(async (agent, input, options) => {
      runOptionsAreFresh(options, 5);
      const parsedInput = JSON.parse(input);
      expect(parsedInput.onePageCorrection).toEqual(onePageCorrection);
      expect(input).toContain("MUST be exactly one page");
      expect(input).toContain("Cut lower-priority content");
      await invoke(agent, "read_working_tex", {});
      await invoke(agent, "apply_analysis_edits", {});
      expect(await invoke(agent, "read_working_tex", {})).toBe(correctedTex);
      await invoke(agent, "submit_tailoring_result", {});
      return {};
    });

    const result = await runTailoringAgent({
      attemptSessionId: "tailor-one-page-correction",
      input: {
        analysis: ANALYSIS,
        baseline: BASELINE,
        onePageCorrection,
        operations: {
          renderPlan(plan, signal) {
            signal.throwIfAborted();
            expect(plan).toEqual(correctedPlan);
            return correctedTex;
          },
        },
      },
      signal: new AbortController().signal,
      runtime,
    });

    expect(result.plan.omissions).toEqual([{
      baselineItemId: bullet!.id,
      rationale: "Lower-priority content omitted to enforce the one-page resume requirement.",
      evidenceIds: ["baseline-evidence"],
    }]);
    expect(result.toolCount).toBe(4);
  });

  test("rejects applying analysis edits before reading the baseline", async () => {
    let guardResult: unknown;
    let renderCalls = 0;
    const runtime = runtimeWith(async (agent, _input, options) => {
      runOptionsAreFresh(options, 5);
      guardResult = await invoke(agent, "apply_analysis_edits", {});
      return {};
    });
    await expect(runTailoringAgent({
      attemptSessionId: "tailor-apply-before-read",
      input: {
        analysis: ANALYSIS,
        baseline: BASELINE,
        operations: {
          renderPlan() {
            renderCalls++;
            return BASELINE;
          },
        },
      },
      signal: new AbortController().signal,
      runtime,
    })).rejects.toThrow("requires exactly one validated terminal call");
    expect(guardResult).toContain("requires reading the baseline working copy first");
    expect(renderCalls).toBe(0);
  });

  test("rejects submission before inspecting the applied working copy", async () => {
    const runtime = runtimeWith(async (agent, _input, options) => {
      runOptionsAreFresh(options, 5);
      await invoke(agent, "read_working_tex", {});
      await invoke(agent, "apply_analysis_edits", {});
      await expect(invoke(agent, "submit_tailoring_result", {}))
        .rejects.toThrow("requires reading the applied working copy");
      return {};
    });
    await expect(runTailoringAgent({
      attemptSessionId: "tailor-submit-before-inspection",
      input: {
        analysis: ANALYSIS,
        baseline: BASELINE,
        operations: { renderPlan: () => `${BASELINE}\n% preview` },
      },
      signal: new AbortController().signal,
      runtime,
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
        candidateContext: CONTEXT,
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
        context: CONTEXT,
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
