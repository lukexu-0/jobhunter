import type { ApiKeyResolver } from "@oh-my-pi/pi-ai";
import type { ApplicationModelProvider } from "../contracts/models.ts";
import { assertOAuthOnlyStorage, getAuthStorage, type AuthStorageLike } from "./storage";

export class OAuthRequiredError extends Error {
  readonly code = "OAUTH_REQUIRED";

  constructor(provider: ApplicationModelProvider, cause?: unknown) {
    super(`OAuth sign-in required for ${provider}`, cause === undefined ? undefined : { cause });
    this.name = "OAuthRequiredError";
  }
}


const OAUTH_MODELS: Record<ApplicationModelProvider, readonly string[]> = {
  "openai-codex": ["gpt-5.6-sol", "gpt-5.6-luna"],
  "google-antigravity": ["gemini-3.8-flash"],
};

function assertModel(provider: ApplicationModelProvider, modelId: string): void {
  if (!OAUTH_MODELS[provider]?.includes(modelId)) {
    throw new Error(`Unsupported OAuth model ${provider}/${modelId}`);
  }
}

export async function resolveOAuthOnlyWithStorage(
  storage: AuthStorageLike,
  provider: ApplicationModelProvider,
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

  if (provider === "google-antigravity") {
    if (!access.projectId) throw new OAuthRequiredError(provider);
    return JSON.stringify({ token: access.accessToken, projectId: access.projectId });
  }
  return access.accessToken;
}

export async function oauthOnlyResolver(
  provider: ApplicationModelProvider,
  sessionId: string,
  modelId: string,
  signal?: AbortSignal,
  forceRefresh = false,
): Promise<string> {
  return resolveOAuthOnlyWithStorage(await getAuthStorage(), provider, sessionId, modelId, signal, forceRefresh);
}

export function createOAuthOnlyApiKeyResolver(
  provider: ApplicationModelProvider,
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
