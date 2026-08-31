import type { GmailAuthHarnessClient } from "../api/application-harness-client";
import type { AuthProviderHooks } from "./service";

const GMAIL_AUTH_POLL_INTERVAL_MS = 1_000;
const passiveSignal = new AbortController().signal;

export interface GmailAuthProviderOptions {
  readonly waitForPoll?: (signal: AbortSignal) => Promise<void>;
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, GMAIL_AUTH_POLL_INTERVAL_MS);
  timer.unref();
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}

export function createGmailAuthProviderHooks(
  harness: GmailAuthHarnessClient,
  options: GmailAuthProviderOptions = {},
): AuthProviderHooks {
  const wait = options.waitForPoll ?? waitForPoll;
  let connected = false;

  return {
    status: async () => {
      const status = await harness.getGmailAuth(passiveSignal);
      connected = status.state === "connected";
      return status;
    },
    login: async (controller) => {
      connected = false;
      let session = await harness.createGmailAuthSession(controller.signal);
      if (session.authorizationUrl === undefined) {
        throw new Error("Gmail authorization URL is unavailable");
      }
      controller.onAuth({ url: session.authorizationUrl });

      while (session.state === "pending") {
        await wait(controller.signal);
        controller.signal.throwIfAborted();
        session = await harness.getGmailAuthSession(session.id, controller.signal);
      }
      if (session.state !== "succeeded") {
        throw new Error("Gmail authorization did not succeed");
      }
      connected = true;
    },
    assertConnected: () => {
      if (!connected) throw new Error("Gmail authorization is not connected");
    },
    logout: async () => {
      connected = false;
      await harness.deleteGmailAuth(passiveSignal);
    },
  };
}
