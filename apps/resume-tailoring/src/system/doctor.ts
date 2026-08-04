import { getBundledModel, resolveWireModelId, type Effort } from "@oh-my-pi/pi-catalog";
import { getAuthStatus } from "../auth/service.ts";
import type { AuthProvider } from "../contracts/index.ts";
import { openContextDatabase } from "../context/database.ts";
import { loadContextManifest } from "../context/manifest.ts";
import { checkContextFreshness } from "../context/service.ts";
import { LUNA_MODEL_NAME } from "../models/luna-job-extractor.ts";
import { MODEL_NAME, OMP_CODEX_MODEL } from "../models/oauth-codex-model.ts";

export type DoctorCheckStatus = "ok" | "warning" | "error";

export interface DoctorCheck {
  id: "bun" | "context" | "auth-openai"
    | "model-openai" | "model-luna"
    | "latexmk" | "pdfinfo" | "pdftotext" | "pdffonts" | "pdftoppm";
  status: DoctorCheckStatus;
  classification: string;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  checkedAt: number;
  checks: DoctorCheck[];
}

export type DoctorProvider = "openai-codex";
export type DoctorModelId = typeof MODEL_NAME | typeof LUNA_MODEL_NAME;
export type DoctorModelDescriptors = Readonly<Record<DoctorModelId, unknown>>;
export type DoctorAuthState = "connected" | "disconnected" | "expired";

export interface DoctorAuthStatus {
  readonly providers: readonly { readonly provider: AuthProvider; readonly state: DoctorAuthState }[];
}

export type ContextDoctorStatus =
  | { readonly state: "fresh" }
  | { readonly state: "stale" }
  | { readonly state: "invalid" }
  | { readonly state: "inaccessible" };

export interface DoctorProcessProbe {
  readonly findExecutable: (executable: string) => string | undefined;
  readonly version: (executablePath: string, args: readonly string[]) => Promise<string>;
}

export interface DoctorDependencies {
  readonly now?: () => number;
  readonly authStatus?: () => Promise<DoctorAuthStatus>;
  readonly contextStatus?: () => ContextDoctorStatus;
  readonly modelDescriptors?: () => DoctorModelDescriptors;
  readonly process?: DoctorProcessProbe;
  readonly probeEntitlement?: (provider: DoctorProvider, modelId: DoctorModelId) => Promise<void>;
}

export interface DoctorOptions {
  readonly probeModels?: boolean;
}

export type DoctorProbeFailure = "auth_expired" | "callback_port_conflict" | "network_failure" | "model_unentitled";

export class DoctorProbeError extends Error {
  constructor(readonly classification: DoctorProbeFailure) {
    super(classification);
    this.name = "DoctorProbeError";
  }
}

const TOOL_IDS = ["bun", "latexmk", "pdfinfo", "pdftotext", "pdffonts", "pdftoppm"] as const;
const VERSION_ARGS: Readonly<Record<(typeof TOOL_IDS)[number], readonly string[]>> = Object.freeze({
  bun: Object.freeze(["--version"]),
  latexmk: Object.freeze(["--version"]),
  pdfinfo: Object.freeze(["-v"]),
  pdftotext: Object.freeze(["-v"]),
  pdffonts: Object.freeze(["-v"]),
  pdftoppm: Object.freeze(["-v"]),
});
const SUCCESS_CACHE_MS = 10 * 60 * 1_000;
const MAX_VERSION_BYTES = 4 * 1024;
const MAX_JSON_BYTES = 32 * 1024;
const successCaches = new WeakMap<DoctorDependencies, Map<string, number>>();

const EXPECTED_CODEX_DESCRIPTOR = Object.freeze({
  id: "gpt-5.6-sol", name: "GPT-5.6 Sol", api: "openai-codex-responses", provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text", "image"], supportsTools: true,
  cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  remoteCompaction: { enabled: true, api: "openai-codex-responses", v2StreamingEnabled: true }, contextWindow: 372_000,
  maxTokens: 128_000, preferWebsockets: false, useResponsesLite: true, priority: 1, applyPatchToolType: "freeform",
  thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] },
});

