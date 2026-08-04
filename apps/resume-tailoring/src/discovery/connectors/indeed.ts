import type {
  DiscoveredJobInput,
  DiscoveryConnector,
  DiscoverySyncResult,
} from "../types";
import { SafePublicHttpClient } from "./http";
import type {
  DiscoveryHttpBudget,
  PublicHttpResponse,
} from "./http";
import {
  canonicalizeJobUrl,
  nonemptyString,
  normalizeSpace,
  parsePostedAt,
  sanitizeDescription,
  stringAt,
} from "./normalize";

export const INDEED_MCP_ENDPOINT = "https://mcp.indeed.com/claude/mcp";
const INDEED_MCP_HOST = "mcp.indeed.com";
const INDEED_MCP_ORIGIN = "https://mcp.indeed.com";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const JSON_RPC_VERSION = "2.0";
const JSON_MEDIA_TYPE = "application/json";
const SSE_MEDIA_TYPE = "text/event-stream";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_ARRAY_LENGTH = 1_000;
const MAX_JSON_OBJECT_KEYS = 100;
const MAX_JSON_STRING_LENGTH = 100_000;
const MAX_SSE_EVENTS = 100;
const MAX_TOOL_PAGES = 10;
const MAX_TOOLS = 100;
const MAX_TOOL_CALLS = 120;
const MAX_SEARCH_JOBS = 500;
const MAX_CONTENT_PARTS = 20;
const MAX_CURSOR_LENGTH = 500;
const DEFAULT_MAX_JOBS = 100;
const MAX_JOBS = 100;
const CONNECTOR_ERROR_MESSAGE = "The Indeed job source is unavailable";
const SIGN_IN_ERROR_MESSAGE = "Indeed sign-in is required";
const AUTHORIZATION_ERROR_MESSAGE = "Indeed MCP rejected the current authorization";
const UNSUPPORTED_CLIENT_ERROR_MESSAGE = "Indeed MCP did not accept this standards-based client";
const CONFIG_ERROR_MESSAGE = "Invalid Indeed connector configuration";
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UNSUPPORTED_CLIENT_STATUSES: Readonly<Record<number, true>> = {
  404: true,
  405: true,
  406: true,
  415: true,
};
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BEARER_TOKEN = /^[\x21-\x7e]{1,8192}$/;

type JsonRecord = Readonly<Record<string, unknown>>;

export interface IndeedSearchConfig {
  readonly query: string;
  readonly location?: string | undefined;
}

export interface IndeedConnectorConfig {
  readonly id: string;
  readonly name?: string | undefined;
  readonly searches: readonly IndeedSearchConfig[];
  readonly maxJobs?: number | undefined;
}
interface ValidatedIndeedConfig {
  readonly id: string;
  readonly name: string;
  readonly searches: readonly IndeedSearchConfig[];
  readonly maxJobs: number;
}


export type IndeedAccessTokenResolver = (signal: AbortSignal) => Promise<string | undefined>;

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly properties: JsonRecord;
  readonly required: readonly string[];
}

interface SearchToolMapping {
  readonly tool: McpTool;
  readonly queryField: string;
  readonly locationField?: string | undefined;
  readonly limitField?: string | undefined;
}

interface DetailToolMapping {
  readonly tool: McpTool;
  readonly idField?: string | undefined;
  readonly requisitionField?: string | undefined;
  readonly urlField?: string | undefined;
}

interface ToolSelection<T> {
  readonly mapping?: T | undefined;
  readonly provenance?: string | undefined;
}

interface JobCandidate {
  readonly sourceItemId: string;
  readonly sourceUrl: string;
  readonly title?: string | undefined;
  readonly company?: string | undefined;
  readonly location?: string | undefined;
  readonly description?: string | undefined;
  readonly applyUrl?: string | undefined;
  readonly postedAt?: unknown;
  readonly requisitionId?: string | undefined;
}

class IndeedConnectorError extends Error {
  constructor(message = CONNECTOR_ERROR_MESSAGE) {
    super(message);
    this.name = "IndeedConnectorError";
  }
}

function protocolError(): never {
  throw new IndeedConnectorError();
}

function configError(): never {
  throw new Error(CONFIG_ERROR_MESSAGE);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertBoundedJson(root: unknown): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || entry.depth > MAX_JSON_DEPTH) protocolError();
    const value = entry.value;
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) protocolError();
      continue;
    }
    if (typeof value === "string") {
      if (value.length > MAX_JSON_STRING_LENGTH) protocolError();
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_JSON_ARRAY_LENGTH) protocolError();
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: value[index], depth: entry.depth + 1 });
      }
      continue;
    }
    const record = asRecord(value);
    if (!record) protocolError();
    const entries = Object.entries(record);
    if (entries.length > MAX_JSON_OBJECT_KEYS) protocolError();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!;
      if (key.length > 200) protocolError();
      pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
}

