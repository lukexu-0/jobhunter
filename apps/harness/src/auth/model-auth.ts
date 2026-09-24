import type { OAuthCredential } from "@oh-my-pi/pi-ai";

import {
  configureAuthDatabasePath,
  closeAuthStorage,
  getAuthStorage,
  type AuthStorageLike,
} from "./storage.ts";
import {
  resolveApplicationModel,
  type ApplicationModel,
} from "../models/application-model.ts";
import {
  ApplicationModelNameSchema,
  ApplicationModelProviderSchema,
  MirroredOAuthCredentialSchema,
  type ApplicationModelProvider,
  type MirroredOAuthCredential,
} from "../contracts/models.ts";

export class ModelAuthStore {
  readonly #storage: AuthStorageLike;
  #applicationModel: ApplicationModel = resolveApplicationModel();
  #closed = false;

  private constructor(storage: AuthStorageLike) {
    this.#storage = storage;
  }

  static async open(databasePath: string): Promise<ModelAuthStore> {
    configureAuthDatabasePath(databasePath);
    return new ModelAuthStore(await getAuthStorage());
  }

  async setCredential(
    unparsedProvider: ApplicationModelProvider,
    unparsedCredential: MirroredOAuthCredential,
  ): Promise<void> {
    this.#assertOpen();
    const provider = ApplicationModelProviderSchema.parse(unparsedProvider);
    const credential = MirroredOAuthCredentialSchema.parse(unparsedCredential);
    if (provider === "openai-codex" && credential.accountId === undefined) {
      throw new TypeError("OpenAI Codex OAuth credential requires accountId");
    }
    if (provider === "google-antigravity" && credential.projectId === undefined) {
      throw new TypeError("Google Antigravity OAuth credential requires projectId");
    }
    await this.#storage.set(provider, credential as OAuthCredential);
  }

  async deleteCredential(unparsedProvider: ApplicationModelProvider): Promise<void> {
    this.#assertOpen();
    const provider = ApplicationModelProviderSchema.parse(unparsedProvider);
    await this.#storage.logout(provider);
  }

  isConnected(unparsedProvider: ApplicationModelProvider): boolean {
    this.#assertOpen();
    const provider = ApplicationModelProviderSchema.parse(unparsedProvider);
    return this.#storage.listStoredCredentials(provider).length === 1;
  }

  setApplicationModel(model: string): void {
    this.#assertOpen();
    this.#applicationModel = resolveApplicationModel(ApplicationModelNameSchema.parse(model));
  }

  readApplicationModel(): ApplicationModel {
    this.#assertOpen();
    return this.#applicationModel;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await closeAuthStorage();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Model auth store is closed");
  }
}
