import {
  ApproveRunRequestSchema,
  CreateRunRequestSchema,
  EditRunRequestSchema,
  RegenerateRunRequestSchema,
  RunDtoSchema,
  UpdateApplicationStatusRequestSchema,
  UpdateRunIdentityRequestSchema,
  type RunDto,
  type ApplicationStatus,
} from "../contracts";
import { apiResponse } from "./handler";

export interface RunRouteService {
  listRuns(): Promise<RunDto[]> | RunDto[];
  getRun(id: string): Promise<RunDto | undefined> | RunDto | undefined;
  createRun(jobUrl: string, generateKeywordMap: boolean, signal?: AbortSignal): Promise<RunDto>;
  updateApplicationStatus(id: string, applicationStatus: ApplicationStatus): Promise<RunDto>;
  updateRunIdentity(
    id: string,
    identity: { readonly title?: string | undefined; readonly organization?: string | undefined },
  ): Promise<RunDto>;
  deleteRun(id: string): Promise<void> | void;
  retryRun(id: string): Promise<RunDto>;
  regenerateRun(id: string, expectedPdfSha256: string): Promise<RunDto>;
  editRun(id: string, comments: string, expectedPdfSha256: string): Promise<RunDto>;
  approveRun(id: string, expectedPdfSha256: string, acknowledgeVisualIssues: boolean): Promise<RunDto>;
  getArtifact(runId: string, artifactId: string): Promise<Response | undefined> | Response | undefined;
  kick(): void;
}


function mappedError(error: unknown): Response {
  let status = 500;
  let code = "INTERNAL_ERROR";
  let message = "Request failed";
  if (error && typeof error === "object") {
    if ("status" in error && typeof error.status === "number" && error.status >= 400 && error.status <= 599) status = error.status;
    if ("code" in error && typeof error.code === "string") code = error.code;
    if (status < 500 && "message" in error && typeof error.message === "string") {
      message = error.message;
    } else if (code === "JOB_EXTRACTION_UNAVAILABLE") {
      message = "Job description extraction failed";
    } else if (code === "JOB_EXTRACTION_TIMEOUT") {
      message = "Job description extraction timed out";
    }
  }
  return apiResponse.error(code, message, status);
}

async function parseBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON"), { code: "INVALID_JSON", status: 400 });
  }
}

function checkedRun(run: RunDto): RunDto {
  return RunDtoSchema.parse(run);
}

export function createRunRoutes(service: RunRouteService) {
  return async function routeRuns(request: Request, url: URL): Promise<Response | null> {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "v1" || segments[1] !== "runs") return null;

    try {
      if (request.method === "GET" && segments.length === 2) {
        const runs = (await service.listRuns()).map(checkedRun);
        service.kick();
        return apiResponse.json({ runs });
      }
      if (request.method === "POST" && segments.length === 2) {
        const body = CreateRunRequestSchema.safeParse(await parseBody(request));
        if (!body.success) return apiResponse.error("INVALID_REQUEST", "Run request is invalid", 400);
        const run = checkedRun(await service.createRun(body.data.jobUrl, body.data.generateKeywordMap, request.signal));
        service.kick();
        return apiResponse.json(run, 201);
      }

      const runId = segments[2];
      if (!runId) return null;
      if (request.method === "GET" && segments.length === 3) {
        const run = await service.getRun(runId);
        service.kick();
        return run ? apiResponse.json(checkedRun(run)) : apiResponse.error("RUN_NOT_FOUND", "Run not found", 404);
      }
      if (request.method === "PATCH" && segments.length === 3) {
        const rawBody = await parseBody(request);
        const applicationStatus = UpdateApplicationStatusRequestSchema.safeParse(rawBody);
        if (applicationStatus.success) {
          const run = checkedRun(
            await service.updateApplicationStatus(runId, applicationStatus.data.applicationStatus),
          );
          return apiResponse.json(run);
        }
        const identity = UpdateRunIdentityRequestSchema.safeParse(rawBody);
        if (identity.success) {
          const run = checkedRun(await service.updateRunIdentity(runId, identity.data));
          return apiResponse.json(run);
        }
        const identityAttempt = rawBody !== null
          && typeof rawBody === "object"
          && !Array.isArray(rawBody)
          && ("title" in rawBody || "organization" in rawBody);
        return apiResponse.error(
          "INVALID_REQUEST",
          identityAttempt ? "Run identity is invalid" : "Application status is invalid",
          400,
        );
      }
      if (request.method === "DELETE" && segments.length === 3) {
        await service.deleteRun(runId);
        service.kick();
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      if (request.method === "GET" && segments[3] === "artifacts" && segments.length === 5) {
        const artifactId = segments[4];
        if (!artifactId) return null;
        const response = await service.getArtifact(runId, artifactId);
        if (!response) return apiResponse.error("ARTIFACT_NOT_FOUND", "Artifact not found", 404);
        response.headers.set("cache-control", "no-store");
        return response;
      }
      if (request.method !== "POST" || segments.length !== 4) return null;

      let run: RunDto;
      if (segments[3] === "retry") {
        const body = await parseBody(request);
        if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 0) {
          return apiResponse.error("INVALID_REQUEST", "Retry request must be an empty object", 400);
        }
        run = await service.retryRun(runId);
      } else if (segments[3] === "regenerate") {
        const body = RegenerateRunRequestSchema.safeParse(await parseBody(request));
        if (!body.success) return apiResponse.error("INVALID_REQUEST", "Regenerate request is invalid", 400);
        run = await service.regenerateRun(runId, body.data.expectedPdfSha256);
      } else if (segments[3] === "edit") {
        const rawBody = await parseBody(request);
        const body = EditRunRequestSchema.safeParse(rawBody);
        if (!body.success || !rawBody || typeof rawBody !== "object" || !("comments" in rawBody) || typeof rawBody.comments !== "string") {
          return apiResponse.error("INVALID_REQUEST", "Edit comments or PDF hash are invalid", 400);
        }
        run = await service.editRun(runId, rawBody.comments, body.data.expectedPdfSha256);
      } else if (segments[3] === "approve") {
        const body = ApproveRunRequestSchema.safeParse(await parseBody(request));
        if (!body.success) return apiResponse.error("INVALID_REQUEST", "Approval request is invalid", 400);
        run = await service.approveRun(
          runId,
          body.data.expectedPdfSha256,
          body.data.acknowledgeVisualIssues,
        );
      } else {
        return null;
      }
      service.kick();
      return apiResponse.json(checkedRun(run));
    } catch (error) {
      return mappedError(error);
    }
  };
}