function parseBoundedJson(text: string): unknown {
  if (text.length === 0 || text.length > MAX_BODY_BYTES) protocolError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    protocolError();
  }
  assertBoundedJson(parsed);
  return parsed;
}

function parseSse(text: string): readonly unknown[] {
  if (text.length === 0 || text.length > MAX_BODY_BYTES) protocolError();
  const normalized = text.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) protocolError();
  const messages: unknown[] = [];
  let eventName = "";
  let data: string[] = [];
  const append = (message: unknown): void => {
    const record = asRecord(message);
    if (!record || record.jsonrpc !== JSON_RPC_VERSION) protocolError();
    messages.push(message);
    if (messages.length > MAX_SSE_EVENTS) protocolError();
  };
  const flush = (): void => {
    if (data.length === 0) {
      eventName = "";
      return;
    }
    if (eventName !== "" && eventName !== "message") protocolError();
    const parsed = parseBoundedJson(data.join("\n"));
    if (Array.isArray(parsed)) {
      if (parsed.length === 0 || parsed.length > MAX_SSE_EVENTS) protocolError();
      for (const message of parsed) append(message);
    } else {
      append(parsed);
    }
    eventName = "";
    data = [];
  };
  for (const line of [...normalized.split("\n"), ""]) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        data.push(value);
        break;
      case "event":
        if (eventName !== "") protocolError();
        eventName = value;
        break;
      case "id":
        if (value.includes("\0") || value.length > MAX_CURSOR_LENGTH) protocolError();
        break;
      case "retry":
        if (!/^\d{1,10}$/.test(value)) protocolError();
        break;
      default:
        protocolError();
    }
  }
  return messages;
}

function rpcResult(message: unknown, expectedId: number): unknown {
  const record = asRecord(message);
  if (!record || record.jsonrpc !== JSON_RPC_VERSION || record.id !== expectedId) protocolError();
  if (hasOwn(record, "error")) protocolError();
  if (!hasOwn(record, "result")) protocolError();
  return record.result;
}

function responseResult(response: PublicHttpResponse, expectedId: number): unknown {
  if (response.status === 401 || response.status === 403) {
    throw new IndeedConnectorError(AUTHORIZATION_ERROR_MESSAGE);
  }
  if (Object.prototype.hasOwnProperty.call(UNSUPPORTED_CLIENT_STATUSES, response.status)) {
    throw new IndeedConnectorError(UNSUPPORTED_CLIENT_ERROR_MESSAGE);
  }
  if (response.status < 200 || response.status >= 300 || response.body.byteLength === 0) protocolError();
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === JSON_MEDIA_TYPE) return rpcResult(parseBoundedJson(response.text()), expectedId);
  if (mediaType !== SSE_MEDIA_TYPE) protocolError();
  const matches: unknown[] = [];
  for (const message of parseSse(response.text())) {
    const record = asRecord(message);
    if (!record || record.jsonrpc !== JSON_RPC_VERSION) protocolError();
    if (record.id === expectedId) matches.push(message);
  }
  if (matches.length !== 1) protocolError();
  return rpcResult(matches[0], expectedId);
}

function sessionIdOf(response: PublicHttpResponse): string | undefined {
  const value = response.headers.get("mcp-session-id")?.trim();
  if (value === undefined || value === "") return undefined;
  if (!/^[\x21-\x7e]{1,1024}$/.test(value)) protocolError();
  return value;
}

class StreamableHttpMcpSession {
  readonly #client: SafePublicHttpClient;
  readonly #accessToken: string;
  #sessionId: string | undefined;
  #nextId = 1;
  #toolCalls = 0;
  #sessionRecoveryUsed = false;

  constructor(client: SafePublicHttpClient, accessToken: string) {
    this.#client = client;
    this.#accessToken = accessToken;
  }

