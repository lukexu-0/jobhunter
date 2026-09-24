"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AuthProvider, AuthSession } from "../lib/pipeline-contracts";
import { AuthorizationSession, type AuthorizationAction } from "../lib/authorization-session";
import { useDashboardData } from "../credentials/dashboard-data-provider";
import controlStyles from "./alert-controls.module.css";

const MAX_PUBLIC_TEXT_LENGTH = 480;

const PROVIDERS = [
  {
    provider: "openai-codex",
    name: "OpenAI Codex",
    description: "Résumé workflows and the default application agent.",
  },
  {
    provider: "google-antigravity",
    name: "Google Antigravity",
    description: "Application agent access for Gemini 3.8 Flash.",
  },
  {
    provider: "gmail",
    name: "Gmail",
    description: "Application verification emails. Separate from model access.",
  },
] as const satisfies ReadonlyArray<{
  provider: AuthProvider;
  name: string;
  description: string;
}>;

type BusyAction = AuthorizationAction;
type ProviderMap<T> = Partial<Record<AuthProvider, T>>;

function closeAuthWindow(authWindow: Window | null): void {
  if (!authWindow || authWindow.closed) return;

  try {
    authWindow.close();
  } catch {
    // The browser owns the reserved tab once it stops being same-origin.
  }
}

function reserveAuthWindow(): Window | null {
  let authWindow: Window | null = null;
  const width = 620;
  const height = 760;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
  const features = [
    "popup=yes",
    `width=${width}`,
    `height=${height}`,
    `left=${left}`,
    `top=${top}`,
    "resizable=yes",
    "scrollbars=yes",
  ].join(",");

  try {
    authWindow = window.open("", "_blank", features);
    if (!authWindow) return null;

    authWindow.opener = null;
    const referrerPolicy = authWindow.document.createElement("meta");
    referrerPolicy.name = "referrer";
    referrerPolicy.content = "no-referrer";
    authWindow.document.head.append(referrerPolicy);
    return authWindow;
  } catch {
    closeAuthWindow(authWindow);
    return null;
  }
}

function navigateAuthWindow(authWindow: Window, target: string): boolean {
  if (authWindow.closed) return false;

  try {
    const link = authWindow.document.createElement("a");
    link.href = target;
    link.target = "_self";
    link.rel = "noreferrer";
    link.referrerPolicy = "no-referrer";
    (authWindow.document.body ?? authWindow.document.documentElement).append(link);
    link.click();
    return true;
  } catch {
    closeAuthWindow(authWindow);
    return false;
  }
}

function redactPublicText(value: string): string {
  return value
    .replace(
      /"((?:(?:access|refresh|id)[_-]?token|api[_-]?key|authorization(?:[_\s-]?code)?|callback(?:[_\s-]?(?:code|token))?|code|state))"\s*:\s*"(?:\\.|[^"\\])*"/gi,
      '"$1":"[redacted]"',
    )
    .replace(/\b(?:access|refresh|id)[_-]?token\b\s*[:=]\s*[^\s,;]+/gi, "credential=[redacted]")
    .replace(/\b(?:api[_-]?key|authorization)\b\s*[:=]\s*[^\s,;]+/gi, "credential=[redacted]")
    .replace(
      /\b(?:authorization[_\s-]?code|callback(?:[_\s-]?(?:code|token))?|code|state)\b\s*[:=]\s*[^\s,;]+/gi,
      "credential=[redacted]",
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/([?&](?:access_token|refresh_token|id_token|code|state)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, MAX_PUBLIC_TEXT_LENGTH);
}

