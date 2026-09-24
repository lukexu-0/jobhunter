import {
  CreateSourceHandoffRequestSchema,
  RunDtoSchema,
  SourceHandoffDtoSchema,
  SourceHandoffIdSchema,
  type CreateSourceHandoffRequest,
  type RunDto,
  type SourceHandoffDto,
} from "../contracts";
import { apiResponse, type ApiRequestContext } from "./handler";
import { mapRunRouteError } from "./run-routes.ts";
import {
  isEligibleSourceHandoffJobUrl,
  SourceHandoffError,
} from "./source-handoff-service.ts";

export interface SourceHandoffRouteService {
  create(
    request: CreateSourceHandoffRequest,
    signal?: AbortSignal,
  ): Promise<SourceHandoffDto>;
  get(id: string): Promise<SourceHandoffDto>;
  complete(id: string, signal?: AbortSignal): Promise<RunDto>;
  delete(id: string): Promise<void>;
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

function mapSourceHandoffRouteError(error: unknown): Response {
  if (error instanceof SourceHandoffError) {
    return apiResponse.error(error.code, error.message, error.status);
  }
  return mapRunRouteError(error);
}

export function createSourceHandoffRoutes(service: SourceHandoffRouteService) {
  return async function routeSourceHandoffs(
    request: Request,
    url: URL,
    context: ApiRequestContext = {},
  ): Promise<Response | null> {
    const segments = url.pathname.split("/").filter(Boolean);
    if (url.pathname !== `/${segments.join("/")}`) return null;
    if (segments[0] !== "v1" || segments[1] !== "source-handoffs") return null;

    try {
      if (request.method === "POST" && segments.length === 2) {
        const body = CreateSourceHandoffRequestSchema.safeParse(
          await parseBody(request),
        );
        if (!body.success) {
          return apiResponse.error(
            "INVALID_REQUEST",
            "Source handoff request is invalid",
            400,
          );
        }
        if (!isEligibleSourceHandoffJobUrl(body.data.jobUrl)) {
          throw new SourceHandoffError("SOURCE_HANDOFF_INVALID_URL");
        }
        context.onSourceHandoffCreationValidated?.();
        const created = SourceHandoffDtoSchema.parse(
          await service.create(body.data, request.signal),
        );
        return apiResponse.json(created, 201);
      }

      const rawHandoffId = segments[2];
      if (!rawHandoffId) return null;
      const handoffId = SourceHandoffIdSchema.safeParse(rawHandoffId);
      if (!handoffId.success) {
        return apiResponse.error(
          "SOURCE_HANDOFF_NOT_FOUND",
          "Source handoff not found",
          404,
        );
      }
      if (request.method === "GET" && segments.length === 3) {
        return apiResponse.json(
          SourceHandoffDtoSchema.parse(await service.get(handoffId.data)),
        );
      }
      if (request.method === "DELETE" && segments.length === 3) {
        if (request.body !== null) {
          return apiResponse.error(
            "INVALID_REQUEST",
            "Cancel request must not include a body",
            400,
          );
        }
        await service.delete(handoffId.data);
        return new Response(null, {
          status: 204,
          headers: { "cache-control": "no-store" },
        });
      }
      if (
        request.method === "POST"
        && segments[3] === "complete"
        && segments.length === 4
      ) {
        if (request.body !== null) {
          return apiResponse.error(
            "INVALID_REQUEST",
            "Completion request must not include a body",
            400,
          );
        }
        context.onSourceHandoffCompletionValidated?.();
        const run = RunDtoSchema.parse(
          await service.complete(handoffId.data, request.signal),
        );
        return apiResponse.json(run, 201);
      }
      return null;
    } catch (error) {
      return mapSourceHandoffRouteError(error);
    }
  };
}