const EXPECTED_LUNA_DESCRIPTOR = Object.freeze({
  id: "gpt-5.6-luna", name: "GPT-5.6 Luna", api: "openai-codex-responses", provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text", "image"],
  cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
  remoteCompaction: { enabled: true, api: "openai-codex-responses", v2StreamingEnabled: true },
  contextWindow: 372_000, maxTokens: 128_000, preferWebsockets: true, useResponsesLite: true, priority: 3,
  applyPatchToolType: "freeform",
  thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] },
});

async function readBoundedVersion(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) return output + decoder.decode();
    bytes += part.value.byteLength;
    if (bytes > MAX_VERSION_BYTES) {
      await reader.cancel();
      throw new Error("version output exceeded limit");
    }
    output += decoder.decode(part.value, { stream: true });
  }
}

async function defaultVersion(executablePath: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn([executablePath, ...args], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore", env: {}, timeout: 5_000,
  });
  const [exitCode, stdout] = await Promise.all([child.exited, readBoundedVersion(child.stdout)]);
  if (exitCode !== 0) throw new Error("version probe failed");
  return stdout;
}

const DEFAULT_PROCESS: DoctorProcessProbe = Object.freeze({
  findExecutable: (executable: string) => Bun.which(executable) ?? undefined,
  version: defaultVersion,
});

function defaultContextStatus(): ContextDoctorStatus {
  try {
    const loaded = loadContextManifest();
    const database = openContextDatabase();
    try {
      return checkContextFreshness(database, loaded).fresh ? { state: "fresh" } : { state: "stale" };
    } finally {
      database.close();
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return code === "ENOENT" || code === "EACCES" || code === "EPERM" ? { state: "inaccessible" } : { state: "invalid" };
  }
}

function defaultModelDescriptors(): DoctorModelDescriptors {
  return {
    [MODEL_NAME]: OMP_CODEX_MODEL,
    [LUNA_MODEL_NAME]: getBundledModel("openai-codex", LUNA_MODEL_NAME),
  };
}

function descriptorMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) => descriptorMatches((actual as Record<string, unknown>)[key], value));
  }
  return actual === expected;
}

function hasExpectedHighRoute(descriptor: unknown, expected: string): boolean {
  try {
    return resolveWireModelId(
      descriptor as Parameters<typeof resolveWireModelId>[0],
      "high" as Effort,
    ) === expected;
  } catch {
    return false;
  }
}

function check(id: DoctorCheck["id"], status: DoctorCheckStatus, classification: string, detail?: string): DoctorCheck {
  return Object.freeze({ id, status, classification, ...(detail ? { detail } : {}) });
}

async function toolCheck(id: (typeof TOOL_IDS)[number], processProbe: DoctorProcessProbe): Promise<DoctorCheck> {
  try {
    const executablePath = processProbe.findExecutable(id);
    if (!executablePath) return check(id, "error", "missing_system_tool");
    await processProbe.version(executablePath, VERSION_ARGS[id]);
    return check(id, "ok", "available");
  } catch {
    return check(id, "error", "missing_system_tool");
  }
}

function contextCheck(status: ContextDoctorStatus): DoctorCheck {
  switch (status.state) {
    case "fresh": return check("context", "ok", "fresh");
    case "stale": return check("context", "error", "stale_index");
    case "inaccessible": return check("context", "error", "context_source_inaccessible");
    case "invalid": return check("context", "error", "context_source_invalid");
  }
}

function authCheck(id: "auth-openai", state: DoctorAuthState): DoctorCheck {
  if (state === "connected") return check(id, "ok", "connected");
  if (state === "expired") return check(id, "warning", "auth_expired");
  return check(id, "warning", "auth_absent");
}