function launchTarget(session: AuthSession): string | undefined {
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
      return "Authorization completed. The credential was refreshed.";
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
  const { authStatus, setAuthStatus } = useDashboardData();
  const [authorization] = useState(() => new AuthorizationSession({ initialStatus: authStatus }));
  const {
    isLoadingStatus, statusError, sessions, notices, busy, applicationModel,
    isLoadingApplicationModel, applicationModelError, authStatus: latestStatus,
  } = useSyncExternalStore(authorization.subscribe, authorization.getSnapshot, authorization.getSnapshot);
  const [promptValues, setPromptValues] = useState<ProviderMap<string>>({});
  const lifetime = useRef(0);
  const reservedWindows = useRef(new Set<Window>());

  useEffect(() => {
    const windows = reservedWindows.current;
    authorization.start();
    return () => {
      lifetime.current += 1;
      authorization.stop();
      for (const authWindow of windows) closeAuthWindow(authWindow);
      windows.clear();
    };
  }, [authorization]);

  useEffect(() => {
    if (latestStatus) setAuthStatus(latestStatus);
  }, [latestStatus, setAuthStatus]);

  const statusByProvider = useMemo(
    () => new Map((latestStatus ?? authStatus)?.providers.map((status) => [status.provider, status]) ?? []),
    [authStatus, latestStatus],
  );

  const startSession = useCallback(async (provider: AuthProvider) => {
    // Reserve during user activation; neither Window nor prompt credentials enter the session owner.
    const authWindow = reserveAuthWindow();
    if (authWindow) reservedWindows.current.add(authWindow);
    const currentLifetime = lifetime.current;
    const session = await authorization.connect(provider);
    if (authWindow) reservedWindows.current.delete(authWindow);
    if (!session || currentLifetime !== lifetime.current) {
      closeAuthWindow(authWindow);
      return;
    }
    const target = launchTarget(session);
    if (target && authWindow && navigateAuthWindow(authWindow, target)) {
      authorization.notice(provider, {
        tone: "info",
        text: "Sign-in opened in a new tab. Return here when authorization is complete.",
      });
    } else if (target) {
      closeAuthWindow(authWindow);
      authorization.notice(provider, {
        tone: "error",
        text: "Your browser blocked the sign-in window. Use the Open sign-in link below.",
      });
    } else {
      closeAuthWindow(authWindow);
      authorization.notice(provider, { tone: "info", text: "Connection session started. Follow the instructions below." });
    }
  }, [authorization]);

  const answerPrompt = useCallback(async (session: AuthSession) => {
    const currentLifetime = lifetime.current;
    const result = await authorization.answer(session, promptValues[session.provider] ?? "");
    if (result && currentLifetime === lifetime.current) {
      setPromptValues((current) => ({ ...current, [session.provider]: "" }));
    }
  }, [authorization, promptValues]);

  const cancelSession = authorization.cancel;
  const logout = authorization.disconnect;
  const refreshApplicationModel = authorization.refreshModel;
  const toggleApplicationModel = (useAntigravity: boolean) => authorization.selectModel(
    useAntigravity ? "gemini-3.8-flash" : "gpt-5.6-sol",
  );

  const usesAntigravity = applicationModel === "gemini-3.8-flash";
  const requestedModelProvider = usesAntigravity ? "openai-codex" : "google-antigravity";
  const requestedModelConnected = statusByProvider.get(requestedModelProvider)?.state === "connected";
  const requestedModelProviderName = requestedModelProvider === "google-antigravity"
    ? "Google Antigravity"
    : "OpenAI Codex";
  const applicationModelSwitchDescription = applicationModel === undefined
    ? "Application model status is unavailable. Retry model status to enable this switch."
    : requestedModelConnected
      ? usesAntigravity
        ? "Turn off to use OpenAI Codex for applications."
        : "Turn on to use Google Antigravity 3.8 Flash for applications."
      : `Connect ${requestedModelProviderName} to switch models.`;

  return (
    <section className="oauth-dashboard" aria-label="OAuth credentials">
      {statusError ? (
        <p className="dashboard-notice dashboard-notice--error" role="alert">
          {statusError}
        </p>
      ) : null}

      <div className="provider-table" aria-busy={isLoadingStatus}>
        <div className="provider-table__head" aria-hidden="true">
          <span>Credential</span>
          <span>Status</span>
          <span>Action</span>
        </div>

        <ul className="provider-list" aria-label="Credentials">
          {PROVIDERS.map((provider) => {
            const providerStatus = statusByProvider.get(provider.provider);
            const session = sessions[provider.provider];
            const action = busy[provider.provider];
            const notice = notices[provider.provider];
            const isPending = session?.state === "pending";
            const isConnected = providerStatus?.state === "connected";
            const statusLabel = isLoadingStatus ? "Checking" : providerStatus?.state ?? "Unavailable";
            const email = providerStatus?.identity?.email;

            return (
              <li className="provider-row" key={provider.provider}>
                <div>
                  <p className="provider-identity__name">{provider.name}</p>
                  <p className="oauth-session__instructions">{provider.description}</p>
                </div>

                <div className="provider-connection">
                  <span className={`status-badge status-badge--${statusLabel.toLowerCase()}`}>{statusLabel}</span>
                  {email ? <span className="provider-account">{redactPublicText(email)}</span> : null}
                </div>

                <div className={`provider-actions ${controlStyles.controls}`}>
                  {provider.provider === "google-antigravity" ? (
                    <label
                      className={controlStyles.toggle}
                      title={requestedModelConnected ? undefined : `Connect ${requestedModelProviderName} to switch models.`}
                    >
                      <input
                        aria-describedby="application-model-switch-description"
                        aria-label="Use Google Antigravity 3.8 Flash for applications"
                        checked={usesAntigravity}
                        disabled={
                          isLoadingApplicationModel
                          || applicationModel === undefined
                          || Boolean(busy["google-antigravity"])
                          || !requestedModelConnected
                        }
                        onChange={(event) => void toggleApplicationModel(event.currentTarget.checked)}
                        role="switch"
                        type="checkbox"
                      />
                      <span>{busy["google-antigravity"] === "model" ? "Switching…" : "Use 3.8 Flash"}</span>
                      <span className="visually-hidden" id="application-model-switch-description">
                        {applicationModelSwitchDescription}
                      </span>
                    </label>
                  ) : null}
                  {isConnected ? (
                    <button
                      className="control control--quiet"
                      type="button"
                      aria-label={`${action === "logout" ? "Disconnecting" : "Logout"} ${provider.name}`}
                      onClick={() => void logout(provider.provider)}
                      disabled={Boolean(action) || isPending}
                    >
                      {action === "logout" ? "Disconnecting…" : "Logout"}
                    </button>
                  ) : (
                    <button
                      className="control control--primary"
                      type="button"
                      aria-label={`${action === "connect" ? "Connecting" : "Connect"} ${provider.name}`}
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
                    providerName={provider.name}
                    busyAction={action}
                    promptValue={promptValues[provider.provider] ?? ""}
                    onPromptValueChange={(value) =>
                      setPromptValues((current) => ({ ...current, [provider.provider]: value }))
                    }
                    onAnswerPrompt={() => void answerPrompt(session)}
                    onCancel={() => void cancelSession(session)}
                  />
                ) : null}

                {provider.provider === "google-antigravity" && applicationModelError ? (
                  <div
                    className={`dashboard-notice dashboard-notice--error ${controlStyles.controls}`}
                    role="alert"
                  >
                    <span>{applicationModelError}</span>
                    <button
                      className="control control--quiet"
                      disabled={isLoadingApplicationModel}
                      onClick={() => void refreshApplicationModel()}
                      type="button"
                    >
                      {isLoadingApplicationModel ? "Retrying…" : "Retry model status"}
                    </button>
                  </div>
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

    </section>
  );
}

function SessionDetail({
  session,
  providerName,
  busyAction,
  promptValue,
  onPromptValueChange,
  onAnswerPrompt,
  onCancel,
}: {
  session: AuthSession;
  providerName: string;
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
          <a
            aria-label={`Open ${providerName} sign-in`}
            className="control control--link"
            href={target}
            target="_blank"
            rel="noopener noreferrer"
          >
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
            <button
              aria-label={`${busyAction === "prompt" ? "Sending" : "Submit"} ${providerName} authorization response`}
              className="control control--primary"
              type="submit"
              disabled={Boolean(busyAction) || !promptValue.trim()}
            >
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
          <button
            aria-label={`${busyAction === "cancel" ? "Cancelling" : "Cancel"} ${providerName} authorization`}
            className="control control--quiet"
            type="button"
            onClick={onCancel}
            disabled={Boolean(busyAction)}
          >
            {busyAction === "cancel" ? "Cancelling…" : "Cancel"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
