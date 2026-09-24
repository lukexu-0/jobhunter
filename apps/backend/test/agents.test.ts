import { describe, expect, test } from "bun:test";
import {
  Agent,
  RunContext,
  Runner,
  Usage,
  type AgentInputItem,
  type Model,
  type CallModelInputFilter,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type Tool,
} from "@openai/agents-core";
import { createHash } from "node:crypto";
import { z } from "zod";
import { SYNTHETIC_RESUME } from "./private-context.fixture.ts";
import {
  AgentDeadlineError,
  createTerminalSubmission,
  runAnalysisAgent,
  runAtsKeywordExtractionAgent,
  runEditAgent,
  runRepairAgent,
  runTailoringAgent,
  runWithDeadline,
  type AgentRunner,
  type AgentRunOptions,
  type AgentRuntimeDependencies,
} from "../src/agents/index.ts";
import type { ContextSnapshot } from "../src/context/types.ts";
import { hashJobAnalysis } from "../src/resume/ledger.ts";
import { parseBaselineResume } from "../src/resume/parser.ts";
import type { TailoringPlan } from "../src/resume/types.ts";
import {
  ANALYSIS_INSTRUCTIONS,
  ANALYSIS_VALIDATION_FEEDBACK_MAX_CHARS,
  ANALYSIS_TASK,
  ANALYSIS_WORKFLOW_SHA256,
  validateAnalysisAgainstAtsKeywordExtraction,
  validatePersistedAnalysisAgainstAtsKeywordExtraction,
} from "../src/agents/analysis-agent.ts";
import {
  ATS_KEYWORD_EXTRACTION_INSTRUCTIONS,
  ATS_KEYWORD_EXTRACTION_TASK,
  ATS_KEYWORD_EXTRACTION_VALIDATION_FEEDBACK_MAX_CHARS,
  ATS_KEYWORD_EXTRACTION_WORKFLOW_SHA256,
  ATS_KEYWORD_EXTRACTION_PROFILES,
  validateAtsKeywordExtractionAgainstJobDescription,
  validatePersistedAtsKeywordExtractionAgainstJobDescription,
} from "../src/agents/ats-keyword-extraction-agent.ts";
import {
  buildMechanicalTailoringPlan,
  MAX_TAILORING_TOOL_BYTES,
  MAX_TAILORING_TOOL_CALLS,
  type OnePageCorrection,
  TAILORING_INSTRUCTIONS,
  TAILORING_TASK,
  TAILORING_WORKFLOW_SHA256,
} from "../src/agents/tailoring-agent.ts";
import { atsKeywordExtractionFixture, jobAnalysisFixture } from "./job-analysis.fixture.ts";

