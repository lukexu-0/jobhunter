import { describe, expect, test } from "bun:test";
import {
  ApplicationAgentFailure,
  type ApplicationAgentDependencies,
  type ApplicationAgentRunInput,
  type ApplicationRunResult,
} from "../src/agents/application-agent";
import {
  APPLICATION_AGENT_MODEL,
  APPLICATION_AGENT_MODEL_PROVIDER,
  APPLICATION_AGENT_REASONING,
  ApplicationAgentService,
} from "../src/agents/application-agent-service";
import { ApplicationAgentSteeringConflict } from "../src/agents/application-agent-steering.ts";
import type { AuthStatusResponse } from "../src/contracts";

const TOKEN = "test-token-0123456789abcdef-0123456789";
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const RUNTIME_URL = "http://127.0.0.1:8765";
const DIRECT_VALUE = "private-candidate-value";

const INPUT: ApplicationAgentRunInput = {
  opportunityKind: "job",
  sessionId: SESSION_ID,
  runtimeUrl: RUNTIME_URL,
  task: `Apply using ${DIRECT_VALUE}`,
  maxTurns: 42,
  deadlineMs: 60_000,
  autoSubmit: false,
};

const RESULT: ApplicationRunResult = {
  status: "submitted",
  company: "Example Co",
  role: "Engineer",
  job_url: "https://jobs.example.test/opening",
  final_url: "https://apply.example.test/review",
  fields_filled: [{
    label: "Name",
    field_type: "text",
    value_present: true,
    note: "",
  }],
  fields_needing_human: [],
  files_attached: ["resume.pdf"],
  warnings: [],
  revision_count: 1,
  submit_attempted: true,
  submission_confirmation: {
    type: "post_submit_confirmation",
    text: "Application received",
  },
};

const SUBMISSION_GUARD_FACTORY = () => ({
  markReviewReady: async () => undefined,
  claim: async () => undefined,
  finalize: async (_outcome: "submitted" | "uncertain") => undefined,
});

function connectedStatus(): AuthStatusResponse {
  return {
    providers: [
      { provider: "openai-codex" as const, state: "connected" as const },
    ],
  };
}

