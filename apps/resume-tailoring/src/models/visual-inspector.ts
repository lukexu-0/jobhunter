import {
  completeSimple,
  type ApiKeyResolver,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog";
import { z } from "zod";
import { createOAuthOnlyApiKeyResolver } from "../auth/oauth-only-resolver";
import { MODEL_NAME, OMP_CODEX_MODEL } from "./oauth-codex-model";

export const MAX_VISUAL_INSPECTION_PNG_BYTES = 25 * 1024 * 1024;
// pi-catalog publishes Effort as an ambient const enum; this is its exact medium wire value.
const MEDIUM_EFFORT = "medium" as Effort;

export const VisualInspectionSchema = z.object({
  status: z.enum(["pass", "issue", "uncertain"]),
  summary: z.string().trim().min(1).max(2_000),
  findings: z.array(z.object({
    severity: z.enum(["error", "warning", "info"]),
    description: z.string().trim().min(1).max(2_000),
    page: z.literal(1),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  }).strict()).max(100),
}).strict();
export type VisualInspection = z.infer<typeof VisualInspectionSchema>;

export type VisualInspectionTransport = (
  model: Model<"openai-codex-responses">,
  context: Context,
  options: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export type VisualInspectionResolverFactory = (
  provider: "openai-codex",
  sessionId: string,
  modelId: typeof MODEL_NAME,
  signal?: AbortSignal,
) => ApiKeyResolver;

export interface VisualInspectorOptions {
  readonly transport?: VisualInspectionTransport;
  readonly resolverFactory?: VisualInspectionResolverFactory;
}

export async function inspectResumePng(
  png: Uint8Array,
  attemptSessionId: string,
  signal?: AbortSignal,
  inspectorOptions: VisualInspectorOptions = {},
): Promise<VisualInspection> {
  if (!(png instanceof Uint8Array) || png.byteLength === 0 || png.byteLength > MAX_VISUAL_INSPECTION_PNG_BYTES) {
    throw new Error(`PNG must contain 1-${MAX_VISUAL_INSPECTION_PNG_BYTES} bytes`);
  }
  if (png.byteLength < 8 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47 || png[4] !== 0x0d || png[5] !== 0x0a || png[6] !== 0x1a || png[7] !== 0x0a) {
    throw new Error("Visual inspection accepts PNG only");
  }
  if (!attemptSessionId.trim()) throw new Error("attemptSessionId is required");

  const resolverFactory = inspectorOptions.resolverFactory ?? createOAuthOnlyApiKeyResolver;
  const transport = inspectorOptions.transport ?? completeSimple;
  const apiKey = resolverFactory("openai-codex", attemptSessionId, MODEL_NAME, signal);
  const schemaDocument = z.toJSONSchema(VisualInspectionSchema);
  Reflect.deleteProperty(schemaDocument, "$schema");
  const schema = JSON.stringify(schemaDocument);
  const message = await transport(OMP_CODEX_MODEL, {
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
  if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? `Visual inspection request ${message.stopReason}`);
  const textParts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") textParts.push(part.text);
    else if (part.type !== "thinking" && part.type !== "redactedThinking") throw new Error(`Unexpected visual inspection response content: ${part.type}`);
  }
  if (textParts.length !== 1) throw new Error("Visual inspection must return exactly one JSON text result");
  const jsonText = textParts[0];
  if (jsonText === undefined) throw new Error("Visual inspection response text is missing");
  const fencedJson = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(jsonText.trim());
  const parseableJson = fencedJson?.[1] ?? jsonText;
  let value: unknown;
  try {
    value = JSON.parse(parseableJson);
  } catch (error) {
    throw new Error("Visual inspection returned invalid JSON", { cause: error });
  }
  return VisualInspectionSchema.parse(value);
}
