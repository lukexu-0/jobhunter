import { describe, expect, test } from "bun:test";
import {
  Usage,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents-core";
import { lstat, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationAgentFailure } from "../src/agents/application-agent.ts";
import {
  ApplicationAgentTraceStore,
  MAX_APPLICATION_AGENT_TRACE_RECORD_BYTES,
  MAX_RETAINED_APPLICATION_AGENT_TRACES,
  type ApplicationAgentTraceRecord,
} from "../src/agents/application-agent-traces.ts";
import {
  createAttemptRunner,
  type AgentRunner,
  type ModelTraceEvent,
} from "../src/agents/runner.ts";

const SESSION_ID = "018f5f78-7f1e-7c61-8a58-c9c321bc6b2a";
const TRACE_ID = "018f5f78-8a90-7861-8b35-10a74486100f";
const NOW = 1_725_000_000_000;

async function traceRoot(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "application-agent-traces-")), "traces");
}

async function readTraceRecords(root: string): Promise<readonly ApplicationAgentTraceRecord[]> {
  const files = await readdir(root);
  expect(files).toEqual([`${NOW}-${SESSION_ID}-${TRACE_ID}.jsonl`]);
  const text = await readFile(join(root, files[0]!), "utf8");
  return text.trimEnd().split("\n").map((line) => JSON.parse(line) as ApplicationAgentTraceRecord);
}

