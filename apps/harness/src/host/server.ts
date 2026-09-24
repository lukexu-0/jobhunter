import type { Server } from "bun";
import { createHash, timingSafeEqual } from "node:crypto";

import {
  APPLICATION_ANECDOTE_MAX_COUNT,
  APPLICATION_CONTEXT_MAX_COUNT,
  HarnessServiceError,
} from "./artifacts.ts";
import { ApplicationModelNameSchema, ApplicationModelProviderSchema, OpportunityKindSchema, MirroredOAuthCredentialSchema, PublicRuntimeActionRequestSchema, RuntimeActionRequestSchema, SessionCommandSchema, SourceCaptureCreateRequestSchema, validateJobUrl, type ApplicationModelProvider, type MirroredOAuthCredential } from "../contracts/models.ts";
import type { SessionEvent } from "./events.ts";
import type { ApplicationModelMetadata } from "../application/application-agent.ts";
import type { SourceCaptureManager } from "./source-capture.ts";
import type { ApplicationSessionManager } from "./sessions.ts";

import {
  GmailOAuthServiceError,
  type GmailAuthSession,
  type GmailOAuthManager,
} from "./gmail.ts";

export interface HarnessServerConfig {
  bearerToken: string;
}

export const HARNESS_REQUEST_BODY_LIMITS = Object.freeze({
  jsonBytes: 1024 * 1024,
  multipartBytes: 160 * 1024 * 1024,
});

export interface HarnessDependencies {
  gmailAuth: Pick<GmailOAuthManager, "completeCallback" | "disconnect" | "getSession" | "start" | "status">;
  modelAuth: {
    setCredential(
      provider: ApplicationModelProvider,
      credential: MirroredOAuthCredential,
    ): Promise<void>;
    deleteCredential(provider: ApplicationModelProvider): Promise<void>;
    setApplicationModel(model: "gpt-5.6-sol" | "gemini-3.8-flash"): void;
    readApplicationModel(): ApplicationModelMetadata;
    isConnected(provider: ApplicationModelProvider): boolean;
  };
  sourceCaptures: Pick<SourceCaptureManager, "create" | "complete" | "delete">;
  sessions: Pick<
    ApplicationSessionManager,
    | "create"
    | "getSnapshot"
    | "subscribeEvents"
    | "openBrowser"
    | "suggestions"
    | "command"
    | "runtimeAction"
    | "runtimeModelAction"
    | "delete"
  >;
}

function zModelSelection(value: unknown): "gpt-5.6-sol" | "gemini-3.8-flash" | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1) return null;
  const parsed = ApplicationModelNameSchema.safeParse(record.model);
  return parsed.success ? parsed.data : null;
}

export type HarnessHandler = (request: Request) => Response | Promise<Response>;

export function startHarnessServer(port: number, handler: HarnessHandler): Server<undefined> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    maxRequestBodySize: HARNESS_REQUEST_BODY_LIMITS.multipartBytes,
    fetch: handler,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function gmailAuthSessionResponse(session: GmailAuthSession): Record<string, unknown> {
  return {
    id: session.id,
    state: session.state,
    ...(session.authorizationUrl === undefined
      ? {}
      : { authorization_url: session.authorizationUrl }),
    expires_at: session.expiresAt.toISOString(),
  };
}

function sseResponse(source: ReadableStream<SessionEvent>, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<SessionEvent> | undefined;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = source.getReader();
      let closed = false;
      const heartbeat = () => { if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n")); };
      const timer = setInterval(heartbeat, 15_000);
      const abort = () => { void reader?.cancel(); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const event = next.value;
          controller.enqueue(encoder.encode(`id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`));
        }
        heartbeat();
        closed = true;
        controller.close();
      } catch (error) {
        closed = true;
        controller.error(error);
      } finally {
        clearInterval(timer);
        signal.removeEventListener("abort", abort);
        reader.releaseLock();
      }
    },
    async cancel() { await reader?.cancel(); },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

async function requestIsBodyless(request: Request): Promise<boolean> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isInteger(declaredLength) || declaredLength !== 0) return false;
  }
  if (request.body === null) return true;

  const reader = request.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return true;
      if (chunk.value.byteLength > 0) return false;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function hasMediaType(request: Request, expected: string): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === expected;
}

