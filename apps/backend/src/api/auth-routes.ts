import {
  ApplicationModelSelectionSchema,
  AuthPromptAnswerSchema,
  AuthProviderSchema,
  StartAuthSessionRequestSchema,
  type ApplicationModelId,
  type ApplicationModelSelection,
  type AuthSession,
  type AuthStatusResponse,
  type AuthProvider,
  type ModelAuthProvider,
} from "../contracts";
import { apiResponse } from "./handler";

export interface AuthRouteService {
  getAuthStatus(): Promise<AuthStatusResponse> | AuthStatusResponse;
  startSession(provider: AuthProvider): Promise<AuthSession>;
  getSession(sessionId: string): Promise<AuthSession | undefined> | AuthSession | undefined;
  answerPrompt(sessionId: string, value: string): Promise<AuthSession>;
  cancelSession(sessionId: string): Promise<AuthSession | undefined>;
  logout(provider: AuthProvider): Promise<void>;
}

export interface ApplicationModelSelectionService {
  getApplicationModel(): Promise<ApplicationModelSelection> | ApplicationModelSelection;
  setApplicationModel(model: ApplicationModelId): Promise<ApplicationModelSelection> | ApplicationModelSelection;
}

interface PublicServiceError {
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

function serviceError(error: unknown): Response {
  const value = error as PublicServiceError;
  const status = typeof value?.status === "number" && value.status >= 400 && value.status <= 599 ? value.status : 500;
  const code = typeof value?.code === "string" ? value.code : "INTERNAL_ERROR";
  const message = status < 500 && typeof value?.message === "string" ? value.message : "Request failed";
  return apiResponse.error(code, message, status);
}


async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON"), {
      code: "INVALID_JSON",
      status: 400,
    });
  }
}


export function createAuthRoutes(
  service: AuthRouteService,
  modelSelection: ApplicationModelSelectionService,
) {
  return async function routeAuth(request: Request, url: URL): Promise<Response | null> {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "v1" || segments[1] !== "auth") return null;

    try {
      if (request.method === "GET" && segments.length === 2) {
        return apiResponse.json(await service.getAuthStatus());
      }

      if (segments[2] === "application-model" && segments.length === 3) {
        if (request.method === "GET") {
          return apiResponse.json(
            ApplicationModelSelectionSchema.parse(await modelSelection.getApplicationModel()),
          );
        }
        if (request.method === "PUT") {
          const body = ApplicationModelSelectionSchema.safeParse(await parseJson(request));
          if (!body.success) {
            return apiResponse.error("INVALID_REQUEST", "Application model is invalid", 400);
          }
          const provider: ModelAuthProvider = body.data.model === "gemini-3.8-flash"
            ? "google-antigravity"
            : "openai-codex";
          const providerName = provider === "google-antigravity" ? "Google Antigravity" : "OpenAI Codex";
          const modelName = body.data.model === "gemini-3.8-flash" ? "Gemini 3.8 Flash" : "GPT-5.6 Sol";
          const status = await service.getAuthStatus();
          if (status.providers.find((candidate) => candidate.provider === provider)?.state !== "connected") {
            return apiResponse.error(
              "AUTH_PROVIDER_DISCONNECTED",
              `Connect ${providerName} before selecting ${modelName}`,
              409,
            );
          }
          return apiResponse.json(
            ApplicationModelSelectionSchema.parse(
              await modelSelection.setApplicationModel(body.data.model),
            ),
          );
        }
        return null;
      }
      if (segments[2] === "sessions" && typeof segments[3] === "string") {
        const sessionId = segments[3];
        if (request.method === "GET" && segments.length === 4) {
          const session = await service.getSession(sessionId);
          return session ? apiResponse.json(session) : apiResponse.error("AUTH_SESSION_NOT_FOUND", "Authentication session not found", 404);
        }
        if (request.method === "POST" && segments[4] === "prompt" && segments.length === 5) {
          const body = AuthPromptAnswerSchema.safeParse(await parseJson(request));
          if (!body.success) return apiResponse.error("INVALID_REQUEST", "Prompt answer is invalid", 400);
          return apiResponse.json(await service.answerPrompt(sessionId, body.data.value));
        }
        if (request.method === "DELETE" && segments.length === 4) {
          const session = await service.cancelSession(sessionId);
          return session ? apiResponse.json(session) : apiResponse.error("AUTH_SESSION_NOT_FOUND", "Authentication session not found", 404);
        }
      }


      const provider = AuthProviderSchema.safeParse(segments[2]);
      if (!provider.success) return null;
      if (request.method === "POST" && segments[3] === "sessions" && segments.length === 4) {
        const body = StartAuthSessionRequestSchema.safeParse(await parseJson(request));
        if (!body.success) return apiResponse.error("INVALID_REQUEST", "Authentication session request must be an empty object", 400);
        return apiResponse.json(await service.startSession(provider.data), 201);
      }
      if (request.method === "DELETE" && segments.length === 3) {
        await service.logout(provider.data);
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      return null;
    } catch (error) {
      return serviceError(error);
    }
  };
}
