import type { Model, ModelProvider } from "@openai/agents-core";
import { ANTIGRAVITY_MODEL_NAME, OAuthAntigravityModel, type OAuthAntigravityModelOptions } from "./oauth-antigravity-model.ts";

export class OAuthAntigravityModelProvider implements ModelProvider {
  readonly #model: OAuthAntigravityModel;

  constructor(attemptSessionId: string, options: OAuthAntigravityModelOptions = {}) {
    this.#model = new OAuthAntigravityModel(attemptSessionId, options);
  }

  getModel(modelName: string = ANTIGRAVITY_MODEL_NAME): Model {
    if (modelName !== ANTIGRAVITY_MODEL_NAME) throw new Error(`Unsupported model: ${modelName}`);
    return this.#model;
  }
}
