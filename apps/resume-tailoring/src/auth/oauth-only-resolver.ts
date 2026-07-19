import type { ApiKeyResolver } from "@oh-my-pi/pi-ai";
import { assertOAuthOnlyStorage, getAuthStorage, type AuthProvider, type AuthStorageLike } from "./storage";

export class OAuthRequiredError extends Error {
  readonly code = "OAUTH_REQUIRED";

  constructor(provider: AuthProvider, cause?: unknown) {
    super(`OAuth sign-in required for ${provider}`, cause === undefined ? undefined : { cause });
    this.name = "OAuthRequiredError";
  }
}

function redactEmail(email: string): string {
  const separator = email.lastIndexOf("@");
  if (separator <= 0) return "***";
  return `${email[0]}***${email.slice(separator)}`;
}

const OAUTH_MODELS = {
  "openai-codex": ["gpt-5.6-sol", "gpt-5.6-luna"],
  "google-antigravity": ["gemini-3.5-flash"],
} as const;

function assertModel(provider: AuthProvider, modelId: string): void {
  const models = OAUTH_MODELS[provider as keyof typeof OAUTH_MODELS] as readonly string[] | undefined;
  if (!models?.includes(modelId)) throw new Error(`Unsupported OAuth model ${provider}/${modelId}`);
}

export async function resolveOAuthOnlyWithStorage(
  storage: AuthStorageLike,
  provider: AuthProvider,
  sessionId: string,
  modelId: string,
  signal?: AbortSignal,
  forceRefresh = false,
): Promise<string> {
  assertModel(provider, modelId);
  assertOAuthOnlyStorage(storage);
  let access;
  try {
    access = await storage.getOAuthAccess(provider, sessionId, {
      modelId,
      forceRefresh,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw new OAuthRequiredError(provider, error);
  }
  if (!access?.accessToken) throw new OAuthRequiredError(provider);

  if (provider === "openai-codex") return access.accessToken;
  if (!access.projectId) throw new OAuthRequiredError(provider);
  return JSON.stringify({
    token: access.accessToken,
    projectId: access.projectId,
    ...(access.email ? { email: redactEmail(access.email) } : {}),
  });
}

export async function oauthOnlyResolver(
  provider: AuthProvider,
  sessionId: string,
  modelId: string,
  signal?: AbortSignal,
  forceRefresh = false,
): Promise<string> {
  return resolveOAuthOnlyWithStorage(await getAuthStorage(), provider, sessionId, modelId, signal, forceRefresh);
}

export function createOAuthOnlyApiKeyResolver(
  provider: AuthProvider,
  sessionId: string,
  modelId: string,
  signal?: AbortSignal,
  storagePromise: Promise<AuthStorageLike> = getAuthStorage(),
): ApiKeyResolver {
  let forcedRefreshUsed = false;
  return async (context) => {
    const effectiveSignal = context.signal ?? signal;
    if (context.lastChance) return undefined;
    if (context.error !== undefined) {
      if (forcedRefreshUsed) return undefined;
      forcedRefreshUsed = true;
    }
    return resolveOAuthOnlyWithStorage(
      await storagePromise,
      provider,
      sessionId,
      modelId,
      effectiveSignal,
      context.error !== undefined,
    );
  };
}
