import {
  JobSourceError,
  cancelPublicHttpBody,
  canonicalizePublicHttpUrl,
  fetchPinnedPublicHttp,
  readBoundedPublicHttpBody,
} from "../../api/job-source";
import type {
  JobSourceFetch,
  ResolveHost,
} from "../../api/job-source";

export type ConnectorFetch = JobSourceFetch;
export type { ResolveHost, ResolvedAddress } from "../../api/job-source";

export type PublicHttpErrorCode =
  | "DESTINATION_BLOCKED"
  | "REQUEST_FAILED"
  | "REQUEST_TIMEOUT"
  | "TOO_MANY_REDIRECTS"
  | "RESPONSE_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "BUDGET_EXCEEDED";

const ERROR_MESSAGES: Readonly<Record<PublicHttpErrorCode, string>> = {
  DESTINATION_BLOCKED: "Discovery source must resolve to a public HTTP(S) address",
  REQUEST_FAILED: "Discovery source could not be loaded",
  REQUEST_TIMEOUT: "Discovery source request timed out",
  TOO_MANY_REDIRECTS: "Discovery source redirected too many times",
  RESPONSE_TOO_LARGE: "Discovery source response exceeded the size limit",
  UNSUPPORTED_MEDIA_TYPE: "Discovery source returned an unsupported response type",
  BUDGET_EXCEEDED: "Discovery synchronization exceeded its network budget",
};

export class PublicHttpError extends Error {
  readonly code: PublicHttpErrorCode;

  constructor(code: PublicHttpErrorCode, options?: ErrorOptions) {
    super(ERROR_MESSAGES[code], options);
    this.name = "PublicHttpError";
    this.code = code;
  }
}

export interface DiscoveryHttpBudgetOptions {
  readonly maxRequests: number;
  readonly maxBytes: number;
}

interface DiscoveryHttpReservation {
  readonly maxBodyBytes: number;
  settle(actualBytes: number): void;
  fail(): void;
}

export class DiscoveryHttpBudget {
  #remainingRequests: number;
  #remainingBytes: number;

  constructor(options: DiscoveryHttpBudgetOptions) {
    if (
      !Number.isSafeInteger(options.maxRequests)
      || options.maxRequests < 1
      || !Number.isSafeInteger(options.maxBytes)
      || options.maxBytes < 1
    ) {
      throw new Error("Invalid discovery HTTP budget");
    }
    this.#remainingRequests = options.maxRequests;
    this.#remainingBytes = options.maxBytes;
  }

