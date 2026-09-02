import { z } from "zod";

const GMAIL_API_ORIGIN = "https://gmail.googleapis.com";
const MAX_GMAIL_JSON_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 100;
export const MAX_GMAIL_SEARCH_OUTPUT_BYTES = 50 * 1_024;
const EMPTY_SEARCH_RESULT_BYTES = Buffer.byteLength('{"emails":[],"truncated":false}', "utf8");
const MAX_HEADER_CODE_POINTS = 1_000;
const MAX_PREVIEW_WORDS = 30;

const GmailMessageIdSchema = z.string().min(1).max(512);
const GmailMessageListSchema = z.object({
  messages: z.array(z.object({ id: GmailMessageIdSchema }).passthrough()).max(MAX_SEARCH_RESULTS).optional(),
  nextPageToken: z.string().min(1).optional(),
}).passthrough();
const GmailMessageMetadataSchema = z.object({
  id: GmailMessageIdSchema,
  internalDate: z.string().regex(/^\d+$/).optional(),
  snippet: z.string().optional(),
  payload: z.object({
    headers: z.array(z.object({
      name: z.string(),
      value: z.string(),
    }).passthrough()).optional(),
  }).passthrough().optional(),
}).passthrough();
const GmailFullMessageSchema = z.object({
  id: GmailMessageIdSchema,
  threadId: z.string().min(1).max(512).optional(),
  labelIds: z.array(z.string().max(512)).optional(),
  snippet: z.string().optional(),
  historyId: z.string().regex(/^\d+$/).optional(),
  internalDate: z.string().regex(/^\d+$/).optional(),
  payload: z.object({}).passthrough(),
  sizeEstimate: z.number().int().nonnegative().optional(),
}).passthrough();
export type GmailParsedMessage = z.infer<typeof GmailFullMessageSchema>;

export const GmailReadEmailInputSchema = z.object({ id: GmailMessageIdSchema }).strict();

export const GmailSearchInputSchema = z.object({
  word_query: z.string().trim().min(1).max(500).optional(),
  received_within_minutes: z.number().int().min(1).max(1_440).optional(),
  received_outside_last_minutes: z.number().int().min(1).max(2_147_483_647).optional(),
}).strict();
export type GmailSearchInput = z.infer<typeof GmailSearchInputSchema>;

export interface GmailEmailSummary {
  readonly id: string;
  readonly subject: string;
  readonly sender: string;
  readonly preview: string;
}

export interface GmailSearchResult {
  readonly emails: readonly GmailEmailSummary[];
  readonly truncated: boolean;
}

export type GmailFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GmailToolClient {
  searchInbox(input: GmailSearchInput, signal?: AbortSignal): Promise<GmailSearchResult>;
  readEmail(id: string, signal?: AbortSignal): Promise<GmailParsedMessage>;
}

export interface GmailClientDependencies {
  readonly accessToken: (signal?: AbortSignal) => Promise<string>;
  readonly fetch?: GmailFetch;
  readonly now?: () => number;
  readonly apiOrigin?: string;
}

export class GmailClientError extends Error {
  constructor(readonly code: "NOT_CONNECTED" | "PROVIDER_FAILED" | "RESPONSE_TOO_LARGE") {
    super(
      code === "NOT_CONNECTED"
        ? "Connect Gmail in Provider access"
        : code === "RESPONSE_TOO_LARGE"
          ? "The Gmail response is too large"
          : "Gmail could not complete the request",
    );
    this.name = "GmailClientError";
  }
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cancellation for a locked or already consumed body.
  }
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null
    && /^\d+$/.test(declaredLength.trim())
    && Number(declaredLength) > maximumBytes
  ) {
    await cancelResponse(response);
    throw new GmailClientError("RESPONSE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GmailClientError("PROVIDER_FAILED");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytesRead += item.value.byteLength;
      if (bytesRead > maximumBytes) throw new GmailClientError("RESPONSE_TOO_LARGE");
      chunks.push(decoder.decode(item.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(""));
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof GmailClientError) throw error;
    throw new GmailClientError("PROVIDER_FAILED");
  }
}

function boundedCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function preview(value: string): string {
  const words = value.trim().split(/\s+/u).filter(Boolean);
  return words.slice(0, MAX_PREVIEW_WORDS).join(" ");
}

function headerValue(
  headers: readonly { readonly name: string; readonly value: string }[] | undefined,
  name: string,
): string {
  const value = headers?.find((header) => header.name.toLowerCase() === name)?.value ?? "";
  return boundedCodePoints(value, MAX_HEADER_CODE_POINTS);
}

