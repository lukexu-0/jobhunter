"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiErrorSchema,
  AuthSessionSchema,
  AuthStatusResponseSchema,
  type AuthSession,
  type AuthStatusResponse,
  type OAuthProvider,
} from "@jobhunter/pipeline/contracts";

const AUTH_ROOT = "/api/pipeline/auth";
const POLL_INTERVAL_MS = 2_500;
const MAX_PUBLIC_TEXT_LENGTH = 480;

const PROVIDERS = [
  {
    provider: "openai-codex",
    name: "OpenAI Codex",
    description: "OAuth access for the tailoring agent.",
  },
  {
    provider: "google-antigravity",
    name: "Google Antigravity",
    description: "OAuth access for visual document inspection.",
  },
] as const satisfies ReadonlyArray<{
  provider: OAuthProvider;
  name: string;
  description: string;
}>;

type BrowserAuthSession = AuthSession & { url?: string };
type Notice = { tone: "error" | "info" | "success"; text: string };
type BusyAction = "connect" | "logout" | "cancel" | "prompt";
type ProviderMap<T> = Partial<Record<OAuthProvider, T>>;

function redactPublicText(value: string): string {
  return value
    .replace(/\b(?:access|refresh|id)[_-]?token\b\s*[:=]\s*[^\s,;]+/gi, "credential=[redacted]")
    .replace(/\b(?:api[_-]?key|authorization)\b\s*[:=]\s*[^\s,;]+/gi, "credential=[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/([?&](?:access_token|refresh_token|id_token|code)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, MAX_PUBLIC_TEXT_LENGTH);
}

function apiMessage(value: unknown): string {
  const parsed = ApiErrorSchema.safeParse(value);
  return parsed.success ? redactPublicText(parsed.data.error.message) : "The request could not be completed.";
}

async function readResponseJson(response: Response): Promise<unknown> {
  let value: unknown;

  try {
    value = await response.json();
  } catch {
    throw new Error("The service returned an unreadable response.");
  }

  if (!response.ok) throw new Error(apiMessage(value));
  return value;
}

function parseAuthSession(value: unknown): BrowserAuthSession | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const { url, ...sessionValue } = value as Record<string, unknown>;
  const parsed = AuthSessionSchema.safeParse(sessionValue);
  if (!parsed.success) return null;

  return typeof url === "string" ? { ...parsed.data, url } : parsed.data;
}

