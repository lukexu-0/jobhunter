import {
  completeSimple,
  type ApiKeyResolver,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { getBundledModel, type Effort } from "@oh-my-pi/pi-catalog";
import { z } from "zod";
import { createOAuthOnlyApiKeyResolver } from "../auth/oauth-only-resolver";

export const GEMINI_MODEL_NAME = "gemini-3.5-flash" as const;
export const MAX_GEMINI_PNG_BYTES = 25 * 1024 * 1024;
// pi-catalog publishes Effort as an ambient const enum; this is its exact medium wire value.
const MEDIUM_EFFORT = "medium" as Effort;

export const GeminiVisualInspectionSchema = z.object({
  status: z.enum(["pass", "issue", "uncertain"]),
  summary: z.string().trim().min(1).max(2_000),
  findings: z.array(z.object({
    severity: z.enum(["error", "warning", "info"]),
    description: z.string().trim().min(1).max(2_000),
    page: z.literal(1),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  }).strict()).max(100),
}).strict();
export type GeminiVisualInspection = z.infer<typeof GeminiVisualInspectionSchema>;

const GEMINI_DESCRIPTOR = getBundledModel<"google-gemini-cli">("google-antigravity", GEMINI_MODEL_NAME);
const expectedDescriptor = {
  id: GEMINI_MODEL_NAME,
  name: "Gemini 3.5 Flash",
  api: "google-gemini-cli",
  provider: "google-antigravity",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 65_536,
  requestModelId: "gemini-3.5-flash-extra-low",
  thinking: {
    mode: "budget", efforts: ["minimal", "low", "medium", "high"],
    effortBudgets: { minimal: 1_000, low: 1_000, medium: 4_000, high: 10_000 },
    effortRouting: {
      off: "gemini-3.5-flash-extra-low", minimal: "gemini-3.5-flash-extra-low", low: "gemini-3.5-flash-extra-low",
      medium: "gemini-3.5-flash-low", high: "gemini-3-flash-agent",
    },
    suppressWhenOff: true,
  },
};
function assertDescriptorValue(actual: unknown, expected: unknown, path: string): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Invalid bundled Gemini descriptor field: ${path}`);
    return;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) throw new Error(`Invalid bundled Gemini descriptor field: ${path}`);
    const actualRecord = actual as Record<string, unknown>;
    for (const [key, nestedExpected] of Object.entries(expected)) {
      if (!(key in actual)) throw new Error(`Missing bundled Gemini descriptor field: ${path}.${key}`);
      assertDescriptorValue(actualRecord[key], nestedExpected, `${path}.${key}`);
    }
    return;
  }
  if (actual !== expected) throw new Error(`Invalid bundled Gemini descriptor field: ${path}`);
}

if (!GEMINI_DESCRIPTOR) throw new Error("Missing bundled google-antigravity/gemini-3.5-flash descriptor");
const descriptor = GEMINI_DESCRIPTOR as Model<"google-gemini-cli"> & Record<string, unknown>;
for (const [field, expected] of Object.entries(expectedDescriptor)) {
  assertDescriptorValue(descriptor[field], expected, field);
}

export type GeminiCompleteTransport = (
  model: Model<"google-gemini-cli">,
  context: Context,
  options: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export type AntigravityResolverFactory = (
  provider: "google-antigravity",
  sessionId: string,
  modelId: typeof GEMINI_MODEL_NAME,
  signal?: AbortSignal,
) => ApiKeyResolver;

export interface GeminiInspectorOptions {
  readonly transport?: GeminiCompleteTransport;
  readonly resolverFactory?: AntigravityResolverFactory;
}

export async function inspectResumePng(
  png: Uint8Array,
  attemptSessionId: string,
  signal?: AbortSignal,
  inspectorOptions: GeminiInspectorOptions = {},
): Promise<GeminiVisualInspection> {
  if (!(png instanceof Uint8Array) || png.byteLength === 0 || png.byteLength > MAX_GEMINI_PNG_BYTES) {
    throw new Error(`PNG must contain 1-${MAX_GEMINI_PNG_BYTES} bytes`);
  }
  if (png.byteLength < 8 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47 || png[4] !== 0x0d || png[5] !== 0x0a || png[6] !== 0x1a || png[7] !== 0x0a) {
    throw new Error("Gemini visual inspection accepts PNG only");
  }
  if (!attemptSessionId.trim()) throw new Error("attemptSessionId is required");

  const resolverFactory = inspectorOptions.resolverFactory ?? createOAuthOnlyApiKeyResolver;
  const transport = inspectorOptions.transport ?? completeSimple;
  const apiKey = resolverFactory("google-antigravity", attemptSessionId, GEMINI_MODEL_NAME, signal);
  const schema = JSON.stringify(z.toJSONSchema(GeminiVisualInspectionSchema));
  const message = await transport(GEMINI_DESCRIPTOR, {
    systemPrompt: [
      "Inspect the single resume page for clipping, overlap, unreadable text, broken glyphs, poor spacing, or layout defects.",
      `Return exactly one JSON object and no Markdown or commentary. It must satisfy this strict JSON Schema: ${schema}`,
    ],
    messages: [{
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString("base64") }],
      timestamp: Date.now(),
    }],
  }, { apiKey, ...(signal ? { signal } : {}), reasoning: MEDIUM_EFFORT });
  if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? `Gemini request ${message.stopReason}`);
  const textParts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") textParts.push(part.text);
    else if (part.type !== "thinking" && part.type !== "redactedThinking") throw new Error(`Unexpected Gemini response content: ${part.type}`);
  }
  if (textParts.length !== 1) throw new Error("Gemini must return exactly one JSON text result");
  const jsonText = textParts[0];
  if (jsonText === undefined) throw new Error("Gemini response text is missing");
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch (error) {
    throw new Error("Gemini returned invalid JSON", { cause: error });
  }
  return GeminiVisualInspectionSchema.parse(value);
}
