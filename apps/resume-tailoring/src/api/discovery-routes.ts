import {
  DiscoveryListRequestSchema,
  DiscoveryListResponseSchema,
  DiscoveryQueueRequestSchema,
  DiscoveryQueueResponseSchema,
  DiscoverySyncRequestSchema,
  DiscoverySyncResponseSchema,
  type DiscoveryListRequest,
  type DiscoveryListResponse,
  type DiscoveryQueueRequest,
  type DiscoveryQueueResponse,
  type DiscoverySyncResponse,
} from "../contracts/index.ts";
import { apiResponse } from "./handler.ts";

export const DISCOVERY_SYNC_PATH = "/v1/discovery/sync";

export interface DiscoveryRouteService {
  list(options: DiscoveryListRequest): DiscoveryListResponse | Promise<DiscoveryListResponse>;
  sync(signal: AbortSignal): Promise<DiscoverySyncResponse>;
  queue(request: DiscoveryQueueRequest, signal?: AbortSignal): Promise<DiscoveryQueueResponse>;
}

const LIST_PARAMETERS: Readonly<Record<string, true>> = {
  role: true,
  suitable: true,
  maxAgeDays: true,
  status: true,
  hideQueued: true,
  search: true,
  limit: true,
  sort: true,
  offset: true,
};

const MAX_DISCOVERY_REQUEST_BYTES = 256 * 1024;

class DiscoveryRequestTooLargeError extends Error {
  readonly code = "REQUEST_TOO_LARGE";
  readonly status = 413;

  constructor() {
    super("Discovery request is too large");
  }
}

function invalidJsonError(): Error & { code: string; status: number } {
  return Object.assign(new Error("Request body is not valid JSON"), {
    code: "INVALID_JSON",
    status: 400,
  });
}

async function parseBody(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null
    && /^\d+$/.test(contentLength.trim())
    && Number(contentLength) > MAX_DISCOVERY_REQUEST_BYTES
  ) throw new DiscoveryRequestTooLargeError();
  if (request.body === null) throw invalidJsonError();
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";
  const cancel = (): void => {
    void reader.cancel(request.signal.reason).catch(() => undefined);
  };
  if (request.signal.aborted) cancel();
  else request.signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_DISCOVERY_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DiscoveryRequestTooLargeError();
      }
      try {
        text += decoder.decode(chunk.value, { stream: true });
      } catch {
        throw invalidJsonError();
      }
    }
    request.signal.throwIfAborted();
    try {
      text += decoder.decode();
      return JSON.parse(text) as unknown;
    } catch {
      throw invalidJsonError();
    }
  } finally {
    request.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function integerParameter(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) return Number.NaN;
  return Number(value);
}

function parseListRequest(url: URL): DiscoveryListRequest | undefined {
  for (const key of url.searchParams.keys()) {
    if (LIST_PARAMETERS[key] !== true || url.searchParams.getAll(key).length !== 1) return undefined;
  }
  const role = url.searchParams.get("role");
  const suitable = url.searchParams.get("suitable");
  const status = url.searchParams.get("status");
  const hideQueued = url.searchParams.get("hideQueued");
  const sort = url.searchParams.get("sort");
  const search = url.searchParams.get("search");
  const maxAgeDays = url.searchParams.get("maxAgeDays");
  const parsed = DiscoveryListRequestSchema.safeParse({
    ...(role === null ? {} : { role }),
    ...(suitable === null
      ? {}
      : { suitable: suitable === "true" ? true : suitable === "false" ? false : suitable }),
    ...(status === null ? {} : { status }),
    ...(hideQueued === null
      ? {}
      : { hideQueued: hideQueued === "true" ? true : hideQueued === "false" ? false : hideQueued }),
    ...(sort === null ? {} : { sort }),
    ...(search === null ? {} : { search }),
    ...(maxAgeDays === null
      ? {}
      : { maxAgeDays: maxAgeDays === "all" ? null : integerParameter(maxAgeDays) }),
    ...(url.searchParams.has("limit")
      ? { limit: integerParameter(url.searchParams.get("limit")) }
      : {}),
    ...(url.searchParams.has("offset")
      ? { offset: integerParameter(url.searchParams.get("offset")) }
      : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

function mappedError(error: unknown): Response {
  let status = 500;
  let code = "INTERNAL_ERROR";
  let message = "Request failed";
  if (error && typeof error === "object") {
    if (
      "status" in error
      && typeof error.status === "number"
      && error.status >= 400
      && error.status <= 599
    ) status = error.status;
    if ("code" in error && typeof error.code === "string") code = error.code;
    if (status < 500 && "message" in error && typeof error.message === "string") {
      message = error.message;
    }
  }
  return apiResponse.error(code, message, status);
}

export function createDiscoveryRoutes(service: DiscoveryRouteService) {
  return async function routeDiscovery(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname === "/v1/discovery" && request.method === "GET") {
      const options = parseListRequest(url);
      if (!options) {
        return apiResponse.error("INVALID_REQUEST", "Discovery query is invalid", 400);
      }
      try {
        return apiResponse.json(DiscoveryListResponseSchema.parse(await service.list(options)));
      } catch (error) {
        return mappedError(error);
      }
    }
    if (url.pathname === DISCOVERY_SYNC_PATH && request.method === "POST") {
      try {
        const body = DiscoverySyncRequestSchema.safeParse(await parseBody(request));
        if (!body.success) {
          return apiResponse.error("INVALID_REQUEST", "Discovery sync request is invalid", 400);
        }
        return apiResponse.json(DiscoverySyncResponseSchema.parse(await service.sync(request.signal)));
      } catch (error) {
        return mappedError(error);
      }
    }
    if (url.pathname === "/v1/discovery/queue" && request.method === "POST") {
      try {
        const body = DiscoveryQueueRequestSchema.safeParse(await parseBody(request));
        if (!body.success) {
          return apiResponse.error("INVALID_REQUEST", "Discovery queue request is invalid", 400);
        }
        return apiResponse.json(DiscoveryQueueResponseSchema.parse(
          await service.queue(body.data, request.signal),
        ));
      } catch (error) {
        return mappedError(error);
      }
    }
    return null;
  };
}