  consumeRequestAttempt(): void {
    if (this.#remainingRequests < 1) throw new PublicHttpError("BUDGET_EXCEEDED");
    this.#remainingRequests -= 1;
  }

  reserveBody(maxBodyBytes: number): DiscoveryHttpReservation {
    if (this.#remainingBytes < 1) throw new PublicHttpError("BUDGET_EXCEEDED");
    const reservedBytes = Math.min(maxBodyBytes, this.#remainingBytes);
    this.#remainingBytes -= reservedBytes;
    let settled = false;
    const settle = (actualBytes?: number) => {
      if (settled) return;
      settled = true;
      const consumedBytes = actualBytes !== undefined
        && Number.isSafeInteger(actualBytes)
        && actualBytes >= 0
        ? Math.min(actualBytes, reservedBytes)
        : reservedBytes;
      this.#remainingBytes += reservedBytes - consumedBytes;
    };
    return {
      maxBodyBytes: reservedBytes,
      settle,
      fail: settle,
    };
  }
}

export interface SafeHttpClientOptions {
  readonly fetchImpl?: ConnectorFetch;
  readonly resolveHost?: ResolveHost;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxBodyBytes?: number;
  readonly budget?: DiscoveryHttpBudget;
}

export interface PublicHttpRequestOptions {
  readonly signal?: AbortSignal;
  readonly method?: "GET" | "POST";
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly acceptedMediaTypes?: readonly string[];
  readonly authorizationOrigin?: string;
  readonly allowedHosts?: readonly string[];
  readonly maxBodyBytes?: number;
  readonly maxRedirects?: number;
  readonly acceptedEmptyStatuses?: readonly number[];
}

export class PublicHttpResponse {
  readonly url: URL;
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;

  constructor(url: URL, status: number, headers: Headers, body: Uint8Array) {
    this.url = url;
    this.status = status;
    this.headers = headers;
    this.body = body;
  }

  text(): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(this.body);
    } catch {
      throw new PublicHttpError("REQUEST_FAILED");
    }
  }

  json<T = unknown>(): T {
    try {
      return JSON.parse(this.text()) as T;
    } catch (error) {
      if (error instanceof PublicHttpError) throw error;
      throw new PublicHttpError("REQUEST_FAILED");
    }
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const REDIRECT_STATUSES: Readonly<Record<number, true>> = {
  301: true,
  302: true,
  303: true,
  307: true,
  308: true,
};
const DEFAULT_MEDIA_TYPES = [
  "application/json",
  "application/ld+json",
  "application/vnd.api+json",
  "text/html",
  "application/xhtml+xml",
  "text/plain",
] as const;

function validatedLimit(value: number | undefined, fallback: number, minimum: 0 | 1): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new Error("Invalid safe public HTTP client options");
  }
  return resolved;
}

function cancellationReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function mappedPublicHttpError(error: unknown): PublicHttpError {
  if (error instanceof PublicHttpError) return error;
  if (error instanceof JobSourceError) {
    return new PublicHttpError(
      error.code === "JOB_URL_BLOCKED"
        ? "DESTINATION_BLOCKED"
        : error.code === "JOB_SOURCE_TOO_LARGE"
          ? "RESPONSE_TOO_LARGE"
          : "REQUEST_FAILED",
    );
  }
  return new PublicHttpError("REQUEST_FAILED");
}

function mediaTypeOf(response: Response): string {
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") throw new PublicHttpError("REQUEST_FAILED");
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export class SafePublicHttpClient {
  readonly #fetch: ConnectorFetch | undefined;
  readonly #resolveHost: ResolveHost | undefined;
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;
  readonly #maxBodyBytes: number;
  readonly #budget: DiscoveryHttpBudget | undefined;

  constructor(options: SafeHttpClientOptions = {}) {
    this.#fetch = options.fetchImpl;
    this.#resolveHost = options.resolveHost;
    this.#timeoutMs = validatedLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1);
    this.#maxRedirects = validatedLimit(options.maxRedirects, DEFAULT_MAX_REDIRECTS, 0);
    this.#maxBodyBytes = validatedLimit(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 1);
    this.#budget = options.budget;
  }

  withBudget(budget: DiscoveryHttpBudget): SafePublicHttpClient {
    return new SafePublicHttpClient({
      ...(this.#fetch === undefined ? {} : { fetchImpl: this.#fetch }),
      ...(this.#resolveHost === undefined ? {} : { resolveHost: this.#resolveHost }),
      timeoutMs: this.#timeoutMs,
      maxRedirects: this.#maxRedirects,
      maxBodyBytes: this.#maxBodyBytes,
      budget,
    });
  }

  get(input: string | URL, options: PublicHttpRequestOptions = {}): Promise<PublicHttpResponse> {
    return this.request(input, { ...options, method: "GET" });
  }

  post(input: string | URL, body: string, options: PublicHttpRequestOptions = {}): Promise<PublicHttpResponse> {
    return this.request(input, { ...options, method: "POST", body });
  }

  async request(input: string | URL, options: PublicHttpRequestOptions = {}): Promise<PublicHttpResponse> {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const timeoutReason = new PublicHttpError("REQUEST_TIMEOUT");
    const timer = setTimeout(() => controller.abort(timeoutReason), this.#timeoutMs);
    const onCallerAbort = () => controller.abort(cancellationReason(options.signal!));
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });
    try {
      return await this.#requestWithSignal(input, options, controller.signal);
    } catch (error) {
      if (options.signal?.aborted) throw cancellationReason(options.signal);
      if (error === timeoutReason) throw timeoutReason;
      throw mappedPublicHttpError(error);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  async #requestWithSignal(
    input: string | URL,
    options: PublicHttpRequestOptions,
    signal: AbortSignal,
  ): Promise<PublicHttpResponse> {
    let logicalUrl: URL;
    try {
      logicalUrl = canonicalizePublicHttpUrl(input);
    } catch (error) {
      throw mappedPublicHttpError(error);
    }
    const visited = new Set<string>();
    const allowedHosts = options.allowedHosts?.map((host) => host.trim().toLowerCase());
    const authorizationOrigin = options.authorizationOrigin?.trim().toLowerCase();
    const acceptedMediaTypes = new Set((options.acceptedMediaTypes ?? DEFAULT_MEDIA_TYPES).map((value) => value.toLowerCase()));
    const acceptedEmptyStatuses = new Set(options.acceptedEmptyStatuses ?? []);
    for (const status of acceptedEmptyStatuses) {
      if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
        throw new PublicHttpError("REQUEST_FAILED");
      }
    }
    const requestedMaxRedirects = options.maxRedirects ?? this.#maxRedirects;
    if (!Number.isSafeInteger(requestedMaxRedirects) || requestedMaxRedirects < 0) {
      throw new PublicHttpError("REQUEST_FAILED");
    }
    const maxRedirects = Math.min(this.#maxRedirects, requestedMaxRedirects);
    const maxBodyBytes = Math.min(this.#maxBodyBytes, Math.max(1, options.maxBodyBytes ?? this.#maxBodyBytes));
    const budget = this.#budget;
    let method = options.method ?? "GET";
    let requestBody = options.body;
    for (let hop = 0; ; hop += 1) {
      signal.throwIfAborted();
      const hostname = logicalUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
      if (
        logicalUrl.protocol !== "https:"
        || logicalUrl.port !== ""
        || (allowedHosts && !allowedHosts.includes(hostname))
      ) {
        throw new PublicHttpError("DESTINATION_BLOCKED");
      }
      const headers = new Headers(options.headers);
      if (method === "GET" && options.method === "POST") headers.delete("content-type");
      if (!headers.has("accept")) headers.set("accept", [...acceptedMediaTypes].join(", "));
      if (authorizationOrigin !== logicalUrl.origin.toLowerCase()) headers.delete("authorization");
      const request = {
        signal,
        method,
        headers: Object.fromEntries(headers.entries()),
        ...(requestBody === undefined ? {} : { body: requestBody }),
        ...(this.#fetch === undefined ? {} : { fetchImpl: this.#fetch }),
        ...(this.#resolveHost === undefined ? {} : { resolveHost: this.#resolveHost }),
        ...(budget === undefined ? {} : {
          beforeFetchAttempt: () => budget.consumeRequestAttempt(),
        }),
      } as const;
      const { response } = await fetchPinnedPublicHttp(logicalUrl, request);
      let reservation: DiscoveryHttpReservation | undefined;
      try {
        reservation = budget?.reserveBody(maxBodyBytes);
      } catch (error) {
        cancelPublicHttpBody(response);
        throw error;
      }
      const responseLimit = reservation?.maxBodyBytes ?? maxBodyBytes;
      if (REDIRECT_STATUSES[response.status]) {
        cancelPublicHttpBody(response);
        reservation?.settle(0);
        if (hop >= maxRedirects) throw new PublicHttpError("TOO_MANY_REDIRECTS");
        const location = response.headers.get("location");
        if (!location) throw new PublicHttpError("REQUEST_FAILED");
        let next: URL;
        try {
          next = canonicalizePublicHttpUrl(new URL(location, logicalUrl));
        } catch (error) {
          throw mappedPublicHttpError(error);
        }
        if (visited.has(next.href)) throw new PublicHttpError("TOO_MANY_REDIRECTS");
        visited.add(logicalUrl.href);
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = "GET";
          requestBody = undefined;
        }
        logicalUrl = next;
        continue;
      }
      if (response.status === 204 || response.status === 304) {
        cancelPublicHttpBody(response);
        reservation?.settle(0);
        return new PublicHttpResponse(logicalUrl, response.status, new Headers(response.headers), new Uint8Array());
      }
      let mediaType: string;
      try {
        mediaType = mediaTypeOf(response);
      } catch (error) {
        cancelPublicHttpBody(response);
        reservation?.settle(0);
        throw error;
      }
      const mediaTypeAccepted = acceptedMediaTypes.has(mediaType);
      if (!mediaTypeAccepted && !acceptedEmptyStatuses.has(response.status)) {
        cancelPublicHttpBody(response);
        reservation?.settle(0);
        throw new PublicHttpError("UNSUPPORTED_MEDIA_TYPE");
      }
      const declaredLength = response.headers.get("content-length");
      if (declaredLength && /^\d+$/.test(declaredLength.trim()) && Number(declaredLength) > responseLimit) {
        cancelPublicHttpBody(response);
        reservation?.settle(0);
        throw new PublicHttpError("RESPONSE_TOO_LARGE");
      }
      let body: Uint8Array;
      try {
        body = await readBoundedPublicHttpBody(response, signal, responseLimit);
        reservation?.settle(body.byteLength);
      } catch (error) {
        reservation?.fail();
        throw mappedPublicHttpError(error);
      }
      if (body.byteLength === 0 && acceptedEmptyStatuses.has(response.status)) {
        return new PublicHttpResponse(logicalUrl, response.status, new Headers(response.headers), body);
      }
      if (!mediaTypeAccepted) throw new PublicHttpError("UNSUPPORTED_MEDIA_TYPE");
      return new PublicHttpResponse(logicalUrl, response.status, new Headers(response.headers), body);
    }
  }
}