describe("application agent model traces", () => {
  test("persists private model payloads and the terminal invalid-output failure", async () => {
    const root = await traceRoot();
    const store = new ApplicationAgentTraceStore(root, {
      now: () => NOW,
      traceIdFactory: () => TRACE_ID,
    });
    const trace = await store.start({
      sessionId: SESSION_ID,
      opportunityKind: "job",
      autoSubmit: false,
    });

    await trace.record({
      type: "model_request",
      model: "gpt-5.6-sol",
      request: {
        systemInstructions: "private application instructions",
        input: "private applicant task",
        modelSettings: { toolChoice: "required", store: false },
        tools: [],
        outputType: "text",
        handoffs: [],
        tracing: false,
      },
    });
    await trace.record({
      type: "model_response",
      model: "gpt-5.6-sol",
      response: {
        usage: new Usage({
          requests: 1,
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        }),
        output: [{
          type: "function_call",
          callId: "call-invalid",
          name: "request_human_review",
          arguments: "{\"result\":{\"fields_needing_human\":[{\"field\":\"work_authorization\"}]}}",
        }],
      },
    });
    await trace.finish({
      status: "failed",
      error: new ApplicationAgentFailure("INVALID_MODEL_OUTPUT"),
    });

    const records = await readTraceRecords(root);
    expect(records.map((record) => record.type)).toEqual([
      "trace_started",
      "model_request",
      "model_response",
      "trace_finished",
    ]);
    expect(records[1]).toMatchObject({
      sequence: 2,
      sessionId: SESSION_ID,
      request: {
        systemInstructions: "private application instructions",
        input: "private applicant task",
      },
    });
    expect(records[2]).toMatchObject({
      sequence: 3,
      response: {
        output: [{
          type: "function_call",
          name: "request_human_review",
        }],
      },
    });
    expect(records[3]).toMatchObject({
      sequence: 4,
      status: "failed",
      error: {
        name: "ApplicationAgentFailure",
        message: "The model returned invalid output",
        code: "INVALID_MODEL_OUTPUT",
      },
    });
    if (process.platform !== "win32") {
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(root, (await readdir(root))[0]!))).mode & 0o777).toBe(0o600);
    }
  });

  test("canonicalizes an uppercase valid session UUID for trace storage", async () => {
    const root = await traceRoot();
    const store = new ApplicationAgentTraceStore(root, {
      now: () => NOW,
      traceIdFactory: () => TRACE_ID,
    });
    const trace = await store.start({
      sessionId: SESSION_ID.toUpperCase(),
      opportunityKind: "job",
      autoSubmit: false,
    });

    await trace.finish({ status: "completed" });

    const records = await readTraceRecords(root);
    expect(records[0]).toMatchObject({
      type: "trace_started",
      sessionId: SESSION_ID,
    });
  });

  test("records requests and responses through the application model provider", async () => {
    const root = await traceRoot();
    const store = new ApplicationAgentTraceStore(root, {
      now: () => NOW,
      traceIdFactory: () => TRACE_ID,
    });
    const trace = await store.start({
      sessionId: SESSION_ID,
      opportunityKind: "job",
      autoSubmit: true,
    });
    const request: ModelRequest = {
      systemInstructions: "private system prompt",
      input: "private applicant input",
      modelSettings: { store: false },
      tools: [],
      outputType: "text",
      handoffs: [],
      tracing: false,
    };
    const response: ModelResponse = {
      usage: new Usage({
        requests: 1,
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
      }),
      output: [{
        type: "function_call",
        callId: "call-1",
        name: "playwright_cli",
        arguments: "{\"command\":\"snapshot\",\"args\":[]}",
      }],
    };
    const model: Model = {
      async getResponse(): Promise<ModelResponse> {
        return response;
      },
      async *getStreamedResponse() {
        throw new Error("streaming is not used by this test");
      },
    };
    const provider: ModelProvider = {
      getModel(): Model {
        return model;
      },
    };
    let tracedProvider: ModelProvider | undefined;
    createAttemptRunner(SESSION_ID, {
      providerFactory: () => provider,
      runnerFactory: (configuration): AgentRunner => {
        tracedProvider = configuration.modelProvider;
        return {
          async run(): Promise<unknown> {
            throw new Error("the model-provider trace seam does not run an agent");
          },
        };
      },
      modelTraceSink: trace,
    });

    expect(tracedProvider).toBeDefined();
    const tracedModel = await tracedProvider!.getModel("gpt-5.6-sol");
    await expect(tracedModel.getResponse(request)).resolves.toBe(response);
    await trace.finish({ status: "completed" });

    const records = await readTraceRecords(root);
    expect(records.map((record) => record.type)).toEqual([
      "trace_started",
      "model_request",
      "model_response",
      "trace_finished",
    ]);
    expect(records[1]).toMatchObject({
      model: "gpt-5.6-sol",
      request: {
        systemInstructions: "private system prompt",
        input: "private applicant input",
      },
    });
    expect(records[2]).toMatchObject({
      model: "gpt-5.6-sol",
      response: {
        output: [{
          type: "function_call",
          name: "playwright_cli",
        }],
      },
    });
  });

  test("does not replace a hostile model failure while recording it", async () => {
    const hostileFailure = new Proxy(Object.create(null) as object, {
      getPrototypeOf() {
        throw new Error("hostile prototype trap");
      },
    });
    const model: Model = {
      async getResponse(): Promise<ModelResponse> {
        throw hostileFailure;
      },
      async *getStreamedResponse() {
        throw new Error("streaming is not used by this test");
      },
    };
    const events: ModelTraceEvent[] = [];
    let tracedProvider: ModelProvider | undefined;
    createAttemptRunner(SESSION_ID, {
      providerFactory: () => ({ getModel: () => model }),
      runnerFactory: (configuration): AgentRunner => {
        tracedProvider = configuration.modelProvider;
        return {
          async run(): Promise<unknown> {
            throw new Error("the model-provider trace seam does not run an agent");
          },
        };
      },
      modelTraceSink: {
        record(event) {
          events.push(event);
        },
      },
    });
    const tracedModel = await tracedProvider!.getModel("gpt-5.6-sol");
    const request: ModelRequest = {
      input: "private applicant input",
      modelSettings: { store: false },
      tools: [],
      outputType: "text",
      handoffs: [],
      tracing: false,
    };

    const failure = await tracedModel.getResponse(request).catch((error: unknown) => error);

    expect(failure === hostileFailure).toBeTrue();
    expect(events.map((event) => event.type)).toEqual([
      "model_request",
      "model_error",
    ]);
    expect(events[1]).toMatchObject({
      type: "model_error",
      error: {
        name: "UninspectableError",
      },
    });
  });

  test("retains only the newest bounded set of trace files", async () => {
    const root = await traceRoot();
    let sequence = 0;
    const store = new ApplicationAgentTraceStore(root, {
      now: () => NOW + sequence,
      traceIdFactory: () =>
        `018f5f78-8a90-7861-8b35-${(++sequence).toString(16).padStart(12, "0")}`,
    });

    for (let index = 0; index <= MAX_RETAINED_APPLICATION_AGENT_TRACES; index += 1) {
      const trace = await store.start({
        sessionId: SESSION_ID,
        opportunityKind: "job",
        autoSubmit: false,
      });
      await trace.finish({ status: "completed" });
    }

    const files = (await readdir(root)).sort();
    expect(files).toHaveLength(MAX_RETAINED_APPLICATION_AGENT_TRACES);
    expect(files.some((file) => file.startsWith(`${NOW + 1}-`))).toBeFalse();
    expect(files.some((file) => file.startsWith(`${NOW + sequence}-`))).toBeTrue();
  });

  test("keeps the newest completed traces after an older active trace finishes", async () => {
    const root = await traceRoot();
    let sequence = 0;
    const options = {
      now: () => NOW + sequence,
      traceIdFactory: () =>
        `018f5f78-8a90-7861-8b35-${(++sequence).toString(16).padStart(12, "0")}`,
    };
    const olderStore = new ApplicationAgentTraceStore(root, options);
    const newerStore = new ApplicationAgentTraceStore(root, options);
    const olderActiveTrace = await olderStore.start({
      sessionId: SESSION_ID,
      opportunityKind: "job",
      autoSubmit: false,
    });
    for (let index = 0; index < MAX_RETAINED_APPLICATION_AGENT_TRACES; index += 1) {
      const trace = await newerStore.start({
        sessionId: SESSION_ID,
        opportunityKind: "job",
        autoSubmit: false,
      });
      await trace.finish({ status: "completed" });
    }

    await olderActiveTrace.finish({ status: "completed" });

    const files = await readdir(root);
    expect(files).toHaveLength(MAX_RETAINED_APPLICATION_AGENT_TRACES);
    expect(files.some((file) => file.startsWith(`${NOW + 1}-`))).toBeFalse();
    expect(files.some((file) => file.startsWith(`${NOW + 2}-`))).toBeTrue();
  });

  test("recovers a dead process trace as bounded incomplete JSONL", async () => {
    const root = await traceRoot();
    const store = new ApplicationAgentTraceStore(root, {
      now: () => NOW,
      traceIdFactory: () => TRACE_ID,
    });
    await store.initialize();
    const staleTraceId = "018f5f78-8a90-7861-8b35-10a74486100a";
    const staleStem = `${NOW - 1}-${SESSION_ID}-${staleTraceId}`;
    const staleActivePath = join(
      root,
      `${staleStem}.2147483647.1.active`,
    );
    const staleLine = "{\"type\":\"trace_started\",\"sessionId\":\"stale\"}\\n";
    await writeFile(staleActivePath, staleLine, { mode: 0o644 });

    const trace = await store.start({
      sessionId: SESSION_ID,
      opportunityKind: "job",
      autoSubmit: false,
    });
    await trace.finish({ status: "completed" });

    const incompletePath = join(root, `${staleStem}.incomplete.jsonl`);
    const files = await readdir(root);
    expect(files).toContain(`${staleStem}.incomplete.jsonl`);
    expect(files.some((file) => file.endsWith(".active"))).toBeFalse();
    expect(await readFile(incompletePath, "utf8")).toBe(staleLine);
    if (process.platform !== "win32") {
      expect((await lstat(incompletePath)).mode & 0o777).toBe(0o600);
    }
  });

  test("publishes an incomplete trace when terminal recording fails", async () => {
    const root = await traceRoot();
    let clockReads = 0;
    const store = new ApplicationAgentTraceStore(root, {
      now: () => (++clockReads <= 2 ? NOW : -1),
      traceIdFactory: () => TRACE_ID,
    });
    const trace = await store.start({
      sessionId: SESSION_ID,
      opportunityKind: "job",
      autoSubmit: false,
    });

    await expect(trace.finish({ status: "completed" })).rejects.toThrow(
      "invalid application trace timestamp",
    );

    const files = await readdir(root);
    expect(files).toEqual([
      `${NOW}-${SESSION_ID}-${TRACE_ID}.incomplete.jsonl`,
    ]);
    expect(files.some((file) => file.endsWith(".active"))).toBeFalse();
  });

  test("records truncation and terminal markers for an oversized model record", async () => {
    const root = await traceRoot();
    const store = new ApplicationAgentTraceStore(root, {
      now: () => NOW,
      traceIdFactory: () => TRACE_ID,
    });
    const trace = await store.start({
      sessionId: SESSION_ID,
      opportunityKind: "job",
      autoSubmit: false,
    });

    await trace.record({
      type: "model_request",
      model: "gpt-5.6-sol",
      request: {
        input: "x".repeat(MAX_APPLICATION_AGENT_TRACE_RECORD_BYTES),
        modelSettings: { store: false },
        tools: [],
        outputType: "text",
        handoffs: [],
        tracing: false,
      },
    });
    await trace.finish({ status: "completed" });

    const records = await readTraceRecords(root);
    expect(records.map((record) => record.type)).toEqual([
      "trace_started",
      "trace_truncated",
      "trace_finished",
    ]);
    expect(records[1]).toMatchObject({
      type: "trace_truncated",
      attemptedRecordType: "model_request",
    });
  });

  test("publishes incomplete after a model record cannot be serialized", async () => {
    const root = await traceRoot();
    const store = new ApplicationAgentTraceStore(root, {
      now: () => NOW,
      traceIdFactory: () => TRACE_ID,
    });
    const trace = await store.start({
      sessionId: SESSION_ID,
      opportunityKind: "job",
      autoSubmit: false,
    });
    const cyclicProviderData: Record<string, unknown> = {};
    cyclicProviderData.self = cyclicProviderData;

    const recordFailure = await trace.record({
      type: "model_request",
      model: "gpt-5.6-sol",
      request: {
        input: "private applicant input",
        modelSettings: {
          store: false,
          providerData: cyclicProviderData,
        },
        tools: [],
        outputType: "text",
        handoffs: [],
        tracing: false,
      },
    }).catch((error: unknown) => error);
    const finishFailure = await trace.finish({ status: "completed" })
      .catch((error: unknown) => error);

    expect(recordFailure).toBeInstanceOf(TypeError);
    expect(finishFailure).toBe(recordFailure);
    expect(await readdir(root)).toEqual([
      `${NOW}-${SESSION_ID}-${TRACE_ID}.incomplete.jsonl`,
    ]);
  });
});
