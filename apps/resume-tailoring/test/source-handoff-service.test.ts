import { describe, expect, test } from "bun:test";
import {
  SourceCaptureHarnessError,
  type SourceCaptureCompleteResult,
  type SourceCaptureCreateInput,
  type SourceCaptureCreateResult,
  type SourceCaptureHarnessClient,
} from "../src/api/application-harness-client";
import {
  SourceHandoffService,
  type SourceHandoffRunService,
} from "../src/api/source-handoff-service";
import type {
  CreateSourceHandoffRequest,
  RunDto,
} from "../src/contracts";

const HANDOFF_ID = "123e4567-e89b-42d3-a456-426614174000";
const JOB_URL = "https://jobs.example.test/role";
const REQUEST: CreateSourceHandoffRequest = {
  jobUrl: JOB_URL,
  generateKeywordMap: true,
  skipReview: false,
  autoSubmit: false,
};

function runDto(): RunDto {
  return {
    id: "run-1",
    jobUrl: JOB_URL,
    opportunityKind: "job",
    status: "queued",
    applicationStatus: "pending",
    isApplying: false,
    generateKeywordMap: true,
    skipReview: false,
    autoSubmit: false,
    queueSequence: 1,
    revision: 1,
    origin: "initial",
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    visualAcknowledgementRequired: false,
    attempts: [],
    artifacts: [],
    timeline: [],
  };
}


function fixture(overrides: {
  completeResult?: SourceCaptureCompleteResult;
  createError?: unknown;
  createResult?: Promise<SourceCaptureCreateResult>;
  onCaptureCreate?: () => void;
  completeError?: unknown;
  deleteError?: unknown;
  deleteResult?: Promise<void>;
  runCreate?: SourceHandoffRunService["createRunFromCapturedSource"];
} = {}) {
  const calls = {
    events: [] as string[],
    validates: 0,
    creates: 0,
    kicks: 0,
    captureCreates: [] as SourceCaptureCreateInput[],
    captureCompletes: [] as string[],
    captureDeletes: [] as string[],
    capturedSources: [] as string[],
  };
  const runs: SourceHandoffRunService = {
    validateSourceHandoffRequest: async (request) => {
      calls.events.push("validate");
      calls.validates += 1;
      return request;
    },
    createRunFromCapturedSource: async (request, source, signal) => {
      calls.events.push("run-create");
      calls.creates += 1;
      calls.capturedSources.push(source);
      if (overrides.runCreate !== undefined) {
        return await overrides.runCreate(request, source, signal);
      }
      return runDto();
    },
    kick: () => {
      calls.events.push("kick");
      calls.kicks += 1;
    },
  };
  const harness: SourceCaptureHarnessClient = {
    createSourceCapture: async (input): Promise<SourceCaptureCreateResult> => {
      calls.events.push("capture-create");
      calls.captureCreates.push(input);
      overrides.onCaptureCreate?.();
      if (overrides.createError !== undefined) throw overrides.createError;
      if (overrides.createResult !== undefined) return await overrides.createResult;
      return;
    },
    completeSourceCapture: async (captureId) => {
      calls.events.push("capture-complete");
      calls.captureCompletes.push(captureId);
      if (overrides.completeError !== undefined) throw overrides.completeError;
      return overrides.completeResult ?? {
        finalUrl: JOB_URL,
        source: "Senior Engineer\nBuild reliable TypeScript services with careful testing and ownership.",
      };
    },
    deleteSourceCapture: async (captureId) => {
      calls.events.push("capture-delete");
      calls.captureDeletes.push(captureId);
      if (overrides.deleteResult !== undefined) await overrides.deleteResult;
      if (overrides.deleteError !== undefined) throw overrides.deleteError;
    },
  };
  return {
    calls,
    service: new SourceHandoffService({
      runs,
      harness,
      idFactory: () => HANDOFF_ID,
    }),
  };
}

