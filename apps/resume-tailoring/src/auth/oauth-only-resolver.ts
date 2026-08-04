import type { ApiKeyResolver } from "@oh-my-pi/pi-ai";
import type { ModelAuthProvider } from "../contracts";
import { assertOAuthOnlyStorage, getAuthStorage, type AuthStorageLike } from "./storage";

export class OAuthRequiredError extends Error {
  readonly code = "OAUTH_REQUIRED";

  constructor(provider: ModelAuthProvider, cause?: unknown) {
    super(`OAuth sign-in required for ${provider}`, cause === undefined ? undefined : { cause });
    this.name = "OAuthRequiredError";
  }
}


const OAUTH_MODELS = ["gpt-5.6-sol", "gpt-5.6-luna"] as const;

function assertModel(provider: ModelAuthProvider, modelId: string): void {
  if (!(OAUTH_MODELS as readonly string[]).includes(modelId)) {
    throw new Error(`Unsupported OAuth model ${provider}/${modelId}`);
  }
}

export async function resolveOAuthOnlyWithStorage(
  storage: AuthStorageLike,
  provider: ModelAuthProvider,
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
  provider: ModelAuthProvider,
  sessionId: string,
  modelId: string,
  signal?: AbortSignal,
  forceRefresh = false,
): Promise<string> {
  return resolveOAuthOnlyWithStorage(await getAuthStorage(), provider, sessionId, modelId, signal, forceRefresh);
}

export function createOAuthOnlyApiKeyResolver(
  provider: ModelAuthProvider,
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
