import { createHash } from "node:crypto";
import type { AssistantMessage, Context, Message } from "@oh-my-pi/pi-ai";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { imageSize } from "image-size";

// The tokenizer requires a Set here. Treat apparent special tokens in user text literally.
const TOKEN_OPTIONS = { disallowedSpecial: new Set<string>() };
const MESSAGE_OVERHEAD = 4;
// Sol does not publish image metering. Use the GPT-5.x high/auto patch budget
// as a bounded local estimate; provider usage remains authoritative. Codex Lite
// strips image detail, so a requested low detail must not reduce this estimate.
const IMAGE_PATCH_BUDGET = 2_500;
const IMAGE_TOKEN_MULTIPLIER = 1.2;
const MAX_IMAGE_HEADER_BASE64_CHARS = 87_384; // At most 64 KiB decoded, not the image pixels.

function imageTokens(data: string): number {
  try {
    const { width, height } = imageSize(Buffer.from(data.slice(0, MAX_IMAGE_HEADER_BASE64_CHARS), "base64"));
    if (width <= 0 || height <= 0) return IMAGE_PATCH_BUDGET * IMAGE_TOKEN_MULTIPLIER;
    const scale = Math.min(1, 2_048 / Math.max(width, height), Math.sqrt(IMAGE_PATCH_BUDGET * 32 * 32 / (width * height)));
    const patches = Math.min(IMAGE_PATCH_BUDGET, Math.ceil(width * scale / 32) * Math.ceil(height * scale / 32));
    return Math.ceil(patches * IMAGE_TOKEN_MULTIPLIER);
  } catch {
    // Unknown/long image headers are bounded conservatively; never count base64 as text.
    return IMAGE_PATCH_BUDGET * IMAGE_TOKEN_MULTIPLIER;
  }
}

interface ContextMeasurement {
  readonly localTokens: number;
  readonly epoch: string;
  readonly unmeasuredNative: string;
  readonly nativeKeys: ReadonlySet<string>;
}

/** Per-model accounting for immutable mapped request snapshots, never serialized byte sizes. */
export class CodexContextEstimator {
  #textCache = new Map<string, number>();
  #usedText = new Map<string, number>();
  readonly #nativeUsage = new Map<string, number>();
  readonly #nativeKeys = new WeakMap<object, string>();
  #lastContext: Context | undefined;
  #lastMeasurement: ContextMeasurement | undefined;
  #baseline: { measurement: ContextMeasurement; inputTokens: number } | undefined;

  estimate(context: Context): number {
    const measured = this.#measure(context);
    const baseline = this.#baseline;
    // A replacement or removal of unmeasured opaque history invalidates its calibration.
    if (baseline?.measurement.epoch === measured.epoch
      && baseline.measurement.unmeasuredNative === measured.unmeasuredNative) {
      return Math.max(0, baseline.inputTokens + measured.localTokens - baseline.measurement.localTokens);
    }
    return measured.localTokens;
  }