export class GmailClient {
  readonly #accessToken: GmailClientDependencies["accessToken"];
  readonly #fetch: GmailFetch;
  readonly #apiOrigin: string;
  readonly #now: () => number;

  constructor(dependencies: GmailClientDependencies) {
    this.#accessToken = dependencies.accessToken;
    this.#fetch = dependencies.fetch ?? fetch;
    this.#apiOrigin = dependencies.apiOrigin ?? GMAIL_API_ORIGIN;
    this.#now = dependencies.now ?? Date.now;
  }

  async #getJson(url: URL, signal?: AbortSignal): Promise<unknown> {
    let accessToken: string;
    try {
      accessToken = await this.#accessToken(signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (error instanceof GmailClientError) throw error;
      throw new GmailClientError("NOT_CONNECTED");
    }
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { authorization: `Bearer ${accessToken}` },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      signal?.throwIfAborted();
      throw new GmailClientError("PROVIDER_FAILED");
    }
    if (!response.ok) {
      await cancelResponse(response);
      throw new GmailClientError(response.status === 401 ? "NOT_CONNECTED" : "PROVIDER_FAILED");
    }
    return readBoundedJson(response, MAX_GMAIL_JSON_BYTES);
  }

  async searchInbox(input: GmailSearchInput, signal?: AbortSignal): Promise<GmailSearchResult> {
    const parsedInput = GmailSearchInputSchema.parse(input);
    const now = this.#now();
    const lowerBound = parsedInput.received_within_minutes === undefined
      ? undefined
      : now - parsedInput.received_within_minutes * 60_000;
    const upperBound = parsedInput.received_outside_last_minutes === undefined
      ? parsedInput.received_within_minutes === undefined ? undefined : now
      : now - parsedInput.received_outside_last_minutes * 60_000;
    const query: string[] = [];
    if (parsedInput.word_query) query.push(parsedInput.word_query);
    if (lowerBound !== undefined) query.push(`after:${Math.floor(lowerBound / 1_000) - 1}`);
    if (upperBound !== undefined) query.push(`before:${Math.floor(upperBound / 1_000) + 1}`);

    const listUrl = new URL("/gmail/v1/users/me/messages", this.#apiOrigin);
    listUrl.searchParams.set("labelIds", "INBOX");
    listUrl.searchParams.set("maxResults", String(MAX_SEARCH_RESULTS));
    if (query.length > 0) listUrl.searchParams.set("q", query.join(" "));
    const listed = GmailMessageListSchema.parse(await this.#getJson(listUrl, signal));
    const emails: GmailEmailSummary[] = [];
    let serializedBytes = EMPTY_SEARCH_RESULT_BYTES;
    for (const listedMessage of listed.messages ?? []) {
      signal?.throwIfAborted();
      const messageUrl = new URL(
        `/gmail/v1/users/me/messages/${encodeURIComponent(listedMessage.id)}`,
        this.#apiOrigin,
      );
      messageUrl.searchParams.set("format", "metadata");
      messageUrl.searchParams.append("metadataHeaders", "Subject");
      messageUrl.searchParams.append("metadataHeaders", "From");
      const message = GmailMessageMetadataSchema.parse(await this.#getJson(messageUrl, signal));
      if (lowerBound !== undefined || upperBound !== undefined) {
        const internalDate = Number(message.internalDate);
        if (
          !Number.isFinite(internalDate)
          || (lowerBound !== undefined && internalDate < lowerBound)
          || (upperBound !== undefined && internalDate > upperBound)
        ) continue;
      }
      const summary: GmailEmailSummary = {
        id: message.id,
        subject: headerValue(message.payload?.headers, "subject"),
        sender: headerValue(message.payload?.headers, "from"),
        preview: preview(message.snippet ?? ""),
      };
      const summaryBytes = Buffer.byteLength(JSON.stringify(summary), "utf8") + (emails.length === 0 ? 0 : 1);
      if (serializedBytes + summaryBytes > MAX_GMAIL_SEARCH_OUTPUT_BYTES) {
        return { emails, truncated: true };
      }
      serializedBytes += summaryBytes;
      emails.push(summary);
    }
    return { emails, truncated: listed.nextPageToken !== undefined };
  }

  async readEmail(id: string, signal?: AbortSignal): Promise<GmailParsedMessage> {
    const parsedInput = GmailReadEmailInputSchema.parse({ id });
    const messageUrl = new URL(
      `/gmail/v1/users/me/messages/${encodeURIComponent(parsedInput.id)}`,
      this.#apiOrigin,
    );
    messageUrl.searchParams.set("format", "full");
    return GmailFullMessageSchema.parse(await this.#getJson(messageUrl, signal));
  }
}