  async initialize(signal: AbortSignal): Promise<void> {
    const id = this.#nextId;
    this.#nextId += 1;
    const response = await this.#post({
      jsonrpc: JSON_RPC_VERSION,
      id,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "Jobhunter", version: "1" },
      },
    }, signal, false, false);
    signal.throwIfAborted();
    const result = asRecord(responseResult(response, id));
    if (
      !result
      || result.protocolVersion !== MCP_PROTOCOL_VERSION
      || !asRecord(result.capabilities)
      || !asRecord(result.serverInfo)
    ) protocolError();
    this.#sessionId = sessionIdOf(response);
    const initialized = await this.#post({
      jsonrpc: JSON_RPC_VERSION,
      method: "notifications/initialized",
    }, signal, true, true);
    signal.throwIfAborted();
    if (initialized.status !== 202 || initialized.body.byteLength !== 0) protocolError();
  }

  async listTools(signal: AbortSignal): Promise<readonly McpTool[]> {
    const tools: McpTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      signal.throwIfAborted();
      const payload = await this.#request("tools/list", cursor === undefined ? {} : { cursor }, signal, true);
      signal.throwIfAborted();
      const result = asRecord(payload);
      if (!result || !Array.isArray(result.tools) || result.tools.length > MAX_TOOLS) protocolError();
      for (const value of result.tools) {
        signal.throwIfAborted();
        const tool = parseTool(value);
        if (names.has(tool.name) || tools.length >= MAX_TOOLS) protocolError();
        names.add(tool.name);
        tools.push(tool);
      }
      if (result.nextCursor === undefined || result.nextCursor === null) return tools;
      if (
        typeof result.nextCursor !== "string"
        || result.nextCursor.length < 1
        || result.nextCursor.length > MAX_CURSOR_LENGTH
        || cursors.has(result.nextCursor)
      ) protocolError();
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    protocolError();
  }

  async callReadOnlyTool(
    mapping: SearchToolMapping | DetailToolMapping,
    args: JsonRecord,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.#toolCalls += 1;
    if (this.#toolCalls > MAX_TOOL_CALLS) protocolError();
    const payload = await this.#request(
      "tools/call",
      { name: mapping.tool.name, arguments: args },
      signal,
      true,
    );
    signal.throwIfAborted();
    const result = asRecord(payload);
    if (
      !result
      || (result.isError !== undefined && typeof result.isError !== "boolean")
      || result.isError === true
    ) protocolError();
    if (hasOwn(result, "structuredContent")) {
      assertBoundedJson(result.structuredContent);
      return result.structuredContent;
    }
    if (!Array.isArray(result.content) || result.content.length > MAX_CONTENT_PARTS) protocolError();
    const jsonTexts: string[] = [];
    for (const part of result.content) {
      signal.throwIfAborted();
      const record = asRecord(part);
      if (record?.type === "text" && typeof record.text === "string") jsonTexts.push(record.text);
    }
    if (jsonTexts.length !== 1) protocolError();
    return parseBoundedJson(jsonTexts[0]!);
  }

  async #request(
    method: string,
    params: JsonRecord,
    signal: AbortSignal,
    allowSessionRecovery: boolean,
  ): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    const message = {
      jsonrpc: JSON_RPC_VERSION,
      id,
      method,
      params,
    };
    let response = await this.#post(message, signal, true, false);
    signal.throwIfAborted();
    if (
      response.status === 404
      && allowSessionRecovery
      && this.#sessionId !== undefined
      && !this.#sessionRecoveryUsed
    ) {
      this.#sessionRecoveryUsed = true;
      this.#sessionId = undefined;
      await this.initialize(signal);
      signal.throwIfAborted();
      response = await this.#post(message, signal, true, false);
      signal.throwIfAborted();
    }
    return responseResult(response, id);
  }

  #post(
    message: JsonRecord,
    signal: AbortSignal,
    postInitialize: boolean,
    acceptEmpty202: boolean,
  ): Promise<PublicHttpResponse> {
    const headers: Record<string, string> = {
      accept: `${JSON_MEDIA_TYPE}, ${SSE_MEDIA_TYPE}`,
      authorization: `Bearer ${this.#accessToken}`,
      "content-type": JSON_MEDIA_TYPE,
    };
    if (postInitialize) {
      headers["mcp-protocol-version"] = MCP_PROTOCOL_VERSION;
      if (this.#sessionId !== undefined) headers["mcp-session-id"] = this.#sessionId;
    }
    return this.#client.post(INDEED_MCP_ENDPOINT, JSON.stringify(message), {
      signal,
      headers,
      acceptedMediaTypes: [JSON_MEDIA_TYPE, SSE_MEDIA_TYPE],
      maxRedirects: 0,
      acceptedEmptyStatuses: acceptEmpty202 ? [202, 404] : [404],
      authorizationOrigin: INDEED_MCP_ORIGIN,
      allowedHosts: [INDEED_MCP_HOST],
      maxBodyBytes: MAX_BODY_BYTES,
    });
  }
}