function boundedRequestBody(request: Request, maximumBytes: number): ReadableStream<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null
    && (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBytes)) {
    throw new Error("invalid content length");
  }
  if (request.body === null) throw new Error("missing request body");

  const reader = request.body.getReader();
  let bytesRead = 0;
  let finished = false;
  const finish = (): void => {
    if (!finished) {
      finished = true;
      reader.releaseLock();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
          return;
        }
        bytesRead += chunk.value.byteLength;
        if (bytesRead > maximumBytes) {
          await reader.cancel();
          finish();
          controller.error(new Error("request body too large"));
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (finished) return;
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
}

async function parseJsonRequest(request: Request): Promise<unknown> {
  if (!hasMediaType(request, "application/json")) throw new Error("invalid content type");
  return new Response(
    boundedRequestBody(request, HARNESS_REQUEST_BODY_LIMITS.jsonBytes),
  ).json();
}

async function parseMultipartRequest(request: Request): Promise<FormData> {
  if (!hasMediaType(request, "multipart/form-data")) throw new Error("invalid content type");
  return new Response(
    boundedRequestBody(request, HARNESS_REQUEST_BODY_LIMITS.multipartBytes),
    { headers: { "content-type": request.headers.get("content-type")! } },
  ).formData();
}

export function createHarnessHandler(
  config: HarnessServerConfig,
  dependencies: Partial<HarnessDependencies> = {},
): HarnessHandler {
  const expectedAuthorization = createHash("sha256")
    .update(`Bearer ${config.bearerToken}`, "utf8")
    .digest();

  return async (request) => {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/v1/")) {
        const authorization = createHash("sha256")
          .update(request.headers.get("authorization") ?? "", "utf8")
          .digest();
        if (!timingSafeEqual(authorization, expectedAuthorization)) {
          return jsonResponse(401, {
            code: "unauthorized",
            message: "Unauthorized",
          });
        }
      }

      if (request.method === "GET" && url.pathname === "/oauth/gmail/callback") {
        const allowed = new Set(["state", "code", "error", "error_description", "error_uri", "scope", "authuser", "prompt", "hd", "iss"]);
        const entries = [...url.searchParams.entries()];
        const counts = new Map<string, number>();
        for (const [key] of entries) counts.set(key, (counts.get(key) ?? 0) + 1);
        let succeeded = false;
        const valid = entries.every(([key, value]) => allowed.has(key) && value.length <= 8_192 && !value.includes("\0"))
          && [...counts.values()].every((count) => count === 1)
          && (url.searchParams.get("iss") ?? "https://accounts.google.com") === "https://accounts.google.com";
        if (valid && dependencies.gmailAuth) {
          try {
            if (await requestIsBodyless(request)) {
              succeeded = await dependencies.gmailAuth.completeCallback({
                state: url.searchParams.get("state"),
                code: url.searchParams.get("code"),
                error: url.searchParams.get("error"),
              });
            }
          } catch { succeeded = false; }
        }
        const content = succeeded
          ? "<!doctype html><meta charset=utf-8><title>Gmail connection</title><p>Gmail connected. You may close this window.</p><script>window.close()</script>"
          : "<!doctype html><meta charset=utf-8><title>Gmail connection</title><p>Gmail was not connected. Return to Providers and try again.</p>";
        return new Response(content, {
          status: succeeded ? 200 : 400,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/healthz") { return jsonResponse(200, { status: "ok" }); }
      
      const modelCredentialMatch = /^\/v1\/model-credentials\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PUT" && modelCredentialMatch) {
        if (url.search !== "" || !dependencies.modelAuth) {
          if (url.search !== "") {
            return jsonResponse(422, {
              code: "invalid_request",
              message: "Request is invalid",
            });
          }
          return jsonResponse(500, {
            code: "internal_error",
            message: "Request failed",
          });
        }
        let body: unknown;
        try {
          body = await parseJsonRequest(request);
        } catch {
          return jsonResponse(422, {
            code: "invalid_request",
            message: "Request is invalid",
          });
        }
        const provider = ApplicationModelProviderSchema.safeParse(modelCredentialMatch[1]);
        const credential = MirroredOAuthCredentialSchema.safeParse(body);
        if (!provider.success || !credential.success) {
          return jsonResponse(422, {
            code: "invalid_request",
            message: "Request is invalid",
          });
        }
        await dependencies.modelAuth.setCredential(provider.data, credential.data);
        return new Response(null, {
          status: 204,
          headers: { "cache-control": "no-store" },
        });
      }

      if (request.method === "DELETE" && modelCredentialMatch) {
        if (url.search !== "" || !(await requestIsBodyless(request))) {
          return jsonResponse(422, {
            code: "invalid_request",
            message: "Request is invalid",
          });
        }
        if (!dependencies.modelAuth) {
          return jsonResponse(500, {
            code: "internal_error",
            message: "Request failed",
          });
        }
        const provider = ApplicationModelProviderSchema.safeParse(modelCredentialMatch[1]);
        if (!provider.success) {
          return jsonResponse(422, {
            code: "invalid_request",
            message: "Request is invalid",
          });
        }
        await dependencies.modelAuth.deleteCredential(provider.data);
        return new Response(null, {
          status: 204,
          headers: { "cache-control": "no-store" },
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/application-model") {
        if (url.search !== "" || !(await requestIsBodyless(request))) {
          return jsonResponse(422, {
            code: "invalid_request",
            message: "Request is invalid",
          });
        }
        if (!dependencies.modelAuth) {
          return jsonResponse(500, {
            code: "internal_error",
            message: "Request failed",
          });
        }
        const model = dependencies.modelAuth.readApplicationModel();
        if (!dependencies.modelAuth.isConnected(model.modelProvider)) {
          return jsonResponse(409, {
            code: "oauth_required",
            message: "Connect the configured application model provider in Credentials",
          });
        }
        return jsonResponse(200, { ...model, oauth: "connected" });
      }

      if (request.method === "PUT" && url.pathname === "/v1/application-model") {
        if (url.search !== "" || !dependencies.modelAuth) {
          if (url.search !== "") {
            return jsonResponse(422, {
              code: "invalid_request",
              message: "Request is invalid",
            });
          }
          return jsonResponse(500, {
            code: "internal_error",
            message: "Request failed",
          });
        }
        let body: unknown;
        try {
          body = await parseJsonRequest(request);
        } catch {
          return jsonResponse(422, {
            code: "invalid_request",
            message: "Request is invalid",
          });
        }
        const parsed = zModelSelection(body);
        if (parsed === null) {
          return jsonResponse(422, {
            code: "invalid_request",
            message: "Request is invalid",
          });
        }
        dependencies.modelAuth.setApplicationModel(parsed);
        return new Response(null, {
          status: 204,
          headers: { "cache-control": "no-store" },
        });
      }

      const eventsMatch = /^\/v1\/sessions\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/events$/.exec(url.pathname);
      if (request.method === "GET" && eventsMatch) {
        if (url.search !== "" || !(await requestIsBodyless(request))) return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" });
        const lastHeader = request.headers.get("last-event-id");
        if (lastHeader !== null && !/^(0|[1-9][0-9]*)$/.test(lastHeader)) {
          return jsonResponse(422, { code: "invalid_request", message: "Last-Event-ID must be nonnegative" });
        }
        const lastEventId = lastHeader === null ? undefined : Number(lastHeader);
        if (lastEventId !== undefined && !Number.isSafeInteger(lastEventId)) return jsonResponse(422, { code: "invalid_request", message: "Last-Event-ID must be nonnegative" });
        if (!dependencies.sessions) return jsonResponse(500, { code: "internal_error", message: "Request failed" });
        dependencies.sessions.getSnapshot(eventsMatch[1]!);
        return sseResponse(dependencies.sessions.subscribeEvents(eventsMatch[1]!, lastEventId), request.signal);
      }

      const suggestionsMatch = /^\/v1\/sessions\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/additional-info\/([a-z][a-z0-9_]{0,63})\/suggestions$/.exec(url.pathname);
      if (request.method === "GET" && suggestionsMatch) {
        if (url.search !== "" || !(await requestIsBodyless(request))) return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" });
        if (!dependencies.sessions) return jsonResponse(500, { code: "internal_error", message: "Request failed" });
        return jsonResponse(200, await dependencies.sessions.suggestions(suggestionsMatch[1]!, suggestionsMatch[2]!));
      }

      const browserOpenMatch = /^\/v1\/sessions\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/browser\/open$/.exec(url.pathname);
      if (request.method === "POST" && browserOpenMatch) {
        if (url.search !== "" || !(await requestIsBodyless(request))) return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" });
        if (!dependencies.sessions) return jsonResponse(500, { code: "internal_error", message: "Request failed" });
        await dependencies.sessions.openBrowser(browserOpenMatch[1]!);
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }

      const sessionMatch = /^\/v1\/sessions\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(url.pathname);
      if (request.method === "DELETE" && sessionMatch) {
        if (url.search !== "" || !(await requestIsBodyless(request))) return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" });
        if (!dependencies.sessions) return jsonResponse(500, { code: "internal_error", message: "Request failed" });
        await dependencies.sessions.delete(sessionMatch[1]!);
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      if (request.method === "GET" && sessionMatch) {
        if (url.search !== "" || !(await requestIsBodyless(request))) return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" });
        if (!dependencies.sessions) return jsonResponse(500, { code: "internal_error", message: "Request failed" });
        return jsonResponse(200, dependencies.sessions.getSnapshot(sessionMatch[1]!));
      }

      const runtimeMatch = /^\/v1\/sessions\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/runtime\/(model-)?actions$/.exec(url.pathname);
      if (request.method === "POST" && runtimeMatch) {
        if (url.search !== "") return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" });
        if (!dependencies.sessions) return jsonResponse(500, { code: "internal_error", message: "Request failed" });
        let body: unknown;
        try { body = await parseJsonRequest(request); }
        catch { return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" }); }
        const action = (runtimeMatch[2] === undefined
          ? PublicRuntimeActionRequestSchema
          : RuntimeActionRequestSchema).safeParse(body);
        if (!action.success) return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" });
        const result = runtimeMatch[2] === undefined
          ? await dependencies.sessions.runtimeAction(runtimeMatch[1]!, action.data)
          : await dependencies.sessions.runtimeModelAction(runtimeMatch[1]!, action.data);
        return jsonResponse(200, result);
      }

      const commandMatch = /^\/v1\/sessions\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/commands$/.exec(url.pathname);
      if (request.method === "POST" && commandMatch) {
        if (url.search !== "") return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" });
        if (!dependencies.sessions) return jsonResponse(500, { code: "internal_error", message: "Request failed" });
        let body: unknown;
        try { body = await parseJsonRequest(request); }
        catch { return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" }); }
        const command = SessionCommandSchema.safeParse(body);
        if (!command.success) return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" });
        await dependencies.sessions.command(commandMatch[1]!, command.data);
        return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
      }

      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        if (url.search !== "" || !dependencies.sessions) {
          if (url.search !== "") return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" });
          return jsonResponse(500, { code: "internal_error", message: "Request failed" });
        }
        let form: FormData;
        try { form = await parseMultipartRequest(request); }
        catch { return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" }); }
        const allowed = new Set(["session_id", "job_url", "opportunity_kind", "auto_submit", "auto_end", "personal_information", "resume", "resume_source", "context", "anecdote", "transcript"]);
        if ([...form.keys()].some((key) => !allowed.has(key))) return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" });
        const oneString = (name: string, required = true): string | undefined => {
          const values = form.getAll(name);
          if (values.length === 0 && !required) return undefined;
          if (values.length !== 1 || typeof values[0] !== "string") throw new Error();
          return values[0];
        };
        const oneFile = (name: string, required = true): File | undefined => {
          const values = form.getAll(name);
          if (values.length === 0 && !required) return undefined;
          if (values.length !== 1 || !(values[0] instanceof File) || values[0].name.length === 0) throw new Error();
          return values[0];
        };
        try {
          const sessionId = oneString("session_id", false);
          if (sessionId !== undefined && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(sessionId)) throw new Error();
          const jobUrl = oneString("job_url")!;
          validateJobUrl(jobUrl);
          const opportunityKind = OpportunityKindSchema.parse(oneString("opportunity_kind"));
          const parseBoolean = (name: string): boolean => {
            const value = oneString(name, false);
            if (value === undefined) return false;
            if (value !== "true" && value !== "false") throw new Error();
            return value === "true";
          };
          const context = form.getAll("context");
          const anecdotes = form.getAll("anecdote");
          if (context.length > APPLICATION_CONTEXT_MAX_COUNT || anecdotes.length > APPLICATION_ANECDOTE_MAX_COUNT ||
              context.some((value) => !(value instanceof File)) || anecdotes.some((value) => !(value instanceof File))) throw new Error();
          const response = await dependencies.sessions.create({
            ...(sessionId === undefined ? {} : { sessionId }),
            jobUrl, opportunityKind, autoSubmit: parseBoolean("auto_submit"), autoEnd: parseBoolean("auto_end"),
            personalInformation: oneFile("personal_information")!,
            resume: oneFile("resume")!,
            resumeSource: oneFile("resume_source")!,
            context: context as File[],
            anecdotes: anecdotes as File[],
            ...(oneFile("transcript", false) === undefined ? {} : { transcript: oneFile("transcript", false)! }),
          });
          return jsonResponse(202, response);
        } catch (error) {
          if (error instanceof HarnessServiceError) throw error;
          return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" });
        }
      }

      const sourceDeleteMatch = /^\/v1\/source-captures\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(url.pathname);
      if (request.method === "DELETE" && sourceDeleteMatch) {
        if (url.search !== "" || !(await requestIsBodyless(request))) {
          return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" });
        }
        if (!dependencies.sourceCaptures) return jsonResponse(500, { code: "internal_error", message: "Request failed" });
        await dependencies.sourceCaptures.delete(sourceDeleteMatch[1]!);
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }

      const sourceCompleteMatch = /^\/v1\/source-captures\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/complete$/.exec(url.pathname);
      if (request.method === "POST" && sourceCompleteMatch) {
        if (url.search !== "" || !(await requestIsBodyless(request))) {
          return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" });
        }
        if (!dependencies.sourceCaptures) return jsonResponse(500, { code: "internal_error", message: "Request failed" });
        return jsonResponse(200, await dependencies.sourceCaptures.complete(sourceCompleteMatch[1]!));
      }

      if (request.method === "POST" && url.pathname === "/v1/source-captures") {
        if (url.search !== "" || !dependencies.sourceCaptures) {
          if (url.search !== "") return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" });
          return jsonResponse(500, { code: "internal_error", message: "Request failed" });
        }
        let body: unknown;
        try { body = await parseJsonRequest(request); }
        catch { return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" }); }
        const parsed = SourceCaptureCreateRequestSchema.safeParse(body);
        if (!parsed.success) return jsonResponse(422, { code: "invalid_request", message: "Request is invalid" });
        return jsonResponse(202, await dependencies.sourceCaptures.create(parsed.data));
      }

      if (request.method === "GET" && url.pathname === "/v1/gmail-auth") {
        if (!(await requestIsBodyless(request))) {
          return jsonResponse(422, {
            code: "invalid_request",
            message: "Request is invalid",
          });
        }
        if (!dependencies.gmailAuth) {
          return jsonResponse(500, {
            code: "internal_error",
            message: "Request failed",
          });
        }
        return jsonResponse(200, await dependencies.gmailAuth.status());
      }

      if (request.method === "DELETE" && url.pathname === "/v1/gmail-auth") {
        if (url.search !== "" || !(await requestIsBodyless(request))) {
          return jsonResponse(422, {
            code: "invalid_request",
            message: "Request is invalid",
          });
        }
        if (!dependencies.gmailAuth) {
          return jsonResponse(500, {
            code: "internal_error",
            message: "Request failed",
          });
        }
        await dependencies.gmailAuth.disconnect();
        return new Response(null, {
          status: 204,
          headers: { "cache-control": "no-store" },
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/gmail-auth/sessions"
      ) {
        let body: unknown;
        try {
          body = await parseJsonRequest(request);
        } catch {
          return jsonResponse(422, {
            code: "invalid_request",
            message: "Request is invalid",
          });
        }
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          Object.keys(body).length !== 0
        ) {
          return jsonResponse(422, {
            code: "invalid_request",
            message: "Request is invalid",
          });
        }
        if (!dependencies.gmailAuth) {
          return jsonResponse(500, {
            code: "internal_error",
            message: "Request failed",
          });
        }
        const session = await dependencies.gmailAuth.start();
        return jsonResponse(201, gmailAuthSessionResponse(session));
      }

      const gmailSessionMatch = /^\/v1\/gmail-auth\/sessions\/([^/]+)$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && gmailSessionMatch) {
        const sessionId = gmailSessionMatch[1];
        if (
          !sessionId ||
          !/^[A-Za-z0-9_-]{43}$/.test(sessionId) ||
          url.search !== "" ||
          !(await requestIsBodyless(request))
        ) {
          return jsonResponse(422, {
            code: "invalid_request",
            message: "Request is invalid",
          });
        }
        if (!dependencies.gmailAuth) {
          return jsonResponse(500, {
            code: "internal_error",
            message: "Request failed",
          });
        }
        const session = await dependencies.gmailAuth.getSession(sessionId);
        return jsonResponse(200, gmailAuthSessionResponse(session));
      }

      return jsonResponse(404, { detail: "Not Found" });
    } catch (error) {
      if (error instanceof HarnessServiceError) {
        if (error.code === "session_active" && error.sessionId !== undefined) {
          return jsonResponse(error.statusCode, { code: error.code, session_id: error.sessionId });
        }
        return jsonResponse(error.statusCode, {
          code: error.code,
          message: error.publicMessage,
          ...(error.sessionId === undefined ? {} : { session_id: error.sessionId }),
        });
      }
      if (error instanceof GmailOAuthServiceError) {
        return jsonResponse(error.statusCode, {
          code: error.code,
          message: error.publicMessage,
        });
      }
      return jsonResponse(500, {
        code: "internal_error",
        message: "Request failed",
      });
    }
  };
}