describe("ApplicationAgentService", () => {
  test("reports the fixed connected application-agent metadata", async () => {
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: connectedStatus,
    });

    expect(await service.status()).toEqual({
      modelProvider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning: "high",
      oauth: "connected",
    });
    expect(APPLICATION_AGENT_MODEL_PROVIDER).toBe("openai-codex");
    expect(APPLICATION_AGENT_MODEL).toBe("gpt-5.6-sol");
    expect(APPLICATION_AGENT_REASONING).toBe("high");
  });

  test("requires the application-owned OpenAI Codex OAuth connection", async () => {
    let runtimeConstructions = 0;
    let runs = 0;
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: () => ({
        providers: [
          { provider: "openai-codex", state: "disconnected" },
        ],
      }),
      runtimeClientFactory: () => {
        runtimeConstructions += 1;
        return { action: async () => { throw new Error("unused"); } };
      },
      runApplicationAgent: async () => {
        runs += 1;
        return RESULT;
      },
    });

    const failure = await service.status().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplicationAgentFailure);
    expect((failure as ApplicationAgentFailure).code).toBe("OAUTH_REQUIRED");
    expect(String(failure)).not.toContain(TOKEN);
    const invokeFailure = await service.invoke(
      INPUT,
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(invokeFailure).toBeInstanceOf(ApplicationAgentFailure);
    expect((invokeFailure as ApplicationAgentFailure).code).toBe("OAUTH_REQUIRED");
    expect({ runtimeConstructions, runs }).toEqual({
      runtimeConstructions: 0,
      runs: 0,
    });
  });


  test("sanitizes application-owned OAuth status read failures", async () => {
    const authSecret = `auth storage error: ${TOKEN}:${DIRECT_VALUE}`;
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: () => {
        throw new Error(authSecret);
      },
    });

    const failure = await service.status().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationAgentFailure);
    expect((failure as ApplicationAgentFailure).code).toBe("MODEL_PROVIDER_FAILED");
    expect((failure as Error).message).toBe("The model request failed");
    expect(String(failure)).not.toContain(authSecret);
  });
  test("constructs one authenticated runtime client inside invoke and returns exact success metadata", async () => {
    const runtimeClient = {
      action: async () => {
        throw new Error("unused");
      },
    };
    const runtimeFactoryCalls: unknown[][] = [];
    const runCalls: unknown[][] = [];
    const agentRuntime = {
      providerFactory: () => {
        throw new Error("unused");
      },
    };
    const submissionGuard = {
      markReviewReady: async () => undefined,
      claim: async () => undefined,
      finalize: async (_outcome: "submitted" | "uncertain") => undefined,
    };
    const guardFactoryCalls: string[] = [];
    const service = new ApplicationAgentService(TOKEN, {
      authStatusReader: connectedStatus,
      submissionGuardFactory: (sessionId) => {
        guardFactoryCalls.push(sessionId);
        return submissionGuard;
      },
      runtimeClientFactory: (...args) => {
        runtimeFactoryCalls.push(args);
        return runtimeClient;
      },
      runApplicationAgent: async (...args) => {
        runCalls.push(args);
        return RESULT;
      },
      agentRuntime,
    });
    const signal = new AbortController().signal;

    const success = await service.invoke(INPUT, signal);

    expect(success).toEqual({
      modelProvider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning: "high",
      result: RESULT,
    });
    expect(runtimeFactoryCalls).toEqual([[RUNTIME_URL, SESSION_ID, TOKEN]]);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.[0]).toEqual(INPUT);
    expect(runCalls[0]?.[1]).toBe(signal);
    expect(guardFactoryCalls).toEqual([SESSION_ID]);
    expect(runCalls[0]?.[2]).toMatchObject({
      providerFactory: agentRuntime.providerFactory,
      runtimeClient,
      submissionGuard,
      steeringInbox: expect.any(Object),
    });
    const serializedSuccess = JSON.stringify(success);
    expect(serializedSuccess).not.toContain(TOKEN);
    expect(serializedSuccess).not.toContain(RUNTIME_URL);
    expect(serializedSuccess).not.toContain(DIRECT_VALUE);
    expect(JSON.stringify(runCalls[0]?.[2])).not.toContain(TOKEN);
  });

  test("registers one bounded inbox only for the active invocation and closes it in finally", async () => {
    const privateMessage = "PRIVATE OPERATOR GUIDANCE";
    const { promise: runStarted, resolve: markRunStarted } = Promise.withResolvers<void>();
    const { promise: runResult, resolve: finishRun } =
      Promise.withResolvers<ApplicationRunResult>();
    let steeringInbox: ApplicationAgentDependencies["steeringInbox"];
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: connectedStatus,
      runtimeClientFactory: () => ({
        action: async () => { throw new Error("unused"); },
      }),
      runApplicationAgent: async (_input, _signal, dependencies) => {
        steeringInbox = dependencies.steeringInbox;
        markRunStarted();
        return runResult;
      },
    });
    const signal = new AbortController().signal;

    expect(() => service.steer(
      SESSION_ID,
      { message: privateMessage },
      signal,
    )).toThrow(ApplicationAgentSteeringConflict);
    const invocation = service.invoke(INPUT, signal);
    await runStarted;

    expect(service.steer(
      SESSION_ID,
      { message: `\u001c  ${privateMessage}  \u0085` },
      signal,
    )).toBeUndefined();
    for (let index = 1; index < 16; index += 1) {
      expect(service.steer(
        SESSION_ID,
        { message: `guidance-${index}` },
        signal,
      )).toBeUndefined();
    }
    expect(() => service.steer(
      SESSION_ID,
      { message: "queue overflow" },
      signal,
    )).toThrow(ApplicationAgentSteeringConflict);
    expect(steeringInbox?.snapshot()?.messages).toEqual([
      privateMessage,
      ...Array.from({ length: 15 }, (_, index) => `guidance-${index + 1}`),
    ]);

    finishRun(RESULT);
    await expect(invocation).resolves.toMatchObject({ result: RESULT });
    expect(steeringInbox?.snapshot()).toBeUndefined();
    expect(() => service.steer(
      SESSION_ID,
      { message: "late guidance" },
      signal,
    )).toThrow(ApplicationAgentSteeringConflict);
    expect(String(new ApplicationAgentSteeringConflict())).not.toContain(privateMessage);
  });

  test("routes jobs and non-job opportunities to separate application-agent runners", async () => {
    const jobKinds: string[] = [];
    const nonJobKinds: string[] = [];
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: connectedStatus,
      runtimeClientFactory: () => ({
        action: async () => { throw new Error("unused"); },
      }),
      runApplicationAgent: async (input) => {
        jobKinds.push(input.opportunityKind);
        return RESULT;
      },
      runNonJobApplicationAgent: async (input) => {
        nonJobKinds.push(input.opportunityKind);
        return RESULT;
      },
    });
    const signal = new AbortController().signal;

    await service.invoke(INPUT, signal);
    for (const opportunityKind of ["hackathon", "competition", "event"] as const) {
      await service.invoke({ ...INPUT, opportunityKind }, signal);
    }

    expect(jobKinds).toEqual(["job"]);
    expect(nonJobKinds).toEqual(["hackathon", "competition", "event"]);
  });

  test("strictly revalidates invoke input before OAuth or runtime construction", async () => {
    let authReads = 0;
    let runtimeConstructions = 0;
    let runs = 0;
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: () => {
        authReads += 1;
        return connectedStatus();
      },
      runtimeClientFactory: () => {
        runtimeConstructions += 1;
        return { action: async () => { throw new Error("unused"); } };
      },
      runApplicationAgent: async () => {
        runs += 1;
        return RESULT;
      },
    });

    const failure = await service.invoke(
      { ...INPUT, unexpected: DIRECT_VALUE } as ApplicationAgentRunInput,
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationAgentFailure);
    expect((failure as ApplicationAgentFailure).code).toBe("INVALID_REQUEST");
    expect({ authReads, runtimeConstructions, runs }).toEqual({
      authReads: 0,
      runtimeConstructions: 0,
      runs: 0,
    });
    expect(String(failure)).not.toContain(DIRECT_VALUE);
  });

  test("strictly revalidates the agent result before returning success", async () => {
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: connectedStatus,
      runtimeClientFactory: () => ({
        action: async () => { throw new Error("unused"); },
      }),
      runApplicationAgent: async () => ({
        ...RESULT,
        unexpected: DIRECT_VALUE,
      }) as ApplicationRunResult,
    });

    const failure = await service.invoke(
      INPUT,
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationAgentFailure);
    expect((failure as ApplicationAgentFailure).code).toBe("INVALID_MODEL_OUTPUT");
    expect(String(failure)).not.toContain(DIRECT_VALUE);
  });

  test("sanitizes untyped provider failures after rechecking OAuth", async () => {
    const providerSecret = `${TOKEN}:${RUNTIME_URL}:${DIRECT_VALUE}`;
    let authReads = 0;
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: () => {
        authReads += 1;
        return connectedStatus();
      },
      runtimeClientFactory: () => ({
        action: async () => { throw new Error("unused"); },
      }),
      runApplicationAgent: async () => {
        throw new Error(providerSecret);
      },
    });

    const failure = await service.invoke(
      INPUT,
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(authReads).toBe(2);
    expect(failure).toBeInstanceOf(ApplicationAgentFailure);
    expect((failure as ApplicationAgentFailure).code).toBe("MODEL_PROVIDER_FAILED");
    expect((failure as Error).message).toBe("The model request failed");
    expect(JSON.stringify(failure)).not.toContain(providerSecret);
    expect(String(failure)).not.toContain(TOKEN);
    expect(String(failure)).not.toContain(RUNTIME_URL);
    expect(String(failure)).not.toContain(DIRECT_VALUE);
  });

  test("logs a classified diagnostic without provider or applicant data when masking an untyped failure", async () => {
    const providerSecret = `${TOKEN}:${RUNTIME_URL}:${DIRECT_VALUE}`;
    const assistantSecret = `assistant payload for ${DIRECT_VALUE}`;
    const diagnosticFailureSecret = `diagnostic sink failure for ${DIRECT_VALUE}`;
    let timeoutMessageReads = 0;
    let providerNameReads = 0;
    const timeout = Object.assign(
      new Error(),
      {
        name: "CodexResponseError",
        code: "UND_ERR_BODY_TIMEOUT",
        assistantMessage: { providerPayload: assistantSecret },
      },
    );
    timeout.cause = timeout;
    Object.defineProperty(timeout, "message", {
      get: () => {
        timeoutMessageReads += 1;
        return timeoutMessageReads === 1
          ? `OpenAI Codex SSE stream stalled while waiting for the next event. ${assistantSecret}`
          : assistantSecret;
      },
    });
    const diagnostics: unknown[] = [];
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: connectedStatus,
      runtimeClientFactory: () => ({
        action: async () => { throw new Error("unused"); },
      }),
      runApplicationAgent: async () => {
        const failure = new Error(providerSecret, { cause: timeout });
        Object.defineProperty(failure, "name", {
          get: () => {
            providerNameReads += 1;
            return providerNameReads === 1 ? "Error" : DIRECT_VALUE;
          },
        });
        throw failure;
      },
      diagnosticSink: async (diagnostic: unknown) => {
        diagnostics.push(diagnostic);
        throw new Error(diagnosticFailureSecret);
      },
    });

    const failure = await service.invoke(
      INPUT,
      new AbortController().signal,
    ).catch((error: unknown) => error);
    await Promise.resolve();

    expect(failure).toBeInstanceOf(ApplicationAgentFailure);
    expect(providerNameReads).toBe(1);
    expect(timeoutMessageReads).toBe(1);
    expect((failure as ApplicationAgentFailure).code).toBe("MODEL_PROVIDER_FAILED");
    expect((failure as Error).message).toBe("The model request failed");
    expect(diagnostics).toEqual([{
      event: "application_agent_failure",
      sessionId: SESSION_ID,
      phase: "agent_run",
      errorChain: [
        { name: "Error", category: "unknown" },
        {
          name: "CodexResponseError",
          category: "stream_idle_timeout",
          code: "UND_ERR_BODY_TIMEOUT",
        },
      ],
    }]);
    const serializedDiagnostics = JSON.stringify(diagnostics);
    expect(serializedDiagnostics).not.toContain(TOKEN);
    expect(serializedDiagnostics).not.toContain(RUNTIME_URL);
    expect(serializedDiagnostics).not.toContain(DIRECT_VALUE);
    expect(serializedDiagnostics).not.toContain(assistantSecret);
  });


  test("logs fixed unknown metadata when a hostile proxy hides its Error prototype", async () => {
    const proxySecret = `proxy payload for ${DIRECT_VALUE}`;
    let prototypeReads = 0;
    const hostileError = new Proxy(new Error(proxySecret), {
      getPrototypeOf(target) {
        prototypeReads += 1;
        if (prototypeReads === 1) return Reflect.getPrototypeOf(target);
        throw new Error("prototype unavailable");
      },
    });
    const diagnostics: unknown[] = [];
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: connectedStatus,
      runtimeClientFactory: () => ({
        action: async () => { throw new Error("unused"); },
      }),
      runApplicationAgent: async () => {
        throw hostileError;
      },
      diagnosticSink: (diagnostic: unknown) => {
        diagnostics.push(diagnostic);
      },
    });

    const failure = await service.invoke(
      INPUT,
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationAgentFailure);
    expect((failure as ApplicationAgentFailure).code).toBe("MODEL_PROVIDER_FAILED");
    expect(diagnostics).toEqual([{
      event: "application_agent_failure",
      sessionId: SESSION_ID,
      phase: "agent_run",
      errorChain: [{ name: "NonError", category: "unknown" }],
    }]);
    expect(JSON.stringify(diagnostics)).not.toContain(proxySecret);
    expect(JSON.stringify(diagnostics)).not.toContain(DIRECT_VALUE);
  });
  test("turns a provider failure during a logout race into OAuth required", async () => {
    let authReads = 0;
    const diagnostics: unknown[] = [];
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: () => {
        authReads += 1;
        return authReads === 1
          ? connectedStatus()
          : {
              providers: [
                { provider: "openai-codex", state: "disconnected" },
              ],
            };
      },
      runtimeClientFactory: () => ({
        action: async () => { throw new Error("unused"); },
      }),
      runApplicationAgent: async () => {
        throw new Error(`provider failure: ${DIRECT_VALUE}`);
      },
      diagnosticSink: (diagnostic: unknown) => {
        diagnostics.push(diagnostic);
      },
    });

    const failure = await service.invoke(
      INPUT,
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(authReads).toBe(2);
    expect(failure).toBeInstanceOf(ApplicationAgentFailure);
    expect((failure as ApplicationAgentFailure).code).toBe("OAUTH_REQUIRED");
    expect(String(failure)).not.toContain(DIRECT_VALUE);
    expect(diagnostics).toEqual([]);
  });

  test("preserves abort identity during the provider-failure OAuth reread", async () => {
    const controller = new AbortController();
    const abortReason = new Error("caller stopped pending OAuth reread");
    const {
      promise: rereadStarted,
      resolve: markRereadStarted,
    } = Promise.withResolvers<void>();
    const { promise: pendingReread } = Promise.withResolvers<never>();
    let authReads = 0;
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: () => {
        authReads += 1;
        if (authReads === 1) return connectedStatus();
        markRereadStarted();
        return pendingReread;
      },
      runtimeClientFactory: () => ({
        action: async () => { throw new Error("unused"); },
      }),
      runApplicationAgent: async () => {
        throw new Error(`provider failure: ${DIRECT_VALUE}`);
      },
    });

    const invocation = service.invoke(INPUT, controller.signal)
      .catch((error: unknown) => error);
    await rereadStarted;
    controller.abort(abortReason);

    expect(await invocation).toBe(abortReason);
    expect(authReads).toBe(2);
  });

  test("preserves typed application-agent failures by identity", async () => {
    const typedFailure = new ApplicationAgentFailure("STEP_LIMIT");
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: connectedStatus,
      runtimeClientFactory: () => ({
        action: async () => { throw new Error("unused"); },
      }),
      runApplicationAgent: async () => {
        throw typedFailure;
      },
    });

    const failure = await service.invoke(
      INPUT,
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(failure).toBe(typedFailure);
    expect((failure as ApplicationAgentFailure).code).toBe("STEP_LIMIT");
  });

  test("propagates the exact in-flight abort reason without an OAuth reread", async () => {
    const controller = new AbortController();
    const abortReason = new Error(`caller abort: ${DIRECT_VALUE}`);
    let authReads = 0;
    let markRunStarted!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: () => {
        authReads += 1;
        return connectedStatus();
      },
      runtimeClientFactory: () => ({
        action: async () => { throw new Error("unused"); },
      }),
      runApplicationAgent: async (_input, signal) => {
        markRunStarted();
        return new Promise<ApplicationRunResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });

    const invocation = service.invoke(INPUT, controller.signal)
      .catch((error: unknown) => error);
    await runStarted;
    controller.abort(abortReason);

    expect(await invocation).toBe(abortReason);
    expect(authReads).toBe(1);
  });

  test("observes caller abort even when the injected agent run resolves", async () => {
    const controller = new AbortController();
    const abortReason = new Error("caller stopped completed model work");
    let markRunStarted!: () => void;
    let resolveRun!: (result: ApplicationRunResult) => void;
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: connectedStatus,
      runtimeClientFactory: () => ({
        action: async () => { throw new Error("unused"); },
      }),
      runApplicationAgent: async () => {
        markRunStarted();
        return new Promise<ApplicationRunResult>((resolve) => {
          resolveRun = resolve;
        });
      },
    });

    const invocation = service.invoke(INPUT, controller.signal)
      .catch((error: unknown) => error);
    await runStarted;
    controller.abort(abortReason);
    resolveRun(RESULT);

    expect(await invocation).toBe(abortReason);
  });

  test("registers steering before OAuth preflight and closes it on preflight abort", async () => {
    const controller = new AbortController();
    const abortReason = new Error("caller stopped pending OAuth preflight");
    const {
      promise: authStarted,
      resolve: markAuthStarted,
    } = Promise.withResolvers<void>();
    const { promise: pendingAuthRead } = Promise.withResolvers<never>();
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: () => {
        markAuthStarted();
        return pendingAuthRead;
      },
    });

    const invocation = service.invoke(INPUT, controller.signal)
      .catch((error: unknown) => error);
    await authStarted;
    expect(service.steer(
      SESSION_ID,
      { message: "guidance queued during preflight" },
      controller.signal,
    )).toBeUndefined();
    controller.abort(abortReason);
    const outcome = await invocation;

    expect(outcome).toBe(abortReason);
    expect(() => service.steer(
      SESSION_ID,
      { message: "late guidance" },
      new AbortController().signal,
    )).toThrow(ApplicationAgentSteeringConflict);
  });

  test("preserves abort identity when OAuth preflight fails concurrently", async () => {
    const controller = new AbortController();
    const abortReason = new Error("caller stopped OAuth preflight");
    const service = new ApplicationAgentService(TOKEN, {
      submissionGuardFactory: SUBMISSION_GUARD_FACTORY,
      authStatusReader: () => {
        controller.abort(abortReason);
        throw new Error(`auth failure: ${DIRECT_VALUE}`);
      },
    });

    const failure = await service.invoke(
      INPUT,
      controller.signal,
    ).catch((error: unknown) => error);

    expect(failure).toBe(abortReason);
  });
});
