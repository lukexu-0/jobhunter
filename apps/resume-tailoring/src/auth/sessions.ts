import { randomBytes } from "node:crypto";
import type { OAuthController } from "@oh-my-pi/pi-ai/oauth";
import { assertProviderOAuthConnected, type AuthProvider, type AuthStorageLike } from "./storage";

const SESSION_TTL_MS = 10 * 60_000;
const TERMINAL_RETENTION_MS = 60_000;
const MAX_PROGRESS = 20;
const MAX_PROGRESS_LENGTH = 240;
const MAX_PROMPT_LENGTH = 1_000;
const MAX_ANSWER_LENGTH = 4_096;

type SessionState = "authenticating" | "prompt" | "succeeded" | "failed" | "cancelled" | "expired";
type TerminalState = Extract<SessionState, "succeeded" | "failed" | "cancelled" | "expired">;

export class AuthSessionError extends Error {
  constructor(
    readonly code: "AUTH_CONFLICT" | "SESSION_NOT_FOUND" | "INVALID_PROMPT" | "SESSION_TERMINAL",
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "AuthSessionError";
  }
}

export interface PendingPrompt {
  message: string;
  placeholder?: string;
  kind: "prompt" | "manual-code";
}

export interface PublicAuthSession {
  id: string;
  provider: AuthProvider;
  state: SessionState;
  expiresAt: number;
  launchUrl?: string;
  url?: string;
  instructions?: string;
  progress: string[];
  pendingPrompt?: PendingPrompt;
  error?: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface InternalSession extends PublicAuthSession {
  controller: AbortController;
  terminalAt?: number;
  promptDeferred?: Deferred<string>;
  startDeferred: Deferred<PublicAuthSession>;
}

export interface AuthSessionDependencies {
  now?: () => number;
  randomId?: () => string;
  schedule?: (callback: () => void, delayMs: number) => unknown;
}


function publicSession(session: InternalSession): PublicAuthSession {
  return {
    id: session.id,
    provider: session.provider,
    state: session.state,
    expiresAt: session.expiresAt,
    ...(session.launchUrl ? { launchUrl: session.launchUrl } : {}),
    ...(session.url ? { url: session.url } : {}),
    ...(session.instructions ? { instructions: session.instructions } : {}),
    progress: [...session.progress],
    ...(session.pendingPrompt ? { pendingPrompt: { ...session.pendingPrompt } } : {}),
    ...(session.error ? { error: session.error } : {}),
  };
}

function boundedPublicText(value: string, maximum: number): string {
  return value
    .replace(/(?:access|refresh|id)[_-]?token\s*[:=]\s*\S+/gi, "token=[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, maximum);
}

function terminalError(state: TerminalState): Error {
  const error = new Error(`OAuth session ${state}`);
  error.name = "AbortError";
  return error;
}

export class AuthSessionManager {
  readonly #sessions = new Map<string, InternalSession>();
  readonly #activeByProvider = new Map<AuthProvider, string>();
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;

  constructor(private readonly storage: AuthStorageLike, dependencies: AuthSessionDependencies = {}) {
    this.#now = dependencies.now ?? Date.now;
    this.#randomId = dependencies.randomId ?? (() => randomBytes(16).toString("base64url"));
    this.#schedule = dependencies.schedule ?? ((callback, delay) => setTimeout(callback, delay).unref());
  }

  start(provider: AuthProvider): Promise<PublicAuthSession> {
    this.sweep();
    if (this.#activeByProvider.has(provider)) {
      throw new AuthSessionError("AUTH_CONFLICT", `OAuth sign-in already active for ${provider}`, 409);
    }
    const id = this.#randomId();
    if (!/^[A-Za-z0-9_-]{22}$/.test(id) || this.#sessions.has(id)) {
      throw new Error("OAuth session ID generator did not return a unique 128-bit base64url value");
    }
    const now = this.#now();
    const session: InternalSession = {
      id,
      provider,
      state: "authenticating",
      expiresAt: now + SESSION_TTL_MS,
      progress: [],
      controller: new AbortController(),
      startDeferred: Promise.withResolvers<PublicAuthSession>(),
    };
    this.#sessions.set(id, session);
    this.#activeByProvider.set(provider, id);
    this.#schedule(() => this.sweep(), SESSION_TTL_MS);
    void this.#runLogin(session);
    return session.startDeferred.promise;
  }

  get(id: string): PublicAuthSession {
    this.sweep();
    const session = this.#sessions.get(id);
    if (!session) throw new AuthSessionError("SESSION_NOT_FOUND", "OAuth session not found", 404);
    return publicSession(session);
  }

  answer(id: string, value: string): PublicAuthSession {
    this.sweep();
    const session = this.#sessions.get(id);
    if (!session) throw new AuthSessionError("SESSION_NOT_FOUND", "OAuth session not found", 404);
    if (!session.pendingPrompt || !session.promptDeferred) {
      throw new AuthSessionError("INVALID_PROMPT", "OAuth session is not waiting for input", 409);
    }
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_ANSWER_LENGTH) {
      throw new AuthSessionError("INVALID_PROMPT", "OAuth prompt answer is invalid", 400);
    }
    const pending = session.promptDeferred;
    delete session.pendingPrompt;
    delete session.promptDeferred;
    session.state = "authenticating";
    pending.resolve(value);
    return publicSession(session);
  }

  cancel(id: string): PublicAuthSession {
    this.sweep();
    const session = this.#sessions.get(id);
    if (!session) throw new AuthSessionError("SESSION_NOT_FOUND", "OAuth session not found", 404);
    if (session.terminalAt !== undefined) {
      throw new AuthSessionError("SESSION_TERMINAL", "OAuth session has already finished", 409);
    }
    this.#finish(session, "cancelled");
    return publicSession(session);
  }

  shutdown(): void {
    for (const session of this.#sessions.values()) {
      if (session.terminalAt === undefined) this.#finish(session, "cancelled");
    }
  }

  sweep(): void {
    const now = this.#now();
    for (const session of this.#sessions.values()) {
      if (session.terminalAt === undefined && now >= session.expiresAt) this.#finish(session, "expired");
      if (session.terminalAt !== undefined && now - session.terminalAt >= TERMINAL_RETENTION_MS) {
        this.#sessions.delete(session.id);
      }
    }
  }

  async #runLogin(session: InternalSession): Promise<void> {
    try {
      const controller = {
        signal: session.controller.signal,
        onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
          if (session.terminalAt !== undefined) return;
          session.url = info.url;
          if (info.launchUrl) session.launchUrl = info.launchUrl;
          else delete session.launchUrl;
          if (info.instructions) {
            session.instructions = boundedPublicText(info.instructions, MAX_PROGRESS_LENGTH * 2);
          } else {
            delete session.instructions;
          }
          session.startDeferred.resolve(publicSession(session));
        },
        onProgress: (message: string) => {
          if (session.terminalAt !== undefined) return;
          session.progress.push(boundedPublicText(message, MAX_PROGRESS_LENGTH));
          if (session.progress.length > MAX_PROGRESS) session.progress.shift();
        },
        onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => this.#requestPrompt(session, {
          message: boundedPublicText(prompt.message, MAX_PROMPT_LENGTH),
          ...(prompt.placeholder ? { placeholder: boundedPublicText(prompt.placeholder, 120) } : {}),
          kind: "prompt",
        }),
        onManualCodeInput: () => this.#requestPrompt(session, {
          message: "Enter the authorization code",
          kind: "manual-code",
        }),
      } satisfies OAuthController;

      await this.storage.login(session.provider, controller);
      assertProviderOAuthConnected(this.storage, session.provider);
      if (session.terminalAt === undefined) this.#finish(session, "succeeded");
    } catch {
      if (session.terminalAt !== undefined) return;
      this.#finish(session, "failed", "OAuth sign-in failed");
    }
  }

  #requestPrompt(session: InternalSession, prompt: PendingPrompt): Promise<string> {
    if (session.terminalAt !== undefined) return Promise.reject(terminalError(session.state as TerminalState));
    if (session.promptDeferred) return Promise.reject(new Error("OAuth provider requested overlapping prompts"));
    const answer = Promise.withResolvers<string>();
    session.promptDeferred = answer;
    session.pendingPrompt = prompt;
    session.state = "prompt";
    return answer.promise;
  }

  #finish(session: InternalSession, state: TerminalState, error?: string): void {
    session.state = state;
    session.terminalAt = this.#now();
    if (error) session.error = boundedPublicText(error, MAX_PROGRESS_LENGTH);
    else delete session.error;
    delete session.pendingPrompt;
    session.controller.abort(terminalError(state));
    session.promptDeferred?.reject(terminalError(state));
    delete session.promptDeferred;
    if (this.#activeByProvider.get(session.provider) === session.id) this.#activeByProvider.delete(session.provider);
    session.startDeferred.resolve(publicSession(session));
    this.#schedule(() => this.sweep(), TERMINAL_RETENTION_MS);
  }
}