function parseTool(value: unknown): McpTool {
  const record = asRecord(value);
  const description = record && typeof record.description === "string" ? normalizeSpace(record.description) : "";
  const schema = asRecord(record?.inputSchema);
  const properties = schema?.properties === undefined ? {} : asRecord(schema.properties);
  if (
    !record
    || typeof record.name !== "string"
    || (record.description !== undefined && typeof record.description !== "string")
    || !TOOL_NAME.test(record.name)
    || (typeof record.description === "string" && record.description.length > 2_000)
    || !schema
    || schema.type !== "object"
    || !properties
    || Object.keys(properties).length > 50
  ) protocolError();
  for (const [key, property] of Object.entries(properties)) {
    if (key.length < 1 || key.length > 100 || !asRecord(property)) protocolError();
  }
  const requiredValue = schema.required ?? [];
  if (!Array.isArray(requiredValue) || requiredValue.length > 50) protocolError();
  const required: string[] = [];
  const seen = new Set<string>();
  for (const field of requiredValue) {
    if (
      typeof field !== "string"
      || field.length < 1
      || field.length > 100
      || !hasOwn(properties, field)
      || seen.has(field)
    ) protocolError();
    seen.add(field);
    required.push(field);
  }
  return { name: record.name, description, properties, required };
}

