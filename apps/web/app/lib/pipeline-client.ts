import { z } from "zod";
import {
  ApiErrorSchema,
  ApproveRunRequestSchema,
  ArtifactDtoSchema,
  CreateRunRequestSchema,
  EditRunRequestSchema,
  RegenerateRunRequestSchema,
  RunDtoSchema,
  RunListResponseSchema,
  type ArtifactDto,
  type RunDto,
} from "@jobhunter/pipeline/contracts";

const PIPELINE_ROOT = "/api/pipeline";
const MAX_PUBLIC_MESSAGE_LENGTH = 240;
const MAX_JSON_ARTIFACT_BYTES = 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const ARTIFACT_PATH = /^\/v1\/runs\/[^/?#]+\/artifacts\/[^/?#]+$/;
const PUBLIC_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const JsonValueSchema = z.json();

export class PipelineClientError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = "PipelineClientError";
    this.code = code;
    this.status = status;
  }
}

function publicMessage(message: string): string {
  if (/[\r\n{}\[\]]/.test(message)) return "The pipeline request failed.";
  const redacted = message
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(?:access|refresh|id)[_-]?token\b\s*[:=]\s*[^\s,;]+/gi, "credential=[redacted]")
    .replace(/\bauthorization\b\s*[:=]\s*(?:Bearer|Basic)\s+[^\s,;]+/gi, "authorization=[redacted]")
    .replace(/\b(?:api[_-]?key|authorization|password|secret)\b\s*[:=]\s*[^\s,;]+/gi, "credential=[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted claim]")
    .replace(/([?&](?:access_token|refresh_token|id_token|code)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s"'<>:,;]+[\\/])+[^\s"'<>:,;]*/g, "[redacted path]")
    .trim()
    .slice(0, MAX_PUBLIC_MESSAGE_LENGTH);
  return redacted || "The pipeline request failed.";
}

function invalidResponse(): PipelineClientError {
  return new PipelineClientError(
    "The pipeline returned an invalid response.",
    "INVALID_RESPONSE",
  );
}

async function parseErrorResponse(response: Response): Promise<PipelineClientError> {
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedText(response, MAX_ERROR_BODY_BYTES));
  } catch {
    return new PipelineClientError(
      "The pipeline request failed.",
      "REQUEST_FAILED",
      response.status,
    );
  }

  const parsed = ApiErrorSchema.safeParse(body);
  if (!parsed.success) {
    return new PipelineClientError(
      "The pipeline request failed.",
      "REQUEST_FAILED",
      response.status,
    );
  }

  const code = PUBLIC_ERROR_CODE.test(parsed.data.error.code)
    ? parsed.data.error.code
    : "REQUEST_FAILED";
  const message = response.status >= 500
    ? "The pipeline request failed."
    : publicMessage(parsed.data.error.message);
  return new PipelineClientError(message, code, response.status);
}

