import { z } from "zod";
import {
  AdditionalInfoQuestionIdSchema,
  ApplicationAnswerSuggestionsResponseSchema,
  ApplicationProfessionalizeRequestSchema,
  ApplicationProfessionalizeResponseSchema,
  ApplicationSessionEventDtoSchema,
  ApplicationSessionCommandSchema,
  ApplicationSessionSnapshotDtoSchema,
  ApplicationSessionViewSchema,
  StartApplicationSessionRequestSchema,
  type ApplicationAnswerSuggestionsResponse,
  type ApplicationProfessionalizeRequest,
  type ApplicationProfessionalizeResponse,
  type ApplicationSessionCommand,
  type ApplicationSessionSnapshotDto,
  type ApplicationSessionView,
} from "../contracts";
import {
  ApplicationSessionServiceError,
  type ApplicationSessionEventCursor,
  type ApplicationSessionStreamItem,
} from "./application-session-service";
import { apiResponse } from "./handler";
import { RunServiceError } from "./run-service";


const MAX_APPLICATION_ANSWER_REQUEST_BYTES = 16 * 1024;
class ApplicationAnswerRequestTooLargeError extends Error {}
const EmptyApplicationSuggestionsRequestSchema = z.object({}).strict();
export interface ApplicationSessionRouteService {
  get(runId: string): Promise<ApplicationSessionView> | ApplicationSessionView;
  start(
    runId: string,
    expectedApprovedPdfSha256: string,
    signal: AbortSignal,
  ): Promise<ApplicationSessionSnapshotDto>;
  suggestions(
    runId: string,
    questionId: string,
    signal: AbortSignal,
  ): Promise<ApplicationAnswerSuggestionsResponse>;
  professionalize(
    runId: string,
    questionId: string,
    request: ApplicationProfessionalizeRequest,
    signal: AbortSignal,
  ): Promise<ApplicationProfessionalizeResponse>;
  retry(
    runId: string,
    expectedApprovedPdfSha256: string,
    signal: AbortSignal,
  ): Promise<ApplicationSessionSnapshotDto>;
  events(
    runId: string,
    cursor: ApplicationSessionEventCursor | undefined,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ApplicationSessionStreamItem>> | AsyncIterable<ApplicationSessionStreamItem>;
  command(
    runId: string,
    command: ApplicationSessionCommand,
    signal: AbortSignal,
  ): Promise<void>;
  close(runId: string, signal: AbortSignal): Promise<void>;
}

async function parseBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON"), {
      code: "INVALID_JSON",
      status: 400,
    });
  }
}

async function parseBoundedApplicationAnswerBody(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null
    && /^\d+$/.test(contentLength.trim())
    && Number(contentLength) > MAX_APPLICATION_ANSWER_REQUEST_BYTES
  ) {
    await request.body?.cancel().catch(() => undefined);
    throw new ApplicationAnswerRequestTooLargeError();
  }
  if (request.body === null) {
    throw Object.assign(new Error("Request body is not valid JSON"), {
      code: "INVALID_JSON",
      status: 400,
    });
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let json = "";
  const cancelRead = (): void => {
    void reader.cancel(request.signal.reason).catch(() => undefined);
  };
  if (request.signal.aborted) cancelRead();
  else request.signal.addEventListener("abort", cancelRead, { once: true });
  try {
    while (true) {
      const item = await reader.read();
      request.signal.throwIfAborted();
      if (item.done) break;
      bytesRead += item.value.byteLength;
      if (bytesRead > MAX_APPLICATION_ANSWER_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ApplicationAnswerRequestTooLargeError();
      }
      json += decoder.decode(item.value, { stream: true });
    }
    json += decoder.decode();
    return JSON.parse(json);
  } catch (error) {
    if (request.signal.aborted) request.signal.throwIfAborted();
    if (error instanceof ApplicationAnswerRequestTooLargeError) throw error;
    throw Object.assign(new Error("Request body is not valid JSON"), {
      code: "INVALID_JSON",
      status: 400,
    });
  } finally {
    request.signal.removeEventListener("abort", cancelRead);
    reader.releaseLock();
  }
}

