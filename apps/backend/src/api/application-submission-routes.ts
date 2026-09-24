import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { RepositoryConflictError } from "../db/repository.ts";
import { apiResponse } from "./handler.ts";

const APPLICATION_SUBMISSION_PATH =
  /^\/v1\/internal\/application-submissions\/([^/]+)\/(review-ready|claim|finalize)$/;
const UUIDSchema = z.string().uuid();
const FinalizeRequestSchema = z.object({
  outcome: z.enum(["submitted", "uncertain"]),
}).strict();
const MAX_FINALIZE_REQUEST_BYTES = 1_024;

export interface ApplicationSubmissionRouteService {
  markReviewReady(sessionId: string): void | Promise<void>;
  claim(sessionId: string): void | Promise<void>;
  finalize(sessionId: string, outcome: "submitted" | "uncertain"): void | Promise<void>;
}

function bearerMatches(request: Request, token: string): boolean {
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  const actual = createHash("sha256").update(request.headers.get("authorization") ?? "").digest();
  return timingSafeEqual(actual, expected);
}

function noContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) throw new Error("request body exceeds limit");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function invalidRequest(): Response {
  return apiResponse.error("INVALID_REQUEST", "Request is invalid", 422);
}

export function createApplicationSubmissionRoutes(
  service: ApplicationSubmissionRouteService,
  token: string | undefined,
) {
  return async function routeApplicationSubmission(
    request: Request,
    url: URL,
  ): Promise<Response | null> {
    const match = APPLICATION_SUBMISSION_PATH.exec(url.pathname);
    if (request.method !== "POST" || match === null) return null;
    if (token === undefined || token.length === 0) {
      return apiResponse.error("NOT_FOUND", "Route not found", 404);
    }
    if (!bearerMatches(request, token)) {
      return apiResponse.error("UNAUTHORIZED", "Unauthorized", 401);
    }
    if (url.search !== "") return invalidRequest();
    const sessionId = UUIDSchema.safeParse(match[1]);
    if (!sessionId.success) return invalidRequest();

    try {
      if (match[2] === "review-ready" || match[2] === "claim") {
        try {
          if ((await readBoundedBody(request, 0)).byteLength !== 0) return invalidRequest();
        } catch {
          return invalidRequest();
        }
        if (match[2] === "review-ready") await service.markReviewReady(sessionId.data);
        else await service.claim(sessionId.data);
        return noContent();
      }

      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
        return invalidRequest();
      }
      let input: unknown;
      try {
        const bytes = await readBoundedBody(request, MAX_FINALIZE_REQUEST_BYTES);
        input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        return invalidRequest();
      }
      const parsed = FinalizeRequestSchema.safeParse(input);
      if (!parsed.success) return invalidRequest();
      await service.finalize(sessionId.data, parsed.data.outcome);
      return noContent();
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        return apiResponse.error("SUBMISSION_CONFLICT", "Application submission state changed", 409);
      }
      return apiResponse.error("INTERNAL_ERROR", "Request failed", 500);
    }
  };
}