async function fetchPipeline(path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${PIPELINE_ROOT}${path}`, {
      ...init,
      cache: "no-store",
    });
  } catch {
    throw new PipelineClientError(
      "The pipeline service could not be reached.",
      "NETWORK_ERROR",
    );
  }

  if (!response.ok) throw await parseErrorResponse(response);
  return response;
}

async function requestRun(path: string, init: RequestInit): Promise<RunDto> {
  const response = await fetchPipeline(path, init);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw invalidResponse();
  }

  const parsed = RunDtoSchema.safeParse(body);
  if (!parsed.success) throw invalidResponse();
  return parsed.data;
}

function jsonPost(body: unknown): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  };
}

function runPath(id: string): string {
  return `/runs/${encodeURIComponent(id)}`;
}
function ensureValidRequest(valid: boolean): void {
  if (!valid) {
    throw new PipelineClientError("The request is invalid.", "INVALID_REQUEST");
  }
}

export async function listRuns(): Promise<RunDto[]> {
  const response = await fetchPipeline("/runs", { method: "GET" });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw invalidResponse();
  }

  const parsed = RunListResponseSchema.safeParse(body);
  if (!parsed.success) throw invalidResponse();
  return parsed.data.runs;
}

export function getRun(id: string): Promise<RunDto> {
  return requestRun(runPath(id), { method: "GET" });
}

export function createRun(jobDescription: string): Promise<RunDto> {
  const body = { jobDescription };
  ensureValidRequest(CreateRunRequestSchema.safeParse(body).success);
  return requestRun("/runs", jsonPost(body));
}

export function retryRun(id: string): Promise<RunDto> {
  return requestRun(`${runPath(id)}/retry`, jsonPost({}));
}

export function regenerateRun(id: string, expectedPdfSha256: string): Promise<RunDto> {
  const body = { expectedPdfSha256 };
  ensureValidRequest(RegenerateRunRequestSchema.safeParse(body).success);
  return requestRun(`${runPath(id)}/regenerate`, jsonPost(body));
}

export function editRun(
  id: string,
  comments: string,
  expectedPdfSha256: string,
): Promise<RunDto> {
  const body = { comments, expectedPdfSha256 };
  ensureValidRequest(EditRunRequestSchema.safeParse(body).success);
  return requestRun(`${runPath(id)}/edit`, jsonPost(body));
}

export function approveRun(
  id: string,
  expectedPdfSha256: string,
  acknowledgeVisualIssues: boolean,
): Promise<RunDto> {
  const body = { expectedPdfSha256, acknowledgeVisualIssues };
  ensureValidRequest(
    typeof acknowledgeVisualIssues === "boolean"
      && ApproveRunRequestSchema.safeParse(body).success,
  );
  return requestRun(`${runPath(id)}/approve`, jsonPost(body));
}

export function artifactHref(href: string): string {
  if (!href.startsWith("/") || href.startsWith("//") || !ARTIFACT_PATH.test(href)) {
    throw new PipelineClientError("The artifact link is invalid.", "INVALID_ARTIFACT_HREF");
  }

  let url: URL;
  try {
    url = new URL(href, "https://pipeline.invalid");
  } catch {
    throw new PipelineClientError("The artifact link is invalid.", "INVALID_ARTIFACT_HREF");
  }

  if (
    url.origin !== "https://pipeline.invalid"
    || url.pathname !== href
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new PipelineClientError("The artifact link is invalid.", "INVALID_ARTIFACT_HREF");
  }
  return `${PIPELINE_ROOT}${href.slice("/v1".length)}`;
}

function isJsonMediaType(mediaType: string): boolean {
  const essence = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  return essence === "application/json" || Boolean(essence?.startsWith("application/") && essence.endsWith("+json"));
}

class BoundedBodyError extends Error {
  readonly reason: "too-large" | "unreadable";

  constructor(reason: "too-large" | "unreadable") {
    super(reason);
    this.reason = reason;
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new BoundedBodyError("too-large");
    }
  }

  if (!response.body) {
    throw new BoundedBodyError("unreadable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new BoundedBodyError("too-large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof BoundedBodyError) throw error;
    throw new BoundedBodyError("unreadable");
  } finally {
    reader.releaseLock();
  }
}

export async function readJsonArtifact(artifact: ArtifactDto): Promise<z.infer<typeof JsonValueSchema>> {
  const parsedArtifact = ArtifactDtoSchema.safeParse(artifact);
  if (!parsedArtifact.success) {
    throw new PipelineClientError("The artifact metadata is invalid.", "INVALID_ARTIFACT");
  }
  if (!isJsonMediaType(parsedArtifact.data.mediaType)) {
    throw new PipelineClientError("The artifact is not JSON.", "INVALID_ARTIFACT_MEDIA_TYPE");
  }

  const href = artifactHref(parsedArtifact.data.href);
  const response = await fetchPipeline(href.slice(PIPELINE_ROOT.length), { method: "GET" });
  const responseMediaType = response.headers.get("content-type") ?? "";
  if (!isJsonMediaType(responseMediaType)) {
    throw new PipelineClientError("The artifact response is not JSON.", "INVALID_ARTIFACT_RESPONSE");
  }

  let text: string;
  try {
    text = await readBoundedText(response, MAX_JSON_ARTIFACT_BYTES);
  } catch (error) {
    if (error instanceof BoundedBodyError && error.reason === "too-large") {
      throw new PipelineClientError("The artifact is too large to read.", "ARTIFACT_TOO_LARGE");
    }
    throw new PipelineClientError("The artifact could not be read.", "ARTIFACT_UNREADABLE");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PipelineClientError("The artifact contains invalid JSON.", "INVALID_ARTIFACT_JSON");
  }

  const parsed = JsonValueSchema.safeParse(value);
  if (!parsed.success) {
    throw new PipelineClientError("The artifact contains invalid JSON.", "INVALID_ARTIFACT_JSON");
  }
  return parsed.data;
}