function mappedError(error: unknown): Response {
  if (error instanceof ApplicationAnswerRequestTooLargeError) {
    return apiResponse.error(
      "REQUEST_TOO_LARGE",
      "The application answer request is too large",
      413,
    );
  }
  if (error instanceof ApplicationSessionServiceError || error instanceof RunServiceError) {
    return apiResponse.error(error.code, error.message, error.status);
  }
  if (
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "INVALID_JSON"
    && "status" in error
    && error.status === 400
    && "message" in error
    && typeof error.message === "string"
  ) {
    return apiResponse.error("INVALID_JSON", error.message, 400);
  }
  return apiResponse.error("INTERNAL_ERROR", "Request failed", 500);
}

export const APPLICATION_EVENT_STREAM_PATH =
  /^\/v1\/runs\/[^/]+\/application\/events$/;
const APPLICATION_EVENT_ID = /^([1-9]\d*):(0|[1-9]\d*)$/;
const EVENT_STREAM_HEADERS = {
  "cache-control": "no-store",
  "content-type": "text/event-stream; charset=utf-8",
  "x-accel-buffering": "no",
} as const;

function parseApplicationEventId(value: string): ApplicationSessionEventCursor | undefined {
  const match = APPLICATION_EVENT_ID.exec(value);
  if (!match) return undefined;
  const generation = Number(match[1]);
  const upstreamEventId = Number(match[2]);
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(upstreamEventId)) {
    return undefined;
  }
  return { generation, upstreamEventId };
}