const RAW_JOB_DESCRIPTION = "Build production TypeScript systems";
const RAW_JOB_DESCRIPTION_SHA256 = createHash("sha256").update(RAW_JOB_DESCRIPTION).digest("hex");
const ATS_KEYWORD_EXTRACTION = atsKeywordExtractionFixture({
  rawJobDescription: RAW_JOB_DESCRIPTION,
  jobDescriptionSha256: RAW_JOB_DESCRIPTION_SHA256,
});
const BASELINE = SYNTHETIC_RESUME;
const BASELINE_INVENTORY = parseBaselineResume(BASELINE);
const ANALYSIS = jobAnalysisFixture({
  jobDescriptionSha256: RAW_JOB_DESCRIPTION_SHA256,
  baselineSource: BASELINE,
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
  mustIncludeDirectives: [],
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

function functionTool<TContext>(agent: Agent<TContext, "text">, name: string) {
  const candidate: Tool<TContext> | undefined = agent.tools.find(
    (item) => item.type === "function" && item.name === name,
  );
  if (!candidate || candidate.type !== "function") throw new Error(`missing function tool ${name}`);
  return candidate;
}

async function invoke<TContext>(
  agent: Agent<TContext, "text">,
  name: string,
  input: unknown,
): Promise<unknown> {
  return functionTool(agent, name).invoke(new RunContext<TContext>(), JSON.stringify(input));
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

function runOptionsAreFresh(options: { maxTurns: number | null; signal: AbortSignal }, maxTurns: number): void {
  expect(options.maxTurns).toBe(maxTurns);
  expect(options.signal).toBeInstanceOf(AbortSignal);
  expect(Object.keys(options).sort()).toEqual(["maxTurns", "signal"]);
}

describe("guarded agents", () => {
  test("keeps live ATS workflow validators strict while accepting an otherwise valid persisted extraction", () => {
    const historicalExtraction = {
      ...ATS_KEYWORD_EXTRACTION,
      keywordExtractionWorkflowSha256: "f".repeat(64),
    };

    expect(() =>
      validateAtsKeywordExtractionAgainstJobDescription(
        historicalExtraction,
        RAW_JOB_DESCRIPTION,
      )).toThrow("must match the supplied keyword extraction workflow hash");
    expect(() =>
      validateAnalysisAgainstAtsKeywordExtraction(
        ANALYSIS,
        historicalExtraction,
        "job",
      )).toThrow("does not match the configured workflow");
    expect(validatePersistedAtsKeywordExtractionAgainstJobDescription(
      historicalExtraction,
      RAW_JOB_DESCRIPTION,
    )).toEqual(historicalExtraction);
    expect(validatePersistedAnalysisAgainstAtsKeywordExtraction(
      ANALYSIS,
      historicalExtraction,
    )).toEqual(ANALYSIS);
  });

  test("persisted ATS validators retain description grounding and exact analysis lineage", () => {
    const historicalExtraction = {
      ...ATS_KEYWORD_EXTRACTION,
      keywordExtractionWorkflowSha256: "f".repeat(64),
    };
    const [keyword] = historicalExtraction.keywords;

    expect(() => validatePersistedAtsKeywordExtractionAgainstJobDescription({
      ...historicalExtraction,
      keywords: [{ ...keyword!, jdQuote: "TypeScript absent from the JD" }],
    }, RAW_JOB_DESCRIPTION)).toThrow("must occur verbatim in the supplied job description");
    expect(() => validatePersistedAtsKeywordExtractionAgainstJobDescription({
      ...historicalExtraction,
      keywords: [{ ...keyword!, phrase: "Rust" }],
    }, RAW_JOB_DESCRIPTION)).toThrow("must occur case-insensitively in its exact JD quote");
    expect(() => validatePersistedAnalysisAgainstAtsKeywordExtraction({
      ...ANALYSIS,
      jobDescriptionSha256: "e".repeat(64),
    }, historicalExtraction)).toThrow("job description hashes do not match");
    expect(() => validatePersistedAnalysisAgainstAtsKeywordExtraction({
      ...ANALYSIS,
      jdKeywords: ANALYSIS.jdKeywords.map((candidate, index) =>
        index === 0 ? { ...candidate, phrase: candidate.phrase.toUpperCase() } : candidate),
    }, historicalExtraction)).toThrow("analysis semantic validation failed");
    expect(() => validatePersistedAnalysisAgainstAtsKeywordExtraction(
      ANALYSIS,
      {
        ...historicalExtraction,
        keywords: historicalExtraction.keywords.map((candidate, index) =>
          index === 0 ? { ...candidate, id: "keyword-replaced" } : candidate),
      },
    )).toThrow("analysis semantic validation failed");
    expect(() => validatePersistedAnalysisAgainstAtsKeywordExtraction({
      ...ANALYSIS,
      jdKeywords: ANALYSIS.jdKeywords.map((candidate, index) =>
        index === 0 ? { ...candidate, jdQuote: `${candidate.jdQuote} altered` } : candidate),
    }, historicalExtraction)).toThrow("analysis semantic validation failed");
  });

  test("extracts strict JD-grounded keywords through one guarded Sol submission", async () => {
    const providerIds: string[] = [];
    const runtime = runtimeWith(async (agent, input, options) => {
      runOptionsAreFresh(options, 4);
      expect(agent.name).toBe("ats-job-keyword-extraction");
      expect(agent.model).toBe("gpt-5.6-sol");
      expect(agent.handoffs).toEqual([]);
      expect(agent.mcpServers).toEqual([]);
      expect(typeof agent.toolUseBehavior).toBe("function");
      expect(agent.resetToolChoice).toBe(false);
      expect(agent.modelSettings).toMatchObject({
        reasoning: { effort: "medium" },
        toolChoice: "submit_ats_keyword_extraction",
        parallelToolCalls: false,
        store: false,
        retry: { maxRetries: 0 },
      });
      expect(agent.instructions).toBe(ATS_KEYWORD_EXTRACTION_INSTRUCTIONS);
      expect(agent.tools.map((item) => item.name)).toEqual(["submit_ats_keyword_extraction"]);
      expect(functionTool(agent, "submit_ats_keyword_extraction")).toMatchObject({
        name: "submit_ats_keyword_extraction",
        description: "Submit the complete ATS keyword extraction once.",
        strict: true,
      });
      const parsedInput = JSON.parse(String(input));
      expect(Object.keys(parsedInput).sort()).toEqual([
        "jobDescriptionSha256",
        "keywordExtractionWorkflowSha256",
        "rawJobDescription",
        "task",
      ]);
      expect(parsedInput).toEqual({
        task: ATS_KEYWORD_EXTRACTION_TASK,
        rawJobDescription: RAW_JOB_DESCRIPTION,
        jobDescriptionSha256: RAW_JOB_DESCRIPTION_SHA256,
        keywordExtractionWorkflowSha256: ATS_KEYWORD_EXTRACTION_WORKFLOW_SHA256,
      });
      expect(await invoke(
        agent,
        "submit_ats_keyword_extraction",
        ATS_KEYWORD_EXTRACTION,
      )).toEqual(ATS_KEYWORD_EXTRACTION);
      return { finalOutput: ATS_KEYWORD_EXTRACTION };
    }, providerIds);

    await expect(runAtsKeywordExtractionAgent({
      attemptSessionId: "ats-extraction",
      input: { opportunityKind: "job", rawJobDescription: RAW_JOB_DESCRIPTION },
      signal: new AbortController().signal,
      runtime,
    })).resolves.toEqual(ATS_KEYWORD_EXTRACTION);
    expect(providerIds).toEqual(["ats-extraction"]);
  });

  test("routes non-job opportunities through their keyword extraction profiles", async () => {
    const cases = [
      { opportunityKind: "hackathon", profileKind: "hackathon" },
      { opportunityKind: "competition", profileKind: "competition" },
      { opportunityKind: "event", profileKind: "event" },
      { opportunityKind: "networking_event", profileKind: "event" },
    ] as const;
    for (const { opportunityKind, profileKind } of cases) {
      const profile = ATS_KEYWORD_EXTRACTION_PROFILES[profileKind];
      const expected = {
        ...ATS_KEYWORD_EXTRACTION,
        keywordExtractionWorkflowSha256: profile.workflowSha256,
      };
      const runtime = runtimeWith(async (agent, input) => {
        expect(agent.name).toBe(profile.agentName);
        expect(agent.instructions).toBe(profile.instructions);
        expect(JSON.parse(String(input))).toEqual({
          task: profile.task,
          rawJobDescription: RAW_JOB_DESCRIPTION,
          jobDescriptionSha256: RAW_JOB_DESCRIPTION_SHA256,
          keywordExtractionWorkflowSha256: profile.workflowSha256,
        });
        expect(await invoke(agent, "submit_ats_keyword_extraction", expected)).toEqual(expected);
        return { finalOutput: expected };
      });

      await expect(runAtsKeywordExtractionAgent({
        attemptSessionId: `ats-${opportunityKind}`,
        input: { opportunityKind, rawJobDescription: RAW_JOB_DESCRIPTION },
        signal: new AbortController().signal,
        runtime,
      })).resolves.toEqual(expected);
    }
  });

  test("returns bounded ATS correction feedback without leaking invalid submitted content", async () => {
    const submittedQuote = "Sensitive invented quote from the submitted payload";
    let feedback = "";
    const runtime = runtimeWith(async (agent, _input, options) => {
      runOptionsAreFresh(options, 4);
      const invalid = {
        ...ATS_KEYWORD_EXTRACTION,
        keywords: ATS_KEYWORD_EXTRACTION.keywords.map((keyword) => ({
          ...keyword,
          jdQuote: submittedQuote,
        })),
      };
      feedback = String(await invoke(agent, "submit_ats_keyword_extraction", invalid));
      expect(feedback.length).toBeLessThanOrEqual(
        ATS_KEYWORD_EXTRACTION_VALIDATION_FEEDBACK_MAX_CHARS,
      );
      expect(feedback).toContain("$.keywords[0].jdQuote:");
      expect(feedback).toContain("must occur verbatim in the supplied job description");
      expect(feedback).toContain("call submit_ats_keyword_extraction again");
      expect(feedback).not.toContain(submittedQuote);
      expect(feedback).not.toContain(JSON.stringify(invalid));
      expect(await invoke(
        agent,
        "submit_ats_keyword_extraction",
        ATS_KEYWORD_EXTRACTION,
      )).toEqual(ATS_KEYWORD_EXTRACTION);
      return {};
    });

    await expect(runAtsKeywordExtractionAgent({
      attemptSessionId: "ats-correction",
      input: { opportunityKind: "job", rawJobDescription: RAW_JOB_DESCRIPTION },
      signal: new AbortController().signal,
      runtime,
    })).resolves.toEqual(ATS_KEYWORD_EXTRACTION);
    expect(feedback).not.toBe("");
  });

  test("fails ATS extraction on cancellation without invoking the model runner", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel ATS extraction");
    controller.abort(reason);
    let runnerCalls = 0;
    const runtime = runtimeWith(async () => {
      runnerCalls++;
      return {};
    });
    await expect(runAtsKeywordExtractionAgent({
      attemptSessionId: "ats-cancelled",
      input: { opportunityKind: "job", rawJobDescription: RAW_JOB_DESCRIPTION },
      signal: controller.signal,
      runtime,
    })).rejects.toBe(reason);
    expect(runnerCalls).toBe(0);
  });

  test("projects validated analysis input and uses one strict submission per fresh attempt", async () => {
    const providerIds: string[] = [];
    let calls = 0;
    const runtime = runtimeWith(async (agent, input, options) => {
      calls++;
      runOptionsAreFresh(options, 4);
      expect(agent.model).toBe("gpt-5.6-sol");
      expect(agent.handoffs).toEqual([]);
      expect(agent.mcpServers).toEqual([]);
      expect(typeof agent.toolUseBehavior).toBe("function");
      expect(agent.resetToolChoice).toBe(false);
      expect(agent.modelSettings).toMatchObject({
        reasoning: { effort: "xhigh" }, toolChoice: "submit_job_analysis", parallelToolCalls: false, store: false,
        retry: { maxRetries: 0 },
      });
      expect(agent.instructions).toBe(ANALYSIS_INSTRUCTIONS);
      expect(agent.tools.map((item) => item.name)).toEqual(["submit_job_analysis"]);
      expect(functionTool(agent, "submit_job_analysis")).toMatchObject({
        name: "submit_job_analysis",
        description: "Submit the structured analysis once.",
        strict: true,
      });

      const parsedInput = JSON.parse(String(input));
      expect(Object.keys(parsedInput).sort()).toEqual([
        "analysisWorkflowSha256",
        "atsKeywordExtraction",
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
        atsKeywordExtraction: ATS_KEYWORD_EXTRACTION,
        jobDescriptionSha256: RAW_JOB_DESCRIPTION_SHA256,
        baselineSha256: BASELINE_INVENTORY.sha256,
        rawJobDescription: RAW_JOB_DESCRIPTION,
        baselineInventory: {
          sha256: BASELINE_INVENTORY.sha256,
          bullets: BASELINE_INVENTORY.bullets,
          skills: BASELINE_INVENTORY.skills,
        },
        candidateEvidence: {
          authoritative: [{
            source: "Past project",
            entityId: "project:past-project",
            headingPath: ["Past Project"],
            text: "Built a production project with measurable outcomes.",
            caveats: [],
          }],
          mustIncludeDirectives: [],
          explicitEntityBindings: CONTEXT.explicitEntityBindings,
        },
      });
      expect(Object.keys(parsedInput.baselineInventory)).toEqual(["sha256", "bullets", "skills"]);
      expect(Object.keys(parsedInput.candidateEvidence)).toEqual([
        "authoritative", "mustIncludeDirectives", "explicitEntityBindings",
      ]);
      expect(parsedInput.candidateEvidence.authoritative[0].text)
        .toBe("Built a production project with measurable outcomes.");
      expect(parsedInput).not.toHaveProperty("canonicalCv");
      expect(parsedInput).not.toHaveProperty("context");
      expect(parsedInput).not.toHaveProperty("candidateContext");
      expect(parsedInput).not.toHaveProperty("manifestSha256");
      expect(parsedInput).not.toHaveProperty("sources");
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
    const input = { opportunityKind: "job", rawJobDescription: RAW_JOB_DESCRIPTION, atsKeywordExtraction: ATS_KEYWORD_EXTRACTION, canonicalCv: BASELINE, context: CONTEXT } as const;
    await runAnalysisAgent({ attemptSessionId: "attempt-a", input, signal, runtime });
    await runAnalysisAgent({ attemptSessionId: "attempt-b", input, signal, runtime });
    expect(calls).toBe(2);
    expect(providerIds).toEqual(["attempt-a", "attempt-b"]);
  });

  test("validates completed analysis against the selected opportunity workflow", async () => {
    const opportunityKind = "competition" as const;
    const atsKeywordExtraction = {
      ...ATS_KEYWORD_EXTRACTION,
      keywordExtractionWorkflowSha256:
        ATS_KEYWORD_EXTRACTION_PROFILES[opportunityKind].workflowSha256,
    };
    const runtime = runtimeWith(async (agent) => {
      await invoke(agent, "submit_job_analysis", ANALYSIS);
      return { finalOutput: ANALYSIS };
    });

    await expect(runAnalysisAgent({
      attemptSessionId: "competition-analysis",
      input: {
        opportunityKind,
        rawJobDescription: RAW_JOB_DESCRIPTION,
        atsKeywordExtraction,
        canonicalCv: BASELINE,
        context: CONTEXT,
      },
      signal: new AbortController().signal,
      runtime,
    })).resolves.toEqual(ANALYSIS);
  });

  test("separates requirement directives from factual analysis evidence", async () => {
    const requirementBlocks = [
      {
        ...CONTEXT.evidence[1]!,
        id: "past-project-requirement-impact",
        ordinal: 1,
        headingPath: ["Past Project", "Must Include"],
        text: "Mention the project's measurable production impact.",
        sha256: "1".repeat(64),
      },
      {
        ...CONTEXT.evidence[1]!,
        id: "past-project-requirement-scale",
        ordinal: 2,
        headingPath: ["Past Project", "21. Must Include"],
        text: "Mention the project's production scale.",
        sha256: "2".repeat(64),
      },
      {
        ...CONTEXT.evidence[1]!,
        id: "past-project-no-requirement",
        ordinal: 3,
        headingPath: ["Past Project", "21. Must Include"],
        text: "None specified",
        sha256: "3".repeat(64),
      },
    ] as const;
    const context: ContextSnapshot = {
      ...CONTEXT,
      evidence: [...CONTEXT.evidence, ...requirementBlocks],
      mustIncludeDirectives: [
        {
          sourceId: requirementBlocks[0].sourceId,
          entityId: requirementBlocks[0].entityId,
          text: requirementBlocks[0].text,
        },
        {
          sourceId: requirementBlocks[1].sourceId,
          entityId: requirementBlocks[1].entityId,
          text: requirementBlocks[1].text,
        },
      ],
    };
    const runtime = runtimeWith(async (agent, input) => {
      const candidateEvidence = JSON.parse(String(input)).candidateEvidence;
      expect(candidateEvidence.authoritative.map((block: { text: string }) => block.text))
        .toEqual(["Built a production project with measurable outcomes."]);
      expect(candidateEvidence.mustIncludeDirectives).toEqual([
        { entityId: "project:past-project", text: "Mention the project's measurable production impact." },
        { entityId: "project:past-project", text: "Mention the project's production scale." },
      ]);
      for (const retiredField of ["evidenceId", "sourceId", "sourceVersionId", "sha256"]) {
        expect(JSON.stringify(candidateEvidence)).not.toContain(`"${retiredField}"`);
      }
      await invoke(agent, "submit_job_analysis", ANALYSIS);
      return { finalOutput: ANALYSIS };
    });

    await expect(runAnalysisAgent({
      attemptSessionId: "analysis-requirement-projection",
      input: {
        opportunityKind: "job",
        rawJobDescription: RAW_JOB_DESCRIPTION,
        atsKeywordExtraction: ATS_KEYWORD_EXTRACTION,
        canonicalCv: BASELINE,
        context,
      },
      signal: new AbortController().signal,
      runtime,
    })).resolves.toEqual(ANALYSIS);
  });

  test("keeps schema-invalid analysis calls uncounted and exposes bounded correction feedback", async () => {
    let feedback = "";
    const runtime = runtimeWith(async (agent, _input, options) => {
      runOptionsAreFresh(options, 4);
      const invalidAfter = "Changed text copied from an invalid model payload";
      const invalid = {
        ...ANALYSIS,
        exactEdits: ANALYSIS.exactEdits.map((edit) => ({
          ...edit,
          after: invalidAfter,
        })),
      };
      const invalidOutput = await invoke(agent, "submit_job_analysis", invalid);
      expect(typeof invalidOutput).toBe("string");
      feedback = String(invalidOutput);
      expect(feedback.length).toBeLessThanOrEqual(ANALYSIS_VALIDATION_FEEDBACK_MAX_CHARS);
      expect(feedback).toContain("$.exactEdits[0].after:");
      expect(feedback).toContain("replacement does not contain a linked keyword phrase");
      expect(feedback).toContain("Correction checklist:");
      expect(feedback).not.toContain(ANALYSIS.exactEdits[0]?.after ?? "");
      expect(feedback).not.toContain(invalidAfter);
      expect(feedback).not.toContain("\"schemaVersion\"");
      expect(feedback).not.toContain("\n    at ");

      const correctedOutput = await invoke(agent, "submit_job_analysis", ANALYSIS);
      expect(correctedOutput).toEqual(ANALYSIS);
      return {};
    });

    await expect(runAnalysisAgent({
      attemptSessionId: "schema-correction",
      input: { opportunityKind: "job", rawJobDescription: RAW_JOB_DESCRIPTION, atsKeywordExtraction: ATS_KEYWORD_EXTRACTION, canonicalCv: BASELINE, context: CONTEXT },
      signal: new AbortController().signal,
      runtime,
    })).resolves.toEqual(ANALYSIS);
    expect(feedback).not.toBe("");
  });

  test("groups multiple semantic categories in one feedback turn before strict corrected acceptance", async () => {
    const invalid = {
      ...ANALYSIS,
      analysisWorkflowSha256: "f".repeat(64),
      jdKeywords: ANALYSIS.jdKeywords.map((keyword) => ({
        ...keyword,
        jdQuote: "Absent TypeScript quote",
      })),
      exactEdits: ANALYSIS.exactEdits.map((edit) => ({
        ...edit,
        before: edit.kind === "bullet" ? `${edit.before} stale` : edit.before,
        after: edit.kind === "skill" ? "TypeScript" : edit.after,
      })),
    };
    const responses = [invalid, ANALYSIS];
    const feedback: string[] = [];
    let responseIndex = 0;
    const model: Model = {
      async getResponse(request: ModelRequest): Promise<ModelResponse> {
        if (Array.isArray(request.input)) {
          for (let index = request.input.length - 1; index >= 0; index--) {
            const item = request.input[index];
            if (item?.type !== "function_call_result") continue;
            feedback.push(typeof item.output === "string" ? item.output : JSON.stringify(item.output));
            break;
          }
        }
        const response = responses[responseIndex];
        if (!response) throw new Error("scripted analysis model received an unexpected turn");
        responseIndex++;
        return {
          usage: new Usage({ requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
          output: [{
            type: "function_call",
            callId: `analysis-call-${responseIndex}`,
            name: "submit_job_analysis",
            arguments: JSON.stringify(response),
            status: "completed",
          }],
          responseId: `analysis-response-${responseIndex}`,
        };
      },
      async *getStreamedResponse(): AsyncIterable<never> {
        throw new Error("scripted analysis model does not stream");
      },
    };
    const provider: ModelProvider = {
      getModel(): Model {
        return model;
      },
    };
    const runtime: AgentRuntimeDependencies = {
      providerFactory: () => provider,
      runnerFactory: (config) => new Runner(config),
    };

    await expect(runAnalysisAgent({
      attemptSessionId: "runner-correction",
      input: { opportunityKind: "job", rawJobDescription: RAW_JOB_DESCRIPTION, atsKeywordExtraction: ATS_KEYWORD_EXTRACTION, canonicalCv: BASELINE, context: CONTEXT },
      signal: new AbortController().signal,
      runtime,
    })).resolves.toEqual(ANALYSIS);

    expect(responseIndex).toBe(2);
    expect(feedback).toHaveLength(1);
    const output = feedback[0]!;
    expect(output.length).toBeLessThanOrEqual(ANALYSIS_VALIDATION_FEEDBACK_MAX_CHARS);
    expect(output).toContain("Validation issues grouped by category:");
    expect(output).toContain("Hashes and snapshot:");
    expect(output).toContain("$.analysisWorkflowSha256: must match the supplied analysis workflow hash");
    expect(output).toContain("Job-description grounding:");
    expect(output).toContain("$.jdKeywords[0].jdQuote: must occur verbatim in the supplied job description");
    expect(output).toContain("Baseline targets:");
    expect(output).toContain("$.exactEdits[0].before: must exactly match the supplied baseline bullet text");
    expect(output).toContain("Skill replacements:");
    expect(output).toContain("$.exactEdits[1].after: must not duplicate an existing baseline skill in its category");
    expect(output).toContain("call submit_job_analysis again");
    expect(output).toContain("Correction checklist:");
    expect(output).not.toContain("\"schemaVersion\"");
    expect(output).not.toContain(ANALYSIS.exactEdits[0]?.after ?? "");
    expect(output).not.toContain(invalid.jdKeywords[0]?.jdQuote ?? "");
    expect(output).not.toContain("\n    at ");
  });

  test("accepts an extracted subset and rejects changed keyword identity without content leaks", async () => {
    const changedId = "changed-submitted-keyword-id";
    const changedPhrase = "TYPESCRIPT";
    const changedQuote = "production TypeScript";
    const invalidSubmissions = [
      {
        value: {
          ...ANALYSIS,
          jdKeywords: ANALYSIS.jdKeywords.map((keyword) => ({ ...keyword, id: changedId })),
          exactEdits: ANALYSIS.exactEdits.map((edit) => ({
            ...edit,
            keywordIds: [changedId],
          })),
        },
        path: "$.jdKeywords[0].id:",
      },
      {
        value: {
          ...ANALYSIS,
          jdKeywords: ANALYSIS.jdKeywords.map((keyword) => ({
            ...keyword,
            phrase: changedPhrase,
          })),
        },
        path: "$.jdKeywords[0].phrase:",
      },
      {
        value: {
          ...ANALYSIS,
          jdKeywords: ANALYSIS.jdKeywords.map((keyword) => ({
            ...keyword,
            jdQuote: changedQuote,
          })),
        },
        path: "$.jdKeywords[0].jdQuote:",
      },
    ];
    const feedback: string[] = [];
    const runtime = runtimeWith(async (agent) => {
      for (const invalid of invalidSubmissions) {
        const output = String(await invoke(agent, "submit_job_analysis", invalid.value));
        feedback.push(output);
        expect(output).toContain("Job-description grounding:");
        expect(output).toContain(invalid.path);
        expect(output).not.toContain(changedId);
        expect(output).not.toContain(changedPhrase);
        expect(output).not.toContain(changedQuote);
      }
      expect(await invoke(agent, "submit_job_analysis", ANALYSIS)).toEqual(ANALYSIS);
      return {};
    });

    await expect(runAnalysisAgent({
      attemptSessionId: "analysis-extraction-grounding",
      input: { opportunityKind: "job", rawJobDescription: RAW_JOB_DESCRIPTION, atsKeywordExtraction: ATS_KEYWORD_EXTRACTION, canonicalCv: BASELINE, context: CONTEXT },
      signal: new AbortController().signal,
      runtime,
    })).resolves.toEqual(ANALYSIS);
    expect(feedback).toHaveLength(3);
  });

  test("rejects plain text or absent submission", async () => {
    const runtime = runtimeWith(async () => ({ finalOutput: "plain text" }));
    await expect(runAnalysisAgent({
      attemptSessionId: "plain",
      input: { opportunityKind: "job", rawJobDescription: RAW_JOB_DESCRIPTION, atsKeywordExtraction: ATS_KEYWORD_EXTRACTION, canonicalCv: BASELINE, context: CONTEXT },
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
      input: { opportunityKind: "job", rawJobDescription: RAW_JOB_DESCRIPTION, atsKeywordExtraction: ATS_KEYWORD_EXTRACTION, canonicalCv: BASELINE, context: CONTEXT },
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

    const defaultValidation = createTerminalSubmission({
      name: "default_validation",
      description: "default validation",
      schema: z.object({ value: z.string() }).strict(),
      validate: () => {
        throw new Error("original default validation error");
      },
    });
    await expect(defaultValidation.tool.type === "function"
      ? defaultValidation.tool.invoke(new RunContext(), JSON.stringify({ value: "ok" }))
      : Promise.reject(new Error("not a function tool")))
      .rejects.toThrow("original default validation error");
    expect(defaultValidation.count()).toBe(0);
  });

  test("awaits async terminal validation and rejects concurrent submission", async () => {
    const validationStarted = Promise.withResolvers<void>();
    const releaseValidation = Promise.withResolvers<void>();
    const submission = createTerminalSubmission({
      name: "async_result",
      description: "async",
      schema: z.object({ value: z.string() }).strict(),
      validate: async () => {
        validationStarted.resolve();
        await releaseValidation.promise;
      },
    });
    if (submission.tool.type !== "function") throw new Error("not a function tool");

    const first = submission.tool.invoke(new RunContext(), JSON.stringify({ value: "ok" }));
    await validationStarted.promise;
    expect(submission.count()).toBe(0);
    expect(submission.value()).toBeUndefined();
    await expect(
      submission.tool.invoke(new RunContext(), JSON.stringify({ value: "duplicate" })),
    ).rejects.toThrow("exactly once");
    releaseValidation.resolve();
    await expect(first).resolves.toEqual({ value: "ok" });
    expect(submission.count()).toBe(1);
    expect(submission.value()).toEqual({ value: "ok" });

    let rejectValidation = true;
    const retryable = createTerminalSubmission({
      name: "retryable_result",
      description: "retryable",
      schema: z.object({ value: z.string() }).strict(),
      validate: async () => {
        if (rejectValidation) throw new Error("durable commit failed");
      },
    });
    if (retryable.tool.type !== "function") throw new Error("not a function tool");
    await expect(
      retryable.tool.invoke(new RunContext(), JSON.stringify({ value: "first" })),
    ).rejects.toThrow("durable commit failed");
    expect(retryable.count()).toBe(0);
    rejectValidation = false;
    await expect(
      retryable.tool.invoke(new RunContext(), JSON.stringify({ value: "second" })),
    ).resolves.toEqual({ value: "second" });
    expect(retryable.count()).toBe(1);
  });

  test("tailoring performs the exact four-call mechanical sequence", async () => {
    const tailoredTex = `${BASELINE}\n% isolated tailored copy`;
    const sequence: string[] = [];
    let renderCalls = 0;
    const runtime = runtimeWith(async (agent, input, options) => {
      runOptionsAreFresh(options, MAX_TAILORING_TOOL_CALLS + 1);
      expect(agent.modelSettings).toMatchObject({
        reasoning: { effort: "high" }, parallelToolCalls: false, store: false,
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

      const parsedInput = JSON.parse(String(input));
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

  test("allows up to 100 aggregate tailoring tool calls without per-tool caps", async () => {
    const tailoredTex = `${BASELINE}\n% repeatedly inspected tailored copy`;
    const runtime = runtimeWith(async (agent, _input, options) => {
      runOptionsAreFresh(options, MAX_TAILORING_TOOL_CALLS + 1);
      for (let call = 0; call < 50; call++) {
        expect(await invoke(agent, "read_working_tex", {})).toBe(BASELINE);
      }
      await invoke(agent, "apply_analysis_edits", {});
      for (let call = 0; call < 49; call++) {
        expect(await invoke(agent, "read_working_tex", {})).toBe(tailoredTex);
      }
      await invoke(agent, "submit_tailoring_result", {});
      return {};
    });

    await expect(runTailoringAgent({
      attemptSessionId: "tailor-aggregate-budget",
      input: {
        analysis: ANALYSIS,
        baseline: BASELINE,
        operations: { renderPlan: () => tailoredTex },
      },
      signal: new AbortController().signal,
      runtime,
    })).resolves.toEqual({ plan: PLAN, toolCount: 101 });
  });

  test("rejects the 101st aggregate tailoring tool call", async () => {
    const runtime = runtimeWith(async (agent, _input, options) => {
      runOptionsAreFresh(options, MAX_TAILORING_TOOL_CALLS + 1);
      for (let call = 0; call < 100; call++) {
        await invoke(agent, "read_working_tex", {});
      }
      await invoke(agent, "read_working_tex", {});
      return {};
    });

    await expect(runTailoringAgent({
      attemptSessionId: "tailor-aggregate-budget-exhausted",
      input: {
        analysis: ANALYSIS,
        baseline: BASELINE,
        operations: { renderPlan: () => BASELINE },
      },
      signal: new AbortController().signal,
      runtime,
    })).rejects.toThrow("tailoring tool call budget of 100 exhausted");
  });

  test("an over-budget working-copy read cannot satisfy the submission inspection latch", async () => {
    const oversizedOutput = "x".repeat(258_000);
    const runtime = runtimeWith(async (agent, _input, options) => {
      runOptionsAreFresh(options, MAX_TAILORING_TOOL_CALLS + 1);
      await invoke(agent, "read_working_tex", {});
      await invoke(agent, "apply_analysis_edits", {});
      for (let call = 0; call < 12; call++) {
        expect(await invoke(agent, "read_working_tex", {})).toBe(oversizedOutput);
      }
      await invoke(agent, "apply_analysis_edits", {});
      await expect(invoke(agent, "read_working_tex", {}))
        .rejects.toThrow(`tailoring tool byte budget of ${MAX_TAILORING_TOOL_BYTES} exhausted`);
      await expect(invoke(agent, "submit_tailoring_result", {}))
        .rejects.toThrow("requires reading the applied working copy");
      return {};
    });

    await expect(runTailoringAgent({
      attemptSessionId: "tailor-over-budget-read",
      input: {
        analysis: ANALYSIS,
        baseline: BASELINE,
        operations: { renderPlan: () => oversizedOutput },
      },
      signal: new AbortController().signal,
      runtime,
    })).rejects.toThrow("requires exactly one validated terminal call");
  });

  test("an over-budget apply leaves the inspected working copy unchanged", async () => {
    const inputBytes = Buffer.byteLength(JSON.stringify({}));
    const smallOutput = "a";
    const applyOutputBytes = (preview: string): number => Buffer.byteLength(JSON.stringify({
      ok: true,
      bytes: Buffer.byteLength(preview),
      sha256: createHash("sha256").update(preview).digest("hex"),
    }));
    const largeReadCount = 12;
    const sampleLargeOutput = "x".repeat(250_000);
    const fixedBytes = inputBytes + Buffer.byteLength(JSON.stringify(BASELINE))
      + inputBytes + applyOutputBytes(sampleLargeOutput)
      + inputBytes + applyOutputBytes(smallOutput)
      + inputBytes + Buffer.byteLength(JSON.stringify(smallOutput))
      + inputBytes;
    const targetSerializedBytes = Math.floor(
      (MAX_TAILORING_TOOL_BYTES - fixedBytes - 32) / largeReadCount,
    ) - inputBytes;
    const largeOutput = "x".repeat(targetSerializedBytes - Buffer.byteLength(JSON.stringify("")));
    expect(Buffer.byteLength(largeOutput)).toBeLessThanOrEqual(256 * 1024);
    expect(Buffer.byteLength(JSON.stringify(largeOutput))).toBe(targetSerializedBytes);

    let renderCall = 0;
    const runtime = runtimeWith(async (agent, _input, options) => {
      runOptionsAreFresh(options, MAX_TAILORING_TOOL_CALLS + 1);
      await invoke(agent, "read_working_tex", {});
      await invoke(agent, "apply_analysis_edits", {});
      for (let call = 0; call < largeReadCount; call++) {
        expect(await invoke(agent, "read_working_tex", {})).toBe(largeOutput);
      }
      await invoke(agent, "apply_analysis_edits", {});
      expect(await invoke(agent, "read_working_tex", {})).toBe(smallOutput);
      expect(await invoke(agent, "apply_analysis_edits", {}))
        .toContain(`tailoring tool byte budget of ${MAX_TAILORING_TOOL_BYTES} exhausted`);
      expect(await invoke(agent, "read_working_tex", {})).toBe(smallOutput);
      await invoke(agent, "submit_tailoring_result", {});
      return {};
    });

    await expect(runTailoringAgent({
      attemptSessionId: "tailor-over-budget-apply",
      input: {
        analysis: ANALYSIS,
        baseline: BASELINE,
        operations: {
          renderPlan: () => {
            renderCall++;
            return renderCall === 2 ? smallOutput : largeOutput;
          },
        },
      },
      signal: new AbortController().signal,
      runtime,
    })).resolves.toEqual({ plan: PLAN, toolCount: 19 });
  });

  test("propagates bounded one-page correction metrics into model input and applies its cut", async () => {
    const bullet = BASELINE_INVENTORY.bullets.at(-1);
    expect(bullet).toBeDefined();
    const onePageCorrection: OnePageCorrection = {
      note: "Resume is 2 pages, 1 page over the one-page limit, with 1 visible line after page 1. Remove lower-priority content until it fits.",
      failureCount: 1,
      requiredOmissionCount: 1,
      pageCount: 2,
      pagesOverLimit: 1,
      overflowLineCount: 1,
      candidates: [{
        baselineItemId: bullet!.id,
        section: bullet!.section,
        entityId: bullet!.entityId,
        text: bullet!.text,
      }],
    };
    for (const invalidMetrics of [
      { pageCount: 1, pagesOverLimit: 0, overflowLineCount: 1 },
      { pageCount: 3, pagesOverLimit: 1, overflowLineCount: 1 },
      { pageCount: 2, pagesOverLimit: 1, overflowLineCount: 0 },
    ]) {
      expect(() => buildMechanicalTailoringPlan(ANALYSIS, BASELINE, {
        ...onePageCorrection,
        ...invalidMetrics,
      })).toThrow("one-page correction metrics are invalid");
    }
    const correctedPlan = buildMechanicalTailoringPlan(ANALYSIS, BASELINE, onePageCorrection);
    const correctedTex = `${BASELINE}\n% one-page corrected copy`;
    const runtime = runtimeWith(async (agent, input, options) => {
      runOptionsAreFresh(options, MAX_TAILORING_TOOL_CALLS + 1);
      const parsedInput = JSON.parse(String(input));
      expect(parsedInput.onePageCorrection).toEqual(onePageCorrection);
      expect(String(input)).toContain("\"pageCount\":2");
      expect(String(input)).toContain("\"pagesOverLimit\":1");
      expect(String(input)).toContain("\"overflowLineCount\":1");
      expect(String(input)).toContain("Remove lower-priority content until it fits.");
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
    }]);
    expect(result.toolCount).toBe(4);
  });

  test("rejects applying analysis edits before reading the baseline", async () => {
    let guardResult: unknown;
    let renderCalls = 0;
    const runtime = runtimeWith(async (agent, _input, options) => {
      runOptionsAreFresh(options, MAX_TAILORING_TOOL_CALLS + 1);
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
      runOptionsAreFresh(options, MAX_TAILORING_TOOL_CALLS + 1);
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
      const parsed = JSON.parse(String(input));
      expect(parsed).toMatchObject({
        analysis: ANALYSIS,
        currentPlan: PLAN,
        currentTailoredTex: "immutable tex",
        candidateEvidence: {
          authoritative: [{
            source: "Past project",
            entityId: "project:past-project",
            headingPath: ["Past Project"],
            text: "Built a production project with measurable outcomes.",
            caveats: [],
          }],
          mustIncludeDirectives: [],
          baseline: [{
            entityId: "resume:baseline",
            headingPath: ["Canonical baseline"],
            text: "Canonical resume baseline evidence.",
            caveats: [],
          }],
          explicitEntityBindings: CONTEXT.explicitEntityBindings,
        },
        comments: ["shorten bullet"],
        machineFindings: { issue: "crowding" },
      });
      expect(parsed).not.toHaveProperty("candidateContext");
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

  test("separates requirement directives from factual edit evidence", async () => {
    const requirementBlock = {
      ...CONTEXT.evidence[1]!,
      id: "past-project-edit-requirement",
      ordinal: 1,
      headingPath: ["Past Project", "Must Include"],
      text: "Keep the supported production-impact requirement.",
      sha256: "3".repeat(64),
    };
    const sentinelBlock = {
      ...requirementBlock,
      id: "past-project-edit-no-requirement",
      ordinal: 2,
      text: "None specified",
      sha256: "4".repeat(64),
    };
    const context: ContextSnapshot = {
      ...CONTEXT,
      evidence: [...CONTEXT.evidence, requirementBlock, sentinelBlock],
      mustIncludeDirectives: [{
        sourceId: requirementBlock.sourceId,
        entityId: requirementBlock.entityId,
        text: requirementBlock.text,
      }],
    };
    const runtime = runtimeWith(async (agent, input) => {
      const parsed = JSON.parse(String(input));
      expect(parsed).not.toHaveProperty("candidateContext");
      expect(parsed.candidateEvidence.authoritative.map((block: { text: string }) => block.text))
        .toEqual(["Built a production project with measurable outcomes."]);
      expect(parsed.candidateEvidence.mustIncludeDirectives).toEqual([{
        entityId: "project:past-project",
        text: "Keep the supported production-impact requirement.",
      }]);
      for (const retiredField of ["evidenceId", "sourceId", "sourceVersionId", "sha256"]) {
        expect(JSON.stringify(parsed.candidateEvidence)).not.toContain(`"${retiredField}"`);
      }
      return {};
    });

    await expect(runEditAgent({
      attemptSessionId: "edit-requirement-projection",
      signal: new AbortController().signal,
      runtime,
      input: {
        analysis: ANALYSIS,
        currentPlan: PLAN,
        currentTailoredTex: "immutable tex",
        context,
        deterministicQa: { ok: true },
        visualQa: { status: "pass" },
      },
    })).rejects.toThrow("requires exactly one validated terminal call");
  });

  test("forwards generic run options and replaces the transcript assertion", async () => {
    const context = { sessionId: "application-session" };
    const callModelInputFilter: CallModelInputFilter<typeof context> = ({ modelData }) => modelData;
    const oversizedResult = { finalOutput: "x".repeat(2 * 1024 * 1024 + 1) };
    let assertedResult: unknown;
    const assertTranscript = (result: unknown): void => {
      assertedResult = result;
    };
    const runner: AgentRunner = {
      async run<TContext>(
        _agent: Agent<TContext, "text">,
        _input: string | AgentInputItem[],
        options: AgentRunOptions<TContext>,
      ): Promise<unknown> {
        expect(options.context).toBe(context as unknown as TContext);
        expect(options.callModelInputFilter).toBe(
          callModelInputFilter as unknown as CallModelInputFilter<TContext>,
        );
        expect(options.assertTranscript).toBe(assertTranscript);
        expect(Object.keys(options).sort()).toEqual([
          "assertTranscript",
          "callModelInputFilter",
          "context",
          "maxTurns",
          "signal",
        ]);
        return oversizedResult;
      },
    };
    const contextualAgent = new Agent<typeof context>({ name: "contextual", model: "unused" });

    const result = await runWithDeadline(
      runner,
      contextualAgent,
      "{}",
      2,
      new AbortController().signal,
      1_000,
      { context, callModelInputFilter, assertTranscript },
    );

    expect(result).toBe(oversizedResult);
    expect(assertedResult).toBe(oversizedResult);

    const legacyRunner: AgentRunner = {
      async run(_agent, _input, options): Promise<unknown> {
        expect(Object.keys(options).sort()).toEqual(["maxTurns", "signal"]);
        return oversizedResult;
      },
    };
    await expect(runWithDeadline(
      legacyRunner,
      contextualAgent,
      "{}",
      2,
      new AbortController().signal,
      1_000,
    )).rejects.toThrow("agent transcript exceeds 2097152 bytes");
  });

  test("outer abort settles even when the runner ignores its run signal", async () => {
    const outerController = new AbortController();
    const abortReason = new Error("caller stopped an uncooperative runner");
    const {
      promise: runStarted,
      resolve: markRunStarted,
    } = Promise.withResolvers<void>();
    const { promise: pendingRun } = Promise.withResolvers<unknown>();
    const runner: AgentRunner = {
      run: async () => {
        markRunStarted();
        return pendingRun;
      },
    };
    const inertAgent = new Agent({ name: "outer-abort", model: "unused" });

    const invocation = runWithDeadline(
      runner,
      inertAgent,
      "{}",
      1,
      outerController.signal,
      10_000,
    ).catch((error: unknown) => error);
    await runStarted;
    outerController.abort(abortReason);

    expect(await invocation).toBe(abortReason);
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