function normalizedFieldName(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

const QUERY_FIELDS = new Set([
  "q",
  "query",
  "keyword",
  "keywords",
  "searchquery",
  "searchtext",
  "what",
]);
const LOCATION_FIELDS = new Set(["location", "where"]);
const LIMIT_FIELDS = new Set([
  "count",
  "limit",
  "maxresults",
  "pagesize",
  "maxjobs",
  "numberofresults",
  "resultlimit",
  "resultslimit",
]);
const ID_FIELDS = new Set([
  "id",
  "jobid",
  "jobkey",
  "sourceitemid",
]);
const REQUISITION_FIELDS = new Set([
  "requisitionid",
  "requisitionnumber",
  "reqid",
  "reqnumber",
]);
const URL_FIELDS = new Set([
  "joblink",
  "joburl",
  "link",
  "postingurl",
  "url",
]);
const UNSUPPORTED_SCHEMA_CONSTRAINTS = new Set([
  "$ref",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "dependentRequired",
  "dependentSchemas",
  "else",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "if",
  "items",
  "maxContains",
  "maxItems",
  "maxProperties",
  "minContains",
  "minItems",
  "minProperties",
  "multipleOf",
  "not",
  "nullable",
  "oneOf",
  "pattern",
  "prefixItems",
  "propertyNames",
  "required",
  "then",
  "unevaluatedProperties",
  "uniqueItems",
]);

function fieldsMatching(tool: McpTool, names: ReadonlySet<string>, types: readonly string[]): readonly string[] {
  const fields: string[] = [];
  for (const [name, value] of Object.entries(tool.properties)) {
    const property = asRecord(value);
    if (names.has(normalizedFieldName(name)) && property && typeof property.type === "string" && types.includes(property.type)) {
      fields.push(name);
    }
  }
  return fields;
}

function uniqueField(tool: McpTool, names: ReadonlySet<string>, types: readonly string[]): string | undefined {
  const fields = fieldsMatching(tool, names, types);
  return fields.length === 1 ? fields[0] : undefined;
}

function hasUnknownRequired(tool: McpTool, supportedFields: readonly (string | undefined)[]): boolean {
  const supported = new Set(supportedFields.filter((value): value is string => value !== undefined));
  return tool.required.some((field) => !supported.has(field));
}

function selectedFieldsHaveUnsupportedConstraints(
  tool: McpTool,
  fields: readonly (string | undefined)[],
): boolean {
  for (const field of fields) {
    if (field === undefined) continue;
    const property = asRecord(tool.properties[field]);
    if (!property) return true;
    if (Object.keys(property).some((key) => UNSUPPORTED_SCHEMA_CONSTRAINTS.has(key))) return true;
  }
  return false;
}

function toolTextMatches(tool: McpTool, action: RegExp): boolean {
  const readableName = tool.name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ");
  const text = normalizeSpace(`${readableName} ${tool.description}`);
  return action.test(text) && /\b(?:job|jobs|opening|openings|position|positions|role|roles|posting|postings)\b/i.test(text);
}

function searchMapping(tool: McpTool): SearchToolMapping | "unknown-required" | "unsupported-schema" | undefined {
  if (!toolTextMatches(tool, /\b(?:search|find|list|match|lookup)\b/i)) return undefined;
  const queryField = uniqueField(tool, QUERY_FIELDS, ["string"]);
  if (!queryField) return undefined;
  const locationField = uniqueField(tool, LOCATION_FIELDS, ["string"]);
  const limitField = uniqueField(tool, LIMIT_FIELDS, ["integer", "number"]);
  if (selectedFieldsHaveUnsupportedConstraints(tool, [queryField, locationField, limitField])) {
    return "unsupported-schema";
  }
  if (hasUnknownRequired(tool, [queryField, locationField, limitField])) return "unknown-required";
  return { tool, queryField, locationField, limitField };
}

function detailMapping(tool: McpTool): DetailToolMapping | "unknown-required" | "unsupported-schema" | undefined {
  if (!toolTextMatches(tool, /\b(?:detail|fetch|get|retrieve|lookup)\b/i)) return undefined;
  const idField = uniqueField(tool, ID_FIELDS, ["string"]);
  const requisitionField = uniqueField(tool, REQUISITION_FIELDS, ["string"]);
  const urlField = uniqueField(tool, URL_FIELDS, ["string"]);
  if (!idField && !requisitionField && !urlField) return undefined;
  if (selectedFieldsHaveUnsupportedConstraints(tool, [idField, requisitionField, urlField])) {
    return "unsupported-schema";
  }
  if (hasUnknownRequired(tool, [idField, requisitionField, urlField])) return "unknown-required";
  return { tool, idField, requisitionField, urlField };
}

function selectSearchTool(tools: readonly McpTool[]): ToolSelection<SearchToolMapping> {
  const candidates: SearchToolMapping[] = [];
  let unknownRequired = false;
  let unsupportedSchema = false;
  for (const tool of tools) {
    const mapping = searchMapping(tool);
    if (mapping === "unknown-required") unknownRequired = true;
    else if (mapping === "unsupported-schema") unsupportedSchema = true;
    else if (mapping) candidates.push(mapping);
  }
  if (candidates.length === 1) return { mapping: candidates[0] };
  if (candidates.length > 1) return { provenance: "indeed search tool discovery was ambiguous" };
  return {
    provenance: unsupportedSchema
      ? "indeed search tool has unsupported schema constraints"
      : unknownRequired
        ? "indeed search tool has unsupported required arguments"
        : "indeed search tool was not available",
  };
}

function selectDetailTool(tools: readonly McpTool[]): ToolSelection<DetailToolMapping> {
  const candidates: DetailToolMapping[] = [];
  let unknownRequired = false;
  let unsupportedSchema = false;
  for (const tool of tools) {
    const mapping = detailMapping(tool);
    if (mapping === "unknown-required") unknownRequired = true;
    else if (mapping === "unsupported-schema") unsupportedSchema = true;
    else if (mapping) candidates.push(mapping);
  }
  if (candidates.length === 1) return { mapping: candidates[0] };
  if (candidates.length > 1) return { provenance: "indeed detail tool discovery was ambiguous" };
  return {
    provenance: unsupportedSchema
      ? "indeed detail tool has unsupported schema constraints"
      : unknownRequired
        ? "indeed detail tool has unsupported required arguments"
        : "indeed detail tool was not available",
  };
}

function boundedIdentifier(value: unknown): string | undefined {
  const normalized = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : nonemptyString(value);
  return normalized && normalized.length <= 500 ? normalized : undefined;
}

function jobIdAt(record: JsonRecord): string | undefined {
  return boundedIdentifier(
    record.id ?? record.jobId ?? record.job_id ?? record.jobKey ?? record.job_key
      ?? record.sourceItemId ?? record.source_item_id,
  );
}

function requisitionIdAt(record: JsonRecord): string | undefined {
  return boundedIdentifier(
    record.requisitionId ?? record.requisition_id ?? record.requisitionNumber
      ?? record.requisition_number ?? record.reqId ?? record.req_id,
  );
}

function companyAt(record: JsonRecord): string | undefined {
  const direct = stringAt(record, "company", "companyName", "company_name", "employer", "employerName");
  if (direct) return direct;
  const company = asRecord(record.company) ?? asRecord(record.employer);
  return company ? stringAt(company, "name") : undefined;
}

function boundedNormalizedString(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeSpace(value);
  return normalized.length >= 1 && normalized.length <= maxLength ? normalized : undefined;
}

function candidateAt(record: JsonRecord): JobCandidate | undefined {
  const sourceItemId = jobIdAt(record);
  const rawUrl = stringAt(
    record,
    "url",
    "link",
    "jobUrl",
    "job_url",
    "jobLink",
    "job_link",
    "postingUrl",
    "posting_url",
    "canonicalUrl",
  );
  const sourceUrl = rawUrl ? canonicalizeJobUrl(rawUrl) : undefined;
  const title = boundedNormalizedString(stringAt(record, "title", "jobTitle", "job_title", "positionTitle"), 500);
  const company = boundedNormalizedString(companyAt(record), 500);
  if (!sourceItemId || !sourceUrl) return undefined;
  const applyValue = stringAt(record, "applyUrl", "apply_url", "applicationUrl", "application_url");
  const applyUrl = applyValue ? canonicalizeJobUrl(applyValue) : undefined;
  const location = boundedNormalizedString(stringAt(record, "location", "jobLocation", "job_location"), 500);
  const description = stringAt(
    record,
    "description",
    "jobDescription",
    "job_description",
    "formattedDescription",
    "formatted_description",
    "summary",
  );
  const requisitionId = requisitionIdAt(record);
  return {
    sourceItemId,
    sourceUrl,
    ...(title ? { title } : {}),
    ...(company ? { company } : {}),
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
    ...(applyUrl ? { applyUrl } : {}),
    ...(hasOwn(record, "postedAt") ? { postedAt: record.postedAt } : hasOwn(record, "posted_at")
      ? { postedAt: record.posted_at }
      : hasOwn(record, "datePosted") ? { postedAt: record.datePosted }
        : hasOwn(record, "date") ? { postedAt: record.date } : {}),
    ...(requisitionId ? { requisitionId } : {}),
  };
}

function jobRecords(payload: unknown): readonly unknown[] {
  let value = payload;
  for (let depth = 0; depth < 5; depth += 1) {
    if (Array.isArray(value)) {
      if (value.length > MAX_SEARCH_JOBS) protocolError();
      return value;
    }
    const record = asRecord(value);
    if (!record) return [];
    for (const key of ["jobs", "jobPostings", "postings", "results", "items", "result"] as const) {
      if (hasOwn(record, key)) {
        value = record[key];
        break;
      }
    }
    if (value !== record) continue;
    if (hasOwn(record, "data")) {
      value = record.data;
      continue;
    }
    return jobIdAt(record) ? [record] : [];
  }
  protocolError();
}

function detailRecord(payload: unknown): JsonRecord | undefined {
  let value = payload;
  for (let depth = 0; depth < 5; depth += 1) {
    if (Array.isArray(value)) {
      if (value.length !== 1) return undefined;
      value = value[0];
      continue;
    }
    const record = asRecord(value);
    if (!record) return undefined;
    for (const key of ["job", "result", "item", "details", "data"] as const) {
      if (hasOwn(record, key)) {
        value = record[key];
        break;
      }
    }
    if (value === record) return record;
  }
  return undefined;
}

function stringFitsProperty(tool: McpTool, field: string, value: string): boolean {
  const property = asRecord(tool.properties[field]);
  if (!property) return false;
  const minimum = property.minLength;
  const maximum = property.maxLength;
  if (minimum !== undefined && (typeof minimum !== "number" || !Number.isSafeInteger(minimum) || minimum < 0)) return false;
  if (maximum !== undefined && (typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum < 0)) return false;
  return (minimum === undefined || value.length >= minimum)
    && (maximum === undefined || value.length <= maximum);
}

function boundedLimit(tool: McpTool, field: string, requested: number): number | undefined {
  const property = asRecord(tool.properties[field]);
  if (!property) return undefined;
  const rawMinimum = property.minimum;
  const rawMaximum = property.maximum;
  if (
    (rawMinimum !== undefined && (typeof rawMinimum !== "number" || !Number.isSafeInteger(rawMinimum)))
    || (rawMaximum !== undefined && (typeof rawMaximum !== "number" || !Number.isSafeInteger(rawMaximum)))
  ) return undefined;
  const minimum = Math.max(1, (rawMinimum as number | undefined) ?? 1);
  const maximum = Math.min(MAX_JOBS, (rawMaximum as number | undefined) ?? MAX_JOBS);
  if (minimum > maximum) return undefined;
  return Math.max(minimum, Math.min(maximum, requested));
}

function searchArguments(
  mapping: SearchToolMapping,
  search: IndeedSearchConfig,
  limit: number,
): { readonly args?: JsonRecord; readonly provenance?: string } {
  if (!stringFitsProperty(mapping.tool, mapping.queryField, search.query)) {
    return { provenance: "indeed search query does not match the discovered schema" };
  }
  if (mapping.locationField && mapping.tool.required.includes(mapping.locationField) && !search.location) {
    return { provenance: "indeed search requires a configured location" };
  }
  const args: Record<string, unknown> = { [mapping.queryField]: search.query };
  let provenance: string | undefined;
  if (search.location) {
    if (mapping.locationField) {
      if (!stringFitsProperty(mapping.tool, mapping.locationField, search.location)) {
        return { provenance: "indeed search location does not match the discovered schema" };
      }
      args[mapping.locationField] = search.location;
    } else provenance = "indeed search tool does not accept location";
  }
  if (mapping.limitField) {
    const mappedLimit = boundedLimit(mapping.tool, mapping.limitField, limit);
    if (mappedLimit === undefined) {
      return { provenance: "indeed search limit does not match the discovered schema" };
    }
    args[mapping.limitField] = mappedLimit;
  }
  return { args, ...(provenance ? { provenance } : {}) };
}

function detailArguments(mapping: DetailToolMapping, candidate: JobCandidate): JsonRecord | undefined {
  const args: Record<string, unknown> = {};
  let hasArgument = false;
  if (mapping.idField && mapping.tool.required.includes(mapping.idField)) {
    if (!stringFitsProperty(mapping.tool, mapping.idField, candidate.sourceItemId)) return undefined;
    args[mapping.idField] = candidate.sourceItemId;
    hasArgument = true;
  }
  if (mapping.requisitionField && mapping.tool.required.includes(mapping.requisitionField)) {
    if (
      !candidate.requisitionId
      || !stringFitsProperty(mapping.tool, mapping.requisitionField, candidate.requisitionId)
    ) return undefined;
    args[mapping.requisitionField] = candidate.requisitionId;
    hasArgument = true;
  }
  if (mapping.urlField && mapping.tool.required.includes(mapping.urlField)) {
    if (!stringFitsProperty(mapping.tool, mapping.urlField, candidate.sourceUrl)) return undefined;
    args[mapping.urlField] = candidate.sourceUrl;
    hasArgument = true;
  }
  if (!hasArgument && mapping.idField) {
    if (!stringFitsProperty(mapping.tool, mapping.idField, candidate.sourceItemId)) return undefined;
    args[mapping.idField] = candidate.sourceItemId;
    hasArgument = true;
  }
  if (!hasArgument && mapping.requisitionField && candidate.requisitionId) {
    if (!stringFitsProperty(mapping.tool, mapping.requisitionField, candidate.requisitionId)) return undefined;
    args[mapping.requisitionField] = candidate.requisitionId;
    hasArgument = true;
  }
  if (!hasArgument && mapping.urlField) {
    if (!stringFitsProperty(mapping.tool, mapping.urlField, candidate.sourceUrl)) return undefined;
    args[mapping.urlField] = candidate.sourceUrl;
    hasArgument = true;
  }
  return hasArgument ? args : undefined;
}

async function normalizedJob(
  candidate: JobCandidate,
  detail: JsonRecord | undefined,
  inlineDescription: string | undefined,
  signal: AbortSignal,
): Promise<DiscoveredJobInput | undefined> {
  const detailId = detail ? jobIdAt(detail) : undefined;
  if (detailId && detailId !== candidate.sourceItemId) return undefined;
  const detailRequisitionId = detail ? requisitionIdAt(detail) : undefined;
  if (detailRequisitionId && candidate.requisitionId && detailRequisitionId !== candidate.requisitionId) {
    return undefined;
  }
  const detailDescription = detail && stringAt(
    detail,
    "description",
    "jobDescription",
    "job_description",
    "formattedDescription",
    "formatted_description",
    "summary",
  );
  const description = detailDescription
    ? await sanitizeDescription(detailDescription)
    : inlineDescription;
  signal.throwIfAborted();
  if (!description) return undefined;
  const detailTitle = detail && boundedNormalizedString(
    stringAt(detail, "title", "jobTitle", "job_title", "positionTitle"),
    500,
  );
  const detailCompany = detail && boundedNormalizedString(companyAt(detail), 500);
  const title = detailTitle ?? candidate.title;
  const company = detailCompany ?? candidate.company;
  if (!title || !company) return undefined;
  const detailApply = detail && stringAt(detail, "applyUrl", "apply_url", "applicationUrl", "application_url");
  const applyUrl = (detailApply ? canonicalizeJobUrl(detailApply) : undefined) ?? candidate.applyUrl ?? candidate.sourceUrl;
  const detailLocation = detail && boundedNormalizedString(stringAt(detail, "location", "jobLocation", "job_location"), 500);
  const postedAt = parsePostedAt(
    detail && (detail.postedAt ?? detail.posted_at ?? detail.datePosted ?? detail.date) !== undefined
      ? detail.postedAt ?? detail.posted_at ?? detail.datePosted ?? detail.date
      : candidate.postedAt,
  );
  return {
    sourceItemId: candidate.sourceItemId,
    sourceUrl: candidate.sourceUrl,
    canonicalUrl: candidate.sourceUrl,
    applyUrl,
    title,
    company,
    ...((detailLocation ?? candidate.location) ? { location: detailLocation ?? candidate.location } : {}),
    description,
    ...(postedAt === null ? {} : { postedAt }),
    ...((detailRequisitionId ?? candidate.requisitionId)
      ? { requisitionId: detailRequisitionId ?? candidate.requisitionId }
      : {}),
  };
}

function validatedConfig(config: IndeedConnectorConfig): ValidatedIndeedConfig {
  const id = normalizeSpace(config.id);
  const name = normalizeSpace(config.name ?? "Indeed");
  if (!SOURCE_ID.test(id) || id.length > 100 || name.length < 1 || name.length > 200) configError();
  if (!Array.isArray(config.searches) || config.searches.length < 1 || config.searches.length > 10) configError();
  const searches = config.searches.map((search) => {
    const query = normalizeSpace(search.query);
    const location = search.location === undefined ? undefined : normalizeSpace(search.location);
    if (query.length < 1 || query.length > 200 || (location !== undefined && (location.length < 1 || location.length > 200))) {
      configError();
    }
    return { query, ...(location === undefined ? {} : { location }) };
  });
  const maxJobs = config.maxJobs ?? DEFAULT_MAX_JOBS;
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > MAX_JOBS) configError();
  return { id, name, searches, maxJobs };
}

