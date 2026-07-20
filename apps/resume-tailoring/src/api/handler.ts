import type { ApiError, HealthResponse } from "../contracts";
type ApiRoute = (request: Request, url: URL) => Response | Promise<Response | null> | null;


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
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const internalResponse = await options.internalRoute?.(request, url);
    if (internalResponse) return internalResponse;
    const isMutation = MUTATION_METHODS[request.method] === true;

    if (isMutation && request.headers.get("origin") !== options.webOrigin) {
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

    const routed = await options.route?.(request, url);
    return routed ?? error("NOT_FOUND", "Route not found", 404);
  };
}

export const apiResponse = { json, error } as const;