  observe(context: Context, response: AssistantMessage): void {
    const inputTokens = response.usage.input + response.usage.cacheRead + response.usage.cacheWrite;
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) return;
    const measured = this.#measure(context);
    this.#baseline = { measurement: measured, inputTokens };
    const payload = response.providerPayload;
    const key = payload === undefined ? undefined : this.#nativeKey(payload.items);
    if (key !== undefined && Number.isFinite(response.usage.output) && response.usage.output >= 0) {
      // One provider output group may cover visible text, tool calls AND encrypted reasoning.
      this.#nativeUsage.set(key, response.usage.output);
    }
    for (const oldKey of this.#nativeUsage.keys()) {
      if (oldKey !== key && !measured.nativeKeys.has(oldKey)) this.#nativeUsage.delete(oldKey);
    }
  }

  #textTokens(text: string): number {
    let tokens = this.#textCache.get(text) ?? this.#usedText.get(text);
    if (tokens === undefined) tokens = countTokens(text, TOKEN_OPTIONS);
    this.#usedText.set(text, tokens);
    return tokens;
  }

  #nativeKey(items: readonly Record<string, unknown>[]): string {
    let key = this.#nativeKeys.get(items);
    if (key === undefined) {
      key = createHash("sha256").update(JSON.stringify(items)).digest("hex");
      this.#nativeKeys.set(items, key);
    }
    return key;
  }

  #nativeContentTokens(content: unknown): number {
    if (typeof content === "string") return this.#textTokens(content);
    if (!Array.isArray(content)) return 0;
    let tokens = 0;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      if (part.type === "input_image" && typeof part.image_url === "string") {
        tokens += imageTokens(part.image_url.slice(part.image_url.indexOf(",") + 1));
      } else if (typeof part.text === "string") {
        tokens += this.#textTokens(part.text);
      } else if (typeof part.refusal === "string") {
        tokens += this.#textTokens(part.refusal);
      }
    }
    return tokens;
  }

  #nativeItemsTokens(items: readonly Record<string, unknown>[]): number {
    let tokens = 0;
    for (const item of items) {
      tokens += MESSAGE_OVERHEAD;
      tokens += this.#nativeContentTokens(item.content) + this.#nativeContentTokens(item.summary);
      for (const field of ["name", "arguments", "output"] as const) {
        if (typeof item[field] === "string") tokens += this.#textTokens(item[field]);
      }
      // encrypted_content, IDs and signatures are transport data, not text tokens.
      // Previously observed groups use actual output usage instead of this local count.
    }
    return tokens;
  }

  #messageTokens(message: Message): number {
    if (typeof message.content === "string") return MESSAGE_OVERHEAD + this.#textTokens(message.content);
    let tokens = MESSAGE_OVERHEAD;
    for (const part of message.content) {
      if (part.type === "text") tokens += this.#textTokens(part.text);
      else if (part.type === "image") tokens += imageTokens(part.data);
      else if (part.type === "thinking") tokens += this.#textTokens(part.thinking);
      else if (part.type === "toolCall") tokens += this.#textTokens(part.name) + this.#textTokens(JSON.stringify(part.arguments));
    }
    return tokens;
  }

  #measure(context: Context): ContextMeasurement {
    if (context === this.#lastContext && this.#lastMeasurement !== undefined) return this.#lastMeasurement;
    this.#usedText = new Map();
    let tokens = 0;
    for (const prompt of context.systemPrompt ?? []) tokens += MESSAGE_OVERHEAD + this.#textTokens(prompt);
    for (const tool of context.tools ?? []) {
      tokens += MESSAGE_OVERHEAD + this.#textTokens(tool.name) + this.#textTokens(tool.description) + this.#textTokens(JSON.stringify(tool.parameters));
    }
    // Match the provider's replacement-history semantics; never count discarded prefixes.
    let start = 0;
    let epoch = "initial";
    for (let index = context.messages.length - 1; index >= 0; index--) {
      const message = context.messages[index]!;
      if (message.role === "assistant" && message.providerPayload?.dt === false) {
        start = index;
        epoch = this.#nativeKey(message.providerPayload.items);
        break;
      }
    }
    const nativeKeys = new Set<string>();
    const unmeasuredNative: string[] = [];
    for (let index = start; index < context.messages.length; index++) {
      const message = context.messages[index]!;
      if (message.role === "assistant" && message.providerPayload !== undefined) {
        const items = message.providerPayload.items;
        const key = this.#nativeKey(items);
        nativeKeys.add(key);
        const observed = this.#nativeUsage.get(key);
        tokens += observed ?? this.#nativeItemsTokens(items);
        if (observed === undefined && items.some((item) => typeof item.encrypted_content === "string")) unmeasuredNative.push(key);
      } else {
        tokens += this.#messageTokens(message);
      }
    }
    this.#textCache = this.#usedText;
    this.#lastContext = context;
    this.#lastMeasurement = { localTokens: tokens, epoch, unmeasuredNative: unmeasuredNative.join(","), nativeKeys };
    return this.#lastMeasurement;
  }
}
