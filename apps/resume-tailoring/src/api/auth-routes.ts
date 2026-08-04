import {
  AuthPromptAnswerSchema,
  AuthProviderSchema,
  StartAuthSessionRequestSchema,
  type AuthSession,
  type AuthStatusResponse,
  type AuthProvider,
} from "../contracts";
import { apiResponse } from "./handler";

export interface AuthRouteService {
  getAuthStatus(): Promise<AuthStatusResponse> | AuthStatusResponse;
  startSession(provider: AuthProvider): Promise<AuthSession>;
  getSession(sessionId: string): Promise<AuthSession | undefined> | AuthSession | undefined;
  answerPrompt(sessionId: string, value: string): Promise<AuthSession>;
  cancelSession(sessionId: string): Promise<AuthSession | undefined>;
  logout(provider: AuthProvider): Promise<void>;
  completeIndeedCallback(input: {
    code?: string;
    state: string;
    issuer?: string;
    error?: string;
    errorDescription?: string;
    errorUri?: string;
  }): Promise<void>;
  configureAuthCallbackOrigin?(webOrigin: string): void;
}

interface PublicServiceError {
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

const CALLBACK_SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;
const MAX_CALLBACK_QUERY_LENGTH = 12_800;
const MAX_CALLBACK_PARAMETER_COUNT = 6;

function secureCallbackResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CALLBACK_SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function callbackFailure(code: string, message: string, status: number): Response {
  return secureCallbackResponse(apiResponse.error(code, message, status));
}

function serviceError(error: unknown): Response {
  const value = error as PublicServiceError;
  const status = typeof value?.status === "number" && value.status >= 400 && value.status <= 599 ? value.status : 500;
  const code = typeof value?.code === "string" ? value.code : "INTERNAL_ERROR";
  const message = status < 500 && typeof value?.message === "string" ? value.message : "Request failed";
  return apiResponse.error(code, message, status);
}

function callbackError(error: unknown): Response {
  const code = (error as PublicServiceError)?.code;
  if (code === "AUTH_CALLBACK_EXPIRED") {
    return callbackFailure(
      "AUTH_CALLBACK_EXPIRED",
      "Indeed authentication callback has expired",
      400,
    );
  }
  if (code === "AUTH_PROVIDER_UNAVAILABLE") {
    return callbackFailure(
      "AUTH_PROVIDER_UNAVAILABLE",
      "Indeed authentication is unavailable",
      502,
    );
  }
  return callbackFailure(
    "AUTH_CALLBACK_INVALID",
    "Indeed authentication callback is invalid",
    400,
  );
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

const CALLBACK_QUERY_KEYS: Readonly<Record<string, true>> = {
  code: true,
  state: true,
  iss: true,
  error: true,
  error_description: true,
  error_uri: true,
};

function parseIndeedCallback(url: URL): {
  code?: string;
  state: string;
  issuer?: string;
  error?: string;
  errorDescription?: string;
  errorUri?: string;
} | undefined {
  if (url.search.length > MAX_CALLBACK_QUERY_LENGTH) return undefined;
  let parameterCount = 0;
  for (const key of url.searchParams.keys()) {
    parameterCount += 1;
    if (parameterCount > MAX_CALLBACK_PARAMETER_COUNT || CALLBACK_QUERY_KEYS[key] !== true) {
      return undefined;
    }
  }
  const states = url.searchParams.getAll("state");
  const codes = url.searchParams.getAll("code");
  const issuers = url.searchParams.getAll("iss");
  const errors = url.searchParams.getAll("error");
  const errorDescriptions = url.searchParams.getAll("error_description");
  const errorUris = url.searchParams.getAll("error_uri");
  const hasDenial = errors.length === 1;
  if (
    states.length !== 1
    || states[0]!.length < 1
    || states[0]!.length > 128
    || codes.length > 1
    || (codes[0]?.length ?? 0) > 8_192
    || issuers.length > 1
    || (issuers[0]?.length ?? 0) > 256
    || errors.length > 1
    || (hasDenial && (errors[0]!.length < 1 || errors[0]!.length > 256))
    || errorDescriptions.length > 1
    || (errorDescriptions.length === 1
      && (errorDescriptions[0]!.length < 1 || errorDescriptions[0]!.length > 1_024))
    || errorUris.length > 1
    || (errorUris.length === 1 && (errorUris[0]!.length < 1 || errorUris[0]!.length > 2_048))
    || (hasDenial && codes.length !== 0)
    || (!hasDenial && (errorDescriptions.length !== 0 || errorUris.length !== 0))
  ) {
    return undefined;
  }
  return {
    state: states[0]!,
    ...(codes.length === 1 ? { code: codes[0]! } : {}),
    ...(issuers.length === 1 ? { issuer: issuers[0]! } : {}),
    ...(hasDenial ? { error: errors[0]! } : {}),
    ...(errorDescriptions.length === 1 ? { errorDescription: errorDescriptions[0]! } : {}),
    ...(errorUris.length === 1 ? { errorUri: errorUris[0]! } : {}),
  };
}

export function createAuthRoutes(service: AuthRouteService) {
  return async function routeAuth(request: Request, url: URL): Promise<Response | null> {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "v1" || segments[1] !== "auth") return null;

    try {
      if (request.method === "GET" && segments.length === 2) {
        return apiResponse.json(await service.getAuthStatus());
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

      if (
        request.method === "GET"
        && segments[2] === "indeed"
        && segments[3] === "callback"
        && segments.length === 4
      ) {
        const callback = parseIndeedCallback(url);
        if (!callback) {
          return callbackFailure(
            "AUTH_CALLBACK_INVALID",
            "Indeed authentication callback is invalid",
            400,
          );
        }
        try {
          await service.completeIndeedCallback(callback);
        } catch (error) {
          return callbackError(error);
        }
        return new Response(null, {
          status: 204,
          headers: CALLBACK_SECURITY_HEADERS,
        });
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