function boundedProvenance(parts: ReadonlySet<string>, omitted: number, capped: boolean): string | undefined {
  const messages = [...parts];
  if (omitted > 0) messages.push(`indeed omitted unusable jobs: ${Math.min(omitted, MAX_SEARCH_JOBS)}`);
  if (capped) messages.push("indeed result cap reached");
  const provenance = messages.join("; ");
  return provenance ? provenance.slice(0, 1_000) : undefined;
}

export function createIndeedConnector(
  input: IndeedConnectorConfig,
  resolveAccessToken: IndeedAccessTokenResolver,
  client = new SafePublicHttpClient(),
): DiscoveryConnector {
  const config = validatedConfig(input);
  return {
    id: config.id,
    name: config.name,
    kind: "indeed",
    async sync(signal: AbortSignal, budget?: DiscoveryHttpBudget): Promise<DiscoverySyncResult> {
      signal.throwIfAborted();
      const accessToken = await resolveAccessToken(signal);
      signal.throwIfAborted();
      if (!accessToken || !BEARER_TOKEN.test(accessToken)) throw new IndeedConnectorError(SIGN_IN_ERROR_MESSAGE);
      const session = new StreamableHttpMcpSession(budget ? client.withBudget(budget) : client, accessToken);
      await session.initialize(signal);
      signal.throwIfAborted();
      const tools = await session.listTools(signal);
      signal.throwIfAborted();
      const selectedSearch = selectSearchTool(tools);
      if (!selectedSearch.mapping) {
        return {
          items: [],
          completeSnapshot: false,
          ...(selectedSearch.provenance ? { provenance: selectedSearch.provenance } : {}),
        };
      }
      const selectedDetail = selectDetailTool(tools);
      const items: DiscoveredJobInput[] = [];
      const seenIds = new Set<string>();
      const provenance = new Set<string>();
      let omitted = 0;
      let capped = false;
      for (let searchIndex = 0; searchIndex < config.searches.length; searchIndex += 1) {
        signal.throwIfAborted();
        if (items.length >= config.maxJobs) {
          capped = true;
          break;
        }
        const search = config.searches[searchIndex]!;
        const built = searchArguments(selectedSearch.mapping, search, config.maxJobs - items.length);
        if (built.provenance) provenance.add(built.provenance);
        if (!built.args) continue;
        const searchPayload = await session.callReadOnlyTool(selectedSearch.mapping, built.args, signal);
        signal.throwIfAborted();
        const records = jobRecords(searchPayload);
        for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
          signal.throwIfAborted();
          if (items.length >= config.maxJobs) {
            capped = true;
            break;
          }
          const record = asRecord(records[recordIndex]);
          const candidate = record ? candidateAt(record) : undefined;
          if (!candidate || seenIds.has(candidate.sourceItemId)) {
            omitted += 1;
            continue;
          }
          let detail: JsonRecord | undefined;
          const inlineDescription = candidate.description ? await sanitizeDescription(candidate.description) : undefined;
          signal.throwIfAborted();
          if (!inlineDescription || !candidate.title || !candidate.company) {
            if (!selectedDetail.mapping) {
              omitted += 1;
              if (selectedDetail.provenance) provenance.add(selectedDetail.provenance);
              continue;
            }
            const args = detailArguments(selectedDetail.mapping, candidate);
            if (!args) {
              omitted += 1;
              provenance.add("indeed detail arguments do not match the discovered schema");
              continue;
            }
            const detailPayload = await session.callReadOnlyTool(
              selectedDetail.mapping,
              args,
              signal,
            );
            signal.throwIfAborted();
            detail = detailRecord(detailPayload);
          }
          const item = await normalizedJob(candidate, detail, inlineDescription, signal);
          signal.throwIfAborted();
          if (!item) {
            omitted += 1;
            continue;
          }
          seenIds.add(candidate.sourceItemId);
          items.push(item);
        }
      }
      const resultProvenance = boundedProvenance(provenance, omitted, capped);
      return {
        items,
        completeSnapshot: false,
        ...(resultProvenance ? { provenance: resultProvenance } : {}),
      };
    },
  };
}