async function modelCheck(
  id: "model-openai" | "model-luna",
  provider: DoctorProvider,
  modelId: DoctorModelId,
  expectedDescriptor: unknown,
  descriptor: unknown,
  expectedHighRoute: string | undefined,
  authState: DoctorAuthState,
  dependencies: DoctorDependencies,
  now: number,
  shouldProbe: boolean,
): Promise<DoctorCheck> {
  const descriptorValid = descriptorMatches(descriptor, expectedDescriptor);
  const highRouteValid = expectedHighRoute === undefined || hasExpectedHighRoute(descriptor, expectedHighRoute);
  if (!descriptorValid || !highRouteValid) return check(id, "error", "model_descriptor_invalid");
  if (authState === "disconnected") return check(id, "warning", "auth_absent");
  if (authState === "expired") return check(id, "warning", "auth_expired");
  if (!shouldProbe) return check(id, "ok", "descriptor_valid");
  if (!dependencies.probeEntitlement) return check(id, "warning", "entitlement_probe_unavailable");

  let cache = successCaches.get(dependencies);
  if (!cache) {
    cache = new Map();
    successCaches.set(dependencies, cache);
  }
  const cacheKey = `${provider}\0${modelId}`;
  const cachedAt = cache.get(cacheKey);
  const cacheAge = cachedAt === undefined ? undefined : now - cachedAt;
  if (cacheAge !== undefined && cacheAge >= 0 && cacheAge < SUCCESS_CACHE_MS) return check(id, "ok", "entitled_cached");
  try {
    await dependencies.probeEntitlement(provider, modelId);
    cache.set(cacheKey, now);
    return check(id, "ok", "entitled");
  } catch (error) {
    const classification = error instanceof DoctorProbeError ? error.classification : "network_failure";
    return check(id, "warning", classification);
  }
}

export async function runDoctor(dependencies: DoctorDependencies, options: DoctorOptions = {}): Promise<DoctorReport> {
  const now = dependencies.now?.() ?? Date.now();
  const processProbe = dependencies.process ?? DEFAULT_PROCESS;
  let contextStatus: ContextDoctorStatus;
  try {
    contextStatus = (dependencies.contextStatus ?? defaultContextStatus)();
  } catch {
    contextStatus = { state: "invalid" };
  }
  let authStatus: DoctorAuthStatus;
  let authConfigurationInvalid = false;
  try {
    authStatus = await (dependencies.authStatus ?? getAuthStatus)();
  } catch {
    authStatus = { providers: [] };
    authConfigurationInvalid = true;
  }
  const openaiAuth = authStatus.providers.find(
    ({ provider }) => provider === "openai-codex",
  )?.state ?? "disconnected";

  let descriptors: DoctorModelDescriptors;
  try {
    descriptors = (dependencies.modelDescriptors ?? defaultModelDescriptors)();
  } catch {
    descriptors = { [MODEL_NAME]: undefined, [LUNA_MODEL_NAME]: undefined };
  }

  const bun = await toolCheck("bun", processProbe);
  const context = contextCheck(contextStatus);
  const authOpenai = authConfigurationInvalid
    ? check("auth-openai", "error", "auth_configuration_invalid")
    : authCheck("auth-openai", openaiAuth);
  const modelOpenai = await modelCheck("model-openai", "openai-codex", MODEL_NAME, EXPECTED_CODEX_DESCRIPTOR,
    descriptors[MODEL_NAME], undefined, openaiAuth, dependencies, now, options.probeModels !== false);
  const modelLuna = await modelCheck("model-luna", "openai-codex", LUNA_MODEL_NAME, EXPECTED_LUNA_DESCRIPTOR,
    descriptors[LUNA_MODEL_NAME], LUNA_MODEL_NAME, openaiAuth, dependencies, now, options.probeModels !== false);
  const remainingTools = await Promise.all(TOOL_IDS.slice(1).map((id) => toolCheck(id, processProbe)));
  const checks: DoctorCheck[] = [
    bun, context, authOpenai, modelOpenai, modelLuna, ...remainingTools,
  ];
  return Object.freeze({ ok: checks.every((item) => item.status !== "error"), checkedAt: now, checks });
}

export function doctorExitCode(report: DoctorReport): 0 | 1 {
  return report.ok ? 0 : 1;
}

export function renderDoctorJson(report: DoctorReport): string {
  const rendered = JSON.stringify(report);
  if (Buffer.byteLength(rendered) > MAX_JSON_BYTES) {
    return JSON.stringify({ ok: false, checkedAt: report.checkedAt, checks: [{ id: "context", status: "error", classification: "doctor_output_too_large" }] });
  }
  return rendered;
}
