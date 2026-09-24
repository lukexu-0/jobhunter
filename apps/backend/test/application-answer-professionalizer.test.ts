import { describe, expect, test, vi } from "bun:test";
import type {
  ApiKeyResolver,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { OAuthRequiredError } from "../src/auth/oauth-only-resolver.ts";
import {
  APPLICATION_ANSWER_MAX_RESPONSE_BYTES,
  ApplicationAnswerProfessionalizationError,
  professionalizeApplicationAnswer,
  type ApplicationAnswerStreamTransport,
} from "../src/models/application-answer-professionalizer.ts";
import { MODEL_NAME, OMP_CODEX_MODEL } from "../src/models/oauth-codex-model.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function inertResolver(): ApiKeyResolver {
  return async () => "oauth-bearer";
}

function answerMessage(
  text: string,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: MODEL_NAME,
    content: [{ type: "text", text }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: ZERO_COST,
    },
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

function streamMessage(
  message: AssistantMessage | Promise<AssistantMessage>,
): AsyncIterable<AssistantMessageEvent> {
  return (async function* (): AsyncGenerator<AssistantMessageEvent> {
    const completed = await message;
    for (const [contentIndex, content] of completed.content.entries()) {
      if (content.type === "text" && content.text.length > 0) {
        yield {
          type: "text_delta",
          contentIndex,
          delta: content.text,
          partial: completed,
        };
      }
    }
    const reason = completed.stopReason === "length" || completed.stopReason === "toolUse"
      ? completed.stopReason
      : "stop";
    yield { type: "done", reason, message: completed };
  })();
}

describe("application answer professionalizer", () => {
  test("uses a fresh OAuth-only Sol-high request with the exact default prompt and no provider history", async () => {
    let capturedContext: Context | undefined;
    let capturedOptions: SimpleStreamOptions | undefined;
    let capturedModel: unknown;
    let resolverCall: unknown;
    let resolverSignal: AbortSignal | undefined;
    const resolver = inertResolver();
    const transport: ApplicationAnswerStreamTransport = (model, context, options) => {
      capturedModel = model;
      capturedContext = context;
      capturedOptions = options;
      return streamMessage(answerMessage("  I build reliable systems using the supplied evidence.  "));
    };

    await expect(professionalizeApplicationAnswer(
      "What makes you a strong fit?",
      { promptId: "default", draft: "i build reliable systems" },
      undefined,
      {
        sessionIdFactory: () => "application-answer-fixed",
        resolverFactory: (provider, sessionId, modelId, signal) => {
          resolverCall = { provider, sessionId, modelId };
          resolverSignal = signal;
          return resolver;
        },
        transport,
      },
    )).resolves.toBe("I build reliable systems using the supplied evidence.");

    expect(capturedModel).toBe(OMP_CODEX_MODEL);
    expect(resolverCall).toEqual({
      provider: "openai-codex",
      sessionId: "application-answer-fixed",
      modelId: "gpt-5.6-sol",
    });
    expect(capturedOptions).toMatchObject({
      apiKey: resolver,
      reasoning: "high",
      sessionId: "application-answer-fixed",
      preferWebsockets: false,
      maxTokens: 4_096,
      loopGuard: { enabled: false },
    });
    expect(capturedOptions?.signal).toBe(resolverSignal);
    expect(capturedOptions?.providerSessionState).toBeUndefined();
    expect(capturedContext).toEqual({
      systemPrompt: [
        "Turn the supplied loose thoughts into a concise professional answer to the supplied question without adding facts; return only the answer.",
      ],
      messages: [{
        role: "user",
        content: JSON.stringify({
          question: "What makes you a strong fit?",
          draft: "i build reliable systems",
        }),
        timestamp: expect.any(Number),
      }],
    });
    expect(await capturedOptions?.onPayload?.({ store: true, input: ["fresh"] }, OMP_CODEX_MODEL))
      .toEqual({ store: false, input: ["fresh"] });
  });

  test("uses the exact revision prompt and includes the user's edit specification", async () => {
    let capturedContext: Context | undefined;
    const transport: ApplicationAnswerStreamTransport = (_model, context) => {
      capturedContext = context;
      return streamMessage(answerMessage("A shorter professional answer."));
    };

    await professionalizeApplicationAnswer(
      "What makes you a strong fit?",
      {
        promptId: "default",
        draft: "A longer existing professional answer.",
        instruction: "Make it shorter.",
      },
      undefined,
      { resolverFactory: () => inertResolver(), transport },
    );

    expect(capturedContext?.systemPrompt).toEqual([
      "Edit the supplied professional answer to meet the user's specifications without adding facts and return only the answer.",
    ]);
    expect(JSON.parse(String(capturedContext?.messages[0]?.content))).toEqual({
      question: "What makes you a strong fit?",
      draft: "A longer existing professional answer.",
      instruction: "Make it shorter.",
    });
  });

  test("rejects non-unique, non-text, oversized, and non-normal model output", async () => {
    const invalidMessages: AssistantMessage[] = [
      answerMessage("answer", { stopReason: "length" }),
      answerMessage("answer", {
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      }),
      answerMessage("answer", {
        content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "answer" }],
      }),
      answerMessage("   "),
      answerMessage("😀".repeat(2_001)),
      answerMessage("x".repeat(APPLICATION_ANSWER_MAX_RESPONSE_BYTES + 1)),
    ];
    for (const message of invalidMessages) {
      await expect(professionalizeApplicationAnswer(
        "Question?",
        { promptId: "default", draft: "draft" },
        undefined,
        {
          resolverFactory: () => inertResolver(),
          transport: () => streamMessage(message),
        },
      )).rejects.toMatchObject({ kind: "invalid_output" });
    }
  });

  test("accepts exactly 16 KiB across streamed UTF-8 chunk boundaries", async () => {
    const exactText = `${" ".repeat(APPLICATION_ANSWER_MAX_RESPONSE_BYTES - 4)}😀`;
    const completed = answerMessage(exactText);
    let reachedDone = false;
    let iteratorReturned = false;
    let transportSignal: AbortSignal | undefined;
    const transport: ApplicationAnswerStreamTransport = (_model, _context, options) => {
      transportSignal = options.signal;
      return (async function* (): AsyncGenerator<AssistantMessageEvent> {
        try {
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: `${" ".repeat(APPLICATION_ANSWER_MAX_RESPONSE_BYTES - 4)}\uD83D`,
            partial: completed,
          };
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: "\uDE00",
            partial: completed,
          };
          reachedDone = true;
          yield { type: "done", reason: "stop", message: completed };
        } finally {
          iteratorReturned = true;
        }
      })();
    };

    await expect(professionalizeApplicationAnswer(
      "Question?",
      { promptId: "default", draft: "draft" },
      undefined,
      { resolverFactory: () => inertResolver(), transport },
    )).resolves.toBe("😀");

    expect(new TextEncoder().encode(exactText).byteLength)
      .toBe(APPLICATION_ANSWER_MAX_RESPONSE_BYTES);
    expect(transportSignal?.aborted).toBe(false);
    expect(reachedDone).toBe(true);
    expect(iteratorReturned).toBe(true);
  });

  test("aborts upstream and stops reading on UTF-8 byte 16,385 across chunk boundaries", async () => {
    const partial = answerMessage("not retained");
    let readPastLimit = false;
    let iteratorReturned = false;
    let abortedWhenReturned = false;
    let transportSignal: AbortSignal | undefined;
    const transport: ApplicationAnswerStreamTransport = (_model, _context, options) => {
      transportSignal = options.signal;
      return (async function* (): AsyncGenerator<AssistantMessageEvent> {
        try {
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: `${"x".repeat(APPLICATION_ANSWER_MAX_RESPONSE_BYTES - 3)}\uD83D`,
            partial,
          };
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: "\uDE00",
            partial,
          };
          readPastLimit = true;
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: "must not be read",
            partial,
          };
        } finally {
          iteratorReturned = true;
          abortedWhenReturned = options.signal?.aborted === true;
        }
      })();
    };

    await expect(professionalizeApplicationAnswer(
      "Question?",
      { promptId: "default", draft: "draft" },
      undefined,
      { resolverFactory: () => inertResolver(), transport },
    )).rejects.toMatchObject({ kind: "invalid_output" });

    expect(readPastLimit).toBe(false);
    expect(iteratorReturned).toBe(true);
    expect(abortedWhenReturned).toBe(true);
    expect(transportSignal?.aborted).toBe(true);
    expect(transportSignal?.reason).toMatchObject({ kind: "invalid_output" });
  });

  test("preserves caller abort, hard-deadlines ignoring transports, and sinks late rejection", async () => {
    const alreadyAborted = new AbortController();
    const alreadyAbortedReason = new Error("caller stopped before answer edit");
    alreadyAborted.abort(alreadyAbortedReason);
    let preAbortDependencyCalls = 0;
    await expect(professionalizeApplicationAnswer(
      "Question?",
      { promptId: "default", draft: "draft" },
      alreadyAborted.signal,
      {
        sessionIdFactory: () => {
          preAbortDependencyCalls += 1;
          return "must-not-be-used";
        },
        resolverFactory: () => {
          preAbortDependencyCalls += 1;
          return inertResolver();
        },
        transport: () => {
          preAbortDependencyCalls += 1;
          return streamMessage(answerMessage("unreachable"));
        },
      },
    )).rejects.toBe(alreadyAbortedReason);
    expect(preAbortDependencyCalls).toBe(0);

    const caller = new AbortController();
    const callerReason = new Error("caller stopped answer edit");
    const callerTransport = Promise.withResolvers<AssistantMessage>();
    let callerTransportSignal: AbortSignal | undefined;
    const callerRequest = professionalizeApplicationAnswer(
      "Question?",
      { promptId: "default", draft: "draft" },
      caller.signal,
      {
        resolverFactory: () => inertResolver(),
        transport: (_model, _context, options) => {
          callerTransportSignal = options.signal;
          return streamMessage(callerTransport.promise);
        },
      },
    );
    caller.abort(callerReason);
    await expect(callerRequest).rejects.toBe(callerReason);
    expect(callerTransportSignal?.aborted).toBe(true);
    expect(callerTransportSignal?.reason).toBe(callerReason);
    callerTransport.resolve(answerMessage("late answer"));

    const timeoutTransport = Promise.withResolvers<AssistantMessage>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    let timeoutSignal: AbortSignal | undefined;
    process.on("unhandledRejection", onUnhandled);
    vi.useFakeTimers();
    try {
      const timeoutRequest = professionalizeApplicationAnswer(
        "Question?",
        { promptId: "default", draft: "draft" },
        undefined,
        {
          deadlineMs: 5,
          resolverFactory: () => inertResolver(),
          transport: (_model, _context, options) => {
            timeoutSignal = options.signal;
            return streamMessage(timeoutTransport.promise);
          },
        },
      );
      vi.advanceTimersByTime(5);
      await expect(timeoutRequest).rejects.toEqual(expect.objectContaining({
        kind: "timeout",
        message: "Application answer professionalization timed out",
      }));
      expect(timeoutSignal?.aborted).toBe(true);
      timeoutTransport.reject(new Error("late private provider rejection"));
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  });

  test("recovers nested OAuth failures and bounds every other provider failure", async () => {
    const oauth = new OAuthRequiredError("openai-codex");
    await expect(professionalizeApplicationAnswer(
      "Question?",
      { promptId: "default", draft: "draft" },
      undefined,
      {
        resolverFactory: () => inertResolver(),
        transport: () => {
          throw new Error("private transport wrapper", {
            cause: new Error("private resolver wrapper", { cause: oauth }),
          });
        },
      },
    )).rejects.toBe(oauth);

    const unavailable = await professionalizeApplicationAnswer(
      "Question?",
      { promptId: "default", draft: "draft" },
      undefined,
      {
        resolverFactory: () => inertResolver(),
        transport: () => { throw new Error("Bearer private-provider-secret"); },
      },
    ).catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(ApplicationAnswerProfessionalizationError);
    expect(unavailable).toMatchObject({
      kind: "unavailable",
      message: "Application answer professionalization failed",
    });
    expect(String(unavailable)).not.toContain("private-provider-secret");
  });
});
