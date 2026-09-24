import {
  answerAuthPrompt,
  cancelAuthSession,
  disconnectAuthProvider,
  getApplicationModel,
  getAuthSession,
  getAuthStatus,
  PipelineClientError,
  setApplicationModel,
  startAuthSession,
} from "./pipeline-client";
import type { ApplicationModelId, AuthProvider, AuthSession, AuthStatusResponse } from "./pipeline-contracts";

const http = {
  answerAuthPrompt, cancelAuthSession, disconnectAuthProvider, getApplicationModel,
  getAuthSession, getAuthStatus, setApplicationModel, startAuthSession,
};
export type AuthorizationTransport = typeof http;
export type AuthorizationNotice = Readonly<{ tone: "error" | "info" | "success"; text: string }>;
export type AuthorizationAction = "connect" | "logout" | "cancel" | "prompt" | "model";
type ProviderMap<T> = Partial<Record<AuthProvider, T>>;
type RequestOwner = { controller: AbortController; cancelTimer?: () => void; pollNotice?: AuthorizationNotice };

export interface AuthorizationSnapshot {
  readonly authStatus: AuthStatusResponse | undefined;
  readonly isLoadingStatus: boolean;
  readonly statusError: string | null;
  readonly sessions: Readonly<ProviderMap<AuthSession>>;
  readonly notices: Readonly<ProviderMap<AuthorizationNotice | undefined>>;
  readonly busy: Readonly<ProviderMap<AuthorizationAction | undefined>>;
  readonly applicationModel: ApplicationModelId | undefined;
  readonly isLoadingApplicationModel: boolean;
  readonly applicationModelError: string | null;
}

function safeError(error: unknown, fallback: string): string {
  return error instanceof PipelineClientError ? error.message : fallback;
}

export class AuthorizationSession {
  readonly #http: AuthorizationTransport;
  readonly #schedule: (callback: () => void, delay: number) => () => void;
  readonly #listeners = new Set<() => void>();
  readonly #providers: ProviderMap<RequestOwner> = {};
  #statusRequest: AbortController | undefined;
  #modelRequest: AbortController | undefined;
  #active = false;
  #snapshot: AuthorizationSnapshot;

