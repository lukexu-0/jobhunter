import { apiResponse } from "./handler.ts";

const MAX_STATUS_ITEMS = 20;
const MAX_STATUS_TEXT = 256;

export interface ContextStatus {
  readonly fresh: boolean;
  readonly manifestMatches: boolean;
  readonly staleSources: readonly string[];
  readonly missingSources: readonly string[];
  readonly manifestSha256?: string;
  readonly indexedAt?: number;
  readonly sourceCount?: number;
  readonly blockCount?: number;
  readonly changedSources?: readonly string[];
}

export interface ContextRouteService {
  getContext(): ContextStatus | Promise<ContextStatus>;
  syncContext(): ContextStatus | Promise<ContextStatus>;
}

function boundedStrings(values: readonly string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return values.slice(0, MAX_STATUS_ITEMS).map((value) => value.slice(0, MAX_STATUS_TEXT));
}

function boundedStatus(status: ContextStatus): ContextStatus {
  const staleSources = boundedStrings(status.staleSources) ?? [];
  const missingSources = boundedStrings(status.missingSources) ?? [];
  const changedSources = boundedStrings(status.changedSources);
  return {
    fresh: status.fresh,
    manifestMatches: status.manifestMatches,
    staleSources,
    missingSources,
    ...(status.manifestSha256 ? { manifestSha256: status.manifestSha256.slice(0, 64) } : {}),
    ...(typeof status.indexedAt === "number" && Number.isSafeInteger(status.indexedAt) ? { indexedAt: status.indexedAt } : {}),
    ...(typeof status.sourceCount === "number" && Number.isSafeInteger(status.sourceCount) ? { sourceCount: status.sourceCount } : {}),
    ...(typeof status.blockCount === "number" && Number.isSafeInteger(status.blockCount) ? { blockCount: status.blockCount } : {}),
    ...(changedSources ? { changedSources } : {}),
  };
}

async function parseEmptyBody(request: Request): Promise<boolean> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 0;
  } catch {
    return false;
  }
}

export function createContextRoutes(service: ContextRouteService) {
  return async function routeContext(request: Request, url: URL): Promise<Response | null> {
    if (request.method === "GET" && url.pathname === "/v1/context") {
      try {
        return apiResponse.json(boundedStatus(await service.getContext()));
      } catch {
        return apiResponse.error("CONTEXT_STATUS_FAILED", "Context status could not be loaded", 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/context/sync") {
      if (!(await parseEmptyBody(request))) return apiResponse.error("INVALID_REQUEST", "Context sync request must be an empty object", 400);
      try {
        return apiResponse.json(boundedStatus(await service.syncContext()));
      } catch {
        return apiResponse.error("CONTEXT_SYNC_FAILED", "Context synchronization failed", 500);
      }
    }
    return null;
  };
}
