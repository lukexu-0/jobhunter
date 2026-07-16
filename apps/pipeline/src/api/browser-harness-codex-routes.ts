import { createHash, timingSafeEqual } from "node:crypto";
import {
  BrowserHarnessCodexServiceError,
  parseBrowserHarnessCodexInput,
  type BrowserHarnessCodexCompletion,
  type BrowserHarnessCodexInput,
  type BrowserHarnessCodexStatus,
} from "../models/browser-harness-codex";
import { apiResponse } from "./handler";

export const BROWSER_HARNESS_CODEX_PATH = "/v1/internal/browser-harness/codex";
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_MODEL_TIMEOUT_MS = 300_000;

export interface BrowserHarnessCodexRouteService {
  status(): Promise<BrowserHarnessCodexStatus> | BrowserHarnessCodexStatus;
  invoke(input: BrowserHarnessCodexInput, signal?: AbortSignal): Promise<BrowserHarnessCodexCompletion>;
}

export interface BrowserHarnessCodexRouteOptions {
  timeoutMs?: number;
}

class RequestTooLargeError extends Error {}

function bearerMatches(request: Request, configuredToken: string): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  const configuredDigest = createHash("sha256").update(`Bearer ${configuredToken}`).digest();
  const presentedDigest = createHash("sha256").update(authorization).digest();
  return timingSafeEqual(configuredDigest, presentedDigest);
}

async function readJsonBody(request: Request, signal: AbortSignal): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_REQUEST_BYTES) {
    throw new RequestTooLargeError();
  }
  if (request.body === null) {
    throw new BrowserHarnessCodexServiceError("INVALID_REQUEST", "The model request is invalid");
  }
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
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new RequestTooLargeError();
      }
      jsonText += decoder.decode(chunk.value, { stream: true });
    }
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    jsonText += decoder.decode();
    return JSON.parse(jsonText);
  } catch (error) {
    if (error instanceof RequestTooLargeError || signal.aborted) throw error;
    throw new BrowserHarnessCodexServiceError("INVALID_REQUEST", "The model request is invalid");
  } finally {
    signal.removeEventListener("abort", cancelRead);
    reader.releaseLock();
  }
}

function routeError(error: unknown, timeoutSignal: AbortSignal): Response {
  if (error instanceof RequestTooLargeError) {
    return apiResponse.error("REQUEST_TOO_LARGE", "The model request is too large", 413);
  }
  if (error instanceof BrowserHarnessCodexServiceError) {
    if (error.code === "INVALID_REQUEST") {
      return apiResponse.error("INVALID_REQUEST", "The model request is invalid", 422);
    }
    if (error.code === "OAUTH_REQUIRED") {
      return apiResponse.error("OAUTH_REQUIRED", "Connect OpenAI Codex in Provider access", 409);
    }
    return apiResponse.error("INVALID_MODEL_OUTPUT", "The model returned invalid output", 502);
  }
  if (timeoutSignal.aborted) {
    return apiResponse.error("MODEL_TIMEOUT", "The model request timed out", 504);
  }
  return apiResponse.error("MODEL_PROVIDER_FAILED", "The model request failed", 502);
}

export function createBrowserHarnessCodexRoutes(
  service: BrowserHarnessCodexRouteService,
  token: string | undefined,
  options: BrowserHarnessCodexRouteOptions = {},
) {
  return async function routeBrowserHarnessCodex(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== BROWSER_HARNESS_CODEX_PATH || (request.method !== "GET" && request.method !== "POST")) {
      return null;
    }
    if (token === undefined || token.length === 0) {
      return apiResponse.error("NOT_FOUND", "Route not found", 404);
    }
    if (!bearerMatches(request, token)) {
      return apiResponse.error("UNAUTHORIZED", "Unauthorized", 401);
    }
    if (request.method === "POST" && request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return apiResponse.error("JSON_REQUIRED", "Model requests must use application/json", 415);
    }

    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS);
    const signal = AbortSignal.any([request.signal, timeoutSignal]);
    try {
      if (request.method === "GET") return apiResponse.json(await service.status());
      const input = parseBrowserHarnessCodexInput(await readJsonBody(request, signal));
      return apiResponse.json(await service.invoke(input, signal));
    } catch (error) {
      return routeError(error, timeoutSignal);
    }
  };
}