function launchTarget(session: BrowserAuthSession): string | undefined {
  const candidate = session.launchUrl ?? session.url;
  if (!candidate) return undefined;

  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function terminalMessage(state: AuthSession["state"]): string | null {
  switch (state) {
    case "succeeded":
      return "Authorization completed. The provider connection was refreshed.";
    case "failed":
      return "Authorization did not complete. Start a new connection to try again.";
    case "cancelled":
      return "Authorization was cancelled.";
    case "expired":
      return "Authorization expired. Start a new connection to continue.";
    default:
      return null;
  }
}

export function OAuthDashboard() {
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ProviderMap<BrowserAuthSession>>({});
  const [notices, setNotices] = useState<ProviderMap<Notice>>({});
  const [busy, setBusy] = useState<ProviderMap<BusyAction>>({});
  const [promptValues, setPromptValues] = useState<ProviderMap<string>>({});

  const refreshAuthStatus = useCallback(async () => {
    setIsLoadingStatus(true);

    try {
      const response = await fetch(AUTH_ROOT, { cache: "no-store" });
      const value = await readResponseJson(response);
      const parsed = AuthStatusResponseSchema.safeParse(value);
      if (!parsed.success) throw new Error("The service returned an invalid connection status.");

      setAuthStatus(parsed.data);
      setStatusError(null);
    } catch (error) {
      setAuthStatus(null);
      setStatusError(error instanceof Error ? redactPublicText(error.message) : "Connection status is unavailable.");
    } finally {
      setIsLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void refreshAuthStatus();
  }, [refreshAuthStatus]);

  const statusByProvider = useMemo(
    () => new Map(authStatus?.providers.map((status) => [status.provider, status]) ?? []),
    [authStatus],
  );

  const updateSession = useCallback((session: BrowserAuthSession) => {
    setSessions((current) => ({ ...current, [session.provider]: session }));
  }, []);

  const setNotice = useCallback((provider: OAuthProvider, notice: Notice | undefined) => {
    setNotices((current) => {
      const next = { ...current };
      if (notice) next[provider] = notice;
      else delete next[provider];
      return next;
    });
  }, []);

  const setBusyAction = useCallback((provider: OAuthProvider, action: BusyAction | undefined) => {
    setBusy((current) => {
      const next = { ...current };
      if (action) next[provider] = action;
      else delete next[provider];
      return next;
    });
  }, []);

  useEffect(() => {
    const pendingSessions = Object.values(sessions).filter(
      (session): session is BrowserAuthSession => session?.state === "pending",
    );
    if (pendingSessions.length === 0) return;

    const controller = new AbortController();
    let current = true;

    const poll = async () => {
      await Promise.all(
        pendingSessions.map(async (session) => {
          try {
            const response = await fetch(`${AUTH_ROOT}/sessions/${encodeURIComponent(session.id)}`, {
              cache: "no-store",
              signal: controller.signal,
            });
            const value = await readResponseJson(response);
            const nextSession = parseAuthSession(value);
            if (!nextSession) throw new Error("The service returned an invalid authorization session.");
            if (!current) return;

            updateSession(nextSession);
            if (nextSession.state === "succeeded") {
              await refreshAuthStatus();
            }
          } catch (error) {
            if (!current || controller.signal.aborted) return;
            setNotice(session.provider, {
              tone: "error",
              text: error instanceof Error ? redactPublicText(error.message) : "Authorization status is unavailable.",
            });
          }
        }),
      );
    };

    void poll();
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      current = false;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refreshAuthStatus, sessions, setNotice, updateSession]);

  const startSession = useCallback(
    async (provider: OAuthProvider) => {
      setBusyAction(provider, "connect");
      setNotice(provider, undefined);

      try {
        const response = await fetch(`${AUTH_ROOT}/${provider}/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const value = await readResponseJson(response);
        const session = parseAuthSession(value);
        if (!session) throw new Error("The service returned an invalid authorization session.");

        updateSession(session);
        const target = launchTarget(session);
        if (target) {
          const authWindow = window.open(target, "_blank", "noopener,noreferrer");
          setNotice(provider, {
            tone: authWindow ? "info" : "error",
            text: authWindow
              ? "Sign-in opened in a new tab. Return here when authorization is complete."
              : "Your browser blocked the sign-in window. Use the Open sign-in link below.",
          });
        } else {
          setNotice(provider, { tone: "info", text: "Connection session started. Follow the instructions below." });
        }

        if (session.state === "succeeded") await refreshAuthStatus();
      } catch (error) {
        setNotice(provider, {
          tone: "error",
          text: error instanceof Error ? redactPublicText(error.message) : "The connection could not be started.",
        });
      } finally {
        setBusyAction(provider, undefined);
      }
    },
    [refreshAuthStatus, setBusyAction, setNotice, updateSession],
  );

  const cancelSession = useCallback(
    async (session: BrowserAuthSession) => {
      setBusyAction(session.provider, "cancel");
      setNotice(session.provider, undefined);

      try {
        const response = await fetch(`${AUTH_ROOT}/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
        const value = await readResponseJson(response);
        const cancelled = parseAuthSession(value);
        if (!cancelled) throw new Error("The service returned an invalid authorization session.");

        updateSession(cancelled);
        setNotice(session.provider, { tone: "info", text: "Authorization was cancelled." });
      } catch (error) {
        setNotice(session.provider, {
          tone: "error",
          text: error instanceof Error ? redactPublicText(error.message) : "The session could not be cancelled.",
        });
      } finally {
        setBusyAction(session.provider, undefined);
      }
    },
    [setBusyAction, setNotice, updateSession],
  );

  const answerPrompt = useCallback(
    async (session: BrowserAuthSession) => {
      const value = promptValues[session.provider]?.trim() ?? "";
      if (!value) return;

      setBusyAction(session.provider, "prompt");
      setNotice(session.provider, undefined);

      try {
        const response = await fetch(`${AUTH_ROOT}/sessions/${encodeURIComponent(session.id)}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        });
        const responseValue = await readResponseJson(response);
        const updated = parseAuthSession(responseValue);
        if (!updated) throw new Error("The service returned an invalid authorization session.");

        updateSession(updated);
        setPromptValues((current) => ({ ...current, [session.provider]: "" }));
        setNotice(session.provider, { tone: "info", text: "Response submitted. Waiting for authorization to continue." });
      } catch (error) {
        setNotice(session.provider, {
          tone: "error",
          text: error instanceof Error ? redactPublicText(error.message) : "The response could not be submitted.",
        });
      } finally {
        setBusyAction(session.provider, undefined);
      }
    },
    [promptValues, setBusyAction, setNotice, updateSession],
  );

  const logout = useCallback(
    async (provider: OAuthProvider) => {
      setBusyAction(provider, "logout");
      setNotice(provider, undefined);

      try {
        const response = await fetch(`${AUTH_ROOT}/${provider}`, { method: "DELETE" });
        if (!response.ok) {
          let value: unknown = null;
          try {
            value = await response.json();
          } catch {
            // The public response is optional for a bodyless DELETE.
          }
          throw new Error(apiMessage(value));
        }

        setSessions((current) => {
          const next = { ...current };
          delete next[provider];
          return next;
        });
        await refreshAuthStatus();
        setNotice(provider, { tone: "success", text: "Provider connection removed." });
      } catch (error) {
        setNotice(provider, {
          tone: "error",
          text: error instanceof Error ? redactPublicText(error.message) : "The provider could not be disconnected.",
        });
      } finally {
        setBusyAction(provider, undefined);
      }
    },
    [refreshAuthStatus, setBusyAction, setNotice],
  );

  return (
    <section className="oauth-dashboard" aria-labelledby="oauth-heading">
      <div className="section-heading">
        <div>
          <p className="kicker">Authorization</p>
          <h2 id="oauth-heading">Provider access</h2>
        </div>
        <p className="section-caption">Connect local OAuth accounts before creating a tailoring run.</p>
      </div>

      {statusError ? (
        <p className="dashboard-notice dashboard-notice--error" role="alert">
          {statusError}
        </p>
      ) : null}

      <div className="provider-table" aria-busy={isLoadingStatus}>
        <div className="provider-table__head" aria-hidden="true">
          <span>Provider</span>
          <span>Connection</span>
          <span>Action</span>
        </div>

        <ul className="provider-list" aria-label="OAuth providers">
          {PROVIDERS.map((provider) => {
            const providerStatus = statusByProvider.get(provider.provider);
            const session = sessions[provider.provider];
            const action = busy[provider.provider];
            const notice = notices[provider.provider];
            const isPending = session?.state === "pending";
            const isConnected = providerStatus?.state === "connected";
            const statusLabel = isLoadingStatus ? "Checking" : providerStatus?.state ?? "Unavailable";
            const identity = providerStatus?.identity?.email ?? providerStatus?.identity?.accountId ?? providerStatus?.identity?.projectId;

            return (
              <li className="provider-row" key={provider.provider}>
                <div className="provider-identity">
                  <p className="provider-identity__name">{provider.name}</p>
                  <p className="provider-identity__id">{provider.provider}</p>
                  <p className="provider-identity__description">{provider.description}</p>
                </div>

                <div className="provider-connection">
                  <span className={`status-badge status-badge--${statusLabel.toLowerCase()}`}>{statusLabel}</span>
                  {identity ? <span className="provider-account">{redactPublicText(identity)}</span> : null}
                </div>

                <div className="provider-actions">
                  {isConnected ? (
                    <button
                      className="control control--quiet"
                      type="button"
                      onClick={() => void logout(provider.provider)}
                      disabled={Boolean(action) || isPending}
                    >
                      {action === "logout" ? "Disconnecting…" : "Logout"}
                    </button>
                  ) : (
                    <button
                      className="control control--primary"
                      type="button"
                      onClick={() => void startSession(provider.provider)}
                      disabled={isLoadingStatus || Boolean(action) || isPending || Boolean(statusError)}
                    >
                      {action === "connect" ? "Connecting…" : "Connect"}
                    </button>
                  )}
                </div>

                {session ? (
                  <SessionDetail
                    session={session}
                    busyAction={action}
                    promptValue={promptValues[provider.provider] ?? ""}
                    onPromptValueChange={(value) =>
                      setPromptValues((current) => ({ ...current, [provider.provider]: value }))
                    }
                    onAnswerPrompt={() => void answerPrompt(session)}
                    onCancel={() => void cancelSession(session)}
                  />
                ) : null}

                {notice ? (
                  <p
                    className={`dashboard-notice dashboard-notice--${notice.tone}`}
                    role={notice.tone === "error" ? "alert" : "status"}
                  >
                    {notice.text}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      <p className="oauth-footnote">Credentials stay in the local pipeline service. This workspace never displays access or refresh tokens.</p>
    </section>
  );
}

function SessionDetail({
  session,
  busyAction,
  promptValue,
  onPromptValueChange,
  onAnswerPrompt,
  onCancel,
}: {
  session: BrowserAuthSession;
  busyAction: BusyAction | undefined;
  promptValue: string;
  onPromptValueChange: (value: string) => void;
  onAnswerPrompt: () => void;
  onCancel: () => void;
}) {
  const target = launchTarget(session);
  const terminal = terminalMessage(session.state);
  const promptId = `oauth-prompt-${session.provider}`;
  const isPending = session.state === "pending";

  return (
    <div className="oauth-session" aria-live="polite">
      <div className="oauth-session__summary">
        <p className="kicker">Authorization session</p>
        {session.instructions ? <p className="oauth-session__instructions">{redactPublicText(session.instructions)}</p> : null}
        {target ? (
          <a className="control control--link" href={target} target="_blank" rel="noreferrer">
            Open sign-in <span aria-hidden="true">↗</span>
          </a>
        ) : null}
      </div>

      {isPending ? (
        <div className="oauth-session__activity">
          <p className="activity-label">Progress</p>
          {session.progress.length > 0 ? (
            <ol className="progress-list">
              {session.progress.map((item, index) => (
                <li key={`${index}-${item}`}>{redactPublicText(item)}</li>
              ))}
            </ol>
          ) : (
            <p className="activity-empty">Waiting for browser authorization.</p>
          )}
        </div>
      ) : null}

      {isPending && session.prompt ? (
        <form
          className="prompt-form"
          onSubmit={(event) => {
            event.preventDefault();
            onAnswerPrompt();
          }}
        >
          <label htmlFor={promptId}>{redactPublicText(session.prompt.message)}</label>
          <div className="prompt-form__controls">
            <input
              id={promptId}
              value={promptValue}
              onChange={(event) => onPromptValueChange(event.target.value)}
              placeholder={session.prompt.placeholder ? redactPublicText(session.prompt.placeholder) : "Enter response"}
              autoComplete={session.prompt.kind === "manual-code" ? "one-time-code" : "off"}
              maxLength={8_192}
              disabled={Boolean(busyAction)}
              required
            />
            <button className="control control--primary" type="submit" disabled={Boolean(busyAction) || !promptValue.trim()}>
              {busyAction === "prompt" ? "Sending…" : "Submit"}
            </button>
          </div>
        </form>
      ) : null}

      <div className="oauth-session__footer">
        {terminal ? (
          <p className={`terminal-feedback terminal-feedback--${session.state}`} role={session.state === "failed" ? "alert" : "status"}>
            {terminal}
          </p>
        ) : null}
        {isPending ? (
          <button className="control control--quiet" type="button" onClick={onCancel} disabled={Boolean(busyAction)}>
            {busyAction === "cancel" ? "Cancelling…" : "Cancel"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
