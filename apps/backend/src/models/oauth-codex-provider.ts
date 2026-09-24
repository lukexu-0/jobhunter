import type { Model, ModelProvider } from "@openai/agents-core";
import { MODEL_NAME, OAuthCodexModel, type OAuthCodexModelOptions } from "./oauth-codex-model";

export class OAuthCodexModelProvider implements ModelProvider {
  readonly #model: OAuthCodexModel;

  constructor(attemptSessionId: string, options: OAuthCodexModelOptions = {}) {
    this.#model = new OAuthCodexModel(attemptSessionId, options);
  }

  getModel(modelName?: string): Model {
    if (modelName !== MODEL_NAME) throw new Error(`Unsupported model: ${String(modelName)}`);
    return this.#model;
  }
}