function eventStreamResponse(
  events: AsyncIterable<ApplicationSessionStreamItem>,
  signal: AbortSignal,
): Response {
  const iterator = events[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finalized = false;

  const finalize = async (returnIterator: boolean): Promise<void> => {
    if (finalized) return;
    finalized = true;
    signal.removeEventListener("abort", abort);
    if (returnIterator) await iterator.return?.();
  };
  const abort = (): void => {
    if (finalized) return;
    void finalize(true).catch(() => {});
    try {
      controller?.close();
    } catch {
      // The consumer may already have cancelled the stream.
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(streamController) {
      if (finalized) return;
      try {
        const item = await iterator.next();
        if (finalized) return;
        if (item.done) {
          await finalize(false);
          streamController.close();
          return;
        }
        const event = ApplicationSessionEventDtoSchema.parse(item.value.event);
        const id = parseApplicationEventId(item.value.id);
        if (!id || id.generation !== event.generation) {
          throw new Error("Application event ID is invalid");
        }
        streamController.enqueue(encoder.encode(
          `id: ${item.value.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`,
        ));
      } catch (error) {
        if (!finalized) {
          await finalize(true).catch(() => {});
          streamController.error(error);
        }
      }
    },
    async cancel() {
      await finalize(true);
    },
  }, { highWaterMark: 0 });

  return new Response(body, { status: 200, headers: EVENT_STREAM_HEADERS });
}

export function createApplicationSessionRoutes(service: ApplicationSessionRouteService) {
  return async function routeApplicationSession(
    request: Request,
    url: URL,
  ): Promise<Response | null> {
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      segments[0] !== "v1"
      || segments[1] !== "runs"
      || !segments[2]
      || segments[3] !== "application"
    ) {
      return null;
    }

    const runId = segments[2];
    try {
      if (request.method === "GET" && segments.length === 4) {
        return apiResponse.json(ApplicationSessionViewSchema.parse(await service.get(runId)));
      }
      if (
        segments[4] === "additional-info"
        && segments[5]
        && segments.length === 7
        && segments[6] === "suggestions"
        && request.method === "POST"
      ) {
        const questionId = AdditionalInfoQuestionIdSchema.safeParse(segments[5]);
        if (!questionId.success) {
          return apiResponse.error(
            "INVALID_REQUEST",
            "Application question is invalid",
            400,
          );
        }
        const body = EmptyApplicationSuggestionsRequestSchema.safeParse(
          await parseBody(request),
        );
        if (!body.success) {
          return apiResponse.error(
            "INVALID_REQUEST",
            "Application suggestions request is invalid",
            400,
          );
        }
        const response = await service.suggestions(
          runId,
          questionId.data,
          request.signal,
        );
        return apiResponse.json(ApplicationAnswerSuggestionsResponseSchema.parse(response));
      }
      if (
        segments[4] === "additional-info"
        && segments[5]
        && segments.length === 7
        && segments[6] === "professionalize"
        && request.method === "POST"
      ) {
        const questionId = AdditionalInfoQuestionIdSchema.safeParse(segments[5]);
        if (!questionId.success) {
          return apiResponse.error(
            "INVALID_REQUEST",
            "Application question is invalid",
            400,
          );
        }
        const body = ApplicationProfessionalizeRequestSchema.safeParse(
          await parseBoundedApplicationAnswerBody(request),
        );
        if (!body.success) {
          return apiResponse.error(
            "INVALID_REQUEST",
            "Application professionalization request is invalid",
            400,
          );
        }
        const response = await service.professionalize(
          runId,
          questionId.data,
          body.data,
          request.signal,
        );
        return apiResponse.json(ApplicationProfessionalizeResponseSchema.parse(response));
      }
      if (request.method === "POST" && segments.length === 4) {
        const body = StartApplicationSessionRequestSchema.safeParse(await parseBody(request));
        if (!body.success) {
          return apiResponse.error("INVALID_REQUEST", "Application start request is invalid", 400);
        }
        const snapshot = await service.start(
          runId,
          body.data.expectedApprovedPdfSha256,
          request.signal,
        );
        return apiResponse.json(ApplicationSessionSnapshotDtoSchema.parse(snapshot), 202);
      }
      if (
        request.method === "POST"
        && segments[4] === "retry"
        && segments.length === 5
      ) {
        const body = StartApplicationSessionRequestSchema.safeParse(await parseBody(request));
        if (!body.success) {
          return apiResponse.error("INVALID_REQUEST", "Application retry request is invalid", 400);
        }
        const snapshot = await service.retry(
          runId,
          body.data.expectedApprovedPdfSha256,
          request.signal,
        );
        return apiResponse.json(ApplicationSessionSnapshotDtoSchema.parse(snapshot), 202);
      }
      if (
        request.method === "GET"
        && APPLICATION_EVENT_STREAM_PATH.test(url.pathname)
      ) {
        const rawCursor = request.headers.get("last-event-id");
        const cursor = rawCursor === null ? undefined : parseApplicationEventId(rawCursor);
        if (rawCursor !== null && cursor === undefined) {
          return apiResponse.error(
            "INVALID_REQUEST",
            "Application event cursor is invalid",
            400,
          );
        }
        const events = await service.events(runId, cursor, request.signal);
        return eventStreamResponse(events, request.signal);
      }
      if (
        request.method === "POST"
        && segments[4] === "commands"
        && segments.length === 5
      ) {
        const body = ApplicationSessionCommandSchema.safeParse(await parseBody(request));
        if (!body.success) {
          return apiResponse.error("INVALID_REQUEST", "Application command is invalid", 400);
        }
        await service.command(runId, body.data, request.signal);
        return new Response(null, {
          status: 202,
          headers: { "cache-control": "no-store" },
        });
      }
      if (request.method === "DELETE" && segments.length === 4) {
        if (request.body !== null) {
          return apiResponse.error("INVALID_REQUEST", "Application close request must be bodyless", 400);
        }
        await service.close(runId, request.signal);
        return new Response(null, {
          status: 204,
          headers: { "cache-control": "no-store" },
        });
      }
      return null;
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      return mappedError(error);
    }
  };
}
