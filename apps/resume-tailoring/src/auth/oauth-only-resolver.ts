import type { ApiKeyResolver } from "@oh-my-pi/pi-ai";
import { assertOAuthOnlyStorage, getAuthStorage, type AuthProvider, type AuthStorageLike } from "./storage";

export class OAuthRequiredError extends Error {
  readonly code = "OAUTH_REQUIRED";

  constructor(provider: AuthProvider, cause?: unknown) {
    super(`OAuth sign-in required for ${provider}`, cause === undefined ? undefined : { cause });
    this.name = "OAuthRequiredError";
  }
}


const OAUTH_MODELS = ["gpt-5.6-sol", "gpt-5.6-luna"] as const;

function assertModel(provider: AuthProvider, modelId: string): void {
  if (!(OAUTH_MODELS as readonly string[]).includes(modelId)) {
    throw new Error(`Unsupported OAuth model ${provider}/${modelId}`);
  }
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

  return access.accessToken;
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