describe("SourceHandoffService", () => {
  test("opens one bounded local capture without creating or persisting a run", async () => {
    const target = fixture();

    const created = await target.service.create(REQUEST);

    expect(created).toEqual({
      id: HANDOFF_ID,
      state: "awaiting_human_verification",
      jobUrl: JOB_URL,
    });
    await expect(target.service.get(HANDOFF_ID)).resolves.toEqual(created);
    expect(target.calls).toMatchObject({
      validates: 1,
      creates: 0,
      kicks: 0,
      captureCreates: [{
        captureId: HANDOFF_ID,
        jobUrl: JOB_URL,
        approvedOrigins: ["https://jobs.example.test"],
      }],
      captureCompletes: [],
      capturedSources: [],
    });
    await target.service.delete(HANDOFF_ID);
  });

  test("recovers identical creates during and after the shared private open", async () => {
    const opening = Promise.withResolvers<SourceCaptureCreateResult>();
    const captureStarted = Promise.withResolvers<void>();
    const target = fixture({
      createResult: opening.promise,
      onCaptureCreate: () => {
        captureStarted.resolve();
      },
    });

    const disconnected = new AbortController();
    const first = target.service.create(REQUEST, disconnected.signal);
    await captureStarted.promise;
    disconnected.abort(new DOMException("Response connection was lost", "AbortError"));
    const retryDuringOpen = target.service.create(REQUEST);

    opening.resolve();
    const [created, recovered] = await Promise.all([first, retryDuringOpen]);
    expect(recovered).toEqual(created);
    await expect(target.service.create(REQUEST)).resolves.toEqual(created);
    expect(target.calls).toMatchObject({
      validates: 1,
      captureCreates: [expect.objectContaining({ captureId: HANDOFF_ID })],
    });

    await expect(target.service.create({
      ...REQUEST,
      generateKeywordMap: false,
    })).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_CONFLICT",
      status: 409,
    });
    await target.service.delete(HANDOFF_ID);
  });
  test("retries an ambiguous private create with the same handoff id", async () => {
    const behavior: { createError?: unknown } = {
      createError: new SourceCaptureHarnessError("ambiguous_result"),
    };
    const target = fixture(behavior);

    await expect(target.service.create(REQUEST)).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_UNAVAILABLE",
      status: 503,
    });
    expect(target.calls.captureDeletes).toEqual([]);

    delete behavior.createError;
    await expect(target.service.create(REQUEST)).resolves.toMatchObject({
      id: HANDOFF_ID,
      state: "awaiting_human_verification",
    });
    expect(target.calls.captureCreates).toEqual([
      expect.objectContaining({ captureId: HANDOFF_ID }),
      expect.objectContaining({ captureId: HANDOFF_ID }),
    ]);
    await target.service.delete(HANDOFF_ID);
  });
  test("retains opening ownership when private cleanup cannot be confirmed", async () => {
    const behavior: { createError?: unknown; deleteError?: unknown } = {
      createError: new SourceCaptureHarnessError("unavailable"),
      deleteError: new SourceCaptureHarnessError("ambiguous_result"),
    };
    const target = fixture(behavior);

    await expect(target.service.create(REQUEST)).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_UNAVAILABLE",
      status: 503,
    });
    await expect(target.service.create({
      ...REQUEST,
      generateKeywordMap: false,
    })).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_CONFLICT",
      status: 409,
    });

    delete behavior.createError;
    delete behavior.deleteError;
    await expect(target.service.create(REQUEST)).resolves.toMatchObject({
      id: HANDOFF_ID,
    });
    expect(target.calls.captureCreates).toHaveLength(2);
    await target.service.delete(HANDOFF_ID);
  });



  test("rejects HTTP and trailing-dot hosts before destination validation or private browser I/O", async () => {
    for (const jobUrl of [
      "http://jobs.example.test/role",
      "https://jobs.example.test./role",
    ]) {
      const target = fixture();
      await expect(target.service.create({
        ...REQUEST,
        jobUrl,
      })).rejects.toMatchObject({
        code: "SOURCE_HANDOFF_INVALID_URL",
        status: 400,
        message: "Source handoff URL must use HTTPS with a canonical host",
      });
      expect(target.calls).toMatchObject({
        validates: 0,
        captureCreates: [],
      });
    }
  });

  test("closes the capture before Luna persistence, returns one run, and frees the singleton", async () => {
    const target = fixture();
    await target.service.create(REQUEST);

    const run = await target.service.complete(HANDOFF_ID);

    expect(run).toEqual(runDto());
    expect(target.calls.capturedSources).toEqual([
      "Senior Engineer\nBuild reliable TypeScript services with careful testing and ownership.",
    ]);
    expect(target.calls.events).toEqual([
      "validate",
      "capture-create",
      "capture-complete",
      "run-create",
      "kick",
      "capture-delete",
    ]);
    await expect(target.service.get(HANDOFF_ID)).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_NOT_FOUND",
      status: 404,
    });
    await expect(target.service.create(REQUEST)).resolves.toMatchObject({
      id: HANDOFF_ID,
      state: "awaiting_human_verification",
    });
    await target.service.delete(HANDOFF_ID);
  });

  test("shares in-flight completion and retains one committed result without a lease", async () => {
    const committed = Promise.withResolvers<RunDto>();
    const runStarted = Promise.withResolvers<void>();
    const target = fixture({
      runCreate: async () => {
        runStarted.resolve();
        return await committed.promise;
      },
    });
    await target.service.create(REQUEST);

    const first = target.service.complete(HANDOFF_ID);
    await runStarted.promise;
    const retryWhileCommitting = target.service.complete(HANDOFF_ID);
    committed.resolve(runDto());

    await expect(first).resolves.toEqual(runDto());
    await expect(retryWhileCommitting).resolves.toEqual(runDto());
    await expect(target.service.complete(HANDOFF_ID)).resolves.toEqual(runDto());
    expect(target.calls).toMatchObject({
      creates: 1,
      kicks: 1,
      captureCompletes: [HANDOFF_ID],
      captureDeletes: [HANDOFF_ID],
    });

    await Promise.resolve();
    await expect(target.service.complete(HANDOFF_ID)).resolves.toEqual(runDto());
  });
  test("keeps shared completion alive when one caller disconnects", async () => {
    const firstRequest = new AbortController();
    const committed = Promise.withResolvers<RunDto>();
    const runStarted = Promise.withResolvers<void>();
    const target = fixture({
      runCreate: async (_request, _source, signal) => {
        if (signal === undefined) throw new Error("missing completion signal");
        runStarted.resolve();
        return await Promise.race([
          committed.promise,
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
        ]);
      },
    });
    await target.service.create(REQUEST);

    const firstError = target.service.complete(HANDOFF_ID, firstRequest.signal)
      .catch((error: unknown) => error);
    await runStarted.promise;
    const liveRetry = target.service.complete(HANDOFF_ID);
    firstRequest.abort(new DOMException("First response connection was lost", "AbortError"));
    committed.resolve(runDto());

    await expect(firstError).resolves.toMatchObject({ name: "AbortError" });
    await expect(liveRetry).resolves.toEqual(runDto());
    await expect(target.service.complete(HANDOFF_ID)).resolves.toEqual(runDto());
    expect(target.calls).toMatchObject({
      creates: 1,
      kicks: 1,
      captureCompletes: [HANDOFF_ID],
      captureDeletes: [HANDOFF_ID],
    });
  });


  test("schedules and replays a commit when its caller disconnects as persistence returns", async () => {
    const request = new AbortController();
    const target = fixture({
      runCreate: async () => {
        request.abort(new DOMException("Client disconnected", "AbortError"));
        return runDto();
      },
    });
    await target.service.create(REQUEST);

    await expect(target.service.complete(HANDOFF_ID, request.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(target.calls).toMatchObject({
      creates: 1,
      kicks: 1,
    });
    await expect(target.service.complete(HANDOFF_ID)).resolves.toEqual(runDto());
  });

  test("retains the bounded private replay when extraction fails and retries the same handoff", async () => {
    let attempts = 0;
    const target = fixture({
      runCreate: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("model extraction failed");
        return runDto();
      },
    });
    await target.service.create(REQUEST);

    await expect(target.service.complete(HANDOFF_ID)).rejects.toThrow(
      "model extraction failed",
    );
    await expect(target.service.get(HANDOFF_ID)).resolves.toMatchObject({
      id: HANDOFF_ID,
    });
    expect(target.calls.captureDeletes).toEqual([]);

    await expect(target.service.complete(HANDOFF_ID)).resolves.toEqual(runDto());
    expect(target.calls).toMatchObject({
      creates: 2,
      kicks: 1,
      captureCompletes: [HANDOFF_ID, HANDOFF_ID],
      captureDeletes: [HANDOFF_ID],
    });
  });
  test("retains the private completion replay after an ambiguous response and retries", async () => {
    const behavior: { completeError?: unknown } = {
      completeError: new SourceCaptureHarnessError("ambiguous_result"),
    };
    const target = fixture(behavior);
    await target.service.create(REQUEST);

    await expect(target.service.complete(HANDOFF_ID)).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_UNAVAILABLE",
      status: 503,
    });
    await expect(target.service.get(HANDOFF_ID)).resolves.toMatchObject({
      id: HANDOFF_ID,
    });
    expect(target.calls.captureDeletes).toEqual([]);

    delete behavior.completeError;
    await expect(target.service.complete(HANDOFF_ID)).resolves.toEqual(runDto());
    expect(target.calls).toMatchObject({
      creates: 1,
      captureCompletes: [HANDOFF_ID, HANDOFF_ID],
      captureDeletes: [HANDOFF_ID],
    });
  });


  test("cancellation joins an in-flight completion and releases the private replay", async () => {
    const runStarted = Promise.withResolvers<void>();
    const target = fixture({
      runCreate: async (_request, _source, signal) => {
        if (signal === undefined) throw new Error("missing completion signal");
        runStarted.resolve();
        signal.throwIfAborted();
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    });
    await target.service.create(REQUEST);

    const completion = target.service.complete(HANDOFF_ID);
    const completionError = completion.catch((error: unknown) => error);
    await runStarted.promise;
    await expect(target.service.delete(HANDOFF_ID)).resolves.toBeUndefined();
    await expect(completionError).resolves.toMatchObject({ name: "AbortError" });

    expect(target.calls.captureDeletes).toEqual([HANDOFF_ID]);
    await expect(target.service.get(HANDOFF_ID)).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_NOT_FOUND",
    });
  });

  test("does not cache or kick a commit that returns while the service is closing", async () => {
    const committed = Promise.withResolvers<RunDto>();
    const runStarted = Promise.withResolvers<void>();
    const target = fixture({
      runCreate: async () => {
        runStarted.resolve();
        return await committed.promise;
      },
    });
    await target.service.create(REQUEST);

    const completion = target.service.complete(HANDOFF_ID);
    await runStarted.promise;
    const closing = target.service.close();
    committed.resolve(runDto());

    await expect(completion).resolves.toEqual(runDto());
    await closing;
    expect(target.calls.kicks).toBe(0);
    await expect(target.service.complete(HANDOFF_ID)).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_NOT_FOUND",
    });
  });

  test("rejects a second session, returns fixed not-found errors, and cancel frees both sides", async () => {
    const target = fixture();
    await target.service.create(REQUEST);

    await expect(target.service.create({
      ...REQUEST,
      autoSubmit: true,
    })).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_CONFLICT",
      status: 409,
      message: "A source handoff is already active",
    });
    await expect(target.service.get("223e4567-e89b-42d3-a456-426614174000"))
      .rejects.toMatchObject({
        code: "SOURCE_HANDOFF_NOT_FOUND",
        status: 404,
        message: "Source handoff not found",
      });

    await target.service.delete(HANDOFF_ID);
    expect(target.calls.captureDeletes).toEqual([HANDOFF_ID]);
    await expect(target.service.get(HANDOFF_ID)).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_NOT_FOUND",
    });
    await expect(target.service.create(REQUEST)).resolves.toMatchObject({
      id: HANDOFF_ID,
    });
    await target.service.close();
  });





  test("maps private capture failures without persistence or private detail", async () => {
    const unavailable = fixture({
      createError: new SourceCaptureHarnessError("unavailable"),
    });
    const createError = await unavailable.service.create(REQUEST)
      .catch((reason: unknown) => reason);
    expect(createError).toEqual(
      expect.objectContaining({
        code: "SOURCE_HANDOFF_UNAVAILABLE",
        status: 503,
        message: "Source handoff is unavailable",
      }),
    );
    expect(unavailable.calls).toMatchObject({
      creates: 0,
      captureDeletes: [HANDOFF_ID],
      capturedSources: [],
    });

    const notReady = fixture({
      completeError: new SourceCaptureHarnessError("capture_not_ready"),
    });
    await notReady.service.create(REQUEST);
    await expect(notReady.service.complete(HANDOFF_ID)).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_NOT_FOUND",
      status: 404,
    });
    expect(notReady.calls).toMatchObject({
      creates: 0,
      captureDeletes: [HANDOFF_ID],
    });
    await expect(notReady.service.get(HANDOFF_ID)).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_NOT_FOUND",
    });

    const completionUnavailable = fixture({
      completeError: new SourceCaptureHarnessError("unavailable"),
    });
    await completionUnavailable.service.create(REQUEST);
    await expect(completionUnavailable.service.complete(HANDOFF_ID)).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_NOT_FOUND",
      status: 404,
    });
    expect(completionUnavailable.calls.captureDeletes).toEqual([HANDOFF_ID]);
    await expect(completionUnavailable.service.get(HANDOFF_ID)).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_NOT_FOUND",
    });
    await expect(completionUnavailable.service.create(REQUEST)).resolves.toMatchObject({
      id: HANDOFF_ID,
    });
    await completionUnavailable.service.close();
  });

  test("accepts a canonical same-origin final URL through the private 4096-character bound", async () => {
    const prefix = "https://jobs.example.test/role?state=";
    const finalUrl = `${prefix}${"a".repeat(4_096 - prefix.length)}`;
    const target = fixture({
      completeResult: {
        finalUrl,
        source: "Senior Engineer\nBuild reliable TypeScript services with careful testing and ownership.",
      },
    });
    await target.service.create(REQUEST);

    await expect(target.service.complete(HANDOFF_ID)).resolves.toEqual(runDto());
    expect(target.calls).toMatchObject({
      creates: 1,
      kicks: 1,
      captureDeletes: [HANDOFF_ID],
    });
  });
  test("rejects a non-canonical final URL from a custom private client", async () => {
    const target = fixture({
      completeResult: {
        finalUrl: "https://user:secret@jobs.example.test/role",
        source: "private source that must never reach the run service from a malformed response",
      },
    });
    await target.service.create(REQUEST);

    await expect(target.service.complete(HANDOFF_ID)).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_NOT_FOUND",
      status: 404,
    });
    expect(target.calls).toMatchObject({
      creates: 0,
      captureDeletes: [HANDOFF_ID],
      capturedSources: [],
    });
  });


  test("rejects a final origin outside the approved guard and closes without using source", async () => {
    const target = fixture({
      completeResult: {
        finalUrl: "https://evil.example.test/role",
        source: "private source that must never reach the run service after origin drift",
      },
    });
    await target.service.create(REQUEST);

    await expect(target.service.complete(HANDOFF_ID)).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_NOT_FOUND",
      status: 404,
    });
    expect(target.calls).toMatchObject({
      creates: 0,
      captureDeletes: [HANDOFF_ID],
      capturedSources: [],
    });
    await expect(target.service.get(HANDOFF_ID)).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_NOT_FOUND",
    });
  });

  test("shutdown awaits and deletes a capture that finishes opening after close starts", async () => {
    const opening = Promise.withResolvers<SourceCaptureCreateResult>();
    const captureStarted = Promise.withResolvers<void>();
    const target = fixture({
      createResult: opening.promise,
      onCaptureCreate: () => { captureStarted.resolve(); },
    });
    const creating = target.service.create(REQUEST);
    await captureStarted.promise;

    let closeSettled = false;
    const closing = Promise.resolve(target.service.close());
    void closing.then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    opening.resolve();
    await expect(creating).rejects.toMatchObject({
      code: "SOURCE_HANDOFF_UNAVAILABLE",
      status: 503,
    });
    await closing;
    expect(target.calls.creates).toBe(0);
    expect(target.calls.captureDeletes).toContain(HANDOFF_ID);
  });

  test("shutdown aborts and awaits in-flight Luna work before releasing the boundary", async () => {
    const entered = Promise.withResolvers<void>();
    const target = fixture({
      runCreate: async (_request, _source, signal) => {
        entered.resolve();
        return await new Promise<RunDto>((_resolve, reject) => {
          const rejectAborted = () => reject(signal!.reason);
          if (signal!.aborted) rejectAborted();
          else signal!.addEventListener("abort", rejectAborted, { once: true });
        });
      },
    });
    await target.service.create(REQUEST);
    const completing = target.service.complete(HANDOFF_ID);
    await entered.promise;

    await target.service.close();

    await expect(completing).rejects.toMatchObject({ name: "AbortError" });
    expect(target.calls.captureDeletes).toEqual([HANDOFF_ID]);
    expect(target.calls.kicks).toBe(0);
  });
});