  constructor(options: {
    initialStatus?: AuthStatusResponse;
    transport?: AuthorizationTransport;
    schedule?: (callback: () => void, delay: number) => () => void;
  } = {}) {
    this.#http = options.transport ?? http;
    this.#schedule = options.schedule ?? ((callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    });
    this.#snapshot = {
      authStatus: options.initialStatus,
      isLoadingStatus: options.initialStatus === undefined,
      statusError: null,
      sessions: {}, notices: {}, busy: {},
      applicationModel: undefined,
      isLoadingApplicationModel: true,
      applicationModelError: null,
    };
  }

  getSnapshot = (): AuthorizationSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  start = (): void => {
    if (this.#active) return;
    this.#active = true;
    if (Object.values(this.#snapshot.busy).some(Boolean)) this.#publish({ busy: {} });
    void this.refreshStatus();
    void this.refreshModel();
    for (const session of Object.values(this.#snapshot.sessions)) {
      const owner = this.#ownProvider(session.provider);
      this.#resumePolling(session.provider, owner);
    }
  };

  stop = (): void => {
    this.#active = false;
    this.#statusRequest?.abort();
    this.#modelRequest?.abort();
    for (const provider of Object.keys(this.#providers) as AuthProvider[]) {
      this.#providers[provider]?.controller.abort();
      this.#providers[provider]?.cancelTimer?.();
      delete this.#providers[provider];
    }
  };

  #publish(patch: Partial<AuthorizationSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }

  notice = (provider: AuthProvider, notice: AuthorizationNotice | undefined): void => {
    if (this.#active) this.#publish({ notices: { ...this.#snapshot.notices, [provider]: notice } });
  };

  #busy(provider: AuthProvider, action: AuthorizationAction | undefined): void {
    this.#publish({ busy: { ...this.#snapshot.busy, [provider]: action } });
  }

  #ownProvider(provider: AuthProvider): RequestOwner {
    this.#providers[provider]?.controller.abort();
    this.#providers[provider]?.cancelTimer?.();
    const owner = { controller: new AbortController() };
    this.#providers[provider] = owner;
    return owner;
  }

  #owns(provider: AuthProvider, owner: RequestOwner): boolean {
    return this.#active && this.#providers[provider] === owner && !owner.controller.signal.aborted;
  }

  refreshStatus = async (): Promise<void> => {
    if (!this.#active) return;
    this.#statusRequest?.abort();
    const controller = new AbortController();
    this.#statusRequest = controller;
    try {
      const authStatus = await this.#http.getAuthStatus(controller.signal);
      if (this.#active && this.#statusRequest === controller && !controller.signal.aborted) {
        this.#publish({ authStatus, statusError: null, isLoadingStatus: false });
      }
    } catch (error) {
      if (this.#active && this.#statusRequest === controller && !controller.signal.aborted) {
        this.#publish({ statusError: safeError(error, "Connection status is unavailable."), isLoadingStatus: false });
      }
    }
  };

  refreshModel = async (): Promise<void> => {
    if (!this.#active) return;
    this.#modelRequest?.abort();
    const controller = new AbortController();
    this.#modelRequest = controller;
    this.#publish({ isLoadingApplicationModel: true });
    try {
      const { model } = await this.#http.getApplicationModel(controller.signal);
      if (this.#active && this.#modelRequest === controller && !controller.signal.aborted) {
        this.#publish({ applicationModel: model, applicationModelError: null, isLoadingApplicationModel: false });
      }
    } catch (error) {
      if (this.#active && this.#modelRequest === controller && !controller.signal.aborted) {
        this.#publish({ applicationModelError: safeError(error, "The application model is unavailable."), isLoadingApplicationModel: false });
      }
    }
  };

  #install(session: AuthSession): void {
    this.#publish({ sessions: { ...this.#snapshot.sessions, [session.provider]: session } });
    if (session.state === "succeeded") void this.refreshStatus();
  }

  #resumePolling(provider: AuthProvider, owner: RequestOwner): void {
    const session = this.#snapshot.sessions[provider];
    if (!this.#owns(provider, owner) || session?.state !== "pending") return;
    owner.cancelTimer = this.#schedule(() => { void this.#poll(session, owner); }, 2_500);
  }

  async #poll(session: AuthSession, owner: RequestOwner): Promise<void> {
    if (!this.#owns(session.provider, owner)) return;
    try {
      const next = await this.#http.getAuthSession(session.id, owner.controller.signal);
      if (!this.#owns(session.provider, owner)) return;
      if (next.id !== session.id || next.provider !== session.provider) {
        throw new PipelineClientError("The pipeline returned an invalid response.", "INVALID_RESPONSE");
      }
      if (owner.pollNotice && this.#snapshot.notices[session.provider] === owner.pollNotice) {
        this.notice(session.provider, undefined);
      }
      owner.pollNotice = undefined;
      this.#install(next);
    } catch (error) {
      if (!this.#owns(session.provider, owner)) return;
      owner.pollNotice = { tone: "error", text: safeError(error, "Authorization status is unavailable.") };
      this.notice(session.provider, owner.pollNotice);
    } finally {
      this.#resumePolling(session.provider, owner);
    }
  }

  connect = async (provider: AuthProvider): Promise<AuthSession | undefined> => {
    if (!this.#active) return;
    const owner = this.#ownProvider(provider);
    this.#busy(provider, "connect");
    this.notice(provider, undefined);
    try {
      const session = await this.#http.startAuthSession(provider, owner.controller.signal);
      if (!this.#owns(provider, owner)) return;
      if (session.provider !== provider) throw new PipelineClientError("The pipeline returned an invalid response.", "INVALID_RESPONSE");
      this.#install(session);
      return session;
    } catch (error) {
      if (this.#owns(provider, owner)) this.notice(provider, { tone: "error", text: safeError(error, "The connection could not be started.") });
    } finally {
      if (this.#owns(provider, owner)) {
        this.#busy(provider, undefined);
        this.#resumePolling(provider, owner);
      }
    }
  };
  cancel = (session: AuthSession): Promise<AuthSession | undefined> => this.#changeSession(session, "cancel");

  answer = (session: AuthSession, value: string): Promise<AuthSession | undefined> => {
    const answer = value.trim();
    if (!answer) return Promise.resolve(undefined);
    return this.#changeSession(session, "prompt", answer);
  };

  async #changeSession(session: AuthSession, action: "cancel" | "prompt", value?: string): Promise<AuthSession | undefined> {
    if (!this.#active || this.#snapshot.sessions[session.provider]?.id !== session.id) return;
    const provider = session.provider;
    const owner = this.#ownProvider(provider);
    this.#busy(provider, action);
    this.notice(provider, undefined);
    try {
      const next = action === "cancel"
        ? await this.#http.cancelAuthSession(session.id, owner.controller.signal)
        : await this.#http.answerAuthPrompt(session.id, value!, owner.controller.signal);
      if (!this.#owns(provider, owner)) return;
      if (next.id !== session.id || next.provider !== provider) throw new PipelineClientError("The pipeline returned an invalid response.", "INVALID_RESPONSE");
      this.#install(next);
      if (action === "prompt") this.notice(provider, { tone: "info", text: "Response submitted. Waiting for authorization to continue." });
      return next;
    } catch (error) {
      if (this.#owns(provider, owner)) this.notice(provider, {
        tone: "error",
        text: safeError(error, action === "cancel" ? "The session could not be cancelled." : "The response could not be submitted."),
      });
    } finally {
      if (this.#owns(provider, owner)) {
        this.#busy(provider, undefined);
        this.#resumePolling(provider, owner);
      }
    }
  }

  disconnect = async (provider: AuthProvider): Promise<void> => {
    if (!this.#active) return;
    const owner = this.#ownProvider(provider);
    this.#statusRequest?.abort();
    this.#busy(provider, "logout");
    this.notice(provider, undefined);
    try {
      await this.#http.disconnectAuthProvider(provider, owner.controller.signal);
      if (!this.#owns(provider, owner)) return;
      const sessions = { ...this.#snapshot.sessions };
      delete sessions[provider];
      this.#publish({ sessions });
      await this.refreshStatus();
      if (this.#owns(provider, owner)) this.notice(provider, { tone: "success", text: "Credential removed." });
    } catch (error) {
      if (this.#owns(provider, owner)) this.notice(provider, { tone: "error", text: safeError(error, "The credential could not be disconnected.") });
    } finally {
      if (this.#owns(provider, owner)) {
        this.#busy(provider, undefined);
        this.#resumePolling(provider, owner);
      }
    }
  };

  selectModel = async (model: ApplicationModelId): Promise<void> => {
    if (!this.#active) return;
    const provider = "google-antigravity";
    const owner = this.#ownProvider(provider);
    this.#modelRequest?.abort();
    this.#publish({ isLoadingApplicationModel: false, applicationModelError: null });
    this.#busy(provider, "model");
    this.notice(provider, undefined);
    try {
      const selection = await this.#http.setApplicationModel(model, owner.controller.signal);
      if (!this.#owns(provider, owner)) return;
      this.#publish({ applicationModel: selection.model, applicationModelError: null });
      this.notice(provider, {
        tone: "success",
        text: selection.model === "gemini-3.8-flash"
          ? "Application agent switched to Google Antigravity 3.8 Flash."
          : "Application agent switched to OpenAI Codex.",
      });
    } catch (error) {
      if (this.#owns(provider, owner)) this.notice(provider, { tone: "error", text: safeError(error, "The application model could not be changed.") });
    } finally {
      if (this.#owns(provider, owner)) {
        this.#busy(provider, undefined);
        this.#resumePolling(provider, owner);
      }
    }
  };
}
