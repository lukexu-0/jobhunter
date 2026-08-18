import { createHash, timingSafeEqual } from "node:crypto";
import {
  ApplicationAgentSteerRequestSchema,
  type ApplicationAgentSteerRequest,
} from "../contracts/index.ts";
import { apiResponse } from "./handler.ts";
import {
  ApplicationAgentFailure,
  ApplicationAgentRunInputSchema,
  type ApplicationAgentRunInput,
  type ApplicationAgentFailureCode,
  type ApplicationRunResult,
} from "../agents/application-agent.ts";
import {
  APPLICATION_AGENT_STEERING_CONFLICT_MESSAGE,
  ApplicationAgentSteeringConflict,
} from "../agents/application-agent-steering.ts";

export const APPLICATION_AGENT_PATH = "/v1/internal/application-agent";
export const MAX_APPLICATION_AGENT_REQUEST_BYTES = 20_971_520;
const MAX_STEER_REQUEST_BYTES = 128 * 1024;
const APPLICATION_AGENT_STEER_PATH =
  /^\/v1\/internal\/application-agent\/([^/]+)\/steer$/;

class RequestTooLargeError extends Error {}
async function runAbortable<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = (): void => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = Promise.resolve().then(operation);
    return await Promise.race([result, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

const APPLICATION_AGENT_ERROR_RESPONSES: Readonly<Record<ApplicationAgentFailureCode, readonly [status: number, message: string]>> = {
  INVALID_REQUEST: [422, "Request is invalid"],
  OAUTH_REQUIRED: [409, "Connect OpenAI Codex in Provider access"],
  INVALID_MODEL_OUTPUT: [502, "The model returned invalid output"],
  MODEL_PROVIDER_FAILED: [502, "The model request failed"],
  APPLICATION_MISMATCH: [409, "The open page does not match the requested job"],
  BROWSER_FAILED: [502, "The browser session failed"],
};

function serviceErrorResponse(error: unknown): Response {
  if (error instanceof ApplicationAgentFailure) {
    const mapped = APPLICATION_AGENT_ERROR_RESPONSES[error.code];
    if (mapped !== undefined) return apiResponse.error(error.code, mapped[1], mapped[0]);
  }
  return apiResponse.error("MODEL_PROVIDER_FAILED", "The model request failed", 502);
}

async function readJsonBody(
  request: Request,
  signal: AbortSignal,
  maxBytes = MAX_APPLICATION_AGENT_REQUEST_BYTES,
): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new RequestTooLargeError();
  }
  if (request.body === null) throw new SyntaxError("Missing JSON body");

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let jsonText = "";
  const cancelRead = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  if (signal.aborted) cancelRead();
  else signal.addEventListener("abort", cancelRead, { once: true });
  try {
    while (true) {
      const chunk = await runAbortable(() => reader.read(), signal);
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestTooLargeError();
      }
      jsonText += decoder.decode(chunk.value, { stream: true });
    }
    signal.throwIfAborted();
    jsonText += decoder.decode();
    return JSON.parse(jsonText);
  } finally {
    signal.removeEventListener("abort", cancelRead);
    reader.releaseLock();
  }
}

export interface ApplicationAgentStatus {
  readonly modelProvider: "openai-codex";
  readonly model: "gpt-5.6-sol";
  readonly reasoning: "high";
  readonly oauth: "connected";
}

export interface ApplicationAgentSuccess {
  readonly modelProvider: "openai-codex";
  readonly model: "gpt-5.6-sol";
  readonly reasoning: "high";
  readonly result: ApplicationRunResult;
}

export interface ApplicationAgentRouteService {
  status(signal?: AbortSignal): Promise<ApplicationAgentStatus> | ApplicationAgentStatus;
  invoke(input: ApplicationAgentRunInput, signal: AbortSignal): Promise<ApplicationAgentSuccess>;
  steer(
    sessionId: string,
    input: ApplicationAgentSteerRequest,
    signal: AbortSignal,
  ): Promise<void> | void;
}


export function createApplicationAgentRoutes(
  service: ApplicationAgentRouteService | undefined,
  token: string | undefined,
) {
  return async function routeApplicationAgent(request: Request, url: URL): Promise<Response | null> {
    const steerPath = APPLICATION_AGENT_STEER_PATH.exec(url.pathname);
    const isInvokePath = url.pathname === APPLICATION_AGENT_PATH;
    if (
      !(
        (isInvokePath && (request.method === "GET" || request.method === "POST"))
        || (steerPath !== null && request.method === "POST")
      )
    ) {
      return null;
    }
    if (token === undefined || token.length === 0 || service === undefined) {
      return apiResponse.error("NOT_FOUND", "Route not found", 404);
    }
    const expectedAuthorization = createHash("sha256").update(`Bearer ${token}`).digest();
    const presentedAuthorization = createHash("sha256").update(request.headers.get("authorization") ?? "").digest();
    if (!timingSafeEqual(expectedAuthorization, presentedAuthorization)) {
      return apiResponse.error("UNAUTHORIZED", "Unauthorized", 401);
    }
    if (isInvokePath && request.method === "GET") {
      try {
        const status = await service.status(request.signal);
        request.signal.throwIfAborted();
        return apiResponse.json(status);
      } catch (error) {
        if (request.signal.aborted) throw request.signal.reason;
        return serviceErrorResponse(error);
      }
    }
    const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return apiResponse.error(
        "JSON_REQUIRED",
        steerPath === null
          ? "Model requests must use application/json"
          : "Steering requests must use application/json",
        415,
      );
    }
    if (steerPath !== null) {
      let sessionId: string;
      let input: ApplicationAgentSteerRequest;
      try {
        sessionId = ApplicationAgentRunInputSchema.shape.sessionId.parse(
          steerPath[1],
        );
        input = ApplicationAgentSteerRequestSchema.parse(
          await readJsonBody(request, request.signal, MAX_STEER_REQUEST_BYTES),
        );
      } catch (error) {
        if (request.signal.aborted) throw request.signal.reason;
        if (error instanceof RequestTooLargeError) {
          return apiResponse.error(
            "REQUEST_TOO_LARGE",
            "The steering request is too large",
            413,
          );
        }
        return apiResponse.error("INVALID_REQUEST", "Request is invalid", 422);
      }
      try {
        await runAbortable(
          () => service.steer(sessionId, input, request.signal),
          request.signal,
        );
        request.signal.throwIfAborted();
        return new Response(null, {
          status: 202,
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        if (request.signal.aborted) throw request.signal.reason;
        if (error instanceof ApplicationAgentSteeringConflict) {
          return apiResponse.error(
            "APPLICATION_COMMAND_CONFLICT",
            APPLICATION_AGENT_STEERING_CONFLICT_MESSAGE,
            409,
          );
        }
        return serviceErrorResponse(error);
      }
    }
    let input: ApplicationAgentRunInput;
    try {
      input = ApplicationAgentRunInputSchema.parse(await readJsonBody(request, request.signal));
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      if (error instanceof RequestTooLargeError) {
        return apiResponse.error("REQUEST_TOO_LARGE", "The model request is too large", 413);
      }
      return apiResponse.error("INVALID_REQUEST", "Request is invalid", 422);
    }
    try {
      const success = await runAbortable(
        () => service.invoke(input, request.signal),
        request.signal,
      );
      request.signal.throwIfAborted();
      return apiResponse.json(success);
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      return serviceErrorResponse(error);
    }
  };
}
