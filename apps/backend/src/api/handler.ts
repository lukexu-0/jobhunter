import type { ApiError, HealthResponse } from "../contracts";
export interface ApiRequestContext {
  readonly onRunCreationValidated?: () => void;
  readonly onSourceHandoffCreationValidated?: () => void;
  readonly onSourceHandoffCompletionValidated?: () => void;
}

type ApiRoute = (
  request: Request,
  url: URL,
  context: ApiRequestContext,
) => Response | Promise<Response | null> | null;


export interface ApiHandlerOptions {
  webOrigin: string;
  internalRoute?: ApiRoute;
  route?: ApiRoute;
}

const MUTATION_METHODS: Readonly<Record<string, true>> = {
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
};

const LOOPBACK_ORIGIN_PATTERN =
  /^[a-z][a-z0-9+.-]*:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/;

function loopbackAliasOrigin(origin: string): string | undefined {
  const match = LOOPBACK_ORIGIN_PATTERN.exec(origin);
  if (!match) return undefined;
  try {
    const url = new URL(origin);
    if (
      url.origin === "null" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.hostname !== match[1]
    ) {
      return undefined;
    }

    const aliasHost = url.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
    return `${url.protocol}//${aliasHost}${url.port === "" ? "" : `:${url.port}`}`;
  } catch {
    return undefined;
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function error(code: string, message: string, status: number): Response {
  return json({ error: { code, message } } satisfies ApiError, status);
}

export function createApiHandler(options: ApiHandlerOptions) {
  const loopbackAlias = loopbackAliasOrigin(options.webOrigin);
  return async function handle(
    request: Request,
    context: ApiRequestContext = {},
  ): Promise<Response> {
    const url = new URL(request.url);
    const internalResponse = await options.internalRoute?.(request, url, context);
    if (internalResponse) return internalResponse;
    const isMutation = MUTATION_METHODS[request.method] === true;

    const origin = request.headers.get("origin");
    if (isMutation && origin !== options.webOrigin && origin !== loopbackAlias) {
      return error("ORIGIN_REJECTED", "Mutation origin is not allowed", 403);
    }

    if (
      isMutation &&
      request.body !== null &&
      !/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")
    ) {
      return error("JSON_REQUIRED", "Mutation request bodies must use application/json", 415);
    }

    if (request.method === "GET" && url.pathname === "/v1/health") {
      return json({ status: "ok" } satisfies HealthResponse);
    }

    const routed = await options.route?.(request, url, context);
    return routed ?? error("NOT_FOUND", "Route not found", 404);
  };
}

export const apiResponse = { json, error } as const;
